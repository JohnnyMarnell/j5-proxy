#!/usr/bin/env node
// Smart runtime wrapper:
//   bunx j5-proxy  → Bun runs this → isBun=true  → imports index.ts (TypeScript source, no compile needed)
//   npx j5-proxy   → Node runs this → isBun=false → imports dist/index.js (compiled output)

const isBun = typeof globalThis.Bun !== 'undefined';
import(isBun ? '../index.ts' : '../dist/index.js').catch(err => {
    console.error(err);
    process.exit(1);
});
