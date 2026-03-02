// --- ZYTE API AUTH VALIDATION ---

/**
 * Validates HTTP Basic auth for Zyte API emulation.
 *
 * curl uses `-u "KEY":` which sends `Authorization: Basic base64(KEY:)`.
 * The username (API key) must be non-empty and look like a valid key
 * (alphanumeric/dash/underscore, at least 4 characters).
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

    if (!key || key.length < 4 || !/^[a-zA-Z0-9_-]+$/.test(key)) return null;

    return key;
}

// --- X-Proxy-Options PARSING ---
export interface ProxyOptions {
    render: boolean;
    logHtml: boolean;
    wait: number;
    selector: string | null;
    settle: number;
}

export function parseProxyOptions(header: string | undefined, globalLogHtml = false): ProxyOptions {
    const opts: ProxyOptions = {
        render: false,
        logHtml: globalLogHtml,
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
        const val = rest.join('=');
        switch (key.trim().toLowerCase()) {
            case 'wait': opts.wait = parseInt(val, 10) || 20000; break;
            case 'selector': opts.selector = val.trim(); break;
            case 'settle': opts.settle = parseInt(val, 10) || 1000; break;
        }
    }
    return opts;
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
