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

// ---- Debug: download the captured audio as a WAV (encoded by the SDK) ------
els.savewav.onclick = () => {
  const blob = asr.getWav();
  if (!blob) {
    els.savewav.textContent = "no audio yet";
    setTimeout(() => (els.savewav.textContent = "Save WAV"), 1500);
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.download = `capture-${asr.sampleRate}hz-${ts}.wav`;
  a.click();
  URL.revokeObjectURL(a.href);
  const secs = ((blob.size - 44) / 2 / asr.sampleRate).toFixed(1);
  els.savewav.textContent = `saved ${secs}s`;
  setTimeout(() => (els.savewav.textContent = "Save WAV"), 2000);
};

