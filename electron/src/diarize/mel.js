'use strict';

// Mel spectrogram that reproduces resemblyzer's librosa pipeline exactly:
//   librosa.feature.melspectrogram(y, sr=16000, n_fft=400, hop_length=160, n_mels=40)
// with librosa 0.11 defaults: window='hann' (periodic), center=True, pad_mode='constant'
// (zero-pad — NOT reflect), power=2.0. The Slaney mel filterbank is loaded from
// mel-filterbank.json (exported verbatim from librosa.filters.mel) rather than rebuilt.
//
// Output is the (n_frames, 40) NON-log mel, matching resemblyzer's wav_to_mel_spectrogram.

const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_RATE = 16000;
const N_FFT = 400;          // int(16000 * 25ms / 1000)
const HOP = 160;            // int(16000 * 10ms / 1000)
const N_MELS = 40;
const N_BINS = N_FFT / 2 + 1; // 201

// --- Slaney mel filterbank (40 x 201), loaded once. ------------------------
const fb = (() => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'mel-filterbank.json'), 'utf8'));
  if (raw.shape[0] !== N_MELS || raw.shape[1] !== N_BINS) {
    throw new Error(`mel-filterbank.json shape ${raw.shape} != [${N_MELS}, ${N_BINS}]`);
  }
  // Flatten to Float32 row-major for cache-friendly multiply.
  const flat = new Float32Array(N_MELS * N_BINS);
  for (let m = 0; m < N_MELS; m++) {
    const row = raw.filters[m];
    for (let k = 0; k < N_BINS; k++) flat[m * N_BINS + k] = row[k];
  }
  return flat;
})();

// --- Periodic Hann window (fftbins=True), length n_fft. --------------------
const hann = (() => {
  const w = new Float32Array(N_FFT);
  for (let n = 0; n < N_FFT; n++) w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT);
  return w;
})();

// --- Precomputed DFT basis for the 201 non-redundant bins. -----------------
// real[k] =  sum_n x[n] cos(2*pi*k*n/N) ; imag[k] = -sum_n x[n] sin(2*pi*k*n/N)
// n_fft=400 is not a power of two; a direct DFT over 201 bins is exact and fast
// enough for offline diarization (a handful of segments per session).
const cosT = new Float32Array(N_BINS * N_FFT);
const sinT = new Float32Array(N_BINS * N_FFT);
for (let k = 0; k < N_BINS; k++) {
  for (let n = 0; n < N_FFT; n++) {
    const a = (2 * Math.PI * k * n) / N_FFT;
    cosT[k * N_FFT + n] = Math.cos(a);
    sinT[k * N_FFT + n] = Math.sin(a);
  }
}

// melSpectrogram computes the (n_frames, 40) non-log mel of a float32 waveform.
// Returns { frames, data } where data is a Float32Array of length frames*40 (row-major).
function melSpectrogram(wav) {
  // center=True: zero-pad n_fft/2 on each side (pad_mode='constant').
  const pad = N_FFT / 2; // 200
  const padded = new Float32Array(wav.length + 2 * pad);
  padded.set(wav, pad);

  // librosa frame count for center framing: 1 + floor(len(wav) / hop).
  const frames = 1 + Math.floor(wav.length / HOP);
  const data = new Float32Array(frames * N_MELS);

  const windowed = new Float32Array(N_FFT);
  const power = new Float32Array(N_BINS);

  for (let t = 0; t < frames; t++) {
    const base = t * HOP;
    for (let n = 0; n < N_FFT; n++) windowed[n] = padded[base + n] * hann[n];

    for (let k = 0; k < N_BINS; k++) {
      let re = 0, im = 0;
      const ck = k * N_FFT;
      for (let n = 0; n < N_FFT; n++) {
        const x = windowed[n];
        re += x * cosT[ck + n];
        im -= x * sinT[ck + n];
      }
      power[k] = re * re + im * im; // power=2.0
    }

    // mel[m] = sum_k fb[m,k] * power[k]
    const out = t * N_MELS;
    for (let m = 0; m < N_MELS; m++) {
      let acc = 0;
      const fm = m * N_BINS;
      for (let k = 0; k < N_BINS; k++) acc += fb[fm + k] * power[k];
      data[out + m] = acc;
    }
  }

  return { frames, data };
}

module.exports = { melSpectrogram, SAMPLE_RATE, N_FFT, HOP, N_MELS, N_BINS };
