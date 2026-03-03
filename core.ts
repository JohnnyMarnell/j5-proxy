/// <reference lib="dom" />
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProxyOptions } from './lib';

// Apply stealth plugin once — chromium is a module-level singleton shared across all imports
chromium.use(stealth());

export const STEALTH_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --- BROWSER ---

export async function launchBrowser(): Promise<any> {
    return chromium.launch({ headless: true });
}

// --- CLEANUP ERROR DEBOUNCE ---

let _cleanupErrCount = 0;
let _cleanupErrTimer: ReturnType<typeof setTimeout> | null = null;

export function logCleanupError(warn: (msg: string) => void = () => {}) {
    _cleanupErrCount++;
    if (!_cleanupErrTimer) {
        _cleanupErrTimer = setTimeout(() => {
            warn(`${_cleanupErrCount} stale CDP session error${_cleanupErrCount > 1 ? 's' : ''} suppressed during cleanup.`);
            _cleanupErrCount = 0;
            _cleanupErrTimer = null;
        }, 2000);
    }
}

// --- COOKIE MANAGEMENT ---

/** Finds cookies.py by checking several candidate locations. */
function findCookieScript(): string | null {
    try {
        // Bun provides import.meta.dir; Node ESM needs fileURLToPath
        const dir: string = typeof (import.meta as any).dir === 'string'
            ? (import.meta as any).dir
            : dirname(fileURLToPath(import.meta.url));

        const candidates = [
            process.env['J5_COOKIE_SCRIPT'],  // explicit override always wins
            join(dir, 'cookies.py'),           // dev: core.ts lives in project root
            join(dir, '..', 'cookies.py'),     // compiled: dist/core.js → one level up
        ].filter(Boolean) as string[];

        return candidates.find(p => existsSync(p)) ?? null;
    } catch {
        return null;
    }
}

export let cookiesAvailable = false;
let _pythonCmd: string | null = null;
let _cookieScriptPath: string | null = null;
let _cachedCookies: any[] = [];
let _lastCookieFetch = 0;

export interface CookiePrereqResult {
    available: boolean;
    reason?: string;
}

/**
 * Probes for Python + browser_cookie3 + cookies.py.
 * Sets the module-level `cookiesAvailable` flag.
 * Safe to call multiple times — re-probes each time.
 */
export function checkCookiePrereqs(): CookiePrereqResult {
    _cookieScriptPath = findCookieScript();

    _pythonCmd = null;
    for (const cmd of ['python3', 'python']) {
        try {
            execSync(`${cmd} -c "import browser_cookie3"`, { stdio: 'pipe' });
            _pythonCmd = cmd;
            break;
        } catch {}
    }

    const reasons = [
        !_pythonCmd     ? 'browser_cookie3 not found (pip install browser-cookie3)' : null,
        !_cookieScriptPath ? 'cookies.py not found (expected alongside the binary, or set J5_COOKIE_SCRIPT)' : null,
    ].filter(Boolean).join('; ');

    cookiesAvailable = !!_pythonCmd && !!_cookieScriptPath;
    return cookiesAvailable ? { available: true } : { available: false, reason: reasons };
}

/**
 * Returns cookies from cache, or runs cookies.py to get fresh ones.
 *
 * - Normal mode (`forceRefresh=false`): returns [] silently if unavailable.
 * - Refresh mode (`forceRefresh=true`): throws if unavailable.
 */
export function getCookies(forceRefresh = false, ttl = 3_600_000): any[] {
    if (forceRefresh && !cookiesAvailable) {
        throw new Error(
            'Cookie refresh requested but extraction is unavailable. ' +
            'Install browser-cookie3 and ensure cookies.py exists alongside the binary, ' +
            'or point J5_COOKIE_SCRIPT to its path.'
        );
    }

    if (!cookiesAvailable) return [];

    const now = Date.now();
    if (!forceRefresh && _cachedCookies.length > 0 && now - _lastCookieFetch < ttl) {
        return _cachedCookies;
    }

    try {
        const out = execSync(`${_pythonCmd!} ${_cookieScriptPath!}`).toString();
        const parsed = JSON.parse(out);
        if (parsed.error) throw new Error(parsed.error);
        _cachedCookies = parsed;
        _lastCookieFetch = now;
        return _cachedCookies;
    } catch (err: any) {
        if (forceRefresh) throw err;
        return _cachedCookies; // return stale on silent failure
    }
}

