'use strict';

// Loads tool paths and runtime settings from JSON file.
// Resolution order: TSCRIBER_CONFIG env → ./tscriber.config.json → ~/.tscriber/config.json

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function tryWhich(cmd) {
  try {
    return execFileSync('which', [cmd], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Walks up from cwd looking for the repo root (the dir containing extension/ + electron/).
function repoRoot() {
  let dir = process.cwd();
  for (;;) {
    if (isDir(path.join(dir, 'extension')) && isDir(path.join(dir, 'electron'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function repoPath(rel) {
  const root = repoRoot();
  return root ? path.join(root, rel) : rel;
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~' || p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(1));
  }
  if (!path.isAbsolute(p)) {
    return repoPath(p);
  }
  return p;
}

function defaults() {
  const packaged = Boolean(process.env.TSCRIBER_RESOURCES);
  const resources = process.env.TSCRIBER_RESOURCES;

  return {
    addr:        '127.0.0.1:8080',
    data_dir:    path.join(os.homedir(), '.tscriber', 'sessions'),
    auto:        true,
    summarize:   true,
    language:    'en',
    threads:     0,
    // Binaries are always bundled inside the app.
    whisper_bin: packaged
      ? path.join(resources, 'bin', 'whisper', 'whisper-cli')
      : (tryWhich('whisper-cli') ?? repoPath('third_party/whisper.cpp/build/bin/whisper-cli')),
    llama_bin:   packaged
      ? path.join(resources, 'bin', 'llama', 'llama-completion')
      : (tryWhich('llama-completion') ?? repoPath('third_party/llama.cpp/build/bin/llama-completion')),
    // Models are not bundled — user sets these via Settings (⌘,).
    // In dev mode fall back to the repo's models/ dir.
    model:       packaged ? null : repoPath('models/ggml-large-v3-turbo-q5_0.bin'),
    vad_model:   packaged
      ? path.join(resources, 'models', 'ggml-silero-v5.1.2.bin')
      : repoPath('models/ggml-silero-v5.1.2.bin'),
    gemma_model: packaged ? null : repoPath('models/gemma-4-E4B-it-Q4_K_M.gguf'),
    diarize:     true,
    llm_ctx_size:   65536,
    llm_chunk_chars: 60000,
    llm_max_tokens: 4096,
    // diarize_onnx_model defaults to electron/src/diarize/voice-encoder.onnx (in diarize.js);
    // whisper_prompt primes Whisper with domain vocabulary so Russian-pronounced English
    // Override per-project in tscriber.config.json → "whisper_prompt": "your terms here".
    whisper_prompt: 'IT meeting. Terms: deploy, healthcheck, timeout, one-click, slack, router, API, SDK, iOS, Android, Google Pay, Apple Pay, refund, Jumio, integration, verification, age verification, release, staging, production, MCP, Concordium.',
  };
}

function search() {
  if (process.env.TSCRIBER_CONFIG) return process.env.TSCRIBER_CONFIG;
  const candidates = [];
  const root = repoRoot();
  if (root) candidates.push(path.join(root, 'tscriber.config.json'));
  candidates.push(path.join(os.homedir(), '.tscriber', 'config.json'));
  for (const c of candidates) {
    try { fs.statSync(c); return c; } catch {}
  }
  return null;
}

// load returns defaults overlaid with the JSON config file.
// If configPath is null, the standard locations are searched.
// Returns { cfg, filePath } — filePath is null if no file was found.
function load(configPath = null) {
  const cfg = defaults();
  const filePath = configPath ?? search();
  if (!filePath) return { cfg, filePath: null };

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { cfg, filePath: null };
    throw new Error(`config read ${filePath}: ${e.message}`);
  }

  let overrides;
  try {
    overrides = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config parse ${filePath}: ${e.message}`);
  }

  Object.assign(cfg, overrides);

  for (const key of ['data_dir', 'whisper_bin', 'model', 'vad_model', 'llama_bin', 'gemma_model', 'diarize_onnx_model']) {
    if (cfg[key]) cfg[key] = expandHome(cfg[key]);
  }

  return { cfg, filePath };
}

module.exports = { load, defaults, repoRoot, repoPath };
