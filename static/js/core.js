// core.js — Globals: BASE, cached DOM refs, session/transcript state, per-session settings.
// Loaded as an ordered classic script (shared global scope); see index.html.
// EVL ASR front end.
// Captures the selected mic, streams 16 kHz Int16 PCM to the proxy over a
// WebSocket, and renders an append-only transcript that survives reconnects.
//
// Wire protocol with the proxy (JSON text, plus raw binary PCM frames up):
//   up   : binary Int16 PCM frames; {type:"flush"} / {type:"stop"} controls
//   down : {type:"interim", text}          -- live hypothesis (replace)
//          {type:"final", text, speaker?}  -- committed segment (append)
//          {type:"status", state}          -- connection state
//          {type:"error", message}

// Base URL path the app is served under (set by the server for sub-path
// deployments, e.g. "/asr"; empty when served at the root). All same-origin
// URLs — the WebSocket, fetches, and the worklet module — are built with it.
const BASE = "/speech";

// Cached DOM element references.
const els = {
  mic: document.getElementById("mic"),
  refresh: document.getElementById("refresh"),
  toggle: document.getElementById("toggle"),
  pause: document.getElementById("pause"),
  dot: document.getElementById("dot"),
  state: document.getElementById("state"),
  themeToggle: document.getElementById("theme-toggle"),
  transcript: document.getElementById("transcript"),
  interim: document.getElementById("interim"),
  elapsed: document.getElementById("elapsed"),
  words: document.getElementById("words"),
  aiActivity: document.getElementById("ai-activity"),
  aiLabel: document.getElementById("ai-label"),
  sessions: document.getElementById("sessions"),
  meetingTitle: document.getElementById("meeting-title"),
  download: document.getElementById("download"),
  downloadFooter: document.getElementById("download-footer"),
  downloadTranscript: document.getElementById("download-transcript"),
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
  adminReset: document.getElementById("admin-reset"),
  adminRunAll: document.getElementById("admin-run-all"),
  adminStatus: document.getElementById("admin-status"),
  adminAuth: document.getElementById("admin-auth"),
  adminToken: document.getElementById("admin-token"),
  // Extras: per-connection transcription settings
  settings: document.getElementById("settings"),
  setDiarization: document.getElementById("set-diarization"),
  setMaxspeakers: document.getElementById("set-maxspeakers"),
  setMaxspeakersRow: document.getElementById("set-maxspeakers-row"),
  setPunct: document.getElementById("set-punct"),
  setNs: document.getElementById("set-ns"),
  setEc: document.getElementById("set-ec"),
  setAgc: document.getElementById("set-agc"),
  settingsReset: document.getElementById("settings-reset"),
};

// Show/hide the banner used for capacity and similar user-facing messages.
function showNotice(text) {
  els.notice.textContent = text;
  els.notice.hidden = !text;
}

// --- Session state (reset/torn down by start()/stop()) ---
let running = false;   // a capture session is active
let paused = false;    // session live but audio frames are not being sent
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

// --- Per-connection transcription settings (Extras tab) ---
// Defaults match the server env defaults / current capture constraints; the
// server's actual defaults are seeded from /config on first load. Choices are
// saved per browser and applied when a session starts (query params on /ws for
// ASR options; getUserMedia constraints for mic processing).
const SETTINGS_KEY = "asr.settings.v1";
const settings = {
  diarization: true, maxSpeakers: 4, autoPunct: true,
  noiseSuppression: true, echoCancellation: true, autoGain: false,
};
const hadSavedSettings = !!localStorage.getItem(SETTINGS_KEY);
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null") || {}); } catch {}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}
function applySettingsToUI() {
  els.setDiarization.checked = settings.diarization;
  els.setMaxspeakers.value = settings.maxSpeakers;
  els.setPunct.checked = settings.autoPunct;
  els.setNs.checked = settings.noiseSuppression;
  els.setEc.checked = settings.echoCancellation;
  els.setAgc.checked = settings.autoGain;
  els.setMaxspeakersRow.style.display = settings.diarization ? "" : "none";
}
function readSettingsFromUI() {
  settings.diarization = els.setDiarization.checked;
  settings.maxSpeakers = Math.max(1, Math.min(8, parseInt(els.setMaxspeakers.value, 10) || 4));
  settings.autoPunct = els.setPunct.checked;
  settings.noiseSuppression = els.setNs.checked;
  settings.echoCancellation = els.setEc.checked;
  settings.autoGain = els.setAgc.checked;
  els.setMaxspeakersRow.style.display = settings.diarization ? "" : "none";
  saveSettings();
}
applySettingsToUI();
els.settings.addEventListener("change", readSettingsFromUI);

// Reset transcription + mic settings to defaults: discard this browser's saved
// overrides, restore mic defaults, and re-seed the ASR options from the server.
async function resetSettings() {
  try { localStorage.removeItem(SETTINGS_KEY); } catch {}
  settings.noiseSuppression = true;
  settings.echoCancellation = true;
  settings.autoGain = false;
  settings.diarization = true; settings.maxSpeakers = 4; settings.autoPunct = true;
  try {
    const cfg = await fetch(`config`).then((r) => r.json());
    if (typeof cfg.diarization === "boolean") settings.diarization = cfg.diarization;
    if (typeof cfg.max_speakers === "number") settings.maxSpeakers = cfg.max_speakers;
    if (typeof cfg.auto_punct === "boolean") settings.autoPunct = cfg.auto_punct;
  } catch { /* keep the hardcoded fallbacks */ }
  applySettingsToUI();
}
els.settingsReset.onclick = resetSettings;

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

