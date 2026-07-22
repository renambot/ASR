# EVL ASR — project guide

Live speech-to-text web app: browser mic → Python proxy (FastAPI) → NVIDIA NIM
(Riva), with optional LLM analyzers. Architecture, API, and deployment are
documented in `docs/architecture.md` (also published to the GitHub wiki) and
`README.md` — keep those current when behavior changes.

## Branches

- `main` — the deployable app.
- `sdk` — adds `packages/asr-client` (headless browser SDK, BSD-3) and
  refactors the app to be its reference consumer. Merge pending live testing.

## Running & verifying

- Run: `./GO` (all settings at the top). Docker: `docker compose up -d --build`.
- **Secrets live in git-ignored `GO.local` / `.env`** (see the `.example`
  files) — never in `GO`, compose, or any tracked file. Before committing,
  scan the staged diff for keys.
- Endpoint tests: `.venv/bin/uvicorn server:app --port <p>` + curl (use a
  scratch copy for `ANALYZERS_CONFIG` when a test mutates it).
- UI verification without a NIM: headless Chrome (`--headless --screenshot` /
  `--dump-dom`) against the live server, plus **probe pages**: copy `static/`
  (and `sdk/`) into a scratch dir mirroring the served URL layout, inject a
  `<script>` that runs checks and writes PASS/FAIL into `document.title`, then
  grep the dumped DOM. Transcript events can be simulated with
  `asr._handleMessage({type: "final", text, speaker})`.
- Headless Chrome floors the window width at ~500px — for narrower layouts,
  force `document.body.style.width` inside the page.
- Real ASR/LLM flows need the deployed NIM + LLM endpoint; always state
  explicitly what was and wasn't exercised.

## Conventions

- Commits: imperative subject + a short "why" body. Commit/push only when
  asked.
- The GitHub **wiki tracks `main`** and is generated from
  `docs/architecture.md` (fix the relative README links, push `Home.md` to
  `ASR.wiki.git`). Edit `docs/architecture.md`, never the wiki directly.
- Frontend: `static/js/*.js` are **ordered classic scripts sharing one global
  scope** — keep the load order in `index.html`; don't convert to ES modules
  casually. `BASE` in `core.js` is deliberately hardcoded to the deployed
  sub-path.
- On the `sdk` branch, capture/WS/transcript logic belongs in
  `packages/asr-client` (rebuild `dist/` with `npm run build` after editing
  `src/`); `static/js/` is UI only.
- Backend: **single uvicorn worker only** — `_active_sessions` and the
  analyzer registry are in-process state. Scale via `MAX_SESSIONS` or more
  instances, never `--workers`.

## Gotchas learned the hard way

- The `hidden` attribute loses to any author `display:` rule — pair
  `[hidden] { display: none; }` with such elements.
- Flex scrolling: a scrollable flex child needs `min-height: 0`, and cards
  with `overflow: hidden` need `flex: 0 0 auto` or flex shrinks them to
  nothing instead of overflowing.
- Media queries add no specificity — mobile overrides must appear *after* the
  base rules in the stylesheet.
- macOS screenshot filenames contain a U+202F narrow space before "AM/PM" —
  match them with a glob, don't type the name.
- The current NIM model does **not** support VAD endpointing: with
  `ASR_ENDPOINTING=true` transcripts only appear on Stop. It stays `false`
  (timed commits); the backend plumbing is kept for a future model.
- Analyzers are per-session: the `/ws` `analyzers` param defaults **on** when
  absent (app/back-compat) but the SDK sends `analyzers=0` unless the
  consumer opts in.
