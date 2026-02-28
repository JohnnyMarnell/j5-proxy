import argparse
import browser_cookie3
import json
import re
import sys

def export_cookies(include=None, exclude=None):
    try:
        cookie_jar = browser_cookie3.chrome()

        include_re = re.compile(include) if include else None
        exclude_re = re.compile(exclude) if exclude else None

        exported_cookies = []
        for cookie in cookie_jar:
            if include_re and not include_re.search(cookie.domain):
                continue
            if exclude_re and exclude_re.search(cookie.domain):
                continue
            exported_cookies.append({
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain,
                "path": cookie.path,
                "secure": bool(cookie.secure),
                # Playwright strictly requires float or -1 for session cookies
                "expires": float(cookie.expires) if cookie.expires else -1,
                "sameSite": "None"
            })

        print(json.dumps(exported_cookies))

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export Chrome cookies as JSON")
    parser.add_argument("--include", help="Regex to match cookie domains to include")
    parser.add_argument("--exclude", help="Regex to match cookie domains to exclude")
    args = parser.parse_args()
    export_cookies(include=args.include, exclude=args.exclude)