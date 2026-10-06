/* ============================================================
   MiroxAI — Frontend v59
   FIXED:
   - Image bubbles no longer giant (max-width: 420px, max-height: 60vh)
   - Continue button works — appends to same bubble via /v1/chat/completions
     with full assistant prefix in history
   - TTS: fetch TTS audio eagerly on readAloud toggle; user gesture unlocks
   ============================================================ */

const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const FALLBACK_MODELS = [
  { id: 'mirox-luna-1.2', label: 'Luna', tagline: 'Fast · warm · free', tier: 'free', default: true },
  { id: 'mirox-gen-1', label: 'Gen', tagline: 'Ultra concise', tier: 'free' },
  { id: 'mirox-pro-5', label: 'Pro', tagline: 'Balanced · deeper', tier: 'pro' },
  { id: 'mirox-ultra-10', label: 'Ultra', tagline: 'Deep reasoning', tier: 'pro' },
  { id: 'mirox-eclipse-2.0', label: 'Eclipse', tagline: 'Best quality · Ultimate only', tier: 'ultimate' },
];
const TIER_RANK = { free: 0, pro: 1, ultimate: 2 };
const LS_KEY = 'miroxai_conversations_v23';
const TOKEN_KEY = 'mirox_token';
const USER_SETTINGS_KEY = 'miroxai_user_settings_v23';
const DEVICE_ID_KEY = 'mirox_device_id';
const APPEARANCE_KEY = 'miroxai_appearance_v23';
const MCP_KEY = 'miroxai_mcp_v23';
const FEEDBACK_KEY = 'miroxai_feedback_v23';
const KEYS_CACHE = 'miroxai_keys_cache_v23';

let __config = null, __user = null, __tier = 'free', __model = 'mirox-luna-1.2';
let currentConversationId = null, isReplying = false, __conversations = [], pendingFiles = [];
let recognition = null, activeStreamController = null;
let userSettings = { soundOn: true, notifOn: true, highlightOn: true, lineNumbers: false, language: 'en-US', voiceRate: 1, autoSpeak: false, voice_id: null };
let ttsAvailable = false, currentAudio = null, readAloudEnabled = false, lastSpokenText = '', audioUnlocked = false;

const LANGUAGE_ICONS = {
  js:'ri-javascript-fill', javascript:'ri-javascript-fill', jsx:'ri-reactjs-line',
  ts:'ri-code-s-slash-line', typescript:'ri-code-s-slash-line', tsx:'ri-reactjs-line',
  py:'ri-code-s-slash-line', python:'ri-code-s-slash-line',
  html:'ri-html5-fill', xml:'ri-html5-fill',
  css:'ri-css3-fill',
  json:'ri-braces-line', yaml:'ri-braces-line', yml:'ri-braces-line', toml:'ri-braces-line',
  bash:'ri-terminal-box-line', sh:'ri-terminal-box-line', shell:'ri-terminal-box-line', zsh:'ri-terminal-box-line',
  sql:'ri-database-2-line',
  go:'ri-code-s-slash-line', rust:'ri-code-s-slash-line', rs:'ri-code-s-slash-line',
  java:'ri-code-s-slash-line', cpp:'ri-code-s-slash-line', c:'ri-code-s-slash-line',
  php:'ri-code-s-slash-line', ruby:'ri-code-s-slash-line', rb:'ri-code-s-slash-line',
  md:'ri-markdown-line', markdown:'ri-markdown-line',
};
const langIcon = l => LANGUAGE_ICONS[String(l || '').toLowerCase()] || 'ri-code-line';

