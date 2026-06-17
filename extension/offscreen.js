// Offscreen document: owns the WebSocket to the local backend and the Web
// Audio graph. Captures two streams — the tab output (remote participants) and
// the local microphone ("self") — downsamples each to 16 kHz mono Int16 PCM and
// streams them as binary frames. DOM speaker events are relayed in as JSON.
//
// Binary frame layout (must match electron/src/capture.js BINARY_HEADER_LEN):
//   byte 0     : source (0 = tab, 1 = mic)
//   bytes 1..9 : int64 LE epoch millis
//   bytes 9..  : int16 LE mono PCM @ 16 kHz

const WS_URL = "ws://127.0.0.1:8080/capture";
const TARGET_RATE = 16000;
const SOURCE_TAB = 0;
const SOURCE_MIC = 1;
const BINARY_HEADER_LEN = 9; // 1-byte source + 8-byte int64 LE timestamp

let ws = null;
let wsReady = false;
const pending = []; // messages queued until the socket opens

let audioCtx = null;
let tabStream = null;
let micStream = null;
let nodes = []; // graph nodes to disconnect on stop

// Default false: popup.js only allows recording from a real call URL, so when
// recording starts the mic is almost certainly active. The first poll (≤100ms)
// from content.js will correct it if the user actually is muted.
let micMuted = false;

function connectWS(meeting, language) {
  return new Promise((resolve, reject) => {
    let done = false;
    ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    const deadline = setTimeout(() => {
      if (done) return;
      done = true;
      ws.close();
      reject(new Error("Server unreachable — is t-scriber running?"));
    }, 3000);
    ws.onopen = () => {
      clearTimeout(deadline);
      done = true;
      wsReady = true;
      sendJSON({ type: "session_start", meeting: meeting || "", language: language || "en", ts: Date.now() });
      for (const m of pending.splice(0)) ws.send(m);
      console.log("[t-scriber] WS connected");
      resolve();
    };
    ws.onclose = () => {
      wsReady = false;
      console.log("[t-scriber] WS closed");
      if (!done) {
        done = true;
        clearTimeout(deadline);
        reject(new Error("Server unreachable — is t-scriber running?"));
      }
    };
    ws.onerror = (e) => console.warn("[t-scriber] WS error", e);
  });
}

function sendJSON(obj) {
  const s = JSON.stringify(obj);
  if (wsReady) ws.send(s);
  else pending.push(s);
}

function sendPCM(source, int16) {
  if (!int16.length) return;
  const frame = new Uint8Array(BINARY_HEADER_LEN + int16.byteLength);
  const dv = new DataView(frame.buffer);
  dv.setUint8(0, source);
  dv.setBigInt64(1, BigInt(Date.now()), true);
  frame.set(new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength), BINARY_HEADER_LEN);
  if (wsReady) ws.send(frame.buffer);
  // Drop audio if the socket is not ready — backpressure beats unbounded memory.
}

// Stateful linear resampler from inRate -> TARGET_RATE. Carries the fractional
// read position and previous sample across worklet chunks. Tiny error at chunk
// boundaries is irrelevant for ASR.
function createResampler(inRate) {
  const step = inRate / TARGET_RATE;
  let pos = 0;
  return (input) => {
    const out = [];
    while (pos < input.length) {
      const i = Math.floor(pos);
      const t = pos - i;
      const a = input[i];
      const b = i + 1 < input.length ? input[i + 1] : input[i];
      out.push(a + (b - a) * t);
      pos += step;
    }
    pos -= input.length;
    return Float32Array.from(out);
  };
}

function floatToInt16(floats) {
  const out = new Int16Array(floats.length);
  for (let i = 0; i < floats.length; i++) {
    const s = Math.max(-1, Math.min(1, floats[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Wires one MediaStream into the graph: source -> worklet (capture) and,
// optionally, source -> destination (so the user keeps hearing the call).
async function pipe(stream, source, { playback }) {
  const src = audioCtx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioCtx, "pcm-capture");
  const resample = createResampler(audioCtx.sampleRate);

  worklet.port.onmessage = (e) => {
    if (source === SOURCE_MIC && micMuted) return;
    const resampled = resample(e.data);
    sendPCM(source, floatToInt16(resampled));
  };

  src.connect(worklet);
  // Keep the worklet pulled by the graph; it outputs silence so this is inaudible.
  worklet.connect(audioCtx.destination);
  if (playback) src.connect(audioCtx.destination);

  nodes.push(src, worklet);
}

async function start(streamId, meeting, language) {
  await connectWS(meeting, language);

  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
    video: false,
  });

  // Microphone is a separate stream — tab audio does NOT contain your own voice.
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    console.warn("[t-scriber] mic capture failed (self will be missing):", e);
  }

  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule(chrome.runtime.getURL("pcm-worklet.js"));
  await audioCtx.resume();

  await pipe(tabStream, SOURCE_TAB, { playback: true }); // remote participants, keep audible
  if (micStream) await pipe(micStream, SOURCE_MIC, { playback: false }); // self, no echo

  console.log("[t-scriber] capture started @", audioCtx.sampleRate, "Hz ->", TARGET_RATE);
}

function stop() {
  for (const n of nodes) {
    try {
      n.disconnect();
    } catch (_) {}
  }
  nodes = [];
  for (const s of [tabStream, micStream]) {
    s?.getTracks().forEach((t) => t.stop());
  }
  tabStream = micStream = null;
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
  if (ws && wsReady) sendJSON({ type: "session_stop", ts: Date.now() });
  ws?.close();
  ws = null;
  wsReady = false;
  console.log("[t-scriber] capture stopped");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return;
  switch (msg.cmd) {
    case "start":
      start(msg.streamId, msg.meeting, msg.language)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true; // keep message channel open for async response
    case "stop":
      stop();
      break;
    case "speaker_event":
      sendJSON({
        type: "speaker_event",
        speaker: msg.payload.speaker,
        event: msg.payload.event,
        ts: msg.payload.ts,
      });
      break;
    case "mic_mute":
      micMuted = msg.muted;
      break;
  }
});
