'use strict';

const http = require('node:http');
const { WebSocketServer } = require('ws');
const { newSession } = require('./session.js');

const BINARY_HEADER_LEN = 9;

class CaptureServer {
  // logger: optional fn({ type, msg }) — defaults to console.log
  // type: 'connect' | 'session' | 'speaker' | 'stats' | 'stop' | 'error'
  constructor(dataDir, logger = null) {
    this.dataDir    = dataDir;
    this.onComplete = null;
    this._sessions  = new Map();
    this._log       = logger ?? (({ msg }) => console.log(msg));
  }

  _emit(type, msg, extra = null) { this._log({ type, msg, ...extra }); }

  createHttpServer() {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });

    wss.on('connection', (ws, req) => {
      this._emit('connect', `extension connected: ${req.socket.remoteAddress}`);

      ws.on('message', (data, isBinary) => {
        if (isBinary) this._onBinary(ws, data);
        else this._onText(ws, data.toString('utf8'));
      });

      ws.on('close', ()    => this._closeSession(ws));
      ws.on('error', (err) => {
        if (err.code !== 'ECONNRESET') this._emit('error', `ws error: ${err.message}`);
        this._closeSession(ws);
      });
    });

    const server = http.createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
      res.writeHead(404); res.end();
    });

    server.on('upgrade', (req, socket, head) => {
      if (req.url === '/capture') {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      } else {
        socket.destroy();
      }
    });

    return server;
  }

  logStatsEvery(ms) {
    const id = setInterval(() => {
      for (const sess of this._sessions.values()) {
        this._emit('stats', `… ${sess.stats()}`);
      }
    }, ms);
    id.unref();
  }

  _onText(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { this._emit('error', `bad json: ${raw}`); return; }

    switch (msg.type) {
      case 'session_start': {
        const sess = newSession(this.dataDir, msg.meeting || '');
        this._sessions.set(ws, sess);
        this._emit('session', `▶ session_start meeting="${msg.meeting}" -> ${sess.dir}`, { meeting: msg.meeting || '' });
        break;
      }
      case 'speaker_event': {
        this._emit('speaker', `🗣  speaker="${msg.speaker}" event=${msg.event} ts=${msg.ts}`);
        const sess = this._sessions.get(ws);
        if (sess) sess.writeEvent(raw);
        break;
      }
      case 'session_stop':
        this._closeSession(ws);
        break;
      default: {
        const sess = this._sessions.get(ws);
        if (sess) sess.writeEvent(raw);
        break;
      }
    }
  }

  _onBinary(ws, data) {
    if (data.length < BINARY_HEADER_LEN) {
      this._emit('error', `binary frame too short: ${data.length} bytes`);
      return;
    }
    const src  = data[0];
    const tsMs = Number(data.readBigInt64LE(1));
    const pcm  = data.slice(BINARY_HEADER_LEN);

    let sess = this._sessions.get(ws);
    if (!sess) {
      sess = newSession(this.dataDir, '');
      this._sessions.set(ws, sess);
      this._emit('session', `▶ implicit session_start -> ${sess.dir}`);
    }
    sess.writePCM(src, tsMs, pcm);
  }

  _closeSession(ws) {
    const sess = this._sessions.get(ws);
    if (!sess) return;
    this._sessions.delete(ws);
    this._emit('stop', `■ ${sess.stats()}`);
    sess.close(() => {
      if (this.onComplete) setImmediate(() => this.onComplete(sess.dir));
    });
  }
}

module.exports = { CaptureServer };
