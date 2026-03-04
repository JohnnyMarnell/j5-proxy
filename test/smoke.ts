#!/usr/bin/env bun
/**
 * Manual smoke-test harness.
 *
 * Usage:
 *   bun test/smoke.ts <config.json>
 *   bun test/smoke.ts '{"tests":[...]}'       # inline JSON
 *   bun test/smoke.ts <config> --port 8787    # use already-running proxy
 *
 * Config schema:
 *   {
 *     "timeout": 60000,          // optional, ms per request (default 60000)
 *     "tests": [
 *       {
 *         "name": "usage API",   // optional display label
 *         "url": "https://...",  // required, the target URL (not the proxy URL)
 *         "proxyOptions": "render,verify",  // optional X-Proxy-Options header
 *         "responseType": "json",           // "html" | "json" (default "html")
 *         "expect": "some text",            // required, must appear in response body
 *         "timeout": 90000                  // optional per-test override (ms)
 *       }
 *     ]
 *   }
 */

import { spawn } from 'bun';
import { existsSync, readFileSync } from 'fs';
import { createServer } from 'net';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestCase {
    name?: string;
    url: string;
    proxyOptions?: string;
    responseType: 'html' | 'json';
    expect: string;
    timeout?: number;
}

interface Config {
    timeout: number;
    tests: TestCase[];
}

interface TestResult {
    label: string;
    pass: boolean;
    status?: number;
    bytes?: number;
    reason?: string;
    ms?: number;
}

// ---------------------------------------------------------------------------
// Config loading + validation
// ---------------------------------------------------------------------------

function die(msg: string): never {
    console.error(`\n❌  ${msg}\n`);
    process.exit(1);
}

function validateConfig(raw: unknown, source: string): Config {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        die(`Config must be a JSON object (source: ${source})`);

    const obj = raw as Record<string, unknown>;

    if (!Array.isArray(obj.tests) || obj.tests.length === 0)
        die('"tests" must be a non-empty array');

    const globalTimeout = typeof obj.timeout === 'number' ? obj.timeout : 60_000;

    const tests: TestCase[] = obj.tests.map((t: unknown, i: number) => {
        if (!t || typeof t !== 'object' || Array.isArray(t))
            die(`tests[${i}] must be an object`);

        const tc = t as Record<string, unknown>;

        if (typeof tc.url !== 'string' || !tc.url)
            die(`tests[${i}].url is required (non-empty string)`);

        if (typeof tc.expect !== 'string' || !tc.expect)
            die(`tests[${i}].expect is required (non-empty string)`);

        if (tc.responseType !== undefined && tc.responseType !== 'html' && tc.responseType !== 'json')
            die(`tests[${i}].responseType must be "html" or "json", got: ${JSON.stringify(tc.responseType)}`);

        if (tc.proxyOptions !== undefined && typeof tc.proxyOptions !== 'string')
            die(`tests[${i}].proxyOptions must be a string`);

        if (tc.timeout !== undefined && typeof tc.timeout !== 'number')
            die(`tests[${i}].timeout must be a number`);

        return {
            name:          typeof tc.name === 'string' ? tc.name : undefined,
            url:           tc.url as string,
            proxyOptions:  tc.proxyOptions as string | undefined,
            responseType:  (tc.responseType as 'html' | 'json') ?? 'html',
            expect:        tc.expect as string,
            timeout:       typeof tc.timeout === 'number' ? tc.timeout : undefined,
        };
    });

    return { timeout: globalTimeout, tests };
}

function loadConfig(arg: string): Config {
    // Try as file path first, then inline JSON
    if (existsSync(arg)) {
        let text: string;
        try { text = readFileSync(arg, 'utf-8'); }
        catch (e: any) { die(`Cannot read file "${arg}": ${e.message}`); }
        let raw: unknown;
        try { raw = JSON.parse(text!); }
        catch (e: any) { die(`Invalid JSON in "${arg}": ${e.message}`); }
        return validateConfig(raw, arg);
    }

    // Try inline JSON
    let raw: unknown;
    try { raw = JSON.parse(arg); }
    catch { die(`Argument is neither an existing file path nor valid JSON:\n  ${arg}`); }
    return validateConfig(raw, '<inline>');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, () => {
            const addr = srv.address();
            const port = addr && typeof addr === 'object' ? addr.port : null;
            srv.close(() => port ? resolve(port) : reject(new Error('Could not get free port')));
        });
    });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`Timed out after ${ms}ms (${label})`)), ms)
        ),
    ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length === 0 || args[0]!.startsWith('-')) {
    console.error('Usage: bun test/smoke.ts <config.json | inline-json> [--port <n>]');
    process.exit(1);
}

