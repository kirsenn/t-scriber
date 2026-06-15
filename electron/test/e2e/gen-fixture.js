#!/usr/bin/env node
'use strict';

// Run-once generator for E2E audio fixtures. NOT part of the test run — it shells out to
// macOS `say` + `afconvert`, so it only runs on a dev machine. The artifacts it writes
// under test/fixtures/e2e/<scenario>/ are committed and replayed by transcribe.e2e.js.
//
// Scenarios are plain JSON in test/e2e/scenarios/. Add a new conversation by dropping a new
// <name>.json there (see scenarios/planning.json for the schema), then regenerate.
//
// Usage (from electron/):
//   npm run gen-fixture                       # regenerate every scenarios/*.json
//   node test/e2e/gen-fixture.js scenarios/planning.json   # just one
//
// What it does per scenario: synthesises each scripted line with the Milena voice (distinct
// speakers via per-speaker pitch/rate markup), lays the lines on a single shared clock into
// two continuous PCM tracks (tab + mic, silence where the other speaks), and emits speaker
// events. Both tracks start at T0 and stay byte-aligned, so a whisper segment's file offset
// reconstructs to the same wall-clock epoch the events use (see mapping.js).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { SCENARIOS_DIR, FIXTURES_DIR, T0, SAMPLE_RATE, emitsEvent } = require('./scenario.js');

const BYTES_PER_MS = SAMPLE_RATE * 2 / 1000; // 16-bit mono → 32 bytes/ms
const DEFAULT_GAP_MS = 3000;                 // silence between turns; must exceed
                                             // VAD_preroll (~1000ms) + MATCH_TOLERANCE_MS (500ms)
                                             // — silero-vad pre-rolls up to ~1s on tracks with
                                             // multiple speech segments, pulling the detected start
                                             // earlier and risking an overlap with the adjacent
                                             // speaker interval.

// synth runs `say` + `afconvert` for one line and returns the raw 16-bit mono PCM bytes.
// voiceName selects the macOS TTS voice (default: Milena).
// markup is prepended to the text (e.g. "[[pbas 62]][[rate 195]]") to vary the voice.
function synth(voiceName, markup, text) {
  const tmp   = os.tmpdir();
  const stamp = crypto.randomBytes(6).toString('hex');
  const aiff  = path.join(tmp, `tscriber-tts-${stamp}.aiff`);
  const wav   = path.join(tmp, `tscriber-tts-${stamp}.wav`);
  try {
    execFileSync('say', ['-v', voiceName || 'Milena', '-o', aiff, (markup || '') + text]);
    execFileSync('afconvert', [aiff, wav, '-d', 'LEI16@16000', '-c', '1', '-f', 'WAVE']);
    return wavToPcm(fs.readFileSync(wav));
  } finally {
    fs.rmSync(aiff, { force: true });
    fs.rmSync(wav, { force: true });
  }
}

// wavToPcm walks the RIFF chunks and returns the `data` chunk body. afconvert inserts an
// FLLR padding chunk before data, so a blind 44-byte slice would be wrong.
function wavToPcm(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let off = 12;
  while (off + 8 <= buf.length) {
    const id   = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'data') return buf.subarray(body, body + size);
    off = body + size + (size & 1); // chunks are word-aligned
  }
  throw new Error('no data chunk in WAV');
}

function silence(bytes) { return Buffer.alloc(bytes); }
function msFromBytes(bytes) { return Math.round(bytes / BYTES_PER_MS); }

function validateScenario(scn, file) {
  for (const key of ['script', 'facts', 'requiredSummaryFacts', 'transcriptFacts', 'selfName']) {
    if (scn[key] == null) throw new Error(`${file}: missing "${key}"`);
  }
  if (!Array.isArray(scn.script) || scn.script.length === 0) throw new Error(`${file}: "script" must be a non-empty array`);
  const ids = new Set(scn.facts.map((f) => f.id));
  for (const id of [...scn.requiredSummaryFacts, ...(scn.niceToHaveSummaryFacts || []), ...scn.transcriptFacts]) {
    if (!ids.has(id)) throw new Error(`${file}: fact id "${id}" referenced but not defined in "facts"`);
  }
}

