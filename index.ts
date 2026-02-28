/// <reference lib="dom" />
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { execSync } from 'child_process';
import { parseArgs } from 'node:util';

// --- CLI ARGUMENT PARSING ---
const { values } = parseArgs({
    options: {
        port: { type: 'string', short: 'p', default: '8787' },
        ttl: { type: 'string', short: 't', default: '3600000' }, // Default cache TTL: 1 hour (in ms)
    }
});

const PORT = parseInt(values.port as string, 10);
const COOKIE_CACHE_TTL = parseInt(values.ttl as string, 10);

// Apply stealth plugin
chromium.use(stealth());

const app = new Hono();

let browser: any; 

// --- COOKIE CACHING STATE ---
let cachedCookies: any[] = [];
let lastCookieFetchTime: number = 0;

// Helper function to get cookies (either from cache or by executing Python)
function getCookies(): any[] {
    const now = Date.now();
    
    // Return cached cookies if they exist and haven't expired
    if (cachedCookies.length > 0 && (now - lastCookieFetchTime < COOKIE_CACHE_TTL)) {
        console.log('[-] Using cached session cookies.');
        return cachedCookies;
    }

    console.log('[+] Cache expired or empty. Extracting fresh Chrome cookies via Python...');
    try {
        // Execute the Python script synchronously
        // Ensure cookies.py is in the same directory
        const pythonOutput = execSync('python cookies.py').toString();
        
        const parsedCookies = JSON.parse(pythonOutput);
        
        if (parsedCookies.error) {
            throw new Error(parsedCookies.error);
        }

        // Update the cache
        cachedCookies = parsedCookies;
        lastCookieFetchTime = now;
        
        console.log(`[+] Successfully extracted and cached ${cachedCookies.length} cookies.`);
        return cachedCookies;
    } catch (error: any) {
        console.error(`[!] Failed to extract cookies via Python: ${error.message}`);
        // Fallback: return existing cached cookies if available, otherwise empty array
        return cachedCookies; 
    }
}

// 1. Initialize the browser
async function initBrowser() {
    console.log('Booting Chromium...');
    browser = await chromium.launch({ headless: true });
    console.log('Browser ready.');
}

// 2. Define the proxy route
app.get('/*', async (c) => {
    const path = c.req.path.substring(1); 
    
    if (!path || path === 'favicon.ico') {
        return c.text('Not found', 404);
    }

    const targetUrl = path.startsWith('http') ? path : `https://${path}`;
    console.log(`\n[+] Scrape request: ${targetUrl}`);

    let targetOrigin = '';
    try {
        targetOrigin = new URL(targetUrl).origin;
    } catch (e) {
        return c.text('Invalid URL provided', 400);
    }

    let context;
    try {
        // Fetch cookies (triggers Python script if cache is stale)
        const sessionCookies = getCookies();

        context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 720 }
        });
        
        // Inject the freshly decrypted or cached cookies into this specific context
        if (sessionCookies.length > 0) {
            await context.addCookies(sessionCookies);
        }
        
        const page = await context.newPage();

        // --- THE ROBUST HTML INTERCEPTOR ---
        const captureHtmlPromise = new Promise<string>((resolve) => {
            page.on('response', async (response: any) => {
                if (response.request().resourceType() === 'document' && response.request().frame() === page.mainFrame()) {
                    try {
                        const text = await response.text();
                        
                        if (!text.includes('challenge-error-text') && !text.includes('Just a moment')) {
                            if (text.length > 1000) {
                                resolve(text);
                            }
                        } else {
                            console.log('[-] Cloudflare challenge detected, waiting for it to solve and reload...');
                        }
                    } catch (e) {
                        // Body might be unavailable during rapid redirects, safe to ignore
                    }
                }
            });
        });

        console.log('Navigating to target...');
        
        await page.goto(targetUrl, { waitUntil: 'commit', timeout: 30000 });

        console.log('Waiting for valid HTML payload (bypassing CF if present)...');
        
        let rawHtml: string;
        try {
            rawHtml = await Promise.race([
                captureHtmlPromise,
                new Promise<string>((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout waiting for real HTML (Cloudflare might be stuck)')), 25000)
                )
            ]);
            console.log('Success! Intercepted the pure View Source payload.');
        } catch (err: any) {
            console.log(`Fallback: Promise timed out. Grabbing live DOM content. Error: ${err.message}`);
            rawHtml = await page.content();
        }

        // --- THE REGEX MAGIC ---
        const finalHtml = rawHtml.replace(
            /(href|src|action)=["'](\/[^/][^"']*)["']/gi,
            `$1="${targetOrigin}$2"`
        );

        return c.html(finalHtml);

    } catch (error: any) {
        console.error(`[-] Error scraping ${targetUrl}:`, error.message);
        return c.text(`Error scraping page: ${error.message}`, 500);
    } finally {
        if (context) await context.close(); 
    }
});

// 3. Start the server
initBrowser().then(() => {
    serve({
        fetch: app.fetch,
        port: PORT
    }, (info) => {
        console.log(`\n🚀 Headless proxy running at http://localhost:${info.port}`);
    });
});

process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    if (browser) await browser.close();
    process.exit(0);
});