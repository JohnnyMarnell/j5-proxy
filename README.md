# j5-proxy

[![CI](https://github.com/JohnnyMarnell/proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/JohnnyMarnell/proxy/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/j5-proxy)](https://www.npmjs.com/package/j5-proxy)
[![license](https://img.shields.io/github/license/JohnnyMarnell/j5-proxy)](LICENSE)

Proxy utility that seamlessly passes Cloudflare bot detection and automatically injects local Chrome cookies.

Supports fast HTML interception, full JS rendering, and JSON API proxying — all controllable per-request via the `X-Proxy-Options` header. Ships as both CLI and programmatic API.

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

# As a library
bun add j5-proxy
npm install j5-proxy
```

Chromium is downloaded automatically on first install via the `postinstall` script.
If you skipped that step: `npx patchright install chromium`

### Standalone binary

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

## Usage

Proxy any URL by passing it as the path:

```bash
curl http://localhost:8787/https://example.com

# https:// is assumed
curl http://localhost:8787/example.com
```

---

## Modes

### Default — fast HTML interception

Blocks all non-document sub-requests (scripts, fonts, images) before they hit the wire. Captures the first document response and closes the page immediately. Returns in roughly the time of one HTTP round-trip.

A `<base>` tag is injected so relative URLs resolve against the original origin.

```bash
curl http://localhost:8787/example.com
```

### `render` — full JS execution

Navigates the page and waits for the browser's `load` event (all initial resources fetched), then returns the live DOM. Use `load-state` to trade speed for thoroughness.

```bash
curl -H "X-Proxy-Options: render" http://localhost:8787/example.com
```

#### Load states

| `load-state` | Completes when | Typical time | Use when |
|---|---|---|---|
| `domcontentloaded` | HTML parsed, deferred scripts run | ~100–500ms | Server-rendered pages, just need DOM structure |
| `load` *(default)* | All initial resources fetched (scripts, CSS, images) | ~1–5s | Most JS-rendered pages |
| `networkidle` | No network activity for 500ms | ~15–25s | SPAs with progressive async loading |

```bash
curl -H "X-Proxy-Options: render" http://localhost:8787/example.com
# ^ load (default)

curl -H "X-Proxy-Options: render, load-state=domcontentloaded" http://localhost:8787/example.com
# ^ fastest

curl -H "X-Proxy-Options: render, load-state=networkidle" http://localhost:8787/example.com
# ^ most thorough, slowest
```

### `verify` — Cloudflare-aware interception

Like default mode but allows all sub-requests to run so Cloudflare's background verification can complete. Holds the page open after HTML capture and waits for the CF JSD oneshot response (up to 5s) before returning. Good middle ground between default and full render.

```bash
curl -H "X-Proxy-Options: verify" http://localhost:8787/example.com
```

**What you'll see in logs:**
```
ℹ [#1 +312ms] ✓ CF JSD background verification request detected
ℹ [#1 +489ms] ✓ verify: no CF challenge, real content received
ℹ [#1 +891ms] ✓ CF JSD verification confirmed (200)
ℹ [#1 +891ms] requests completed: document:1, script:4, fetch:2, stylesheet:1
```

If CF ever serves a blocking "Just a moment" challenge page (rare with a real Chrome fingerprint + cookies), `verify` holds and waits for the post-bypass document. Default mode would return the challenge HTML and warn.

---

## Browser selection

By default j5-proxy uses **Chromium** (bundled with patchright, binary-level stealth patches applied). This works well for most sites.

Use `--chrome` to switch to **real Chrome** with a persistent browser context:

```bash
j5-proxy --chrome
```

| | Chromium (default) | Chrome (`--chrome`) |
|---|---|---|
| Binary | Bundled Chromium | System Chrome (`channel: chrome`) |
| Context | Fresh per request | Persistent across all requests |
| Profile dir | n/a | `$TMPDIR/j5-proxy-chrome-profile` |
| Viewport | 1280×720 | OS default (`viewport: null`) |
| User agent | Chrome UA (patchright) | Real Chrome UA |
| Cookies | Injected per request | Injected at launch, cleared on refresh |

The persistent profile accumulates browsing history and storage across proxy restarts, which can help with fingerprint legitimacy. Install Chrome if not already present:

```bash
npx patchright install chrome
```

## Cloudflare detection

The proxy uses a real Chromium binary with the stealth plugin and injects your local Chrome cookies. This combination means CF typically sees a legitimate browser fingerprint and skips the interactive challenge entirely, going straight to background verification (CF JSD).

**Two distinct CF signals — logged at all verbosity levels:**

| Log | Meaning |
|---|---|
| `✓ CF JSD background verification request detected` | CF is doing invisible background browser verification. Real content was already served. Good. |
| `✓ CF JSD verification confirmed (200)` | CF's oneshot POST completed — session verified. |
| `⚠ CF challenge page detected — returning challenge HTML` | Blocking challenge was served. Use `verify` to wait it out. |
| `✓ CF challenge page detected — waiting for bypass` | (`verify` mode) Holding for challenge to complete. |
| `✓ CF bypass complete — real content received` | (`verify` mode) Challenge passed, real HTML captured. |

---

## CLI flags

```bash
bun --hot index.ts --help
```

| Flag | Default | Description |
|---|---|---|
| `-p`, `--port` | `8787` | Server port |
| `-t`, `--ttl` | `3600000` | Cookie cache TTL (ms) |
| `--log-html` | `false` | Log HTML at each pipeline step (truncated to 500 chars) |
| `--log-file` | `/tmp/j5-proxy.jsonl` | Path for the JSONL request log |
| `-i`, `--idle` | `1800000` | Auto-shutdown after ms of inactivity (0 to disable) |
| `--throttle-interval` | `5000` | Cache responses for this many ms |
| `--throttle-regex` | `.*` | Only cache URLs matching this regex |
| `--notify` / `--no-notify` | `true` | OS notification on non-2XX responses |
| `--startup-notify` / `--no-startup-notify` | `true` | OS notification on startup |
| `--refresh-cookies` | `false` | Force fresh cookie extraction on startup |
| `--chrome` | `false` | Use real Chrome with persistent context instead of Chromium |
| `-v` / `-vv` / `-vvv` | off | Verbosity (see below) |

### Verbosity levels

```bash
bun --hot index.ts -v      # log all requests, aborts, and responses
bun --hot index.ts -vv     # same + HTML at pipeline steps (truncated to 500 chars)
bun --hot index.ts -vvv    # same + full HTML body
```

| Level | Requests | Skipped (aborted) | Responses | HTML steps |
|---|---|---|---|---|
| *(none)* | — | count summary | — | — |
| `-v` | documents only | count summary | ✓ | — |
| `-vv` | documents only | each individually | ✓ | truncated |
| `-vvv` | all (fire time + abort time) | each individually | ✓ | full |

In default intercept mode, non-document requests are aborted before hitting the network. At `-v` you get a one-line summary at the end:
```
ℹ [#1 +843ms] ✗ skipped: script:6, font:2, image:4
```
At `-vv` each abort is logged as it fires:
```
ℹ [#1 +563ms] ✗ skip script https://...vendor.js
```
At `-vvv` you also see the initial request fire, then the abort:
```
ℹ [#1 +480ms] → script https://...vendor.js
ℹ [#1 +481ms] ✗ skip script https://...vendor.js
```

---

## X-Proxy-Options reference

Pass as a comma-separated header. Unknown options or invalid values return **400**.

```bash
curl -H "X-Proxy-Options: render, wait=10000, selector=#content, settle=500" \
  http://localhost:8787/example.com
```

| Option | Type | Default | Description |
|---|---|---|---|
| `render` | flag | off | Full JS render mode |
| `verify` | flag | off | CF-aware interception: allow sub-requests, wait for JSD oneshot |
| `log-html` | flag | off | Log HTML at each pipeline step |
| `screenshot` | flag | off | Save a headless screenshot to `/tmp` |
| `refresh-cookies` | flag | off | Force fresh cookie extraction for this request |
| `wait` | ms | `20000` | Max wait for load-state / selector in render mode |
| `selector` | CSS | none | Wait for a CSS selector before capturing (render mode) |
| `settle` | ms | `1000` | Extra wait after load-state/selector (render mode) |
| `load-state` | string | `load` | Render completion signal: `domcontentloaded`, `load`, `networkidle` |

**Invalid option → 400:**
```bash
curl -H "X-Proxy-Options: rendur" http://localhost:8787/example.com
# HTTP 400
# {"error":"Invalid X-Proxy-Options","details":["unknown option: \"rendur\" (valid: render, verify, log-html, refresh-cookies, screenshot)"]}
```

---

## Logging

### Console

```
✔ [#1] GET https://example.com → 200 (48231B) 843ms [cache-stored]
✔ [#2] GET https://example.com → 200 (48231B) 2ms [cached #1]
⚠ [#3] GET https://example.com/missing → 404 (153B) 210ms body={"error":"not found"}
✔ [#4] GET https://example.com → 200 (48231B) 1203ms [render, log-html] 📸 /tmp/example-com_123.png
```

In render/verify mode, completed request counts are logged before the final line:
```
ℹ [#4 +1198ms] requests completed: document:1, script:8, fetch:3, stylesheet:2, image:1
```

### JSONL log

Every request is appended to `--log-file` (default `/tmp/j5-proxy.jsonl`):

```bash
# Watch in real time
tail -f /tmp/j5-proxy.jsonl | jq '{id:.reqId, ms:.duration, status:.status, url:.url}'

# Only completed requests
tail -f /tmp/j5-proxy.jsonl | jq 'select(.duration) | {id:.reqId, url:.url, ms:.duration, status:.status}'

# JSON API responses
tail -f /tmp/j5-proxy.jsonl | jq 'select(.step=="json-response") | {url:.request.url, ms:.elapsed}'

# Screenshots
tail -f /tmp/j5-proxy.jsonl | jq 'select(.step=="screenshot") | .response.screenshotPath'
```

Log steps emitted per request:

| Step | When |
|---|---|
| `first-response` | First document response received by the browser |
| `json-response` | JSON content-type detected — includes upstream headers |
| `intercepted-response` | Default/verify mode captured HTML (with `log-html`) |
| `after-commit` | DOM after initial commit (with `log-html` + `render`) |
| `after-networkidle` | DOM after load-state completes (with `log-html` + `render`) |
| `after-selector` | DOM after selector found (with `log-html` + `render` + `selector`) |
| `final-rendered` | Final rendered DOM (with `log-html` + `render`) |
| `fallback-dom` | Captured from live DOM after intercept timeout |
| `screenshot` | Screenshot path recorded |

---

## Response throttle cache

GET requests are cached for `--throttle-interval` ms (default 5s). Only URLs matching `--throttle-regex` are cached. `render` and `selector` requests bypass the cache.

---

## Cookie injection

Cookies are automatically extracted from your local Chrome via `cookies.py` and injected into every browser context. Cached for `--ttl` ms (default 1 hour).

Requires `browser_cookie3`:
```bash
pip install browser-cookie3
```

Without it the proxy works fine, just without session cookies. Force a refresh:
```bash
j5-proxy --refresh-cookies
curl -H "X-Proxy-Options: refresh-cookies" http://localhost:8787/example.com
```

---

## Idle auto-shutdown

The proxy shuts down after `--idle` ms (default 30 minutes) of inactivity. Disable with `--idle 0`.

---

## Bot detection testing

```bash
bun --hot index.ts   # terminal 1
bun run bot          # terminal 2 — scrapes 5 bot detector sites in parallel with screenshots
```

Sites tested:
- https://bot.sannysoft.com/
- https://abrahamjuliot.github.io/creepjs/
- https://www.browserscan.net/bot-detection
- https://pixelscan.net/fingerprint-check

Screenshots saved to `/tmp/j5-proxy_*.png`.

---

## Programmatic API

```typescript
import { scrape, createProxy } from 'j5-proxy';

const { html, status, isJson } = await scrape('https://example.com', {
  render: true,
  wait: 10000,
  selector: '#main',
  settle: 500,
});

const proxy = await createProxy({ port: 8787 });
await proxy.stop();
```

---

## Zyte API emulation

The proxy exposes a Zyte-compatible endpoint for drop-in local testing:

```bash
curl -u "$(python3 -c 'import secrets; print(secrets.token_hex(16))')": \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "httpResponseBody": true}' \
  http://localhost:8787/v1/extract
```
