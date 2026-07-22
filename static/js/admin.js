// admin.js — Analysis tab: analyzer editor, persistence, run-now/run-all.
// Loaded as an ordered classic script (shared global scope); see index.html.
// ---- Admin tab -------------------------------------------------------------
// Edits the server-side analyzer registry (GET/PUT /admin/analyzers). Defaults
// come from analyzers.json on the server; saving applies immediately to
// running sessions and persists back to that file when writable.
let adminLoaded = false;

function adminHeaders() {
  const h = { "Content-Type": "application/json" };
  if (els.adminToken.value) h["X-Admin-Token"] = els.adminToken.value;
  return h;
}

const SCHEDULE_INTERVALS = [1, 2, 5, 10, 15, 30]; // minutes
const MAX_ANALYZERS = 5;

// Drag-to-reorder for the Admin analyzer rows. collectAnalyzers() reads order
// from the DOM, so a reordered list persists (localStorage + server) on Save.
let draggedItem = null;
function getDragAfterElement(container, y) {
  const rows = [...container.querySelectorAll(".admin-item:not(.dragging)")];
  let closest = { offset: -Infinity, el: null };
  for (const el of rows) {
    const box = el.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, el };
  }
  return closest.el;
}
els.adminList.addEventListener("dragover", (e) => {
  if (!draggedItem) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const after = getDragAfterElement(els.adminList, e.clientY);
  if (after == null) els.adminList.appendChild(draggedItem);
  else els.adminList.insertBefore(draggedItem, after);
});
els.adminList.addEventListener("drop", (e) => e.preventDefault());

function adminItemRow(a) {
  const item = document.createElement("div");
  item.className = "admin-item";
  item.dataset.id = a.id || "";

  // --- header: drag handle, fold caret, name (stays visible when collapsed) --
  const head = document.createElement("div");
  head.className = "admin-head";

  const handle = document.createElement("span");
  handle.className = "drag-handle";
  handle.textContent = "⠿";
  handle.title = "Drag to reorder";
  handle.draggable = true;
  handle.addEventListener("dragstart", (e) => {
    draggedItem = item;
    item.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", ""); } catch { /* Firefox needs data */ }
  });
  handle.addEventListener("dragend", () => {
    item.classList.remove("dragging");
    draggedItem = null;
  });

  const fold = document.createElement("button");
  fold.type = "button";
  fold.className = "fold";
  fold.title = "Collapse / expand";
  fold.textContent = "▾";
  fold.onclick = () => {
    const collapsed = item.classList.toggle("collapsed");
    fold.textContent = collapsed ? "▸" : "▾";
  };

  const name = document.createElement("input");
  name.type = "text";
  name.placeholder = "Name";
  name.value = a.name || "";
  name.dataset.field = "name";

  const run = document.createElement("button");
  run.type = "button";
  run.className = "run-now";
  run.textContent = "Run";
  run.title = "Run this analyzer now on the current transcript";
  run.onclick = () => runAnalyzers([collectAnalyzerItem(item)]);

  head.appendChild(handle);
  head.appendChild(fold);
  head.appendChild(name);
  head.appendChild(run);

  // --- body: prompt + schedule row (hidden when collapsed) -----------------
  const body = document.createElement("div");
  body.className = "admin-body";

  const prompt = document.createElement("textarea");
  prompt.placeholder = "Prompt (system message; the transcript is the user message)";
  prompt.value = a.prompt || "";
  prompt.dataset.field = "prompt";

  const row = document.createElement("div");
  row.className = "row";

  // Schedule selector: fixed cadence in minutes, chained after the previous
  // prompt in the list, or once when the recording stops.
  const runLabel = document.createElement("span");
  runLabel.textContent = "runs";
  const sched = document.createElement("select");
  sched.dataset.field = "schedule";
  const mins = new Set(SCHEDULE_INTERVALS);
  if (a.mode === "interval" || a.mode === undefined) mins.add(a.interval_min ?? 5);
  [...mins].sort((x, y) => x - y).forEach((m) => {
    const o = document.createElement("option");
    o.value = String(m);
    o.textContent = m === 1 ? "every 1 min" : `every ${m} min`;
    sched.appendChild(o);
  });
  const oChain = document.createElement("option");
  oChain.value = "chain";
  oChain.textContent = "after previous prompt";
  const oStop = document.createElement("option");
  oStop.value = "on_stop";
  oStop.textContent = "when recording stops";
  sched.appendChild(oChain);
  sched.appendChild(oStop);
  sched.value = a.mode === "chain" ? "chain"
    : a.mode === "on_stop" ? "on_stop"
    : String(a.interval_min ?? 5);
  row.appendChild(runLabel);
  row.appendChild(sched);

  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = a.enabled !== false;
  enabled.dataset.field = "enabled";
  const enLabel = document.createElement("label");
  enLabel.style.display = "flex";
  enLabel.style.alignItems = "center";
  enLabel.style.gap = "4px";
  enLabel.appendChild(enabled);
  enLabel.appendChild(document.createTextNode("on"));
  row.appendChild(enLabel);

  const del = document.createElement("button");
  del.className = "del";
  del.textContent = "Delete";
  del.onclick = () => { item.remove(); syncAddButton(); };
  row.appendChild(del);

  body.appendChild(prompt);
  body.appendChild(row);
  item.appendChild(head);
  item.appendChild(body);
  return item;
}

