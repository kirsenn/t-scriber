'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, shell } = require('electron');
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

const dbModule = require('./src/db.js');

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
  db = dbModule.openDb();
}

function importSessions() {
  dbModule.importSessions(db, path.join(TSCRIBER_DIR, 'sessions'));
}

function refreshSession(dir) {
  try {
    const row = dbModule.refreshSession(db, dir);
    if (!row) return;
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

ipcMain.handle('reprocess-session', async (event, id) => {
  const win = BrowserWindow.fromWebContents(event.sender);

  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Отмена', 'Только саммари', 'Транскрибация + саммари'],
    defaultId: 1,
    cancelId: 0,
    message: 'Перепрогнать обработку?',
    detail: 'Только саммари — быстро, использует уже готовую транскрибацию.\nТранскрибация + саммари — полный перезапуск с нуля.',
  });

  if (response === 0) return { ok: false };

  const mode = response === 1 ? 'summary' : 'full';

  const row = db.prepare('SELECT dir FROM sessions WHERE id = ?').get(id);
  if (!row?.dir) return { ok: false, error: 'Сессия не найдена' };

  const { load: loadConfig } = require('./src/config.js');
  const { process: pipelineProcess, summaryOnly } = require('./src/pipeline.js');

  const { cfg } = loadConfig();

  if (mode === 'full' && (!cfg.model || !fs.existsSync(cfg.model))) {
    sendLog('error', 'Модель Whisper не задана — укажите путь в настройках (⌘,)');
    return { ok: false, error: 'no model' };
  }

  sendToRenderer({ type: 'log-panel-open' });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30 * 60 * 1000);

  try {
    if (mode === 'summary') {
      sendLog('processing', 'Генерация саммари…');
      const res = await summaryOnly(row.dir, cfg, controller.signal);
      clearTimeout(timeout);
      if (res.summaryErr) {
        sendLog('error', `Ошибка саммари: ${res.summaryErr.message}`);
        return { ok: false, error: res.summaryErr.message };
      }
      sendLog('success', 'Саммари готово');
    } else {
      sendLog('processing', 'Транскрибация…');
      const res = await pipelineProcess(row.dir, cfg, controller.signal);
      clearTimeout(timeout);
      sendLog('success', `Транскрибация готова · ${res.dialogue.length} сегментов`);
      if (res.summaryErr) {
        sendLog('info', `Резюме пропущено: ${res.summaryErr.message}`);
      } else if (res.summary) {
        sendLog('success', 'Резюме готово');
      }
    }
    refreshSession(row.dir);
    return { ok: true };
  } catch (e) {
    clearTimeout(timeout);
    sendLog('error', e.message);
    return { ok: false, error: e.message };
  }
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
    {
      label: 'Помощь',
      submenu: [
        {
          label: 'Открыть папку расширения',
          click() {
            const extensionPath = app.isPackaged
              ? path.join(process.resourcesPath, 'extension')
              : path.join(__dirname, '..', 'extension');
            shell.openPath(extensionPath);
          },
        },
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
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'Установите расширение Chrome',
    message: 'Для записи встреч нужно расширение Chrome.',
    detail:
      'Откройте меню Помощь → «Открыть папку расширения», затем:\n\n'
      + 'Chrome → chrome://extensions → включите «Режим разработчика» → '
      + '"Загрузить распакованное" → выберите открывшуюся папку.',
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