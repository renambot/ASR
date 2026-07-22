// core.js — Globals: BASE, cached DOM refs, UI state, per-session settings,
// and the AsrClient instance the rest of the app drives.
// Loaded as an ordered classic script (shared global scope); see index.html.
//
// EVL ASR front end. Capture, streaming, and the proxy wire protocol live in
// the headless SDK (sdk/asr-client.js — see packages/asr-client); these
// scripts are the reference consumer: they wire AsrClient events to the UI.

// Base URL path the app is served under (set by the server for sub-path
// deployments, e.g. "/asr"; empty when served at the root). Passed to the SDK
// as serverUrl; page fetches stay relative.
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

// --- UI session state (the SDK owns the capture/socket/transcript state) ---
let running = false;    // a capture session is active (mirrors asr.running)
let paused = false;     // session live but audio frames are not being sent
let interimText = "";   // current in-progress hypothesis (grey text)
let startTime = 0;      // for the footer elapsed timer
let elapsedTimer = null;
let serverFull = false; // the proxy rejected us at capacity this session

// --- Per-connection transcription settings (Extras tab) ---
// Defaults match the server env defaults / current capture constraints; the
// server's actual defaults are seeded from /config on first load. Choices are
// saved per browser and applied when a session starts (passed to the SDK,
// which forwards ASR options as /ws query params and mic options to capture).
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

// --- Speaker display (colors; names live in the SDK) ---
let knownSpeakers = [];  // speaker ids in order of first appearance
const SPEAKER_COLORS = [
  "#76b900", "#4da3ff", "#f5a623", "#ff5c8a",
  "#b78cff", "#2fd6c3", "#ffd166", "#ff8c5c",
];
function speakerColor(s) {
  const i = knownSpeakers.indexOf(String(s));
  return SPEAKER_COLORS[(i >= 0 ? i : 0) % SPEAKER_COLORS.length];
}

// --- The headless ASR client (see packages/asr-client) ---
// Map the Extras settings onto SDK options; re-applied on every Start.
function settingsToOptions() {
  return {
    diarization: settings.diarization,
    maxSpeakers: settings.maxSpeakers,
    punctuation: settings.autoPunct,
    noiseSuppression: settings.noiseSuppression,
    echoCancellation: settings.echoCancellation,
    autoGain: settings.autoGain,
  };
}

const asr = new AsrClient(Object.assign(
  { serverUrl: BASE, captureAudio: true },   // captureAudio: the Save WAV button
  settingsToOptions(),
));
