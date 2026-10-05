'use strict';

// GigaAM engine: transcribes a session PCM track with GigaAM-v3 e2e RNNT (Russian only) via
// onnxruntime-node. The work runs in worker.js so the Electron main thread never stalls.
// Implements the engine interface described in ../index.js.

const fs = require('node:fs');
const path = require('node:path');
const { modelFiles } = require('./recognizer.js');
const { runWorker } = require('../../util.js');

const WORKER = path.join(__dirname, 'worker.js');

const name  = 'gigaam';
const label = 'GigaAM';

// options picks this engine's settings out of the app config.
function options(cfg) {
  return {
    modelDir:     cfg.gigaam_model_dir,
    threads:      cfg.threads || 0,
    replacements: cfg.gigaam_replacements || null,
    dropFillers:  cfg.gigaam_drop_fillers !== false,
  };
}

// missing lists what is absent for this engine to run (empty when ready).
function missing(opts) {
  if (!opts.modelDir) return ['папка модели не указана'];
  return Object.values(modelFiles(opts.modelDir)).filter(f => !fs.existsSync(f));
}

// run transcribes pcmPath and resolves to [{ startMs, endMs, text }]. workDir is unused —
// nothing intermediate is written. Aborting signal terminates the worker.
async function run(signal, pcmPath, workDir, opts) {
  const absent = missing(opts);
  if (absent.length) throw new Error(`GigaAM model not found: ${absent.join(', ')} (run scripts/setup-models.sh)`);

  const { segments, stats } = await runWorker(WORKER, { pcmPath, ...opts }, signal, 'gigaam');
  console.log(`[gigaam] ${path.basename(pcmPath)}: ${stats.audioS}s audio, ${stats.chunks} chunks, ` +
    `vad ${stats.vadMs}ms, load ${stats.loadMs}ms, asr ${stats.asrMs}ms`);
  return segments;
}

module.exports = { name, label, options, missing, run };
