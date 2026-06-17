'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { parseEvents, build, render, splitAtBoundaries, MATCH_TOLERANCE_MS } = require('../src/mapping.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mapping-test-'));
}

test('parseEvents: pairs start/stop, handles duplicate starts, closes open intervals', async () => {
  const dir = makeTempDir();
  const p   = path.join(dir, 'events.jsonl');
  fs.writeFileSync(p, [
    '{"type":"speaker_event","speaker":"Denis","event":"start","ts":1000}',
    '{"type":"speaker_event","speaker":"Denis","event":"stop","ts":5000}',
    '{"type":"session_stop","ts":5500}',
    '{"type":"speaker_event","speaker":"Anna","event":"start","ts":6000}',
    '{"type":"speaker_event","speaker":"Anna","event":"start","ts":6200}', // duplicate start → ignored
    '{"type":"speaker_event","speaker":"Anna","event":"stop","ts":9000}',
    '{"type":"speaker_event","speaker":"Bob","event":"start","ts":10000}', // no stop → closed at lastTS
    '',
  ].join('\n'));

  const ivs = await parseEvents(p);

  assert.equal(ivs.length, 3, `got ${ivs.length} intervals, want 3: ${JSON.stringify(ivs)}`);

  assert.deepEqual(ivs[0], { speaker: 'Denis', startMs: 1000, endMs: 5000 });
  assert.deepEqual(ivs[1], { speaker: 'Anna',  startMs: 6000, endMs: 9000 });
  assert.equal(ivs[2].speaker,  'Bob');
  assert.equal(ivs[2].startMs, 10000);
});

test('build: attributes tab/mic segments to correct speakers', () => {
  const intervals = [
    { speaker: 'Denis', startMs: 1000, endMs: 5000 },
    { speaker: 'Anna',  startMs: 6000, endMs: 9000 },
  ];
  const tracks = [
    { source: 'mic', t0Ms: 1000, segments: [
      { startMs: 0, endMs: 3000, text: 'привет' }, // epoch 1000–4000 → Denis
    ]},
    { source: 'tab', t0Ms: 1000, segments: [
      { startMs: 5000,  endMs: 7500,  text: 'да' },  // epoch 6000–8500 → Anna
      { startMs: 14000, endMs: 16000, text: 'хм' },  // epoch 15000–17000 → nobody
    ]},
  ];

  const segs = build(tracks, intervals, '');
  assert.equal(segs.length, 3, `got ${segs.length} segments, want 3`);

  assert.equal(segs[0].speaker, 'Denis'); assert.equal(segs[0].text, 'привет');
  assert.equal(segs[1].speaker, 'Anna');  assert.equal(segs[1].text, 'да');
  assert.equal(segs[2].speaker, 'unknown');
});

test('build: mic segments without DOM events fall back to selfName', () => {
  const tracks = [
    { source: 'mic', t0Ms: 1000, segments: [{ startMs: 0, endMs: 2000, text: 'моя реплика' }] },
    { source: 'tab', t0Ms: 1000, segments: [{ startMs: 0, endMs: 2000, text: 'чужая реплика' }] },
  ];

  const segs = build(tracks, [], 'Вы');
  const mic = segs.find(s => s.source === 'mic');
  const tab = segs.find(s => s.source === 'tab');

  assert.equal(mic.speaker, 'Вы',     `mic speaker = "${mic.speaker}", want "Вы"`);
  assert.equal(tab.speaker, 'unknown', `tab speaker = "${tab.speaker}", want "unknown"`);
});

test('attribution tolerance: segment starting 300ms before DOM interval is still matched', () => {
  // attribute is internal; test it through build()
  const intervals = [{ speaker: 'Denis', startMs: 2000, endMs: 5000 }];
  const tracks = [
    { source: 'tab', t0Ms: 0, segments: [{ startMs: 1700, endMs: 4000, text: 'x' }] },
  ];
  const segs = build(tracks, intervals, '');
  assert.equal(segs[0].speaker, 'Denis', `got "${segs[0].speaker}", want "Denis" (within tolerance)`);
});

// --- splitAtBoundaries ---

test('splitAtBoundaries: returns null when no boundary falls inside segment', () => {
  const intervals = [{ speaker: 'Alice', startMs: 0, endMs: 5000 }];
  assert.equal(splitAtBoundaries(0, 5000, 'one two three', intervals), null);
});

