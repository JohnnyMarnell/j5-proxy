import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';

const PROXY_PORT = 18787;
const TARGET_PORT = 18788;
const VERBOSE = process.env.VERBOSE === '1';

function log(msg: string) {
    if (VERBOSE) console.log(`[e2e] ${msg}`);
}

let targetServer: ReturnType<typeof Bun.serve>;
let proxyProc: Subprocess;

beforeAll(async () => {
    log('Starting e2e setup...');
    log(`Target server port: ${TARGET_PORT}, Proxy port: ${PROXY_PORT}`);

    // --- Mock target server ---
    log('Starting mock target server...');
    targetServer = Bun.serve({
        port: TARGET_PORT,
        fetch(req) {
            const url = new URL(req.url);

            if (url.pathname === '/html') {
                // Make response > 1000 bytes so proxy's HTML interception captures it
                const htmlContent = `<!DOCTYPE html>
<html>
<head>
    <title>Test Page</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
    <h1>Hello from mock server</h1>
    <p>This is a test HTML response with enough content to pass the proxy's >1000 byte filter.</p>
    <div class="content">
        <p>Additional paragraph 1: Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>
        <p>Additional paragraph 2: Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>
        <p>Additional paragraph 3: Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.</p>
        <p>Additional paragraph 4: Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
    </div>
    <footer>
        <p>Test content to ensure response size exceeds 1000 bytes for proxy HTML interception.</p>
    </footer>
</body>
</html>`;
                return new Response(htmlContent, { headers: { 'content-type': 'text/html; charset=utf-8' } });
            }

            if (url.pathname === '/json') {
                return Response.json({ status: 'ok', items: [1, 2, 3] });
            }

            if (url.pathname === '/error') {
                return Response.json({ error: 'not found', detail: 'gone' }, { status: 404 });
            }

            if (url.pathname === '/server-error') {
                return new Response('Internal Server Error', { status: 500 });
            }

            if (url.pathname === '/slow') {
                return new Promise(resolve =>
                    setTimeout(() => resolve(new Response(
                        '<html><head></head><body>slow</body></html>',
                        { headers: { 'content-type': 'text/html' } }
                    )), 2000)
                );
            }

            return new Response('Not Found', { status: 404 });
        },
    });
    log('✓ Target server ready');

    // --- Start proxy as subprocess ---
    log('Starting proxy subprocess...');
    const projectRoot = import.meta.dir + '/..';
    proxyProc = spawn({
        cmd: ['bun', 'index.ts', '-p', String(PROXY_PORT), '--idle', '60000', '--log-file', '/tmp/proxy-test.jsonl'],
        cwd: projectRoot,
        stdout: VERBOSE ? 'inherit' : 'pipe',
        stderr: VERBOSE ? 'inherit' : 'pipe',
    });

    // Wait for proxy to be ready by polling
    log('Waiting for proxy to be ready...');
    const deadline = Date.now() + 15000;
    let attempts = 0;
    while (Date.now() < deadline) {
        attempts++;
        try {
            const res = await fetch(`http://localhost:${PROXY_PORT}/favicon.ico`);
            log(`✓ Proxy ready after ${attempts} attempts`);
            break;
        } catch (e) {
            if (Date.now() - 2000 > deadline) {
                throw new Error(`Proxy failed to start after ${attempts} attempts: ${e}`);
            }
            await Bun.sleep(200);
        }
    }
    log('Setup complete\n');
});

afterAll(async () => {
    log('\nCleaning up...');
    proxyProc?.kill();
    targetServer?.stop(true);
    log('✓ Cleanup complete');
});

function proxyUrl(path: string): string {
    return `http://localhost:${PROXY_PORT}/http://localhost:${TARGET_PORT}${path}`;
}

// --- Zyte helpers ---

const ZYTE_VALID_KEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'; // exactly 32 lowercase hex chars

function zyteExtractUrl(version = 'v1'): string {
    // Route is /:version{v\d+}/extract — e.g. /v1/extract
    return `http://localhost:${PROXY_PORT}/${version}/extract`;
}

function zyteBasicAuth(key: string): string {
    return 'Basic ' + Buffer.from(`${key}:`).toString('base64');
}

async function zytePost(
    body: Record<string, any>,
    key: string | null = ZYTE_VALID_KEY,
    version = 'v1',
): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key !== null) headers['Authorization'] = zyteBasicAuth(key);
    return fetch(zyteExtractUrl(version), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}