// buildScenario synthesises, assembles and writes one scenario's fixture. Returns its name.
function buildScenario(scn, file) {
  validateScenario(scn, file);
  const name     = scn.name || path.basename(file, '.json');
  const gapMs    = scn.gapMs ?? DEFAULT_GAP_MS;
  const voices   = scn.voices || {};
  const outDir   = path.join(FIXTURES_DIR, name);
  fs.mkdirSync(outDir, { recursive: true });

  const tabParts = [];
  const micParts = [];
  const events   = [];
  const scriptLines = [];
  let byteCursor = 0; // shared timeline position, in bytes, identical for both tracks

  for (const turn of scn.script) {
    // Resolve voice name and markup from the voices dict.
    // Supports both legacy string form ("[[pbas 62]]...") and object form ({say, markup}).
    const voiceEntry = voices[turn.speaker];
    let voiceName = 'Milena';
    let markup    = '';
    if (voiceEntry && typeof voiceEntry === 'object') {
      voiceName = voiceEntry.say  || 'Milena';
      markup    = voiceEntry.markup || '';
    } else if (typeof voiceEntry === 'string') {
      markup = voiceEntry;
    }

    process.stderr.write(`  synth: ${turn.speaker} (${turn.track}, voice=${voiceName}) "${turn.text.slice(0, 40)}…"\n`);
    const pcm = synth(voiceName, markup, turn.text);
    const aMs = msFromBytes(byteCursor);
    const bMs = msFromBytes(byteCursor + pcm.length);

    // emitsEvent (shared with the harness): tab turns not marked event:false emit speaker events.
    // event:false simulates a hidden tab period that diarization must re-attribute by voice.
    if (turn.track === 'tab') {
      tabParts.push(pcm);
      micParts.push(silence(pcm.length));
      if (emitsEvent(turn)) {
        events.push({ type: 'speaker_event', speaker: turn.speaker, event: 'start', ts: T0 + aMs });
        events.push({ type: 'speaker_event', speaker: turn.speaker, event: 'stop',  ts: T0 + bMs });
      }
    } else {
      micParts.push(pcm);
      tabParts.push(silence(pcm.length));
      // mic turn carries no speaker_event → exercises the self_name fallback
    }

    scriptLines.push(`[${String(aMs).padStart(6)}ms] ${turn.track}/${turn.speaker}: ${turn.text}`);
    byteCursor += pcm.length;

    const gapBytes = gapMs * BYTES_PER_MS;
    tabParts.push(silence(gapBytes));
    micParts.push(silence(gapBytes));
    byteCursor += gapBytes;
  }

  const tabPcm = Buffer.concat(tabParts);
  const micPcm = Buffer.concat(micParts);
  if (tabPcm.length !== micPcm.length) {
    throw new Error(`${name}: track length mismatch tab=${tabPcm.length} mic=${micPcm.length}`);
  }

  // No expected.json: the scenario JSON is the single source of truth and everything the harness
  // asserts is derived from it at test time (see scenario.js). The fixture holds only the
  // generated artifacts that can't be recomputed without `say`: the two PCM tracks and events.
  fs.writeFileSync(path.join(outDir, 'tab.pcm.gz'), zlib.gzipSync(tabPcm));
  fs.writeFileSync(path.join(outDir, 'mic.pcm.gz'), zlib.gzipSync(micPcm));
  fs.writeFileSync(path.join(outDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'script.txt'),
    `# E2E fixture "${name}" — ${scn.script.length} turns, ${msFromBytes(tabPcm.length)}ms\n` +
    `# self_name=${scn.selfName}, gapMs=${gapMs}, T0=${T0}\n\n` + scriptLines.join('\n') + '\n');

  process.stderr.write(`  → ${outDir}  (${(tabPcm.length / BYTES_PER_MS / 1000).toFixed(1)}s/track, ${events.length} events)\n`);
  return name;
}

function main() {
  const args  = process.argv.slice(2);
  const files = args.length
    ? args
    : fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.json')).map((f) => path.join(SCENARIOS_DIR, f));

  if (files.length === 0) { process.stderr.write(`no scenarios found in ${SCENARIOS_DIR}\n`); process.exit(1); }

  for (const file of files) {
    const abs = path.isAbsolute(file) ? file : path.resolve(file);
    process.stderr.write(`scenario: ${path.relative(process.cwd(), abs)}\n`);
    const scn = JSON.parse(fs.readFileSync(abs, 'utf8'));
    buildScenario(scn, abs);
  }
  process.stderr.write(`\ndone: ${files.length} scenario(s) → ${FIXTURES_DIR}\n`);
}

main();
