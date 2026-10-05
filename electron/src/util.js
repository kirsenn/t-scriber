'use strict';

// Shared helpers for the engines: subprocess error tails, model-path checks, worker threads.

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

// tail returns the last n chars of s, prefixed with an ellipsis if truncated.
function tail(s, n) {
  return s.length <= n ? s : '…' + s.slice(-n);
}

// assertModelExists throws a uniform "run setup" error if the model file is missing.
function assertModelExists(modelPath) {
  try {
    fs.statSync(modelPath);
  } catch {
    throw new Error(`model not found at ${modelPath} (run scripts/setup-models.sh)`);
  }
}

// unpackedPath maps a file bundled inside app.asar to its app.asar.unpacked copy (see
// asarUnpack in package.json). Native code such as onnxruntime-node opens model files itself
// and cannot read from the asar archive. Paths outside an asar are returned unchanged.
function unpackedPath(p) {
  const marker = `app.asar${path.sep}`;
  return p.includes(marker) ? p.replace(marker, `app.asar.unpacked${path.sep}`) : p;
}

// runWorker runs a one-shot worker thread that posts a single { ok: true, ... } or
// { ok: false, error } message, and resolves with that message. name prefixes errors.
//
// Aborting signal rejects at once and raises workerData.abortFlag; the worker polls it with
// throwIfAborted between units of work and exits on its own. It is never terminated while busy:
// killing a thread inside an onnxruntime-node call aborts the whole process.
function runWorker(file, workerData, signal, name) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error(`${name} aborted`));

    const abortFlag = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(file, { workerData: { ...workerData, abortFlag } });

    const onAbort = () => { Atomics.store(abortFlag, 0, 1); reject(new Error(`${name} aborted`)); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };

    worker.once('message', (msg) => {
      cleanup();
      worker.terminate(); // idle now — the worker has posted its only message
      if (msg && msg.ok) resolve(msg);
      else reject(new Error(`${name} worker failed: ${msg && msg.error}`));
    });
    worker.once('error', (e) => { cleanup(); reject(e); });
  });
}

// throwIfAborted is the worker side of runWorker's cancellation.
function throwIfAborted(abortFlag) {
  if (abortFlag && Atomics.load(abortFlag, 0)) throw new Error('aborted');
}

module.exports = { tail, assertModelExists, unpackedPath, runWorker, throwIfAborted };
