'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
app.setName('T-Scriber');

// Expose resource root so config.js can resolve bundled binaries
// without importing Electron (config.js is also used by the CLI).
if (app.isPackaged) {
  process.env.TSCRIBER_RESOURCES = process.resourcesPath;
}

const TSCRIBER_DIR = path.join(os.homedir(), '.tscriber');
const CONFIG_PATH  = path.join(TSCRIBER_DIR, 'config.json');
const APP_ICON     = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
const DB_PATH      = path.join(TSCRIBER_DIR, 'tscriber.db');

let db;
let mainWindow     = null;
let settingsWindow = null;
let httpServer     = null;
let serverRunning  = false;
let rendererReady  = false;
const pendingEvents = [];

// -- DB -----------------------------------------------------------------------

function initDb() {
  fs.mkdirSync(TSCRIBER_DIR, { recursive: true });
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      started_at   TEXT,
      meeting      TEXT,
      participants TEXT,
      title        TEXT,
      snippet      TEXT,
      summary_md   TEXT,
      transcript   TEXT,
      dir          TEXT
    )
  `);
}

function deriveTitle(summaryMd) {
  if (!summaryMd) return null;
  const m = summaryMd.match(/##\s*Ключевые решения\s*\n([\s\S]*?)(?:\n##|$)/);
  if (m) {
    const bullet = m[1].match(/^\s*[*\-]\s+(.+)/m);
    if (bullet) return bullet[1].replace(/\*\*/g, '').trim().slice(0, 50);
  }
  const s = summaryMd.match(/##\s*Краткое резюме\s*\n([\s\S]*?)(?:\n##|$)/);
  if (s) return s[1].trim().split(/\s+/).slice(0, 6).join(' ');
  return null;
}

function deriveSnippet(summaryMd) {
  if (!summaryMd) return '';
  const m = summaryMd.match(/##\s*Краткое резюме\s*\n([\s\S]*?)(?:\n##|$)/);
  if (!m) return '';
  const text = m[1].trim().replace(/\n+/g, ' ');
  return text.length > 80 ? text.slice(0, 77) + '…' : text;
}

function buildRow(dir) {
  const name = path.basename(dir);
  const metaPath = path.join(dir, 'meta.json');
  const transcriptPath = path.join(dir, 'transcript.json');
  if (!fs.existsSync(metaPath) || !fs.existsSync(transcriptPath)) return null;

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const summaryMd = fs.existsSync(path.join(dir, 'summary.md'))
    ? fs.readFileSync(path.join(dir, 'summary.md'), 'utf8')
    : null;
  const transcriptRaw = fs.readFileSync(transcriptPath, 'utf8');
  const segments = JSON.parse(transcriptRaw);
  const participants = [...new Set(segments.map(s => s.speaker).filter(Boolean))];

  return {
    id:           meta.id || name,
    started_at:   meta.started_at || null,
    meeting:      meta.meeting || null,
    participants: JSON.stringify(participants),
    title:        deriveTitle(summaryMd) || meta.meeting || name,
    snippet:      deriveSnippet(summaryMd),
    summary_md:   summaryMd,
    transcript:   transcriptRaw,
    dir,
  };
}

function importSessions() {
  const dataDir = path.join(TSCRIBER_DIR, 'sessions');
  if (!fs.existsSync(dataDir)) return;

  const existing = new Set(db.prepare('SELECT id FROM sessions').all().map(r => r.id));
  let dirs;
  try { dirs = fs.readdirSync(dataDir); } catch { return; }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO sessions
      (id, started_at, meeting, participants, title, snippet, summary_md, transcript, dir)
    VALUES (@id, @started_at, @meeting, @participants, @title, @snippet, @summary_md, @transcript, @dir)
  `);

  for (const name of dirs) {
    if (existing.has(name)) continue;
    const dir = path.join(dataDir, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const row = buildRow(dir);
      if (row) insert.run(row);
    } catch (e) {
      console.error(`Import failed for ${name}:`, e.message);
    }
  }
}

function refreshSession(dir) {
  try {
    const row = buildRow(dir);
    if (!row) return;
    db.prepare(`
      INSERT OR REPLACE INTO sessions
        (id, started_at, meeting, participants, title, snippet, summary_md, transcript, dir)
      VALUES (@id, @started_at, @meeting, @participants, @title, @snippet, @summary_md, @transcript, @dir)
    `).run(row);
    setTimeout(() => sendToRenderer({ type: 'sessions-changed' }), 100);
  } catch (e) {
    console.error(`refreshSession failed for ${dir}:`, e.message);
  }
}

// -- Config IPC ---------------------------------------------------------------

ipcMain.handle('get-config', () => {
  const { load } = require('./src/config.js');
  return load().cfg;
});

ipcMain.handle('save-config', (_, overrides) => {
  fs.mkdirSync(TSCRIBER_DIR, { recursive: true });
  // Read existing file so we preserve fields we don't show in UI (e.g. addr).
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  const merged = { ...existing, ...overrides };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n');
});

ipcMain.handle('choose-file', async (event, { filters = [] } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters,
  });
  return canceled ? null : filePaths[0];
});

// -- Session IPC --------------------------------------------------------------

ipcMain.handle('list-sessions', () =>
  db.prepare(
    'SELECT id, started_at, meeting, participants, title, snippet FROM sessions ORDER BY started_at DESC'
  ).all().map(r => ({ ...r, participants: JSON.parse(r.participants || '[]') }))
);

ipcMain.handle('get-session', (_, id) => {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    participants: JSON.parse(row.participants || '[]'),
    transcript: JSON.parse(row.transcript || '[]'),
  };
});

