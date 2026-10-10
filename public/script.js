(function () {
  'use strict';

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
    { id: 'mirox-luna-1.2', label: 'Luna', tier: 'free', tagline: 'Fast, unlimited', icon: 'ri-moon-line' },
    { id: 'mirox-gen-1', label: 'Gen', tier: 'free', tagline: 'Concise, unlimited', icon: 'ri-flashlight-line' },
    { id: 'mirox-pro-5', label: 'Pro', tier: 'pro', tagline: 'Deeper reasoning', icon: 'ri-vip-diamond-line' },
    { id: 'mirox-ultra-10', label: 'Ultra', tier: 'pro', tagline: 'Long context', icon: 'ri-rocket-2-line' },
    { id: 'mirox-eclipse-2.0', label: 'Eclipse', tier: 'ultimate', tagline: 'Most powerful', icon: 'ri-sun-fill' },
  ];
  const TIER_RANK = { free: 0, pro: 1, ultimate: 2 };

  const LS_KEY = 'miroxai_conversations_v34';
  const TOKEN_KEY = 'mirox_token';
  const GUEST_KEY = 'miroxai_guest_id_v1';
  const APPEARANCE_KEY = 'miroxai_appearance_v34';
  const SHARE_KEY = 'miroxai_share_v5';
  const BONUS_KEY = 'miroxai_bonus_v5';
  const PREFS_KEY = 'miroxai_prefs_v1';
  const MCP_KEY = 'miroxai_mcp_v1';
  const PASTE_ATTACH_THRESHOLD = 1024;
  const NET_TIMEOUT_MS = 15000;
  const STREAM_TIMEOUT_MS = 120000;
  const BASE_FREE_LIMIT = 10000;
  const BONUS_TOKENS = 50000;
  const BONUS_MS = 7 * 24 * 60 * 60 * 1000;
  const BONUS_CHECK_MS = 30 * 1000;
  const MAX_IMAGE_DIM = 1280;

  let __config = null, __user = null, __tier = 'free', __model = 'mirox-luna-1.2';
  let currentConversationId = null, isReplying = false;
  let continuationBusy = false, streamRenderAt = 0, userIsAtBottom = true;
  let autoScrollEnabled = true;
  let __conversations = [], pendingFiles = [], activeStreamController = null, __usage = null;
  let forceSearchNext = false, __historyQuery = '';
  let __ivDataUrl = '';
  let __shareState = { claimed: false, claimedAt: 0, dismissedAt: 0 };
  let __bonusTimer = null;
  let __lastBonusActive = false;
  let __prefs = {};
  let __mcpServers = [];

  const uid = () => 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const escapeHtml = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  function safeGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
  function safeSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
  function safeRemove(k) { try { localStorage.removeItem(k); } catch {} }
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
  function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }

  /* ═══════════ GUEST IDENTITY ═══════════ */
  function getGuestId() {
    let id = null;
    try { id = localStorage.getItem(GUEST_KEY); } catch {}
    if (!id || id.length < 8) {
      id = 'g_' + Math.random().toString(36).slice(2, 14) + Date.now().toString(36).slice(-6);
      try { localStorage.setItem(GUEST_KEY, id); } catch {}
    }
    return id;
  }
  function resetGuestId() {
    const id = 'g_' + Math.random().toString(36).slice(2, 14) + Date.now().toString(36).slice(-6);
    try { localStorage.setItem(GUEST_KEY, id); } catch {}
    return id;
  }

  /* ═══════════ AUTH + BONUS PROOF HEADERS ═══════════ */
  function bonusProofHeaders() {
    const b = loadBonusRaw();
    if (!b || !isBonusValid(b)) return {};
    return {
      'X-Mirox-Guest': getGuestId(),
      'X-Mirox-Bonus-Tokens': String(b.tokens),
      'X-Mirox-Bonus-Expires': String(b.expiresAt),
      'X-Mirox-Bonus-Granted': String(b.grantedAt || 0),
    };
  }
  function authHeaders(extra) {
    const h = { 'Content-Type': 'application/json', ...(extra || {}) };
    const t = getToken();
    if (t) h.Authorization = 'Bearer ' + t;
    // Always attach bonus proof (server can ignore if user is authenticated)
    Object.assign(h, bonusProofHeaders());
    // Attach language pref
    if (__prefs.responseLanguage && __prefs.responseLanguage !== 'auto') {
      h['X-Mirox-Lang'] = __prefs.responseLanguage;
    }
    if (__prefs.translateComments) h['X-Mirox-Translate-Comments'] = '1';
    return h;
  }
  async function netFetch(url, opts = {}, ms = NET_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      if (opts.signal) opts.signal.addEventListener('abort', () => ctrl.abort());
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

  /* ═══════════ BONUS SYSTEM ═══════════ */
  function loadBonusRaw() {
    const b = safeGet(BONUS_KEY, null);
    if (!b || typeof b !== 'object') return null;
    return b;
  }
  function saveBonusRaw(b) { b ? safeSet(BONUS_KEY, b) : safeRemove(BONUS_KEY); }
  function isBonusValid(b) {
    if (!b) return false;
    const tokens = parseInt(b.tokens, 10) || 0;
    const expiresAt = parseInt(b.expiresAt, 10) || 0;
    if (tokens <= 0) return false;
    if (expiresAt <= 0) return false;
    return Date.now() < expiresAt;
  }
  function getActiveBonus() {
    const b = loadBonusRaw();
    if (!b) return 0;
    if (!isBonusValid(b)) {
      saveBonusRaw(null);
      if (__shareState.claimed) { __shareState.claimed = false; saveShareState(); }
      return 0;
    }
    return b.tokens;
  }
  function getBonusExpiryMs() {
    const b = loadBonusRaw();
    if (!isBonusValid(b)) return 0;
    return b.expiresAt - Date.now();
  }
  function isBonusActive() { return getActiveBonus() > 0; }
  function grantLocalBonus(tokens) {
    const prev = loadBonusRaw();
    const now = Date.now();
    let newTokens, newExpiry;
    if (isBonusValid(prev)) {
      newTokens = (prev.tokens || 0) + tokens;
      newExpiry = Math.max(prev.expiresAt, now + BONUS_MS);
    } else {
      newTokens = tokens;
      newExpiry = now + BONUS_MS;
    }
    const bonus = { tokens: newTokens, expiresAt: newExpiry, grantedAt: now, guest: getGuestId() };
    saveBonusRaw(bonus);
    return bonus;
  }
  function getFreeLimit() { return BASE_FREE_LIMIT + getActiveBonus(); }
  function formatBonusRemaining() {
    const ms = getBonusExpiryMs();
    if (ms <= 0) return '';
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    if (days >= 1) return days + 'd';
    if (hours >= 1) return hours + 'h';
    const mins = Math.max(1, Math.floor(ms / 60000));
    return mins + 'm';
  }

  /* ═══════════ PREFERENCES ═══════════ */
  function loadPrefs() {
    __prefs = safeGet(PREFS_KEY, {
      autoScroll: true, enterSend: true, showThinking: true, compact: false,
      reduceMotion: false, fontSize: 'md',
      responseLanguage: 'auto', uiLanguage: 'en', translateComments: false,
      desktopNotify: false, sound: true, bonusReminder: true,
      verboseLog: false,
      persona: '',
    });
  }
  function savePrefs() { safeSet(PREFS_KEY, __prefs); }
  function applyPrefs() {
    document.documentElement.setAttribute('data-fontsize', __prefs.fontSize || 'md');
    document.documentElement.classList.toggle('reduce-motion', !!__prefs.reduceMotion);
    document.documentElement.classList.toggle('compact-mode', !!__prefs.compact);
    // Sync toggles
    const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    setChk('autoScrollToggle', __prefs.autoScroll);
    setChk('enterSendToggle', __prefs.enterSend);
    setChk('showThinkingToggle', __prefs.showThinking);
    setChk('compactToggle', __prefs.compact);
    setChk('reduceMotionToggle', __prefs.reduceMotion);
    setChk('desktopNotifyToggle', __prefs.desktopNotify);
    setChk('soundToggle', __prefs.sound);
    setChk('bonusReminderToggle', __prefs.bonusReminder);
    setChk('verboseLogToggle', __prefs.verboseLog);
    setChk('translateCommentsToggle', __prefs.translateComments);
    const langSel = document.getElementById('languageSelect');
    if (langSel) langSel.value = __prefs.responseLanguage || 'auto';
    const uiSel = document.getElementById('uiLanguageSelect');
    if (uiSel) uiSel.value = __prefs.uiLanguage || 'en';
    const pInp = document.getElementById('personaInput');
    if (pInp && __prefs.persona) pInp.value = __prefs.persona;
  }

  /* ═══════════ MCP SERVERS ═══════════ */
  function loadMcp() {
    __mcpServers = safeGet(MCP_KEY, []);
    if (!Array.isArray(__mcpServers)) __mcpServers = [];
    const en = safeGet(MCP_KEY + '_enabled', false);
    const t = document.getElementById('mcpEnableToggle');
    if (t) t.checked = !!en;
  }
  function saveMcp() { safeSet(MCP_KEY, __mcpServers); }
  function renderMcpList() {
    const wrap = document.getElementById('mcpServerList');
    if (!wrap) return;
    if (!__mcpServers.length) { wrap.innerHTML = '<div class="mcp-empty">No MCP servers configured.</div>'; return; }
    wrap.innerHTML = __mcpServers.map((s, i) => `
      <div class="mcp-row" data-idx="${i}">
        <div class="mcp-row-icon"><i class="ri-server-line"></i></div>
        <div class="mcp-row-info">
          <div class="mcp-row-name">${escapeHtml(s.name)}</div>
          <div class="mcp-row-url">${escapeHtml(s.url)}</div>
        </div>
        <div class="mcp-row-actions">
          <button class="icon-btn mcp-test" data-idx="${i}" title="Test"><i class="ri-flashlight-line"></i></button>
          <button class="icon-btn mcp-remove" data-idx="${i}" title="Remove"><i class="ri-delete-bin-line"></i></button>
        </div>
      </div>`).join('');
    wrap.querySelectorAll('.mcp-remove').forEach((b) => {
      b.onclick = () => {
        const i = parseInt(b.dataset.idx, 10);
        __mcpServers.splice(i, 1);
        saveMcp(); renderMcpList();
        toast('Server removed');
      };
    });
    wrap.querySelectorAll('.mcp-test').forEach((b) => {
      b.onclick = async () => {
        const i = parseInt(b.dataset.idx, 10);
        const s = __mcpServers[i];
        if (!s) return;
        toast(`Testing ${s.name}…`);
        try {
          const r = await netFetch(s.url, { method: 'GET', headers: s.key ? { Authorization: 'Bearer ' + s.key } : {} }, 5000);
          toast(r.ok ? `✓ ${s.name} is reachable` : `✗ ${s.name} returned ${r.status}`);
        } catch (e) { toast(`✗ ${s.name} unreachable`); }
      };
    });
  }

  /* ═══════════ MODEL ACCESS ═══════════ */
  function canUseModel(tier) {
    if (__tier === 'free' && isBonusActive()) return true;
    if (tier === 'free') return true;
    if (__tier === 'ultimate') return true;
    if (__tier === 'pro' && tier === 'pro') return true;
    return false;
  }
  function modelAccessReason(tier) {
    if (__tier === 'free' && isBonusActive() && tier !== 'free') return 'bonus';
    if (tier === 'free') return 'free';
    if (__tier === 'ultimate') return 'tier';
    if (__tier === 'pro' && tier === 'pro') return 'tier';
    return 'locked';
  }
  function tierLabel(tier) {
    if (tier === 'free') return 'FREE';
    if (tier === 'pro') return 'PRO';
    if (tier === 'ultimate') return 'ULT';
    return tier.toUpperCase();
  }

  /* ═══════════ CONFETTI ═══════════ */
  function launchConfetti(opts) {
    if (__prefs.reduceMotion) return;
    const o = opts || {};
    const duration = o.duration || 4200;
    const count = o.count || 200;
    const canvas = document.createElement('canvas');
    canvas.className = 'confetti-canvas';
    document.body.appendChild(canvas);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth, H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    const colors = ['#4d6bfe','#7c8aff','#16a34a','#4ade80','#f59e0b','#fbbf24','#ec4899','#f472b6','#06b6d4','#22d3ee','#a855f7','#c084fc','#ef4444','#f87171','#facc15'];
    const particles = [];
    const origins = [{ x: W*0.15, y: H*0.25 }, { x: W*0.85, y: H*0.25 }, { x: W*0.5, y: H*0.2 }];
    for (let i = 0; i < count; i++) {
      const origin = origins[i % origins.length];
      const angle = (Math.random() - 0.5) * Math.PI * 1.4 - Math.PI / 2;
      const speed = 6 + Math.random() * 12;
      particles.push({
        x: origin.x + (Math.random() - 0.5) * 60,
        y: origin.y + (Math.random() - 0.5) * 40,
        vx: Math.cos(angle) * speed * (0.7 + Math.random() * 0.6),
        vy: Math.sin(angle) * speed - 4 - Math.random() * 3,
        gravity: 0.28 + Math.random() * 0.14, drag: 0.988,
        size: 6 + Math.random() * 8,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.34,
        shape: Math.random() < 0.55 ? 'rect' : (Math.random() < 0.5 ? 'circle' : 'ribbon'),
        swayAmp: 0.5 + Math.random() * 1.8, swayFreq: 0.02 + Math.random() * 0.03,
        swayPhase: Math.random() * Math.PI * 2,
      });
    }
    const start = performance.now(); let raf = null, stopped = false;
    function frame(now) {
      if (stopped) return;
      const t = (now - start) / duration;
      ctx.clearRect(0, 0, W, H);
      const fadeStart = 0.7;
      ctx.globalAlpha = t > fadeStart ? Math.max(0, 1 - (t - fadeStart) / (1 - fadeStart)) : 1;
      for (const p of particles) {
        p.vy += p.gravity; p.vx *= p.drag; p.vy *= p.drag;
        p.swayPhase += p.swayFreq;
        p.x += p.vx + Math.sin(p.swayPhase) * p.swayAmp * 0.4;
        p.y += p.vy; p.rotation += p.rotationSpeed;
        if (p.y > H + 40) continue;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rotation); ctx.fillStyle = p.color;
        if (p.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2); ctx.fill(); }
        else if (p.shape === 'ribbon') { const flip = Math.sin(p.rotation * 2); ctx.fillRect(-p.size/2, -p.size/8, p.size, Math.abs(flip) * p.size * 0.4 + 1.5); }
        else { ctx.fillRect(-p.size/2, -p.size/3, p.size, p.size * 0.7); }
        ctx.restore();
      }
      if (t < 1) raf = requestAnimationFrame(frame);
      else { stopped = true; ctx.clearRect(0, 0, W, H); canvas.remove(); }
    }
    raf = requestAnimationFrame(frame);
    setTimeout(() => { stopped = true; if (raf) cancelAnimationFrame(raf); if (canvas.parentNode) canvas.remove(); }, duration + 2000);
  }

  /* ═══════════ MASCOT ═══════════ */
  const MOODS = ['idle','happy','thinking','coding','celebrate','error','learning'];
  const BLOB_PATH = 'M100 20 C126 20 144 32 154 54 C178 56 194 76 194 102 C194 128 178 148 154 152 C144 174 126 186 100 186 C74 186 56 174 46 152 C22 148 6 128 6 102 C6 76 22 56 46 54 C56 32 74 20 100 20 Z';
  const BLOB_SVG = `<svg class="blob-svg" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mirox avatar"><g class="blob-float"><path class="blob-body" d="${BLOB_PATH}" fill="currentColor"/><g class="blob-eyes" fill="var(--bg)"><ellipse cx="88" cy="82" rx="4.5" ry="13" transform="rotate(18 88 82)"/><ellipse cx="110" cy="78" rx="4.5" ry="13" transform="rotate(18 110 78)"/></g></g></svg>`;
  function blobSvg() { return BLOB_SVG; }
  function upgradeStaticMascots(scope = document) {
    scope.querySelectorAll('.mascot:not([data-blob-ready])').forEach((el) => {
      const m = MOODS.includes(el.dataset.mood) ? el.dataset.mood : 'idle';
      el.innerHTML = blobSvg(); el.dataset.mood = m; el.classList.add('m-' + m); el.dataset.blobReady = '1';
    });
  }
  function setMascotMood(mood, scope) {
    const root = scope || document;
    const m = MOODS.includes(mood) ? mood : 'idle';
    upgradeStaticMascots(root);
    root.querySelectorAll('.mascot').forEach((el) => {
      el.className = el.className.split(' ').filter((c) => !/^m-/.test(c)).join(' ');
      el.classList.add('m-' + m); el.dataset.mood = m;
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
    return 'thinking';
  }
  function startIdleMascot() {
    setInterval(() => {
      const w = document.getElementById('welcomeMascot');
      if (!w || isReplying || !w.parentElement) return;
      const pool = ['happy', 'thinking', 'coding', 'learning'];
      setMascotMood(pool[Math.floor(Math.random() * pool.length)], w.parentElement);
    }, 8000);
  }
  function pickStatusLabel(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return 'Thinking';
    if (/\b(build|create|make|write|code|script)\b/.test(t)) return 'Building';
    if (/\b(search|find|look up|google)\b/.test(t)) return 'Searching';
    if (/\b(fix|bug|error|debug)\b/.test(t)) return 'Debugging';
    return 'Thinking';
  }

  /* ═══════════ Thinking panel ═══════════ */
  function createThinkPanel(label, steps, headline) {
    const el = document.createElement('div');
    el.className = 'think-wrap';
    el.innerHTML = `
      <div class="think-head">
        <span class="think-head-icon"><i class="ri-loader-4-line spin"></i></span>
        <span class="think-head-label"><span class="think-label">${escapeHtml(label || 'Thinking')}</span></span>
        <span class="think-timer">0.0s</span>
      </div>
      ${headline ? `<div class="think-head-sub">${escapeHtml(headline.slice(0, 180))}${headline.length > 180 ? '…' : ''}</div>` : ''}
      <div class="think-body"></div>`;
    const body = el.querySelector('.think-body');
    const timerEl = el.querySelector('.think-timer');
    const labelEl = el.querySelector('.think-label');
    const headIcon = el.querySelector('.think-head-icon i');
    const t0 = performance.now();
    let done = false;
    const timer = setInterval(() => {
      if (done) { clearInterval(timer); return; }
      timerEl.textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's';
    }, 100);
    function addNarration(text) {
      if (!text) return;
      const p = document.createElement('div');
      p.className = 'think-narration';
      p.innerHTML = `<span class="think-narration-dot"></span><span>${escapeHtml(text)}</span>`;
      body.appendChild(p);
    }
    if (Array.isArray(steps)) steps.forEach((s) => addNarration(s));
    function close(finalLabel, mood) {
      if (done) return;
      done = true; clearInterval(timer);
      timerEl.textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's';
      labelEl.textContent = finalLabel;
      headIcon.className = 'ri-checkbox-circle-line';
      el.classList.add('done');
      setMascotMood(mood, el);
      setTimeout(() => el.classList.add('collapsed'), 1500);
    }
    return {
      el, addStep(text) { addNarration(text); }, addNarration,
      addTool() { return { setStatus() {}, addResult() {}, addCode() {} }; },
      setMood(mood) { setMascotMood(mood, el); },
      markWriting() { addNarration('Writing the answer…'); },
      finish() { addNarration('Thinking complete'); close('Thought for a moment', 'happy'); },
      fail(msg) { addNarration(msg || 'Stopped with an error.'); headIcon.className = 'ri-error-warning-line'; close('Stopped', 'error'); },
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
    safeSet(LS_KEY, slim);
  }
  function loadChats() { const v = safeGet(LS_KEY, []); __conversations = Array.isArray(v) ? v : []; }

  function welcomeHTML() {
    return `<div class="welcome-screen">
      <div class="welcome-mascot"><div class="mascot mascot-lg m-idle" id="welcomeMascot" data-mood="idle"></div></div>
      <h1 class="welcome-title">Hi, I'm Mirox</h1>
      <p class="welcome-sub">Luna and Gen are unlimited and free. Share to unlock <strong>Pro, Ultra &amp; Eclipse</strong> free for 7 days.</p>
      <div class="suggestion-grid">
        <button class="suggestion-card" type="button" data-prompt="Show me a simple Lua script that prints numbers 1 to 5"><i class="ri-code-box-line"></i><span>Write a Lua script</span></button>
        <button class="suggestion-card" type="button" data-prompt="Show me an HTML example with a table"><i class="ri-html5-line"></i><span>Show an HTML table</span></button>
        <button class="suggestion-card" type="button" data-prompt="Generate me an image of a cat"><i class="ri-image-line"></i><span>Generate an image</span></button>
        <button class="suggestion-card" type="button" data-prompt="Explain a concept simply"><i class="ri-lightbulb-line"></i><span>Explain a concept</span></button>
      </div>
    </div>`;
  }
  function startNewChat() {
    currentConversationId = null;
    const t = $('#chatTitle'); if (t) t.textContent = 'New chat';
    const c = $('#chatMessages'); if (c) c.innerHTML = welcomeHTML();
    upgradeStaticMascots($('#chatMessages'));
    bindSuggestionClicks(); updateTokenUsage();
    renderHistory();
  }
  function bindSuggestionClicks() {
    $$('.suggestion-card').forEach((card) => {
      if (card.__wired) return; card.__wired = true;
      card.onclick = () => {
        const p = card.dataset.prompt;
        const inp = $('#messageInput');
        if (p && inp) { inp.value = p; updateSendButtonState(); handleSend(); }
      };
    });
  }
  function renderHistory() {
    const list = $('#historyList'); if (!list) return;
    const q = __historyQuery.trim().toLowerCase();
    let items = __conversations;
    if (q) items = __conversations.filter((c) => (c.title || '').toLowerCase().includes(q) || (c.messages || []).some((m) => (m.content || '').toLowerCase().includes(q)));
    if (!items.length) { list.innerHTML = `<li class="history-empty">${q ? 'No matches' : 'No conversations yet'}</li>`; return; }
    list.innerHTML = items.map((c) =>
      `<li class="history-item${c.id === currentConversationId ? ' active' : ''}" data-id="${c.id}">
        <i class="ri-chat-3-line"></i>
        <span class="history-title">${escapeHtml(c.title || 'Chat')}</span>
        <button class="history-delete icon-btn" aria-label="Delete chat"><i class="ri-delete-bin-line"></i></button>
      </li>`).join('');
  }
  function estimateTokens(text) { return Math.ceil(String(text || '').length / 4); }
  function conversationTokenUsage(convo = currentConvo()) {
    if (!convo) return 0;
    return (convo.messages || []).reduce((sum, m) => sum + estimateTokens(m.content || ''), 0);
  }
  function formatK(n) {
    if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
    return String(n);
  }
  function updateTokenUsage() {
    const el = $('#tokenUsage'); if (!el) return;
    const used = conversationTokenUsage();
    const bonus = getActiveBonus();
    const limit = __tier === 'free' ? (BASE_FREE_LIMIT + bonus) : null;
    const span = el.querySelector('span');
    if (span) {
      if (limit) span.textContent = `${formatK(Math.min(used, limit))} / ${formatK(limit)}`;
      else span.textContent = `${formatK(used)} tokens`;
    }
    const hasBonus = bonus > 0 && __tier === 'free';
    el.classList.toggle('has-bonus', hasBonus);
    el.querySelector('.token-bonus-badge')?.remove();
    if (hasBonus) {
      const badge = document.createElement('span');
      badge.className = 'token-bonus-badge';
      badge.innerHTML = `<i class="ri-vip-crown-fill"></i>+${formatK(bonus)} · ${formatBonusRemaining()}`;
      el.appendChild(badge);
    }
  }
  function atChatBottom(c = $('#chatMessages')) { return !c || c.scrollHeight - c.scrollTop - c.clientHeight < 100; }
  function scrollToBottom(force = false) {
    const c = $('#chatMessages'); if (!c) return;
    if (force || (autoScrollEnabled && userIsAtBottom && __prefs.autoScroll !== false)) c.scrollTop = c.scrollHeight;
    updateScrollButton();
  }
  function updateScrollButton() {
    const c = $('#chatMessages'), b = $('#scrollBottomBtn'); if (!c || !b) return;
    b.classList.toggle('visible', !atChatBottom(c));
  }
  function freeLimitReached(convo = currentConvo()) {
    if (__tier !== 'free') return false;
    return conversationTokenUsage(convo) >= getFreeLimit();
  }
  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fileIconHTML() { return '<span class="file-glyph" aria-hidden="true"><i class="ri-file-text-line"></i></span>'; }

  /* ═══════════ Language meta ═══════════ */
  const LANG_META = {
    lua: { label: 'LUA', icon: 'devicon-lua-plain colored', hljs: 'lua' },
    python: { label: 'PY', icon: 'devicon-python-plain colored', hljs: 'python' },
    py: { label: 'PY', icon: 'devicon-python-plain colored', hljs: 'python' },
    javascript: { label: 'JS', icon: 'devicon-javascript-plain colored', hljs: 'javascript' },
    js: { label: 'JS', icon: 'devicon-javascript-plain colored', hljs: 'javascript' },
    typescript: { label: 'TS', icon: 'devicon-typescript-plain colored', hljs: 'typescript' },
    ts: { label: 'TS', icon: 'devicon-typescript-plain colored', hljs: 'typescript' },
    html: { label: 'HTML', icon: 'devicon-html5-plain colored', hljs: 'xml' },
    css: { label: 'CSS', icon: 'devicon-css3-plain colored', hljs: 'css' },
    json: { label: 'JSON', icon: 'devicon-json-plain colored', hljs: 'json' },
    bash: { label: 'SH', icon: 'devicon-bash-plain colored', hljs: 'bash' },
    sh: { label: 'SH', icon: 'devicon-bash-plain colored', hljs: 'bash' },
    java: { label: 'JAVA', icon: 'devicon-java-plain colored', hljs: 'java' },
    cpp: { label: 'C++', icon: 'devicon-cplusplus-plain colored', hljs: 'cpp' },
    c: { label: 'C', icon: 'devicon-c-plain colored', hljs: 'c' },
    go: { label: 'GO', icon: 'devicon-go-plain colored', hljs: 'go' },
    rust: { label: 'RUST', icon: 'devicon-rust-plain colored', hljs: 'rust' },
    ruby: { label: 'RB', icon: 'devicon-ruby-plain colored', hljs: 'ruby' },
    php: { label: 'PHP', icon: 'devicon-php-plain colored', hljs: 'php' },
    sql: { label: 'SQL', icon: 'ri-database-2-line', hljs: 'sql' },
    yaml: { label: 'YAML', icon: 'ri-file-list-2-line', hljs: 'yaml' },
    yml: { label: 'YAML', icon: 'ri-file-list-2-line', hljs: 'yaml' },
    markdown: { label: 'MD', icon: 'ri-markdown-line', hljs: 'markdown' },
    md: { label: 'MD', icon: 'ri-markdown-line', hljs: 'markdown' },
  };
  function langMeta(lang) {
    const key = String(lang || '').toLowerCase().trim();
    return LANG_META[key] || { label: (key || 'CODE').toUpperCase().slice(0, 6), icon: 'ri-code-s-slash-line', hljs: key || 'plaintext' };
  }
  function highlightCode(lang, code) {
    const raw = String(code || '').replace(/\n$/, '');
    const meta = langMeta(lang);
    try {
      if (window.hljs && hljs.getLanguage && hljs.getLanguage(meta.hljs)) return hljs.highlight(raw, { language: meta.hljs }).value;
      if (window.hljs) return hljs.highlightAuto(raw).value;
    } catch {}
    return escapeHtml(raw);
  }
  function renderCode(lang, code, closed) {
    const meta = langMeta(lang);
    const raw = String(code || '').replace(/\n$/, '');
    const btn = closed
      ? '<button class="code-action-btn" data-copy><i class="ri-file-copy-line"></i> Copy</button>'
      : '<span class="writing-tag"><i class="ri-loader-4-line spin"></i> writing…</span>';
    return `<div class="code-block" data-lang="${escapeHtml(meta.hljs)}">
      <div class="code-block-header">
        <span class="code-lang-badge"><i class="${meta.icon}"></i><span>${escapeHtml(meta.label)}</span></span>
        ${btn}
      </div>
      <pre><code class="hljs language-${escapeHtml(meta.hljs)}">${highlightCode(lang, raw)}</code></pre>
    </div>`;
  }

  /* ═══════════ Markdown ═══════════ */
  function renderMarkdown(rawText) {
    if (!rawText) return '';
    const src = String(rawText);
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
  function renderText(text) {
    const lines = String(text).split('\n');
    let out = '';
    const buf = [];
    const flush = () => { if (buf.length) { out += `<p>${inlineFmt(buf.join(' '))}</p>`; buf.length = 0; } };
    const splitRow = (line) => { let s = line.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|')) s = s.slice(0, -1); return s.split('|').map((v) => v.trim()); };
    const isSepRow = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) { flush(); continue; }
      if (t.includes('|') && i + 1 < lines.length && isSepRow(lines[i + 1])) {
        flush();
        const headers = splitRow(t); i += 1;
        let table = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
        headers.forEach((c) => { table += `<th>${inlineFmt(c)}</th>`; });
        table += '</tr></thead><tbody>';
        while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim() !== '') {
          i++;
          const row = splitRow(lines[i]); table += '<tr>';
          for (let j = 0; j < headers.length; j++) table += `<td>${inlineFmt(row[j] || '')}</td>`;
          table += '</tr>';
        }
        out += table + '</tbody></table></div>';
        continue;
      }
      const hm = t.match(/^(#{1,6})\s+(.+)$/);
      if (hm) { flush(); const lvl = hm[1].length; out += `<h${lvl} class="md-h md-h${lvl}">${inlineFmt(hm[2])}</h${lvl}>`; continue; }
      const hr = t.match(/^([-*_])\1{2,}$/);
      if (hr) { flush(); out += '<hr class="md-hr">'; continue; }
      const um = t.match(/^[-*+]\s+(.+)$/);
      if (um) { flush(); out += `<div class="md-li md-ul">• ${inlineFmt(um[1])}</div>`; continue; }
      const om = t.match(/^(\d+)\.\s+(.+)$/);
      if (om) { flush(); out += `<div class="md-li md-ol">${om[1]}. ${inlineFmt(om[2])}</div>`; continue; }
      if (/^>\s?/.test(t)) { flush(); out += `<blockquote class="md-quote">${inlineFmt(t.replace(/^>\s?/, ''))}</blockquote>`; continue; }
      buf.push(t);
    }
    flush();
    return out;
  }
  function inlineFmt(t) {
    let s = escapeHtml(t);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000C${codes.length - 1}\u0000`; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
    return s;
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

  /* ═══════════ Message DOM ═══════════ */
  function addMessageToDOM(role, content, ts, msgId, files, image) {
    const container = $('#chatMessages'); if (!container) return null;
    container.querySelector('.welcome-screen')?.remove();
    const id = msgId || uid();
    const el = document.createElement('div');
    el.className = 'message ' + (role === 'user' ? 'user' : 'ai');
    el.dataset.msgId = id; el.dataset.role = role;
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
    if (freeLimitReached()) { toast('Max tokens reached — share for more or upgrade.', 5000); return; }
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
    inp.value = ''; inp.style.height = 'auto';
    pendingFiles = []; updatePreview(); updateSendButtonState();
    saveChats(); renderHistory(); updateTokenUsage();
    sendToAPI(text, files, searchFlag);
  }
  function shouldShowContinue(full, convo, streamComplete) {
    if (!full) return false;
    if (freeLimitReached(convo)) return true;
    if (!streamComplete) return true;
    const fences = (full.match(/```/g) || []).length;
    if (fences % 2 === 1) return true;
    const trimmed = full.trim();
    if (/(\.\.\.|…|,|\bto be continued\b|\bcontinue\b|\bnext part\b)$/i.test(trimmed)) return true;
    return false;
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
    if (isReplying || continuationBusy) return;
    continuationBusy = true;
    btn.disabled = true; btn.innerHTML = '<i class="ri-loader-4-line spin"></i><span>Continuing…</span>';
    try {
      await sendToAPI('Continue your previous response from exactly where it stopped. Do not repeat the completed text.', [], false, { existingMsgEl: msgEl, existingBubble: bubble, messageObj, continuation: true });
    } finally {
      continuationBusy = false;
      if (btn.isConnected) btn.remove();
    }
  }

  /* ═══════════ API — with bonus proof so premium models work for guests ═══════════ */
  async function sendToAPI(text, files, forceSearch, continuation = null) {
    const isContinuation = !!(continuation && continuation.continuation);
    const convoAtStart = currentConvo();
    if (!isContinuation && freeLimitReached(convoAtStart)) { toast('Max tokens reached.', 5000); return; }
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
      panel = { el: document.createElement('span'), addStep() {}, addNarration() {}, addTool() { return { setStatus() {}, addResult() {}, addCode() {} }; }, setMood() {}, markWriting() {}, finish() {}, fail() {}, destroy() {} };
      const prev = String(continuation.messageObj.content || '');
      var full = prev ? prev + '\n\n' : '';
    } else {
      msgEl = document.createElement('div');
      msgEl.className = 'message ai';
      msgEl.dataset.msgId = aiMsgId;
      msgEl.dataset.role = 'ai';
      panel = createThinkPanel(pickStatusLabel(text), [], text);
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
    let streamComplete = false;
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
      const reqBody = {
        message: text, history, model, stream: true, files, search: !!forceSearch,
        guest_id: getGuestId(),
        bonus_active: isBonusActive(),
        bonus_tokens: getActiveBonus(),
        bonus_expires: (loadBonusRaw() || {}).expiresAt || 0,
        mcp_servers: __mcpServers,
        mcp_enabled: !!document.getElementById('mcpEnableToggle')?.checked,
        persona: __prefs.persona || '',
        language: __prefs.responseLanguage || 'auto',
      };
      if (__prefs.verboseLog) console.log('[Mirox] Request:', reqBody, authHeaders());
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: authHeaders(),
        credentials: 'same-origin',
        body: JSON.stringify(reqBody),
        signal: activeStreamController.signal,
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const d = await res.json(); detail = d.error?.message || d.error || d.message || detail; } catch {}
        // Special handling: guest users with valid bonus should be allowed
        if ((res.status === 401 || res.status === 403) && isBonusActive()) {
          throw new Error('Bonus verified locally but server rejected guest access. Try refreshing or signing in — your 50k bonus is saved.');
        }
        if (res.status === 401 || res.status === 403) throw new Error('Not signed in. Sign in or refresh the page.');
        if (res.status === 404) throw new Error('Endpoint /v1/chat/completions not found.');
        if (res.status >= 500) throw new Error(`Server error (${res.status}).`);
        throw new Error(detail);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const ensureBubble = () => {
        if (!bubble) { bubble = document.createElement('div'); bubble.className = 'bubble'; msgEl.insertBefore(bubble, timeEl); }
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
          if (!pl) continue;
          if (pl === '[DONE]') { streamComplete = true; continue; }
          let o;
          try { o = JSON.parse(pl); } catch { continue; }
          if (o.n) panel.addNarration(o.n);
          if (o.img) {
            generatedImage = o.img;
            panel.markWriting(); panel.setMood('celebrate'); ensureBubble();
            bubble.innerHTML = `<div class="gen-image"><img src="${o.img}" draggable="false" alt=""></div><div class="bubble-text"></div>`;
            bubbleText = bubble.querySelector('.bubble-text');
            const img = bubble.querySelector('img');
            if (img) img.onclick = () => openImageViewer(o.img);
            scrollToBottom();
            continue;
          }
          if (o.d) {
            full += o.d;
            const limit = getFreeLimit();
            if (__tier === 'free' && convo && conversationTokenUsage(convo) + estimateTokens(full) >= limit) {
              full = full.slice(0, Math.max(0, (limit - conversationTokenUsage(convo)) * 4));
              limitHit = true;
              if (!gotToken) { gotToken = true; ensureBubble(); bubble.innerHTML = '<div class="bubble-text"></div>'; bubbleText = bubble.querySelector('.bubble-text'); }
              if (bubbleText) bubbleText.innerHTML = renderMarkdown(full);
              try { await reader.cancel(); } catch {}
              break;
            }
            if (!gotToken) {
              gotToken = true;
              panel.markWriting(); panel.setMood('learning'); ensureBubble();
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
      if (savedMsg && shouldShowContinue(full, convo, streamComplete)) {
        attachContinueButton(msgEl, bubble, savedMsg);
      }
      if (__prefs.desktopNotify && document.hidden) {
        try { new Notification('Mirox replied', { body: 'Tap to view the answer', icon: '/logo.png' }); } catch {}
      }
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
      } else bubble.textContent = aborted ? '(stopped)' : 'Error: ' + msg;
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
  function handleFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const arr = [];
    for (const f of Array.from(fileList)) {
      if (hasAttachment(f.name, f.size)) { toast('Already added', 1500); continue; }
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
      const one = () => { done++; if (done === arr.length) finish(); };
      if (isImg) {
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
      return `<div class="attach-chip">${fileIconHTML()}${escapeHtml(f.name)}${f.size ? ` <span class="attach-size">${fmtSize(f.size)}</span>` : ''}</div>`;
    }).join('');
  }
  function addTextAttachment(text, name) {
    const body = String(text).slice(0, 60000);
    const fname = name || ('pasted-' + new Date().toISOString().slice(11, 19).replace(/:/g, '-') + '.txt');
    if (pendingFiles.some((f) => f.type === 'text' && f.content === body)) { toast('Already added', 1500); return; }
    pendingFiles.push({ name: fname, size: text.length, type: 'text', content: body });
    updatePreview(); updateSendButtonState();
  }

  function toast(msg, ms) {
    const t = document.createElement('div');
    t.className = 'mirox-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, ms || 1800);
  }

  /* ═══════════ Share ═══════════ */
  function loadShareState() { __shareState = safeGet(SHARE_KEY, { claimed: false, claimedAt: 0, dismissedAt: 0 }); }
  function saveShareState() { safeSet(SHARE_KEY, __shareState); }
  function shouldShowShareAd() {
    if (__tier !== 'free') return false;
    if (isBonusActive()) return false;
    if (__shareState.dismissedAt && Date.now() - __shareState.dismissedAt < 6 * 3600 * 1000) return false;
    return true;
  }
  function openShareAd() {
    if (!shouldShowShareAd()) return;
    setTimeout(() => $('#shareAdModal')?.classList.add('open'), 1800);
  }
  function closeShareAd(dismiss) {
    const modal = $('#shareAdModal');
    if (modal) modal.classList.remove('open');
    if (dismiss) { __shareState.dismissedAt = Date.now(); saveShareState(); }
  }
  function setShareStatus(text, cls) {
    const el = $('#shareAdStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'share-ad-status' + (cls ? ' ' + cls : '');
  }
  function celebrateReward() {
    launchConfetti({ duration: 4500, count: 240 });
    const chip = $('#tokenUsage');
    if (chip) { chip.classList.add('pulse'); setTimeout(() => chip.classList.remove('pulse'), 1200); }
    const wm = document.getElementById('welcomeMascot');
    if (wm) {
      setMascotMood('celebrate', wm.parentElement);
      setTimeout(() => setMascotMood('happy', wm.parentElement), 2000);
    }
  }
  function grantShareRewardLocal() {
    const bonus = grantLocalBonus(BONUS_TOKENS);
    __shareState.claimed = true;
    __shareState.claimedAt = Date.now();
    __shareState.dismissedAt = 0;
    saveShareState();
    updateTokenUsage();
    renderModelPicker();
    celebrateReward();
    const days = Math.round((bonus.expiresAt - Date.now()) / 86400000);
    toast(`🎉 ${BONUS_TOKENS.toLocaleString()} bonus tokens + Pro/Ultra/Eclipse unlocked for ${days} days!`, 6500);
  }
  async function grantShareReward() {
    grantShareRewardLocal();
    try {
      await jsonOr('/api/share/reward', {
        method: 'POST',
        body: JSON.stringify({ bonus_tokens: BONUS_TOKENS, valid_days: 7, verified: true, verified_at: Date.now(), guest_id: getGuestId() }),
      }, null);
    } catch {}
    try { if (__user) await refreshUsage(); } catch {}
  }
  async function attemptShare() {
    const btn = $('#shareAdShareBtn');
    const shareData = {
      title: 'MiroxAI — Free unlimited AI chat',
      text: 'I\'m using MiroxAI for free AI chats. Get 50k tokens + Pro/Ultra/Eclipse free for a week!',
      url: location.origin + '/?ref=share&g=' + getGuestId(),
    };
    if (btn) btn.disabled = true;
    if (navigator.share) {
      try {
        setShareStatus('Opening share sheet…', '');
        await navigator.share(shareData);
        setShareStatus('Share confirmed! Adding reward…', 'ok');
        await grantShareReward();
        setTimeout(() => closeShareAd(false), 2400);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') {
          setShareStatus('Share cancelled. Try again when you\'re ready.', 'warn');
          if (btn) btn.disabled = false;
          return;
        }
      }
    }
    const shareText = encodeURIComponent(shareData.text + ' ' + shareData.url);
    const url = `https://twitter.com/intent/tweet?text=${shareText}`;
    window.open(url, '_blank', 'noopener,width=600,height=500');
    setShareStatus('Complete the share in the new window…', '');
    let resolved = false;
    const focusHandler = () => {
      if (resolved) return;
      resolved = true;
      window.removeEventListener('focus', focusHandler);
      setTimeout(async () => {
        setShareStatus('Share detected! Adding reward…', 'ok');
        await grantShareReward();
        setTimeout(() => closeShareAd(false), 2400);
      }, 800);
    };
    window.addEventListener('focus', focusHandler);
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        window.removeEventListener('focus', focusHandler);
        setShareStatus('No share detected. Try again?', 'warn');
        if (btn) btn.disabled = false;
      }
    }, 90000);
  }

  /* ═══════════ Image viewer ═══════════ */
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

  /* ═══════════ Model picker ═══════════ */
  function getModelsList() { return __config?.models?.length ? __config.models : FALLBACK_MODELS; }
  function renderModelPicker() {
    const menu = $('#modelPickerMenu'); if (!menu) return;
    const models = getModelsList();
    const cur = __model || models[0].id;
    const bonusActive = __tier === 'free' && isBonusActive();

    let html = '';
    if (bonusActive) {
      html += `<div class="model-picker-banner">
        <i class="ri-vip-crown-fill"></i>
        <div class="model-picker-banner-text">
          <strong>All models unlocked</strong>
          <span>Bonus active · ${formatBonusRemaining()} left</span>
        </div>
      </div>`;
    }

    html += models.map((m) => {
      const usable = canUseModel(m.tier);
      const reason = modelAccessReason(m.tier);
      const isActive = m.id === cur;
      const tierLbl = tierLabel(m.tier);
      const tierClass = 'tier-' + m.tier;
      const reasonClass = usable ? (reason === 'bonus' ? 'via-bonus' : 'via-tier') : 'locked';
      const lockIcon = usable ? '' : '<i class="ri-lock-2-line model-option-lock"></i>';
      const bonusCrown = reason === 'bonus' ? '<i class="ri-vip-crown-fill model-option-crown"></i>' : '';
      const modelIcon = m.icon || 'ri-sparkling-2-line';
      return `<div class="model-option${isActive ? ' active' : ''}${usable ? '' : ' locked'} ${reasonClass}" data-model-id="${m.id}" data-usable="${usable}" data-tier="${m.tier}">
        <span class="model-option-icon"><i class="${modelIcon}"></i></span>
        <span class="model-option-body">
          <span class="model-option-top">
            <span class="model-option-name">${escapeHtml(m.label)}</span>
            <span class="model-tier-badge ${tierClass}">${tierLbl}</span>
            ${bonusCrown}${lockIcon}
          </span>
          <span class="model-option-tagline">${escapeHtml(m.tagline || '')}</span>
        </span>
      </div>`;
    }).join('');

    if (!bonusActive && __tier === 'free') {
      html += `<div class="model-picker-cta" id="modelPickerShareCta">
        <i class="ri-gift-2-line"></i>
        <span>Share to unlock <strong>Pro, Ultra &amp; Eclipse</strong> free for 7 days</span>
      </div>`;
    }

    menu.innerHTML = html;

    menu.querySelectorAll('.model-option').forEach((opt) => {
      opt.onclick = (e) => {
        e.stopPropagation();
        if (opt.dataset.usable === 'false') {
          if (__tier === 'free') {
            toast('Share to unlock this model free for 7 days', 3500);
            closeModelPicker();
            setTimeout(() => openShareAd(), 400);
          } else {
            toast('Upgrade to use this model');
          }
          return;
        }
        selectModel(opt.dataset.modelId);
      };
    });
    const cta = menu.querySelector('#modelPickerShareCta');
    if (cta) cta.onclick = (e) => { e.stopPropagation(); closeModelPicker(); setTimeout(() => openShareAd(), 200); };

    const c = models.find((m) => m.id === cur);
    if (c) { const lbl = $('#currentModelLabel'); if (lbl) lbl.textContent = c.label; }

    const btn = $('#modelPickerBtn');
    if (btn) {
      btn.classList.toggle('has-bonus', bonusActive);
      btn.querySelector('.model-picker-crown')?.remove();
      if (bonusActive) {
        const crown = document.createElement('i');
        crown.className = 'ri-vip-crown-fill model-picker-crown';
        btn.appendChild(crown);
      }
    }
  }
  function selectModel(id) {
    if (!id) return;
    const m = getModelsList().find((x) => x.id === id);
    if (!m) return;
    if (!canUseModel(m.tier)) {
      if (__tier === 'free') { toast('Share to unlock this model free for 7 days', 3500); closeModelPicker(); setTimeout(() => openShareAd(), 400); }
      else toast('Upgrade to use this model');
      return;
    }
    __model = id;
    const lbl = $('#currentModelLabel'); if (lbl) lbl.textContent = m.label;
    renderModelPicker(); closeModelPicker();
  }
  function openModelPicker() { $('#modelPicker')?.classList.add('open'); $('#modelPickerMenu')?.classList.add('open'); renderModelPicker(); }
  function closeModelPicker() { $('#modelPicker')?.classList.remove('open'); $('#modelPickerMenu')?.classList.remove('open'); }

  /* ═══════════ Usage / auth ═══════════ */
  async function refreshUsage() {
    const res = await jsonOr('/api/me', {}, null, 7000);
    if (!res || !res.user) {
      __user = null; __usage = null; __tier = 'free';
      const chip = $('#userChip');
      if (chip) { chip.querySelector('.user-name').textContent = 'Guest mode'; chip.querySelector('.user-sub').textContent = 'Sign in to save chats'; }
      const sb = $('#signInFromSettingsBtn'); if (sb) sb.style.display = '';
      const lo = $('#logoutBtn'); if (lo) lo.style.display = 'none';
      renderModelPicker(); updateTokenUsage(); return;
    }
    __user = res.user;
    __tier = res.user.tier || 'free';
    __usage = res.user;
    const chip = $('#userChip');
    if (chip) {
      chip.querySelector('.user-name').textContent = res.user.name || res.user.email;
      chip.querySelector('.user-sub').textContent = (__tier.charAt(0).toUpperCase() + __tier.slice(1)) + ' plan';
    }
    const sb = $('#signInFromSettingsBtn'); if (sb) sb.style.display = 'none';
    const lo = $('#logoutBtn'); if (lo) lo.style.display = '';
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
    if (res && res.ok) { setToken(res.token || ''); closeModal('loginModal'); await refreshUsage(); toast('Welcome, ' + name + '!'); openShareAd(); }
    else toast(res?.error || 'Login failed', 2500);
  }
  function doLoginment() { window.location.href = '/api/auth/loginment/start'; }
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
  async function genImage() {
    const prompt = $('#imagePrompt')?.value.trim();
    if (!prompt) { toast('Describe the image first.'); return; }
    const btn = $('#generateImageBtn'), result = $('#imageResult');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ri-loader-4-line spin"></i> Generating…'; }
    if (result) result.innerHTML = '<div class="studio-empty"><i class="ri-loader-4-line spin"></i> Painting…</div>';
    try {
      const res = await netFetch('/v1/images/generations', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ prompt, guest_id: getGuestId() }) }, 90000);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok && data.image) {
        if (result) { result.innerHTML = `<img src="${data.image}" alt="${escapeHtml(prompt)}">`; result.querySelector('img').onclick = () => openImageViewer(data.image); }
      } else {
        const errMsg = data.error?.message || data.error || data.message || `HTTP ${res.status}`;
        if (result) result.innerHTML = `<div class="studio-error">Failed: ${escapeHtml(errMsg)}</div>`;
      }
    } catch (e) {
      if (result) result.innerHTML = `<div class="studio-error">Error: ${escapeHtml(e.message)}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ri-image-add-line"></i> Generate'; }
    }
  }

  /* ═══════════ Bonus watcher ═══════════ */
  function startBonusWatcher() {
    if (__bonusTimer) clearInterval(__bonusTimer);
    __bonusTimer = setInterval(() => {
      const active = isBonusActive();
      if (active !== __lastBonusActive) {
        __lastBonusActive = active;
        updateTokenUsage(); renderModelPicker();
        if (!active && __model && !canUseModel(getModelsList().find((m) => m.id === __model)?.tier || 'free')) {
          __model = 'mirox-luna-1.2';
          const lbl = $('#currentModelLabel'); if (lbl) lbl.textContent = 'Luna';
          toast('Bonus expired — switched back to Luna. Share again to renew!', 5000);
        } else if (active) {
          toast('🎉 Bonus active — Pro, Ultra & Eclipse unlocked!', 4500);
        }
      } else if (active) updateTokenUsage();
    }, BONUS_CHECK_MS);
  }

  /* ═══════════ Modals ═══════════ */
  function openModal(id) { const el = document.getElementById(id); if (el) el.classList.add('open'); }
  function closeModal(id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); }
  function openSidebar() { $('#sidebar')?.classList.add('open'); $('#sidebarScrim')?.classList.add('open'); }
  function closeSidebar() { $('#sidebar')?.classList.remove('open'); $('#sidebarScrim')?.classList.remove('open'); }

  function applyAppearance(prefs) {
    const root = document.documentElement;
    let mode = prefs.mode || 'light';
    if (mode === 'auto') {
      mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    const theme = prefs.theme || 'default';
    root.setAttribute('data-mode', mode);
    root.setAttribute('data-theme', theme);
    if (prefs.mode === 'auto') root.setAttribute('data-mode-auto', '1'); else root.removeAttribute('data-mode-auto');
    safeSet(APPEARANCE_KEY, { mode: prefs.mode || 'light', theme });
    $$('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === (prefs.mode || 'light')));
    $$('.swatch').forEach((b) => b.classList.toggle('active', b.dataset.theme === theme));
  }
  function loadAppearance() {
    const prefs = safeGet(APPEARANCE_KEY, {});
    if (!prefs.mode && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) prefs.mode = 'dark';
    applyAppearance(prefs);
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
      inp.addEventListener('keydown', (e) => {
        const enterSend = __prefs.enterSend !== false;
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && enterSend) { e.preventDefault(); handleSend(); }
      });
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
      toast(forceSearchNext ? 'Web search enabled' : 'Web search disabled');
    });
    on('#imageModeBtn', 'click', () => openModal('imageModal'));
    on('#plansModeBtn', 'click', () => { openModal('plansModal'); loadPlans(); });
    on('#supportModeBtn', 'click', (e) => { e.preventDefault(); openModal('supportModal'); });
    on('#supportModeBtn2', 'click', () => openModal('supportModal'));
    on('#generateImageBtn', 'click', genImage);
    on('#submitReportBtn', 'click', () => { toast('Ticket submitted!'); closeModal('supportModal'); });
    on('#settingsBtn', 'click', (e) => { e.preventDefault(); openSettingsModal(); });
    on('#logoutBtn', 'click', doLogout);
    on('#loginmentBtn', 'click', doLoginment);
    on('#signInFromSettingsBtn', 'click', () => { closeModal('settingsModal'); openModal('loginModal'); });

    // Settings tabs
    $$('.settings-tab').forEach((tab) => {
      tab.onclick = () => {
        const t = tab.dataset.tab;
        $$('.settings-tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === t));
        $$('.settings-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === t));
      };
    });

    // Appearance
    $$('[data-mode]').forEach((b) => { b.onclick = () => applyAppearance({ mode: b.dataset.mode, theme: document.documentElement.getAttribute('data-theme') || 'default' }); });
    $$('.swatch').forEach((b) => { b.onclick = () => applyAppearance({ mode: (safeGet(APPEARANCE_KEY, {}).mode || 'light'), theme: b.dataset.theme }); });
    $$('[data-fontsize]').forEach((b) => { b.onclick = () => { __prefs.fontSize = b.dataset.fontsize; savePrefs(); applyPrefs(); $$('[data-fontsize]').forEach((x) => x.classList.toggle('active', x.dataset.fontsize === __prefs.fontSize)); }; });

    // Toggles
    const bindToggle = (id, key, cb) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        __prefs[key] = el.checked;
        savePrefs();
        applyPrefs();
        if (cb) cb(el.checked);
      });
    };
    bindToggle('autoScrollToggle', 'autoScroll');
    bindToggle('enterSendToggle', 'enterSend');
    bindToggle('showThinkingToggle', 'showThinking');
    bindToggle('compactToggle', 'compact');
    bindToggle('reduceMotionToggle', 'reduceMotion');
    bindToggle('desktopNotifyToggle', 'desktopNotify', (v) => {
      if (v && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    });
    bindToggle('soundToggle', 'sound');
    bindToggle('bonusReminderToggle', 'bonusReminder');
    bindToggle('verboseLogToggle', 'verboseLog');
    bindToggle('translateCommentsToggle', 'translateComments');

    // Persona
    on('#savePersonaBtn', 'click', () => {
      const inp = $('#personaInput'); if (!inp) return;
      __prefs.persona = inp.value.trim();
      savePrefs();
      const st = $('#personaStatus'); if (st) { st.textContent = 'Saved ✓'; st.className = 'persona-status ok'; setTimeout(() => { st.textContent = ''; }, 2000); }
      toast('Persona saved');
    });
    on('#clearPersonaBtn', 'click', () => {
      const inp = $('#personaInput'); if (inp) inp.value = '';
      __prefs.persona = ''; savePrefs();
      const st = $('#personaStatus'); if (st) { st.textContent = 'Cleared'; st.className = 'persona-status'; setTimeout(() => { st.textContent = ''; }, 2000); }
    });
    $$('.persona-preset').forEach((b) => {
      b.onclick = () => {
        const inp = $('#personaInput'); if (inp) inp.value = b.dataset.persona;
        toast('Preset applied — click Save to persist');
      };
    });

    // MCP
    on('#mcpEnableToggle', 'change', (e) => { safeSet(MCP_KEY + '_enabled', e.target.checked); toast(`MCP ${e.target.checked ? 'enabled' : 'disabled'}`); });
    on('#mcpAddBtn', 'click', () => {
      const name = $('#mcpNameInput')?.value.trim();
      const url = $('#mcpUrlInput')?.value.trim();
      const key = $('#mcpKeyInput')?.value.trim();
      if (!name || !url) { toast('Name and URL are required'); return; }
      __mcpServers.push({ name, url, key });
      saveMcp(); renderMcpList();
      $('#mcpNameInput').value = ''; $('#mcpUrlInput').value = ''; $('#mcpKeyInput').value = '';
      toast(`Added server: ${name}`);
    });

    // Language
    on('#languageSelect', 'change', (e) => { __prefs.responseLanguage = e.target.value; savePrefs(); toast('Response language updated'); });
    on('#uiLanguageSelect', 'change', (e) => { __prefs.uiLanguage = e.target.value; savePrefs(); toast('UI language preference saved (requires reload)'); });

    // Data
    on('#exportChatsBtn', 'click', () => {
      const blob = new Blob([JSON.stringify(__conversations, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `mirox-chats-${Date.now()}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      toast('Chats exported');
    });
    on('#importChatsBtn', 'click', () => $('#importChatsInput')?.click());
    on('#importChatsInput', 'change', (e) => {
      const file = e.target.files?.[0]; if (!file) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const arr = JSON.parse(String(r.result));
          if (!Array.isArray(arr)) throw new Error('not an array');
          __conversations = arr.concat(__conversations);
          saveChats(); renderHistory();
          toast(`Imported ${arr.length} chats`);
        } catch { toast('Invalid file'); }
      };
      r.readAsText(file);
      e.target.value = '';
    });
    on('#clearChatsBtn', 'click', () => {
      if (!confirm('Delete all chats? This cannot be undone.')) return;
      __conversations = []; saveChats(); startNewChat();
      toast('All chats cleared');
    });
    on('#clearAllDataBtn', 'click', () => {
      if (!confirm('Reset everything? Chats, settings and bonus will be erased.')) return;
      ['miroxai_conversations_v34','miroxai_appearance_v34','miroxai_share_v5','miroxai_bonus_v5','miroxai_prefs_v1','miroxai_mcp_v1','mirox_token','miroxai_guest_id_v1'].forEach((k) => { try { localStorage.removeItem(k); } catch {} });
      toast('All local data cleared — reloading…');
      setTimeout(() => location.reload(), 900);
    });

    // Developer
    on('#copyDiagBtn', 'click', async () => {
      const diag = {
        ua: navigator.userAgent, url: location.href, ts: Date.now(),
        tier: __tier, guestId: getGuestId(),
        bonus: loadBonusRaw(),
        model: __model,
        mcpServers: __mcpServers.length,
      };
      try { await navigator.clipboard.writeText(JSON.stringify(diag, null, 2)); toast('Diagnostics copied'); } catch {}
    });
    on('#resetGuestBtn', 'click', () => {
      if (!confirm('Reset guest ID? You will need to re-share to earn a new bonus.')) return;
      const newId = resetGuestId();
      const lbl = $('#guestIdLabel'); if (lbl) lbl.textContent = newId;
      toast('Guest ID reset');
    });

    // Generic close
    document.addEventListener('click', (e) => {
      const cb = e.target.closest('[data-close]');
      if (cb) { closeModal(cb.dataset.close); return; }
      if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open');
      if (e.target.closest('[data-iv-close]')) closeImageViewer();
    });
    on('#userChip', 'click', () => { if (!__user) openModal('loginModal'); });
    on('#upgradeBtn', 'click', (e) => { e.stopPropagation(); if (!__user) openModal('loginModal'); else { openModal('plansModal'); loadPlans(); } });
    on('#simpleLoginForm', 'submit', doLogin);
    on('#ivDownload', 'click', () => { if (!__ivDataUrl) return; const a = document.createElement('a'); a.href = __ivDataUrl; a.download = `mirox-${Date.now()}.png`; document.body.appendChild(a); a.click(); document.body.removeChild(a); });
    on('#shareAdShareBtn', 'click', attemptShare);
    on('#shareAdIgnoreBtn', 'click', () => closeShareAd(true));
    on('#shareAdCloseBtn', 'click', () => closeShareAd(true));
    bindSuggestionClicks();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeImageViewer(); closeModelPicker();
        if ($('#shareAdModal')?.classList.contains('open')) { closeShareAd(true); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('#messageInput')?.focus(); }
    });
    window.addEventListener('resize', () => { if (window.innerWidth > 860) closeSidebar(); });
  }

  function openSettingsModal() {
    // Refresh guest ID display
    const lbl = $('#guestIdLabel'); if (lbl) lbl.textContent = getGuestId();
    renderMcpList();
    openModal('settingsModal');
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
      if (lastBubble && shouldShowContinue(lastAiMessage.content || '', convo, true)) {
        attachContinueButton(lastAiEl, lastBubble, lastAiMessage);
      }
    }
    renderHistory(); updateTokenUsage();
    scrollToBottom(true);
  }

  async function init() {
    try {
      loadAppearance(); loadPrefs(); applyPrefs(); loadShareState(); loadChats(); loadMcp(); wireAll();
      __lastBonusActive = isBonusActive();
      renderHistory(); renderModelPicker(); startIdleMascot();
      updateTokenUsage(); renderMcpList();
      startBonusWatcher();
      // Auto-detect OS theme change if mode === 'auto'
      if (window.matchMedia) {
        try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
          const p = safeGet(APPEARANCE_KEY, {});
          if (p.mode === 'auto') applyAppearance(p);
        }); } catch {}
      }
    } catch (e) { console.error('[Mirox init]', e); }
    finally { killLoader(); }
    loadConfig().catch(() => {});
    refreshUsage().then(() => openShareAd()).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
