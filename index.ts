#!/usr/bin/env bun
/// <reference lib="dom" />
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cac } from 'cac';
import consola, { type ConsolaReporter, type LogObject } from 'consola';
import { formatWithOptions } from 'node:util';
import { appendFileSync } from 'node:fs';
import notifier from 'node-notifier';
import {
    launchBrowser,
    scrapeWithBrowser,
    getCookies,
    checkCookiePrereqs,
    cookiesAvailable,
    logCleanupError,
    type ScrapeLoggers,
} from './core';
import {
    parseProxyOptions,
    getCacheKey,
    summarizeBody,
    stripHopByHop,
    ResponseCache,
    validateZyteAuth,
} from './lib';
import type { ProxyOptions, CachedResponse } from './lib';

// When stdout is not a TTY (PM2, pipes, etc.) replace the fancy right-aligned
// reporter with a plain left-justified one: "[Mon Mar 02 14:38:06] [type] msg"
if (!process.stdout.isTTY) {
    const plainReporter: ConsolaReporter = {
        log(logObj: LogObject) {
            const d = logObj.date ?? new Date();
            const ts = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            const type = logObj.type !== 'log' ? `[${logObj.type}] ` : '';
            const msg = formatWithOptions({}, ...logObj.args);
            const stream = logObj.level < 2 ? process.stderr : process.stdout;
            stream.write(`[${ts}] ${type}${msg}\n`);
        }
    };
    consola.setReporters([plainReporter]);
}

// --- CLI ARGUMENT PARSING ---
const cli = cac('j5-proxy');

cli
    .option('-p, --port <port>', 'Server port', { default: 8787 })
    .option('-t, --ttl <ms>', 'Cookie cache TTL (ms)', { default: 3600000 })
    .option('--log-html', 'Log HTML at each pipeline step to stdout', { default: false })
    .option('--log-file <path>', 'Path for the JSONL request log', { default: '/tmp/j5-proxy.jsonl' })
    .option('-i, --idle <ms>', 'Auto-shutdown after ms of inactivity (0 to disable)', { default: 1800000 })
    .option('--throttle-interval <ms>', 'Cache responses for this many ms', { default: 5000 })
    .option('--throttle-regex <pattern>', 'Only cache URLs matching this regex', { default: '.*' })
    .option('--notify', 'Send OS notification on non-2XX responses (use --no-notify to disable)', { default: true })
    .option('--startup-notify', 'Send OS notification on startup (use --no-startup-notify to disable)', { default: true })
    .option('--refresh-cookies', 'Force fresh cookie extraction on startup — errors loudly if unavailable', { default: false })
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
const NOTIFY_ON_ERROR: boolean = opts.notify as boolean;
const STARTUP_NOTIFY: boolean = opts.startupNotify as boolean;
const REFRESH_COOKIES_ON_START: boolean = opts.refreshCookies as boolean;

// --- STARTUP PRE-REQUISITE CHECKS ---
function checkPrereqs(): void {
    // Runtime: warn if not Bun
    if (!process.versions.bun) {
        const detected = Object.keys(process.versions)
            .filter(k => !['node','v8','uv','zlib','brotli','ares','modules','nghttp2','napi','llhttp','openssl','cldr','icu','tz','unicode'].includes(k))
            .join(', ') || 'unknown';
        consola.warn(`Not running under Bun (runtime: ${detected || 'node-like'}). Expected: bun index.ts`);
    }

    // Platform: warn if not macOS (Chrome cookie extraction is macOS-only)
    if (process.platform !== 'darwin') {
        consola.warn(`Running on ${process.platform}, not macOS. Chrome cookie extraction will likely fail.`);
    }

    // Cookie prereqs — warn only, never exit (unless --refresh-cookies was explicitly passed)
    const { available, reason } = checkCookiePrereqs();
    if (!available) {
        consola.warn(
            `Cookie extraction unavailable (${reason}). ` +
            `Proxy works fine without cookies — pass --refresh-cookies or ` +
            `X-Proxy-Options: refresh-cookies to force a refresh attempt.`
        );
    }

    // --refresh-cookies: error hard only when the user explicitly asked for it
    if (REFRESH_COOKIES_ON_START && !available) {
        consola.error(`--refresh-cookies was requested but cookie extraction is unavailable: ${reason}`);
        process.exit(1);
    }
}

// --- OS NOTIFICATIONS ---
function notify(title: string, message: string) {
    notifier.notify({ title, message, sound: false });
}

