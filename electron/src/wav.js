'use strict';

// Wraps a raw 16 kHz mono signed-16-bit-LE PCM file in a 44-byte WAV header.

const fs = require('node:fs');

const SAMPLE_RATE = 16000;

// Builds the exact 44-byte WAV header for mono 16-bit PCM @ 16 kHz.
function buildWAVHeader(dataLen) {
  const channels      = 1;
  const bitsPerSample = 16;
  const byteRate      = SAMPLE_RATE * channels * bitsPerSample / 8;
  const blockAlign    = channels * bitsPerSample / 8;

  const buf = Buffer.allocUnsafe(44);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);              // PCM subchunk size
  buf.writeUInt16LE(1, 20);              // audio format = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

// pcmToWAV reads pcmPath, prepends a WAV header, and writes the result to wavPath.
// Returns a Promise that resolves when the file is fully written.
function pcmToWAV(pcmPath, wavPath) {
  const { size: dataLen } = fs.statSync(pcmPath);
  const header = buildWAVHeader(dataLen);

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(wavPath);
    out.on('error', reject);

    out.write(header, (err) => {
      if (err) return reject(err);
      const src = fs.createReadStream(pcmPath);
      src.on('error', reject);
      src.pipe(out, { end: true });
      out.on('finish', resolve);
    });
  });
}

module.exports = { pcmToWAV, buildWAVHeader, SAMPLE_RATE };