// --- SCRAPING PIPELINE ---

export interface ScrapeLoggers {
    info(msg: string): void;
    warn(msg: string): void;
    /** 0 = silent, 1 = requests+aborts, 2 = +truncated HTML steps, 3 = +full HTML */
    verbosity?: number;
    /** Called on the first document response from the browser. */
    onFirstResponse?(status: number, bytes: number, ms: number): void;
    /** Called when an application/json response is detected. */
    onJsonResponse?(status: number, bytes: number, ms: number, headers: Record<string, string>, body: string): void;
    /** Called at each HTML pipeline step when logHtml is enabled. */
    onHtmlStep?(label: string, html: string, ms: number): void;
    /** Called when a screenshot is captured. */
    onScreenshot?(path: string, ms: number): void;
    onSelectorFound?(selector: string): void;
    onSelectorTimeout?(selector: string, timeoutMs: number): void;
    onNetworkIdleTimeout?(): void;
}

const SILENT: ScrapeLoggers = { info: () => {}, warn: () => {} };

export interface ScrapeOutput {
    isJson: boolean;
    status: number;
    body: string;
    headers: Record<string, string>;
    screenshotPath?: string;
}


function ms(startTime: number) { return Date.now() - startTime; }

// Sanitize a URL for use as a filename
function sanitizeUrlForFilename(url: string): string {
    try {
        const parsed = new URL(url);
        const domain = parsed.hostname.replace(/\./g, '-');
        const path = parsed.pathname.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 50);
        return `j5-proxy_${domain}${path}`.slice(0, 100);
    } catch {
        return 'j5-proxy_screenshot';
    }
}

// Screenshot capture — doesn't block request, errors are silently logged
export async function captureScreenshotAsync(
    page: any,
    url: string,
    reqId: number,
    startTime: number,
    loggers: ScrapeLoggers = SILENT,
): Promise<string | undefined> {
    try {
        const sanitized = sanitizeUrlForFilename(url);
        const timestamp = Date.now();
        const filename = `/tmp/${sanitized}_${timestamp}.png`;
        await page.screenshot({ path: filename, fullPage: true });
        loggers.info(`[#${reqId}] Screenshot saved: ${filename}`);
        loggers.onScreenshot?.(filename, ms(startTime));
        return filename;
    } catch (err: any) {
        loggers.warn(`[#${reqId}] Screenshot failed: ${err.message}`);
        return undefined;
    }
}