function notifyError(reqId: number, status: number, url: string) {
    if (!NOTIFY_ON_ERROR) return;
    const short = url.length > 60 ? url.substring(0, 57) + '…' : url;
    notifier.notify({ title: `j5-proxy ⚠ ${status}`, message: `[#${reqId}] ${short}`, sound: true });
}

// --- JSONL LOGGER ---
function logToFile(entry: Record<string, any>) {
    try {
        appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    } catch (e: any) {
        consola.error(`Failed to write to ${LOG_FILE}: ${e.message}`);
    }
}

// --- HTML STEP LOGGER ---
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

function resetIdleTimer() { lastRequestTime = Date.now(); }

const idleInterval = IDLE_TIMEOUT > 0 ? setInterval(() => {
    if (Date.now() - lastRequestTime >= IDLE_TIMEOUT) {
        consola.warn(`No requests for ${IDLE_TIMEOUT / 1000}s — shutting down due to inactivity.`);
        shutdown('inactivity');
    }
}, 10000) : null;
if (idleInterval) idleInterval.unref();

// --- SHUTDOWN ---
let shuttingDown = false;
let browser: any;

async function shutdown(reason = 'signal') {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleInterval) clearInterval(idleInterval);
    consola.warn(`Shutting down (${reason})...`);
    notify('j5-proxy shutting down', `Reason: ${reason}`);
    if (browser) await browser.close();
    process.exit(0);
}

// --- RESPONSE THROTTLE CACHE ---
const responseCache = new ResponseCache(THROTTLE_INTERVAL);

// --- REQUEST HANDLING ---

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

function buildRequestContext(c: import('hono').Context): RequestContext | Response {
    const reqId = ++requestCounter;
    resetIdleTimer();
    const startTime = Date.now();

    const path = c.req.path.substring(1);
    if (!path || path === 'favicon.ico') return c.text('Not found', 404);

    const targetUrl = path.startsWith('http') ? path : `https://${path}`;

    let targetOrigin = '';
    try {
        targetOrigin = new URL(targetUrl).origin;
    } catch {
        return c.text('Invalid URL provided', 400);
    }

    const proxyOpts = parseProxyOptions(c.req.header('x-proxy-options'), GLOBAL_LOG_HTML);

    const reqHeaders: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => { reqHeaders[k] = v; });

    const queryParams: Record<string, string> = {};
    new URL(targetUrl).searchParams.forEach((v, k) => { queryParams[k] = v; });
    const cacheKey = getCacheKey('GET', targetUrl, queryParams);

    const tags = [
        proxyOpts.render ? 'render' : null,
        proxyOpts.logHtml ? 'log-html' : null,
        proxyOpts.selector ? `selector=${proxyOpts.selector}` : null,
        proxyOpts.refreshCookies ? 'refresh-cookies' : null,
        (!proxyOpts.render && !proxyOpts.selector && THROTTLE_REGEX.test(targetUrl)) ? 'cached' : null,
    ].filter(Boolean) as string[];

    return { reqId, startTime, targetUrl, targetOrigin, proxyOpts, reqHeaders, cacheKey, tags };
}

function tryCache(ctx: RequestContext): Response | null {
    if (ctx.proxyOpts.render || ctx.proxyOpts.selector || !THROTTLE_REGEX.test(ctx.targetUrl)) return null;

    const cached = responseCache.get(ctx.cacheKey);
    if (!cached) return null;

    const duration = elapsed(ctx);
    consola.success(`[#${ctx.reqId}] GET ${ctx.targetUrl.substring(0, 80)} → ${cached.status} (${cached.body.length}B) ${duration}ms [cache-hit #${cached.hits}]`);
    logToFile({
        ts: new Date().toISOString(), reqId: ctx.reqId, duration, method: 'GET',
        url: ctx.targetUrl, status: cached.status, bodyLength: cached.body.length,
        cacheHit: true, cacheHits: cached.hits,
    });
    return new Response(cached.body, { status: cached.status, headers: stripHopByHop(cached.headers) });
}

