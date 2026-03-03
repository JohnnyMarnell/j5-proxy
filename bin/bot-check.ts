#!/usr/bin/env bun
// Bot detector test suite — scrapes bot detection sites with screenshots,
// generates a single HTML viewer, and opens it in the browser.

import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROXY_URL = process.env.PROXY_URL ?? 'http://localhost:8787';
const START_MS = Date.now();
const RUN_DIR = await mkdtemp(join(tmpdir(), 'j5-proxy-bot-check-'));
const VIEWER_PATH = join(RUN_DIR, 'index.html');

const TARGETS: { url: string; options?: string }[] = [
    { url: 'https://bot.sannysoft.com/' },
    { url: 'https://abrahamjuliot.github.io/creepjs/' },
    { url: 'https://www.browserscan.net/bot-detection' },
    { url: 'https://pixelscan.net/fingerprint-check', options: 'load-state=networkidle, wait=45000' },
    { url: 'https://browserleaks.com/canvas' },
    { url: 'https://browserleaks.com/webgl' },
    { url: 'https://browserleaks.com/webrtc' },
];

console.log('🤖 Bot detection test suite');
console.log('================================');
console.log(`Proxy: ${PROXY_URL}`);

console.log(`Run dir: ${RUN_DIR}`);

// Scrape all URLs in parallel with screenshots
console.log(`Scraping ${TARGETS.length} bot detectors in parallel...`);
const results = await Promise.allSettled(
    TARGETS.map(async ({ url, options }) => {
        const proxyOptions = ['render', 'screenshot', options].filter(Boolean).join(', ');
        const res = await fetch(`${PROXY_URL}/${url}`, {
            headers: { 'X-Proxy-Options': proxyOptions },
        });
        const status = res.status;
        console.log(`  ${status === 200 ? '✓' : '⚠'} ${status} ${url}`);
        return { url, status };
    })
);

const failed = results.filter(r => r.status === 'rejected');
if (failed.length > 0) {
    console.warn(`⚠ ${failed.length} request(s) failed:`);
    failed.forEach(r => console.warn(`  ${(r as PromiseRejectedResult).reason}`));
}

// Collect screenshots written during this run — proxy embeds Date.now() in filenames, filter by start time.
const screenshots = (await readdir(tmpdir()))
    .filter(f => {
        if (!f.startsWith('j5-proxy_') || !f.endsWith('.png')) return false;
        const ts = parseInt(f.replace(/.*_(\d+)\.png$/, '$1'), 10);
        return !isNaN(ts) && ts >= START_MS;
    })
    .sort()
    .map(f => join(tmpdir(), f));

console.log(`\n📸 ${screenshots.length} screenshot(s) captured`);

// Generate HTML viewer
const items = screenshots.map(p => {
    const label = p.replace(/^.*j5-proxy_/, '').replace(/_\d+\.png$/, '').replace(/-/g, '.');
    return `
    <section>
      <h2>${label}</h2>
      <img src="file://${p}" alt="${label}">
    </section>`;
}).join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>j5-proxy bot check</title>
  <style>
    body { background: #111; color: #eee; font-family: sans-serif; margin: 0; padding: 24px; }
    h1   { margin-bottom: 24px; }
    section { margin-bottom: 48px; }
    h2   { font-size: 14px; color: #aaa; margin-bottom: 8px; word-break: break-all; }
    img  { max-width: 100%; border: 1px solid #333; display: block; }
  </style>
</head>
<body>
  <h1>🤖 j5-proxy bot check</h1>
  ${items || '<p>No screenshots found.</p>'}
</body>
</html>`;

await writeFile(VIEWER_PATH, html);
console.log(`\nViewer: ${VIEWER_PATH}`);

execSync(`open "file://${VIEWER_PATH}"`);
