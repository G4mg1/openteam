(function () {
  'use strict';

  /* ═══════════ Loader ═══════════ */
  function killLoader() {
    const el = document.getElementById('loadingScreen');
    if (!el) return;
    el.classList.add('hidden');
    setTimeout(() => { el.style.display = 'none'; }, 750);
  }
  window.__miroxKillLoader = killLoader;
  setTimeout(killLoader, 1400);
  setTimeout(killLoader, 3000);
  window.addEventListener('error', () => killLoader());

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };

  const FALLBACK_MODELS = [
    { id: 'mirox-luna-1.2', label: 'Luna', tier: 'free', default: true },
    { id: 'mirox-gen-1', label: 'Gen', tier: 'free' },
    { id: 'mirox-pro-5', label: 'Pro', tier: 'pro' },
    { id: 'mirox-ultra-10', label: 'Ultra', tier: 'pro' },
    { id: 'mirox-eclipse-2.0', label: 'Eclipse', tier: 'ultimate' },
  ];
  const TIER_RANK = { free: 0, pro: 1, ultimate: 2 };
  const LS_KEY = 'miroxai_conversations_v23';
  const TOKEN_KEY = 'mirox_token';
  const APPEARANCE_KEY = 'miroxai_appearance_v23';
  const BRIDGE_KEY = 'miroxai_bridge_v23';
  const KDE_DEVICE_KEY = 'miroxai_kde_device_v1';
  const BRIDGE_OPTS_KEY = 'miroxai_bridge_opts_v1';
  const PASTE_ATTACH_THRESHOLD = 1024; // 1KB

  const MAX_BRIDGE_QUESTIONS = 6;
  const MAX_BRIDGE_ITER = 200;
  const MAX_AUTO_CONTINUES = 100;
  const MAX_DUP_COMMANDS = 40;
  const AUTO_CONTINUE_DELAY_MS = 900;
  const MAX_IMAGE_DIM = 1280;

  let __config = null, __user = null, __tier = 'free', __model = 'mirox-luna-1.2';
  let currentConversationId = null, isReplying = false;
  let __conversations = [], pendingFiles = [], activeStreamController = null, __usage = null;
  let __bridge = { name: 'My Laptop', model: 'mirox-luna-1.2', port: 8765, connected: false, baseUrl: null, env: null };
  let bridgeConversation = [], bridgeRunning = false, bridgeQuestionCount = 0, bridgeProgress = 0;
  let bridgeTurn = null, bridgeAutoTimer = null, bridgeTaskComplete = true;
  let bridgeWaitingForUser = false;
  let bridgeAbort = false;
  let __bqResolver = null, __bqSelected = null;
  let forceSearchNext = false;

  let __sudoPassword = '';
  let __sudoRemember = false;
  let __sudoResolver = null;

  let __kdeDevices = [];
  let __kdeCurrentDevice = null;
  let __kdeResolver = null;
  let __kdeAvailable = false;

  let __bridgeAutoRun = true;
  let __bridgeShowCode = false;
  let __lastBuildFolder = null;
  let __lastBuildWasMobile = false;
  let __lastPreviewFile = null;

  const uid = () => 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const escapeHtml = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  function safeGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
  function safeSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
  function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }

  /* ═══════════ Mascot eyes follow cursor ═══════════ */
  document.addEventListener('mousemove', (e) => {
    const x = ((e.clientX / window.innerWidth) - .5) * 5;
    const y = ((e.clientY / window.innerHeight) - .5) * 3.5;
    const r = document.documentElement.style;
    r.setProperty('--look-x', x.toFixed(1) + 'px');
    r.setProperty('--look-y', y.toFixed(1) + 'px');
  }, { passive: true });

  /* ═══════════ Mascot emotes (v24) ═══════════ */
  const MASCOT_EMOTES = ['idle','thinking','happy','searching','reading','learning','reasoning','typing','coding','sad','surprised','sleepy','love','laugh','focused','error','celebrate','confused','proud','curious'];
  function mascotHTML(cls, emote) {
    const e = MASCOT_EMOTES.includes(emote) ? emote : (/thinking/.test(cls || '') ? 'thinking' : 'idle');
    return `<div class="mascot ${cls || ''} emote-${e}" data-emote="${e}"><span class="eye left"></span><span class="eye right"></span><span class="mouth"></span><span class="acc acc-glasses"></span><span class="acc acc-book"></span><span class="acc acc-lens"></span><span class="acc acc-bulb"></span><span class="acc acc-pen"></span><span class="acc acc-spark"></span><span class="acc acc-dots"></span><span class="acc acc-heart"></span><span class="acc acc-tear"></span><span class="acc acc-bang"></span><span class="acc acc-q">?</span></div>`;
  }
  function setMascotEmote(el, name) {
    if (!el) return;
    const e = MASCOT_EMOTES.includes(name) ? name : 'idle';
    el.className = el.className.replace(/\bemote-[a-z]+\b/g, '').trim() + ' emote-' + e;
    el.dataset.emote = e;
  }
  function emoteForLabel(label) {
    const l = String(label || '');
    if (/search/i.test(l)) return 'searching';
    if (/image|paint/i.test(l)) return 'curious';
    if (/build|design|refactor|test/i.test(l)) return 'coding';
    if (/analy|problem|safe|check/i.test(l)) return 'focused';
    if (/plan/i.test(l)) return 'reasoning';
    if (/scan|ping|send/i.test(l)) return 'learning';
    return 'thinking';
  }
  function emoteForText(t) {
    const s = String(t || '').toLowerCase();
    if (/writing/.test(s)) return 'typing';
    if (/overview|source/.test(s)) return 'reading';
    if (/finished|done/.test(s)) return 'reasoning';
    if (/search/.test(s)) return 'searching';
    if (/connected|generat/.test(s)) return 'learning';
    if (/error|fail|wrong/.test(s)) return 'error';
    return null;
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

  /* Build a short, safe reasoning seed from the user's message */
  function makeReasoning(text) {
    const t = String(text || '').trim().replace(/\s+/g, ' ');
    if (!t) return 'Understanding the request and planning a clear, safe, helpful answer.';
    const short = t.length > 130 ? t.slice(0, 130) + '…' : t;
    let extra = 'Planning a clear, accurate and safe answer.';
    const l = t.toLowerCase();
    if (/\b(wifi|wi-fi|router|network)\b/.test(l) && /\b(remove|delete|kick|block)\b/.test(l))
      extra = 'This touches the user\'s own network — give safe, legitimate steps (router admin panel, MAC filtering, password change). No harmful content.';
    else if (/\b(password|login|account)\b/.test(l)) extra = 'Sensitive topic — provide safe recovery and security best practices only.';
    else if (/\b(code|bug|error|fix)\b/.test(l)) extra = 'Will answer with a fenced code block and a short explanation.';
    else if (/\b(vs|difference|compare|better)\b/.test(l)) extra = 'Will compare both sides fairly and end with a clear recommendation.';
    return `User said: "${short}" — ${extra}`;
  }

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

  const openModal = (id) => { const el = document.getElementById(id); if (el) el.classList.add('open'); };
  const closeModal = (id) => { const el = document.getElementById(id); if (el) el.classList.remove('open'); };
  const openSidebar = () => { $('#sidebar')?.classList.add('open'); $('#sidebarScrim')?.classList.add('open'); };
  const closeSidebar = () => { $('#sidebar')?.classList.remove('open'); $('#sidebarScrim')?.classList.remove('open'); };

  function applyAppearance(prefs) {
    const root = document.documentElement;
    const mode = prefs.mode || 'light';
    const theme = prefs.theme || 'default';
    root.setAttribute('data-mode', mode);
    root.setAttribute('data-theme', theme);
    safeSet(APPEARANCE_KEY, { mode, theme });
    $$('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    $$('.swatch').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
  }
  function loadAppearance() {
    let prefs = safeGet(APPEARANCE_KEY, {});
    if (!prefs.mode && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) prefs.mode = 'dark';
    applyAppearance(prefs);
  }

  /* ═══════════ Text sanitization (bridge) ═══════════ */
  function stripBridgeTags(text) {
    if (!text) return '';
    let t = String(text);
    // a block still streaming (opening tag, no close yet) is hidden entirely
    t = t.replace(/<bridge-([a-z][a-z0-9-]*)\b[^>]*(?<!\/)>(?![\s\S]*<\/bridge-\1>)[\s\S]*$/, '');
    t = t.replace(/<bridge-designs>[\s\S]*?<\/bridge-designs>/g, '');
    t = t.replace(/<bridge-[a-z][a-z0-9-]*[^>]*>[\s\S]*?<\/bridge-[a-z][a-z0-9-]*>/g, '');
    t = t.replace(/<bridge-[a-z][a-z0-9-]*\s+[^>]*\/>/g, '');
    t = t.replace(/<\/?bridge-[a-z][a-z0-9-]*[^>]*>/g, '');
    t = t.replace(/^\s*<\/(?:bridge-[a-z][a-z0-9-]*|bridge-write|bridge-append|bridge-exec|bridge-read|bridge-list|bridge-delete|bridge-move|bridge-copy|bridge-sudo|bridge-ask|bridge-plan|bridge-progress|bridge-email|bridge-http|bridge-clipboard|bridge-screenshot|bridge-git|bridge-pkgs|bridge-sysinfo|bridge-syscheck|bridge-processes|design)>\s*$/gim, '');
    t = t.replace(/^\s*<bridge-[a-z][a-z0-9-]*[^>]*>\s*$/gim, '');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }
  function sanitizeForChat(text) {
    let t = stripBridgeTags(text);
    t = t.replace(/```[\s\S]*?```/g, '');
    t = t.replace(/~~~[\s\S]*?~~~/g, '');
    t = t.replace(/`[^`\n]+`/g, '');
    t = t.replace(/\bDONE\b/g, '');
    t = t.replace(/\basking\(\s*\)/gi, '');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  /* ═══════════ Syntax highlight ═══════════ */
  const HL_ALIASES = { html: 'xml', htm: 'xml', js: 'javascript', mjs: 'javascript', ts: 'typescript', py: 'python', python3: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', jsonc: 'json', lua: 'lua', cxx: 'cpp' };
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

  /* ═══════════ Markdown (chat keeps code blocks, now highlighted) ═══════════ */
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
    return parts.map(p => p.type === 'code' ? renderCode(p.lang, p.content, p.closed) : renderText(p.content)).join('');
  }
  function renderCode(lang, code, closed) {
    const cleanLang = (lang || '').trim().toLowerCase();
    const label = (cleanLang || 'CODE').toUpperCase();
    const raw = String(code || '').replace(/\n$/, '');
    const btn = closed
      ? `<button class="code-action-btn" data-copy><i class="ri-file-copy-line"></i> Copy</button>`
      : `<span style="font-size:11px;color:var(--accent);opacity:.8;display:inline-flex;align-items:center;gap:5px;"><i class="ri-loader-4-line" style="animation:spin 1s linear infinite;"></i> writing…</span>`;
    return `<div class="code-block"><div class="code-block-header"><span class="code-lang-label">${escapeHtml(label)}</span>${btn}</div><pre><code class="hljs">${highlightCode(cleanLang, raw)}</code></pre></div>`;
  }
  function renderText(text) {
    const lines = String(text).split('\n');
    let out = '';
    const buf = [];
    const flush = () => { if (buf.length) { out += `<p>${inlineFmt(buf.join(' '))}</p>`; buf.length = 0; } };
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) { flush(); continue; }
      const hm = t.match(/^(#{1,4})\s+(.+)$/);
      if (hm) { flush(); out += `<h${hm[1].length}>${inlineFmt(hm[2])}</h${hm[1].length}>`; continue; }
      const um = t.match(/^[-*+]\s+(.+)$/);
      if (um) { out += `<div style="margin:2px 0;">• ${inlineFmt(um[1])}</div>`; continue; }
      const om = t.match(/^(\d+)\.\s+(.+)$/);
      if (om) { out += `<div style="margin:2px 0;">${om[1]}. ${inlineFmt(om[2])}</div>`; continue; }
      buf.push(t);
    }
    flush(); return out;
  }
  function inlineFmt(t) {
    t = escapeHtml(t);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    return t;
  }
  function wireCopyButtons(scope) {
    (scope || document).querySelectorAll('.code-action-btn[data-copy]').forEach(btn => {
      if (btn.__wired) return; btn.__wired = true;
      btn.onclick = async () => {
        const code = btn.closest('.code-block')?.querySelector('pre code')?.textContent || '';
        try { await navigator.clipboard.writeText(code); btn.innerHTML = '<i class="ri-check-line"></i> Copied'; setTimeout(() => { btn.innerHTML = '<i class="ri-file-copy-line"></i> Copy'; }, 1200); } catch {}
      };
    });
  }

  /* ═══════════ Thinking panel (min / max) ═══════════ */
  function createThinkPanel(label, reasonText) {
    const el = document.createElement('div');
    el.className = 'think-wrap';
    el.innerHTML = `
      <div class="think-head">
        ${mascotHTML('mascot-sm thinking', emoteForLabel(label))}
        <span class="think-label">${escapeHtml(label || 'Thinking')}</span>
        <span class="think-timer">0.0s</span>
        <button class="think-btn" data-think="min" type="button" title="Minimize"><i class="ri-subtract-line"></i></button>
        <button class="think-btn" data-think="max" type="button" title="Expand"><i class="ri-fullscreen-line"></i></button>
      </div>
      <div class="think-body"></div>`;
    const body = el.querySelector('.think-body');
    const timerEl = el.querySelector('.think-timer');
    const labelEl = el.querySelector('.think-label');
    const mascotEl = el.querySelector('.mascot');
    const setPhase = (t) => { const e = emoteForText(t); if (e) setMascotEmote(mascotEl, e); };
    const t0 = performance.now();
    let done = false, writeStep = null;
    const timer = setInterval(() => {
      if (done) { clearInterval(timer); return; }
      timerEl.textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's';
    }, 100);

    function addStep(text, state = 'info') {
      setPhase(text);
      const row = document.createElement('div');
      row.className = 'think-step ' + state;
      const icon = state === 'run' ? '<i class="ri-loader-4-line"></i>' : state === 'ok' ? '<i class="ri-check-line"></i>' : '<i class="ri-sparkling-2-line"></i>';
      row.innerHTML = `<span class="ts-icon">${icon}</span><span class="ts-text">${escapeHtml(text)}</span>`;
      body.appendChild(row);
      body.scrollTop = body.scrollHeight;
      return row;
    }
    if (reasonText) {
      const r = document.createElement('div');
      r.className = 'think-reason';
      r.textContent = reasonText;
      body.appendChild(r);
    }
    el.querySelector('[data-think="min"]').addEventListener('click', () => { el.classList.toggle('collapsed'); });
    el.querySelector('[data-think="max"]').addEventListener('click', () => { el.classList.toggle('expanded'); });

    return {
      el,
      addStep,
      setLabel(t) { labelEl.textContent = t; },
      markWriting() {
        if (!writeStep) { writeStep = addStep('Writing the answer…', 'run'); }
      },
      finish() {
        if (done) return; done = true;
        clearInterval(timer);
        timerEl.textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's';
        if (writeStep) { writeStep.className = 'think-step ok'; writeStep.querySelector('.ts-icon').innerHTML = '<i class="ri-check-line"></i>'; }
        else addStep('Done.', 'ok');
        el.classList.add('done');
        mascotEl.classList.remove('thinking');
        setMascotEmote(mascotEl, 'celebrate');
        setTimeout(() => setMascotEmote(mascotEl, 'happy'), 1200);
        setTimeout(() => { el.classList.add('collapsed'); }, 1400);
      },
      destroy() { clearInterval(timer); setMascotEmote(mascotEl, 'sad'); }
    };
  }

  /* ═══════════ Conversations ═══════════ */
  function currentConvo() { return __conversations.find(c => c.id === currentConversationId) || null; }
  /* ═══════════ Media store (IndexedDB) ═══════════
     Images are base64 data URLs (~1 MB). localStorage holds ~5 MB in total, so big
     media goes to IndexedDB and localStorage keeps only a key. */
  const IMG_DB = 'miroxai-media', IMG_STORE = 'media';
  function idbOpen() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(IMG_DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(IMG_STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function mediaPut(key, val) {
    try {
      const db = await idbOpen();
      return await new Promise((res, rej) => {
        const tx = db.transaction(IMG_STORE, 'readwrite');
        tx.objectStore(IMG_STORE).put(val, key);
        tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
      });
    } catch { return false; }
  }
  async function mediaGet(key) {
    try {
      const db = await idbOpen();
      return await new Promise((res, rej) => {
        const q = db.transaction(IMG_STORE).objectStore(IMG_STORE).get(key);
        q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error);
      });
    } catch { return null; }
  }
  const BIG = 20000;
  function saveChats() {
    for (const c of __conversations) {
      for (const m of c.messages || []) {
        if (!m.id) m.id = uid();
        if (typeof m.image === 'string' && m.image.length > BIG) {
          m.imageKey = 'img:' + m.id; mediaPut(m.imageKey, m.image); m.image = null;
        }
        if (Array.isArray(m.files)) {
          m.files.forEach((f, i) => {
            if (f && typeof f.dataUrl === 'string' && f.dataUrl.length > BIG) {
              f.dataKey = 'file:' + m.id + ':' + i; mediaPut(f.dataKey, f.dataUrl); f.dataUrl = null;
            }
          });
        }
      }
    }
    safeSet(LS_KEY, __conversations);
  }
  /* Put stored media back into an already-rendered conversation */
  async function hydrateMedia(convo) {
    for (const m of convo.messages || []) {
      const el = document.querySelector('#chatMessages [data-msg-id="' + m.id + '"]');
      if (!el) continue;
      if (m.imageKey && !el.querySelector('.gen-image')) {
        const url = await mediaGet(m.imageKey);
        if (url) {
          const wrap = document.createElement('div');
          wrap.className = 'gen-image';
          wrap.innerHTML = '<img src="' + url + '" alt="" draggable="false">';
          wrap.querySelector('img').onclick = () => openImageViewer(url);
          el.querySelector('.bubble')?.insertBefore(wrap, el.querySelector('.bubble').firstChild);
        }
      }
      if (Array.isArray(m.files)) {
        const chips = el.querySelectorAll('.attach-chip');
        for (let i = 0; i < m.files.length; i++) {
          const f = m.files[i];
          if (f && f.dataKey && f.type === 'image') {
            const url = await mediaGet(f.dataKey);
            const img = chips[i]?.querySelector('img');
            if (url && img) img.src = url;
          }
        }
      }
    }
  }
  function fileIconHTML(name) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    const map = {
      pdf: 'ri-file-pdf-2-line', doc: 'ri-file-word-2-line', docx: 'ri-file-word-2-line',
      xls: 'ri-file-excel-2-line', xlsx: 'ri-file-excel-2-line', csv: 'ri-file-excel-2-line',
      ppt: 'ri-file-ppt-2-line', pptx: 'ri-file-ppt-2-line',
      js: 'ri-javascript-line', ts: 'ri-javascript-line', py: 'ri-code-s-slash-line', html: 'ri-html5-line',
      css: 'ri-css3-line', json: 'ri-braces-line', java: 'ri-code-s-slash-line', c: 'ri-code-s-slash-line',
      cpp: 'ri-code-s-slash-line', go: 'ri-code-s-slash-line', rs: 'ri-code-s-slash-line', sh: 'ri-terminal-box-line',
      zip: 'ri-file-zip-line', rar: 'ri-file-zip-line', '7z': 'ri-file-zip-line',
      png: 'ri-image-line', jpg: 'ri-image-line', jpeg: 'ri-image-line', gif: 'ri-image-line', webp: 'ri-image-line',
      md: 'ri-markdown-line', txt: 'ri-file-text-line'
    };
    return '<i class="' + (map[ext] || 'ri-file-line') + ' attach-icon"></i>';
  }
  function flashSearchHit() {
    const q = (__chatSearch || '').trim().toLowerCase();
    if (!q) return;
    const hit = $$('#chatMessages .message').find(m => (m.textContent || '').toLowerCase().includes(q));
    if (hit) { hit.scrollIntoView({ behavior: 'smooth', block: 'center' }); hit.classList.add('flash-hit'); setTimeout(() => hit.classList.remove('flash-hit'), 1800); }
  }
  function loadChats() { __conversations = safeGet(LS_KEY, []); }

  function welcomeHTML() {
    return `<div class="welcome-screen">
      <div class="welcome-mascot">
        ${mascotHTML('mascot-lg wave')}
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
    bindSuggestionClicks(); renderHistory();
  }
  function bindSuggestionClicks() {
    $$('.suggestion-card').forEach(card => {
      if (card.__wired) return; card.__wired = true;
      card.onclick = () => {
        const p = card.dataset.prompt;
        if (p && p.startsWith('Open the Bridge workspace')) { openBridgeWorkspace(); return; }
        const inp = $('#messageInput');
        if (p && inp) { inp.value = p; updateSendButtonState(); handleSend(); }
      };
    });
  }
  let __chatSearch = '';
  function escHL(text, q) {
    const s = String(text || '');
    const i = q ? s.toLowerCase().indexOf(q) : -1;
    if (i < 0) return escapeHtml(s);
    return escapeHtml(s.slice(0, i)) + '<mark>' + escapeHtml(s.slice(i, i + q.length)) + '</mark>' + escapeHtml(s.slice(i + q.length));
  }
  function snippetAround(text, q) {
    const s = String(text || ''); const i = s.toLowerCase().indexOf(q);
    if (i < 0) return '';
    const start = Math.max(0, i - 30);
    return (start ? '…' : '') + s.slice(start, i + q.length + 60);
  }
  function renderHistory() {
    const list = $('#historyList'); if (!list) return;
    const q = (__chatSearch || '').trim().toLowerCase();
    if (q) {
      const hits = [];
      for (const c of __conversations) {
        const msg = (c.messages || []).find(m => String(m.content || '').toLowerCase().includes(q));
        const titleHit = String(c.title || '').toLowerCase().includes(q);
        if (msg || titleHit) hits.push({ c, snippet: msg ? snippetAround(msg.content, q) : '' });
      }
      list.innerHTML = hits.length ? hits.map(({ c, snippet }) =>
        `<li class="history-item search-hit${c.id === currentConversationId ? ' active' : ''}" data-id="${c.id}">
          <i class="ri-chat-search-line"></i>
          <span class="history-title">${escHL(c.title || 'Chat', q)}</span>
          ${snippet ? `<span class="hit-snippet">${escHL(snippet, q)}</span>` : ''}
        </li>`).join('') : '<li class="history-empty">No matches</li>';
      return;
    }
    if (!__conversations.length) { list.innerHTML = '<li class="history-empty">No conversations yet</li>'; return; }
    list.innerHTML = __conversations.map((c, i) =>
      `<li class="history-item${c.id === currentConversationId ? ' active' : ''}" data-id="${c.id}" style="animation-delay:${Math.min(i * 25, 250)}ms">
        <i class="ri-chat-3-line"></i>
        <span class="history-title">${escapeHtml(c.title || 'Chat')}</span>
        <button class="history-delete icon-btn"><i class="ri-delete-bin-line"></i></button>
      </li>`
    ).join('');
  }
    function scrollToBottom() { const c = $('#chatMessages'); if (c) c.scrollTop = c.scrollHeight; }

  function fmtSize(n) { if (n == null) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }

  function addMessageToDOM(role, content, ts, msgId, files, image, thinkLabel) {
    const container = $('#chatMessages'); if (!container) return null;
    const welcome = container.querySelector('.welcome-screen'); if (welcome) welcome.remove();
    const id = msgId || uid();
    const el = document.createElement('div');
    el.className = 'message ' + (role === 'user' ? 'user' : 'ai');
    el.dataset.msgId = id; el.dataset.role = role;
    let inner = '';
    if (role === 'user' && files && files.length) {
      inner += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;">';
      for (const f of files) {
        if (f.type === 'image' && (f.dataUrl || f.dataKey)) inner += `<div class="attach-chip"><img src="${f.dataUrl || ''}" alt="">${escapeHtml(f.name || '')}${f.size ? ` <span class="attach-size">${fmtSize(f.size)}</span>` : ''}</div>`;
        else inner += `<div class="attach-chip">${fileIconHTML(f.name)}${escapeHtml(f.name || 'file')}${f.size ? ` <span class="attach-size">${fmtSize(f.size)}</span>` : ''}</div>`;
      }
      inner += '</div>';
    }
    if (role !== 'user' && image) {
      inner += `<div style="margin-bottom:10px;border-radius:14px;overflow:hidden;border:1px solid var(--border);max-width:100%;cursor:zoom-in;"><img src="${image}" style="display:block;width:100%;" draggable="false"></div>`;
    }
    inner += '<div class="bubble-text"></div>';
    el.innerHTML = `<div class="bubble">${inner}</div>
      <div class="message-actions">
        <button class="action-btn" data-action="copy"><i class="ri-file-copy-line"></i></button>
        ${role !== 'user' ? '<button class="action-btn" data-action="retry"><i class="ri-refresh-line"></i></button>' : ''}
      </div>
      <div class="message-time">${ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</div>`;
    container.appendChild(el);
    if (thinkLabel && role !== 'user') { const p = createThinkPanel(thinkLabel, ''); p.finish(); el.insertBefore(p.el, el.firstChild); }
    const bt = el.querySelector('.bubble-text');
    const bubble = el.querySelector('.bubble');
    if (role === 'user') { bt.textContent = content || ''; if (!content) bt.style.display = 'none'; }
    else { bubble.dataset.rawText = content || ''; if (content) { bt.innerHTML = renderMarkdown(content); wireCopyButtons(bt); } }
    if (role !== 'user' && image) { const img = el.querySelector('img'); if (img) img.onclick = () => openImageViewer(image); }
    wireMessageActions(el); scrollToBottom();
    return el;
  }

  function wireMessageActions(el) {
    el.querySelectorAll('.action-btn').forEach(btn => {
      if (btn.__wired) return; btn.__wired = true;
      btn.onclick = async () => {
        const action = btn.dataset.action;
        const bubble = el.querySelector('.bubble');
        if (action === 'copy') {
          try { await navigator.clipboard.writeText(bubble?.innerText || ''); btn.innerHTML = '<i class="ri-check-line"></i>'; setTimeout(() => { btn.innerHTML = '<i class="ri-file-copy-line"></i>'; }, 1200); } catch {}
        } else if (action === 'retry') {
          if (isReplying) return;
          handleRetry(el);
        }
      };
    });
  }
  async function handleRetry(el) {
    if (isReplying) return;
    const convo = currentConvo(); if (!convo) return;
    const id = el.dataset.msgId;
    const idx = (convo.messages || []).findIndex(m => m.id === id);
    if (idx < 0) return;
    let userMsg = null;
    for (let i = idx - 1; i >= 0; i--) if (convo.messages[i].role === 'user') { userMsg = convo.messages[i]; break; }
    if (!userMsg) return;
    convo.messages = convo.messages.slice(0, idx); saveChats();
    let s = el.nextElementSibling;
    while (s) { const n = s.nextElementSibling; s.remove(); s = n; }
    el.remove();
    sendToAPI(userMsg.content, userMsg.files || []);
  }

  function updateSendButtonState() {
    const btn = $('#sendBtn'), inp = $('#messageInput');
    if (!btn || !inp) return;
    const has = inp.value.trim().length > 0 || pendingFiles.length > 0;
    const enable = has && !isReplying;
    btn.classList.toggle('is-disabled', !enable);
    btn.setAttribute('aria-disabled', String(!enable));
  }
  function handleSend() {
    if (isReplying) return;
    const inp = $('#messageInput'); if (!inp) return;
    const text = inp.value.trim();
    if (!text && !pendingFiles.length) return;
    const files = pendingFiles.slice();
    const searchFlag = forceSearchNext; forceSearchNext = false;
    const searchBtn = $('#searchModeBtn'); if (searchBtn) searchBtn.classList.remove('active');
    if (!currentConversationId) {
      currentConversationId = uid();
      __conversations.unshift({ id: currentConversationId, title: text.slice(0, 60) || 'New chat', messages: [], created: Date.now() });
    }
    const msgId = uid();
    const convo = currentConvo();
    if (convo) convo.messages.push({ id: msgId, role: 'user', content: text, ts: Date.now(), files });
    addMessageToDOM('user', text, Date.now(), msgId, files);
    inp.value = ''; inp.style.height = 'auto';
    pendingFiles = []; updatePreview(); updateSendButtonState();
    saveChats(); renderHistory();
    sendToAPI(text, files, searchFlag);
  }

  async function sendToAPI(text, files, forceSearch) {
    isReplying = true; updateSendButtonState();
    const stopBtn = $('#stopBtn'); if (stopBtn) stopBtn.style.display = 'grid';
    const convo = currentConvo();
    const history = convo ? convo.messages.slice(-14).map(m => ({ role: m.role, content: m.content })) : [];
    const model = __model || 'mirox-luna-1.2';

    const buildIntent = /\b(build|create|make|write|scaffold|generate|develop|code)\b.*\b(app|site|website|game|project|page|landing|dashboard|api|script|bot|tool|todo|chat|portfolio)\b/i.test(text);
    if (buildIntent) {
      setTimeout(() => { toast('Tip: open Bridge — it can actually write the files and run your project.', 4200); }, 400);
    }

    const container = $('#chatMessages');
    const welcome = container?.querySelector('.welcome-screen'); if (welcome) welcome.remove();

    /* Thinking message with expandable reasoning panel */
    const msgEl = document.createElement('div');
    msgEl.className = 'message ai';
    const aiMsgId = uid();
    msgEl.dataset.msgId = aiMsgId; msgEl.dataset.role = 'ai';
    const label = pickStatusLabel(text);
    const panel = createThinkPanel(label, makeReasoning(text));
    msgEl.appendChild(panel.el);
    const timeEl = document.createElement('div');
    timeEl.className = 'message-time';
    msgEl.appendChild(timeEl);
    container?.appendChild(msgEl);
    scrollToBottom();

    activeStreamController = new AbortController();
    let full = '', generatedImage = null, bubble = null, bubbleText = null, gotToken = false;

    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text, history, model, stream: true, files, search: !!forceSearch,
          bridge: __bridge.connected ? { connected: true, name: __bridge.name, model: __bridge.model, env: __bridge.env } : null,
        }),
        signal: activeStreamController.signal,
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error?.message || `HTTP ${res.status}`); }
      const reader = res.body.getReader(); const dec = new TextDecoder();
      let buf = '', searchStepAdded = false;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const pl = line.slice(5).trim();
          if (!pl || pl === '[DONE]') continue;
          try {
            const o = JSON.parse(pl);
            if (o.search && o.search.query && !searchStepAdded) {
              searchStepAdded = true;
              panel.addStep(`Searching the web for "${o.search.query}"…`, 'run');
            }
            if (o.overview && o.overview.text) {
              panel.addStep(`Overview from ${o.overview.source || 'web'} acquired`, 'ok');
            }
            if (o.source && o.source.title) {
              panel.addStep(`Source: ${o.source.title}`, 'ok');
            }
            if (o.search_done) {
              panel.addStep(`Search finished — ${o.count || 0} result(s)`, 'ok');
            }
            if (o.p) {
              panel.addStep(`Connected to ${o.p} · generating…`, 'ok');
            }
            if (o.img) {
              generatedImage = o.img;
              panel.markWriting();
              if (!bubble) {
                bubble = document.createElement('div');
                bubble.className = 'bubble';
                msgEl.insertBefore(bubble, timeEl);
              }
              bubble.innerHTML = `<div style="margin-bottom:10px;border-radius:14px;overflow:hidden;border:1px solid var(--border);max-width:100%;cursor:zoom-in;"><img src="${o.img}" style="display:block;width:100%;" draggable="false"></div><div class="bubble-text"></div>`;
              bubbleText = bubble.querySelector('.bubble-text');
              const img = bubble.querySelector('img'); if (img) img.onclick = () => openImageViewer(o.img);
              scrollToBottom(); refreshUsage(); continue;
            }
            if (o.d) {
              full += o.d;
              if (!gotToken) {
                gotToken = true;
                panel.markWriting();
                if (!bubble) {
                  bubble = document.createElement('div');
                  bubble.className = 'bubble';
                  msgEl.insertBefore(bubble, timeEl);
                }
                bubble.innerHTML = '<div class="bubble-text"></div>';
                bubbleText = bubble.querySelector('.bubble-text');
              }
              if (bubbleText) { bubbleText.innerHTML = renderMarkdown(full); wireCopyButtons(bubbleText); }
              scrollToBottom();
            }
            if (o.error) throw new Error(o.error.message || o.error);
          } catch (e) { if (e instanceof SyntaxError) {} else throw e; }
        }
      }
      panel.finish();
      if (bubbleText) { bubbleText.innerHTML = renderMarkdown(full); wireCopyButtons(bubbleText); }
      wireMessageActions(msgEl);
      if (convo) convo.messages.push({ id: aiMsgId, role: 'assistant', content: full, ts: Date.now(), image: generatedImage, thinkLabel: label });
      saveChats();
      if (timeEl) timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      refreshUsage();
    } catch (e) {
      panel.destroy();
      if (!bubble) {
        bubble = document.createElement('div');
        bubble.className = 'bubble';
        msgEl.insertBefore(bubble, timeEl);
      }
      bubble.textContent = e.name === 'AbortError' ? '(stopped)' : 'Error: ' + e.message;
    } finally {
      isReplying = false; activeStreamController = null;
      if (stopBtn) stopBtn.style.display = 'none';
      updateSendButtonState();
    }
  }
  function stopStreaming() {
    if (activeStreamController) { try { activeStreamController.abort(); } catch {} activeStreamController = null; }
    isReplying = false;
    const s = $('#stopBtn'); if (s) s.style.display = 'none';
    updateSendButtonState();
  }

  /* ═══════════ Files & paste-as-attachment ═══════════ */
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
    if (pendingFiles.some(f => f.type === 'text' && f.content === String(text).slice(0, 60000))) { toast('Attachment already added', 2000); return; }
    const fname = name || ('pasted-' + new Date().toISOString().slice(11, 19).replace(/:/g, '-') + '.txt');
    pendingFiles.push({ name: fname, size: text.length, type: 'text', content: String(text).slice(0, 60000) });
    updatePreview(); updateSendButtonState();
    toast(`Large text added as attachment (${fmtSize(text.length)})`, 2200);
  }
  function handleFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const seen = new Set(); let dupes = 0;
    const arr = Array.from(fileList).filter(f => {
      const key = f.name + '|' + f.size;
      if (seen.has(key) || pendingFiles.some(p => p.name === f.name && p.size === f.size)) { dupes++; return false; }
      seen.add(key); return true;
    });
    if (dupes) toast('Attachment already added', 2000);
    if (!arr.length) return;
    let done = 0; const newFiles = [];
    arr.forEach((f, idx) => {
      const isImg = (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(f.name);
      if (isImg) {
        readImageAsResizedDataUrl(f).then((dataUrl) => {
          if (dataUrl) newFiles.push({ name: f.name, size: f.size, type: 'image', dataUrl, order: idx });
          done++; if (done === arr.length) finish();
        }).catch(() => { done++; if (done === arr.length) finish(); });
      } else {
        const r = new FileReader();
        r.onload = () => { newFiles.push({ name: f.name, size: f.size, type: 'text', content: String(r.result).slice(0, 60000), order: idx }); done++; if (done === arr.length) finish(); };
        r.onerror = () => { done++; if (done === arr.length) finish(); };
        r.readAsText(f);
      }
    });
    function finish() {
      newFiles.sort((a, b) => (a.order || 0) - (b.order || 0));
      pendingFiles = pendingFiles.concat(newFiles);
      updatePreview(); updateSendButtonState();
    }
  }
  function updatePreview() {
    const p = $('#attachmentPreview'), list = $('#attachmentList'); if (!p || !list) return;
    if (!pendingFiles.length) { p.style.display = 'none'; list.innerHTML = ''; return; }
    p.style.display = 'flex';
    list.innerHTML = pendingFiles.map(f => f.type === 'image' && f.dataUrl
      ? `<div class="attach-chip"><img src="${f.dataUrl}" alt="">${escapeHtml(f.name)}${f.size ? ` <span class="attach-size">${fmtSize(f.size)}</span>` : ''}</div>`
      : `<div class="attach-chip">${fileIconHTML(f.name)}${escapeHtml(f.name)}${f.size ? ` <span class="attach-size">${fmtSize(f.size)}</span>` : ''}</div>`
    ).join('');
  }

  /* ═══════════ Toast ═══════════ */
  function toast(msg, ms) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);max-width:min(560px,calc(100vw - 32px));text-align:center;background:var(--panel);color:var(--text);border:1px solid var(--border);padding:10px 16px;border-radius:12px;font-size:13px;box-shadow:var(--shadow-lg);z-index:9999;animation:bubbleIn .3s var(--ease-spring);';
    document.body.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 350); }, ms || 1800);
  }

  /* ═══════════ Image viewer & history ═══════════ */
  let __ivDataUrl = '';
  function openImageViewer(url) {
    if (!url) return;
    __ivDataUrl = url;
    const iv = $('#imageViewer'); if (!iv) return;
    iv.classList.add('open');
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => { const c = $('#ivCanvas'); if (!c) return; c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); };
    img.src = url;
  }
  function closeImageViewer() { $('#imageViewer')?.classList.remove('open'); }

  let __imageCache = [];
  async function fetchImageHistory() {
    try {
      const res = await fetch('/api/images/history', { credentials: 'same-origin', cache: 'no-store' });
      const data = await res.json();
      return (data && data.images) || [];
    } catch { return []; }
  }
  async function renderImageHistory() {
    const wrap = $('#imageHistory'); if (!wrap) return;
    wrap.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:13px;">Loading…</div>';
    const items = await fetchImageHistory();
    __imageCache = items;
    if (!items.length) { wrap.innerHTML = '<div style="padding:14px;color:var(--text-faint);font-size:13px;text-align:center;grid-column:1/-1;">No images yet.</div>'; return; }
    wrap.innerHTML = items.map((it, i) => `
      <div class="image-history-item" data-idx="${i}" style="animation-delay:${Math.min(i * 30, 300)}ms">
        <img src="${it.image}" alt="" loading="lazy">
        <div class="image-history-prompt">${escapeHtml(it.prompt || '')}</div>
      </div>
    `).join('');
    wrap.querySelectorAll('.image-history-item').forEach(el => {
      el.onclick = () => { const i = parseInt(el.dataset.idx, 10); const it = items[i]; if (it) openImageViewer(it.image); };
    });
  }
  async function renderSidebarImageHistory() {
    const wrap = $('#sidebarImageHistory'); if (!wrap) return;
    wrap.innerHTML = '<div class="sidebar-empty">Loading…</div>';
    const items = await fetchImageHistory();
    __imageCache = items;
    if (!items.length) { wrap.innerHTML = '<div class="sidebar-empty">No images yet.</div>'; return; }
    wrap.innerHTML = items.map((it, i) => `
      <div class="sidebar-image-item" data-idx="${i}" title="${escapeHtml(it.prompt || '')}" style="animation-delay:${Math.min(i * 30, 300)}ms">
        <img src="${it.image}" alt="" loading="lazy">
      </div>
    `).join('');
    wrap.querySelectorAll('.sidebar-image-item').forEach(el => {
      el.onclick = () => { const i = parseInt(el.dataset.idx, 10); const it = items[i]; if (it) openImageViewer(it.image); };
    });
  }

  /* ═══════════ Model picker / credits / config ═══════════ */
  function getModelsList() { return __config?.models?.length ? __config.models : FALLBACK_MODELS; }
  function canUseModel(tier) { if (tier === 'free') return true; if (tier === 'ultimate') return true; return TIER_RANK[__tier] >= TIER_RANK[tier]; }
  function renderModelPicker() {
    const menu = $('#modelPickerMenu'); if (!menu) return;
    const models = getModelsList(); const cur = __model || models[0].id;
    menu.innerHTML = models.map(m => {
      const usable = canUseModel(m.tier); const lock = usable ? '' : ' locked';
      return `<div class="model-option${m.id === cur ? ' active' : ''}${lock}" data-model-id="${m.id}" data-usable="${usable}">
        <span class="model-option-label"><span class="dot"></span>${escapeHtml(m.label)}</span></div>`;
    }).join('');
    menu.querySelectorAll('.model-option').forEach(opt => {
      opt.onclick = (e) => { e.stopPropagation(); if (opt.dataset.usable === 'false') { toast('Upgrade to use this model'); return; } selectModel(opt.dataset.modelId); };
    });
    const c = models.find(m => m.id === cur);
    if (c) { const lbl = $('#currentModelLabel'); if (lbl) lbl.textContent = c.label; }
  }
  function selectModel(id) { if (!id) return; __model = id; const m = getModelsList().find(x => x.id === id); if (m) { const lbl = $('#currentModelLabel'); if (lbl) lbl.textContent = m.label; } renderModelPicker(); closeModelPicker(); }
  function openModelPicker() { $('#modelPicker')?.classList.add('open'); $('#modelPickerMenu')?.classList.add('open'); }
  function closeModelPicker() { $('#modelPicker')?.classList.remove('open'); $('#modelPickerMenu')?.classList.remove('open'); }

  function renderCreditBar() {
    const bar = $('#creditBar'); if (!bar) return;
    if (!__usage || __tier !== 'free') { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    const setPill = (sel, used, limit) => {
      const pill = bar.querySelector(sel); if (!pill) return;
      const txt = pill.querySelector('span'); const rem = Math.max(0, limit - used);
      if (txt) txt.textContent = `${rem}/${limit}`;
      pill.classList.toggle('low', rem <= Math.max(1, Math.floor(limit * 0.25)) && rem > 0);
      pill.classList.toggle('empty', rem <= 0);
    };
    setPill('[data-credit="vision"]', __usage.vision_used || 0, __usage.vision_limit || 10);
    setPill('[data-credit="image"]', __usage.image_used || 0, __usage.image_limit || 10);
    setPill('[data-credit="eclipse"]', __usage.eclipse_used || 0, __usage.eclipse_limit || 5);
  }
  async function refreshUsage() {
    const res = await authJson('/api/me', {}, null);
    if (!res?.user) {
      __user = null; __usage = null; __tier = 'free'; renderCreditBar();
      const chip = $('#userChip');
      if (chip) { chip.querySelector('.user-name').textContent = 'Guest mode'; chip.querySelector('.user-sub').textContent = 'Sign in to save chats'; }
      return;
    }
    __user = res.user; __tier = res.user.tier || 'free';
    __usage = { vision_limit: res.user.vision_limit ?? 10, vision_used: res.user.vision_used ?? 0,
      image_limit: res.user.image_limit ?? 10, image_used: res.user.image_used ?? 0,
      eclipse_limit: res.user.eclipse_limit ?? 5, eclipse_used: res.user.eclipse_used ?? 0 };
    renderCreditBar();
    const chip = $('#userChip');
    if (chip) { chip.querySelector('.user-name').textContent = res.user.name || res.user.email; chip.querySelector('.user-sub').textContent = (__tier.charAt(0).toUpperCase() + __tier.slice(1)) + ' plan'; }
    renderModelPicker();
  }
  async function loadConfig() {
    try { const res = await fetch('/api/config', { cache: 'no-store' }); const data = await res.json(); if (data?.models?.length) __config = data; } catch {}
    if (!__config) __config = { models: FALLBACK_MODELS };
    __model = getModelsList()[0].id; renderModelPicker();
  }
  async function doLogin(e) {
    if (e) e.preventDefault();
    const name = $('#loginName')?.value.trim(); const email = $('#loginEmail')?.value.trim().toLowerCase();
    if (!name || !email) return;
    const res = await authJson('/api/auth/simple-login', { method: 'POST', body: JSON.stringify({ name, email }) }, null);
    if (res?.ok) { setToken(res.token); closeModal('loginModal'); await refreshUsage(); toast('Welcome, ' + name + '!'); }
    else alert(res?.error || 'Login failed');
  }
  function doLoginment() { window.location.href = '/api/auth/loginment/start'; }
  async function doLogout() { await authJson('/api/logout', { method: 'POST' }, null); setToken(''); await refreshUsage(); closeModal('settingsModal'); toast('Signed out'); }
  async function loadPlans() {
    const grid = $('#plansGrid'); if (!grid) return;
    const res = await authJson('/api/subscription/plans', {}, null);
    if (!res?.plans) { grid.innerHTML = '<div class="history-empty">Could not load.</div>'; return; }
    grid.innerHTML = res.plans.map(p => {
      const isCurrent = p.id === __tier;
      const price = p.id === 'free' ? '<div style="font-size:26px;font-weight:700;">Free</div>'
        : `<div style="font-size:32px;font-weight:700;">$${p.price_usd.toFixed(2)}</div>`;
      return `<div class="plan-card${isCurrent ? ' current' : ''}"><div class="plan-name">${escapeHtml(p.label)}</div><div class="plan-tagline">${escapeHtml(p.tagline || '')}</div>${price}<ul style="font-size:13px;color:var(--text-muted);line-height:1.8;margin-top:8px;">${(p.perks || []).map(x => `<li>✓ ${escapeHtml(x)}</li>`).join('')}</ul></div>`;
    }).join('');
  }
  async function loadPersona() { if (!__user) return; const res = await authJson('/api/persona', {}, null); const inp = $('#personaInput'); if (inp && res?.persona) inp.value = res.persona; }
  async function savePersona() {
    const status = $('#personaStatus');
    if (!__user) { if (status) { status.textContent = 'Sign in first.'; status.className = 'persona-status err'; } return; }
    const inp = $('#personaInput'); if (!inp) return;
    if (status) { status.textContent = 'Saving…'; status.className = 'persona-status'; }
    const res = await authJson('/api/persona', { method: 'POST', body: JSON.stringify({ persona: inp.value.trim() }) }, null);
    if (res?.ok) { if (status) { status.textContent = 'Saved ✓'; status.className = 'persona-status ok'; } setTimeout(() => { if (status) status.textContent = ''; }, 2000); }
    else { if (status) { status.textContent = 'Failed.'; status.className = 'persona-status err'; } }
  }
  async function genImage() {
    const inp = $('#imagePrompt'); const prompt = inp?.value.trim();
    if (!prompt) return alert('Describe the image first.');
    const btn = $('#generateImageBtn'), result = $('#imageResult');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ri-loader-4-line" style="animation:spin 1s linear infinite;"></i> Generating…'; }
    if (result) result.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);"><i class="ri-loader-4-line" style="animation:spin 1s linear infinite;font-size:22px;color:var(--accent);"></i><div style="margin-top:8px;font-size:13px;">Painting your image…</div></div>';
    try {
      const res = await fetch('/v1/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, aspect_ratio: '1:1' }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok && data.image) { if (result) result.innerHTML = `<img src="${data.image}" alt="${escapeHtml(prompt)}">`; refreshUsage(); renderImageHistory(); renderSidebarImageHistory(); }
      else if (result) result.innerHTML = `<div style="color:#dc2626;font-size:13px;">Failed: ${escapeHtml(data.error?.message || 'Unknown')}</div>`;
    } catch (e) { if (result) result.innerHTML = `<div style="color:#dc2626;font-size:13px;">Error: ${escapeHtml(e.message)}</div>`; }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ri-image-add-line"></i> Generate'; } }
  }

  /* ═══════════ Bridge ═══════════ */
  function loadBridgeLS() { const b = safeGet(BRIDGE_KEY, {}); __bridge = { ...__bridge, ...b, connected: false, baseUrl: null, env: null }; }
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
    else try { localStorage.removeItem(KDE_DEVICE_KEY); } catch {}
  }

  function renderBridgeStatus() {
    [['#bridgeStatus', '.bridge-status-dot'], ['#bwStatusPill', '.bridge-status-dot'], ['#bwStatusBox', '.bridge-status-dot']].forEach(([sel, dotSel]) => {
      const wrap = document.querySelector(sel); if (!wrap) return;
      const dot = wrap.querySelector(dotSel); const txt = wrap.querySelector('span');
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
    const ar = $('#bwToggleAutoRun'); if (ar) ar.classList.toggle('active', __bridgeAutoRun);
    const sc = $('#bwToggleShowCode'); if (sc) sc.classList.toggle('active', __bridgeShowCode);
    const sb = $('#bwStopBtn'); if (sb) sb.style.display = bridgeRunning ? 'inline-flex' : 'none';
  }
  function renderSudoStatus() {
    const s = $('#bwSudoStatus');
    if (!s) return;
    if (__sudoPassword) { s.textContent = __sudoRemember ? 'Password saved (session)' : 'Password set (temporary)'; s.style.color = 'var(--success)'; }
    else { s.textContent = 'No password saved'; s.style.color = ''; }
  }
  function renderKdeStatus() {
    const box = $('#bwKdeBox'); const txt = $('#bwKdeStatus');
    if (!box || !txt) return;
    if (__kdeAvailable) { txt.textContent = 'KDE Connect ready'; box.style.color = 'var(--success)'; }
    else { txt.textContent = 'KDE Connect: not installed'; box.style.color = 'var(--text-muted)'; }
    renderKdeDeviceList();
  }
  function renderKdeDeviceList() {
    const wrap = $('#bwDeviceList'); if (!wrap) return;
    if (!__kdeAvailable) {
      wrap.innerHTML = '<div class="bw-hint" style="margin-top:6px;">Install on the bridge: <code>sudo apt install kdeconnect</code></div>';
      return;
    }
    if (!__kdeDevices.length) {
      wrap.innerHTML = '<div class="bw-hint" style="margin-top:6px;">No devices found. Tap <b>Scan for devices</b>.</div>';
      return;
    }
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
      </div>
    `).join('');
    wrap.querySelectorAll('.bw-device-row').forEach(row => {
      const id = row.dataset.id;
      const dev = __kdeDevices.find(x => x.id === id);
      row.querySelector('[data-kde-pick]')?.addEventListener('click', () => {
        __kdeCurrentDevice = { id: dev.id, name: dev.name };
        saveKdeDevice(); renderKdeDeviceList();
        toast(`Selected: ${dev.name}`);
      });
      row.querySelector('[data-kde-ping]')?.addEventListener('click', async () => {
        toast(`Pinging ${dev.name}…`);
        try { const r = await bridgeCall('/kde/ping', { device: dev.id }); toast(r.ok ? `📱 ${dev.name} is online` : `✗ No response`); } catch { toast('Ping failed'); }
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
      const cmdEl = $('#sudoCommandText'); if (cmdEl) cmdEl.textContent = command || '';
      const pwd = $('#sudoPasswordInput'); if (pwd) { pwd.value = ''; pwd.type = 'password'; }
      const rev = $('#sudoRevealBtn'); if (rev) rev.innerHTML = '<i class="ri-eye-line"></i>';
      const hint = $('#sudoHint'); if (hint) { hint.textContent = ''; hint.className = 'sudo-hint'; }
      modal.classList.add('open');
      setTimeout(() => { pwd?.focus(); }, 100);
    });
  }
  function closeSudoModal() { $('#sudoModal')?.classList.remove('open'); }
  function submitSudo() {
    const pwd = $('#sudoPasswordInput')?.value || '';
    const remember = !!$('#sudoRememberChk')?.checked;
    const hint = $('#sudoHint');
    if (!pwd) { if (hint) { hint.textContent = 'Enter your password.'; hint.className = 'sudo-hint err'; } return; }
    __sudoPassword = pwd; __sudoRemember = !!remember;
    closeSudoModal(); renderSudoStatus();
    if (__sudoResolver) { __sudoResolver({ password: pwd, remember }); __sudoResolver = null; }
  }
  function skipSudo() { closeSudoModal(); if (__sudoResolver) { __sudoResolver(null); __sudoResolver = null; } }
  function forgetSudo() { __sudoPassword = ''; __sudoRemember = false; renderSudoStatus(); toast('Sudo password forgotten.'); }
  async function askSudo(command) {
    if (__sudoPassword) return { password: __sudoPassword, remember: __sudoRemember, reused: true };
    return await showSudoModal(command);
  }

  async function testBridge(port) {
    for (const host of ['localhost', '127.0.0.1']) {
      try {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(`http://${host}:${port}/ping`, { signal: ctrl.signal, mode: 'cors' });
        clearTimeout(t);
        if (r.ok) { const d = await r.json(); if (d && d.ok) return { ok: true, data: d, base: `http://${host}:${port}` }; }
      } catch {}
    }
    return { ok: false };
  }
  async function fetchEnv(base) {
    try { const r = await fetch(`${base}/env`, { mode: 'cors' }); if (!r.ok) return null; const d = await r.json(); if (d && d.ok) return d; } catch {}
    return null;
  }
  async function startBridge() {
    const name = ($('#bwNameInput')?.value || __bridge.name).trim();
    const model = $('#bwModelSelect')?.value || __bridge.model;
    const port = parseInt($('#bwPortInput')?.value || __bridge.port, 10);
    __bridge.name = name; __bridge.model = model; __bridge.port = port;
    saveBridgeLS(); renderBridgeStatus(); setBwHint('Connecting…', '');
    const res = await testBridge(port);
    if (res.ok) {
      __bridge.connected = true; __bridge.baseUrl = res.base;
      __bridge.env = await fetchEnv(res.base);
      __kdeAvailable = !!__bridge.env?.kde_connect_available;
      renderBridgeStatus(); renderKdeStatus();
      const empty = $('#bridgeEmpty'); if (empty) empty.remove();
      const home = __bridge.env?.home || '(unknown)';
      setBwHint(`Connected · Home: ${home}`, 'ok');
      addBridgeSystemMsg(`Connected. Home: ${home}`);
      if (__kdeAvailable) addBridgeSystemMsg('KDE Connect detected.');
    } else {
      __bridge.connected = false; __bridge.baseUrl = null; __bridge.env = null; __kdeAvailable = false;
      renderBridgeStatus(); renderKdeStatus();
      setBwHint(`Could not reach the bridge on port ${port}.`, 'err');
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
    const r = await fetch(__bridge.baseUrl + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }
  function downloadBridgeClient() {
    const params = new URLSearchParams({ name: __bridge.name, port: String(__bridge.port), model: __bridge.model });
    const a = document.createElement('a'); a.href = '/api/bridge/download?' + params.toString(); a.download = 'mirox_client_bridge.zip';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  function setBwHint(text, cls = '') { const el = $('#bwConnectHint'); if (!el) return; el.textContent = text; el.className = 'bw-hint' + (cls ? ' ' + cls : ''); }
  function updateBridgeSendBtn() {
    const btn = $('#bridgeSendBtn'), inp = $('#bridgeInput'); if (!btn || !inp) return;
    const has = inp.value.trim().length > 0;
    const enabled = __bridge.connected && !bridgeRunning && has;
    btn.classList.toggle('is-disabled', !enabled);
    btn.setAttribute('aria-disabled', String(!enabled));
    renderToggles();
  }
  function openBridgeWorkspace() {
    $('#bridgeWorkspace')?.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => { if (__bridge.connected) startBridge(); }, 50);
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
    if (__lastBuildFolder) { s.textContent = __lastBuildFolder; s.style.color = 'var(--success)'; }
    else { s.textContent = 'No project yet'; s.style.color = ''; }
  }

  function addBridgeUserMsg(text) {
    const container = $('#bridgeMessages'); if (!container) return;
    const empty = $('#bridgeEmpty'); if (empty) empty.remove();
    const el = document.createElement('div'); el.className = 'bridge-msg user';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `<div class="bridge-bubble">${escapeHtml(text).replace(/\n/g, '<br>')}</div><div class="bridge-meta">You · ${time}</div>`;
    container.appendChild(el); scrollBridgeBottom();
  }
  function addBridgeAiMsg(text) {
    let clean = sanitizeForChat(text);
    if (!clean) return null;
    const container = $('#bridgeMessages'); if (!container) return null;
    const empty = $('#bridgeEmpty'); if (empty) empty.remove();
    const el = document.createElement('div'); el.className = 'bridge-msg ai';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `<div class="bridge-bubble">${escapeHtml(clean).replace(/\n/g, '<br>')}</div><div class="bridge-meta">Mirox · ${time}</div>`;
    container.appendChild(el); scrollBridgeBottom();
    return el;
  }
  function addBridgeSystemMsg(text) {
    const container = $('#bridgeMessages'); if (!container) return;
    const empty = $('#bridgeEmpty'); if (empty) empty.remove();
    const el = document.createElement('div'); el.className = 'bridge-msg system';
    el.innerHTML = `<div class="bridge-bubble">${escapeHtml(text)}</div>`;
    container.appendChild(el); scrollBridgeBottom();
  }
  function addBridgeSuccessMsg(text, extras) {
    const container = $('#bridgeMessages'); if (!container) return;
    const el = document.createElement('div'); el.className = 'bridge-msg ai';
    const e = extras || {};
    let buttons = '';
    if (e.previewPath) buttons += `<button class="bridge-success-btn" data-preview="${escapeHtml(e.previewPath)}"><i class="ri-eye-line"></i> Preview</button>`;
    if (e.folder) buttons += `<button class="bridge-success-btn" data-copy-folder="${escapeHtml(e.folder)}"><i class="ri-folder-open-line"></i> Copy path</button>`;
    el.innerHTML = `<div class="bridge-success">
      <div class="bridge-success-head"><i class="ri-checkbox-circle-fill"></i><span>${escapeHtml(text)}</span></div>
      ${buttons ? `<div class="bridge-success-actions">${buttons}</div>` : ''}
    </div>`;
    el.querySelectorAll('[data-preview]').forEach(b => b.onclick = () => openPreview(b.dataset.preview));
    el.querySelectorAll('[data-copy-folder]').forEach(b => b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.copyFolder); toast('Path copied.'); } catch {}
    });
    container.appendChild(el); scrollBridgeBottom();
  }
  function addBridgeThinkingBubble(label) {
    const container = $('#bridgeMessages'); if (!container) return null;
    const empty = $('#bridgeEmpty'); if (empty) empty.remove();
    const el = document.createElement('div'); el.className = 'bridge-msg ai';
    const text = escapeHtml(label || 'Thinking');
    el.innerHTML = `<div class="bridge-thinking">${mascotHTML('mascot-xs thinking')}<span>${text}</span><span class="thinking-dots"><span></span><span></span><span></span></span></div>`;
    container.appendChild(el); scrollBridgeBottom();
    return el;
  }

  function addBridgeActionBubble(cmd) {
    const container = $('#bridgeMessages'); if (!container) return null;
    const el = document.createElement('div'); el.className = 'bridge-msg ai';
    const data = getActionData(cmd);
    el.innerHTML = `<div class="bridge-action">
      <div class="bridge-action-head">
        <div class="bridge-action-icon ${data.iconClass}"><i class="${data.icon}"></i></div>
        <div class="bridge-action-label">${data.label}</div>
        <span class="bridge-action-status working"><i class="ri-loader-4-line"></i> Working</span>
      </div>
      <div class="bridge-action-code" style="display:none;"></div>
    </div>`;
    container.appendChild(el); scrollBridgeBottom();
    return el;
  }
  function updateBridgeActionBubble(el, cmd, result) {
    if (!el) return;
    const status = el.querySelector('.bridge-action-status'); if (!status) return;
    const ok = result && result.ok;
    if (ok) { status.className = 'bridge-action-status ok'; status.innerHTML = '<i class="ri-check-line"></i> Done'; }
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
  function getActionData(cmd) {
    const t = cmd.type;
    const base = getBaseName(cmd.path) || getBaseName(cmd.from) || '';
    if (t === 'kde-list') return { icon: 'ri-radar-line', iconClass: 'list', label: 'Scanning devices' };
    if (t === 'kde-refresh') return { icon: 'ri-refresh-line', iconClass: 'list', label: 'Refreshing' };
    if (t === 'kde-ping') return { icon: 'ri-wifi-line', iconClass: 'exec', label: `Pinging device` };
    if (t === 'kde-ring') return { icon: 'ri-notification-3-line', iconClass: 'exec', label: 'Ringing device' };
    if (t === 'kde-share') return { icon: 'ri-send-plane-fill', iconClass: 'write', label: `Sending <code>${escapeHtml(getBaseName(cmd.path) || cmd.path)}</code>` };
    if (t === 'kde-share-text') return { icon: 'ri-file-text-line', iconClass: 'write', label: 'Sharing text' };
    if (t === 'kde-sms') return { icon: 'ri-message-3-line', iconClass: 'write', label: `SMS` };
    if (t === 'kde-lock') return { icon: 'ri-lock-line', iconClass: 'exec', label: 'Locking device' };
    if (t === 'kde-notifications') return { icon: 'ri-notification-badge-line', iconClass: 'read', label: 'Notifications' };
    if (t === 'kde-plugins') return { icon: 'ri-puzzle-line', iconClass: 'list', label: 'Plugins' };
    if (t === 'kde-photo') return { icon: 'ri-camera-lens-line', iconClass: 'write', label: 'Photo' };
    if (t === 'kde-myid') return { icon: 'ri-fingerprint-line', iconClass: 'read', label: 'Own ID' };
    if (t === 'sudo') return { icon: 'ri-shield-keyhole-line', iconClass: 'exec', label: `sudo` };
    if (t === 'write') return { icon: 'ri-file-add-line', iconClass: 'write', label: `Writing <code>${escapeHtml(base)}</code>` };
    if (t === 'append') return { icon: 'ri-file-edit-line', iconClass: 'write', label: `Appending <code>${escapeHtml(base)}</code>` };
    if (t === 'delete') return { icon: 'ri-delete-bin-line', iconClass: 'exec', label: `Deleting <code>${escapeHtml(base)}</code>` };
    if (t === 'move') return { icon: 'ri-drag-move-line', iconClass: 'exec', label: `Moving <code>${escapeHtml(base)}</code>` };
    if (t === 'copy') return { icon: 'ri-file-copy-2-line', iconClass: 'exec', label: `Copying <code>${escapeHtml(base)}</code>` };
    if (t === 'read') return { icon: 'ri-file-text-line', iconClass: 'read', label: `Reading <code>${escapeHtml(base)}</code>` };
    if (t === 'list') return { icon: 'ri-folder-line', iconClass: 'list', label: `Listing <code>${escapeHtml(base || cmd.path)}</code>` };
    if (t === 'sysinfo') return { icon: 'ri-cpu-line', iconClass: 'list', label: 'System info' };
    if (t === 'syscheck') return { icon: 'ri-heart-pulse-line', iconClass: 'list', label: 'Health check' };
    if (t === 'processes') return { icon: 'ri-list-check-2', iconClass: 'list', label: 'Processes' };
    if (t === 'email') return { icon: 'ri-mail-send-line', iconClass: 'write', label: `Email` };
    if (t === 'http') return { icon: 'ri-global-line', iconClass: 'exec', label: `HTTP` };
    if (t === 'clipboard') return { icon: 'ri-clipboard-line', iconClass: 'read', label: 'Clipboard' };
    if (t === 'screenshot') return { icon: 'ri-screenshot-2-line', iconClass: 'list', label: 'Screenshot' };
    if (t === 'git') return { icon: 'ri-git-branch-line', iconClass: 'exec', label: `Git ${escapeHtml(cmd.action || '')}` };
    if (t === 'pkgs') return { icon: 'ri-archive-line', iconClass: 'list', label: `Packages` };
    if (t === 'exec') {
      let friendly = 'Running command';
      const c = cmd.command;
      if (/^npm\s+(install|i)/i.test(c)) friendly = 'Installing packages';
      else if (/^pip\s+install/i.test(c)) friendly = 'Installing Python packages';
      else if (/^mkdir/i.test(c)) friendly = 'Creating folder';
      else if (/^(ls|dir)\b/i.test(c)) friendly = 'Listing files';
      else if (/^(cat|type)\b/i.test(c)) friendly = 'Reading file';
      else if (/^(python|python3)\s/i.test(c)) friendly = 'Running Python';
      else if (/^node\s/i.test(c)) friendly = 'Running Node';
      else if (/^git\s/i.test(c)) friendly = 'Git operation';
      else if (/^npm\s+run/i.test(c)) friendly = 'Running project';
      return { icon: 'ri-play-line', iconClass: 'exec', label: friendly };
    }
    return { icon: 'ri-terminal-line', iconClass: '', label: 'Working' };
  }
  function getBaseName(p) { if (!p) return ''; const parts = String(p).split('/'); return parts[parts.length - 1] || p; }

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

  /* ---------- Bridge tag extraction ---------- */
  function extractBridgeCommands(text) {
    const cmds = []; let m;
    const add = (type, m, extra) => cmds.push(Object.assign({ type, index: m.index }, extra));
    let re;
    re = /<bridge-kde-refresh\s*\/>/g; while ((m = re.exec(text)) !== null) add('kde-refresh', m, {});
    re = /<bridge-kde-list(?:\s+available="([^"]*)")?\s*\/>/g; while ((m = re.exec(text)) !== null) add('kde-list', m, { available: m[1] === 'true' });
    re = /<bridge-kde-ping\s+device="([^"]+)"(?:\s*\/>|>([\s\S]*?)<\/bridge-kde-ping>)/g; while ((m = re.exec(text)) !== null) add('kde-ping', m, { device: m[1], message: (m[2] || '').trim() });
    re = /<bridge-kde-ring\s+device="([^"]+)"\s*\/>/g; while ((m = re.exec(text)) !== null) add('kde-ring', m, { device: m[1] });
    re = /<bridge-kde-share\s+device="([^"]+)"\s+path="([^"]+)"\s*\/>/g; while ((m = re.exec(text)) !== null) add('kde-share', m, { device: m[1], path: m[2] });
    re = /<bridge-kde-share-text\s+device="([^"]+)">([\s\S]*?)<\/bridge-kde-share-text>/g; while ((m = re.exec(text)) !== null) add('kde-share-text', m, { device: m[1], text: m[2] });
    re = /<bridge-kde-sms\s+device="([^"]+)"\s+number="([^"]+)">([\s\S]*?)<\/bridge-kde-sms>/g; while ((m = re.exec(text)) !== null) add('kde-sms', m, { device: m[1], number: m[2], message: m[3] });
    re = /<bridge-kde-lock\s+device="([^"]+)"\s*\/>/g; while ((m = re.exec(text)) !== null) add('kde-lock', m, { device: m[1] });
    re = /<bridge-kde-notifications\s+device="([^"]+)"\s*\/>/g; while ((m = re.exec(text)) !== null) add('kde-notifications', m, { device: m[1] });
    re = /<bridge-kde-plugins\s+device="([^"]+)"\s*\/>/g; while ((m = re.exec(text)) !== null) add('kde-plugins', m, { device: m[1] });
    re = /<bridge-kde-photo\s+device="([^"]+)"(?:\s+path="([^"]*)")?\s*\/>/g; while ((m = re.exec(text)) !== null) add('kde-photo', m, { device: m[1], path: m[2] || '' });
    re = /<bridge-kde-my-id\s*\/>/g; while ((m = re.exec(text)) !== null) add('kde-myid', m, {});
    re = /<bridge-sudo>([\s\S]*?)<\/bridge-sudo>/g; while ((m = re.exec(text)) !== null) add('sudo', m, { command: m[1].trim() });
    re = /<bridge-exec>([\s\S]*?)<\/bridge-exec>/g; while ((m = re.exec(text)) !== null) add('exec', m, { command: m[1].trim() });
    re = /<bridge-write\s+path="([^"]+)">([\s\S]*?)<\/bridge-write>/g; while ((m = re.exec(text)) !== null) add('write', m, { path: m[1], content: m[2] });
    re = /<bridge-append\s+path="([^"]+)">([\s\S]*?)<\/bridge-append>/g; while ((m = re.exec(text)) !== null) add('append', m, { path: m[1], content: m[2] });
    re = /<bridge-delete\s+path="([^"]+)"\s*\/>/g; while ((m = re.exec(text)) !== null) add('delete', m, { path: m[1] });
    re = /<bridge-move\s+from="([^"]+)"\s+to="([^"]+)"\s*\/>/g; while ((m = re.exec(text)) !== null) add('move', m, { from: m[1], to: m[2] });
    re = /<bridge-copy\s+from="([^"]+)"\s+to="([^"]+)"\s*\/>/g; while ((m = re.exec(text)) !== null) add('copy', m, { from: m[1], to: m[2] });
    re = /<bridge-read\s+path="([^"]+)"\s*\/>/g; while ((m = re.exec(text)) !== null) add('read', m, { path: m[1] });
    re = /<bridge-list\s+path="([^"]+)"\s*\/>/g; while ((m = re.exec(text)) !== null) add('list', m, { path: m[1] });
    re = /<bridge-sysinfo\s*\/>/g; while ((m = re.exec(text)) !== null) add('sysinfo', m, {});
    re = /<bridge-syscheck\s*\/>/g; while ((m = re.exec(text)) !== null) add('syscheck', m, {});
    re = /<bridge-processes\s*\/>/g; while ((m = re.exec(text)) !== null) add('processes', m, {});
    re = /<bridge-email\s+to="([^"]+)"\s+subject="([^"]*)">([\s\S]*?)<\/bridge-email>/g; while ((m = re.exec(text)) !== null) add('email', m, { to: m[1], subject: m[2], body: m[3] });
    re = /<bridge-http\s+url="([^"]+)"(?:\s+method="([^"]*)")?(?:\s*\/>|>([\s\S]*?)<\/bridge-http>)/g; while ((m = re.exec(text)) !== null) add('http', m, { url: m[1], method: m[2] || 'GET', body: m[3] || '' });
    re = /<bridge-clipboard\s+action="(get|set)"(?:\s*>([\s\S]*?)<\/bridge-clipboard>|\s*\/>)/g; while ((m = re.exec(text)) !== null) add('clipboard', m, { action: m[1], content: m[2] || '' });
    re = /<bridge-screenshot(?:\s+path="([^"]*)")?\s*\/>/g; while ((m = re.exec(text)) !== null) add('screenshot', m, { path: m[1] || '' });
    re = /<bridge-git\s+action="([^"]+)"(?:\s+cwd="([^"]*)")?(?:\s+message="([^"]*)")?\s*\/>/g; while ((m = re.exec(text)) !== null) add('git', m, { action: m[1], cwd: m[2] || '', message: m[3] || '' });
    re = /<bridge-pkgs\s+type="([^"]+)"(?:\s+cwd="([^"]*)")?\s*\/>/g; while ((m = re.exec(text)) !== null) add('pkgs', m, { pkgType: m[1], cwd: m[2] || '' });
    cmds.sort((a, b) => a.index - b.index);
    return cmds;
  }
  function hasUnclosedWriteOrAppend(text) {
    const t = String(text || '');
    const opensW = (t.match(/<bridge-write\b/g) || []).length;
    const closesW = (t.match(/<\/bridge-write>/g) || []).length;
    const opensA = (t.match(/<bridge-append\b/g) || []).length;
    const closesA = (t.match(/<\/bridge-append>/g) || []).length;
    return (opensW > closesW) || (opensA > closesA);
  }
  function lastWriteOrAppendPath(text) {
    const t = String(text || '');
    const matches = [...t.matchAll(/<bridge-(?:write|append)\s+path="([^"]+)"/g)];
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
  function extractBridgePlan(text) {
    const m = /<bridge-plan>([\s\S]*?)<\/bridge-plan>/.exec(text);
    if (!m) return null;
    const files = [];
    for (const line of m[1].split('\n')) {
      const l = line.trim().replace(/^[-*+]\s*/, '').replace(/^["']|["']$/g, '');
      if (l && (l.includes('/') || /\.\w{1,8}$/.test(l))) files.push(l);
    }
    return files.length ? files : null;
  }
  function extractBridgeQuestions(text) {
    const qs = []; const re = /<bridge-ask>([\s\S]*?)<\/bridge-ask>/g; let m;
    while ((m = re.exec(text)) !== null) {
      const lines = m[1].trim().split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      const question = lines[0];
      const options = [];
      for (let i = 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('-') || l.startsWith('*')) options.push(l.replace(/^[-*]\s*/, '').trim());
      }
      qs.push({ question, options });
    }
    return qs;
  }
  function extractProgressTag(text) {
    const m = /<bridge-progress\s+step="(\d+)"\s+total="(\d+)"(?:\s+label="([^"]*)")?\s*\/>/.exec(text);
    if (!m) return null;
    return { step: parseInt(m[1], 10), total: parseInt(m[2], 10), label: m[3] || '' };
  }
  function getNarrationText(text) { return sanitizeForChat(text); }
  function looksLikeFreeQuestion(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (/(?:^|\n)\s*asking\(\s*\)/i.test(t)) return true;
    const stripped = t.replace(/\bDONE\b/i, '').trim();
    if (!stripped) return false;
    if (!/\?\s*$/.test(stripped)) return false;
    if (/<bridge-/.test(stripped)) return false;
    return true;
  }
  function isEnvQuestion(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    const envWords = ['bridge environment', 'environment block', 'allowed dir', 'allowed path', 'allowed dirs', 'allowed paths', 'which directory', 'what directory', 'which path', 'what path'];
    for (const w of envWords) if (q.includes(w)) return true;
    if (q.includes('paste') && (q.includes('environment') || q.includes('bridge'))) return true;
    return false;
  }
  function buildEnvBlockString() {
    const env = __bridge.env || {};
    const allowed = Array.isArray(env.allowed_dirs) && env.allowed_dirs.length ? env.allowed_dirs.join(', ') : '(none)';
    const home = env.home || '(unknown)';
    const cwd = env.cwd || home;
    const user = env.user || (home ? home.split('/').filter(Boolean).pop() : '(unknown)');
    return [
      `[Bridge environment]`,
      `user=${user}`,
      `home=${home}`,
      `cwd=${cwd}`,
      `platform=${env.platform || '(unknown)'}`,
      `allowed_dirs=${allowed}`,
      `kdeConnect=${env.kde_connect_available ? 'true' : 'false'}`,
      __kdeCurrentDevice ? `currentKdeDevice=${__kdeCurrentDevice.id} name="${__kdeCurrentDevice.name}"` : '',
      ``,
      `CRITICAL:`,
      `- Never paste code, CSS, HTML, or JS into your visible reply. All file content goes inside <bridge-write> or <bridge-append> tags.`,
      `- Always CLOSE your tags. Never leave a <bridge-write> or <bridge-append> open.`,
      `- For long files, write the first chunk with <bridge-write>, then use <bridge-append> for the rest.`,
    ].filter(Boolean).join('\n');
  }

  async function kdeListDevices(availableOnly = false) {
    if (!__bridge.connected) throw new Error('Bridge not connected');
    const r = await bridgeCall('/kde/list', { available: !!availableOnly });
    if (r && r.devices) { __kdeDevices = r.devices; __kdeAvailable = !!r.installed; renderKdeStatus(); }
    return r;
  }
  async function askDeviceChoice(devices) {
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
          card.dataset.id = d.id;
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
            <button class="planner-choose-btn" type="button"><i class="ri-check-line"></i> Choose</button>
          `;
          grid.appendChild(card);
          card.querySelector('.planner-choose-btn').addEventListener('click', () => {
            __kdeCurrentDevice = { id: d.id, name: d.name };
            saveKdeDevice(); renderKdeDeviceList(); closeKdeModal();
            resolve({ id: d.id, name: d.name });
          });
        });
      }
      modal.classList.add('open');
    });
  }
  function closeKdeModal() { $('#kdeModal')?.classList.remove('open'); }
  function kdeSkip() { closeKdeModal(); if (__kdeResolver) { __kdeResolver(null); __kdeResolver = null; } }

  async function refreshKdeDevices(showModal) {
    if (!__bridge.connected) return null;
    try { await bridgeCall('/kde/refresh', {}); } catch {}
    let r; try { r = await kdeListDevices(false); } catch { return null; }
    if (!r || !r.ok) return null;
    const devices = r.devices || [];
    if (!showModal) { renderKdeDeviceList(); return devices; }
    if (!devices.length) { await askDeviceChoice([]); return []; }
    const reachable = devices.filter(d => d.reachable);
    if (reachable.length === 1) {
      __kdeCurrentDevice = { id: reachable[0].id, name: reachable[0].name };
      saveKdeDevice(); renderKdeDeviceList();
      toast(`Using ${reachable[0].name}`);
      return devices;
    }
    const pick = await askDeviceChoice(devices);
    return pick ? devices : null;
  }

  async function executeBridgeCommand(cmd) {
    const t = cmd.type;
    if (t.startsWith('kde-')) {
      if (!__kdeAvailable) return { ok: false, error: 'kdeconnect-cli not installed', install_hint: 'sudo apt install kdeconnect' };
      let deviceId = cmd.device || '';
      if (!deviceId && __kdeCurrentDevice) deviceId = __kdeCurrentDevice.id;
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
    if (t === 'write') return bridgeCall('/write', { path: cmd.path, content: cmd.content });
    if (t === 'append') return bridgeCall('/append', { path: cmd.path, content: cmd.content });
    if (t === 'delete') return bridgeCall('/delete', { path: cmd.path });
    if (t === 'move') return bridgeCall('/move', { from: cmd.from, to: cmd.to });
    if (t === 'copy') return bridgeCall('/copy', { from: cmd.from, to: cmd.to });
    if (t === 'read') return bridgeCall('/read', { path: cmd.path });
    if (t === 'list') return bridgeCall('/list', { path: cmd.path });
    if (t === 'sysinfo') return bridgeCall('/sysinfo', {});
    if (t === 'syscheck') return bridgeCall('/syscheck', {});
    if (t === 'processes') return bridgeCall('/processes', {});
    if (t === 'email') return bridgeCall('/email', { to: cmd.to, subject: cmd.subject, body: cmd.body });
    if (t === 'http') return bridgeCall('/http', { url: cmd.url, method: cmd.method, body: cmd.body });
    if (t === 'clipboard') return bridgeCall('/clipboard', { action: cmd.action, content: cmd.content });
    if (t === 'screenshot') return bridgeCall('/screenshot', { path: cmd.path });
    if (t === 'git') return bridgeCall('/git', { action: cmd.action, cwd: cmd.cwd, message: cmd.message });
    if (t === 'pkgs') return bridgeCall('/pkgs', { type: cmd.pkgType, cwd: cmd.cwd });
    return { ok: false, error: 'Unknown' };
  }

  function formatResultForAI(cmd, result) {
    const ok = result && result.ok;
    if (!ok) {
      const extra = result?.allowed_dirs ? `\nALLOWED: ${result.allowed_dirs.join(', ')}` : '';
      const hint = result?.install_hint ? `\nHINT: ${result.install_hint}` : '';
      return `[${cmd.type}] ERROR: ${(result && result.error) || 'unknown'}${extra}${hint}`;
    }
    const trunc = (s, n = 3000) => String(s || '').slice(0, n);
    if (cmd.type.startsWith('kde-')) {
      if (cmd.type === 'kde-list') {
        const list = (result.devices || []).map(d => `${d.reachable ? '*' : ' '} ${d.name} (${d.id})`).join('\n');
        return `[kde-list] ${result.devices?.length || 0} device(s)\n${list}${result.chosen ? `\nCHOSEN: ${result.chosen.name} (${result.chosen.id})` : ''}`;
      }
      if (cmd.type === 'kde-ping') { const d = result.device || {}; return `[kde-ping] ${result.online ? 'ONLINE' : 'OFFLINE'} · ${d.name || cmd.device}`; }
      if (cmd.type === 'kde-share') { const d = result.device || {}; return `[kde-share] sent → ${d.name || cmd.device}${result.was_dir ? ' (zipped)' : ''}`; }
      if (cmd.type === 'kde-myid') return `[kde-my-id] ${result.id}`;
      if (cmd.type === 'kde-refresh') return `[kde-refresh] ok`;
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
      case 'list': return `[list] path=${result.path}\n` + (result.items || []).map(i => (i.is_dir ? 'D ' : 'F ') + i.name).join('\n');
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
    if (t === 'write') return 'write:' + cmd.path + ':' + (cmd.content || '').length;
    if (t === 'append') return 'append:' + cmd.path + ':' + (cmd.content || '').length;
    if (t === 'delete') return 'delete:' + cmd.path;
    if (t === 'move') return 'move:' + cmd.from + '→' + cmd.to;
    if (t === 'copy') return 'copy:' + cmd.from + '→' + cmd.to;
    if (t === 'read') return 'read:' + cmd.path;
    if (t === 'list') return 'list:' + cmd.path;
    if (t === 'email') return 'email:' + cmd.to + ':' + (cmd.subject || '');
    if (t === 'http') return 'http:' + cmd.method + ':' + cmd.url;
    if (t === 'clipboard') return 'clipboard:' + cmd.action;
    if (t === 'screenshot') return 'screenshot:' + (cmd.path || 'default');
    if (t === 'git') return 'git:' + cmd.action + ':' + (cmd.cwd || '');
    if (t === 'pkgs') return 'pkgs:' + cmd.pkgType;
    if (t.startsWith('kde-')) return t + ':' + (cmd.device || '') + ':' + (cmd.path || cmd.text || cmd.number || '');
    return t;
  }
  function shouldBlockSignature(sig) {
    if (!bridgeTurn) return false;
    const count = bridgeTurn.commandLog.get(sig) || 0;
    if (bridgeTurn.failedSignatures.has(sig)) return true;
    if (count >= MAX_DUP_COMMANDS) return true;
    return false;
  }
  function showBridgeQuestionModal(q, index, total) {
    return new Promise((resolve) => {
      __bqResolver = resolve; __bqSelected = null;
      const modal = $('#bridgeQuestionModal'); if (!modal) { resolve(''); return; }
      const txt = $('#bqText'); if (txt) txt.textContent = q.question || '';
      const ctr = $('#bqCounter'); if (ctr) ctr.textContent = `Question ${index} of ${total}`;
      const progFill = $('#bqProgressFill'); if (progFill) progFill.style.width = Math.round(((index - 1) / total) * 100) + '%';
      const optsWrap = $('#bqOptions');
      if (optsWrap) {
        optsWrap.innerHTML = '';
        const cw = $('#bqCustomWrap');
        if (q.options && q.options.length) {
          if (cw) cw.style.display = 'none';
          q.options.forEach(opt => {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'question-option'; b.textContent = opt;
            b.onclick = () => { __bqSelected = opt; optsWrap.querySelectorAll('.question-option').forEach(x => x.classList.remove('selected')); b.classList.add('selected'); const ci = $('#bqCustomInput'); if (ci) ci.value = ''; };
            optsWrap.appendChild(b);
          });
        } else { if (cw) cw.style.display = 'block'; }
      }
      const ci = $('#bqCustomInput');
      if (ci) { ci.value = ''; ci.oninput = () => { if (ci.value.trim()) { __bqSelected = null; const ow = $('#bqOptions'); if (ow) ow.querySelectorAll('.question-option').forEach(x => x.classList.remove('selected')); } }; }
      modal.classList.add('open');
      setTimeout(() => { const f = document.querySelector('.question-option'); if (f) f.focus(); else $('#bqCustomInput')?.focus(); }, 100);
    });
  }
  function closeBridgeQuestionModal() { $('#bridgeQuestionModal')?.classList.remove('open'); }
  function submitBridgeQuestion() {
    const custom = $('#bqCustomInput')?.value.trim();
    const answer = custom || __bqSelected || '';
    if (!answer) return;
    closeBridgeQuestionModal();
    if (__bqResolver) { __bqResolver(answer); __bqResolver = null; }
  }
  function skipBridgeQuestion() { closeBridgeQuestionModal(); if (__bqResolver) { __bqResolver('[Skipped by user]'); __bqResolver = null; } }

  /* ---------- Planner ---------- */
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
          <button class="planner-choose-btn" type="button"><i class="ri-check-line"></i> Choose</button>
        `;
        card.appendChild(iframe); card.appendChild(footer); grid.appendChild(card);
        footer.querySelector('.planner-choose-btn').addEventListener('click', () => {
          closePlannerModal();
          resolve({ id: d.id, name: d.name });
        });
      });
      modal.classList.add('open');
    });
  }
  function closePlannerModal() { $('#plannerModal')?.classList.remove('open'); }
  let __plannerResolver = null;
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

  /* ---------- Verification ---------- */
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
    const el = document.createElement('div'); el.className = 'bridge-msg ai';
    const okCount = rows.filter(r => r.exists).length;
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
      </tr>
    `).join('');
    el.innerHTML = `
      <div class="verify-card ${allOk ? 'ok' : 'err'}">
        <div class="verify-header">${header}</div>
        <table class="verify-table">
          <thead><tr><th>#</th><th>File path</th><th>Status</th><th>Size</th></tr></thead>
          <tbody>${trs}</tbody>
        </table>
      </div>`;
    container.appendChild(el); scrollBridgeBottom();
  }
  function computeProjectRoot(paths, home) {
    if (!paths.length) return home || '';
    const norm = paths.map(p => String(p).replace(/\\/g, '/'));
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

  /* ---------- Bridge loop ---------- */
  async function fetchBridgeReply(history) {
    const envBlock = buildEnvBlockString();
    const lastMsg = history[history.length - 1];
    const messageWithEnv = `${envBlock}\n\n${lastMsg.content}`;
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: messageWithEnv,
        history: history.slice(0, -1).map(h => ({ role: h.role, content: h.content })),
        model: __bridge.model, stream: false,
        bridge: {
          connected: true, name: __bridge.name, model: __bridge.model, mode: 'developer', env: __bridge.env || {},
          sudoAvailable: true, plannerAvailable: true,
          kdeAvailable: __kdeAvailable, kdeDevice: __kdeCurrentDevice,
          filesWritten: bridgeTurn ? [...bridgeTurn.writtenFiles] : [],
          plannedFiles: bridgeTurn ? [...bridgeTurn.plannedFiles] : [],
          failedSignatures: bridgeTurn ? [...bridgeTurn.failedSignatures] : [],
          commandsRun: bridgeTurn ? bridgeTurn.commandsRun : 0,
        },
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    return data.reply || data.choices?.[0]?.message?.content || '';
  }
  async function autoContinueAfterDelay(label = 'Auto-continuing') {
    if (!__bridgeAutoRun) return;
    addBridgeSystemMsg(`${label} in ${AUTO_CONTINUE_DELAY_MS / 1000}s…`);
    setProgressText(`${label} in ${AUTO_CONTINUE_DELAY_MS / 1000}s…`);
    let remaining = AUTO_CONTINUE_DELAY_MS / 1000;
    const ticker = setInterval(() => { remaining--; if (remaining > 0) setProgressText(`${label} in ${remaining}s…`); else clearInterval(ticker); }, 1000);
    await new Promise(r => setTimeout(r, AUTO_CONTINUE_DELAY_MS));
    clearInterval(ticker);
  }

  async function runBridgeTurn(userText, isResume = false) {
    if (!__bridge.connected) { setBwHint('Bridge is not connected.', 'err'); return; }
    if (bridgeRunning) return;
    bridgeRunning = true; bridgeAbort = false;
    if (bridgeAutoTimer) { clearTimeout(bridgeAutoTimer); bridgeAutoTimer = null; }
    updateBridgeSendBtn();

    if (!isResume) {
      bridgeQuestionCount = 0;
      bridgeTaskComplete = false;
      bridgeWaitingForUser = false;
      bridgeTurn = { runs: 0, plannedFiles: new Set(), writtenFiles: new Set(), commandLog: new Map(), failedSignatures: new Set(), commandsRun: 0 };
      bridgeProgress = 0;
      updateBridgeProgress(2, 'Starting…');
      addBridgeUserMsg(userText);
      const lower = userText.toLowerCase();
      __lastBuildWasMobile = /\b(phone|mobile|tablet|android|iphone|ipad|device)\b/.test(lower);
      const starterText = `[System] Rules for this turn:
