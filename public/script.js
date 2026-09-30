/* ============================================================
   MiroxAI — Frontend Script v14
   Fixed: plan persistence, username bug, Firebase sync,
   Eclipse credits, thinking animation, HF image gen
   ============================================================ */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getDatabase, ref, set, get, update, push, onValue, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

/* ---------- Firebase Config ---------- */
const FIREBASE_CONFIG = {
  databaseURL: 'https://miroxdata-default-rtdb.europe-west1.firebasedatabase.app/'
};

const firebaseApp = initializeApp(FIREBASE_CONFIG);
const db = getDatabase(firebaseApp);

/* ---------- Shortcuts ---------- */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

/* ---------- State ---------- */
let __config = null;
let __user = null;
let __tier = 'free';
let __model = null;
let currentConversationId = null;
let isReplying = false;
let __conversations = [];
let pendingFiles = [];
let bgState = { url: null, dim: 45, blur: 0 };
let recognition = null, callRecognition = null;
let synth = window.speechSynthesis;
let callActive = false, callMuted = false, micStream = null;
let callRestartTimer = null, callSpeakEndTimer = null;
let activeStreamController = null;
let supportPollTimer = null, currentTicketId = null;

/* ---------- localStorage keys ---------- */
const LS_KEY = 'miroxai_conversations_v2';
const TOKEN_KEY = 'mirox_token';
const USER_SETTINGS_KEY = 'miroxai_user_settings_v2';
const DEVICE_ID_KEY = 'mirox_device_id';

/* ---------- Safe JSON ---------- */
async function readJson(r, f = null) {
  if (!r) return f;
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) { try { await r.text(); } catch {} return f; }
  try { return await r.json(); } catch { return f; }
}

async function safeFetch(url, opts = {}) {
  try {
    const r = await fetch(url, opts);
    const data = await readJson(r, null);
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: null }; }
}

/* ---------- Auth helpers ---------- */
function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }

function authFetch(u, o = {}) {
  const h = { 'Content-Type': 'application/json', ...(o.headers || {}) };
  const t = getToken();
  if (t) h.Authorization = 'Bearer ' + t;
  return fetch(u, { ...o, headers: h, credentials: 'same-origin', cache: 'no-store' });
}

async function authJson(u, o = {}, f = null) {
  try { const r = await authFetch(u, o); return await readJson(r, f); } catch { return f; }
}

/* ---------- Utility ---------- */
function killLoader() {
  const l = document.getElementById('loadingScreen');
  if (l) { l.classList.add('hidden'); l.style.display = 'none'; }
}
killLoader(); setTimeout(killLoader, 400); setTimeout(killLoader, 1500);

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function uid() {
  return 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function fmtSize(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

function openModal(id) { const el = document.getElementById(id); if (el) el.classList.add('open'); }
function closeModal(id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); }

function openSidebar() {
  $('#sidebar')?.classList.add('open');
  $('#sidebarScrim')?.classList.add('open');
}
function closeSidebar() {
  $('#sidebar')?.classList.remove('open');
  $('#sidebarScrim')?.classList.remove('open');
}

function showLightbox(src) {
  const lb = $('#lightbox');
  if (!lb) return;
  lb.querySelector('img').src = src;
  lb.classList.add('open');
}

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) { id = 'dev_' + uid(); localStorage.setItem(DEVICE_ID_KEY, id); }
  return id;
}

/* ---------- Firebase Helpers ---------- */
async function saveToFirebase(path, data) {
  try { await set(ref(db, path), data); return true; }
  catch (e) { console.warn('Firebase save failed:', e); return false; }
}

async function updateFirebase(path, data) {
  try { await update(ref(db, path), data); return true; }
  catch (e) { console.warn('Firebase update failed:', e); return false; }
}

async function readFromFirebase(path) {
  try {
    const snap = await get(ref(db, path));
    return snap.exists() ? snap.val() : null;
  } catch { return null; }
}

async function pushToFirebase(path, data) {
  try {
    const r = push(ref(db, path));
    await set(r, { ...data, _ts: serverTimestamp() });
    return r.key;
  } catch (e) { console.warn('Firebase push failed:', e); return null; }
}

/* ---------- User Settings ---------- */
let userSettings = {
  temperature: 0.7,
  language: 'en-US',
  autoscroll: true,
  soundOn: true,
  notifOn: true,
  voiceRate: 1,
  voiceName: '',
  highlightOn: true,
  lineNumbers: false,
};

function loadUserSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(USER_SETTINGS_KEY) || '{}');
    userSettings = { ...userSettings, ...s };
  } catch {}
}

function saveUserSettings() {
  try { localStorage.setItem(USER_SETTINGS_KEY, JSON.stringify(userSettings)); } catch {}
  if (__user) {
    authJson('/api/settings/user', {
      method: 'POST',
      body: JSON.stringify({ settings: userSettings })
    }).catch(() => {});
    // Also save to Firebase
    updateFirebase(`users/${__user.email}/settings`, userSettings).catch(() => {});
  }
}

