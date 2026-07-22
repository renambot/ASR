// ai.js — AI activity indicator, AI Summary button, session-count polling.
// Loaded as an ordered classic script (shared global scope); see index.html.
// ---- AI activity indicator -------------------------------------------------
// Purple + pulsing while any AI runs: client-initiated LLM calls (the AI
// Summary button) tracked by a counter, plus server-side background analyzers
// reported over the WebSocket ({type:"ai_running"}).
let aiClientCount = 0;   // in-flight client LLM requests
let aiServerRunning = false; // server analyzer currently running
let aiModel = "";        // LLM model the analyzers / AI Summary use
function updateAiIndicator() {
  const running = aiClientCount > 0 || aiServerRunning;
  els.aiActivity.classList.toggle("running", running);
  els.aiLabel.textContent = aiModel ? `AI: ${aiModel}` : "AI";
  els.aiActivity.title = aiModel
    ? `AI model: ${aiModel} — ${running ? "running…" : "idle"}`
    : (running ? "AI running…" : "AI idle");
}

// ---- LLM post-processing ---------------------------------------------------
// The server exposes POST /llm when an LLM endpoint is configured (see
// LLM_BASE_URL in GO / docker-compose.yml). The prompt, model, and API key
// all live server-side; the client just sends the current transcript (with
// any custom speaker names applied) and renders the result.
els.llm.onclick = async () => {
  const text = fullText();
  if (!text) {
    els.llm.textContent = "no transcript";
    setTimeout(() => (els.llm.textContent = "AI Summary"), 1500);
    return;
  }
  els.llm.disabled = true;
  els.llm.textContent = "Processing…";
  aiClientCount++; updateAiIndicator();
  try {
    const resp = await fetch(`llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Run the "Meeting Summary" analyzer's prompt; the server falls back to
      // its default summary prompt if no analyzer by that name is configured.
      body: JSON.stringify({ text, analyzer: "Meeting Summary" }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    els.llmResult.textContent = data.result;
    if (data.model) aiModel = data.model; // reflect the actual model in the footer
    const title = data.analyzer || "LLM output";
    els.llmTitle.textContent = data.model ? `${title} — ${data.model}` : title;
    els.llmPanel.hidden = false;
    els.llmPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    els.llmResult.textContent = `Error: ${e.message}`;
    els.llmTitle.textContent = "LLM output";
    els.llmPanel.hidden = false;
  } finally {
    els.llm.disabled = false;
    els.llm.textContent = "AI Summary";
    aiClientCount--; updateAiIndicator();
  }
};

els.llmCopy.onclick = async () => {
  try { await navigator.clipboard.writeText(els.llmResult.textContent); els.llmCopy.textContent = "Copied!"; }
  catch { els.llmCopy.textContent = "Copy failed"; }
  setTimeout(() => (els.llmCopy.textContent = "Copy"), 1500);
};

els.llmClose.onclick = () => { els.llmPanel.hidden = true; };

// Footer indicator of live sessions the server is currently handling.
function updateSessions(cfg) {
  const n = cfg && typeof cfg.sessions === "number" ? cfg.sessions : null;
  els.sessions.textContent = n === null ? "— sessions" : `${n} session${n === 1 ? "" : "s"}`;
}

// One /config fetch shows the AI Summary button and seeds the session count;
// then poll the count periodically (it changes slowly).
fetch(`config`)
  .then((r) => r.json())
  .then((cfg) => {
    if (cfg.llm) els.llm.hidden = false;
    if (cfg.llm_model) { aiModel = cfg.llm_model; updateAiIndicator(); }
    updateSessions(cfg);
    // First-time users (no saved settings): seed the ASR options from the
    // server's configured defaults so the Extras UI reflects reality.
    if (!hadSavedSettings) {
      if (typeof cfg.diarization === "boolean") settings.diarization = cfg.diarization;
      if (typeof cfg.max_speakers === "number") settings.maxSpeakers = cfg.max_speakers;
      if (typeof cfg.auto_punct === "boolean") settings.autoPunct = cfg.auto_punct;
      applySettingsToUI();
    }
  })
  .catch(() => {});
setInterval(() => {
  fetch(`config`).then((r) => r.json()).then(updateSessions).catch(() => {});
}, 5000);

