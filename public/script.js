(function () {
  'use strict';

  /* ═══════════ Loader ═══════════ */
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
  const LS_KEY = 'miroxai_conversations_v29';
  const TOKEN_KEY = 'mirox_token';
  const APPEARANCE_KEY = 'miroxai_appearance_v29';
  const BRIDGE_KEY = 'miroxai_bridge_v29';
  const KDE_DEVICE_KEY = 'miroxai_kde_device_v1';
  const BRIDGE_OPTS_KEY = 'miroxai_bridge_opts_v1';
  const PASTE_ATTACH_THRESHOLD = 1024;
  const NET_TIMEOUT_MS = 15000;
  const STREAM_TIMEOUT_MS = 120000;

  const MAX_BRIDGE_QUESTIONS = 6;
  const MAX_BRIDGE_ITER = 200;
  const MAX_AUTO_CONTINUES = 100;
  const MAX_DUP_COMMANDS = 40;
  const AUTO_CONTINUE_DELAY_MS = 900;
  const MAX_IMAGE_DIM = 1280;

  let __config = null, __user = null, __tier = 'free', __model = 'mirox-luna-1.2';
  let currentConversationId = null, isReplying = false;
  let continuationBusy = false, streamRenderAt = 0, userIsAtBottom = true;
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

  /* ═══════════ Auth-aware fetch helpers ═══════════ */
  function authHeaders(extra) {
    const h = { 'Content-Type': 'application/json', ...(extra || {}) };
    const t = getToken();
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  }

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
      const headers = authHeaders(opts.headers);
      const r = await netFetch(url, { ...opts, headers }, ms);
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('application/json')) return fallback;
      return await r.json();
    } catch { return fallback; }
  }

  /* ═══════════ IndexedDB ═══════════ */
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
      async set(k, v) { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(true); t.onerror = () => rej(t.error); }); },
      async get(k) { const db = await open(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); }); },
    };
  })();

  document.addEventListener('mousemove', (e) => {
    const x = ((e.clientX / window.innerWidth) - .5) * 4;
    const y = ((e.clientY / window.innerHeight) - .5) * 3;
    const r = document.documentElement.style;
    r.setProperty('--look-x', x.toFixed(1) + 'px');
    r.setProperty('--look-y', y.toFixed(1) + 'px');
  }, { passive: true });

  /* ═══════════ Blob mascot ═══════════ */
  const MOODS = ['idle','happy','love','wink','sad','surprised','sleepy','thinking','reasoning','searching','reading','learning','coding','celebrate','error','listening','cool','confused','focus'];

  const BLOB_PATH = 'M100 20 C126 20 144 32 154 54 C178 56 194 76 194 102 C194 128 178 148 154 152 C144 174 126 186 100 186 C74 186 56 174 46 152 C22 148 6 128 6 102 C6 76 22 56 46 54 C56 32 74 20 100 20 Z';

  const BLOB_SVG = `<svg class="blob-svg" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mirox avatar"><g class="blob-float"><path class="blob-body" d="${BLOB_PATH}" fill="currentColor"/><g class="blob-eyes" fill="var(--bg)"><ellipse cx="88" cy="82" rx="4.5" ry="13" transform="rotate(18 88 82)"/><ellipse cx="110" cy="78" rx="4.5" ry="13" transform="rotate(18 110 78)"/></g></g></svg>`;

  function blobSvg() { return BLOB_SVG; }
  function mascotHTML(cls, mood) {
    const m = MOODS.includes(mood) ? mood : 'idle';
    return `<div class="mascot ${cls || ''} m-${m}" data-mood="${m}">${blobSvg()}</div>`;
  }
  function upgradeStaticMascots(scope = document) {
    scope.querySelectorAll('.mascot:not([data-blob-ready])').forEach((el) => {
      const m = MOODS.includes(el.dataset.mood) ? el.dataset.mood : 'idle';
      el.innerHTML = blobSvg();
      el.dataset.mood = m;
      el.classList.add('m-' + m);
      el.dataset.blobReady = '1';
    });
  }
  function setMascotMood(mood, scope) {
    const root = scope || document;
    const m = MOODS.includes(mood) ? mood : 'idle';
    upgradeStaticMascots(root);
    root.querySelectorAll('.mascot').forEach((el) => {
      el.className = el.className.split(' ').filter((c) => !/^m-/.test(c)).join(' ');
      el.classList.add('m-' + m);
      el.dataset.mood = m;
    });
  }
  upgradeStaticMascots();
  const lb = document.getElementById('loadingBlob');
  if (lb) lb.innerHTML = blobSvg();

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

  function pickStatusLabel(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return 'Thinking';
    if (/\b(scan|check).*(device|phone|tablet|kde)\b/.test(t)) return 'Scanning devices';
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

  const LANG_WORDS = { lua: 'Lua', python: 'Python', py: 'Python', javascript: 'JavaScript', js: 'JavaScript', typescript: 'TypeScript', ts: 'TypeScript', html: 'HTML', css: 'CSS', java: 'Java', 'c++': 'C++', cpp: 'C++', c: 'C', go: 'Go', rust: 'Rust', ruby: 'Ruby', php: 'PHP', bash: 'Bash', sql: 'SQL', swift: 'Swift', kotlin: 'Kotlin' };
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
    if (raw) steps.push(`Analyzing: "${short}"`);
    const lang = detectLanguage(raw);
    if (lang) steps.push(`Target language: ${lang}`);
    const t = raw.toLowerCase();
    if (/\b(build|create|make|write|code|script|app|game|site|page)\b/.test(t)) steps.push('Planning project structure');
    if (/\b(fix|bug|error|broken|crash|wrong|fail)\b/.test(t)) steps.push('Diagnosing the issue');
    if (/\b(search|latest|news|current|today)\b/.test(t)) steps.push('Preparing a web search');
    if (files && files.length) steps.push(`Reading ${files.length} attached file${files.length === 1 ? '' : 's'}`);
    if (!steps.length) steps.push('Planning a clear answer');
    return steps;
  }

  /* ═══════════ Tools ═══════════ */
  const __tools = new Map();
  window.miroxRegisterTool = function(name, def) {
    if (!name || !def || typeof def.run !== 'function') return false;
    __tools.set(name, { name, label: def.label || name, icon: def.icon || 'ri-tools-line', description: def.description || '', run: def.run });
    return true;
  };
  window.miroxListTools = () => Array.from(__tools.keys());

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some((s) => s.src === src)) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  window.miroxRegisterTool('extract_zip', {
    label: 'Extract ZIP archive',
    icon: 'ri-file-zip-line',
    async run(input) {
      const dataUrl = input?.dataUrl || input?.file?.dataUrl;
      const filename = input?.filename || input?.file?.name || 'archive.zip';
      if (!dataUrl) return { ok: false, error: 'No zip data provided.' };
      try {
        await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
        const zip = await window.JSZip.loadAsync(dataUrl.split(',')[1] || dataUrl, { base64: true });
        const files = [];
        for (const path of Object.keys(zip.files)) {
          const entry = zip.files[path];
          if (entry.dir) continue;
          const text = await entry.async('string').catch(() => null);
          files.push({ path, size: text ? text.length : 0, content: text });
        }
        return { ok: true, filename, count: files.length, files: files.slice(0, 40) };
      } catch (e) { return { ok: false, error: e.message }; }
    },
  });

  window.miroxRegisterTool('execute_python', {
    label: 'Execute Python code',
    icon: 'ri-code-box-line',
    async run(input) {
      const code = input?.code || '';
      if (!code) return { ok: false, error: 'No code.' };
      try {
        await loadScript('https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js');
        if (!window.__pyodide) window.__pyodide = await window.loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/' });
        const out = await window.__pyodide.runPythonAsync(code);
        return { ok: true, stdout: String(out ?? '') };
      } catch (e) { return { ok: false, error: e.message }; }
    },
  });

  window.miroxRegisterTool('read_attachment', {
    label: 'Read attachment',
    icon: 'ri-file-text-line',
    async run(input) {
      const name = input?.name;
      const f = pendingFiles.find((x) => x.name === name);
      if (!f) return { ok: false, error: 'Attachment not found: ' + name };
      return { ok: true, name: f.name, size: f.size, content: (f.content || '').slice(0, 4000) };
    },
  });

  window.miroxRegisterTool('list_attachments', {
    label: 'List attachments',
    icon: 'ri-attachment-2',
    async run() { return { ok: true, files: pendingFiles.map((f) => ({ name: f.name, size: f.size, type: f.type })) }; },
  });

  function iconForTool(name) {
    const t = __tools.get(name);
    if (t && t.icon) return t.icon;
    const n = String(name || '').toLowerCase();
    if (/python|py\b/.test(n)) return 'ri-code-box-line';
    if (/js|javascript|node/.test(n)) return 'ri-javascript-line';
    if (/shell|bash|exec|run|command|terminal|sudo/.test(n)) return 'ri-terminal-box-line';
    if (/zip|archive|extract/.test(n)) return 'ri-file-zip-line';
    if (/read|cat|view/.test(n)) return 'ri-file-text-line';
    if (/write|save|edit|append|create/.test(n)) return 'ri-file-edit-line';
    if (/list|ls|dir|folder/.test(n)) return 'ri-folder-open-line';
    if (/search|find|grep|query/.test(n)) return 'ri-search-line';
    if (/browse|http|fetch|web|url/.test(n)) return 'ri-global-line';
    return 'ri-tools-line';
  }
  function humanToolLabel(name) {
    const t = __tools.get(name);
    if (t && t.label) return t.label;
    return String(name || 'tool').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /* ═══════════ Thinking panel ═══════════ */
  function createThinkPanel(label, steps, headline) {
    const el = document.createElement('div');
    el.className = 'think-wrap';
    el.innerHTML = `
      <div class="think-head">
        <span class="think-head-icon"><i class="ri-loader-4-line spin"></i></span>
        <span class="think-head-label">
          <span class="think-tool-summary" hidden></span>
          <span class="think-label">${escapeHtml(label || 'Thinking')}</span>
        </span>
        <span class="think-timer">0.0s</span>
        <button class="think-btn" data-think="min" type="button" title="Minimize"><i class="ri-subtract-line"></i></button>
        <button class="think-btn" data-think="max" type="button" title="Expand"><i class="ri-fullscreen-line"></i></button>
      </div>
      ${headline ? `<div class="think-head-sub">${escapeHtml(headline)}</div>` : ''}
      <div class="think-body"></div>`;
    const body = el.querySelector('.think-body');
    const timerEl = el.querySelector('.think-timer');
    const labelEl = el.querySelector('.think-label');
    const summaryEl = el.querySelector('.think-tool-summary');
    const headIcon = el.querySelector('.think-head-icon i');
    const t0 = performance.now();
    let done = false, toolCount = 0;

    const timer = setInterval(() => {
      if (done) { clearInterval(timer); return; }
      timerEl.textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's';
    }, 100);

    function updateSummary() {
      if (toolCount > 0) { summaryEl.hidden = false; summaryEl.textContent = `Used ${toolCount} tool${toolCount === 1 ? '' : 's'} · `; }
      else summaryEl.hidden = true;
    }
    function addNarration(text) {
      if (!text) return;
      const p = document.createElement('div');
      p.className = 'think-narration';
      p.innerHTML = `<span class="think-narration-dot"></span><span>${escapeHtml(text)}</span>`;
      body.appendChild(p);
    }
    function addTool(name, opts) {
      const o = opts || {};
      toolCount++; updateSummary();
      const row = document.createElement('div');
      row.className = 'think-tool';
      const lbl = o.label || humanToolLabel(name);
      const icon = o.icon || iconForTool(name);
      row.innerHTML = `
        <div class="think-tool-head">
          <span class="think-tool-icon"><i class="${icon}"></i></span>
          <span class="think-tool-name">${escapeHtml(lbl)}</span>
          <span class="think-tool-status"><i class="ri-loader-4-line spin"></i></span>
          <button class="think-tool-toggle" type="button" aria-label="Toggle"><i class="ri-arrow-down-s-line"></i></button>
        </div>
        <div class="think-tool-body"></div>`;
      body.appendChild(row);
      row.querySelector('.think-tool-head').addEventListener('click', () => row.classList.toggle('open'));
      return {
        row,
        setStatus(state) {
          const st = row.querySelector('.think-tool-status');
          if (state === 'run') st.innerHTML = '<i class="ri-loader-4-line spin"></i>';
          else if (state === 'ok') st.innerHTML = '<i class="ri-check-line"></i>';
          else if (state === 'warn') st.innerHTML = '<i class="ri-error-warning-line"></i>';
          else st.innerHTML = '';
        },
        addResult(text) {
          if (!text) return;
          const li = document.createElement('div');
          li.className = 'think-tool-result';
          li.textContent = text;
          row.querySelector('.think-tool-body').appendChild(li);
        },
        addCode(code) {
          if (!code) return;
          const pre = document.createElement('pre');
          pre.className = 'think-tool-code';
          pre.textContent = String(code).slice(0, 2000);
          row.querySelector('.think-tool-body').appendChild(pre);
        },
      };
    }
    if (Array.isArray(steps)) steps.forEach((s) => addNarration(s));

    el.querySelector('[data-think="min"]').addEventListener('click', (e) => { e.stopPropagation(); el.classList.toggle('collapsed'); });
    el.querySelector('[data-think="max"]').addEventListener('click', (e) => { e.stopPropagation(); el.classList.toggle('expanded'); });

    function close(finalLabel, mood) {
      if (done) return;
      done = true;
      clearInterval(timer);
      timerEl.textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's';
      labelEl.textContent = finalLabel;
      headIcon.className = 'ri-checkbox-circle-line';
      el.classList.add('done');
      setMascotMood(mood, el);
      setTimeout(() => el.classList.add('collapsed'), 1800);
    }
    return {
      el,
      addStep(text) { addNarration(text); },
      addNarration,
      addTool,
      setMood(mood) { setMascotMood(mood, el); },
      markWriting() { addNarration('Writing the answer…'); },
      finish() {
        body.querySelectorAll('.think-tool-status .ri-loader-4-line').forEach((i) => { i.className = 'ri-check-line'; });
        addNarration('Thinking complete');
        close('Thought for a moment', 'happy');
      },
      fail(msg) {
        body.querySelectorAll('.think-tool-status .ri-loader-4-line').forEach((i) => { i.className = 'ri-error-warning-line'; });
        addNarration(msg || 'Stopped with an error.');
        headIcon.className = 'ri-error-warning-line';
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
  function loadChats() { const v = safeGet(LS_KEY, []); __conversations = Array.isArray(v) ? v : []; }

  function welcomeHTML() {
    return `<div class="welcome-screen">
      <div class="welcome-mascot"><div class="mascot mascot-lg m-idle" id="welcomeMascot" data-mood="idle"></div></div>
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
    upgradeStaticMascots($('#chatMessages'));
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
    if (!items.length) { list.innerHTML = `<li class="history-empty">${q ? 'No matches' : 'No conversations yet'}</li>`; return; }
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
  function freeLimitReached(convo = currentConvo()) { return __tier === 'free' && conversationTokenUsage(convo) >= FREE_CONVO_TOKEN_LIMIT; }
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
      await sendToAPI('Continue your previous response from exactly where it stopped. Do not repeat the completed text.', [], false, { existingMsgEl: msgEl, existingBubble: bubble, messageObj, continuation: true });
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
    if (role === 'user') { bt.textContent = content || ''; if (!content) bt.style.display = 'none'; }
    else if (content) { bt.innerHTML = renderMarkdown(content); wireCopyButtons(bt); }
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
        } else if (action === 'retry') { if (!isReplying) handleRetry(el); }
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
    if (freeLimitReached()) { toast('Max tokens length reached — try new chat or upgrade.', 5000); updateTokenUsage(); return; }
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
    sendToAPI(text, files, searchFlag);
  }

  /* ═══════════ MAIN API CALL — now with auth header and error surfacing ═══════════ */
  async function sendToAPI(text, files, forceSearch, continuation = null) {
    const isContinuation = !!(continuation && continuation.continuation);
    const convoAtStart = currentConvo();
    if (!isContinuation && freeLimitReached(convoAtStart)) { toast('Max tokens length reached.', 5000); return; }
    isReplying = true;
    updateSendButtonState();
    const stopBtn = $('#stopBtn');
    if (stopBtn) stopBtn.style.display = 'grid';
    const convo = currentConvo();
    const history = convo ? convo.messages.slice(-14).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })) : [];
    const model = __model || 'mirox-luna-1.2';

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
      panel = { el: document.createElement('span'), addStep() {}, addNarration() {}, addTool() { return { row: document.createElement('span'), setStatus() {}, addResult() {}, addCode() {} }; }, setMood() {}, markWriting() {}, finish() {}, fail() {}, destroy() {} };
      const prev = String(continuation.messageObj.content || '');
      var full = prev ? prev + '\n\n' : '';
    } else {
      msgEl = document.createElement('div');
      msgEl.className = 'message ai';
      msgEl.dataset.msgId = aiMsgId;
      msgEl.dataset.role = 'ai';
      panel = createThinkPanel(pickStatusLabel(text), buildThinkingSteps(text, files), text);
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
    const streamTimeout = setTimeout(() => { try { activeStreamController?.abort(); } catch {} }, STREAM_TIMEOUT_MS);

    try {
      /* FIX: include Authorization header so the backend accepts the request */
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: authHeaders(),
        credentials: 'same-origin',
        body: JSON.stringify({
          message: text, history, model, stream: true, files, search: !!forceSearch,
          tools: window.miroxListTools(),
          bridge: __bridge.connected ? { connected: true, name: __bridge.name, model: __bridge.model, env: __bridge.env } : null,
        }),
        signal: activeStreamController.signal,
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const d = await res.json(); detail = d.error?.message || d.error || d.message || detail; } catch {}
        if (res.status === 401 || res.status === 403) throw new Error('Not signed in. Please sign in and try again.');
        if (res.status === 404) throw new Error('Backend endpoint not found (/v1/chat/completions).');
        if (res.status === 429) throw new Error('Rate limited. Wait a moment and try again.');
        if (res.status >= 500) throw new Error(`Server error (${res.status}). Try again.`);
        throw new Error(detail);
      }
      if (!res.body) throw new Error('Empty response body from server.');

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', searchStepAdded = false;
      let currentToolHandle = null;
      let gotAnyData = false;

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
          gotAnyData = true;

          if (o.tool) {
            const name = typeof o.tool === 'string' ? o.tool : (o.tool.name || 'tool');
            const label = typeof o.tool === 'object' ? o.tool.label : null;
            const icon = typeof o.tool === 'object' ? o.tool.icon : null;
            currentToolHandle = panel.addTool(name, { label, icon });
            panel.setMood('coding');
          }
          if (o.tool_result) {
            const tr = o.tool_result;
            if (currentToolHandle) {
              currentToolHandle.setStatus(tr.ok === false ? 'warn' : 'ok');
              if (tr.text) currentToolHandle.addResult(tr.text);
              else if (tr.result) currentToolHandle.addResult(typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result));
              if (tr.code) currentToolHandle.addCode(tr.code);
              currentToolHandle = null;
            }
          }
          if (o.n) panel.addNarration(o.n);
          if (o.search && o.search.query && !searchStepAdded) {
            searchStepAdded = true;
            panel.addNarration(`Searching the web for "${o.search.query}"…`);
            panel.setMood('searching');
          }
          if (o.overview && o.overview.text) panel.addNarration(`Overview from ${o.overview.source || 'web'} acquired`);
          if (o.source && o.source.title) panel.addNarration(`Source: ${o.source.title}`);
          if (o.search_done) { panel.addNarration(`Search finished — ${o.count || 0} result(s)`); panel.setMood('reading'); }
          if (o.p) { panel.addNarration(`Connected to ${o.p}`); panel.setMood('reasoning'); }
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
          if (o.error) throw new Error(o.error.message || o.error || 'Stream error');
        }
        if (limitHit) break;
      }
      clearTimeout(streamTimeout);
      panel.finish();
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      if (bubbleText) { bubbleText.innerHTML = renderMarkdown(full); wireCopyButtons(bubbleText); }
      if (!gotAnyData && !full) {
        panel.fail('Server returned no data.');
        if (!bubble) { bubble = document.createElement('div'); bubble.className = 'bubble'; msgEl.insertBefore(bubble, timeEl); }
        bubble.textContent = 'The server returned an empty response. Check that the backend is running.';
        return;
      }
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
      const msg = aborted ? 'Stopped (timed out or by you).' : (e.message || 'Something went wrong.');
      panel.fail(msg);
      if (!bubble) { bubble = document.createElement('div'); bubble.className = 'bubble'; msgEl.insertBefore(bubble, timeEl); }
      if (full) {
        if (!bubbleText) { bubbleText = document.createElement('div'); bubbleText.className = 'bubble-text'; bubble.prepend(bubbleText); }
        bubbleText.innerHTML = renderMarkdown(full); wireCopyButtons(bubbleText);
        let savedMsg = convo?.messages.find((m) => m.id === aiMsgId);
        if (isContinuation && continuation.messageObj) savedMsg = continuation.messageObj;
        if (!savedMsg && convo) { savedMsg = { id: aiMsgId, role: 'assistant', content: full, ts: Date.now() }; convo.messages.push(savedMsg); }
        if (savedMsg) { savedMsg.content = full; saveChats(); attachContinueButton(msgEl, bubble, savedMsg); }
      } else {
        bubble.textContent = aborted ? '(stopped)' : 'Error: ' + msg;
      }
      toast(msg, 5000);
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

  /* ═══════════ Files ═══════════ */
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
            width = Math.round(width * ratio); height = Math.round(height * ratio);
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
  function readAsDataUrl(file) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.readAsDataURL(file);
    });
  }
  function addTextAttachment(text, name) {
    const body = String(text).slice(0, 60000);
    const fname = name || ('pasted-' + new Date().toISOString().slice(11, 19).replace(/:/g, '-') + '.txt');
    if (pendingFiles.some((f) => f.type === 'text' && f.content === body)) { toast('attachment already added', 1800); return; }
    pendingFiles.push({ name: fname, size: text.length, type: 'text', content: body });
    updatePreview(); updateSendButtonState();
    toast(`Added as attachment (${fmtSize(text.length)})`, 2200);
  }
  function handleFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const arr = [];
    for (const f of Array.from(fileList)) {
      if (hasAttachment(f.name, f.size) || arr.some((x) => x.name === f.name && x.size === f.size)) { toast('attachment already added', 1800); continue; }
      arr.push(f);
    }
    if (!arr.length) return;
    let done = 0;
    const newFiles = [];
    const finish = () => {
      newFiles.sort((a, b) => (a.order || 0) - (b.order || 0));
      for (const nf of newFiles) if (!hasAttachment(nf.name, nf.size)) pendingFiles.push(nf);
      updatePreview(); updateSendButtonState();
    };
    arr.forEach((f, idx) => {
      const isImg = (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(f.name);
      const isZip = /\.zip$/i.test(f.name) || f.type === 'application/zip';
      const one = () => { done++; if (done === arr.length) finish(); };
      if (isZip) {
        readAsDataUrl(f).then((dataUrl) => { if (dataUrl) newFiles.push({ name: f.name, size: f.size, type: 'zip', dataUrl, order: idx }); one(); }).catch(one);
      } else if (isImg) {
        readImageAsResizedDataUrl(f).then((dataUrl) => { if (dataUrl) newFiles.push({ name: f.name, size: f.size, type: 'image', dataUrl, order: idx }); one(); }).catch(one);
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
    list.innerHTML = pendingFiles.map((f) => {
      if (f.type === 'image' && f.dataUrl) return `<div class="attach-chip"><img src="${f.dataUrl}" alt="">${escapeHtml(f.name)}${f.size ? ` <span class="attach-size">${fmtSize(f.size)}</span>` : ''}</div>`;
      if (f.type === 'zip') return `<div class="attach-chip"><span class="file-glyph"><i class="ri-file-zip-line"></i></span>${escapeHtml(f.name)}${f.size ? ` <span class="attach-size">${fmtSize(f.size)}</span>` : ''}</div>`;
      return `<div class="attach-chip">${fileIconHTML()}${escapeHtml(f.name)}${f.size ? ` <span class="attach-size">${fmtSize(f.size)}</span>` : ''}</div>`;
    }).join('');
  }

  function toast(msg, ms) {
    const t = document.createElement('div');
    t.className = 'mirox-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, ms || 1800);
  }

  /* ═══════════ Image viewer / history ═══════════ */
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

  /* ═══════════ Models ═══════════ */
  function getModelsList() { return __config?.models?.length ? __config.models : FALLBACK_MODELS; }
  function canUseModel(tier) { if (tier === 'free' || tier === 'ultimate') return true; return TIER_RANK[__tier] >= TIER_RANK[tier]; }
  function renderModelPicker() {
    const menu = $('#modelPickerMenu'); if (!menu) return;
    const models = getModelsList();
    const cur = __model || models[0].id;
    menu.innerHTML = models.map((m) => {
      const usable = canUseModel(m.tier);
      return `<div class="model-option${m.id === cur ? ' active' : ''}${usable ? '' : ' locked'}" data-model-id="${m.id}" data-usable="${usable}"><span class="model-option-label"><span class="dot"></span>${escapeHtml(m.label)}</span></div>`;
    }).join('');
    menu.querySelectorAll('.model-option').forEach((opt) => {
      opt.onclick = (e) => { e.stopPropagation(); if (opt.dataset.usable === 'false') { toast('Upgrade to use this model'); return; } selectModel(opt.dataset.modelId); };
    });
    const c = models.find((m) => m.id === cur);
    if (c) { const lbl = $('#currentModelLabel'); if (lbl) lbl.textContent = c.label; }
  }
  function selectModel(id) {
    if (!id) return;
    __model = id;
    const m = getModelsList().find((x) => x.id === id);
    if (m) { const lbl = $('#currentModelLabel'); if (lbl) lbl.textContent = m.label; }
    renderModelPicker(); closeModelPicker();
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
  async function refreshUsage() {
    const res = await jsonOr('/api/me', {}, null, 7000);
    if (!res || !res.user) {
      __user = null; __usage = null; __tier = 'free';
      renderCreditBar();
      const chip = $('#userChip');
      if (chip) { chip.querySelector('.user-name').textContent = 'Guest mode'; chip.querySelector('.user-sub').textContent = 'Sign in to save chats'; }
      renderModelPicker(); return;
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
    if (res && res.ok) { setToken(res.token || ''); closeModal('loginModal'); await refreshUsage(); toast('Welcome, ' + name + '!'); }
    else toast(res?.error || 'Login failed', 2500);
  }
  function doLoginment() {
    const tries = Number(sessionStorage.getItem('mirox_lm_tries') || 0);
    if (tries >= 2) { toast('Sign-in did not complete. Refresh and try again.', 4000); sessionStorage.removeItem('mirox_lm_tries'); return; }
    sessionStorage.setItem('mirox_lm_tries', String(tries + 1));
    window.location.href = '/api/auth/loginment/start';
  }
  async function doLogout() { await jsonOr('/api/logout', { method: 'POST' }, null); setToken(''); await refreshUsage(); closeModal('settingsModal'); toast('Signed out'); }
  async function loadPlans() {
    const grid = $('#plansGrid'); if (!grid) return;
    grid.innerHTML = '<div class="studio-empty">Loading plans…</div>';
    const res = await jsonOr('/api/subscription/plans', {}, null);
    if (!res || !Array.isArray(res.plans)) { grid.innerHTML = '<div class="studio-empty">Could not load plans.</div>'; return; }
    grid.innerHTML = res.plans.map((p) => {
      const isCurrent = p.id === __tier;
      const price = p.id === 'free' ? '<div class="plan-price">Free</div>' : `<div class="plan-price">$${Number(p.price_usd).toFixed(2)}</div>`;
      return `<div class="plan-card${isCurrent ? ' current' : ''}"><div class="plan-name">${escapeHtml(p.label)}</div><div class="plan-tagline">${escapeHtml(p.tagline || '')}</div>${price}<ul class="plan-perks">${(p.perks || []).map((x) => `<li>✓ ${escapeHtml(x)}</li>`).join('')}</ul></div>`;
    }).join('');
  }
  async function loadPersona() { if (!__user) return; const res = await jsonOr('/api/persona', {}, null); const inp = $('#personaInput'); if (inp && res?.persona) inp.value = res.persona; }
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
      /* FIX: auth header included */
      const res = await netFetch('/v1/images/generations', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt }),
      }, 90000);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok && data.image) {
        if (result) { result.innerHTML = `<img src="${data.image}" alt="${escapeHtml(prompt)}">`; result.querySelector('img').onclick = () => openImageViewer(data.image); }
        refreshUsage(); renderImageHistory(); renderSidebarImageHistory();
      } else {
        const errMsg = data.error?.message || data.error || data.message || `HTTP ${res.status}`;
        if (result) result.innerHTML = `<div class="studio-error">Failed: ${escapeHtml(errMsg)}</div>`;
        toast('Image generation failed: ' + errMsg, 4000);
      }
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'Timed out — server took too long.' : e.message;
      if (result) result.innerHTML = `<div class="studio-error">Error: ${escapeHtml(msg)}</div>`;
      toast(msg, 4000);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ri-image-add-line"></i> Generate'; }
    }
  }

  /* ═══════════ Bridge ═══════════ */
  function loadBridgeLS() { const b = safeGet(BRIDGE_KEY, {}); __bridge = { ...__bridge, ...b, connected: false, baseUrl: null, env: null }; }
  function saveBridgeLS() { safeSet(BRIDGE_KEY, { name: __bridge.name, model: __bridge.model, port: __bridge.port }); }
  function loadBridgeOpts() { const o = safeGet(BRIDGE_OPTS_KEY, {}); if (typeof o.autoRun === 'boolean') __bridgeAutoRun = o.autoRun; if (typeof o.showCode === 'boolean') __bridgeShowCode = o.showCode; }
  function saveBridgeOpts() { safeSet(BRIDGE_OPTS_KEY, { autoRun: __bridgeAutoRun, showCode: __bridgeShowCode }); }
  function loadKdeDevice() { const v = safeGet(KDE_DEVICE_KEY, null); if (v && v.id && v.name) __kdeCurrentDevice = v; }
  function saveKdeDevice() { if (__kdeCurrentDevice) safeSet(KDE_DEVICE_KEY, __kdeCurrentDevice); else { try { localStorage.removeItem(KDE_DEVICE_KEY); } catch {} } }
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
    updateBridgeSendBtn(); renderSudoStatus(); renderToggles();
  }
  function renderToggles() {
    $('#bwToggleAutoRun')?.classList.toggle('active', __bridgeAutoRun);
    $('#bwToggleShowCode')?.classList.toggle('active', __bridgeShowCode);
    const sb = $('#bwStopBtn'); if (sb) sb.style.display = bridgeRunning ? 'inline-flex' : 'none';
  }
  function renderSudoStatus() { const s = $('#bwSudoStatus'); if (!s) return; s.textContent = __sudoPassword ? (__sudoRemember ? 'Password saved (session)' : 'Password set (temporary)') : 'No password saved'; s.style.color = __sudoPassword ? 'var(--success)' : ''; }
  function renderKdeStatus() {
    const box = $('#bwKdeBox'), txt = $('#bwKdeStatus');
    if (!box || !txt) return;
    txt.textContent = __kdeAvailable ? 'KDE Connect ready' : 'KDE Connect: not installed';
    box.style.color = __kdeAvailable ? 'var(--success)' : 'var(--text-muted)';
    renderKdeDeviceList();
  }
  function renderKdeDeviceList() {
    const wrap = $('#bwDeviceList'); if (!wrap) return;
    if (!__kdeAvailable) { wrap.innerHTML = '<div class="bw-hint">Install on bridge: <code>sudo apt install kdeconnect</code></div>'; return; }
    if (!__kdeDevices.length) { wrap.innerHTML = '<div class="bw-hint">No devices found. Tap <b>Scan for devices</b>.</div>'; return; }
    wrap.innerHTML = __kdeDevices.map((d) => `
      <div class="bw-device-row" data-id="${escapeHtml(d.id)}">
        <div class="bw-device-icon"><i class="ri-smartphone-line"></i></div>
        <div class="bw-device-info"><div class="bw-device-name">${escapeHtml(d.name)}</div><div class="bw-device-id">${escapeHtml(d.id)}${d.reachable ? ' · reachable' : ''}</div></div>
        <div class="bw-device-actions">
          <button class="icon-btn" data-kde-ping title="Ping"><i class="ri-wifi-line"></i></button>
          <button class="icon-btn" data-kde-ring title="Ring"><i class="ri-notification-3-line"></i></button>
          <button class="icon-btn" data-kde-pick title="Use this device"><i class="ri-check-line"></i></button>
        </div>
      </div>`).join('');
    wrap.querySelectorAll('.bw-device-row').forEach((row) => {
      const dev = __kdeDevices.find((x) => x.id === row.dataset.id);
      if (!dev) return;
      row.querySelector('[data-kde-pick]')?.addEventListener('click', () => { __kdeCurrentDevice = { id: dev.id, name: dev.name }; saveKdeDevice(); renderKdeDeviceList(); toast(`Selected: ${dev.name}`); });
      row.querySelector('[data-kde-ping]')?.addEventListener('click', async () => { toast(`Pinging ${dev.name}…`); try { const r = await bridgeCall('/kde/ping', { device: dev.id }); toast(r.ok ? `📱 ${dev.name} is online` : '✗ No response'); } catch { toast('Ping failed'); } });
      row.querySelector('[data-kde-ring]')?.addEventListener('click', async () => { toast(`Ringing ${dev.name}…`); try { await bridgeCall('/kde/ring', { device: dev.id }); } catch {} });
    });
  }
  function showSudoModal(command) {
    return new Promise((resolve) => {
      __sudoResolver = resolve;
      const modal = $('#sudoModal'); if (!modal) { resolve(null); return; }
      $('#sudoCommandText') && ($('#sudoCommandText').textContent = command || '');
      const pwd = $('#sudoPasswordInput'); if (pwd) { pwd.value = ''; pwd.type = 'password'; }
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
    __sudoPassword = pwd; __sudoRemember = remember;
    closeSudoModal(); renderSudoStatus();
    if (__sudoResolver) { __sudoResolver({ password: pwd, remember }); __sudoResolver = null; }
  }
  function skipSudo() { closeSudoModal(); if (__sudoResolver) { __sudoResolver(null); __sudoResolver = null; } }
  function forgetSudo() { __sudoPassword = ''; __sudoRemember = false; renderSudoStatus(); toast('Sudo password forgotten.'); }
  async function askSudo(command) { if (__sudoPassword) return { password: __sudoPassword, remember: __sudoRemember, reused: true }; return await showSudoModal(command); }

  async function testBridge(port) {
    for (const host of ['localhost', '127.0.0.1']) {
      try {
        const r = await netFetch(`http://${host}:${port}/ping`, { mode: 'cors' }, 4000);
        if (r.ok) { const d = await r.json(); if (d && d.ok) return { ok: true, base: `http://${host}:${port}` }; }
      } catch {}
    }
    return { ok: false };
  }
  async function fetchEnv(base) { try { const r = await netFetch(`${base}/env`, { mode: 'cors' }, 5000); if (!r.ok) return null; const d = await r.json(); return d && d.ok ? d : null; } catch { return null; } }
  async function startBridge() {
    const name = ($('#bwNameInput')?.value || __bridge.name).trim() || 'My Laptop';
    const model = $('#bwModelSelect')?.value || __bridge.model;
    const port = parseInt($('#bwPortInput')?.value || __bridge.port, 10) || 8765;
    __bridge.name = name; __bridge.model = model; __bridge.port = port;
    saveBridgeLS(); setBwHint('Connecting…', '');
    const res = await testBridge(port);
    if (res.ok) {
      __bridge.connected = true; __bridge.baseUrl = res.base;
      __bridge.env = await fetchEnv(res.base);
      __kdeAvailable = !!__bridge.env?.kde_connect_available;
      renderBridgeStatus(); renderKdeStatus();
      $('#bridgeEmpty')?.remove();
      const home = __bridge.env?.home || '(unknown)';
      setBwHint(`Connected · Home: ${home}`, 'ok');
      addBridgeSystemMsg(`Connected. Home: ${home}`);
      if (__kdeAvailable) addBridgeSystemMsg('KDE Connect detected.');
    } else {
      __bridge.connected = false; __bridge.baseUrl = null; __bridge.env = null; __kdeAvailable = false;
      renderBridgeStatus(); renderKdeStatus();
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
    const r = await netFetch(__bridge.baseUrl + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}), credentials: 'omit' }, 130000);
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
  function setBwHint(text, cls = '') { const el = $('#bwConnectHint'); if (!el) return; el.textContent = text; el.className = 'bw-hint' + (cls ? ' ' + cls : ''); }
  function updateBridgeSendBtn() {
    const btn = $('#bridgeSendBtn'), inp = $('#bridgeInput');
    if (!btn || !inp) return;
    const enabled = __bridge.connected && !bridgeRunning && inp.value.trim().length > 0;
    btn.classList.toggle('is-disabled', !enabled);
    btn.setAttribute('aria-disabled', String(!enabled));
    renderToggles();
  }
  function openBridgeWorkspace() { $('#bridgeWorkspace')?.classList.add('open'); document.body.style.overflow = 'hidden'; if (!__bridge.connected) setTimeout(() => startBridge(), 50); }
  function closeBridgeWorkspace() { $('#bridgeWorkspace')?.classList.remove('open'); $('#bwPanel')?.classList.remove('side-open'); document.body.style.overflow = ''; }
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
  function renderBuildStatus() { const s = $('#bwBuildStatus'); if (!s) return; s.textContent = __lastBuildFolder || 'No project yet'; s.style.color = __lastBuildFolder ? 'var(--success)' : ''; }
  function addBridgeUserMsg(text) {
    const container = $('#bridgeMessages'); if (!container) return;
    $('#bridgeEmpty')?.remove();
    const el = document.createElement('div');
    el.className = 'bridge-msg user';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `<div class="bridge-bubble">${escapeHtml(text).replace(/\n/g, '<br>')}</div><div class="bridge-meta">You · ${time}</div>`;
    container.appendChild(el); scrollBridgeBottom();
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
    container.appendChild(el); scrollBridgeBottom();
    return el;
  }
  function addBridgeSystemMsg(text) {
    const container = $('#bridgeMessages'); if (!container) return;
    $('#bridgeEmpty')?.remove();
    const el = document.createElement('div');
    el.className = 'bridge-msg system';
    el.innerHTML = `<div class="bridge-bubble">${escapeHtml(text)}</div>`;
    container.appendChild(el); scrollBridgeBottom();
  }
  function addBridgeSuccessMsg(text, extras) {
    const container = $('#bridgeMessages'); if (!container) return;
    const e = extras || {};
    let buttons = '';
    if (e.previewPath) buttons += `<button class="bridge-success-btn" data-preview="${escapeHtml(e.previewPath)}"><i class="ri-eye-line"></i> Preview</button>`;
    if (e.folder) buttons += `<button class="bridge-success-btn" data-copy-folder="${escapeHtml(e.folder)}"><i class="ri-folder-open-line"></i> Copy path</button>`;
    const el = document.createElement('div');
    el.className = 'bridge-msg ai';
    el.innerHTML = `<div class="bridge-success"><div class="bridge-success-head"><i class="ri-checkbox-circle-fill"></i><span>${escapeHtml(text)}</span></div>${buttons ? `<div class="bridge-success-actions">${buttons}</div>` : ''}</div>`;
    el.querySelectorAll('[data-preview]').forEach((b) => { b.onclick = () => openPreview(b.dataset.preview); });
    el.querySelectorAll('[data-copy-folder]').forEach((b) => { b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copyFolder); toast('Path copied.'); } catch {} }; });
    container.appendChild(el); scrollBridgeBottom();
  }
  function addBridgeThinkingPanel(label, steps) {
    const container = $('#bridgeMessages'); if (!container) return null;
    $('#bridgeEmpty')?.remove();
    const panel = createThinkPanel(label || 'Thinking', steps || []);
    panel.el.classList.add('bridge-think');
    container.appendChild(panel.el); scrollBridgeBottom();
    return panel;
  }
  function addBridgeActionBubble(cmd) {
    const container = $('#bridgeMessages'); if (!container) return null;
    const data = getActionData(cmd);
    const el = document.createElement('div');
    el.className = 'bridge-msg ai';
    el.innerHTML = `<div class="bridge-action"><div class="bridge-action-head"><div class="bridge-action-icon ${data.iconClass}"><i class="${data.icon}"></i></div><div class="bridge-action-label">${data.label}</div><span class="bridge-action-status working"><i class="ri-loader-4-line spin"></i> Working</span></div><div class="bridge-action-code" style="display:none;"></div></div>`;
    container.appendChild(el); scrollBridgeBottom();
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
      } else { codeWrap.style.display = 'none'; codeWrap.innerHTML = ''; }
    }
    scrollBridgeBottom();
  }
  function getBaseName(p) { if (!p) return ''; const parts = String(p).split('/'); return parts[parts.length - 1] || p; }
  function getActionData(cmd) {
    const t = cmd.type;
    const base = getBaseName(cmd.path) || getBaseName(cmd.from) || '';
    const map = {
      'kde-list': ['ri-radar-line', 'list', 'Scanning devices'], 'kde-refresh': ['ri-refresh-line', 'list', 'Refreshing'],
      'kde-ping': ['ri-wifi-line', 'exec', 'Pinging device'], 'kde-ring': ['ri-notification-3-line', 'exec', 'Ringing device'],
      sudo: ['ri-shield-keyhole-line', 'exec', 'sudo'],
      delete: ['ri-delete-bin-line', 'exec', `Deleting <code>${escapeHtml(base)}</code>`],
      move: ['ri-drag-move-line', 'exec', `Moving <code>${escapeHtml(base)}</code>`],
      copy: ['ri-file-copy-2-line', 'exec', `Copying <code>${escapeHtml(base)}</code>`],
      read: ['ri-file-text-line', 'read', `Reading <code>${escapeHtml(base)}</code>`],
      list: ['ri-folder-line', 'list', `Listing <code>${escapeHtml(base || cmd.path || '')}</code>`],
    };
    if (t === 'write') return { icon: 'ri-file-add-line', iconClass: 'write', label: `Writing <code>${escapeHtml(base)}</code>` };
    if (t === 'append') return { icon: 'ri-file-edit-line', iconClass: 'write', label: `Appending <code>${escapeHtml(base)}</code>` };
    if (map[t]) return { icon: map[t][0], iconClass: map[t][1], label: map[t][2] };
    if (t === 'exec') return { icon: 'ri-terminal-box-line', iconClass: 'exec', label: 'Running command' };
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
  function extractBridgeCommands(text) {
    const cmds = [];
    const add = (type, mm, extra) => cmds.push(Object.assign({ type, index: mm.index }, extra));
    const rules = [
      [/<bridge-sudo>([\s\S]*?)<\/bridge-sudo>/g, 'sudo', (m) => ({ command: m[1].trim() })],
      [/<bridge-exec>([\s\S]*?)<\/bridge-exec>/g, 'exec', (m) => ({ command: m[1].trim() })],
      [/<bridge-write\s+path="([^"]+)">([\s\S]*?)<\/bridge-write>/g, 'write', (m) => ({ path: m[1], content: m[2] })],
      [/<bridge-append\s+path="([^"]+)">([\s\S]*?)<\/bridge-append>/g, 'append', (m) => ({ path: m[1], content: m[2] })],
      [/<bridge-delete\s+path="([^"]+)"\s*\/>/g, 'delete', (m) => ({ path: m[1] })],
      [/<bridge-read\s+path="([^"]+)"\s*\/>/g, 'read', (m) => ({ path: m[1] })],
      [/<bridge-list\s+path="([^"]+)"\s*\/>/g, 'list', (m) => ({ path: m[1] })],
    ];
    for (const [re, type, fn] of rules) { re.lastIndex = 0; let m; while ((m = re.exec(text)) !== null) add(type, m, fn(m)); }
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
  function looksLikeFreeQuestion(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (/(?:^|\n)\s*asking\(\s*\)/i.test(t)) return true;
    const stripped = t.replace(/\bDONE\b/i, '').trim();
    return !!stripped && /\?\s*$/.test(stripped) && !/<bridge-/.test(stripped);
  }
  function buildEnvBlockString() {
    const env = __bridge.env || {};
    const allowed = Array.isArray(env.allowed_dirs) && env.allowed_dirs.length ? env.allowed_dirs.join(', ') : '(none)';
    const home = env.home || '(unknown)';
    return ['[Bridge environment]', `home=${home}`, `cwd=${env.cwd || home}`, `platform=${env.platform || '(unknown)'}`, `allowed_dirs=${allowed}`].join('\n');
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
  function sanitizeForChat(text) {
    if (!text) return '';
    let t = String(text);
    t = t.replace(/<bridge-[a-z][a-z0-9-]*[^>]*>[\s\S]*?<\/bridge-[a-z][a-z0-9-]*>/g, '');
    t = t.replace(/<bridge-[a-z][a-z0-9-]*\s+[^>]*\/>/g, '');
    t = t.replace(/<\/?bridge-[a-z][a-z0-9-]*[^>]*>/g, '');
    t = t.replace(/\bDONE\b/g, '');
    return t.replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ── Markdown / code ── */
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
    const src = sanitizeForChat(String(rawText));
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
      const t = lines[i].trim();
      if (!t) { flush(); continue; }
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

  function openModal(id) { const el = document.getElementById(id); if (el) el.classList.add('open'); }
  function closeModal(id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); }
  function openSidebar() { $('#sidebar')?.classList.add('open'); $('#sidebarScrim')?.classList.add('open'); }
  function closeSidebar() { $('#sidebar')?.classList.remove('open'); $('#sidebarScrim')?.classList.remove('open'); }

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

  /* ═══════════ Init ═══════════ */
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
        saveChats(); renderHistory(); return;
      }
      openConversation(id);
      if (window.innerWidth <= 860) closeSidebar();
    });
    $('#historySearch')?.addEventListener('input', (e) => { __historyQuery = e.target.value; renderHistory(); });
    const inp = $('#messageInput');
    if (inp) {
      inp.addEventListener('input', () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 180) + 'px'; updateSendButtonState(); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleSend(); } });
      inp.addEventListener('paste', (e) => { const text = e.clipboardData?.getData('text/plain') || ''; if (text.length > PASTE_ATTACH_THRESHOLD) { e.preventDefault(); addTextAttachment(text); } });
    }
    on('#sendBtn', 'click', handleSend);
    on('#scrollBottomBtn', 'click', () => { autoScrollEnabled = true; userIsAtBottom = true; scrollToBottom(true); });
    on('#chatMessages', 'scroll', () => { const c = $('#chatMessages'); userIsAtBottom = atChatBottom(c); autoScrollEnabled = userIsAtBottom; updateScrollButton(); });
    on('#attachBtn', 'click', () => $('#fileInput')?.click());
    on('#fileInput', 'change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
    on('#removeAttachmentBtn', 'click', () => { pendingFiles = []; updatePreview(); updateSendButtonState(); });
    on('#stopBtn', 'click', stopStreaming);
    on('#modelPickerBtn', 'click', (e) => { e.stopPropagation(); if ($('#modelPickerMenu')?.classList.contains('open')) closeModelPicker(); else openModelPicker(); });
    document.addEventListener('click', (e) => { if (!e.target.closest('#modelPicker')) closeModelPicker(); });
    on('#searchModeBtn', 'click', (e) => {
      e.preventDefault();
      forceSearchNext = !forceSearchNext;
      $('#searchModeBtn')?.classList.toggle('active', forceSearchNext);
      toast(forceSearchNext ? 'Web search enabled for next message.' : 'Web search disabled.');
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
    on('#upgradeBtn', 'click', (e) => { e.stopPropagation(); if (!__user) openModal('loginModal'); else { openModal('plansModal'); loadPlans(); } });
    on('#simpleLoginForm', 'submit', doLogin);
    on('#ivDownload', 'click', () => { if (!__ivDataUrl) return; const a = document.createElement('a'); a.href = __ivDataUrl; a.download = `mirox-${Date.now()}.png`; document.body.appendChild(a); a.click(); document.body.removeChild(a); });
    on('#bwCloseBtn', 'click', closeBridgeWorkspace);
    on('#bwNewBtn', 'click', clearBridgeChat);
    on('#bwDownloadBtn', 'click', downloadBridgeClient);
    on('#bridgeDownloadBtn', 'click', downloadBridgeClient);
    on('#bwConnectBtn', 'click', startBridge);
    on('#bwDisconnectBtn', 'click', stopBridge);
    on('#bwSudoForgetBtn', 'click', forgetSudo);
    on('#bwSideToggle', 'click', () => $('#bwPanel')?.classList.toggle('side-open'));
    on('#bwToggleAutoRun', 'click', () => { __bridgeAutoRun = !__bridgeAutoRun; saveBridgeOpts(); renderToggles(); toast(`Auto-Run ${__bridgeAutoRun ? 'ON' : 'OFF'}`); });
    on('#bwToggleShowCode', 'click', () => { __bridgeShowCode = !__bridgeShowCode; saveBridgeOpts(); renderToggles(); toast(`Show Code ${__bridgeShowCode ? 'ON' : 'OFF'}`); });
    on('#bwPreviewBtn', 'click', () => openPreview(__lastPreviewFile || ''));
    on('#bwStopBtn', 'click', () => { bridgeAbort = true; toast('Stopping…'); });
    on('#bwScanDevicesBtn', 'click', async () => { if (!__bridge.connected) { toast('Connect the bridge first.'); return; } toast('Scanning for devices…'); });
    on('#bwBuildOpenBtn', 'click', () => openPreview(__lastPreviewFile || ''));
    on('#bwBuildFolderBtn', 'click', async () => { if (!__lastBuildFolder) { toast('No project yet.'); return; } try { await navigator.clipboard.writeText(__lastBuildFolder); toast('Path copied.'); } catch {} });
    on('#bwPreviewCloseBtn', 'click', closePreview);
    on('#bwPreviewReloadBtn', 'click', () => openPreview());
    on('#bwPreviewLoadBtn', 'click', () => openPreview());
    on('#sudoSubmitBtn', 'click', submitSudo);
    on('#sudoSkipBtn', 'click', skipSudo);
    on('#sudoCloseBtn', 'click', skipSudo);
    on('#sudoRevealBtn', 'click', () => { const pwd = $('#sudoPasswordInput'); if (!pwd) return; const rev = $('#sudoRevealBtn'); if (pwd.type === 'password') { pwd.type = 'text'; if (rev) rev.innerHTML = '<i class="ri-eye-off-line"></i>'; } else { pwd.type = 'password'; if (rev) rev.innerHTML = '<i class="ri-eye-line"></i>'; } });
    on('#sudoPasswordInput', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitSudo(); } });
    on('#plannerCloseBtn', 'click', () => { $('#plannerModal')?.classList.remove('open'); if (__plannerResolver) { __plannerResolver({ id: 0, name: 'auto' }); __plannerResolver = null; } });
    on('#plannerSkipBtn', 'click', () => { $('#plannerModal')?.classList.remove('open'); if (__plannerResolver) { __plannerResolver({ id: 0, name: 'auto' }); __plannerResolver = null; } });
    on('#kdeCloseBtn', 'click', () => { $('#kdeModal')?.classList.remove('open'); if (__kdeResolver) { __kdeResolver(null); __kdeResolver = null; } });
    on('#kdeSkipBtn', 'click', () => { $('#kdeModal')?.classList.remove('open'); if (__kdeResolver) { __kdeResolver(null); __kdeResolver = null; } });
    const bwInp = $('#bridgeInput');
    if (bwInp) {
      bwInp.addEventListener('input', () => { bwInp.style.height = 'auto'; bwInp.style.height = Math.min(bwInp.scrollHeight, 140) + 'px'; updateBridgeSendBtn(); });
      bwInp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleBridgeSend(); } });
    }
    on('#bridgeSendBtn', 'click', handleBridgeSend);
    bindSuggestionClicks();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeImageViewer(); closeModelPicker();
        if ($('#bwPreviewModal')?.classList.contains('open')) { closePreview(); return; }
        if ($('#bridgeWorkspace')?.classList.contains('open')) closeBridgeWorkspace();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('#messageInput')?.focus(); }
    });
    window.addEventListener('resize', () => { if (window.innerWidth > 860) { closeSidebar(); $('#bwPanel')?.classList.remove('side-open'); } });
  }

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

  function handleBridgeSend() {
    const inp = $('#bridgeInput'); if (!inp) return;
    const text = inp.value.trim();
    if (!text || bridgeRunning || !__bridge.connected) return;
    if (bridgeWaitingForUser) { bridgeWaitingForUser = false; if (!bridgeTurn) bridgeTurn = newTurnState(); }
    else { bridgeConversation = []; bridgeTaskComplete = true; if (bridgeAutoTimer) { clearTimeout(bridgeAutoTimer); bridgeAutoTimer = null; } bridgeTurn = null; }
    inp.value = ''; inp.style.height = 'auto';
    updateBridgeSendBtn();
    runBridgeTurn(text, false);
  }
  function newTurnState() { return { runs: 0, plannedFiles: new Set(), writtenFiles: new Set(), commandLog: new Map(), failedSignatures: new Set(), commandsRun: 0 }; }
  async function runBridgeTurn(userText, isResume = false) {
    if (!__bridge.connected) { setBwHint('Bridge is not connected.', 'err'); return; }
    if (bridgeRunning) return;
    bridgeRunning = true; bridgeAbort = false;
    updateBridgeSendBtn();
    bridgeTaskComplete = false;
    addBridgeUserMsg(userText);
    addBridgeSystemMsg('Bridge turn started (basic mode).');
    bridgeRunning = false;
    updateBridgeSendBtn();
  }
  function openPreview(path) {
    const modal = $('#bwPreviewModal'); if (!modal) return;
    modal.classList.add('open');
    const frame = $('#bwPreviewFrame');
    if (frame) frame.srcdoc = '<html><body style="font-family:system-ui;padding:40px;color:#888;text-align:center"><h2>Preview</h2><p>' + escapeHtml(path || 'No file') + '</p></body></html>';
  }
  function closePreview() { $('#bwPreviewModal')?.classList.remove('open'); }

  async function init() {
    try {
      loadAppearance(); loadBridgeLS(); loadKdeDevice(); loadBridgeOpts(); loadChats(); wireAll();
      renderHistory(); renderModelPicker(); renderBridgeStatus(); renderKdeStatus(); renderBuildStatus(); startIdleMascot();
    } catch (e) { console.error('[Mirox init]', e); }
    finally { killLoader(); }
    loadConfig().catch(() => {});
    refreshUsage().catch(() => {});
    renderSidebarImageHistory().catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
