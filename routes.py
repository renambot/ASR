"""FastAPI app: WebSocket endpoint, HTTP API, and static hosting."""

import json

from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

import analyzers
from analyzers import _validate_analyzers, load_analyzers, save_analyzers
from bridge import Bridge, send_json
from config import (ADMIN_TOKEN, ASR_LANGUAGE, ASR_MODEL, AUTO_PUNCT, BASE_PATH,
                    DIARIZATION, ENDPOINTING, LLM_BASE_URL, LLM_MODEL,
                    LLM_SYSTEM_PROMPT, MAX_SESSIONS, MAX_SPEAKERS, SAMPLE_RATE,
                    SDK_DIR, STATIC_DIR, log)
from llm import chain_suffix, llm_chat

app = FastAPI(title="EVL ASR Proxy")


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
        "llm_model": LLM_MODEL,         # model the analyzers / AI Summary use ("" = endpoint default)
        "sessions": _active_sessions,   # live browser sessions the server is handling
        # Per-connection ASR defaults (the client can override these per session).
        "diarization": DIARIZATION,
        "max_speakers": MAX_SPEAKERS,
        "auto_punct": AUTO_PUNCT,
        "endpointing": ENDPOINTING,
    }


def _admin_auth_error(request: Request):
    """Return an error response if the admin token is required and wrong."""
    if ADMIN_TOKEN and request.headers.get("x-admin-token", "") != ADMIN_TOKEN:
        return JSONResponse({"error": "Invalid or missing admin token."}, status_code=401)
    return None


@app.get("/admin/analyzers")
async def admin_get_analyzers(request: Request):
    err = _admin_auth_error(request)
    if err:
        return err
    return {"analyzers": analyzers.get_all(), "llm": bool(LLM_BASE_URL),
            "auth_required": bool(ADMIN_TOKEN)}


@app.put("/admin/analyzers")
async def admin_put_analyzers(request: Request):
    """Replace the analyzer set. Applies immediately to running sessions
    (the per-session loop reads the registry each tick) and is persisted
    back to the config file on a best-effort basis."""
    err = _admin_auth_error(request)
    if err:
        return err
    try:
        payload = await request.json()
        new = _validate_analyzers(payload.get("analyzers"))
    except (json.JSONDecodeError, ValueError) as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    analyzers.replace(new)
    saved = save_analyzers()
    log.info("Admin updated analyzers: %d item(s), persisted=%s", len(new), saved)
    return {"ok": True, "saved": saved, "analyzers": analyzers.get_all()}


@app.post("/admin/analyzers/reset")
async def admin_reset_analyzers(request: Request):
    """Reload the analyzer registry from the on-disk config file (the server
    defaults), discarding the current in-memory set."""
    err = _admin_auth_error(request)
    if err:
        return err
    load_analyzers()
    log.info("Admin reset analyzers to server defaults: %d item(s)",
             len(analyzers.get_all()))
    return {"ok": True, "analyzers": analyzers.get_all(), "llm": bool(LLM_BASE_URL),
            "auth_required": bool(ADMIN_TOKEN)}


@app.post("/llm")
async def llm_process(payload: dict):
    """Run the transcript through the configured LLM and return the result.

    Body: {"text": "<transcript>",
           "analyzer": "<optional analyzer name or id>",
           "instruction": "<optional prompt override>"}
    If `analyzer` is given and matches a configured analyzer (by name or id),
    that analyzer's prompt is used — so the AI Summary button can run the
    "Meeting Summary" analysis on demand. Otherwise `instruction`, else the
    server default. The endpoint, key, and prompts are all server-side.
    """
    if not LLM_BASE_URL:
        return JSONResponse({"error": "No LLM configured on the server."}, status_code=503)
    text = (payload.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "Empty transcript."}, status_code=400)
    want = (payload.get("analyzer") or "").strip()
    match = None
    if want:
        match = next((a for a in analyzers.get_all()
                      if a["name"].strip().lower() == want.lower() or a["id"] == want), None)
    if match is not None:
        system = match["prompt"]
    else:
        system = (payload.get("instruction") or "").strip() or LLM_SYSTEM_PROMPT
    try:
        out = await llm_chat(system, text)
    except RuntimeError as exc:
        return JSONResponse({"error": str(exc)}, status_code=502)
    if match is not None:
        out["analyzer"] = match["name"]
    log.info("LLM processed %d chars -> %d chars (model=%s, analyzer=%s)",
             len(text), len(out["result"]), out["model"] or "?",
             match["name"] if match else "-")
    return out