/* ---------- Syntax highlighter ---------- */
const HL = (() => {
  const KW = {
    js: 'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|super|import|export|from|as|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false|yield|delete|void|static|get|set',
    ts: 'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|implements|interface|type|enum|namespace|module|declare|abstract|public|private|protected|readonly|as|async|await|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false|never|unknown|any|void|string|number|boolean|symbol|bigint|object',
    py: 'def|class|return|if|elif|else|for|while|break|continue|pass|import|from|as|try|except|finally|raise|with|lambda|yield|global|nonlocal|assert|del|in|is|not|and|or|None|True|False|async|await|self',
    bash: 'if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|local|export|source|alias|unset|readonly|declare|eval|exec',
    go: 'package|import|func|return|if|else|for|range|switch|case|break|continue|var|const|type|struct|interface|map|chan|go|defer|select|nil|true|false|make|new|len|cap|append|copy|delete|close|panic|recover',
    rust: 'fn|let|mut|const|static|if|else|for|while|loop|match|return|break|continue|struct|enum|impl|trait|type|use|mod|pub|where|as|in|ref|self|Self|super|crate|move|async|await|unsafe|dyn|true|false',
    java: 'class|interface|extends|implements|public|private|protected|static|final|abstract|synchronized|volatile|transient|native|new|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|throws|import|package|null|true|false|void|int|long|double|float|boolean|char|byte|short|String|Integer|Boolean|Object',
    cpp: 'int|char|long|short|float|double|void|bool|class|struct|union|enum|public|private|protected|virtual|override|static|const|constexpr|inline|namespace|using|template|typename|typedef|auto|new|delete|return|if|else|for|while|do|switch|case|break|continue|try|catch|throw|true|false|nullptr|this|sizeof',
    sql: 'SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|AND|OR|NOT|NULL|IS|IN|LIKE|BETWEEN|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|UNION|DISTINCT|COUNT|SUM|AVG|MAX|MIN|PRIMARY|KEY|FOREIGN|REFERENCES',
  };
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function highlight(code, lang) {
    const l = String(lang || '').toLowerCase();
    let src = esc(code);
    const strings = [];
    src = src.replace(/"((?:\\.|(?!").)*)"/g, (m) => { strings.push(m); return `\u0001S${strings.length - 1}\u0001`; });
    src = src.replace(/'((?:\\.|(?!').)*)'/g, (m) => { strings.push(m); return `\u0001S${strings.length - 1}\u0001`; });
    src = src.replace(/`((?:\\.|(?!`).)*)`/g, (m) => { strings.push(m); return `\u0001S${strings.length - 1}\u0001`; });
    const comments = [];
    if (['js','ts','java','cpp','go','rust','c'].includes(l)) {
      src = src.replace(/(\/\/[^\n]*)/g, (m) => { comments.push(m); return `\u0001C${comments.length - 1}\u0001`; });
      src = src.replace(/(\/\*[\s\S]*?\*\/)/g, (m) => { comments.push(m); return `\u0001C${comments.length - 1}\u0001`; });
    } else if (l === 'py' || l === 'bash' || l === 'sh' || l === 'shell' || l === 'zsh' || l === 'yaml' || l === 'yml') {
      src = src.replace(/(#[^\n]*)/g, (m) => { comments.push(m); return `\u0001C${comments.length - 1}\u0001`; });
    } else if (l === 'sql') {
      src = src.replace(/(--[^\n]*)/g, (m) => { comments.push(m); return `\u0001C${comments.length - 1}\u0001`; });
    }
    src = src.replace(/\b(0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][+\-]?\d+)?)\b/g, '<span class="hl-num">$1</span>');
    const kw = KW[l];
    if (kw) src = src.replace(new RegExp(`\\b(${kw})\\b`, 'g'), '<span class="hl-kw">$1</span>');
    src = src.replace(/\b([A-Za-z_$][\w$]*)\s*\(/g, '<span class="hl-fn">$1</span>(');
    src = src.replace(/\u0001C(\d+)\u0001/g, (_, i) => `<span class="hl-cm">${comments[+i]}</span>`);
    src = src.replace(/\u0001S(\d+)\u0001/g, (_, i) => `<span class="hl-str">${strings[+i]}</span>`);
    return src;
  }
  return { highlight };
})();

/* ---------- Loading ---------- */
function killLoader() { const l = document.getElementById('loadingScreen'); if (l) { l.classList.add('hidden'); setTimeout(() => l.style.display = 'none', 700); } }
setTimeout(killLoader, 900);
setTimeout(killLoader, 2200);

const uid = () => 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const escapeHtml = s => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
function getDeviceId() { let id = localStorage.getItem(DEVICE_ID_KEY); if (!id) { id = 'dev_' + uid(); localStorage.setItem(DEVICE_ID_KEY, id); } return id; }
function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }
function loadCachedKeys(email) { try { const all = JSON.parse(localStorage.getItem(KEYS_CACHE) || '{}'); return all[email] || []; } catch { return []; } }
function saveCachedKeys(email, keys) { try { const all = JSON.parse(localStorage.getItem(KEYS_CACHE) || '{}'); all[email] = keys; localStorage.setItem(KEYS_CACHE, JSON.stringify(all)); } catch {} }
function addCachedKey(email, keyObj) { if (!email) return; const keys = loadCachedKeys(email); keys.unshift(keyObj); saveCachedKeys(email, keys.slice(0, 50)); }

async function authJson(url, opts = {}, fallback = null) {
  try {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const t = getToken(); if (t) headers.Authorization = 'Bearer ' + t;
    const r = await fetch(url, { ...opts, headers, credentials: 'same-origin', cache: 'no-store' });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) return fallback;
    return await r.json();
  } catch { return fallback; }
}

function openModal(id) { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
function openSidebar() { $('#sidebar')?.classList.add('open'); $('#sidebarScrim')?.classList.add('open'); }
function closeSidebar() { $('#sidebar')?.classList.remove('open'); $('#sidebarScrim')?.classList.remove('open'); }

function loadUserSettings() { try { userSettings = { ...userSettings, ...JSON.parse(localStorage.getItem(USER_SETTINGS_KEY) || '{}') }; } catch {} }
function saveUserSettings() { try { localStorage.setItem(USER_SETTINGS_KEY, JSON.stringify(userSettings)); } catch {} }
function loadFeedback() { try { return JSON.parse(localStorage.getItem(FEEDBACK_KEY) || '{}'); } catch { return {}; } }
function saveFeedback(fb) { try { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(fb)); } catch {} }

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

function loadMcp() { let s = []; try { s = JSON.parse(localStorage.getItem(MCP_KEY) || '[]'); } catch {} renderMcp(s); }
function saveMcp(servers) { try { localStorage.setItem(MCP_KEY, JSON.stringify(servers)); } catch {} renderMcp(servers); }
function renderMcp(servers) {
  const list = $('#mcpList'); if (!list) return;
  if (!servers.length) { list.innerHTML = '<div style="font-size:12.5px;color:var(--text-faint);padding:4px 0;">No MCP servers configured.</div>'; return; }
  list.innerHTML = servers.map((s, i) => `<div class="mcp-item"><div class="mcp-item-status ${s.enabled ? 'on' : ''}"></div><div class="mcp-item-info"><div class="mcp-item-name">${escapeHtml(s.name || 'Unnamed')}</div><div class="mcp-item-url">${escapeHtml(s.url || '')}</div></div><button class="icon-btn mcp-toggle" data-idx="${i}"><i class="ri-${s.enabled ? 'pause-circle-line' : 'play-circle-line'}"></i></button><button class="icon-btn mcp-remove" data-idx="${i}"><i class="ri-delete-bin-line"></i></button></div>`).join('');
}

/* ---------- Markdown ---------- */
function renderMarkdown(text) {
  if (!text) return '';
  let src = String(text);
  const entireWrap = src.match(/^\s*```([a-zA-Z0-9+#._-]*)\s*\n([\s\S]*?)\n?```\s*$/);
  if (entireWrap && ['', 'markdown', 'md', 'text'].includes((entireWrap[1] || '').toLowerCase())) src = entireWrap[2];
  const parts = [];
  const fenceRe = /```([a-zA-Z0-9+#._-]*)\n?([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = fenceRe.exec(src)) !== null) {
    if (m.index > last) parts.push({ type: 'text', content: src.slice(last, m.index) });
    parts.push({ type: 'code', lang: (m[1] || '').trim(), content: m[2], closed: true });
    last = fenceRe.lastIndex;
  }
  const rest = src.slice(last);
  const openMatch = rest.match(/```([a-zA-Z0-9+#._-]*)\n?([\s\S]*)$/);
  if (openMatch) {
    const before = rest.slice(0, openMatch.index);
    if (before) parts.push({ type: 'text', content: before });
    parts.push({ type: 'code', lang: (openMatch[1] || '').trim(), content: openMatch[2], closed: false });
  } else if (rest) parts.push({ type: 'text', content: rest });
  return parts.map(p => p.type === 'code' ? renderCodeBlock(p.lang, p.content, p.closed) : renderTextBlock(p.content)).join('');
}
function renderCodeBlock(lang, code, closed) {
  const cleanLang = (lang || '').trim().toLowerCase();
  const label = (cleanLang || 'Code').toUpperCase();
  const icon = langIcon(cleanLang);
  const raw = String(code || '').replace(/\n$/, '');
  const lines = raw.split('\n');
  const highlighted = HL.highlight(raw, cleanLang);
  let gutter = '';
  if (userSettings.lineNumbers) { let g = ''; for (let i = 1; i <= lines.length; i++) g += i + '\n'; gutter = `<div class="code-gutter">${g}</div>`; }
  const copyBtn = closed ? `<button class="code-action-btn" data-copy><i class="ri-file-copy-line"></i> Copy</button>` : `<span class="code-streaming-hint"><i class="ri-loader-4-line"></i> writing</span>`;
  return `<div class="code-block" data-lang="${escapeHtml(cleanLang)}"><div class="code-block-header"><span class="code-lang-label"><i class="${icon}"></i> ${escapeHtml(label)}</span>${copyBtn}</div><div class="code-block-body">${gutter}<pre><code class="language-${escapeHtml(cleanLang)}">${highlighted}</code></pre></div></div>`;
}
function isTableSeparator(line) { const t = line.trim(); if (!t.startsWith('|')) return false; return /^\|[\s:|-]+\|?\s*$/.test(t) && /-/.test(t); }
function parseTableRow(line) { let s = line.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|')) s = s.slice(0, -1); return s.split('|').map(c => c.trim()); }
function renderTextBlock(text) {
  const lines = String(text).split('\n');
  let out = '', buf = [], listMode = null;
  const flush = () => { if (buf.length) { out += `<p>${inlineFmt(buf.join(' ').trim())}</p>`; buf = []; } };
  const closeList = () => { if (listMode) { out += listMode === 'ul' ? '</ul>' : '</ol>'; listMode = null; } };
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]; const t = raw.trim();
    if (t.startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flush(); closeList();
      const headers = parseTableRow(t);
      const aligns = parseTableRow(lines[i + 1]).map(c => { const l = c.startsWith(':'), r = c.endsWith(':'); if (l && r) return 'center'; if (r) return 'right'; return 'left'; });
      const rows = []; let j = i + 2;
      while (j < lines.length) { const rt = lines[j].trim(); if (!rt.startsWith('|')) break; if (isTableSeparator(rt)) break; rows.push(parseTableRow(rt)); j++; }
      let tbl = '<div class="table-wrap"><table class="md-table"><thead><tr>';
      headers.forEach((h, k) => { tbl += `<th style="text-align:${aligns[k] || 'left'}">${inlineFmt(h)}</th>`; });
      tbl += '</tr></thead><tbody>';
      rows.forEach(row => { tbl += '<tr>'; for (let k = 0; k < headers.length; k++) tbl += `<td style="text-align:${aligns[k] || 'left'}">${inlineFmt(row[k] || '')}</td>`; tbl += '</tr>'; });
      tbl += '</tbody></table></div>';
      out += tbl; i = j; continue;
    }
    if (!t) { flush(); closeList(); i++; continue; }
    const hm = t.match(/^(#{1,4})\s+(.+)$/);
    if (hm) { flush(); closeList(); const lvl = Math.min(4, hm[1].length); out += `<h${lvl}>${inlineFmt(hm[2])}</h${lvl}>`; i++; continue; }
    const um = t.match(/^[-*+]\s+(.+)$/);
    if (um) { flush(); if (listMode !== 'ul') { closeList(); out += '<ul>'; listMode = 'ul'; } out += `<li>${inlineFmt(um[1])}</li>`; i++; continue; }
    const om = t.match(/^(\d+)\.\s+(.+)$/);
    if (om) { flush(); if (listMode !== 'ol') { closeList(); out += '<ol>'; listMode = 'ol'; } out += `<li>${inlineFmt(om[2])}</li>`; i++; continue; }
    closeList(); buf.push(t); i++;
  }
  flush(); closeList();
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
function wireCodeButtons(scope) {
  (scope || document).querySelectorAll('.code-block .code-action-btn[data-copy]').forEach(btn => {
    if (btn.__wired) return; btn.__wired = true;
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

/* ---------- TTS ---------- */
function unlockAudio() {
  if (audioUnlocked) return;
  try { const a = new Audio(); a.volume = 0; a.play().then(() => { a.pause(); audioUnlocked = true; }).catch(() => {}); } catch {}
  audioUnlocked = true;
}
document.addEventListener('click', unlockAudio, { once: true });
document.addEventListener('touchstart', unlockAudio, { once: true });

function stopSpeaking() {
  if (currentAudio) { try { currentAudio.pause(); currentAudio.currentTime = 0; } catch {} currentAudio = null; }
}
async function speakText(text) {
  if (!ttsAvailable) { console.warn('[Mirox] TTS not configured (F_API missing on server).'); return false; }
  const clean = stripForSpeech(text);
  if (!clean) return false;
  stopSpeaking();
  lastSpokenText = clean;
  unlockAudio();
  try {
    const voiceId = userSettings.voice_id || __user?.voice_id || null;
    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean.slice(0, 900), voice: voiceId || null }),
    });
    if (!r.ok) { console.warn('[Mirox] TTS failed HTTP', r.status); return false; }
    const blob = await r.blob();
    if (blob.size < 200) { console.warn('[Mirox] TTS returned empty audio'); return false; }
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    currentAudio = a;
    a.onended = () => { URL.revokeObjectURL(url); currentAudio = null; };
    await a.play();
    return true;
  } catch (e) { console.warn('[Mirox] TTS error:', e.message); return false; }
}
function playAudioDataUrl(dataUrl) {
  if (!dataUrl) return false;
  stopSpeaking();
  unlockAudio();
  try {
    const a = new Audio(dataUrl);
    currentAudio = a;
    a.onended = () => { currentAudio = null; };
    a.play().catch(() => {});
    return true;
  } catch { return false; }
}
function stripForSpeech(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, ' code block ').replace(/`([^`]+)`/g, '$1').replace(/[#*_>~]/g, ' ').replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
}

/* ---------- Conversations ---------- */
function currentConvo() { return __conversations.find(c => c.id === currentConversationId) || null; }
function saveChatsToLS() { try { localStorage.setItem(LS_KEY, JSON.stringify(__conversations)); } catch {} }
function loadChatsFromLS() { try { __conversations = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { __conversations = []; } }
function getWelcomeHTML() { return `<div class="welcome-screen"><img src="/logo.png" alt="MiroxAI" class="welcome-logo theme-aware-logo" onerror="this.style.display='none'; this.nextElementSibling.style.display='grid';"><div class="logo-fallback logo-fallback-lg" style="display:none;">M</div><h1 class="welcome-title">Hi, I'm Mirox</h1><p class="welcome-sub">Built by the OpenSurr team. Ask anything, attach images or files, or start a voice call.</p><div class="suggestion-grid"><button class="suggestion-card" type="button" data-prompt="Generate me an image of a cat"><i class="ri-image-line"></i><span>Generate me an image of a cat</span></button><button class="suggestion-card" type="button" data-prompt="Help me write code"><i class="ri-code-line"></i><span>Help me write code</span></button><button class="suggestion-card" type="button" data-prompt="Explain a concept simply"><i class="ri-lightbulb-line"></i><span>Explain a concept simply</span></button><button class="suggestion-card" type="button" data-prompt="What would you like to talk about?"><i class="ri-chat-3-line"></i><span>What would you like to talk about?</span></button></div></div>`; }
function startNewChat() { currentConversationId = null; $('#chatTitle').textContent = 'New chat'; $('#chatMessages').innerHTML = getWelcomeHTML(); bindSuggestionClicks(); renderHistory(); }
function bindSuggestionClicks() { $$('.suggestion-card').forEach(card => { if (card.__wired) return; card.__wired = true; card.onclick = () => { const prompt = card.dataset.prompt; if (prompt && $('#messageInput')) { $('#messageInput').value = prompt; updateSendButtonState(); handleSend(); } }; }); }
function openConversationLS(id) {
  const c = __conversations.find(x => x.id === id); if (!c) return;
  currentConversationId = id; $('#chatTitle').textContent = c.title || 'Chat';
  const container = $('#chatMessages'); container.innerHTML = '';
  for (const msg of c.messages || []) addMessageToDOM(msg.role, msg.content, msg.ts, false, msg.id, msg.files || [], msg.image || null, msg.finish_reason || null);
  renderHistory(); scrollToBottom();
}
function renderHistory() {
  const list = $('#historyList'); if (!list) return;
  if (!__conversations.length) { list.innerHTML = '<li class="history-empty">No conversations yet</li>'; return; }
  list.innerHTML = __conversations.map(c => `<li class="history-item${c.id === currentConversationId ? ' active' : ''}" data-id="${c.id}"><i class="ri-chat-3-line"></i><span class="history-title">${escapeHtml(c.title || 'Chat')}</span><button class="history-delete icon-btn"><i class="ri-delete-bin-line"></i></button></li>`).join('');
}
function scrollToBottom() { const c = $('#chatMessages'); if (c) c.scrollTop = c.scrollHeight; }

/* ---------- Message rendering ---------- */
function buildActions(role, msgId) {
  if (role === 'ai') return `<div class="message-actions" data-msg-id="${msgId}"><button class="action-btn" data-action="copy" title="Copy"><i class="ri-file-copy-line"></i></button><button class="action-btn" data-action="speak" title="Read aloud"><i class="ri-volume-up-line"></i></button><button class="action-btn" data-action="retry" title="Regenerate"><i class="ri-refresh-line"></i></button><button class="action-btn" data-action="good" title="Good"><i class="ri-thumb-up-line"></i></button><button class="action-btn" data-action="bad" title="Bad"><i class="ri-thumb-down-line"></i></button></div>`;
  return `<div class="message-actions" data-msg-id="${msgId}"><button class="action-btn" data-action="copy" title="Copy"><i class="ri-file-copy-line"></i></button><button class="action-btn" data-action="edit" title="Edit"><i class="ri-edit-line"></i></button></div>`;
}
function renderMessageAttachments(files) {
  if (!files || !files.length) return '';
  const items = files.map(f => f.type === 'image' && f.dataUrl ? `<div class="bubble-attach bubble-attach-img" data-lightbox="${escapeHtml(f.dataUrl)}"><img src="${f.dataUrl}" alt="${escapeHtml(f.name || '')}" loading="lazy"></div>` : `<div class="bubble-attach bubble-attach-file"><i class="ri-file-line"></i><span>${escapeHtml(f.name || 'file')}</span></div>`).join('');
  return `<div class="bubble-attachments">${items}</div>`;
}
function renderGeneratedImage(dataUrl, alt) { if (!dataUrl) return ''; return `<div class="bubble-generated-image" data-lightbox="${escapeHtml(dataUrl)}"><img src="${dataUrl}" alt="${escapeHtml(alt || 'Generated image')}" loading="lazy"></div>`; }
function buildContinueBar(msgId) { return `<div class="continue-bar" data-continue-id="${msgId}"><button class="continue-btn" data-continue="${msgId}"><i class="ri-arrow-down-line"></i> Continue</button></div>`; }
function wireLightbox(el) {
  el.querySelectorAll('[data-lightbox]').forEach(el2 => el2.addEventListener('click', () => { const lb = $('#lightbox'); if (lb) { lb.querySelector('img').src = el2.dataset.lightbox; lb.classList.add('open'); } }));
}
function wireContinueBtn(msgEl) {
  msgEl.querySelectorAll('[data-continue]').forEach(btn => { if (btn.__wired) return; btn.__wired = true; btn.addEventListener('click', () => handleContinue(msgEl)); });
}
function addMessageToDOM(role, content, ts, animate = true, msgId = null, files = [], generatedImage = null, finishReason = null) {
  const container = $('#chatMessages'); if (!container) return null;
  const welcome = container.querySelector('.welcome-screen'); if (welcome) welcome.remove();
  const id = msgId || uid();
  const msgEl = document.createElement('div');
  msgEl.className = `message ${role === 'user' ? 'user' : 'ai'}`;
  msgEl.dataset.msgId = id; msgEl.dataset.role = role;
  if (finishReason) msgEl.dataset.finish = finishReason;
  const attachmentsHtml = role === 'user' ? renderMessageAttachments(files) : '';
  const generatedHtml = role === 'ai' && generatedImage ? renderGeneratedImage(generatedImage, content) : '';
  const continueHtml = (role === 'ai' && finishReason === 'length') ? buildContinueBar(id) : '';
  msgEl.innerHTML = `<div class="message-content"><div class="bubble">${attachmentsHtml}${generatedHtml}<div class="bubble-text"></div></div>${continueHtml}${buildActions(role, id)}<div class="message-time">${ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</div></div>`;
  container.appendChild(msgEl);
  const bubble = msgEl.querySelector('.bubble');
  const bubbleText = msgEl.querySelector('.bubble-text');
  if (role === 'user') { bubbleText.textContent = content || ''; if (!content) bubbleText.style.display = 'none'; }
  else { bubble.dataset.rawText = content; if (content) { bubbleText.innerHTML = renderMarkdown(content || ''); wireCodeButtons(bubbleText); } }
  wireLightbox(msgEl);
  wireContinueBtn(msgEl);
  wireMessageActions(msgEl);
  applyStoredFeedback(msgEl);
  if (animate) scrollToBottom();
  return msgEl;
}
function addThinkingBubble() {
  const container = $('#chatMessages'); if (!container) return null;
  const welcome = container.querySelector('.welcome-screen'); if (welcome) welcome.remove();
  const id = uid();
  const msgEl = document.createElement('div');
  msgEl.className = 'message ai'; msgEl.dataset.msgId = id; msgEl.dataset.role = 'ai'; msgEl.dataset.thinking = '1';
  msgEl.innerHTML = `<div class="message-content"><div class="bubble thinking"><span class="thinking-text" data-default="Thinking">Thinking</span><span class="thinking-dots"><span></span><span></span><span></span></span></div><div class="message-actions" style="opacity:0;pointer-events:none;"><button class="action-btn" data-action="copy"><i class="ri-file-copy-line"></i></button><button class="action-btn" data-action="speak"><i class="ri-volume-up-line"></i></button><button class="action-btn" data-action="retry"><i class="ri-refresh-line"></i></button><button class="action-btn" data-action="good"><i class="ri-thumb-up-line"></i></button><button class="action-btn" data-action="bad"><i class="ri-thumb-down-line"></i></button></div><div class="message-time"></div></div>`;
  container.appendChild(msgEl); scrollToBottom();
  return msgEl;
}
function wireMessageActions(msgEl) {
  const id = msgEl.dataset.msgId, role = msgEl.dataset.role;
  msgEl.querySelectorAll('.message-actions .action-btn').forEach(btn => {
    if (btn.__wired) return; btn.__wired = true;
    btn.addEventListener('click', async e => {
      e.preventDefault(); e.stopPropagation();
      const action = btn.dataset.action;
      const bubble = msgEl.querySelector('.bubble');
      const text = bubble?.innerText || '';
      if (action === 'copy') {
        try {
          if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
          else { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.top = '-1000px'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
          btn.classList.add('active'); btn.innerHTML = '<i class="ri-check-line"></i>';
          setTimeout(() => { btn.classList.remove('active'); btn.innerHTML = '<i class="ri-file-copy-line"></i>'; }, 1200);
        } catch {}
        return;
      }
      if (action === 'speak') {
        const raw = bubble?.dataset.rawText || bubble?.innerText || '';
        if (currentAudio) { stopSpeaking(); btn.classList.remove('active'); return; }
        btn.classList.add('active');
        await speakText(raw);
        btn.classList.remove('active');
        return;
      }
      if (action === 'retry') { if (role !== 'ai') return; handleRetry(msgEl); return; }
      if (action === 'edit') {
        if (role !== 'user') return;
        const cur = bubble?.querySelector('.bubble-text')?.textContent || '';
        const next = prompt('Edit message', cur);
        if (next === null || !next.trim()) return;
        const bt = bubble.querySelector('.bubble-text'); if (bt) { bt.textContent = next.trim(); bt.style.display = ''; }
        const c = currentConvo();
        if (c) { const m = (c.messages || []).find(x => x.id === id); if (m) { m.content = next.trim(); saveChatsToLS(); } }
        return;
      }
      if (action === 'good' || action === 'bad') {
        const fb = loadFeedback();
        const cg = btn.classList.contains('active-good');
        const cb = btn.classList.contains('active-bad');
        msgEl.querySelectorAll('.action-btn[data-action="good"], .action-btn[data-action="bad"]').forEach(b => b.classList.remove('active-good', 'active-bad'));
        if (action === 'good') { if (cg) { delete fb[id]; saveFeedback(fb); } else { fb[id] = 'good'; btn.classList.add('active-good'); saveFeedback(fb); } }
        else { if (cb) { delete fb[id]; saveFeedback(fb); } else { fb[id] = 'bad'; btn.classList.add('active-bad'); saveFeedback(fb); } }
      }
    });
  });
}
function applyStoredFeedback(msgEl) {
  const id = msgEl.dataset.msgId; const fb = loadFeedback();
  if (fb[id] === 'good') msgEl.querySelector('.action-btn[data-action="good"]')?.classList.add('active-good');
  else if (fb[id] === 'bad') msgEl.querySelector('.action-btn[data-action="bad"]')?.classList.add('active-bad');
}

/* ---------- Continue — appends into same bubble ---------- */
async function handleContinue(msgEl) {
  if (isReplying) return;
  const convo = currentConvo(); if (!convo) return;
  const msgId = msgEl.dataset.msgId;
  const m = (convo.messages || []).find(x => x.id === msgId);
  if (!m) return;

  msgEl.querySelector('.continue-bar')?.remove();
  delete msgEl.dataset.finish;

  isReplying = true; updateSendButtonState();
  const stopBtn = $('#stopBtn'); if (stopBtn) stopBtn.style.display = 'grid';
  activeStreamController = new AbortController();

  const idx = convo.messages.findIndex(x => x.id === msgId);
  const priorHistory = convo.messages.slice(Math.max(0, idx - 12), idx).map(x => ({ role: x.role, content: x.content }));
  /* Include the partial assistant message so the model knows what to continue from */
  priorHistory.push({ role: 'assistant', content: m.content });

  const model = __model || 'mirox-luna-1.2';
  let full = m.content || '';
  let pendingTts = null;
  let finishReason = 'stop';

  const bubble = msgEl.querySelector('.bubble');
  let bubbleText = bubble.querySelector('.bubble-text');
  if (!bubbleText) { bubbleText = document.createElement('div'); bubbleText.className = 'bubble-text'; bubble.appendChild(bubbleText); }
  bubbleText.classList.add('streaming');

  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'continue from exactly where you stopped. do not repeat anything. do not add a preamble. output only the continuation.',
        history: priorHistory.slice(-14),
        model, stream: true, files: [],
        voice_id: userSettings.voice_id || null,
        tts: false,
      }),
      signal: activeStreamController.signal,
    });

    if (!res.ok) {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      let errMsg = `HTTP ${res.status}`;
      if (ct.includes('application/json')) { const err = await res.json().catch(() => ({})); errMsg = err.error?.message || err.error || errMsg; }
      throw new Error(errMsg);
    }

    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const pl = line.slice(5).trim();
        if (!pl || pl === '[DONE]') continue;
        try {
          const o = JSON.parse(pl);
          if (o.d) {
            full += o.d;
            bubbleText.innerHTML = renderMarkdown(full);
            wireCodeButtons(bubbleText);
            scrollToBottom();
          }
          if (o.tts) pendingTts = o.tts;
          if (o.done) { if (o.finish_reason) finishReason = o.finish_reason; }
        } catch {}
      }
    }

    bubbleText.classList.remove('streaming');
    bubble.dataset.rawText = full;
    m.content = full;
    m.finish_reason = finishReason;

    if (finishReason === 'length') {
      msgEl.dataset.finish = 'length';
      const cont = document.createElement('div');
      cont.className = 'continue-bar';
      cont.innerHTML = `<button class="continue-btn" data-continue="${msgId}"><i class="ri-arrow-down-line"></i> Continue</button>`;
      msgEl.querySelector('.message-time').before(cont);
      wireContinueBtn(msgEl);
    }

    saveChatsToLS();
    if (readAloudEnabled) {
      if (pendingTts) playAudioDataUrl(pendingTts);
      else if (full) speakText(full);
    }
  } catch (e) {
    bubbleText.classList.remove('streaming');
    if (e.name !== 'AbortError') {
      const err = document.createElement('div');
      err.style.cssText = 'color:var(--danger);font-size:13px;margin-top:8px;';
      err.textContent = 'Continue failed: ' + e.message;
      msgEl.querySelector('.message-time').before(err);
      setTimeout(() => err.remove(), 5000);
      /* Re-add the button so they can try again */
      if (!msgEl.querySelector('.continue-bar')) {
        const cont = document.createElement('div');
        cont.className = 'continue-bar';
        cont.innerHTML = `<button class="continue-btn" data-continue="${msgId}"><i class="ri-arrow-down-line"></i> Continue</button>`;
        msgEl.querySelector('.message-time').before(cont);
        wireContinueBtn(msgEl);
      }
    }
  } finally {
    isReplying = false;
    activeStreamController = null;
    const st = $('#stopBtn'); if (st) st.style.display = 'none';
    updateSendButtonState();
  }
}

