# Live ASR — browser mic → NVIDIA NIM (Riva) realtime ASR

A minimal web app for **indefinite live speech-to-text**. Pick a microphone in
the browser, stream audio to your NVIDIA ASR NIM, and watch an append-only
transcript grow — talk for hours, then copy or download the text. Optional
speaker diarization labels who is talking.

## How it works

```
Browser mic ──16 kHz PCM16 (binary WS)──▶  Python proxy  ──base64 JSON (WS)──▶  NIM :9000
  AudioWorklet resamples + Int16            server.py                           /v1/realtime?intent=transcription
  append-only transcript UI                 reconnects NIM silently             OpenAI-Realtime-style events
```

The NIM speaks an **OpenAI-Realtime-style protocol**: the proxy sends a
`transcription_session.update` (config), then a stream of
`input_audio_buffer.append` events (base64 PCM16), and
`input_audio_buffer.commit` to force a transcription; the NIM returns
`…transcription.delta` (interim, cumulative) and `…transcription.completed`
(final) events.

The proxy (`server.py`) exists so that:
- the browser talks to a **same-origin** socket (no CORS / mixed-content issues),
- the NIM address and any API key stay server-side,
- raw PCM is wrapped into the base64 JSON events the NIM expects, and
- the **upstream NIM session is transparently reconnected** if it drops, without
  the browser losing the transcript — key for multi-hour use.

### Segmentation: commit vs. endpointing

The realtime API only produces transcripts when audio is either **committed** or
**endpointed** (server-side VAD). NIM ships with endpointing **disabled**
(all-zero thresholds), so the app supports two modes:

- **Endpointing on** (`ASR_ENDPOINTING=true`) — the NIM finalizes at natural
  speech pauses. Nicer segmentation, but depends on the model actually emitting
  results with VAD enabled.
- **Endpointing off** — the proxy commits the buffer every `COMMIT_INTERVAL_SEC`
  seconds. Deterministic: text flows on a fixed cadence regardless of pauses or
  noise. This is the most reliable mode for a VAD-disabled NIM.

Pressing **Stop** always flushes the last buffered audio so the final utterance
isn't lost.

## Setup

```sh
python3 -m venv .venv
source .venv/bin/activate          # tcsh: source .venv/bin/activate.csh
pip install -r requirements.txt
```

## Configure and run

All settings live at the top of the **`GO`** launcher script — edit them and run
`./GO` (no environment setup needed):

```sh
./GO
```

Then open **http://localhost:8080**.

### Settings (in `GO`)

| Variable | Default | Notes |
|---|---|---|
| `NIM_SCHEME` | `wss` | `ws` or `wss` |
| `NIM_HOST` | `arcade.evl.uic.edu` | host of your ASR NIM (or nginx front door) |
| `NIM_PORT` | `443` | `443` via nginx, or `9000`/`7777` direct to the NIM |
| `NIM_PATH` | `/asr/v1/realtime` | `/v1/realtime` if hitting the NIM directly |
| `NIM_API_KEY` | *(empty)* | sent as `Authorization: Bearer …` if set |
| `ASR_MODEL` | `cache-aware-parakeet-rnnt-en-US-asr-streaming-sortformer` | must match the loaded model |
| `ASR_LANGUAGE` | `en-US` | language code |
| `SAMPLE_RATE` | `16000` | must match the model |
| `AUTO_PUNCT` | `true` | automatic punctuation |
| `ASR_DIARIZATION` | `true` | speaker labels (needs the sortformer model) |
| `ASR_MAX_SPEAKERS` | `8` | diarization speaker cap |
| `ASR_ENDPOINTING` | `false` | `true` = VAD segmentation; `false` = timed commits |
| `EOU_STOP_HISTORY` / `EOU_STOP_THRESHOLD` | `800` / `0.98` | endpointing: silence to finalize |
| `EOU_START_HISTORY` / `EOU_START_THRESHOLD` | `300` / `0.2` | endpointing: speech-start detection |
| `COMMIT_INTERVAL_SEC` | `2.0` | commit cadence when endpointing is off |
| `DEBUG` | `false` | verbose per-frame / per-event logging |
| `DEBUG_AUDIO_DIR` | *(empty)* | if set, write forwarded PCM to a WAV there |

TLS (for serving the page over https, required for mic access off localhost):
set `SSL_CERT` and `SSL_KEY` in `GO` and it passes them to uvicorn.

## Using it

1. Open the page, allow microphone access.
2. Choose a mic, press **Start**, and speak.
3. Grey italic text is the live hypothesis; it becomes solid when the segment is
   finalized and appended. With diarization on, a new line labeled `Speaker N:`
   starts whenever the speaker changes.
4. **Copy** / **Download .txt** any time. The session runs until you press **Stop**.
5. **Save WAV** downloads exactly what was captured (debugging).

## Deploying behind nginx

`deploy/nginx-asr.conf` exposes the NIM under an `/asr/` route with the
WebSocket upgrade headers and long read timeouts required for multi-hour
streaming. Put the `map $http_upgrade …` block in the `http{}` context, adjust
the hostname/cert/upstream port, then `nginx -t && nginx -s reload`.

## Notes on "runs indefinitely"

- The browser→proxy socket is kept alive with WebSocket pings and auto-reconnects
  if it drops while running.
- The proxy→NIM session auto-reconnects with backoff; a brief gap may drop a few
  audio frames but the accumulated transcript is never lost.
- Audio is buffered with a bounded, drop-oldest queue so latency can't grow
  unbounded during a reconnect.

## Files

```
GO                      # launcher: all settings, then `./GO`
server.py               # proxy: reconnect, commit/endpointing, diarization, flush, debug
static/index.html       # UI
static/app.js           # capture, stream, render, copy/download/WAV
static/pcm-worklet.js   # 16 kHz Int16 PCM resampler (audio thread)
deploy/nginx-asr.conf   # WebSocket reverse-proxy for the /asr route
requirements.txt
```