@app.post("/analyze")
async def analyze(payload: dict):
    """Run one or more analyzer prompts against a client-supplied transcript
    and return their results. Stateless (no session needed), so the Admin
    "Run now" / "Run all" buttons work during, paused, or after recording.

    Body: {"text": "<transcript>", "analyzers": [{id,name,prompt,mode}, ...]}
    Honors 'chain' ordering (an analyzer's output is fed to the next chained
    one). Returns {"results": [{id, name, result|error}, ...]}.
    """
    if not LLM_BASE_URL:
        return JSONResponse({"error": "No LLM configured on the server."}, status_code=503)
    text = (payload.get("text") or "").strip()
    prompt_list = payload.get("analyzers")  # renamed: `analyzers` is the module
    if not text:
        return JSONResponse({"error": "Empty transcript."}, status_code=400)
    if not isinstance(prompt_list, list) or not prompt_list:
        return JSONResponse({"error": "No analyzers given."}, status_code=400)
    results = []
    prev_ran, prev_name, prev_result = False, None, None
    for a in prompt_list:
        if not isinstance(a, dict):
            prev_ran = False
            continue
        name = str(a.get("name") or "Analyzer")
        aid = str(a.get("id") or name)
        prompt = str(a.get("prompt") or "").strip()
        mode = str(a.get("mode") or "interval")
        if not prompt:
            prev_ran = False
            continue
        user = text
        if mode == "chain" and prev_ran and prev_result is not None:
            user += chain_suffix(prev_name, prev_result)
        try:
            out = await llm_chat(prompt, user)
        except RuntimeError as exc:
            results.append({"id": aid, "name": name, "error": str(exc)})
            prev_ran = False
            continue
        results.append({"id": aid, "name": name, "result": out["result"]})
        prev_ran, prev_name, prev_result = True, name, out["result"]
    log.info("analyze: ran %d analyzer(s) over %d chars", len(results), len(text))
    return {"results": results}


@app.get("/")
async def index():
    """Serve the page, injecting BASE_PATH so the client builds correctly
    prefixed URLs (WebSocket, /config, /llm, /admin) and loads its own static
    assets from the right place when deployed under a sub-path."""
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    if BASE_PATH:
        html = html.replace("/static/", f"{BASE_PATH}/static/")
    html = html.replace(
        "<head>",
        f'<head>\n  <script>window.__BASE__ = "{BASE_PATH}";</script>',
        1,
    )
    return HTMLResponse(html)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
# The headless client SDK (packages/asr-client), served so the app and any
# embedding page can load it from the proxy at /sdk/asr-client.js.
app.mount("/sdk", StaticFiles(directory=SDK_DIR), name="sdk")

# When a BASE_PATH is configured, re-home the entire app under that prefix so
# it can be served from a sub-path behind a reverse proxy. All routes above
# were registered on `app`; we mount that under BASE_PATH on a fresh parent and
# rebind `app` (uvicorn imports `server:app` after this module finishes).
if BASE_PATH:
    _root = FastAPI(title="EVL ASR Proxy (root)")
    _root.mount(BASE_PATH, app)

    @_root.get("/")
    async def _redirect_to_base():
        return RedirectResponse(url=f"{BASE_PATH}/")

    app = _root