async function handleRetry(msgEl) {
  if (isReplying) return;
  const id = msgEl.dataset.msgId;
  const convo = currentConvo(); if (!convo) return;
  const idx = (convo.messages || []).findIndex(m => m.id === id);
  if (idx < 0) return;
  let userMsg = null;
  for (let i = idx - 1; i >= 0; i--) { if (convo.messages[i].role === 'user') { userMsg = convo.messages[i]; break; } }
  if (!userMsg) return;
  convo.messages = convo.messages.slice(0, idx);
  saveChatsToLS();
  let el = msgEl.nextElementSibling;
  while (el) { const n = el.nextElementSibling; el.remove(); el = n; }
  msgEl.remove();
  sendToAPI(userMsg.content, userMsg.files || []);
}

function updateSendButtonState() {
  const btn = $('#sendBtn'), inp = $('#messageInput'); if (!btn || !inp) return;
  const hasContent = inp.value.trim().length > 0 || pendingFiles.length > 0;
  const shouldEnable = hasContent && !isReplying;
  btn.classList.toggle('is-disabled', !shouldEnable);
  btn.setAttribute('aria-disabled', String(!shouldEnable));
}
function handleSend() {
  if (isReplying) return;
  const inp = $('#messageInput'); if (!inp) return;
  const text = inp.value.trim();
  if (!text && !pendingFiles.length) return;
  const filesToSend = pendingFiles.slice();
  if (!currentConversationId) {
    currentConversationId = uid();
    __conversations.unshift({ id: currentConversationId, title: text.slice(0, 60) || 'New chat', messages: [], created: Date.now() });
  }
  const msgId = uid();
  const convo = currentConvo();
  if (convo) { convo.messages.push({ id: msgId, role: 'user', content: text, ts: Date.now(), files: filesToSend }); convo.updated = Date.now(); }
  addMessageToDOM('user', text, Date.now(), true, msgId, filesToSend);
  inp.value = ''; inp.style.height = 'auto';
  pendingFiles = []; updatePreview(); updateSendButtonState();
  saveChatsToLS(); renderHistory();
  sendToAPI(text, filesToSend);
}

