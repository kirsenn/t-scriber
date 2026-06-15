'use strict';

// End-to-end diarization test. Replays committed fixtures whose scenario has `"diarize": true`
// (see scenario.js) through the real pipeline (whisper + diarize), then checks that tab-track
// segments belonging to speakers who had anchors (spoke before the "hidden tab" gap) are
// resolved to their real names rather than 'unknown'.
//
// Opt-in (heavy, needs whisper + the diarize voice-encoder.onnx model):
//   cd electron && npm run test:e2e
//
// Skips cleanly if the diarize engine isn't runnable (see diarizeSkipReason).

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const zlib   = require('node:zlib');

const WebSocket = require('ws');
const { CaptureServer } = require('../../src/capture.js');
const { process: pipelineProcess } = require('../../src/pipeline.js');
const { load } = require('../../src/config.js');
const { modelPath } = require('../../src/diarize.js');
const { T0, deriveExpectations, discover } = require('./scenario.js');

const BYTES_PER_MS = 32;
const FRAME_BYTES  = 3200;
const SOURCE_TAB   = 0;
const SOURCE_MIC   = 1;

function binarySkipReason(cfg) {
  if (!process.env.RUN_E2E) return 'set RUN_E2E=1 to run the heavy E2E test';
  const needed = [cfg.whisper_bin, cfg.model, cfg.vad_model];
  for (const p of needed) if (!p || !fs.existsSync(p)) return `missing binary/model: ${p}`;
  return null;
}

// The JS diarize engine needs the voice-encoder ONNX model and the onnxruntime-node addon.
function diarizeSkipReason(cfg) {
  if (!fs.existsSync(modelPath(cfg))) {
    return `voice-encoder.onnx missing at ${modelPath(cfg)} — run scripts/export-voice-encoder.py`;
  }
  try { require.resolve('onnxruntime-node'); } catch { return 'onnxruntime-node not installed'; }
  return null;
}

const baseCfg   = load().cfg;
const binReason = binarySkipReason(baseCfg);
const diarReason = diarizeSkipReason(baseCfg);
const fixtures  = discover('diarize');

if (fixtures.length === 0) {
  test('Diarize E2E: fixtures', {
    skip: binReason || diarReason || 'no diarize fixtures — run `npm run gen-fixture`',
  }, () => {});
} else {
  for (const fx of fixtures) {
    const opts = { timeout: 600000 };
    if (binReason)  opts.skip = binReason;
    if (diarReason) opts.skip = diarReason;
    test(`Diarize E2E [${fx.name}]: hidden-tab segments re-attributed by diarization`, opts,
      () => runDiarizeScenario(fx));
  }
}

async function runDiarizeScenario(fx) {
  const tag      = `[${fx.name}]`;
  const scn      = fx.scn;                   // declarative source of truth (scenarios/<name>.json)
  const exp      = deriveExpectations(scn);  // structural expectations derived from the script
  const tabPcm   = zlib.gunzipSync(fs.readFileSync(path.join(fx.dir, 'tab.pcm.gz')));
  const micPcm   = zlib.gunzipSync(fs.readFileSync(path.join(fx.dir, 'mic.pcm.gz')));
  const events   = fs.readFileSync(path.join(fx.dir, 'events.jsonl'), 'utf8')
    .split('\n').map(l => l.trim()).filter(Boolean);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tscriber-diarize-e2e-'));
  const cfg = {
    ...baseCfg,
    data_dir:       dataDir,
    summarize:      false,   // skip Gemma to keep the test fast
    language:       'en',    // fixture uses English voices (Samantha + Daniel)
    self_name:      scn.selfName,
    diarize:        true,
  };

  const srv = new CaptureServer(dataDir, () => {});
  let capturedDir    = null;
  let pipelineResult = null;
  let pipelineErr    = null;
  const done = new Promise((resolve) => {
    srv.onComplete = async (dir) => {
      capturedDir = dir;
      try { pipelineResult = await pipelineProcess(dir, cfg, null); }
      catch (e) { pipelineErr = e; }
      resolve();
    };
  });

  const server = srv.createHttpServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/capture`);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

    ws.send(JSON.stringify({ type: 'session_start', meeting: fx.name }));
    sendTrack(ws, SOURCE_TAB, tabPcm, T0);
    sendTrack(ws, SOURCE_MIC, micPcm, T0);
    for (const line of events) ws.send(line);
    ws.send(JSON.stringify({ type: 'session_stop' }));

    await done;
    ws.close();

    assert.equal(pipelineErr, null, `pipeline failed: ${pipelineErr && pipelineErr.message}`);

    const dialogue = JSON.parse(fs.readFileSync(path.join(capturedDir, 'transcript.json'), 'utf8'));
    console.log(`\n===== ${tag} dialogue =====`);
    for (const s of dialogue) {
      console.log(`  ${s.speaker} (${s.source}) [${s.startMs}-${s.endMs}]: ${s.text}`);
    }

    // Hard assertion: each hidden (event-less) segment must be re-attributed to the CORRECT
    // speaker by voice. We locate the segment by its unique marker word (whisper-stable) and
    // check the diarization-assigned speaker matches the scripted one.
    const attribution = exp.hiddenAttribution;
    assert.ok(attribution.length > 0, `${tag} scenario has no hiddenAttribution markers — nothing to assert`);

    for (const { speaker, marker } of attribution) {
      const seg = dialogue.find(s =>
        s.source === 'tab' && s.text.toLowerCase().includes(marker.toLowerCase()));
      assert.ok(seg, `${tag} no tab segment containing marker "${marker}" (whisper output drifted?)`);
      assert.equal(seg.speaker, speaker,
        `${tag} hidden segment "${marker}" attributed to "${seg.speaker}", expected "${speaker}" — diarization mismatch`);
      console.log(`  ✓ "${marker}" → ${seg.speaker} (expected ${speaker})`);
    }
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function sendTrack(ws, src, pcm, t0) {
  for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
    const body = pcm.subarray(off, Math.min(off + FRAME_BYTES, pcm.length));
    const ts   = t0 + Math.round(off / BYTES_PER_MS);
    const header = Buffer.alloc(9);
    header[0] = src;
    header.writeBigInt64LE(BigInt(ts), 1);
    ws.send(Buffer.concat([header, body]));
  }
}
