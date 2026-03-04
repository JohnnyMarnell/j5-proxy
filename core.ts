/// <reference lib="dom" />
import { chromium } from 'patchright';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import consola from 'consola';
import type { ProxyOptions } from './lib';


// --- BROWSER ---

export type BrowserHandle =
    | { kind: 'chromium'; browser: any }
    | { kind: 'chrome'; context: any };

// Persistent Chrome profile dir — reused across restarts so the profile
// builds up naturally (history, storage, etc.) which helps with fingerprinting.
const CHROME_PROFILE_DIR = join(tmpdir(), 'j5-proxy-chrome-profile');

export async function closeBrowser(handle: BrowserHandle): Promise<void> {
    if (handle.kind === 'chrome') await handle.context.close().catch(() => {});
    else await handle.browser.close().catch(() => {});
}

export async function launchBrowser(useChrome = false, initialCookies: any[] = []): Promise<BrowserHandle> {
    if (useChrome) {
        const context = await chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
            channel: 'chrome',
            headless: true,
            viewport: null,
            // No custom userAgent or headers — let Chrome identify itself naturally
        });
        if (initialCookies.length > 0) await context.addCookies(initialCookies);
        return { kind: 'chrome', context };
    }

    const browser = await chromium.launch({ headless: true });
    return { kind: 'chromium', browser };
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
        const ageS = Math.round((now - _lastCookieFetch) / 1000);
        consola.info(`🍪 Using cached cookies (${_cachedCookies.length} cookies, age ${ageS}s)`);
        return _cachedCookies;
    }

    try {
        const out = execSync(`${_pythonCmd!} ${_cookieScriptPath!}`).toString();
        const parsed = JSON.parse(out);
        if (parsed.error) throw new Error(parsed.error);
        _cachedCookies = parsed;
        _lastCookieFetch = now;
        consola.info(`🍪 Fetched fresh cookies (${_cachedCookies.length} cookies)`);
        return _cachedCookies;
    } catch (err: any) {
        if (forceRefresh) throw err;
        consola.warn(`🍪 Cookie fetch failed, using stale cache (${_cachedCookies.length} cookies): ${(err as any).message}`);
        return _cachedCookies; // return stale on silent failure
    }
}

// --- COOKIE FILTERING ---

/**
 * Filters a cookie jar down to cookies whose domain matches the target URL.
 * Handles the leading-dot convention (.example.com matches sub.example.com).
 */
