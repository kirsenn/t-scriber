'use strict';

// Speech recognition: picks an engine for the session language.
//
// Every engine (whisper/, gigaam/) is a module with the same shape:
//   name, label                       — id for config/logs and display name for the UI
//   options(cfg)                      — the engine's settings, picked out of the app config
//   missing(opts) → string[]          — what is absent for it to run (empty when ready)
//   run(signal, pcmPath, workDir, opts) → Promise<[{ startMs, endMs, text }]>

const path = require('node:path');
const whisper = require('./whisper');
const gigaam = require('./gigaam');

const engines = { whisper, gigaam };

// select returns the engine for cfg.language: Russian uses cfg.asr_ru ('gigaam' by default),
// everything else Whisper. A Russian session whose GigaAM model is missing falls back to
// Whisper with a note. Returns { name, label, run(signal, pcmPath, workDir), error, note };
// error/note are Russian strings for the UI log, error is set when nothing usable is left.
function select(cfg) {
  const isRu = (cfg.language || '').toLowerCase().startsWith('ru');
  let note = null;

  if (isRu && cfg.asr_ru !== 'whisper') {
    const absent = gigaam.missing(gigaam.options(cfg));
    if (!absent.length) return bind(gigaam, cfg, null);
    note = `Модель GigaAM не найдена (${absent.map(f => path.basename(f)).join(', ')}) — распознаю Whisper. ` +
      'Папку можно указать в настройках (⌘,)';
  }

  const res = bind(whisper, cfg, note);
  if (whisper.missing(whisper.options(cfg)).length) {
    res.error = 'Модель Whisper не задана — укажите путь в настройках (⌘,)';
  }
  return res;
}

function bind(engine, cfg, note) {
  const opts = engine.options(cfg);
  return {
    name:  engine.name,
    label: engine.label,
    run:   (signal, pcmPath, workDir) => engine.run(signal, pcmPath, workDir, opts),
    error: null,
    note,
  };
}

module.exports = { select, engines };
