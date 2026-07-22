# Ideas & backlog

Living list of possible next steps and the reasoning behind settled decisions.

## SDK (`sdk` branch)

- **Publish `@evl/asr-client` to npm** — dist builds and types are ready;
  needs the `@evl` npm scope (or a rename) and a version/release routine.
- **`client.analyze(prompts)` / `summarize()`** (v1.1) — thin wrappers over
  the existing stateless `/analyze` and `/llm` endpoints for on-demand runs.
- **Web Component `<evl-asr>`** — drop-in UI on top of the headless SDK for
  consumers who don't want to build their own.
- **iframe embed + postMessage bridge** — zero-integration option.
- **Re-adopt `window.__BASE__`** in the app so it works at any `BASE_PATH`
  without editing `core.js` (the server already injects it).

## App / proxy

- **Access tokens for `/ws`** if the proxy is ever exposed beyond a trusted
  network (ALLOWED_ORIGINS gates browsers, not tools).
- **Rotate the LLM API key** — it was visible in plaintext during dev
  sessions (never committed).
- **GitHub social-preview image** — manual upload (Settings → Social
  preview); `docs/logo.png` works, or generate a 1280×640 card.
- Analyzer editor polish: persist fold state; Delete accessible from a
  collapsed row.
- Live-analysis panel: user-adjustable split height.

## Settled decisions (and why)

- **Endpointing (VAD) off** — the current NIM model never auto-finalizes, so
  enabling it stalls transcripts until Stop. Backend support kept for a
  future model; no UI toggle.
- **Analyzers are opt-in for SDK consumers** (`analyzers: false` default) —
  embedded pages must not silently trigger server-side LLM calls. The app
  opts in; absent param defaults on for back-compat.
- **Wiki tracks `main` only** — regenerated from `docs/architecture.md` at
  merge time.
- **Single uvicorn worker** — in-process session counter and analyzer
  registry; scale with `MAX_SESSIONS` or extra instances.
- **Proxy serves the readable SDK source** at `/sdk/asr-client.js` (not the
  minified build) — debuggability over ~10 KB.
- **`ASR_MAX_SPEAKERS=4`, AGC off, 1 s commits** — diarization tuning that
  matched typical meetings.
