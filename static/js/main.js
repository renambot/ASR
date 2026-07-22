// main.js — Clear/Start/Pause handlers, theme toggle, page bootstrap.
// Loaded as an ordered classic script (shared global scope); see index.html.
// Wipe the transcript, speaker panel, analysis, AI summary, and captured audio.
// Used by the Clear button and on Start (each recording begins fresh).
// Speaker names survive here (in the SDK) so a restarted recording re-attaches
// them to returning speaker ids; the Clear button wipes them too (below).
function clearWorkspace() {
  asr.clear();          // transcript segments, interim, captured audio
  interimText = "";
  knownSpeakers = [];
  els.speakerList.textContent = "";
  els.speakersEmpty.style.display = "";
  renderTranscript();
  els.analysisList.textContent = "";
  els.analysisEmpty.style.display = "";
  els.llmPanel.hidden = true;
  els.llmResult.textContent = "";
}

els.clear.onclick = () => {
  if (!fullText() || confirm("Clear the transcript, analysis, speaker names, and captured audio?")) {
    clearWorkspace();
    asr.clear({ names: true }); // also forget the custom speaker names
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

// Pause/resume: stop (or resume) sending audio while keeping the session and
// the socket open. The SDK drops frames, mutes the mic track, and flushes on
// pause so the last spoken segment still gets transcribed; the status dot
// updates via its "status" events.
els.pause.onclick = () => {
  if (!running) return;
  paused = !paused;
  if (paused) {
    asr.pause();
    els.pause.textContent = "Resume";
  } else {
    asr.resume();
    els.pause.textContent = "Pause";
  }
};

els.refresh.onclick = () => ensurePermissionThenList();

// ---- Light / dark theme -----------------------------------------------------
// Defaults to the OS preference; a manual choice is stored and wins. The head
// applies a saved choice before paint; here we keep the toggle button in sync.
const THEME_KEY = "asr.theme";
function effectiveTheme() {
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced === "light" || forced === "dark") return forced;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light" : "dark";
}
function syncThemeButton() {
  const light = effectiveTheme() === "light";
  els.themeToggle.textContent = light ? "🌙" : "☀️";
  els.themeToggle.title = light ? "Switch to dark mode" : "Switch to light mode";
}
els.themeToggle.onclick = () => {
  const next = effectiveTheme() === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  syncThemeButton();
};
// Follow OS changes while no manual choice is stored.
if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => {
    if (!localStorage.getItem(THEME_KEY)) syncThemeButton();
  });
}
syncThemeButton();

// --- Bootstrap on page load ---
// Populate device list on load (labels appear after permission is granted).
listDevices();
navigator.mediaDevices.addEventListener?.("devicechange", listDevices);
ensurePermissionThenList();

// Re-apply this browser's saved analyzers to the server so they run session to
// session even without opening the Admin tab. Best-effort: silently skipped if
// the server requires an admin token (re-applied when it's entered in Admin).
(async () => {
  const stored = readStoredAnalyzers();
  if (stored) { try { await pushAnalyzers(stored); } catch { /* needs token / offline */ } }
})();
