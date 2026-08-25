#!/usr/bin/env python3
"""Compare reference screenshot and current preview screenshot stacked."""
import base64
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

REF = Path("/Users/dykong/.minimax/v2/assets/2026/08/25/20-30-31-504-asset_20260825-203031-504_2164874c42ba_6fc7eb90-ChatGPT Image 2026年8月25日 20_23_07.png")
CUR = Path("/tmp/adp-screenshot.png")

def b64(p: Path) -> str:
    return base64.b64encode(p.read_bytes()).decode("ascii")

def main() -> int:
    ref_b64 = b64(REF)
    cur_b64 = b64(CUR)
    with sync_playwright() as p:
        chrome = "/Users/dykong/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        browser = p.chromium.launch(executable_path=chrome)
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        html = f"""
<!doctype html>
<html><head><style>
  body {{ margin: 0; font-family: system-ui, sans-serif; background: #0e0e10; color: #eee; }}
  .row {{ display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 8px; }}
  .col {{ background: #1a1a1d; border: 1px solid #2a2a2f; border-radius: 6px; overflow: hidden; }}
  .col h3 {{ margin: 0; padding: 6px 10px; font-size: 12px; font-weight: 600; color: #ccc; background: #232327; }}
  .col img {{ display: block; width: 100%; height: auto; }}
</style></head>
<body>
  <div class="row">
    <div class="col"><h3>Reference (screenshot)</h3><img src="data:image/png;base64,{ref_b64}"></div>
    <div class="col"><h3>Current implementation</h3><img src="data:image/png;base64,{cur_b64}"></div>
  </div>
</body></html>
"""
        page.set_content(html)
        page.wait_for_timeout(500)
        # Set viewport to match the content height
        height = page.evaluate("() => document.body.scrollHeight")
        page.set_viewport_size({"width": 1600, "height": min(height + 20, 4000)})
        page.screenshot(path="/tmp/adp-compare.png", full_page=True)
        browser.close()
    print("saved /tmp/adp-compare.png")
    return 0

if __name__ == "__main__":
    sys.exit(main())
