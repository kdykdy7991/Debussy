#!/usr/bin/env python3
"""Verify save flow + list page work after replacement."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

DETAIL_URL = "http://127.0.0.1:5173/#/agents/agent_00000000-0000-0000-0000-000000000000"
LIST_URL = "http://127.0.0.1:5173/#/agents"

def main() -> int:
    with sync_playwright() as p:
        chrome = "/Users/dykong/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        browser = p.chromium.launch(executable_path=chrome)

        # ── Test 1: detail page save flow ──────────────────────────────
        page = browser.new_page(viewport={"width": 1440, "height": 980})
        api_calls = []
        page.on("request", lambda req: api_calls.append(f"{req.method} {req.url}") if "/api/control/" in req.url else None)

        page.goto(DETAIL_URL, wait_until="networkidle", timeout=20000)
        page.wait_for_timeout(1500)

        # Edit welcome (second textarea)
        welcome = page.locator('textarea').nth(1)
        welcome.click()
        welcome.press("End")
        welcome.type(" [Phase3]")
        page.wait_for_timeout(200)

        save_btn = page.get_by_role("button", name="保存草稿")
        assert not save_btn.is_disabled(), "save should be enabled after edit"
        save_btn.click()
        page.wait_for_timeout(2000)

        post_calls = [c for c in api_calls if "POST" in c and "revisions" in c]
        print(f"[detail] POST /revisions calls: {len(post_calls)}")
        assert post_calls, "expected POST /revisions"
        page.close()

        # ── Test 2: list page still works ─────────────────────────────
        page = browser.new_page(viewport={"width": 1440, "height": 980})
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.goto(LIST_URL, wait_until="networkidle", timeout=20000)
        page.wait_for_timeout(2000)
        # The real list view should mount inside the same AppShell
        data_route = page.locator(".admin-shell").first.get_attribute("data-route")
        print(f"[list] data-route: {data_route}")
        assert data_route == "agents", f"expected 'agents', got '{data_route}'"
        assert len(errors) == 0, f"page errors: {errors}"
        page.screenshot(path="/tmp/adp-list.png", full_page=False)
        Path("/Users/dykong/Documents/Debussy/runtimes/pi/packages/web/ui-preview-list.png").write_bytes(
            Path("/tmp/adp-list.png").read_bytes()
        )
        print("saved /tmp/adp-list.png")
        browser.close()
    print("\n✓ all assertions passed")
    return 0

if __name__ == "__main__":
    sys.exit(main())
