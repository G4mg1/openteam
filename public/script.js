/* ============================================================
   MiroxAI — Frontend Script v17
   FIXED: model picker (wrapper div + clean handlers)
   Default model = FIRST model in config (Luna)
   ============================================================ */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getDatabase, ref, set, get, update, push, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

const FIREBASE_CONFIG = { databaseURL: 'https://miroxdata-default-rtdb.europe-west1.firebasedatabase.app/' };
const firebaseApp = initializeApp(FIREBASE_CONFIG);
const db = getDatabase(firebaseApp);

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

/* Fallback — matches backend MODELS order, Luna FIRST */
const FALLBACK_MODELS = [
  { id: 'mirox-luna-1.2', label: 'Luna', tagline: 'Fast · warm · free', default: true },
  { id: 'mirox-gen-1', label: 'Gen', tagline: 'Ultra concise' },
  { id: 'mirox-pro-5', label: 'Pro', tagline: 'Balanced · deeper' },
  { id: 'mirox-ultra-10', label: 'Ultra', tagline: 'Deep reasoning' },
  { id: 'mirox-eclipse-2.0', label: 'Eclipse', tagline: 'Best quality' },
];

let __config = null;
let __user = null;
let __tier = 'free';
let __model = 'mirox-luna-1.2';
let currentConversationId = null;
let isReplying = false;
let __conversations = [];
let pendingFiles = [];
let bgState = { url: null, dim: 45 };
let recognition = null, callRecognition = null;
let synth = window.speechSynthesis;
let callActive = false, callMuted = false, micStream = null;
let activeStreamController = null;

const LS_KEY = 'miroxai_conversations_v5';
const TOKEN_KEY = 'mirox_token';
const USER_SETTINGS_KEY = 'miroxai_user_settings_v5';
const DEVICE_ID_KEY = 'mirox_device_id';
const APPEARANCE_KEY = 'miroxai_appearance_v5';
const BG_KEY = 'miroxai_bg_v5';
const MCP_KEY = 'miroxai_mcp_v5';
const IMAGE_STORE_KEY = 'miroxai_saved_images_v1';
let savedImages = [];
let currentGeneratedImage = null;

/* ---------- Utilities ---------- */
function killLoader() {
  const l = document.getElementById('loadingScreen');
  if (l) { l.classList.add('hidden'); setTimeout(() => l.style.display = 'none', 400); }
}
killLoader(); setTimeout(killLoader, 500); setTimeout(killLoader, 1800);

const uid = () => 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const escapeHtml = s => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) { id = 'dev_' + uid(); localStorage.setItem(DEVICE_ID_KEY, id); }
  return id;
}
function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }

async function authJson(url, opts = {}, fallback = null) {
  try {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const t = getToken();
    if (t) headers.Authorization = 'Bearer ' + t;
    const r = await fetch(url, { ...opts, headers, credentials: 'same-origin', cache: 'no-store' });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) return fallback;
    return await r.json();
  } catch { return fallback; }
}
async function saveToFirebase(path, data) { try { await set(ref(db, path), data); } catch {} }
async function updateFirebase(path, data) { try { await update(ref(db, path), data); } catch {} }
async function readFromFirebase(path) { try { const s = await get(ref(db, path)); return s.exists() ? s.val() : null; } catch { return null; } }
async function pushToFirebase(path, data) { try { const r = push(ref(db, path)); await set(r, { ...data, _ts: serverTimestamp() }); } catch {} }

function openModal(id) { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
function openSidebar() { $('#sidebar')?.classList.add('open'); $('#sidebarScrim')?.classList.add('open'); }
function closeSidebar() { $('#sidebar')?.classList.remove('open'); $('#sidebarScrim')?.classList.remove('open'); }

/* ---------- Settings ---------- */
let userSettings = { soundOn: true, notifOn: true, highlightOn: true, lineNumbers: false, language: 'en-US', voiceRate: 1 };
function loadUserSettings() { try { userSettings = { ...userSettings, ...JSON.parse(localStorage.getItem(USER_SETTINGS_KEY) || '{}') }; } catch {} }
function saveUserSettings() { try { localStorage.setItem(USER_SETTINGS_KEY, JSON.stringify(userSettings)); } catch {} }

/* ---------- Appearance ---------- */
function loadAppearance() {
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}'); } catch {}
  if (!prefs.mode && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) prefs.mode = 'dark';
  applyAppearance(prefs);
}
function applyAppearance(prefs) {
  const root = document.documentElement;
  const mode = prefs.mode || root.getAttribute('data-mode') || 'light';
  const theme = prefs.theme || root.getAttribute('data-theme') || 'default';
  const corner = prefs.corner || root.getAttribute('data-corner') || 'soft';
  root.setAttribute('data-mode', mode);
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-corner', corner);
  try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ mode, theme, corner })); } catch {}
  $$('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $$('.swatch').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
  $$('[data-corner]').forEach(b => b.classList.toggle('active', b.dataset.corner === corner));
}

/* ---------- Background ---------- */
function loadBgPrefs() { try { bgState = { ...bgState, ...JSON.parse(localStorage.getItem(BG_KEY) || '{}') }; } catch {}; applyBackground(); }
function applyBackground() {
  document.body.style.backgroundImage = bgState.url
    ? `linear-gradient(rgba(20,15,10,${bgState.dim / 100}), rgba(20,15,10,${bgState.dim / 100})), url("${bgState.url}"), radial-gradient(ellipse 80% 60% at 50% -20%, var(--accent-soft), transparent 70%)`
    : '';
  document.body.style.backgroundSize = bgState.url ? 'cover' : '';
  document.body.style.backgroundPosition = bgState.url ? 'center' : '';
  document.body.style.backgroundAttachment = bgState.url ? 'fixed' : '';
}
function saveBgPrefs() { try { localStorage.setItem(BG_KEY, JSON.stringify(bgState)); } catch {} }

/* ---------- MCP ---------- */
function loadMcp() {
  let servers = [];
  try { servers = JSON.parse(localStorage.getItem(MCP_KEY) || '[]'); } catch {}
  renderMcp(servers);
}
function saveMcp(servers) { try { localStorage.setItem(MCP_KEY, JSON.stringify(servers)); } catch {}; renderMcp(servers); }
function renderMcp(servers) {
  const list = $('#mcpList');
  if (!list) return;
  if (!servers.length) { list.innerHTML = '<div style="font-size:12.5px;color:var(--text-faint);padding:4px 0;">No MCP servers configured.</div>'; return; }
  list.innerHTML = servers.map((s, i) => `
    <div class="mcp-item">
      <div class="mcp-item-status ${s.enabled ? 'on' : ''}"></div>
      <div class="mcp-item-info">
        <div class="mcp-item-name">${escapeHtml(s.name || 'Unnamed')}</div>
        <div class="mcp-item-url">${escapeHtml(s.url || '')}</div>
      </div>
      <button class="icon-btn mcp-toggle" data-idx="${i}"><i class="ri-${s.enabled ? 'pause-circle-line' : 'play-circle-line'}"></i></button>
      <button class="icon-btn mcp-remove" data-idx="${i}"><i class="ri-delete-bin-line"></i></button>
    </div>`).join('');
}

