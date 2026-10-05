'use strict';

// GigaAM-v3 e2e RNNT speech recogniser over onnxruntime-node.
//
// Graphs:
//   frontend.onnx (committed here, from scripts/export-gigaam-frontend.py): wav → log-mel
//   <model_dir>/v3_e2e_rnnt_{encoder,decoder,joint}.onnx + v3_e2e_rnnt_vocab.txt — the
//   published ONNX export (huggingface.co/istupakov/gigaam-v3-onnx, MIT).
//
// Decoding is a port of gigaam.decoding.RNNTGreedyDecoding. The decoder/joint graphs are
// exported with batch size 1, so chunks are decoded one at a time; the prediction-network
// output is cached and only recomputed after a non-blank emission.

const fs = require('node:fs');
const path = require('node:path');
const { parseVocab, tokensToWords } = require('../words.js');
const { unpackedPath } = require('../../util.js');
const { SAMPLE_RATE } = require('../../audio.js');

const FRONTEND = unpackedPath(path.join(__dirname, 'frontend.onnx'));
const MIN_SAMPLES = 320 + 160 * 8; // a few encoder frames; shorter chunks are skipped
const ENC_DIM = 768;
const PRED_DIM = 320;
const MAX_SYMBOLS_PER_FRAME = 10;

const MODEL_FILES = {
  encoder: 'v3_e2e_rnnt_encoder.onnx',
  decoder: 'v3_e2e_rnnt_decoder.onnx',
  joint:   'v3_e2e_rnnt_joint.onnx',
  vocab:   'v3_e2e_rnnt_vocab.txt',
};

// modelFiles lists the files a model dir must contain, for validation and error messages.
function modelFiles(modelDir) {
  const out = {};
  for (const [k, f] of Object.entries(MODEL_FILES)) out[k] = path.join(modelDir, f);
  return out;
}

class Recognizer {
  // ort is the onnxruntime-node module (injected so tests and the worker share one copy).
  constructor(ort, modelDir, opts = {}) {
    this.ort = ort;
    this.files = modelFiles(modelDir);
    this.threads = opts.threads || 0;
  }

  async load() {
    const { ort, files } = this;
    const so = { graphOptimizationLevel: 'all', logSeverityLevel: 3 };
    if (this.threads > 0) so.intraOpNumThreads = this.threads;
    // Tiny per-step graphs: threading overhead outweighs any gain.
    const small = { ...so, intraOpNumThreads: 1, interOpNumThreads: 1 };
    [this.frontend, this.encoder, this.decoder, this.joint] = await Promise.all([
      ort.InferenceSession.create(FRONTEND, so),
      ort.InferenceSession.create(files.encoder, so),
      ort.InferenceSession.create(files.decoder, small),
      ort.InferenceSession.create(files.joint, small),
    ]);
    this.vocab = parseVocab(fs.readFileSync(files.vocab, 'utf8'));
    this.blank = this.vocab.length - 1; // last id is <blk>
    if (this.vocab[this.blank] !== '<blk>') throw new Error(`unexpected vocab: last token ${this.vocab[this.blank]}`);
    return this;
  }

  // transcribe decodes one chunk (Float32Array, 16 kHz, <= ~25 s). Returns words with
  // timestamps relative to the chunk start, shifted by offsetMs.
  async transcribe(wav, offsetMs = 0) {
    if (wav.length < MIN_SAMPLES) return [];
    const { ort } = this;

    const fe = await this.frontend.run({
      wav: new ort.Tensor('float32', wav, [1, wav.length]),
      length: new ort.Tensor('int64', BigInt64Array.from([BigInt(wav.length)]), [1]),
    });
    const enc = await this.encoder.run({ audio_signal: fe.features, length: fe.feature_lengths });
    const encoded = enc.encoded.data;            // [1, 768, T] channel-major
    const T = enc.encoded.dims[2];
    const encLen = Math.min(T, Number(enc.encoded_len.data[0]));

    const { tokens, frames } = await this._greedy(encoded, T, encLen);
    const frameMs = (wav.length / SAMPLE_RATE * 1000) / encLen;
    return tokensToWords(this.vocab, tokens, frames, frameMs, offsetMs);
  }

  async _greedy(encoded, T, encLen) {
    const { ort } = this;
    const tokens = [];
    const frames = [];

    let h = new ort.Tensor('float32', new Float32Array(PRED_DIM), [1, 1, PRED_DIM]);
    let c = new ort.Tensor('float32', new Float32Array(PRED_DIM), [1, 1, PRED_DIM]);
    // Start-of-sequence: blank label (its embedding is the zero padding row) with zero state —
    // equivalent to gigaam's predict(None, None).
    let pred = await this._predict(this.blank, h, c);
    h = pred.h; c = pred.c;
    let g = new ort.Tensor('float32', pred.dec.data, [1, PRED_DIM, 1]);

    const frame = new Float32Array(ENC_DIM);
    for (let t = 0; t < encLen; t++) {
      for (let d = 0; d < ENC_DIM; d++) frame[d] = encoded[d * T + t];
      const f = new ort.Tensor('float32', frame, [1, ENC_DIM, 1]);

      for (let s = 0; s < MAX_SYMBOLS_PER_FRAME; s++) {
        const out = await this.joint.run({ enc: f, dec: g });
        const k = argmax(out.joint.data);
        if (k === this.blank) break;
        tokens.push(k);
        frames.push(t);
        pred = await this._predict(k, h, c);
        h = pred.h; c = pred.c;
        g = new ort.Tensor('float32', pred.dec.data, [1, PRED_DIM, 1]);
      }
    }
    return { tokens, frames };
  }

  async _predict(label, h, c) {
    const { ort } = this;
    const out = await this.decoder.run({
      x: new ort.Tensor('int64', BigInt64Array.from([BigInt(label)]), [1, 1]),
      'h.1': h,
      'c.1': c,
    });
    return { dec: out.dec, h: out.h, c: out.c };
  }
}

function argmax(a) {
  let best = 0;
  for (let i = 1; i < a.length; i++) if (a[i] > a[best]) best = i;
  return best;
}

module.exports = { Recognizer, modelFiles };
