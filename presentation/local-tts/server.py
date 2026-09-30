"""Small local Vietnamese dual-engine cloned-voice service for Quizzzzzzzz.

The service exposes only loopback HTTP and returns MP3 so the existing quiz
audio pipeline can cache and play it. The active engine is selected in Admin.
"""

from __future__ import annotations

import json
import hashlib
import hmac
import io
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import wave
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
try:
    import torch
except ImportError:  # pragma: no cover - optional engine check is operational
    torch = None
from vietvoicetts import ModelConfig, TTSApi

try:
    from omnivoice import OmniVoice, OmniVoiceGenerationConfig
except ImportError:  # pragma: no cover - optional engine check is operational
    OmniVoice = None
    OmniVoiceGenerationConfig = None


ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent.parent
SETTINGS_FILE = ROOT / "settings.json"
ADMIN_CREDENTIALS_FILE = PROJECT_ROOT / ".admin-credentials.json"
DEFAULT_REFERENCE_AUDIO = PROJECT_ROOT / "presentation" / "quiz" / "audio" / "welcome.mp3"
ELEVENLABS_VENDOR_ROOT = ROOT / "elevenlabs_proxy"
if ELEVENLABS_VENDOR_ROOT.is_dir() and str(ELEVENLABS_VENDOR_ROOT) not in sys.path:
    sys.path.insert(0, str(ELEVENLABS_VENDOR_ROOT))
ELEVENLABS_DATA_DIR = ROOT / "data"
ELEVENLABS_ACCOUNTS_FILE = ELEVENLABS_DATA_DIR / "accounts.json"
USAGE_AUDIT_FILE = ELEVENLABS_DATA_DIR / "elevenlabs-usage.jsonl"
ELEVENLABS_DATA_DIR.mkdir(parents=True, exist_ok=True)

try:
    from core.session_manager import SessionManager as ElevenLabsSessionManager
    from core.synthesizer import Synthesizer as ElevenLabsSynthesizer
    from core.token_extractor import auto_extract_tokens
    from core.browser_auth import BrowserAuthHelper as ElevenLabsBrowserAuth
    ELEVENLABS_IMPORT_ERROR = None
except Exception as error:  # pragma: no cover - optional local integration
    ElevenLabsSessionManager = None
    ElevenLabsSynthesizer = None
    auto_extract_tokens = None
    ElevenLabsBrowserAuth = None
    ELEVENLABS_IMPORT_ERROR = error

