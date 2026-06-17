'use strict';

// Owns the on-disk artifacts for a single recording session.

const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_RATE = 16000;
const SOURCE_TAB = 0;
const SOURCE_MIC = 1;

class Session {
  constructor(id, dir) {
    this.id  = id;
    this.dir = dir;

    this._tab    = fs.createWriteStream(path.join(dir, 'tab.pcm'));
    this._mic    = fs.createWriteStream(path.join(dir, 'mic.pcm'));
    this._events = fs.createWriteStream(path.join(dir, 'events.jsonl'));

    this._tabBytes  = 0;
    this._micBytes  = 0;
    this._numEvents = 0;
    this._firstTabMs = 0;
    this._firstMicMs = 0;
  }

  writePCM(src, tsMs, pcm) {
    if (src === SOURCE_TAB) {
      if (!this._firstTabMs) this._firstTabMs = tsMs;
      this._tabBytes += pcm.length;
      this._tab.write(pcm);
    } else if (src === SOURCE_MIC) {
      if (!this._firstMicMs) this._firstMicMs = tsMs;
      this._micBytes += pcm.length;
      this._mic.write(pcm);
    }
  }

  writeEvent(raw) {
    this._numEvents++;
    this._events.write(typeof raw === 'string' ? raw : raw.toString());
    this._events.write('\n');
  }

  stats() {
    const tabSecs = this._tabBytes / (SAMPLE_RATE * 2);
    const micSecs = this._micBytes / (SAMPLE_RATE * 2);
    return `session ${this.id}: tab=${tabSecs.toFixed(1)}s mic=${micSecs.toFixed(1)}s events=${this._numEvents} dir=${this.dir}`;
  }

  // close flushes all streams and persists timing.json, then calls callback when done.
  close(callback) {
    const timing = {
      first_tab_ms: this._firstTabMs,
      first_mic_ms: this._firstMicMs,
      sample_rate:  SAMPLE_RATE,
    };
    try {
      fs.writeFileSync(path.join(this.dir, 'timing.json'), JSON.stringify(timing, null, 2));
    } catch {}

    // Wait for all three streams to finish flushing before calling back.
    let pending = 3;
    const done = () => { if (--pending === 0 && callback) callback(); };
    this._tab.end(done);
    this._mic.end(done);
    this._events.end(done);
  }
}

// newSession creates the session directory, writes meta.json, and returns a Session.
function newSession(dataDir, meeting, language) {
  const now = new Date();
  const id  = formatDatetime(now);
  const dir = path.join(dataDir, id);
  fs.mkdirSync(dir, { recursive: true });

  const meta = {
    id,
    meeting:    meeting || '',
    language:   language || 'en',
    started_at: now.toISOString(),
    sample_rate: SAMPLE_RATE,
    channels:   1,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

  return new Session(id, dir);
}

function formatDatetime(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = { Session, newSession, SAMPLE_RATE, SOURCE_TAB, SOURCE_MIC };
