'use strict';

// Full end-to-end transcription test, no UI. Replays committed audio fixtures through the
// real WebSocket capture path, lets the real pipeline run (whisper + Gemma), and asserts on
// the artifacts. Heavy and slow (loads whisper + a ~5GB Gemma), so it is opt-in:
//
//   cd electron && npm run test:e2e          # sets RUN_E2E=1
//
// One subtest runs per scenario fixture under test/fixtures/e2e/<scenario>/ (generated from
// test/e2e/scenarios/<scenario>.json via `npm run gen-fixture`). Determinism: the summariser
// is non-deterministic, so we never compare exact text — we run it greedy + fixed seed
// (cfg.llm_temp/llm_seed) and check planted facts by recall.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');

const WebSocket = require('ws');
const { CaptureServer } = require('../../src/capture.js');
const { process: pipelineProcess } = require('../../src/pipeline.js');
const { load } = require('../../src/config.js');
const { cleanOutput } = require('../../src/analyze.js');
const { reportFacts, factMatches } = require('./match.js');
const { T0, deriveExpectations, discover } = require('./scenario.js');

const execFileAsync = promisify(execFile);

const BYTES_PER_MS = 32;            // 16kHz mono int16
const FRAME_BYTES  = 3200;          // ~100ms per WS frame
const SOURCE_TAB   = 0;
const SOURCE_MIC   = 1;

// binarySkipReason returns a string if the engines aren't available, else null. Fixture
// presence is handled separately (per scenario / via discovery).
function binarySkipReason(cfg) {
  if (!process.env.RUN_E2E) return 'set RUN_E2E=1 to run the heavy E2E test';
  const needed = [cfg.whisper_bin, cfg.model, cfg.vad_model, cfg.llama_bin, cfg.gemma_model];
  for (const p of needed) if (!p || !fs.existsSync(p)) return `missing binary/model: ${p}`;
  return null;
}

const baseCfg   = load().cfg;
const binReason = binarySkipReason(baseCfg);
const fixtures  = discover('transcribe'); // transcription-only scenarios (diarize ones run in diarize.e2e.js)

// concurrency:1 — each scenario loads a ~5GB Gemma model onto the GPU; running them in
// parallel causes kIOGPUCommandBufferCallbackErrorOutOfMemory and multi-minute hangs.
describe('E2E', { concurrency: 1 }, () => {
  if (fixtures.length === 0) {
    test('scenarios', { skip: binReason || 'no fixtures — run `npm run gen-fixture`' }, () => {});
  } else {
    for (const fx of fixtures) {
      const opts = { timeout: 600000 };
      if (binReason) opts.skip = binReason;
      test(`[${fx.name}]: socket → pipeline → transcript + summary`, opts, () => runScenario(fx));
    }
  }
});

