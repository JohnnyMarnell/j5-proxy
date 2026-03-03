/// <reference lib="dom" />
/**
 * j5-proxy programmatic API
 *
 * @example
 * // One-shot scrape
 * import { scrape } from 'j5-proxy';
 * const { html } = await scrape('https://example.com', { render: true });
 *
 * @example
 * // Long-lived proxy server
 * import { createProxy } from 'j5-proxy';
 * const proxy = await createProxy({ port: 8787 });
 * // ... use the proxy ...
 * await proxy.stop();
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import {
    launchBrowser,
    scrapeWithBrowser,
    getCookies,
    cookiesAvailable,
    type ScrapeLoggers,
} from './core';
import { parseProxyOptions, ResponseCache, getCacheKey, stripHopByHop } from './lib';
import type { ProxyOptions } from './lib';

export type { ProxyOptions } from './lib';
export type { ScrapeLoggers, ScrapeOutput, CookiePrereqResult } from './core';

// --- scrape() ---

export interface ScrapeOptions {
    /** Full JS render mode — wait for networkidle + settle time. Default: false */
    render?: boolean;
    /** Max wait for networkidle / selector in ms. Default: 20000 */
    wait?: number;
    /** Wait for this CSS selector to appear before capturing the DOM. Default: none */
    selector?: string | null;
    /** Extra settle time after networkidle/selector in ms. Default: 1000 */
    settle?: number;
    /** Enable per-step HTML logging. Fires `onHtmlStep` at each pipeline stage. Default: false */
    logHtml?: boolean;
    /** Pre-fetched cookies to inject. If omitted, uses the shared cookie cache (if available). */
    cookies?: any[];
    /** Called at each HTML pipeline step when `logHtml` is true. */
    onHtmlStep?: (label: string, html: string, elapsedMs: number) => void;
}

export interface ScrapeResult {
    /** Final HTML string, or the raw JSON body if the upstream returned application/json. */
    html: string;
    /** HTTP status code from the upstream page. */
    status: number;
    /** Normalized URL that was fetched. */
    url: string;
    /** True if the upstream returned application/json (html contains the raw JSON string). */
    isJson: boolean;
    /** Upstream response headers with hop-by-hop headers removed. */
    headers: Record<string, string>;
}

let _apiReqId = 0;

/**
 * Scrape a URL through a stealth Playwright browser.
 *
 * Manages its own browser lifecycle — creates and closes a Chromium instance per call.
 * For repeated scraping, prefer `createProxy()` which keeps a browser alive.
 */
export async function scrape(url: string, options: ScrapeOptions = {}): Promise<ScrapeResult> {
    const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;
    const targetOrigin = new URL(normalizedUrl).origin;
    const reqId = ++_apiReqId;
    const startTime = Date.now();

    const proxyOpts: ProxyOptions = {
        render: options.render ?? false,
        logHtml: options.logHtml ?? false,
        wait: options.wait ?? 20000,
        selector: options.selector ?? null,
        settle: options.settle ?? 1000,
        refreshCookies: false,
    };

    const loggers: ScrapeLoggers = {
        info: () => {},
        warn: () => {},
        onHtmlStep: options.onHtmlStep
            ? (label, html, elapsedMs) => options.onHtmlStep!(label, html, elapsedMs)
            : undefined,
    };

    const cookies = options.cookies ?? (cookiesAvailable ? getCookies() : []);
    const browser = await launchBrowser();
    try {
        const output = await scrapeWithBrowser(browser, reqId, startTime, normalizedUrl, proxyOpts, cookies, loggers);

        if (output.isJson) {
            return { html: output.body, status: output.status, url: normalizedUrl, isJson: true, headers: output.headers };
        }

        const baseTag = `<base href="${targetOrigin}/">`;
        const html = output.body.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
        return { html, status: output.status, url: normalizedUrl, isJson: false, headers: output.headers };
    } finally {
        await browser.close();
    }
}

