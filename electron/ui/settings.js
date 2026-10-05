'use strict';

//const { tscriber } = window;

// ── state ────────────────────────────────────────────────────────────────────

let cfg = {};  // current values (shown in UI)

// ── DOM refs ─────────────────────────────────────────────────────────────────

const pathEls = {
  model:       document.getElementById('path-model'),
  gigaam_model_dir: document.getElementById('path-gigaam'),
  gemma_model: document.getElementById('path-gemma'),
};


const selAsrRu        = document.getElementById('sel-asr-ru');
const inpLlmMaxTokens = document.getElementById('inp-llm-max-tokens');
const chkAuto         = document.getElementById('chk-auto');
const chkSummarize    = document.getElementById('chk-summarize');
const chkDiarize      = document.getElementById('chk-diarize');
const rowGigaam    = document.getElementById('row-gigaam');
const gigaamError  = document.getElementById('gigaam-error');
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
  renderPath('model',       cfg.model);
  renderPath('gigaam_model_dir', cfg.gigaam_model_dir);
  renderPath('gemma_model', cfg.gemma_model);

  selAsrRu.value        = cfg.asr_ru === 'whisper' ? 'whisper' : 'gigaam';
  inpLlmMaxTokens.value = cfg.llm_max_tokens ?? 4096;
  chkAuto.checked       = !!cfg.auto;
  chkSummarize.checked  = !!cfg.summarize;
  chkDiarize.checked    = !!cfg.diarize;
}

// validate blocks saving while GigaAM is chosen for Russian but its model folder is not set
// or lacks the model files; the folder row is highlighted with a hint.
let valid = true;
let saving = false;

async function validate() {
  let error = null;
  if (selAsrRu.value === 'gigaam') {
    const missing = await tscriber.checkGigaamDir(cfg.gigaam_model_dir ?? null);
    if (missing.length) {
      error = cfg.gigaam_model_dir
        ? `В папке нет файлов модели GigaAM: ${missing.join(', ')}. Укажите папку, где лежит модель.`
        : 'Для русского выбран GigaAM — укажите папку, где лежит модель (кнопка «Папка…»).';
    }
  }
  valid = !error;
  rowGigaam.classList.toggle('invalid', !valid);
  gigaamError.textContent = error || '';
  gigaamError.hidden = valid;
  btnSave.disabled = saving || !valid;
}

function collect() {
  return {
    asr_ru:      selAsrRu.value,
    model:       cfg.model       ?? null,
    gigaam_model_dir: cfg.gigaam_model_dir ?? null,
    gemma_model: cfg.gemma_model ?? null,
    llm_max_tokens:  parseInt(inpLlmMaxTokens.value, 10) || 4096,
    auto:            chkAuto.checked,
    summarize:       chkSummarize.checked,
    diarize:         chkDiarize.checked,
  };
}

// ── file pickers ──────────────────────────────────────────────────────────────

const filterMap = {
  bin:  [{ name: 'GGML model', extensions: ['bin'] }],
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
