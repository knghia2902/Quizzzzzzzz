"""ElevenLabs Text-to-Speech Synthesizer with Multi-Account Auto-Failover.

Converts Vietnamese (and multilingual) text into high-quality MP3 audio.
Uses browser web session emulation or standard API keys.
Automatically rotates accounts when free quota / credits are depleted.
"""

from __future__ import annotations

import logging
import re
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
import requests

from core.session_manager import SessionManager

logger = logging.getLogger("elevenlabs-api.synth")

# Predefined well-known voices supporting eleven_multilingual_v2
DEFAULT_VOICES = [
    {"voice_id": "21m00Tcm4TlvDq8ikWAM", "name": "Rachel (Nữ - Truyền cảm, tự nhiên)", "category": "premade"},
    {"voice_id": "pNInz6obpgDQGcFmaJgB", "name": "Adam (Nam - Trầm ấm, dứt khoát)", "category": "premade"},
    {"voice_id": "TxGEqnHWrfWFTfGW9XjX", "name": "Josh (Nam - Trẻ trung, thân thiện)", "category": "premade"},
    {"voice_id": "EXAVITQu4vr4xnSDxMaL", "name": "Bella (Nữ - Tươi sáng, kể chuyện)", "category": "premade"},
    {"voice_id": "yoZ06aMxZJJ28mfd3POQ", "name": "Sam (Nam - Đọc tin tức, phát thanh)", "category": "premade"},
    {"voice_id": "VR6AewLTigWG4xSOukaG", "name": "Arnold (Nam - Chững chạc, nội lực)", "category": "premade"},
    {"voice_id": "AZnzlk1XvdvUeBnXmlld", "name": "Domi (Nữ - Tự tin, mạnh mẽ)", "category": "premade"},
    {"voice_id": "ErXwobaYiN019PkySvjV", "name": "Antoni (Nam - Điềm đạm, ấm áp)", "category": "premade"},
]

DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"
DEFAULT_MODEL_ID = "eleven_v3"

DEFAULT_MODELS = [
    {"model_id": "eleven_v3", "name": "Eleven v3 (Bản V3 mới nhất - Tự nhiên & biểu cảm nhất)"},
    {"model_id": "eleven_v3_conversational", "name": "Eleven v3 Conversational (Hội thoại đối thoại V3)"},
    {"model_id": "eleven_multilingual_v2", "name": "Eleven Multilingual v2 (Đa ngôn ngữ v2)"},
    {"model_id": "eleven_flash_v2_5", "name": "Eleven Flash v2.5 (Siêu nhanh 75ms)"},
    {"model_id": "eleven_turbo_v2_5", "name": "Eleven Turbo v2.5 (Cân bằng tốc độ)"},
]


