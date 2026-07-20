// Live ASR front end.
// Captures the selected mic, streams 16 kHz Int16 PCM to the proxy over a
// WebSocket, and renders an append-only transcript that survives reconnects.
//
// Wire protocol with the proxy (JSON text, plus raw binary PCM frames up):
//   up   : binary Int16 PCM frames; {type:"flush"} / {type:"stop"} controls
//   down : {type:"interim", text}          -- live hypothesis (replace)
//          {type:"final", text, speaker?}  -- committed segment (append)
//          {type:"status", state}          -- connection state
//          {type:"error", message}

// Cached DOM element references.
const els = {
  mic: document.getElementById("mic"),
  refresh: document.getElementById("refresh"),
  toggle: document.getElementById("toggle"),
  dot: document.getElementById("dot"),
  state: document.getElementById("state"),
  transcript: document.getElementById("transcript"),
  interim: document.getElementById("interim"),
  elapsed: document.getElementById("elapsed"),
  words: document.getElementById("words"),
  meetingTitle: document.getElementById("meeting-title"),
  copy: document.getElementById("copy"),
  download: document.getElementById("download"),
  savewav: document.getElementById("savewav"),
  clear: document.getElementById("clear"),
  speakerList: document.getElementById("speaker-list"),
  speakersEmpty: document.getElementById("speakers-empty"),
  notice: document.getElementById("notice"),
  llm: document.getElementById("llm"),
  llmPanel: document.getElementById("llm-panel"),
  llmResult: document.getElementById("llm-result"),
  llmTitle: document.getElementById("llm-title"),
  llmCopy: document.getElementById("llm-copy"),
  llmClose: document.getElementById("llm-close"),
  analysisList: document.getElementById("analysis-list"),
  analysisEmpty: document.getElementById("analysis-empty"),
  adminList: document.getElementById("admin-list"),
  adminAdd: document.getElementById("admin-add"),
  adminSave: document.getElementById("admin-save"),
  adminStatus: document.getElementById("admin-status"),
  adminAuth: document.getElementById("admin-auth"),
  adminToken: document.getElementById("admin-token"),
};

// Show/hide the banner used for capacity and similar user-facing messages.
function showNotice(text) {
  els.notice.textContent = text;
  els.notice.hidden = !text;
}

// --- Session state (reset/torn down by start()/stop()) ---
let running = false;   // a capture session is active
let ws = null;         // WebSocket to the proxy
let audioCtx = null;   // Web Audio context (runs at `sampleRate`)
let workletNode = null;// PCM capture/resample worklet
let mediaStream = null;// the selected mic's MediaStream
let sourceNode = null; // MediaStreamSource feeding the worklet
let sinkNode = null;   // zero-gain sink so the audio graph actually renders
let sampleRate = 16000;
let debugChunks = [];  // captured PCM16 frames for the Save WAV debug button
const DEBUG_MAX_BYTES = 16000 * 2 * 600; // cap capture at ~10 min

// --- Transcript state ---
let finalSegments = []; // committed pieces: {text, speaker|null}
let interimText = "";   // current in-progress hypothesis (grey text)
let startTime = 0;
let elapsedTimer = null;
let wantReconnect = false; // auto-reconnect the browser<->proxy socket while running
let sessionEndResolve = null; // resolves when the server sends session_end after stop

// --- Speaker naming (diarization) ---
// Custom names entered in the side panel, keyed by the raw speaker id the NIM
// emits (usually "0", "1", …). Names apply to the rendered transcript AND to
// Copy / Download, since both go through speakerLabel()/composeText().
let speakerNames = {};   // speakerId -> custom name (kept across Clear)
let knownSpeakers = [];  // speaker ids in order of first appearance
const SPEAKER_COLORS = [
  "#76b900", "#4da3ff", "#f5a623", "#ff5c8a",
  "#b78cff", "#2fd6c3", "#ffd166", "#ff8c5c",
];
function speakerColor(s) {
  const i = knownSpeakers.indexOf(String(s));
  return SPEAKER_COLORS[(i >= 0 ? i : 0) % SPEAKER_COLORS.length];
}

