/// <reference lib="dom" />
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cac } from 'cac';
import consola from 'consola';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { execSync } from 'child_process';
import { appendFileSync } from 'node:fs';

const PYTHON_COOKIE_EXPORT = `${__dirname}/cookies.py`;

// --- CLI ARGUMENT PARSING ---
const cli = cac('proxy');

cli
  .option('-p, --port <port>', 'Server port', { default: 8787 })
  .option('-t, --ttl <ms>', 'Cookie cache TTL (ms)', { default: 3600000 })
  .option('--log-html', 'Log HTML at each pipeline step to stdout', { default: false })
  .option('--log-file <path>', 'Path for the JSONL request log', { default: '/tmp/proxy.jsonl' })
  .option('-i, --idle <ms>', 'Auto-shutdown after ms of inactivity', { default: 1800000 })
  .option('--throttle-interval <ms>', 'Cache responses for this many ms', { default: 5000 })
  .option('--throttle-regex <pattern>', 'Only cache URLs matching this regex', { default: '.*' })
  .help();

const parsed = cli.parse();
if (parsed.options.help) process.exit(0);
const opts = parsed.options;

const PORT: number = Number(opts.port);
const COOKIE_CACHE_TTL: number = Number(opts.ttl);
const GLOBAL_LOG_HTML: boolean = opts.logHtml as boolean;
const LOG_FILE: string = opts.logFile as string;
const IDLE_TIMEOUT: number = Number(opts.idle);
const THROTTLE_INTERVAL: number = Number(opts.throttleInterval);
const THROTTLE_REGEX = new RegExp(opts.throttleRegex as string);

// --- DEBOUNCED CLEANUP ERROR LOGGING ---
let cleanupErrorCount = 0;
let cleanupErrorTimer: ReturnType<typeof setTimeout> | null = null;

function logCleanupError() {
    cleanupErrorCount++;
    if (!cleanupErrorTimer) {
        cleanupErrorTimer = setTimeout(() => {
            consola.warn(`${cleanupErrorCount} stale CDP session error${cleanupErrorCount > 1 ? 's' : ''} suppressed during cleanup.`);
            cleanupErrorCount = 0;
            cleanupErrorTimer = null;
        }, 2000);
    }
}

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
        consola.error(`Failed to write to ${LOG_FILE}: ${e.message}`);
    }
}

// Apply stealth plugin
chromium.use(stealth());

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

    if (cachedCookies.length > 0 && (now - lastCookieFetchTime < COOKIE_CACHE_TTL)) {
        return cachedCookies;
    }

    consola.info('Cache expired or empty. Extracting fresh Chrome cookies via Python...');
    try {
        const pythonOutput = execSync(`python ${PYTHON_COOKIE_EXPORT}`).toString();
        const parsedCookies = JSON.parse(pythonOutput);

        if (parsedCookies.error) {
            throw new Error(parsedCookies.error);
        }

        cachedCookies = parsedCookies;
        lastCookieFetchTime = now;

        consola.success(`Extracted and cached ${cachedCookies.length} cookies.`);
        return cachedCookies;
    } catch (error: any) {
        consola.error(`Failed to extract cookies via Python: ${error.message}`);
        return cachedCookies;
    }
}

// --- BROWSER INIT ---
async function initBrowser() {
    consola.start('Booting Chromium...');
    browser = await chromium.launch({ headless: true });
    consola.ready('Browser ready.');
}

// --- X-Proxy-Options PARSING ---
interface ProxyOptions {
    render: boolean;
    logHtml: boolean;
    wait: number;
    selector: string | null;
    settle: number;
}

