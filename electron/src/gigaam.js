'use strict';

// Transcribes a 16 kHz mono PCM file with GigaAM-v3 (Russian-only) via onnxruntime-node.
// Drop-in alternative to transcribe.js: run() resolves to [{ startMs, endMs, text }].
// The work runs in src/gigaam/worker.js so the Electron main thread never stalls.

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { modelFiles, DEFAULT_ENCODER } = require('./gigaam/recognizer.js');

// missingFiles returns the model files absent from opts.modelDir (empty when ready).
function missingFiles(opts) {
  if (!opts.modelDir) return ['gigaam_model_dir is not set'];
  return Object.values(modelFiles(opts.modelDir, opts.encoder || DEFAULT_ENCODER))
    .filter(f => !fs.existsSync(f));
}

// run transcribes pcmPath. ctx: optional { signal } (AbortSignal) — aborting terminates the worker.
// opts: { modelDir, encoder, threads, replacements, dropFillers }
async function run(ctx, pcmPath, workDir, opts) {
  const missing = missingFiles(opts);
  if (missing.length) {
    throw new Error(`GigaAM model not found: ${missing.join(', ')} (run scripts/setup-models.sh)`);
  }
  const signal = ctx && ctx.signal;

  const { segments, stats } = await new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('gigaam aborted'));

    const worker = new Worker(path.join(__dirname, 'gigaam', 'worker.js'), {
      workerData: {
        pcmPath,
        modelDir:     opts.modelDir,
        encoder:      opts.encoder || DEFAULT_ENCODER,
        threads:      opts.threads || 0,
        replacements: opts.replacements || null,
        dropFillers:  opts.dropFillers !== false,
      },
    });

    const onAbort = () => { worker.terminate(); reject(new Error('gigaam aborted')); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };

    worker.once('message', (msg) => {
      cleanup();
      worker.terminate();
      if (msg && msg.ok) resolve(msg);
      else reject(new Error(`gigaam worker failed: ${msg && msg.error}`));
    });
    worker.once('error', (e) => { cleanup(); reject(e); });
  });

  console.log(`[gigaam] ${path.basename(pcmPath)}: ${stats.audioS}s audio, ${stats.chunks} chunks, ` +
    `vad ${stats.vadMs}ms, load ${stats.loadMs}ms, asr ${stats.asrMs}ms`);
  return segments;
}

module.exports = { run, missingFiles };
