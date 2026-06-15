'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { cleanOutput, splitChunks } = require('../src/analyze.js');

test('cleanOutput: strips reasoning pass, keeps answer', () => {
  const raw  = '<|channel>thought\nMeeting analyst. Let me draft...\n*Draft 1:* ...\n<channel|>## Краткое резюме\nВстреча краткая.\n\n## Ключевые решения\n—<end_of_turn>';
  const got  = cleanOutput(raw);
  const want = '## Краткое резюме\nВстреча краткая.\n\n## Ключевые решения\n—';

  assert.equal(got, want, `cleanOutput =\n${JSON.stringify(got)}\nwant\n${JSON.stringify(want)}`);
  assert(!got.includes('thought'), 'reasoning leaked: "thought"');
  assert(!got.includes('Draft'),   'reasoning leaked: "Draft"');
});

test('cleanOutput: no reasoning delimiter → content returned as-is (minus control tokens)', () => {
  const got = cleanOutput('## Резюме\nтекст<end_of_turn>');
  assert.equal(got, '## Резюме\nтекст');
});

test('splitChunks: short text stays as single chunk', () => {
  const got = splitChunks('one\ntwo\nthree', 1000);
  assert.equal(got.length, 1, `got ${got.length} chunks, want 1`);
});

test('splitChunks: splits on line boundaries, no content lost', () => {
  const lines = Array.from({ length: 10 }, () => 'x'.repeat(20));
  const text  = lines.join('\n');
  const chunks = splitChunks(text, 50);

  assert(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);

  for (const c of chunks) {
    assert(c.length <= 50, `chunk exceeds maxChars: ${c.length}`);
  }

  const total = chunks.join('').split('').filter(ch => ch === 'x').length;
  assert.equal(total, 200, `lost content: counted ${total} x's, want 200`);
});