/* ---------- Send to API ---------- */
async function sendToAPI(text, files = []) {
  isReplying = true; updateSendButtonState();
  const stopBtn = $('#stopBtn'); if (stopBtn) stopBtn.style.display = 'grid';

  const convo = currentConvo();
  const history = convo ? convo.messages.slice(-14).map(m => ({ role: m.role, content: m.content })) : [];
  const model = __model || 'mirox-luna-1.2';
  const msgEl = addThinkingBubble();
  const bubble = msgEl.querySelector('.bubble');
  const thinkingText = msgEl.querySelector('.thinking-text');
  const timeEl = msgEl.querySelector('.message-time');
  const aiMsgId = msgEl.dataset.msgId;
  activeStreamController = new AbortController();

  let full = '', generatedImage = null, pendingTts = null, finishReason = 'stop';
  let imageWasSet = false;
  let bubbleText = null;

  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history, model, stream: true, files, voice_id: userSettings.voice_id || null, tts: readAloudEnabled }),
      signal: activeStreamController.signal,
    });
    if (!res.ok) {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      let errMsg = `HTTP ${res.status}`;
      if (ct.includes('application/json')) { const err = await res.json().catch(() => ({})); errMsg = err.error?.message || err.error || errMsg; }
      throw new Error(errMsg);
    }

    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = '', firstChunk = true;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const pl = line.slice(5).trim();
        if (!pl || pl === '[DONE]') continue;
        try {
          const o = JSON.parse(pl);
          if (o.p) {
            if (o.p === 'ar-search' || o.p === 'fallback') { if (thinkingText) thinkingText.textContent = 'Reading current data'; }
            else if (o.p === 'ollama') { if (thinkingText) thinkingText.textContent = 'Running local model'; }
            else if (o.p === 'image') { if (thinkingText) thinkingText.textContent = 'Drawing…'; }
            else if (o.p === 'pl' || o.p === 'hf') { if (thinkingText) thinkingText.textContent = 'Thinking'; }
            else if (o.p === 'canned') { if (thinkingText) thinkingText.textContent = 'Replying'; }
          }
          if (o.status && thinkingText) thinkingText.textContent = o.status;

          if (o.img) {
            generatedImage = o.img;
            imageWasSet = true;
            bubble.classList.remove('thinking');
            bubble.innerHTML = `<div class="bubble-generated-image" data-lightbox="${escapeHtml(o.img)}"><img src="${o.img}" alt="${escapeHtml(o.imgAlt || 'Generated image')}" loading="lazy"></div><div class="bubble-text"></div>`;
            bubbleText = bubble.querySelector('.bubble-text');
            wireLightbox(msgEl);
            const act = msgEl.querySelector('.message-actions');
            if (act) { act.style.opacity = ''; act.style.pointerEvents = ''; }
            scrollToBottom();
            firstChunk = false;
            continue;
          }

          if (o.d) {
            full += o.d;
            if (firstChunk) {
              bubble.classList.remove('thinking');
              bubble.classList.add('streaming');
              if (!imageWasSet) { bubble.innerHTML = '<div class="bubble-text"></div>'; bubbleText = bubble.querySelector('.bubble-text'); }
              firstChunk = false;
              const act = msgEl.querySelector('.message-actions');
              if (act) { act.style.opacity = ''; act.style.pointerEvents = ''; }
            }
            const target = bubbleText || bubble.querySelector('.bubble-text') || bubble;
            target.innerHTML = renderMarkdown(full);
            wireCodeButtons(target);
            if (!bubble.classList.contains('streaming')) bubble.classList.add('streaming');
            scrollToBottom();
          }

          if (o.tts) pendingTts = o.tts;
          if (o.error) throw new Error(o.error.message || o.error);
          if (o.done) { bubble.classList.remove('streaming'); if (o.finish_reason) finishReason = o.finish_reason; }
        } catch {}
      }
    }

    bubble.classList.remove('streaming');
    delete msgEl.dataset.thinking;
    bubble.dataset.rawText = full;

    if (finishReason === 'length') {
      msgEl.dataset.finish = 'length';
      const cont = document.createElement('div');
      cont.className = 'continue-bar';
      cont.innerHTML = `<button class="continue-btn" data-continue="${aiMsgId}"><i class="ri-arrow-down-line"></i> Continue</button>`;
      msgEl.querySelector('.message-time').before(cont);
      wireContinueBtn(msgEl);
    }

    const c = currentConvo();
    if (c) { c.messages.push({ id: aiMsgId, role: 'assistant', content: full, ts: Date.now(), image: generatedImage, finish_reason: finishReason }); c.updated = Date.now(); }
    saveChatsToLS();
    wireMessageActions(msgEl);
    if (timeEl) timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (readAloudEnabled) { if (pendingTts) playAudioDataUrl(pendingTts); else if (full) speakText(full); }
  } catch (e) {
    bubble.classList.remove('streaming');
    if (e.name !== 'AbortError') {
      bubble.classList.remove('thinking');
      bubble.textContent = `Sorry, something went wrong: ${e.message}`;
      if (timeEl) timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else { bubble.classList.remove('thinking'); if (!bubble.textContent) bubble.textContent = '(stopped)'; }
    delete msgEl.dataset.thinking;
    const act = msgEl.querySelector('.message-actions'); if (act) { act.style.opacity = ''; act.style.pointerEvents = ''; }
    wireMessageActions(msgEl);
  } finally {
    isReplying = false;
    activeStreamController = null;
    const st = $('#stopBtn'); if (st) st.style.display = 'none';
    updateSendButtonState();
  }
}
function stopStreaming() {
  if (activeStreamController) { try { activeStreamController.abort(); } catch {} activeStreamController = null; }
  stopSpeaking();
  isReplying = false;
  const st = $('#stopBtn'); if (st) st.style.display = 'none';
  updateSendButtonState();
}

