#!/usr/bin/env node
'use strict';

// Runs the post-recording pipeline over a captured session directory.
//
// Usage:
//   node transcribe-cli.js --dir ~/.tscriber/sessions/<ts>   # one session
//   node transcribe-cli.js --latest                          # most recent
//   node transcribe-cli.js --latest --summary-only           # just redo summary.md

const { load: loadConfig } = require('./src/config.js');
const { process: pipelineProcess, summaryOnly, latestSession } = require('./src/pipeline.js');
const { render } = require('./src/mapping.js');
const { openDb, refreshSession: dbRefresh } = require('./src/db.js');

function preScanConfig(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    for (const pfx of ['-config=', '--config=']) {
      if (a.startsWith(pfx)) return a.slice(pfx.length);
    }
    if ((a === '-config' || a === '--config') && i + 1 < argv.length) return argv[i + 1];
  }
  return null;
}

function parseArgs(argv, cfg) {
  const extra = { dir: '', latest: false, summaryOnly: false };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg.startsWith('-')) { i++; continue; }

    let key, val;
    const stripped = arg.replace(/^--?/, '');
    const eqIdx = stripped.indexOf('=');
    if (eqIdx >= 0) {
      key = stripped.slice(0, eqIdx);
      val = stripped.slice(eqIdx + 1);
    } else {
      key = stripped;
      const boolFlags = new Set(['latest', 'summary-only', 'summarize', 'auto']);
      if (boolFlags.has(key)) { val = 'true'; }
      else { val = argv[++i]; }
    }

    switch (key) {
      case 'dir':          extra.dir         = val; break;
      case 'latest':       extra.latest      = val !== 'false'; break;
      case 'summary-only': extra.summaryOnly = val !== 'false'; break;
      case 'data':         cfg.data_dir      = val; break;
      case 'bin':
      case 'whisper-bin':  cfg.whisper_bin   = val; break;
      case 'model':        cfg.model         = val; break;
      case 'vad':          cfg.vad_model     = val; break;
      case 'lang':         cfg.language      = val; break;
      case 'self':         cfg.self_name     = val; break;
      case 'threads':      cfg.threads       = parseInt(val, 10); break;
      case 'summarize':    cfg.summarize     = val !== 'false'; break;
      case 'llama-bin':    cfg.llama_bin     = val; break;
      case 'gemma':        cfg.gemma_model   = val; break;
    }
    i++;
  }
  return extra;
}

async function main() {
  const argv = process.argv.slice(2);
  const cfgFilePath = preScanConfig(argv);

  let loadResult;
  try { loadResult = loadConfig(cfgFilePath); }
  catch (e) { console.error(`config: ${e.message}`); process.exit(1); }

  const cfg   = loadResult.cfg;
  const flags = parseArgs(argv, cfg);

  let target = flags.dir;
  if (flags.latest) {
    try {
      target = await latestSession(cfg.data_dir);
      console.log(`latest session: ${target}`);
    } catch (e) { console.error(e.message); process.exit(1); }
  }

  if (!target) {
    console.error('usage: node transcribe-cli.js --dir <session-dir> | --latest');
    process.exit(1);
  }

  const db = openDb();

  if (flags.summaryOnly) {
    let res;
    try { res = await summaryOnly(target, cfg, null); }
    catch (e) { console.error(e.message); process.exit(1); }

    if (res.summaryErr) { console.error(`summary failed: ${res.summaryErr.message}`); process.exit(1); }
    dbRefresh(db, target);
    console.log('\n--- summary ---');
    console.log(res.summary);
    return;
  }

  let res;
  try { res = await pipelineProcess(target, cfg, null); }
  catch (e) { console.error(e.message); process.exit(1); }

  console.log('\n--- transcript (speaker-attributed) ---');
  console.log(render(res.dialogue, res.originMs));

  if (res.summaryErr) {
    console.error(`summary skipped: ${res.summaryErr.message}`);
  } else if (res.summary) {
    console.log('\n--- summary ---');
    console.log(res.summary);
  }

  dbRefresh(db, target);
  console.log(`\nDB updated: ${target}`);
}

main();
