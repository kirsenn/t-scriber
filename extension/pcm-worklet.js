// AudioWorklet processor: pulls mono Float32 audio off the realtime thread in
// ~2048-sample chunks and posts copies to the offscreen document, which
// resamples to 16 kHz Int16 PCM and ships it over the WebSocket. Running on the
// audio thread (not a deprecated ScriptProcessorNode) keeps capture glitch-free.
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(2048);
    this._n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0]; // channel 0 (we downmix to mono upstream)
      for (let i = 0; i < ch.length; i++) {
        this._buf[this._n++] = ch[i];
        if (this._n === this._buf.length) {
          this.port.postMessage(this._buf.slice(0));
          this._n = 0;
        }
      }
    }
    return true; // keep the processor alive
  }
}

registerProcessor("pcm-capture", PCMCapture);