function logCompletion(ctx: RequestContext, responseStatus: number, responseBody: string, fromCache: boolean, responseError?: string) {
    const duration = elapsed(ctx);

    if (!fromCache && !ctx.proxyOpts.render && !ctx.proxyOpts.selector && responseStatus === 200 && THROTTLE_REGEX.test(ctx.targetUrl)) {
        if (responseBody.length > 0) {
            responseCache.set(ctx.cacheKey, responseBody, responseStatus, { 'content-type': 'text/html; charset=utf-8' });
        }
    }

    const cacheStatus = fromCache ? ` [cache-hit #${responseCache.getEntry(ctx.cacheKey)?.hits || 0}]` :
        (!ctx.proxyOpts.render && !ctx.proxyOpts.selector && THROTTLE_REGEX.test(ctx.targetUrl) && responseStatus === 200) ? ' [cache-stored]' : '';
    const proxyOptsStr = ctx.tags.length ? ` [${ctx.tags.join(', ')}]` : '';
    const errorStr = responseError ? ` ERR: ${responseError}` : '';
    const truncUrl = ctx.targetUrl.substring(0, 70) + (ctx.targetUrl.length > 70 ? '...' : '');
    const bodySummary = (responseStatus < 200 || responseStatus >= 300) ? ` body=${summarizeBody(responseBody)}` : '';

    const isSuccess = responseStatus >= 200 && responseStatus < 300;
    const logFn = isSuccess ? consola.success : consola.warn;
    logFn(`[#${ctx.reqId}] GET ${truncUrl} → ${responseStatus} (${responseBody.length}B) ${duration}ms${cacheStatus}${proxyOptsStr}${errorStr}${bodySummary}`);
    if (!isSuccess) notifyError(ctx.reqId, responseStatus, ctx.targetUrl);

    logToFile({
        ts: new Date().toISOString(), reqId: ctx.reqId, duration, method: 'GET',
        url: ctx.targetUrl, status: responseStatus, bodyLength: responseBody.length,
        cacheHit: fromCache,
        cacheStored: (!fromCache && !ctx.proxyOpts.render && !ctx.proxyOpts.selector && responseStatus === 200 && THROTTLE_REGEX.test(ctx.targetUrl)),
        proxyOptions: ctx.proxyOpts,
        ...(responseError ? { error: responseError } : {}),
    });
}

const app = new Hono();

// --- ZYTE API EMULATION ---
app.post('/:version{v\\d+}/extract', async (c) => {
    const reqId = ++requestCounter;
    resetIdleTimer();
    const startTime = Date.now();

    const apiKey = validateZyteAuth(c.req.header('authorization'));
    if (!apiKey) {
        return c.json({ type: '/auth/key-not-found', title: 'Authentication Key Not Found', status: 401, detail: "The authentication key is not valid or can't be matched." }, 401);
    }

    let body: Record<string, any>;
    try { body = await c.req.json(); }
    catch { return c.json({ type: '/error/bad-request', title: 'Bad Request', status: 400, detail: 'Invalid JSON body.' }, 400); }

    const rawUrl: string | undefined = body.url;
    if (!rawUrl) {
        return c.json({ type: '/error/bad-request', title: 'Bad Request', status: 400, detail: 'Missing required field: url.' }, 400);
    }

    const targetUrl = rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : `https://${rawUrl}`;
    try { new URL(targetUrl); }
    catch { return c.json({ type: '/error/bad-request', title: 'Bad Request', status: 400, detail: 'Invalid URL.' }, 400); }

    const wantHttpResponseBody = !!body.httpResponseBody;
    const version = c.req.param('version');
    consola.info(`[#${reqId}] ZYTE POST /${version}/extract key=${apiKey.slice(0, 4)}… url=${targetUrl}`);

    const zyteProxyOpts: ProxyOptions = {
        render: false, logHtml: false, wait: 20000, selector: null, settle: 1000, refreshCookies: false,
    };
    const zyteLoggers: ScrapeLoggers = {
        info: (msg) => consola.info(msg),
        warn: (msg) => consola.warn(msg),
    };

    try {
        const cookies = cookiesAvailable ? getCookies(false, COOKIE_CACHE_TTL) : [];
        const output = await scrapeWithBrowser(
            browser, reqId, startTime, targetUrl, zyteProxyOpts, cookies, zyteLoggers, (msg) => consola.warn(msg)
        );

        const duration = Date.now() - startTime;
        const ok = output.status >= 200 && output.status < 300;
        (ok ? consola.success : consola.warn)(`[#${reqId}] ZYTE ${targetUrl.substring(0, 70)} → ${output.status} (${output.body.length}B) ${duration}ms`);
        if (!ok) notifyError(reqId, output.status, targetUrl);
        logToFile({ ts: new Date().toISOString(), reqId, duration, method: 'ZYTE', url: targetUrl, status: output.status, bodyLength: output.body.length });

        const result: Record<string, any> = { url: targetUrl, statusCode: output.status };
        if (wantHttpResponseBody) result.httpResponseBody = Buffer.from(output.body).toString('base64');
        return c.json(result);

    } catch (error: any) {
        const duration = Date.now() - startTime;
        consola.error(`[#${reqId}] ZYTE error ${targetUrl}: ${error.message}`);
        notifyError(reqId, 500, targetUrl);
        logToFile({ ts: new Date().toISOString(), reqId, duration, method: 'ZYTE', url: targetUrl, status: 500, error: error.message });
        return c.json({ type: '/error/internal', title: 'Internal Error', status: 500, detail: error.message }, 500);
    }
});