/* ---------- LANGUAGE META ---------- */
const LANG_META = {
  js: { label: 'JavaScript', cls: 'language-javascript' },
  javascript: { label: 'JavaScript', cls: 'language-javascript' },
  jsx: { label: 'JSX', cls: 'language-javascript' },
  ts: { label: 'TypeScript', cls: 'language-typescript' },
  typescript: { label: 'TypeScript', cls: 'language-typescript' },
  tsx: { label: 'TSX', cls: 'language-typescript' },
  py: { label: 'Python', cls: 'language-python' },
  python: { label: 'Python', cls: 'language-python' },
  c: { label: 'C', cls: 'language-c' },
  cpp: { label: 'C++', cls: 'language-cpp' },
  'c++': { label: 'C++', cls: 'language-cpp' },
  cs: { label: 'C#', cls: 'language-csharp' },
  csharp: { label: 'C#', cls: 'language-csharp' },
  java: { label: 'Java', cls: 'language-java' },
  lua: { label: 'Lua', cls: 'language-lua' },
  css: { label: 'CSS', cls: 'language-css' },
  scss: { label: 'SCSS', cls: 'language-scss' },
  html: { label: 'HTML', cls: 'language-xml' },
  xml: { label: 'XML', cls: 'language-xml' },
  svg: { label: 'SVG', cls: 'language-xml' },
  json: { label: 'JSON', cls: 'language-json' },
  yaml: { label: 'YAML', cls: 'language-yaml' },
  yml: { label: 'YAML', cls: 'language-yaml' },
  sh: { label: 'Shell', cls: 'language-bash' },
  bash: { label: 'Bash', cls: 'language-bash' },
  zsh: { label: 'Shell', cls: 'language-bash' },
  shell: { label: 'Shell', cls: 'language-bash' },
  sql: { label: 'SQL', cls: 'language-sql' },
  go: { label: 'Go', cls: 'language-go' },
  rust: { label: 'Rust', cls: 'language-rust' },
  rs: { label: 'Rust', cls: 'language-rust' },
  php: { label: 'PHP', cls: 'language-php' },
  rb: { label: 'Ruby', cls: 'language-ruby' },
  ruby: { label: 'Ruby', cls: 'language-ruby' },
  md: { label: 'Markdown', cls: 'language-markdown' },
  markdown: { label: 'Markdown', cls: 'language-markdown' },
  txt: { label: 'Text', cls: '' },
  plain: { label: 'Text', cls: '' },
};

function langInfo(l) {
  if (!l) return { label: 'Code', cls: '' };
  const k = l.toLowerCase().trim();
  return LANG_META[k] || { label: l.toUpperCase(), cls: 'language-' + k };
}

/* ---------- Markdown Renderer ---------- */
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

  let out = '';
  for (const p of parts) {
    if (p.type === 'code') {
      out += renderCodeBlock(p.lang, p.content, false);
    } else {
      out += renderTextBlock(p.content);
    }
  }
  return out;
}

