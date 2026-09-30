"""Browser Automation for ElevenLabs Login and Token Extraction using Playwright.

Launches a Chromium browser session with persistent context so the user can
log in via Google, Email, etc.
Automatically intercepts network traffic to extract:
- Authorization Bearer tokens
- Session Cookies
- User-Agent
And registers the captured credentials into SessionManager!
"""

from __future__ import annotations

import logging
import os
import re
import threading
from pathlib import Path
from typing import Any, Callable, Dict, Optional
from core.session_manager import SessionManager, DEFAULT_USER_AGENT

logger = logging.getLogger("elevenlabs-api.browser")

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PROFILE_DIR = DATA_DIR / "browser_profile"


def clean_profile_locks(profile_dir: Path) -> None:
    """Remove stale Chrome lock files that prevent relaunch."""
    for lock_name in ("SingletonLock", "SingletonSocket", "SingletonCookie", "LOCK"):
        lock_file = profile_dir / lock_name
        if lock_file.exists():
            try:
                if lock_file.is_file():
                    lock_file.unlink()
                elif lock_file.is_dir():
                    lock_file.rmdir()
            except Exception:
                pass


class BrowserAuthHelper:
    def __init__(self, session_manager: SessionManager):
        self.session_manager = session_manager
        self._is_running = False
        self._captured_data: Optional[Dict[str, Any]] = None
        self._lock = threading.Lock()
        self.status = "idle"  # idle | launching | waiting_login | captured | error
        self.error_message: Optional[str] = None

    def start_login_flow(
        self,
        on_success: Optional[Callable[[Dict[str, Any]], None]] = None,
        headless: bool = False,
    ) -> Dict[str, Any]:
        with self._lock:
            if self._is_running:
                return {"ok": False, "message": "Trình duyệt đăng nhập đang chạy, vui lòng kiểm tra cửa sổ trên màn hình"}
            self._is_running = True
            self.status = "launching"
            self.error_message = None

        thread = threading.Thread(
            target=self._run_browser_thread,
            args=(on_success, headless),
            daemon=True,
        )
        thread.start()
        return {"ok": True, "message": "Đang mở trình duyệt đăng nhập..."}

    def _run_browser_thread(
        self,
        on_success: Optional[Callable[[Dict[str, Any]], None]],
        headless: bool,
    ) -> None:
        from playwright.sync_api import sync_playwright

        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        clean_profile_locks(PROFILE_DIR)

        captured = {
            "token": None,
            "auth_type": "bearer",
            "cookies": "",
            "user_agent": DEFAULT_USER_AGENT,
            "name": "",
        }

        try:
            with sync_playwright() as p:
                logger.info("Starting browser for ElevenLabs login...")

                # Try real Chrome if available, fallback to bundled Chromium
                launch_kwargs = {
                    "user_data_dir": str(PROFILE_DIR),
                    "headless": headless,
                    "viewport": {"width": 1280, "height": 800},
                    "user_agent": DEFAULT_USER_AGENT,
                    "args": [
                        "--disable-blink-features=AutomationControlled",
                        "--no-sandbox",
                    ],
                }

                try:
                    context = p.chromium.launch_persistent_context(channel="chrome", **launch_kwargs)
                except Exception:
                    context = p.chromium.launch_persistent_context(**launch_kwargs)

                page = context.pages[0] if context.pages else context.new_page()

                def on_request(request):
                    url = request.url
                    if "api.elevenlabs.io" in url or "elevenlabs.io/api" in url:
                        headers = request.headers
                        auth_header = headers.get("authorization")
                        api_key = headers.get("xi-api-key")

                        if auth_header and auth_header.startswith("Bearer "):
                            token_val = auth_header[7:].strip()
                            if token_val and len(token_val) > 20:
                                captured["token"] = token_val
                                captured["auth_type"] = "bearer"
                        elif api_key:
                            captured["token"] = api_key
                            captured["auth_type"] = "api_key"

                page.on("request", on_request)

                def read_firebase_session() -> None:
                    """Read the logged-in Firebase token when the SPA made no API call yet."""
                    if captured["token"]:
                        return
                    try:
                        session = page.evaluate(
                            """async () => new Promise((resolve) => {
                                try {
                                    const opened = indexedDB.open('firebaseLocalStorageDb');
                                    opened.onerror = () => resolve(null);
                                    opened.onsuccess = (event) => {
                                        try {
                                            const db = event.target.result;
                                            const tx = db.transaction('firebaseLocalStorage', 'readonly');
                                            const request = tx.objectStore('firebaseLocalStorage').getAll();
                                            request.onerror = () => resolve(null);
                                            request.onsuccess = () => {
                                                const rows = Array.isArray(request.result) ? request.result : [];
                                                const item = rows.find((row) => row?.value?.stsTokenManager?.accessToken);
                                                if (!item) return resolve(null);
                                                resolve({
                                                    token: item.value.stsTokenManager.accessToken,
                                                    name: item.value.email || item.value.displayName || '',
                                                });
                                            };
                                        } catch (_) { resolve(null); }
                                    };
                                } catch (_) { resolve(null); }
                            })"""
                        )
                        token = str((session or {}).get("token") or "").strip()
                        if len(token) > 20:
                            captured["token"] = token
                            captured["auth_type"] = "bearer"
                            captured["name"] = str((session or {}).get("name") or "").strip()
                    except Exception as session_error:
                        logger.debug(f"Firebase session lookup unavailable: {session_error}")

                def read_browser_storage() -> None:
                    """Fallback for newer app builds that keep auth outside Firebase IndexedDB."""
                    if captured["token"]:
                        return
                    try:
                        storage = page.evaluate(
                            """() => ({
                                local: Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)) || ''),
                                session: Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.getItem(sessionStorage.key(i)) || '')
                            })"""
                        ) or {}
                        values = list(storage.get("local") or []) + list(storage.get("session") or [])
                        for value in values:
                            match = re.search(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", str(value))
                            if match:
                                captured["token"] = match.group(0)
                                captured["auth_type"] = "bearer"
                                email = re.search(r'"email"\s*:\s*"([^"\\]+)', str(value))
                                captured["name"] = email.group(1) if email else ""
                                return
                        for cookie in context.cookies("https://elevenlabs.io"):
                            value = str(cookie.get("value") or "")
                            if value.count(".") == 2 and len(value) > 40:
                                captured["token"] = value
                                captured["auth_type"] = "bearer"
                                return
                    except Exception as storage_error:
                        logger.debug(f"Browser storage lookup unavailable: {storage_error}")

                self.status = "waiting_login"
                logger.info("Navigating to ElevenLabs sign-in...")
                try:
                    page.goto("https://elevenlabs.io/app/speech-synthesis", timeout=45000, wait_until="domcontentloaded")
                except Exception as nav_err:
                    logger.warning(f"Navigation warning (continuing): {nav_err}")

                # Wait for user to log in and an API call to happen
                max_wait_seconds = 180  # 3 minutes for user to login
                poll_interval = 1.0
                elapsed = 0.0

                while elapsed < max_wait_seconds and not captured["token"]:
                    page.wait_for_timeout(int(poll_interval * 1000))
                    read_firebase_session()
                    read_browser_storage()
                    elapsed += poll_interval

                if captured["token"]:
                    cookies = context.cookies("https://elevenlabs.io")
                    cookie_str = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
                    captured["cookies"] = cookie_str

                    account = self.session_manager.add_or_update_account(
                        token=captured["token"],
                        auth_type=captured["auth_type"],
                        cookies=captured["cookies"],
                        user_agent=DEFAULT_USER_AGENT,
                        name=captured["name"] or "ElevenLabs Web (Trình duyệt)",
                    )
                    self._captured_data = account
                    self.status = "captured"
                    logger.info(f"Successfully captured ElevenLabs session: {account.get('id')}")

                    if on_success:
                        try:
                            on_success(account)
                        except Exception as cb_err:
                            logger.error(f"Error in on_success callback: {cb_err}")

                    page.wait_for_timeout(3000)
                else:
                    self.status = "timeout"
                    self.error_message = "Hết thời gian chờ đăng nhập (3 phút)."
                    logger.warning("Timed out waiting for login/token capture.")

                context.close()

        except Exception as e:
            logger.error(f"Browser login error: {e}")
            self.status = "error"
            self.error_message = str(e)
        finally:
            with self._lock:
                self._is_running = False