/* ---------- Files ---------- */
function handleFiles(files) {
  if (!files?.length) return;
  const arr = Array.from(files);
  let done = 0;
  const newFiles = [];
  arr.forEach((f, idx) => {
    const isImg = (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(f.name);
    const r = new FileReader();
    if (isImg) {
      r.onload = () => { newFiles.push({ name: f.name, size: f.size, type: 'image', dataUrl: r.result, order: idx }); done++; if (done === arr.length) finish(); };
      r.onerror = () => { done++; if (done === arr.length) finish(); };
      r.readAsDataURL(f);
    } else {
      r.onload = () => { newFiles.push({ name: f.name, size: f.size, type: 'text', content: String(r.result).slice(0, 60000), order: idx }); done++; if (done === arr.length) finish(); };
      r.onerror = () => { done++; if (done === arr.length) finish(); };
      r.readAsText(f);
    }
  });
  function finish() { newFiles.sort((a, b) => (a.order || 0) - (b.order || 0)); pendingFiles = pendingFiles.concat(newFiles); updatePreview(); updateSendButtonState(); }
}
function updatePreview() {
  const p = $('#attachmentPreview'), list = $('#attachmentList'); if (!p || !list) return;
  if (!pendingFiles.length) { p.style.display = 'none'; list.innerHTML = ''; return; }
  p.style.display = 'flex';
  list.innerHTML = pendingFiles.map(f => f.type === 'image' && f.dataUrl ? `<div class="attach-chip"><img src="${f.dataUrl}" alt="">${escapeHtml(f.name)}</div>` : `<div class="attach-chip"><i class="ri-file-line"></i>${escapeHtml(f.name)}</div>`).join('');
}

/* ---------- Model picker ---------- */
function getModelsList() { return __config?.models?.length ? __config.models : FALLBACK_MODELS; }
function canUseModel(t) { if (t === 'free') return true; if (t === 'ultimate' && __tier === 'free') return true; return TIER_RANK[__tier || 'free'] >= TIER_RANK[t]; }
function renderModelPicker() {
  const menu = $('#modelPickerMenu'); if (!menu) return;
  const models = getModelsList(); const currentId = __model || models[0].id;
  menu.innerHTML = models.map(m => { const usable = canUseModel(m.tier); const lockLabel = usable ? '' : (m.tier === 'ultimate' ? '🔒 Ultimate' : '🔒 Pro'); return `<div class="model-option${m.id === currentId ? ' active' : ''}${usable ? '' : ' locked'}" data-model-id="${m.id}" data-tier="${m.tier}" data-usable="${usable}"><span class="model-option-label"><span class="dot"></span>${escapeHtml(m.label)}${lockLabel ? `<span class="model-lock">${lockLabel}</span>` : ''}</span><span class="model-option-tag">${escapeHtml(m.tagline || '')}</span></div>`; }).join('');
  menu.querySelectorAll('.model-option').forEach(opt => { opt.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (opt.dataset.usable === 'false') { const t = opt.dataset.tier; if (t === 'pro') alert('Pro and Ultra models require the Pro or Ultimate plan.'); else if (t === 'ultimate') alert('Eclipse requires the Ultimate plan.'); closeModelPicker(); return; } selectModel(opt.dataset.modelId); }; });
  const cur = models.find(m => m.id === currentId) || models[0];
  if (cur && $('#currentModelLabel')) $('#currentModelLabel').textContent = cur.label;
}
function selectModel(id) { if (!id) return; __model = id; const m = getModelsList().find(x => x.id === id); if (m && $('#currentModelLabel')) $('#currentModelLabel').textContent = m.label; renderModelPicker(); closeModelPicker(); }
function openModelPicker() { $('#modelPicker')?.classList.add('open'); $('#modelPickerMenu')?.classList.add('open'); }
function closeModelPicker() { $('#modelPicker')?.classList.remove('open'); $('#modelPickerMenu')?.classList.remove('open'); }
function wireModelPicker() {
  const btn = $('#modelPickerBtn'); if (!btn) return;
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); if ($('#modelPickerMenu')?.classList.contains('open')) closeModelPicker(); else openModelPicker(); });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#modelPicker')) closeModelPicker(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModelPicker(); });
}
function wireSendButton() {
  const btn = $('#sendBtn'), inp = $('#messageInput'); if (!btn || !inp) return;
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); handleSend(); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); handleSend(); return false; } });
  inp.addEventListener('input', () => { updateSendButtonState(); inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 180) + 'px'; });
  inp.addEventListener('paste', () => setTimeout(updateSendButtonState, 10));
  updateSendButtonState();
}

