// Popup: the Start click is a genuine user gesture, which is the reliable place
// to call tabCapture.getMediaStreamId(). We grab the stream id here and hand it
// to the background worker, which sets up the offscreen document + WebSocket.

const toggle = document.getElementById("toggle");
const statusEl = document.getElementById("status");
const dot = document.getElementById("dot");
const stateLabel = document.getElementById("state-label");
const langSelect = document.getElementById("lang-select");

function setStatus(text, isErr = false) {
  statusEl.textContent = text;
  statusEl.className = isErr ? "err" : "";
}

function render(recording) {
  toggle.textContent = recording ? "■ Stop recording" : "● Start recording";
  toggle.className = recording ? "rec" : "idle";
  dot.className = recording ? "rec" : "";
  stateLabel.className = recording ? "rec" : "";
  stateLabel.textContent = recording ? "Recording" : "Not recording";
  langSelect.disabled = recording;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function start() {
  const tab = await activeTab();
  // Real meeting rooms look like meet.google.com/xxx-xxxx-xxx (e.g. pyv-umiq-shg).
  // Reject the landing page, settings, and other non-call Meet URLs.
  if (!/^https:\/\/meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+([/?]|$)/.test(tab?.url || "")) {
    setStatus("Open a Google Meet call first (not the landing page).", true);
    return;
  }
  // Defensive cleanup: if a previous capture is still holding the tab (e.g. the
  // service worker was restarted and lost its in-memory state), getMediaStreamId
  // throws "Cannot capture a tab with an active stream". Tearing down any stale
  // offscreen document first releases the stream.
  await chrome.runtime.sendMessage({ type: "stop" }).catch(() => {});

  // The offscreen document is invisible and cannot surface a permission prompt,
  // so the mic must be pre-granted for the extension origin. Asking inside the
  // transient popup is unreliable (the prompt steals focus and closes the popup,
  // aborting the request -> NotAllowedError). Instead we check the stored state
  // and, if not yet granted, open a real extension tab that does the prompting.
  let micState = "prompt";
  try {
    micState = (await navigator.permissions.query({ name: "microphone" })).state;
  } catch (_) {
    /* older Chrome: fall through and attempt anyway */
  }
  if (micState !== "granted") {
    await chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
    setStatus("Grant microphone in the opened tab, then click Start again.", true);
    return;
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  const res = await chrome.runtime.sendMessage({
    type: "start",
    streamId,
    meeting: tab.title || tab.url,
    language: langSelect.value,
  });
  if (!res?.ok) throw new Error(res?.error || "start failed");
  render(true);
  setStatus("");
}

async function stop() {
  const res = await chrome.runtime.sendMessage({ type: "stop" });
  if (!res?.ok) throw new Error(res?.error || "stop failed");
  render(false);
  setStatus("");
}

toggle.addEventListener("click", async () => {
  toggle.disabled = true;
  try {
    const { recording } = await chrome.runtime.sendMessage({ type: "status" });
    if (recording) await stop();
    else await start();
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes("active stream")) {
      render(false);
      setStatus("Tab already captured — reload the Meet tab, then Start again.", true);
    } else {
      setStatus(msg, true);
    }
  } finally {
    toggle.disabled = false;
  }
});

langSelect.addEventListener("change", () => {
  chrome.storage.local.set({ language: langSelect.value });
});

(async () => {
  try {
    const { language } = await chrome.storage.local.get({ language: "ru" });
    langSelect.value = language;
    const { recording } = await chrome.runtime.sendMessage({ type: "status" });
    render(recording);
  } catch (_) {
    render(false);
  }
})();
