'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const asr    = require('../src/asr');
const { forSession } = require('../src/config.js');

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('engines share one interface', () => {
  for (const engine of Object.values(asr.engines)) {
    assert.equal(typeof engine.name, 'string');
    assert.equal(typeof engine.label, 'string');
    for (const fn of ['options', 'missing', 'run']) assert.equal(typeof engine[fn], 'function', `${engine.name}.${fn}`);
  }
});

test('select: GigaAM for Russian by default, Whisper otherwise or when GigaAM is missing', () => {
  const dir = tmpDir('asr-test-');
  for (const f of ['v3_e2e_rnnt_encoder.onnx', 'v3_e2e_rnnt_decoder.onnx', 'v3_e2e_rnnt_joint.onnx', 'v3_e2e_rnnt_vocab.txt']) {
    fs.writeFileSync(path.join(dir, f), '');
  }
  const whisperModel = path.join(dir, 'ggml.bin');
  fs.writeFileSync(whisperModel, '');

  const base = { gigaam_model_dir: dir, model: whisperModel };

  const ru = asr.select({ ...base, language: 'ru' });
  assert.equal(ru.name, 'gigaam');
  assert.equal(ru.label, 'GigaAM');
  assert.equal(ru.error, null);

  assert.equal(asr.select({ ...base, language: 'en' }).name, 'whisper');
  assert.equal(asr.select({ ...base, language: 'en' }).note, null);
  assert.equal(asr.select({ ...base, language: 'ru', asr_ru: 'whisper' }).name, 'whisper');

  // Missing GigaAM model → Whisper with a note, not a failure.
  const fallback = asr.select({ ...base, language: 'ru', gigaam_model_dir: path.join(dir, 'nope') });
  assert.equal(fallback.name, 'whisper');
  assert.equal(fallback.error, null);
  assert.match(fallback.note, /GigaAM/);

  // Nothing usable left → error.
  const none = asr.select({ ...base, language: 'ru', gigaam_model_dir: null, model: null });
  assert.match(none.error, /Whisper/);
});

test('gigaam.missing: names the absent files, or the unset folder', () => {
  const { gigaam } = asr.engines;
  assert.deepEqual(gigaam.missing({ modelDir: null }), ['папка модели не указана']);
  const dir = tmpDir('asr-gigaam-');
  fs.writeFileSync(path.join(dir, 'v3_e2e_rnnt_vocab.txt'), '');
  assert.deepEqual(gigaam.missing({ modelDir: dir }).map(f => path.basename(f)),
    ['v3_e2e_rnnt_encoder.onnx', 'v3_e2e_rnnt_decoder.onnx', 'v3_e2e_rnnt_joint.onnx']);
});

test('config.forSession: language from meta.json, cfg untouched otherwise', () => {
  const cfg = { language: 'en', model: 'x' };
  const dir = tmpDir('asr-session-');
  assert.equal(forSession(cfg, dir), cfg); // no meta.json

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ language: 'ru' }));
  assert.deepEqual(forSession(cfg, dir), { language: 'ru', model: 'x' });
  assert.equal(cfg.language, 'en');
});
