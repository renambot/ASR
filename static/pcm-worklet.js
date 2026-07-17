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

    // Linear resample inputRate -> targetRate by stepping through `data` in
    // increments of `ratio`, interpolating between the two nearest samples.
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
