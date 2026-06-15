// Content script (meet.google.com): derives the *active speaker* from the DOM
// and reports start/stop transitions to the background worker. It does NOT do
// voice diarization — it reads Meet's own "who is speaking" UI signal.
//
// IMPORTANT: Google Meet's DOM is obfuscated and changes often. We therefore
//   (a) match on stable-ish attributes (data-participant-id, aria, jsname)
//       rather than hashed CSS class names, and
//   (b) ship a debug helper — run `__tscriberDebug()` in the page console to
//       dump candidate tiles so SELECTORS can be re-tuned against the live DOM.
// Selector tuning + overlap handling is the Step 3 refinement; this is the PoC
// plumbing that proves the event stream reaches the backend.

const SELECTORS = {
  // A participant tile — carries the participant id in current Meet.
  tile: "[data-participant-id]",
  // The animated audio-level meter inside a tile. While a participant talks it
  // rapidly cycles CSS classes; when silent it is static. We detect speech as
  // "this meter changed class recently" rather than matching a single class,
  // which is robust to the animation. jsname is Meet-internal — if it changes,
  // re-discover it with probeSpeaking() (see diagnostics below).
  speakingMeter: '[jsname="QgSmzd"]',
};

const POLL_MS = 200;
const SPEAK_TIMEOUT_MS = 600; // meter silence before we declare speech ended

// Auto-run selector diagnostics on every page load. Off in normal use (avoids
// console spam); the window.__tscriber* helpers below stay available for manual
// re-tuning regardless of this flag.
const DEBUG = false;

// Text labels that live inside a tile but are NOT the participant name (hover
// controls / feature labels). Interim filter until the name element is pinned.
const NON_NAME = new Set([
  "Reframe", "Background", "Backgrounds", "Visual effects", "More options",
  "Pin", "Unpin", "Minimize", "You",
]);

function looksLikeName(t) {
  if (!t || t.length > 40) return false;
  if (/^[a-z0-9_]+$/.test(t)) return false; // material-icon ligature
  if (NON_NAME.has(t)) return false;
  return /[A-ZА-Я]/.test(t) || /\s/.test(t) || /[а-яё]/i.test(t);
}

function pickName(tile) {
  // Current Meet renders the participant name in <span class="notranslate">
  // inside the tile. Prefer that; fall back to a leaf-text heuristic if the
  // markup shifts.
  for (const el of tile.querySelectorAll(".notranslate")) {
    const t = (el.textContent || "").trim();
    if (looksLikeName(t)) return t;
  }
  for (const el of tile.querySelectorAll("*")) {
    if (el.childElementCount !== 0) continue;
    const t = (el.textContent || "").trim();
    if (looksLikeName(t)) return t;
  }
  return tile.getAttribute("data-participant-id") || "unknown";
}

function emit(speaker, event) {
  chrome.runtime.sendMessage({
    type: "speaker_event",
    speaker,
    event, // "start" | "stop"
    ts: Date.now(),
  });
}

// Activity tracking: a MutationObserver marks a participant active whenever its
// audio meter animates; the poll loop turns that into start/stop transitions.
const lastActivity = new Map(); // pid -> performance.now() of last meter change
const speaking = new Map(); // pid -> last emitted boolean
const nameByPid = new Map(); // pid -> resolved display name

const meterObserver = new MutationObserver((muts) => {
  for (const m of muts) {
    if (m.attributeName !== "class") continue;
    const el = m.target;
    if (!el.closest) continue;
    const meter = el.matches(SELECTORS.speakingMeter) ? el : el.closest(SELECTORS.speakingMeter);
    if (!meter) continue;
    const tile = meter.closest(SELECTORS.tile);
    if (!tile) continue;
    const pid = tile.getAttribute("data-participant-id");
    lastActivity.set(pid, performance.now());
    nameByPid.set(pid, pickName(tile));
  }
});
meterObserver.observe(document.body, {
  attributes: true,
  subtree: true,
  attributeFilter: ["class"],
});

