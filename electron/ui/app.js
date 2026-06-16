'use strict';

// -- Utilities --

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(s) {
  return s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const day = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${day}<br>${time}`;
}

function formatDateLong(isoStr) {
  if (!isoStr) return '';
  return new Date(isoStr).toLocaleString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function msToStamp(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function formatLogTime(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
}

function parseSummary(md) {
  const out = { resume: '', decisions: [], actions: [] };
  if (!md) return out;
  for (const part of md.split(/^##\s+/m)) {
    if (!part.trim()) continue;
    const nl = part.indexOf('\n');
    if (nl === -1) continue;
    const heading = part.slice(0, nl).trim();
    const body = part.slice(nl + 1).trim();
    const items = () => body.split('\n').map(l => l.replace(/^\s*[*\-]\s+/, '').trim()).filter(Boolean);
    if (heading === 'Краткое резюме') out.resume = body;
    else if (heading === 'Ключевые решения') out.decisions = items();
    else if (heading === 'Action items') out.actions = items();
  }
  return out;
}

function initials(name) {
  return (name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

const AVATAR_COLORS = [
  { bg: '#dbeafe', color: '#1d4ed8' },
  { bg: '#dcfce7', color: '#15803d' },
  { bg: '#fce7f3', color: '#be185d' },
  { bg: '#fef3c7', color: '#b45309' },
];

function avatarStyle(idx) {
  const c = AVATAR_COLORS[idx % AVATAR_COLORS.length];
  return `background:${c.bg};color:${c.color}`;
}

const TRASH = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
const REPROCESS = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`;

// -- State --
let currentSessionId = null;
let transcriptOpen = false;
let knownIds = new Set();

// -- Init --
window.addEventListener('DOMContentLoaded', () => {
  loadSessions();
  setupEvents();
});

function setupEvents() {
  window.tscriber.onEvent(event => {
    if (event.type === 'log') appendLog(event);
    else if (event.type === 'server-started') onServerStarted();
    else if (event.type === 'server-stopped') onServerStopped();
    else if (event.type === 'sessions-changed') onSessionsChanged();
    else if (event.type === 'log-panel-open') openLogPanel();
  });

  document.getElementById('log-toggle').addEventListener('click', () => {
    const panel = document.querySelector('.log-panel');
    const chevron = document.getElementById('log-chevron');
    panel.classList.toggle('log-open');
    chevron.textContent = panel.classList.contains('log-open') ? '▴' : '▾';
  });
}

// -- Server status --
function onServerStarted() {
  document.getElementById('status-dot').className = 'status-dot running';
  document.getElementById('status-text').textContent = 'Сервер запущен · ws://127.0.0.1:8080/capture';
}

function onServerStopped() {
  document.getElementById('status-dot').className = 'status-dot stopped';
  document.getElementById('status-text').textContent = 'Сервер остановлен';
}

function openLogPanel() {
  const panel = document.querySelector('.log-panel');
  const chevron = document.getElementById('log-chevron');
  if (!panel.classList.contains('log-open')) {
    panel.classList.add('log-open');
    chevron.textContent = '▴';
  }
}

// -- Log panel --
const MAX_LOG_LINES = 60;

function appendLog({ level, text, ts }) {
  const box = document.getElementById('log-lines');
  const div = document.createElement('div');
  div.className = `log-line${level ? ' ' + level : ''}`;
  div.innerHTML = `<span class="log-ts">${formatLogTime(ts)}</span><span class="log-msg">${escHtml(text)}</span>`;
  box.appendChild(div);
  while (box.children.length > MAX_LOG_LINES) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;

  const lastEl = document.getElementById('log-last');
  lastEl.textContent = text;
  lastEl.className = `log-last${level ? ' ' + level : ''}`;
}

// -- Sessions --
async function loadSessions() {
  const sessions = await window.tscriber.listSessions();
  knownIds = new Set(sessions.map(s => s.id));
  renderTable(sessions);
}

async function onSessionsChanged() {
  const sessions = await window.tscriber.listSessions();
  const newIds = new Set(sessions.map(s => s.id));
  // Find newly added sessions
  const addedIds = [...newIds].filter(id => !knownIds.has(id));
  knownIds = newIds;
  renderTable(sessions, addedIds);
  // If current detail session was updated, reload it
  if (currentSessionId && newIds.has(currentSessionId)) {
    const session = await window.tscriber.getSession(currentSessionId);
    if (session) renderDetail(session);
  }
}

// -- Table --
function renderTable(sessions, highlightIds = []) {
  const tbody = document.getElementById('tbody');
  if (!sessions.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Записей нет</td></tr>';
    return;
  }

  tbody.innerHTML = sessions.map(s => {
    const MAX_P = 4;
    const shown = s.participants.slice(0, MAX_P);
    const extra = s.participants.length - MAX_P;
    const participantsHtml = `<div class="p-pills">`
      + shown.map((p, i) => `<div class="avatar" style="${avatarStyle(i)}" title="${escHtml(p)}">${escHtml(initials(p))}</div>`).join('')
      + (extra > 0 ? `<span class="p-extra">+${extra}</span>` : '')
      + `</div>`;

    const isNew = highlightIds.includes(s.id);

    return `
      <tr data-id="${escHtml(s.id)}"${s.id === currentSessionId ? ' class="selected"' : isNew ? ' class="new-row"' : ''}>
        <td class="cell-date">${formatDate(s.started_at)}</td>
        <td>${participantsHtml}</td>
        <td>
          <div class="t-title">${escHtml(s.title || '')}</div>
          <div class="t-snippet">${escHtml(s.snippet || '')}</div>
        </td>
        <td class="cell-del"><div class="cell-btns"><button class="btn-reprocess" title="Перепрогнать">${REPROCESS}</button><button class="btn-del" title="Удалить">${TRASH}</button></div></td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('.btn-del') || e.target.closest('.btn-reprocess')) return;
      selectRow(tr.dataset.id, tr);
    });
    tr.querySelector('.btn-del').addEventListener('click', e => {
      e.stopPropagation();
      deleteSession(tr.dataset.id);
    });
    tr.querySelector('.btn-reprocess').addEventListener('click', e => {
      e.stopPropagation();
      reprocessSession(tr.dataset.id);
    });
  });
}

// -- Select --
async function selectRow(id, tr) {
  if (id === currentSessionId) {
    currentSessionId = null;
    transcriptOpen = false;
    document.querySelectorAll('#tbody tr').forEach(r => r.classList.remove('selected'));
    document.getElementById('app').classList.remove('detail-visible');
    return;
  }

  document.querySelectorAll('#tbody tr').forEach(r => r.classList.remove('selected'));
  tr.classList.add('selected');
  currentSessionId = id;
  transcriptOpen = false;

  const session = await window.tscriber.getSession(id);
  if (!session) return;

  renderDetail(session);
  document.getElementById('app').classList.add('detail-visible');
}

// -- Detail --
function renderDetail(session) {
  const summ = parseSummary(session.summary_md);
  const startMs = session.started_at ? new Date(session.started_at).getTime() : 0;
  const segs = session.transcript || [];

  let duration = '';
  if (segs.length >= 2) {
    const durMin = Math.round((segs[segs.length - 1].endMs - segs[0].startMs) / 60000);
    if (durMin > 0) duration = ` · ${durMin} мин`;
  }

  const pillsHtml = session.participants
    .map(p => `<span class="pill">${escHtml(p)}</span>`)
    .join('');

  let bodyHtml = '';
  if (summ.resume) {
    bodyHtml += `<div class="sec-label">Краткое резюме</div><p class="summary-body">${escHtml(summ.resume)}</p>`;
  }
  if (summ.decisions.length) {
    bodyHtml += `<div class="sec-label">Ключевые решения</div><ul class="dl">${
      summ.decisions.map(d => `<li><span>${renderInline(escHtml(d))}</span></li>`).join('')
    }</ul>`;
  }
  if (summ.actions.length) {
    bodyHtml += `<div class="sec-label">Action items</div><ul class="al">${
      summ.actions.map(a => `<li><span>${renderInline(escHtml(a))}</span></li>`).join('')
    }</ul>`;
  }
  if (!bodyHtml) bodyHtml = '<p class="no-summary">Резюме недоступно</p>';

  const transcriptHtml = segs.length ? `
    <button class="transcript-toggle" id="tr-toggle">
      <span class="tr-chevron">▾</span>
      <span id="tr-label">Показать транскрибацию</span>
    </button>
    <div id="tr-box" class="tr-box" style="display:none"></div>
  ` : '';

  // Remember scroll position before re-render
  const detailEl = document.querySelector('.detail-section');
  const scrollTop = detailEl?.scrollTop ?? 0;

  document.getElementById('detail-content').innerHTML = `
    <div class="dh">
      <div>
        <h1>${escHtml(session.meeting || session.id)}</h1>
        <div class="dh-sub">${formatDateLong(session.started_at)}${duration}</div>
        <div class="pills">${pillsHtml}</div>
      </div>
      <div class="dh-actions">
        <button class="btn-reprocess-lg" id="btn-reprocess-lg">${REPROCESS} Перепрогнать</button>
        <button class="btn-del-lg" id="btn-del-lg">${TRASH} Удалить</button>
      </div>
    </div>
    ${bodyHtml}
    ${transcriptHtml}
  `;

  // Restore scroll
  if (detailEl) detailEl.scrollTop = scrollTop;

  document.getElementById('btn-del-lg').addEventListener('click', () => deleteSession(currentSessionId));
  document.getElementById('btn-reprocess-lg').addEventListener('click', () => reprocessSession(currentSessionId));

  if (segs.length) {
    document.getElementById('tr-toggle').addEventListener('click', () => {
      toggleTranscript(segs, startMs);
    });
    // Restore open state after re-render
    if (transcriptOpen) toggleTranscript(segs, startMs);
  }
}

function toggleTranscript(segs, startMs) {
  const box = document.getElementById('tr-box');
  const label = document.getElementById('tr-label');
  const chevron = document.querySelector('.tr-chevron');

  if (!transcriptOpen) {
    box.innerHTML = segs.map(seg => `
      <div class="tr-line">
        <span class="tr-ts">${msToStamp(seg.startMs - startMs)}</span>
        <span class="tr-spk${seg.source === 'mic' ? ' self' : ''}">${escHtml(seg.speaker || '?')}</span>
        <span class="tr-txt">${escHtml(seg.text || '')}</span>
      </div>
    `).join('');
    box.style.display = 'block';
    label.textContent = 'Скрыть транскрибацию';
    chevron.textContent = '▴';
    transcriptOpen = true;
  } else {
    box.style.display = 'none';
    label.textContent = 'Показать транскрибацию';
    chevron.textContent = '▾';
    transcriptOpen = false;
  }
}

// -- Reprocess --
async function reprocessSession(id) {
  await window.tscriber.reprocessSession(id);
}

// -- Delete --
async function deleteSession(id) {
  const deleted = await window.tscriber.deleteSession(id);
  if (!deleted) return;

  if (id === currentSessionId) {
    currentSessionId = null;
    transcriptOpen = false;
    document.getElementById('app').classList.remove('detail-visible');
    document.getElementById('detail-content').innerHTML = '';
  }

  knownIds.delete(id);
  await loadSessions();
}
