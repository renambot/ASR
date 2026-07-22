# @evl/asr-client

Headless browser client for an **EVL ASR proxy** ([renambot/ASR](https://github.com/renambot/ASR)):
live microphone speech-to-text with optional speaker diarization, delivered as
events. No DOM, no CSS, no framework, no dependencies — you build the UI.

The heavy lifting (NVIDIA NIM/Riva session, reconnection, API keys, background
LLM analyzers) lives in the proxy; this client captures the mic, streams
16 kHz PCM over a WebSocket, and hands you transcript events.

## Install / load

Classic script (sets `window.AsrClient`; also served by the proxy at `/sdk/asr-client.js`,
or use the minified `dist/asr-client.min.js`):

```html
<script src="https://your-proxy-host/speech/sdk/asr-client.js"></script>
```

ES modules / bundlers (TypeScript definitions included):

```js
import AsrClient from "@evl/asr-client";   // dist/asr-client.mjs
```

CommonJS: `const AsrClient = require("@evl/asr-client");`

To rebuild `dist/` after editing the source: `npm install && npm run build`
(esbuild; the `src/` file itself needs no build step).

## Quick start

```js
// Pick a microphone (optional — omit deviceId for the system default).
// Note: browsers only reveal device labels after a mic permission grant.
const mics = await AsrClient.listMicrophones();   // [{deviceId, label}]

const asr = new AsrClient({
  serverUrl: "https://your-proxy-host/speech",  // "" if served by the proxy itself
  deviceId: mics[0].deviceId,
  diarization: true,
  maxSpeakers: 3,
});

asr.on("interim", (text) => hypothesisEl.textContent = text);
asr.on("segment", (seg) => addLine(asr.speakerLabel(seg.speaker), seg.text));
asr.on("status", (state) => console.log("ASR:", state));

await asr.start();     // asks for mic permission, starts streaming
// ... later:
asr.pause();           // stop sending audio, keep the session open
asr.resume();
await asr.stop();      // flush, let end-of-meeting analyzers run, tear down

// Switch mics between sessions:
asr.configure({ deviceId: mics[1].deviceId });    // applies on the next start()
```

## Options (constructor / `configure()`)

| Option | Default | Notes |
|---|---|---|
| `serverUrl` | *(required)* | Proxy base URL: `"https://host/path"`, `"/path"`, or `""` (same origin) |
| `diarization` | server default | Label speakers |
| `maxSpeakers` | server default | 1–8, used when diarization is on |
| `punctuation` | server default | Automatic punctuation |
| `deviceId` | system default | From `AsrClient.listMicrophones()` |
| `echoCancellation` | `true` | Mic processing |
| `noiseSuppression` | `true` | Mic processing |
| `autoGain` | `false` | Off by default: AGC distorts diarization cues |
| `reconnect` | `true` | Auto-reconnect while running |
| `captureAudio` | `false` | Keep streamed PCM so `getWav()` works (~10 min cap) |
| `workletUrl` | inlined | Override if your CSP forbids `blob:` scripts |
| `analyzers` | `false` | **Opt in** to the proxy's background analyzers (topics, summaries, …) for this session; results arrive as `analysis` events. Off by default so your page doesn't silently trigger server-side LLM calls |

ASR/mic options apply on the next `start()`. `configure(partial)` merges options.

## Events (`on(event, fn)` → returns unsubscribe; `off(event, fn)`)

| Event | Payload | Meaning |
|---|---|---|
| `interim` | `text` | Live hypothesis (replace-style) |
| `segment` | `{text, speaker, tMs}` | Finalized segment; `speaker` is an id string or `null` |
| `speaker` | `id` | A new speaker id appeared |
| `status` | `state, message?` | `idle · connecting · listening · paused · reconnecting · finalizing · full · error · closed` |
| `analysis` | `{id, name, result\|error, ts}` | Pushed by the proxy's background analyzers, if configured |
| `ai_running` | `boolean` | A server-side LLM call is in flight |
| `error` | `Error` | ASR error reported by the proxy |

## Methods & properties

- `start()` / `pause()` / `resume()` / `stop()` / `dispose()`
- `setSpeakerName(id, name)` — also syncs to the proxy so analyzers use it
- `speakerLabel(id)` — custom name or `"Speaker N"`
- `transcriptText({timestamps, names})` — composed transcript; with
  `timestamps: true` each segment becomes `[MM:SS] Label: text`
- `clear({names})` — reset the transcript (and optionally the speaker names)
- `getWav()` — `Blob` of the streamed audio (`captureAudio: true`), else `null`
- `serverInfo()` — the proxy's `/config` (defaults, LLM availability, sessions)
- `AsrClient.listMicrophones()` — `[{deviceId, label}]`
- `segments` (read-only), `interim`, `running`, `paused`, `elapsedMs`,
  `sampleRate`, `speakerNames`

## Notes

- **A proxy is required.** Browsers can't talk to the NIM directly; deploy the
  ASR proxy from the main repo and point `serverUrl` at it.
- **Cross-origin embedding:** set `ALLOWED_ORIGINS` on the proxy (e.g.
  `ALLOWED_ORIGINS="https://app.example.com"`) to allow pages on other origins;
  it enables CORS on the HTTP API and an Origin check on the WebSocket.
- `stop()` waits (bounded) for the proxy's end-of-meeting analyzers so their
  results arrive before the socket closes.

License: BSD-3-Clause.
