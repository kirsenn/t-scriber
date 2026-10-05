'use strict';

// Re-attributes tab-track dialogue segments labelled 'unknown' using voice embeddings.
//
// Pure JS: speaker embeddings via onnxruntime-node (mel.js, embedder.js, cluster.js), run in a
// worker thread (worker.js) so the mel STFT + inference never block the Electron main thread.
// Tests inject a fake embedder via cfg._embedderOverride, which runs in-process (no worker,
// no native addon).
//
// Fast-paths: returns dialogue unchanged if there are no unknowns or no named anchors.
// startMs/endMs in dialogue are ABSOLUTE epoch ms; tabT0 is the epoch ms of the first
// tab.pcm sample, subtracted so offsets are relative to the WAV.

const path = require('node:path');
const { loadAudioPcm } = require('../audio.js');
const { classify } = require('./classify.js');
const { unpackedPath, runWorker } = require('../util.js');

// Tuned thresholds (ported from the original resemblyzer pipeline) — keep in sync with
// test/e2e/eval/diarize-parity.js.
const MATCH_THRESHOLD = 0.62; // cosine: above → matched to a known centroid
const CLUSTER_CUT     = 0.45; // average-linkage cosine-distance cut for new speakers

const DEFAULT_MODEL = unpackedPath(path.join(__dirname, 'voice-encoder.onnx'));
const WORKER        = path.join(__dirname, 'worker.js');

// modelPath resolves the exported voice-encoder, overridable via cfg.diarize_onnx_model.
function modelPath(cfg) {
  return (cfg && cfg.diarize_onnx_model) || DEFAULT_MODEL;
}

// run re-attributes unknown tab-track segments in dialogue and returns the updated array.
async function run(signal, tabPcmPath, dialogue, cfg = {}, tabT0 = 0) {
  const unknowns = dialogue.filter(s => s.speaker === 'unknown' && s.source === 'tab');
  const anchors  = dialogue.filter(s => s.speaker !== 'unknown' && s.source === 'tab');
  if (unknowns.length === 0 || anchors.length === 0) return dialogue;

  // Convert absolute epoch timestamps to offsets relative to the start of tab.pcm.
  const rel = ms => Math.max(0, ms - tabT0);
  const anchorData  = anchors.map(a => ({ speaker: a.speaker, startMs: rel(a.startMs), endMs: rel(a.endMs) }));
  const unknownData = unknowns.map(s => ({ startMs: rel(s.startMs), endMs: rel(s.endMs) }));
  const params = { threshold: MATCH_THRESHOLD, cut: CLUSTER_CUT };

  let names;
  if (cfg._embedderOverride) {
    // Test path: run the core in-process against the injected embedder (no worker/onnx).
    names = await classify(cfg._embedderOverride, loadAudioPcm(tabPcmPath), anchorData, unknownData, params);
  } else {
    ({ names } = await runWorker(WORKER, {
      pcmPath: tabPcmPath, modelPath: modelPath(cfg), anchors: anchorData, unknowns: unknownData, ...params,
    }, signal, 'diarize'));
  }

  // Merge resolved names back by reference, preserving input order.
  const speakerOf = new Map();
  unknowns.forEach((seg, i) => speakerOf.set(seg, names[i]));
  return dialogue.map(seg =>
    speakerOf.has(seg) ? { ...seg, speaker: speakerOf.get(seg) } : seg);
}

module.exports = { run, modelPath, DEFAULT_MODEL };
