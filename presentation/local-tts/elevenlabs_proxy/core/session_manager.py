"""Account and Session Manager for ElevenLabs Web & API Pool.

Manages tokens, cookies, and API keys for free tier accounts.
Supports automatic credit tracking, balance refreshing, and multi-account rotation.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
import base64
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
import requests

logger = logging.getLogger("elevenlabs-api.session")

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
ACCOUNTS_FILE = DATA_DIR / "accounts.json"

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
)


class SessionManager:
    def __init__(self, storage_path: Path = ACCOUNTS_FILE):
        self.storage_path = storage_path
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        self._accounts: Dict[str, Dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if self.storage_path.is_file():
            try:
                data = json.loads(self.storage_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    self._accounts = data
                elif isinstance(data, list):
                    self._accounts = {item["id"]: item for item in data if "id" in item}
                self._deduplicate_accounts()
            except Exception as e:
                logger.error(f"Failed to load accounts file: {e}")
                self._accounts = {}
        else:
            self._accounts = {}

    @staticmethod
    def _token_identity(token: str) -> str:
        """Return the stable ElevenLabs user id from a JWT, when available."""
        raw = str(token or "").strip()
        if raw.lower().startswith("bearer "):
            raw = raw[7:].strip()
        try:
            payload = raw.split(".")[1]
            payload += "=" * (-len(payload) % 4)
            claims = json.loads(base64.urlsafe_b64decode(payload.encode("ascii")).decode("utf-8"))
            return str(claims.get("sub") or claims.get("user_id") or claims.get("email") or "").strip().lower()
        except (IndexError, ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
            return ""

    @classmethod
    def _account_identity(cls, account: Dict[str, Any]) -> str:
        token_identity = cls._token_identity(account.get("token", ""))
        if token_identity:
            return f"token:{token_identity}"
        email = str(account.get("email") or "").strip().lower()
        return f"email:{email}" if email else ""

    def _deduplicate_accounts(self) -> None:
        """Collapse duplicate browser sessions for the same ElevenLabs user."""
        unique: Dict[str, Dict[str, Any]] = {}
        duplicate_ids = []
        for account_id, account in self._accounts.items():
            identity = self._account_identity(account)
            if not identity or identity not in unique:
                unique[identity or f"id:{account_id}"] = account
                continue

            current = unique[identity]
            current_score = (
                current.get("status") == "active",
                current.get("last_checked") or "",
            )
            candidate_score = (
                account.get("status") == "active",
                account.get("last_checked") or "",
            )
            if candidate_score >= current_score:
                unique[identity] = account
            duplicate_ids.append(account_id)

        if duplicate_ids:
            self._accounts = {account["id"]: account for account in unique.values()}
            self._save()
            logger.info("Removed %d duplicate ElevenLabs session(s)", len(duplicate_ids))

    def _save(self) -> None:
        try:
            self.storage_path.write_text(
                json.dumps(self._accounts, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            logger.error(f"Failed to save accounts file: {e}")

    def build_headers(self, account: Dict[str, Any]) -> Dict[str, str]:
        user_agent = account.get("user_agent") or DEFAULT_USER_AGENT
        headers = {
            "User-Agent": user_agent,
            "Origin": "https://elevenlabs.io",
            "Referer": "https://elevenlabs.io/",
            "Accept": "application/json",
        }
        token = account.get("token", "").strip()
        auth_type = account.get("auth_type", "bearer").lower()

        if auth_type == "bearer":
            if not token.startswith("Bearer "):
                headers["Authorization"] = f"Bearer {token}"
            else:
                headers["Authorization"] = token
        elif auth_type == "api_key":
            headers["xi-api-key"] = token
        elif auth_type == "cookie":
            # For cookie auth without bearer token, or combine
            if token:
                headers["Authorization"] = f"Bearer {token}" if not token.startswith("Bearer ") else token

        # If cookies are provided as string
        cookie_val = account.get("cookies")
        if cookie_val:
            if isinstance(cookie_val, dict):
                headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookie_val.items())
            elif isinstance(cookie_val, str) and cookie_val.strip():
                headers["Cookie"] = cookie_val.strip()

        return headers

    def refresh_account_info(self, account_id: str) -> Dict[str, Any]:
        account = self._accounts.get(account_id)
        if not account:
            raise ValueError(f"Account {account_id} not found")

        headers = self.build_headers(account)
        try:
            # Query user & subscription
            sub_url = "https://api.elevenlabs.io/v1/user/subscription"
            resp = requests.get(sub_url, headers=headers, timeout=12)
            if resp.status_code == 200:
                sub_data = resp.json()
                char_count = int(sub_data.get("character_count", 0))
                char_limit = int(sub_data.get("character_limit", 10000))
                tier = sub_data.get("tier", "free")
                status = sub_data.get("status", "active")
                reset_unix = sub_data.get("next_character_count_reset_unix")
                reset_date_str = ""
                if reset_unix:
                    try:
                        reset_date_str = datetime.fromtimestamp(reset_unix, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
                    except Exception:
                        pass

                account["character_count"] = char_count
                account["character_limit"] = char_limit
                account["remaining_characters"] = max(0, char_limit - char_count)
                account["tier"] = tier
                account["status"] = "active" if account["remaining_characters"] > 0 else "quota_exceeded"
                account["reset_date"] = reset_date_str
                account["last_checked"] = datetime.now(timezone.utc).isoformat()
                account["error_message"] = None

                # Also try to fetch user email if possible
                try:
                    user_resp = requests.get("https://api.elevenlabs.io/v1/user", headers=headers, timeout=8)
                    if user_resp.status_code == 200:
                        user_data = user_resp.json()
                        email = user_data.get("email")
                        if email:
                            account["email"] = email
                            if not account.get("name") or account.get("name").startswith("Account "):
                                account["name"] = email
                except Exception:
                    pass

            elif resp.status_code in (401, 403):
                account["status"] = "invalid_auth"
                account["error_message"] = f"Authentication failed ({resp.status_code}): {resp.text[:120]}"
            else:
                account["status"] = "error"
                account["error_message"] = f"HTTP {resp.status_code}: {resp.text[:120]}"

        except Exception as e:
            logger.error(f"Error checking subscription for {account_id}: {e}")
            account["status"] = "network_error"
            account["error_message"] = str(e)

        self._save()
        return account

    def add_or_update_account(
        self,
        token: str,
        auth_type: str = "bearer",
        name: Optional[str] = None,
        cookies: Optional[str] = None,
        user_agent: Optional[str] = None,
        account_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        token = token.strip()
        if not token:
            raise ValueError("Token or API key is required")

        if not account_id:
            identity = self._account_identity({"token": token, "email": name if "@" in str(name or "") else ""})
            for existing_id, existing in self._accounts.items():
                if identity and self._account_identity(existing) == identity:
                    account_id = existing_id
                    break
            if not account_id:
                account_id = f"acc_{uuid.uuid4().hex[:8]}"

        existing = self._accounts.get(account_id, {})
        account = {
            "id": account_id,
            "name": name or existing.get("name") or f"Account {len(self._accounts) + 1}",
            "email": existing.get("email", ""),
            "auth_type": auth_type.lower(),
            "token": token,
            "cookies": cookies if cookies is not None else existing.get("cookies", ""),
            "user_agent": user_agent or existing.get("user_agent") or DEFAULT_USER_AGENT,
            "character_count": existing.get("character_count", 0),
            "character_limit": existing.get("character_limit", 10000),
            "remaining_characters": existing.get("remaining_characters", 10000),
            "tier": existing.get("tier", "free"),
            "status": existing.get("status", "unknown"),
            "reset_date": existing.get("reset_date", ""),
            "last_checked": existing.get("last_checked", None),
            "created_at": existing.get("created_at") or datetime.now(timezone.utc).isoformat(),
            "error_message": None,
        }
        self._accounts[account_id] = account
        self._save()

        # Try to refresh stats immediately
        try:
            self.refresh_account_info(account_id)
        except Exception:
            pass

        return self._accounts[account_id]

    def remove_account(self, account_id: str) -> bool:
        if account_id in self._accounts:
            del self._accounts[account_id]
            self._save()
            return True
        return False

    def list_accounts(self) -> List[Dict[str, Any]]:
        # Return accounts sorted by remaining_characters desc
        accounts_list = list(self._accounts.values())
        accounts_list.sort(key=lambda a: a.get("remaining_characters", 0), reverse=True)
        return accounts_list

    def get_active_account(self) -> Optional[Dict[str, Any]]:
        """Select the best available account with remaining credits."""
        valid_accounts = [
            acc
            for acc in self._accounts.values()
            if acc.get("status") in ("active", "unknown")
            and acc.get("remaining_characters", 0) > 0
        ]
        if not valid_accounts:
            # If all are exhausted or none active, return any account that is not invalid_auth
            valid_accounts = [
                acc for acc in self._accounts.values() if acc.get("status") != "invalid_auth"
            ]

        if not valid_accounts:
            return None

        # Sort by remaining characters descending
        valid_accounts.sort(key=lambda a: a.get("remaining_characters", 0), reverse=True)
        return valid_accounts[0]

    def mark_quota_exhausted(self, account_id: str, reason: str = "quota_exhausted") -> None:
        if account_id in self._accounts:
            self._accounts[account_id]["status"] = "quota_exceeded"
            self._accounts[account_id]["remaining_characters"] = 0
            self._accounts[account_id]["error_message"] = reason
            self._save()

    def mark_invalid_auth(self, account_id: str, reason: str = "invalid_auth") -> None:
        if account_id in self._accounts:
            self._accounts[account_id]["status"] = "invalid_auth"
            self._accounts[account_id]["error_message"] = reason
            self._save()

    def get_total_balance(self) -> Dict[str, Any]:
        total_remaining = 0
        total_limit = 0
        active_count = 0
        for acc in self._accounts.values():
            if acc.get("status") in ("active", "unknown"):
                total_remaining += acc.get("remaining_characters", 0)
                total_limit += acc.get("character_limit", 10000)
                active_count += 1

        return {
            "total_accounts": len(self._accounts),
            "active_accounts": active_count,
            "total_remaining_characters": total_remaining,
            "total_character_limit": total_limit,
            "estimated_credits": total_remaining,
        }
