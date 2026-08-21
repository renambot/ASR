#!/usr/bin/env python3
"""Load-test the EVL ASR proxy with many concurrent fake "browser" sessions.

Each session speaks the same wire protocol as the web app / SDK: it opens
/ws and streams 16-bit mono PCM frames (100 ms each) from a WAV file at
real-time pace, then reports what came back (interims, finals, errors).

Usage:
  .venv/bin/python tools/loadtest.py \
      --server wss://arcade.evl.uic.edu/speech --wav sample.wav \
      --sessions 1,5,10,20 --duration 60 [--user U --password P] \
      [--diarization] [--analyzers]

Notes:
- The WAV should be 16 kHz mono 16-bit PCM — exactly what the app's
  "Save WAV" button produces. It is looped for the duration.
- Sessions close their socket without sending {"type":"stop"}, so the
  proxy never runs end-of-meeting analyzers for them (no LLM burst).
- Analyzers are opted OUT by default (analyzers=0); pass --analyzers to
  also load the proxy's LLM with per-session background analysis.
- This consumes real NIM GPU streams: run it off-hours, and raise the
  proxy's MAX_SESSIONS so the cap isn't what you end up measuring.
"""

import argparse
import asyncio
import json
import ssl
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from http.cookies import SimpleCookie

try:
    import websockets
except ImportError:
    sys.exit("The 'websockets' package is required (use the repo venv: .venv/bin/python).")

FRAME_SEC = 0.1  # the app's worklet emits ~100 ms frames


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def http_base(ws_base: str) -> str:
    """wss://host/path -> https://host/path (and ws -> http)."""
    return "http" + ws_base[2:] if ws_base.startswith("ws") else ws_base