// --- createProxy() ---

export interface ProxyConfig {
    /** HTTP port to listen on. Default: 8787 */
    port?: number;
    /** Cookie cache TTL in ms. Default: 3600000 (1 hour) */
    cookieTtl?: number;
    /** Enable HTML step logging globally for all requests. Default: false */
    logHtml?: boolean;
    /** Cache GET responses for this many ms. Default: 5000 */
    throttleInterval?: number;
    /** Only cache URLs matching this regex. Default: all URLs */
    throttleRegex?: string | RegExp;
}

export interface ProxyServer {
    /** The port the server is actually listening on. */
    readonly port: number;
    /** Gracefully close the browser and stop the HTTP server. */
    stop(): Promise<void>;
}

/**
 * Start a j5-proxy HTTP server programmatically.
 *
 * Keeps a single Chromium browser alive for the server's lifetime, making it
 * efficient for sustained workloads. Supports the same `X-Proxy-Options` header
 * as the CLI server.
 *
 * @example
 * const proxy = await createProxy({ port: 9000, throttleInterval: 10_000 });
 * // proxy is now running at http://localhost:9000
 * // GET http://localhost:9000/https://example.com to scrape
 * await proxy.stop();
 */
export async function createProxy(config: ProxyConfig = {}): Promise<ProxyServer> {
    const throttleInterval = config.throttleInterval ?? 5000;
    const throttleRegex = config.throttleRegex instanceof RegExp
        ? config.throttleRegex
        : new RegExp(config.throttleRegex ?? '.*');
    const cookieTtl = config.cookieTtl ?? 3_600_000;

    const responseCache = new ResponseCache(throttleInterval);
    const browser = await launchBrowser();
    let reqCounter = 0;

    const app = new Hono();

    app.get('/*', async (c) => {
        const path = c.req.path.slice(1);
        if (!path || path === 'favicon.ico') return c.text('Not found', 404);

        const targetUrl = path.startsWith('http') ? path : `https://${path}`;
        let targetOrigin: string;
        try { targetOrigin = new URL(targetUrl).origin; }
        catch { return c.text('Invalid URL', 400); }

        const proxyOpts = parseProxyOptions(c.req.header('x-proxy-options'), config.logHtml ?? false);
        const reqId = ++reqCounter;
        const startTime = Date.now();

        // Throttle cache
        const cacheKey = getCacheKey('GET', targetUrl, {});
        if (!proxyOpts.render && !proxyOpts.selector && throttleRegex.test(targetUrl)) {
            const cached = responseCache.get(cacheKey);
            if (cached) {
                return new Response(cached.body, { status: cached.status, headers: stripHopByHop(cached.headers) });
            }
        }

        const cookies = cookiesAvailable ? getCookies(false, cookieTtl) : [];

        try {
            const output = await scrapeWithBrowser(browser, reqId, startTime, targetUrl, proxyOpts, cookies);

            if (output.isJson) {
                return new Response(output.body, { status: output.status, headers: stripHopByHop(output.headers) });
            }

            const baseTag = `<base href="${targetOrigin}/">`;
            const html = output.body.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);

            if (!proxyOpts.render && !proxyOpts.selector && output.status === 200 && throttleRegex.test(targetUrl)) {
                responseCache.set(cacheKey, html, 200, { 'content-type': 'text/html; charset=utf-8' });
            }

            return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        } catch (err: any) {
            return new Response(`Error: ${err.message}`, { status: 500 });
        }
    });

    return new Promise<ProxyServer>((resolve, reject) => {
        try {
            const server = serve({ fetch: app.fetch, port: config.port ?? 8787 }, (info) => {
                resolve({
                    port: info.port,
                    stop: async () => {
                        await browser.close();
                        await new Promise<void>((res) => server.close(() => res()));
                    },
                });
            });
        } catch (err) {
            reject(err);
        }
    });
}
