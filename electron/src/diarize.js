'use strict';

// Re-attributes tab-track dialogue segments labelled 'unknown' using voice embeddings.
//
// Pure JS: speaker embeddings via onnxruntime-node (src/diarize/{mel,embedder,cluster}.js),
// run in a worker thread (src/diarize/worker.js) so the mel STFT + inference never block the
// Electron main thread. Tests inject a fake embedder via cfg._embedderOverride, which runs
// in-process (no worker, no native addon).
//
// Fast-paths: returns dialogue unchanged if there are no unknowns or no named anchors.
// startMs/endMs in dialogue are ABSOLUTE epoch ms; tabT0 is the epoch ms of the first
// tab.pcm sample, subtracted so offsets are relative to the WAV.

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { loadAudioPcm } = require('./diarize/embedder.js');
const { classify } = require('./diarize/classify.js');

// Tuned thresholds (ported from the original resemblyzer pipeline) — keep in sync with
// test/e2e/eval/diarize-parity.js.
const MATCH_THRESHOLD = 0.62; // cosine: above → matched to a known centroid
const CLUSTER_CUT     = 0.45; // average-linkage cosine-distance cut for new speakers

const DEFAULT_MODEL = path.join(__dirname, 'diarize', 'voice-encoder.onnx');

// modelPath resolves the exported voice-encoder, overridable via cfg.diarize_onnx_model.
function modelPath(cfg) {
  return (cfg && cfg.diarize_onnx_model) || DEFAULT_MODEL;
}

// run re-attributes unknown tab-track segments in dialogue and returns the updated array.
async function run(signal, tabPcmPath, workDir, dialogue, cfg = {}, tabT0 = 0) {
  const unknowns = dialogue.filter(s => s.speaker === 'unknown' && s.source === 'tab');
  const anchors  = dialogue.filter(s => s.speaker !== 'unknown' && s.source === 'tab');

  // Fast paths — nothing to do.
  if (unknowns.length === 0) return dialogue;
  if (anchors.length === 0)  return dialogue;

  // Convert absolute epoch timestamps to offsets relative to the start of tab.pcm.
  const rel = ms => Math.max(0, ms - tabT0);
  const anchorData  = anchors.map(a => ({ speaker: a.speaker, startMs: rel(a.startMs), endMs: rel(a.endMs) }));
  const unknownData = unknowns.map(s => ({ startMs: rel(s.startMs), endMs: rel(s.endMs) }));

  let names;
  if (cfg._embedderOverride) {
    // Test path: run the core in-process against the injected embedder (no worker/onnx).
    const audio = loadAudioPcm(tabPcmPath);
    names = await classify(cfg._embedderOverride, audio, anchorData, unknownData,
      { threshold: MATCH_THRESHOLD, cut: CLUSTER_CUT });
  } else {
    names = await runWorker(signal, tabPcmPath, modelPath(cfg), anchorData, unknownData);
  }

  // Merge resolved names back by reference, preserving input order.
  const speakerOf = new Map();
  unknowns.forEach((seg, i) => speakerOf.set(seg, names[i]));
  return dialogue.map(seg =>
    speakerOf.has(seg) ? { ...seg, speaker: speakerOf.get(seg) } : seg);
}

// runWorker spawns the diarization worker, resolving with the per-unknown speaker names.
// Honours an optional AbortSignal by terminating the worker.
function runWorker(signal, pcmPath, model, anchors, unknowns) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('diarize aborted'));

    const worker = new Worker(path.join(__dirname, 'diarize', 'worker.js'), {
      workerData: { pcmPath, modelPath: model, anchors, unknowns, threshold: MATCH_THRESHOLD, cut: CLUSTER_CUT },
    });

    const onAbort = () => worker.terminate();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };

    worker.once('message', (msg) => {
      cleanup();
      worker.terminate();
      if (msg && msg.ok) resolve(msg.names);
      else reject(new Error(`diarize worker failed: ${msg && msg.error}`));
    });
    worker.once('error', (e) => { cleanup(); reject(e); });
  });
}

module.exports = { run, modelPath, DEFAULT_MODEL };
