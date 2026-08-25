#!/usr/bin/env python3
"""Check for console errors on the preview page."""
import sys
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:5173/ui-preview/agent-design"

def main() -> int:
    with sync_playwright() as p:
        chrome = "/Users/dykong/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        browser = p.chromium.launch(executable_path=chrome)
        page = browser.new_page(viewport={"width": 1440, "height": 980})
        errors = []
        warnings = []
        def on_console(msg):
            t = msg.type
            if t == "error":
                errors.append(f"[{t}] {msg.text}")
            elif t == "warning":
                warnings.append(f"[{t}] {msg.text}")
        page.on("console", on_console)
        page.on("pageerror", lambda exc: errors.append(f"[pageerror] {exc}"))
        page.goto(URL, wait_until="networkidle", timeout=20000)
        page.wait_for_timeout(1500)
        browser.close()
    print(f"errors: {len(errors)}")
    for e in errors:
        print("  ", e)
    print(f"warnings: {len(warnings)}")
    for w in warnings[:5]:
        print("  ", w)
    return 0

if __name__ == "__main__":
    sys.exit(main())
