// devices.js — Microphone device enumeration and permission handling.
// Loaded as an ordered classic script (shared global scope); see index.html.
// --------------------------------------------------------------------------
// Device handling
// --------------------------------------------------------------------------
async function listDevices() {
  const mics = await AsrClient.listMicrophones();
  const current = els.mic.value;
  els.mic.innerHTML = "";
  mics.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.deviceId;
    opt.textContent = m.label;
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
