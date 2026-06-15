// Opened as a real extension tab when the microphone is not yet granted. A tab
// (unlike the transient popup) keeps focus while the permission prompt is shown,
// so getUserMedia resolves reliably. Once granted, the permission persists for
// the extension origin and the offscreen document can use the mic.

const statusEl = document.getElementById("status");

function set(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || "";
}

(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    set("✓ Microphone granted. You can close this tab and click Start again.", "ok");
    setTimeout(() => window.close(), 2000);
  } catch (e) {
    if (e.name === "NotAllowedError") {
      set(
        "Microphone blocked. If you didn't see a prompt, macOS is blocking Chrome: " +
          "System Settings → Privacy & Security → Microphone → enable Google Chrome, " +
          "then fully quit and reopen Chrome and try again.",
        "err",
      );
    } else if (e.name === "NotFoundError") {
      set("No microphone device found.", "err");
    } else {
      set("Microphone error: " + (e.name || e), "err");
    }
  }
})();
