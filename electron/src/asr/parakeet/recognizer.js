'use strict';

// NVIDIA Parakeet-TDT-0.6B-v3 speech recogniser over onnxruntime-node. Multilingual (25
// European languages incl. English and Russian), emits punctuation and capitalisation itself.
//
// Graphs — the published ONNX export (huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx, CC-BY-4.0):
//   nemo128.onnx                    wav → 128-bin log-mel (NeMo preprocessor)
//   encoder-model[.int8].onnx       FastConformer encoder, 8× subsampling (one frame per 80 ms)
//   decoder_joint-model[.int8].onnx prediction network + joint, one step per call
//   vocab.txt                       "<piece> <id>" per line, last id is <blk>
//
// Decoding is a port of onnx_asr's NemoConformerTdt greedy loop: the joint returns token
// logits followed by duration logits, and the duration argmax says how many encoder frames to
// skip — that skipping is what makes TDT faster than plain RNNT.

const fs = require('node:fs');
const path = require('node:path');
const { parseVocab, tokensToWords } = require('../words.js');
const { SAMPLE_RATE } = require('../../audio.js');

const MIN_SAMPLES = 160 * 8 * 4; // a few encoder frames; shorter chunks are skipped
const FRAME_MS = 80;             // 10 ms hop × subsampling 8
const MAX_TOKENS_PER_STEP = 10;

// modelFiles lists the files a model dir must contain. quant is 'int8' or '' (fp32).
function modelFiles(modelDir, quant = '') {
  const sfx = quant ? `.${quant}` : '';
  const files = {
    preprocessor: path.join(modelDir, 'nemo128.onnx'),
    encoder:      path.join(modelDir, `encoder-model${sfx}.onnx`),
    decoderJoint: path.join(modelDir, `decoder_joint-model${sfx}.onnx`),
    vocab:        path.join(modelDir, 'vocab.txt'),
  };
  // The fp32 encoder keeps its weights in an external-data file next to the graph.
  if (!quant) files.encoderData = files.encoder + '.data';
  return files;
}

class Recognizer {
  // ort is the onnxruntime-node module (injected so tests and the worker share one copy).
  constructor(ort, modelDir, opts = {}) {
    this.ort = ort;
    this.files = modelFiles(modelDir, opts.quant || '');
    this.threads = opts.threads || 0;
  }

  async load() {
    const { ort, files } = this;
    const so = { graphOptimizationLevel: 'all', logSeverityLevel: 3 };
    if (this.threads > 0) so.intraOpNumThreads = this.threads;
    // Tiny per-step graph: threading overhead outweighs any gain.
    const small = { ...so, intraOpNumThreads: 1, interOpNumThreads: 1 };
    [this.preprocessor, this.encoder, this.decoderJoint] = await Promise.all([
      ort.InferenceSession.create(files.preprocessor, so),
      ort.InferenceSession.create(files.encoder, so),
      ort.InferenceSession.create(files.decoderJoint, small),
    ]);
    this.vocab = parseVocab(fs.readFileSync(files.vocab, 'utf8'));
    this.blank = this.vocab.length - 1;
    if (this.vocab[this.blank] !== '<blk>') throw new Error(`unexpected vocab: last token ${this.vocab[this.blank]}`);
    // Control tokens (<unk>, <pad>, <|...|>) are never text.
    this.control = new Set(this.vocab.flatMap((p, id) => (p.startsWith('<') && p.endsWith('>') ? [id] : [])));
    return this;
  }

  // transcribe decodes one chunk (Float32Array, 16 kHz, <= ~30 s). Returns words with
  // timestamps relative to the chunk start, shifted by offsetMs.
  async transcribe(wav, offsetMs = 0) {
    if (wav.length < MIN_SAMPLES) return [];
    const { ort } = this;

    const fe = await this.preprocessor.run({
      waveforms: new ort.Tensor('float32', wav, [1, wav.length]),
      waveforms_lens: new ort.Tensor('int64', BigInt64Array.from([BigInt(wav.length)]), [1]),
    });
    const enc = await this.encoder.run({ audio_signal: fe.features, length: fe.features_lens });
    const [, D, T] = enc.outputs.dims;            // [1, 1024, T] channel-major
    const encLen = Math.min(T, Number(enc.encoded_lengths.data[0]));

    const { tokens, frames } = await this._greedy(enc.outputs.data, D, T, encLen);
    const keep = tokens.map((k, i) => i).filter(i => !this.control.has(tokens[i]));
    const words = tokensToWords(this.vocab, keep.map(i => tokens[i]), keep.map(i => frames[i]), FRAME_MS, offsetMs);
    // TDT can place the last token at the final frame; never run past the chunk.
    const endMs = Math.round(offsetMs + wav.length / SAMPLE_RATE * 1000);
    for (const w of words) w.endMs = Math.min(w.endMs, endMs);
    return words;
  }

  async _greedy(encoded, D, T, encLen) {
    const { ort } = this;
    const V = this.vocab.length;
    const tokens = [];
    const frames = [];

    const stateDims = this.decoderJoint.inputMetadata.find(m => m.name === 'input_states_1').shape;
    const [layers, , hidden] = stateDims;
    let s1 = new ort.Tensor('float32', new Float32Array(layers * hidden), [layers, 1, hidden]);
    let s2 = new ort.Tensor('float32', new Float32Array(layers * hidden), [layers, 1, hidden]);
    let prev = this.blank;

    const frame = new Float32Array(D);
    const targetLength = new ort.Tensor('int32', Int32Array.from([1]), [1]);
    let t = 0;
    let emitted = 0;
    let loadedT = -1;
    while (t < encLen) {
      if (loadedT !== t) {
        for (let d = 0; d < D; d++) frame[d] = encoded[d * T + t];
        loadedT = t;
      }
      const out = await this.decoderJoint.run({
        encoder_outputs: new ort.Tensor('float32', frame, [1, D, 1]),
        targets: new ort.Tensor('int32', Int32Array.from([prev]), [1, 1]),
        target_length: targetLength,
        input_states_1: s1,
        input_states_2: s2,
      });
      const logits = out.outputs.data;
      const token = argmax(logits, 0, V);
      const step = argmax(logits, V, logits.length) - V; // durations are 0..4 frames

      if (token !== this.blank) {
        s1 = out.output_states_1;
        s2 = out.output_states_2;
        prev = token;
        tokens.push(token);
        frames.push(t);
        emitted++;
      }
      if (step > 0) {
        t += step;
        emitted = 0;
      } else if (token === this.blank || emitted === MAX_TOKENS_PER_STEP) {
        t += 1;
        emitted = 0;
      }
    }
    return { tokens, frames };
  }
}

function argmax(a, from, to) {
  let best = from;
  for (let i = from + 1; i < to; i++) if (a[i] > a[best]) best = i;
  return best;
}

module.exports = { Recognizer, modelFiles };