ipcMain.handle('delete-session', async (event, id) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Отмена', 'Удалить'],
    defaultId: 0,
    cancelId: 0,
    message: 'Удалить запись?',
    detail: 'Все файлы сессии будут удалены без возможности восстановления.',
  });
  if (response !== 1) return false;

  const row = db.prepare('SELECT dir FROM sessions WHERE id = ?').get(id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  if (row?.dir && fs.existsSync(row.dir)) {
    fs.rmSync(row.dir, { recursive: true, force: true });
  }
  return true;
});

// -- Renderer communication ---------------------------------------------------

function sendToRenderer(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!rendererReady) {
    pendingEvents.push(event);
    return;
  }
  mainWindow.webContents.send('event', event);
}

function sendLog(level, text) {
  sendToRenderer({ type: 'log', level, text, ts: Date.now() });
}

// -- Capture server -----------------------------------------------------------

function onServerEvent({ type, msg, meeting }) {
  if (type === 'speaker' || type === 'stats') return;

  let level = 'info';
  let display = msg;

  if (type === 'connect') {
    level = 'connect';
    display = 'Расширение подключено';
  } else if (type === 'session') {
    level = 'session';
    display = meeting ? `Встреча начата: ${meeting}` : 'Запись началась';
  } else if (type === 'stop') {
    level = 'stop';
    display = 'Запись завершена';
  } else if (type === 'error') {
    level = 'error';
  }

  sendLog(level, display);
}

async function startServer() {
  const { load: loadConfig } = require('./src/config.js');
  const { CaptureServer } = require('./src/capture.js');
  const { process: pipelineProcess } = require('./src/pipeline.js');

  // Use initial config only for server address + data dir.
  const { cfg: initialCfg } = loadConfig();
  fs.mkdirSync(initialCfg.data_dir, { recursive: true });

  const srv = new CaptureServer(initialCfg.data_dir, onServerEvent);
  srv.logStatsEvery(5000);

  srv.onComplete = async (dir) => {
    // Re-read config on every recording so settings changes take effect
    // without restarting the app.
    const { cfg } = loadConfig();

    if (!cfg.auto) return;

    if (!cfg.model || !fs.existsSync(cfg.model)) {
      sendLog('error', 'Модель Whisper не задана — укажите путь в настройках (⌘,)');
      return;
    }

    sendLog('processing', 'Транскрибация...');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    try {
      const res = await pipelineProcess(dir, cfg, controller.signal);
      clearTimeout(timeout);
      if (res.dialogue.length === 0) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        sendLog('info', 'Ничего не записано');
        return;
      }
      sendLog('success', `Транскрибация готова · ${res.dialogue.length} сегментов`);
      refreshSession(dir);
      if (res.summaryErr) {
        sendLog('info', 'Резюме пропущено');
      } else if (res.summary) {
        sendLog('success', 'Резюме готово');
        refreshSession(dir);
      }
    } catch (e) {
      clearTimeout(timeout);
      sendLog('error', e.message);
    }
  };

  const [host, portStr] = initialCfg.addr.split(':');
  const port = parseInt(portStr, 10);

  httpServer = srv.createHttpServer();
  httpServer.listen(port, host, () => {
    serverRunning = true;
    sendToRenderer({ type: 'server-started' });
  });

  httpServer.on('error', (err) => {
    serverRunning = false;
    sendLog('error', `Сервер: ${err.message}`);
    sendToRenderer({ type: 'server-stopped' });
  });
}

// -- Settings window ----------------------------------------------------------

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 540,
    height: 480,
    resizable: false,
    title: 'Настройки',
    icon: APP_ICON,
    titleBarStyle: 'hiddenInset',
    minimizable: false,
    maximizable: false,
    parent: mainWindow ?? undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'ui', 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// -- App menu -----------------------------------------------------------------

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Настройки…',
          accelerator: 'CmdOrCtrl+,',
          click: openSettings,
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Окно',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// -- Main window --------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 540,
    title: 'T-Scriber',
    icon: APP_ICON,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    rendererReady = true;
    for (const e of pendingEvents.splice(0)) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('event', e);
      }
    }
    // Sync server state to a window that was opened while server was already running.
    if (serverRunning && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('event', { type: 'server-started' });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });
}

function showExtensionHint(win) {
  const extensionPath = app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.join(__dirname, '..', 'extension');
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'Установите расширение Chrome',
    message: 'Для записи встреч нужно расширение Chrome.',
    detail:
      'Откройте Chrome → chrome://extensions → включите «Режим разработчика» → '
      + '"Загрузить распакованное" → выберите папку:\n\n' + extensionPath,
    buttons: ['Понятно'],
  });
}

// -- Lifecycle ----------------------------------------------------------------

app.whenReady().then(() => {
  buildMenu();
  initDb();
  importSessions();
  createWindow();

  // Show extension install hint on first ever launch.
  const hintFlag = path.join(TSCRIBER_DIR, '.extension-hint-shown');
  if (!fs.existsSync(hintFlag)) {
    fs.mkdirSync(TSCRIBER_DIR, { recursive: true });
    fs.writeFileSync(hintFlag, '');
    if (mainWindow) showExtensionHint(mainWindow);
  }

  startServer().catch(err => {
    console.error('startServer:', err);
    sendLog('error', `Сервер не запустился: ${err.message}`);
    sendToRenderer({ type: 'server-stopped' });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (httpServer) { httpServer.close(); httpServer = null; serverRunning = false; }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// app.on('browser-window-created', (event, window) => {
//   window.webContents.openDevTools({ mode: 'detach' });
// });