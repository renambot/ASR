// session.js — Session lifecycle: start/stop via the SDK, plus the UI state
// that goes with it (buttons, elapsed timer).
// Loaded as an ordered classic script (shared global scope); see index.html.
// --------------------------------------------------------------------------
// Start / stop
// --------------------------------------------------------------------------
// Put the header controls back into their idle configuration.
function resetSessionUI() {
  running = false;
  paused = false;
  els.toggle.textContent = "Start";
  els.toggle.classList.add("primary");
  els.pause.textContent = "Pause";
  els.pause.disabled = true;
  els.mic.disabled = false;
  els.settings.disabled = false;
  els.settingsReset.disabled = false;
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

// Begin a capture session: fresh workspace, current settings, then the SDK
// opens the mic and the socket.
async function start() {
  clearWorkspace(); // each recording starts fresh (transcript, analysis, audio)
  showNotice("");   // clear any previous capacity/error banner
  serverFull = false;

  // Apply the Extras settings and the selected mic for this session.
  asr.configure(Object.assign(
    { deviceId: els.mic.value || undefined },
    settingsToOptions(),
  ));
  await asr.start();

  running = true;
  paused = false;
  els.toggle.textContent = "Stop";
  els.toggle.classList.remove("primary");
  els.pause.textContent = "Pause";
  els.pause.disabled = false;
  els.mic.disabled = true;
  els.settings.disabled = true; // settings apply per session; lock during one
  els.settingsReset.disabled = true;
  startTime = Date.now() - 0;
  if (!elapsedTimer) {
    elapsedTimer = setInterval(() => {
      els.elapsed.textContent = fmtElapsed(Date.now() - startTime);
    }, 500);
  }
}

// End the session. The SDK flushes the last buffered audio and waits (bounded)
// for the server's end-of-meeting analyzers before closing the socket.
async function stop() {
  resetSessionUI();
  await asr.stop();
  interimText = "";
  renderTranscript();
}
