(function () {
  'use strict';

  /* ═══════════ Loader: removed as early as possible, never blocks ═══════════ */
  let __loaderGone = false;
  function killLoader() {
    if (__loaderGone) return;
    __loaderGone = true;
    const el = document.getElementById('loadingScreen');
    if (!el) return;
    el.classList.add('hidden');
    el.style.pointerEvents = 'none';
    setTimeout(() => { el.style.display = 'none'; }, 400);
  }
  window.__miroxKillLoader = killLoader;
  setTimeout(killLoader, 1200);
  window.addEventListener('load', killLoader);
  window.addEventListener('error', killLoader);
  window.addEventListener('unhandledrejection', killLoader);

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };

  const FALLBACK_MODELS = [
    { id: 'mirox-luna-1.2', label: 'Luna', tier: 'free' },
    { id: 'mirox-gen-1', label: 'Gen', tier: 'free' },
    { id: 'mirox-pro-5', label: 'Pro', tier: 'pro' },
    { id: 'mirox-ultra-10', label: 'Ultra', tier: 'pro' },
    { id: 'mirox-eclipse-2.0', label: 'Eclipse', tier: 'ultimate' },
  ];
  const TIER_RANK = { free: 0, pro: 1, ultimate: 2 };
  const LS_KEY = 'miroxai_conversations_v26';
  const TOKEN_KEY = 'mirox_token';
  const APPEARANCE_KEY = 'miroxai_appearance_v26';
  const BRIDGE_KEY = 'miroxai_bridge_v26';
  const KDE_DEVICE_KEY = 'miroxai_kde_device_v1';
  const BRIDGE_OPTS_KEY = 'miroxai_bridge_opts_v1';
  const PASTE_ATTACH_THRESHOLD = 1024;
  const NET_TIMEOUT_MS = 9000;

  const MAX_BRIDGE_QUESTIONS = 6;
  const MAX_BRIDGE_ITER = 200;
  const MAX_AUTO_CONTINUES = 100;
  const MAX_DUP_COMMANDS = 40;
  const AUTO_CONTINUE_DELAY_MS = 900;
  const MAX_IMAGE_DIM = 1280;

  let __config = null, __user = null, __tier = 'free', __model = 'mirox-luna-1.2';
  let currentConversationId = null, isReplying = false;
  let continuationBusy = false, streamRenderPending = false, streamRenderAt = 0, userIsAtBottom = true;
  const FREE_CONVO_TOKEN_LIMIT = 10000;
  let autoScrollEnabled = true;
  let __conversations = [], pendingFiles = [], activeStreamController = null, __usage = null;
  let __bridge = { name: 'My Laptop', model: 'mirox-luna-1.2', port: 8765, connected: false, baseUrl: null, env: null };
  let bridgeConversation = [], bridgeRunning = false, bridgeQuestionCount = 0, bridgeProgress = 0;
  let bridgeTurn = null, bridgeAutoTimer = null, bridgeTaskComplete = true;
  let bridgeWaitingForUser = false, bridgeAbort = false;
  let __bqResolver = null, __bqSelected = null;
  let forceSearchNext = false, __historyQuery = '';
  let __sudoPassword = '', __sudoRemember = false, __sudoResolver = null;
  let __kdeDevices = [], __kdeCurrentDevice = null, __kdeResolver = null, __kdeAvailable = false;
  let __bridgeAutoRun = true, __bridgeShowCode = false;
  let __lastBuildFolder = null, __lastBuildWasMobile = false, __lastPreviewFile = null;
  let __plannerResolver = null, __ivDataUrl = '';

  const uid = () => 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const escapeHtml = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  function safeGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
  function safeSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
  function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }

  /* Every network call gets a timeout so nothing can hang the UI. */
  async function netFetch(url, opts = {}, ms = NET_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const extra = opts.signal ? [opts.signal] : [];
    try {
      if (extra.length) extra[0].addEventListener('abort', () => ctrl.abort());
      return await fetch(url, { ...opts, signal: ctrl.signal, credentials: 'same-origin', cache: 'no-store' });
    } finally { clearTimeout(timer); }
  }
  async function jsonOr(url, opts = {}, fallback = null, ms = NET_TIMEOUT_MS) {
    try {
      const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      const t = getToken(); if (t) headers.Authorization = 'Bearer ' + t;
      const r = await netFetch(url, { ...opts, headers }, ms);
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('application/json')) return fallback;
      return await r.json();
    } catch { return fallback; }
  }

  /* ═══════════ IndexedDB (generated images) ═══════════ */
  const idb = (() => {
    let p = null;
    const open = () => p || (p = new Promise((res, rej) => {
      if (!('indexedDB' in window)) return rej(new Error('no idb'));
      const r = indexedDB.open('mirox', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    return {
      async set(k, v) {
        const db = await open();
        return new Promise((res, rej) => {
          const t = db.transaction('kv', 'readwrite');
          t.objectStore('kv').put(v, k);
          t.oncomplete = () => res(true);
          t.onerror = () => rej(t.error);
        });
      },
      async get(k) {
        const db = await open();
        return new Promise((res, rej) => {
          const q = db.transaction('kv').objectStore('kv').get(k);
          q.onsuccess = () => res(q.result || null);
          q.onerror = () => rej(q.error);
        });
      },
    };
  })();

  /* ═══════════ Mascot ═══════════ */
  document.addEventListener('mousemove', (e) => {
    const x = ((e.clientX / window.innerWidth) - .5) * 5;
    const y = ((e.clientY / window.innerHeight) - .5) * 3.5;
    const r = document.documentElement.style;
    r.setProperty('--look-x', x.toFixed(1) + 'px');
    r.setProperty('--look-y', y.toFixed(1) + 'px');
  }, { passive: true });

  const MASCOT_MOODS = {
    idle: '', happy: '', love: '', wink: '', sad: '', surprised: '', sleepy: '',
    thinking: '', reasoning: '', searching: '', reading: '', learning: '',
    coding: '', celebrate: '', error: '', listening: '', cool: '', confused: '', focus: '',
  };
  const MOOD_KEYS = Object.keys(MASCOT_MOODS);
  const BLOB_SVG_SOURCE = `<svg class="blob-svg" viewBox="-125 -125 250 250" role="img" aria-label="MiroxAI animated blob" xmlns="http://www.w3.org/2000/svg"><defs>__GRADIENT_DEFS__</defs><g class="blob-wobble"><path class="blob-body" d="M0-87 C24-91 44-80 60-64 C78-48 88-26 87-3 C88 18 78 43 62 59 C45 77 22 88 0 86 C-25 89-47 78-64 61 C-81 43-88 21-86-3 C-88-27-76-50-59-65 C-42-81-22-87 0-87Z" fill="url(__GRADIENT_URL__)"/><g class="blob-face"><ellipse class="eye left" cx="-27" cy="-8" rx="6.2" ry="9" fill="#24233a"/><ellipse class="eye right" cx="27" cy="-8" rx="6.2" ry="9" fill="#24233a"/><circle class="eye-glint" cx="-29" cy="-11" r="2.1"/><circle class="eye-glint" cx="25" cy="-11" r="2.1"/><ellipse class="cheek left" cx="-43" cy="13" rx="9" ry="4.5"/><ellipse class="cheek right" cx="43" cy="13" rx="9" ry="4.5"/><path class="blob-mouth" d="M-11 20 Q0 30 11 20" fill="none" stroke-width="4"/><g class="blob-glasses" fill="none" stroke="#24233a" stroke-width="3.5"><rect x="-43" y="-21" width="32" height="26" rx="9"/><rect x="11" y="-21" width="32" height="26" rx="9"/><path d="M-11-11 Q0-16 11-11"/></g></g><g class="blob-sparkles" fill="white"><path d="M-72-48 l3 8 8 3-8 3-3 8-3-8-8-3 8-3z"/><path d="M69 35 l2.5 6 6 2.5-6 2.5-2.5 6-2.5-6-6-2.5 6-2.5z"/></g></g></svg>`;
  let blobMascotId = 0;
  function blobSvg() {
    const id = 'mirox-blob-' + (++blobMascotId);
    const gradient = `<linearGradient id="${id}-gradient" x1="12%" y1="8%" x2="88%" y2="92%"><stop offset="0%" stop-color="var(--blob-start)"/><stop offset="48%" stop-color="var(--blob-mid)"/><stop offset="100%" stop-color="var(--blob-end)"/></linearGradient>`;
    return BLOB_SVG_SOURCE
      .replace('__GRADIENT_DEFS__', gradient)
      .replace('__GRADIENT_URL__', `#${id}-gradient`);
  }
  function mascotHTML(cls, mood) {
    const m = MOOD_KEYS.includes(mood) ? mood : 'idle';
    return `<div class="mascot ${cls || ''} m-${m}" data-mood="${m}">${blobSvg()}<span class="prop" aria-hidden="true">${escapeHtml(MASCOT_MOODS[m])}</span></div>`;
  }
  function upgradeStaticMascots(scope = document) {
    scope.querySelectorAll('.mascot:not([data-blob-ready])').forEach((el) => {
      const m = MOOD_KEYS.includes(el.dataset.mood) ? el.dataset.mood : 'idle';
      el.innerHTML = blobSvg() + `<span class="prop" aria-hidden="true">${escapeHtml(MASCOT_MOODS[m])}</span>`;
      el.dataset.mood = m;
      el.classList.add('m-' + m);
      el.dataset.blobReady = '1';
    });
  }
  function setMascotMood(mood, scope) {
    const root = scope || document;
    const m = MOOD_KEYS.includes(mood) ? mood : 'idle';
    upgradeStaticMascots(root);
    root.querySelectorAll('.mascot').forEach((el) => {
      el.className = el.className.split(' ').filter((c) => !/^m-/.test(c)).join(' ');
      el.classList.add('m-' + m);
      el.dataset.mood = m;
      const p = el.querySelector('.prop');
      if (p) p.textContent = MASCOT_MOODS[m];
    });
  }
  upgradeStaticMascots();
  function pickMoodFor(text) {
    const t = String(text || '').toLowerCase();
    if (/\b(search|look up|google|latest|news|find)\b/.test(t)) return 'searching';
    if (/\b(build|code|script|fix|bug|function|debug|lua|python|javascript|html|css)\b/.test(t)) return 'coding';
    if (/\b(explain|teach|learn|how does|why|what is)\b/.test(t)) return 'learning';
    if (t.length > 300) return 'reasoning';
    return 'thinking';
  }
  function startIdleMascot() {
    setInterval(() => {
      const w = document.getElementById('welcomeMascot');
      if (!w || isReplying || !w.parentElement) return;
      const pool = ['happy', 'wink', 'love', 'cool', 'learning', 'listening'];
      setMascotMood(pool[Math.floor(Math.random() * pool.length)], w.parentElement);
    }, 7000);
  }

  /* ═══════════ Status labels ═══════════ */
  function pickStatusLabel(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return 'Thinking';
    if (/\b(remove|delete|kick|block|forget|unpair)\b/.test(t) && /\b(wifi|wi-fi|network|router)\b/.test(t)) return 'Planning a safe answer';
    if (/\b(password|hack|exploit|crack|bypass)\b/.test(t)) return 'Checking safety first';
    if (/\b(scan|check).*(device|phone|tablet|kde)\b/.test(t)) return 'Scanning devices';
    if (/\b(ping|online|reachable)\b/.test(t)) return 'Pinging device';
    if (/\b(send|share|move|push).*(phone|mobile|device|tablet)\b/.test(t)) return 'Sending to device';
    if (/\b(fix|debug|bug|error|broken|crash|issue|problem|wrong|fail)\b/.test(t)) return 'Looking into problems';
    if (/\b(search|find|look up|research|where is|locate|google)\b/.test(t)) return 'Searching the web';
    if (/\b(generate|draw|render|image of|picture of)\b/.test(t)) return 'Painting image';
    if (/\b(design|ui|ux|layout|wireframe|mockup|prototype|preview)\b/.test(t)) return 'Designing screens';
    if (/\b(plan|roadmap|outline|architect)\b/.test(t)) return 'Planning';
    if (/\b(build|create|make|generate|write|scaffold|implement|add|set ?up|new|develop|code)\b/.test(t)) return 'Building';
    if (/\b(analyze|analyse|inspect|review|audit|check|examine|verify)\b/.test(t)) return 'Analyzing';
    if (/\b(refactor|improve|optimize|rewrite|simplify)\b/.test(t)) return 'Refactoring';
    if (/\b(test|unit test|integration)\b/.test(t)) return 'Running tests';
    if (/\b(sudo|root|admin|privilege)\b/.test(t)) return 'Elevating privileges';
    return 'Thinking';
  }

  /* ═══════════ Reasoning trace (built from what the user asked) ═══════════ */
  const LANG_WORDS = {
    lua: 'Lua', python: 'Python', py: 'Python', javascript: 'JavaScript', js: 'JavaScript',
    typescript: 'TypeScript', ts: 'TypeScript', html: 'HTML', css: 'CSS', java: 'Java',
    'c++': 'C++', cpp: 'C++', c: 'C', go: 'Go', rust: 'Rust', ruby: 'Ruby', php: 'PHP',
    bash: 'Bash', sql: 'SQL', swift: 'Swift', kotlin: 'Kotlin',
  };
  function detectLanguage(text) {
    const t = String(text || '').toLowerCase();
    for (const k of Object.keys(LANG_WORDS)) {
      if (new RegExp('\\b' + k.replace(/\+/g, '\\+') + '\\b').test(t)) return LANG_WORDS[k];
    }
    return null;
  }
  function buildThinkingSteps(text, files) {
    const raw = String(text || '').trim().replace(/\s+/g, ' ');
    const steps = [];
    const short = raw.length > 110 ? raw.slice(0, 110) + '…' : raw;
    if (raw) steps.push(`The user asked: "${short}"`);
    const lang = detectLanguage(raw);
    if (lang) steps.push(`They want this in ${lang}, so I'll write idiomatic ${lang} and keep the syntax exact.`);
    const t = raw.toLowerCase();
    if (/\b(build|create|make|write|code|script|app|game|site|page)\b/.test(t)) steps.push('Breaking the task into parts: structure, core logic, then how it runs or gets tested.');
    if (/\b(fix|bug|error|broken|crash|wrong|fail)\b/.test(t)) steps.push('Finding the root cause first, then checking the fix against the original behavior.');
    if (/\b(search|latest|news|current|today)\b/.test(t)) steps.push("This needs current information, so I'll check sources before answering.");
    if (/\b(explain|why|how does|what is)\b/.test(t)) steps.push('Explaining step by step with a small concrete example.');
    if (files && files.length) steps.push(`Reading the ${files.length} attached file${files.length === 1 ? '' : 's'} before answering.`);
    if (!steps.length) steps.push('Planning a clear, accurate answer.');
    return steps;
  }

  /* ═══════════ Modals ═══════════ */
  const openModal = (id) => { const el = document.getElementById(id); if (el) el.classList.add('open'); };
  const closeModal = (id) => { const el = document.getElementById(id); if (el) el.classList.remove('open'); };
  const openSidebar = () => { $('#sidebar')?.classList.add('open'); $('#sidebarScrim')?.classList.add('open'); };
  const closeSidebar = () => { $('#sidebar')?.classList.remove('open'); $('#sidebarScrim')?.classList.remove('open'); };

  /* ═══════════ Appearance ═══════════ */
  function applyAppearance(prefs) {
    const root = document.documentElement;
    const mode = prefs.mode || 'light';
    const theme = prefs.theme || 'default';
    root.setAttribute('data-mode', mode);
    root.setAttribute('data-theme', theme);
    safeSet(APPEARANCE_KEY, { mode, theme });
    $$('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $$('.swatch').forEach((b) => b.classList.toggle('active', b.dataset.theme === theme));
  }
  function loadAppearance() {
    const prefs = safeGet(APPEARANCE_KEY, {});
    if (!prefs.mode && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) prefs.mode = 'dark';
    applyAppearance(prefs);
  }

  /* ═══════════ Text cleanup for bridge replies ═══════════ */
  function stripBridgeTags(text) {
    if (!text) return '';
    let t = String(text);
    t = t.replace(/<bridge-designs>[\s\S]*?<\/bridge-designs>/g, '');
    t = t.replace(/<bridge-[a-z][a-z0-9-]*[^>]*>[\s\S]*?<\/bridge-[a-z][a-z0-9-]*>/g, '');
    t = t.replace(/<bridge-[a-z][a-z0-9-]*\s+[^>]*\/>/g, '');
    t = t.replace(/<\/?bridge-[a-z][a-z0-9-]*[^>]*>/g, '');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }
  function sanitizeForChat(text) {
    let t = stripBridgeTags(text);
    t = t.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]+`/g, '');
    t = t.replace(/\bDONE\b/g, '').replace(/\basking\(\s*\)/gi, '');
    return t.replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ═══════════ Markdown & highlighting ═══════════ */
  const HL_ALIASES = { html: 'xml', htm: 'xml', js: 'javascript', mjs: 'javascript', ts: 'typescript', py: 'python', python3: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', jsonc: 'json', cxx: 'cpp' };
  function highlightCode(lang, code) {
    const raw = String(code || '').replace(/\n$/, '');
    try {
      if (window.hljs) {
        const l = (HL_ALIASES[String(lang || '').toLowerCase()] || String(lang || '').toLowerCase()).trim();
        if (l && hljs.getLanguage && hljs.getLanguage(l)) return hljs.highlight(raw, { language: l }).value;
        return hljs.highlightAuto(raw).value;
      }
    } catch {}
    return escapeHtml(raw);
  }
  function renderMarkdown(rawText) {
    if (!rawText) return '';
    const src = stripBridgeTags(String(rawText));
    if (!src) return '';
    const parts = [];
    const re = /```([a-zA-Z0-9+#._-]*)\n?([\s\S]*?)```/g;
    let last = 0, m;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) parts.push({ type: 'text', content: src.slice(last, m.index) });
      parts.push({ type: 'code', lang: (m[1] || '').trim(), content: m[2], closed: true });
      last = re.lastIndex;
    }
    const rest = src.slice(last);
    const openM = rest.match(/```([a-zA-Z0-9+#._-]*)\n?([\s\S]*)$/);
    if (openM) {
      const before = rest.slice(0, openM.index);
      if (before) parts.push({ type: 'text', content: before });
      parts.push({ type: 'code', lang: (openM[1] || '').trim(), content: openM[2], closed: false });
    } else if (rest) parts.push({ type: 'text', content: rest });
    return parts.map((p) => p.type === 'code' ? renderCode(p.lang, p.content, p.closed) : renderText(p.content)).join('');
  }
  function renderCode(lang, code, closed) {
    const cleanLang = (lang || '').trim().toLowerCase();
    const label = (cleanLang || 'CODE').toUpperCase();
    const raw = String(code || '').replace(/\n$/, '');
    const btn = closed
      ? '<button class="code-action-btn" data-copy><i class="ri-file-copy-line"></i> Copy</button>'
      : '<span class="writing-tag"><i class="ri-loader-4-line spin"></i> writing…</span>';
    return `<div class="code-block"><div class="code-block-header"><span class="code-lang-label">${escapeHtml(label)}</span>${btn}</div><pre><code class="hljs">${highlightCode(cleanLang, raw)}</code></pre></div>`;
  }
  function renderText(text) {
    const lines = String(text).split('\n');
    let out = '';
    const buf = [];
    const flush = () => { if (buf.length) { out += `<p>${inlineFmt(buf.join(' '))}</p>`; buf.length = 0; } };
    const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((v) => v.trim());
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i], t = raw.trim();
      if (!t) { flush(); continue; }
      // GitHub-style Markdown table. Build safe HTML cell-by-cell (inlineFmt escapes input).
      if (t.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
        flush();
        const headers = cells(t); i += 1;
        let table = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
        headers.forEach((c) => { table += `<th>${inlineFmt(c)}</th>`; });
        table += '</tr></thead><tbody>';
        while (i + 1 < lines.length && lines[i + 1].trim().includes('|') && lines[i + 1].trim() !== '') {
          i++; const row = cells(lines[i]); table += '<tr>';
          for (let j = 0; j < headers.length; j++) table += `<td>${inlineFmt(row[j] || '')}</td>`;
          table += '</tr>';
        }
        out += table + '</tbody></table></div>';
        continue;
      }
      const hm = t.match(/^(#{1,4})\s+(.+)$/);
      if (hm) { flush(); out += `<h${hm[1].length}>${inlineFmt(hm[2])}</h${hm[1].length}>`; continue; }
      const um = t.match(/^[-*+]\s+(.+)$/);
      if (um) { flush(); out += `<div class="md-li">• ${inlineFmt(um[1])}</div>`; continue; }
      const om = t.match(/^(\d+)\.\s+(.+)$/);
      if (om) { flush(); out += `<div class="md-li">${om[1]}. ${inlineFmt(om[2])}</div>`; continue; }
      if (/^>\s?/.test(t)) { flush(); out += `<blockquote>${inlineFmt(t.replace(/^>\s?/, ''))}</blockquote>`; continue; }
      buf.push(t);
    }
    flush();
    return out;
  }
  function inlineFmt(t) {
    t = escapeHtml(t);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    return t;
  }
  function wireCopyButtons(scope) {
    (scope || document).querySelectorAll('.code-action-btn[data-copy]').forEach((btn) => {
      if (btn.__wired) return; btn.__wired = true;
      btn.onclick = async () => {
        const code = btn.closest('.code-block')?.querySelector('pre code')?.textContent || '';
        try {
          await navigator.clipboard.writeText(code);
          btn.innerHTML = '<i class="ri-check-line"></i> Copied';
          setTimeout(() => { btn.innerHTML = '<i class="ri-file-copy-line"></i> Copy'; }, 1200);
        } catch {}
      };
    });
  }

  /* ═══════════ Thinking panel: always ends (finish / fail / destroy) ═══════════ */
  function createThinkPanel(label, steps) {
    const el = document.createElement('div');
    el.className = 'think-wrap';
    el.innerHTML = `
      <div class="think-head">
        ${mascotHTML('mascot-sm', 'thinking')}
        <span class="think-label">${escapeHtml(label || 'Thinking')}</span>
        <span class="think-timer">0.0s</span>
        <button class="think-btn" data-think="min" type="button" title="Minimize"><i class="ri-subtract-line"></i></button>
        <button class="think-btn" data-think="max" type="button" title="Expand"><i class="ri-fullscreen-line"></i></button>
      </div>
      <div class="think-body"></div>`;
    const body = el.querySelector('.think-body');
    const timerEl = el.querySelector('.think-timer');
    const labelEl = el.querySelector('.think-label');
    const t0 = performance.now();
    let done = false, writeStep = null;
    const timer = setInterval(() => {
      if (done) { clearInterval(timer); return; }
      timerEl.textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's';
    }, 100);

    function addStep(text, state = 'info') {
      const row = document.createElement('div');
      row.className = 'think-step ' + state;
      const icon = state === 'run' ? '<i class="ri-loader-4-line spin"></i>'
        : state === 'ok' ? '<i class="ri-check-line"></i>'
        : state === 'warn' ? '<i class="ri-error-warning-line"></i>'
        : '<i class="ri-sparkling-2-line"></i>';
      row.innerHTML = `<span class="ts-icon">${icon}</span><span class="ts-text">${escapeHtml(text)}</span>`;
      body.appendChild(row);
      body.scrollTop = body.scrollHeight;
      return row;
    }
    function markStepDone(row) {
      if (!row) return;
      row.className = 'think-step ok';
      row.querySelector('.ts-icon').innerHTML = '<i class="ri-check-line"></i>';
    }
    if (Array.isArray(steps)) {
      steps.forEach((s) => {
        const r = document.createElement('div');
        r.className = 'think-reason';
        r.textContent = s;
        body.appendChild(r);
      });
    }
    el.querySelector('[data-think="min"]').addEventListener('click', () => el.classList.toggle('collapsed'));
    el.querySelector('[data-think="max"]').addEventListener('click', () => el.classList.toggle('expanded'));

    function close(finalLabel, mood) {
      if (done) return;
      done = true;
      clearInterval(timer);
      timerEl.textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's';
      labelEl.textContent = finalLabel;
      el.classList.add('done');
      setMascotMood(mood, el);
      setTimeout(() => el.classList.add('collapsed'), 1600);
    }
    return {
      el,
      addStep,
      setMood(mood) { setMascotMood(mood, el); },
      markWriting() { if (!writeStep) writeStep = addStep('Writing the answer…', 'run'); },
      finish() {
        if (writeStep) markStepDone(writeStep);
        body.querySelectorAll('.think-step.run').forEach(markStepDone);
        addStep('Done.', 'ok');
        close('Done', 'happy');
      },
      fail(msg) {
        body.querySelectorAll('.think-step.run').forEach((r) => {
          r.className = 'think-step warn';
          r.querySelector('.ts-icon').innerHTML = '<i class="ri-error-warning-line"></i>';
        });
        addStep(msg || 'Stopped with an error.', 'warn');
        close('Stopped', 'error');
      },
      destroy() { clearInterval(timer); if (!done) close('Stopped', 'idle'); },
    };
  }

  /* ═══════════ Conversations ═══════════ */
  function currentConvo() { return __conversations.find((c) => c.id === currentConversationId) || null; }
  function saveChats() {
    const slim = __conversations.map((c) => ({
      ...c,
      messages: (c.messages || []).map((m) => ({
        id: m.id, role: m.role, content: m.content, ts: m.ts,
        imageKey: m.imageKey || null,
        files: (m.files || []).map((f) => ({ name: f.name, size: f.size, type: f.type })),
      })),
    }));
    if (!safeSet(LS_KEY, slim)) {
      let copy = slim.slice();
      while (copy.length > 1 && !safeSet(LS_KEY, copy)) copy = copy.slice(0, -1);
    }
  }
  function loadChats() {
    const v = safeGet(LS_KEY, []);
    __conversations = Array.isArray(v) ? v : [];
  }

  function welcomeHTML() {
    return `<div class="welcome-screen">
      <div class="welcome-mascot">
        <div class="mascot mascot-lg m-idle" id="welcomeMascot" data-mood="idle">
          <span class="brow left"></span><span class="brow right"></span>
          <span class="eye left"></span><span class="eye right"></span>
          <span class="cheek left"></span><span class="cheek right"></span>
          <span class="mouth"></span><span class="prop"></span>
        </div>
        <div class="mascot-ring"></div>
        <div class="mascot-ring r2"></div>
      </div>
      <h1 class="welcome-title">Hi, I'm Mirox</h1>
      <p class="welcome-sub">Luna and Gen are unlimited and free. Try asking me to search the web, generate an image, or build a project with Bridge.</p>
      <div class="suggestion-grid">
        <button class="suggestion-card" type="button" data-prompt="Search the web for the latest AI news"><i class="ri-global-line"></i><span>Search the web for AI news</span></button>
        <button class="suggestion-card" type="button" data-prompt="Generate me an image of a cat"><i class="ri-image-line"></i><span>Generate me an image of a cat</span></button>
        <button class="suggestion-card" type="button" data-prompt="Open the Bridge workspace and scan my devices"><i class="ri-smartphone-line"></i><span>Scan my phone with Bridge</span></button>
        <button class="suggestion-card" type="button" data-prompt="Explain a concept simply"><i class="ri-lightbulb-line"></i><span>Explain a concept simply</span></button>
      </div>
    </div>`;
  }
  function startNewChat() {
    currentConversationId = null;
    const t = $('#chatTitle'); if (t) t.textContent = 'New chat';
    const c = $('#chatMessages'); if (c) c.innerHTML = welcomeHTML();
    bindSuggestionClicks(); updateTokenUsage();
    renderHistory(); updateTokenUsage();
  }
  function bindSuggestionClicks() {
    $$('.suggestion-card').forEach((card) => {
      if (card.__wired) return; card.__wired = true;
      card.onclick = () => {
        const p = card.dataset.prompt;
        if (p && p.startsWith('Open the Bridge workspace')) { openBridgeWorkspace(); return; }
        const inp = $('#messageInput');
        if (p && inp) { inp.value = p; updateSendButtonState(); handleSend(); }
      };
    });
  }

  function makeSnippet(text, q) {
    const s = String(text || '');
    const i = s.toLowerCase().indexOf(q);
    const start = Math.max(0, i - 30);
    return (start ? '…' : '') + s.slice(start, i + q.length + 50).replace(/\s+/g, ' ') + '…';
  }
  function renderHistory() {
    const list = $('#historyList'); if (!list) return;
    const q = __historyQuery.trim().toLowerCase();
    const snippets = {};
    let items = __conversations;
    if (q) {
      items = __conversations.filter((c) => {
        if ((c.title || '').toLowerCase().includes(q)) return true;
        const hit = (c.messages || []).find((m) => (m.content || '').toLowerCase().includes(q));
        if (hit) { snippets[c.id] = makeSnippet(hit.content, q); return true; }
        return false;
      });
    }
    if (!items.length) {
      list.innerHTML = `<li class="history-empty">${q ? 'No matches' : 'No conversations yet'}</li>`;
      return;
    }
    list.innerHTML = items.map((c, i) =>
      `<li class="history-item${c.id === currentConversationId ? ' active' : ''}" data-id="${c.id}" style="animation-delay:${Math.min(i * 25, 250)}ms">
        <i class="ri-chat-3-line"></i>
        <span class="history-title">${escapeHtml(c.title || 'Chat')}${snippets[c.id] ? `<span class="history-snippet">${escapeHtml(snippets[c.id])}</span>` : ''}</span>
        <button class="history-delete icon-btn" aria-label="Delete chat"><i class="ri-delete-bin-line"></i></button>
      </li>`).join('');
  }
  function estimateTokens(text) { return Math.ceil(String(text || '').length / 4); }
  function conversationTokenUsage(convo = currentConvo()) {
    if (!convo) return 0;
    return (convo.messages || []).reduce((sum, m) => sum + estimateTokens(m.content || ''), 0);
  }
  function updateTokenUsage() {
    const el = $('#tokenUsage'); if (!el) return;
    const used = conversationTokenUsage();
    const limit = __tier === 'free' ? FREE_CONVO_TOKEN_LIMIT : null;
    const span = el.querySelector('span');
    if (span) span.textContent = limit ? `${Math.min(used, limit).toLocaleString()} / 10k tokens` : `${used.toLocaleString()} tokens`;
    el.classList.toggle('token-near-limit', !!limit && used >= limit * .85);
    el.classList.toggle('token-limit', !!limit && used >= limit);
    el.title = limit ? `Estimated conversation usage. Free limit: ${limit.toLocaleString()} tokens.` : 'Estimated tokens used in this conversation';
  }
  function atChatBottom(c = $('#chatMessages')) { return !c || c.scrollHeight - c.scrollTop - c.clientHeight < 100; }
  function scrollToBottom(force = false) {
    const c = $('#chatMessages'); if (!c) return;
    if (force || (autoScrollEnabled && userIsAtBottom)) c.scrollTop = c.scrollHeight;
    updateScrollButton();
  }
  function updateScrollButton() {
    const c = $('#chatMessages'), b = $('#scrollBottomBtn'); if (!c || !b) return;
    b.classList.toggle('visible', !atChatBottom(c));
  }
  function freeLimitReached(convo = currentConvo()) {
    return __tier === 'free' && conversationTokenUsage(convo) >= FREE_CONVO_TOKEN_LIMIT;
  }
  function showLimitNote(bubble) {
    if (!bubble || bubble.querySelector('.token-limit-note')) return;
    const note = document.createElement('div'); note.className = 'token-limit-note';
    note.textContent = 'Max tokens length reached — try new chat or upgrade to Pro / Ultimate.';
    bubble.appendChild(note);
  }
  function attachContinueButton(msgEl, bubble, messageObj) {
    if (!msgEl || !bubble || !messageObj || bubble.querySelector('[data-continue]')) return;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'continue-response-btn'; btn.dataset.continue = '1';
    btn.innerHTML = '<i class="ri-play-circle-line"></i><span>Continue</span>';
    btn.addEventListener('click', () => continueAssistantMessage(msgEl, bubble, messageObj, btn));
    bubble.appendChild(btn);
  }
  async function continueAssistantMessage(msgEl, bubble, messageObj, btn) {
    if (isReplying || continuationBusy || freeLimitReached()) return;
    continuationBusy = true;
    btn.disabled = true; btn.innerHTML = '<i class="ri-loader-4-line spin"></i><span>Continuing…</span>';
    try {
      await sendToAPI('Continue your previous response from exactly where it stopped. Do not repeat the completed text. Continue in the same response.', [], false, { existingMsgEl: msgEl, existingBubble: bubble, messageObj, continuation: true });
    } finally {
      continuationBusy = false;
      if (btn.isConnected) btn.remove();
    }
  }
  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fileIconHTML() { return '<span class="file-glyph" aria-hidden="true"><i class="ri-file-text-line"></i></span>'; }

  function addMessageToDOM(role, content, ts, msgId, files, image) {
    const container = $('#chatMessages'); if (!container) return null;
    container.querySelector('.welcome-screen')?.remove();
    const id = msgId || uid();
    const el = document.createElement('div');
    el.className = 'message ' + (role === 'user' ? 'user' : 'ai');
    el.dataset.msgId = id;
    el.dataset.role = role;
    let inner = '';
    if (role === 'user' && files && files.length) {
      inner += '<div class="attach-row">';
      for (const f of files) {
        if (f.type === 'image' && f.dataUrl) inner += `<div class="attach-chip"><img src="${f.dataUrl}" alt="">${escapeHtml(f.name || '')}${f.size ? ` <span class="attach-size">${fmtSize(f.size)}</span>` : ''}</div>`;
        else inner += `<div class="attach-chip">${fileIconHTML()}${escapeHtml(f.name || 'file')}${f.size ? ` <span class="attach-size">${fmtSize(f.size)}</span>` : ''}</div>`;
      }
      inner += '</div>';
    }
    if (role === 'ai' && image) inner += `<div class="gen-image"><img src="${image}" draggable="false" alt=""></div>`;
    inner += '<div class="bubble-text"></div>';
    el.innerHTML = `<div class="bubble">${inner}</div>
      <div class="message-actions">
        <button class="action-btn" data-action="copy" aria-label="Copy"><i class="ri-file-copy-line"></i></button>
        ${role === 'ai' ? '<button class="action-btn" data-action="retry" aria-label="Retry"><i class="ri-refresh-line"></i></button>' : ''}
      </div>
      <div class="message-time">${ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</div>`;
    container.appendChild(el);
    const bt = el.querySelector('.bubble-text');
    if (role === 'user') {
      bt.textContent = content || '';
      if (!content) bt.style.display = 'none';
    } else if (content) {
      bt.innerHTML = renderMarkdown(content);
      wireCopyButtons(bt);
    }
    if (role === 'ai' && image) {
      const img = el.querySelector('.gen-image img');
      if (img) img.onclick = () => openImageViewer(image);
    }
    wireMessageActions(el);
    scrollToBottom();
    return el;
  }

  function wireMessageActions(el) {
    el.querySelectorAll('.action-btn').forEach((btn) => {
      if (btn.__wired) return; btn.__wired = true;
      btn.onclick = async () => {
        const action = btn.dataset.action;
        if (action === 'copy') {
          try {
            await navigator.clipboard.writeText(el.querySelector('.bubble')?.innerText || '');
            btn.innerHTML = '<i class="ri-check-line"></i>';
            setTimeout(() => { btn.innerHTML = '<i class="ri-file-copy-line"></i>'; }, 1200);
          } catch {}
        } else if (action === 'retry') {
          if (!isReplying) handleRetry(el);
        }
      };
    });
  }
  async function handleRetry(el) {
    if (isReplying) return;
    const convo = currentConvo(); if (!convo) return;
    const idx = (convo.messages || []).findIndex((m) => m.id === el.dataset.msgId);
    if (idx < 0) return;
    let userMsg = null;
    for (let i = idx - 1; i >= 0; i--) if (convo.messages[i].role === 'user') { userMsg = convo.messages[i]; break; }
    if (!userMsg) return;
    convo.messages = convo.messages.slice(0, idx);
    saveChats();
    let s = el.nextElementSibling;
    while (s) { const n = s.nextElementSibling; s.remove(); s = n; }
    el.remove();
    sendToAPI(userMsg.content, userMsg.files || []);
  }

  function updateSendButtonState() {
    const btn = $('#sendBtn'), inp = $('#messageInput');
    if (!btn || !inp) return;
    const enable = (inp.value.trim().length > 0 || pendingFiles.length > 0) && !isReplying;
    btn.classList.toggle('is-disabled', !enable);
    btn.setAttribute('aria-disabled', String(!enable));
  }

  function handleSend() {
    if (isReplying) return;
    const inp = $('#messageInput'); if (!inp) return;
    const text = inp.value.trim();
    if (!text && !pendingFiles.length) return;
    if (freeLimitReached()) { toast('Max tokens length reached — try new chat or upgrade to Pro / Ultimate.', 5000); updateTokenUsage(); return; }
    const files = pendingFiles.slice();
    const searchFlag = forceSearchNext;
    forceSearchNext = false;
    $('#searchModeBtn')?.classList.remove('active');
    if (!currentConversationId) {
      currentConversationId = uid();
      __conversations.unshift({ id: currentConversationId, title: text.slice(0, 60) || 'New chat', messages: [], created: Date.now() });
    }
    const msgId = uid();
    const convo = currentConvo();
    if (convo) convo.messages.push({ id: msgId, role: 'user', content: text, ts: Date.now(), files });
    addMessageToDOM('user', text, Date.now(), msgId, files);
    inp.value = '';
    inp.style.height = 'auto';
    pendingFiles = [];
    updatePreview();
    updateSendButtonState();
    saveChats();
    renderHistory(); updateTokenUsage();
    if (freeLimitReached(convo)) {
      const lastUserEl = $('#chatMessages')?.querySelector(`[data-msg-id="${msgId}"]`);
      showLimitNote(lastUserEl?.querySelector('.bubble'));
      saveChats(); toast('Max tokens length reached — try new chat or upgrade to Pro / Ultimate.', 5000);
      updateSendButtonState(); return;
    }
    sendToAPI(text, files, searchFlag);
  }

  async function sendToAPI(text, files, forceSearch, continuation = null) {
    const isContinuation = !!(continuation && continuation.continuation);
    const convoAtStart = currentConvo();
    if (!isContinuation && freeLimitReached(convoAtStart)) { toast('Max tokens length reached — try new chat or upgrade to Pro / Ultimate.', 5000); return; }
    isReplying = true;
    updateSendButtonState();
    const stopBtn = $('#stopBtn');
    if (stopBtn) stopBtn.style.display = 'grid';
    const convo = currentConvo();
    const history = convo ? convo.messages.slice(-14).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })) : [];
    const model = __model || 'mirox-luna-1.2';

    if (/\b(build|create|make|write|scaffold|generate|develop|code)\b.*\b(app|site|website|game|project|page|landing|dashboard|api|script|bot|tool|todo|chat|portfolio)\b/i.test(text)) {
      setTimeout(() => toast('Tip: open Bridge — it can write the files and run your project.', 4200), 400);
    }

    const container = $('#chatMessages');
    container?.querySelector('.welcome-screen')?.remove();

    let msgEl, bubble, bubbleText, timeEl, panel;
    const aiMsgId = isContinuation ? continuation.messageObj.id : uid();
    if (isContinuation) {
      msgEl = continuation.existingMsgEl;
      bubble = continuation.existingBubble;
      bubbleText = bubble.querySelector('.bubble-text');
      timeEl = msgEl.querySelector('.message-time');
      bubble.querySelector('[data-continue]')?.remove();
      bubble.querySelector('.token-limit-note')?.remove();
      // Do not insert another mascot/thinking card into the same assistant response.
      panel = { el: document.createElement('span'), addStep() {}, setMood() {}, markWriting() {}, finish() {}, fail() {}, destroy() {} };
      const prev = String(continuation.messageObj.content || '');
      var full = prev ? prev + '\n\n' : '';
    } else {
      msgEl = document.createElement('div');
      msgEl.className = 'message ai';
      msgEl.dataset.msgId = aiMsgId;
      msgEl.dataset.role = 'ai';
      panel = createThinkPanel(pickStatusLabel(text), buildThinkingSteps(text, files));
      panel.setMood(pickMoodFor(text));
      msgEl.appendChild(panel.el);
      timeEl = document.createElement('div'); timeEl.className = 'message-time';
      msgEl.appendChild(timeEl);
      container?.appendChild(msgEl);
      bubble = null; bubbleText = null; var full = '';
      scrollToBottom(true);
    }
    activeStreamController = new AbortController();
    let generatedImage = null, gotToken = !!isContinuation, limitHit = false;
    let renderTimer = null;
    const renderStreamText = () => {
      renderTimer = null;
      if (bubbleText) { bubbleText.innerHTML = renderMarkdown(full); wireCopyButtons(bubbleText); }
      scrollToBottom();
    };
    const scheduleRender = () => {
      const now = performance.now();
      if (renderTimer) return;
      renderTimer = setTimeout(renderStreamText, Math.max(50, 120 - (now - streamRenderAt)));
      streamRenderAt = now;
    };
    const streamTimeout = setTimeout(() => { try { activeStreamController?.abort(); } catch {} }, 90000);

    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          message: text, history, model, stream: true, files, search: !!forceSearch,
          bridge: __bridge.connected ? { connected: true, name: __bridge.name, model: __bridge.model, env: __bridge.env } : null,
        }),
        signal: activeStreamController.signal,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error?.message || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', searchStepAdded = false;

      const ensureBubble = () => {
        if (!bubble) {
          bubble = document.createElement('div');
          bubble.className = 'bubble';
          msgEl.insertBefore(bubble, timeEl);
        }
      };

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
          let o;
          try { o = JSON.parse(pl); } catch { continue; }

          if (o.search && o.search.query && !searchStepAdded) {
            searchStepAdded = true;
            panel.addStep(`Searching the web for "${o.search.query}"…`, 'run');
            panel.setMood('searching');
          }
          if (o.overview && o.overview.text) panel.addStep(`Overview from ${o.overview.source || 'web'} acquired`, 'ok');
          if (o.source && o.source.title) panel.addStep(`Source: ${o.source.title}`, 'ok');
          if (o.search_done) {
            panel.addStep(`Search finished — ${o.count || 0} result(s)`, 'ok');
            panel.setMood('reading');
          }
          if (o.p) {
            panel.addStep(`Connected to ${o.p} · generating…`, 'ok');
            panel.setMood('reasoning');
          }
          if (o.img) {
            generatedImage = o.img;
            panel.markWriting();
            panel.setMood('celebrate');
            ensureBubble();
            bubble.innerHTML = `<div class="gen-image"><img src="${o.img}" draggable="false" alt=""></div><div class="bubble-text"></div>`;
            bubbleText = bubble.querySelector('.bubble-text');
            const img = bubble.querySelector('img');
            if (img) img.onclick = () => openImageViewer(o.img);
            scrollToBottom();
            refreshUsage();
            continue;
          }
          if (o.d) {
            full += o.d;
            if (__tier === 'free' && convo && conversationTokenUsage(convo) + estimateTokens(full) >= FREE_CONVO_TOKEN_LIMIT) {
              full = full.slice(0, Math.max(0, (FREE_CONVO_TOKEN_LIMIT - conversationTokenUsage(convo)) * 4));
              limitHit = true;
              if (!gotToken) { gotToken = true; ensureBubble(); bubble.innerHTML = '<div class="bubble-text"></div>'; bubbleText = bubble.querySelector('.bubble-text'); }
              if (bubbleText) { bubbleText.innerHTML = renderMarkdown(full); }
              try { await reader.cancel(); } catch {}
              break;
            }
            if (!gotToken) {
              gotToken = true;
              panel.markWriting();
              panel.setMood('learning');
              ensureBubble();
              bubble.innerHTML = '<div class="bubble-text"></div>';
              bubbleText = bubble.querySelector('.bubble-text');
            }
            scheduleRender();
          }
          if (o.error) throw new Error(o.error.message || 'Stream error');
        }
        if (limitHit) break;
      }
      clearTimeout(streamTimeout);
      panel.finish();
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      if (bubbleText) { bubbleText.innerHTML = renderMarkdown(full); wireCopyButtons(bubbleText); }
      wireMessageActions(msgEl);

      let imageKey = null;
      if (generatedImage) {
        imageKey = 'img:' + aiMsgId;
        await idb.set(imageKey, generatedImage).catch(() => { imageKey = null; });
      }
      let savedMsg;
      if (convo) {
        if (isContinuation) {
          savedMsg = convo.messages.find((m) => m.id === aiMsgId) || continuation.messageObj;
          savedMsg.content = full; savedMsg.ts = Date.now(); if (imageKey) savedMsg.imageKey = imageKey;
        } else {
          savedMsg = { id: aiMsgId, role: 'assistant', content: full, ts: Date.now(), imageKey };
          convo.messages.push(savedMsg);
        }
      }
      saveChats(); updateTokenUsage();
      timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (savedMsg && full && !limitHit) attachContinueButton(msgEl, bubble, savedMsg);
      if (limitHit || freeLimitReached(convo)) showLimitNote(bubble);
      refreshUsage(); renderSidebarImageHistory();
    } catch (e) {
      clearTimeout(streamTimeout);
      const aborted = e.name === 'AbortError';
      panel.fail(aborted ? 'Stopped (timed out or by you).' : (e.message || 'Something went wrong.'));
      if (!bubble) {
        bubble = document.createElement('div'); bubble.className = 'bubble'; msgEl.insertBefore(bubble, timeEl);
      }
      if (full) {
        if (!bubbleText) { bubbleText = document.createElement('div'); bubbleText.className = 'bubble-text'; bubble.prepend(bubbleText); }
        bubbleText.innerHTML = renderMarkdown(full); wireCopyButtons(bubbleText);
        let savedMsg = convo?.messages.find((m) => m.id === aiMsgId);
        if (isContinuation && continuation.messageObj) savedMsg = continuation.messageObj;
        if (!savedMsg && convo) { savedMsg = { id: aiMsgId, role: 'assistant', content: full, ts: Date.now() }; convo.messages.push(savedMsg); }
        if (savedMsg) { savedMsg.content = full; saveChats(); attachContinueButton(msgEl, bubble, savedMsg); }
      } else bubble.textContent = aborted ? '(stopped)' : 'Error: ' + e.message;
      updateTokenUsage();
    } finally {
      clearTimeout(streamTimeout);
      panel.destroy();
      isReplying = false;
      activeStreamController = null;
      if (stopBtn) stopBtn.style.display = 'none';
      updateSendButtonState();
      updateTokenUsage();
    }
  }

  function stopStreaming() {
    if (activeStreamController) { try { activeStreamController.abort(); } catch {} activeStreamController = null; }
    isReplying = false;
    const s = $('#stopBtn'); if (s) s.style.display = 'none';
    updateSendButtonState();
  }

  /* ═══════════ Files & paste-as-attachment ═══════════ */
  function hasAttachment(name, size) { return pendingFiles.some((f) => f.name === name && f.size === size); }

  function readImageAsResizedDataUrl(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
            const ratio = Math.min(MAX_IMAGE_DIM / width, MAX_IMAGE_DIM / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }
          const c = document.createElement('canvas');
          c.width = width; c.height = height;
          c.getContext('2d').drawImage(img, 0, 0, width, height);
          try { resolve(c.toDataURL('image/jpeg', 0.85)); } catch { resolve(dataUrl); }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  function addTextAttachment(text, name) {
    const body = String(text).slice(0, 60000);
    const fname = name || ('pasted-' + new Date().toISOString().slice(11, 19).replace(/:/g, '-') + '.txt');
    if (pendingFiles.some((f) => f.type === 'text' && f.content === body)) { toast('attachment already added', 1800); return; }
    pendingFiles.push({ name: fname, size: text.length, type: 'text', content: body });
    updatePreview();
    updateSendButtonState();
    toast(`Large text added as attachment (${fmtSize(text.length)})`, 2200);
  }

  function handleFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const arr = [];
    for (const f of Array.from(fileList)) {
      if (hasAttachment(f.name, f.size) || arr.some((x) => x.name === f.name && x.size === f.size)) {
        toast('attachment already added', 1800);
        continue;
      }
      arr.push(f);
    }
    if (!arr.length) return;
    let done = 0;
    const newFiles = [];
    const finish = () => {
      newFiles.sort((a, b) => (a.order || 0) - (b.order || 0));
      for (const nf of newFiles) if (!hasAttachment(nf.name, nf.size)) pendingFiles.push(nf);
      updatePreview();
      updateSendButtonState();
    };
    arr.forEach((f, idx) => {
      const isImg = (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(f.name);
      const one = () => { done++; if (done === arr.length) finish(); };
      if (isImg) {
        readImageAsResizedDataUrl(f)
          .then((dataUrl) => { if (dataUrl) newFiles.push({ name: f.name, size: f.size, type: 'image', dataUrl, order: idx }); one(); })
          .catch(one);
      } else {
        const r = new FileReader();
        r.onload = () => { newFiles.push({ name: f.name, size: f.size, type: 'text', content: String(r.result).slice(0, 60000), order: idx }); one(); };
        r.onerror = one;
        r.readAsText(f);
      }
    });
  }

  function updatePreview() {
    const p = $('#attachmentPreview'), list = $('#attachmentList');
    if (!p || !list) return;
    if (!pendingFiles.length) { p.style.display = 'none'; list.innerHTML = ''; return; }
    p.style.display = 'flex';
    list.innerHTML = pendingFiles.map((f) => f.type === 'image' && f.dataUrl
      ? `<div class="attach-chip"><img src="${f.dataUrl}" alt="">${escapeHtml(f.name)}${f.size ? ` <span class="attach-size">${fmtSize(f.size)}</span>` : ''}</div>`
      : `<div class="attach-chip">${fileIconHTML()}${escapeHtml(f.name)}${f.size ? ` <span class="attach-size">${fmtSize(f.size)}</span>` : ''}</div>`
    ).join('');
  }

  /* ═══════════ Toast ═══════════ */
  function toast(msg, ms) {
    const t = document.createElement('div');
    t.className = 'mirox-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, ms || 1800);
  }

  /* ═══════════ Image viewer & history ═══════════ */
  function openImageViewer(url) {
    if (!url) return;
    __ivDataUrl = url;
    const iv = $('#imageViewer'); if (!iv) return;
    iv.classList.add('open');
    const img = new Image();
    img.onload = () => {
      const c = $('#ivCanvas'); if (!c) return;
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
    };
    img.src = url;
  }
  function closeImageViewer() { $('#imageViewer')?.classList.remove('open'); }

  async function fetchImageHistory() {
    const data = await jsonOr('/api/images/history', {}, null);
    return (data && Array.isArray(data.images)) ? data.images : [];
  }
  async function renderImageHistory() {
    const wrap = $('#imageHistory'); if (!wrap) return;
    wrap.innerHTML = '<div class="studio-empty">Loading…</div>';
    const items = await fetchImageHistory();
    if (!items.length) { wrap.innerHTML = '<div class="studio-empty">No images yet.</div>'; return; }
    wrap.innerHTML = items.map((it, i) => `
      <div class="image-history-item" data-idx="${i}" style="animation-delay:${Math.min(i * 30, 300)}ms">
        <img src="${it.image}" alt="" loading="lazy">
        <div class="image-history-prompt">${escapeHtml(it.prompt || '')}</div>
      </div>`).join('');
    wrap.querySelectorAll('.image-history-item').forEach((el) => {
      el.onclick = () => { const it = items[parseInt(el.dataset.idx, 10)]; if (it) openImageViewer(it.image); };
    });
  }
  async function renderSidebarImageHistory() {
    const wrap = $('#sidebarImageHistory'); if (!wrap) return;
    wrap.innerHTML = '<div class="sidebar-empty">Loading…</div>';
    const items = await fetchImageHistory();
    if (!items.length) { wrap.innerHTML = '<div class="sidebar-empty">No images yet.</div>'; return; }
    wrap.innerHTML = items.map((it, i) => `
      <div class="sidebar-image-item" data-idx="${i}" title="${escapeHtml(it.prompt || '')}" style="animation-delay:${Math.min(i * 30, 300)}ms">
        <img src="${it.image}" alt="" loading="lazy">
      </div>`).join('');
    wrap.querySelectorAll('.sidebar-image-item').forEach((el) => {
      el.onclick = () => { const it = items[parseInt(el.dataset.idx, 10)]; if (it) openImageViewer(it.image); };
    });
  }

  /* ═══════════ Model picker, credits, config ═══════════ */
  function getModelsList() { return __config?.models?.length ? __config.models : FALLBACK_MODELS; }
  function canUseModel(tier) {
    if (tier === 'free' || tier === 'ultimate') return true;
    return TIER_RANK[__tier] >= TIER_RANK[tier];
  }
  function renderModelPicker() {
    const menu = $('#modelPickerMenu'); if (!menu) return;
    const models = getModelsList();
    const cur = __model || models[0].id;
    menu.innerHTML = models.map((m) => {
      const usable = canUseModel(m.tier);
      return `<div class="model-option${m.id === cur ? ' active' : ''}${usable ? '' : ' locked'}" data-model-id="${m.id}" data-usable="${usable}">
        <span class="model-option-label"><span class="dot"></span>${escapeHtml(m.label)}</span></div>`;
    }).join('');
    menu.querySelectorAll('.model-option').forEach((opt) => {
      opt.onclick = (e) => {
        e.stopPropagation();
        if (opt.dataset.usable === 'false') { toast('Upgrade to use this model'); return; }
        selectModel(opt.dataset.modelId);
      };
    });
    const c = models.find((m) => m.id === cur);
    if (c) { const lbl = $('#currentModelLabel'); if (lbl) lbl.textContent = c.label; }
  }
  function selectModel(id) {
    if (!id) return;
    __model = id;
    const m = getModelsList().find((x) => x.id === id);
    if (m) { const lbl = $('#currentModelLabel'); if (lbl) lbl.textContent = m.label; }
    renderModelPicker();
    closeModelPicker();
  }
  function openModelPicker() { $('#modelPicker')?.classList.add('open'); $('#modelPickerMenu')?.classList.add('open'); }
  function closeModelPicker() { $('#modelPicker')?.classList.remove('open'); $('#modelPickerMenu')?.classList.remove('open'); }

  function renderCreditBar() {
    const bar = $('#creditBar'); if (!bar) return;
    if (!__usage || __tier !== 'free') { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    const setPill = (sel, used, limit) => {
      const pill = bar.querySelector(sel); if (!pill) return;
      const rem = Math.max(0, limit - used);
      const txt = pill.querySelector('span');
      if (txt) txt.textContent = `${rem}/${limit}`;
      pill.classList.toggle('low', rem <= Math.max(1, Math.floor(limit * 0.25)) && rem > 0);
      pill.classList.toggle('empty', rem <= 0);
    };
    setPill('[data-credit="vision"]', __usage.vision_used || 0, __usage.vision_limit || 10);
    setPill('[data-credit="image"]', __usage.image_used || 0, __usage.image_limit || 10);
    setPill('[data-credit="eclipse"]', __usage.eclipse_used || 0, __usage.eclipse_limit || 5);
  }

  /* Fetches /api/me. Never throws, never loops: a failure just means "guest". */
  async function refreshUsage() {
    const res = await jsonOr('/api/me', {}, null, 7000);
    if (!res || !res.user) {
      __user = null; __usage = null; __tier = 'free';
      renderCreditBar();
      const chip = $('#userChip');
      if (chip) {
        chip.querySelector('.user-name').textContent = 'Guest mode';
        chip.querySelector('.user-sub').textContent = 'Sign in to save chats';
      }
      renderModelPicker();
      return;
    }
    __user = res.user;
    __tier = res.user.tier || 'free';
    __usage = {
      vision_limit: res.user.vision_limit ?? 10, vision_used: res.user.vision_used ?? 0,
      image_limit: res.user.image_limit ?? 10, image_used: res.user.image_used ?? 0,
      eclipse_limit: res.user.eclipse_limit ?? 5, eclipse_used: res.user.eclipse_used ?? 0,
    };
    renderCreditBar();
    const chip = $('#userChip');
    if (chip) {
      chip.querySelector('.user-name').textContent = res.user.name || res.user.email;
      chip.querySelector('.user-sub').textContent = (__tier.charAt(0).toUpperCase() + __tier.slice(1)) + ' plan';
    }
    renderModelPicker(); updateTokenUsage();
  }

  async function loadConfig() {
    const data = await jsonOr('/api/config', {}, null, 7000);
    if (data && Array.isArray(data.models) && data.models.length) __config = data;
    if (!__config) __config = { models: FALLBACK_MODELS };
    __model = getModelsList()[0].id;
    renderModelPicker();
    const wrap = $('#emailLoginWrap');
    if (wrap && __config.email_login_available === false) wrap.style.display = 'none';
  }

  async function doLogin(e) {
    if (e) e.preventDefault();
    const name = $('#loginName')?.value.trim();
    const email = $('#loginEmail')?.value.trim().toLowerCase();
    if (!name || !email) return;
    const res = await jsonOr('/api/auth/simple-login', { method: 'POST', body: JSON.stringify({ name, email }) }, null);
    if (res && res.ok) {
      setToken(res.token || '');
      closeModal('loginModal');
      await refreshUsage();
      toast('Welcome, ' + name + '!');
    } else {
      toast(res?.error || 'Login failed', 2500);
    }
  }

  /* Loginment: one attempt per page load. If the callback fails, we stop
     instead of sending the user around the sign-in cycle again. */
  function doLoginment() {
    const tries = Number(sessionStorage.getItem('mirox_lm_tries') || 0);
    if (tries >= 2) {
      toast('Sign-in did not complete. Refresh the page and try once more, or use email login.', 4000);
      sessionStorage.removeItem('mirox_lm_tries');
      return;
    }
    sessionStorage.setItem('mirox_lm_tries', String(tries + 1));
    window.location.href = '/api/auth/loginment/start';
  }

  async function doLogout() {
    await jsonOr('/api/logout', { method: 'POST' }, null);
    setToken('');
    await refreshUsage();
    closeModal('settingsModal');
    toast('Signed out');
  }

  async function loadPlans() {
    const grid = $('#plansGrid'); if (!grid) return;
    grid.innerHTML = '<div class="studio-empty">Loading plans…</div>';
    const res = await jsonOr('/api/subscription/plans', {}, null);
    if (!res || !Array.isArray(res.plans)) { grid.innerHTML = '<div class="studio-empty">Could not load plans.</div>'; return; }
    grid.innerHTML = res.plans.map((p) => {
      const isCurrent = p.id === __tier;
      const price = p.id === 'free' ? '<div class="plan-price">Free</div>' : `<div class="plan-price">$${Number(p.price_usd).toFixed(2)}</div>`;
      return `<div class="plan-card${isCurrent ? ' current' : ''}">
        <div class="plan-name">${escapeHtml(p.label)}</div>
        <div class="plan-tagline">${escapeHtml(p.tagline || '')}</div>
        ${price}
        <ul class="plan-perks">${(p.perks || []).map((x) => `<li>✓ ${escapeHtml(x)}</li>`).join('')}</ul>
      </div>`;
    }).join('');
  }

  async function loadPersona() {
    if (!__user) return;
    const res = await jsonOr('/api/persona', {}, null);
    const inp = $('#personaInput');
    if (inp && res?.persona) inp.value = res.persona;
  }
  async function savePersona() {
    const status = $('#personaStatus');
    const set = (t, c) => { if (status) { status.textContent = t; status.className = 'persona-status ' + (c || ''); } };
    if (!__user) return set('Sign in first.', 'err');
    const inp = $('#personaInput'); if (!inp) return;
    set('Saving…');
    const res = await jsonOr('/api/persona', { method: 'POST', body: JSON.stringify({ persona: inp.value.trim() }) }, null);
    if (res && res.ok) { set('Saved ✓', 'ok'); setTimeout(() => set(''), 2000); }
    else set('Failed.', 'err');
  }

  async function genImage() {
    const prompt = $('#imagePrompt')?.value.trim();
    if (!prompt) { toast('Describe the image first.'); return; }
    const btn = $('#generateImageBtn'), result = $('#imageResult');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ri-loader-4-line spin"></i> Generating…'; }
    if (result) result.innerHTML = '<div class="studio-empty"><i class="ri-loader-4-line spin"></i> Painting your image…</div>';
    try {
      const res = await netFetch('/v1/images/generations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      }, 70000);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok && data.image) {
        if (result) {
          result.innerHTML = `<img src="${data.image}" alt="${escapeHtml(prompt)}">`;
          result.querySelector('img').onclick = () => openImageViewer(data.image);
        }
        refreshUsage();
        renderImageHistory();
        renderSidebarImageHistory();
      } else if (result) {
        result.innerHTML = `<div class="studio-error">Failed: ${escapeHtml(data.error?.message || data.error || 'Unknown')}</div>`;
      }
    } catch (e) {
      if (result) result.innerHTML = `<div class="studio-error">Error: ${escapeHtml(e.name === 'AbortError' ? 'Timed out' : e.message)}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ri-image-add-line"></i> Generate'; }
    }
  }

  /* ═══════════ Bridge: settings & status ═══════════ */
  function loadBridgeLS() {
    const b = safeGet(BRIDGE_KEY, {});
    __bridge = { ...__bridge, ...b, connected: false, baseUrl: null, env: null };
  }
  function saveBridgeLS() { safeSet(BRIDGE_KEY, { name: __bridge.name, model: __bridge.model, port: __bridge.port }); }
  function loadBridgeOpts() {
    const o = safeGet(BRIDGE_OPTS_KEY, {});
    if (typeof o.autoRun === 'boolean') __bridgeAutoRun = o.autoRun;
    if (typeof o.showCode === 'boolean') __bridgeShowCode = o.showCode;
  }
  function saveBridgeOpts() { safeSet(BRIDGE_OPTS_KEY, { autoRun: __bridgeAutoRun, showCode: __bridgeShowCode }); }
  function loadKdeDevice() {
    const v = safeGet(KDE_DEVICE_KEY, null);
    if (v && v.id && v.name) __kdeCurrentDevice = v;
  }
  function saveKdeDevice() {
    if (__kdeCurrentDevice) safeSet(KDE_DEVICE_KEY, __kdeCurrentDevice);
    else { try { localStorage.removeItem(KDE_DEVICE_KEY); } catch {} }
  }

  function renderBridgeStatus() {
    [['#bridgeStatus'], ['#bwStatusPill'], ['#bwStatusBox']].forEach(([sel]) => {
      const wrap = document.querySelector(sel); if (!wrap) return;
      const dot = wrap.querySelector('.bridge-status-dot');
      const txt = wrap.querySelector('span');
      if (dot) { dot.classList.toggle('online', __bridge.connected); dot.classList.toggle('offline', !__bridge.connected); }
      if (txt) txt.textContent = __bridge.connected ? 'Connected' : 'Disconnected';
    });
    const c = $('#bwConnectBtn'), d = $('#bwDisconnectBtn');
    if (c) c.style.display = __bridge.connected ? 'none' : 'flex';
    if (d) d.style.display = __bridge.connected ? 'flex' : 'none';
    updateBridgeSendBtn();
    renderSudoStatus();
    renderToggles();
  }
  function renderToggles() {
    $('#bwToggleAutoRun')?.classList.toggle('active', __bridgeAutoRun);
    $('#bwToggleShowCode')?.classList.toggle('active', __bridgeShowCode);
    const sb = $('#bwStopBtn'); if (sb) sb.style.display = bridgeRunning ? 'inline-flex' : 'none';
  }
  function renderSudoStatus() {
    const s = $('#bwSudoStatus'); if (!s) return;
    s.textContent = __sudoPassword ? (__sudoRemember ? 'Password saved (session)' : 'Password set (temporary)') : 'No password saved';
    s.style.color = __sudoPassword ? 'var(--success)' : '';
  }
  function renderKdeStatus() {
    const box = $('#bwKdeBox'), txt = $('#bwKdeStatus');
    if (!box || !txt) return;
    txt.textContent = __kdeAvailable ? 'KDE Connect ready' : 'KDE Connect: not installed';
    box.style.color = __kdeAvailable ? 'var(--success)' : 'var(--text-muted)';
    renderKdeDeviceList();
  }
  function renderKdeDeviceList() {
    const wrap = $('#bwDeviceList'); if (!wrap) return;
    if (!__kdeAvailable) { wrap.innerHTML = '<div class="bw-hint">Install on the bridge: <code>sudo apt install kdeconnect</code></div>'; return; }
    if (!__kdeDevices.length) { wrap.innerHTML = '<div class="bw-hint">No devices found. Tap <b>Scan for devices</b>.</div>'; return; }
    wrap.innerHTML = __kdeDevices.map((d) => `
      <div class="bw-device-row" data-id="${escapeHtml(d.id)}">
        <div class="bw-device-icon"><i class="ri-smartphone-line"></i></div>
        <div class="bw-device-info">
          <div class="bw-device-name">${escapeHtml(d.name)}</div>
          <div class="bw-device-id">${escapeHtml(d.id)}${d.reachable ? ' · reachable' : ''}</div>
        </div>
        <div class="bw-device-actions">
          <button class="icon-btn" data-kde-ping title="Ping"><i class="ri-wifi-line"></i></button>
          <button class="icon-btn" data-kde-ring title="Ring"><i class="ri-notification-3-line"></i></button>
          <button class="icon-btn" data-kde-pick title="Use this device"><i class="ri-check-line"></i></button>
        </div>
      </div>`).join('');
    wrap.querySelectorAll('.bw-device-row').forEach((row) => {
      const dev = __kdeDevices.find((x) => x.id === row.dataset.id);
      if (!dev) return;
      row.querySelector('[data-kde-pick]')?.addEventListener('click', () => {
        __kdeCurrentDevice = { id: dev.id, name: dev.name };
        saveKdeDevice(); renderKdeDeviceList();
        toast(`Selected: ${dev.name}`);
      });
      row.querySelector('[data-kde-ping]')?.addEventListener('click', async () => {
        toast(`Pinging ${dev.name}…`);
        try { const r = await bridgeCall('/kde/ping', { device: dev.id }); toast(r.ok ? `📱 ${dev.name} is online` : '✗ No response'); }
        catch { toast('Ping failed'); }
      });
      row.querySelector('[data-kde-ring]')?.addEventListener('click', async () => {
        toast(`Ringing ${dev.name}…`);
        try { await bridgeCall('/kde/ring', { device: dev.id }); } catch {}
      });
    });
  }

  /* Sudo modal */
  function showSudoModal(command) {
    return new Promise((resolve) => {
      __sudoResolver = resolve;
      const modal = $('#sudoModal'); if (!modal) { resolve(null); return; }
      $('#sudoCommandText') && ($('#sudoCommandText').textContent = command || '');
      const pwd = $('#sudoPasswordInput');
      if (pwd) { pwd.value = ''; pwd.type = 'password'; }
      const rev = $('#sudoRevealBtn'); if (rev) rev.innerHTML = '<i class="ri-eye-line"></i>';
      const hint = $('#sudoHint'); if (hint) { hint.textContent = ''; hint.className = 'sudo-hint'; }
      modal.classList.add('open');
      setTimeout(() => pwd?.focus(), 100);
    });
  }
  function closeSudoModal() { $('#sudoModal')?.classList.remove('open'); }
  function submitSudo() {
    const pwd = $('#sudoPasswordInput')?.value || '';
    const remember = !!$('#sudoRememberChk')?.checked;
    const hint = $('#sudoHint');
    if (!pwd) { if (hint) { hint.textContent = 'Enter your password.'; hint.className = 'sudo-hint err'; } return; }
    __sudoPassword = pwd;
    __sudoRemember = remember;
    closeSudoModal();
    renderSudoStatus();
    if (__sudoResolver) { __sudoResolver({ password: pwd, remember }); __sudoResolver = null; }
  }
  function skipSudo() {
    closeSudoModal();
    if (__sudoResolver) { __sudoResolver(null); __sudoResolver = null; }
  }
  function forgetSudo() {
    __sudoPassword = ''; __sudoRemember = false;
    renderSudoStatus();
    toast('Sudo password forgotten.');
  }
  async function askSudo(command) {
    if (__sudoPassword) return { password: __sudoPassword, remember: __sudoRemember, reused: true };
    return await showSudoModal(command);
  }

  /* ═══════════ Bridge: connection ═══════════ */
  async function testBridge(port) {
    for (const host of ['localhost', '127.0.0.1']) {
      try {
        const r = await netFetch(`http://${host}:${port}/ping`, { mode: 'cors' }, 4000);
        if (r.ok) {
          const d = await r.json();
          if (d && d.ok) return { ok: true, base: `http://${host}:${port}` };
        }
      } catch {}
    }
    return { ok: false };
  }
  async function fetchEnv(base) {
    try {
      const r = await netFetch(`${base}/env`, { mode: 'cors' }, 5000);
      if (!r.ok) return null;
      const d = await r.json();
      return d && d.ok ? d : null;
    } catch { return null; }
  }
  async function startBridge() {
    const name = ($('#bwNameInput')?.value || __bridge.name).trim() || 'My Laptop';
    const model = $('#bwModelSelect')?.value || __bridge.model;
    const port = parseInt($('#bwPortInput')?.value || __bridge.port, 10) || 8765;
    __bridge.name = name; __bridge.model = model; __bridge.port = port;
    saveBridgeLS();
    setBwHint('Connecting…', '');
    const res = await testBridge(port);
    if (res.ok) {
      __bridge.connected = true;
      __bridge.baseUrl = res.base;
      __bridge.env = await fetchEnv(res.base);
      __kdeAvailable = !!__bridge.env?.kde_connect_available;
      renderBridgeStatus();
      renderKdeStatus();
      $('#bridgeEmpty')?.remove();
      const home = __bridge.env?.home || '(unknown)';
      setBwHint(`Connected · Home: ${home}`, 'ok');
      addBridgeSystemMsg(`Connected. Home: ${home}`);
      if (__kdeAvailable) addBridgeSystemMsg('KDE Connect detected.');
    } else {
      __bridge.connected = false; __bridge.baseUrl = null; __bridge.env = null; __kdeAvailable = false;
      renderBridgeStatus();
      renderKdeStatus();
      setBwHint(`Could not reach the bridge on port ${port}. Is runner.py running?`, 'err');
    }
  }
  function stopBridge() {
    __bridge.connected = false; __bridge.baseUrl = null; __bridge.env = null;
    __sudoPassword = ''; __sudoRemember = false;
    __kdeAvailable = false; __kdeDevices = [];
    renderBridgeStatus(); renderKdeStatus(); setBwHint('', '');
  }
  async function bridgeCall(endpoint, payload) {
    if (!__bridge.connected || !__bridge.baseUrl) throw new Error('Bridge not connected');
    const r = await netFetch(__bridge.baseUrl + endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}), credentials: 'omit',
    }, 130000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }
  function downloadBridgeClient() {
    const params = new URLSearchParams({ name: __bridge.name, port: String(__bridge.port), model: __bridge.model });
    const a = document.createElement('a');
    a.href = '/api/bridge/download?' + params.toString();
    a.download = 'mirox_client_bridge.zip';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  function setBwHint(text, cls = '') {
    const el = $('#bwConnectHint'); if (!el) return;
    el.textContent = text;
    el.className = 'bw-hint' + (cls ? ' ' + cls : '');
  }
  function updateBridgeSendBtn() {
    const btn = $('#bridgeSendBtn'), inp = $('#bridgeInput');
    if (!btn || !inp) return;
    const enabled = __bridge.connected && !bridgeRunning && inp.value.trim().length > 0;
    btn.classList.toggle('is-disabled', !enabled);
    btn.setAttribute('aria-disabled', String(!enabled));
    renderToggles();
  }
  function openBridgeWorkspace() {
    $('#bridgeWorkspace')?.classList.add('open');
    document.body.style.overflow = 'hidden';
    if (!__bridge.connected) setTimeout(() => startBridge(), 50);
  }
  function closeBridgeWorkspace() {
    $('#bridgeWorkspace')?.classList.remove('open');
    $('#bwPanel')?.classList.remove('side-open');
    document.body.style.overflow = '';
  }
  function clearBridgeChat() {
    const m = $('#bridgeMessages'); if (m) m.innerHTML = '';
    bridgeConversation = []; bridgeQuestionCount = 0; bridgeProgress = 0; bridgeTurn = null;
    bridgeTaskComplete = true; bridgeWaitingForUser = false;
    __lastBuildFolder = null; __lastBuildWasMobile = false;
    if (bridgeAutoTimer) { clearTimeout(bridgeAutoTimer); bridgeAutoTimer = null; }
    updateBridgeProgress(0, 'Ready');
    const w = $('#bwProgress'); if (w) w.style.display = 'none';
    renderBuildStatus();
  }
  function scrollBridgeBottom() { const c = $('#bridgeMessages'); if (c) c.scrollTop = c.scrollHeight; }
  function renderBuildStatus() {
    const s = $('#bwBuildStatus'); if (!s) return;
    s.textContent = __lastBuildFolder || 'No project yet';
    s.style.color = __lastBuildFolder ? 'var(--success)' : '';
  }

  function addBridgeUserMsg(text) {
    const container = $('#bridgeMessages'); if (!container) return;
    $('#bridgeEmpty')?.remove();
    const el = document.createElement('div');
    el.className = 'bridge-msg user';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `<div class="bridge-bubble">${escapeHtml(text).replace(/\n/g, '<br>')}</div><div class="bridge-meta">You · ${time}</div>`;
    container.appendChild(el);
    scrollBridgeBottom();
  }
  function addBridgeAiMsg(text) {
    const clean = sanitizeForChat(text);
    if (!clean) return null;
    const container = $('#bridgeMessages'); if (!container) return null;
    $('#bridgeEmpty')?.remove();
    const el = document.createElement('div');
    el.className = 'bridge-msg ai';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `<div class="bridge-bubble">${escapeHtml(clean).replace(/\n/g, '<br>')}</div><div class="bridge-meta">Mirox · ${time}</div>`;
    container.appendChild(el);
    scrollBridgeBottom();
    return el;
  }
  function addBridgeSystemMsg(text) {
    const container = $('#bridgeMessages'); if (!container) return;
    $('#bridgeEmpty')?.remove();
    const el = document.createElement('div');
    el.className = 'bridge-msg system';
    el.innerHTML = `<div class="bridge-bubble">${escapeHtml(text)}</div>`;
    container.appendChild(el);
    scrollBridgeBottom();
  }
  function addBridgeSuccessMsg(text, extras) {
    const container = $('#bridgeMessages'); if (!container) return;
    const e = extras || {};
    let buttons = '';
    if (e.previewPath) buttons += `<button class="bridge-success-btn" data-preview="${escapeHtml(e.previewPath)}"><i class="ri-eye-line"></i> Preview</button>`;
    if (e.folder) buttons += `<button class="bridge-success-btn" data-copy-folder="${escapeHtml(e.folder)}"><i class="ri-folder-open-line"></i> Copy path</button>`;
    const el = document.createElement('div');
    el.className = 'bridge-msg ai';
    el.innerHTML = `<div class="bridge-success">
      <div class="bridge-success-head"><i class="ri-checkbox-circle-fill"></i><span>${escapeHtml(text)}</span></div>
      ${buttons ? `<div class="bridge-success-actions">${buttons}</div>` : ''}
    </div>`;
    el.querySelectorAll('[data-preview]').forEach((b) => { b.onclick = () => openPreview(b.dataset.preview); });
    el.querySelectorAll('[data-copy-folder]').forEach((b) => {
      b.onclick = async () => {
        try { await navigator.clipboard.writeText(b.dataset.copyFolder); toast('Path copied.'); } catch {}
      };
    });
    container.appendChild(el);
    scrollBridgeBottom();
  }
  function addBridgeThinkingPanel(label, steps) {
    const container = $('#bridgeMessages'); if (!container) return null;
    $('#bridgeEmpty')?.remove();
    const panel = createThinkPanel(label || 'Thinking', steps || []);
    panel.el.classList.add('bridge-think');
    container.appendChild(panel.el);
    scrollBridgeBottom();
    return panel;
  }
  function addBridgeActionBubble(cmd) {
    const container = $('#bridgeMessages'); if (!container) return null;
    const data = getActionData(cmd);
    const el = document.createElement('div');
    el.className = 'bridge-msg ai';
    el.innerHTML = `<div class="bridge-action">
      <div class="bridge-action-head">
        <div class="bridge-action-icon ${data.iconClass}"><i class="${data.icon}"></i></div>
        <div class="bridge-action-label">${data.label}</div>
        <span class="bridge-action-status working"><i class="ri-loader-4-line spin"></i> Working</span>
      </div>
      <div class="bridge-action-code" style="display:none;"></div>
    </div>`;
    container.appendChild(el);
    scrollBridgeBottom();
    return el;
  }
  function updateBridgeActionBubble(el, cmd, result) {
    if (!el) return;
    const status = el.querySelector('.bridge-action-status');
    if (!status) return;
    if (result && result.ok) { status.className = 'bridge-action-status ok'; status.innerHTML = '<i class="ri-check-line"></i> Done'; }
    else if (result && result.cancelled) { status.className = 'bridge-action-status err'; status.innerHTML = '<i class="ri-close-line"></i> Cancelled'; }
    else { status.className = 'bridge-action-status err'; status.innerHTML = '<i class="ri-close-line"></i> Failed'; }
    const codeWrap = el.querySelector('.bridge-action-code');
    if (codeWrap) {
      if (__bridgeShowCode && cmd.type === 'write' && typeof cmd.content === 'string') {
        codeWrap.style.display = 'block';
        codeWrap.innerHTML = `<pre><code>${escapeHtml(cmd.content.slice(0, 3000))}${cmd.content.length > 3000 ? '\n… (truncated)' : ''}</code></pre>`;
      } else {
        codeWrap.style.display = 'none';
        codeWrap.innerHTML = '';
      }
    }
    scrollBridgeBottom();
  }
  function getBaseName(p) {
    if (!p) return '';
    const parts = String(p).split('/');
    return parts[parts.length - 1] || p;
  }
  function getActionData(cmd) {
    const t = cmd.type;
    const base = getBaseName(cmd.path) || getBaseName(cmd.from) || '';
    const map = {
      'kde-list': ['ri-radar-line', 'list', 'Scanning devices'],
      'kde-refresh': ['ri-refresh-line', 'list', 'Refreshing'],
      'kde-ping': ['ri-wifi-line', 'exec', 'Pinging device'],
      'kde-ring': ['ri-notification-3-line', 'exec', 'Ringing device'],
      'kde-share-text': ['ri-file-text-line', 'write', 'Sharing text'],
      'kde-sms': ['ri-message-3-line', 'write', 'SMS'],
      'kde-lock': ['ri-lock-line', 'exec', 'Locking device'],
      'kde-notifications': ['ri-notification-badge-line', 'read', 'Notifications'],
      'kde-plugins': ['ri-puzzle-line', 'list', 'Plugins'],
      'kde-photo': ['ri-camera-lens-line', 'write', 'Photo'],
      'kde-myid': ['ri-fingerprint-line', 'read', 'Own ID'],
      sudo: ['ri-shield-keyhole-line', 'exec', 'sudo'],
      delete: ['ri-delete-bin-line', 'exec', `Deleting <code>${escapeHtml(base)}</code>`],
      move: ['ri-drag-move-line', 'exec', `Moving <code>${escapeHtml(base)}</code>`],
      copy: ['ri-file-copy-2-line', 'exec', `Copying <code>${escapeHtml(base)}</code>`],
      read: ['ri-file-text-line', 'read', `Reading <code>${escapeHtml(base)}</code>`],
      list: ['ri-folder-line', 'list', `Listing <code>${escapeHtml(base || cmd.path || '')}</code>`],
      sysinfo: ['ri-cpu-line', 'list', 'System info'],
      syscheck: ['ri-heart-pulse-line', 'list', 'Health check'],
      processes: ['ri-list-check-2', 'list', 'Processes'],
      email: ['ri-mail-send-line', 'write', 'Email'],
      http: ['ri-global-line', 'exec', 'HTTP'],
      clipboard: ['ri-clipboard-line', 'read', 'Clipboard'],
      screenshot: ['ri-screenshot-2-line', 'list', 'Screenshot'],
      pkgs: ['ri-archive-line', 'list', 'Packages'],
    };
    if (t === 'kde-share') return { icon: 'ri-send-plane-fill', iconClass: 'write', label: `Sending <code>${escapeHtml(getBaseName(cmd.path) || cmd.path || '')}</code>` };
    if (t === 'write') return { icon: 'ri-file-add-line', iconClass: 'write', label: `Writing <code>${escapeHtml(base)}</code>` };
    if (t === 'append') return { icon: 'ri-file-edit-line', iconClass: 'write', label: `Appending <code>${escapeHtml(base)}</code>` };
    if (t === 'git') return { icon: 'ri-git-branch-line', iconClass: 'exec', label: `Git ${escapeHtml(cmd.action || '')}` };
    if (map[t]) return { icon: map[t][0], iconClass: map[t][1], label: map[t][2] };
    if (t === 'exec') {
      const c = cmd.command || '';
      let friendly = 'Running command';
      if (/^npm\s+(install|i)/i.test(c)) friendly = 'Installing packages';
      else if (/^pip\s+install/i.test(c)) friendly = 'Installing Python packages';
      else if (/^mkdir/i.test(c)) friendly = 'Creating folder';
      else if (/^(ls|dir)\b/i.test(c)) friendly = 'Listing files';
      else if (/^(cat|type)\b/i.test(c)) friendly = 'Reading file';
      else if (/^(python|python3)\s/i.test(c)) friendly = 'Running Python';
      else if (/^lua\s/i.test(c)) friendly = 'Running Lua';
      else if (/^node\s/i.test(c)) friendly = 'Running Node';
      else if (/^git\s/i.test(c)) friendly = 'Git operation';
      else if (/^npm\s+run/i.test(c)) friendly = 'Running project';
      return { icon: 'ri-play-line', iconClass: 'exec', label: friendly };
    }
    return { icon: 'ri-terminal-line', iconClass: '', label: 'Working' };
  }

  function setProgressText(text) { const el = $('#bwProgressText'); if (el && text) el.textContent = text; }
  function updateBridgeProgress(pct, text) {
    const newPct = Math.max(0, Math.min(100, Math.round(pct)));
    if (newPct > bridgeProgress) bridgeProgress = newPct;
    const bar = $('#bwProgress'), fill = $('#bwProgressFill'), pctEl = $('#bwProgressPct');
    if (bar) bar.style.display = 'block';
    if (fill) { fill.style.width = bridgeProgress + '%'; fill.classList.toggle('done', bridgeProgress >= 100); }
    if (pctEl) { pctEl.textContent = bridgeProgress + '%'; pctEl.classList.toggle('done', bridgeProgress >= 100); }
    if (text) setProgressText(text);
  }

  /* ═══════════ Bridge: tag parsing ═══════════ */
  function extractBridgeCommands(text) {
    const cmds = [];
    const add = (type, mm, extra) => cmds.push(Object.assign({ type, index: mm.index }, extra));
    const rules = [
      [/<bridge-kde-refresh\s*\/>/g, 'kde-refresh', () => ({})],
      [/<bridge-kde-list(?:\s+available="([^"]*)")?\s*\/>/g, 'kde-list', (m) => ({ available: m[1] === 'true' })],
      [/<bridge-kde-ping\s+device="([^"]+)"(?:\s*\/>|>([\s\S]*?)<\/bridge-kde-ping>)/g, 'kde-ping', (m) => ({ device: m[1], message: (m[2] || '').trim() })],
      [/<bridge-kde-ring\s+device="([^"]+)"\s*\/>/g, 'kde-ring', (m) => ({ device: m[1] })],
      [/<bridge-kde-share\s+device="([^"]+)"\s+path="([^"]+)"\s*\/>/g, 'kde-share', (m) => ({ device: m[1], path: m[2] })],
      [/<bridge-kde-share-text\s+device="([^"]+)">([\s\S]*?)<\/bridge-kde-share-text>/g, 'kde-share-text', (m) => ({ device: m[1], text: m[2] })],
      [/<bridge-kde-sms\s+device="([^"]+)"\s+number="([^"]+)">([\s\S]*?)<\/bridge-kde-sms>/g, 'kde-sms', (m) => ({ device: m[1], number: m[2], message: m[3] })],
      [/<bridge-kde-lock\s+device="([^"]+)"\s*\/>/g, 'kde-lock', (m) => ({ device: m[1] })],
      [/<bridge-kde-notifications\s+device="([^"]+)"\s*\/>/g, 'kde-notifications', (m) => ({ device: m[1] })],
      [/<bridge-kde-plugins\s+device="([^"]+)"\s*\/>/g, 'kde-plugins', (m) => ({ device: m[1] })],
      [/<bridge-kde-photo\s+device="([^"]+)"(?:\s+path="([^"]*)")?\s*\/>/g, 'kde-photo', (m) => ({ device: m[1], path: m[2] || '' })],
      [/<bridge-kde-my-id\s*\/>/g, 'kde-myid', () => ({})],
      [/<bridge-sudo>([\s\S]*?)<\/bridge-sudo>/g, 'sudo', (m) => ({ command: m[1].trim() })],
      [/<bridge-exec>([\s\S]*?)<\/bridge-exec>/g, 'exec', (m) => ({ command: m[1].trim() })],
      [/<bridge-write\s+path="([^"]+)">([\s\S]*?)<\/bridge-write>/g, 'write', (m) => ({ path: m[1], content: m[2] })],
      [/<bridge-append\s+path="([^"]+)">([\s\S]*?)<\/bridge-append>/g, 'append', (m) => ({ path: m[1], content: m[2] })],
      [/<bridge-delete\s+path="([^"]+)"\s*\/>/g, 'delete', (m) => ({ path: m[1] })],
      [/<bridge-move\s+from="([^"]+)"\s+to="([^"]+)"\s*\/>/g, 'move', (m) => ({ from: m[1], to: m[2] })],
      [/<bridge-copy\s+from="([^"]+)"\s+to="([^"]+)"\s*\/>/g, 'copy', (m) => ({ from: m[1], to: m[2] })],
      [/<bridge-read\s+path="([^"]+)"\s*\/>/g, 'read', (m) => ({ path: m[1] })],
      [/<bridge-list\s+path="([^"]+)"\s*\/>/g, 'list', (m) => ({ path: m[1] })],
      [/<bridge-sysinfo\s*\/>/g, 'sysinfo', () => ({})],
      [/<bridge-syscheck\s*\/>/g, 'syscheck', () => ({})],
      [/<bridge-processes\s*\/>/g, 'processes', () => ({})],
      [/<bridge-email\s+to="([^"]+)"\s+subject="([^"]*)">([\s\S]*?)<\/bridge-email>/g, 'email', (m) => ({ to: m[1], subject: m[2], body: m[3] })],
      [/<bridge-http\s+url="([^"]+)"(?:\s+method="([^"]*)")?(?:\s*\/>|>([\s\S]*?)<\/bridge-http>)/g, 'http', (m) => ({ url: m[1], method: m[2] || 'GET', body: m[3] || '' })],
      [/<bridge-clipboard\s+action="(get|set)"(?:\s*>([\s\S]*?)<\/bridge-clipboard>|\s*\/>)/g, 'clipboard', (m) => ({ action: m[1], content: m[2] || '' })],
      [/<bridge-screenshot(?:\s+path="([^"]*)")?\s*\/>/g, 'screenshot', (m) => ({ path: m[1] || '' })],
      [/<bridge-git\s+action="([^"]+)"(?:\s+cwd="([^"]*)")?(?:\s+message="([^"]*)")?\s*\/>/g, 'git', (m) => ({ action: m[1], cwd: m[2] || '', message: m[3] || '' })],
      [/<bridge-pkgs\s+type="([^"]+)"(?:\s+cwd="([^"]*)")?\s*\/>/g, 'pkgs', (m) => ({ pkgType: m[1], cwd: m[2] || '' })],
    ];
    for (const [re, type, fn] of rules) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) add(type, m, fn(m));
    }
    cmds.sort((a, b) => a.index - b.index);
    return cmds;
  }
  function hasUnclosedWriteOrAppend(text) {
    const t = String(text || '');
    return (t.match(/<bridge-write\b/g) || []).length > (t.match(/<\/bridge-write>/g) || []).length
      || (t.match(/<bridge-append\b/g) || []).length > (t.match(/<\/bridge-append>/g) || []).length;
  }
  function lastWriteOrAppendPath(text) {
    const matches = [...String(text || '').matchAll(/<bridge-(?:write|append)\s+path="([^"]+)"/g)];
    return matches.length ? matches[matches.length - 1][1] : null;
  }
  function extractBridgeDesigns(text) {
    const m = /<bridge-designs>([\s\S]*?)<\/bridge-designs>/.exec(text);
    if (!m) return null;
    const designs = [];
    const re = /<design\s+id="(\d+)"(?:\s+name="([^"]*)")?\s*>([\s\S]*?)<\/design>/g;
    let mm;
    while ((mm = re.exec(m[1])) !== null) {
      designs.push({ id: parseInt(mm[1], 10), name: (mm[2] || ('Design ' + mm[1])).trim(), html: mm[3].trim() });
    }
    return designs.length ? designs : null;
  }
  function extractBridgeQuestions(text) {
    const qs = [];
    const re = /<bridge-ask>([\s\S]*?)<\/bridge-ask>/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const lines = m[1].trim().split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      const options = lines.slice(1).filter((l) => /^[-*]/.test(l)).map((l) => l.replace(/^[-*]\s*/, '').trim());
      qs.push({ question: lines[0], options });
    }
    return qs;
  }
  function looksLikeFreeQuestion(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (/(?:^|\n)\s*asking\(\s*\)/i.test(t)) return true;
    const stripped = t.replace(/\bDONE\b/i, '').trim();
    return !!stripped && /\?\s*$/.test(stripped) && !/<bridge-/.test(stripped);
  }
  function isEnvQuestion(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    const words = ['bridge environment', 'environment block', 'allowed dir', 'allowed path', 'which directory', 'what directory', 'which path', 'what path'];
    if (words.some((w) => q.includes(w))) return true;
    return q.includes('paste') && (q.includes('environment') || q.includes('bridge'));
  }
  function buildEnvBlockString() {
    const env = __bridge.env || {};
    const allowed = Array.isArray(env.allowed_dirs) && env.allowed_dirs.length ? env.allowed_dirs.join(', ') : '(none)';
    const home = env.home || '(unknown)';
    const cwd = env.cwd || home;
    const user = env.user || (home ? home.split('/').filter(Boolean).pop() : '(unknown)');
    return [
      '[Bridge environment]',
      `user=${user}`,
      `home=${home}`,
      `cwd=${cwd}`,
      `platform=${env.platform || '(unknown)'}`,
      `allowed_dirs=${allowed}`,
      `kdeConnect=${env.kde_connect_available ? 'true' : 'false'}`,
      __kdeCurrentDevice ? `currentKdeDevice=${__kdeCurrentDevice.id} name="${__kdeCurrentDevice.name}"` : '',
      '',
      `PATH RULE: every path must be absolute and start with ${home}/. Never write "." or "~".`,
      'CRITICAL:',
      '- Never paste code, CSS, HTML, or JS into your visible reply. All file content goes inside <bridge-write> or <bridge-append> tags.',
      '- Always close your tags.',
      '- For long files, write the first chunk with <bridge-write>, then add the rest with <bridge-append>.',
    ].filter(Boolean).join('\n');
  }
  function absBridgePath(p, home) {
    let s = String(p || '').trim().replace(/\\/g, '/');
    if (!home) return s;
    if (s === '' || s === '~' || s === '.' || s === './') return home;
    if (s.startsWith('~/')) return home + s.slice(1);
    if (s.startsWith('./')) return home + '/' + s.slice(2);
    if (!s.startsWith('/')) return home + '/' + s;
    return s;
  }

  /* ═══════════ Bridge: KDE Connect ═══════════ */
  async function kdeListDevices(availableOnly = false) {
    if (!__bridge.connected) throw new Error('Bridge not connected');
    const r = await bridgeCall('/kde/list', { available: !!availableOnly });
    if (r && r.devices) {
      __kdeDevices = r.devices;
      __kdeAvailable = !!r.installed;
      renderKdeStatus();
    }
    return r;
  }
  function askDeviceChoice(devices) {
    return new Promise((resolve) => {
      const modal = $('#kdeModal'), grid = $('#kdeGrid');
      if (!modal || !grid) { resolve(null); return; }
      __kdeResolver = resolve;
      grid.innerHTML = '';
      if (!devices || !devices.length) {
        grid.innerHTML = '<div class="kde-empty">No devices found.</div>';
      } else {
        devices.forEach((d, i) => {
          const card = document.createElement('div');
          card.className = 'kde-device-card' + (d.reachable ? ' reachable' : '');
          card.innerHTML = `
            <div class="kde-device-card-head">
              <div class="kde-device-card-icon"><i class="ri-smartphone-line"></i></div>
              <div class="kde-device-card-meta">
                <div class="kde-device-card-name">${escapeHtml(d.name)}</div>
                <div class="kde-device-card-id">${escapeHtml(d.id)}</div>
              </div>
              <div class="kde-device-card-num">${i + 1}</div>
            </div>
            <div class="kde-device-card-status ${d.reachable ? 'ok' : 'warn'}">${d.reachable ? '● reachable' : '○ not reachable'}</div>
            <button class="planner-choose-btn" type="button"><i class="ri-check-line"></i> Choose</button>`;
          grid.appendChild(card);
          card.querySelector('.planner-choose-btn').addEventListener('click', () => {
            __kdeCurrentDevice = { id: d.id, name: d.name };
            saveKdeDevice();
            renderKdeDeviceList();
            closeKdeModal();
            resolve({ id: d.id, name: d.name });
          });
        });
      }
      modal.classList.add('open');
    });
  }
  function closeKdeModal() { $('#kdeModal')?.classList.remove('open'); }
  function kdeSkip() {
    closeKdeModal();
    if (__kdeResolver) { __kdeResolver(null); __kdeResolver = null; }
  }
  async function refreshKdeDevices(showModal) {
    if (!__bridge.connected) return null;
    try { await bridgeCall('/kde/refresh', {}); } catch {}
    let r;
    try { r = await kdeListDevices(false); } catch { return null; }
    if (!r || !r.ok) return null;
    const devices = r.devices || [];
    if (!showModal) { renderKdeDeviceList(); return devices; }
    if (!devices.length) { await askDeviceChoice([]); return []; }
    const reachable = devices.filter((d) => d.reachable);
    if (reachable.length === 1) {
      __kdeCurrentDevice = { id: reachable[0].id, name: reachable[0].name };
      saveKdeDevice();
      renderKdeDeviceList();
      toast(`Using ${reachable[0].name}`);
      return devices;
    }
    const pick = await askDeviceChoice(devices);
    return pick ? devices : null;
  }

  /* ═══════════ Bridge: command execution ═══════════ */
  async function executeBridgeCommand(cmd) {
    const home = __bridge.env?.home || '';
    if (cmd.path) cmd.path = absBridgePath(cmd.path, home);
    if (cmd.from) cmd.from = absBridgePath(cmd.from, home);
    if (cmd.to) cmd.to = absBridgePath(cmd.to, home);

    const t = cmd.type;
    if (t.startsWith('kde-')) {
      if (!__kdeAvailable) return { ok: false, error: 'kdeconnect-cli not installed', install_hint: 'sudo apt install kdeconnect' };
      let deviceId = cmd.device || (__kdeCurrentDevice ? __kdeCurrentDevice.id : '');
      if (!deviceId && !['kde-refresh', 'kde-list', 'kde-myid'].includes(t)) {
        const devices = await kdeListDevices(false);
        if (devices && devices.devices && devices.devices.length) {
          const pick = await askDeviceChoice(devices.devices);
          if (pick) deviceId = pick.id;
        }
        if (!deviceId) return { ok: false, error: 'no device chosen', cancelled: true };
      }
      try {
        if (t === 'kde-refresh') return await bridgeCall('/kde/refresh', {});
        if (t === 'kde-list') {
          await bridgeCall('/kde/refresh', {});
          const r = await kdeListDevices(!!cmd.available);
          if (r && r.devices && r.devices.length && !__kdeCurrentDevice) {
            const pick = await askDeviceChoice(r.devices);
            if (pick) return { ok: true, devices: r.devices, chosen: pick };
          }
          return { ok: true, devices: r?.devices || [] };
        }
        if (t === 'kde-myid') return await bridgeCall('/kde/my-id', {});
        if (t === 'kde-ping') return await bridgeCall('/kde/ping', { device: deviceId, message: cmd.message || '' });
        if (t === 'kde-ring') return await bridgeCall('/kde/ring', { device: deviceId });
        if (t === 'kde-share') return await bridgeCall('/kde/share', { device: deviceId, path: cmd.path });
        if (t === 'kde-share-text') return await bridgeCall('/kde/share-text', { device: deviceId, text: cmd.text });
        if (t === 'kde-sms') return await bridgeCall('/kde/sms', { device: deviceId, number: cmd.number, message: cmd.message });
        if (t === 'kde-lock') return await bridgeCall('/kde/lock', { device: deviceId });
        if (t === 'kde-notifications') return await bridgeCall('/kde/notifications', { device: deviceId });
        if (t === 'kde-plugins') return await bridgeCall('/kde/plugins', { device: deviceId });
        if (t === 'kde-photo') return await bridgeCall('/kde/photo', { device: deviceId, path: cmd.path });
      } catch (e) { return { ok: false, error: e.message }; }
      return { ok: false, error: 'unknown kde command' };
    }
    if (t === 'sudo') {
      addBridgeSystemMsg(`Elevating for: ${cmd.command}`);
      const sudo = await askSudo(cmd.command);
      if (!sudo || !sudo.password) return { ok: false, error: 'cancelled', cancelled: true };
      try { return await bridgeCall('/sudo-exec', { command: cmd.command, password: sudo.password, timeout: 120 }); }
      catch (e) { return { ok: false, error: 'sudo failed: ' + e.message }; }
    }
    if (t === 'exec') {
      const rawCmd = String(cmd.command || '').trim();
      if (/(?:^|[\s&|;])sudo\b/.test(rawCmd) && !__sudoPassword) {
        const sudo = await askSudo(rawCmd);
        if (!sudo || !sudo.password) return { ok: false, error: 'cancelled', cancelled: true };
        return bridgeCall('/sudo-exec', { command: rawCmd, password: sudo.password, timeout: 120 });
      }
      return bridgeCall('/exec', { command: cmd.command });
    }
    const map = {
      write: ['/write', { path: cmd.path, content: cmd.content }],
      append: ['/append', { path: cmd.path, content: cmd.content }],
      delete: ['/delete', { path: cmd.path }],
      move: ['/move', { from: cmd.from, to: cmd.to }],
      copy: ['/copy', { from: cmd.from, to: cmd.to }],
      read: ['/read', { path: cmd.path }],
      list: ['/list', { path: cmd.path }],
      sysinfo: ['/sysinfo', {}],
      syscheck: ['/syscheck', {}],
      processes: ['/processes', {}],
      email: ['/email', { to: cmd.to, subject: cmd.subject, body: cmd.body }],
      http: ['/http', { url: cmd.url, method: cmd.method, body: cmd.body }],
      clipboard: ['/clipboard', { action: cmd.action, content: cmd.content }],
      screenshot: ['/screenshot', { path: cmd.path }],
      git: ['/git', { action: cmd.action, cwd: cmd.cwd, message: cmd.message }],
      pkgs: ['/pkgs', { type: cmd.pkgType, cwd: cmd.cwd }],
    };
    if (map[t]) return bridgeCall(map[t][0], map[t][1]);
    return { ok: false, error: 'Unknown command' };
  }

  function formatResultForAI(cmd, result) {
    if (!result || !result.ok) {
      const extra = result?.allowed_dirs ? `\nALLOWED: ${result.allowed_dirs.join(', ')}` : '';
      const hint = result?.install_hint ? `\nHINT: ${result.install_hint}` : '';
      return `[${cmd.type}] ERROR: ${(result && result.error) || 'unknown'}${extra}${hint}`;
    }
    const trunc = (s, n = 3000) => String(s || '').slice(0, n);
    if (cmd.type.startsWith('kde-')) {
      if (cmd.type === 'kde-list') {
        const list = (result.devices || []).map((d) => `${d.reachable ? '*' : ' '} ${d.name} (${d.id})`).join('\n');
        return `[kde-list] ${result.devices?.length || 0} device(s)\n${list}${result.chosen ? `\nCHOSEN: ${result.chosen.name} (${result.chosen.id})` : ''}`;
      }
      if (cmd.type === 'kde-ping') return `[kde-ping] ${result.online ? 'ONLINE' : 'OFFLINE'}`;
      if (cmd.type === 'kde-share') return `[kde-share] sent${result.was_dir ? ' (zipped)' : ''}`;
      if (cmd.type === 'kde-myid') return `[kde-my-id] ${result.id}`;
      return `[${cmd.type}] ok`;
    }
    switch (cmd.type) {
      case 'sudo':
      case 'exec': return `[exec] exit=${result.exit_code}\nSTDOUT:\n${trunc(result.stdout)}\nSTDERR:\n${trunc(result.stderr, 1500)}`;
      case 'write': return `[write] ok path=${result.path} bytes=${result.bytes}`;
      case 'append': return `[append] ok path=${result.path}`;
      case 'delete': return `[delete] ok path=${result.path}`;
      case 'move': return `[move] ${result.from} → ${result.to}`;
      case 'copy': return `[copy] ${result.from} → ${result.to}`;
      case 'read': return `[read] path=${result.path}\n${trunc(result.content)}`;
      case 'list': return `[list] path=${result.path}\n` + (result.items || []).map((i) => (i.is_dir ? 'D ' : 'F ') + i.name).join('\n');
      case 'sysinfo': return `[sysinfo] ${JSON.stringify(result, null, 2).slice(0, 2500)}`;
      case 'syscheck': return `[syscheck] ${JSON.stringify(result.check || {}, null, 2)}`;
      case 'processes': return `[processes] ${trunc(result.raw || '', 2500)}`;
      case 'email': return `[email] sent to ${result.sent_to}`;
      case 'http': return `[http] status=${result.status}\n${trunc(result.body, 2500)}`;
      case 'clipboard': return `[clipboard] ${cmd.action === 'get' ? 'content:\n' + trunc(result.content, 2000) : 'set ok'}`;
      case 'screenshot': return `[screenshot] saved to ${result.path}`;
      case 'git': return `[git ${cmd.action}] ${trunc(result.stdout, 2000)}\n${trunc(result.stderr, 800)}`;
      case 'pkgs': return `[pkgs ${cmd.pkgType}] ${trunc(result.raw, 2000)}`;
      default: return `[${cmd.type}] ok`;
    }
  }

  function cmdSignature(cmd) {
    const t = cmd.type;
    if (t === 'exec' || t === 'sudo') return t + ':' + cmd.command.trim();
    if (t === 'write' || t === 'append') return t + ':' + cmd.path + ':' + (cmd.content || '').length;
    if (t === 'delete') return 'delete:' + cmd.path;
    if (t === 'move' || t === 'copy') return t + ':' + cmd.from + '→' + cmd.to;
    if (t === 'read' || t === 'list') return t + ':' + cmd.path;
    if (t === 'email') return 'email:' + cmd.to + ':' + (cmd.subject || '');
    if (t === 'http') return 'http:' + cmd.method + ':' + cmd.url;
    if (t.startsWith('kde-')) return t + ':' + (cmd.device || '') + ':' + (cmd.path || cmd.text || cmd.number || '');
    return t + ':' + (cmd.path || cmd.action || cmd.pkgType || '');
  }
  function shouldBlockSignature(sig) {
    if (!bridgeTurn) return false;
    if (bridgeTurn.failedSignatures.has(sig)) return true;
    return (bridgeTurn.commandLog.get(sig) || 0) >= MAX_DUP_COMMANDS;
  }

  /* ═══════════ Bridge: questions & planner ═══════════ */
  function showBridgeQuestionModal(q, index, total) {
    return new Promise((resolve) => {
      __bqResolver = resolve;
      __bqSelected = null;
      const modal = $('#bridgeQuestionModal');
      if (!modal) { resolve(''); return; }
      $('#bqText').textContent = q.question || '';
      $('#bqCounter').textContent = `Question ${index} of ${total}`;
      $('#bqProgressFill').style.width = Math.round(((index - 1) / total) * 100) + '%';
      const optsWrap = $('#bqOptions');
      const cw = $('#bqCustomWrap');
      optsWrap.innerHTML = '';
      if (q.options && q.options.length) {
        cw.style.display = 'none';
        q.options.forEach((opt) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'question-option';
          b.textContent = opt;
          b.onclick = () => {
            __bqSelected = opt;
            optsWrap.querySelectorAll('.question-option').forEach((x) => x.classList.remove('selected'));
            b.classList.add('selected');
            $('#bqCustomInput').value = '';
          };
          optsWrap.appendChild(b);
        });
      } else {
        cw.style.display = 'block';
      }
      const ci = $('#bqCustomInput');
      ci.value = '';
      ci.oninput = () => {
        if (ci.value.trim()) {
          __bqSelected = null;
          optsWrap.querySelectorAll('.question-option').forEach((x) => x.classList.remove('selected'));
        }
      };
      modal.classList.add('open');
    });
  }
  function closeBridgeQuestionModal() { $('#bridgeQuestionModal')?.classList.remove('open'); }
  function submitBridgeQuestion() {
    const answer = $('#bqCustomInput')?.value.trim() || __bqSelected || '';
    if (!answer) return;
    closeBridgeQuestionModal();
    if (__bqResolver) { __bqResolver(answer); __bqResolver = null; }
  }
  function skipBridgeQuestion() {
    closeBridgeQuestionModal();
    if (__bqResolver) { __bqResolver('[Skipped by user]'); __bqResolver = null; }
  }

  function showPlannerModal(designs) {
    return new Promise((resolve) => {
      const modal = $('#plannerModal'), grid = $('#plannerGrid');
      if (!modal || !grid) { resolve(null); return; }
      grid.innerHTML = '';
      designs.slice(0, 3).forEach((d) => {
        const card = document.createElement('div');
        card.className = 'planner-card';
        const iframe = document.createElement('iframe');
        iframe.className = 'planner-preview';
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.setAttribute('loading', 'lazy');
        iframe.srcdoc = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;height:100%;overflow:auto;font-family:system-ui,sans-serif;background:#fff;color:#111}</style></head><body>' + d.html + '</body></html>';
        const footer = document.createElement('div');
        footer.className = 'planner-card-footer';
        footer.innerHTML = `
          <div class="planner-card-label"><span class="planner-card-dot"></span><span class="planner-card-name">${escapeHtml(d.name)}</span><span class="planner-card-id">Design ${d.id}</span></div>
          <button class="planner-choose-btn" type="button"><i class="ri-check-line"></i> Choose</button>`;
        card.appendChild(iframe);
        card.appendChild(footer);
        grid.appendChild(card);
        footer.querySelector('.planner-choose-btn').addEventListener('click', () => {
          closePlannerModal();
          resolve({ id: d.id, name: d.name });
        });
      });
      modal.classList.add('open');
    });
  }
  function closePlannerModal() { $('#plannerModal')?.classList.remove('open'); }
  function showPlannerModalPromise(designs) {
    return new Promise((resolve) => {
      __plannerResolver = resolve;
      showPlannerModal(designs).then((choice) => {
        if (__plannerResolver) { __plannerResolver(choice); __plannerResolver = null; }
      });
    });
  }
  function plannerSkip() {
    closePlannerModal();
    if (__plannerResolver) { __plannerResolver({ id: 0, name: 'Let Mirox decide' }); __plannerResolver = null; }
  }

  /* ═══════════ Bridge: verification & project summary ═══════════ */
  async function buildVerificationTable(paths) {
    const rows = [];
    for (const p of paths) {
      let exists = false, realPath = p, size = 0;
      try {
        const res = await bridgeCall('/read', { path: p });
        if (res && res.ok) { exists = true; realPath = res.path || p; size = (res.content || '').length; }
      } catch {}
      rows.push({ path: p, exists, realPath, size });
    }
    return rows;
  }
  function renderVerificationTable(rows) {
    const container = $('#bridgeMessages'); if (!container) return;
    const okCount = rows.filter((r) => r.exists).length;
    const allOk = okCount === rows.length;
    const header = allOk
      ? `<i class="ri-checkbox-circle-fill"></i> Verified · ${okCount}/${rows.length} files exist`
      : `<i class="ri-error-warning-fill"></i> Verification · ${okCount}/${rows.length} found`;
    const trs = rows.map((r, i) => `
      <tr class="${r.exists ? 'ok' : 'err'}">
        <td>${i + 1}</td>
        <td><code>${escapeHtml(r.realPath)}</code></td>
        <td>${r.exists ? '<span class="vt-ok">✓ exists</span>' : '<span class="vt-err">✗ missing</span>'}</td>
        <td>${r.exists ? r.size + ' B' : '—'}</td>
      </tr>`).join('');
    const el = document.createElement('div');
    el.className = 'bridge-msg ai';
    el.innerHTML = `
      <div class="verify-card ${allOk ? 'ok' : 'err'}">
        <div class="verify-header">${header}</div>
        <table class="verify-table">
          <thead><tr><th>#</th><th>File path</th><th>Status</th><th>Size</th></tr></thead>
          <tbody>${trs}</tbody>
        </table>
      </div>`;
    container.appendChild(el);
    scrollBridgeBottom();
  }
  function computeProjectRoot(paths, home) {
    if (!paths.length) return home || '';
    const norm = paths.map((p) => String(p).replace(/\\/g, '/'));
    let prefix = norm[0].split('/');
    for (const p of norm.slice(1)) {
      const parts = p.split('/');
      let i = 0;
      while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i++;
      prefix = prefix.slice(0, i);
    }
    const s = prefix.join('/');
    return s.endsWith('/') ? s.slice(0, -1) : s;
  }

  /* ═══════════ Bridge: AI loop ═══════════ */
  async function fetchBridgeReply(history) {
    const envBlock = buildEnvBlockString();
    const lastMsg = history[history.length - 1];
    const r = await netFetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `${envBlock}\n\n${lastMsg.content}`,
        history: history.slice(0, -1).map((h) => ({ role: h.role, content: h.content })),
        model: __bridge.model, stream: false,
        bridge: {
          connected: true, name: __bridge.name, model: __bridge.model, mode: 'developer', env: __bridge.env || {},
          kdeAvailable: __kdeAvailable, kdeDevice: __kdeCurrentDevice,
          filesWritten: bridgeTurn ? [...bridgeTurn.writtenFiles] : [],
          plannedFiles: bridgeTurn ? [...bridgeTurn.plannedFiles] : [],
          commandsRun: bridgeTurn ? bridgeTurn.commandsRun : 0,
        },
      }),
    }, 120000);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
    return data.reply || '';
  }
  async function autoContinueAfterDelay(label = 'Auto-continuing') {
    if (!__bridgeAutoRun) return;
    const secs = AUTO_CONTINUE_DELAY_MS / 1000;
    addBridgeSystemMsg(`${label} in ${secs}s…`);
    setProgressText(`${label} in ${secs}s…`);
    await sleep(AUTO_CONTINUE_DELAY_MS);
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function describeReplyPlan(reply, cmds) {
    const steps = [];
    const files = [...new Set(cmds.filter((c) => c.type === 'write' || c.type === 'append').map((c) => getBaseName(c.path)))];
    if (files.length) steps.push(`Writing ${files.length} file${files.length === 1 ? '' : 's'}: ${files.slice(0, 4).join(', ')}${files.length > 4 ? '…' : ''}`);
    cmds.filter((c) => c.type === 'exec' || c.type === 'sudo').forEach((c) => {
      steps.push(`Running: ${(c.command || '').split(/\s+/).slice(0, 4).join(' ')}`);
    });
    if (/\bDONE\b/i.test(reply)) steps.push('Checking that every planned file exists.');
    return steps;
  }

  function newTurnState() {
    return { runs: 0, plannedFiles: new Set(), writtenFiles: new Set(), commandLog: new Map(), failedSignatures: new Set(), commandsRun: 0 };
  }

  async function runBridgeTurn(userText, isResume = false) {
    if (!__bridge.connected) { setBwHint('Bridge is not connected.', 'err'); return; }
    if (bridgeRunning) return;
    bridgeRunning = true;
    bridgeAbort = false;
    if (bridgeAutoTimer) { clearTimeout(bridgeAutoTimer); bridgeAutoTimer = null; }
    updateBridgeSendBtn();

    if (!isResume) {
      bridgeQuestionCount = 0;
      bridgeTaskComplete = false;
      bridgeWaitingForUser = false;
      bridgeTurn = newTurnState();
      bridgeProgress = 0;
      updateBridgeProgress(2, 'Starting…');
      addBridgeUserMsg(userText);
      __lastBuildWasMobile = /\b(phone|mobile|tablet|android|iphone|ipad|device)\b/i.test(userText);
      const lang = detectLanguage(userText);
      bridgeConversation.push({
        role: 'user',
        content: `[System] Rules for this turn:
1. NEVER paste code into visible text. All file content goes inside <bridge-write>...</bridge-write> or <bridge-append>...</bridge-append>.
2. ALWAYS close tags.
3. Long files: write the first chunk with <bridge-write>, then add the rest with <bridge-append>.
4. Never ask the user to pick a plan for a small file. Just build it.
5. Create projects inside <home>/<project-name>/. Use absolute paths only.
6. Before writing code, think out loud in one or two short lines: what the user asked, the language${lang ? ' (' + lang + ')' : ''}, and the files you will create.
7. When the whole project is on disk, reply DONE on its own line.

${userText}`,
      });
    } else {
      setProgressText('Continuing…');
    }

    let iter = 0, autoContinues = 0;
    try {
      while (iter++ < MAX_BRIDGE_ITER) {
        if (bridgeAbort) { addBridgeSystemMsg('Stopped by user.'); break; }
        bridgeTurn.runs++;
        const lastUser = bridgeConversation.filter((h) => h.role === 'user').slice(-1)[0];
        const userLast = lastUser?.content || '';
        const thinking = addBridgeThinkingPanel(pickStatusLabel(userLast), buildThinkingSteps(userLast, []));
        thinking?.setMood(pickMoodFor(userLast));

        let reply = '';
        try {
          reply = await fetchBridgeReply(bridgeConversation);
          thinking?.finish();
        } catch (e) {
          thinking?.fail('AI error: ' + e.message);
          addBridgeSystemMsg('AI error: ' + e.message);
          break;
        }

        if (!reply || !reply.trim()) {
          if (autoContinues < MAX_AUTO_CONTINUES && __bridgeAutoRun) {
            autoContinues++;
            await autoContinueAfterDelay('Empty response — continuing');
            bridgeConversation.push({ role: 'user', content: '[System] Continue.' });
            continue;
          }
          break;
        }

        const designs = extractBridgeDesigns(reply);
        if (designs && designs.length) {
          const narration0 = sanitizeForChat(reply.replace(/<bridge-designs>[\s\S]*?<\/bridge-designs>/g, ''));
          if (narration0) addBridgeAiMsg(narration0);
          addBridgeSystemMsg('Showing 3 designs — pick one.');
          bridgeConversation.push({ role: 'assistant', content: reply });
          bridgeWaitingForUser = true;
          setProgressText('Waiting for your design…');
          const choice = await showPlannerModalPromise(designs);
          if (!choice) break;
          const choiceText = choice.id === 0 ? 'user_chosed(0)' : `user_chosed(${choice.id})  // ${choice.name}`;
          addBridgeUserMsg(choiceText);
          bridgeConversation.push({ role: 'user', content: choiceText });
          bridgeWaitingForUser = false;
          setProgressText('Building the chosen design…');
          continue;
        }

        const cmdsInReply = extractBridgeCommands(reply);
        const questionsInReply = extractBridgeQuestions(reply);
        const saidDone = /\bDONE\b/i.test(reply);
        const truncatedWrite = hasUnclosedWriteOrAppend(reply);
        const lastPath = lastWriteOrAppendPath(reply);

        const plan = describeReplyPlan(reply, cmdsInReply);
        if (plan.length) addBridgeThinkingPanel('Plan', plan)?.finish();

        if (!cmdsInReply.length && !questionsInReply.length && !saidDone && !truncatedWrite && looksLikeFreeQuestion(reply)) {
          const narrationQ = sanitizeForChat(reply);
          if (narrationQ) addBridgeAiMsg(narrationQ);
          addBridgeSystemMsg('Mirox is waiting for you — type your reply below.');
          bridgeConversation.push({ role: 'assistant', content: reply });
          bridgeWaitingForUser = true;
          bridgeTaskComplete = true;
          setProgressText('Waiting for your reply…');
          updateBridgeSendBtn();
          return;
        }

        const tp = bridgeTurn.plannedFiles.size;
        const dc = bridgeTurn.writtenFiles.size;
        if (tp > 0) updateBridgeProgress(2 + Math.round((dc / tp) * 93), `Files: ${dc} / ${tp}`);
        else updateBridgeProgress(Math.min(90, 5 + iter * 3), `Working… (step ${iter})`);

        const narration = sanitizeForChat(reply);
        if (narration) addBridgeAiMsg(narration);
        bridgeConversation.push({ role: 'assistant', content: reply });

        if (questionsInReply.length > 0 && !truncatedWrite) {
          const remaining = MAX_BRIDGE_QUESTIONS - bridgeQuestionCount;
          const toAsk = questionsInReply.slice(0, Math.max(0, remaining));
          for (let qi = 0; qi < toAsk.length; qi++) {
            const q = toAsk[qi];
            bridgeQuestionCount++;
            if (isEnvQuestion(q.question)) {
              const envBlock = buildEnvBlockString();
              addBridgeUserMsg(envBlock);
              bridgeConversation.push({ role: 'user', content: `[Answer]\n${envBlock}` });
              continue;
            }
            setProgressText('Waiting for your answer…');
            const answer = await showBridgeQuestionModal(q, qi + 1, toAsk.length);
            addBridgeUserMsg(answer);
            bridgeConversation.push({ role: 'user', content: `[Answer to "${q.question}"] ${answer}` });
          }
          if (toAsk.length) {
            bridgeConversation.push({ role: 'user', content: '[System] User answered. Continue.' });
            continue;
          }
        }

        if (cmdsInReply.length > 0) {
          const resultLines = [];
          for (const cmd of cmdsInReply) {
            if (bridgeAbort) { resultLines.push('[abort] user stopped'); break; }
            const sig = cmdSignature(cmd);
            if (shouldBlockSignature(sig)) { resultLines.push(`[${cmd.type}] BLOCKED (repeated or failed earlier)`); continue; }
            bridgeTurn.commandLog.set(sig, (bridgeTurn.commandLog.get(sig) || 0) + 1);
            bridgeTurn.commandsRun++;
            if (cmd.type === 'write' || cmd.type === 'append') bridgeTurn.plannedFiles.add(cmd.path);
            const bubble = addBridgeActionBubble(cmd);
            let result;
            try { result = await executeBridgeCommand(cmd); }
            catch (e) { result = { ok: false, error: e.message }; }
            updateBridgeActionBubble(bubble, cmd, result);
            if (result && result.ok) { if (cmd.type === 'write') bridgeTurn.writtenFiles.add(cmd.path); }
            else bridgeTurn.failedSignatures.add(sig);
            resultLines.push(formatResultForAI(cmd, result));
          }
          const tp2 = bridgeTurn.plannedFiles.size;
          const dc2 = bridgeTurn.writtenFiles.size;
          if (tp2 > 0) updateBridgeProgress(2 + Math.round((dc2 / tp2) * 93), `Files: ${dc2} / ${tp2}`);
          const env = __bridge.env || {};
          bridgeConversation.push({
            role: 'user',
            content: ['[Bridge environment]', `home=${env.home || '?'}`, `cwd=${env.cwd || '?'}`, `platform=${env.platform || '?'}`, `allowed_dirs=${(env.allowed_dirs || []).join(', ') || '(none)'}`, '', `[Progress] ${dc2}/${tp2 || '?'} files`, '[Results]', resultLines.join('\n\n'), 'Write inside allowed_dirs only. If done, reply DONE. Otherwise continue.'].join('\n'),
          });
          if (truncatedWrite && lastPath) {
            bridgeConversation.push({ role: 'user', content: `[System] Your previous reply was cut off mid-file (path="${lastPath}"). Continue with <bridge-append path="${lastPath}">...</bridge-append> and close the tag.` });
          }
          continue;
        }

        if (truncatedWrite) {
          if (__bridgeAutoRun && autoContinues < MAX_AUTO_CONTINUES) {
            autoContinues++;
            const p = lastPath || 'your file';
            setProgressText('Continuing the truncated file…');
            bridgeConversation.push({ role: 'user', content: `[System] Your last reply ended with an unclosed tag (path="${p}"). Continue from the last character with <bridge-append path="${p}"> and close it.` });
            continue;
          }
          addBridgeSystemMsg('File was truncated. Type "continue" to resume.');
          bridgeWaitingForUser = true;
          updateBridgeSendBtn();
          return;
        }

        const hasPlan = bridgeTurn.plannedFiles.size > 0;
        const allFilesWritten = hasPlan && bridgeTurn.writtenFiles.size >= bridgeTurn.plannedFiles.size;
        if (saidDone && (allFilesWritten || !hasPlan)) {
          updateBridgeProgress(99, 'Verifying…');
          const toVerify = [...bridgeTurn.writtenFiles];
          if (toVerify.length) {
            const rows = await buildVerificationTable(toVerify);
            renderVerificationTable(rows);
            const allOk = rows.every((r) => r.exists);
            const projRoot = computeProjectRoot(rows.map((r) => r.realPath), __bridge.env?.home || '');
            __lastBuildFolder = projRoot;
            const previewFile = rows.find((r) => /(^|\/)index\.html?$/i.test(r.realPath));
            __lastPreviewFile = previewFile ? previewFile.realPath : (rows[0]?.realPath || '');
            updateBridgeProgress(100, allOk ? 'Complete' : 'Complete with warnings');
            addBridgeSuccessMsg(
              allOk ? `Project complete · ${rows.length} file${rows.length === 1 ? '' : 's'} · ${projRoot}` : `Finished · ${rows.filter((r) => r.exists).length}/${rows.length} verified`,
              { folder: projRoot, previewPath: __lastPreviewFile || '' }
            );
            renderBuildStatus();
            if (__lastBuildWasMobile && __kdeAvailable && projRoot) {
              const sent = await offerKdeSend(projRoot);
              if (sent) addBridgeSuccessMsg(`Sent to ${sent.name}`);
            }
            if (__lastPreviewFile && /\.html?$/i.test(__lastPreviewFile)) setTimeout(() => openPreview(__lastPreviewFile), 400);
          } else {
            updateBridgeProgress(100, 'Complete');
            addBridgeSuccessMsg('Task complete');
          }
          bridgeTaskComplete = true;
          break;
        }
        if (saidDone && hasPlan && !allFilesWritten) {
          const missing = [...bridgeTurn.plannedFiles].filter((f) => !bridgeTurn.writtenFiles.has(f));
          bridgeConversation.push({ role: 'user', content: `[System] Missing: ${missing.join(', ')}. Write them now.` });
          continue;
        }

        if (!saidDone) {
          if (__bridgeAutoRun && autoContinues < MAX_AUTO_CONTINUES) {
            autoContinues++;
            await autoContinueAfterDelay('Auto-continuing');
            bridgeConversation.push({ role: 'user', content: '[System] Continue. Output the next actions.' });
            continue;
          }
          if (!__bridgeAutoRun) {
            bridgeWaitingForUser = true;
            addBridgeSystemMsg('Auto-Run is off — click Send to continue.');
            updateBridgeSendBtn();
            break;
          }
          addBridgeSystemMsg('Iteration limit reached. Type "continue" to keep going.');
          break;
        }
      }
    } catch (e) {
      addBridgeSystemMsg('Bridge error: ' + e.message);
    } finally {
      bridgeRunning = false;
      updateBridgeSendBtn();
      setProgressText(bridgeTaskComplete ? 'Done' : 'Paused');
    }
  }

  async function offerKdeSend(path) {
    if (!__kdeAvailable) return null;
    let device = __kdeCurrentDevice;
    if (!device) {
      const devices = await kdeListDevices(false);
      const list = devices?.devices || [];
      if (list.length === 1) { device = { id: list[0].id, name: list[0].name }; __kdeCurrentDevice = device; saveKdeDevice(); }
      else if (list.length > 1) { const pick = await askDeviceChoice(list); if (!pick) return null; device = pick; }
      else return null;
    }
    const bubble = addBridgeActionBubble({ type: 'kde-share', path });
    try {
      const r = await bridgeCall('/kde/share', { device: device.id, path });
      updateBridgeActionBubble(bubble, { type: 'kde-share' }, r);
      return r.ok ? device : null;
    } catch (e) {
      updateBridgeActionBubble(bubble, { type: 'kde-share' }, { ok: false, error: e.message });
      return null;
    }
  }

  function handleBridgeSend() {
    const inp = $('#bridgeInput'); if (!inp) return;
    const text = inp.value.trim();
    if (!text || bridgeRunning || !__bridge.connected) return;
    if (bridgeWaitingForUser) {
      bridgeWaitingForUser = false;
      if (!bridgeTurn) bridgeTurn = newTurnState();
    } else {
      bridgeConversation = [];
      bridgeTaskComplete = true;
      if (bridgeAutoTimer) { clearTimeout(bridgeAutoTimer); bridgeAutoTimer = null; }
      bridgeTurn = null;
    }
    inp.value = '';
    inp.style.height = 'auto';
    updateBridgeSendBtn();
    runBridgeTurn(text, false);
  }

  /* ═══════════ Preview ═══════════ */
  async function openPreview(pathOrEmpty) {
    const modal = $('#bwPreviewModal'); if (!modal) return;
    const frame = $('#bwPreviewFrame');
    const subtitle = $('#bwPreviewSubtitle');
    const pathInput = $('#bwPreviewPath');
    modal.classList.add('open');
    const targetPath = absBridgePath(pathOrEmpty || pathInput?.value.trim() || __lastPreviewFile || '', __bridge.env?.home || '');
    if (pathInput) pathInput.value = targetPath;
    if (!targetPath) {
      if (subtitle) subtitle.textContent = 'No file path yet.';
      if (frame) frame.srcdoc = '<html><body style="font-family:system-ui;padding:40px;color:#888;text-align:center"><h2>No preview</h2><p>Build a project, or type an absolute path to an .html file.</p></body></html>';
      return;
    }
    if (subtitle) subtitle.textContent = targetPath;
    try {
      const r = await bridgeCall('/read', { path: targetPath });
      if (!r || !r.ok) throw new Error(r?.error || 'could not read file');
      let html = r.content || '';
      const baseDir = targetPath.replace(/\/[^/]*$/, '');
      for (const m of [...html.matchAll(/<link\s+[^>]*href=["']([^"']+\.css[^"']*)["'][^>]*>/gi)]) {
        if (/^https?:/i.test(m[1])) continue;
        const cssPath = m[1].startsWith('/') ? m[1] : `${baseDir}/${m[1]}`.replace(/\/\.\//g, '/');
        try { const cr = await bridgeCall('/read', { path: cssPath }); if (cr && cr.ok) html = html.replace(m[0], `<style>\n${cr.content}\n</style>`); } catch {}
      }
      for (const m of [...html.matchAll(/<script\s+[^>]*src=["']([^"']+\.js[^"']*)["'][^>]*>\s*<\/script>/gi)]) {
        if (/^https?:/i.test(m[1])) continue;
        const jsPath = m[1].startsWith('/') ? m[1] : `${baseDir}/${m[1]}`.replace(/\/\.\//g, '/');
        try { const jr = await bridgeCall('/read', { path: jsPath }); if (jr && jr.ok) html = html.replace(m[0], `<script>\n${jr.content}\n</script>`); } catch {}
      }
      if (frame) frame.srcdoc = html;
    } catch (e) {
      if (frame) frame.srcdoc = `<html><body style="font-family:system-ui;padding:40px;color:#b91c1c"><h2>Preview failed</h2><p>${escapeHtml(e.message)}</p></body></html>`;
    }
  }
  function closePreview() { $('#bwPreviewModal')?.classList.remove('open'); }

  /* ═══════════ Open a saved chat ═══════════ */
  async function openConversation(id) {
    const convo = __conversations.find((c) => c.id === id);
    if (!convo) return;
    currentConversationId = id;
    updateTokenUsage();
    const t = $('#chatTitle'); if (t) t.textContent = convo.title || 'Chat';
    const c = $('#chatMessages'); if (c) c.innerHTML = '';
    let lastAiEl = null, lastAiMessage = null;
    for (const m of convo.messages || []) {
      const img = m.imageKey ? await idb.get(m.imageKey).catch(() => null) : null;
      const rendered = addMessageToDOM(m.role, m.content, m.ts, m.id, m.files || [], img);
      if (m.role === 'assistant') { lastAiEl = rendered; lastAiMessage = m; }
    }
    if (lastAiEl && lastAiMessage) {
      const lastBubble = lastAiEl.querySelector('.bubble');
      if (freeLimitReached(convo)) showLimitNote(lastBubble);
      else if (lastBubble) attachContinueButton(lastAiEl, lastBubble, lastAiMessage);
    }
    renderHistory(); updateTokenUsage();
    scrollToBottom(true);
  }

  /* ═══════════ Wiring ═══════════ */
  function wireAll() {
    on('#hamburgerBtn', 'click', openSidebar);
    on('#sidebarCloseBtn', 'click', closeSidebar);
    on('#sidebarScrim', 'click', closeSidebar);
    on('#brandLogo', 'click', (e) => { e.preventDefault(); startNewChat(); if (window.innerWidth <= 860) closeSidebar(); });
    on('#newChatBtn', 'click', () => { startNewChat(); if (window.innerWidth <= 860) closeSidebar(); });

    $$('.sidebar-tab').forEach((tab) => {
      tab.onclick = () => {
        const t = tab.dataset.tab;
        $$('.sidebar-tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === t));
        $$('.sidebar-section').forEach((s) => { s.style.display = s.dataset.pane === t ? '' : 'none'; });
        if (t === 'images') renderSidebarImageHistory();
      };
    });

    on('#historyList', 'click', (e) => {
      const item = e.target.closest('.history-item');
      if (!item) return;
      const id = item.dataset.id;
      if (e.target.closest('.history-delete')) {
        __conversations = __conversations.filter((c) => c.id !== id);
        if (currentConversationId === id) startNewChat();
        saveChats();
        renderHistory();
        return;
      }
      openConversation(id);
      if (window.innerWidth <= 860) closeSidebar();
    });

    $('#historySearch')?.addEventListener('input', (e) => { __historyQuery = e.target.value; renderHistory(); });

    const inp = $('#messageInput');
    if (inp) {
      inp.addEventListener('input', () => {
        inp.style.height = 'auto';
        inp.style.height = Math.min(inp.scrollHeight, 180) + 'px';
        updateSendButtonState();
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleSend(); }
      });
      inp.addEventListener('paste', (e) => {
        const text = e.clipboardData?.getData('text/plain') || '';
        if (text.length > PASTE_ATTACH_THRESHOLD) { e.preventDefault(); addTextAttachment(text); }
      });
    }
    on('#sendBtn', 'click', handleSend);
  on('#scrollBottomBtn', 'click', () => { autoScrollEnabled = true; userIsAtBottom = true; scrollToBottom(true); });
  on('#chatMessages', 'scroll', () => {
    const c = $('#chatMessages'); userIsAtBottom = atChatBottom(c);
    if (!userIsAtBottom) autoScrollEnabled = false;
    else autoScrollEnabled = true;
    updateScrollButton();
  });
    on('#attachBtn', 'click', () => $('#fileInput')?.click());
    on('#fileInput', 'change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
    on('#removeAttachmentBtn', 'click', () => { pendingFiles = []; updatePreview(); updateSendButtonState(); });
    on('#stopBtn', 'click', stopStreaming);
    on('#modelPickerBtn', 'click', (e) => {
      e.stopPropagation();
      if ($('#modelPickerMenu')?.classList.contains('open')) closeModelPicker(); else openModelPicker();
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('#modelPicker')) closeModelPicker(); });

    on('#searchModeBtn', 'click', (e) => {
      e.preventDefault();
      forceSearchNext = !forceSearchNext;
      $('#searchModeBtn')?.classList.toggle('active', forceSearchNext);
      toast(forceSearchNext ? 'Web search enabled for next message.' : 'Web search disabled.');
      const ta = $('#messageInput');
      if (ta) {
        ta.placeholder = forceSearchNext ? 'What should I search the web for?' : 'How can I help you today? (paste big text → becomes an attachment)';
        ta.focus();
      }
    });

    on('#imageModeBtn', 'click', () => { openModal('imageModal'); renderImageHistory(); });
    on('#plansModeBtn', 'click', () => { openModal('plansModal'); loadPlans(); });
    on('#supportModeBtn', 'click', (e) => { e.preventDefault(); openModal('supportModal'); });
    on('#supportModeBtn2', 'click', () => openModal('supportModal'));
    on('#bridgeModeBtn', 'click', openBridgeWorkspace);
    on('#bridgeOpenBtn', 'click', openBridgeWorkspace);
    on('#generateImageBtn', 'click', genImage);
    on('#submitReportBtn', 'click', () => { toast('Ticket submitted!'); closeModal('supportModal'); });
    on('#settingsBtn', 'click', (e) => { e.preventDefault(); openModal('settingsModal'); loadPersona(); });
    on('#logoutBtn', 'click', doLogout);
    on('#savePersonaBtn', 'click', savePersona);
    on('#loginmentBtn', 'click', doLoginment);

    $$('.settings-tab').forEach((tab) => {
      tab.onclick = () => {
        const t = tab.dataset.tab;
        $$('.settings-tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === t));
        $$('.settings-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === t));
      };
    });
    $$('[data-mode]').forEach((b) => { b.onclick = () => applyAppearance({ mode: b.dataset.mode, theme: document.documentElement.getAttribute('data-theme') || 'default' }); });
    $$('.swatch').forEach((b) => { b.onclick = () => applyAppearance({ mode: document.documentElement.getAttribute('data-mode') || 'light', theme: b.dataset.theme }); });

    document.addEventListener('click', (e) => {
      const cb = e.target.closest('[data-close]');
      if (cb) { closeModal(cb.dataset.close); return; }
      if (e.target.classList.contains('modal-overlay') && e.target.id !== 'bridgeQuestionModal') e.target.classList.remove('open');
      if (e.target.closest('[data-iv-close]')) closeImageViewer();
    });

    on('#userChip', 'click', () => { if (!__user) openModal('loginModal'); });
    on('#upgradeBtn', 'click', (e) => {
      e.stopPropagation();
      if (!__user) openModal('loginModal');
      else { openModal('plansModal'); loadPlans(); }
    });
    on('#simpleLoginForm', 'submit', doLogin);
    on('#ivDownload', 'click', () => {
      if (!__ivDataUrl) return;
      const a = document.createElement('a');
      a.href = __ivDataUrl;
      a.download = `mirox-${Date.now()}.png`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    });

    on('#bwCloseBtn', 'click', closeBridgeWorkspace);
    on('#bwNewBtn', 'click', clearBridgeChat);
    on('#bwDownloadBtn', 'click', downloadBridgeClient);
    on('#bridgeDownloadBtn', 'click', downloadBridgeClient);
    on('#bwConnectBtn', 'click', startBridge);
    on('#bwDisconnectBtn', 'click', stopBridge);
    on('#bwSudoForgetBtn', 'click', forgetSudo);
    on('#bwSideToggle', 'click', () => $('#bwPanel')?.classList.toggle('side-open'));
    on('#bwToggleAutoRun', 'click', () => {
      __bridgeAutoRun = !__bridgeAutoRun;
      saveBridgeOpts(); renderToggles();
      toast(`Auto-Run ${__bridgeAutoRun ? 'ON' : 'OFF'}`);
    });
    on('#bwToggleShowCode', 'click', () => {
      __bridgeShowCode = !__bridgeShowCode;
      saveBridgeOpts(); renderToggles();
      toast(`Show Code ${__bridgeShowCode ? 'ON' : 'OFF'}`);
    });
    on('#bwPreviewBtn', 'click', () => openPreview(__lastPreviewFile || ''));
    on('#bwStopBtn', 'click', () => { bridgeAbort = true; toast('Stopping…'); });
    on('#bwScanDevicesBtn', 'click', async () => {
      if (!__bridge.connected) { toast('Connect the bridge first.'); return; }
      toast('Scanning for devices…');
      const devices = await refreshKdeDevices(false);
      toast(devices && devices.length ? `Found ${devices.length} device${devices.length === 1 ? '' : 's'}` : 'No devices found yet.');
    });
    on('#bwBuildOpenBtn', 'click', () => openPreview(__lastPreviewFile || ''));
    on('#bwBuildFolderBtn', 'click', async () => {
      if (!__lastBuildFolder) { toast('No project yet.'); return; }
      try { await navigator.clipboard.writeText(__lastBuildFolder); toast('Path copied.'); } catch {}
    });
    on('#bwPreviewCloseBtn', 'click', closePreview);
    on('#bwPreviewReloadBtn', 'click', () => openPreview());
    on('#bwPreviewLoadBtn', 'click', () => openPreview());

    on('#sudoSubmitBtn', 'click', submitSudo);
    on('#sudoSkipBtn', 'click', skipSudo);
    on('#sudoCloseBtn', 'click', skipSudo);
    on('#sudoRevealBtn', 'click', () => {
      const pwd = $('#sudoPasswordInput'); if (!pwd) return;
      const rev = $('#sudoRevealBtn');
      if (pwd.type === 'password') { pwd.type = 'text'; if (rev) rev.innerHTML = '<i class="ri-eye-off-line"></i>'; }
      else { pwd.type = 'password'; if (rev) rev.innerHTML = '<i class="ri-eye-line"></i>'; }
    });
    on('#sudoPasswordInput', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitSudo(); } });

    on('#plannerCloseBtn', 'click', plannerSkip);
    on('#plannerSkipBtn', 'click', plannerSkip);
    on('#kdeCloseBtn', 'click', kdeSkip);
    on('#kdeSkipBtn', 'click', kdeSkip);
    on('#kdeRefreshBtn', 'click', async () => {
      const sub = $('#kdeSubtitle'); if (sub) sub.textContent = 'Rescanning…';
      await refreshKdeDevices(true);
    });

    const bwInp = $('#bridgeInput');
    if (bwInp) {
      bwInp.addEventListener('input', () => {
        bwInp.style.height = 'auto';
        bwInp.style.height = Math.min(bwInp.scrollHeight, 140) + 'px';
        updateBridgeSendBtn();
      });
      bwInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleBridgeSend(); }
      });
    }
    on('#bridgeSendBtn', 'click', handleBridgeSend);
    $$('.bw-quick').forEach((btn) => {
      btn.onclick = () => {
        const inp2 = $('#bridgeInput');
        if (inp2) { inp2.value = btn.dataset.q; updateBridgeSendBtn(); }
        handleBridgeSend();
      };
    });

    on('#bqCustomToggle', 'click', () => {
      const cw = $('#bqCustomWrap');
      if (!cw) return;
      cw.style.display = cw.style.display === 'none' ? 'block' : 'none';
      if (cw.style.display === 'block') $('#bqCustomInput')?.focus();
    });
    on('#bqSubmit', 'click', submitBridgeQuestion);
    on('#bqSkipOne', 'click', skipBridgeQuestion);
    on('#bqCustomInput', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitBridgeQuestion(); } });

    bindSuggestionClicks();

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeImageViewer();
        closeModelPicker();
        if ($('#bwPreviewModal')?.classList.contains('open')) { closePreview(); return; }
        if ($('#kdeModal')?.classList.contains('open')) { kdeSkip(); return; }
        if ($('#plannerModal')?.classList.contains('open')) { plannerSkip(); return; }
        if ($('#sudoModal')?.classList.contains('open')) { skipSudo(); return; }
        if ($('#bridgeQuestionModal')?.classList.contains('open')) return;
        if ($('#bridgeWorkspace')?.classList.contains('open')) closeBridgeWorkspace();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('#messageInput')?.focus(); }
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 860) { closeSidebar(); $('#bwPanel')?.classList.remove('side-open'); }
    });
  }

  /* ═══════════ Init: wire the UI first, then load data in the background ═══════════ */
  function init() {
    try {
      loadAppearance();
      loadBridgeLS();
      loadKdeDevice();
      loadBridgeOpts();
      loadChats();
      wireAll();
      renderHistory();
      renderModelPicker();
      renderBridgeStatus();
      renderKdeStatus();
      renderBuildStatus();
      startIdleMascot();
    } catch (e) {
      console.error('[Mirox init]', e);
    } finally {
      killLoader();
    }
    /* Network data loads after the UI is already usable. A failure only leaves defaults in place. */
    loadConfig().catch(() => {});
    refreshUsage().catch(() => {});
    renderSidebarImageHistory().catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
