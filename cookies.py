import browser_cookie3
import json
import sys

def export_cookies():
    try:
        # Extract only the cookies we need to avoid massive payloads
        cookie_jar = browser_cookie3.chrome(domain_name='claude.ai')
        
        playwright_cookies = []
        for cookie in cookie_jar:
            playwright_cookies.append({
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain,
                "path": cookie.path,
                "secure": cookie.secure,
                # Playwright strictly requires float or -1 for session cookies
                "expires": float(cookie.expires) if cookie.expires else -1,
                "sameSite": "None"
            })
            
        # Output directly to stdout for Node to capture
        print(json.dumps(playwright_cookies))
        
    except Exception as e:
        # Send errors to stderr so they don't corrupt the JSON payload
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    export_cookies()