1. NEVER paste code into visible text. All file content goes inside <bridge-write>...</bridge-write> or <bridge-append>...</bridge-append>.
2. ALWAYS close tags. Never leave a <bridge-write> or <bridge-append> open.
3. If a file is long, write the first chunk with <bridge-write>, then use <bridge-append> for the rest.
4. Never complain about truncation. Never ask the user to pick a "plan" for a small file. Just build it.
5. Create projects inside <home>/<project-name>/.
6. When the whole project is on disk, reply DONE on its own line.

${userText}`;
      bridgeConversation.push({ role: 'user', content: starterText });
    } else {
      setProgressText('Continuing…');
    }

    let iter = 0, autoContinues = 0;
    try {
      while (iter++ < MAX_BRIDGE_ITER) {
        if (bridgeAbort) { addBridgeSystemMsg('Stopped by user.'); break; }
        bridgeTurn.runs++;
        const lastUser = bridgeConversation.filter(h => h.role === 'user').slice(-1)[0];
        const label = pickStatusLabel(lastUser?.content || '') || 'Working';
        const thinkingEl = addBridgeThinkingBubble(label);
        let reply = '';
        try { reply = await fetchBridgeReply(bridgeConversation); }
        catch (e) { if (thinkingEl) thinkingEl.remove(); addBridgeSystemMsg('AI error: ' + e.message); break; }
        if (thinkingEl) thinkingEl.remove();

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
          const narration0 = getNarrationText(reply.replace(/<bridge-designs>[\s\S]*?<\/bridge-designs>/g, ''));
          if (narration0) addBridgeAiMsg(narration0);
          addBridgeSystemMsg('Showing 3 designs — pick one.');
          bridgeConversation.push({ role: 'assistant', content: reply });
          if (bridgeConversation.length > 50) bridgeConversation = bridgeConversation.slice(-50);
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
        const plan = extractBridgePlan(reply);
        const prog = extractProgressTag(reply);
        const saidDone = /\bDONE\b/i.test(reply);
        const truncatedWrite = hasUnclosedWriteOrAppend(reply);
        const lastPath = lastWriteOrAppendPath(reply);

        if (!cmdsInReply.length && !questionsInReply.length && !saidDone && !truncatedWrite && looksLikeFreeQuestion(reply)) {
          const narrationQ = getNarrationText(reply);
          if (narrationQ) addBridgeAiMsg(narrationQ);
          addBridgeSystemMsg('Mirox is waiting for you — type your reply below.');
          bridgeConversation.push({ role: 'assistant', content: reply });
          if (bridgeConversation.length > 50) bridgeConversation = bridgeConversation.slice(-50);
          bridgeWaitingForUser = true;
          bridgeTaskComplete = true;
          setProgressText('Waiting for your reply…');
          updateBridgeSendBtn();
          return;
        }

        const tp = bridgeTurn.plannedFiles.size;
        const dc = bridgeTurn.writtenFiles.size;
        if (tp > 0) updateBridgeProgress(2 + Math.round((dc / tp) * 93), `Files: ${dc} / ${tp}`);
        else if (prog && prog.total > 0) updateBridgeProgress(Math.min(95, 2 + Math.round((prog.step / prog.total) * 93)), prog.label || `Step ${prog.step}/${prog.total}`);
        else updateBridgeProgress(Math.min(90, 5 + iter * 3), `Working… (step ${iter})`);

        if (plan && plan.length) { for (const f of plan) bridgeTurn.plannedFiles.add(f); addBridgeSystemMsg(`Planned ${plan.length} files`); }

        const narration = getNarrationText(reply);
        if (narration) addBridgeAiMsg(narration);

        bridgeConversation.push({ role: 'assistant', content: reply });
        if (bridgeConversation.length > 50) bridgeConversation = bridgeConversation.slice(-50);

        if (questionsInReply.length > 0 && !truncatedWrite) {
          const remaining = MAX_BRIDGE_QUESTIONS - bridgeQuestionCount;
          const toAsk = questionsInReply.slice(0, Math.max(0, remaining));
          if (toAsk.length > 0) {
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
            bridgeConversation.push({ role: 'user', content: `[System] User answered. Continue.` });
            continue;
          }
        }

        if (cmdsInReply.length > 0) {
          const resultLines = [];
          for (let i = 0; i < cmdsInReply.length; i++) {
            if (bridgeAbort) { resultLines.push('[abort] user stopped'); break; }
            const cmd = cmdsInReply[i];
            const sig = cmdSignature(cmd);
            if (shouldBlockSignature(sig)) { resultLines.push(`[${cmd.type}] BLOCKED`); continue; }
            bridgeTurn.commandLog.set(sig, (bridgeTurn.commandLog.get(sig) || 0) + 1);
            bridgeTurn.commandsRun++;
            const bubble = addBridgeActionBubble(cmd);
            let result;
            try { result = await executeBridgeCommand(cmd); } catch (e) { result = { ok: false, error: e.message }; }
            updateBridgeActionBubble(bubble, cmd, result);
            if (result && result.ok) { if (cmd.type === 'write') bridgeTurn.writtenFiles.add(cmd.path); }
            else { bridgeTurn.failedSignatures.add(sig); }
            resultLines.push(formatResultForAI(cmd, result));
          }
          const tp2 = bridgeTurn.plannedFiles.size;
          const dc2 = bridgeTurn.writtenFiles.size;
          if (tp2 > 0) updateBridgeProgress(2 + Math.round((dc2 / tp2) * 93), `Files: ${dc2} / ${tp2}`);
          const env = __bridge.env || {};
          const allowed = (env.allowed_dirs || []).join(', ') || '(none)';
          bridgeConversation.push({
            role: 'user',
            content: [`[Bridge environment]`, `home=${env.home || '?'}`, `cwd=${env.cwd || '?'}`, `platform=${env.platform || '?'}`, `allowed_dirs=${allowed}`, ``, `[Progress] ${dc2}/${tp2 || '?'} files`, `[Results]`, resultLines.join('\n\n'), `Write inside allowed_dirs only.`, `If done, reply DONE. Otherwise next batch.`].join('\n'),
          });
          if (truncatedWrite && lastPath) {
            bridgeConversation.push({ role: 'user', content: `[System] Your previous reply was cut off mid-file (path="${lastPath}"). Continue EXACTLY where you stopped using <bridge-append path="${lastPath}">...</bridge-append>. Close the tag.` });
          }
          continue;
        }

        if (truncatedWrite) {
          if (__bridgeAutoRun && autoContinues < MAX_AUTO_CONTINUES) {
            autoContinues++;
            const p = lastPath || 'your file';
            setProgressText('Continuing the truncated file…');
            bridgeConversation.push({ role: 'user', content: `[System] Your last reply ended with an unclosed <bridge-write> or <bridge-append> tag (path="${p}"). Continue from the LAST character you wrote. Emit <bridge-append path="${p}"> with the remaining content and CLOSE the tag with </bridge-append>. Do NOT restart the file. Do NOT re-explain. Do NOT ask questions.` });
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
          let projRoot = '';
          if (toVerify.length) {
            const rows = await buildVerificationTable(toVerify);
            renderVerificationTable(rows);
            const allOk = rows.every(r => r.exists);
            const home = __bridge.env?.home || '';
            projRoot = computeProjectRoot(rows.map(r => r.realPath), home);
            __lastBuildFolder = projRoot;
            const previewFile = rows.find(r => /(^|\/)index\.html?$/i.test(r.realPath));
            __lastPreviewFile = previewFile ? previewFile.realPath : (rows[0]?.realPath || '');
            updateBridgeProgress(100, allOk ? 'Complete' : 'Complete with warnings');
            addBridgeSuccessMsg(
              allOk ? `Project complete · ${rows.length} file${rows.length === 1 ? '' : 's'} · ${projRoot}` : `Finished · ${rows.filter(r => r.exists).length}/${rows.length} verified`,
              { folder: projRoot, previewPath: __lastPreviewFile || '' }
            );
            renderBuildStatus();
            if (__lastBuildWasMobile && __kdeAvailable && projRoot) {
              const sent = await offerKdeSend(projRoot);
              if (sent) addBridgeSuccessMsg(`Sent to ${sent.name}`);
            }
            if (__lastPreviewFile && /\.html?$/i.test(__lastPreviewFile)) {
              setTimeout(() => openPreview(__lastPreviewFile), 400);
            }
          } else {
            updateBridgeProgress(100, 'Complete');
            addBridgeSuccessMsg('Task complete');
          }
          bridgeTaskComplete = true;
          break;
        }
        if (saidDone && hasPlan && !allFilesWritten) {
          const missing = [...bridgeTurn.plannedFiles].filter(f => !bridgeTurn.writtenFiles.has(f));
          bridgeConversation.push({ role: 'user', content: `[System] Missing: ${missing.join(', ')}.` });
          continue;
        }

        if (!saidDone) {
          if (__bridgeAutoRun && autoContinues < MAX_AUTO_CONTINUES) {
            autoContinues++;
            await autoContinueAfterDelay('Auto-continuing');
            bridgeConversation.push({ role: 'user', content: `[System] Continue. Output the next actions. If you were writing a file, use <bridge-append> to add the rest and CLOSE the tag.` });
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

      const hasPlan = bridgeTurn.plannedFiles.size > 0;
      const allFilesWritten = hasPlan && bridgeTurn.writtenFiles.size >= bridgeTurn.plannedFiles.size;
      const missing = hasPlan ? [...bridgeTurn.plannedFiles].filter(f => !bridgeTurn.writtenFiles.has(f)) : [];
      if (!(allFilesWritten || !hasPlan) && !bridgeTaskComplete && !bridgeWaitingForUser && __bridgeAutoRun) {
        bridgeAutoTimer = setTimeout(() => {
          if (!__bridge.connected) return;
          const msg = missing.length ? `Continue. Missing: ${missing.join(', ')}` : 'Continue.';
          bridgeConversation.push({ role: 'user', content: `[System] ${msg}` });
          runBridgeTurn('', true);
        }, AUTO_CONTINUE_DELAY_MS);
      }
    } finally {
      bridgeRunning = false;
      updateBridgeSendBtn();
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
    const bubble = addBridgeActionBubble({ type: 'kde-share', path, device: device.id });
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
      if (!bridgeTurn) bridgeTurn = { runs: 0, plannedFiles: new Set(), writtenFiles: new Set(), commandLog: new Map(), failedSignatures: new Set(), commandsRun: 0 };
    } else {
      bridgeConversation = [];
      bridgeTaskComplete = true;
      if (bridgeAutoTimer) { clearTimeout(bridgeAutoTimer); bridgeAutoTimer = null; }
      bridgeTurn = null;
    }

    inp.value = ''; inp.style.height = 'auto';
    updateBridgeSendBtn();
    runBridgeTurn(text, false);
  }

  /* ---------- Preview ---------- */
  async function openPreview(pathOrEmpty) {
    const modal = $('#bwPreviewModal'); if (!modal) return;
    const frame = $('#bwPreviewFrame');
    const subtitle = $('#bwPreviewSubtitle');
    const pathInput = $('#bwPreviewPath');
    modal.classList.add('open');

    let targetPath = pathOrEmpty || pathInput?.value.trim() || __lastPreviewFile || '';
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

      const linkRe = /<link\s+[^>]*href=["']([^"']+\.css[^"']*)["'][^>]*>/gi;
      const cssMatches = [...html.matchAll(linkRe)];
      for (const m of cssMatches) {
        const href = m[1];
        if (/^https?:/i.test(href)) continue;
        const cssPath = href.startsWith('/') ? href : `${baseDir}/${href}`.replace(/\/\.\//g, '/');
        try {
          const cr = await bridgeCall('/read', { path: cssPath });
          if (cr && cr.ok) html = html.replace(m[0], `<style>\n${cr.content}\n</style>`);
        } catch {}
      }
      const scriptRe = /<script\s+[^>]*src=["']([^"']+\.js[^"']*)["'][^>]*>\s*<\/script>/gi;
      const jsMatches = [...html.matchAll(scriptRe)];
      for (const m of jsMatches) {
        const src = m[1];
        if (/^https?:/i.test(src)) continue;
        const jsPath = src.startsWith('/') ? src : `${baseDir}/${src}`.replace(/\/\.\//g, '/');
        try {
          const jr = await bridgeCall('/read', { path: jsPath });
          if (jr && jr.ok) html = html.replace(m[0], `<script>\n${jr.content}\n</script>`);
        } catch {}
      }
      if (frame) frame.srcdoc = html;
    } catch (e) {
      if (frame) frame.srcdoc = `<html><body style="font-family:system-ui;padding:40px;color:#b91c1c"><h2>Preview failed</h2><p>${escapeHtml(e.message)}</p></body></html>`;
    }
  }
  function closePreview() { $('#bwPreviewModal')?.classList.remove('open'); }

  /* ---------- Wiring ---------- */
  function wireAll() {
    on('#hamburgerBtn', 'click', openSidebar);
    on('#sidebarCloseBtn', 'click', closeSidebar);
    on('#sidebarScrim', 'click', closeSidebar);
    on('#brandLogo', 'click', (e) => { e.preventDefault(); startNewChat(); if (window.innerWidth <= 860) closeSidebar(); });
    on('#newChatBtn', 'click', () => { startNewChat(); if (window.innerWidth <= 860) closeSidebar(); });

    $$('.sidebar-tab').forEach(tab => {
      tab.onclick = () => {
        const t = tab.dataset.tab;
        $$('.sidebar-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === t));
        $$('.sidebar-section').forEach(s => { s.style.display = s.dataset.pane === t ? '' : 'none'; });
        if (t === 'images') renderSidebarImageHistory();
      };
    });

    on('#historyList', 'click', (e) => {
      const item = e.target.closest('.history-item'); if (!item) return;
      if (e.target.closest('.history-delete')) {
        const id = item.dataset.id;
        __conversations = __conversations.filter(c => c.id !== id);
        if (currentConversationId === id) startNewChat();
        saveChats(); renderHistory(); return;
      }
      const id = item.dataset.id;
      const convo = __conversations.find(c => c.id === id);
      if (!convo) return;
      currentConversationId = id;
      const t = $('#chatTitle'); if (t) t.textContent = convo.title || 'Chat';
      const c = $('#chatMessages'); if (c) c.innerHTML = '';
      for (const m of convo.messages || []) addMessageToDOM(m.role, m.content, m.ts, m.id, m.files || [], m.image || null, m.thinkLabel || '');
      hydrateMedia(convo);
      renderHistory(); scrollToBottom(); flashSearchHit();
      if (window.innerWidth <= 860) closeSidebar();
    });

    const inp = $('#messageInput');
    if (inp) {
      inp.addEventListener('input', () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 180) + 'px'; updateSendButtonState(); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleSend(); } });
      /* Paste-as-attachment: text bigger than 1KB becomes a file chip */
      inp.addEventListener('paste', (e) => {
        const cd = e.clipboardData;
        if (!cd) return;
        const text = cd.getData('text/plain') || '';
        if (text.length > PASTE_ATTACH_THRESHOLD) {
          e.preventDefault();
          addTextAttachment(text);
        }
      });
    }
    on('#sendBtn', 'click', handleSend);
    on('#attachBtn', 'click', () => $('#fileInput')?.click());
    on('#fileInput', 'change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
    on('#removeAttachmentBtn', 'click', () => { pendingFiles = []; updatePreview(); updateSendButtonState(); });
    on('#stopBtn', 'click', stopStreaming);
    on('#chatSearch', 'input', (e) => { __chatSearch = e.target.value || ''; renderHistory(); });
    on('#modelPickerBtn', 'click', (e) => { e.stopPropagation(); const menu = $('#modelPickerMenu'); if (menu?.classList.contains('open')) closeModelPicker(); else openModelPicker(); });
    document.addEventListener('click', (e) => { if (!e.target.closest('#modelPicker')) closeModelPicker(); });

    on('#searchModeBtn', 'click', (e) => {
      e.preventDefault();
      forceSearchNext = !forceSearchNext;
      const btn = $('#searchModeBtn'); if (btn) btn.classList.toggle('active', forceSearchNext);
      toast(forceSearchNext ? 'Web search enabled for next message.' : 'Web search disabled.');
      const ta = $('#messageInput');
      if (ta) { ta.placeholder = forceSearchNext ? 'What should I search the web for?' : 'How can I help you today? (paste big text → becomes an attachment)'; ta.focus(); }
    });

    on('#imageModeBtn', 'click', () => { openModal('imageModal'); renderImageHistory(); });
    on('#plansModeBtn', 'click', () => { openModal('plansModal'); loadPlans(); });
    on('#supportModeBtn', 'click', () => openModal('supportModal'));
    on('#supportModeBtn2', 'click', () => openModal('supportModal'));
    on('#bridgeModeBtn', 'click', openBridgeWorkspace);
    on('#bridgeOpenBtn', 'click', openBridgeWorkspace);
    on('#generateImageBtn', 'click', genImage);
    on('#submitReportBtn', 'click', () => { alert('Ticket submitted!'); closeModal('supportModal'); });
    on('#settingsBtn', 'click', () => { openModal('settingsModal'); loadPersona(); });
    on('#logoutBtn', 'click', doLogout);
    on('#savePersonaBtn', 'click', savePersona);
    on('#loginmentBtn', 'click', doLoginment);

    $$('.settings-tab').forEach(tab => {
      tab.onclick = () => { const t = tab.dataset.tab;
        $$('.settings-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === t));
        $$('.settings-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === t)); };
    });
    $$('[data-mode]').forEach(b => b.onclick = () => applyAppearance({ mode: b.dataset.mode, theme: document.documentElement.getAttribute('data-theme') || 'default' }));
    $$('.swatch').forEach(b => b.onclick = () => applyAppearance({ mode: document.documentElement.getAttribute('data-mode') || 'light', theme: b.dataset.theme }));
    document.addEventListener('click', (e) => {
      const cb = e.target.closest('[data-close]'); if (cb) { closeModal(cb.dataset.close); return; }
      if (e.target.classList.contains('modal-overlay') && e.target.id !== 'bridgeQuestionModal') e.target.classList.remove('open');
    });
    on('#userChip', 'click', () => { if (!__user) openModal('loginModal'); });
    on('#upgradeBtn', 'click', (e) => { e.stopPropagation(); if (!__user) openModal('loginModal'); else { openModal('plansModal'); loadPlans(); } });
    on('#simpleLoginForm', 'submit', doLogin);
    document.addEventListener('click', (e) => { if (e.target.closest('[data-iv-close]')) closeImageViewer(); });
    on('#ivDownload', 'click', () => { if (!__ivDataUrl) return; const a = document.createElement('a'); a.href = __ivDataUrl; a.download = `mirox-${Date.now()}.png`; document.body.appendChild(a); a.click(); document.body.removeChild(a); });

    /* Bridge */
    on('#bwCloseBtn', 'click', closeBridgeWorkspace);
    on('#bwNewBtn', 'click', clearBridgeChat);
    on('#bwDownloadBtn', 'click', downloadBridgeClient);
    on('#bridgeDownloadBtn', 'click', downloadBridgeClient);
    on('#bwConnectBtn', 'click', startBridge);
    on('#bwDisconnectBtn', 'click', stopBridge);
    on('#bwSudoForgetBtn', 'click', forgetSudo);
    on('#bwSideToggle', 'click', () => { $('#bwPanel')?.classList.toggle('side-open'); });

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
      if (devices && devices.length) toast(`Found ${devices.length} device${devices.length === 1 ? '' : 's'}`);
      else toast('No devices found yet.');
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
    on('#kdeRefreshBtn', 'click', async () => { const sub = $('#kdeSubtitle'); if (sub) sub.textContent = 'Rescanning…'; await refreshKdeDevices(true); });

    const bwInp = $('#bridgeInput');
    if (bwInp) {
      bwInp.addEventListener('input', () => { bwInp.style.height = 'auto'; bwInp.style.height = Math.min(bwInp.scrollHeight, 140) + 'px'; updateBridgeSendBtn(); });
      bwInp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleBridgeSend(); } });
    }
    on('#bridgeSendBtn', 'click', handleBridgeSend);
    $$('.bw-quick').forEach(btn => { btn.onclick = () => { const q = btn.dataset.q; const inp = $('#bridgeInput'); if (inp) { inp.value = q; updateBridgeSendBtn(); } handleBridgeSend(); }; });

    on('#bqCustomToggle', 'click', () => { const cw = $('#bqCustomWrap'); if (cw) { cw.style.display = cw.style.display === 'none' ? 'block' : 'none'; if (cw.style.display === 'block') $('#bqCustomInput')?.focus(); } });
    on('#bqSubmit', 'click', submitBridgeQuestion);
    on('#bqSkipOne', 'click', skipBridgeQuestion);
    on('#bqCustomInput', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitBridgeQuestion(); } });

    bindSuggestionClicks();

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeImageViewer(); closeModelPicker();
        if ($('#bwPreviewModal')?.classList.contains('open')) { closePreview(); return; }
        if ($('#kdeModal')?.classList.contains('open')) { kdeSkip(); return; }
        if ($('#plannerModal')?.classList.contains('open')) { plannerSkip(); return; }
        if ($('#sudoModal')?.classList.contains('open')) { skipSudo(); return; }
        if ($('#bridgeQuestionModal')?.classList.contains('open')) return;
        if ($('#bridgeWorkspace')?.classList.contains('open')) closeBridgeWorkspace();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('#messageInput')?.focus(); }
    });
    window.addEventListener('resize', () => { if (window.innerWidth > 860) { closeSidebar(); $('#bwPanel')?.classList.remove('side-open'); } });
  }

  async function init() {
    try {
      loadAppearance(); loadBridgeLS(); loadKdeDevice(); loadBridgeOpts(); wireAll(); renderModelPicker();
      renderBridgeStatus(); updateBridgeSendBtn(); renderKdeStatus(); renderBuildStatus();
      await loadConfig(); loadChats(); renderHistory(); await refreshUsage();
    } catch (e) { console.error('[Mirox init]', e); }
    finally { killLoader(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