async function runScenario(fx) {
  const tag = `[${fx.name}]`;
  const scn = fx.scn;                       // declarative source of truth (scenarios/<name>.json)
  const exp = deriveExpectations(scn);      // structural expectations derived from the script
  const tabPcm = zlib.gunzipSync(fs.readFileSync(path.join(fx.dir, 'tab.pcm.gz')));
  const micPcm = zlib.gunzipSync(fs.readFileSync(path.join(fx.dir, 'mic.pcm.gz')));
  const events = fs.readFileSync(path.join(fx.dir, 'events.jsonl'), 'utf8')
    .split('\n').map((l) => l.trim()).filter(Boolean);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tscriber-e2e-'));
  const cfg = { ...baseCfg, data_dir: dataDir, summarize: true, language: 'ru',
    self_name: scn.selfName, llm_temp: 0, llm_seed: 42 };

  const srv = new CaptureServer(dataDir, () => {});
  let capturedDir = null;
  let pipelineResult = null;
  let pipelineErr = null;
  const done = new Promise((resolve) => {
    // Same wiring as electron/main.js, minus Electron: onComplete runs the pipeline.
    srv.onComplete = async (dir) => {
      capturedDir = dir;
      try { pipelineResult = await pipelineProcess(dir, cfg, null); }
      catch (e) { pipelineErr = e; }
      resolve();
    };
  });

  const server = srv.createHttpServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    // ---- stream the fixture through a real WebSocket ----
    const ws = new WebSocket(`ws://127.0.0.1:${port}/capture`);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

    ws.send(JSON.stringify({ type: 'session_start', meeting: fx.name }));
    sendTrack(ws, SOURCE_TAB, tabPcm, T0);
    sendTrack(ws, SOURCE_MIC, micPcm, T0);
    for (const line of events) ws.send(line);
    ws.send(JSON.stringify({ type: 'session_stop' }));

    await done;
    ws.close();

    // ---- assertions ----
    assert.equal(pipelineErr, null, `pipeline failed: ${pipelineErr && pipelineErr.message}`);
    assert.ok(capturedDir, 'onComplete never fired');
    assert.equal(pipelineResult.summaryErr, null,
      `summary failed: ${pipelineResult.summaryErr && pipelineResult.summaryErr.message}`);

    for (const f of ['transcript.tab.json', 'transcript.json', 'transcript.txt', 'summary.md']) {
      assert.ok(fs.existsSync(path.join(capturedDir, f)), `missing artifact ${f}`);
    }

    const transcript = fs.readFileSync(path.join(capturedDir, 'transcript.txt'), 'utf8');
    const summary    = fs.readFileSync(path.join(capturedDir, 'summary.md'), 'utf8');
    const dialogue   = JSON.parse(fs.readFileSync(path.join(capturedDir, 'transcript.json'), 'utf8'));
    const factById   = Object.fromEntries(scn.facts.map((f) => [f.id, f]));

    console.log(`\n===== ${tag} transcript.txt =====\n` + transcript);
    console.log(`\n===== ${tag} summary.md =====\n` + summary);

    // Whisper sanity: robust facts must survive transcription. Failure here points at
    // audio/whisper, not the summariser.
    assert.ok(transcript.trim().length > 0, 'empty transcript');
    for (const id of scn.transcriptFacts) {
      assert.ok(factMatches(transcript, factById[id]), `transcript missing planted fact "${id}" (whisper layer)`);
    }

    // Speaker attribution: tab speakers come from events; an event-less mic turn falls back
    // to self_name (mapping.build).
    const speakers = new Set(dialogue.map((d) => d.speaker));
    for (const sp of exp.tabSpeakers) {
      assert.ok(speakers.has(sp), `${sp} not attributed (got: ${[...speakers]})`);
    }
    if (exp.expectSelfFallback) {
      const micSegs = dialogue.filter((d) => d.source === 'mic');
      assert.ok(micSegs.length > 0, 'expected mic segments (self fallback) but found none');
      assert.ok(micSegs.every((d) => d.speaker === scn.selfName),
        `mic segments not attributed to self_name="${scn.selfName}" (got: ${micSegs.map((d) => d.speaker)})`);
    }

    // Summary structure: the prompt mandates exactly these three headings.
    for (const h of ['## Краткое резюме', '## Ключевые решения', '## Action items']) {
      assert.ok(summary.includes(h), `summary missing heading "${h}"`);
    }

    // Summary facts (hard gate): every required planted fact must appear by recall.
    const required = scn.requiredSummaryFacts.map((id) => factById[id]);
    const rep = reportFacts(summary, required);
    console.log(`\n===== ${tag} required summary facts =====`);
    for (const f of rep.passed) console.log(`  ✓ ${f.id} — ${f.label}`);
    for (const f of rep.failed) console.log(`  ✗ ${f.id} — ${f.label}`);
    assert.equal(rep.failed.length, 0, `summary missing required facts: ${rep.failed.map((f) => f.id).join(', ')}`);

    // Forbidden facts: must NOT appear in summary (hallucination guard).
    if (scn.forbiddenSummaryFacts?.length) {
      const forbidden = scn.forbiddenSummaryFacts.map((id) => factById[id]);
      const forbidRep = reportFacts(summary, forbidden);
      console.log(`\n===== ${tag} forbidden summary facts =====`);
      for (const f of forbidden) {
        console.log(`  ${forbidRep.passed.includes(f) ? '✗ FOUND (bad)' : '✓ absent'} ${f.id} — ${f.label}`);
      }
      assert.equal(forbidRep.passed.length, 0,
        `summary contains forbidden (hallucinated) facts: ${forbidRep.passed.map((f) => f.id).join(', ')}`);
    }

    // Nice-to-have facts: reported only, never blocking.
    const niceRep = reportFacts(summary, (scn.niceToHaveSummaryFacts || []).map((id) => factById[id]));
    if (niceRep.all.length) {
      console.log(`\n===== ${tag} nice-to-have summary facts (informational) =====`);
      for (const f of niceRep.all) console.log(`  ${niceRep.passed.includes(f) ? '✓' : '·'} ${f.id} — ${f.label}`);
    }

    // Soft LLM-judge: prints a coverage opinion, never asserts.
    await runJudge(cfg, summary, scn, tag).catch((e) => console.log(`judge skipped: ${e.message}`));
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

// sendTrack chunks a continuous PCM track into ~100ms binary frames. Each frame carries the
// 9-byte header capture.js expects: [src(1) | int64 LE epoch ms | pcm]. ts = T0 + offset, so
// the first frame fixes first_{tab,mic}_ms = T0 and offsets reconstruct to wall-clock.
function sendTrack(ws, src, pcm, t0) {
  for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
    const body = pcm.subarray(off, Math.min(off + FRAME_BYTES, pcm.length));
    const ts = t0 + Math.round(off / BYTES_PER_MS);
    const header = Buffer.alloc(9);
    header[0] = src;
    header.writeBigInt64LE(BigInt(ts), 1);
    ws.send(Buffer.concat([header, body]));
  }
}

