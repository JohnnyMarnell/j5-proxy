# proxy

Headless Chrome proxy that lets you fetch any URL through a stealth-configured Playwright browser. Supports HTML scraping, full JS rendering, and JSON API proxying — all controllable per-request via the `X-Proxy-Options` header.

## Install

```bash
bun install
```

## Run

```bash
bun --hot index.ts
```

### CLI flags

| Flag | Default | Description |
|---|---|---|
| `-p`, `--port` | `8787` | Server port |
| `-t`, `--ttl` | `3600000` | Cookie cache TTL (ms) |
| `--log-html` | `false` | Log HTML at each pipeline step to stdout (all requests) |
| `--log-file` | `/tmp/proxy.jsonl` | Path for the JSONL request log |
| `-i`, `--idle` | `1800000` | Auto-shutdown after ms of inactivity (default 30m) |
| `--throttle-interval` | `5000` | Cache responses for this many ms |
| `--throttle-regex` | `.*` | Only cache URLs matching this regex |

```bash
bun --hot index.ts -p 3000 --log-html --log-file ./requests.jsonl
bun --hot index.ts --throttle-interval 10000 --throttle-regex 'example\.com'
bun --hot index.ts --help
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

Returns the first real HTML document response from the server, skipping Cloudflare challenge pages. A `<base>` tag is injected so relative URLs (CSS, JS, images) resolve against the original origin.

```bash
curl http://localhost:8787/example.com
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

Every request is logged to `/tmp/proxy.jsonl` (configurable via `--log-file`). Each line is a JSON object you can tail and pipe through `jq`.

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

**Tailing examples:**

```bash
# Watch requests in real time
tail -f /tmp/proxy.jsonl | jq '{id:.reqId, step:.step, ms:.elapsed}'

# See just completed requests with timing
tail -f /tmp/proxy.jsonl | jq 'select(.duration) | {id:.reqId, url:.url, ms:.duration, status:.status}'

# Filter JSON API responses
tail -f /tmp/proxy.jsonl | jq 'select(.step=="json-response") | {url:.request.url, ms:.elapsed, len:.response.bodyLength}'
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
ℹ [#2 +180ms] JSON response: 200 (4523 bytes)
✔ [#2] GET https://api.example.com/data → 200 (4523B) 195ms
⚠ [#1 +2905ms] Selector "#content" not found within 20000ms
✔ [#1] GET https://example.com → 200 (52001B) 4112ms [render]
```

### Cookie injection

Cookies are automatically extracted from your local Chrome via `cookies.py` and injected into every browser context. They're cached for the TTL duration (default 1 hour) to avoid repeated extraction.

### Idle auto-shutdown

The proxy automatically shuts down after `--idle` ms (default 30 minutes) of inactivity. A macOS notification is sent on shutdown.

## X-Proxy-Options reference

Pass as a comma-separated header. All options are optional.

```
X-Proxy-Options: render, log-html, wait=10000, selector=.main-content, settle=2000
```

| Option | Type | Default | Description |
|---|---|---|---|
| `render` | flag | off | Full JS render mode |
| `log-html` | flag | off | Log HTML at each step to stdout |
| `wait` | ms | `20000` | Max wait for networkidle / selector |
| `selector` | CSS | none | Wait for selector before capturing DOM |
| `settle` | ms | `1000` | Post-render settle time |
