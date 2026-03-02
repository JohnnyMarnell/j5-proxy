# Proxy — Project Guidelines

Headless Chrome proxy server. Single-file TypeScript app (`index.ts`).

## Runtime & tooling

- **Bun** is the runtime. Use `bun install`, `bun run`, `bun --hot index.ts`.
- **Hono** + `@hono/node-server` for HTTP routing/serving. Not Express, not raw `Bun.serve()`.
- **consola** for logging. No manual timestamp formatting or custom log functions.
- **cac** for CLI argument parsing. Not `parseArgs` from `node:util`.

## Key libraries

- `playwright-extra` + `puppeteer-extra-plugin-stealth` for headless Chrome
- `cookies.py` companion script for extracting local Chrome cookies

## Code style

- Keep the request handler thin — business logic lives in small named functions (`buildRequestContext`, `tryCache`, `attachResponseListeners`, `renderPage`, `interceptPage`, `logCompletion`).
- `RequestContext` is the shared state bag threaded through handler functions.
- For non-2XX responses, always include status + truncated body in the log line.