// Parse --port flag (points at an already-running proxy; skip launch)
const portFlagIdx = args.indexOf('--port');
const portFlagVal = portFlagIdx !== -1 ? (args[portFlagIdx + 1] ?? '') : '';
const externalPort = portFlagVal ? parseInt(portFlagVal, 10) : null;
if (portFlagIdx !== -1 && (externalPort === null || isNaN(externalPort) || externalPort < 1 || externalPort > 65535))
    die(`Invalid --port value: ${portFlagVal}`);

const config = loadConfig(args[0]!);
const projectRoot = import.meta.dir + '/..';
const divider = '─'.repeat(64);

let port: number;
let proxyProc: ReturnType<typeof spawn> | null = null;

if (externalPort) {
    port = externalPort;
    console.log(`\n${divider}`);
    console.log(`🔌  Using existing proxy at port ${port}  (${config.tests.length} test(s) queued)`);
    console.log(`${divider}\n`);

    // Verify it's actually reachable
    try {
        await withTimeout(fetch(`http://localhost:${port}/favicon.ico`), 3000, 'proxy reachability check');
    } catch {
        die(`No proxy responding at http://localhost:${port} — is it running?`);
    }
} else {
    port = await getFreePort();

    console.log(`\n${divider}`);
    console.log(`🔧  Starting proxy on port ${port}  (${config.tests.length} test(s) queued)`);
    console.log(`${divider}\n`);

    proxyProc = spawn({
        cmd: ['bun', 'index.ts', '-p', String(port), '--idle', '0', '--no-startup-notify', '--no-notify', '-v'],
        cwd: projectRoot,
        stdout: 'inherit',
        stderr: 'inherit',
    });

    const startWait = Date.now();
    let ready = false;
    while (Date.now() - startWait < 20_000) {
        try {
            await fetch(`http://localhost:${port}/favicon.ico`);
            ready = true;
            break;
        } catch { await Bun.sleep(200); }
    }

    if (!ready) {
        proxyProc.kill();
        die('Proxy failed to start within 20s');
    }
}

console.log(`\n${divider}`);
console.log(`🚀  Proxy ready — running ${config.tests.length} test(s) in parallel`);
console.log(`${divider}\n`);

// ---------------------------------------------------------------------------
// Run tests in parallel
// ---------------------------------------------------------------------------

const results: TestResult[] = await Promise.all(config.tests.map(async (test, i): Promise<TestResult> => {
    const label     = test.name ?? `[${i}] ${test.url}`;
    const proxyUrl  = `http://localhost:${port}/${test.url}`;
    const ms        = test.timeout ?? config.timeout;
    const headers: Record<string, string> = {};
    if (test.proxyOptions) headers['X-Proxy-Options'] = test.proxyOptions;

    const t0 = Date.now();
    try {
        const res  = await withTimeout(fetch(proxyUrl, { headers }), ms, label);
        const body = await res.text();
        const elapsed = Date.now() - t0;

        if (res.status < 200 || res.status >= 300)
            return { label, pass: false, status: res.status, bytes: body.length, ms: elapsed,
                reason: `Non-2XX response` };

        if (test.responseType === 'json') {
            const ct = res.headers.get('content-type') ?? '';
            if (!ct.includes('application/json'))
                return { label, pass: false, status: res.status, bytes: body.length, ms: elapsed,
                    reason: `Expected application/json content-type, got: ${ct}` };
        }

        if (!body.includes(test.expect)) {
            const preview = body.length > 300 ? body.slice(0, 300) + `… (+${body.length - 300} chars)` : body;
            return { label, pass: false, status: res.status, bytes: body.length, ms: elapsed,
                reason: `Expected text not found: ${JSON.stringify(test.expect)}\nBody preview:\n${preview}` };
        }

        return { label, pass: true, status: res.status, bytes: body.length, ms: elapsed };
    } catch (e: any) {
        return { label, pass: false, ms: Date.now() - t0, reason: e.message };
    }
}));

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\n${divider}`);
console.log('📋  Results');
console.log(`${divider}\n`);

let passed = 0, failed = 0;
for (const r of results) {
    if (r.pass) {
        console.log(`  ✅  PASS  ${r.label}  →  HTTP ${r.status} (${r.bytes}B, ${r.ms}ms)`);
        passed++;
    } else {
        console.log(`  ❌  FAIL  ${r.label}${r.status ? `  →  HTTP ${r.status} (${r.bytes}B, ${r.ms}ms)` : `  (${r.ms}ms)`}`);
        if (r.reason) {
            for (const line of r.reason.split('\n'))
                console.log(`          ${line}`);
        }
        failed++;
    }
}

console.log(`\n${divider}`);
console.log(`    ${passed} passed  ·  ${failed} failed`);
console.log(`${divider}\n`);

proxyProc?.kill();
process.exit(failed > 0 ? 1 : 0);
