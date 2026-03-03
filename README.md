# j5-proxy

[![CI](https://github.com/JohnnyMarnell/proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/JohnnyMarnell/proxy/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/j5-proxy)](https://www.npmjs.com/package/j5-proxy)
[![license](https://img.shields.io/github/license/JohnnyMarnell/j5-proxy)](LICENSE)

Proxy utility that can seamlessly pass Cloudfare bot detection and automatically inject cookies.

Supports HTML scraping, full JS rendering, and JSON API proxying — all controllable per-request via the `X-Proxy-Options` header. Ships as both CLI and programmatic API for use as a library.

Also works as a local [Zyte](https://www.zyte.com/) emulator.

## Install

```bash
# Bun (recommended)
bunx j5-proxy

# npm / npx
npx j5-proxy

# Global install
npm install -g j5-proxy
bun add -g j5-proxy

# As a library (programmatic API)
bun add j5-proxy
npm install j5-proxy
```

Chromium is downloaded automatically on first install via the `postinstall` script.
If you skipped that step, run: `npx playwright install chromium`

### Standalone binary (no runtime required)

Download a pre-built binary from [GitHub Releases](https://github.com/JohnnyMarnell/proxy/releases):

```bash
# macOS (Apple Silicon)
curl -L https://github.com/JohnnyMarnell/proxy/releases/latest/download/j5-proxy-mac-arm64 -o j5-proxy
chmod +x j5-proxy && ./j5-proxy
```

### Development

```bash
git clone https://github.com/JohnnyMarnell/proxy
cd proxy && bun install
bun --hot index.ts
```

## Run

```bash
bun --hot index.ts
# or after global install:
j5-proxy
```

### Bot detection testing

Test the proxy against major bot detectors in parallel:

```bash
# Start the proxy in one terminal
bun --hot index.ts

# In another terminal, run the bot detector test suite
bun run bot
# or
bash ./bin/bot-test.sh
```

This will:
1. Clear previous screenshots from `/tmp`
2. Scrape all 5 bot detector sites **in parallel** with screenshots
3. Automatically open all screenshots in your default image viewer

Sites tested:
- https://bot.sannysoft.com/
- https://abrahamjuliot.github.io/creepjs/
- https://www.browserscan.net/bot-detection
- https://pixelscan.net/
- https://browserleaks.com/

Screenshots are saved to `/tmp/j5-proxy_*.png` for inspection.

### CLI flags

| Flag | Default | Description |
|---|---|---|
| `-p`, `--port` | `8787` | Server port |
| `-t`, `--ttl` | `3600000` | Cookie cache TTL (ms) |
| `--log-html` | `false` | Log HTML at each pipeline step to stdout (all requests) |
| `--log-file` | `/tmp/j5-proxy.jsonl` | Path for the JSONL request log |
| `-i`, `--idle` | `1800000` | Auto-shutdown after ms of inactivity (default 30m) |
| `--throttle-interval` | `5000` | Cache responses for this many ms |
| `--throttle-regex` | `.*` | Only cache URLs matching this regex |

```bash
bun --hot index -p 3000 --log-html --log-file ./requests.jsonl
bun --hot index --throttle-interval 10000 --throttle-regex 'example\.com'
bun --hot index --help
```

## Usage

Proxy any URL by passing it as the path:

```bash
# Browser or curl — just append the target URL
curl http://localhost:8787/https://example.com

# https:// is assumed if no scheme given
curl http://localhost:8787/example.com
```

## Features

### Default mode — HTML interception

Returns the first real HTML document response from the server, automatically detecting and waiting for Cloudflare challenge pages. A `<base>` tag is injected so relative URLs (CSS, JS, images) resolve against the original origin.

**Cloudflare challenge detection** watches for:
- `challenge-error-text` and `Just a moment` strings
- Cloudflare challenge cookies (`cf_clearance`, `__cf_bm`)
- `Checking your browser` and `Enable JavaScript and cookies` messages
- `Cloudflare` + `Ray ID` combo (Cloudflare-specific headers)

When a challenge is detected, the proxy logs:
```
ℹ [#1 +342ms] Cloudflare challenge detected, waiting for bypass...
ℹ [#1 +2905ms] ✓ Cloudflare challenge bypassed
```

The browser automatically completes the challenge (typically 3-10 seconds), then the proxy captures and returns the real HTML.

```bash
curl http://localhost:8787/example.com
# Automatically detects, waits for, and bypasses Cloudflare challenges
```

### Render mode — full JS execution

Wait for the page to fully render (networkidle + JS settle time), then return the final DOM state. Useful for SPAs and pages that build their content client-side.

```bash
curl -H "X-Proxy-Options: render" http://localhost:8787/example.com
```

### Render sub-options

Fine-tune render behavior per-request:

| Option | Default | Description |
|---|---|---|
| `render` | off | Enable render mode |
| `wait=<ms>` | `20000` | Max wait for networkidle and selector |
| `selector=<css>` | none | Wait for a CSS selector to appear before capturing |
| `settle=<ms>` | `1000` | Extra settle time after networkidle/selector for late JS mutations |

```bash
# Wait up to 10s, require #content to appear, 2s settle
curl -H "X-Proxy-Options: render, wait=10000, selector=#content, settle=2000" \
  http://localhost:8787/example.com
```

### Screenshot capture

Take a headless browser screenshot for visual debugging or bot detector testing. The screenshot is captured **before** the response is sent, ensuring you can see exactly what the browser rendered at that moment.

Screenshots are saved to `/tmp/<domain>_<timestamp>.png` and the path is included in both console and JSONL logs.

```bash
curl -H "X-Proxy-Options: screenshot" http://localhost:8787/example.com

# Console output:
✔ [#1] GET example.com → 200 (25688B) 775ms [screenshot] 📸 /tmp/example-com_1708452000123.png

# JSONL log entry includes:
# "screenshotPath": "/tmp/example-com_1708452000123.png"
```

**Combine with render mode for full JS execution + screenshot:**
```bash
curl -H "X-Proxy-Options: render, screenshot" http://localhost:8787/example.com
```

**Useful for testing against bot detectors:**
- https://bot.sannysoft.com/
- https://abrahamjuliot.github.io/creepjs/
- https://www.browserscan.net/bot-detection
- https://pixelscan.net/
- https://browserleaks.com/

Example workflow:
```bash
# Take screenshots before and after render mode
curl -H "X-Proxy-Options: screenshot" http://localhost:8787/bot.sannysoft.com
curl -H "X-Proxy-Options: render, screenshot" http://localhost:8787/bot.sannysoft.com

# Check the logs
tail -f /tmp/j5-proxy.jsonl | jq 'select(.screenshotPath) | {url: .url, screenshot: .screenshotPath}'
```

### JSON API proxying

If the target URL returns `application/json`, the proxy short-circuits immediately — no HTML pipeline, no rendering wait. The JSON body and upstream response headers are forwarded directly.

```bash
curl http://localhost:8787/api.example.com/v1/data
# Returns JSON with original headers (content-type, cache-control, etc.)
```

### Response throttle cache

GET requests are cached for `--throttle-interval` ms (default 5s) to avoid hammering the same URL. Only URLs matching `--throttle-regex` are cached. Render/selector requests bypass the cache.

### HTML step logging

Log the HTML at each stage of the pipeline to stdout. Enable per-request or globally:

```bash
# Per-request
curl -H "X-Proxy-Options: log-html" http://localhost:8787/example.com

# Per-request with render
curl -H "X-Proxy-Options: render, log-html" http://localhost:8787/example.com

# Globally via CLI
bun --hot index.ts --log-html
```

When enabled, stdout shows a 500-char preview at each step:
```
[#1 +342ms HTML:after-commit] https://example.com
────────────────────────────────────────────────────────────
<!doctype html><html>... (48231 chars total)
────────────────────────────────────────────────────────────
```

### JSONL request log

Every request is logged to `/tmp/j5-proxy.jsonl` (configurable via `--log-file`). Each line is a JSON object you can tail and pipe through `jq`.

**Log entries are emitted at each step**, not just at the end — so `tail -f` shows activity immediately:

| Step | When |
|---|---|
| `first-response` | The very first document response the browser receives |
| `json-response` | JSON detected — includes upstream headers |
| `intercepted-response` | Default mode captured real HTML (with `log-html`) |
| `after-commit` | DOM after initial commit (with `log-html` + `render`) |
| `after-networkidle` | DOM after network settles (with `log-html` + `render`) |
| `after-selector` | DOM after selector found (with `log-html` + `render` + `selector`) |
| `final-rendered` | Final rendered DOM (with `log-html` + `render`) |
| `fallback-dom` | Timeout fallback (with `log-html`) |
| `screenshot` | Screenshot captured (with `screenshot` option) |

Each entry includes:

```json
{
  "ts": "2026-02-28T12:00:00.000Z",
  "reqId": 1,
  "elapsed": 342,
  "step": "first-response",
  "request": {
    "url": "https://example.com",
    "headers": { "host": "localhost:8787", "x-proxy-options": "render" },
    "proxyOptions": { "render": true, "logHtml": false, "wait": 20000, "selector": null, "settle": 1000 }
  },
  "response": {
    "status": 200,
    "bodyLength": 48231,
    "body": "<html>..."
  }
}
```

Screenshot step:
```json
{
  "ts": "2026-02-28T12:05:10.123Z",
  "reqId": 1,
  "elapsed": 5210,
  "step": "screenshot",
  "request": {
    "url": "https://bot.sannysoft.com",
    "headers": { "host": "localhost:8787", "x-proxy-options": "screenshot" },
    "proxyOptions": { "screenshot": true, ... }
  },
  "response": {
    "screenshotPath": "/tmp/bot-sannysoft-com_1708452010123.png"
  }
}
```

**Tailing examples:**

```bash
# Watch requests in real time
tail -f /tmp/j5-proxy.jsonl | jq '{id:.reqId, step:.step, ms:.elapsed}'

# See just completed requests with timing
tail -f /tmp/j5-proxy.jsonl | jq 'select(.duration) | {id:.reqId, url:.url, ms:.duration, status:.status}'

# Filter JSON API responses
tail -f /tmp/j5-proxy.jsonl | jq 'select(.step=="json-response") | {url:.request.url, ms:.elapsed, len:.response.bodyLength}'

# Find screenshot steps
tail -f /tmp/j5-proxy.jsonl | jq 'select(.step=="screenshot") | {id:.reqId, url:.request.url, screenshot:.response.screenshotPath}'
```

### Non-2XX response logging

When the upstream returns a non-2XX status, the log line includes the response body (truncated, JSON compacted) for easier debugging:

```
✔ [#1] GET https://example.com → 200 (48231B) 342ms [cache-stored]
⚠ [#2] GET https://example.com/missing → 404 (153B) 210ms body={"error":"not found"}
```

### Per-request timing

All stdout and JSONL entries are tagged with `#reqId` and `+elapsedMs`, so concurrent requests stay distinguishable:

```
ℹ [#1 +342ms] First response: 200 (48231 bytes)
ℹ [#1 +2905ms] Cloudflare challenge detected, waiting for bypass...
ℹ [#1 +5210ms] ✓ Cloudflare challenge bypassed
ℹ [#2 +180ms] JSON response: 200 (4523 bytes)
✔ [#2] GET https://api.example.com/data → 200 (4523B) 195ms
⚠ [#1 +2905ms] Selector "#content" not found within 20000ms
✔ [#1] GET https://example.com → 200 (52001B) 4112ms [render, screenshot] 📸 /tmp/example-com_1708452000123.png
```

### Cookie injection

Cookies are automatically extracted from your local Chrome via `cookies.py` and injected into every browser context. They're cached for the TTL duration (default 1 hour) to avoid repeated extraction.

### Idle auto-shutdown

The proxy automatically shuts down after `--idle` ms (default 30 minutes) of inactivity. A macOS notification is sent on shutdown.

## Programmatic API

Use j5-proxy as a library — no HTTP server needed.

```typescript
import { scrape, createProxy } from 'j5-proxy';

// One-shot scrape (creates + closes a browser per call)
const { html, status, isJson } = await scrape('https://example.com', {
  render: true,       // full JS render mode
  wait: 10000,        // max wait for networkidle (ms)
  selector: '#main',  // wait for a CSS selector to appear
  settle: 500,        // extra settle time after networkidle (ms)
});

// Long-lived proxy server (keeps one browser alive)
const proxy = await createProxy({
  port: 8787,
  throttleInterval: 10_000,
  throttleRegex: 'example\\.com',
});
// proxy is now reachable at http://localhost:8787
await proxy.stop(); // closes browser + server
```

### Cookie extraction

Cookies from your local Chrome are automatically injected if `browser_cookie3` is installed:

```bash
pip install browser-cookie3
```

Without it, the proxy works fine but without session cookies. To force a refresh:

```bash
# CLI
j5-proxy --refresh-cookies

# Per-request header (errors with 503 if cookies are unavailable)
curl -H "X-Proxy-Options: refresh-cookies" http://localhost:8787/example.com
```

## X-Proxy-Options reference

Pass as a comma-separated header. All options are optional.

```
X-Proxy-Options: render, log-html, screenshot, wait=10000, selector=.main-content, settle=2000
```

| Option | Type | Default | Description |
|---|---|---|---|
| `render` | flag | off | Full JS render mode |
| `log-html` | flag | off | Log HTML at each step to stdout |
| `screenshot` | flag | off | Take a headless browser screenshot (async, saves to /tmp) |
| `wait` | ms | `20000` | Max wait for networkidle / selector |
| `selector` | CSS | none | Wait for selector before capturing DOM |
| `settle` | ms | `1000` | Post-render settle time |
