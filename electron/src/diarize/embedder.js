'use strict';

// Speaker-embedding via onnxruntime-node, a byte-for-byte port of the resemblyzer
// VoiceEncoder.embed_utterance this project used to call out to in Python. The ONNX graph
// (voice-encoder.onnx, exported once via scripts/export-voice-encoder.py) holds the
// LSTM+linear+relu up to but NOT including L2 norm; the per-partial L2, mean, and final L2
// are done here (matching the original forward + embed_utterance).
//
// preprocess does normalize_volume only. The original also ran a webrtcvad silence trim;
// it is deliberately omitted — the parity harness showed JS-vs-reference cosine stays
// >0.99 without it (see test/e2e/eval/diarize-parity.js).

const fs = require('node:fs');
const { melSpectrogram, N_MELS } = require('./mel.js');
const { l2normalize, mean } = require('./cluster.js');

const SAMPLE_RATE = 16000;
const MIN_SEGMENT_SAMPLES = SAMPLE_RATE / 5; // 200 ms — shorter slices give noisy embeddings
const INT16_MAX = 32767;                     // resemblyzer normalize_volume uses 2^15 - 1
const TARGET_DBFS = -30;

// resemblyzer.hparams: partials_n_frames=160, mel_window_step=10ms → 160 samples/frame.
const SAMPLES_PER_FRAME = 160;
const PARTIALS_N_FRAMES = 160;
const RATE = 1.3;
const MIN_COVERAGE = 0.75;

let ort = null; // lazy require so non-diarize code paths never load the native addon.

function msToSamples(ms) {
  return Math.trunc((ms * SAMPLE_RATE) / 1000);
}

// loadAudioPcm reads a raw 16 kHz mono int16-LE PCM file as Float32 in [-1, 1), matching
// soundfile.read(dtype='float32') which divides int16 by 32768.
function loadAudioPcm(pcmPath) {
  const buf = fs.readFileSync(pcmPath);
  const n = buf.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

// normalizeVolume — resemblyzer normalize_volume(target=-30 dBFS, increase_only=True).
function normalizeVolume(wav) {
  let sumSq = 0;
  for (let i = 0; i < wav.length; i++) {
    const v = wav[i] * INT16_MAX;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / wav.length);
  const waveDBFS = 20 * Math.log10(rms / INT16_MAX);
  const change = TARGET_DBFS - waveDBFS;
  if (change < 0) return wav; // increase_only: never attenuate
  const scale = Math.pow(10, change / 20);
  const out = new Float32Array(wav.length);
  for (let i = 0; i < wav.length; i++) out[i] = wav[i] * scale;
  return out;
}

// computePartialSlices — verbatim port of VoiceEncoder.compute_partial_slices. Returns mel
// slices [{start, stop}] and the total wav length the partials span (for zero-padding).
function computePartialSlices(nSamples) {
  const nFrames = Math.ceil((nSamples + 1) / SAMPLES_PER_FRAME);
  const frameStep = Math.round((SAMPLE_RATE / RATE) / SAMPLES_PER_FRAME);
  const melSlices = [];
  const steps = Math.max(1, nFrames - PARTIALS_N_FRAMES + frameStep + 1);
  for (let i = 0; i < steps; i += frameStep) {
    melSlices.push({ start: i, stop: i + PARTIALS_N_FRAMES });
  }
  // Drop the trailing partial if it is too sparsely covered (and we have more than one).
  const last = melSlices[melSlices.length - 1];
  const lastWavStart = last.start * SAMPLES_PER_FRAME;
  const lastWavStop = last.stop * SAMPLES_PER_FRAME;
  const coverage = (nSamples - lastWavStart) / (lastWavStop - lastWavStart);
  if (coverage < MIN_COVERAGE && melSlices.length > 1) melSlices.pop();
  const maxWaveLength = melSlices[melSlices.length - 1].stop * SAMPLES_PER_FRAME;
  return { melSlices, maxWaveLength };
}

class VoiceEmbedder {
  constructor(modelPath) {
    this.modelPath = modelPath;
    this._session = null;
  }

  async _ensureSession() {
    if (this._session) return this._session;
    if (!ort) ort = require('onnxruntime-node');
    this._session = await ort.InferenceSession.create(this.modelPath);
    return this._session;
  }

  // embedSegment returns the L2-normalised 256-d embedding (Float32Array) of audio[startMs,endMs],
  // or null if the slice is shorter than MIN_SEGMENT_SAMPLES (before or after preprocess).
  async embedSegment(audio, startMs, endMs) {
    const lo = msToSamples(startMs);
    const hi = msToSamples(endMs);
    const chunk = audio.subarray(lo, hi);
    if (chunk.length < MIN_SEGMENT_SAMPLES) return null;

    const wav0 = normalizeVolume(chunk);
    // (VAD silence trim would go here; preserved length for now.)
    if (wav0.length < MIN_SEGMENT_SAMPLES) return null;

    const { melSlices, maxWaveLength } = computePartialSlices(wav0.length);
    const wav = maxWaveLength > wav0.length
      ? (() => { const p = new Float32Array(maxWaveLength); p.set(wav0); return p; })()
      : wav0;

    const { frames, data } = melSpectrogram(wav);
    const session = await this._ensureSession();

    const partials = [];
    for (const s of melSlices) {
      // Guard: a slice must not run past the computed mel (resemblyzer's padding guarantees it).
      const stop = Math.min(s.stop, frames);
      const len = stop - s.start;
      if (len <= 0) continue;
      const slice = new Float32Array(len * N_MELS);
      slice.set(data.subarray(s.start * N_MELS, stop * N_MELS));
      const tensor = new ort.Tensor('float32', slice, [1, len, N_MELS]);
      const out = await session.run({ mels: tensor });
      partials.push(l2normalize(out.embeds.data)); // per-partial L2, as in forward()
    }
    if (partials.length === 0) return null;

    return l2normalize(mean(partials)); // mean of partial embeds → final L2
  }
}

module.exports = { VoiceEmbedder, loadAudioPcm, normalizeVolume, computePartialSlices, msToSamples, MIN_SEGMENT_SAMPLES };
