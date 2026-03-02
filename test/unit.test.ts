import { test, expect, describe } from 'bun:test';
import { parseProxyOptions, getCacheKey, summarizeBody, stripHopByHop, ResponseCache } from '../lib';

// --- parseProxyOptions ---

describe('parseProxyOptions', () => {
    test('returns defaults when no header', () => {
        const opts = parseProxyOptions(undefined);
        expect(opts).toEqual({
            render: false,
            logHtml: false,
            wait: 20000,
            selector: null,
            settle: 1000,
        });
    });

    test('respects globalLogHtml default', () => {
        const opts = parseProxyOptions(undefined, true);
        expect(opts.logHtml).toBe(true);
    });

    test('parses render flag', () => {
        const opts = parseProxyOptions('render');
        expect(opts.render).toBe(true);
    });

    test('parses log-html flag', () => {
        const opts = parseProxyOptions('log-html');
        expect(opts.logHtml).toBe(true);
    });

    test('parses wait, selector, settle', () => {
        const opts = parseProxyOptions('render, wait=5000, selector=#main, settle=500');
        expect(opts.render).toBe(true);
        expect(opts.wait).toBe(5000);
        expect(opts.selector).toBe('#main');
        expect(opts.settle).toBe(500);
    });

    test('handles selector with = in value', () => {
        const opts = parseProxyOptions('selector=[data-id=foo]');
        expect(opts.selector).toBe('[data-id=foo]');
    });

    test('is case-insensitive for flags', () => {
        const opts = parseProxyOptions('Render, Log-Html');
        expect(opts.render).toBe(true);
        expect(opts.logHtml).toBe(true);
    });

    test('invalid wait falls back to default', () => {
        const opts = parseProxyOptions('wait=abc');
        expect(opts.wait).toBe(20000);
    });
});

// --- getCacheKey ---

describe('getCacheKey', () => {
    test('method + url with no params', () => {
        expect(getCacheKey('GET', 'https://example.com', {})).toBe('GET:https://example.com');
    });

    test('includes sorted query params', () => {
        const key = getCacheKey('GET', 'https://example.com/path', { b: '2', a: '1' });
        expect(key).toBe('GET:https://example.com/path?b=2&a=1');
    });
});

// --- summarizeBody ---

describe('summarizeBody', () => {
    test('empty body', () => {
        expect(summarizeBody('')).toBe('(empty)');
    });

    test('short plain text returned as-is', () => {
        expect(summarizeBody('hello')).toBe('hello');
    });

    test('long plain text is truncated', () => {
        const long = 'x'.repeat(300);
        const result = summarizeBody(long);
        expect(result.length).toBeLessThan(300);
        expect(result).toContain('…(300B)');
    });

    test('short JSON compacted', () => {
        const body = JSON.stringify({ a: 1, b: "hello" }, null, 2);
        expect(summarizeBody(body)).toBe('{"a":1,"b":"hello"}');
    });

    test('large JSON truncated after compaction', () => {
        const obj: Record<string, string> = {};
        for (let i = 0; i < 100; i++) obj[`key${i}`] = 'value'.repeat(10);
        const body = JSON.stringify(obj);
        const result = summarizeBody(body, 50);
        expect(result.length).toBeLessThanOrEqual(70); // 50 + suffix
        expect(result).toContain('…(');
    });

    test('custom maxLen', () => {
        expect(summarizeBody('abcdefgh', 4)).toBe('abcd…(8B)');
    });
});

// --- stripHopByHop ---

describe('stripHopByHop', () => {
    test('removes hop-by-hop headers', () => {
        const headers = stripHopByHop({
            'content-type': 'text/html',
            'transfer-encoding': 'chunked',
            'connection': 'keep-alive',
            'content-encoding': 'gzip',
            'x-custom': 'value',
        });
        expect(headers.get('content-type')).toBe('text/html');
        expect(headers.get('x-custom')).toBe('value');
        expect(headers.get('transfer-encoding')).toBeNull();
        expect(headers.get('connection')).toBeNull();
        expect(headers.get('content-encoding')).toBeNull();
    });

    test('handles empty headers', () => {
        const headers = stripHopByHop({});
        expect([...headers.entries()]).toHaveLength(0);
    });
});

// --- ResponseCache ---

describe('ResponseCache', () => {
    test('set and get', () => {
        const cache = new ResponseCache(5000);
        cache.set('k1', '<html>', 200, { 'content-type': 'text/html' });
        const entry = cache.get('k1');
        expect(entry).not.toBeNull();
        expect(entry!.body).toBe('<html>');
        expect(entry!.status).toBe(200);
        expect(entry!.hits).toBe(1);
    });

    test('increments hits on repeated gets', () => {
        const cache = new ResponseCache(5000);
        cache.set('k1', 'body', 200, {});
        cache.get('k1');
        cache.get('k1');
        const entry = cache.get('k1');
        expect(entry!.hits).toBe(3);
    });

    test('returns null for missing key', () => {
        const cache = new ResponseCache(5000);
        expect(cache.get('nope')).toBeNull();
    });

    test('expires after ttl', async () => {
        const cache = new ResponseCache(50); // 50ms TTL
        cache.set('k1', 'body', 200, {});
        expect(cache.get('k1')).not.toBeNull();
        await Bun.sleep(60);
        expect(cache.get('k1')).toBeNull();
    });

    test('getEntry returns raw entry without incrementing hits', () => {
        const cache = new ResponseCache(5000);
        cache.set('k1', 'body', 200, {});
        const entry = cache.getEntry('k1');
        expect(entry!.hits).toBe(0);
        expect(entry!.body).toBe('body');
    });

    test('clear removes all entries', () => {
        const cache = new ResponseCache(5000);
        cache.set('k1', 'a', 200, {});
        cache.set('k2', 'b', 200, {});
        cache.clear();
        expect(cache.get('k1')).toBeNull();
        expect(cache.get('k2')).toBeNull();
    });
});
