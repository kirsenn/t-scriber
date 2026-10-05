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

const PARAKEET_FILES = ['nemo128.onnx', 'encoder-model.onnx', 'encoder-model.onnx.data', 'decoder_joint-model.onnx', 'vocab.txt'];

test('select: GigaAM for Russian, Parakeet otherwise; each falls back to the other for Russian', () => {
  const dir = tmpDir('asr-test-');
  for (const f of ['v3_e2e_rnnt_encoder.onnx', 'v3_e2e_rnnt_decoder.onnx', 'v3_e2e_rnnt_joint.onnx', 'v3_e2e_rnnt_vocab.txt']) {
    fs.writeFileSync(path.join(dir, f), '');
  }
  for (const f of PARAKEET_FILES) fs.writeFileSync(path.join(dir, f), '');
  const nope = path.join(dir, 'nope');
  const base = { gigaam_model_dir: dir, parakeet_model_dir: dir };

  const ru = asr.select({ ...base, language: 'ru' });
  assert.equal(ru.name, 'gigaam');
  assert.equal(ru.label, 'GigaAM');
  assert.equal(ru.error, null);
  assert.equal(ru.note, null);
  assert.equal(asr.select({ ...base, language: 'ru', asr_ru: 'parakeet' }).name, 'parakeet');
  assert.equal(asr.select({ ...base, language: 'ru', asr_ru: 'whisper' }).name, 'gigaam'); // legacy value

  const en = asr.select({ ...base, language: 'en' });
  assert.equal(en.name, 'parakeet');
  assert.equal(en.note, null);
  assert.equal(asr.select({ ...base, language: 'de' }).name, 'parakeet');

  // Missing preferred Russian model → the other engine with a note, not a failure.
  const fallback = asr.select({ ...base, language: 'ru', gigaam_model_dir: nope });
  assert.equal(fallback.name, 'parakeet');
  assert.equal(fallback.error, null);
  assert.match(fallback.note, /GigaAM.*Parakeet/);
  assert.equal(asr.select({ ...base, language: 'ru', asr_ru: 'parakeet', parakeet_model_dir: null }).name, 'gigaam');

  // Nothing usable left → error naming what is missing. GigaAM never covers English.
  const en0 = asr.select({ ...base, language: 'en', parakeet_model_dir: null });
  assert.equal(en0.name, null);
  assert.match(en0.error, /Parakeet/);
  assert.doesNotMatch(en0.error, /GigaAM/);
  const ru0 = asr.select({ language: 'ru', gigaam_model_dir: nope, parakeet_model_dir: null });
  assert.match(ru0.error, /GigaAM.*Parakeet/);
});

test('gigaam.missing: names the absent files, or the unset folder', () => {
  const { gigaam } = asr.engines;
  assert.deepEqual(gigaam.missing({ modelDir: null }), ['папка модели не указана']);
  const dir = tmpDir('asr-gigaam-');
  fs.writeFileSync(path.join(dir, 'v3_e2e_rnnt_vocab.txt'), '');
  assert.deepEqual(gigaam.missing({ modelDir: dir }).map(f => path.basename(f)),
    ['v3_e2e_rnnt_encoder.onnx', 'v3_e2e_rnnt_decoder.onnx', 'v3_e2e_rnnt_joint.onnx']);
});

test('parakeet.missing: fp32 needs the external weights, int8 its own graphs', () => {
  const { parakeet } = asr.engines;
  assert.deepEqual(parakeet.missing(parakeet.options({ parakeet_model_dir: null })), ['папка модели не указана']);
  const dir = tmpDir('asr-parakeet-');
  for (const f of PARAKEET_FILES) if (f !== 'encoder-model.onnx.data') fs.writeFileSync(path.join(dir, f), '');
  assert.deepEqual(parakeet.missing(parakeet.options({ parakeet_model_dir: dir })).map(f => path.basename(f)),
    ['encoder-model.onnx.data']);
  assert.deepEqual(parakeet.missing(parakeet.options({ parakeet_model_dir: dir, parakeet_quant: 'int8' })).map(f => path.basename(f)),
    ['encoder-model.int8.onnx', 'decoder_joint-model.int8.onnx']);
});

test('config.forSession: language from meta.json, cfg untouched otherwise', () => {
  const cfg = { language: 'en', model: 'x' };
  const dir = tmpDir('asr-session-');
  assert.equal(forSession(cfg, dir), cfg); // no meta.json

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ language: 'ru' }));
  assert.deepEqual(forSession(cfg, dir), { language: 'ru', model: 'x' });
  assert.equal(cfg.language, 'en');
});