function syncAddButton() {
  const n = els.adminList.querySelectorAll(".admin-item").length;
  els.adminAdd.disabled = n >= MAX_ANALYZERS;
  els.adminAdd.textContent = n >= MAX_ANALYZERS
    ? `Max ${MAX_ANALYZERS} prompts` : "+ Add analyzer";
}

// Persist the analyzer set in this browser so it survives server restarts and
// is restored session to session. localStorage is the client's source of
// truth; on load we re-apply it to the server (which is what actually runs the
// analyzers), and every Save writes it back here.
const ANALYZERS_LS_KEY = "asr.analyzers.v1";

function readStoredAnalyzers() {
  try {
    const a = JSON.parse(localStorage.getItem(ANALYZERS_LS_KEY) || "null");
    return Array.isArray(a) && a.length ? a : null;
  } catch { return null; }
}

function writeStoredAnalyzers(analyzers) {
  try { localStorage.setItem(ANALYZERS_LS_KEY, JSON.stringify(analyzers)); } catch {}
}

// Read one Admin editor row into an analyzer definition.
function collectAnalyzerItem(item) {
  const slug = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const get = (f) => item.querySelector(`[data-field="${f}"]`);
  const name = get("name").value.trim();
  const sched = get("schedule").value;
  const isInterval = sched !== "chain" && sched !== "on_stop";
  return {
    id: item.dataset.id || slug(name) || undefined,
    name,
    prompt: get("prompt").value.trim(),
    mode: isInterval ? "interval" : sched,
    interval_min: isInterval ? Number(sched) : 5,
    enabled: get("enabled").checked,
  };
}

// Read the analyzer definitions out of all Admin editor rows.
function collectAnalyzers() {
  return [...els.adminList.querySelectorAll(".admin-item")].map(collectAnalyzerItem);
}

// Timestamped, name-applied transcript for analyzers ("[MM:SS] Label: text"),
// mirroring the server's format so prompts (e.g. Speakers) can cite times.
function analyzerTranscript() {
  return asr.transcriptText({ timestamps: true });
}