// runJudge asks the same local Gemma whether each expected fact is reflected in the summary.
// Purely informational — output is printed, nothing is asserted.
async function runJudge(cfg, summary, scn, tag) {
  const sys = 'Ты — придирчивый проверяющий. Тебе дан конспект встречи и список ожидаемых пунктов. ' +
    'Для каждого пункта ответь строкой «<пункт>: да» или «<пункт>: нет», отражён ли он в конспекте. ' +
    'Без пояснений.';
  const items = scn.requiredSummaryFacts
    .concat(scn.niceToHaveSummaryFacts || [])
    .map((id) => scn.facts.find((f) => f.id === id).label);
  const usr = `Конспект:\n\n${summary}\n\nОжидаемые пункты:\n- ${items.join('\n- ')}`;

  const sysPath = path.join(os.tmpdir(), `tscriber-judge-sys-${process.pid}-${scn.name}.txt`);
  const usrPath = path.join(os.tmpdir(), `tscriber-judge-usr-${process.pid}-${scn.name}.txt`);
  fs.writeFileSync(sysPath, sys);
  fs.writeFileSync(usrPath, usr);
  try {
    const { stdout } = await execFileAsync(cfg.llama_bin, [
      '-m', cfg.gemma_model, '--jinja', '-sysf', sysPath, '-f', usrPath, '-st',
      '-rea', 'off', '--no-display-prompt', '-ngl', '99', '-c', '8192', '-n', '512',
      '--temp', '0', '-s', '42',
    ], { maxBuffer: 16 * 1024 * 1024 });
    console.log(`\n===== ${tag} LLM-judge (informational) =====\n` + cleanOutput(stdout));
  } finally {
    fs.rmSync(sysPath, { force: true });
    fs.rmSync(usrPath, { force: true });
  }
}