function tick() {
  const now = performance.now();
  const present = new Set();
  for (const tile of document.querySelectorAll(SELECTORS.tile)) {
    const pid = tile.getAttribute("data-participant-id");
    present.add(pid);
    const isActive = now - (lastActivity.get(pid) ?? -1e12) < SPEAK_TIMEOUT_MS;
    const was = speaking.get(pid) || false;
    if (isActive && !was) {
      speaking.set(pid, true);
      emit(nameByPid.get(pid) || pickName(tile), "start");
    } else if (!isActive && was) {
      speaking.set(pid, false);
      emit(nameByPid.get(pid) || pickName(tile), "stop");
    }
  }
  // Participant left mid-speech -> close their interval.
  for (const pid of [...speaking.keys()]) {
    if (!present.has(pid)) {
      if (speaking.get(pid)) emit(nameByPid.get(pid) || pid, "stop");
      speaking.delete(pid);
      lastActivity.delete(pid);
    }
  }
}

setInterval(tick, POLL_MS);

// Transparency: when Chrome fully occludes/hides the Meet tab it pauses Meet's
// rAF-driven meter animation, so speaker detection stalls until the tab is
// visible again. Audio capture is unaffected. Log the transition so this is
// observable rather than mysterious.
document.addEventListener("visibilitychange", () => {
  const hidden = document.visibilityState === "hidden";
  console.log(
    `[t-scriber] tab ${document.visibilityState}` +
      (hidden ? " — speaker detection paused (audio still recording)" : " — speaker detection resumed"),
  );
});

// Selector-tuning diagnostics. Content scripts run in an isolated world, so a
// window.* helper isn't reachable from the page console — these auto-dump to the
// console (console output IS shared) so the structure can just be copied.
//
// In-call, tiles DO carry data-participant-id (the SELECTORS.tile anchor). What
// we still need to pin down is the *speaking* indicator markup — probeSpeaking()
// finds it by watching which class toggles while a participant talks.
function attrs(el) {
  return [...el.attributes].map((a) => `${a.name}="${a.value}"`).join(" ");
}

function climbToTile(el) {
  let tile = el;
  for (let k = 0; k < 6 && tile.parentElement; k++) tile = tile.parentElement;
  return tile;
}

function dumpDOM() {
  // Anchor on BOTH <video> (camera on) and avatar <img> (camera off) — many
  // participants join without video but still have a tile with their avatar.
  const anchors = [];
  document.querySelectorAll("video").forEach((v) => anchors.push(["video", v]));
  document.querySelectorAll("img").forEach((img) => {
    if ((img.src || "").includes("googleusercontent") || img.alt) anchors.push(["img", img]);
  });

  console.log(`[t-scriber] --- DOM probe (anchors=${anchors.length}) ---`);
  if (!anchors.length) {
    console.log("[t-scriber] no video/avatar yet — make sure you've JOINED the call.");
    return;
  }

  const seenTiles = new Set();
  let n = 0;
  for (const [kind, el] of anchors) {
    const tile = climbToTile(el);
    if (seenTiles.has(tile)) continue;
    seenTiles.add(tile);
    const text = (tile.textContent || "").trim().slice(0, 40);
    console.log(`[t-scriber] tile[${n}] via=${kind} text="${text}"`);
    console.log(`[t-scriber] tile[${n}] attrs: ${attrs(tile)}`);
    console.log(`[t-scriber] tile[${n}] html:`, tile.outerHTML.slice(0, 800));
    if (++n >= 8) break;
  }
  console.log("[t-scriber] --- end probe (copy everything above) ---");
}

window.__tscriberDebug = dumpDOM;

// Per-tile name resolution check + a dump of every leaf text in the tile, so
// the element that actually holds the participant name can be pinned down.
function dumpTiles() {
  const tiles = document.querySelectorAll(SELECTORS.tile);
  const now = performance.now();
  console.log(`[t-scriber] --- tiles=${tiles.length} ---`);
  tiles.forEach((tile, i) => {
    const pid = tile.getAttribute("data-participant-id");
    const active = now - (lastActivity.get(pid) ?? -1e12) < SPEAK_TIMEOUT_MS;
    console.log(`[t-scriber] tile[${i}] pid=${pid} name="${pickName(tile)}" speaking=${active}`);
    // All leaf texts with their element info — find where the real name lives.
    for (const el of tile.querySelectorAll("*")) {
      if (el.childElementCount !== 0) continue;
      const t = (el.textContent || "").trim();
      if (!t) continue;
      console.log(`[t-scriber]    leaf "${t}" <${el.tagName.toLowerCase()}> jsname=${el.getAttribute("jsname") || ""} class="${el.className}"`);
    }
  });
}
window.__tscriberTiles = dumpTiles;