HOST = os.environ.get("QUIZ_TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("QUIZ_TTS_PORT", "8786"))
MAX_TEXT_LENGTH = 600
ADMIN_TOKEN = os.environ.get("QUIZ_TTS_ADMIN_TOKEN") or secrets.token_urlsafe(18)
VOICE_LOCK = threading.RLock()

DEFAULT_SETTINGS = {
    "engine": "vietvoice",
    "speed": 1.2,
    "nfe_step": 32,
    "max_chunk_duration": 15.0,
    "reference_audio": str(DEFAULT_REFERENCE_AUDIO),
    "reference_text": "Chào mừng bạn đến với Quiz!",
    "elevenlabs_voice_id": "6adFm46eyy74snVn6YrT",
    "elevenlabs_model_id": "eleven_v3",
    "elevenlabs_language_code": "vi",
    "elevenlabs_stability": 0.5,
    "elevenlabs_similarity_boost": 0.75,
    "dynamic_voice_enabled": True,
}

DEFAULT_AUDIO_VOLUME = {
    "master": 100,
    "music": 16,
    "welcome": 80,
    "roomReady": 80,
    "finalResults": 80,
    "dynamicVoice": 80,
    "correct": 45,
    "incorrect": 45,
    "timeout": 45,
}


def _resolve_reference_audio(value: object) -> Path:
    raw = str(value or DEFAULT_SETTINGS["reference_audio"]).strip()
    path = Path(raw)
    if not path.is_absolute():
        path = (PROJECT_ROOT / path).resolve()
    return path


def normalize_audio_volume(values: object) -> dict:
    source = values if isinstance(values, dict) else {}
    normalized = {}
    for key, default in DEFAULT_AUDIO_VOLUME.items():
        try:
            value = float(source.get(key, default))
        except (TypeError, ValueError):
            value = default
        normalized[key] = int(round(max(0.0, min(100.0, value))))
    return normalized


def _normalize_language_code(value: object) -> str:
    code = str(value or DEFAULT_SETTINGS["elevenlabs_language_code"]).strip().lower()
    if code in {"", "auto", "none"}:
        return "auto"
    return code if re.fullmatch(r"[a-z]{2,3}", code) else DEFAULT_SETTINGS["elevenlabs_language_code"]


def _normalize_bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def normalize_settings(values: dict) -> dict:
    engine = str(values.get("engine", DEFAULT_SETTINGS["engine"])).strip().lower()
    if engine not in {"vietvoice", "omnivoice", "elevenlabs"}:
        engine = DEFAULT_SETTINGS["engine"]
    nfe_step = int(max(8, min(64, int(values.get("nfe_step", DEFAULT_SETTINGS["nfe_step"])))))
    # VietVoice becomes unstable/noisy with the very low NFE values that are
    # useful for OmniVoice. Keep a safe floor when the engine is switched.
    if engine == "vietvoice":
        nfe_step = max(32, nfe_step)
    return {
        "engine": engine,
        "speed": max(0.8, min(1.5, float(values.get("speed", DEFAULT_SETTINGS["speed"]))),),
        "nfe_step": nfe_step,
        "max_chunk_duration": max(5.0, min(30.0, float(values.get("max_chunk_duration", DEFAULT_SETTINGS["max_chunk_duration"]))),),
        "reference_audio": str(_resolve_reference_audio(values.get("reference_audio"))),
        "reference_text": str(values.get("reference_text", DEFAULT_SETTINGS["reference_text"])).strip()[:500],
        "elevenlabs_voice_id": str(values.get("elevenlabs_voice_id", DEFAULT_SETTINGS["elevenlabs_voice_id"])).strip()[:128],
        "elevenlabs_model_id": str(values.get("elevenlabs_model_id", DEFAULT_SETTINGS["elevenlabs_model_id"])).strip()[:96],
        "elevenlabs_language_code": _normalize_language_code(values.get("elevenlabs_language_code", DEFAULT_SETTINGS["elevenlabs_language_code"])),
        "elevenlabs_stability": max(0.0, min(1.0, float(values.get("elevenlabs_stability", DEFAULT_SETTINGS["elevenlabs_stability"])))),
        "elevenlabs_similarity_boost": max(0.0, min(1.0, float(values.get("elevenlabs_similarity_boost", DEFAULT_SETTINGS["elevenlabs_similarity_boost"])))),
        "dynamic_voice_enabled": _normalize_bool(values.get("dynamic_voice_enabled"), DEFAULT_SETTINGS["dynamic_voice_enabled"]),
        "audio_volume": normalize_audio_volume(values.get("audio_volume")),
    }


def read_settings() -> dict:
    values = dict(DEFAULT_SETTINGS)
    if SETTINGS_FILE.is_file():
        try:
            stored = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            if isinstance(stored, dict):
                values.update(stored)
        except (OSError, json.JSONDecodeError):
            print("[local-tts] settings.json không hợp lệ, dùng cấu hình mặc định", flush=True)
    values["reference_audio"] = os.environ.get("QUIZ_TTS_REFERENCE_AUDIO", values["reference_audio"])
    values["reference_text"] = os.environ.get("QUIZ_TTS_REFERENCE_TEXT", values["reference_text"])
    return normalize_settings(values)


def read_admin_credentials() -> dict:
    values = {
        "username": os.environ.get("QUIZ_ADMIN_USER", "admin").strip() or "admin",
        "password": os.environ.get("QUIZ_ADMIN_PASSWORD", "admin"),
        "must_change": os.environ.get("QUIZ_ADMIN_MUST_CHANGE", "true").strip().lower() in {"1", "true", "yes"},
    }
    if ADMIN_CREDENTIALS_FILE.is_file():
        try:
            stored = json.loads(ADMIN_CREDENTIALS_FILE.read_text(encoding="utf-8"))
            if isinstance(stored, dict):
                values["username"] = str(stored.get("username") or values["username"]).strip()
                values["password"] = str(stored.get("password") or values["password"])
                values["must_change"] = bool(stored.get("must_change", values["must_change"]))
        except (OSError, json.JSONDecodeError):
            print("[local-tts] Không đọc được .admin-credentials.json, dùng cấu hình môi trường", flush=True)
    return values


def save_admin_credentials(values: dict) -> None:
    payload = {
        "username": str(values["username"]).strip(),
        "password": str(values["password"]),
        "must_change": bool(values.get("must_change", False)),
    }
    temporary = ADMIN_CREDENTIALS_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(ADMIN_CREDENTIALS_FILE)


def admin_login(username: str, password: str) -> dict:
    credentials = read_admin_credentials()
    if not hmac.compare_digest(str(username), credentials["username"]) or not hmac.compare_digest(str(password), credentials["password"]):
        return {"ok": False, "error": "invalid_credentials", "message": "Sai tên đăng nhập hoặc mật khẩu."}
    return {"ok": True, "username": credentials["username"], "must_change": credentials["must_change"]}


def admin_change_password(username: str, new_password: str) -> dict:
    credentials = read_admin_credentials()
    if str(username) != credentials["username"]:
        return {"ok": False, "error": "invalid_credentials", "message": "Tài khoản quản trị không hợp lệ."}
    if not str(new_password).strip():
        return {"ok": False, "error": "invalid_password", "message": "Mật khẩu mới không được để trống."}
    credentials["password"] = str(new_password)
    credentials["must_change"] = False
    save_admin_credentials(credentials)
    return {"ok": True, "username": credentials["username"], "must_change": False}


def public_settings(values: dict) -> dict:
    return {
        **values,
        "model_label": {
            "omnivoice": "OmniVoice Vietnamese",
            "elevenlabs": "ElevenLabs Web API",
        }.get(values["engine"], "VietVoice-TTS"),
        "language": "vi-VN",
        "cloned": True,
        "reference_exists": Path(values["reference_audio"]).is_file() if values["engine"] != "elevenlabs" else True,
        "elevenlabs_url": "Tích hợp trong Quiz",
        "admin_token_required": True,
        "audio_volume": dict(values.get("audio_volume", DEFAULT_AUDIO_VOLUME)),
    }


def _public_elevenlabs_account(account: dict) -> dict:
    return {
        "id": account.get("id"),
        "name": account.get("name"),
        "status": account.get("status"),
        "remaining_characters": account.get("remaining_characters", 0),
        "character_limit": account.get("character_limit", 0),
        "error_message": account.get("error_message", ""),
    }


def _public_elevenlabs_payload(payload: dict) -> dict:
    accounts = payload.get("accounts", []) if isinstance(payload, dict) else []
    stats = payload.get("stats", {}) if isinstance(payload, dict) else {}
    return {
        "ok": True,
        "active_accounts": int(stats.get("active_accounts", 0) or 0),
        "total_remaining_characters": int(stats.get("total_remaining_characters", 0) or 0),
        "total_character_limit": int(stats.get("total_character_limit", 0) or 0),
        "accounts": [
            _public_elevenlabs_account(account)
            for account in accounts if isinstance(account, dict)
        ],
        "dashboard_url": "/admin",
    }


ELEVENLABS_SESSIONS = None
ELEVENLABS_SYNTHESIZER = None
ELEVENLABS_BROWSER_AUTH = None
if ElevenLabsSessionManager is not None and ElevenLabsSynthesizer is not None:
    try:
        legacy_root = os.environ.get("QUIZ_ELEVENLABS_LEGACY_ROOT", "").strip()
        legacy_accounts = Path(legacy_root) / "data" / "accounts.json" if legacy_root else None
        if not ELEVENLABS_ACCOUNTS_FILE.is_file() and legacy_accounts and legacy_accounts.is_file():
            shutil.copy2(legacy_accounts, ELEVENLABS_ACCOUNTS_FILE)
        ELEVENLABS_SESSIONS = ElevenLabsSessionManager(storage_path=ELEVENLABS_ACCOUNTS_FILE)
        ELEVENLABS_SYNTHESIZER = ElevenLabsSynthesizer(ELEVENLABS_SESSIONS)
        if ElevenLabsBrowserAuth is not None:
            ELEVENLABS_BROWSER_AUTH = ElevenLabsBrowserAuth(ELEVENLABS_SESSIONS)
    except Exception as error:  # pragma: no cover - operational guard
        ELEVENLABS_IMPORT_ERROR = error


def _elevenlabs_unavailable(message: str = "ElevenLabs chưa được tích hợp trên service Quiz.") -> dict:
    return {
        "ok": False,
        "error": "elevenlabs_unavailable",
        "message": message,
        "detail": str(ELEVENLABS_IMPORT_ERROR or "unknown_error"),
        "accounts": [],
        "active_accounts": 0,
        "total_accounts": 0,
        "total_remaining_characters": 0,
        "total_character_limit": 0,
    }


def _public_elevenlabs_accounts() -> dict:
    if ELEVENLABS_SESSIONS is None:
        return _elevenlabs_unavailable()
    accounts = ELEVENLABS_SESSIONS.list_accounts()
    stats = ELEVENLABS_SESSIONS.get_total_balance()
    return {
        **_public_elevenlabs_payload({"accounts": accounts, "stats": stats}),
        "total_accounts": int(stats.get("total_accounts", len(accounts)) or 0),
    }


def elevenlabs_status() -> dict:
    return _public_elevenlabs_accounts()


def elevenlabs_options() -> dict:
    if ELEVENLABS_SYNTHESIZER is None:
        return _elevenlabs_unavailable("Không thể đọc danh sách voice/model ElevenLabs.")
    try:
        voices = ELEVENLABS_SYNTHESIZER.get_voices()
        models = ELEVENLABS_SYNTHESIZER.get_models()
        configured_voice_id = str(SETTINGS.get("elevenlabs_voice_id", "")).strip()
        if configured_voice_id and not any(str(item.get("voice_id", "")) == configured_voice_id for item in voices):
            voices = [{"voice_id": configured_voice_id, "name": "Giọng đang dùng", "category": "configured"}, *voices]
        return {
            "ok": True,
            "current_voice_id": configured_voice_id,
            "current_model_id": str(SETTINGS.get("elevenlabs_model_id", "")).strip(),
            "voices": [
                {"voice_id": str(item.get("voice_id", "")), "name": str(item.get("name", ""))}
                for item in voices if isinstance(item, dict) and item.get("voice_id")
            ],
            "models": [
                {"model_id": str(item.get("model_id", "")), "name": str(item.get("name", ""))}
                for item in models if isinstance(item, dict) and item.get("model_id")
            ],
        }
    except Exception as error:  # pragma: no cover - operational guard
        return {"ok": False, "error": "elevenlabs_options_failed", "message": str(error), "voices": [], "models": []}


def elevenlabs_scan() -> dict:
    if ELEVENLABS_SESSIONS is None or auto_extract_tokens is None:
        return _elevenlabs_unavailable("Không thể nạp bộ quét session ElevenLabs vào service Quiz.")
    try:
        found = auto_extract_tokens(ELEVENLABS_SESSIONS)
        return {**_public_elevenlabs_accounts(), "scanned_accounts": len(found)}
    except Exception as error:  # pragma: no cover - operational guard
        return {
            **_elevenlabs_unavailable("Không quét được session ElevenLabs từ Chrome/Edge."),
            "error": "elevenlabs_scan_failed",
            "detail": str(error),
            "scanned_accounts": 0,
        }


def elevenlabs_login_start() -> dict:
    if ELEVENLABS_BROWSER_AUTH is None:
        return _elevenlabs_unavailable("Không thể mở phiên đăng nhập ElevenLabs trên service Quiz.")
    try:
        return ELEVENLABS_BROWSER_AUTH.start_login_flow()
    except Exception as error:  # pragma: no cover - operational guard
        return {"ok": False, "error": "elevenlabs_login_failed", "message": str(error)}


def elevenlabs_login_status() -> dict:
    if ELEVENLABS_BROWSER_AUTH is None:
        return {"ok": False, "state": "unavailable", "message": "Luồng đăng nhập ElevenLabs chưa sẵn sàng."}
    account = getattr(ELEVENLABS_BROWSER_AUTH, "_captured_data", None)
    return {
        "ok": True,
        "state": str(getattr(ELEVENLABS_BROWSER_AUTH, "status", "idle")),
        "running": bool(getattr(ELEVENLABS_BROWSER_AUTH, "_is_running", False)),
        "message": str(getattr(ELEVENLABS_BROWSER_AUTH, "error_message", "") or ""),
        "account": _public_elevenlabs_account(account) if isinstance(account, dict) else None,
    }


def elevenlabs_delete(account_id: str) -> dict:
    if ELEVENLABS_SESSIONS is None:
        return _elevenlabs_unavailable()
    deleted = ELEVENLABS_SESSIONS.remove_account(str(account_id or "").strip())
    if not deleted:
        return {"ok": False, "error": "account_not_found", "message": "Không tìm thấy tài khoản ElevenLabs."}
    return {"ok": True, **_public_elevenlabs_accounts()}


def build_tts(values: dict) -> TTSApi:
    return TTSApi(ModelConfig(
        speed=values["speed"],
        nfe_step=values["nfe_step"],
        max_chunk_duration=values["max_chunk_duration"],
    ))


SETTINGS = read_settings()
REFERENCE_AUDIO = Path(SETTINGS["reference_audio"])
if not REFERENCE_AUDIO.is_file():
    raise SystemExit(f"Missing voice reference audio: {REFERENCE_AUDIO}")

TTS = build_tts(SETTINGS)
OMNIVOICE_MODEL = None
OMNIVOICE_PROMPT = None
OMNIVOICE_PROMPT_KEY = None


def release_omnivoice() -> None:
    global OMNIVOICE_MODEL, OMNIVOICE_PROMPT, OMNIVOICE_PROMPT_KEY
    OMNIVOICE_MODEL = None
    OMNIVOICE_PROMPT = None
    OMNIVOICE_PROMPT_KEY = None
    if torch is not None and torch.cuda.is_available():
        torch.cuda.empty_cache()


def get_omnivoice():
    global OMNIVOICE_MODEL
    if OMNIVOICE_MODEL is not None:
        return OMNIVOICE_MODEL
    if OmniVoice is None or OmniVoiceGenerationConfig is None or torch is None:
        raise RuntimeError("omnivoice_not_installed")
    has_cuda = torch.cuda.is_available()
    OMNIVOICE_MODEL = OmniVoice.from_pretrained(
        "splendor1811/omnivoice-vietnamese",
        device_map="cuda:0" if has_cuda else "cpu",
        dtype=torch.float16 if has_cuda else torch.float32,
    )
    return OMNIVOICE_MODEL


def synthesize_omnivoice(text: str, settings: dict) -> bytes:
    global OMNIVOICE_PROMPT, OMNIVOICE_PROMPT_KEY
    model = get_omnivoice()
    prompt_key = (settings["reference_audio"], settings["reference_text"])
    if OMNIVOICE_PROMPT is None or OMNIVOICE_PROMPT_KEY != prompt_key:
        OMNIVOICE_PROMPT = model.create_voice_clone_prompt(
            ref_audio=settings["reference_audio"],
            ref_text=settings["reference_text"],
        )
        OMNIVOICE_PROMPT_KEY = prompt_key
    config = OmniVoiceGenerationConfig(
        num_step=settings["nfe_step"],
        guidance_scale=2.0,
        audio_chunk_duration=settings["max_chunk_duration"],
        audio_chunk_threshold=max(settings["max_chunk_duration"] * 2, 30.0),
    )
    # OmniVoice interprets an exclamation mark as a dramatic prosody break.
    # Quiz announcements should stay continuous, so use a short neutral stop.
    voice_text = text.replace("!", ".").replace("！", ".")
    output = model.generate(
        text=voice_text,
        language="vietnamese",
        voice_clone_prompt=OMNIVOICE_PROMPT,
        speed=settings["speed"],
        generation_config=config,
    )
    samples = np.asarray(output[0], dtype=np.float32).reshape(-1)
    samples = compress_internal_silences(samples, 24000)
    samples = np.clip(samples, -1.0, 1.0)
    pcm = (samples * 32767).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(pcm.tobytes())
    return buffer.getvalue()


def compress_internal_silences(samples: np.ndarray, sample_rate: int, max_pause: float = 0.10) -> np.ndarray:
    """Keep short natural pauses while removing model-generated dramatic gaps."""
    frame_size = max(1, int(sample_rate * 0.01))
    frame_count = len(samples) // frame_size
    if frame_count < 3:
        return samples
    frames = samples[:frame_count * frame_size].reshape(frame_count, frame_size)
    peaks = np.max(np.abs(frames), axis=1)
    threshold = max(0.008, float(peaks.max()) * 0.02)
    active = peaks > threshold
    target_samples = max(1, int(sample_rate * max_pause))
    minimum_gap = target_samples + int(sample_rate * 0.02)
    pieces = []
    last_sample = 0
    frame = 0
    while frame < frame_count:
        if active[frame]:
            frame += 1
            continue
        start_frame = frame
        while frame < frame_count and not active[frame]:
            frame += 1
        end_frame = frame
        start_sample = start_frame * frame_size
        end_sample = min(len(samples), end_frame * frame_size)
        is_internal = start_frame > 0 and frame < frame_count
        if is_internal and end_sample - start_sample > minimum_gap:
            pieces.append(samples[last_sample:start_sample])
            midpoint = (start_sample + end_sample) // 2
            half = target_samples // 2
            pieces.append(samples[midpoint - half:midpoint - half + target_samples])
            last_sample = end_sample
    pieces.append(samples[last_sample:])
    result = np.concatenate(pieces) if len(pieces) > 1 else samples

    # OmniVoice adds a small fade/pad at the edges. Keep only a tiny lead-in
    # so the announcement starts directly on the first syllable.
    result_frame_count = len(result) // frame_size
    if result_frame_count < 3:
        return result
    result_frames = result[:result_frame_count * frame_size].reshape(result_frame_count, frame_size)
    result_peaks = np.max(np.abs(result_frames), axis=1)
    result_active = result_peaks > threshold
    active_frames = np.flatnonzero(result_active)
    if not len(active_frames):
        return result
    lead_keep = int(sample_rate * 0.02)
    trail_keep = int(sample_rate * 0.08)
    start = max(0, active_frames[0] * frame_size - lead_keep)
    end = min(len(result), (active_frames[-1] + 1) * frame_size + trail_keep)
    result = result[start:end]
    lead_skip = min(len(result), int(sample_rate * 0.07))
    result = result[lead_skip:]
    fade_samples = min(len(result), int(sample_rate * 0.015))
    if fade_samples:
        result[:fade_samples] *= np.linspace(0.0, 1.0, fade_samples, dtype=np.float32)
    return result


def split_announcement_text(text: str, max_chars: int = 110) -> list[str]:
    """Split long leaderboard announcements at player separators.

    Both local models can lose names or stop early when ten names and scores
    are sent as one long generation. Keeping each chunk below the model's
    comfortable context size preserves the exact leaderboard data while
    allowing the audio pipeline to stitch the pieces back together.
    """
    value = str(text or "").strip()
    if value.count(";") < 3 or len(value) <= max_chars:
        return [value]
    parts = [part.strip() for part in re.split(r";\s*", value) if part.strip()]
    chunks: list[str] = []
    current = parts[0]
    for part in parts[1:]:
        candidate = f"{current}; {part}"
        if len(current) > 0 and len(candidate) > max_chars:
            chunks.append(current)
            current = part
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks or [value]


def concatenate_wavs(wav_chunks: list[bytes], pause_ms: int = 90) -> bytes:
    if not wav_chunks:
        raise ValueError("no_audio_chunks")
    first = wave.open(io.BytesIO(wav_chunks[0]), "rb")
    try:
        channels = first.getnchannels()
        sample_width = first.getsampwidth()
        sample_rate = first.getframerate()
        frames = [first.readframes(first.getnframes())]
    finally:
        first.close()
    silence = b"\x00" * int(sample_rate * pause_ms / 1000) * channels * sample_width
    for chunk in wav_chunks[1:]:
        current = wave.open(io.BytesIO(chunk), "rb")
        try:
            if (current.getnchannels(), current.getsampwidth(), current.getframerate()) != (channels, sample_width, sample_rate):
                raise ValueError("incompatible_audio_chunks")
            frames.extend((silence, current.readframes(current.getnframes())))
        finally:
            current.close()
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(sample_width)
        wav.setframerate(sample_rate)
        wav.writeframes(b"".join(frames))
    return output.getvalue()


def synthesize_single_wav(text: str, settings: dict) -> bytes:
    if settings["engine"] == "omnivoice":
        return synthesize_omnivoice(text, settings)
    wav_bytes, _ = TTS.synthesize_to_bytes(
        text,
        reference_audio=settings["reference_audio"],
        reference_text=settings["reference_text"],
    )
    return wav_bytes


def synthesize_wav(text: str) -> bytes:
    with VOICE_LOCK:
        settings = dict(SETTINGS)
        chunks = split_announcement_text(text)
        wav_chunks = [synthesize_single_wav(chunk, settings) for chunk in chunks]
        return wav_chunks[0] if len(wav_chunks) == 1 else concatenate_wavs(wav_chunks)


def _record_elevenlabs_usage(text: str, settings: dict, meta: dict, source: str) -> None:
    event = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "characters": len(text),
        "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "text_preview": text[:120],
        "voice_id": meta.get("voice_id") or settings.get("elevenlabs_voice_id"),
        "model_id": meta.get("model_id") or settings.get("elevenlabs_model_id"),
        "language_code": settings.get("elevenlabs_language_code", "auto"),
        "account_name": meta.get("account_name"),
        "account_id": meta.get("account_id"),
        "remaining_characters": meta.get("remaining_characters"),
    }
    try:
        with USAGE_AUDIT_FILE.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")
    except OSError as error:  # pragma: no cover - audit must never break audio
        print(f"[local-tts] Không ghi được nhật ký credit: {error}", flush=True)


