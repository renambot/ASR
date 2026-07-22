// devices.js — Microphone device enumeration and permission handling.
// Loaded as an ordered classic script (shared global scope); see index.html.
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

