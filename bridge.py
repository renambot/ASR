"""Per-client bridge: one browser WebSocket <-> one NIM realtime session."""

import asyncio
import base64
import json
import time
import uuid
import wave
from pathlib import Path

import websockets
from fastapi import WebSocket, WebSocketDisconnect

import analyzers
from config import (ANALYZER_MIN_CHARS, ANALYZER_TICK_SEC, AUDIO_QUEUE_MAX,
                    COMMIT_INTERVAL, DEBUG_AUDIO_DIR, DEBUG_AUDIO_MAX_BYTES,
                    LLM_BASE_URL, NIM_API_KEY, SAMPLE_RATE, log)
from llm import chain_suffix, llm_chat
from nim import nim_url, session_opts, session_update_event, _speaker_segments


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
        # Per-connection ASR settings from the browser's ?query params (merged
        # over the server env defaults), fixed for the life of this session.
        self.opts = session_opts(browser_ws.query_params)
        # Decouples the browser reader from the NIM writer: audio keeps being
        # read from the browser even while the NIM is momentarily reconnecting.
        self.audio_q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=AUDIO_QUEUE_MAX)
        self.stop = asyncio.Event()   # tear everything down
        self.flush = asyncio.Event()  # browser asked to finalize buffered audio
        self.debug_pcm = bytearray() if DEBUG_AUDIO_DIR else None
        self.frames_sent = 0  # cumulative frames forwarded to the NIM
        # Server-side copy of finalized segments for the background analyzers.
        # Each is {"t": elapsed_seconds, "speaker": id|None, "text": str}; the
        # analyzer transcript is rendered as "[MM:SS] <label>: text".
        self.transcript_segments: list[dict] = []
        self._t0: float | None = None  # monotonic time of the first segment
        # speaker id (str) -> custom name from the browser's Speakers panel, so
        # analyzers see "Alice: …" instead of "Speaker 0: …".
        self.speaker_names: dict[str, str] = {}
        self._finalizing = False  # a stop/finalize is already in progress

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
            # Run end-of-meeting analyzers while the socket is still open,
            # then tear down. Guard against duplicate stop messages.
            if not self._finalizing:
                self._finalizing = True
                asyncio.create_task(self._finalize())
        elif etype == "speaker_names":
            # Custom speaker names from the Speakers panel; applied to the
            # transcript the analyzers see.
            names = evt.get("names")
            if isinstance(names, dict):
                self.speaker_names = {str(k): str(v) for k, v in names.items()}

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
                    await nim.send(json.dumps(session_update_event(self.opts)))
                    log.info("NIM session opened: %s", url)
                    await send_json(self.browser, {"type": "status", "state": "connected"})
                    backoff = 0.5

                    tasks = {
                        asyncio.create_task(self._pump_audio(nim)),
                        asyncio.create_task(self._pump_transcripts(nim)),
                    }
                    # With server-side endpointing on, the NIM segments itself,
                    # so we must NOT also force periodic commits.
                    if COMMIT_INTERVAL > 0 and not self.opts["endpointing"]:
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
                # Finalized segment. With diarization on, split it at per-word
                # speaker changes; with it off, ignore any speaker tag the NIM
                # returns so no "Speaker N" labels leak into the transcript.
                if self.opts["diarization"]:
                    log.debug("NIM completed (diarization) full event: %s", json.dumps(evt))
                    segments = _speaker_segments(evt)
                else:
                    whole = (evt.get("transcript") or "").strip()
                    segments = [(None, whole)] if whole else []
                for speaker, text in segments:
                    if not text:
                        continue
                    if self._t0 is None:
                        self._t0 = time.monotonic()
                    self.transcript_segments.append({
                        "t": time.monotonic() - self._t0,
                        "speaker": speaker,
                        "text": text,
                    })
                    payload = {"type": "final", "text": text}
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

    # -- background analyzers ------------------------------------------------
    async def run_analyzers(self) -> None:
        """Periodically run the analyzer prompts over the transcript.

        The registry is re-read every tick, so Admin-tab edits apply to
        sessions already in progress. Analyzers are processed sequentially in
        list order so 'chain' entries can fire right after their predecessor,
        with that predecessor's output as extra context:
          interval -- due when interval_min has elapsed since its last run
          chain    -- due when the previous analyzer in the list just ran
          on_stop  -- skipped here; handled by _finalize() on Stop."""
        self._analyzer_state: dict[str, dict] = {}  # id -> {"last": t}
        while not self.stop.is_set():
            try:
                await asyncio.wait_for(self.stop.wait(), timeout=ANALYZER_TICK_SEC)
                break  # stop was set
            except asyncio.TimeoutError:
                pass
            registry = analyzers.get_all()
            if not LLM_BASE_URL or not registry:
                continue
            text = self._labeled_transcript()
            # Wait until there's some actual transcript before analyzing.
            if len(text.strip()) < ANALYZER_MIN_CHARS:
                continue
            now = time.monotonic()
            prev_ran, prev_name, prev_result = False, None, None
            for a in registry:
                if self.stop.is_set():
                    break
                due = False
                if not a.get("enabled", True):
                    prev_ran = False
                    continue
                if a["mode"] == "interval":
                    st = self._analyzer_state.setdefault(a["id"], {"last": 0.0})
                    if now - st["last"] >= a["interval_min"] * 60:
                        st["last"] = now
                        due = True
                elif a["mode"] == "chain":
                    due = prev_ran
                # on_stop: never due in the periodic loop
                if due:
                    result = await self._run_analyzer(
                        a, text, prev_name=prev_name if a["mode"] == "chain" else None,
                        prev_result=prev_result if a["mode"] == "chain" else None)
                    prev_ran, prev_name, prev_result = result is not None, a["name"], result
                else:
                    prev_ran = False

    async def run_on_stop_analyzers(self) -> None:
        """Run the end-of-meeting analyzers (mode on_stop), in list order.
        A 'chain' analyzer directly after one of these runs too, with its
        output as context."""
        # Give the flushed last segment a moment to come back from the NIM.
        await asyncio.sleep(1.0)
        text = self._labeled_transcript()
        if not text.strip() or not LLM_BASE_URL:
            return
        prev_ran, prev_name, prev_result = False, None, None
        for a in analyzers.get_all():
            if not a.get("enabled", True):
                prev_ran = False
                continue
            due = a["mode"] == "on_stop" or (a["mode"] == "chain" and prev_ran)
            if due:
                result = await self._run_analyzer(
                    a, text, prev_name=prev_name if a["mode"] == "chain" else None,
                    prev_result=prev_result if a["mode"] == "chain" else None)
                prev_ran, prev_name, prev_result = result is not None, a["name"], result
            else:
                prev_ran = False

    @staticmethod
    def _fmt_ts(seconds: float) -> str:
        s = int(seconds)
        return f"{s // 60:02d}:{s % 60:02d}"

    def _labeled_transcript(self) -> str:
        """Render the transcript for analyzers as "[MM:SS] <label>: text",
        applying the browser-supplied custom speaker names when present."""
        names = {k: v.strip() for k, v in self.speaker_names.items() if v.strip()}
        out = []
        for seg in self.transcript_segments:
            ts = self._fmt_ts(seg["t"])
            sp = seg["speaker"]
            if sp is not None:
                label = names.get(str(sp)) or f"Speaker {sp}"
                out.append(f"[{ts}] {label}: {seg['text']}")
            else:
                out.append(f"[{ts}] {seg['text']}")
        return "\n".join(out)

    async def _run_analyzer(self, analyzer: dict, text: str,
                            prev_name: str | None = None,
                            prev_result: str | None = None):
        """Run one analyzer; returns its result text, or None on error."""
        user = text
        if prev_result is not None:
            user += chain_suffix(prev_name, prev_result)
        # Tell the client an AI call is in flight (drives the activity indicator).
        await send_json(self.browser, {"type": "ai_running", "running": True})
        try:
            out = await llm_chat(analyzer["prompt"], user)
        except RuntimeError as exc:
            await send_json(self.browser, {
                "type": "analysis", "id": analyzer["id"], "name": analyzer["name"],
                "error": str(exc), "ts": time.time(),
            })
            return None
        finally:
            await send_json(self.browser, {"type": "ai_running", "running": False})
        log.info("analyzer %r (%s): %d chars -> %d chars",
                 analyzer["id"], analyzer["mode"], len(user), len(out["result"]))
        await send_json(self.browser, {
            "type": "analysis", "id": analyzer["id"], "name": analyzer["name"],
            "result": out["result"], "ts": time.time(),
        })
        return out["result"]

    async def _finalize(self) -> None:
        """Handle Stop from the browser: run the on_stop analyzers while the
        socket is still open, tell the client we're done, then tear down."""
        try:
            await self.run_on_stop_analyzers()
        except Exception:  # noqa: BLE001 - never let finalize wedge teardown
            log.exception("on_stop analyzers failed")
        finally:
            await send_json(self.browser, {"type": "session_end"})
            self.stop.set()

    async def serve(self) -> None:
        """Run the browser reader, the NIM manager, and the analyzer loop
        until any ends, then tear everything down and (optionally) dump the
        captured debug audio."""
        reader = asyncio.create_task(self.read_browser())
        nim = asyncio.create_task(self.run_nim())
        analyzers = asyncio.create_task(self.run_analyzers())
        try:
            await asyncio.wait({reader, nim}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            self.stop.set()
            for t in (reader, nim, analyzers):
                t.cancel()
            await asyncio.gather(reader, nim, analyzers, return_exceptions=True)
            if self.debug_pcm is not None:
                self._write_debug_wav()
