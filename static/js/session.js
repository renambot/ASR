// session.js — Session lifecycle: start/stop, audio graph, capture constraints.
// Loaded as an ordered classic script (shared global scope); see index.html.
// --------------------------------------------------------------------------
// Start / stop
// --------------------------------------------------------------------------
// Begin a capture session: open the mic, build the audio graph, connect the WS.
async function start() {
  clearWorkspace(); // each recording starts fresh (transcript, analysis, audio)
  showNotice("");   // clear any previous capacity/error banner
  try {
    // Match the sample rate the proxy/NIM expect.
    const cfg = await fetch(`config`).then((r) => r.json());
    sampleRate = cfg.sample_rate || 16000;
  } catch { /* use default */ }

  const deviceId = els.mic.value;
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      // Mic processing per the Extras settings (AGC off by default: it pumps
      // levels and distorts the voice cues the diarizer relies on).
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGain,
    },
  });

  // Some browsers/devices ignore the constraint; re-assert it best-effort.
  const micTrack = mediaStream.getAudioTracks()[0];
  try {
    if (micTrack && micTrack.getSettings
        && micTrack.getSettings().autoGainControl !== settings.autoGain) {
      await micTrack.applyConstraints({ autoGainControl: settings.autoGain });
    }
  } catch { /* not all browsers support toggling AGC after the fact */ }

  // Request the target rate directly; the worklet resamples if the browser
  // ignores the hint (e.g. Safari forcing 44.1/48 kHz).
  try {
    audioCtx = new AudioContext({ sampleRate });
  } catch {
    audioCtx = new AudioContext();
  }
  await audioCtx.resume();
  await audioCtx.audioWorklet.addModule(`static/pcm-worklet.js`);

  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, "pcm-worklet", {
    processorOptions: { targetRate: sampleRate },
  });
  workletNode.port.onmessage = (ev) => {
    if (paused) return; // paused: drop frames so no audio is sent or captured
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

// End the session: stop capture, flush the tail, tear down the audio graph.
async function stop() {
  running = false;
  paused = false;
  wantReconnect = false;
  els.toggle.textContent = "Start";
  els.toggle.classList.add("primary");
  els.pause.textContent = "Pause";
  els.pause.disabled = true;
  els.mic.disabled = false;
  els.settings.disabled = false;
  els.settingsReset.disabled = false;

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