export function filterCookiesForUrl(cookies: any[], targetUrl: string): any[] {
    if (cookies.length === 0) return cookies;
    try {
        const hostname = new URL(targetUrl).hostname;
        return cookies.filter(c => {
            const domain = c.domain?.startsWith('.') ? c.domain.slice(1) : c.domain;
            return domain && (hostname === domain || hostname.endsWith('.' + domain));
        });
    } catch {
        return cookies;
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
    cookiesApplied?: number;
}


// Cloudflare blocking challenge — page is gating real content behind a JS challenge.
// Only reliable indicators; CF JSD (invisible background verification) is NOT this.
function isCloudflareChallenge(html: string): boolean {
    return html.includes('challenge-error-text') || html.includes('Just a moment');
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
        const filename = join(tmpdir(), `${sanitized}_${timestamp}.png`);
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
): { jsonResponsePromise: Promise<{ body: string; headers: Record<string, string>; status: number }>; captureHtmlPromise: Promise<string>; jsdVerifiedPromise: Promise<void>; cfChallengeDetected: Promise<void>; skipCounts: Record<string, number>; completedCounts: Record<string, number> } {
    let firstResponseLogged = false;
    let resolveJson!: (r: { body: string; headers: Record<string, string>; status: number }) => void;
    const jsonResponsePromise = new Promise<{ body: string; headers: Record<string, string>; status: number }>((r) => { resolveJson = r; });
    let resolveCapture!: (html: string) => void;
    let rejectCapture!: (err: Error) => void;
    const captureHtmlPromise = new Promise<string>((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject; });
    let resolveCfChallenge!: () => void;
    const cfChallengeDetected = new Promise<void>((r) => { resolveCfChallenge = r; });
    const skipCounts: Record<string, number> = {};
    const completedCounts: Record<string, number> = {};
    const verbosity = loggers.verbosity ?? 0;
    let cfChallengeSeen = false;

    page.on('requestfinished', (req: any) => {
        const type = req.resourceType();
        completedCounts[type] = (completedCounts[type] ?? 0) + 1;
    });

    // Always: detect CF JSD background verification (one-shot request) — fires on real pages after real content is served.
    // Not a blocking challenge — CF is satisfied with the browser fingerprint and doing invisible background verification.
    let cfJsdLogged = false;
    page.on('request', (req: any) => {
        if (!cfJsdLogged && req.url().includes('challenge-platform')) {
            cfJsdLogged = true;
            loggers.info(`[#${reqId} +${ms(startTime)}ms] ✓ CF JSD background verification request detected`);
        }
    });

    // Always: watch for the JSD oneshot response — this is CF confirming the background verification passed.
    let resolveJsd!: () => void;
    const jsdVerifiedPromise = new Promise<void>((r) => { resolveJsd = r; });
    page.on('response', (res: any) => {
        if (res.url().includes('/jsd/oneshot')) {
            loggers.info(`[#${reqId} +${ms(startTime)}ms] ✓ CF JSD verification confirmed (${res.status()})`);
            resolveJsd();
        }
    });

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
                if (isCloudflareChallenge(text)) {
                    cfChallengeSeen = true;
                    resolveCfChallenge();
                    loggers.info(`[#${reqId} +${ms(startTime)}ms] ✓ CF challenge page detected — waiting for bypass`);
                }
            }

            if (isDocument && !proxyOpts.render) {
                if (isCloudflareChallenge(text)) {
                    // Always hold — real content arrives after CF bypass completes
                } else {
                    if (cfChallengeSeen) {
                        loggers.info(`[#${reqId} +${ms(startTime)}ms] ✓ CF bypass complete — real content received`);
                    } else if (proxyOpts.verify) {
                        loggers.info(`[#${reqId} +${ms(startTime)}ms] ✓ verify: no CF challenge, real content received`);
                    }
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

    return { jsonResponsePromise, captureHtmlPromise, jsdVerifiedPromise, cfChallengeDetected, skipCounts, completedCounts };
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

    await page.waitForLoadState(proxyOpts.loadState, { timeout: proxyOpts.wait }).catch(() => {
        loggers.warn(`[#${reqId} +${ms(startTime)}ms] ${proxyOpts.loadState} timed out, continuing with current DOM`);
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

type JsonResult = { body: string; headers: Record<string, string>; status: number };
type InterceptResult = { isJson: false; html: string } | { isJson: true; json: JsonResult };

export async function interceptPage(
    page: any,
    reqId: number,
    startTime: number,
    proxyOpts: ProxyOptions,
    captureHtmlPromise: Promise<string>,
    jsonResponsePromise: Promise<JsonResult>,
    loggers: ScrapeLoggers = SILENT,
): Promise<InterceptResult> {
    try {
        return await Promise.race([
            captureHtmlPromise.then(html => ({ isJson: false as const, html })),
            jsonResponsePromise.then(json => ({ isJson: true as const, json })),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Timeout waiting for real content (Cloudflare might be stuck)')), 25000)
            ),
        ]);
    } catch {
        loggers.warn(`[#${reqId} +${ms(startTime)}ms] Intercept timed out, falling back to live DOM.`);
        const html = await page.content();
        if (proxyOpts.logHtml) {
            loggers.onHtmlStep?.('fallback-dom', html, ms(startTime));
        }
        return { isJson: false, html };
    }
}

function logCompletedCounts(counts: Record<string, number>, reqId: number, startTime: number, loggers: ScrapeLoggers) {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return;
    const summary = entries.map(([t, n]) => `${t}:${n}`).join(', ');
    loggers.info(`[#${reqId} +${ms(startTime)}ms] requests completed: ${summary}`);
}

/**
 * Core scraping function. Opens a browser context, navigates to the URL,
 * and returns the final HTML or JSON body.
 *
 * Handles JSON early-exit, Cloudflare detection, render mode, and selector waiting.
 * Logging is fully optional via the `loggers` parameter.
 */
export async function scrapeWithBrowser(
    handle: BrowserHandle,
    reqId: number,
    startTime: number,
    targetUrl: string,
    proxyOpts: ProxyOptions,
    cookies: any[] = [],
    loggers: ScrapeLoggers = SILENT,
    warnCleanup: (msg: string) => void = () => {},
    userAgent?: string,
): Promise<ScrapeOutput> {
    let context: any;
    let ownContext = false; // whether we created the context and should close it
    let page: any;
    let cookiesApplied: number | undefined;
    try {
        if (handle.kind === 'chrome') {
            context = handle.context;
            // Refresh cookies into the persistent context if explicitly requested
            if (proxyOpts.refreshCookies && cookies.length > 0) {
                const filtered = filterCookiesForUrl(cookies, targetUrl);
                await context.clearCookies();
                await context.addCookies(filtered);
                cookiesApplied = filtered.length;
                loggers.info?.(`[#${reqId}] 🍪 Refreshed ${filtered.length}/${cookies.length} cookies into persistent Chrome context`);
            }
        } else {
            context = await handle.browser.newContext({
                ...(userAgent ? { userAgent } : {}),
                viewport: { width: 1280, height: 720 },
            });
            if (cookies.length > 0) {
                const filtered = filterCookiesForUrl(cookies, targetUrl);
                if (filtered.length > 0) {
                    await context.addCookies(filtered);
                    cookiesApplied = filtered.length;
                    loggers.info?.(`[#${reqId}] 🍪 Injected ${filtered.length}/${cookies.length} cookies into Chromium context`);
                }
            }
            ownContext = true;
        }

        page = await context.newPage();

        const { jsonResponsePromise, captureHtmlPromise, jsdVerifiedPromise, cfChallengeDetected, skipCounts, completedCounts } = attachResponseListeners(
            page, reqId, startTime, targetUrl, proxyOpts, loggers
        );
        // Suppress unhandled rejections on promises that may never be awaited
        captureHtmlPromise.catch(() => {});
        jsonResponsePromise.catch(() => {});
        cfChallengeDetected.catch(() => {});

        // Intercept mode: abort all non-document requests before they hit the wire.
        // verify skips this — CF's challenge/JSD scripts need to run and make network requests.
        // Close the page as soon as we have the HTML or JSON — don't wait for goto/finally.
        // verify mode skips this: we keep the page alive to let JSD complete after HTML capture.
        // .catch() on the chain is essential: if captureHtmlPromise rejects (e.g. document
        // fetch fails) and we never reach interceptPage, the rejection must be handled here
        // or Bun/Node will treat it as an unhandled rejection and crash the process.
        if (!proxyOpts.render && !proxyOpts.verify) {
            captureHtmlPromise.then(() => page.close().catch(() => {})).catch(() => {});
            jsonResponsePromise.then(() => page.close().catch(() => {})).catch(() => {});
        }

        await page.goto(targetUrl, { waitUntil: 'commit', timeout: 30000 });

        // 500ms window to detect a JSON response before committing to the HTML pipeline.
        // Fast JSON APIs (no CF challenge) resolve here. Slower ones (post-CF-bypass) are
        // caught inside interceptPage which also races jsonResponsePromise.
        const jsonEarlyExit = await Promise.race([
            jsonResponsePromise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
        ]);
        if (jsonEarlyExit) {
            return { isJson: true, status: jsonEarlyExit.status, body: jsonEarlyExit.body, headers: jsonEarlyExit.headers, cookiesApplied };
        }

        let screenshotPath: string | undefined;
        let rawHtml: string;

        if (proxyOpts.render) {
            rawHtml = await renderPage(page, reqId, startTime, proxyOpts, loggers);
            logCompletedCounts(completedCounts, reqId, startTime, loggers);
        } else {
            const interceptResult = await interceptPage(page, reqId, startTime, proxyOpts, captureHtmlPromise, jsonResponsePromise, loggers);
            if (interceptResult.isJson) {
                return { isJson: true, status: interceptResult.json.status, body: interceptResult.json.body, headers: interceptResult.json.headers, cookiesApplied };
            }
            rawHtml = interceptResult.html;
            if (Object.keys(skipCounts).length > 0) {
                const summary = Object.entries(skipCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}:${n}`).join(', ');
                loggers.info(`[#${reqId} +${ms(startTime)}ms] ✗ skipped: ${summary}`);
            }
            if (proxyOpts.verify) {
                const JSD_TIMEOUT = 5000;
                const timedOut = await Promise.race([
                    jsdVerifiedPromise.then(() => false),
                    new Promise<boolean>((r) => setTimeout(() => r(true), JSD_TIMEOUT)),
                ]);
                if (timedOut) {
                    loggers.warn(`[#${reqId} +${ms(startTime)}ms] ⚠ verify: JSD oneshot not seen within ${JSD_TIMEOUT}ms — CF may not have verified`);
                }
                logCompletedCounts(completedCounts, reqId, startTime, loggers);
            }
        }

        // Capture screenshot before closing the page (if requested)
        if (proxyOpts.screenshot) {
            screenshotPath = await captureScreenshotAsync(page, targetUrl, reqId, startTime, loggers);
        }

        return { isJson: false, status: 200, body: rawHtml, headers: { 'content-type': 'text/html; charset=utf-8' }, screenshotPath, cookiesApplied };
    } finally {
        if (page) await page.close().catch(() => logCleanupError(warnCleanup));
        if (ownContext && context) await context.close().catch(() => logCleanupError(warnCleanup));
    }
}