test('splitAtBoundaries: splits evenly at midpoint boundary', () => {
  const intervals = [
    { speaker: 'Alice', startMs: 0,    endMs: 2000 },
    { speaker: 'Bob',   startMs: 2000, endMs: 4000 },
  ];
  const parts = splitAtBoundaries(0, 4000, 'one two three four', intervals);
  assert.ok(parts !== null);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].startMs, 0);    assert.equal(parts[0].endMs, 2000);
  assert.equal(parts[1].startMs, 2000); assert.equal(parts[1].endMs, 4000);
  assert.equal(parts[0].text + ' ' + parts[1].text, 'one two three four');
});

test('splitAtBoundaries: gap between speakers produces three parts', () => {
  // Alice 0–1000, gap 1000–3000, Bob 3000–4000
  const intervals = [
    { speaker: 'Alice', startMs: 0,    endMs: 1000 },
    { speaker: 'Bob',   startMs: 3000, endMs: 4000 },
  ];
  // 8 words: "a b c d e f g h"
  // boundaries inside [0,4000]: Alice-end=1000, Bob-start=3000
  const parts = splitAtBoundaries(0, 4000, 'a b c d e f g h', intervals);
  assert.ok(parts !== null);
  assert.equal(parts[0].startMs, 0);
  assert.equal(parts[parts.length - 1].endMs, 4000);
  // first part = Alice territory; last part = Bob territory
  assert.ok(parts[0].text.length > 0);
  assert.ok(parts[parts.length - 1].text.length > 0);
});

// --- build with splitting ---

test('build: Whisper segment spanning two back-to-back speakers is split correctly', () => {
  const intervals = [
    { speaker: 'Alice', startMs: 0,    endMs: 2000 },
    { speaker: 'Bob',   startMs: 2000, endMs: 4000 },
  ];
  const tracks = [{
    source: 'tab', t0Ms: 0, segments: [
      { startMs: 0, endMs: 4000, text: 'alice says this bob replies now' },
    ],
  }];

  const segs = build(tracks, intervals, '');
  assert.equal(segs.length, 2, `got ${segs.length} segments, want 2`);
  assert.equal(segs[0].speaker, 'Alice');
  assert.equal(segs[1].speaker, 'Bob');
  assert.ok(segs[0].text.length > 0, 'Alice part should have text');
  assert.ok(segs[1].text.length > 0, 'Bob part should have text');
  assert.equal(segs[0].text + ' ' + segs[1].text, 'alice says this bob replies now');
});

test('build: short overlap (200ms gap) still splits speakers correctly', () => {
  // Quick succession: Alice ends at 1800, Bob starts at 2000 — 200ms silence
  const intervals = [
    { speaker: 'Alice', startMs: 0,    endMs: 1800 },
    { speaker: 'Bob',   startMs: 2000, endMs: 4000 },
  ];
  const tracks = [{
    source: 'tab', t0Ms: 0, segments: [
      { startMs: 0, endMs: 4000, text: 'alice говорит bob отвечает' },
    ],
  }];

  const segs = build(tracks, intervals, '');
  assert.ok(segs.length >= 2, `want ≥2 segments, got ${segs.length}`);
  assert.equal(segs[0].speaker, 'Alice');
  assert.equal(segs[segs.length - 1].speaker, 'Bob');
});

test('build: segment fully within one speaker interval is not split', () => {
  const intervals = [
    { speaker: 'Denis', startMs: 0,    endMs: 5000 },
    { speaker: 'Anna',  startMs: 7000, endMs: 9000 },
  ];
  const tracks = [{
    source: 'tab', t0Ms: 0, segments: [
      { startMs: 1000, endMs: 4000, text: 'только денис говорит' },
    ],
  }];

  const segs = build(tracks, intervals, '');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].speaker, 'Denis');
  assert.equal(segs[0].text, 'только денис говорит');
});

test('render: consecutive same-speaker lines are merged', () => {
  const segs = [
    { speaker: 'Denis', startMs: 1000, endMs: 2000, text: 'раз' },
    { speaker: 'Denis', startMs: 2000, endMs: 3000, text: 'два' },
    { speaker: 'Anna',  startMs: 3000, endMs: 4000, text: 'три' },
  ];
  const out  = render(segs, 1000);
  const want = '[00:00] Denis: раз два \n[00:02] Anna: три';
  assert.equal(out, want, `render =\n${JSON.stringify(out)}\nwant\n${JSON.stringify(want)}`);
});