export function attachResponseListeners(
    page: any,
    reqId: number,
    startTime: number,
    targetUrl: string,
    proxyOpts: ProxyOptions,
    loggers: ScrapeLoggers = SILENT,
): { jsonResponsePromise: Promise<{ body: string; headers: Record<string, string>; status: number }>; captureHtmlPromise: Promise<string>; skipCounts: Record<string, number> } {
    let firstResponseLogged = false;
    let resolveJson!: (r: { body: string; headers: Record<string, string>; status: number }) => void;
    const jsonResponsePromise = new Promise<{ body: string; headers: Record<string, string>; status: number }>((r) => { resolveJson = r; });
    let resolveCapture!: (html: string) => void;
    let rejectCapture!: (err: Error) => void;
    const captureHtmlPromise = new Promise<string>((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject; });
    const skipCounts: Record<string, number> = {};
    const verbosity = loggers.verbosity ?? 0;

    // -vvv: log every request as it fires (including those about to be skipped)
    if (verbosity >= 3) {
        page.on('request', (req: any) => {
            loggers.info(`[#${reqId} +${ms(startTime)}ms] → ${req.resourceType()} ${req.url().substring(0, 120)}`);
        });
    } else if (verbosity >= 1) {
        // -v / -vv: only log document requests (skips will surface via requestfailed)
        page.on('request', (req: any) => {
            if (req.resourceType() === 'document') {
                loggers.info(`[#${reqId} +${ms(startTime)}ms] → document ${req.url().substring(0, 120)}`);
            }
        });
    }

    page.on('requestfailed', (req: any) => {
        const reason = req.failure()?.errorText ?? 'unknown';
        const aborted = reason === 'net::ERR_ABORTED';
        const type = req.resourceType();
        const url = req.url().substring(0, 120);

        if (aborted) {
            // Our intentional skip — accumulate for summary (-v) or log individually (-vv+)
            if (verbosity >= 2) {
                loggers.info(`[#${reqId} +${ms(startTime)}ms] ✗ skip ${type} ${url}`);
            } else if (verbosity >= 1) {
                skipCounts[type] = (skipCounts[type] ?? 0) + 1;
            }
        } else {
            // Real failure — always warn regardless of verbosity
            if (type === 'document') {
                loggers.warn(`[#${reqId} +${ms(startTime)}ms] ✗ DOCUMENT FAILED (${reason}) ${url}`);
                rejectCapture(new Error(`Document request failed: ${reason} ${req.url()}`));
            } else {
                loggers.warn(`[#${reqId} +${ms(startTime)}ms] ✗ failed (${reason}) ${type} ${url}`);
            }
        }
    });

    if (verbosity >= 1) {
        page.on('response', (res: any) => {
            const loc = res.headers()['location'] ? ` → ${res.headers()['location']}` : '';
            loggers.info(`[#${reqId} +${ms(startTime)}ms] ← ${res.status()} ${res.request().resourceType()} ${res.url().substring(0, 120)}${loc}`);
        });
    }

    page.on('response', async (response: any) => {
        if (response.request().frame() !== page.mainFrame()) return;

        const contentType = response.headers()['content-type'] || '';
        const isJson = contentType.includes('application/json');
        const isDocument = response.request().resourceType() === 'document';

        if (!isDocument && !isJson) return;

        try {
            const text = await response.text();

            if (isJson) {
                const elapsed = ms(startTime);
                loggers.info(`[#${reqId} +${elapsed}ms] JSON response: ${response.status()} (${text.length} bytes)`);
                const upstreamHeaders: Record<string, string> = {};
                for (const [k, v] of Object.entries(response.headers())) {
                    upstreamHeaders[k] = v as string;
                }
                loggers.onJsonResponse?.(response.status(), text.length, elapsed, upstreamHeaders, text);
                resolveJson({ body: text, headers: upstreamHeaders, status: response.status() });
                return;
            }

            if (isDocument && !firstResponseLogged) {
                firstResponseLogged = true;
                const elapsed = ms(startTime);
                loggers.info(`[#${reqId} +${elapsed}ms] First response: ${response.status()} (${text.length} bytes)`);
                loggers.onFirstResponse?.(response.status(), text.length, elapsed);
            }

            if (isDocument && !proxyOpts.render) {
                if (text.length > 1000) {
                    if (proxyOpts.logHtml) {
                        loggers.onHtmlStep?.('intercepted-response', text, ms(startTime));
                    }
                    resolveCapture(text);
                }
            }
        } catch {
            // Body might be unavailable during rapid redirects
        }
    });

    return { jsonResponsePromise, captureHtmlPromise, skipCounts };
}

export async function renderPage(
    page: any,
    reqId: number,
    startTime: number,
    proxyOpts: ProxyOptions,
    loggers: ScrapeLoggers = SILENT,
): Promise<string> {
    if (proxyOpts.logHtml) {
        loggers.onHtmlStep?.('after-commit', await page.content(), ms(startTime));
    }

    await page.waitForLoadState('networkidle', { timeout: proxyOpts.wait }).catch(() => {
        loggers.warn(`[#${reqId} +${ms(startTime)}ms] networkidle timed out, continuing with current DOM`);
        loggers.onNetworkIdleTimeout?.();
    });

    if (proxyOpts.logHtml) {
        loggers.onHtmlStep?.('after-networkidle', await page.content(), ms(startTime));
    }

    if (proxyOpts.selector) {
        try {
            await page.waitForSelector(proxyOpts.selector, { timeout: proxyOpts.wait });
            loggers.info(`[#${reqId} +${ms(startTime)}ms] Selector "${proxyOpts.selector}" appeared`);
            loggers.onSelectorFound?.(proxyOpts.selector);
        } catch {
            loggers.warn(`[#${reqId} +${ms(startTime)}ms] Selector "${proxyOpts.selector}" not found within ${proxyOpts.wait}ms`);
            loggers.onSelectorTimeout?.(proxyOpts.selector, proxyOpts.wait);
        }
        if (proxyOpts.logHtml) {
            loggers.onHtmlStep?.('after-selector', await page.content(), ms(startTime));
        }
    }

    await page.waitForTimeout(proxyOpts.settle);
    const rawHtml = await page.content();
    if (proxyOpts.logHtml) {
        loggers.onHtmlStep?.('final-rendered', rawHtml, ms(startTime));
    }
    return rawHtml;
}

