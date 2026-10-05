'use strict';

// Worker thread for the Parakeet engine: VAD → chunked TDT decoding → filler removal → sentence
// segments, off the Electron main thread (same pattern as ../gigaam/worker.js).
//
// Input (workerData): { pcmPath, modelDir, quant, threads, abortFlag }
// Output (postMessage): { ok: true, segments, stats } | { ok: false, error }.

const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const ort = require('onnxruntime-node');
const { SAMPLE_RATE, loadAudioPcm } = require('../../audio.js');
const { unpackedPath, throwIfAborted } = require('../../util.js');
const { Recognizer } = require('./recognizer.js');
const vad = require('../vad.js');
const { dropFillers, toSegments } = require('../words.js');

const VAD_MODEL = unpackedPath(path.join(__dirname, '..', 'silero-vad.onnx'));

(async () => {
  try {
    const { pcmPath, modelDir, quant, threads, abortFlag } = workerData;
    const t0 = Date.now();
    const audio = loadAudioPcm(pcmPath);

    const vadSession = await ort.InferenceSession.create(VAD_MODEL, { intraOpNumThreads: 1, interOpNumThreads: 1 });
    const probs = await vad.speechProbs(ort, vadSession, audio);
    const chunks = vad.chunk(vad.speechTimestamps(probs, audio.length), probs);
    const tVad = Date.now();
    throwIfAborted(abortFlag);

    const rec = await new Recognizer(ort, modelDir, { quant, threads }).load();
    const tLoad = Date.now();

    let words = [];
    for (const ch of chunks) {
      throwIfAborted(abortFlag);
      const offsetMs = ch.start / SAMPLE_RATE * 1000;
      words = words.concat(await rec.transcribe(audio.subarray(ch.start, ch.end), offsetMs));
    }

    parentPort.postMessage({
      ok: true,
      segments: toSegments(dropFillers(words)),
      stats: {
        audioS: Math.round(audio.length / SAMPLE_RATE),
        chunks: chunks.length,
        vadMs:  tVad - t0,
        loadMs: tLoad - tVad,
        asrMs:  Date.now() - tLoad,
      },
    });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message });
  }
})();
