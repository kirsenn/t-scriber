'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const text   = require('../src/asr/gigaam/text.js');
const vad    = require('../src/asr/gigaam/vad.js');

const w = (t, startMs, endMs) => ({ text: t, startMs, endMs });

test('parseVocab: "<piece> <id>" lines, pieces may be a bare marker', () => {
  const vocab = text.parseVocab('<unk> 0\n. 1\n▁ 2\nпри 3\n▁при 4\n<blk> 5\n');
  assert.deepEqual(vocab, ['<unk>', '.', '▁', 'при', '▁при', '<blk>']);
});

test('tokensToWords: groups pieces at ▁, timestamps from frames + offset', () => {
  const vocab = ['<unk>', '▁При', 'вет', '.', '▁Как', '▁дела', '?'];
  const words = text.tokensToWords(vocab, [1, 2, 3, 0, 4, 5, 6], [0, 1, 2, 3, 10, 12, 13], 40, 1000);
  assert.deepEqual(words, [
    w('Привет.', 1000, 1120),
    w('Как', 1400, 1440),
    w('дела?', 1480, 1560),
  ]);
});

test('dropFillers: removes hesitations, moves sentence punctuation, re-capitalises', () => {
  const out = text.dropFillers([
    w('Э,', 0, 1), w('мы', 1, 2), w('сейчас', 2, 3), w('э-э', 3, 4), w('выкатываем', 4, 5), w('ммм.', 5, 6),
    w('э', 6, 7), w('потом', 7, 8), w('Хм...', 8, 9), w('да.', 9, 10),
  ]);
  assert.deepEqual(out.map(x => x.text), ['Мы', 'сейчас', 'выкатываем.', 'Потом...', 'Да.']);
});

test('dropFillers: keeps real one-letter words', () => {
  const out = text.dropFillers([w('А', 0, 1), w('я', 1, 2), w('в', 2, 3), w('Москве.', 3, 4), w('Ааа...', 4, 5)]);
  assert.deepEqual(out.map(x => x.text), ['А', 'я', 'в', 'Москве.']);
});

test('applyReplacements: stems with case endings, phrases, punctuation, overrides', () => {
  const m = text.compileReplacements({ 'джир': 'Jira', 'питон': null });
  const out = text.applyReplacements([
    w('выкатываем', 0, 1), w('Конкордиуму,', 1, 2), w('платим', 2, 3), w('гугл', 3, 4), w('пэй.', 4, 5),
    w('В', 5, 6), w('джире', 6, 7), w('на', 7, 8), w('питоне.', 8, 9),
  ], m);
  assert.deepEqual(out.map(x => x.text), ['выкатываем', 'Concordium,', 'платим', 'Google Pay.', 'В', 'Jira', 'на', 'питоне.']);
  assert.deepEqual(out[3], w('Google Pay.', 3, 5));
});

test('applyReplacements: stem must match the whole word', () => {
  const out = text.applyReplacements([w('питомнике', 0, 1), w('впн-ом', 1, 2)], text.compileReplacements());
  assert.deepEqual(out.map(x => x.text), ['питомнике', 'впн-ом']);
});

test('toSegments: splits on sentence ends and long pauses', () => {
  const segs = text.toSegments([
    w('Привет.', 0, 500), w('Как', 600, 800), w('дела', 800, 1000), w('там', 4000, 4300), w('вообще?', 4300, 4800),
  ]);
  assert.deepEqual(segs, [
    { startMs: 0, endMs: 500, text: 'Привет.' },
    { startMs: 600, endMs: 1000, text: 'Как дела' },
    { startMs: 4000, endMs: 4800, text: 'там вообще?' },
  ]);
});

// probs helper: one value per 512-sample (32 ms) VAD frame.
function probsFor(spans, nFrames) {
  const p = new Float32Array(nFrames);
  for (const [a, b] of spans) for (let i = a; i < b; i++) p[i] = 0.9;
  return p;
}

test('vad.speechTimestamps: detects regions, drops blips, pads edges', () => {
  // 0.32 s blip (too short), speech 1.6–3.2 s, speech 6.4–8.0 s, 10 s total.
  const probs = probsFor([[10, 12], [50, 100], [200, 250]], 313);
  const ts = vad.speechTimestamps(probs, 313 * 512);
  assert.equal(ts.length, 2);
  const pad = 0.15 * 16000;
  assert.deepEqual(ts[0], { start: 50 * 512 - pad, end: 100 * 512 + pad });
  assert.deepEqual(ts[1], { start: 200 * 512 - pad, end: 250 * 512 + pad });
});

test('vad.chunk: merges close regions, caps length, cuts at the quietest frame', () => {
  const sr = 16000;
  const merged = vad.chunk([{ start: 0, end: 2 * sr }, { start: 2.3 * sr, end: 4 * sr }], new Float32Array(200));
  assert.deepEqual(merged, [{ start: 0, end: 4 * sr }]);

  // One 50 s region with a dip at ~17 s → first cut lands on the dip, all chunks ≤ 20 s.
  const nFrames = Math.ceil(50 * sr / 512);
  const probs = new Float32Array(nFrames).fill(0.9);
  const dip = Math.round(17 * sr / 512);
  probs[dip] = 0.1;
  const chunks = vad.chunk([{ start: 0, end: 50 * sr }], probs);
  assert.equal(chunks[0].end, dip * 512);
  for (const c of chunks) assert.ok(c.end - c.start <= 20 * sr, JSON.stringify(c));
  assert.equal(chunks[chunks.length - 1].end, 50 * sr);
});