function renderTextBlock(text) {
  const lines = String(text).split('\n');
  let out = '', paraBuf = [];
  const flushPara = () => {
    if (paraBuf.length) {
      const t = paraBuf.join(' ').trim();
      if (t) out += `<p>${inlineFmt(t)}</p>`;
      paraBuf = [];
    }
  };
  let listOpen = false, listType = null;
  const closeList = () => {
    if (listOpen) { out += listType === 'ol' ? '</ol>' : '</ul>'; listOpen = false; listType = null; }
  };
  for (const raw of lines) {
    const t = raw.replace(/\s+$/, '').trim();
    if (!t) { flushPara(); closeList(); continue; }
    const hm = t.match(/^(#{1,4})\s+(.+)$/);
    if (hm) { flushPara(); closeList(); const lvl = Math.min(4, hm[1].length); out += `<h${lvl}>${inlineFmt(hm[2])}</h${lvl}>`; continue; }
    if (t.startsWith('> ')) { flushPara(); closeList(); out += `<blockquote>${inlineFmt(t.slice(2))}</blockquote>`; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); closeList(); out += '<hr>'; continue; }
    const um = t.match(/^[-*+]\s+(.+)$/);
    if (um) {
      flushPara();
      if (!listOpen || listType !== 'ul') { closeList(); out += '<ul>'; listOpen = true; listType = 'ul'; }
      out += `<li>${inlineFmt(um[1])}</li>`;
      continue;
    }
    const om = t.match(/^(\d+)\.\s+(.+)$/);
    if (om) {
      flushPara();
      if (!listOpen || listType !== 'ol') { closeList(); out += '<ol>'; listOpen = true; listType = 'ol'; }
      out += `<li>${inlineFmt(om[2])}</li>`;
      continue;
    }
    closeList();
    paraBuf.push(t);
  }
  flushPara(); closeList();
  return out;
}

function inlineFmt(t) {
  const codes = [];
  t = String(t).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0001${codes.length - 1}\u0001`; });
  t = escapeHtml(t);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/\u0001(\d+)\u0001/g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  return t;
}

/* ---------- Code Block Renderer ---------- */
function renderCodeBlock(langRaw, code, streaming) {
  const info = langInfo(langRaw);
  const raw = String(code || '').replace(/\n$/, '');
  const lines = raw.split('\n');
  const codeHtml = lines.map(l => escapeHtml(l)).join('\n');
  const codeClass = info.cls || '';
  let gutterHtml = '';
  if (userSettings.lineNumbers) {
    let g = '';
    for (let i = 1; i <= lines.length; i++) g += `${i}\n`;
    gutterHtml = `<div class="code-gutter">${g}</div>`;
  }
  const cls = `code-block${userSettings.lineNumbers ? ' has-line-numbers' : ''}`;
  return `<div class="${cls}">
    <div class="code-block-header">
      <span>${escHtml(info.label)}${streaming ? ' · typing…' : ''}</span>
      <button class="code-action-btn" data-copy><i class="ri-file-copy-line"></i> Copy</button>
    </div>
    <div class="code-block-body">
      ${gutterHtml}
      <pre><code class="${codeClass}">${codeHtml}</code></pre>
    </div>
  </div>`;
}

function highlightCode(scope) {
  if (!window.hljs) return;
  (scope || document).querySelectorAll('.code-block pre code').forEach(el => {
    if (el.dataset.hl) return;
    const cls = el.className || '';
    const raw = el.textContent || '';
    el.textContent = raw;
    el.removeAttribute('data-highlighted');
    el.classList.remove('hljs');
    try {
      let r;
      const m = cls.match(/language-([a-z0-9+#-]+)/i);
      if (m && window.hljs.getLanguage(m[1])) r = window.hljs.highlight(raw, { language: m[1], ignoreIllegals: true });
      else r = window.hljs.highlightAuto(raw);
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
      const block = btn.closest('.code-block');
      const codeEl = block?.querySelector('pre code');
      const text = codeEl?.textContent || '';
      const ok = await copyText(text);
      btn.innerHTML = ok ? '<i class="ri-check-line"></i> Copied' : 'Failed';
      btn.classList.toggle('copied', ok);
      setTimeout(() => { btn.innerHTML = '<i class="ri-file-copy-line"></i> Copy'; btn.classList.remove('copied'); }, 1400);
    });
  });
}

async function copyText(t) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(t); return true; } } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.top = '-1000px';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

function renderBubble(bubble, text) {
  if (!bubble) return;
  if (!userSettings.highlightOn) { bubble.textContent = text || ''; return; }
  bubble.innerHTML = renderMarkdown(text || '');
  highlightCode(bubble);
  wireCodeButtons(bubble);
  // Apply highlight animation
  bubble.classList.add('highlight-active');
  setTimeout(() => bubble.classList.remove('highlight-active'), 1600);
}

/* ---------- Thinking Indicator ---------- */
function showThinking() {
  const el = document.getElementById('thinkingIndicator');
  if (el) el.style.display = 'flex';
}
function hideThinking() {
  const el = document.getElementById('thinkingIndicator');
  if (el) el.style.display = 'none';
}

/* ---------- CONVERSATION MANAGEMENT ---------- */
function currentConvo() {
  return __conversations.find(c => c.id === currentConversationId) || null;
}

function saveChatsToLS() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(__conversations)); } catch {}
  if (__user) {
    // Save to Firebase
    saveToFirebase(`chats/${__user.email}/conversations`, __conversations).catch(() => {});
  }
}

function loadChatsFromLS() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) __conversations = JSON.parse(raw) || [];
  } catch { __conversations = []; }
}

async function loadChatsFromFirebase() {
  if (!__user) return;
  const data = await readFromFirebase(`chats/${__user.email}/conversations`);
  if (data && Array.isArray(data) && data.length) {
    __conversations = data;
    saveChatsToLS();
    renderHistory();
  }
}

function startNewChat() {
  currentConversationId = null;
  $('#chatTitle').textContent = 'New chat';
  $('#chatMessages').innerHTML = getWelcomeHTML();
  bindSuggestionClicks();
  renderHistory();
  showThinking(); hideThinking();
}

function openConversationLS(id) {
  const c = __conversations.find(x => x.id === id);
  if (!c) return;
  currentConversationId = id;
  $('#chatTitle').textContent = c.title || 'Chat';
  const container = $('#chatMessages');
  container.innerHTML = '';
  for (const msg of c.messages || []) {
    addMessageToDOM(msg.role, msg.content, msg.ts, false);
  }
  renderHistory();
  scrollToBottom();
}

function renderHistory() {
  const list = $('#historyList');
  if (!list) return;
  if (!__conversations.length) {
    list.innerHTML = '<li class="history-empty">No conversations yet</li>';
    return;
  }
  list.innerHTML = __conversations.map(c => `
    <li class="history-item${c.id === currentConversationId ? ' active' : ''}" data-id="${c.id}">
      <i class="ri-chat-3-line"></i>
      <span class="history-title">${escapeHtml(c.title || 'Chat')}</span>
      <button class="history-delete icon-btn" aria-label="Delete"><i class="ri-delete-bin-line"></i></button>
    </li>
  `).join('');
}

function getWelcomeHTML() {
  return `<div class="welcome-screen">
    <img src="logo.png" alt="MiroxAI" class="welcome-logo">
    <h1 class="welcome-title">Hi, I'm Mirox</h1>
    <p class="welcome-sub">Built by the OpenSurr team. Ask anything, attach images or files, use web search, or start a voice call.</p>
    <div class="suggestion-grid">
      <button class="suggestion-card" data-prompt="What would you like to talk about?"><i class="ri-chat-3-line"></i><span>What would you like to talk about?</span></button>
      <button class="suggestion-card" data-prompt="Help me write code"><i class="ri-code-line"></i><span>Help me write code</span></button>
      <button class="suggestion-card" data-prompt="Explain a concept simply"><i class="ri-lightbulb-line"></i><span>Explain a concept simply</span></button>
      <button class="suggestion-card" data-prompt="Generate an image"><i class="ri-image-line"></i><span>Generate an image</span></button>
    </div>
    <p class="welcome-disclaimer">Mirox can make mistakes. Made by the OpenSurr team.</p>
  </div>`;
}

function bindSuggestionClicks() {
  $$('.suggestion-card').forEach(card => {
    card.addEventListener('click', () => {
      const prompt = card.dataset.prompt;
      if (prompt && $('#messageInput')) {
        $('#messageInput').value = prompt;
        $('#messageInput').dispatchEvent(new Event('input'));
        handleSend();
      }
    });
  });
}

function scrollToBottom() {
  const c = $('#chatMessages');
  if (c) c.scrollTop = c.scrollHeight;
}

/* ---------- MESSAGE RENDERING ---------- */
function addMessageToDOM(role, content, ts, animate = true) {
  const container = $('#chatMessages');
  if (!container) return;
  const msgEl = document.createElement('div');
  msgEl.className = `message ${role === 'user' ? 'user' : 'ai'}`;
  const avatar = role === 'user' ? '<i class="ri-user-line"></i>' : '<i class="ri-robot-line"></i>';
  msgEl.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div class="message-content">
      <div class="bubble"></div>
      <div class="message-time">${ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</div>
    </div>
  `;
  container.appendChild(msgEl);
  const bubble = msgEl.querySelector('.bubble');
  if (role === 'user') {
    bubble.textContent = content;
  } else {
    renderBubble(bubble, content);
  }
  if (animate) scrollToBottom();
  return msgEl;
}

/* ---------- SEND / STREAM ---------- */
function handleSend() {
  if (isReplying) return;
  const inp = $('#messageInput');
  if (!inp) return;
  const text = inp.value.trim();
  if (!text && !pendingFiles.length) return;

  if (!currentConversationId) {
    currentConversationId = uid();
    __conversations.unshift({
      id: currentConversationId,
      title: text.slice(0, 60) || 'New chat',
      messages: [],
      created: Date.now(),
    });
  }

  const convo = currentConvo();
  if (convo) {
    convo.messages.push({ role: 'user', content: text, ts: Date.now() });
    convo.updated = Date.now();
  }

  // If first message, remove welcome screen
  const welcome = $('.welcome-screen');
  if (welcome) welcome.remove();

  addMessageToDOM('user', text, Date.now());

  inp.value = '';
  inp.style.height = 'auto';
  $('#sendBtn').disabled = true;

  saveChatsToLS();
  renderHistory();

  sendToAPI(text);
}

async function sendToAPI(text) {
  isReplying = true;
  showThinking();

  const sendBtn = $('#sendBtn');
  const stopBtn = $('#stopBtn');
  if (sendBtn) sendBtn.disabled = true;
  if (stopBtn) stopBtn.style.display = 'grid';

  const convo = currentConvo();
  const history = convo ? convo.messages.slice(-14) : [];
  const model = __model || 'mirox-luna-1.2';

  // Check Eclipse credits before sending
  if (model === 'mirox-eclipse-2.0' && __user) {
    const credits = __user.eclipse_credits ?? 10;
    if (credits <= 0) {
      hideThinking();
      addMessageToDOM('ai', 'You have used all 10 Eclipse credits for today. Eclipse will refill in 24 hours. Switching to Luna.', Date.now());
      isReplying = false;
      if (sendBtn) sendBtn.disabled = false;
      if (stopBtn) stopBtn.style.display = 'none';
      return;
    }
  }

  activeStreamController = new AbortController();

  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        history: history.map(m => ({ role: m.role, content: m.content })),
        model,
        web_search: $('#searchToggleBtn')?.classList.contains('active'),
        files: pendingFiles,
      }),
      signal: activeStreamController.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Request failed');
    }

    // Create AI message element
    const container = $('#chatMessages');
    const msgEl = document.createElement('div');
    msgEl.className = 'message ai';
    msgEl.innerHTML = `
      <div class="message-avatar"><i class="ri-robot-line"></i></div>
      <div class="message-content">
        <div class="bubble"></div>
        <div class="message-time"></div>
      </div>
    `;
    container.appendChild(msgEl);
    const bubble = msgEl.querySelector('.bubble');

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';

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
        try {
          const o = JSON.parse(pl);
          if (o.d) {
            full += o.d;
            renderBubble(bubble, full);
            scrollToBottom();
          }
          if (o.error) throw new Error(o.error);
          if (o.done) {
            // Update user record
            if (__user) {
              __user.daily_used = o.daily_used;
              __user.trial_used = o.trial_used;
              if (model === 'mirox-eclipse-2.0') {
                __user.eclipse_credits = (__user.eclipse_credits ?? 10) - 1;
                if (__user.eclipse_credits <= 0) {
                  __user.eclipse_reset = Date.now() + 24 * 60 * 60 * 1000;
                }
                updateFirebase(`users/${__user.email}`, {
                  eclipse_credits: __user.eclipse_credits,
                  eclipse_reset: __user.eclipse_reset || null
                });
              }
              updateFirebase(`users/${__user.email}`, { daily_used: __user.daily_used, trial_used: __user.trial_used });
            }
          }
        } catch {}
      }
    }

    // Save AI reply to conversation
    if (convo) {
      convo.messages.push({ role: 'assistant', content: full, ts: Date.now() });
      convo.updated = Date.now();
    }
    saveChatsToLS();

    // Save chat log to Firebase
    if (__user) {
      pushToFirebase(`logs/chat/${__user.email}`, {
        model, message: text.slice(0, 500), reply: full.slice(0, 1000),
        ts: Date.now(), device: getDeviceId()
      });
    }

    msgEl.querySelector('.message-time').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  } catch (e) {
    if (e.name !== 'AbortError') {
      addMessageToDOM('ai', `Sorry, something went wrong: ${e.message}`, Date.now());
      if (__user) {
        pushToFirebase(`logs/chat/${__user.email}`, {
          model: __model || 'mirox-luna-1.2', error: e.message, ts: Date.now(), device: getDeviceId()
        });
      }
    }
  } finally {
    hideThinking();
    isReplying = false;
    activeStreamController = null;
    if (sendBtn) sendBtn.disabled = !$('#messageInput')?.value.trim();
    if (stopBtn) stopBtn.style.display = 'none';
    pendingFiles = [];
    updatePreview();
  }
}