export async function interceptPage(
    page: any,
    reqId: number,
    startTime: number,
    proxyOpts: ProxyOptions,
    captureHtmlPromise: Promise<string>,
    loggers: ScrapeLoggers = SILENT,
): Promise<string> {
    try {
        return await Promise.race([
            captureHtmlPromise,
            new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error('Timeout waiting for real HTML (Cloudflare might be stuck)')), 25000)
            ),
        ]);
    } catch {
        loggers.warn(`[#${reqId} +${ms(startTime)}ms] Intercept timed out, falling back to live DOM.`);
        const rawHtml = await page.content();
        if (proxyOpts.logHtml) {
            loggers.onHtmlStep?.('fallback-dom', rawHtml, ms(startTime));
        }
        return rawHtml;
    }
}

/**
 * Core scraping function. Opens a browser context, navigates to the URL,
 * and returns the final HTML or JSON body.
 *
 * Handles JSON early-exit, Cloudflare detection, render mode, and selector waiting.
 * Logging is fully optional via the `loggers` parameter.
 */
export async function scrapeWithBrowser(
    browser: any,
    reqId: number,
    startTime: number,
    targetUrl: string,
    proxyOpts: ProxyOptions,
    cookies: any[] = [],
    loggers: ScrapeLoggers = SILENT,
    warnCleanup: (msg: string) => void = () => {},
): Promise<ScrapeOutput> {
    let context: any;
    let page: any;
    try {
        context = await browser.newContext({
            userAgent: STEALTH_UA,
            viewport: { width: 1280, height: 720 },
        });
        if (cookies.length > 0) await context.addCookies(cookies);

        page = await context.newPage();

        const { jsonResponsePromise, captureHtmlPromise, skipCounts } = attachResponseListeners(
            page, reqId, startTime, targetUrl, proxyOpts, loggers
        );

        // Intercept mode: abort everything except documents before it goes on the wire.
        // No state, no bookkeeping — just kill non-document requests immediately.
        if (!proxyOpts.render) {
            await page.route('**/*', (route: any) => {
                route.request().resourceType() === 'document' ? route.continue() : route.abort('aborted');
            });
        }

        // Close the page as soon as we have the HTML — don't wait for goto/finally.
        if (!proxyOpts.render) {
            captureHtmlPromise.then(() => page.close().catch(() => {}));
        }

        await page.goto(targetUrl, { waitUntil: 'commit', timeout: 30000 });

        // 500ms window to detect a JSON response before committing to the HTML pipeline
        const jsonEarlyExit = await Promise.race([
            jsonResponsePromise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
        ]);
        if (jsonEarlyExit) {
            return { isJson: true, status: jsonEarlyExit.status, body: jsonEarlyExit.body, headers: jsonEarlyExit.headers };
        }

        let screenshotPath: string | undefined;
        let rawHtml: string;

        if (proxyOpts.render) {
            rawHtml = await renderPage(page, reqId, startTime, proxyOpts, loggers);
        } else {
            rawHtml = await interceptPage(page, reqId, startTime, proxyOpts, captureHtmlPromise, loggers);
            if ((loggers.verbosity ?? 0) === 1 && Object.keys(skipCounts).length > 0) {
                const summary = Object.entries(skipCounts).map(([t, n]) => `${t}×${n}`).join(', ');
                loggers.info(`[#${reqId} +${ms(startTime)}ms] ✗ skipped: ${summary}`);
            }
        }

        // Capture screenshot before closing the page (if requested)
        if (proxyOpts.screenshot) {
            screenshotPath = await captureScreenshotAsync(page, targetUrl, reqId, startTime, loggers);
        }

        return { isJson: false, status: 200, body: rawHtml, headers: { 'content-type': 'text/html; charset=utf-8' }, screenshotPath };
    } finally {
        if (page) await page.close().catch(() => logCleanupError(warnCleanup));
        if (context) await context.close().catch(() => logCleanupError(warnCleanup));
    }
}