function parseProxyOptions(header: string | undefined): ProxyOptions {
    const defaults: ProxyOptions = {
        render: false,
        logHtml: GLOBAL_LOG_HTML,
        wait: 20000,
        selector: null,
        settle: 1000,
    };
    if (!header) return defaults;
    const parts = header.split(',').map(s => s.trim());
    for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower === 'render') { defaults.render = true; continue; }
        if (lower === 'log-html') { defaults.logHtml = true; continue; }
        const [key, ...rest] = part.split('=');
        if (!key) continue;
        const val = rest.join('=');
        switch (key.trim().toLowerCase()) {
            case 'wait': defaults.wait = parseInt(val, 10) || 20000; break;
            case 'selector': defaults.selector = val.trim(); break;
            case 'settle': defaults.settle = parseInt(val, 10) || 1000; break;
        }
    }
    return defaults;
}

function logHtmlStep(reqId: number, label: string, html: string, url: string, elapsedMs: number, reqHeaders: Record<string, string>, proxyOpts: ProxyOptions) {
    const preview = html.length > 500 ? html.substring(0, 500) + `... (${html.length} chars total)` : html;
    consola.info(`\n[#${reqId} +${elapsedMs}ms HTML:${label}] ${url}\n${'─'.repeat(60)}\n${preview}\n${'─'.repeat(60)}`);
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
        consola.warn(`No requests for ${IDLE_TIMEOUT / 1000}s — shutting down due to inactivity.`);
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
    consola.warn(`Shutting down (${reason})...`);
    notify('Proxy shutting down', `Reason: ${reason}`);
    if (browser) await browser.close();
    process.exit(0);
}

// --- RESPONSE BODY SUMMARY FOR LOGGING ---
function summarizeBody(body: string, maxLen = 200): string {
    if (!body || body.length === 0) return '(empty)';
    // Try to compact JSON
    try {
        const parsed = JSON.parse(body);
        const compact = JSON.stringify(parsed);
        if (compact.length <= maxLen) return compact;
        return compact.substring(0, maxLen) + `…(${compact.length}B)`;
    } catch {
        // Not JSON, just truncate
        if (body.length <= maxLen) return body;
        return body.substring(0, maxLen) + `…(${body.length}B)`;
    }
}

// --- HOP-BY-HOP HEADERS TO STRIP ---
const HOP_BY_HOP = new Set(['transfer-encoding', 'connection', 'keep-alive', 'content-encoding']);

function stripHopByHop(headers: Record<string, string>): Headers {
    const out = new Headers();
    for (const [k, v] of Object.entries(headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v);
    }
    return out;
}

// --- REQUEST HANDLING: broken into smaller functions ---

let requestCounter = 0;

interface RequestContext {
    reqId: number;
    startTime: number;
    targetUrl: string;
    targetOrigin: string;
    proxyOpts: ProxyOptions;
    reqHeaders: Record<string, string>;
    cacheKey: string;
    tags: string[];
}

function elapsed(ctx: RequestContext): number {
    return Date.now() - ctx.startTime;
}

/** Parse the incoming Hono context into a RequestContext, or return an error Response. */
function buildRequestContext(c: import('hono').Context): RequestContext | Response {
    const reqId = ++requestCounter;
    resetIdleTimer();
    const startTime = Date.now();

    const path = c.req.path.substring(1);

    if (!path || path === 'favicon.ico') {
        return c.text('Not found', 404);
    }

    const targetUrl = path.startsWith('http') ? path : `https://${path}`;

    let targetOrigin = '';
    try {
        targetOrigin = new URL(targetUrl).origin;
    } catch {
        return c.text('Invalid URL provided', 400);
    }

    const proxyOpts = parseProxyOptions(c.req.header('x-proxy-options'));

    const reqHeaders: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => { reqHeaders[k] = v; });

    const queryParams: Record<string, string> = {};
    const urlObj = new URL(targetUrl);
    urlObj.searchParams.forEach((v, k) => { queryParams[k] = v; });
    const cacheKey = getCacheKey('GET', targetUrl, queryParams);

    const tags = [
        proxyOpts.render ? 'render' : null,
        proxyOpts.logHtml ? 'log-html' : null,
        proxyOpts.selector ? `selector=${proxyOpts.selector}` : null,
        (!proxyOpts.render && !proxyOpts.selector && THROTTLE_REGEX.test(targetUrl)) ? 'cached' : null,
    ].filter(Boolean) as string[];

    return { reqId, startTime, targetUrl, targetOrigin, proxyOpts, reqHeaders, cacheKey, tags };
}