function stopStreaming() {
  if (activeStreamController) { try { activeStreamController.abort(); } catch {} activeStreamController = null; }
  isReplying = false;
  const sb = $('#sendBtn'); if (sb) sb.disabled = !($('#messageInput')?.value.trim());
  const st = $('#stopBtn'); if (st) st.style.display = 'none';
  hideThinking();
}

/* ---------- FILE HANDLING ---------- */
function handleFiles(files) {
  if (!files?.length) return;
  const nf = [];
  const arr = Array.from(files);
  let done = 0;
  arr.forEach((f, idx) => {
    const isImg = (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(f.name);
    if (isImg) {
      if (f.size > 6 * 1024 * 1024) { done++; if (done === arr.length) finish(); return; }
      const r = new FileReader();
      r.onload = () => {
        nf.push({ name: f.name, size: f.size, type: 'image', content: '[Image] ' + f.name, dataUrl: String(r.result), order: idx });
        done++; if (done === arr.length) finish();
      };
      r.onerror = () => { done++; if (done === arr.length) finish(); };
      r.readAsDataURL(f);
    } else {
      if (f.size > 4 * 1024 * 1024) { done++; if (done === arr.length) finish(); return; }
      const r = new FileReader();
      r.onload = () => {
        nf.push({ name: f.name, size: f.size, type: 'text', content: String(r.result).slice(0, 60000), order: idx });
        done++; if (done === arr.length) finish();
      };
      r.onerror = () => { done++; if (done === arr.length) finish(); };
      r.readAsText(f);
    }
  });
  function finish() {
    nf.sort((a, b) => (a.order || 0) - (b.order || 0));
    pendingFiles = pendingFiles.concat(nf);
    updatePreview();
  }
}

function updatePreview() {
  const p = $('#attachmentPreview'), list = $('#attachmentList');
  if (!p || !list) return;
  if (!pendingFiles.length) { p.style.display = 'none'; list.innerHTML = ''; return; }
  p.style.display = 'flex';
  list.innerHTML = pendingFiles.map(f => {
    if (f.type === 'image' && f.dataUrl) {
      return `<div class="attach-chip"><img src="${f.dataUrl}" alt="">${escapeHtml(f.name)} <span style="color:var(--text-faint)">${fmtSize(f.size)}</span></div>`;
    }
    return `<div class="attach-chip"><i class="ri-file-line"></i>${escapeHtml(f.name)} <span style="color:var(--text-faint)">${fmtSize(f.size)}</span></div>`;
  }).join('');
}

/* ---------- MODEL PICKER ---------- */
function renderModelPicker() {
  const menu = $('#modelPickerMenu');
  if (!menu || !__config?.models) return;
  menu.innerHTML = __config.models.map(m => `
    <button class="model-option${m.id === (__model || 'mirox-luna-1.2') ? ' active' : ''}" data-model-id="${m.id}">
      <span class="model-option-label">${escapeHtml(m.label)}</span>
      <span class="model-option-tag">${escapeHtml(m.tagline)}</span>
    </button>
  `).join('');
  const current = __config.models.find(m => m.id === (__model || 'mirox-luna-1.2'));
  if (current && $('#currentModelLabel')) $('#currentModelLabel').textContent = current.label;
}

function selectModel(id) {
  __model = id;
  const m = __config?.models?.find(x => x.id === id);
  if (m && $('#currentModelLabel')) $('#currentModelLabel').textContent = m.label;
  renderModelPicker();
  $('#modelPickerMenu')?.classList.remove('open');
}

/* ---------- AUTH ---------- */
async function doLogin() {
  const name = $('#loginName')?.value.trim();
  const email = $('#loginEmail')?.value.trim().toLowerCase();
  if (!name || !email) return;
  const res = await authJson('/api/auth/simple-login', {
    method: 'POST',
    body: JSON.stringify({ name, email }),
  });
  if (res?.ok && res.token) {
    setToken(res.token);
    __user = res.user;
    closeModal('loginModal');
    updateUserUI();
    // Save user to Firebase (merge to avoid overwriting)
    updateFirebase(`users/${email}`, {
      email, name, tier: res.user.tier || 'free',
      last_login: Date.now(),
      eclipse_credits: 10,
      eclipse_reset: null,
    });
    // Log user activity
    pushToFirebase(`logs/user/${email}`, { event: 'signin', name, ts: Date.now(), device: getDeviceId() });
    loadChatsFromFirebase();
    loadUserKeys();
  } else {
    alert(res?.error || 'Login failed');
  }
}

async function doLogout() {
  const userEmail = __user?.email;
  await authJson('/api/logout', { method: 'POST' }).catch(() => {});
  setToken('');
  __user = null;
  __tier = 'free';
  if (userEmail) {
    pushToFirebase(`logs/user/${userEmail}`, { event: 'signout', ts: Date.now(), device: getDeviceId() });
  }
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

/* ---------- LOAD USER ---------- */
async function loadUser() {
  const res = await authJson('/api/me', {}, null);
  if (res?.user) {
    __user = res.user;
    __tier = res.user.tier || 'free';
    // Also read from Firebase for fresh tier/credits
    const fbUser = await readFromFirebase(`users/${res.user.email}`);
    if (fbUser) {
      __user = { ...__user, ...fbUser };
      __tier = fbUser.tier || 'free';
    }
    updateUserUI();
    loadChatsFromFirebase();
  } else {
    __tier = 'free';
    updateUserUI();
    loadChatsFromLS();
  }
}

/* ---------- CONFIG ---------- */
async function loadConfig() {
  const res = await safeFetch('/api/config');
  if (res.ok && res.data) {
    __config = res.data;
    renderModelPicker();
    __model = __config.models?.find(m => m.default)?.id || 'mirox-luna-1.2';
    const m = __config.models?.find(x => x.id === __model);
    if (m && $('#currentModelLabel')) $('#currentModelLabel').textContent = m.label;
  }
}

/* ---------- PLANS ---------- */
async function loadPlans() {
  const grid = $('#plansGrid');
  if (!grid) return;
  const res = await authJson('/api/subscription/plans', {}, null);
  if (!res?.plans) return;
  grid.innerHTML = res.plans.map(p => `
    <div class="plan-card${p.id === __tier ? ' current' : ''}">
      <div class="plan-name">${escapeHtml(p.label)}</div>
      <div class="plan-price">${p.price_robux ? p.price_robux + ' Robux' : 'Free'}</div>
      <ul class="plan-perks">
        ${p.perks.map(perk => `<li><i class="ri-check-line"></i> ${escapeHtml(perk)}</li>`).join('')}
      </ul>
    </div>
  `).join('');
}

async function loadUserKeys() {
  const list = $('#apiKeysList');
  if (!list) return;
  const res = await authJson('/api/keys/list', {}, null);
  if (!res?.keys?.length) {
    list.innerHTML = '<div style="font-size:13px;color:var(--text-faint);">No API keys yet. Generate one to get started.</div>';
    return;
  }
  list.innerHTML = res.keys.map(k => `
    <div class="api-key-item">
      <i class="ri-key-line"></i>
      <span class="key-prefix">${escapeHtml(k.prefix)}…</span>
      <span style="color:var(--text-faint);font-size:11px;">${k.created ? new Date(k.created).toLocaleDateString() : ''}</span>
    </div>
  `).join('');
}

async function genKey() {
  const res = await authJson('/api/keys/generate', { method: 'POST' }, null);
  if (res?.ok && res.key) {
    alert('API Key (save this — it won\'t be shown again):\n\n' + res.key);
    loadUserKeys();
  } else {
    alert(res?.error || 'Failed to generate key');
  }
}

/* ---------- IMAGE GENERATION (Hugging Face) ---------- */
async function genImage() {
  const prompt = $('#imagePrompt')?.value.trim();
  if (!prompt) return alert('Please describe the image you want.');
  const btn = $('#generateImageBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ri-loader-4-line"></i> Generating…'; }
  const result = $('#imageResult');
  if (result) result.innerHTML = '<div style="text-align:center;padding:20px;"><div class="thinking-dots" style="justify-content:center;"><span></span><span></span><span></span></div><p style="color:var(--text-faint);font-size:13px;margin-top:8px;">Generating image…</p></div>';

  try {
    const res = await authJson('/v1/images/generations', {
      method: 'POST',
      body: JSON.stringify({ prompt, aspect_ratio: $('#imageAspect')?.value || '1:1' }),
    }, null);

    if (res?.ok && res.image) {
      if (result) {
        result.innerHTML = `<img src="${res.image}" alt="${escapeHtml(prompt)}">`;
      }
      // Log image generation to Firebase
      if (__user) {
        pushToFirebase(`logs/image/${__user.email}`, {
          prompt: prompt.slice(0, 300), model: 'FLUX.1-schnell',
          ts: Date.now(), device: getDeviceId()
        });
      }
    } else {
      if (result) result.innerHTML = `<p style="color:#dc2626;font-size:13px;">Failed: ${escapeHtml(res?.error || 'Unknown error')}</p>`;
    }
  } catch (e) {
    if (result) result.innerHTML = `<p style="color:#dc2626;font-size:13px;">Failed: ${escapeHtml(e.message)}</p>`;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ri-image-add-line"></i> Generate'; }
  }
}

/* ---------- BACKGROUND ---------- */
function applyBackground() {
  const bg = document.body;
  if (bgState.url) {
    bg.style.backgroundImage = `linear-gradient(rgba(0,0,0,${bgState.dim / 100}), rgba(0,0,0,${bgState.dim / 100})), url(${bgState.url})`;
    bg.style.backgroundSize = 'cover';
    bg.style.backgroundPosition = 'center';
    bg.style.backgroundAttachment = 'fixed';
    const main = $('.main');
    if (main) { main.style.backdropFilter = `blur(${bgState.blur}px)`; }
  } else {
    bg.style.backgroundImage = '';
    bg.style.backgroundSize = '';
    bg.style.backgroundPosition = '';
    bg.style.backgroundAttachment = '';
    const main = $('.main');
    if (main) { main.style.backdropFilter = ''; }
  }
}

function saveBgPrefs() {
  try { localStorage.setItem('miroxai_bg', JSON.stringify(bgState)); } catch {}
  if (__user) updateFirebase(`users/${__user.email}/bg`, bgState).catch(() => {});
}

function loadBgPrefs() {
  try {
    const raw = localStorage.getItem('miroxai_bg');
    if (raw) { bgState = { ...bgState, ...JSON.parse(raw) }; }
  } catch {}
  applyBackground();
}

function populateBackgroundUI() {
  if ($('#bgDimInput')) $('#bgDimInput').value = bgState.dim;
  if ($('#bgDimLabel')) $('#bgDimLabel').textContent = bgState.dim + '%';
  if ($('#bgBlurInput')) $('#bgBlurInput').value = bgState.blur;
  if ($('#bgBlurLabel')) $('#bgBlurLabel').textContent = bgState.blur + 'px';
  if ($('#bgUrlInput') && bgState.url && !bgState.url.startsWith('data:')) $('#bgUrlInput').value = bgState.url;
}

/* ---------- APPEARANCE ---------- */
function saveAppearance(prefs) {
  if (prefs.mode) document.documentElement.setAttribute('data-mode', prefs.mode);
  if (prefs.theme) document.documentElement.setAttribute('data-theme', prefs.theme);
  if (prefs.corner) document.documentElement.setAttribute('data-corner', prefs.corner);
  if (prefs.font) document.documentElement.setAttribute('data-font', prefs.font);
  try { localStorage.setItem('miroxai_appearance', JSON.stringify(prefs)); } catch {}
  // Update active states
  $$('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === (prefs.mode || document.documentElement.getAttribute('data-mode'))));
  $$('.swatch').forEach(b => b.classList.toggle('active', b.dataset.theme === (prefs.theme || document.documentElement.getAttribute('data-theme'))));
  $$('[data-corner]').forEach(b => b.classList.toggle('active', b.dataset.corner === (prefs.corner || document.documentElement.getAttribute('data-corner'))));
  $$('[data-font]').forEach(b => b.classList.toggle('active', b.dataset.font === (prefs.font || document.documentElement.getAttribute('data-font'))));
}

function loadAppearance() {
  try {
    const raw = localStorage.getItem('miroxai_appearance');
    if (raw) saveAppearance(JSON.parse(raw));
  } catch {}
}

/* ---------- VOICE ---------- */
function startMic() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    alert('Speech recognition is not supported in your browser.');
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = userSettings.language || 'en-US';
  recognition.interimResults = false;
  recognition.continuous = false;

  const micBtn = $('#micBtn');
  if (micBtn) micBtn.classList.add('active');

  recognition.onresult = e => {
    const text = e.results[0][0].transcript;
    if ($('#messageInput')) {
      $('#messageInput').value = text;
      $('#messageInput').dispatchEvent(new Event('input'));
    }
    if (micBtn) micBtn.classList.remove('active');
    handleSend();
  };
  recognition.onerror = () => { if (micBtn) micBtn.classList.remove('active'); };
  recognition.onend = () => { if (micBtn) micBtn.classList.remove('active'); };
  recognition.start();
}

function startCall() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    alert('Speech recognition is not supported in your browser.');
    return;
  }
  callActive = true;
  callMuted = false;
  $('#callOverlay')?.classList.add('open');
  startCallRecognition();
}

function startCallRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  callRecognition = new SR();
  callRecognition.lang = userSettings.language || 'en-US';
  callRecognition.interimResults = false;
  callRecognition.continuous = true;

  callRecognition.onresult = e => {
    if (callMuted) return;
    const text = e.results[e.results.length - 1][0].transcript;
    if ($('#callTranscript')) $('#callTranscript').textContent = 'You: ' + text;
    // Send to AI via voice
    if (text.trim()) {
      // Simple voice chat: send and speak response
      sendVoiceMessage(text);
    }
  };
  callRecognition.onerror = () => {};
  callRecognition.onend = () => { if (callActive) setTimeout(() => startCallRecognition(), 500); };
  try { callRecognition.start(); } catch {}
}

async function sendVoiceMessage(text) {
  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        model: __model || 'mirox-luna-1.2',
        voice: true,
      }),
    });
    // For voice, we'd stream and speak. Simplified here.
  } catch {}
}

function endCall() {
  callActive = false;
  if (callRecognition) { try { callRecognition.stop(); } catch {} callRecognition = null; }
  $('#callOverlay')?.classList.remove('open');
}

function toggleMute() {
  callMuted = !callMuted;
  const btn = $('#callMuteBtn');
  if (btn) btn.innerHTML = callMuted ? '<i class="ri-mic-off-line"></i>' : '<i class="ri-mic-line"></i>';
}

