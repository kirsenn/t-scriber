'use strict';

// Transcribes a 16 kHz mono PCM file via whisper-cli subprocess.

const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pcmToWAV } = require('./wav.js');
const { tail, assertModelExists } = require('./util.js');

const execFileAsync = promisify(execFile);

function validate(opts) {
  if (!opts.bin) throw new Error('whisper binary path is empty');
  let binExists = false;
  try { fs.statSync(opts.bin); binExists = true; } catch {}
  if (!binExists) {
    // Accept a bare command name resolvable from PATH — execFile will fail clearly if not found.
    // Only throw if the path looks absolute and is missing.
    if (path.isAbsolute(opts.bin)) {
      throw new Error(`whisper binary not found at "${opts.bin}" (run scripts/setup-models.sh)`);
    }
  }
  assertModelExists(opts.model);
}

// run transcribes a PCM file and returns an array of { startMs, endMs, text } segments.
// ctx: object with optional .signal (AbortSignal) for cancellation.
async function run(ctx, pcmPath, workDir, opts) {
  validate(opts);

  const base      = path.basename(pcmPath, path.extname(pcmPath));
  const wavPath   = path.join(workDir, base + '.wav');
  const outPrefix = path.join(workDir, base);

  await pcmToWAV(pcmPath, wavPath);

  const lang = opts.language || 'auto';
  const args = [
    '-m', opts.model,
    '-f', wavPath,
    '-l', lang,
    '-oj',          // JSON output
    '-of', outPrefix,
    '-np',          // no progress prints
    '-sns',         // suppress non-speech tokens
  ];

  if (opts.threads > 0) args.push('-t', String(opts.threads));

  if (opts.prompt) args.push('--prompt', opts.prompt);

  if (opts.vadModel) {
    try { fs.statSync(opts.vadModel); args.push('--vad', '--vad-model', opts.vadModel); } catch {}
  }

  let stdout = '', stderr = '';
  try {
    const result = await execFileAsync(opts.bin, args, {
      maxBuffer: 50 * 1024 * 1024,
      signal: ctx && ctx.signal,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (e) {
    stdout = e.stdout || '';
    stderr = e.stderr || '';
    try { fs.unlinkSync(wavPath); } catch {}
    throw new Error(`whisper-cli failed: ${e.message}\n${tail(stdout + stderr, 2000)}`);
  }

  try { fs.unlinkSync(wavPath); } catch {}

  return parseWhisperJSON(outPrefix + '.json');
}

async function parseWhisperJSON(jsonPath) {
  const raw = await fsPromises.readFile(jsonPath, 'utf8');
  const wj = JSON.parse(raw);
  const segs = [];
  for (const t of wj.transcription ?? []) {
    const text = (t.text || '').trim();
    if (!text) continue;
    segs.push({ startMs: t.offsets.from, endMs: t.offsets.to, text });
  }
  return segs;
}

module.exports = { run };
