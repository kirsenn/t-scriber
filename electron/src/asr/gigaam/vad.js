'use strict';

// Silero VAD for the GigaAM engine. GigaAM decodes at most ~25 s per pass, so long tracks are
// split into speech chunks first. Uses silero-vad.onnx — the "sequence" export from the
// silero-vad pip package (MIT), which scores a whole block of 32 ms frames per ONNX call —
// and a port of silero_vad.utils_vad.get_speech_timestamps_from_probs (with
// max_speech_duration_s = inf; over-long regions are split here at the quietest frame).

const { SAMPLE_RATE } = require('../../audio.js');

const FRAME = 512;          // samples per VAD frame at 16 kHz
const CONTEXT = 64;         // trailing samples of the previous frame prefixed to each frame
const BLOCK_FRAMES = 512;   // frames per ONNX call (~16 s)
const STATE = 128;

// speechProbs returns one speech probability per 512-sample frame of audio.
async function speechProbs(ort, session, audio) {
  const nFrames = Math.ceil(audio.length / FRAME);
  const probs = new Float32Array(nFrames);
  let h = new ort.Tensor('float32', new Float32Array(STATE), [1, 1, STATE]);
  let c = new ort.Tensor('float32', new Float32Array(STATE), [1, 1, STATE]);

  for (let first = 0; first < nFrames; first += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, nFrames - first);
    const width = CONTEXT + FRAME;
    const block = new Float32Array(n * width);
    for (let f = 0; f < n; f++) {
      const start = (first + f) * FRAME;
      // Context = last 64 samples of the previous frame (zeros before the first frame).
      for (let k = 0; k < CONTEXT; k++) {
        const idx = start - CONTEXT + k;
        block[f * width + k] = idx >= 0 && idx < audio.length ? audio[idx] : 0;
      }
      const end = Math.min(start + FRAME, audio.length);
      if (end > start) block.set(audio.subarray(start, end), f * width + CONTEXT);
    }
    const out = await session.run({ input: new ort.Tensor('float32', block, [n, width]), h, c });
    probs.set(out.speech_probs.data, first);
    h = out.hn;
    c = out.cn;
  }
  return probs;
}

// speechTimestamps converts per-frame probabilities into [{ start, end }] sample ranges.
function speechTimestamps(probs, nSamples, opts = {}) {
  const threshold = opts.threshold ?? 0.5;
  const negThreshold = Math.max(threshold - 0.15, 0.01);
  const minSpeech = SAMPLE_RATE * (opts.minSpeechMs ?? 250) / 1000;
  const minSilence = SAMPLE_RATE * (opts.minSilenceMs ?? 300) / 1000;
  const pad = SAMPLE_RATE * (opts.speechPadMs ?? 150) / 1000;

  const speeches = [];
  let triggered = false;
  let cur = null;
  let tempEnd = 0;

  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    const sample = FRAME * i;
    if (p >= threshold && tempEnd) tempEnd = 0;
    if (p >= threshold && !triggered) {
      triggered = true;
      cur = { start: sample };
      continue;
    }
    if (p < negThreshold && triggered) {
      if (!tempEnd) tempEnd = sample;
      if (sample - tempEnd < minSilence) continue;
      cur.end = tempEnd;
      if (cur.end - cur.start > minSpeech) speeches.push(cur);
      cur = null;
      tempEnd = 0;
      triggered = false;
    }
  }
  if (cur && nSamples - cur.start > minSpeech) {
    cur.end = nSamples;
    speeches.push(cur);
  }

  for (let i = 0; i < speeches.length; i++) {
    const s = speeches[i];
    if (i === 0) s.start = Math.trunc(Math.max(0, s.start - pad));
    if (i !== speeches.length - 1) {
      const next = speeches[i + 1];
      const silence = next.start - s.end;
      if (silence < 2 * pad) {
        s.end += Math.floor(silence / 2);
        next.start = Math.trunc(Math.max(0, next.start - Math.floor(silence / 2)));
      } else {
        s.end = Math.trunc(Math.min(nSamples, s.end + pad));
        next.start = Math.trunc(Math.max(0, next.start - pad));
      }
    } else {
      s.end = Math.trunc(Math.min(nSamples, s.end + pad));
    }
  }
  return speeches;
}

// chunk merges nearby speech regions into chunks of at most maxChunkS seconds, splitting
// over-long regions at the lowest-probability frame in the last third of the window.
function chunk(regions, probs, opts = {}) {
  const maxLen = Math.round((opts.maxChunkS ?? 20) * SAMPLE_RATE);
  const maxGap = Math.round((opts.maxGapS ?? 0.6) * SAMPLE_RATE);
  const pieces = [];

  for (const r of regions) {
    let s = r.start;
    while (r.end - s > maxLen) {
      const lo = Math.ceil((s + Math.round(maxLen * 2 / 3)) / FRAME);
      const hi = Math.floor((s + maxLen) / FRAME);
      let cut = lo < probs.length ? lo : hi;
      for (let f = lo + 1; f < hi && f < probs.length; f++) if (probs[f] < probs[cut]) cut = f;
      const at = Math.min(cut * FRAME, s + maxLen);
      pieces.push({ start: s, end: at });
      s = at;
    }
    pieces.push({ start: s, end: r.end });
  }

  const out = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && p.start - last.end < maxGap && p.end - last.start <= maxLen) last.end = p.end;
    else out.push({ ...p });
  }
  return out;
}

module.exports = { speechProbs, speechTimestamps, chunk, FRAME };
