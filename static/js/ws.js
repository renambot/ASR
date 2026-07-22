// ws.js — Wires AsrClient events to the UI (the SDK owns the socket itself).
// Loaded as an ordered classic script (shared global scope); see index.html.
// --------------------------------------------------------------------------
// SDK event wiring
// --------------------------------------------------------------------------
// Connection / session state → the footer status dot. Handlers reference
// functions defined in later scripts (renderAnalysis, resetSessionUI, ...);
// that's fine — events only fire after every script has loaded.
asr.on("status", (state, message) => {
  if (state === "listening") {
    setState("connected", "listening");
  } else if (state === "connecting") {
    setState("reconnecting", "connecting…");
  } else if (state === "reconnecting") {
    setState("reconnecting", "reconnecting…");
  } else if (state === "paused") {
    setState("", "paused");
  } else if (state === "finalizing") {
    setState("reconnecting", "finalizing…");
  } else if (state === "full") {
    // Server at capacity: the SDK already stopped capture; reset the UI and
    // tell the user why. The flag keeps the later "closed" from showing idle.
    serverFull = true;
    showNotice(message ||
      "The server is at capacity right now. Please try again later.");
    resetSessionUI();
    setState("error", "server full");
  } else if (state === "idle" || state === "closed") {
    if (serverFull) setState("error", "server full");
    else setState("", "idle");
  } else if (state === "error") {
    setState("error", "connection error");
  }
});

// The NIM sends the full running hypothesis each time, so replace the current
// partial rather than appending (appending caused duplication).
asr.on("interim", (text) => {
  interimText = text;
  renderTranscript();
});

asr.on("segment", (seg) => {
  registerSpeaker(seg.speaker);
  interimText = "";
  renderTranscript();
});

asr.on("analysis", (msg) => renderAnalysis(msg));

asr.on("ai_running", (isRunning) => {
  aiServerRunning = isRunning;
  updateAiIndicator();
});

asr.on("error", (e) => {
  setState("error", "ASR error");
  console.error("ASR error:", e.message);
});
