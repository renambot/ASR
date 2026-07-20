"""
Live ASR web proxy for an NVIDIA NIM (Riva) realtime ASR instance.

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

import asyncio
import base64
import json
import logging
import os
import time
import uuid
import wave
from pathlib import Path
from urllib.parse import urlencode

import httpx
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

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

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="Live ASR Proxy")


def nim_url() -> str:
    """Build the NIM realtime WebSocket URL, e.g.
    ws://host:9000/v1/realtime?intent=transcription&model=..."""
    query = {"intent": NIM_INTENT}
    if ASR_MODEL:
        query["model"] = ASR_MODEL
    return f"{NIM_SCHEME}://{NIM_HOST}:{NIM_PORT}{NIM_PATH}?{urlencode(query)}"


def session_update_event() -> dict:
    """The first event we send after connecting: configures the transcription
    session (model, language, punctuation, and optional diarization/endpointing)."""
    session = {
        "input_audio_format": "pcm16",
        "input_audio_transcription": {
            "language": ASR_LANGUAGE,
        },
        "input_audio_params": {
            "sample_rate_hz": SAMPLE_RATE,
            "num_channels": 1,
        },
        "recognition_config": {
            "max_alternatives": 1,
            "enable_automatic_punctuation": AUTO_PUNCT,
            "enable_word_time_offsets": DIARIZATION,
            "enable_profanity_filter": False,
        },
    }
    if ASR_MODEL:
        session["input_audio_transcription"]["model"] = ASR_MODEL
    if DIARIZATION:
        session["speaker_diarization"] = {
            "enable_speaker_diarization": True,
            "max_speaker_count": MAX_SPEAKERS,
        }
    if ENDPOINTING:
        session["endpointing_config"] = {
            "start_history": EOU_START_HISTORY,
            "start_threshold": EOU_START_THRESHOLD,
            "stop_history": EOU_STOP_HISTORY,
            "stop_threshold": EOU_STOP_THRESHOLD,
            "stop_history_eou": EOU_STOP_HISTORY_EOU,
            "stop_threshold_eou": EOU_STOP_THRESHOLD_EOU,
        }
    return {"type": "transcription_session.update", "session": session}


_SPEAKER_KEYS = ("speaker", "speaker_tag", "speaker_id", "speaker_label")


def _extract_speaker(evt: dict):
    """Best-effort pull of a speaker label from a completed event. The exact
    field varies by NIM version, so we probe several likely shapes."""
    words = []
    wi = evt.get("words_info")
    if isinstance(wi, dict):
        words = wi.get("words") or []
    words = words or evt.get("words") or []
    # Prefer the speaker of the first tagged word in the segment.
    for w in words:
        if isinstance(w, dict):
            for k in _SPEAKER_KEYS:
                v = w.get(k)
                if v not in (None, "", -1):
                    return str(v)
    # Fall back to a segment-level tag.
    for k in _SPEAKER_KEYS:
        v = evt.get(k)
        if v not in (None, "", -1):
            return str(v)
    return None


async def send_json(ws: WebSocket, payload: dict) -> None:
    """Send a JSON message to the browser, ignoring a closed socket."""
    try:
        await ws.send_text(json.dumps(payload))
    except (WebSocketDisconnect, RuntimeError):
        pass


