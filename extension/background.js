// Service worker: orchestrates capture. It is intentionally thin because MV3
// service workers are killed after ~30s idle — the long-lived WebSocket and the
// audio graph live in the offscreen document instead. This worker only:
//   1. spins up / tears down the offscreen document,
//   2. relays the tab media-stream id (obtained in the popup) to offscreen,
//   3. forwards DOM speaker events from the content script to offscreen,
//   4. auto-stops when the user leaves the meeting.
//
// State note: the service worker is killed after ~30s idle and loses any
// in-memory flag, so "are we recording?" must NOT live in a variable. The
// source of truth is whether the offscreen document exists — it exists iff we
// are capturing. Everything below derives state from hasDocument().

const isRecording = () => chrome.offscreen.hasDocument();

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification:
      "Capture Google Meet tab audio and the local microphone for on-device transcription.",
  });
}

async function startCapture({ streamId, meeting, language }) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", cmd: "start", streamId, meeting, language });
  if (!res?.ok) {
    await stopCapture();
    throw new Error(res?.error || "Capture failed");
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#d33" });
  await chrome.action.setBadgeText({ text: "REC" });
}

async function stopCapture() {
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", cmd: "stop" });
  } catch (_) {
    /* offscreen may already be gone */
  }
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
  await chrome.action.setBadgeText({ text: "" });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case "start":
      startCapture(msg)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true; // async response

    case "stop":
      stopCapture()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;

    case "status":
      isRecording().then((recording) => sendResponse({ recording }));
      return true;

    case "meeting_ended":
      // Content script detected we left the call — tear down so the server
      // stops receiving (no orphaned offscreen capturing a post-call page).
      isRecording().then((rec) => rec && stopCapture());
      return false;

    case "speaker_event":
      // Forward DOM-derived active-speaker transitions to the offscreen WS owner.
      isRecording().then(
        (rec) =>
          rec &&
          chrome.runtime
            .sendMessage({ target: "offscreen", cmd: "speaker_event", payload: msg })
            .catch(() => {}),
      );
      return false;

    case "mic_mute":
      // Forward Meet's mic mute state to offscreen so it can gate mic PCM frames.
      isRecording().then(
        (rec) =>
          rec &&
          chrome.runtime
            .sendMessage({ target: "offscreen", cmd: "mic_mute", muted: msg.muted })
            .catch(() => {}),
      );
      return false;
  }
});
