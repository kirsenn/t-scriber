'use strict';

// GigaAM-only post-processing: mapping Cyrillic spellings of English terms back to their usual
// Latin form (GigaAM is Russian-only and cannot be primed with a prompt). The shared
// token/word/segment helpers live in ../words.js.

const { core, trailingPunct } = require('../words.js');

// Default term map: space-separated Cyrillic stems → replacement. Each stem matches a whole
// word plus up to 3 trailing Cyrillic letters (case endings), so "конкордиуму" → "Concordium".
// Override or extend via cfg.gigaam_replacements; a null value disables a default entry.
const DEFAULT_REPLACEMENTS = {
  'конкордиум': 'Concordium',
  'джумио': 'Jumio',
  'впн': 'VPN',
  'сдк': 'SDK',
  'эсдэка': 'SDK',
  'апиай': 'API',
  'эйпиай': 'API',
  'эмсипи': 'MCP',
  'флаттер': 'Flutter',
  'флатер': 'Flutter',
  'питон': 'Python',
  'слак': 'Slack',
  'айос': 'iOS',
  'гугл пэй': 'Google Pay',
  'гугл пей': 'Google Pay',
  'эпл пэй': 'Apple Pay',
  'эпл пей': 'Apple Pay',
  'эппл пэй': 'Apple Pay',
  'эппл пей': 'Apple Pay',
};

// compileReplacements merges user overrides over the defaults into matchers.
function compileReplacements(overrides) {
  const merged = { ...DEFAULT_REPLACEMENTS, ...(overrides || {}) };
  const out = [];
  for (const [key, value] of Object.entries(merged)) {
    if (!value) continue;
    const stems = key.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
    if (stems.length === 0) continue;
    out.push({ res: stems.map(s => new RegExp(`^${s}[а-я]{0,3}$`)), value });
  }
  // Longer phrases first so "гугл пэй" wins over any single-word entry.
  return out.sort((a, b) => b.res.length - a.res.length);
}

// applyReplacements rewrites term spellings in place of the matched word(s), keeping the
// last word's trailing punctuation and the span's timestamps.
function applyReplacements(words, matchers) {
  if (!matchers.length) return words;
  const out = [];
  for (let i = 0; i < words.length; i++) {
    let hit = null;
    for (const m of matchers) {
      if (i + m.res.length > words.length) continue;
      if (m.res.every((re, k) => re.test(core(words[i + k].text)))) { hit = m; break; }
    }
    if (!hit) { out.push(words[i]); continue; }
    const last = words[i + hit.res.length - 1];
    out.push({ text: hit.value + trailingPunct(last.text), startMs: words[i].startMs, endMs: last.endMs });
    i += hit.res.length - 1;
  }
  return out;
}

module.exports = { DEFAULT_REPLACEMENTS, compileReplacements, applyReplacements };
