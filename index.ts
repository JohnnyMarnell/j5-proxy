/// <reference lib="dom" />
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { execSync } from 'child_process';
import { parseArgs } from 'node:util';
import { appendFileSync } from 'node:fs';

const PYTHON_COOKIE_EXPORT = `${__dirname}/cookies.py`;

// --- LOGGING UTILS ---
function getTimestamp(): string {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s}.${ms}`;
}

function log(...args: any[]) {
    console.log(`[${getTimestamp()}]`, ...args);
}

function logError(...args: any[]) {
    console.error(`[${getTimestamp()}]`, ...args);
}

// --- DEBOUNCED CLEANUP ERROR LOGGING ---
let cleanupErrorCount = 0;
let cleanupErrorTimer: ReturnType<typeof setTimeout> | null = null;

function logCleanupError() {
    cleanupErrorCount++;
    if (!cleanupErrorTimer) {
        cleanupErrorTimer = setTimeout(() => {
            log(`[-] ${cleanupErrorCount} stale CDP session error${cleanupErrorCount > 1 ? 's' : ''} suppressed during cleanup.`);
            cleanupErrorCount = 0;
            cleanupErrorTimer = null;
        }, 2000);
    }
}

// --- CLI ARGUMENT PARSING ---
const { values } = parseArgs({
    options: {
        port: { type: 'string', short: 'p', default: '8787' },
        ttl: { type: 'string', short: 't', default: '3600000' },
        'log-html': { type: 'boolean', default: false },
        'log-file': { type: 'string', default: '/tmp/proxy.jsonl' },
        idle: { type: 'string', short: 'i', default: '1800000' }, // auto-shutdown after ms of inactivity, default 30m
        'throttle-interval': { type: 'string', default: '5000' }, // cache responses for this many ms, default 5s
        'throttle-regex': { type: 'string', default: '.*' }, // only cache URLs matching this regex
    }
});

const PORT = parseInt(values.port as string, 10);
const COOKIE_CACHE_TTL = parseInt(values.ttl as string, 10);
const GLOBAL_LOG_HTML = values['log-html'] as boolean;
const LOG_FILE = values['log-file'] as string;
const IDLE_TIMEOUT = parseInt(values.idle as string, 10);
const THROTTLE_INTERVAL = parseInt(values['throttle-interval'] as string, 10);
const THROTTLE_REGEX = new RegExp(values['throttle-regex'] as string);

// --- OS NOTIFICATIONS ---
function notify(title: string, message: string) {
    try {
        execSync(`osascript -e 'display notification "${message}" with title "${title}"'`, { stdio: 'ignore' });
    } catch {
        // Ignore if not on macOS or notifications unavailable
    }
}

// --- JSONL LOGGER ---
function logToFile(entry: Record<string, any>) {
    try {
        appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    } catch (e: any) {
        logError(`[!] Failed to write to ${LOG_FILE}: ${e.message}`);
    }
}

// Apply stealth plugin
chromium.use(stealth());

const app = new Hono();

let browser: any;

// --- COOKIE CACHING STATE ---
let cachedCookies: any[] = [];
let lastCookieFetchTime: number = 0;

// --- RESPONSE THROTTLE CACHE ---
interface CachedResponse {
    body: string;
    status: number;
    headers: Record<string, string>;
    timestamp: number;
    hits: number;
}

const responseCache = new Map<string, CachedResponse>();

function getCacheKey(method: string, url: string, queryParams: Record<string, any>): string {
    const paramsStr = Object.keys(queryParams).length > 0 
        ? '?' + new URLSearchParams(queryParams as Record<string, string>).toString()
        : '';
    return `${method}:${url}${paramsStr}`;
}

function getCachedResponse(cacheKey: string): CachedResponse | null {
    const cached = responseCache.get(cacheKey);
    if (!cached) return null;
    
    const age = Date.now() - cached.timestamp;
    if (age >= THROTTLE_INTERVAL) {
        responseCache.delete(cacheKey);
        return null;
    }
    
    cached.hits++;
    return cached;
}

function setCachedResponse(cacheKey: string, body: string, status: number, headers: Record<string, string>) {
    responseCache.set(cacheKey, {
        body,
        status,
        headers,
        timestamp: Date.now(),
        hits: 0,
    });
}

// Helper function to get cookies (either from cache or by executing Python)
function getCookies(): any[] {
    const now = Date.now();

    // Return cached cookies if they exist and haven't expired
    if (cachedCookies.length > 0 && (now - lastCookieFetchTime < COOKIE_CACHE_TTL)) {
        return cachedCookies;
    }

    log('[+] Cache expired or empty. Extracting fresh Chrome cookies via Python...');
    try {
        const pythonOutput = execSync(`python ${PYTHON_COOKIE_EXPORT}`).toString();

        const parsedCookies = JSON.parse(pythonOutput);

        if (parsedCookies.error) {
            throw new Error(parsedCookies.error);
        }

        cachedCookies = parsedCookies;
        lastCookieFetchTime = now;

        log(`[+] Successfully extracted and cached ${cachedCookies.length} cookies.`);
        return cachedCookies;
    } catch (error: any) {
        logError(`[!] Failed to extract cookies via Python: ${error.message}`);
        return cachedCookies;
    }
}

// 1. Initialize the browser
async function initBrowser() {
    log('Booting Chromium...');
    browser = await chromium.launch({ headless: true });
    log('Browser ready.');
}

// --- X-Proxy-Options PARSING ---
// Header format: X-Proxy-Options: render, log-html, wait=30000, selector=#content, settle=2000
// Options:
//   render           - Wait for full JS execution, return rendered DOM instead of first HTML response
//   log-html         - Log HTML at each step to server output
//   wait=<ms>        - Max wait time for render mode (default 20000)
//   selector=<css>   - Wait for this CSS selector to appear before capturing DOM
//   settle=<ms>      - Extra settle time after networkidle (default 1000)
interface ProxyOptions {
    render: boolean;
    logHtml: boolean;
    wait: number;
    selector: string | null;
    settle: number;
}

function parseProxyOptions(header: string | undefined): ProxyOptions {
    const opts: ProxyOptions = {
        render: false,
        logHtml: GLOBAL_LOG_HTML,
        wait: 20000,
        selector: null,
        settle: 1000,
    };
    if (!header) return opts;
    const parts = header.split(',').map(s => s.trim());
    for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower === 'render') { opts.render = true; continue; }
        if (lower === 'log-html') { opts.logHtml = true; continue; }
        const [key, ...rest] = part.split('=');
        if (!key) continue;
        const val = rest.join('='); // rejoin in case selector has = in it
        switch (key.trim().toLowerCase()) {
            case 'wait': opts.wait = parseInt(val, 10) || 20000; break;
            case 'selector': opts.selector = val.trim(); break;
            case 'settle': opts.settle = parseInt(val, 10) || 1000; break;
        }
    }
    return opts;
}

function logHtmlStep(reqId: number, label: string, html: string, url: string, elapsedMs: number, reqHeaders: Record<string, string>, proxyOpts: ProxyOptions) {
    const preview = html.length > 500 ? html.substring(0, 500) + `... (${html.length} chars total)` : html;
    log(`\n[#${reqId} +${elapsedMs}ms HTML:${label}] ${url}\n${'─'.repeat(60)}\n${preview}\n${'─'.repeat(60)}`);
    logToFile({
        ts: new Date().toISOString(),
        reqId,
        elapsed: elapsedMs,
        step: label,
        request: { url, headers: reqHeaders, proxyOptions: proxyOpts },
        response: { body: html, bodyLength: html.length },
    });
}

