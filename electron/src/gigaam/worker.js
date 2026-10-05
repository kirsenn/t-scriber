'use strict';

// Worker thread for the GigaAM engine: VAD → chunked RNNT decoding → post-processing, off the
// Electron main thread (same pattern as src/diarize/worker.js).
//
// Input (workerData): { pcmPath, modelDir, encoder, threads, replacements, dropFillers }
// Output (postMessage): { ok: true, segments, stats } | { ok: false, error }.

const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const ort = require('onnxruntime-node');
const { loadAudioPcm } = require('../diarize/embedder.js');
const { Recognizer } = require('./recognizer.js');
const vad = require('./vad.js');
const text = require('./text.js');
const { unpackedPath } = require('../util.js');

const VAD_MODEL = unpackedPath(path.join(__dirname, 'silero-vad.onnx'));

(async () => {
  try {
    const { pcmPath, modelDir, encoder, threads, replacements, dropFillers } = workerData;
    const t0 = Date.now();
    const audio = loadAudioPcm(pcmPath);

    const vadSession = await ort.InferenceSession.create(VAD_MODEL, { intraOpNumThreads: 1, interOpNumThreads: 1 });
    const probs = await vad.speechProbs(ort, vadSession, audio);
    const chunks = vad.chunk(vad.speechTimestamps(probs, audio.length), probs);
    const tVad = Date.now();

    const rec = await new Recognizer(ort, modelDir, { encoder, threads }).load();
    const tLoad = Date.now();

    let words = [];
    for (const ch of chunks) {
      const offsetMs = ch.start / vad.SAMPLE_RATE * 1000;
      words = words.concat(await rec.transcribe(audio.subarray(ch.start, ch.end), offsetMs));
    }
    if (dropFillers !== false) words = text.dropFillers(words);
    words = text.applyReplacements(words, text.compileReplacements(replacements));
    const segments = text.toSegments(words);

    parentPort.postMessage({
      ok: true,
      segments,
      stats: {
        audioS: Math.round(audio.length / vad.SAMPLE_RATE),
        chunks: chunks.length,
        vadMs: tVad - t0,
        loadMs: tLoad - tVad,
        asrMs: Date.now() - tLoad,
      },
    });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message });
  }
})();
