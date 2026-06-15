'use strict';

// Shared helpers for the subprocess wrappers (transcribe.js, analyze.js).

const fs = require('node:fs');

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

module.exports = { tail, assertModelExists };