class Synthesizer:
    def __init__(self, session_manager: SessionManager):
        self.session_manager = session_manager
        self._semaphores: Dict[str, threading.Semaphore] = {}
        self._lock = threading.Lock()

    def _get_semaphore(self, account_id: str) -> threading.Semaphore:
        """ElevenLabs free tier enforces max 2 concurrent requests per account."""
        with self._lock:
            if account_id not in self._semaphores:
                self._semaphores[account_id] = threading.Semaphore(2)
            return self._semaphores[account_id]

    def get_models(self) -> List[Dict[str, Any]]:
        """Fetch available models from ElevenLabs or return curated V3 list."""
        account = self.session_manager.get_active_account()
        if account:
            headers = self.session_manager.build_headers(account)
            try:
                resp = requests.get("https://api.elevenlabs.io/v1/models", headers=headers, timeout=8)
                if resp.status_code == 200:
                    models = resp.json()
                    if isinstance(models, list) and models:
                        v3_models = []
                        other_models = []
                        for m in models:
                            mid = m.get("model_id", "")
                            mname = m.get("name", mid)
                            if mid == "eleven_v3":
                                v3_models.insert(0, {"model_id": mid, "name": f"{mname} (Flagship V3 - Mới nhất)"})
                            elif "v3" in mid:
                                v3_models.append({"model_id": mid, "name": f"{mname} (Conversational V3)"})
                            else:
                                other_models.append({"model_id": mid, "name": mname})
                        return v3_models + other_models
            except Exception as e:
                logger.warning(f"Failed to fetch models from ElevenLabs: {e}")

        return DEFAULT_MODELS

    def get_voices(self) -> List[Dict[str, Any]]:
        """Fetch user voices or return default curated list."""
        account = self.session_manager.get_active_account()
        if account:
            headers = self.session_manager.build_headers(account)
            try:
                resp = requests.get("https://api.elevenlabs.io/v1/voices", headers=headers, timeout=10)
                if resp.status_code == 200:
                    data = resp.json()
                    voices = data.get("voices", [])
                    if voices:
                        return [
                            {
                                "voice_id": v["voice_id"],
                                "name": v["name"],
                                "category": v.get("category", "custom"),
                                "preview_url": v.get("preview_url"),
                            }
                            for v in voices
                        ]
            except Exception as e:
                logger.warning(f"Failed to fetch voices from ElevenLabs: {e}")

        return DEFAULT_VOICES

    @staticmethod
    def apply_audio_speed(audio_bytes: bytes, speed: float) -> bytes:
        """Adjust audio playback speed using ffmpeg atempo filter while preserving pitch."""
        if not audio_bytes or abs(float(speed) - 1.0) < 0.02:
            return audio_bytes

        try:
            filters = []
            rem = float(speed)
            while rem > 2.0:
                filters.append("atempo=2.0")
                rem /= 2.0
            while rem < 0.5:
                filters.append("atempo=0.5")
                rem /= 0.5
            filters.append(f"atempo={rem:.4f}")
            filter_str = ",".join(filters)

            cmd = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel", "error",
                "-y",
                "-i", "pipe:0",
                "-filter:a", filter_str,
                "-b:a", "128k",
                "-f", "mp3",
                "pipe:1",
            ]
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            out, err = proc.communicate(input=audio_bytes)
            if proc.returncode == 0 and len(out) > 500:
                return out
            else:
                logger.warning(
                    f"ffmpeg speed adjustment failed (code {proc.returncode}): {err.decode(errors='ignore')}"
                )
                return audio_bytes
        except Exception as e:
            logger.warning(f"Error applying audio speed with ffmpeg: {e}")
            return audio_bytes

    def synthesize(
        self,
        text: str,
        voice_id: Optional[str] = None,
        model_id: Optional[str] = None,
        stability: float = 0.5,
        similarity_boost: float = 0.75,
        style: float = 0.0,
        speed: float = 1.0,
        language_code: Optional[str] = None,
        output_format: str = "mp3_44100_128",
    ) -> Tuple[bytes, Dict[str, Any]]:
        """Synthesize text to MP3 audio bytes with auto-rotation across accounts."""
        text = text.strip()
        if not text:
            raise ValueError("Text cannot be empty")

        voice_id = voice_id or DEFAULT_VOICE_ID
        model_id = model_id or DEFAULT_MODEL_ID

        # Try up to N available accounts + retries
        attempts = 0
        max_attempts = max(2, len(self.session_manager.list_accounts()) * 2)
        retries_409 = 0
        retries_429 = 0
        retried_401 = False

        while attempts < max_attempts:
            account = self.session_manager.get_active_account()
            if not account:
                # Try auto-extracting from browser before giving up
                if not retried_401:
                    retried_401 = True
                    try:
                        from core.token_extractor import auto_extract_tokens
                        fresh = auto_extract_tokens(self.session_manager)
                        if fresh:
                            account = self.session_manager.get_active_account()
                    except Exception:
                        pass

                if not account:
                    raise RuntimeError(
                        "Không tìm thấy tài khoản hoặc session ElevenLabs nào khả dụng. "
                        "Vui lòng thêm Token / Cookie hoặc đăng nhập qua Browser trên Web UI."
                    )

            account_id = account["id"]
            headers = self.session_manager.build_headers(account)
            headers["Content-Type"] = "application/json"

            url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
            params = {"output_format": output_format}

            payload = {
                "text": text,
                "model_id": model_id,
                "voice_settings": {
                    "stability": max(0.0, min(1.0, float(stability))),
                    "similarity_boost": max(0.0, min(1.0, float(similarity_boost))),
                    "style": max(0.0, min(1.0, float(style))),
                    "use_speaker_boost": True,
                },
            }
            normalized_language = str(language_code or "").strip().lower()
            if normalized_language and normalized_language not in {"auto", "none"}:
                payload["language_code"] = normalized_language

            sem = self._get_semaphore(account_id)
            acquired = sem.acquire(timeout=25.0)

            try:
                logger.info(
                    f"Synthesizing {len(text)} chars with account [{account.get('name')}] ({account_id}), voice {voice_id}, speed {speed}x"
                )
                try:
                    resp = requests.post(url, headers=headers, params=params, json=payload, timeout=45)
                finally:
                    if acquired:
                        sem.release()

                if resp.status_code == 200:
                    audio_bytes = resp.content

                    # Apply speed adjustment if requested (preserves pitch)
                    if speed and abs(float(speed) - 1.0) >= 0.02:
                        audio_bytes = self.apply_audio_speed(audio_bytes, float(speed))

                    # Update local character estimate
                    char_cost = len(text)
                    account["character_count"] = account.get("character_count", 0) + char_cost
                    account["remaining_characters"] = max(0, account.get("remaining_characters", 10000) - char_cost)
                    self.session_manager._save()

                    meta = {
                        "account_id": account_id,
                        "account_name": account.get("name"),
                        "voice_id": voice_id,
                        "model_id": model_id,
                        "speed": float(speed) if speed else 1.0,
                        "characters_used": char_cost,
                        "remaining_characters": account["remaining_characters"],
                    }
                    return audio_bytes, meta

                logger.warning(
                    f"Account {account_id} failed with status {resp.status_code}: {resp.text[:200]}"
                )

                # 409 Conflict: voice busy / already_running
                if resp.status_code == 409 or "already_running" in resp.text:
                    if retries_409 < 4:
                        retries_409 += 1
                        logger.warning(
                            f"ElevenLabs voice busy / already_running (409). Backing off 0.7s (retry {retries_409}/4)..."
                        )
                        time.sleep(0.7)
                        continue

                # 429 Rate limit / concurrent limit handling (do NOT mark as quota exhausted!)
                if resp.status_code == 429:
                    if retries_429 < 4:
                        retries_429 += 1
                        wait_t = 0.8 if "concurrent_limit_exceeded" in resp.text else 1.2
                        logger.warning(
                            f"Account {account_id} reached rate limit (429). Waiting {wait_t}s (retry {retries_429}/4)..."
                        )
                        time.sleep(wait_t)
                        continue

                # 401 / 403 Unauthorized: Try auto-refreshing from browser before disabling account
                if resp.status_code in (401, 403):
                    if not retried_401:
                        retried_401 = True
                        logger.warning(
                            f"Account {account_id} received {resp.status_code} Unauthorized (token expired). Auto-extracting fresh token from browser..."
                        )
                        try:
                            from core.token_extractor import auto_extract_tokens
                            fresh_accounts = auto_extract_tokens(self.session_manager)
                            if fresh_accounts:
                                logger.info(
                                    f"Auto-extracted {len(fresh_accounts)} fresh account(s) from browser. Retrying immediately..."
                                )
                                continue
                        except Exception as ex:
                            logger.warning(f"Auto-extract on 401 failed: {ex}")

                    if "unusual_activity" in resp.text:
                        self.session_manager.mark_invalid_auth(account_id, "Unusual activity flag on API key. Use Web Session Token instead.")
                    else:
                        self.session_manager.mark_invalid_auth(account_id, resp.text[:150])

                # Check if genuine quota exceeded (HTTP 402 or explicit quota error)
                elif resp.status_code == 402 or "quota_exceeded" in resp.text or "character_limit_exceeded" in resp.text:
                    self.session_manager.mark_quota_exhausted(account_id, resp.text[:150])
                else:
                    # Generic error
                    attempts += 1
                    continue

            except Exception as e:
                logger.error(f"Error during synthesis with account {account_id}: {e}")
                attempts += 1
                continue

            attempts += 1

        raise RuntimeError(
            "Tất cả tài khoản trong pool đều đã hết credit hoặc gặp lỗi xác thực. "
            "Vui lòng kiểm tra lại trạng thái tài khoản trên Web UI."
        )