// --------------------------------------------------------------------------
// Device handling
// --------------------------------------------------------------------------
async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter((d) => d.kind === "audioinput");
  const current = els.mic.value;
  els.mic.innerHTML = "";
  mics.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${i + 1}`;
    els.mic.appendChild(opt);
  });
  if (current) els.mic.value = current;
}

async function ensurePermissionThenList() {
  try {
    // A brief getUserMedia grant unlocks device labels.
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (e) {
    setState("error", "mic permission denied");
  }
  await listDevices();
}

// --------------------------------------------------------------------------
// UI helpers
// --------------------------------------------------------------------------
function setState(cls, label) {
  els.dot.className = "dot" + (cls ? " " + cls : "");
  els.state.textContent = label;
}

function speakerLabel(s) {
  if (s === null || s === undefined) return null;
  const key = String(s);
  const custom = speakerNames[key] && speakerNames[key].trim();
  if (custom) return custom;
  return /^\d+$/.test(key) ? `Speaker ${key}` : key;
}

// Group the committed segments into display lines, starting a new line
// whenever the speaker changes. With diarization off (speaker always null)
// this is a single space-joined flow.
function composeLines() {
  const lines = []; // {speaker, parts: []}
  let last = undefined;
  for (const seg of finalSegments) {
    const lbl = speakerLabel(seg.speaker);
    if (lbl !== null && seg.speaker !== last) {
      lines.push({ speaker: seg.speaker, parts: [seg.text] });
      last = seg.speaker;
    } else {
      if (lines.length === 0) lines.push({ speaker: null, parts: [] });
      lines[lines.length - 1].parts.push(seg.text);
      if (lbl === null) last = null;
    }
  }
  return lines
    .map((l) => ({ speaker: l.speaker, text: l.parts.join(" ").trim() }))
    .filter((l) => l.text);
}

// Build the plain-text transcript (used for Copy and Download .txt).
// Custom speaker names from the side panel are applied here too.
function composeText() {
  return composeLines()
    .map((l) => (l.speaker !== null && l.speaker !== undefined
      ? `${speakerLabel(l.speaker)}: ${l.text}`
      : l.text))
    .join("\n")
    .trim();
}

function renderTranscript() {
  els.transcript.textContent = "";
  const lines = composeLines();
  for (const l of lines) {
    const div = document.createElement("div");
    div.className = "line";
    if (l.speaker !== null && l.speaker !== undefined) {
      const tag = document.createElement("span");
      tag.className = "speaker-tag";
      tag.style.color = speakerColor(l.speaker);
      tag.textContent = `${speakerLabel(l.speaker)}: `;
      div.appendChild(tag);
    }
    div.appendChild(document.createTextNode(l.text));
    els.transcript.appendChild(div);
  }
  els.transcript.appendChild(els.interim);
  els.interim.textContent = interimText;
  const words = finalSegments.reduce(
    (n, s) => n + (s.text.trim() ? s.text.trim().split(/\s+/).length : 0), 0);
  els.words.textContent = words + (words === 1 ? " word" : " words");
  // Autoscroll if the user is near the bottom.
  const main = document.querySelector("main");
  const nearBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 120;
  if (nearBottom) main.scrollTop = main.scrollHeight;
}

// --------------------------------------------------------------------------
// Speaker side panel
// --------------------------------------------------------------------------
// Register a diarization speaker id the first time it appears and add an
// editable name row to the side panel. Rows are appended (never rebuilt) so
// typing in an input is not interrupted by incoming transcript events.
function registerSpeaker(s) {
  if (s === null || s === undefined) return;
  const key = String(s);
  if (knownSpeakers.includes(key)) return;
  knownSpeakers.push(key);
  addSpeakerRow(key);
}

function addSpeakerRow(key) {
  els.speakersEmpty.style.display = "none";

  const row = document.createElement("div");
  row.className = "speaker-item";
  row.dataset.speaker = key;

  const swatch = document.createElement("span");
  swatch.className = "speaker-swatch";
  swatch.style.background = speakerColor(key);

  const id = document.createElement("span");
  id.className = "sp-id";
  id.textContent = /^\d+$/.test(key) ? `S${key}` : key;
  id.title = /^\d+$/.test(key) ? `Speaker ${key}` : key;

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = /^\d+$/.test(key) ? `Speaker ${key}` : key;
  input.value = speakerNames[key] || "";
  input.setAttribute("aria-label", `Name for speaker ${key}`);
  input.addEventListener("input", () => {
    speakerNames[key] = input.value;
    renderTranscript();
  });

  row.appendChild(swatch);
  row.appendChild(id);
  row.appendChild(input);
  els.speakerList.appendChild(row);
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// --------------------------------------------------------------------------
// WebSocket to proxy
// --------------------------------------------------------------------------
// Open (or reopen) the socket to the proxy and wire up event handlers.
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => setState("connected", "listening");
  ws.onclose = () => {
    // Don't leave stop() hanging if the socket dies during finalization.
    if (sessionEndResolve) { sessionEndResolve(); sessionEndResolve = null; }
    // If the socket drops mid-session, reconnect; otherwise it was a normal stop.
    if (running && wantReconnect) {
      setState("reconnecting", "reconnecting…");
      setTimeout(() => { if (running) connectWS(); }, 1000);
    } else {
      setState("", "idle");
    }
  };
  ws.onerror = () => setState("error", "connection error");
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "interim") {
      // The NIM sends the full running hypothesis each time, so replace the
      // current partial rather than appending (appending caused duplication).
      interimText = msg.text;
      renderTranscript();
    } else if (msg.type === "final") {
      const t = msg.text.trim();
      if (t) {
        finalSegments.push({ text: t, speaker: msg.speaker ?? null });
        registerSpeaker(msg.speaker ?? null);
      }
      interimText = "";
      renderTranscript();
    } else if (msg.type === "status") {
      if (msg.state === "connected") setState("connected", "listening");
      else if (msg.state === "reconnecting") setState("reconnecting", "ASR reconnecting…");
      else if (msg.state === "connecting") setState("reconnecting", "connecting…");
      else if (msg.state === "full") {
        // Server is at capacity: don't retry in a loop, stop the session and
        // tell the user why. stop() resets the status to "idle", so re-assert
        // the error state after it completes.
        wantReconnect = false;
        showNotice(msg.message ||
          "The server is at capacity right now. Please try again later.");
        stop().catch(() => {}).finally(() => setState("error", "server full"));
      }
    } else if (msg.type === "analysis") {
      renderAnalysis(msg);
    } else if (msg.type === "session_end") {
      // Server finished the end-of-meeting analyzers; stop() may be waiting.
      if (sessionEndResolve) { sessionEndResolve(); sessionEndResolve = null; }
    } else if (msg.type === "error") {
      setState("error", "ASR error");
      console.error("ASR error:", msg.message);
    }
  };
}

// --------------------------------------------------------------------------
// Start / stop
// --------------------------------------------------------------------------
// Begin a capture session: open the mic, build the audio graph, connect the WS.
async function start() {
  debugChunks = []; // fresh capture each session
  showNotice("");   // clear any previous capacity/error banner
  try {
    // Match the sample rate the proxy/NIM expect.
    const cfg = await fetch("/config").then((r) => r.json());
    sampleRate = cfg.sample_rate || 16000;
  } catch { /* use default */ }

  const deviceId = els.mic.value;
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  // Request the target rate directly; the worklet resamples if the browser
  // ignores the hint (e.g. Safari forcing 44.1/48 kHz).
  try {
    audioCtx = new AudioContext({ sampleRate });
  } catch {
    audioCtx = new AudioContext();
  }
  await audioCtx.resume();
  await audioCtx.audioWorklet.addModule("/static/pcm-worklet.js");

  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, "pcm-worklet", {
    processorOptions: { targetRate: sampleRate },
  });
  workletNode.port.onmessage = (ev) => {
    // Capture a copy for debugging before sending (up to the cap).
    if (debugBytes() < DEBUG_MAX_BYTES) debugChunks.push(new Uint8Array(ev.data.slice(0)));
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(ev.data);
  };
  sourceNode.connect(workletNode);
  // The Web Audio graph only renders nodes that reach the destination, so an
  // unconnected worklet never runs process(). Route through a zero-gain node
  // so audio flows without being echoed to the speakers.
  sinkNode = audioCtx.createGain();
  sinkNode.gain.value = 0;
  workletNode.connect(sinkNode);
  sinkNode.connect(audioCtx.destination);

  wantReconnect = true;
  connectWS();

  running = true;
  els.toggle.textContent = "Stop";
  els.toggle.classList.remove("primary");
  els.mic.disabled = true;
  startTime = Date.now() - 0;
  if (!elapsedTimer) {
    elapsedTimer = setInterval(() => {
      els.elapsed.textContent = fmtElapsed(Date.now() - startTime);
    }, 500);
  }
}

// End the session: stop capture, flush the tail, tear down the audio graph.
async function stop() {
  running = false;
  wantReconnect = false;
  els.toggle.textContent = "Start";
  els.toggle.classList.add("primary");
  els.mic.disabled = false;

  // Stop capturing first so no new audio is queued.
  if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); workletNode = null; }
  if (sinkNode) { sinkNode.disconnect(); sinkNode = null; }
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }

  // Ask the server to finalize the last buffered audio, then wait briefly for
  // that final transcript to arrive. After "stop", the server runs any
  // end-of-meeting analyzers while the socket is still open, so wait for its
  // session_end message (bounded) before closing so those results land.
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: "flush" })); } catch {}
    await new Promise((r) => setTimeout(r, 1200));
    const ended = new Promise((r) => { sessionEndResolve = r; });
    try { ws.send(JSON.stringify({ type: "stop" })); } catch {}
    setState("reconnecting", "finalizing…");
    await Promise.race([ended, new Promise((r) => setTimeout(r, 120000))]);
    sessionEndResolve = null;
    ws.close();
  }
  ws = null;
  interimText = "";
  renderTranscript();
  if (audioCtx) { await audioCtx.close(); audioCtx = null; }
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  setState("", "idle");
}

// --------------------------------------------------------------------------
// Transcript actions
// --------------------------------------------------------------------------
function fullText() {
  return composeText();
}

// Text as exported (Copy / Download): the transcript body prefixed with the
// meeting title (if any) and the date. fullText() stays body-only so the LLM
// input and the "clear?" content check aren't affected by the header.
function exportText() {
  const title = els.meetingTitle.value.trim();
  const date = new Date().toLocaleDateString(undefined, {
    year: "numeric", month: "long", day: "numeric",
  });
  const header = (title ? `${title}\n` : "") + date;
  return `${header}\n\n${fullText()}`;
}

els.copy.onclick = async () => {
  try { await navigator.clipboard.writeText(exportText()); els.copy.textContent = "Copied!"; }
  catch { els.copy.textContent = "Copy failed"; }
  setTimeout(() => (els.copy.textContent = "Copy"), 1500);
};

els.download.onclick = () => {
  const blob = new Blob([exportText() + "\n"], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = els.meetingTitle.value.trim()
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  a.download = `${slug ? slug + "-" : "transcript-"}${ts}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// ---- Debug: encode captured PCM16 frames into a WAV and download ----------
function debugBytes() {
  let n = 0;
  for (const c of debugChunks) n += c.length;
  return n;
}