function speakText(text) {
  if (!synth) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = userSettings.voiceRate || 1;
  u.lang = userSettings.language || 'en-US';
  synth.speak(u);
}

async function requestMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    alert('Microphone access granted!');
  } catch {
    alert('Microphone access denied.');
  }
}

/* ---------- MEMORY / PERSONA ---------- */
async function loadMemory() {
  const list = $('#memoryList');
  if (!list || !__user) return;
  const res = await authJson('/api/memory', {}, null);
  if (res?.facts?.length) {
    list.innerHTML = res.facts.map(f => `<div class="memory-item"><span>${escapeHtml(f.text)}</span></div>`).join('');
  } else {
    list.innerHTML = '<p style="font-size:13px;color:var(--text-faint);">No memories yet.</p>';
  }
}

async function addMemory() {
  const input = $('#memoryInput');
  if (!input || !input.value.trim()) return;
  await authJson('/api/memory', {
    method: 'POST',
    body: JSON.stringify({ fact: input.value.trim() }),
  });
  input.value = '';
  loadMemory();
}

async function loadPersona() {
  if (!__user) return;
  const res = await authJson('/api/persona', {}, null);
  if (res?.persona && $('#personaInput')) $('#personaInput').value = res.persona;
}

async function savePersona() {
  const val = $('#personaInput')?.value.trim() || '';
  await authJson('/api/persona', { method: 'POST', body: JSON.stringify({ persona: val }) });
}

