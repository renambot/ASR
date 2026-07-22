// exports.js — Exports: Markdown, raw transcript, WAV download.
// Loaded as an ordered classic script (shared global scope); see index.html.
// --------------------------------------------------------------------------
// Transcript actions
// --------------------------------------------------------------------------
function fullText() {
  return composeText();
}

// ---- Markdown export (Download) -------------------------------------------
// A Markdown document, in order: title + date, then the AI summary, then all
// analyses, then the full transcript. Sections with no content are omitted.
function mdHeader() {
  const title = els.meetingTitle.value.trim();
  const date = new Date().toLocaleDateString(undefined, {
    year: "numeric", month: "long", day: "numeric",
  });
  return `# ${title || "Meeting transcript"}\n\n**Date:** ${date}`;
}

function mdSummary() {
  if (els.llmPanel.hidden) return "";
  const body = els.llmResult.textContent.trim();
  return body ? `## Summary\n\n${body}` : "";
}

function mdAnalysis() {
  const cards = els.analysisList.querySelectorAll(".analysis-card");
  if (!cards.length) return "";
  const parts = ["## Analysis"];
  cards.forEach((c) => {
    const name = (c.querySelector(".a-name")?.textContent || "").trim();
    const body = (c.querySelector(".a-body")?.textContent || "").trim();
    parts.push(`### ${name}\n\n${body}`);
  });
  return parts.join("\n\n");
}

function mdTranscript() {
  const body = fullText().trim();
  if (!body) return "";
  // Two trailing spaces = a Markdown hard line break, so speaker turns keep
  // their own lines when the document is rendered.
  return `## Transcript\n\n${body.replace(/\n/g, "  \n")}`;
}

function exportMarkdown() {
  return [mdHeader(), mdSummary(), mdAnalysis(), mdTranscript()]
    .filter(Boolean)
    .join("\n\n");
}


// Raw transcript for the "Download transcript" button: timestamped lines with
// speaker names, and nothing else (no title header beyond date, no summary,
// no analysis). The .md export groups by speaker and has no per-line times.
function transcriptText() {
  const title = els.meetingTitle.value.trim();
  const date = new Date().toLocaleDateString(undefined, {
    year: "numeric", month: "long", day: "numeric",
  });
  const header = (title ? `${title}\n` : "") + date;
  return `${header}\n\n${analyzerTranscript()}`.trim();
}

// Trigger a client-side file download of `text`.
function saveTextFile(text, suffix, ext, mime) {
  const blob = new Blob([text + "\n"], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = els.meetingTitle.value.trim()
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  a.download = `${slug ? slug + "-" : ""}${suffix}-${ts}.${ext}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function downloadMarkdown() { saveTextFile(exportMarkdown(), "meeting", "md", "text/markdown"); }
els.download.onclick = downloadMarkdown;          // Extras tab
els.downloadFooter.onclick = downloadMarkdown;    // footer copy (same action)
els.downloadTranscript.onclick = () => saveTextFile(transcriptText(), "transcript", "txt", "text/plain");

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