/* ---------- Markdown ---------- */
function renderMarkdown(text) {
  if (!text) return '';
  const src = String(text);
  const parts = [];
  const fenceRe = /```([a-zA-Z0-9+#._-]*)\n?([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = fenceRe.exec(src)) !== null) {
    if (m.index > last) parts.push({ type: 'text', content: src.slice(last, m.index) });
    parts.push({ type: 'code', lang: (m[1] || '').trim(), content: m[2] });
    last = fenceRe.lastIndex;
  }
  if (last < src.length) parts.push({ type: 'text', content: src.slice(last) });
  return parts.map(p => p.type === 'code' ? renderCodeBlock(p.lang, p.content) : renderTextBlock(p.content)).join('');
}
function renderCodeBlock(lang, code) {
  const label = (lang || 'Code').toUpperCase();
  const cls = 'language-' + (lang || '').toLowerCase();
  const raw = String(code || '').replace(/\n$/, '');
  const lines = raw.split('\n');
  const codeHtml = lines.map(l => escapeHtml(l)).join('\n');
  let gutter = '';
  if (userSettings.lineNumbers) {
    let g = ''; for (let i = 1; i <= lines.length; i++) g += i + '\n';
    gutter = `<div class="code-gutter">${g}</div>`;
  }
  return `<div class="code-block">
    <div class="code-block-header"><span>${escapeHtml(label)}</span>
      <button class="code-action-btn" data-copy><i class="ri-file-copy-line"></i> Copy</button>
    </div>
    <div class="code-block-body">${gutter}<pre><code class="${cls}">${codeHtml}</code></pre></div>
  </div>`;
}
function renderTextBlock(text) {
  const lines = String(text).split('\n');
  let out = '', buf = [];
  const flush = () => { if (buf.length) { out += `<p>${inlineFmt(buf.join(' ').trim())}</p>`; buf = []; } };
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) { flush(); continue; }
    const hm = t.match(/^(#{1,4})\s+(.+)$/);
    if (hm) { flush(); out += `<h${Math.min(4, hm[1].length)}>${inlineFmt(hm[2])}</h${Math.min(4, hm[1].length)}>`; continue; }
    const um = t.match(/^[-*+]\s+(.+)$/);
    if (um) { flush(); out += `<li>${inlineFmt(um[1])}</li>`; continue; }
    buf.push(t);
  }
  flush();
  return out;
}
function inlineFmt(t) {
  const codes = [];
  t = String(t).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0001${codes.length - 1}\u0001`; });
  t = escapeHtml(t);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/\u0001(\d+)\u0001/g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  return t;
}
function renderBubble(bubble, text) {
  if (!bubble) return;
  bubble.classList.remove('thinking');
  if (!userSettings.highlightOn) { bubble.textContent = text || ''; return; }
  bubble.innerHTML = renderMarkdown(text || '');
  highlightCode(bubble);
  wireCodeButtons(bubble);
}
function highlightCode(scope) {
  if (!window.hljs) return;
  (scope || document).querySelectorAll('.code-block pre code').forEach(el => {
    if (el.dataset.hl) return;
    const raw = el.textContent || '';
    try {
      const m = (el.className || '').match(/language-([a-z0-9+#-]+)/i);
      const r = (m && window.hljs.getLanguage(m[1]))
        ? window.hljs.highlight(raw, { language: m[1], ignoreIllegals: true })
        : window.hljs.highlightAuto(raw);
      el.innerHTML = r.value; el.classList.add('hljs');
    } catch {}
    el.dataset.hl = '1';
  });
}
function wireCodeButtons(scope) {
  (scope || document).querySelectorAll('.code-block .code-action-btn[data-copy]').forEach(btn => {
    if (btn.__wired) return;
    btn.__wired = true;
    btn.addEventListener('click', async e => {
      e.preventDefault(); e.stopPropagation();
      const text = btn.closest('.code-block')?.querySelector('pre code')?.textContent || '';
      try {
        if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
        else { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.top = '-1000px'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
        btn.innerHTML = '<i class="ri-check-line"></i> Copied';
        setTimeout(() => { btn.innerHTML = '<i class="ri-file-copy-line"></i> Copy'; }, 1400);
      } catch {}
    });
  });
}

/* ---------- Conversations ---------- */
function currentConvo() { return __conversations.find(c => c.id === currentConversationId) || null; }
function saveChatsToLS() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(__conversations)); } catch {}
  if (__user) saveToFirebase(`chats/${__user.email}/conversations`, __conversations);
}
function loadChatsFromLS() { try { __conversations = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { __conversations = []; } }
async function loadChatsFromFirebase() {
  if (!__user) return;
  const data = await readFromFirebase(`chats/${__user.email}/conversations`);
  if (Array.isArray(data) && data.length) { __conversations = data; saveChatsToLS(); renderHistory(); }
}
function getWelcomeHTML() {
  return `<div class="welcome-screen">
    <img src="/logo.png" alt="MiroxAI" class="welcome-logo theme-aware-logo">
    <h1 class="welcome-title">Hi, I'm Mirox</h1>
    <p class="welcome-sub">Built by the OpenSurr team. Ask anything, attach images or files, or start a voice call.</p>
    <div class="suggestion-grid">
      <button class="suggestion-card" data-prompt="What would you like to talk about?"><i class="ri-chat-3-line"></i><span>What would you like to talk about?</span></button>
      <button class="suggestion-card" data-prompt="Help me write code"><i class="ri-code-line"></i><span>Help me write code</span></button>
      <button class="suggestion-card" data-prompt="Explain a concept simply"><i class="ri-lightbulb-line"></i><span>Explain a concept simply</span></button>
      <button class="suggestion-card" data-prompt="Generate an image"><i class="ri-image-line"></i><span>Generate an image</span></button>
    </div>
    <p class="welcome-disclaimer">Mirox can make mistakes. Made by the OpenSurr team.</p>
  </div>`;
}
function startNewChat() {
  currentConversationId = null;
  $('#chatTitle').textContent = 'New chat';
  $('#chatMessages').innerHTML = getWelcomeHTML();
  bindSuggestionClicks();
  renderHistory();
}
function bindSuggestionClicks() {
  $$('.suggestion-card').forEach(card => {
    if (card.__wired) return;
    card.__wired = true;
    card.onclick = () => {
      const prompt = card.dataset.prompt;
      if (prompt && $('#messageInput')) {
        $('#messageInput').value = prompt;
        $('#messageInput').dispatchEvent(new Event('input'));
        handleSend();
      }
    };
  });
}
function openConversationLS(id) {
  const c = __conversations.find(x => x.id === id);
  if (!c) return;
  currentConversationId = id;
  $('#chatTitle').textContent = c.title || 'Chat';
  const container = $('#chatMessages');
  container.innerHTML = '';
  for (const msg of c.messages || []) addMessageToDOM(msg.role, msg.content, msg.ts, false, msg.attachments || []);
  renderHistory();
  scrollToBottom();
}
function renderHistory() {
  const list = $('#historyList');
  if (!list) return;
  if (!__conversations.length) { list.innerHTML = '<li class="history-empty">No conversations yet</li>'; return; }
  list.innerHTML = __conversations.map(c => `
    <li class="history-item${c.id === currentConversationId ? ' active' : ''}" data-id="${c.id}">
      <i class="ri-chat-3-line"></i>
      <span class="history-title">${escapeHtml(c.title || 'Chat')}</span>
      <button class="history-delete icon-btn"><i class="ri-delete-bin-line"></i></button>
    </li>`).join('');
}
function scrollToBottom() { const c = $('#chatMessages'); if (c) c.scrollTop = c.scrollHeight; }

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B','KB','MB','GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function addMessageToDOM(role, content, ts, animate = true, attachments = []) {
  const container = $('#chatMessages');
  if (!container) return null;
  const welcome = container.querySelector('.welcome-screen');
  if (welcome) welcome.remove();
  const msgEl = document.createElement('div');
  msgEl.className = `message ${role === 'user' ? 'user' : 'ai'}`;
  const avatar = role === 'user' ? '<i class="ri-user-line"></i>' : '<i class="ri-sparkling-2-fill"></i>';
  msgEl.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div class="message-content">
      <div class="bubble"></div>
      <div class="message-time">${ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</div>
    </div>`;
  container.appendChild(msgEl);
  const bubble = msgEl.querySelector('.bubble');

  if (role === 'user') {
    if (content) {
      const textEl = document.createElement('div');
      textEl.className = 'message-user-text';
      textEl.textContent = content;
      bubble.appendChild(textEl);
    }
    if (Array.isArray(attachments) && attachments.length) {
      const wrap = document.createElement('div');
      wrap.className = 'message-attachments';
      attachments.forEach(file => {
        if (file?.type === 'image' && file.dataUrl) {
          const card = document.createElement('button');
          card.type = 'button';
          card.className = 'message-image-attachment';
          card.title = file.name || 'Attached image';
          card.innerHTML = `<img src="${file.dataUrl}" alt="${escapeHtml(file.name || 'Attached image')}"><span>${escapeHtml(file.name || 'Image')}</span>`;
          card.addEventListener('click', () => openImageLightbox?.(file.dataUrl));
          wrap.appendChild(card);
        } else if (file?.name) {
          const card = document.createElement('div');
          card.className = 'message-file-attachment';
          card.innerHTML = `<i class="ri-file-text-line"></i><div><strong>${escapeHtml(file.name)}</strong><small>${formatFileSize(file.size || 0)}</small></div>`;
          wrap.appendChild(card);
        }
      });
      bubble.appendChild(wrap);
    }
  } else renderBubble(bubble, content);
  if (animate) scrollToBottom();
  return msgEl;
}

function addThinkingBubble() {
  const container = $('#chatMessages');
  if (!container) return null;
  const welcome = container.querySelector('.welcome-screen');
  if (welcome) welcome.remove();
  const msgEl = document.createElement('div');
  msgEl.className = 'message ai thinking-message';
  msgEl.innerHTML = `
    <div class="message-avatar thinking-avatar"><i class="ri-sparkling-2-fill"></i></div>
    <div class="message-content">
      <div class="bubble thinking">
        <div class="thinking-orb" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
        <div class="thinking-copy"><span class="thinking-label">Thinking</span><span class="thinking-dots">···</span></div>
      </div>
      <div class="message-time"></div>
    </div>`;
  container.appendChild(msgEl);
  scrollToBottom();
  return msgEl;
}

/* ---------- Send ---------- */
function handleSend() {
  if (isReplying) return;
  const inp = $('#messageInput');
  if (!inp) return;
  const text = inp.value.trim();
  if (!text && !pendingFiles.length) return;

  const attachments = pendingFiles.map(f => ({ ...f }));
  if (!currentConversationId) {
    currentConversationId = uid();
    __conversations.unshift({ id: currentConversationId, title: text.slice(0, 60) || (attachments[0]?.name || 'New chat'), messages: [], created: Date.now() });
  }
  const convo = currentConvo();
  const nowTs = Date.now();
  if (convo) { convo.messages.push({ role: 'user', content: text, attachments, ts: nowTs }); convo.updated = nowTs; }

  addMessageToDOM('user', text, nowTs, true, attachments);
  inp.value = ''; inp.style.height = 'auto';
  $('#sendBtn').disabled = true;
  pendingFiles = [];
  updatePreview();
  saveChatsToLS();
  renderHistory();
  sendToAPI(text, attachments);
}

async function sendToAPI(text, attachments = []) {
  isReplying = true;
  const sendBtn = $('#sendBtn'), stopBtn = $('#stopBtn');
  if (sendBtn) sendBtn.disabled = true;
  if (stopBtn) stopBtn.style.display = 'grid';

  const convo = currentConvo();
  const history = convo ? convo.messages.slice(0, -1).slice(-14) : [];
  const model = __model || 'mirox-luna-1.2';
  const msgEl = addThinkingBubble();
  const bubble = msgEl.querySelector('.bubble');
  const timeEl = msgEl.querySelector('.message-time');
  activeStreamController = new AbortController();

  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        history: history.map(m => ({ role: m.role, content: m.content })),
        model,
        stream: true,
        files: attachments,
      }),
      signal: activeStreamController.signal,
    });
    if (!res.ok) {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      let errMsg = `HTTP ${res.status}`;
      if (ct.includes('application/json')) {
        const err = await res.json().catch(() => ({}));
        errMsg = err.error || errMsg;
      } else {
        const txt = await res.text().catch(() => '');
        if (txt) errMsg = txt.slice(0, 300);
      }
      throw new Error(errMsg);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '', firstChunk = true;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const pl = line.slice(5).trim();
        if (!pl || pl === '[DONE]') continue;
        const o = JSON.parse(pl);
        if (o.error) throw new Error(typeof o.error === 'string' ? o.error : (o.error.message || 'MiroxAI encountered an error.'));
        const deltaText = typeof o.choices?.[0]?.delta?.content === 'string' ? o.choices[0].delta.content : (typeof o.d === 'string' ? o.d : '');
        if (deltaText) {
          full += deltaText;
          if (firstChunk) { bubble.classList.remove('thinking'); bubble.innerHTML = ''; firstChunk = false; }
          renderBubble(bubble, full);
          scrollToBottom();
        }
        if (typeof o.daily_used === 'number' && __user) __user.daily_used = o.daily_used;
      }
    }
    if (convo) { convo.messages.push({ role: 'assistant', content: full, ts: Date.now() }); convo.updated = Date.now(); }
    saveChatsToLS();
    if (__user) pushToFirebase(`logs/chat/${__user.email}`, { model, message: text.slice(0, 500), reply: full.slice(0, 1000), ts: Date.now(), device: getDeviceId() });
    if (timeEl) timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    if (e.name !== 'AbortError') {
      bubble.classList.remove('thinking');
      bubble.textContent = `Sorry, something went wrong: ${e.message}`;
      if (timeEl) timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
      bubble.classList.remove('thinking');
      if (!bubble.textContent) bubble.textContent = '(stopped)';
    }
  } finally {
    isReplying = false;
    activeStreamController = null;
    if (sendBtn) sendBtn.disabled = !$('#messageInput')?.value.trim();
    if (stopBtn) stopBtn.style.display = 'none';
  }
}

function stopStreaming() {
  if (activeStreamController) { try { activeStreamController.abort(); } catch {} activeStreamController = null; }
  isReplying = false;
  const sb = $('#sendBtn'); if (sb) sb.disabled = !($('#messageInput')?.value.trim());
  const st = $('#stopBtn'); if (st) st.style.display = 'none';
}

/* ---------- Files ---------- */
async function fileToAttachment(file) {
  const MAX_FILE = 8 * 1024 * 1024;
  if (file.size > MAX_FILE) throw new Error(`${file.name} is larger than 8 MB.`);
  const isImg = (file.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(file.name);
  if (isImg) {
    const buffer = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    const base64 = btoa(binary);
    const mime = file.type || 'image/png';
    return { name: file.name, size: file.size, type: 'image', mime, encoding: 'base64', data: base64, dataUrl: `data:${mime};base64,${base64}` };
  }
  const content = String(await file.text()).slice(0, 60000);
  return { name: file.name, size: file.size, type: 'text', mime: file.type || 'text/plain', encoding: 'utf-8', content };
}

async function handleFiles(files) {
  if (!files?.length) return;
  const newFiles = [];
  for (const file of Array.from(files)) {
    try { newFiles.push(await fileToAttachment(file)); }
    catch (e) { alert(e.message || `Could not attach ${file.name}.`); }
  }
  pendingFiles = pendingFiles.concat(newFiles);
  updatePreview();
}
function updatePreview() {
  const p = $('#attachmentPreview'), list = $('#attachmentList');
  if (!p || !list) return;
  if (!pendingFiles.length) { p.style.display = 'none'; list.innerHTML = ''; return; }
  p.style.display = 'flex';
  list.innerHTML = '';
  pendingFiles.forEach((f, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    if (f.type === 'image' && f.dataUrl) chip.innerHTML = `<img src="${f.dataUrl}" alt=""><span>${escapeHtml(f.name)}</span>`;
    else chip.innerHTML = `<i class="ri-file-text-line"></i><span>${escapeHtml(f.name)}</span>`;
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'attach-chip-remove'; remove.innerHTML = '<i class="ri-close-line"></i>';
    remove.onclick = () => { pendingFiles.splice(i, 1); updatePreview(); };
    chip.appendChild(remove); list.appendChild(chip);
  });
}

/* ============================================================
   MODEL PICKER — FIXED
   - Uses wrapper #modelPicker for outside-click detection
   - Direct onclick handlers on each option
   - Default = models[0] (Luna)
   ============================================================ */
function getModelsList() {
  if (__config?.models?.length) return __config.models;
  return FALLBACK_MODELS;
}

function renderModelPicker() {
  const menu = $('#modelPickerMenu');
  if (!menu) return;

  const models = getModelsList();
  const currentId = __model || models[0].id;

  menu.innerHTML = models.map(m => `
    <div class="model-option${m.id === currentId ? ' active' : ''}" data-model-id="${m.id}">
      <span class="model-option-label"><span class="dot"></span>${escapeHtml(m.label)}</span>
      <span class="model-option-tag">${escapeHtml(m.tagline || '')}</span>
    </div>`).join('');

  menu.querySelectorAll('.model-option').forEach(opt => {
    opt.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectModel(opt.dataset.modelId);
    };
  });

  const current = models.find(m => m.id === currentId) || models[0];
  if (current && $('#currentModelLabel')) $('#currentModelLabel').textContent = current.label;
}

function selectModel(id) {
  if (!id) return;
  __model = id;
  const models = getModelsList();
  const m = models.find(x => x.id === id);
  if (m && $('#currentModelLabel')) $('#currentModelLabel').textContent = m.label;
  renderModelPicker();
  closeModelPicker();
}

function openModelPicker() {
  const wrap = $('#modelPicker');
  const menu = $('#modelPickerMenu');
  if (!wrap || !menu) return;
  wrap.classList.add('open');
  menu.classList.add('open');
}

function closeModelPicker() {
  const wrap = $('#modelPicker');
  const menu = $('#modelPickerMenu');
  if (!wrap || !menu) return;
  wrap.classList.remove('open');
  menu.classList.remove('open');
}

function wireModelPicker() {
  const btn = $('#modelPickerBtn');
  const wrap = $('#modelPicker');
  const menu = $('#modelPickerMenu');
  if (!btn || !wrap || !menu) return;

  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (menu.classList.contains('open')) closeModelPicker();
    else openModelPicker();
  };

  /* Close when clicking anywhere outside the wrapper */
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#modelPicker')) {
      closeModelPicker();
    }
  }, true);

  /* Close on escape */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModelPicker();
  });
}

/* ---------- Auth ---------- */
async function doLogin() {
  const name = $('#loginName')?.value.trim();
  const email = $('#loginEmail')?.value.trim().toLowerCase();
  if (!name || !email) return;
  const res = await authJson('/api/auth/simple-login', { method: 'POST', body: JSON.stringify({ name, email }) }, null);
  if (res?.ok && res.token) {
    setToken(res.token);
    __user = res.user;
    closeModal('loginModal');
    updateUserUI();
    updateFirebase(`users/${email}`, { email, name, tier: res.user.tier || 'free', last_login: Date.now() });
    pushToFirebase(`logs/user/${email}`, { event: 'signin', name, ts: Date.now(), device: getDeviceId() });
    loadChatsFromFirebase();
  } else {
    alert(res?.error || 'Login failed');
  }
}
async function doLogout() {
  const email = __user?.email;
  await authJson('/api/logout', { method: 'POST' }, null);
  setToken('');
  __user = null; __tier = 'free';
  if (email) pushToFirebase(`logs/user/${email}`, { event: 'signout', ts: Date.now(), device: getDeviceId() });
  updateUserUI();
  closeModal('settingsModal');
}
function updateUserUI() {
  const chip = $('#userChip');
  if (!chip) return;
  if (__user) {
    chip.querySelector('.user-name').textContent = __user.name || __user.email;
    chip.querySelector('.user-sub').textContent = `${(__tier || 'free').charAt(0).toUpperCase() + (__tier || 'free').slice(1)} plan`;
  } else {
    chip.querySelector('.user-name').textContent = 'Guest mode';
    chip.querySelector('.user-sub').textContent = 'Sign in to save chats';
  }
}
async function loadUser() {
  const res = await authJson('/api/me', {}, null);
  if (res?.user) {
    __user = res.user;
    __tier = res.user.tier || 'free';
    const fbUser = await readFromFirebase(`users/${res.user.email}`);
    if (fbUser) { __user = { ...__user, ...fbUser }; __tier = fbUser.tier || 'free'; }
    updateUserUI();
    loadChatsFromFirebase();
  } else {
    __tier = 'free';
    updateUserUI();
    loadChatsFromLS();
  }
}

/* ---------- Config — DEFAULT = FIRST MODEL ---------- */
async function loadConfig() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    const data = await res.json();
    if (data?.models?.length) __config = data;
    else __config = { models: FALLBACK_MODELS };
  } catch {
    __config = { models: FALLBACK_MODELS };
  }

  const models = getModelsList();
  /* FIRST model is the default */
  const def = models[0];
  __model = def.id;

  renderModelPicker();
  if ($('#currentModelLabel')) $('#currentModelLabel').textContent = def.label;
}

/* ---------- Plans ---------- */
async function loadPlans() {
  const grid = $('#plansGrid');
  if (!grid) return;
  const res = await authJson('/api/subscription/plans', {}, null);
  if (!res?.plans) return;
  grid.innerHTML = res.plans.map(p => `
    <div class="plan-card${p.id === __tier ? ' current' : ''}">
      <div class="plan-name">${escapeHtml(p.label)}</div>
      <div class="plan-price">${p.price_robux ? p.price_robux + ' Robux' : 'Free'}</div>
      <ul class="plan-perks">${(p.perks || []).map(x => `<li><i class="ri-check-line"></i> ${escapeHtml(x)}</li>`).join('')}</ul>
    </div>`).join('');
}
async function loadUserKeys() {
  const list = $('#apiKeysList');
  if (!list) return;
  const res = await authJson('/api/keys/list', {}, null);
  if (!res?.keys?.length) { list.innerHTML = '<div style="font-size:13px;color:var(--text-faint);">No API keys yet.</div>'; return; }
  list.innerHTML = res.keys.map(k => `<div class="api-key-item"><i class="ri-key-line"></i><span class="key-prefix">${escapeHtml(k.prefix)}…</span></div>`).join('');
}
async function genKey() {
  const res = await authJson('/api/keys/generate', { method: 'POST' }, null);
  if (res?.ok && res.key) { alert('API Key (save this):\n\n' + res.key); loadUserKeys(); }
  else alert(res?.error || 'Failed');
}

/* ---------- Image ---------- */
function loadSavedImages() {
  try {
    const raw = JSON.parse(localStorage.getItem(IMAGE_STORE_KEY) || '[]');
    savedImages = Array.isArray(raw) ? raw.filter(x => x && x.src).slice(0, 6) : [];
  } catch { savedImages = []; }
  renderSavedImages();
}
function persistSavedImages() {
  try {
    // Keep the gallery compact so large base64 images cannot fill localStorage.
    localStorage.setItem(IMAGE_STORE_KEY, JSON.stringify(savedImages.slice(0, 6)));
  } catch {
    // If storage is full, keep only the newest two.
    try { savedImages = savedImages.slice(0, 2); localStorage.setItem(IMAGE_STORE_KEY, JSON.stringify(savedImages)); } catch {}
  }
}
function addSavedImage(src, prompt, aspect) {
  if (!src) return;
  const item = {
    id: uid(),
    src,
    prompt: String(prompt || '').slice(0, 1000),
    aspect: aspect || '1:1',
    created: Date.now()
  };
  savedImages = [item, ...savedImages.filter(x => x.src !== src)].slice(0, 6);
  persistSavedImages();
  renderSavedImages();
  return item;
}
function removeSavedImage(id) {
  savedImages = savedImages.filter(x => x.id !== id);
  persistSavedImages();
  renderSavedImages();
  if (currentGeneratedImage?.id === id) currentGeneratedImage = null;
}
function clearSavedImages() {
  savedImages = [];
  persistSavedImages();
  renderSavedImages();
}
async function downloadImage(src, prompt = 'mirox-image') {
  if (!src) return;
  const safeName = (String(prompt || 'mirox-image').trim().replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'mirox-image') + '.png';
  try {
    if (!src.startsWith('data:')) {
      const r = await fetch(src, { mode: 'cors' });
      if (r.ok) {
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = safeName; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }
    }
  } catch {}
  const a = document.createElement('a');
  a.href = src; a.download = safeName; a.target = '_blank'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}
function openImageLightbox(src) {
  const lb = $('#lightbox');
  const img = lb?.querySelector('img');
  if (!lb || !img || !src) return;
  $$('.saved-image-card').forEach(card => card.classList.toggle('selected', card.querySelector('img')?.src === src));
  img.src = src;
  lb.classList.add('open');
}
function renderImageResult(item) {
  const result = $('#imageResult');
  if (!result) return;
  currentGeneratedImage = item;
  result.innerHTML = `
    <div class="generated-image-card ${item?.id ? 'selected' : ''}">
      <button class="generated-image-preview" data-image-open="${escapeHtml(item.src)}" type="button" aria-label="Open generated image">
        <img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.prompt)}" loading="eager">
      </button>
      <div class="generated-image-footer">
        <div class="generated-image-meta"><span>${escapeHtml(item.aspect || '1:1')}</span><span>Saved</span></div>
        <div class="image-actions">
          <button class="image-action-btn" data-image-download="${escapeHtml(item.src)}" data-image-name="${escapeHtml(item.prompt)}" title="Download" aria-label="Download image"><i class="ri-download-2-line"></i></button>
          <button class="image-action-btn" data-image-regenerate="${escapeHtml(item.id)}" title="Regenerate" aria-label="Regenerate image"><i class="ri-refresh-line"></i></button>
          <button class="image-action-btn danger" data-image-delete="${escapeHtml(item.id)}" title="Delete" aria-label="Delete image"><i class="ri-delete-bin-6-line"></i></button>
        </div>
      </div>
    </div>`;
}
function renderSavedImages() {
  const grid = $('#savedImagesGrid');
  if (!grid) return;
  if (!savedImages.length) {
    grid.innerHTML = `<div class="saved-images-empty"><i class="ri-image-line"></i><span>No saved images yet.</span><small>Generated images will appear here automatically.</small></div>`;
    return;
  }
  grid.innerHTML = savedImages.map(item => `
    <article class="saved-image-card" data-image-id="${escapeHtml(item.id)}">
      <button class="saved-image-preview" data-image-open="${escapeHtml(item.src)}" type="button" aria-label="Open saved image">
        <img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.prompt)}" loading="lazy">
        <span class="saved-image-overlay"><i class="ri-fullscreen-line"></i></span>
      </button>
      <div class="saved-image-info">
        <span class="saved-image-prompt">${escapeHtml(item.prompt || 'Generated image')}</span>
        <span class="saved-image-aspect">${escapeHtml(item.aspect || '1:1')}</span>
      </div>
      <div class="saved-image-actions">
        <button class="image-action-btn" data-image-download="${escapeHtml(item.src)}" data-image-name="${escapeHtml(item.prompt)}" title="Download" aria-label="Download image"><i class="ri-download-2-line"></i></button>
        <button class="image-action-btn" data-image-regenerate="${escapeHtml(item.id)}" title="Regenerate" aria-label="Regenerate image"><i class="ri-refresh-line"></i></button>
        <button class="image-action-btn danger" data-image-delete="${escapeHtml(item.id)}" title="Delete" aria-label="Delete image"><i class="ri-delete-bin-6-line"></i></button>
      </div>
    </article>`).join('');
}
function setImageGenerating(active) {
  const btn = $('#generateImageBtn');
  if (!btn) return;
  btn.disabled = active;
  btn.classList.toggle('is-generating', active);
  btn.innerHTML = active
    ? '<i class="ri-loader-4-line"></i><span>Generating…</span>'
    : '<i class="ri-image-add-line"></i><span>Generate</span>';
}
async function genImage(promptOverride = null, aspectOverride = null) {
  const prompt = String(promptOverride ?? $('#imagePrompt')?.value ?? '').trim();
  const aspect = aspectOverride || $('#imageAspect')?.value || '1:1';
  if (!prompt) return alert('Please describe the image.');
  if ($('#imagePrompt')) $('#imagePrompt').value = prompt;
  if ($('#imageAspect')) $('#imageAspect').value = aspect;
  const result = $('#imageResult');
  setImageGenerating(true);
  if (result) result.innerHTML = `
    <div class="image-generating-card">
      <div class="image-thinking-orb"><span></span><span></span><span></span></div>
      <div><strong>Creating your image</strong><small>Preparing the generation…</small></div>
    </div>`;
  try {
    const res = await authJson('/v1/images/generations', {
      method: 'POST',
      body: JSON.stringify({ prompt, aspect_ratio: aspect })
    }, null);
    if (res?.ok && res.image) {
      const item = addSavedImage(res.image, prompt, aspect);
      if (item) renderImageResult(item);
      if (__user) pushToFirebase(`logs/image/${__user.email}`, { prompt: prompt.slice(0, 300), model: 'Lumenal 1.0', aspect, ts: Date.now(), device: getDeviceId() });
    } else {
      if (result) result.innerHTML = `<div class="image-error-card"><i class="ri-error-warning-line"></i><span>${escapeHtml(typeof res?.error === 'object' ? (res.error.message || 'Image generation failed.') : (res?.error || 'Image generation failed.'))}</span></div>`;
    }
  } catch (e) {
    if (result) result.innerHTML = `<div class="image-error-card"><i class="ri-error-warning-line"></i><span>${escapeHtml(e.message || 'Image generation failed.')}</span></div>`;
  } finally {
    setImageGenerating(false);
  }
}
function regenerateSavedImage(id) {
  const item = savedImages.find(x => x.id === id);
  if (!item) return;
  genImage(item.prompt, item.aspect);
}

/* ---------- Voice ---------- */
function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return alert('Speech recognition not supported.');
  recognition = new SR();
  recognition.lang = userSettings.language || 'en-US';
  recognition.interimResults = false; recognition.continuous = false;
  const micBtn = $('#micBtn');
  micBtn?.classList.add('active');
  recognition.onresult = e => {
    const text = e.results[0][0].transcript;
    if ($('#messageInput')) { $('#messageInput').value = text; $('#messageInput').dispatchEvent(new Event('input')); }
    micBtn?.classList.remove('active');
    handleSend();
  };
  recognition.onerror = () => micBtn?.classList.remove('active');
  recognition.onend = () => micBtn?.classList.remove('active');
  recognition.start();
}
function startCall() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) return alert('Speech recognition not supported in this browser.');
  callActive = true;
  callMuted = false;
  $('#callOverlay')?.classList.add('open');
  if ($('#callTranscript')) $('#callTranscript').textContent = 'Listening…';
  startCallRecognition();
}

async function processCallSpeech(text) {
  if (!callActive || callMuted || !text?.trim()) return;
  const clean = text.trim();
  if ($('#callTranscript')) $('#callTranscript').textContent = 'You: ' + clean;
  try { callRecognition?.stop(); } catch {}
  try { synth?.cancel(); } catch {}
  if ($('#callTranscript')) $('#callTranscript').textContent = 'You: ' + clean + '\n\nMirox is thinking…';
  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: clean, history: [], model: __model || 'mirox-luna-1.2', stream: false })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const reply = String(data.reply || data.choices?.[0]?.message?.content || '').trim();
    if (!reply) throw new Error('Empty AI response.');
    if ($('#callTranscript')) $('#callTranscript').textContent = 'You: ' + clean + '\n\nMirox: ' + reply;
    await speakText(reply);
  } catch (e) {
    if ($('#callTranscript')) $('#callTranscript').textContent = `Call error: ${e.message}`;
  } finally {
    if (callActive) setTimeout(startCallRecognition, 300);
  }
}

function startCallRecognition() {
  if (!callActive) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  try { callRecognition?.stop(); } catch {}
  callRecognition = new SR();
  callRecognition.lang = userSettings.language || 'en-US';
  callRecognition.continuous = false;
  callRecognition.interimResults = false;
  callRecognition.onresult = e => {
    if (callMuted) return;
    const text = e.results[e.results.length - 1][0].transcript;
    processCallSpeech(text);
  };
  callRecognition.onerror = e => {
    if (callActive && e?.error !== 'aborted') setTimeout(startCallRecognition, 500);
  };
  callRecognition.onend = () => {
    /* processCallSpeech() restarts recognition after browser TTS finishes. */
  };
  try { callRecognition.start(); } catch { setTimeout(startCallRecognition, 500); }
}

function endCall() {
  callActive = false;
  try { callRecognition?.stop(); } catch {}
  try { synth?.cancel(); } catch {}
  callRecognition = null;
  $('#callOverlay')?.classList.remove('open');
}
function toggleMute() {
  callMuted = !callMuted;
  const b = $('#callMuteBtn');
  if (b) b.innerHTML = callMuted ? '<i class="ri-mic-off-line"></i>' : '<i class="ri-mic-line"></i>';
  if (callMuted) { try { callRecognition?.stop(); } catch {} }
  else if (callActive) startCallRecognition();
}
function speakText(t) {
  return new Promise(resolve => {
    if (!synth || !t) return resolve();
    synth.cancel();
    const u = new SpeechSynthesisUtterance(String(t));
    u.rate = userSettings.voiceRate || 1;
    u.pitch = 1;
    u.lang = userSettings.language || 'en-US';
    u.onend = resolve;
    u.onerror = resolve;
    synth.speak(u);
  });
}
async function requestMic() { try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); alert('Mic granted.'); } catch { alert('Denied.'); } }

/* ---------- Memory / Persona ---------- */
async function loadMemory() {
  const list = $('#memoryList'); if (!list || !__user) return;
  const res = await authJson('/api/memory', {}, null);
  if (res?.facts?.length) list.innerHTML = res.facts.map(f => `<div class="memory-item"><span>${escapeHtml(f.text)}</span></div>`).join('');
  else list.innerHTML = '<p style="font-size:13px;color:var(--text-faint);">No memories yet.</p>';
}
async function addMemory() {
  const input = $('#memoryInput'); if (!input?.value.trim()) return;
  await authJson('/api/memory', { method: 'POST', body: JSON.stringify({ fact: input.value.trim() }) });
  input.value = ''; loadMemory();
}
async function loadPersona() {
  if (!__user) return;
  const res = await authJson('/api/persona', {}, null);
  if (res?.persona && $('#personaInput')) $('#personaInput').value = res.persona;
}
async function savePersona() { await authJson('/api/persona', { method: 'POST', body: JSON.stringify({ persona: $('#personaInput')?.value.trim() || '' }) }); }

/* ---------- Support ---------- */
async function submitReport() {
  const category = $('#supportCategory')?.value;
  const subject = $('#supportSubject')?.value.trim();
  const message = $('#supportMessage')?.value.trim();
  if (!subject || !message) return alert('Please fill subject and message.');
  const res = await authJson('/api/support/ticket', { method: 'POST', body: JSON.stringify({ category, subject, message }) }, null);
  if (res?.ok) { alert('Ticket submitted!'); closeModal('supportModal'); }
  else alert(res?.error || 'Failed.');
}

/* ============================================================
   EVENT DELEGATION
   ============================================================ */
document.addEventListener('click', function(e) {
  const t = e.target;
  const closest = s => t.closest(s);

  const closer = closest('[data-close]');
  if (closer) { closeModal(closer.dataset.close); return; }
  if (t.classList.contains('modal-overlay')) { t.classList.remove('open'); return; }
  if (t.classList.contains('lightbox')) { t.classList.remove('open'); return; }

  if (closest('#hamburgerBtn')) { openSidebar(); return; }
  if (closest('#sidebarCloseBtn')) { closeSidebar(); return; }
  if (t.id === 'sidebarScrim') { closeSidebar(); return; }
  if (closest('#brandLogo') || closest('#newChatBtn')) { startNewChat(); if (window.innerWidth <= 860) closeSidebar(); return; }

  if (closest('#userChip')) { if (!__user) openModal('loginModal'); return; }
  if (closest('#upgradeBtn')) {
    if (!__user) openModal('loginModal');
    else { openModal('plansModal'); loadPlans(); loadUserKeys(); }
    return;
  }

  if (closest('#settingsBtn')) { openModal('settingsModal'); loadPersona(); loadMemory(); loadMcp(); return; }
  if (closest('#imageModeBtn')) { openModal('imageModal'); return; }
  if (closest('#backgroundModeBtn')) { openModal('backgroundModal'); return; }
  if (closest('#plansModeBtn')) { openModal('plansModal'); loadPlans(); loadUserKeys(); return; }
  if (closest('#supportModeBtn') || closest('#supportModeBtn2')) { openModal('supportModal'); return; }
  if (closest('#talkModeBtn')) { startCall(); return; }
  if (closest('#callEndBtn')) { endCall(); return; }
  if (closest('#callMuteBtn')) { toggleMute(); return; }
  if (closest('#stopBtn')) { stopStreaming(); return; }

  const tab = closest('.settings-tab');
  if (tab) {
    document.querySelectorAll('.settings-tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.settings-pane').forEach(x => x.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`.settings-pane[data-pane="${tab.dataset.tab}"]`)?.classList.add('active');
    if (tab.dataset.tab === 'mcp') loadMcp();
    return;
  }

  const mb = closest('[data-mode]'); if (mb && mb.closest('#modeOptions')) { applyAppearance({ mode: mb.dataset.mode }); return; }
  const sw = closest('.swatch'); if (sw?.dataset.theme) { applyAppearance({ theme: sw.dataset.theme }); return; }
  const cb = closest('[data-corner]'); if (cb && cb.closest('#cornerOptions')) { applyAppearance({ corner: cb.dataset.corner }); return; }

  const tg = closest('[data-toggle]');
  if (tg) {
    const k = tg.dataset.toggle;
    userSettings[k] = !userSettings[k];
    tg.textContent = userSettings[k] ? 'ON' : 'OFF';
    tg.classList.toggle('active', userSettings[k]);
    saveUserSettings();
    return;
  }

  if (closest('#attachBtn')) { $('#fileInput')?.click(); return; }
  if (closest('#removeAttachmentBtn')) { pendingFiles = []; updatePreview(); return; }
  if (closest('#searchToggleBtn')) { $('#searchToggleBtn').classList.toggle('active'); return; }
  if (closest('#micBtn')) { startMic(); return; }

  if (closest('#editTitleBtn')) {
    const cur = $('#chatTitle')?.textContent || '';
    const nxt = prompt('Rename chat', cur);
    if (nxt === null) return;
    const tr = nxt.trim(); if (!tr) return;
    $('#chatTitle').textContent = tr;
    const c = currentConvo(); if (c) { c.title = tr; saveChatsToLS(); renderHistory(); }
    return;
  }

  if (closest('#logoutBtn')) { doLogout(); return; }
  if (closest('#savePersonaBtn')) { savePersona(); return; }
  if (closest('#addMemoryBtn')) { addMemory(); return; }
  if (closest('#submitReportBtn')) { submitReport(); return; }
  if (closest('#generateKeyBtn')) { genKey(); return; }
  const imageOpen = closest('[data-image-open]');
  if (imageOpen) { openImageLightbox(imageOpen.dataset.imageOpen || ''); return; }
  const imageDownload = closest('[data-image-download]');
  if (imageDownload) { downloadImage(imageDownload.dataset.imageDownload || '', imageDownload.dataset.imageName || 'mirox-image'); return; }
  const imageDelete = closest('[data-image-delete]');
  if (imageDelete) { removeSavedImage(imageDelete.dataset.imageDelete || ''); if (currentGeneratedImage?.id === imageDelete.dataset.imageDelete) $('#imageResult').innerHTML = ''; return; }
  const imageRegen = closest('[data-image-regenerate]');
  if (imageRegen) { regenerateSavedImage(imageRegen.dataset.imageRegenerate || ''); return; }
  if (closest('#clearSavedImagesBtn')) { clearSavedImages(); return; }
  if (closest('#generateImageBtn')) { genImage(); return; }
  if (closest('#bgUploadZone')) { $('#bgFileInput')?.click(); return; }
  if (closest('#bgUrlApplyBtn')) { const u = $('#bgUrlInput')?.value.trim(); if (u) { bgState.url = u; saveBgPrefs(); applyBackground(); } return; }
  if (closest('#bgRemoveBtn')) { bgState.url = null; saveBgPrefs(); applyBackground(); if ($('#bgUrlInput')) $('#bgUrlInput').value = ''; return; }
  if (closest('#requestMicBtn')) { requestMic(); return; }

  if (closest('#addMcpBtn')) {
    const name = $('#mcpNameInput')?.value.trim();
    const url = $('#mcpUrlInput')?.value.trim();
    if (!name || !url) return alert('Name and URL required.');
    let servers = [];
    try { servers = JSON.parse(localStorage.getItem(MCP_KEY) || '[]'); } catch {}
    servers.push({ name, url, enabled: true, created: Date.now() });
    saveMcp(servers);
    if ($('#mcpNameInput')) $('#mcpNameInput').value = '';
    if ($('#mcpUrlInput')) $('#mcpUrlInput').value = '';
    return;
  }
  const mt = closest('.mcp-toggle');
  if (mt) {
    let servers = [];
    try { servers = JSON.parse(localStorage.getItem(MCP_KEY) || '[]'); } catch {}
    const i = +mt.dataset.idx;
    if (servers[i]) { servers[i].enabled = !servers[i].enabled; saveMcp(servers); }
    return;
  }
  const mr = closest('.mcp-remove');
  if (mr) {
    let servers = [];
    try { servers = JSON.parse(localStorage.getItem(MCP_KEY) || '[]'); } catch {}
    servers.splice(+mr.dataset.idx, 1);
    saveMcp(servers);
    return;
  }

  const hist = closest('.history-item');
  if (hist) {
    if (t.closest('.history-delete')) {
      const id = hist.dataset.id;
      __conversations = __conversations.filter(x => x.id !== id);
      if (currentConversationId === id) startNewChat();
      saveChatsToLS(); renderHistory();
      e.stopPropagation();
      return;
    }
    const id = hist.dataset.id;
    if (id) { stopStreaming(); openConversationLS(id); if (window.innerWidth <= 860) closeSidebar(); }
    return;
  }
});

document.addEventListener('submit', function(e) {
  e.preventDefault();
  if (e.target?.id === 'composerForm') handleSend();
  if (e.target?.id === 'simpleLoginForm') doLogin();
}, true);

document.addEventListener('input', function(e) {
  if (e.target?.id === 'messageInput') {
    const sb = $('#sendBtn');
    if (sb) sb.disabled = isReplying || !e.target.value.trim();
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px';
  }
  if (e.target?.id === 'bgDimInput') { bgState.dim = parseInt(e.target.value); const l = $('#bgDimLabel'); if (l) l.textContent = bgState.dim + '%'; applyBackground(); saveBgPrefs(); }
  if (e.target?.id === 'imagePrompt') { const c = $('#imagePromptCount'); if (c) c.textContent = String(e.target.value.length); }
});

document.addEventListener('change', function(e) {
  if (e.target?.id === 'fileInput') { handleFiles(e.target.files); e.target.value = ''; }
  if (e.target?.id === 'bgFileInput') {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { bgState.url = r.result; saveBgPrefs(); applyBackground(); };
    r.readAsDataURL(f); e.target.value = '';
  }
  if (e.target?.id === 'langSelect') { userSettings.language = e.target.value; saveUserSettings(); }
});

/* ---------- INIT ---------- */
async function init() {
  loadUserSettings();
  loadAppearance();
  loadBgPrefs();
  loadSavedImages();

  /* Wire picker FIRST — works even before config loads */
  wireModelPicker();
  renderModelPicker();

  await loadConfig();
  await loadUser();

  loadChatsFromLS();
  renderHistory();
  bindSuggestionClicks();
  updateUserUI();
  loadMcp();

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('#messageInput')?.focus(); }
  });
}

init();
