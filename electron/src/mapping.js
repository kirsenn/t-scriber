'use strict';

// Merges DOM-derived speaker events with whisper segments into a labeled dialogue.

const fs = require('node:fs');
const readline = require('node:readline');

const MATCH_TOLERANCE_MS = 500;

// parseEvents reads events.jsonl and pairs start/stop events into speaker intervals.
// Unbalanced starts are closed at the last observed event timestamp.
// Returns a Promise<Array<{ speaker, startMs, endMs }>>.
async function parseEvents(filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  const events = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed);
      if (e.type === 'speaker_event') events.push(e);
    } catch {}
  }

  events.sort((a, b) => a.ts - b.ts);

  const lastTS = events.length > 0 ? events[events.length - 1].ts : 0;
  const open   = new Map(); // speaker -> startTs
  const intervals = [];

  for (const e of events) {
    if (e.event === 'start') {
      if (!open.has(e.speaker)) open.set(e.speaker, e.ts);
    } else if (e.event === 'stop') {
      if (open.has(e.speaker)) {
        intervals.push({ speaker: e.speaker, startMs: open.get(e.speaker), endMs: e.ts });
        open.delete(e.speaker);
      }
    }
  }

  // Close any still-open intervals at the last event time.
  for (const [speaker, start] of open) {
    intervals.push({ speaker, startMs: start, endMs: lastTS });
  }

  intervals.sort((a, b) => a.startMs - b.startMs);
  return intervals;
}

// build attributes each track's segments to a speaker and returns the merged,
// time-sorted dialogue. selfName labels mic-track gaps where DOM attribution failed.
function build(tracks, intervals, selfName) {
  const out = [];

  for (const tr of tracks) {
    for (const seg of tr.segments) {
      const start = tr.t0Ms + seg.startMs;
      const end   = tr.t0Ms + seg.endMs;
      let who = attribute(start, end, intervals);
      if (who === 'unknown' && tr.source === 'mic' && selfName) who = selfName;
      out.push({ speaker: who, source: tr.source, startMs: start, endMs: end, text: seg.text });
    }
  }

  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

// attribute picks the speaker whose interval overlaps the segment most (within tolerance).
function attribute(start, end, intervals) {
  let best        = 'unknown';
  let bestOverlap = 0;
  const lo = start - MATCH_TOLERANCE_MS;
  const hi = end   + MATCH_TOLERANCE_MS;

  for (const iv of intervals) {
    const ov = overlap(lo, hi, iv.startMs, iv.endMs);
    if (ov > bestOverlap) { bestOverlap = ov; best = iv.speaker; }
  }
  return best;
}

function overlap(aStart, aEnd, bStart, bEnd) {
  const lo = Math.max(aStart, bStart);
  const hi = Math.min(aEnd, bEnd);
  return hi > lo ? hi - lo : 0;
}

// render formats the dialogue with timestamps relative to originMs.
// Consecutive lines from the same speaker are merged.
function render(segs, originMs) {
  let result     = '';
  let curSpeaker = null;

  for (const s of segs) {
    let rel = s.startMs - originMs;
    if (rel < 0) rel = 0;
    const mm = Math.floor(rel / 60000);
    const ss = Math.floor((rel % 60000) / 1000);

    if (s.speaker !== curSpeaker) {
      result    += `\n[${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}] ${s.speaker}: `;
      curSpeaker = s.speaker;
    }
    result += s.text + ' ';
  }

  return result.trim();
}

module.exports = { parseEvents, build, render, MATCH_TOLERANCE_MS };