// --- INACTIVITY AUTO-SHUTDOWN ---
let lastRequestTime = Date.now();

function resetIdleTimer() {
    lastRequestTime = Date.now();
}

const idleInterval = setInterval(() => {
    if (Date.now() - lastRequestTime >= IDLE_TIMEOUT) {
        log(`[!] No requests for ${IDLE_TIMEOUT / 1000}s — shutting down due to inactivity.`);
        shutdown('inactivity');
    }
}, 10000);
idleInterval.unref();

// --- SHUTDOWN ---
let shuttingDown = false;

async function shutdown(reason = 'signal') {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(idleInterval);
    log(`[!] Shutting down (${reason})...`);
    notify('Proxy shutting down', `Reason: ${reason}`);
    if (browser) await browser.close();
    process.exit(0);
}

// 2. Define the proxy route
let requestCounter = 0;

app.get('/*', async (c) => {
    const reqId = ++requestCounter;
    resetIdleTimer();
    const startTime = Date.now();
    const elapsed = () => Date.now() - startTime;
    const path = c.req.path.substring(1);

    if (!path || path === 'favicon.ico') {
        return c.text('Not found', 404);
    }

    const targetUrl = path.startsWith('http') ? path : `https://${path}`;

    let targetOrigin = '';
    try {
        targetOrigin = new URL(targetUrl).origin;
    } catch (e) {
        return c.text('Invalid URL provided', 400);
    }

    const proxyOpts = parseProxyOptions(c.req.header('x-proxy-options'));

    // Collect request headers for logging
    const reqHeaders: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => { reqHeaders[k] = v; });

    // Check response cache for GET requests (before filtering with throttle-regex)
    const queryParams: Record<string, any> = {};
    const urlObj = new URL(targetUrl);
    urlObj.searchParams.forEach((v, k) => { queryParams[k] = v; });
    
    const cacheKey = getCacheKey('GET', targetUrl, queryParams);
    let cacheHit = false;
    let fromCache = false;

    // Only use cache if URL matches throttle regex and not using render/selector (these require full JS execution)
    if (!proxyOpts.render && !proxyOpts.selector && THROTTLE_REGEX.test(targetUrl)) {
        const cached = getCachedResponse(cacheKey);
        if (cached) {
            cacheHit = true;
            fromCache = true;
            const duration = elapsed();
            log(`[#${reqId}] GET ${targetUrl.substring(0, 80)} → ${cached.status} (${cached.body.length}B) ${duration}ms [cache-hit #${cached.hits}]`);
            logToFile({
                ts: new Date().toISOString(),
                reqId,
                duration,
                method: 'GET',
                url: targetUrl,
                status: cached.status,
                bodyLength: cached.body.length,
                cacheHit: true,
                cacheHits: cached.hits,
            });
            const headers = new Headers();
            for (const [k, v] of Object.entries(cached.headers)) {
                if (['transfer-encoding', 'connection', 'keep-alive', 'content-encoding'].includes(k.toLowerCase())) continue;
                headers.set(k, v);
            }
            return new Response(cached.body, { status: cached.status, headers });
        }
    }

    const tags = [
        proxyOpts.render ? 'render' : null,
        proxyOpts.logHtml ? 'log-html' : null,
        proxyOpts.selector ? `selector=${proxyOpts.selector}` : null,
        (!proxyOpts.render && !proxyOpts.selector && THROTTLE_REGEX.test(targetUrl)) ? 'cached' : null,
    ].filter(Boolean);

    let context: any;
    let page: any;
    let responseStatus = 200;
    let responseBody = '';
    let responseError: string | undefined;

    try {
        const sessionCookies = getCookies();

        context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 720 }
        });

        if (sessionCookies.length > 0) {
            await context.addCookies(sessionCookies);
        }

        page = await context.newPage();

        let rawHtml: string;
        let firstResponseLogged = false;

        // Early-exit for JSON responses — resolves with { body, headers, status }
        let resolveJson: ((result: { body: string; headers: Record<string, string>; status: number }) => void) | null = null;
        const jsonResponsePromise = new Promise<{ body: string; headers: Record<string, string>; status: number }>((resolve) => { resolveJson = resolve; });

        // Single response listener shared by both modes.
        // Always logs the first document response to JSONL immediately.
        // If response is JSON, short-circuits via jsonResponsePromise.
        // In default mode, also resolves captureHtmlPromise.
        let resolveCapture: ((html: string) => void) | null = null;
        const captureHtmlPromise = new Promise<string>((resolve) => { resolveCapture = resolve; });

        page.on('response', async (response: any) => {
            if (response.request().frame() !== page.mainFrame()) return;

            const contentType = response.headers()['content-type'] || '';
            const isJson = contentType.includes('application/json');
            const isDocument = response.request().resourceType() === 'document';

            if (!isDocument && !isJson) return;

            try {
                const text = await response.text();

                // JSON response — short-circuit, forward headers + body immediately
                if (isJson) {
                    const ms = elapsed();
                    log(`[#${reqId} +${ms}ms] JSON response: ${response.status()} (${text.length} bytes)`);

                    // Collect upstream headers
                    const upstreamHeaders: Record<string, string> = {};
                    const rawHeaders = response.headers();
                    for (const [k, v] of Object.entries(rawHeaders)) {
                        upstreamHeaders[k] = v as string;
                    }

                    logToFile({
                        ts: new Date().toISOString(),
                        reqId,
                        elapsed: ms,
                        step: 'json-response',
                        request: { url: targetUrl, headers: reqHeaders, proxyOptions: proxyOpts },
                        response: { status: response.status(), bodyLength: text.length, body: text, headers: upstreamHeaders },
                    });

                    resolveJson!({ body: text, headers: upstreamHeaders, status: response.status() });
                    return;
                }

                // Always log the very first document response to JSONL + stdout
                if (isDocument && !firstResponseLogged) {
                    firstResponseLogged = true;
                    const ms = elapsed();
                    log(`[#${reqId} +${ms}ms] First response: ${response.status()} (${text.length} bytes)`);
                    logToFile({
                        ts: new Date().toISOString(),
                        reqId,
                        elapsed: ms,
                        step: 'first-response',
                        request: { url: targetUrl, headers: reqHeaders, proxyOptions: proxyOpts },
                        response: { status: response.status(), bodyLength: text.length, body: text },
                    });
                }

                // In default mode, resolve with the first non-CF HTML
                if (isDocument && !proxyOpts.render) {
                    if (!text.includes('challenge-error-text') && !text.includes('Just a moment')) {
                        if (text.length > 1000) {
                            if (proxyOpts.logHtml) {
                                logHtmlStep(reqId, 'intercepted-response', text, targetUrl, elapsed(), reqHeaders, proxyOpts);
                            }
                            resolveCapture!(text);
                        }
                    } else {
                        log(`[#${reqId} +${elapsed()}ms] Cloudflare challenge detected, waiting for it to solve and reload...`);
                    }
                }
            } catch (e) {
                // Body might be unavailable during rapid redirects, safe to ignore
            }
        });

        // Navigate — both modes start the same way
        await page.goto(targetUrl, { waitUntil: 'commit', timeout: 30000 });

        // Race JSON early-exit against the HTML pipeline.
        // A tiny delay lets the response listener fire before we proceed.
        const jsonEarlyExit = await Promise.race([
            jsonResponsePromise.then(r => r),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
        ]);

        if (jsonEarlyExit) {
            // JSON detected — forward upstream headers and body, skip HTML pipeline
            responseStatus = jsonEarlyExit.status;
            responseBody = jsonEarlyExit.body;

            const headers = new Headers();
            for (const [k, v] of Object.entries(jsonEarlyExit.headers)) {
                // Skip hop-by-hop headers
                if (['transfer-encoding', 'connection', 'keep-alive', 'content-encoding'].includes(k.toLowerCase())) continue;
                headers.set(k, v);
            }

            return new Response(jsonEarlyExit.body, {
                status: jsonEarlyExit.status,
                headers,
            });
        }

        if (proxyOpts.render) {
            // --- RENDER MODE: full JS execution, return final DOM ---
            if (proxyOpts.logHtml) {
                const commitHtml = await page.content();
                logHtmlStep(reqId, 'after-commit', commitHtml, targetUrl, elapsed(), reqHeaders, proxyOpts);
            }

            // Wait for network to settle
            await page.waitForLoadState('networkidle', { timeout: proxyOpts.wait }).catch(() => {
                log(`[#${reqId} +${elapsed()}ms] networkidle timed out, continuing with current DOM state`);
            });

            if (proxyOpts.logHtml) {
                const idleHtml = await page.content();
                logHtmlStep(reqId, 'after-networkidle', idleHtml, targetUrl, elapsed(), reqHeaders, proxyOpts);
            }

            // Wait for a specific selector if requested
            if (proxyOpts.selector) {
                try {
                    await page.waitForSelector(proxyOpts.selector, { timeout: proxyOpts.wait });
                    log(`[#${reqId} +${elapsed()}ms] Selector "${proxyOpts.selector}" appeared`);
                } catch {
                    log(`[#${reqId} +${elapsed()}ms] Selector "${proxyOpts.selector}" not found within ${proxyOpts.wait}ms`);
                }

                if (proxyOpts.logHtml) {
                    const selectorHtml = await page.content();
                    logHtmlStep(reqId, 'after-selector', selectorHtml, targetUrl, elapsed(), reqHeaders, proxyOpts);
                }
            }

            // Extra settle time for late JS mutations
            await page.waitForTimeout(proxyOpts.settle);

            rawHtml = await page.content();

            if (proxyOpts.logHtml) {
                logHtmlStep(reqId, 'final-rendered', rawHtml, targetUrl, elapsed(), reqHeaders, proxyOpts);
            }
        } else {
            // --- DEFAULT MODE: intercept first real HTML response ---
            try {
                rawHtml = await Promise.race([
                    captureHtmlPromise,
                    new Promise<string>((_, reject) =>
                        setTimeout(() => reject(new Error('Timeout waiting for real HTML (Cloudflare might be stuck)')), 25000)
                    )
                ]);
            } catch (err: any) {
                log(`[#${reqId} +${elapsed()}ms] Intercept timed out, falling back to live DOM.`);
                rawHtml = await page.content();
                if (proxyOpts.logHtml) {
                    logHtmlStep(reqId, 'fallback-dom', rawHtml, targetUrl, elapsed(), reqHeaders, proxyOpts);
                }
            }
        }

        const baseTag = `<base href="${targetOrigin}/">`;
        const finalHtml = rawHtml.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
        responseBody = finalHtml;

        return c.html(finalHtml);

    } catch (error: any) {
        logError(`[#${reqId} +${elapsed()}ms] Error scraping ${targetUrl}: ${error.message}`);
        responseStatus = 500;
        responseError = error.message;
        responseBody = `Error scraping page: ${error.message}`;
        return c.text(responseBody, 500);
    } finally {
        if (!fromCache) {
            if (page) await page.close().catch(logCleanupError);
            if (context) await context.close().catch(logCleanupError);
        }

        const duration = elapsed();
        
        // Cache the response if it's a successful GET request matching the throttle regex (and not using render/selector)
        if (!fromCache && !proxyOpts.render && !proxyOpts.selector && responseStatus === 200 && THROTTLE_REGEX.test(targetUrl)) {
            const upstreamHeaders: Record<string, string> = {};
            // Only cache simple headers (content-type, etc)
            if (responseBody.length > 0) {
                upstreamHeaders['content-type'] = 'text/html; charset=utf-8';
                setCachedResponse(cacheKey, responseBody, responseStatus, upstreamHeaders);
            }
        }

        // Single-line logging with stats
        const cacheStatus = fromCache ? ` [cache-hit #${responseCache.get(cacheKey)?.hits || 0}]` : 
                           (!proxyOpts.render && !proxyOpts.selector && THROTTLE_REGEX.test(targetUrl) && responseStatus === 200) ? ` [cache-stored]` : '';
        const proxyOptsStr = tags.length ? ` [${tags.join(', ')}]` : '';
        const errorStr = responseError ? ` ERR: ${responseError}` : '';
        
        log(`[#${reqId}] GET ${targetUrl.substring(0, 70)}${targetUrl.length > 70 ? '...' : ''} → ${responseStatus} (${responseBody.length}B) ${duration}ms${cacheStatus}${proxyOptsStr}${errorStr}`);

        // Detailed JSONL logging
        logToFile({
            ts: new Date().toISOString(),
            reqId,
            duration,
            method: 'GET',
            url: targetUrl,
            status: responseStatus,
            bodyLength: responseBody.length,
            cacheHit: fromCache,
            cacheStored: (!fromCache && !proxyOpts.render && !proxyOpts.selector && responseStatus === 200 && THROTTLE_REGEX.test(targetUrl)),
            proxyOptions: proxyOpts,
            ...(responseError ? { error: responseError } : {}),
        });
    }
});

// 3. Start the server
initBrowser().then(() => {
    serve({
        fetch: app.fetch,
        port: PORT
    }, (info) => {
        log(`🚀 Headless proxy running at http://localhost:${info.port}`);
        log(`📝 Logging requests to ${LOG_FILE}`);
        log(`⏱  Auto-shutdown after ${IDLE_TIMEOUT / 1000}s idle`);
        log(`⚡ Response throttle: ${THROTTLE_INTERVAL}ms, regex: ${values['throttle-regex']}`);
        notify('Proxy started', `Listening on port ${info.port}`);
    });
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
