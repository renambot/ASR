// ws.js — WebSocket to the proxy: connect, reconnect, message dispatch.
// Loaded as an ordered classic script (shared global scope); see index.html.
// --------------------------------------------------------------------------
// WebSocket to proxy
// --------------------------------------------------------------------------
// Open (or reopen) the socket to the proxy and wire up event handlers.
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // Per-connection ASR settings ride along as query params; the server merges
  // them over its env defaults for this session only.
  // Endpointing is intentionally not sent: it's governed server-side by
  // ASR_ENDPOINTING (kept for a future model with VAD support). The current
  // model doesn't endpoint, so the client never overrides it.
  const params = new URLSearchParams({
    diarization: settings.diarization ? "1" : "0",
    max_speakers: String(settings.maxSpeakers),
    punct: settings.autoPunct ? "1" : "0",
  });
  const wsurl = `${proto}://${location.host}${BASE}/ws?${params.toString()}`;
  ws = new WebSocket(wsurl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => { setState("connected", "listening"); sendSpeakerNames(); };
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
        finalSegments.push({
          text: t, speaker: msg.speaker ?? null,
          ms: startTime ? Date.now() - startTime : 0, // elapsed for analyzer timestamps
        });
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
    } else if (msg.type === "ai_running") {
      aiServerRunning = !!msg.running;
      updateAiIndicator();
    } else if (msg.type === "session_end") {
      // Server finished the end-of-meeting analyzers; stop() may be waiting.
      if (sessionEndResolve) { sessionEndResolve(); sessionEndResolve = null; }
    } else if (msg.type === "error") {
      setState("error", "ASR error");
      console.error("ASR error:", msg.message);
    }
  };
}

