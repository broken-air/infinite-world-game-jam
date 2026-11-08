"""Shared local HTTP and Chromium lifecycle base for browser verification."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright


PROJECT_ROOT = Path(__file__).resolve().parents[1]
GAME_DIR = PROJECT_ROOT / "game"


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *args):
        pass


class BrowserHarness:
    def __init__(self, game_dir=GAME_DIR, host="127.0.0.1", port=0, headless=True):
        self.game_dir = Path(game_dir).resolve()
        self.host = host
        self.port = port
        self.headless = headless
        self._server = None
        self._thread = None
        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None

    @property
    def base_url(self):
        if self._server is None:
            raise RuntimeError("BrowserHarness has not started")
        return f"http://{self.host}:{self._server.server_port}"

    @property
    def page(self):
        if self._page is None:
            raise RuntimeError("BrowserHarness has not started")
        return self._page

    @property
    def context(self):
        """暴露浏览器上下文，供需要每用例独立 page 的测试（如 e2e.py）使用。"""
        if self._context is None:
            raise RuntimeError("BrowserHarness has not started")
        return self._context

    def start(self):
        if self._server is not None:
            return self

        handler = partial(_QuietHandler, directory=str(self.game_dir))
        self._server = ThreadingHTTPServer((self.host, self.port), handler)
        self._thread = Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        try:
            self._playwright = sync_playwright().start()
            self._browser = self._playwright.chromium.launch(headless=self.headless)
            self._context = self._browser.new_context()
            self._page = self._context.new_page()
        except Exception:
            self.stop()
            raise
        return self

    def open(self, path="/"):
        self.page.goto(f"{self.base_url}/{path.lstrip('/')}")
        return self.page

    def stop(self):
        if self._context is not None:
            self._context.close()
            self._context = None
        if self._browser is not None:
            self._browser.close()
            self._browser = None
        if self._playwright is not None:
            self._playwright.stop()
            self._playwright = None
        self._page = None
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join()
            self._thread = None

    def __enter__(self):
        return self.start()

    def __exit__(self, _exc_type, _exc_value, _traceback):
        self.stop()
