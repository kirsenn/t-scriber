'use strict';

// Shared DB helpers used by both main.js (Electron) and transcribe-cli.js.

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const DB_PATH = path.join(os.homedir(), '.tscriber', 'tscriber.db');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    started_at   TEXT,
    meeting      TEXT,
    participants TEXT,
    title        TEXT,
    snippet      TEXT,
    summary_md   TEXT,
    transcript   TEXT,
    dir          TEXT
  )
`;

const SQL_UPSERT = `
  INSERT OR REPLACE INTO sessions
    (id, started_at, meeting, participants, title, snippet, summary_md, transcript, dir)
  VALUES (@id, @started_at, @meeting, @participants, @title, @snippet, @summary_md, @transcript, @dir)
`;

const SQL_INSERT_IGNORE = `
  INSERT OR IGNORE INTO sessions
    (id, started_at, meeting, participants, title, snippet, summary_md, transcript, dir)
  VALUES (@id, @started_at, @meeting, @participants, @title, @snippet, @summary_md, @transcript, @dir)
`;

function openDb(dbPath = DB_PATH) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.exec(SCHEMA);
    return db;
  } catch (e) {
    if (e.code !== 'ERR_DLOPEN_FAILED') throw e;
    // better-sqlite3 was compiled for Electron's Node ABI; fall back to the
    // built-in node:sqlite when running under system Node.js (Node 23.4+).
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA);
    return db;
  }
}

function deriveTitle(summaryMd) {
  if (!summaryMd) return null;
  const m = summaryMd.match(/##\s*Ключевые решения\s*\n([\s\S]*?)(?:\n##|$)/);
  if (m) {
    const bullet = m[1].match(/^\s*[*\-]\s+(.+)/m);
    if (bullet) return bullet[1].replace(/\*\*/g, '').trim().slice(0, 50);
  }
  const s = summaryMd.match(/##\s*Краткое резюме\s*\n([\s\S]*?)(?:\n##|$)/);
  if (s) return s[1].trim().split(/\s+/).slice(0, 6).join(' ');
  return null;
}

function deriveSnippet(summaryMd) {
  if (!summaryMd) return '';
  const m = summaryMd.match(/##\s*Краткое резюме\s*\n([\s\S]*?)(?:\n##|$)/);
  if (!m) return '';
  const text = m[1].trim().replace(/\n+/g, ' ');
  return text.length > 80 ? text.slice(0, 77) + '…' : text;
}

function buildRow(dir) {
  const name = path.basename(dir);
  const metaPath = path.join(dir, 'meta.json');
  const transcriptPath = path.join(dir, 'transcript.json');
  if (!fs.existsSync(metaPath) || !fs.existsSync(transcriptPath)) return null;

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const summaryMd = fs.existsSync(path.join(dir, 'summary.md'))
    ? fs.readFileSync(path.join(dir, 'summary.md'), 'utf8')
    : null;
  const transcriptRaw = fs.readFileSync(transcriptPath, 'utf8');
  const segments = JSON.parse(transcriptRaw);
  const participants = [...new Set(segments.map(s => s.speaker).filter(Boolean))];

  return {
    id:           meta.id || name,
    started_at:   meta.started_at || null,
    meeting:      meta.meeting || null,
    participants: JSON.stringify(participants),
    title:        deriveTitle(summaryMd) || meta.meeting || name,
    snippet:      deriveSnippet(summaryMd),
    summary_md:   summaryMd,
    transcript:   transcriptRaw,
    dir,
  };
}

// Upserts session files → DB row. Returns the row, or null if files aren't ready yet.
function refreshSession(db, dir) {
  const row = buildRow(dir);
  if (!row) return null;
  db.prepare(SQL_UPSERT).run(row);
  return row;
}

// Inserts sessions not yet in the DB (skips existing ones).
function importSessions(db, dataDir) {
  if (!fs.existsSync(dataDir)) return;
  const existing = new Set(db.prepare('SELECT id FROM sessions').all().map(r => r.id));
  let dirs;
  try { dirs = fs.readdirSync(dataDir); } catch { return; }

  const insert = db.prepare(SQL_INSERT_IGNORE);
  for (const name of dirs) {
    if (existing.has(name)) continue;
    const dir = path.join(dataDir, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const row = buildRow(dir);
      if (row) insert.run(row);
    } catch (e) {
      console.error(`Import failed for ${name}:`, e.message);
    }
  }
}

module.exports = { openDb, buildRow, refreshSession, importSessions, DB_PATH };
