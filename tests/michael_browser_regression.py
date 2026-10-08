"""Optional browser regressions: python tests/michael_browser_regression.py.
Requires Playwright for Python and installed Google Chrome; no npm dependency.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import unittest

from playwright.sync_api import sync_playwright

TARGET = Path(__file__).resolve().parents[1] / "docs" / "michael"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class MichaelBrowserRegression(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(TARGET)))
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/index.html"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(channel="chrome")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def assert_form_inert(self, page):
        requests = []
        page.on("request", lambda request: requests.append(request.url))
        page.goto(self.url + "#contact")
        requests.clear()
        controls = page.locator("#brief-form input, #brief-form select, #brief-form textarea, #brief-form button")
        enabled = [controls.nth(i).get_attribute("id") or "submit" for i in range(controls.count()) if controls.nth(i).is_enabled()]
        # Try real browser input and click even if the fail-closed assertion fails.
        page.locator("#client-name").click(force=True)
        page.keyboard.type("DO_NOT_TRANSMIT")
        page.locator("#client-need").click(force=True)
        page.keyboard.type("DO_NOT_TRANSMIT_NEED")
        page.keyboard.press("Enter")
        page.locator("#brief-form button").click(force=True)
        page.wait_for_timeout(200)
        self.assertEqual(requests, [], "Inert form must not request a URL or submit fields")
        self.assertEqual(page.locator("#client-name").input_value(), "", "Inert form must not accept input")
        self.assertEqual(enabled, [], "All consultation controls must remain disabled without an installed handler")

    def test_no_javascript_cannot_enter_or_transmit_fields(self):
        context = self.browser.new_context(java_script_enabled=False)
        try:
            page = context.new_page()
            self.assert_form_inert(page)
            self.assertIn("JavaScript", page.locator("#brief-form noscript").inner_text())
            self.assertIn("disabled", page.locator("#brief-form noscript").inner_text())
        finally:
            context.close()

    def test_skip_to_content_preserves_pricing(self):
        context = self.browser.new_context()
        try:
            page = context.new_page()
            page.goto(self.url)
            page.get_by_role("tab", name="Pricing", exact=True).click()
            page.wait_for_function("location.hash === '#pricing'")
            skip = page.get_by_role("link", name="Skip to content")
            skip.focus()
            skip.press("Enter")
            page.wait_for_function("location.hash === '#main'")
            page.wait_for_timeout(100)
            self.assertTrue(page.locator("#pricing").is_visible(), "Skip must preserve Pricing, not activate Overview")
            self.assertEqual(page.locator("#tab-pricing").get_attribute("aria-selected"), "true")
            self.assertEqual(page.evaluate("document.activeElement.id"), "main")
            # Repeat when the hash already equals #main (no hashchange event).
            skip.focus()
            skip.press("Enter")
            self.assertEqual(page.evaluate("document.activeElement.id"), "main")
        finally:
            context.close()

    def test_download_status_does_not_claim_saved_or_sent(self):
        context = self.browser.new_context()
        try:
            page = context.new_page()
            page.goto(self.url + "#contact")
            page.locator("#client-name").fill("Regression Tester")
            page.locator("#client-need").fill("Local download only")
            requests = []
            page.on("request", lambda request: requests.append(request.url))
            with page.expect_download() as download:
                page.get_by_role("button", name="Download my consultation brief").click()
            self.assertIn("Regression Tester", download.value.path().read_text(encoding="utf-8"))
            status = page.locator("#brief-status").inner_text().lower()
            self.assertIn("download requested", status)
            self.assertIn("not sent", status)
            self.assertNotIn("has been downloaded", status)
            self.assertEqual(requests, [], "Download must not perform server requests")
        finally:
            context.close()

    def test_tabpanels_are_keyboard_focusable(self):
        context = self.browser.new_context()
        try:
            page = context.new_page()
            page.goto(self.url)
            panels = page.locator('[role="tabpanel"]')
            self.assertEqual(panels.count(), 6)
            for i in range(panels.count()):
                self.assertEqual(panels.nth(i).get_attribute("tabindex"), "0")
            page.locator("#tab-overview").focus()
            page.keyboard.press("Tab")
            self.assertEqual(page.evaluate("document.activeElement.id"), "overview")
        finally:
            context.close()

    def test_broken_initialization_keeps_form_inert(self):
        context = self.browser.new_context()
        try:
            page = context.new_page()
            page.add_init_script("URL.createObjectURL = undefined;")
            self.assert_form_inert(page)
        finally:
            context.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
