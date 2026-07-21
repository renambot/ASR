# EVL ASR — browser mic → NVIDIA NIM (Riva) realtime ASR

A minimal web app for **indefinite live speech-to-text**. Pick a microphone in
the browser, stream audio to your NVIDIA ASR NIM, and watch an append-only
transcript grow — talk for hours, then copy it or export the meeting as
Markdown. Optional speaker diarization labels who is talking (with renamable
speakers), background LLM analyzers surface topics/summaries live, and an AI
summary runs on demand.

![EVL ASR — live transcript with speaker labels, the Analysis panel, and the Admin analyzer editor](docs/screenshot.jpg)

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

### Or run with Docker

All the settings from `GO` are environment variables, so the proxy runs
unchanged in a container. Edit the `environment:` block in
`docker-compose.yml` (NIM host/port/path, model, diarization, …). For secrets
(API keys, endpoints), copy `.env.example` to **`.env`** (git-ignored) — docker
compose auto-loads it and substitutes the values in. Then:

```sh
docker compose up -d --build
```

Then open <http://localhost:8080>. For TLS (mic access off localhost),
either mount a cert/key and set `SSL_CERT`/`SSL_KEY` (see the commented
lines in `docker-compose.yml`), or terminate TLS with nginx in front.

## Configure and run

All settings live at the top of the **`GO`** launcher script — edit them and run
`./GO` (no environment setup needed):

```sh
./GO
```

Then open **http://localhost:8080**.

**Keep secrets out of git:** `GO` is committed, so don't put real keys in it.
Copy `GO.local.example` to **`GO.local`** (git-ignored) and put your
`LLM_API_KEY`, endpoints, etc. there — `GO` sources it and its values override
the defaults.

### Settings (in `GO`)

| Variable | Default | Notes |
|---|---|---|
| `NIM_SCHEME` | `wss` | `ws` or `wss` |
| `NIM_HOST` | `arcade.evl.uic.edu` | host of your ASR NIM (or nginx front door) |
| `NIM_PORT` | `443` | `443` via nginx, or `9000`/`7777` direct to the NIM |
| `NIM_PATH` | `/asr/v1/realtime` | `/v1/realtime` if hitting the NIM directly |
| `NIM_INTENT` | `transcription` | realtime intent sent to the NIM |
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
| `COMMIT_INTERVAL_SEC` | `0.75` | commit cadence when endpointing is off; lower = snappier |
| `MAX_SESSIONS` | `20` | max simultaneous browser sessions; extra visitors get a "server at capacity" notice (0 = unlimited) |
| `AUDIO_QUEUE_MAX` | `100` | bounded, drop-oldest audio queue depth (caps latency during a reconnect) |
| `LLM_BASE_URL` | *(empty)* | OpenAI-compatible endpoint (e.g. vLLM) powering the **AI Summary** button and the background **analyzers**; empty = both features off |
| `LLM_MODEL` / `LLM_API_KEY` | *(empty)* | model name and optional bearer token for that endpoint |
| `LLM_SYSTEM_PROMPT` | *(built-in)* | fallback prompt for AI Summary when no "Meeting Summary" analyzer exists (default: summary + action items) |
| `LLM_TEMPERATURE` / `LLM_MAX_TOKENS` / `LLM_TIMEOUT_SEC` | `0.2` / `1024` / `120` | generation settings |
| `ANALYZERS_CONFIG` | `./analyzers.json` | JSON file with the default background analyzer prompts (max 5). Each runs on a schedule chosen in the Admin tab: every N minutes, chained after the previous prompt (receiving its output as context), or once when the recording stops |
| `ANALYZER_MIN_CHARS` | `40` | the periodic analyzers wait until the transcript has at least this many characters before running (avoids firing on an empty meeting) |
| `ADMIN_TOKEN` | *(empty)* | shared secret for the Admin tab / `/admin/analyzers` endpoints; empty = open |
| `BASE_PATH` | *(empty)* | serve the whole app (page, static, `/ws`, `/config`, `/llm`, `/admin`) under a sub-path, e.g. `/asr`, for reverse-proxy deployments; empty = root. The proxy must forward the path unchanged (do not strip the prefix) |
| `DEBUG` | `false` | verbose per-frame / per-event logging |
| `DEBUG_AUDIO_DIR` | *(empty)* | if set, write forwarded PCM to a WAV there |

TLS (for serving the page over https, required for mic access off localhost):
set `SSL_CERT` and `SSL_KEY` in `GO` and it passes them to uvicorn.

## Using it

1. Open the page, allow microphone access. Optionally type a **Meeting title**
   (it's added to the top of exports).
2. Choose a mic, press **Start**, and speak. **Pause/Resume** stops sending
   audio without ending the session; the transcript continues on resume.
3. Grey italic text is the live hypothesis; it becomes solid when the segment is
   finalized and appended. With diarization on, a new line labeled `Speaker N:`
   starts whenever the speaker changes.
4. **Copy** or **Download .md** any time. The Markdown export is ordered:
   title + date → AI summary → analyses → full transcript. The session runs
   until you press **Stop**.
5. **Save WAV** downloads exactly what was captured (debugging).

### Side panel and analyzers (when an LLM is configured)

- **Speakers tab** — rename each `Speaker N`; names replace the label
  everywhere, including exports and the analyzers.
- **Analysis panel** (bottom of the transcript) — shows results from the
  background **analyzers** that run on a schedule during the meeting.
- **Admin tab** — edit the analyzer prompts and schedules (fold/reorder rows;
  order matters for chaining). **Run** one or **Run all now** on demand (works
  during, paused, or after recording), **Save** to persist (also cached in this
  browser), or **Reset to server defaults**.
- **AI Summary** button (footer) — runs the "Meeting Summary" analyzer over the
  transcript on demand. The footer's **AI** dot turns purple while any AI runs.

## Deploying behind nginx

`deploy/nginx-asr.conf` exposes the NIM under an `/asr/` route with the
WebSocket upgrade headers and long read timeouts required for multi-hour
streaming. Put the `map $http_upgrade …` block in the `http{}` context, adjust
the hostname/cert/upstream port, then `nginx -t && nginx -s reload`.

### Serving the app under a sub-path

Set `BASE_PATH` (e.g. `/live-asr`) and forward the path **unchanged** — do not
strip the prefix (note there is no trailing slash on `proxy_pass`):

```nginx
location /live-asr/ {
    proxy_pass http://127.0.0.1:8080;   # no trailing slash: keeps the /live-asr prefix
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;   # WebSocket (/live-asr/ws)
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host       $host;
    proxy_read_timeout 3600s;
}
```

The server then serves the page, static assets, `/ws`, `/config`, `/llm` and
`/admin` all under `/live-asr`, and redirects `/` there.

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
GO.local.example        # copy to GO.local (git-ignored) for secrets/overrides
server.py               # proxy: reconnect, commit/endpointing, diarization,
                        #   analyzers, LLM (/llm, /analyze), admin, static hosting
static/index.html       # UI (markup + all CSS)
static/app.js           # capture, stream, render, exports, analyzers, panels
static/pcm-worklet.js   # 16 kHz Int16 PCM resampler (audio thread)
analyzers.json          # default background-analyzer prompts and schedules
Dockerfile              # container image
docker-compose.yml      # containerized deployment (reads .env)
docker-entrypoint.sh    # container entrypoint (PORT/TLS)
.env.example            # copy to .env (git-ignored) for Docker secrets
deploy/nginx-asr.conf   # WebSocket reverse-proxy for the /asr route
docs/architecture.md    # architecture / code / UI / deployment guide (also the wiki)
requirements.txt
```
