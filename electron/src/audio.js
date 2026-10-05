'use strict';

// The capture format shared by every engine: raw 16 kHz mono signed-16-bit-LE PCM
// (tab.pcm / mic.pcm in a session directory).

const fs = require('node:fs');

const SAMPLE_RATE = 16000;

// loadAudioPcm reads a PCM file as Float32 in [-1, 1), matching
// soundfile.read(dtype='float32') which divides int16 by 32768.
function loadAudioPcm(pcmPath) {
  const buf = fs.readFileSync(pcmPath);
  const n = buf.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

module.exports = { SAMPLE_RATE, loadAudioPcm };
