// transcript.js — Transcript composition and rendering; speaker labels and names.
// Loaded as an ordered classic script (shared global scope); see index.html.
// --------------------------------------------------------------------------
// UI helpers
// --------------------------------------------------------------------------
function setState(cls, label) {
  els.dot.className = "dot" + (cls ? " " + cls : "");
  els.state.textContent = label;
}

// Push the custom speaker-name map to the server so its background analyzers
// use the names ("Alice: …") instead of raw "Speaker 0: …" labels.
function sendSpeakerNames() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: "speaker_names", names: speakerNames })); } catch {}
  }
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

