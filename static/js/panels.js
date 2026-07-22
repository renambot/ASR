// panels.js — Side-panel tabs and Live-analysis result rendering.
// Loaded as an ordered classic script (shared global scope); see index.html.
// ---- Side panel tabs -------------------------------------------------------
document.querySelectorAll(".tabs .tab").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".tabs .tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-body").forEach((s) => (s.hidden = s.id !== `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab === "admin") loadAdmin();
  };
});

// ---- Analysis tab ----------------------------------------------------------
// The server runs the analyzer prompts in the background during a session and
// pushes {type:"analysis", id, name, result|error, ts} messages. One card per
// analyzer id, updated in place.
// The "Meeting Summary" analyzer (the end-of-meeting summary) is shown in the
// main transcript view (the LLM panel) rather than as a bottom Analysis card.
function isMeetingSummary(msg) {
  return (msg.name || "").trim().toLowerCase() === "meeting summary"
    || msg.id === "final-summary";
}

function showSummaryInMain(text) {
  els.llmResult.textContent = text;
  els.llmTitle.textContent = aiModel ? `Meeting Summary — ${aiModel}` : "Meeting Summary";
  els.llmPanel.hidden = false;
  els.llmPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderAnalysis(msg) {
  if (isMeetingSummary(msg) && !msg.error && msg.result) {
    // Surface it in the main view; drop any stale bottom card for it.
    const stale = els.analysisList.querySelector(`[data-analyzer="${CSS.escape(msg.id)}"]`);
    if (stale) stale.remove();
    showSummaryInMain(msg.result);
    return;
  }
  els.analysisEmpty.style.display = "none";
  let card = els.analysisList.querySelector(`[data-analyzer="${CSS.escape(msg.id)}"]`);
  if (!card) {
    card = document.createElement("div");
    card.className = "analysis-card";
    card.dataset.analyzer = msg.id;
    const head = document.createElement("div");
    head.className = "a-head";
    const name = document.createElement("span");
    name.className = "a-name";
    const time = document.createElement("span");
    time.className = "a-time";
    head.appendChild(name);
    head.appendChild(time);
    const body = document.createElement("div");
    body.className = "a-body";
    card.appendChild(head);
    card.appendChild(body);
    els.analysisList.appendChild(card);
  }
  card.querySelector(".a-name").textContent = msg.name || msg.id;
  card.querySelector(".a-time").textContent =
    new Date((msg.ts || Date.now() / 1000) * 1000).toLocaleTimeString();
  const body = card.querySelector(".a-body");
  body.textContent = msg.error ? `Error: ${msg.error}` : msg.result;
  body.classList.toggle("error", !!msg.error);
}