describe('e2e', () => {
    test('proxies HTML and injects base tag', async () => {
        log('TEST: proxies HTML and injects base tag');
        const start = Date.now();
        
        // Heartbeat logger while waiting for response
        const heartbeat = setInterval(() => {
            const elapsed = Date.now() - start;
            log(`  ... still waiting (${elapsed}ms)`);
        }, 5000);
        
        const res = await fetch(proxyUrl('/html'));
        clearInterval(heartbeat);
        
        const elapsed = Date.now() - start;
        log(`  → GET /html returned ${res.status} in ${elapsed}ms`);
        expect(res.status).toBe(200);
        const body = await res.text();
        log(`  → Response body: ${body.length} bytes`);
        expect(body).toContain('<h1>Hello from mock server</h1>');
        expect(body).toContain(`<base href="http://localhost:${TARGET_PORT}/">`);
        log('  ✓ PASS\n');
    }, 30000);

    test('proxies JSON and preserves content-type', async () => {
        log('TEST: proxies JSON and preserves content-type');
        const start = Date.now();
        const res = await fetch(proxyUrl('/json'));
        const elapsed = Date.now() - start;
        const ct = res.headers.get('content-type');
        log(`  → GET /json returned ${res.status} (content-type: ${ct}) in ${elapsed}ms`);
        expect(res.status).toBe(200);
        expect(ct).toContain('application/json');
        const data = await res.json();
        log(`  → JSON body: ${JSON.stringify(data)}`);
        expect(data).toEqual({ status: 'ok', items: [1, 2, 3] });
        log('  ✓ PASS\n');
    }, 30000);

    test('returns 404 for empty path', async () => {
        log('TEST: returns 404 for empty path');
        const start = Date.now();
        const res = await fetch(`http://localhost:${PROXY_PORT}/`);
        const elapsed = Date.now() - start;
        log(`  → GET / returned ${res.status} in ${elapsed}ms`);
        expect(res.status).toBe(404);
        log('  ✓ PASS\n');
    }, 10000);

    test('returns 400 for invalid URL', async () => {
        log('TEST: returns 400 for invalid URL');
        const start = Date.now();
        const res = await fetch(`http://localhost:${PROXY_PORT}/:::bad`);
        const elapsed = Date.now() - start;
        log(`  → GET /:::bad returned ${res.status} in ${elapsed}ms`);
        expect(res.status).toBe(400);
        log('  ✓ PASS\n');
    }, 10000);

    test('response cache returns same content on second hit', async () => {

        log('TEST: response cache returns same content on second hit');
        
        log('  First request...');
        const start1 = Date.now();
        const res1 = await fetch(proxyUrl('/html'));
        const elapsed1 = Date.now() - start1;
        const body1 = await res1.text();
        log(`  → First GET /html returned ${res1.status} in ${elapsed1}ms (${body1.length} bytes)`);
        expect(res1.status).toBe(200);

        log('  Second request (should hit cache)...');
        const start2 = Date.now();
        const res2 = await fetch(proxyUrl('/html'));
        const elapsed2 = Date.now() - start2;
        const body2 = await res2.text();
        log(`  → Second GET /html returned ${res2.status} in ${elapsed2}ms (${body2.length} bytes)`);
        expect(res2.status).toBe(200);
        expect(body2).toBe(body1);
        log(`  → Cache speedup: ${elapsed1}ms → ${elapsed2}ms\n`);
        log('  ✓ PASS\n');
    }, 30000);
});

