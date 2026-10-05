'use strict';

// Shared helpers for the subprocess wrappers (transcribe.js, analyze.js) and model paths.

const fs = require('node:fs');
const path = require('node:path');

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

module.exports = { tail, assertModelExists, unpackedPath };
