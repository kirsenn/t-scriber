'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { run } = require('../src/diarize.js');
const { l2normalize, buildCentroids, matchToCentroid, agglomerativeCosine } =
  require('../src/diarize/cluster.js');

const SAMPLE_RATE = 16000;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diarize-test-'));
}

// Write a minimal 16-bit PCM file with `durationMs` of silence (runJs reads it but a fake
// embedder ignores the audio).
function writeFakePcm(filePath, durationMs = 10000) {
  const bytes = Math.round(durationMs * SAMPLE_RATE * 2 / 1000);
  fs.writeFileSync(filePath, Buffer.alloc(bytes));
}

// Build a dialogue array from a shorthand spec: [{sp, src, startMs, endMs}].
function makeDialogue(spec) {
  return spec.map(({ sp, src = 'tab', startMs, endMs }) => ({
    speaker: sp, source: src, startMs, endMs, text: 'dummy',
  }));
}

// Fake embedder injected via cfg._embedderOverride. `byStart` maps a segment's (relative)
// startMs to a raw embedding vector; missing or null → segment too short to embed.
function fakeEmbedder(byStart) {
  return {
    async embedSegment(_audio, startMs) {
      const v = byStart[startMs];
      return v ? l2normalize(Float32Array.from(v)) : null;
    },
  };
}

// ---- fast paths (return before any engine work) ---------------------------

test('diarize.run: unchanged when no unknowns exist', async () => {
  const dir = makeTempDir(); const pcm = path.join(dir, 'tab.pcm'); writeFakePcm(pcm);
  const dialogue = makeDialogue([
    { sp: 'Анна', startMs: 0, endMs: 3000 },
    { sp: 'Борис', startMs: 4000, endMs: 7000 },
  ]);
  const result = await run(null, pcm, dir, dialogue, { _embedderOverride: fakeEmbedder({}) });
  assert.deepEqual(result, dialogue);
});

test('diarize.run: unchanged when all tab segments are unknown', async () => {
  const dir = makeTempDir(); const pcm = path.join(dir, 'tab.pcm'); writeFakePcm(pcm);
  const dialogue = makeDialogue([
    { sp: 'unknown', startMs: 0, endMs: 3000 },
    { sp: 'unknown', startMs: 4000, endMs: 7000 },
  ]);
  const result = await run(null, pcm, dir, dialogue, { _embedderOverride: fakeEmbedder({}) });
  assert.deepEqual(result, dialogue);
});

test('diarize.run: unchanged when unknowns are mic-only', async () => {
  const dir = makeTempDir(); const pcm = path.join(dir, 'tab.pcm'); writeFakePcm(pcm);
  const dialogue = [
    { speaker: 'Анна',    source: 'tab', startMs: 0,    endMs: 3000, text: 'a' },
    { speaker: 'unknown', source: 'mic', startMs: 4000, endMs: 6000, text: 'b' },
  ];
  const result = await run(null, pcm, dir, dialogue, { _embedderOverride: fakeEmbedder({}) });
  assert.deepEqual(result, dialogue);
});

// ---- run() wiring through the JS engine (fake embedder) -------------------

test('diarize.run: matches unknowns to nearest anchor centroid', async () => {
  const dir = makeTempDir(); const pcm = path.join(dir, 'tab.pcm'); writeFakePcm(pcm);
  const dialogue = makeDialogue([
    { sp: 'Анна',    startMs: 0,    endMs: 2000 },
    { sp: 'Борис',   startMs: 2500, endMs: 4500 },
    { sp: 'unknown', startMs: 5000, endMs: 7000 }, // Anna-like
    { sp: 'unknown', startMs: 7500, endMs: 9500 }, // Boris-like
  ]);
  const embedder = fakeEmbedder({
    0:    [1, 0, 0, 0],
    2500: [0, 1, 0, 0],
    5000: [0.98, 0.02, 0, 0],
    7500: [0.01, 0.99, 0, 0],
  });
  const result = await run(null, pcm, dir, dialogue, { _embedderOverride: embedder });
  assert.equal(result[0].speaker, 'Анна');
  assert.equal(result[1].speaker, 'Борис');
  assert.equal(result[2].speaker, 'Анна',  'unknown[0] → Anna');
  assert.equal(result[3].speaker, 'Борис', 'unknown[1] → Boris');
});

test('diarize.run: an unknown below threshold becomes unknown_speaker_0', async () => {
  const dir = makeTempDir(); const pcm = path.join(dir, 'tab.pcm'); writeFakePcm(pcm);
  const dialogue = makeDialogue([
    { sp: 'Анна',    startMs: 0,    endMs: 2000 },
    { sp: 'unknown', startMs: 3000, endMs: 5000 }, // orthogonal to Anna → no match
  ]);
  const embedder = fakeEmbedder({ 0: [1, 0, 0, 0], 3000: [0, 0, 1, 0] });
  const result = await run(null, pcm, dir, dialogue, { _embedderOverride: embedder });
  assert.equal(result[1].speaker, 'unknown_speaker_0');
});