// Finds the speaking indicator: observes class changes across all tiles for 12s
// and logs only the added/removed class tokens. Talk (or have someone talk)
// during the window — the token that toggles in sync with speech is the
// "is speaking" marker we should match in isSpeaking().
function probeSpeaking() {
  const tiles = [...document.querySelectorAll(SELECTORS.tile)];
  console.log(`[t-scriber] speaking probe started on ${tiles.length} tiles — TALK NOW for ~12s`);
  const prev = new WeakMap();
  tiles.forEach((t) =>
    t.querySelectorAll("*").forEach((el) => prev.set(el, el.className || "")),
  );
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.attributeName !== "class") continue;
      const el = m.target;
      const now = el.className || "";
      const before = prev.get(el) || "";
      prev.set(el, now);
      const a = new Set(now.split(/\s+/).filter(Boolean));
      const b = new Set(before.split(/\s+/).filter(Boolean));
      const added = [...a].filter((x) => !b.has(x));
      const removed = [...b].filter((x) => !a.has(x));
      if (added.length || removed.length) {
        console.log(
          `[t-scriber] classΔ <${el.tagName.toLowerCase()}> jsname=${el.getAttribute("jsname") || ""} +[${added}] -[${removed}]`,
        );
      }
    }
  });
  tiles.forEach((t) => obs.observe(t, { attributes: true, subtree: true, attributeFilter: ["class"] }));
  setTimeout(() => {
    obs.disconnect();
    console.log("[t-scriber] speaking probe done");
  }, 12000);
}
window.__tscriberSpeaking = probeSpeaking;

// --- Mic mute state tracking -----------------------------------------------
// Gates self-audio capture: when the user is muted in Meet (or not in a call
// at all), the offscreen document drops mic PCM frames before they reach the
// WebSocket. This prevents ambient home audio from leaking into the transcript.
//
// Selector note: Meet's mic button aria-label flips between
//   "Turn off microphone" (mic is ON)  and  "Turn on microphone" (mic is OFF).
// If the label format changes, re-discover it by inspecting the bottom control
// bar in Meet's DevTools — look for a button whose aria-label contains "microphone".
function getMicMuted() {
  const btn = document.querySelector('[aria-label*="microphone" i]');
  if (!btn) return null; // button not visible (tab hidden, controls collapsed) — keep last state
  return /turn on microphone/i.test(btn.getAttribute("aria-label") || "");
}

let lastMicMuted = null;
function checkMicMute() {
  const muted = getMicMuted();
  if (muted === null) return; // state unknown, don't change anything
  if (muted !== lastMicMuted) {
    lastMicMuted = muted;
    chrome.runtime.sendMessage({ type: "mic_mute", muted }).catch(() => {});
  }
}
setInterval(checkMicMute, 100);

// --- Auto-stop when the user leaves the call -------------------------------
// The tab-capture stream survives leaving the meeting (it just captures the
// post-call page), so we must explicitly tell the backend to stop. We detect
// two cases: an in-call->left transition (SPA) and the "you left / rejoin"
// screen (full reload).
let wasInCall = false;
let endedSent = false;

function inCall() {
  return !!document.querySelector('[aria-label*="leave call" i]');
}
function leftScreen() {
  return (
    !!document.querySelector('[aria-label*="rejoin" i]') ||
    /you left the (meeting|call)/i.test(document.body?.innerText || "")
  );
}
function checkMeetingState() {
  if (inCall()) {
    wasInCall = true;
    endedSent = false;
    return;
  }
  if ((wasInCall || leftScreen()) && !endedSent) {
    endedSent = true;
    chrome.runtime.sendMessage({ type: "meeting_ended" }).catch(() => {});
    console.log("[t-scriber] left the call -> requested stop");
  }
}
setInterval(checkMeetingState, 1000);

console.log("[t-scriber] content script active");
// Auto-diagnostic (DEBUG only): once tiles exist, dump resolved names + leaf texts
// a few times so the name element can be pinned down. (Speaking detection already
// works via meterObserver; probeSpeaking remains available for re-discovery.)
if (DEBUG) {
  let dumps = 0;
  const dumpTimer = setInterval(() => {
    const tiles = document.querySelectorAll(SELECTORS.tile);
    if (tiles.length) dumpTiles();
    else console.log("[t-scriber] no tiles yet — join the call");
    if (++dumps >= 4) clearInterval(dumpTimer);
  }, 6000);
}