# ---------------------------------------------------------------------------
# Per-client bridge
# ---------------------------------------------------------------------------
class Bridge:
    """Bridges one browser socket to a (re)connectable NIM session."""

    def __init__(self, browser_ws: WebSocket):
        self.browser = browser_ws
        # Decouples the browser reader from the NIM writer: audio keeps being
        # read from the browser even while the NIM is momentarily reconnecting.
        self.audio_q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=AUDIO_QUEUE_MAX)
        self.stop = asyncio.Event()   # tear everything down
        self.flush = asyncio.Event()  # browser asked to finalize buffered audio
        self.debug_pcm = bytearray() if DEBUG_AUDIO_DIR else None
        self.frames_sent = 0  # cumulative frames forwarded to the NIM

    # -- browser -> queue ---------------------------------------------------
    async def read_browser(self) -> None:
        """Continuously drain the browser socket regardless of NIM state."""
        try:
            while not self.stop.is_set():
                msg = await self.browser.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                data = msg.get("bytes")
                if data:
                    self._enqueue(data)
                    continue
                text = msg.get("text")
                if text:
                    await self._handle_control(text)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            self.stop.set()

    def _enqueue(self, data: bytes) -> None:
        if self.debug_pcm is not None and len(self.debug_pcm) < DEBUG_AUDIO_MAX_BYTES:
            self.debug_pcm.extend(data)
        if self.audio_q.full():
            try:
                self.audio_q.get_nowait()  # drop oldest to bound latency
            except asyncio.QueueEmpty:
                pass
        self.audio_q.put_nowait(data)

    def _write_debug_wav(self) -> None:
        """Persist the captured PCM as a WAV (debug only) to verify the exact
        audio that reached the NIM."""
        if not self.debug_pcm:
            return
        Path(DEBUG_AUDIO_DIR).mkdir(parents=True, exist_ok=True)
        ts = time.strftime("%Y%m%d-%H%M%S")
        path = Path(DEBUG_AUDIO_DIR) / f"capture-{ts}-{uuid.uuid4().hex[:6]}.wav"
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)  # 16-bit
            w.setframerate(SAMPLE_RATE)
            w.writeframes(bytes(self.debug_pcm))
        secs = len(self.debug_pcm) / 2 / SAMPLE_RATE
        log.info("wrote debug audio: %s (%.1fs, %d bytes)", path, secs, len(self.debug_pcm))

    async def _handle_control(self, text: str) -> None:
        try:
            evt = json.loads(text)
        except json.JSONDecodeError:
            return
        etype = evt.get("type")
        if etype == "flush":
            # Browser stopped talking: finalize whatever audio is buffered so the
            # last utterance isn't lost. The browser waits briefly before closing.
            self.flush.set()
        elif etype == "stop":
            self.stop.set()

    # -- NIM connection manager --------------------------------------------
    async def run_nim(self) -> None:
        """Keep an upstream NIM session alive, reconnecting as needed."""
        url = nim_url()
        headers = {}
        if NIM_API_KEY:
            headers["Authorization"] = f"Bearer {NIM_API_KEY}"
        backoff = 0.5

        while not self.stop.is_set():
            try:
                await send_json(self.browser, {"type": "status", "state": "connecting"})
                async with websockets.connect(
                    url,
                    additional_headers=headers or None,
                    max_size=None,
                    ping_interval=20,
                    ping_timeout=20,
                ) as nim:
                    await nim.send(json.dumps(session_update_event()))
                    log.info("NIM session opened: %s", url)
                    await send_json(self.browser, {"type": "status", "state": "connected"})
                    backoff = 0.5

                    tasks = {
                        asyncio.create_task(self._pump_audio(nim)),
                        asyncio.create_task(self._pump_transcripts(nim)),
                    }
                    # With server-side endpointing on, the NIM segments itself,
                    # so we must NOT also force periodic commits.
                    if COMMIT_INTERVAL > 0 and not ENDPOINTING:
                        tasks.add(asyncio.create_task(self._commit_loop(nim)))
                    done, pending = await asyncio.wait(
                        tasks, return_when=asyncio.FIRST_COMPLETED
                    )
                    for t in pending:
                        t.cancel()
                    for t in done:
                        exc = t.exception()
                        if exc:
                            raise exc
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - reconnect on any upstream error
                if self.stop.is_set():
                    break
                log.warning("NIM connection lost (%s); reconnecting in %.1fs", exc, backoff)
                await send_json(self.browser, {"type": "status", "state": "reconnecting"})
                try:
                    await asyncio.wait_for(self.stop.wait(), timeout=backoff)
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, 5.0)

        await send_json(self.browser, {"type": "status", "state": "closed"})

    async def _pump_audio(self, nim) -> None:
        """Drain queued PCM frames and forward each as an append event."""
        sent = 0
        while not self.stop.is_set():
            # A pending flush (browser pressed Stop) takes priority: send the
            # remaining audio and commit before we go back to waiting for more.
            if self.flush.is_set():
                self.flush.clear()
                await self._flush_buffer(nim)
            try:
                chunk = await asyncio.wait_for(self.audio_q.get(), timeout=0.25)
            except asyncio.TimeoutError:
                continue
            await nim.send(self._append_event(chunk))
            sent += 1
            self.frames_sent += 1
            if sent == 1 or sent % 50 == 0:
                log.debug("forwarded %d audio frame(s) to NIM (%d bytes each)", sent, len(chunk))

    @staticmethod
    def _append_event(chunk: bytes) -> str:
        return json.dumps({
            "type": "input_audio_buffer.append",
            "audio": base64.b64encode(chunk).decode("ascii"),
        })

    async def _flush_buffer(self, nim) -> None:
        """Send any queued audio, then commit so the NIM finalizes it."""
        while True:
            try:
                chunk = self.audio_q.get_nowait()
            except asyncio.QueueEmpty:
                break
            await nim.send(self._append_event(chunk))
            self.frames_sent += 1
        if self.frames_sent > 0:
            await nim.send(json.dumps({"type": "input_audio_buffer.commit"}))
            log.debug("flushed and committed buffered audio on stop")

    async def _commit_loop(self, nim) -> None:
        """Periodically commit the audio buffer so the NIM emits transcripts
        (needed when server-side endpointing/VAD is disabled)."""
        last_committed = -1
        while not self.stop.is_set():
            try:
                await asyncio.wait_for(self.stop.wait(), timeout=COMMIT_INTERVAL)
                break  # stop was set
            except asyncio.TimeoutError:
                pass
            if self.frames_sent > 0 and self.frames_sent != last_committed:
                last_committed = self.frames_sent
                await nim.send(json.dumps({"type": "input_audio_buffer.commit"}))

    async def _pump_transcripts(self, nim) -> None:
        """Read NIM events and forward transcripts to the browser as simplified
        {type: interim|final|error} messages."""
        async for raw in nim:
            if self.stop.is_set():
                break
            try:
                evt = json.loads(raw)
            except json.JSONDecodeError:
                log.debug("NIM non-JSON message: %r", raw)
                continue
            etype = evt.get("type", "")
            log.debug("NIM event: %s", etype)
            if etype.endswith("transcription.delta"):
                # Interim hypothesis (cumulative); the client replaces, not appends.
                text = evt.get("delta", "")
                if text:
                    await send_json(self.browser, {"type": "interim", "text": text})
            elif etype.endswith("transcription.completed"):
                # Finalized segment; append it to the running transcript.
                text = evt.get("transcript", "")
                if text:
                    payload = {"type": "final", "text": text}
                    if DIARIZATION:
                        log.debug("NIM completed (diarization) full event: %s", json.dumps(evt))
                        speaker = _extract_speaker(evt)
                        if speaker is not None:
                            payload["speaker"] = speaker
                    await send_json(self.browser, payload)
            elif etype == "error":
                log.warning("NIM error event: %s", json.dumps(evt))
                await send_json(
                    self.browser,
                    {"type": "error", "message": str(evt.get("error", evt))},
                )
            else:
                log.debug("NIM unhandled event: %s", json.dumps(evt))

    async def serve(self) -> None:
        """Run the browser reader and the NIM manager until either ends, then
        tear both down and (optionally) dump the captured debug audio."""
        reader = asyncio.create_task(self.read_browser())
        nim = asyncio.create_task(self.run_nim())
        try:
            await asyncio.wait({reader, nim}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            self.stop.set()
            for t in (reader, nim):
                t.cancel()
            await asyncio.gather(reader, nim, return_exceptions=True)
            if self.debug_pcm is not None:
                self._write_debug_wav()


# Count of live browser sessions (single event loop, so a plain int is safe).
_active_sessions = 0


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    """One browser connection == one Bridge to the NIM, capped at MAX_SESSIONS."""
    global _active_sessions
    await ws.accept()
    if MAX_SESSIONS > 0 and _active_sessions >= MAX_SESSIONS:
        log.warning("Rejecting browser: at capacity (%d/%d)", _active_sessions, MAX_SESSIONS)
        await send_json(ws, {
            "type": "status",
            "state": "full",
            "message": f"The server is at capacity ({MAX_SESSIONS} active sessions). "
                       "Please try again later.",
        })
        try:
            await ws.close(code=1013)  # 1013 = Try Again Later
        except RuntimeError:
            pass
        return
    _active_sessions += 1
    log.info("Browser connected (%d/%s active)", _active_sessions,
             MAX_SESSIONS if MAX_SESSIONS > 0 else "unlimited")
    bridge = Bridge(ws)
    try:
        await bridge.serve()
    finally:
        _active_sessions -= 1
        log.info("Browser disconnected (%d active)", _active_sessions)
        try:
            await ws.close()
        except RuntimeError:
            pass


@app.get("/config")
async def config():
    """Expose non-secret settings the client needs (e.g. sample rate)."""
    return {
        "sample_rate": SAMPLE_RATE,
        "language": ASR_LANGUAGE,
        "model": ASR_MODEL or "default",
        "llm": bool(LLM_BASE_URL),
    }


@app.post("/llm")
async def llm_process(payload: dict):
    """Run the transcript through the configured LLM and return the result.

    Body: {"text": "<transcript>", "instruction": "<optional prompt override>"}
    The endpoint, key, and default prompt are all server-side configuration,
    mirroring how the NIM connection is handled.
    """
    if not LLM_BASE_URL:
        return JSONResponse({"error": "No LLM configured on the server."}, status_code=503)
    text = (payload.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "Empty transcript."}, status_code=400)
    system = (payload.get("instruction") or "").strip() or LLM_SYSTEM_PROMPT

    body = {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": text},
        ],
        "temperature": LLM_TEMPERATURE,
        "max_tokens": LLM_MAX_TOKENS,
    }
    if LLM_MODEL:
        body["model"] = LLM_MODEL
    headers = {"Content-Type": "application/json"}
    if LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"

    try:
        async with httpx.AsyncClient(timeout=LLM_TIMEOUT_SEC) as client:
            resp = await client.post(
                f"{LLM_BASE_URL}/chat/completions", json=body, headers=headers
            )
            resp.raise_for_status()
            data = resp.json()
        result = data["choices"][0]["message"]["content"]
        usage = data.get("usage") or {}
        log.info("LLM processed %d chars -> %d chars (model=%s)",
                 len(text), len(result), data.get("model", LLM_MODEL or "?"))
        return {"result": result, "model": data.get("model", LLM_MODEL), "usage": usage}
    except httpx.HTTPStatusError as exc:
        log.warning("LLM HTTP error: %s %s", exc.response.status_code, exc.response.text[:500])
        return JSONResponse(
            {"error": f"LLM returned {exc.response.status_code}."}, status_code=502)
    except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
        log.warning("LLM request failed: %r", exc)
        return JSONResponse({"error": "LLM request failed."}, status_code=502)


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
