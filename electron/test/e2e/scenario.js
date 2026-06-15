'use strict';

// Single source of truth for E2E scenarios.
//
// The declarative contract — script, planted facts + their match patterns, required/forbidden/
// nice-to-have facts, selfName, voices, the diarize/heavy flags — lives ONLY in
// scenarios/<name>.json. Fixtures under fixtures/e2e/<name>/ hold just the *generated* artifacts
// that can't be recomputed without macOS `say`: the two PCM tracks and the speaker events.
//
// Everything a test asserts is therefore either read straight from the scenario or DERIVED from
// its script here. Editing a scenario (e.g. broadening a fact's patterns) needs NO fixture
// regeneration — only changing the spoken text does. This is why expected.json no longer exists:
// it used to duplicate the scenario's declarative fields into the fixture, so edits silently
// didn't take effect until a regen.

const fs = require('node:fs');
const path = require('node:path');

const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const FIXTURES_DIR  = path.join(__dirname, '..', 'fixtures', 'e2e');

// Generation constants — fixed so replayed timestamps are reproducible. gen-fixture lays both PCM
// tracks on this clock; the harness replays with the same T0 so a whisper segment's file offset
// reconstructs to the same wall-clock epoch the speaker events use (see mapping.js).
const T0          = 1700000000000;
const SAMPLE_RATE = 16000;

// emitsEvent is the ONE rule for which scripted turns produce speaker_event markers: tab-track
// turns not explicitly hidden (event:false). gen-fixture uses it to write events.jsonl;
// deriveExpectations uses it to know which speakers anchored. Shared so the two never drift.
function emitsEvent(turn) {
  return turn.track === 'tab' && turn.event !== false;
}

function loadScenario(name) {
  return JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, `${name}.json`), 'utf8'));
}

// deriveExpectations computes everything the harness asserts that depends on the script *layout*
// (as opposed to the planted facts, which are read from the scenario directly). Pure function of
// scn.script — mirrors what gen-fixture used to bake into expected.json.
function deriveExpectations(scn) {
  const tabSpeakers          = new Set();
  const anchorSpeakers       = new Set(); // spoke in an event-emitting turn
  const hiddenOnlyCandidates = new Set(); // spoke only in hidden (event:false) turns
  const hiddenAttribution    = [];        // {speaker, marker} for hidden turns carrying a marker
  let hasMic = false;

  for (const turn of scn.script) {
    if (turn.track === 'tab') {
      tabSpeakers.add(turn.speaker);
      if (emitsEvent(turn)) {
        anchorSpeakers.add(turn.speaker);
      } else {
        if (!anchorSpeakers.has(turn.speaker)) hiddenOnlyCandidates.add(turn.speaker);
        if (turn.marker) hiddenAttribution.push({ speaker: turn.speaker, marker: turn.marker });
      }
    } else {
      hasMic = true; // mic turns carry no speaker_event → exercises the self_name fallback
    }
  }

  // Speakers seen only in hidden turns can't be recovered by diarization (no anchor voiceprint).
  const hiddenOnlySpeakers = [...hiddenOnlyCandidates].filter((sp) => !anchorSpeakers.has(sp));
  // Speakers seen in BOTH anchor and hidden turns are the ones diarization must recover.
  const hiddenSpeakers = scn.diarize
    ? [...new Set(scn.script
        .filter((t) => t.track === 'tab' && t.event === false)
        .map((t) => t.speaker)
        .filter((sp) => anchorSpeakers.has(sp)))]
    : [];

  return {
    tabSpeakers: [...tabSpeakers],
    expectSelfFallback: hasMic,
    hiddenSpeakers,
    hiddenOnlySpeakers,
    hiddenAttribution,
  };
}

// discover lists runnable scenarios for a harness. `kind` is 'transcribe' or 'diarize':
// diarize scenarios (mixed voices/languages) run only in diarize.e2e.js, the rest in
// transcribe.e2e.js. A scenario is runnable only if its generated audio fixture is present —
// long-meeting's heavy fixture is git-ignored, so it's skipped unless regenerated. Heavy
// scenarios are opt-in via RUN_E2E_HEAVY=1 so the normal run stays fast.
function discover(kind) {
  if (!fs.existsSync(SCENARIOS_DIR)) return [];
  return fs.readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.basename(f, '.json'))
    .map((name) => ({ name, scn: loadScenario(name), dir: path.join(FIXTURES_DIR, name) }))
    .filter(({ scn, dir }) => {
      const isDiarize = scn.diarize === true;
      if (kind === 'diarize' ? !isDiarize : isDiarize) return false;
      if (scn.heavy && !process.env.RUN_E2E_HEAVY) return false;
      return fs.existsSync(path.join(dir, 'tab.pcm.gz')); // generated audio must exist
    });
}

module.exports = {
  SCENARIOS_DIR, FIXTURES_DIR, T0, SAMPLE_RATE,
  emitsEvent, loadScenario, deriveExpectations, discover,
};