def load_wav(path: str):
    """Return (pcm_bytes, sample_rate); requires 16-bit mono PCM."""
    with wave.open(path, "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            sys.exit(f"{path}: need mono 16-bit PCM (got {w.getnchannels()} ch, "
                     f"{w.getsampwidth() * 8}-bit). Use the app's Save WAV output.")
        return w.readframes(w.getnframes()), w.getframerate()


def fetch_config(base: str):
    """Best-effort GET /config (for the expected sample rate)."""
    try:
        with urllib.request.urlopen(http_base(base) + "/config", timeout=5) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return {}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # keep the 303 so we can read Set-Cookie
        return None


def login(base: str, user: str, password: str) -> str:
    """POST /login and return the asr_auth cookie value (raises on failure)."""
    url = http_base(base) + "/login"
    body = urllib.parse.urlencode({"username": user, "password": password}).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        resp = opener.open(req, timeout=10)     # 200 = login page again = bad creds
        raise SystemExit("Login failed: wrong username or password.")
    except urllib.error.HTTPError as e:
        if e.code != 303:
            raise SystemExit(f"Login failed: HTTP {e.code}")
        cookie = SimpleCookie()
        for h in e.headers.get_all("Set-Cookie") or []:
            cookie.load(h)
        if "asr_auth" not in cookie:
            raise SystemExit("Login succeeded but no asr_auth cookie was set.")
        return cookie["asr_auth"].value


# ---------------------------------------------------------------------------
# One fake browser session
# ---------------------------------------------------------------------------
class SessionStats:
    def __init__(self, idx):
        self.idx = idx
        self.connected = False
        self.rejected_full = False
        self.error = None            # str when something went wrong
        self.t_first_interim = None  # seconds after connect
        self.interims = 0
        self.finals = 0
        self.final_chars = 0
        self.frames_sent = 0


async def run_session(idx, ws_url, headers, pcm, frame_bytes, deadline, stats):
    t0 = time.monotonic()
    try:
        async with websockets.connect(
            ws_url, additional_headers=headers or None,
            open_timeout=15, ping_interval=20, ping_timeout=20, max_size=None,
        ) as ws:
            stats.connected = True
            stop = asyncio.Event()

            async def reader():
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except (json.JSONDecodeError, TypeError):
                        continue
                    t = msg.get("type")
                    if t == "interim":
                        stats.interims += 1
                        if stats.t_first_interim is None:
                            stats.t_first_interim = time.monotonic() - t0
                    elif t == "final":
                        stats.finals += 1
                        stats.final_chars += len(msg.get("text") or "")
                    elif t == "status" and msg.get("state") == "full":
                        stats.rejected_full = True
                        stats.connected = False
                        stop.set()
                    elif t == "error":
                        stats.error = str(msg.get("message"))[:80]

            async def writer():
                # Pace frames on an absolute schedule so N sessions don't drift.
                pos = 0
                next_at = time.monotonic()
                while time.monotonic() < deadline and not stop.is_set():
                    chunk = pcm[pos:pos + frame_bytes]
                    if len(chunk) < frame_bytes:           # loop the file
                        chunk = chunk + pcm[:frame_bytes - len(chunk)]
                        pos = frame_bytes - (len(pcm) - pos)
                    else:
                        pos += frame_bytes
                    await ws.send(chunk)
                    stats.frames_sent += 1
                    next_at += FRAME_SEC
                    delay = next_at - time.monotonic()
                    if delay > 0:
                        await asyncio.sleep(delay)

            rt = asyncio.create_task(reader())
            try:
                await writer()
            finally:
                rt.cancel()
                # Close WITHOUT {"type":"stop"}: no end-of-meeting analyzers.
    except websockets.exceptions.InvalidStatus as e:
        stats.error = f"handshake rejected (HTTP {e.response.status_code} — auth/origin?)"
    except Exception as e:  # noqa: BLE001 - record, don't crash the run
        if not stats.rejected_full:
            stats.error = f"{type(e).__name__}: {e}"[:100]


# ---------------------------------------------------------------------------
# Ramp runner
# ---------------------------------------------------------------------------
def fmt(x, unit=""):
    return "-" if x is None else f"{x:.2f}{unit}"


async def run_level(n, ws_url, headers, pcm, frame_bytes, duration, stagger):
    deadline = time.monotonic() + duration + n * stagger
    stats = [SessionStats(i) for i in range(n)]
    tasks = []
    for s in stats:
        tasks.append(asyncio.create_task(
            run_session(s.idx, ws_url, headers, pcm, frame_bytes, deadline, s)))
        await asyncio.sleep(stagger)
    await asyncio.gather(*tasks)

    ok = [s for s in stats if s.connected and not s.error]
    full = [s for s in stats if s.rejected_full]
    err = [s for s in stats if s.error and not s.rejected_full]
    ttfi = [s.t_first_interim for s in ok if s.t_first_interim is not None]
    finals = sum(s.finals for s in ok)
    chars = sum(s.final_chars for s in ok)
    row = {
        "sessions": n, "ok": len(ok), "full": len(full), "errors": len(err),
        "ttfi_p50": statistics.median(ttfi) if ttfi else None,
        "ttfi_max": max(ttfi) if ttfi else None,
        "finals/s": round(finals / max(len(ok), 1), 1),
        "chars/s": round(chars / max(len(ok), 1)),
    }
    print(f"  {n:>4} sessions | ok {row['ok']:>3}  full {row['full']:>3}  "
          f"err {row['errors']:>3} | first-interim p50 {fmt(row['ttfi_p50'], 's'):>8} "
          f"max {fmt(row['ttfi_max'], 's'):>8} | finals/sess {row['finals/s']:>6} "
          f"chars/sess {row['chars/s']:>7}")
    for s in err[:5]:
        print(f"       session {s.idx}: {s.error}")
    return row


async def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--server", required=True,
                    help="proxy base, e.g. wss://host/speech or ws://localhost:8080")
    ap.add_argument("--wav", required=True, help="16 kHz mono 16-bit PCM WAV to stream")
    ap.add_argument("--sessions", default="1,5,10",
                    help="comma-separated ramp levels (default 1,5,10)")
    ap.add_argument("--duration", type=float, default=60, help="seconds per level")
    ap.add_argument("--stagger", type=float, default=0.1, help="seconds between connects")
    ap.add_argument("--cooldown", type=float, default=5, help="seconds between levels")
    ap.add_argument("--diarization", action="store_true", help="enable diarization")
    ap.add_argument("--analyzers", action="store_true",
                    help="opt sessions in to background analyzers (loads the LLM!)")
    ap.add_argument("--user", help="AUTH_USERNAME when the proxy has the login page")
    ap.add_argument("--password", help="AUTH_PASSWORD when the proxy has the login page")
    args = ap.parse_args()

    base = args.server.rstrip("/")
    pcm, rate = load_wav(args.wav)
    frame_bytes = int(rate * FRAME_SEC) * 2

    cfg = fetch_config(base)
    if cfg.get("sample_rate") and cfg["sample_rate"] != rate:
        print(f"WARNING: WAV is {rate} Hz but the server expects "
              f"{cfg['sample_rate']} Hz — transcription will be garbage.")
    if cfg.get("sessions"):
        print(f"NOTE: the server already reports {cfg['sessions']} live session(s).")

    headers = {}
    if args.user or args.password:
        token = login(base, args.user or "", args.password or "")
        headers["Cookie"] = f"asr_auth={token}"
        print("Logged in; using the asr_auth cookie on WS handshakes.")

    params = {"diarization": "1" if args.diarization else "0",
              "analyzers": "1" if args.analyzers else "0",
              "punct": "1"}
    ws_url = f"{base}/ws?{urllib.parse.urlencode(params)}"

    print(f"Target {ws_url}\nWAV: {args.wav} ({rate} Hz, {len(pcm) / rate / 2:.1f}s, "
          f"looped) | {args.duration:.0f}s per level\n")
    levels = [int(x) for x in args.sessions.split(",") if x.strip()]
    for i, n in enumerate(levels):
        await run_level(n, ws_url, headers, pcm, frame_bytes, args.duration, args.stagger)
        if i < len(levels) - 1:
            await asyncio.sleep(args.cooldown)
    print("\nDone. Watch for the level where first-interim latency grows or "
          "errors appear — that's the capacity knee; set MAX_SESSIONS below it.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\ninterrupted")
