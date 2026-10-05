'use strict';

//const { tscriber } = window;

// ── state ────────────────────────────────────────────────────────────────────

let cfg = {};  // current values (shown in UI)

// ── DOM refs ─────────────────────────────────────────────────────────────────

const pathEls = {
  gigaam_model_dir: document.getElementById('path-gigaam'),
  parakeet_model_dir: document.getElementById('path-parakeet'),
  gemma_model: document.getElementById('path-gemma'),
};


const selAsrRu        = document.getElementById('sel-asr-ru');
const inpLlmMaxTokens = document.getElementById('inp-llm-max-tokens');
const chkAuto         = document.getElementById('chk-auto');
const chkSummarize    = document.getElementById('chk-summarize');
const chkDiarize      = document.getElementById('chk-diarize');
const btnSave      = document.getElementById('btn-save');
const savedMsg     = document.getElementById('saved-msg');

// ── helpers ───────────────────────────────────────────────────────────────────

function shortPath(p) {
  if (!p) return 'Не задано';
  const home = '/Users/';
  const hi = p.indexOf(home);
  if (hi !== -1) {
    const after = p.slice(hi + home.length);
    const slash = after.indexOf('/');
    return '~/' + (slash !== -1 ? after.slice(slash + 1) : after);
  }
  return p;
}

function renderPath(field, value) {
  const el = pathEls[field];
  if (!el) return;
  const label = shortPath(value);
  el.textContent = label;
  el.title = value || '';
  el.className = 's-path ' + (value ? 'ok' : 'missing');
}

function render() {
  renderPath('gigaam_model_dir', cfg.gigaam_model_dir);
  renderPath('parakeet_model_dir', cfg.parakeet_model_dir);
  renderPath('gemma_model', cfg.gemma_model);

  selAsrRu.value        = cfg.asr_ru === 'parakeet' ? 'parakeet' : 'gigaam';
  inpLlmMaxTokens.value = cfg.llm_max_tokens ?? 4096;
  chkAuto.checked       = !!cfg.auto;
  chkSummarize.checked  = !!cfg.summarize;
  chkDiarize.checked    = !!cfg.diarize;
}

// Engines that need a model folder, with the folder row and hint shown when it is invalid.
const dirEngines = [
  { engine: 'gigaam',   label: 'GigaAM',   field: 'gigaam_model_dir' },
  { engine: 'parakeet', label: 'Parakeet', field: 'parakeet_model_dir' },
].map(d => ({ ...d, row: document.getElementById(`row-${d.engine}`), err: document.getElementById(`${d.engine}-error`) }));

// validate blocks saving while the engine chosen for Russian has no model folder set or the
// folder lacks the model files; the folder row is highlighted with a hint. (English always uses
// Parakeet; an unset Parakeet folder only shows as «Не задано».)
let valid = true;
let saving = false;

async function validate() {
  valid = true;
  for (const d of dirEngines) {
    let error = null;
    if (selAsrRu.value === d.engine) {
      const dir = cfg[d.field] ?? null;
      const missing = await tscriber.checkModelDir(d.engine, dir);
      if (missing.length) {
        error = dir
          ? `В папке нет файлов модели ${d.label}: ${missing.join(', ')}. Укажите папку, где лежит модель.`
          : `Для русского выбран ${d.label} — укажите папку, где лежит модель (кнопка «Папка…»).`;
      }
    }
    d.row.classList.toggle('invalid', !!error);
    d.err.textContent = error || '';
    d.err.hidden = !error;
    if (error) valid = false;
  }
  btnSave.disabled = saving || !valid;
}

function collect() {
  return {
    asr_ru:      selAsrRu.value,
    gigaam_model_dir: cfg.gigaam_model_dir ?? null,
    parakeet_model_dir: cfg.parakeet_model_dir ?? null,
    gemma_model: cfg.gemma_model ?? null,
    llm_max_tokens:  parseInt(inpLlmMaxTokens.value, 10) || 4096,
    auto:            chkAuto.checked,
    summarize:       chkSummarize.checked,
    diarize:         chkDiarize.checked,
  };
}

// ── file pickers ──────────────────────────────────────────────────────────────

const filterMap = {
  gguf: [{ name: 'GGUF model', extensions: ['gguf'] }],
};

document.querySelectorAll('.s-btn-pick').forEach(btn => {
  btn.addEventListener('click', async () => {
    const field  = btn.dataset.field;
    const filter = filterMap[btn.dataset.filter] ?? [];
    const picked = await tscriber.chooseFile({ filters: filter, directory: !!btn.dataset.directory });
    if (!picked) return;
    cfg[field] = picked;
    renderPath(field, picked);
    validate();
  });
});

selAsrRu.addEventListener('change', validate);

// ── save ──────────────────────────────────────────────────────────────────────

btnSave.addEventListener('click', async () => {
  await validate();
  if (!valid) return;
  saving = true;
  btnSave.disabled = true;
  const values = collect();
  await tscriber.saveConfig(values);
  cfg = { ...cfg, ...values };
  savedMsg.classList.add('visible');
  setTimeout(() => {
    savedMsg.classList.remove('visible');
    saving = false;
    btnSave.disabled = !valid;
  }, 2000);
});

// ── init ──────────────────────────────────────────────────────────────────────

(async () => {
  cfg = await tscriber.getConfig();
  render();
  validate();
})();
