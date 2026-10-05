'use strict';

// Parakeet engine: transcribes a session PCM track with NVIDIA Parakeet-TDT-0.6B-v3 via
// onnxruntime-node. The work runs in worker.js so the Electron main thread never stalls.
// Implements the engine interface described in ../index.js.

const fs = require('node:fs');
const path = require('node:path');
const { modelFiles } = require('./recognizer.js');
const { runWorker } = require('../../util.js');

const WORKER = path.join(__dirname, 'worker.js');

const name  = 'parakeet';
const label = 'Parakeet';

// options picks this engine's settings out of the app config. parakeet_quant: 'fp32' (default,
// ~2.5 GB) or 'int8' (~670 MB, ~10 points worse WER on our English meeting benchmark).
function options(cfg) {
  return {
    modelDir: cfg.parakeet_model_dir,
    quant:    cfg.parakeet_quant === 'int8' ? 'int8' : '',
    threads:  cfg.threads || 0,
  };
}

// missing lists what is absent for this engine to run (empty when ready).
function missing(opts) {
  if (!opts.modelDir) return ['папка модели не указана'];
  return Object.values(modelFiles(opts.modelDir, opts.quant)).filter(f => !fs.existsSync(f));
}

// run transcribes pcmPath and resolves to [{ startMs, endMs, text }]. workDir is unused —
// nothing intermediate is written. Aborting signal stops the worker.
async function run(signal, pcmPath, workDir, opts) {
  const absent = missing(opts);
  if (absent.length) throw new Error(`Parakeet model not found: ${absent.join(', ')} (run scripts/setup-models.sh)`);

  const { segments, stats } = await runWorker(WORKER, { pcmPath, ...opts }, signal, 'parakeet');
  console.log(`[parakeet] ${path.basename(pcmPath)}: ${stats.audioS}s audio, ${stats.chunks} chunks, ` +
    `vad ${stats.vadMs}ms, load ${stats.loadMs}ms, asr ${stats.asrMs}ms`);
  return segments;
}

module.exports = { name, label, options, missing, run };
