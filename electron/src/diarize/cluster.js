'use strict';

// Pure clustering helpers for diarization — no onnxruntime, no I/O, so they unit-test
// directly on synthetic embeddings. These reproduce the centroid-match + average-linkage
// agglomerative clustering this project originally did with numpy/scipy.

// l2normalize returns a new unit-norm copy of vec (or a zero copy if vec is all-zero).
function l2normalize(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  const norm = Math.sqrt(s);
  const out = new Float32Array(vec.length);
  if (norm > 0) for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

// mean returns the element-wise mean of a non-empty list of equal-length vectors.
function mean(vecs) {
  const dim = vecs[0].length;
  const out = new Float32Array(dim);
  for (const v of vecs) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= vecs.length;
  return out;
}

// dot assumes both vectors are L2-normalised, so it is the cosine similarity.
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// buildCentroids turns a Map<name, Float32Array[]> of per-speaker anchor embeddings into a
// Map<name, Float32Array> of L2-normalised centroids (mean then normalise). A speaker whose
// centroid degenerates to zero is dropped.
function buildCentroids(speakerEmbeds) {
  const centroids = new Map();
  for (const [name, embs] of speakerEmbeds) {
    if (embs.length === 0) continue;
    const c = mean(embs);
    let norm = 0;
    for (let i = 0; i < c.length; i++) norm += c[i] * c[i];
    if (Math.sqrt(norm) > 0) centroids.set(name, l2normalize(c));
  }
  return centroids;
}

// matchToCentroid returns the name of the nearest centroid if its cosine similarity is
// >= threshold, otherwise null. `embed` and all centroids must be L2-normalised.
function matchToCentroid(embed, centroids, threshold) {
  let bestName = null;
  let bestSim = -Infinity;
  for (const [name, c] of centroids) {
    const sim = dot(embed, c);
    if (sim > bestSim) { bestSim = sim; bestName = name; }
  }
  return bestSim >= threshold ? bestName : null;
}

// agglomerativeCosine clusters L2-normalised embeddings with average-linkage (UPGMA) on
// cosine distance and a flat cut at `cut`, reproducing
//   scipy.linkage(pdist(X,'cosine'), method='average') + fcluster(t=cut, 'distance').
// Returns one integer label per input embedding, numbered by order of first appearance
// (0 for the first observed cluster, 1 for the next, ...).
function agglomerativeCosine(embeds, cut = 0.45) {
  const n = embeds.length;
  if (n === 0) return [];
  if (n === 1) return [0];

  // Active clusters: each holds member indices and a Lance-Williams distance to every other.
  const clusters = embeds.map((_, i) => ({ members: [i], alive: true }));
  // Pairwise cosine-distance matrix between current clusters (indexed by cluster id).
  const dist = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = 1 - dot(embeds[i], embeds[j]);
      dist[i][j] = d;
      dist[j][i] = d;
    }
  }

  let aliveCount = n;
  while (aliveCount > 1) {
    // Find the closest pair of live clusters.
    let bi = -1, bj = -1, best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!clusters[i].alive) continue;
      for (let j = i + 1; j < n; j++) {
        if (!clusters[j].alive) continue;
        if (dist[i][j] < best) { best = dist[i][j]; bi = i; bj = j; }
      }
    }
    // fcluster(criterion='distance', t=cut): observations stay together while the merge
    // height is <= cut. Stop once the closest merge would exceed it.
    if (best > cut) break;

    // Merge bj into bi using the UPGMA (average-linkage) Lance-Williams update.
    const ni = clusters[bi].members.length;
    const nj = clusters[bj].members.length;
    for (let k = 0; k < n; k++) {
      if (k === bi || k === bj || !clusters[k].alive) continue;
      const merged = (ni * dist[bi][k] + nj * dist[bj][k]) / (ni + nj);
      dist[bi][k] = merged;
      dist[k][bi] = merged;
    }
    clusters[bi].members = clusters[bi].members.concat(clusters[bj].members);
    clusters[bj].alive = false;
    aliveCount--;
  }

  // Map each observation to its surviving cluster, then renumber by first appearance.
  const clusterOf = new Int32Array(n);
  for (let c = 0; c < n; c++) {
    if (!clusters[c].alive) continue;
    for (const m of clusters[c].members) clusterOf[m] = c;
  }
  const renumber = new Map();
  const labels = new Array(n);
  let next = 0;
  for (let i = 0; i < n; i++) {
    const c = clusterOf[i];
    if (!renumber.has(c)) renumber.set(c, next++);
    labels[i] = renumber.get(c);
  }
  return labels;
}

module.exports = { l2normalize, mean, dot, buildCentroids, matchToCentroid, agglomerativeCosine };