/** Return a cached response if available, or null. */
function tryCache(ctx: RequestContext): Response | null {
    if (ctx.proxyOpts.render || ctx.proxyOpts.selector || !THROTTLE_REGEX.test(ctx.targetUrl)) return null;

    const cached = getCachedResponse(ctx.cacheKey);
    if (!cached) return null;

    const duration = elapsed(ctx);
    consola.success(`[#${ctx.reqId}] GET ${ctx.targetUrl.substring(0, 80)} → ${cached.status} (${cached.body.length}B) ${duration}ms [cache-hit #${cached.hits}]`);
    logToFile({
        ts: new Date().toISOString(),
        reqId: ctx.reqId,
        duration,
        method: 'GET',
        url: ctx.targetUrl,
        status: cached.status,
        bodyLength: cached.body.length,
        cacheHit: true,
        cacheHits: cached.hits,
    });
    return new Response(cached.body, { status: cached.status, headers: stripHopByHop(cached.headers) });
}

/** Set up response listeners on the page and return promises for JSON early-exit and HTML capture. */
function attachResponseListeners(ctx: RequestContext, page: any) {
    let firstResponseLogged = false;

    let resolveJson: (result: { body: string; headers: Record<string, string>; status: number }) => void;
    const jsonResponsePromise = new Promise<{ body: string; headers: Record<string, string>; status: number }>((r) => { resolveJson = r; });

    let resolveCapture: (html: string) => void;
    const captureHtmlPromise = new Promise<string>((r) => { resolveCapture = r; });

    page.on('response', async (response: any) => {
        if (response.request().frame() !== page.mainFrame()) return;

        const contentType = response.headers()['content-type'] || '';
        const isJson = contentType.includes('application/json');
        const isDocument = response.request().resourceType() === 'document';

        if (!isDocument && !isJson) return;

        try {
            const text = await response.text();

            if (isJson) {
                const ms = elapsed(ctx);
                consola.info(`[#${ctx.reqId} +${ms}ms] JSON response: ${response.status()} (${text.length} bytes)`);
                const upstreamHeaders: Record<string, string> = {};
                for (const [k, v] of Object.entries(response.headers())) {
                    upstreamHeaders[k] = v as string;
                }
                logToFile({
                    ts: new Date().toISOString(),
                    reqId: ctx.reqId,
                    elapsed: ms,
                    step: 'json-response',
                    request: { url: ctx.targetUrl, headers: ctx.reqHeaders, proxyOptions: ctx.proxyOpts },
                    response: { status: response.status(), bodyLength: text.length, body: text, headers: upstreamHeaders },
                });
                resolveJson!({ body: text, headers: upstreamHeaders, status: response.status() });
                return;
            }

            if (isDocument && !firstResponseLogged) {
                firstResponseLogged = true;
                const ms = elapsed(ctx);
                consola.info(`[#${ctx.reqId} +${ms}ms] First response: ${response.status()} (${text.length} bytes)`);
                logToFile({
                    ts: new Date().toISOString(),
                    reqId: ctx.reqId,
                    elapsed: ms,
                    step: 'first-response',
                    request: { url: ctx.targetUrl, headers: ctx.reqHeaders, proxyOptions: ctx.proxyOpts },
                    response: { status: response.status(), bodyLength: text.length, body: text },
                });
            }

            if (isDocument && !ctx.proxyOpts.render) {
                if (!text.includes('challenge-error-text') && !text.includes('Just a moment')) {
                    if (text.length > 1000) {
                        if (ctx.proxyOpts.logHtml) {
                            logHtmlStep(ctx.reqId, 'intercepted-response', text, ctx.targetUrl, elapsed(ctx), ctx.reqHeaders, ctx.proxyOpts);
                        }
                        resolveCapture!(text);
                    }
                } else {
                    consola.info(`[#${ctx.reqId} +${elapsed(ctx)}ms] Cloudflare challenge detected, waiting...`);
                }
            }
        } catch {
            // Body might be unavailable during rapid redirects
        }
    });

    return { jsonResponsePromise, captureHtmlPromise };
}

