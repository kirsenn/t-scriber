'use strict';

//const { tscriber } = window;

// ── state ────────────────────────────────────────────────────────────────────

let cfg = {};  // current values (shown in UI)

// ── DOM refs ─────────────────────────────────────────────────────────────────

const pathEls = {
  model:       document.getElementById('path-model'),
  gemma_model: document.getElementById('path-gemma'),
};

const inpLanguage  = document.getElementById('inp-language');
const inpSelfName  = document.getElementById('inp-self-name');
const chkAuto      = document.getElementById('chk-auto');
const chkSummarize = document.getElementById('chk-summarize');
const chkDiarize   = document.getElementById('chk-diarize');
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
  renderPath('gemma_model', cfg.gemma_model);

  inpLanguage.value  = cfg.language  ?? 'ru';
  inpSelfName.value  = cfg.self_name ?? 'Вы';
  chkAuto.checked      = !!cfg.auto;
  chkSummarize.checked = !!cfg.summarize;
  chkDiarize.checked   = !!cfg.diarize;
}

function collect() {
  return {
    model:       cfg.model       ?? null,
    gemma_model: cfg.gemma_model ?? null,
    language:    inpLanguage.value.trim()  || 'ru',
    self_name:   inpSelfName.value.trim()  || 'Вы',
    auto:        chkAuto.checked,
    summarize:   chkSummarize.checked,
    diarize:     chkDiarize.checked,
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
    const picked = await tscriber.chooseFile({ filters: filter });
    if (!picked) return;
    cfg[field] = picked;
    renderPath(field, picked);
  });
});

// ── save ──────────────────────────────────────────────────────────────────────

btnSave.addEventListener('click', async () => {
  btnSave.disabled = true;
  const values = collect();
  await tscriber.saveConfig(values);
  cfg = { ...cfg, ...values };
  savedMsg.classList.add('visible');
  setTimeout(() => {
    savedMsg.classList.remove('visible');
    btnSave.disabled = false;
  }, 2000);
});

// ── init ──────────────────────────────────────────────────────────────────────

(async () => {
  cfg = await tscriber.getConfig();
  render();
})();
