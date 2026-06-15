'use strict';

// Orchestrates: transcription → speaker mapping → LLM summarisation.

const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { run: whisperRun } = require('./transcribe.js');
const { parseEvents, build, render } = require('./mapping.js');
const { Client: AnalyzeClient } = require('./analyze.js');

// process transcribes tab.pcm/mic.pcm in dir, attributes speakers, and writes:
//   transcript.tab.json / transcript.mic.json — raw per-track segments
//   transcript.json — speaker-attributed dialogue
//   transcript.txt  — human-readable text (also LLM input)
//   summary.md      — Markdown summary (if cfg.summarize is true)
//
// cfg: { whisper_bin, model, vad_model, language, threads, self_name, summarize, llama_bin, gemma_model }
// Returns { dialogue, originMs, summary, summaryErr }
async function process(dir, cfg, signal) {
  const opts = {
    bin:      cfg.whisper_bin,
    model:    cfg.model,
    vadModel: cfg.vad_model,
    language: cfg.language,
    threads:  cfg.threads,
  };

  const timing = await loadTiming(path.join(dir, 'timing.json'));
  const tracks  = [];

  for (const src of ['tab', 'mic']) {
    const pcm = path.join(dir, src + '.pcm');
    try {
      const fi = await fsPromises.stat(pcm);
      if (fi.size === 0) continue;
    } catch { continue; }

    const ctx  = signal ? { signal } : {};
    const segs = await whisperRun(ctx, pcm, dir, opts);
    await writeJSON(path.join(dir, `transcript.${src}.json`), segs);

    const t0 = src === 'tab' ? (timing.first_tab_ms || 0) : (timing.first_mic_ms || 0);
    tracks.push({ source: src, t0Ms: t0, segments: segs });
  }

  const intervals = await parseEvents(path.join(dir, 'events.jsonl')).catch(() => []);
  let   dialogue  = build(tracks, intervals, cfg.self_name);
  const origin    = originMs(tracks);

  if (cfg.diarize && dialogue.some(s => s.speaker === 'unknown' && s.source === 'tab')) {
    const { run: diarizeRun } = require('./diarize.js');
    const tabPcm = path.join(dir, 'tab.pcm');
    const tabT0  = timing.first_tab_ms || 0;
    try {
      dialogue = await diarizeRun(signal, tabPcm, dir, dialogue, cfg, tabT0);
    } catch (e) {
      // Non-fatal: diarization failure leaves unknowns as-is.
      console.error(`[diarize] skipped: ${e.message}`);
    }
  }

  await writeJSON(path.join(dir, 'transcript.json'), dialogue);
  const transcriptText = render(dialogue, origin);
  await fsPromises.writeFile(path.join(dir, 'transcript.txt'), transcriptText + '\n', 'utf8');

  const result = { dialogue, originMs: origin, summary: '', summaryErr: null };

  if (cfg.summarize && transcriptText) {
    try {
      const client = new AnalyzeClient(cfg.llama_bin, cfg.gemma_model, { temp: cfg.llm_temp, seed: cfg.llm_seed });
      result.summary = await client.summarize(signal, transcriptText);
      await fsPromises.writeFile(path.join(dir, 'summary.md'), result.summary + '\n', 'utf8');
    } catch (e) {
      result.summaryErr = e;
    }
  }

  return result;
}

// summaryOnly regenerates summary.md from an existing transcript.txt without
// re-running whisper. Useful when tweaking the prompt or model.
async function summaryOnly(dir, cfg, signal) {
  let text;
  try {
    text = (await fsPromises.readFile(path.join(dir, 'transcript.txt'), 'utf8')).trim();
  } catch {
    throw new Error(`read transcript.txt (run the full pipeline first) in ${dir}`);
  }
  if (!text) throw new Error(`transcript.txt is empty in ${dir}`);

  const result = { summary: '', summaryErr: null };
  try {
    const client = new AnalyzeClient(cfg.llama_bin, cfg.gemma_model);
    result.summary = await client.summarize(signal, text);
    await fsPromises.writeFile(path.join(dir, 'summary.md'), result.summary + '\n', 'utf8');
  } catch (e) {
    result.summaryErr = e;
  }
  return result;
}

// latestSession returns the most recently modified session directory under dataDir.
async function latestSession(dataDir) {
  const entries = await fsPromises.readdir(dataDir, { withFileTypes: true });
  let best    = null;
  let bestMod = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const info = await fsPromises.stat(path.join(dataDir, entry.name));
      if (info.mtimeMs > bestMod) { bestMod = info.mtimeMs; best = path.join(dataDir, entry.name); }
    } catch {}
  }

  if (!best) throw new Error(`no session directories in ${dataDir}`);
  return best;
}

function originMs(tracks) {
  let origin = 0;
  for (const tr of tracks) {
    if (tr.t0Ms && (!origin || tr.t0Ms < origin)) origin = tr.t0Ms;
  }
  return origin;
}

async function loadTiming(filePath) {
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

async function writeJSON(filePath, data) {
  await fsPromises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { process, summaryOnly, latestSession };
