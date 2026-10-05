'use strict';

// Pure text helpers for the GigaAM engine: RNNT tokens → words with timestamps → sentence
// segments, plus the post-processing GigaAM needs that Whisper does not — dropping verbatim
// hesitation fillers ("э-э", "м-м") and mapping Cyrillic spellings of English terms back to
// their usual Latin form (GigaAM is Russian-only and cannot be primed with a prompt).

const WORD_SEP = '▁'; // sentencepiece word-start marker

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

const FILLER_RE = /^(?:э+|а{2,}|э(?:-э+)+|м{1,}|м(?:-м+)+|эм+|хм+)$/;
const SENTENCE_END_RE = /[.?!…]$/;
const TRAIL_PUNCT_RE = /[.,?!…:;»"]+$/;

// parseVocab parses v3_e2e_rnnt_vocab.txt ("<piece> <id>" per line) into an id-indexed array.
function parseVocab(raw) {
  const vocab = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const sp = line.lastIndexOf(' ');
    vocab[Number(line.slice(sp + 1))] = line.slice(0, sp);
  }
  return vocab;
}

// tokensToWords groups token ids into words — a port of gigaam.timestamps_utils.frames_to_words.
// frameMs is the duration of one encoder frame; offsetMs shifts all timestamps.
// Returns [{ text, startMs, endMs }].
function tokensToWords(vocab, tokenIds, tokenFrames, frameMs, offsetMs = 0) {
  const words = [];
  let chars = [];
  let frames = [];

  const commit = () => {
    const text = chars.join('').trim();
    if (text) {
      words.push({
        text,
        startMs: Math.round(offsetMs + frames[0] * frameMs),
        endMs:   Math.round(offsetMs + (frames[frames.length - 1] + 1) * frameMs),
      });
    }
    chars = [];
    frames = [];
  };

  for (let i = 0; i < tokenIds.length; i++) {
    let piece = vocab[tokenIds[i]];
    if (piece === undefined || piece === '<unk>') continue;
    if (piece.startsWith(WORD_SEP)) {
      commit();
      piece = piece.slice(1);
    } else if (piece === ' ') {
      commit();
      continue;
    }
    chars.push(piece);
    frames.push(tokenFrames[i]);
  }
  commit();
  return words;
}

function core(text) {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/^[«"(]+/, '').replace(TRAIL_PUNCT_RE, '');
}

function trailingPunct(text) {
  const m = text.match(TRAIL_PUNCT_RE);
  return m ? m[0] : '';
}

function capitalize(text) {
  const i = text.search(/[\p{L}]/u);
  return i < 0 ? text : text.slice(0, i) + text[i].toUpperCase() + text.slice(i + 1);
}

// dropFillers removes hesitation-only words. Sentence-ending punctuation carried by a dropped
// filler moves to the previous word, and a sentence that now starts with a lowercase word is
// re-capitalised.
function dropFillers(words) {
  const out = [];
  let capNext = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!FILLER_RE.test(core(w.text))) {
      out.push(capNext ? { ...w, text: capitalize(w.text) } : w);
      capNext = false;
      continue;
    }
    const sentenceStart = out.length === 0 || SENTENCE_END_RE.test(out[out.length - 1].text);
    const p = trailingPunct(w.text);
    if (SENTENCE_END_RE.test(p) && out.length > 0 && !TRAIL_PUNCT_RE.test(out[out.length - 1].text)) {
      out[out.length - 1] = { ...out[out.length - 1], text: out[out.length - 1].text + p };
    }
    if (sentenceStart || SENTENCE_END_RE.test(p)) capNext = true;
  }
  return out;
}

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

// toSegments splits words into sentence-level segments ({ startMs, endMs, text }), the shape
// every ASR engine returns. A segment also ends at a pause longer than maxGapMs.
function toSegments(words, maxGapMs = 1500) {
  const segs = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    segs.push({ startMs: cur[0].startMs, endMs: cur[cur.length - 1].endMs, text: cur.map(w => w.text).join(' ') });
    cur = [];
  };
  for (const w of words) {
    if (cur.length && w.startMs - cur[cur.length - 1].endMs > maxGapMs) flush();
    cur.push(w);
    if (SENTENCE_END_RE.test(w.text)) flush();
  }
  flush();
  return segs;
}

module.exports = {
  DEFAULT_REPLACEMENTS, parseVocab, tokensToWords, dropFillers,
  compileReplacements, applyReplacements, toSegments,
};