/* ---------- SUPPORT ---------- */
async function submitReport() {
  const category = $('#supportCategory')?.value;
  const subject = $('#supportSubject')?.value.trim();
  const message = $('#supportMessage')?.value.trim();
  if (!subject || !message) return alert('Please fill in subject and message.');
  const res = await authJson('/api/support/ticket', {
    method: 'POST',
    body: JSON.stringify({ category, subject, message }),
  }, null);
  if (res?.ok) {
    alert('Ticket submitted! We\'ll reply shortly.');
    closeModal('supportModal');
  } else {
    alert(res?.error || 'Failed to submit ticket.');
  }
}

async function loadMyReports() {
  const res = await authJson('/api/support/my', {}, null);
  // Render tickets
}

async function sendSupportReply() {
  const input = $('#supportReplyInput');
  if (!input || !input.value.trim() || !currentTicketId) return;
  await authJson('/api/support/reply', {
    method: 'POST',
    body: JSON.stringify({ ticket_id: currentTicketId, message: input.value.trim() }),
  });
  input.value = '';
  // Reload thread
}

function backToTickets() {
  $('#supportTicketView').style.display = 'none';
  $('.support-form').style.display = 'flex';
  currentTicketId = null;
}

/* ---------- EVENT LISTENERS ---------- */
document.addEventListener('click', function(e) {
  const t = e.target;
  const closest = s => t.closest(s);

  // Close modals
  const closer = closest('[data-close]');
  if (closer) { closeModal(closer.dataset.close); return; }
  if (t.classList.contains('modal-overlay')) { t.classList.remove('open'); return; }
  if (t.classList.contains('lightbox')) { t.classList.remove('open'); return; }

  // Sidebar
  if (closest('#hamburgerBtn')) { openSidebar(); return; }
  if (closest('#sidebarCloseBtn')) { closeSidebar(); return; }
  if (t.id === 'sidebarScrim') { closeSidebar(); return; }
  if (closest('#brandLogo')) { startNewChat(); if (window.innerWidth <= 860) closeSidebar(); return; }
  if (closest('#newChatBtn')) { startNewChat(); if (window.innerWidth <= 860) closeSidebar(); return; }

  // User chip
  if (closest('#userChip')) {
    if (!__user) openModal('loginModal');
    return;
  }
  if (closest('#upgradeBtn')) {
    if (!__user) openModal('loginModal');
    else { openModal('plansModal'); loadPlans(); loadUserKeys(); }
    return;
  }

  // Settings
  if (closest('#settingsBtn')) { openModal('settingsModal'); loadPersona(); loadMemory(); return; }
  if (closest('#imageModeBtn')) { openModal('imageModal'); return; }
  if (closest('#backgroundModeBtn')) { openModal('backgroundModal'); populateBackgroundUI(); return; }
  if (closest('#plansModeBtn')) { openModal('plansModal'); loadPlans(); loadUserKeys(); return; }
  if (closest('#supportModeBtn') || closest('#supportModeBtn2')) { openModal('supportModal'); return; }
  if (closest('#talkModeBtn')) { startCall(); return; }
  if (closest('#callEndBtn')) { endCall(); return; }
  if (closest('#callMuteBtn')) { toggleMute(); return; }
  if (closest('#stopBtn')) { stopStreaming(); return; }

  // Model picker
  if (closest('#modelPickerBtn')) { e.stopPropagation(); $('#modelPickerMenu')?.classList.toggle('open'); return; }
  const mo = closest('.model-option');
  if (mo) { selectModel(mo.dataset.modelId); return; }
  if (!closest('#modelPicker')) $('#modelPickerMenu')?.classList.remove('open');

  // Settings tabs
  const tab = closest('.settings-tab');
  if (tab) {
    document.querySelectorAll('.settings-tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.settings-pane').forEach(x => x.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`.settings-pane[data-pane="${tab.dataset.tab}"]`)?.classList.add('active');
    return;
  }

  // Appearance
  const mb = closest('[data-mode]'); if (mb && mb.closest('#modeOptions')) { saveAppearance({ mode: mb.dataset.mode }); return; }
  const sw = closest('.swatch'); if (sw && sw.dataset.theme) { saveAppearance({ theme: sw.dataset.theme }); return; }
  const cb = closest('[data-corner]'); if (cb && cb.closest('#cornerOptions')) { saveAppearance({ corner: cb.dataset.corner }); return; }
  const fb = closest('[data-font]'); if (fb && fb.closest('#fontOptions')) { saveAppearance({ font: fb.dataset.font }); return; }

  // Toggles
  const tg = closest('[data-toggle]');
  if (tg) {
    const k = tg.dataset.toggle;
    userSettings[k] = !userSettings[k];
    tg.textContent = tg.textContent.replace(/ON|OFF/, userSettings[k] ? 'ON' : 'OFF');
    tg.classList.toggle('active', userSettings[k]);
    saveUserSettings();
    if (k === 'lineNumbers' || k === 'highlightOn') {
      document.querySelectorAll('.message.ai .bubble').forEach(b => {
        const txt = b.dataset.rawText;
        if (txt !== undefined) renderBubble(b, txt);
      });
    }
    return;
  }

  // Attach
  if (closest('#attachBtn')) { $('#fileInput')?.click(); return; }
  if (closest('#removeAttachmentBtn')) { pendingFiles = []; updatePreview(); return; }
  if (closest('#searchToggleBtn')) { $('#searchToggleBtn').classList.toggle('active'); return; }
  if (closest('#micBtn')) { startMic(); return; }

  // Edit title
  if (closest('#editTitleBtn')) {
    const cur = $('#chatTitle')?.textContent || '';
    const nxt = prompt('Rename this chat', cur);
    if (nxt === null) return;
    const tr = nxt.trim(); if (!tr) return;
    if ($('#chatTitle')) $('#chatTitle').textContent = tr;
    const c = currentConvo(); if (c) { c.title = tr; saveChatsToLS(); renderHistory(); }
    return;
  }

  // Actions
  if (closest('#logoutBtn')) { doLogout(); return; }
  if (closest('#savePersonaBtn')) { savePersona(); return; }
  if (closest('#addMemoryBtn')) { addMemory(); return; }
  if (closest('#submitReportBtn')) { submitReport(); return; }
  if (closest('#supportReplyBtn')) { sendSupportReply(); return; }
  if (closest('#supportBackBtn')) { backToTickets(); return; }
  if (closest('#generateKeyBtn')) { genKey(); return; }
  if (closest('#generateImageBtn')) { genImage(); return; }
  if (closest('#bgUploadZone')) { $('#bgFileInput')?.click(); return; }
  if (closest('#bgUrlApplyBtn')) {
    const u = $('#bgUrlInput')?.value.trim(); if (!u) return;
    bgState.url = u; saveBgPrefs(); applyBackground(); return;
  }
  if (closest('#bgRemoveBtn')) {
    bgState.url = null; saveBgPrefs(); applyBackground();
    if ($('#bgUrlInput')) $('#bgUrlInput').value = ''; return;
  }
  if (closest('#requestMicBtn')) { requestMic(); return; }
  if (closest('#testVoiceBtn')) { speakText('Hi, this is Mirox, made by the OpenSurr team.'); return; }

  // History items
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
    if (id) {
      stopStreaming();
      openConversationLS(id);
      if (window.innerWidth <= 860) closeSidebar();
    }
    return;
  }
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(o => o.classList.remove('open'));
    $('#modelPickerMenu')?.classList.remove('open');
    $('#lightbox')?.classList.remove('open');
    return;
  }
  if (e.key === 'Enter' && e.target?.id === 'messageInput' && !e.shiftKey) {
    e.preventDefault(); handleSend();
  }
  if (e.key === 'Enter' && e.target?.id === 'supportReplyInput') {
    e.preventDefault(); sendSupportReply();
  }
});

