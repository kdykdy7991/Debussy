#!/usr/bin/env python3
"""Verify the new Agent design content mounts inside the real AppShell."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:5173/#/agents/agent_00000000-0000-0000-0000-000000000000"

def main() -> int:
    with sync_playwright() as p:
        chrome = "/Users/dykong/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        browser = p.chromium.launch(executable_path=chrome)
        page = browser.new_page(viewport={"width": 1440, "height": 980})

        api_calls = []
        errors = []
        def on_request(req):
            if "/api/control/" in req.url:
                api_calls.append(f"{req.method} {req.url}")
        page.on("request", on_request)
        page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))

        page.goto(URL, wait_until="networkidle", timeout=20000)
        page.wait_for_timeout(2000)

        # Check: the new content is mounted
        title = page.locator(".adp-header__title").first
        title_text = title.text_content() or ""
        print(f"page title: '{title_text.strip()}'")

        # Check: left sidebar is the real AppSidebar (not the preview's NavRail)
        app_sidebar = page.locator(".app-sidebar, [class*='AppSidebar'], aside").first
        sidebar_text = app_sidebar.text_content() or ""
        has_debussy = "Debussy" in sidebar_text
        has_total = "总览" in sidebar_text
        print(f"left sidebar has 'Debussy': {has_debussy}, has '总览': {has_total}")

        # Check: data source indicator
        ds = page.locator(".adp-header__datasource").first
        ds_text = ds.text_content() or ""
        print(f"data source: '{ds_text.strip()}'")

        # Check: load error banner
        banner = page.locator(".adp-banner")
        banner_visible = banner.is_visible() if banner.count() else False
        print(f"load error banner visible: {banner_visible}")

        # API calls made
        print(f"API calls: {len(api_calls)}")
        for c in api_calls:
            print(f"  {c}")

        print(f"Page errors: {len(errors)}")
        for e in errors:
            print(f"  {e}")

        page.screenshot(path="/tmp/adp-replaced.png", full_page=False)
        Path("/Users/dykong/Documents/Debussy/runtimes/pi/packages/web/ui-preview-replaced.png").write_bytes(
            Path("/tmp/adp-replaced.png").read_bytes()
        )
        print("saved /tmp/adp-replaced.png")
        browser.close()
    return 0

if __name__ == "__main__":
    sys.exit(main())