def _read_elevenlabs_usage(limit: int = 50) -> list[dict]:
    if not USAGE_AUDIT_FILE.is_file():
        return []
    try:
        rows = []
        for line in USAGE_AUDIT_FILE.read_text(encoding="utf-8").splitlines()[-max(1, min(200, int(limit))) :]:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                rows.append(value)
        return rows
    except (OSError, ValueError):
        return []


def synthesize_elevenlabs_mp3(text: str, settings: dict, source: str = "unknown") -> bytes:
    if ELEVENLABS_SYNTHESIZER is None:
        raise RuntimeError("elevenlabs_integrated_service_unavailable")
    audio, meta = ELEVENLABS_SYNTHESIZER.synthesize(
        text=text,
        voice_id=settings["elevenlabs_voice_id"] or None,
        model_id=settings["elevenlabs_model_id"],
        speed=settings["speed"],
        stability=settings["elevenlabs_stability"],
        similarity_boost=settings["elevenlabs_similarity_boost"],
        language_code=settings.get("elevenlabs_language_code"),
    )
    if not audio:
        raise RuntimeError("elevenlabs_empty_audio")
    print(
        f"[local-tts] ElevenLabs integrated synthesis via {meta.get('account_name', meta.get('account_id', 'account'))} "
        f"({meta.get('remaining_characters', '?')} chars left; source={source}; chars={len(text)})",
        flush=True,
    )
    _record_elevenlabs_usage(text, settings, meta, source)
    return audio