/** Render mode: wait for networkidle, optional selector, settle, return final DOM. */
async function renderPage(ctx: RequestContext, page: any): Promise<string> {
    if (ctx.proxyOpts.logHtml) {
        const commitHtml = await page.content();
        logHtmlStep(ctx.reqId, 'after-commit', commitHtml, ctx.targetUrl, elapsed(ctx), ctx.reqHeaders, ctx.proxyOpts);
    }

    await page.waitForLoadState('networkidle', { timeout: ctx.proxyOpts.wait }).catch(() => {
        consola.warn(`[#${ctx.reqId} +${elapsed(ctx)}ms] networkidle timed out, continuing with current DOM state`);
    });

    if (ctx.proxyOpts.logHtml) {
        const idleHtml = await page.content();
        logHtmlStep(ctx.reqId, 'after-networkidle', idleHtml, ctx.targetUrl, elapsed(ctx), ctx.reqHeaders, ctx.proxyOpts);
    }

    if (ctx.proxyOpts.selector) {
        try {
            await page.waitForSelector(ctx.proxyOpts.selector, { timeout: ctx.proxyOpts.wait });
            consola.info(`[#${ctx.reqId} +${elapsed(ctx)}ms] Selector "${ctx.proxyOpts.selector}" appeared`);
        } catch {
            consola.warn(`[#${ctx.reqId} +${elapsed(ctx)}ms] Selector "${ctx.proxyOpts.selector}" not found within ${ctx.proxyOpts.wait}ms`);
        }

        if (ctx.proxyOpts.logHtml) {
            const selectorHtml = await page.content();
            logHtmlStep(ctx.reqId, 'after-selector', selectorHtml, ctx.targetUrl, elapsed(ctx), ctx.reqHeaders, ctx.proxyOpts);
        }
    }

    await page.waitForTimeout(ctx.proxyOpts.settle);
    const rawHtml = await page.content();

    if (ctx.proxyOpts.logHtml) {
        logHtmlStep(ctx.reqId, 'final-rendered', rawHtml, ctx.targetUrl, elapsed(ctx), ctx.reqHeaders, ctx.proxyOpts);
    }

    return rawHtml;
}

/** Default mode: wait for the first real HTML response from the intercept listener. */
async function interceptPage(ctx: RequestContext, page: any, captureHtmlPromise: Promise<string>): Promise<string> {
    try {
        return await Promise.race([
            captureHtmlPromise,
            new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error('Timeout waiting for real HTML (Cloudflare might be stuck)')), 25000)
            )
        ]);
    } catch {
        consola.warn(`[#${ctx.reqId} +${elapsed(ctx)}ms] Intercept timed out, falling back to live DOM.`);
        const rawHtml = await page.content();
        if (ctx.proxyOpts.logHtml) {
            logHtmlStep(ctx.reqId, 'fallback-dom', rawHtml, ctx.targetUrl, elapsed(ctx), ctx.reqHeaders, ctx.proxyOpts);
        }
        return rawHtml;
    }
}