/* ---------- Read aloud ---------- */
function updateReadAloudIcon() {
  const btn = $('#readAloudBtn'); if (!btn) return;
  btn.innerHTML = readAloudEnabled ? '<i class="ri-volume-up-line"></i>' : '<i class="ri-volume-mute-line"></i>';
  btn.classList.toggle('active', readAloudEnabled);
  btn.title = readAloudEnabled ? 'Read aloud: ON' : 'Read aloud: OFF';
}
function wireReadAloud() {
  const btn = $('#readAloudBtn'); if (!btn) return;
  updateReadAloudIcon();
  btn.addEventListener('click', async () => {
    unlockAudio();
    readAloudEnabled = !readAloudEnabled;
    userSettings.autoSpeak = readAloudEnabled;
    saveUserSettings();
    updateReadAloudIcon();
    const tg = document.querySelector('[data-toggle="autoSpeak"]');
    if (tg) { tg.textContent = readAloudEnabled ? 'ON' : 'OFF'; tg.classList.toggle('active', readAloudEnabled); }
    if (readAloudEnabled) {
      if (!ttsAvailable) { alert('TTS not configured on the server (F_API missing).'); readAloudEnabled = false; updateReadAloudIcon(); return; }
      if (lastSpokenText) speakText(lastSpokenText);
    } else stopSpeaking();
  });
}

/* ---------- Auth ---------- */
async function doLogin() {
  const name = $('#loginName')?.value.trim();
  const email = $('#loginEmail')?.value.trim().toLowerCase();
  if (!name || !email) return;
  const res = await authJson('/api/auth/simple-login', { method: 'POST', body: JSON.stringify({ name, email }) }, null);
  if (res?.ok && res.token) { setToken(res.token); __user = res.user; __tier = res.user.tier || 'free'; if (res.user.voice_id) { userSettings.voice_id = res.user.voice_id; saveUserSettings(); } closeModal('loginModal'); updateUserUI(); renderModelPicker(); loadChatsFromLS(); renderHistory(); }
  else alert(res?.error || 'Login failed');
}
async function doLogout() {
  await authJson('/api/logout', { method: 'POST' }, null);
  setToken(''); __user = null; __tier = 'free';
  updateUserUI(); closeModal('settingsModal'); renderModelPicker();
}
function updateUserUI() {
  const chip = $('#userChip'); if (!chip) return;
  if (__user) { chip.querySelector('.user-name').textContent = __user.name || __user.email; chip.querySelector('.user-sub').textContent = `${(__tier || 'free').charAt(0).toUpperCase() + (__tier || 'free').slice(1)} plan`; }
  else { chip.querySelector('.user-name').textContent = 'Guest mode'; chip.querySelector('.user-sub').textContent = 'Sign in to save chats'; }
}
async function loadUser() {
  const res = await authJson('/api/me', {}, null);
  if (res?.user) { __user = res.user; __tier = res.user.tier || 'free'; if (res.user.voice_id) { userSettings.voice_id = res.user.voice_id; saveUserSettings(); } updateUserUI(); }
  else { __tier = 'free'; updateUserUI(); }
  loadChatsFromLS(); renderHistory();
}
async function loadConfig() {
  try { const res = await fetch('/api/config', { cache: 'no-store' }); const data = await res.json(); if (data?.models?.length) __config = data; else __config = { models: FALLBACK_MODELS }; ttsAvailable = !!data?.tts_available; }
  catch { __config = { models: FALLBACK_MODELS }; }
  const models = getModelsList(); __model = models[0].id; renderModelPicker();
  if ($('#currentModelLabel')) $('#currentModelLabel').textContent = models[0].label;
}

/* ---------- Plans ---------- */
async function loadPlans() {
  const grid = $('#plansGrid'); if (!grid) return;
  const res = await authJson('/api/subscription/plans', {}, null);
  if (!res?.plans) return;
  grid.innerHTML = res.plans.map(p => {
    const isFree = p.id === 'free';
    const isCurrent = p.id === __tier;
    const priceDisplay = isFree ? '<div class="plan-price-free">Free</div>' : `<div class="plan-price-usd">$${p.price_usd.toFixed(2)}<span class="plan-price-period">/mo</span></div><div class="plan-price-afg">≈ ${p.price_afg} AFG</div>`;
    const buyBtn = isFree ? `<button class="plan-btn${isCurrent ? ' disabled' : ''}" ${isCurrent ? 'disabled' : ''}>${isCurrent ? 'Current plan' : 'Start free'}</button>` : `<button class="plan-btn primary" data-buy="${escapeHtml(p.id)}">Buy ${escapeHtml(p.label)}</button>`;
    return `<div class="plan-card${isCurrent ? ' current' : ''}"><div class="plan-name">${escapeHtml(p.label)}</div><div class="plan-tagline">${escapeHtml(p.tagline || '')}</div><div class="plan-pricing">${priceDisplay}</div><ul class="plan-perks">${(p.perks || []).map(x => `<li><i class="ri-check-line"></i> ${escapeHtml(x)}</li>`).join('')}</ul>${buyBtn}</div>`;
  }).join('');
  grid.querySelectorAll('[data-buy]').forEach(btn => btn.addEventListener('click', () => openModal('paymentSoonModal')));
}