def synthesize_mp3(text: str, preview_settings: dict | None = None, source: str = "unknown") -> bytes:
    with VOICE_LOCK:
        settings = normalize_settings({**SETTINGS, **(preview_settings or {})})
    if settings["engine"] == "elevenlabs":
        return synthesize_elevenlabs_mp3(text, settings, source)
    wav_bytes = synthesize_wav(text)

    result = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "wav",
            "-i",
            "pipe:0",
            "-af",
            "volume=-3dB",
            "-codec:a",
            "libmp3lame",
            "-ar",
            "44100",
            "-q:a",
            "2",
            "-f",
            "mp3",
            "pipe:1",
        ],
        input=wav_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return result.stdout


class Handler(BaseHTTPRequestHandler):
    server_version = "QuizLocalTTS/1.0"

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if self.headers.get("X-Quiz-Local-Admin") == "1":
            return True
        supplied = self.headers.get("X-Admin-Token", "")
        return bool(supplied) and hmac.compare_digest(supplied, ADMIN_TOKEN)

    def _read_json(self, max_length: int = 16_384) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > max_length:
            raise ValueError("invalid_body")
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(body, dict):
            raise ValueError("invalid_json")
        return body

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            self._json({"ok": True, **public_settings(SETTINGS)})
            return
        if path == "/audio-settings":
            with VOICE_LOCK:
                self._json({"ok": True, "audio_volume": dict(SETTINGS.get("audio_volume", DEFAULT_AUDIO_VOLUME))})
            return
        if path == "/elevenlabs-status":
            if not self._authorized():
                self._json({"ok": False, "error": "unauthorized"}, 401)
                return
            self._json(elevenlabs_status())
            return
        if path == "/elevenlabs-options":
            if not self._authorized():
                self._json({"ok": False, "error": "unauthorized"}, 401)
                return
            self._json(elevenlabs_options())
            return
        if path == "/elevenlabs-usage":
            if not self._authorized():
                self._json({"ok": False, "error": "unauthorized"}, 401)
                return
            self._json({"ok": True, "entries": _read_elevenlabs_usage()})
            return
        if path == "/elevenlabs-accounts":
            if not self._authorized():
                self._json({"ok": False, "error": "unauthorized"}, 401)
                return
            self._json(elevenlabs_status())
            return
        if path == "/elevenlabs-login-status":
            if not self._authorized():
                self._json({"ok": False, "error": "unauthorized"}, 401)
                return
            self._json(elevenlabs_login_status())
            return
        if path == "/settings":
            if not self._authorized():
                self._json({"ok": False, "error": "unauthorized"}, 401)
                return
            with VOICE_LOCK:
                self._json({"ok": True, "settings": public_settings(SETTINGS)})
            return
        self._json({"ok": False, "error": "not_found"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in {"/admin-login", "/admin-change-password"}:
            if not self._authorized():
                self._json({"ok": False, "error": "unauthorized"}, 401)
                return
            try:
                body = self._read_json(4_096)
                if path == "/admin-login":
                    result = admin_login(str(body.get("username", "")), str(body.get("password", "")))
                else:
                    result = admin_change_password(str(body.get("username", "")), str(body.get("newPassword", "")))
                self._json(result, 200 if result.get("ok") else 401)
            except (json.JSONDecodeError, ValueError):
                self._json({"ok": False, "error": "invalid_json"}, 400)
            except OSError as error:
                print(f"[local-tts] Admin credential write failed: {error}", flush=True)
                self._json({"ok": False, "error": "credentials_write_failed"}, 500)
            return
        if path == "/elevenlabs-scan":
            if not self._authorized():
                self._json({"ok": False, "error": "unauthorized"}, 401)
                return
            self._json(elevenlabs_scan())
            return
        if path == "/elevenlabs-login":
            if not self._authorized():
                self._json({"ok": False, "error": "unauthorized"}, 401)
                return
            self._json(elevenlabs_login_start(), 200)
            return
        if path == "/preview":
            if not self._authorized():
                self._json({"ok": False, "error": "unauthorized"}, 401)
                return
            try:
                body = self._read_json()
                text = str(body.get("text", "")).strip()
                if not text or len(text) > MAX_TEXT_LENGTH:
                    self._json({"ok": False, "error": "invalid_text"}, 400)
                    return
                preview_keys = {
                    "engine", "speed", "nfe_step", "max_chunk_duration", "reference_audio", "reference_text",
                    "elevenlabs_voice_id", "elevenlabs_model_id", "elevenlabs_language_code",
                    "elevenlabs_stability", "elevenlabs_similarity_boost",
                }
                preview_settings = {key: body[key] for key in preview_keys if key in body}
                audio = synthesize_mp3(text, preview_settings, source="admin_preview")
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                self.wfile.write(audio)
            except (json.JSONDecodeError, ValueError):
                self._json({"ok": False, "error": "invalid_json"}, 400)
            except Exception as error:  # pragma: no cover - operational guard
                print(f"[local-tts] {type(error).__name__}: {error}", flush=True)
                self._json({"ok": False, "error": "synthesis_failed"}, 500)
            return

        if path != "/tts":
            self._json({"ok": False, "error": "not_found"}, 404)
            return

        try:
            with VOICE_LOCK:
                if not SETTINGS.get("dynamic_voice_enabled", False):
                    self._json({"ok": False, "error": "dynamic_voice_disabled"}, 409)
                    return
            body = self._read_json()
            text = str(body.get("text", "")).strip()
            if not text or len(text) > MAX_TEXT_LENGTH:
                self._json({"ok": False, "error": "invalid_text"}, 400)
                return
            audio = synthesize_mp3(text, source="dynamic_quiz")
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
        except (json.JSONDecodeError, ValueError):
            self._json({"ok": False, "error": "invalid_json"}, 400)
        except Exception as error:  # pragma: no cover - operational guard
            print(f"[local-tts] {type(error).__name__}: {error}", flush=True)
            self._json({"ok": False, "error": "synthesis_failed"}, 500)

    def do_DELETE(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/elevenlabs-account":
            self._json({"ok": False, "error": "not_found"}, 404)
            return
        if not self._authorized():
            self._json({"ok": False, "error": "unauthorized"}, 401)
            return
        try:
            body = self._read_json(4_096)
            result = elevenlabs_delete(str(body.get("accountId", "")))
            self._json(result, 200 if result.get("ok") else 404)
        except (json.JSONDecodeError, ValueError):
            self._json({"ok": False, "error": "invalid_json"}, 400)

    def do_PUT(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/settings":
            self._json({"ok": False, "error": "not_found"}, 404)
            return
        if not self._authorized():
            self._json({"ok": False, "error": "unauthorized"}, 401)
            return
        global SETTINGS, TTS
        try:
            patch = self._read_json()
            with VOICE_LOCK:
                candidate = normalize_settings({**SETTINGS, **patch})
                reference_audio = Path(candidate["reference_audio"])
                if candidate["engine"] != "elevenlabs" and not reference_audio.is_file():
                    self._json({"ok": False, "error": "reference_audio_not_found"}, 400)
                    return
                next_tts = build_tts(candidate)
                previous_tts = TTS
                previous_engine = SETTINGS["engine"]
                SETTINGS = candidate
                TTS = next_tts
                SETTINGS_FILE.write_text(json.dumps(SETTINGS, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                if candidate["engine"] != "omnivoice" or candidate["engine"] != previous_engine:
                    release_omnivoice()
                try:
                    previous_tts.cleanup()
                except Exception:
                    pass
                self._json({"ok": True, "settings": public_settings(SETTINGS)})
        except (json.JSONDecodeError, ValueError, TypeError):
            self._json({"ok": False, "error": "invalid_settings"}, 400)
        except Exception as error:  # pragma: no cover - operational guard
            print(f"[local-tts] {type(error).__name__}: {error}", flush=True)
            self._json({"ok": False, "error": "settings_failed"}, 500)

    def log_message(self, format: str, *args: object) -> None:
        print(f"[local-tts] {self.address_string()} - {format % args}", flush=True)


if __name__ == "__main__":
    print(f"[local-tts] Dual-engine clone service ready on http://{HOST}:{PORT}", flush=True)
    print("[local-tts] Admin access is managed automatically by the launcher", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