// Wrap raw PCM16 chunks in a standard 44-byte WAV header (mono, 16-bit).
function buildWav(chunks, rate) {
  let dataLen = 0;
  for (const c of chunks) dataLen += c.length;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const wr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  wr(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true);
  wr(8, "WAVE");
  wr(12, "fmt ");
  view.setUint32(16, 16, true);   // PCM chunk size
  view.setUint16(20, 1, true);    // format = PCM
  view.setUint16(22, 1, true);    // mono
  view.setUint32(24, rate, true); // sample rate
  view.setUint32(28, rate * 2, true); // byte rate (rate * blockAlign)
  view.setUint16(32, 2, true);    // block align (mono * 16-bit)
  view.setUint16(34, 16, true);   // bits per sample
  wr(36, "data");
  view.setUint32(40, dataLen, true);
  let off = 44;
  const out = new Uint8Array(buf);
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return new Blob([buf], { type: "audio/wav" });
}

els.savewav.onclick = () => {
  if (debugChunks.length === 0) {
    els.savewav.textContent = "no audio yet";
    setTimeout(() => (els.savewav.textContent = "Save WAV"), 1500);
    return;
  }
  const blob = buildWav(debugChunks, sampleRate);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.download = `capture-${sampleRate}hz-${ts}.wav`;
  a.click();
  URL.revokeObjectURL(a.href);
  const secs = (debugBytes() / 2 / sampleRate).toFixed(1);
  els.savewav.textContent = `saved ${secs}s`;
  setTimeout(() => (els.savewav.textContent = "Save WAV"), 2000);
};

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
  try {
    const resp = await fetch("/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    els.llmResult.textContent = data.result;
    els.llmTitle.textContent = data.model ? `LLM output — ${data.model}` : "LLM output";
    els.llmPanel.hidden = false;
    els.llmPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    els.llmResult.textContent = `Error: ${e.message}`;
    els.llmTitle.textContent = "LLM output";
    els.llmPanel.hidden = false;
  } finally {
    els.llm.disabled = false;
    els.llm.textContent = "AI Summary";
  }
};