/* ---------- Voice + Keys ---------- */
async function loadVoices() {
  const sel = $('#voiceSelect'); if (!sel) return;
  const statusEl = $('#voiceStatus');
  if (!ttsAvailable) { sel.innerHTML = '<option value="">TTS not configured on server</option>'; if (statusEl) { statusEl.textContent = 'Admin needs to set F_API env variable.'; statusEl.className = 'msg err'; } return; }
  const res = await authJson('/api/voices', {}, null);
  const voices = res?.voices || [];
  const current = userSettings.voice_id || '';
  sel.innerHTML = '<option value="">Default voice</option>' + voices.map(v => `<option value="${escapeHtml(v.id)}"${v.id === current ? ' selected' : ''}>${escapeHtml(v.name)}${v.lang ? ' · ' + escapeHtml(v.lang) : ''}</option>`).join('');
  if (statusEl) { statusEl.textContent = voices.length ? `${voices.length} voice(s) available` : 'Using default voice'; statusEl.className = 'msg muted'; }
}
async function loadUserKeys() {
  const list = $('#apiKeysList'), counter = $('#apiKeyCounter'); if (!list) return;
  if (!__user) { list.innerHTML = '<div style="font-size:13px;color:var(--text-faint);">Sign in to see your API keys.</div>'; if (counter) counter.textContent = '(0/2 this month)'; return; }
  const cached = loadCachedKeys(__user.email);
  list.innerHTML = cached.length ? cached.map(k => `<div class="api-key-item"><i class="ri-key-line"></i><span class="key-prefix">${escapeHtml(k.prefix)}…</span></div>`).join('') : '<div style="font-size:12.5px;color:var(--text-faint);">Loading…</div>';
  const res = await authJson('/api/keys/list', {}, null);
  const used = res?.used ?? cached.length;
  const limit = res?.limit ?? 2;
  if (counter) counter.textContent = `(${used}/${limit} this month)`;
  if (res?.keys?.length) { saveCachedKeys(__user.email, res.keys); list.innerHTML = res.keys.map(k => `<div class="api-key-item"><i class="ri-key-line"></i><span class="key-prefix">${escapeHtml(k.prefix)}…</span></div>`).join(''); }
}
async function genKey() {
  if (!__user) { alert('Sign in first.'); openModal('loginModal'); return; }
  const btn = $('#generateKeyBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
  try {
    const res = await authJson('/api/keys/generate', { method: 'POST' }, null);
    if (res?.ok && res.key) { addCachedKey(__user.email, { prefix: res.prefix, created: Math.floor(Date.now() / 1000) }); const nd = $('#newKeyDisplay'), nv = $('#newKeyValue'); if (nd && nv) { nd.style.display = 'block'; nv.textContent = res.key; } loadUserKeys(); }
    else alert(res?.error || 'Failed');
  } finally { if (btn) { btn.disabled = false; btn.textContent = 'Generate key'; } }
}
async function genImage() {
  const prompt = $('#imagePrompt')?.value.trim(); if (!prompt) return alert('Please describe the image.');
  const btn = $('#generateImageBtn'), result = $('#imageResult');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ri-loader-4-line"></i> Generating…'; }
  if (result) result.innerHTML = '<div style="text-align:center;padding:20px;"><div class="bubble thinking" style="display:inline-flex;background:var(--panel);border:1px solid var(--border);padding:12px 16px;border-radius:16px;"><span class="thinking-text">Generating</span><span class="thinking-dots"><span></span><span></span><span></span></span></div></div>';
  try {
    const res = await fetch('/v1/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, aspect_ratio: $('#imageAspect')?.value || '1:1' }) });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok && data.image) { if (result) result.innerHTML = `<img src="${data.image}" alt="${escapeHtml(prompt)}" loading="lazy">`; }
    else { if (result) result.innerHTML = `<div style="padding:16px;border-radius:12px;background:rgba(220,38,38,0.08);border:1px solid rgba(220,38,38,0.2);"><p style="color:#dc2626;font-size:13px;margin:0;"><strong>Failed:</strong> ${escapeHtml(data.error?.message || data.error || 'Unknown')}</p></div>`; }
  } catch (e) { if (result) result.innerHTML = `<div style="padding:16px;border-radius:12px;background:rgba(220,38,38,0.08);"><p style="color:#dc2626;font-size:13px;margin:0;"><strong>Error:</strong> ${escapeHtml(e.message)}</p></div>`; }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ri-image-add-line"></i> Generate'; } }
}

/* ---------- Mic + Call ---------- */
function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return alert('Speech recognition not supported.');
  recognition = new SR();
  recognition.lang = userSettings.language || 'en-US';
  recognition.interimResults = false; recognition.continuous = false;
  const micBtn = $('#micBtn'); micBtn?.classList.add('active');
  recognition.onresult = e => { const text = e.results[0][0].transcript; if ($('#messageInput')) { $('#messageInput').value = text; updateSendButtonState(); } micBtn?.classList.remove('active'); handleSend(); };
  recognition.onerror = () => micBtn?.classList.remove('active');
  recognition.onend = () => micBtn?.classList.remove('active');
  recognition.start();
}
let callActive = false, callRecog = null, isSpeaking = false;
function startCall() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return alert('Speech recognition not supported.');
  unlockAudio();
  callActive = true; isSpeaking = false;
  $('#callOverlay')?.classList.add('open');
  if ($('#callStatus')) $('#callStatus').textContent = 'Hold the button to speak';
  if ($('#callTranscript')) $('#callTranscript').textContent = '';
  updatePttUI('idle');
}
function endCall() { callActive = false; isSpeaking = false; try { callRecog?.stop(); } catch {} callRecog = null; stopSpeaking(); $('#callOverlay')?.classList.remove('open'); updatePttUI('idle'); }
function updatePttUI(state) {
  const btn = $('#pttBtn'), avatar = $('#callAvatar'), status = $('#callStatus'); if (!btn) return;
  if (state === 'recording') { btn.classList.add('recording'); btn.innerHTML = '<i class="ri-mic-fill"></i><span>Release to send</span>'; avatar?.classList.add('recording'); if (status) status.textContent = 'Listening…'; }
  else if (state === 'thinking') { btn.classList.remove('recording'); btn.innerHTML = '<i class="ri-loader-4-line"></i><span>Thinking…</span>'; avatar?.classList.remove('recording'); if (status) status.textContent = 'Thinking…'; }
  else if (state === 'speaking') { btn.classList.remove('recording'); btn.innerHTML = '<i class="ri-volume-up-line"></i><span>Speaking…</span>'; avatar?.classList.remove('recording'); if (status) status.textContent = 'Speaking…'; }
  else { btn.classList.remove('recording'); btn.innerHTML = '<i class="ri-mic-line"></i><span>Hold to speak</span>'; avatar?.classList.remove('recording'); if (status) status.textContent = 'Hold the button to speak'; }
}
function beginPttRecording() {
  if (!callActive || isSpeaking) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) return;
  if (callRecog) { try { callRecog.abort(); } catch {} callRecog = null; }
  callRecog = new SR();
  callRecog.lang = userSettings.language || 'en-US';
  callRecog.interimResults = false; callRecog.continuous = false; callRecog.maxAlternatives = 1;
  let finalText = '';
  callRecog.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) finalText += e.results[i][0].transcript; };
  callRecog.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') console.warn('[Call]', e.error); };
  callRecog.onend = () => { if (!callActive) return; if (finalText.trim()) handleCallTurn(finalText.trim()); else updatePttUI('idle'); callRecog = null; };
  try { callRecog.start(); updatePttUI('recording'); } catch { updatePttUI('idle'); }
}
function endPttRecording() { if (callRecog) { try { callRecog.stop(); } catch {} } else updatePttUI('idle'); }
async function handleCallTurn(userText) {
  updatePttUI('thinking');
  if ($('#callTranscript')) { $('#callTranscript').textContent += (($('#callTranscript').textContent) ? '\n\n' : '') + `You: ${userText}`; $('#callTranscript').scrollTop = $('#callTranscript').scrollHeight; }
  const history = currentConvo()?.messages?.slice(-10).map(m => ({ role: m.role, content: m.content })) || [];
  const model = __model || 'mirox-luna-1.2';
  try {
    const res = await fetch('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: userText, history, model, stream: false, voice_id: userSettings.voice_id || null, tts: true }) });
    const data = await res.json().catch(() => ({}));
    const reply = data?.reply || data?.choices?.[0]?.message?.content || '';
    if (reply) {
      if ($('#callTranscript')) { $('#callTranscript').textContent += `\n\nMirox: ${reply}`; $('#callTranscript').scrollTop = $('#callTranscript').scrollHeight; }
      lastSpokenText = reply;
      const ttsUrl = data?.tts || null;
      if (ttsUrl) { isSpeaking = true; updatePttUI('speaking'); await new Promise(resolve => { try { stopSpeaking(); const a = new Audio(ttsUrl); currentAudio = a; a.onended = () => { currentAudio = null; resolve(); }; a.onerror = () => { currentAudio = null; resolve(); }; a.play().catch(() => resolve()); } catch { resolve(); } }); isSpeaking = false; }
      else if (ttsAvailable) { isSpeaking = true; updatePttUI('speaking'); await speakText(reply); isSpeaking = false; }
      updatePttUI('idle');
    } else updatePttUI('idle');
  } catch (e) { console.warn('[Call]', e.message); if ($('#callStatus')) $('#callStatus').textContent = 'Error — try again'; updatePttUI('idle'); }
}
function wirePttButton() {
  const btn = $('#pttBtn'); if (!btn) return;
  let recording = false;
  const start = (e) => { e.preventDefault(); e.stopPropagation(); if (recording) return; recording = true; beginPttRecording(); };
  const end = (e) => { e.preventDefault(); e.stopPropagation(); if (!recording) return; recording = false; endPttRecording(); };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointerleave', end);
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
}
async function requestMic() { try { await navigator.mediaDevices.getUserMedia({ audio: true }); alert('Mic granted.'); } catch { alert('Denied.'); } }

/* ---------- Memory / Persona ---------- */
async function loadMemory() { const list = $('#memoryList'); if (!list || !__user) return; const res = await authJson('/api/memory', {}, null); if (res?.facts?.length) list.innerHTML = res.facts.map(f => `<div class="memory-item"><span>${escapeHtml(f.text)}</span></div>`).join(''); else list.innerHTML = '<p style="font-size:13px;color:var(--text-faint);">No memories yet.</p>'; }
async function addMemory() { const input = $('#memoryInput'); if (!input?.value.trim()) return; await authJson('/api/memory', { method: 'POST', body: JSON.stringify({ fact: input.value.trim() }) }); input.value = ''; loadMemory(); }
async function loadPersona() { if (!__user) return; const res = await authJson('/api/persona', {}, null); if (res?.persona && $('#personaInput')) $('#personaInput').value = res.persona; }
async function savePersona() { await authJson('/api/persona', { method: 'POST', body: JSON.stringify({ persona: $('#personaInput')?.value.trim() || '' }) }); }
async function submitReport() { const category = $('#supportCategory')?.value; const subject = $('#supportSubject')?.value.trim(); const message = $('#supportMessage')?.value.trim(); if (!subject || !message) return alert('Please fill subject and message.'); const res = await authJson('/api/support/ticket', { method: 'POST', body: JSON.stringify({ category, subject, message }) }, null); if (res?.ok) { alert('Ticket submitted!'); closeModal('supportModal'); } }

/* ---------- Wire everything ---------- */
function wireToolButtons() {
  $('#talkModeBtn')?.addEventListener('click', startCall);
  $('#imageModeBtn')?.addEventListener('click', () => openModal('imageModal'));
  $('#plansModeBtn')?.addEventListener('click', () => { openModal('plansModal'); loadPlans(); loadUserKeys(); });
  $('#supportModeBtn')?.addEventListener('click', () => openModal('supportModal'));
  $('#supportModeBtn2')?.addEventListener('click', () => openModal('supportModal'));
  $('#settingsBtn')?.addEventListener('click', () => { openModal('settingsModal'); loadPersona(); loadMemory(); loadMcp(); loadVoices(); });
  $('#upgradeBtn')?.addEventListener('click', (e) => { e.stopPropagation(); if (!__user) openModal('loginModal'); else { openModal('plansModal'); loadPlans(); loadUserKeys(); } });
  $('#logoutBtn')?.addEventListener('click', doLogout);
  $('#generateKeyBtn')?.addEventListener('click', genKey);
  $('#generateImageBtn')?.addEventListener('click', genImage);
  $('#previewVoiceBtn')?.addEventListener('click', async () => {
    unlockAudio();
    const sel = $('#voiceSelect'); const vid = sel?.value || null;
    userSettings.voice_id = vid; saveUserSettings();
    authJson('/api/me/voice', { method: 'POST', body: JSON.stringify({ voice_id: vid || null }) }, null);
    const status = $('#voiceStatus'); if (status) { status.textContent = 'Generating preview…'; status.className = 'msg muted'; }
    const ok = await speakText('Hi, I am Mirox. This is how I sound.');
    if (status) { if (ok) status.textContent = 'Preview playing…'; else { status.textContent = 'Preview failed — check server logs / F_API'; status.className = 'msg err'; } }
  });
  $('#copyNewKeyBtn')?.addEventListener('click', async () => { const v = $('#newKeyValue')?.textContent || ''; try { if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(v); const b = $('#copyNewKeyBtn'); if (b) { b.innerHTML = '<i class="ri-check-line"></i>'; setTimeout(() => b.innerHTML = '<i class="ri-file-copy-line"></i>', 1200); } } catch {} });
  $('#addMcpBtn')?.addEventListener('click', () => { const name = $('#mcpNameInput')?.value.trim(); const url = $('#mcpUrlInput')?.value.trim(); if (!name || !url) return alert('Name and URL required.'); let servers = []; try { servers = JSON.parse(localStorage.getItem(MCP_KEY) || '[]'); } catch {} servers.push({ name, url, enabled: true, created: Date.now() }); saveMcp(servers); if ($('#mcpNameInput')) $('#mcpNameInput').value = ''; if ($('#mcpUrlInput')) $('#mcpUrlInput').value = ''; });
  $('#savePersonaBtn')?.addEventListener('click', savePersona);
  $('#addMemoryBtn')?.addEventListener('click', addMemory);
  $('#submitReportBtn')?.addEventListener('click', submitReport);
  $('#requestMicBtn')?.addEventListener('click', requestMic);
  $('#attachBtn')?.addEventListener('click', () => $('#fileInput')?.click());
  $('#removeAttachmentBtn')?.addEventListener('click', () => { pendingFiles = []; updatePreview(); updateSendButtonState(); });
  $('#micBtn')?.addEventListener('click', startMic);
  $('#stopBtn')?.addEventListener('click', stopStreaming);
  $('#callEndBtn')?.addEventListener('click', endCall);
  $('#editTitleBtn')?.addEventListener('click', () => { const cur = $('#chatTitle')?.textContent || ''; const nxt = prompt('Rename chat', cur); if (nxt === null) return; const tr = nxt.trim(); if (!tr) return; $('#chatTitle').textContent = tr; const c = currentConvo(); if (c) { c.title = tr; saveChatsToLS(); renderHistory(); } });
  $('#hamburgerBtn')?.addEventListener('click', openSidebar);
  $('#sidebarCloseBtn')?.addEventListener('click', closeSidebar);
  $('#sidebarScrim')?.addEventListener('click', closeSidebar);
  $('#brandLogo')?.addEventListener('click', (e) => { e.preventDefault(); startNewChat(); if (window.innerWidth <= 860) closeSidebar(); });
  $('#newChatBtn')?.addEventListener('click', () => { startNewChat(); if (window.innerWidth <= 860) closeSidebar(); });
  $('#userChip')?.addEventListener('click', () => { if (!__user) openModal('loginModal'); });
  $('#voiceSelect')?.addEventListener('change', async () => { const sel = $('#voiceSelect'); userSettings.voice_id = sel?.value || null; saveUserSettings(); authJson('/api/me/voice', { method: 'POST', body: JSON.stringify({ voice_id: sel?.value || null }) }, null); });
}

document.addEventListener('click', function (e) {
  const t = e.target; const closest = s => t.closest(s);
  const closer = closest('[data-close]'); if (closer) { closeModal(closer.dataset.close); return; }
  if (t.classList.contains('modal-overlay')) { t.classList.remove('open'); return; }
  if (t.classList.contains('lightbox')) { t.classList.remove('open'); return; }
  const tab = closest('.settings-tab');
  if (tab) { document.querySelectorAll('.settings-tab').forEach(x => x.classList.remove('active')); document.querySelectorAll('.settings-pane').forEach(x => x.classList.remove('active')); tab.classList.add('active'); document.querySelector(`.settings-pane[data-pane="${tab.dataset.tab}"]`)?.classList.add('active'); if (tab.dataset.tab === 'mcp') loadMcp(); if (tab.dataset.tab === 'voice') loadVoices(); return; }
  const mb = closest('[data-mode]'); if (mb && mb.closest('#modeOptions')) { applyAppearance({ mode: mb.dataset.mode }); return; }
  const sw = closest('.swatch'); if (sw?.dataset.theme) { applyAppearance({ theme: sw.dataset.theme }); return; }
  const cb = closest('[data-corner]'); if (cb && cb.closest('#cornerOptions')) { applyAppearance({ corner: cb.dataset.corner }); return; }
  const tg = closest('[data-toggle]');
  if (tg) {
    const k = tg.dataset.toggle; userSettings[k] = !userSettings[k];
    tg.textContent = userSettings[k] ? 'ON' : 'OFF'; tg.classList.toggle('active', userSettings[k]); saveUserSettings();
    if (k === 'lineNumbers' || k === 'highlightOn') {
      document.querySelectorAll('.message.ai .bubble').forEach(b => {
        const txt = b.dataset.rawText; if (txt === undefined) return;
        const bt = b.querySelector('.bubble-text');
        if (bt) { bt.innerHTML = renderMarkdown(txt); wireCodeButtons(bt); }
        else { b.innerHTML = renderMarkdown(txt); wireCodeButtons(b); }
      });
    }
    if (k === 'autoSpeak') { readAloudEnabled = userSettings.autoSpeak; updateReadAloudIcon(); if (!readAloudEnabled) stopSpeaking(); }
    return;
  }
  const mt = closest('.mcp-toggle'); if (mt) { let servers = []; try { servers = JSON.parse(localStorage.getItem(MCP_KEY) || '[]'); } catch {} const i = +mt.dataset.idx; if (servers[i]) { servers[i].enabled = !servers[i].enabled; saveMcp(servers); } return; }
  const mr = closest('.mcp-remove'); if (mr) { let servers = []; try { servers = JSON.parse(localStorage.getItem(MCP_KEY) || '[]'); } catch {} servers.splice(+mr.dataset.idx, 1); saveMcp(servers); return; }
  const hist = closest('.history-item');
  if (hist) {
    if (t.closest('.history-delete')) { const id = hist.dataset.id; __conversations = __conversations.filter(x => x.id !== id); if (currentConversationId === id) startNewChat(); saveChatsToLS(); renderHistory(); e.stopPropagation(); return; }
    const id = hist.dataset.id; if (id) { stopStreaming(); openConversationLS(id); if (window.innerWidth <= 860) closeSidebar(); }
    return;
  }
});
document.addEventListener('submit', function (e) { e.preventDefault(); if (e.target?.id === 'simpleLoginForm') doLogin(); }, true);
document.addEventListener('change', function (e) { if (e.target?.id === 'fileInput') { handleFiles(e.target.files); e.target.value = ''; } if (e.target?.id === 'langSelect') { userSettings.language = e.target.value; saveUserSettings(); } });

/* ---------- Init ---------- */
async function init() {
  loadUserSettings(); loadAppearance();
  wireModelPicker(); wireSendButton(); wireToolButtons(); wireReadAloud(); wirePttButton();
  renderModelPicker();
  readAloudEnabled = !!userSettings.autoSpeak;
  updateReadAloudIcon();
  await loadConfig();
  await loadUser();
  bindSuggestionClicks(); updateUserUI(); loadMcp();
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('#messageInput')?.focus(); } });
}
init();
