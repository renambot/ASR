var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// src/asr-client.js
var require_asr_client = __commonJS({
  "src/asr-client.js"(exports, module) {
    (function(root, factory) {
      if (typeof module === "object" && typeof module.exports === "object") {
        module.exports = factory();
      } else {
        root.AsrClient = factory();
      }
    })(typeof self !== "undefined" ? self : exports, function() {
      "use strict";
      const WORKLET_SOURCE = `
// AudioWorklet: resample mic audio to the target rate and emit Int16 PCM
// frames to the main thread. Runs off the audio render thread so it stays
// glitch-free during multi-hour sessions.
class PCMWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.targetRate = opts.targetRate || 16000;
    this.inputRate = sampleRate; // worklet global: the AudioContext's actual rate
    this.ratio = this.inputRate / this.targetRate; // input samples per output sample
    this.frameSamples = Math.round(this.targetRate * 0.1); // emit ~100 ms frames
    this.leftover = new Float32Array(0); // input samples not yet consumed
    this.frac = 0; // fractional read position carried across process() calls
    this.acc = new Int16Array(this.frameSamples); // output frame being filled
    this.accLen = 0;
  }

  // Called by the audio engine every render quantum (128 input samples).
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const ch = input[0]; // mono (first channel)

    // Prepend the samples left over from the previous call so resampling is
    // continuous across quantum boundaries.
    const data = new Float32Array(this.leftover.length + ch.length);
    data.set(this.leftover, 0);
    data.set(ch, this.leftover.length);

    // Linear resample inputRate -> targetRate by stepping through 'data' in
    // increments of 'ratio', interpolating between the two nearest samples.
    let pos = this.frac;
    while (Math.ceil(pos) < data.length) {
      const i = Math.floor(pos);
      const t = pos - i; // fractional distance to the next sample
      const next = i + 1 < data.length ? data[i + 1] : data[i];
      let s = data[i] * (1 - t) + next * t;
      // Clamp and convert Float32 [-1,1] -> Int16 (asymmetric range).
      s = Math.max(-1, Math.min(1, s));
      this.acc[this.accLen++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      // Once a full frame is accumulated, hand a copy to the main thread.
      if (this.accLen === this.frameSamples) {
        this.port.postMessage(this.acc.buffer.slice(0));
        this.accLen = 0;
      }
      pos += this.ratio;
    }

    // Keep the tail we didn't consume, and remember the sub-sample offset.
    const consumed = Math.floor(pos);
    this.leftover = data.subarray(consumed);
    this.frac = pos - consumed;
    return true; // keep the processor alive
  }
}

registerProcessor("pcm-worklet", PCMWorklet);
`;
      const DEFAULTS = {
        serverUrl: "",
        // proxy base: "https://host/path", "/path", or "" (same origin)
        diarization: void 0,
        // undefined = use the server's configured default
        maxSpeakers: void 0,
        // 1..8
        punctuation: void 0,
        deviceId: void 0,
        // microphone deviceId; undefined = system default
        echoCancellation: true,
        noiseSuppression: true,
        autoGain: false,
        reconnect: true,
        // auto-reconnect the socket while running
        captureAudio: false,
        // keep the streamed PCM so getWav() works
        workletUrl: void 0,
        // override the inlined worklet (CSP without blob:)
        // Opt-in: run the proxy's background analyzers (topics, summaries, ...)
        // for this session. Off by default so embedded pages don't silently
        // trigger server-side LLM calls; results arrive as "analysis" events.
        analyzers: false
      };
      const STOP_FLUSH_WAIT_MS = 1200;
      const STOP_SESSION_END_MS = 12e4;
      const RECONNECT_DELAY_MS = 1e3;
      const CAPTURE_CAP_SECONDS = 600;
      class AsrClient {
        constructor(options) {
          if (!options || options.serverUrl === void 0) {
            throw new Error('AsrClient: options.serverUrl is required ("" for same origin)');
          }
          this._opts = Object.assign({}, DEFAULTS, options);
          this._opts.serverUrl = String(this._opts.serverUrl).replace(/\/+$/, "");
          this._handlers = /* @__PURE__ */ new Map();
          this._segments = [];
          this._interim = "";
          this._names = {};
          this._knownSpeakers = /* @__PURE__ */ new Set();
          this._running = false;
          this._paused = false;
          this._wantReconnect = false;
          this._startedAt = 0;
          this._sampleRate = 16e3;
          this._ws = null;
          this._audioCtx = null;
          this._workletNode = null;
          this._sourceNode = null;
          this._sinkNode = null;
          this._mediaStream = null;
          this._pcmChunks = [];
          this._sessionEndResolve = null;
          this._reconnectTimer = null;
          this._disposed = false;
        }
        // ---- events -------------------------------------------------------------
        // "interim" (text) | "segment" ({text, speaker, tMs}) | "speaker" (id)
        // "status" (state, message?) | "analysis" (msg) | "ai_running" (bool)
        // "error" (err)
        on(event, fn) {
          if (!this._handlers.has(event)) this._handlers.set(event, /* @__PURE__ */ new Set());
          this._handlers.get(event).add(fn);
          return () => this.off(event, fn);
        }
        off(event, fn) {
          const set = this._handlers.get(event);
          if (set) set.delete(fn);
        }
        _emit(event, ...args) {
          const set = this._handlers.get(event);
          if (!set) return;
          for (const fn of set) {
            try {
              fn(...args);
            } catch (e) {
            }
          }
        }
        // ---- read-only state ----------------------------------------------------
        get running() {
          return this._running;
        }
        get paused() {
          return this._paused;
        }
        get segments() {
          return this._segments;
        }
        // treat as read-only
        get interim() {
          return this._interim;
        }
        get sampleRate() {
          return this._sampleRate;
        }
        get startedAt() {
          return this._startedAt;
        }
        get elapsedMs() {
          return this._startedAt ? Date.now() - this._startedAt : 0;
        }
        get speakerNames() {
          return Object.assign({}, this._names);
        }
        // ---- configuration ------------------------------------------------------
        // Merge new options; ASR/mic options apply on the next start().
        configure(partial) {
          Object.assign(this._opts, partial || {});
          if (partial && partial.serverUrl !== void 0) {
            this._opts.serverUrl = String(partial.serverUrl).replace(/\/+$/, "");
          }
        }
        // ---- URLs ---------------------------------------------------------------
        _httpUrl(path) {
          return this._opts.serverUrl + path;
        }
        _wsUrl() {
          const base = this._opts.serverUrl;
          const params = new URLSearchParams();
          const o = this._opts;
          if (o.diarization !== void 0) params.set("diarization", o.diarization ? "1" : "0");
          if (o.maxSpeakers !== void 0) params.set("max_speakers", String(o.maxSpeakers));
          if (o.punctuation !== void 0) params.set("punct", o.punctuation ? "1" : "0");
          params.set("analyzers", o.analyzers ? "1" : "0");
          const qs = params.toString();
          const suffix = "/ws" + (qs ? "?" + qs : "");
          if (/^https?:\/\//i.test(base)) return base.replace(/^http/i, "ws") + suffix;
          const proto = location.protocol === "https:" ? "wss" : "ws";
          return `${proto}://${location.host}${base}${suffix}`;
        }
        // ---- server -------------------------------------------------------------
        async serverInfo() {
          const resp = await fetch(this._httpUrl("/config"));
          if (!resp.ok) throw new Error(`serverInfo: HTTP ${resp.status}`);
          return resp.json();
        }
        static async listMicrophones() {
          const devices = await navigator.mediaDevices.enumerateDevices();
          return devices.filter((d) => d.kind === "audioinput").map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
        }
        // ---- on-demand analysis ---------------------------------------------------
        // Stateless HTTP calls to the proxy's LLM endpoints: they work during,
        // paused, or after a session — or with no session at all when `text` is
        // given. Orthogonal to the `analyzers` option (which governs the proxy's
        // background/scheduled runs); nothing here fires without an explicit call.
        // The input both methods analyze: caller-supplied text, or this client's
        // transcript rendered with timestamps + names (same as the app's Run now).
        _analysisInput(text) {
          const t = String(text !== void 0 ? text : this.transcriptText({ timestamps: true })).trim();
          if (!t) throw new Error("AsrClient: nothing to analyze (no transcript and no text given)");
          return t;
        }
        // POST JSON to the proxy, surfacing its {error} on failure and driving the
        // ai_running event so activity indicators cover on-demand calls too.
        async _post(path, body) {
          this._emit("ai_running", true);
          try {
            const resp = await fetch(this._httpUrl(path), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body)
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
            return data;
          } finally {
            this._emit("ai_running", false);
          }
        }
        // Run one or more prompts over the transcript (or opts.text). Accepts a
        // string, one {prompt, name?, id?, chain?} object, or a list; {chain: true}
        // feeds the previous prompt's output in as extra context. Returns
        // [{id, name, result|error}, ...] — per-prompt errors don't throw.
        async analyze(prompts, opts) {
          const raw = typeof prompts === "string" ? [{ prompt: prompts }] : Array.isArray(prompts) ? prompts : [prompts];
          const list = raw.map((p, i) => ({
            id: String(p.id || p.name || `prompt-${i + 1}`),
            name: String(p.name || p.id || `Prompt ${i + 1}`),
            prompt: String(p.prompt || ""),
            mode: p.chain ? "chain" : "interval"
          }));
          const text = this._analysisInput(opts && opts.text);
          const data = await this._post("/analyze", { text, analyzers: list });
          return data.results || [];
        }
        // One-shot summary of the transcript (or opts.text). By default the proxy
        // uses its configured default prompt; pass {analyzer: "<name or id>"} to
        // run a server-configured analyzer's prompt, or {instruction} to override.
        async summarize(opts) {
          const o = opts || {};
          const body = { text: this._analysisInput(o.text) };
          if (o.analyzer) body.analyzer = o.analyzer;
          if (o.instruction) body.instruction = o.instruction;
          const data = await this._post("/llm", body);
          return { result: data.result, model: data.model || "", analyzer: data.analyzer };
        }
        // ---- lifecycle ----------------------------------------------------------
        async start() {
          if (this._disposed) throw new Error("AsrClient: disposed");
          if (this._running) return;
          this._segments = [];
          this._interim = "";
          this._knownSpeakers = /* @__PURE__ */ new Set();
          this._pcmChunks = [];
          try {
            const cfg = await this.serverInfo();
            this._sampleRate = cfg.sample_rate || 16e3;
          } catch (e) {
          }
          const o = this._opts;
          this._mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: o.deviceId ? { exact: o.deviceId } : void 0,
              channelCount: 1,
              echoCancellation: o.echoCancellation,
              noiseSuppression: o.noiseSuppression,
              autoGainControl: o.autoGain
            }
          });
          const micTrack = this._mediaStream.getAudioTracks()[0];
          try {
            if (micTrack && micTrack.getSettings && micTrack.getSettings().autoGainControl !== o.autoGain) {
              await micTrack.applyConstraints({ autoGainControl: o.autoGain });
            }
          } catch (e) {
          }
          try {
            this._audioCtx = new AudioContext({ sampleRate: this._sampleRate });
          } catch (e) {
            this._audioCtx = new AudioContext();
          }
          await this._audioCtx.resume();
          const workletUrl = o.workletUrl || URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
          await this._audioCtx.audioWorklet.addModule(workletUrl);
          this._sourceNode = this._audioCtx.createMediaStreamSource(this._mediaStream);
          this._workletNode = new AudioWorkletNode(this._audioCtx, "pcm-worklet", {
            processorOptions: { targetRate: this._sampleRate }
          });
          const captureCap = this._sampleRate * 2 * CAPTURE_CAP_SECONDS;
          this._workletNode.port.onmessage = (ev) => {
            if (this._paused) return;
            if (o.captureAudio && this._capturedBytes() < captureCap) {
              this._pcmChunks.push(new Uint8Array(ev.data.slice(0)));
            }
            if (this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.send(ev.data);
          };
          this._sourceNode.connect(this._workletNode);
          this._sinkNode = this._audioCtx.createGain();
          this._sinkNode.gain.value = 0;
          this._workletNode.connect(this._sinkNode);
          this._sinkNode.connect(this._audioCtx.destination);
          this._running = true;
          this._paused = false;
          this._startedAt = Date.now();
          this._wantReconnect = !!o.reconnect;
          this._connect();
        }
        pause() {
          if (!this._running || this._paused) return;
          this._paused = true;
          if (this._mediaStream) {
            this._mediaStream.getAudioTracks().forEach((t) => {
              t.enabled = false;
            });
          }
          this._send({ type: "flush" });
          this._emit("status", "paused");
        }
        resume() {
          if (!this._running || !this._paused) return;
          this._paused = false;
          if (this._mediaStream) {
            this._mediaStream.getAudioTracks().forEach((t) => {
              t.enabled = true;
            });
          }
          this._emit("status", "listening");
        }
        // stop({finalize: false}) skips the server's end-of-meeting analyzers and
        // the wait for their results — fast teardown for push-to-talk style use.
        // The tail flush still happens, so the last utterance is transcribed.
        async stop(opts) {
          const finalize = !opts || opts.finalize !== false;
          if (!this._running && !this._ws) return;
          this._running = false;
          this._paused = false;
          this._wantReconnect = false;
          if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
          }
          this._teardownCapture();
          if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._send({ type: "flush" });
            await new Promise((r) => setTimeout(r, STOP_FLUSH_WAIT_MS));
            if (finalize) {
              const ended = new Promise((r) => {
                this._sessionEndResolve = r;
              });
              this._send({ type: "stop" });
              this._emit("status", "finalizing");
              await Promise.race([ended, new Promise((r) => setTimeout(r, STOP_SESSION_END_MS))]);
              this._sessionEndResolve = null;
            }
            try {
              this._ws.close();
            } catch (e) {
            }
          }
          this._ws = null;
          this._interim = "";
          if (this._audioCtx) {
            try {
              await this._audioCtx.close();
            } catch (e) {
            }
            this._audioCtx = null;
          }
          this._emit("status", "idle");
        }
        dispose() {
          this._disposed = true;
          this._wantReconnect = false;
          if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
          }
          this._teardownCapture();
          if (this._ws) {
            try {
              this._ws.close();
            } catch (e) {
            }
            this._ws = null;
          }
          if (this._audioCtx) {
            try {
              this._audioCtx.close();
            } catch (e) {
            }
            this._audioCtx = null;
          }
          this._handlers.clear();
          this._running = false;
        }
        _teardownCapture() {
          if (this._workletNode) {
            this._workletNode.port.onmessage = null;
            this._workletNode.disconnect();
            this._workletNode = null;
          }
          if (this._sinkNode) {
            this._sinkNode.disconnect();
            this._sinkNode = null;
          }
          if (this._sourceNode) {
            this._sourceNode.disconnect();
            this._sourceNode = null;
          }
          if (this._mediaStream) {
            this._mediaStream.getTracks().forEach((t) => t.stop());
            this._mediaStream = null;
          }
        }
        // ---- WebSocket ----------------------------------------------------------
        _send(obj) {
          if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            try {
              this._ws.send(JSON.stringify(obj));
            } catch (e) {
            }
          }
        }
        _connect() {
          const ws = new WebSocket(this._wsUrl());
          ws.binaryType = "arraybuffer";
          this._ws = ws;
          ws.onopen = () => {
            this._emit("status", "listening");
            this._sendSpeakerNames();
          };
          ws.onclose = () => {
            if (this._sessionEndResolve) {
              this._sessionEndResolve();
              this._sessionEndResolve = null;
            }
            if (this._running && this._wantReconnect) {
              this._emit("status", "reconnecting");
              this._reconnectTimer = setTimeout(() => {
                if (this._running) this._connect();
              }, RECONNECT_DELAY_MS);
            } else {
              this._emit("status", "closed");
            }
          };
          ws.onerror = () => this._emit("status", "error");
          ws.onmessage = (ev) => {
            let msg;
            try {
              msg = JSON.parse(ev.data);
            } catch (e) {
              return;
            }
            this._handleMessage(msg);
          };
        }
        _handleMessage(msg) {
          if (msg.type === "interim") {
            this._interim = msg.text;
            this._emit("interim", msg.text);
          } else if (msg.type === "final") {
            const text = (msg.text || "").trim();
            if (!text) return;
            const seg = {
              text,
              speaker: msg.speaker !== void 0 && msg.speaker !== null ? String(msg.speaker) : null,
              tMs: this._startedAt ? Date.now() - this._startedAt : 0
            };
            this._segments.push(seg);
            this._interim = "";
            if (seg.speaker !== null && !this._knownSpeakers.has(seg.speaker)) {
              this._knownSpeakers.add(seg.speaker);
              this._emit("speaker", seg.speaker);
            }
            this._emit("segment", seg);
          } else if (msg.type === "status") {
            if (msg.state === "connected") {
              this._emit("status", "listening");
            } else if (msg.state === "reconnecting" || msg.state === "connecting") {
              this._emit("status", msg.state);
            } else if (msg.state === "full") {
              this._wantReconnect = false;
              this._running = false;
              this._teardownCapture();
              this._emit("status", "full", msg.message);
            }
          } else if (msg.type === "analysis") {
            this._emit("analysis", msg);
          } else if (msg.type === "ai_running") {
            this._emit("ai_running", !!msg.running);
          } else if (msg.type === "session_end") {
            if (this._sessionEndResolve) {
              this._sessionEndResolve();
              this._sessionEndResolve = null;
            }
          } else if (msg.type === "error") {
            this._emit("error", new Error(String(msg.message || "ASR error")));
          }
        }
        // ---- speakers -----------------------------------------------------------
        speakerLabel(id) {
          if (id === null || id === void 0) return null;
          const key = String(id);
          const custom = this._names[key] && this._names[key].trim();
          if (custom) return custom;
          return /^\d+$/.test(key) ? `Speaker ${key}` : key;
        }
        setSpeakerName(id, name) {
          this._names[String(id)] = String(name);
          this._sendSpeakerNames();
        }
        _sendSpeakerNames() {
          this._send({ type: "speaker_names", names: this._names });
        }
        // ---- transcript ---------------------------------------------------------
        // Composed plain text. {timestamps: true} gives "[MM:SS] Label: text" per
        // segment; otherwise consecutive same-speaker segments are grouped into
        // "Label: text" lines. {names: false} keeps the raw "Speaker N" labels.
        transcriptText(opts) {
          const o = opts || {};
          const useNames = o.names !== false;
          const label = (sp) => useNames ? this.speakerLabel(sp) : sp === null || sp === void 0 ? null : /^\d+$/.test(String(sp)) ? `Speaker ${sp}` : String(sp);
          if (o.timestamps) {
            const fmt = (ms) => {
              const s = Math.max(0, Math.floor(ms / 1e3));
              return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
            };
            return this._segments.map((seg) => {
              const l = label(seg.speaker);
              return l ? `[${fmt(seg.tMs)}] ${l}: ${seg.text}` : `[${fmt(seg.tMs)}] ${seg.text}`;
            }).join("\n");
          }
          const lines = [];
          let last;
          for (const seg of this._segments) {
            const l = label(seg.speaker);
            if (l !== null && seg.speaker !== last) {
              lines.push({ speaker: seg.speaker, parts: [seg.text] });
              last = seg.speaker;
            } else {
              if (lines.length === 0) lines.push({ speaker: null, parts: [] });
              lines[lines.length - 1].parts.push(seg.text);
              if (l === null) last = null;
            }
          }
          return lines.map((ln) => ({ speaker: ln.speaker, text: ln.parts.join(" ").trim() })).filter((ln) => ln.text).map((ln) => {
            const l = label(ln.speaker);
            return l !== null && ln.speaker !== void 0 ? `${l}: ${ln.text}` : ln.text;
          }).join("\n").trim();
        }
        clear(opts) {
          this._segments = [];
          this._interim = "";
          this._knownSpeakers = /* @__PURE__ */ new Set();
          this._pcmChunks = [];
          if (opts && opts.names) {
            this._names = {};
            this._sendSpeakerNames();
          }
        }
        // ---- captured audio -------------------------------------------------------
        _capturedBytes() {
          let n = 0;
          for (const c of this._pcmChunks) n += c.length;
          return n;
        }
        // WAV of everything streamed since start() (requires captureAudio: true).
        // Returns null when nothing was captured.
        getWav() {
          if (this._pcmChunks.length === 0) return null;
          const rate = this._sampleRate;
          let dataLen = 0;
          for (const c of this._pcmChunks) dataLen += c.length;
          const buf = new ArrayBuffer(44 + dataLen);
          const view = new DataView(buf);
          const wr = (off2, s) => {
            for (let i = 0; i < s.length; i++) view.setUint8(off2 + i, s.charCodeAt(i));
          };
          wr(0, "RIFF");
          view.setUint32(4, 36 + dataLen, true);
          wr(8, "WAVE");
          wr(12, "fmt ");
          view.setUint32(16, 16, true);
          view.setUint16(20, 1, true);
          view.setUint16(22, 1, true);
          view.setUint32(24, rate, true);
          view.setUint32(28, rate * 2, true);
          view.setUint16(32, 2, true);
          view.setUint16(34, 16, true);
          wr(36, "data");
          view.setUint32(40, dataLen, true);
          let off = 44;
          const out = new Uint8Array(buf);
          for (const c of this._pcmChunks) {
            out.set(c, off);
            off += c.length;
          }
          return new Blob([buf], { type: "audio/wav" });
        }
      }
      AsrClient.version = "0.4.0";
      return AsrClient;
    });
  }
});
export default require_asr_client();