test('diarize.run: two distinct unmatched clusters → unknown_speaker_0 / _1 by first appearance', async () => {
  const dir = makeTempDir(); const pcm = path.join(dir, 'tab.pcm'); writeFakePcm(pcm);
  const dialogue = makeDialogue([
    { sp: 'Анна',    startMs: 0,    endMs: 2000 },  // anchor, unrelated to the two below
    { sp: 'unknown', startMs: 3000, endMs: 5000 },  // cluster A (appears first)
    { sp: 'unknown', startMs: 6000, endMs: 8000 },  // cluster B
    { sp: 'unknown', startMs: 9000, endMs: 11000 }, // cluster A again
  ]);
  const embedder = fakeEmbedder({
    0:    [1, 0, 0, 0],
    3000: [0, 1, 0, 0],
    6000: [0, 0, 1, 0],
    9000: [0, 0.98, 0.02, 0],
  });
  const result = await run(null, pcm, dir, dialogue, { _embedderOverride: embedder });
  assert.equal(result[1].speaker, 'unknown_speaker_0');
  assert.equal(result[2].speaker, 'unknown_speaker_1');
  assert.equal(result[3].speaker, 'unknown_speaker_0', 'third clusters with the first');
});

test('diarize.run: a too-short (null) unknown becomes unknown_speaker_0', async () => {
  const dir = makeTempDir(); const pcm = path.join(dir, 'tab.pcm'); writeFakePcm(pcm);
  const dialogue = makeDialogue([
    { sp: 'Анна',    startMs: 0,    endMs: 2000 },
    { sp: 'unknown', startMs: 3000, endMs: 3100 }, // null embed
  ]);
  const embedder = fakeEmbedder({ 0: [1, 0, 0, 0] }); // 3000 missing → null
  const result = await run(null, pcm, dir, dialogue, { _embedderOverride: embedder });
  assert.equal(result[1].speaker, 'unknown_speaker_0');
});

test('diarize.run: no usable anchor embeddings → all unknowns become unknown_speaker_0', async () => {
  const dir = makeTempDir(); const pcm = path.join(dir, 'tab.pcm'); writeFakePcm(pcm);
  const dialogue = makeDialogue([
    { sp: 'Анна',    startMs: 0,    endMs: 2000 }, // anchor embeds to null
    { sp: 'unknown', startMs: 3000, endMs: 5000 },
  ]);
  const embedder = fakeEmbedder({ 3000: [1, 0, 0, 0] }); // anchor (0) missing → no centroids
  const result = await run(null, pcm, dir, dialogue, { _embedderOverride: embedder });
  assert.equal(result[1].speaker, 'unknown_speaker_0');
});

// ---- cluster.js pure-function units ---------------------------------------

test('cluster.matchToCentroid: above threshold matches, below returns null', () => {
  const anchors = new Map([
    ['A', [l2normalize(Float32Array.from([1, 0, 0]))]],
    ['B', [l2normalize(Float32Array.from([0, 1, 0]))]],
  ]);
  const centroids = buildCentroids(anchors);
  assert.equal(matchToCentroid(l2normalize(Float32Array.from([0.9, 0.1, 0])), centroids, 0.62), 'A');
  assert.equal(matchToCentroid(l2normalize(Float32Array.from([0, 0, 1])), centroids, 0.62), null);
});

test('cluster.agglomerativeCosine: separates two clear clusters, single → [0]', () => {
  const v = a => l2normalize(Float32Array.from(a));
  const embeds = [v([1, 0, 0]), v([0.97, 0.03, 0]), v([0, 1, 0]), v([0.02, 0.98, 0])];
  const labels = agglomerativeCosine(embeds, 0.45);
  assert.equal(labels[0], labels[1], 'first two together');
  assert.equal(labels[2], labels[3], 'last two together');
  assert.notEqual(labels[0], labels[2], 'the two groups differ');
  assert.deepEqual(agglomerativeCosine([v([1, 0, 0])], 0.45), [0]);
});

test('cluster.agglomerativeCosine: labels numbered by first appearance', () => {
  const v = a => l2normalize(Float32Array.from(a));
  // order: B, A, B, A  → first-seen cluster gets 0, next gets 1
  const labels = agglomerativeCosine([v([0, 1, 0]), v([1, 0, 0]), v([0.02, 0.98, 0]), v([0.98, 0.02, 0])], 0.45);
  assert.equal(labels[0], 0);
  assert.equal(labels[1], 1);
  assert.equal(labels[2], 0);
  assert.equal(labels[3], 1);
});
