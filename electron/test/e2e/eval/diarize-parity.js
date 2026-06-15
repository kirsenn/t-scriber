'use strict';

// Diarization smoke check: runs the JS embedder (onnxruntime-node) + clustering on the
// committed diarize fixture and verifies the two hidden segments are attributed to the
// right speakers — without needing whisper. Fast local sanity check for the JS engine.
//
//   cd electron && node test/e2e/eval/diarize-parity.js
//
// (Originally a JS-vs-Python parity harness; the Python resemblyzer reference was removed
// together with the Python diarization layer once parity was confirmed >0.99.)
// Eval-only, removable together with eval/.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { VoiceEmbedder, loadAudioPcm } = require('../../../src/diarize/embedder.js');
const { classify } = require('../../../src/diarize/classify.js');
const { modelPath } = require('../../../src/diarize.js');

const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'e2e', 'diarize-hidden-tab');
const MODEL = modelPath({});
const MATCH_THRESHOLD = 0.62;
const CLUSTER_CUT = 0.45;

// Anchors come from events.jsonl; the two hidden (event-less) windows are the markers the
// e2e test asserts on. All ms are relative to the tab track start (T0).
const ANCHORS = [
  { speaker: 'Anna',  startMs: 0,     endMs: 11823 },
  { speaker: 'Boris', startMs: 13023, endMs: 24940 },
  { speaker: 'Anna',  startMs: 47905, endMs: 53510 },
];
const UNKNOWNS = [
  { startMs: 26140, endMs: 36845, expect: 'Anna' },  // "...by Wednesday..."
  { startMs: 37045, endMs: 47705, expect: 'Boris' }, // "...before the final deadline..."
];

function pcmFromFixture() {
  const pcm = zlib.gunzipSync(fs.readFileSync(path.join(FIXTURE, 'tab.pcm.gz')));
  const tmp = path.join(os.tmpdir(), `diarize-parity-${process.pid}.pcm`);
  fs.writeFileSync(tmp, pcm);
  return tmp;
}

async function main() {
  if (!fs.existsSync(MODEL)) {
    console.error(`SKIP: ${MODEL} missing — run scripts/export-voice-encoder.py`);
    process.exit(0);
  }
  const pcmPath = pcmFromFixture();
  try {
    const audio = loadAudioPcm(pcmPath);
    const embedder = new VoiceEmbedder(MODEL);
    const names = await classify(embedder, audio, ANCHORS, UNKNOWNS,
      { threshold: MATCH_THRESHOLD, cut: CLUSTER_CUT });

    console.log('\n=== JS attribution ===');
    let ok = true;
    UNKNOWNS.forEach((u, i) => {
      const good = names[i] === u.expect;
      ok = ok && good;
      console.log(`  [${u.startMs}-${u.endMs}] → ${names[i]} (expect ${u.expect}) ${good ? '✓' : '✗'}`);
    });
    console.log(`\nRESULT: attribution ${ok ? 'OK' : 'WRONG'}`);
    process.exit(ok ? 0 : 1);
  } finally {
    fs.rmSync(pcmPath, { force: true });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
