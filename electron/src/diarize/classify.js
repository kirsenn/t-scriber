'use strict';

// Core diarization classification, independent of where it runs (main thread with an
// injected fake embedder in tests, or the worker thread with a real VoiceEmbedder).
// Given anchor + unknown segments (times already relative to the tab track start), it
// returns a resolved speaker name per unknown, in input order.

const { buildCentroids, matchToCentroid, agglomerativeCosine } = require('./cluster.js');

// classify: embed anchors → centroids; assign each unknown to the nearest centroid above
// `threshold`, else cluster the leftovers into unknown_speaker_N (first-appearance order).
// Segments too short to embed (null) fall through to unknown_speaker_0.
async function classify(embedder, audio, anchors, unknowns, { threshold, cut }) {
  const speakerEmbeds = new Map();
  for (const a of anchors) {
    const emb = await embedder.embedSegment(audio, a.startMs, a.endMs);
    if (!emb) continue;
    if (!speakerEmbeds.has(a.speaker)) speakerEmbeds.set(a.speaker, []);
    speakerEmbeds.get(a.speaker).push(emb);
  }
  const centroids = buildCentroids(speakerEmbeds);

  const names = new Array(unknowns.length).fill(null);
  if (centroids.size === 0) return names.map(() => 'unknown_speaker_0');

  const unmatchedIdx = [];
  const unmatchedEmbs = [];
  for (let i = 0; i < unknowns.length; i++) {
    const s = unknowns[i];
    const emb = await embedder.embedSegment(audio, s.startMs, s.endMs);
    if (!emb) { names[i] = 'unknown_speaker_0'; continue; }
    const name = matchToCentroid(emb, centroids, threshold);
    if (name) names[i] = name;
    else { unmatchedIdx.push(i); unmatchedEmbs.push(emb); }
  }
  if (unmatchedEmbs.length > 0) {
    const labels = agglomerativeCosine(unmatchedEmbs, cut);
    unmatchedIdx.forEach((idx, k) => { names[idx] = `unknown_speaker_${labels[k]}`; });
  }
  return names;
}

module.exports = { classify };
