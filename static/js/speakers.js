// speakers.js — Speaker side panel rows and elapsed-time formatting.
// Loaded as an ordered classic script (shared global scope); see index.html.
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
    sendSpeakerNames(); // keep the server's analyzer transcript in sync
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

