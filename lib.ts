// --- ZYTE API AUTH VALIDATION ---

/**
 * Validates HTTP Basic auth for Zyte API emulation.
 *
 * curl uses `-u "KEY":` which sends `Authorization: Basic base64(KEY:)`.
 * The username (API key) must be exactly 32 lowercase hex characters,
 * matching the format Zyte uses for real API keys.
 *
 * Returns the key string if valid, or null if missing/invalid.
 */
export function validateZyteAuth(authHeader: string | undefined): string | null {
    if (!authHeader || !authHeader.startsWith('Basic ')) return null;

    const encoded = authHeader.slice('Basic '.length);
    let decoded: string;
    try {
        decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    } catch {
        return null;
    }

    // Format is "key:" (password is always empty for Zyte)
    const colonIdx = decoded.indexOf(':');
    const key = colonIdx >= 0 ? decoded.slice(0, colonIdx) : decoded;

    // Zyte API keys are exactly 32 lowercase hex characters
    if (!/^[0-9a-f]{32}$/.test(key)) return null;

    return key;
}

// --- X-Proxy-Options PARSING ---
export interface ProxyOptions {
    render: boolean;
    /** Let sub-requests run, wait for CF JSD oneshot verification and/or challenge bypass before returning. */
    verify: boolean;
    logHtml: boolean;
    wait: number;
    /** Render mode completion signal: 'domcontentloaded' | 'load' | 'networkidle'. Default: 'load'. */
    loadState: 'domcontentloaded' | 'load' | 'networkidle';
    selector: string | null;
    settle: number;
    /** Force a fresh cookie extraction for this request. Errors loudly if cookies are unavailable. */
    refreshCookies: boolean;
    /** Take a headless browser screenshot and save to /tmp. Async (doesn't block response). */
    screenshot: boolean;
}

const VALID_BOOL_OPTIONS = new Set(['render', 'verify', 'log-html', 'refresh-cookies', 'screenshot']);
const VALID_KV_OPTIONS = new Set(['wait', 'selector', 'settle', 'load-state']);
const VALID_LOAD_STATES = new Set(['domcontentloaded', 'load', 'networkidle']);

export function parseProxyOptions(header: string | undefined, globalLogHtml = false): { opts: ProxyOptions; errors: string[] } {
    const opts: ProxyOptions = {
        render: false,
        verify: false,
        logHtml: globalLogHtml,
        wait: 20000,
        loadState: 'load',
        selector: null,
        settle: 1000,
        refreshCookies: false,
        screenshot: false,
    };
    const errors: string[] = [];
    if (!header) return { opts, errors };

    const parts = header.split(',').map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower === 'render')           { opts.render = true; continue; }
        if (lower === 'verify')           { opts.verify = true; continue; }
        if (lower === 'log-html')         { opts.logHtml = true; continue; }
        if (lower === 'refresh-cookies')  { opts.refreshCookies = true; continue; }
        if (lower === 'screenshot')       { opts.screenshot = true; continue; }

        const eqIdx = part.indexOf('=');
        if (eqIdx === -1) {
            // No '=' — must be a boolean flag, but didn't match any known one
            errors.push(`unknown option: "${part}" (valid: ${[...VALID_BOOL_OPTIONS].join(', ')})`);
            continue;
        }

        const key = part.slice(0, eqIdx).trim().toLowerCase();
        const val = part.slice(eqIdx + 1).trim();

        if (!VALID_KV_OPTIONS.has(key)) {
            errors.push(`unknown option: "${key}" (valid: ${[...VALID_KV_OPTIONS].join(', ')})`);
            continue;
        }

        switch (key) {
            case 'wait': {
                const n = parseInt(val, 10);
                if (isNaN(n) || n <= 0) errors.push(`invalid value for wait: "${val}" (expected positive integer ms)`);
                else opts.wait = n;
                break;
            }
            case 'settle': {
                const n = parseInt(val, 10);
                if (isNaN(n) || n < 0) errors.push(`invalid value for settle: "${val}" (expected non-negative integer ms)`);
                else opts.settle = n;
                break;
            }
            case 'selector':
                opts.selector = val;
                break;
            case 'load-state': {
                const ls = val.toLowerCase();
                if (!VALID_LOAD_STATES.has(ls)) errors.push(`invalid load-state: "${val}" (valid: ${[...VALID_LOAD_STATES].join(', ')})`);
                else opts.loadState = ls as ProxyOptions['loadState'];
                break;
            }
        }
    }
    return { opts, errors };
}

// --- CACHE KEY ---
export function getCacheKey(method: string, url: string, queryParams: Record<string, any>): string {
    const paramsStr = Object.keys(queryParams).length > 0
        ? '?' + new URLSearchParams(queryParams as Record<string, string>).toString()
        : '';
    return `${method}:${url}${paramsStr}`;
}

// --- RESPONSE BODY SUMMARY ---
export function summarizeBody(body: string, maxLen = 200): string {
    if (!body || body.length === 0) return '(empty)';
    try {
        const parsed = JSON.parse(body);
        const compact = JSON.stringify(parsed);
        if (compact.length <= maxLen) return compact;
        return compact.substring(0, maxLen) + `…(${compact.length}B)`;
    } catch {
        if (body.length <= maxLen) return body;
        return body.substring(0, maxLen) + `…(${body.length}B)`;
    }
}

// --- HOP-BY-HOP HEADERS ---
const HOP_BY_HOP = new Set(['transfer-encoding', 'connection', 'keep-alive', 'content-encoding']);

export function stripHopByHop(headers: Record<string, string>): Headers {
    const out = new Headers();
    for (const [k, v] of Object.entries(headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v);
    }
    return out;
}

// --- RESPONSE THROTTLE CACHE ---
export interface CachedResponse {
    body: string;
    status: number;
    headers: Record<string, string>;
    timestamp: number;
    hits: number;
}

export class ResponseCache {
    private cache = new Map<string, CachedResponse>();

    constructor(private ttl: number) {}

    get(cacheKey: string): CachedResponse | null {
        const cached = this.cache.get(cacheKey);
        if (!cached) return null;

        if (Date.now() - cached.timestamp >= this.ttl) {
            this.cache.delete(cacheKey);
            return null;
        }

        cached.hits++;
        return cached;
    }

    set(cacheKey: string, body: string, status: number, headers: Record<string, string>) {
        this.cache.set(cacheKey, {
            body,
            status,
            headers,
            timestamp: Date.now(),
            hits: 0,
        });
    }

    getEntry(cacheKey: string): CachedResponse | undefined {
        return this.cache.get(cacheKey);
    }

    clear() {
        this.cache.clear();
    }
}