describe('e2e Zyte /v1/extract', () => {
    test('returns 401 with Zyte error body when Authorization header is absent', async () => {
        log('TEST: Zyte 401 — no auth header');
        const res = await zytePost({ url: `http://localhost:${TARGET_PORT}/html`, httpResponseBody: true }, null);
        log(`  → status ${res.status}`);
        expect(res.status).toBe(401);
        const data = await res.json();
        log(`  → body: ${JSON.stringify(data)}`);
        expect(data.type).toBe('/auth/key-not-found');
        expect(data.status).toBe(401);
        log('  ✓ PASS\n');
    }, 10000);

    test('returns 401 with Zyte error body when API key is empty (curl -u "":)', async () => {
        log('TEST: Zyte 401 — empty key');
        const res = await zytePost({ url: `http://localhost:${TARGET_PORT}/html`, httpResponseBody: true }, '');
        log(`  → status ${res.status}`);
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.type).toBe('/auth/key-not-found');
        log('  ✓ PASS\n');
    }, 10000);

    test('returns 400 when url field is missing', async () => {
        log('TEST: Zyte 400 — missing url');
        const res = await zytePost({});
        log(`  → status ${res.status}`);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.status).toBe(400);
        log('  ✓ PASS\n');
    }, 10000);

    test('returns 400 for invalid JSON body', async () => {
        log('TEST: Zyte 400 — invalid JSON');
        const res = await fetch(zyteExtractUrl(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': zyteBasicAuth(ZYTE_VALID_KEY),
            },
            body: 'not-json',
        });
        log(`  → status ${res.status}`);
        expect(res.status).toBe(400);
        log('  ✓ PASS\n');
    }, 10000);

    test('fetches page and returns base64-encoded httpResponseBody', async () => {
        log('TEST: Zyte extract — valid request with httpResponseBody');
        const start = Date.now();

        const heartbeat = setInterval(() => log(`  ... still waiting (${Date.now() - start}ms)`), 5000);
        const res = await zytePost({
            url: `http://localhost:${TARGET_PORT}/html`,
            httpResponseBody: true,
        });
        clearInterval(heartbeat);

        const elapsed = Date.now() - start;
        log(`  → status ${res.status} in ${elapsed}ms`);
        expect(res.status).toBe(200);

        const data = await res.json();
        log(`  → url=${data.url} statusCode=${data.statusCode} httpResponseBody length=${data.httpResponseBody?.length}`);

        expect(data.url).toBe(`http://localhost:${TARGET_PORT}/html`);
        expect(data.statusCode).toBe(200);
        expect(typeof data.httpResponseBody).toBe('string');

        const decoded = Buffer.from(data.httpResponseBody, 'base64').toString('utf-8');
        log(`  → decoded body: ${decoded.length} bytes`);
        expect(decoded).toContain('<h1>Hello from mock server</h1>');
        log('  ✓ PASS\n');
    }, 30000);

    test('omits httpResponseBody field when not requested', async () => {
        log('TEST: Zyte extract — httpResponseBody not requested');
        const start = Date.now();

        const heartbeat = setInterval(() => log(`  ... still waiting (${Date.now() - start}ms)`), 5000);
        const res = await zytePost({
            url: `http://localhost:${TARGET_PORT}/html`,
            httpResponseBody: false,
        });
        clearInterval(heartbeat);

        const elapsed = Date.now() - start;
        log(`  → status ${res.status} in ${elapsed}ms`);
        expect(res.status).toBe(200);

        const data = await res.json();
        log(`  → keys: ${Object.keys(data).join(', ')}`);
        expect(data.url).toBe(`http://localhost:${TARGET_PORT}/html`);
        expect(data.statusCode).toBe(200);
        expect(data.httpResponseBody).toBeUndefined();
        log('  ✓ PASS\n');
    }, 30000);

    test('normalizes bare hostname url (no scheme)', async () => {
        log('TEST: Zyte extract — bare hostname normalized to https://');
        // We can't actually fetch localhost without scheme usefully, so just check
        // the returned `url` field reflects the normalization (it will 500 on
        // connect but the URL normalisation happens before Playwright).
        const res = await zytePost({ url: 'example.invalid', httpResponseBody: false });
        log(`  → status ${res.status}`);
        // Will be 500 (unreachable host) but NOT 400 — the URL was valid after normalisation
        expect(res.status).not.toBe(400);
        if (res.status === 200) {
            const data = await res.json();
            expect(data.url).toBe('https://example.invalid');
        }
        log('  ✓ PASS\n');
    }, 30000);

    test('works with /v2/extract path (version-agnostic routing)', async () => {
        log('TEST: Zyte extract — /v2/extract');
        const start = Date.now();

        const heartbeat = setInterval(() => log(`  ... still waiting (${Date.now() - start}ms)`), 5000);
        const res = await zytePost(
            { url: `http://localhost:${TARGET_PORT}/html`, httpResponseBody: true },
            ZYTE_VALID_KEY,
            'v2',
        );
        clearInterval(heartbeat);

        const elapsed = Date.now() - start;
        log(`  → status ${res.status} in ${elapsed}ms`);
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.statusCode).toBe(200);
        expect(typeof data.httpResponseBody).toBe('string');

        const decoded = Buffer.from(data.httpResponseBody, 'base64').toString('utf-8');
        expect(decoded).toContain('<h1>Hello from mock server</h1>');
        log('  ✓ PASS\n');
    }, 30000);
});