// --- MAIN GET HANDLER ---
app.get('/*', async (c) => {
    const ctxOrResponse = buildRequestContext(c);
    if (ctxOrResponse instanceof Response) return ctxOrResponse;
    const ctx = ctxOrResponse;

    // refresh-cookies via header: error if unavailable
    if (ctx.proxyOpts.refreshCookies && !cookiesAvailable) {
        return c.json({
            error: 'Cookie refresh requested but extraction is unavailable.',
            hint: 'Install browser-cookie3, ensure cookies.py exists alongside the binary, or set J5_COOKIE_SCRIPT.',
        }, 503);
    }

    const cachedResp = tryCache(ctx);
    if (cachedResp) return cachedResp;

    let responseStatus = 200;
    let responseBody = '';
    let responseError: string | undefined;

    try {
        const cookies = cookiesAvailable ? getCookies(ctx.proxyOpts.refreshCookies, COOKIE_CACHE_TTL) : [];

        const loggers: ScrapeLoggers = {
            info: (msg) => consola.info(msg),
            warn: (msg) => consola.warn(msg),
            onFirstResponse: (status, bytes, ms) => logToFile({
                ts: new Date().toISOString(), reqId: ctx.reqId, elapsed: ms, step: 'first-response',
                request: { url: ctx.targetUrl, headers: ctx.reqHeaders, proxyOptions: ctx.proxyOpts },
                response: { status, bodyLength: bytes },
            }),
            onJsonResponse: (status, bytes, ms, headers, body) => logToFile({
                ts: new Date().toISOString(), reqId: ctx.reqId, elapsed: ms, step: 'json-response',
                request: { url: ctx.targetUrl, headers: ctx.reqHeaders, proxyOptions: ctx.proxyOpts },
                response: { status, bodyLength: bytes, body, headers },
            }),
            onHtmlStep: (label, html, ms) => logHtmlStep(ctx.reqId, label, html, ctx.targetUrl, ms, ctx.reqHeaders, ctx.proxyOpts),
        };

        const output = await scrapeWithBrowser(
            browser, ctx.reqId, ctx.startTime, ctx.targetUrl, ctx.proxyOpts, cookies, loggers, (msg) => consola.warn(msg)
        );

        responseStatus = output.status;

        if (output.isJson) {
            responseBody = output.body;
            return new Response(output.body, { status: output.status, headers: stripHopByHop(output.headers) });
        }

        const baseTag = `<base href="${ctx.targetOrigin}/">`;
        const finalHtml = output.body.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
        responseBody = finalHtml;
        return new Response(finalHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });

    } catch (error: any) {
        consola.error(`[#${ctx.reqId} +${elapsed(ctx)}ms] Error scraping ${ctx.targetUrl}: ${error.message}`);
        responseStatus = 500;
        responseError = error.message;
        responseBody = `Error scraping page: ${error.message}`;
        return new Response(responseBody, { status: 500 });
    } finally {
        logCompletion(ctx, responseStatus, responseBody, false, responseError);
    }
});

// --- START ---
checkPrereqs();

async function initBrowser() {
    consola.start('Booting Chromium...');
    browser = await launchBrowser();
    consola.ready('Browser ready.');
}

initBrowser().then(() => {
    serve({ fetch: app.fetch, port: PORT }, (info) => {
        const idleNote = IDLE_TIMEOUT > 0
            ? `⏱  Auto-shutdown after ${IDLE_TIMEOUT / 1000}s idle`
            : `⏱  Idle auto-shutdown disabled`;
        consola.box(
            `🚀 j5-proxy running at http://localhost:${info.port}\n` +
            `📝 Logging requests to ${LOG_FILE}\n` +
            idleNote + '\n' +
            `⚡ Response throttle: ${THROTTLE_INTERVAL}ms, regex: ${opts.throttleRegex}\n` +
            `🍪 Cookies: ${cookiesAvailable ? 'available' : 'unavailable (proxy works, but without session cookies)'}`
        );
        if (STARTUP_NOTIFY) notify('j5-proxy started', `Listening on port ${info.port}`);
    });
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