/** Log the final summary line and JSONL entry. */
function logCompletion(ctx: RequestContext, responseStatus: number, responseBody: string, fromCache: boolean, responseError?: string) {
    const duration = elapsed(ctx);

    // Cache the response if applicable
    if (!fromCache && !ctx.proxyOpts.render && !ctx.proxyOpts.selector && responseStatus === 200 && THROTTLE_REGEX.test(ctx.targetUrl)) {
        if (responseBody.length > 0) {
            setCachedResponse(ctx.cacheKey, responseBody, responseStatus, { 'content-type': 'text/html; charset=utf-8' });
        }
    }

    const cacheStatus = fromCache ? ` [cache-hit #${responseCache.get(ctx.cacheKey)?.hits || 0}]` :
        (!ctx.proxyOpts.render && !ctx.proxyOpts.selector && THROTTLE_REGEX.test(ctx.targetUrl) && responseStatus === 200) ? ' [cache-stored]' : '';
    const proxyOptsStr = ctx.tags.length ? ` [${ctx.tags.join(', ')}]` : '';
    const errorStr = responseError ? ` ERR: ${responseError}` : '';
    const truncUrl = ctx.targetUrl.substring(0, 70) + (ctx.targetUrl.length > 70 ? '...' : '');

    // For non-2XX, include status line and body summary
    const bodySummary = (responseStatus < 200 || responseStatus >= 300) ? ` body=${summarizeBody(responseBody)}` : '';

    const logFn = responseStatus >= 200 && responseStatus < 300 ? consola.success : consola.warn;
    logFn(`[#${ctx.reqId}] GET ${truncUrl} → ${responseStatus} (${responseBody.length}B) ${duration}ms${cacheStatus}${proxyOptsStr}${errorStr}${bodySummary}`);

    logToFile({
        ts: new Date().toISOString(),
        reqId: ctx.reqId,
        duration,
        method: 'GET',
        url: ctx.targetUrl,
        status: responseStatus,
        bodyLength: responseBody.length,
        cacheHit: fromCache,
        cacheStored: (!fromCache && !ctx.proxyOpts.render && !ctx.proxyOpts.selector && responseStatus === 200 && THROTTLE_REGEX.test(ctx.targetUrl)),
        proxyOptions: ctx.proxyOpts,
        ...(responseError ? { error: responseError } : {}),
    });
}

const app = new Hono();

app.get('/*', async (c) => {
    const ctxOrResponse = buildRequestContext(c);
    if (ctxOrResponse instanceof Response) return ctxOrResponse;
    const ctx = ctxOrResponse;

    // Check cache first
    const cachedResp = tryCache(ctx);
    if (cachedResp) return cachedResp;

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

        const { jsonResponsePromise, captureHtmlPromise } = attachResponseListeners(ctx, page);

        // Navigate
        await page.goto(ctx.targetUrl, { waitUntil: 'commit', timeout: 30000 });

        // Race JSON early-exit
        const jsonEarlyExit = await Promise.race([
            jsonResponsePromise.then(r => r),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
        ]);

        if (jsonEarlyExit) {
            responseStatus = jsonEarlyExit.status;
            responseBody = jsonEarlyExit.body;
            return new Response(jsonEarlyExit.body, {
                status: jsonEarlyExit.status,
                headers: stripHopByHop(jsonEarlyExit.headers),
            });
        }

        // HTML pipeline
        const rawHtml = ctx.proxyOpts.render
            ? await renderPage(ctx, page)
            : await interceptPage(ctx, page, captureHtmlPromise);

        const baseTag = `<base href="${ctx.targetOrigin}/">`;
        const finalHtml = rawHtml.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
        responseBody = finalHtml;
        return new Response(finalHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });

    } catch (error: any) {
        consola.error(`[#${ctx.reqId} +${elapsed(ctx)}ms] Error scraping ${ctx.targetUrl}: ${error.message}`);
        responseStatus = 500;
        responseError = error.message;
        responseBody = `Error scraping page: ${error.message}`;
        return new Response(responseBody, { status: 500 });
    } finally {
        if (page) await page.close().catch(logCleanupError);
        if (context) await context.close().catch(logCleanupError);

        logCompletion(ctx, responseStatus, responseBody, false, responseError);
    }
});

// --- START ---
initBrowser().then(() => {
    serve({
        fetch: app.fetch,
        port: PORT
    }, (info) => {
        consola.box(
            `🚀 Headless proxy running at http://localhost:${info.port}\n` +
            `📝 Logging requests to ${LOG_FILE}\n` +
            `⏱  Auto-shutdown after ${IDLE_TIMEOUT / 1000}s idle\n` +
            `⚡ Response throttle: ${THROTTLE_INTERVAL}ms, regex: ${opts.throttleRegex}`
        );
        notify('Proxy started', `Listening on port ${info.port}`);
    });
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