// Force-run analyzers now on the current transcript. Stateless (POST /analyze),
// so it works during, paused, or after recording; results render in the panel.
async function runAnalyzers(list) {
  const items = list.filter((a) => a.prompt);
  if (!items.length) { els.adminStatus.textContent = "Nothing to run (empty prompt)."; return; }
  const text = analyzerTranscript().trim();
  if (!text) { els.adminStatus.textContent = "No transcript to analyze yet."; return; }
  els.adminStatus.textContent = items.length === 1
    ? `Running “${items[0].name || items[0].id}”…`
    : `Running ${items.length} analyzer(s)…`;
  aiClientCount++; updateAiIndicator();
  try {
    const resp = await fetch(`analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, analyzers: items }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    (data.results || []).forEach((r) => renderAnalysis({ ...r, ts: Date.now() / 1000 }));
    els.adminStatus.textContent = `Ran ${(data.results || []).length} analyzer(s).`;
  } catch (e) {
    els.adminStatus.textContent = `Run failed: ${e.message}`;
  } finally {
    aiClientCount--; updateAiIndicator();
  }
}

// PUT the analyzer set to the server; returns the server-normalized result.
async function pushAnalyzers(analyzers) {
  const resp = await fetch(`admin/analyzers`, {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify({ analyzers }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

async function loadAdmin() {
  if (adminLoaded) return;
  els.adminStatus.textContent = "Loading…";
  const stored = readStoredAnalyzers();
  try {
    const resp = await fetch(`admin/analyzers`, { headers: adminHeaders() });
    if (resp.status === 401) {
      els.adminAuth.hidden = false;
      els.adminStatus.textContent = "Enter the admin token, then reopen this tab.";
      return;
    }
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    els.adminAuth.hidden = !data.auth_required;

    let analyzers = data.analyzers;
    let restored = false;
    if (stored) {
      // This browser has a saved set: re-apply it so the server runs it, and
      // show the normalized result. Fall back to showing the stored set if the
      // apply fails (e.g. missing admin token).
      try {
        analyzers = (await pushAnalyzers(stored)).analyzers;
      } catch {
        analyzers = stored;
      }
      writeStoredAnalyzers(analyzers);
      restored = true;
    } else {
      writeStoredAnalyzers(data.analyzers); // seed the store from server defaults
    }

    els.adminList.textContent = "";
    analyzers.forEach((a) => els.adminList.appendChild(adminItemRow(a)));
    syncAddButton();
    els.adminStatus.textContent = !data.llm
      ? "Warning: no LLM configured on the server — analyzers will not run."
      : restored
        ? `${analyzers.length} analyzer(s) restored from this browser.`
        : `${analyzers.length} analyzer(s) loaded.`;
    adminLoaded = true;
  } catch (e) {
    els.adminStatus.textContent = `Load failed: ${e.message}`;
  }
}

// Token edits should retrigger a load on next open.
els.adminToken.addEventListener("input", () => { adminLoaded = false; });

els.adminAdd.onclick = () => {
  els.adminList.appendChild(adminItemRow({
    id: "", name: "", prompt: "", mode: "interval", interval_min: 5,
    enabled: true,
  }));
  syncAddButton();
};

els.adminSave.onclick = async () => {
  const analyzers = collectAnalyzers();
  els.adminSave.disabled = true;
  els.adminStatus.textContent = "Saving…";
  try {
    const data = await pushAnalyzers(analyzers);
    writeStoredAnalyzers(data.analyzers); // persist this browser's copy
    els.adminStatus.textContent = data.saved
      ? "Saved (applies now; kept in this browser + server config file)."
      : "Saved (applies now; kept in this browser).";
    els.adminList.textContent = "";
    data.analyzers.forEach((a) => els.adminList.appendChild(adminItemRow(a)));
    syncAddButton();
    adminLoaded = true;
  } catch (e) {
    els.adminStatus.textContent = `Save failed: ${e.message}`;
  } finally {
    els.adminSave.disabled = false;
  }
};

els.adminRunAll.onclick = () => runAnalyzers(collectAnalyzers());

// Discard this browser's saved analyzers and reload the server's defaults
// (re-read from the server's config file). Clears localStorage so the browser
// no longer overrides the defaults.
els.adminReset.onclick = async () => {
  if (!confirm("Reset to the server's default analyzers? This discards this browser's saved set.")) return;
  els.adminReset.disabled = true;
  els.adminStatus.textContent = "Resetting…";
  try {
    const resp = await fetch(`admin/analyzers/reset`, { method: "POST", headers: adminHeaders() });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    try { localStorage.removeItem(ANALYZERS_LS_KEY); } catch {}
    els.adminList.textContent = "";
    data.analyzers.forEach((a) => els.adminList.appendChild(adminItemRow(a)));
    syncAddButton();
    adminLoaded = true;
    els.adminStatus.textContent = `Reset to ${data.analyzers.length} server default(s).`;
  } catch (e) {
    els.adminStatus.textContent = `Reset failed: ${e.message}`;
  } finally {
    els.adminReset.disabled = false;
  }
};

