"""Automatic Token & Session Extractor for ElevenLabs.

Scans local Chrome, Edge, and Brave browser profiles to automatically extract
active ElevenLabs Web JWT tokens and session credentials without needing
to open a new browser or enter passwords.
"""

from __future__ import annotations

import glob
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional
import requests

from core.session_manager import SessionManager, DEFAULT_USER_AGENT

logger = logging.getLogger("elevenlabs-api.extractor")


def get_browser_user_data_paths() -> List[Path]:
    """Find user data directories for popular browsers on Windows."""
    paths = []
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        return paths

    base = Path(local_app_data)
    candidates = [
        base / "Google" / "Chrome" / "User Data",
        base / "Microsoft" / "Edge" / "User Data",
        base / "BraveSoftware" / "Brave-Browser" / "User Data",
        base / "Chromium" / "User Data",
    ]
    for p in candidates:
        if p.is_dir():
            paths.append(p)
    return paths


def find_candidate_tokens_in_file(file_path: Path) -> List[str]:
    """Read binary file safely and extract potential JWT tokens."""
    tokens = []
    try:
        # If file is locked, copy to a temp file first
        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            shutil.copy2(file_path, tmp_path)
            data = tmp_path.read_bytes()
        finally:
            if tmp_path.is_file():
                try:
                    tmp_path.unlink()
                except Exception:
                    pass

        # ElevenLabs JWT tokens from Firebase/Auth start with eyJ and have 3 base64 parts
        pattern = rb"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}"
        matches = re.findall(pattern, data)
        for m in matches:
            tok = m.decode("ascii", errors="ignore")
            if len(tok) > 200:  # Valid auth JWTs are typically 800-1400 chars
                tokens.append(tok)
    except Exception as e:
        logger.debug(f"Could not read {file_path}: {e}")

    return tokens


def validate_token(token: str) -> Optional[Dict[str, Any]]:
    """Test token against ElevenLabs subscription API."""
    headers = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Origin": "https://elevenlabs.io",
        "Referer": "https://elevenlabs.io/",
        "Authorization": f"Bearer {token}",
    }
    try:
        resp = requests.get(
            "https://api.elevenlabs.io/v1/user/subscription",
            headers=headers,
            timeout=8,
        )
        if resp.status_code == 200:
            sub = resp.json()
            email = None
            try:
                user_resp = requests.get(
                    "https://api.elevenlabs.io/v1/user",
                    headers=headers,
                    timeout=5,
                )
                if user_resp.status_code == 200:
                    email = user_resp.json().get("email")
            except Exception:
                pass

            return {
                "token": token,
                "email": email,
                "tier": sub.get("tier", "free"),
                "character_count": sub.get("character_count", 0),
                "character_limit": sub.get("character_limit", 10000),
                "remaining_characters": max(
                    0, sub.get("character_limit", 10000) - sub.get("character_count", 0)
                ),
            }
    except Exception as e:
        logger.debug(f"Token validation failed: {e}")
    return None


def auto_extract_tokens(session_manager: SessionManager) -> List[Dict[str, Any]]:
    """Scan all local browser profiles, validate tokens, and save to SessionManager."""
    user_data_paths = get_browser_user_data_paths()
    seen_tokens = set()
    found_accounts = []

    for browser_dir in user_data_paths:
        pattern = str(
            browser_dir
            / "*"
            / "IndexedDB"
            / "https_elevenlabs.io_0.indexeddb.leveldb"
            / "*"
        )
        for filepath in glob.glob(pattern):
            f = Path(filepath)
            if not f.is_file() or f.name in ("LOCK", "LOG"):
                continue

            candidates = find_candidate_tokens_in_file(f)
            for cand in candidates:
                if cand in seen_tokens:
                    continue
                seen_tokens.add(cand)

                # Validate
                valid_info = validate_token(cand)
                if valid_info:
                    email = valid_info.get("email") or "ElevenLabs Chrome Account"
                    acc = session_manager.add_or_update_account(
                        token=cand,
                        auth_type="bearer",
                        name=f"{email} (Tự động từ Chrome)",
                    )
                    found_accounts.append(acc)
                    logger.info(f"Auto-extracted valid ElevenLabs session: {email}")

    return found_accounts
