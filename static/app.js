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
  copy: document.getElementById("copy"),
  download: document.getElementById("download"),
  savewav: document.getElementById("savewav"),
  clear: document.getElementById("clear"),
};

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
  return /^\d+$/.test(String(s)) ? `Speaker ${s}` : String(s);
}

// Build the transcript text, starting a new line whenever the speaker changes.
// With diarization off (speaker always null) this is just a space-joined flow.
function composeText() {
  const parts = [];
  let last = null;
  for (const seg of finalSegments) {
    const lbl = speakerLabel(seg.speaker);
    if (lbl !== null && seg.speaker !== last) {
      parts.push(`\n${lbl}: ${seg.text}`);
      last = seg.speaker;
    } else {
      parts.push(seg.text);
      if (lbl === null) last = null;
    }
  }
  return parts.join(" ").replace(/ *\n */g, "\n").trim();
}

function renderTranscript() {
  const text = composeText();
  els.transcript.textContent = text ? text + (text.endsWith(" ") ? "" : " ") : "";
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
      if (t) finalSegments.push({ text: t, speaker: msg.speaker ?? null });
      interimText = "";
      renderTranscript();
    } else if (msg.type === "status") {
      if (msg.state === "connected") setState("connected", "listening");
      else if (msg.state === "reconnecting") setState("reconnecting", "ASR reconnecting…");
      else if (msg.state === "connecting") setState("reconnecting", "connecting…");
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
  // that final transcript to arrive before closing (so it isn't lost).
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: "flush" })); } catch {}
    await new Promise((r) => setTimeout(r, 1200));
    try { ws.send(JSON.stringify({ type: "stop" })); } catch {}
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

els.copy.onclick = async () => {
  try { await navigator.clipboard.writeText(fullText()); els.copy.textContent = "Copied!"; }
  catch { els.copy.textContent = "Copy failed"; }
  setTimeout(() => (els.copy.textContent = "Copy"), 1500);
};

els.download.onclick = () => {
  const blob = new Blob([fullText() + "\n"], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.download = `transcript-${ts}.txt`;
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

els.clear.onclick = () => {
  if (!fullText() || confirm("Clear the transcript?")) {
    finalSegments = [];
    interimText = "";
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
