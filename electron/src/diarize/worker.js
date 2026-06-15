'use strict';

// Worker thread for the JS diarization engine. Runs the CPU-bound work (mel STFT) and the
// onnxruntime inference off the Electron main thread so the UI never stalls — mirroring how
// the old Python subprocess kept this work out of the main process.
//
// Input (workerData): { pcmPath, modelPath, anchors, unknowns, threshold, cut } where anchor
// and unknown times are already relative to the tab track start.
// Output (postMessage): { ok: true, names } | { ok: false, error }.

const { parentPort, workerData } = require('node:worker_threads');
const { VoiceEmbedder, loadAudioPcm } = require('./embedder.js');
const { classify } = require('./classify.js');

(async () => {
  try {
    const { pcmPath, modelPath, anchors, unknowns, threshold, cut } = workerData;
    const audio = loadAudioPcm(pcmPath);
    const embedder = new VoiceEmbedder(modelPath);
    const names = await classify(embedder, audio, anchors, unknowns, { threshold, cut });
    parentPort.postMessage({ ok: true, names });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message });
  }
})();
