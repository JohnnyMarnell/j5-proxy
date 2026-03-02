import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';

const PROXY_PORT = 18787;
const TARGET_PORT = 18788;

let targetServer: ReturnType<typeof Bun.serve>;
let proxyProc: Subprocess;

beforeAll(async () => {
    // --- Mock target server ---
    targetServer = Bun.serve({
        port: TARGET_PORT,
        fetch(req) {
            const url = new URL(req.url);

            if (url.pathname === '/html') {
                return new Response(
                    '<html><head><title>Test</title></head><body><h1>Hello from mock</h1></body></html>',
                    { headers: { 'content-type': 'text/html; charset=utf-8' } }
                );
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

    // --- Start proxy as subprocess ---
    proxyProc = spawn({
        cmd: ['bun', 'index.ts', '-p', String(PROXY_PORT), '--idle', '60000', '--log-file', '/tmp/proxy-test.jsonl'],
        cwd: import.meta.dir + '/..',
        stdout: 'pipe',
        stderr: 'pipe',
    });

    // Wait for proxy to be ready by polling
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        try {
            await fetch(`http://localhost:${PROXY_PORT}/favicon.ico`);
            break;
        } catch {
            await Bun.sleep(200);
        }
    }
});

afterAll(async () => {
    proxyProc?.kill();
    targetServer?.stop(true);
});

function proxyUrl(path: string): string {
    return `http://localhost:${PROXY_PORT}/http://localhost:${TARGET_PORT}${path}`;
}

describe('e2e', () => {
    test('proxies HTML and injects base tag', async () => {
        const res = await fetch(proxyUrl('/html'));
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('<h1>Hello from mock</h1>');
        expect(body).toContain(`<base href="http://localhost:${TARGET_PORT}/">`);
    }, 30000);

    test('proxies JSON and preserves content-type', async () => {
        const res = await fetch(proxyUrl('/json'));
        expect(res.status).toBe(200);
        const ct = res.headers.get('content-type');
        expect(ct).toContain('application/json');
        const data = await res.json();
        expect(data).toEqual({ status: 'ok', items: [1, 2, 3] });
    }, 30000);

    test('returns 404 for empty path', async () => {
        const res = await fetch(`http://localhost:${PROXY_PORT}/`);
        expect(res.status).toBe(404);
    }, 10000);

    test('returns 400 for invalid URL', async () => {
        const res = await fetch(`http://localhost:${PROXY_PORT}/:::bad`);
        expect(res.status).toBe(400);
    }, 10000);

    test('response cache returns same content on second hit', async () => {
        // First request
        const res1 = await fetch(proxyUrl('/html'));
        const body1 = await res1.text();
        expect(res1.status).toBe(200);

        // Second request should hit cache (within 5s default throttle)
        const res2 = await fetch(proxyUrl('/html'));
        const body2 = await res2.text();
        expect(res2.status).toBe(200);
        expect(body2).toBe(body1);
    }, 30000);
});
