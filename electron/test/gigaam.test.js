'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const text   = require('../src/asr/gigaam/text.js');

const w = (t, startMs, endMs) => ({ text: t, startMs, endMs });

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
