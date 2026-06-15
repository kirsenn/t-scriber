'use strict';

// Fuzzy fact-matching for the E2E test. Because whisper and the summariser are both
// non-deterministic, we never compare against an exact reference text. Instead we plant
// distinctive facts in the scripted conversation and check them with recall: a fact is
// "present" if any of its patterns survives normalisation. Tolerant to rephrasing.

// normalize lowercases, folds ё→е, drops punctuation, and collapses whitespace so that
// "Пятнадцатое июня!" and "пятнадцатого  июня" compare equal under substring search.
function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// factMatches returns true if any of fact.patterns is found in haystack.
// A pattern may be a plain string (substring match on normalized text) or a RegExp
// (tested against the normalized text). Strings are themselves normalized first.
function factMatches(haystack, fact) {
  const hay = normalize(haystack);
  for (const p of fact.patterns) {
    if (p instanceof RegExp) {
      if (p.test(hay)) return true;
    } else if (hay.includes(normalize(p))) {
      return true;
    }
  }
  return false;
}

// reportFacts runs factMatches over a list and returns { passed, failed, all }.
function reportFacts(haystack, facts) {
  const passed = [];
  const failed = [];
  for (const f of facts) {
    (factMatches(haystack, f) ? passed : failed).push(f);
  }
  return { passed, failed, all: facts };
}

module.exports = { normalize, factMatches, reportFacts };
