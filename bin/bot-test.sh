#!/bin/bash
# Bot detector test script
# Scrapes all major bot detection sites with screenshots and opens results

set -e

PROXY_URL="${PROXY_URL:-http://localhost:8787}"
TMPDIR="/tmp"

# URLs to test
declare -a URLS=(
    "https://bot.sannysoft.com/"
    "https://abrahamjuliot.github.io/creepjs/"
    "https://www.browserscan.net/bot-detection"
    "https://pixelscan.net/fingerprint-check"
    "https://browserleaks.com/"
)

echo "🤖 Bot detection test suite"
echo "================================"
echo "Proxy: $PROXY_URL"
echo "Clearing old screenshots..."
rm -f "$TMPDIR"/j5-proxy_*.png

echo "Scraping ${#URLS[@]} bot detectors with screenshots..."

# Scrape all URLs in parallel
for url in "${URLS[@]}"; do
    (
        echo "  → $url"
        curl -s -H "X-Proxy-Options: screenshot" "$PROXY_URL/$url" > /dev/null 2>&1
    ) &
done

# Wait for all background jobs
wait
echo "✓ All screenshots captured"

# Count and display results
count=$(ls -1 "$TMPDIR"/j5-proxy_*.png 2>/dev/null | wc -l)
echo "📸 Found $count screenshots in $TMPDIR"
ls -lh "$TMPDIR"/j5-proxy_*.png 2>/dev/null | awk '{print "  " $9 " (" $5 ")"}'

echo ""
echo "Opening screenshots..."
open "$TMPDIR"/j5-proxy_*.png