document.addEventListener('submit', function(e) {
  e.preventDefault();
  if (e.target?.id === 'composerForm') handleSend();
  if (e.target?.id === 'simpleLoginForm') doLogin();
}, true);

document.addEventListener('click', function(e) {
  if (e.target?.closest && e.target.closest('#sendBtn')) { e.preventDefault(); handleSend(); }
});

document.addEventListener('input', function(e) {
  if (e.target?.id === 'messageInput') {
    const sb = $('#sendBtn');
    if (sb) sb.disabled = isReplying || !e.target.value.trim();
    // Auto-resize textarea
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
  }
  if (e.target?.id === 'bgDimInput') {
    bgState.dim = parseInt(e.target.value);
    if ($('#bgDimLabel')) $('#bgDimLabel').textContent = bgState.dim + '%';
    applyBackground(); saveBgPrefs();
  }
  if (e.target?.id === 'bgBlurInput') {
    bgState.blur = parseInt(e.target.value);
    if ($('#bgBlurLabel')) $('#bgBlurLabel').textContent = bgState.blur + 'px';
    applyBackground(); saveBgPrefs();
  }
  if (e.target?.id === 'voiceRateInput') {
    userSettings.voiceRate = parseFloat(e.target.value);
    if ($('#voiceRateLabel')) $('#voiceRateLabel').textContent = userSettings.voiceRate.toFixed(1) + '×';
    saveUserSettings();
  }
});

document.addEventListener('change', function(e) {
  if (e.target?.id === 'fileInput') { handleFiles(e.target.files); e.target.value = ''; }
  if (e.target?.id === 'bgFileInput') {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { bgState.url = r.result; saveBgPrefs(); applyBackground(); populateBackgroundUI(); };
    r.readAsDataURL(f); e.target.value = '';
  }
  if (e.target?.id === 'langSelect') { userSettings.language = e.target.value; saveUserSettings(); }
  if (e.target?.id === 'voiceSelect') { userSettings.voiceName = e.target.value; saveUserSettings(); }
});

/* ---------- INIT ---------- */
async function init() {
  loadUserSettings();
  loadAppearance();
  loadBgPrefs();
  await loadConfig();
  await loadUser();
  loadChatsFromLS();
  renderHistory();
  bindSuggestionClicks();
  updateUserUI();

  // Set default model
  __model = __config?.models?.find(m => m.default)?.id || 'mirox-luna-1.2';
  renderModelPicker();

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      $('#messageInput')?.focus();
    }
  });
}

init();
