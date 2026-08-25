#!/usr/bin/env python3
"""Take a screenshot of the /ui-preview/agent-design page for visual diffing."""
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:5173/ui-preview/agent-design"
OUT = Path("/tmp/adp-screenshot.png")

def main() -> int:
    chrome_path = "/Users/dykong/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=chrome_path)
        context = browser.new_context(viewport={"width": 1440, "height": 980}, device_scale_factor=1)
        page = context.new_page()
        page.goto(URL, wait_until="networkidle", timeout=20000)
        # Give fonts a moment to load
        page.wait_for_timeout(1500)
        page.screenshot(path=str(OUT), full_page=False)
        browser.close()
    print(f"saved {OUT}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
