'use strict';

// Whisper engine: transcribes a session PCM track with the whisper-cli subprocess
// (whisper.cpp, Metal). Implements the engine interface described in ../index.js.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pcmToWAV } = require('./wav.js');
const { tail } = require('../../util.js');

const execFileAsync = promisify(execFile);

const name  = 'whisper';
const label = 'Whisper';

// options picks this engine's settings out of the app config.
function options(cfg) {
  return {
    bin:      cfg.whisper_bin,
    model:    cfg.model,
    vadModel: cfg.vad_model,
    language: cfg.language,
    threads:  cfg.threads,
    prompt:   cfg.whisper_prompt || '',
  };
}

// missing lists what is absent for this engine to run (empty when ready).
function missing(opts) {
  if (!opts.model) return ['модель не указана'];
  return fs.existsSync(opts.model) ? [] : [opts.model];
}

// run transcribes pcmPath and resolves to [{ startMs, endMs, text }]. The WAV and JSON
// intermediates are written next to it in workDir. Aborting signal kills whisper-cli.
async function run(signal, pcmPath, workDir, opts) {
  if (!opts.bin) throw new Error('whisper binary path is empty');
  // A bare command name is resolved from PATH by execFile; only a missing absolute path is an error.
  if (path.isAbsolute(opts.bin) && !fs.existsSync(opts.bin)) {
    throw new Error(`whisper binary not found at "${opts.bin}" (run scripts/setup-models.sh)`);
  }
  const absent = missing(opts);
  if (absent.length) throw new Error(`whisper model not found: ${absent.join(', ')} (run scripts/setup-models.sh)`);

  const base      = path.basename(pcmPath, path.extname(pcmPath));
  const wavPath   = path.join(workDir, base + '.wav');
  const outPrefix = path.join(workDir, base);

  await pcmToWAV(pcmPath, wavPath);

  const args = [
    '-m', opts.model,
    '-f', wavPath,
    '-l', opts.language || 'auto',
    '-oj',          // JSON output
    '-of', outPrefix,
    '-np',          // no progress prints
    '-sns',         // suppress non-speech tokens
  ];
  if (opts.threads > 0) args.push('-t', String(opts.threads));
  if (opts.prompt) args.push('--prompt', opts.prompt);
  if (opts.vadModel && fs.existsSync(opts.vadModel)) args.push('--vad', '--vad-model', opts.vadModel);

  try {
    await execFileAsync(opts.bin, args, { maxBuffer: 50 * 1024 * 1024, signal: signal || undefined });
  } catch (e) {
    throw new Error(`whisper-cli failed: ${e.message}\n${tail((e.stdout || '') + (e.stderr || ''), 2000)}`);
  } finally {
    fs.rmSync(wavPath, { force: true });
  }

  return parseWhisperJSON(outPrefix + '.json');
}

function parseWhisperJSON(jsonPath) {
  const wj = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const segs = [];
  for (const t of wj.transcription ?? []) {
    const text = (t.text || '').trim();
    if (text) segs.push({ startMs: t.offsets.from, endMs: t.offsets.to, text });
  }
  return segs;
}

module.exports = { name, label, options, missing, run };