els.llmCopy.onclick = async () => {
  try { await navigator.clipboard.writeText(els.llmResult.textContent); els.llmCopy.textContent = "Copied!"; }
  catch { els.llmCopy.textContent = "Copy failed"; }
  setTimeout(() => (els.llmCopy.textContent = "Copy"), 1500);
};

els.llmClose.onclick = () => { els.llmPanel.hidden = true; };

// Show the AI Summary button only if the server has an LLM configured.
fetch("/config")
  .then((r) => r.json())
  .then((cfg) => { if (cfg.llm) els.llm.hidden = false; })
  .catch(() => {});

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
function renderAnalysis(msg) {
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

function adminItemRow(a) {
  const item = document.createElement("div");
  item.className = "admin-item";

  const name = document.createElement("input");
  name.type = "text";
  name.placeholder = "Name";
  name.value = a.name || "";
  name.dataset.field = "name";

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

  item.dataset.id = a.id || "";
  item.appendChild(name);
  item.appendChild(prompt);
  item.appendChild(row);
  return item;
}

function syncAddButton() {
  const n = els.adminList.querySelectorAll(".admin-item").length;
  els.adminAdd.disabled = n >= MAX_ANALYZERS;
  els.adminAdd.textContent = n >= MAX_ANALYZERS
    ? `Max ${MAX_ANALYZERS} prompts` : "+ Add analyzer";
}

async function loadAdmin() {
  if (adminLoaded) return;
  els.adminStatus.textContent = "Loading…";
  try {
    const resp = await fetch("/admin/analyzers", { headers: adminHeaders() });
    if (resp.status === 401) {
      els.adminAuth.hidden = false;
      els.adminStatus.textContent = "Enter the admin token, then reopen this tab.";
      return;
    }
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    els.adminAuth.hidden = !data.auth_required;
    els.adminList.textContent = "";
    data.analyzers.forEach((a) => els.adminList.appendChild(adminItemRow(a)));
    syncAddButton();
    els.adminStatus.textContent = data.llm
      ? `${data.analyzers.length} analyzer(s) loaded.`
      : "Warning: no LLM configured on the server — analyzers will not run.";
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
  const slug = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const analyzers = [...els.adminList.querySelectorAll(".admin-item")].map((item) => {
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
  });
  els.adminSave.disabled = true;
  els.adminStatus.textContent = "Saving…";
  try {
    const resp = await fetch("/admin/analyzers", {
      method: "PUT",
      headers: adminHeaders(),
      body: JSON.stringify({ analyzers }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    els.adminStatus.textContent = data.saved
      ? "Saved (applies now; persisted to config file)."
      : "Saved for this run (config file not writable).";
    adminLoaded = false; // reload normalized values next open
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

els.clear.onclick = () => {
  if (!fullText() || confirm("Clear the transcript?")) {
    finalSegments = [];
    interimText = "";
    // Reset the speaker panel; keep speakerNames so returning speaker ids
    // (e.g. later in the same session) get their names back automatically.
    knownSpeakers = [];
    els.speakerList.textContent = "";
    els.speakersEmpty.style.display = "";
    renderTranscript();
  }
};

// Start/Stop button. Disabled while starting/stopping to avoid re-entrancy;
// on any start failure we clean up so the UI can't get stuck "running".
els.toggle.onclick = async () => {
  els.toggle.disabled = true;
  try {
    if (running) await stop();
    else await start();
  } catch (e) {
    console.error(e);
    setState("error", e.message || "failed to start");
    await stop().catch(() => {});
  } finally {
    els.toggle.disabled = false;
  }
};

els.refresh.onclick = () => ensurePermissionThenList();

// --- Bootstrap on page load ---
// Populate device list on load (labels appear after permission is granted).
listDevices();
navigator.mediaDevices.addEventListener?.("devicechange", listDevices);
ensurePermissionThenList();
