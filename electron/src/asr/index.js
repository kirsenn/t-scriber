'use strict';

// Speech recognition: picks an engine for the session language.
//
// Every engine (gigaam/, parakeet/) is a module with the same shape:
//   name, label                       — id for config/logs and display name for the UI
//   options(cfg)                      — the engine's settings, picked out of the app config
//   missing(opts) → string[]          — what is absent for it to run (empty when ready)
//   run(signal, pcmPath, workDir, opts) → Promise<[{ startMs, endMs, text }]>

const path = require('node:path');
const gigaam = require('./gigaam');
const parakeet = require('./parakeet');

const engines = { gigaam, parakeet };

// candidates lists the engines for cfg.language, preferred first. Russian: cfg.asr_ru
// ('gigaam' by default or 'parakeet'), then the other one as a fallback. GigaAM is
// Russian-only, so every other language has Parakeet alone.
function candidates(cfg) {
  const isRu = (cfg.language || '').toLowerCase().startsWith('ru');
  if (!isRu) return [parakeet];
  return cfg.asr_ru === 'parakeet' ? [parakeet, gigaam] : [gigaam, parakeet];
}

// select returns the first candidate engine whose model is in place. Falling back past the
// preferred one adds a note. Returns { name, label, run(signal, pcmPath, workDir), error, note };
// error/note are Russian strings for the UI log, error is set when no engine is usable.
function select(cfg) {
  const list = candidates(cfg);
  const absent = new Map(list.map(e => [e, e.missing(e.options(cfg))]));
  const describe = e => `${e.label} (${absent.get(e).map(f => path.basename(f)).join(', ')})`;

  const usable = list.find(e => !absent.get(e).length);
  if (!usable) {
    return {
      name: null, label: null, run: null, note: null,
      error: `Модель не найдена: ${list.map(describe).join(', ')} — укажите папку в настройках (⌘,)`,
    };
  }
  const note = usable === list[0] ? null
    : `Модель ${describe(list[0])} не найдена — распознаю ${usable.label}. Папку можно указать в настройках (⌘,)`;
  return bind(usable, cfg, note);
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
