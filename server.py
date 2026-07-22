"""
EVL ASR web proxy for an NVIDIA NIM (Riva) realtime ASR instance.

Flow:
  Browser mic --(binary PCM16 16kHz mono over WS)--> this proxy
  this proxy  --(base64 JSON events over WS)------> NIM /v1/realtime

The NIM speaks an OpenAI-Realtime-style protocol:
  - we send  `transcription_session.update` (config), then a stream of
    `input_audio_buffer.append` events carrying base64 PCM16, and
    `input_audio_buffer.commit` to force a transcription;
  - the NIM sends back `...transcription.delta` (interim, cumulative) and
    `...transcription.completed` (final) events.

Why a proxy at all (instead of the browser talking to the NIM directly)?
  - same-origin socket for the browser (no CORS / mixed-content headaches),
  - the NIM address + any API key stay server-side,
  - raw PCM gets wrapped into the base64 JSON events the NIM expects, and
  - the upstream NIM session is transparently reconnected if it drops, so a
    user can dictate for hours without the browser noticing.
"""

# The implementation now lives in focused modules:
#   config.py    -- env-driven settings
#   analyzers.py -- background-analyzer registry
#   nim.py       -- NIM session config + transcript-event parsing
#   llm.py       -- OpenAI-compatible chat call + prompt helpers
#   bridge.py    -- per-client browser<->NIM bridge
#   routes.py    -- FastAPI endpoints and static hosting
# This file stays the uvicorn entrypoint (`uvicorn server:app`).

from routes import app  # noqa: F401
