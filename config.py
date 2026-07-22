"""Environment-driven configuration for the EVL ASR proxy."""

import logging
import os
from pathlib import Path

# DEBUG=true surfaces the per-frame / per-event tracing used during bring-up.
# Off by default so multi-hour sessions stay quiet.
DEBUG = os.getenv("DEBUG", "false").lower() == "true"
logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("asr-proxy")

# ---------------------------------------------------------------------------
# Configuration (override with environment variables)
# ---------------------------------------------------------------------------
NIM_SCHEME = os.getenv("NIM_SCHEME", "ws")          # ws or wss
NIM_HOST = os.getenv("NIM_HOST", "localhost")
NIM_PORT = int(os.getenv("NIM_PORT", "9000"))
NIM_PATH = os.getenv("NIM_PATH", "/v1/realtime")
NIM_INTENT = os.getenv("NIM_INTENT", "transcription")
NIM_API_KEY = os.getenv("NIM_API_KEY", "")          # optional bearer token

ASR_MODEL = os.getenv("ASR_MODEL", "")              # empty = NIM default
ASR_LANGUAGE = os.getenv("ASR_LANGUAGE", "en-US")
SAMPLE_RATE = int(os.getenv("SAMPLE_RATE", "16000"))
AUTO_PUNCT = os.getenv("AUTO_PUNCT", "true").lower() == "true"

# Speaker diarization (the sortformer model supports it). When on we also turn
# on word time offsets, since per-word speaker tags ride along with them.
DIARIZATION = os.getenv("ASR_DIARIZATION", "false").lower() == "true"
MAX_SPEAKERS = int(os.getenv("ASR_MAX_SPEAKERS", "8"))

# Server-side endpointing (VAD). The NIM ships these at 0 (disabled), which
# means it never auto-finalizes. Enabling it makes the NIM segment on natural
# speech pauses instead of on our fixed-interval commits. Defaults below are
# NVIDIA's documented streaming-ASR defaults (start/stop windows in ms,
# thresholds are the fraction of frames that must be speech/silence).
ENDPOINTING = os.getenv("ASR_ENDPOINTING", "true").lower() == "true"
EOU_START_HISTORY = int(os.getenv("EOU_START_HISTORY", "300"))       # ms window to detect speech start
EOU_START_THRESHOLD = float(os.getenv("EOU_START_THRESHOLD", "0.2"))  # >=20% non-blank -> speech
EOU_STOP_HISTORY = int(os.getenv("EOU_STOP_HISTORY", "800"))         # ms of silence -> segment
EOU_STOP_THRESHOLD = float(os.getenv("EOU_STOP_THRESHOLD", "0.98"))   # >=98% blank -> stop
EOU_STOP_HISTORY_EOU = int(os.getenv("EOU_STOP_HISTORY_EOU", "800")) # ms of silence -> final result
EOU_STOP_THRESHOLD_EOU = float(os.getenv("EOU_STOP_THRESHOLD_EOU", "0.98"))

# How many audio frames to buffer while the NIM is momentarily reconnecting.
# Older frames are dropped first so we never accumulate stale audio latency.
AUDIO_QUEUE_MAX = int(os.getenv("AUDIO_QUEUE_MAX", "100"))

# Debug: if set to a directory, write each connection's forwarded PCM to a WAV
# there (capped) so you can verify exactly what audio reached the NIM.
DEBUG_AUDIO_DIR = os.getenv("DEBUG_AUDIO_DIR", "")
DEBUG_AUDIO_MAX_BYTES = SAMPLE_RATE * 2 * 600  # ~10 min cap

# Fallback for when endpointing is OFF: with server VAD disabled the NIM only
# transcribes committed audio, so we periodically commit to force results and
# keep the session alive. Ignored when ENDPOINTING is on (the NIM segments
# itself). Set to 0 to disable.
COMMIT_INTERVAL = float(os.getenv("COMMIT_INTERVAL_SEC", "2.0"))

# Cap on simultaneous browser sessions. Each session holds a dedicated
# realtime stream on the NIM, so this protects the GPU from being oversubscribed.
# Set to 0 to disable the limit.
MAX_SESSIONS = int(os.getenv("MAX_SESSIONS", "20"))

# Base URL path to serve the whole app under, for deploying behind a reverse
# proxy at a sub-path (e.g. BASE_PATH="/asr" -> the page, static files, /ws,
# /config, /llm and /admin all live under /asr). Empty = serve at the root.
# The proxy must forward the path unchanged (do not strip the prefix).
BASE_PATH = "/" + os.getenv("BASE_PATH", "").strip().strip("/")
if BASE_PATH == "/":
    BASE_PATH = ""

# ---------------------------------------------------------------------------
# Optional LLM post-processing (OpenAI-compatible chat completions endpoint,
# e.g. vLLM / Open WebUI / OpenAI). Leave LLM_BASE_URL empty to disable; the
# UI hides the button when disabled. The API key and prompt stay server-side.
# ---------------------------------------------------------------------------
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "").rstrip("/")  # e.g. http://host:8000/v1
LLM_MODEL = os.getenv("LLM_MODEL", "")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_SYSTEM_PROMPT = os.getenv("LLM_SYSTEM_PROMPT", "") or (
    "You are given the transcript of a meeting, possibly with speaker labels. "
    "Produce a concise summary followed by a list of decisions and action "
    "items (with owners when identifiable). Use plain text."
)
LLM_TEMPERATURE = float(os.getenv("LLM_TEMPERATURE", "0.2"))
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "1024"))
LLM_TIMEOUT_SEC = float(os.getenv("LLM_TIMEOUT_SEC", "120"))

# ---------------------------------------------------------------------------
# Background analyzers: named prompts run periodically against the growing
# transcript of each session (topics, suggestions, ...). Defaults come from a
# JSON config file; they can be viewed/edited at runtime from the Admin tab
# (GET/PUT /admin/analyzers). Requires the LLM above to be configured.
# ---------------------------------------------------------------------------
ANALYZERS_CONFIG = os.getenv("ANALYZERS_CONFIG", "") or str(
    Path(__file__).parent / "analyzers.json")
# Optional shared secret for the admin endpoints (sent as X-Admin-Token).
# Empty = admin endpoints are open; fine on a trusted LAN, set it otherwise.
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "")
ANALYZER_TICK_SEC = float(os.getenv("ANALYZER_TICK_SEC", "5"))
# Don't run the periodic analyzers until the transcript has at least this many
# non-whitespace characters, so they don't fire on an empty/near-empty meeting.
ANALYZER_MIN_CHARS = int(os.getenv("ANALYZER_MIN_CHARS", "40"))

STATIC_DIR = Path(__file__).parent / "static"
