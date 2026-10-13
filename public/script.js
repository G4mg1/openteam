(function () {
  'use strict';

  /* ============================================================
     MiroxAI frontend v102 — DeepThink · thinking-first · HTML runner
     ============================================================ */

  /* ---------- i18n ---------- */
  const I18N_CACHE_KEY = 'miroxai_i18n_cache_v6';
  const RTL_LANGS = ['fa','ar','he','ur'];
  const TRANSLATE_CONCURRENCY = 2;
  const MYMEMORY_OK = new Set(['es','fr','de','it','pt','ru','ja','ko','ar','hi','fa','tr','vi','th','id','nl','pl','sv','el','cs','ro','uk','he','zh-CN','es-MX']);
  function isTranslatable(code) { return !!(code && typeof code === 'string' && MYMEMORY_OK.has(code.trim())); }
  let __i18nCache = {}, __translationQueue = [], __translating = false, __translationStatusEl = null;
  function loadI18nCache() { try { __i18nCache = JSON.parse(localStorage.getItem(I18N_CACHE_KEY) || '{}') || {}; } catch { __i18nCache = {}; } }
  function saveI18nCache() { try { localStorage.setItem(I18N_CACHE_KEY, JSON.stringify(__i18nCache)); } catch {} }
  function setTranslateStatus(t) { if (!__translationStatusEl) __translationStatusEl = document.getElementById('translateStatus'); if (__translationStatusEl) __translationStatusEl.textContent = t || ''; }
  async function translateString(text, lang) {
    if (!text || !isTranslatable(lang)) return text;
    const key = lang + ':' + text;
    if (__i18nCache[key]) return __i18nCache[key];
    const chunk = text.length > 350 ? text.slice(0, 350) : text;
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(chunk) + '&langpair=' + encodeURIComponent('en|' + lang) + '&mt=1';
    try {
      const r = await fetch(url, { method: 'GET', mode: 'cors' });
      if (!r.ok) throw new Error('http_' + r.status);
      const d = await r.json();
      const status = Number(d && d.responseStatus) || 0;
      const raw = (d && d.responseData && d.responseData.translatedText) || '';
      if (status && status !== 200) throw new Error('mm_' + status);
      let clean = String(raw).trim();
      if (!clean) throw new Error('empty');
      if (clean.startsWith('"') && clean.endsWith('"')) clean = clean.slice(1, -1);
      if (clean === chunk) throw new Error('echo');
      __i18nCache[key] = clean; saveI18nCache(); return clean;
    } catch { __i18nCache[key] = text; saveI18nCache(); return text; }
  }
  function enqueueTranslation(el, src, lang, mode) { if (!isTranslatable(lang)) return; __translationQueue.push({ element: el, sourceText: src, targetLang: lang, mode }); processQueue(); }
  async function processQueue() {
    if (__translating) return;
    if (!__translationQueue.length) { setTranslateStatus(''); return; }
    __translating = true;
    const total = __translationQueue.length; let done = 0;
    setTranslateStatus('Translating… (0/' + total + ')');
    while (__translationQueue.length) {
      const batch = __translationQueue.splice(0, TRANSLATE_CONCURRENCY);
      const results = await Promise.all(batch.map((j) => translateString(j.sourceText, j.targetLang)));
      results.forEach((tr, i) => {
        const job = batch[i];
        if (!job.element || !job.element.isConnected) return;
        if (typeof tr !== 'string' || !tr) return;
        if (job.mode === 'text') {
          if (job.element.children.length === 0) job.element.textContent = tr;
          else for (const n of job.element.childNodes) { if (n.nodeType === 3 && n.textContent.trim()) { n.textContent = tr; break; } }
        } else if (job.mode === 'placeholder') job.element.placeholder = tr;
        else if (job.mode === 'title') job.element.title = tr;
      });
      done += batch.length;
      setTranslateStatus('Translating… (' + Math.min(done, total) + '/' + total + ')');
    }
    __translating = false; setTranslateStatus('');
  }
  function applyTranslations() {
    const lang = (__prefs && __prefs.uiLanguage) || 'en';
    const isRtl = RTL_LANGS.includes(lang);
    document.documentElement.lang = lang;
    document.documentElement.setAttribute('data-dir', isRtl ? 'rtl' : 'ltr');
    const setSrc = (el, s) => { if (el.children.length === 0) el.textContent = s; else for (const n of el.childNodes) { if (n.nodeType === 3 && n.textContent.trim()) { n.textContent = s; break; } } };
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      if (!el.dataset.i18nEn) {
        let s = '';
        if (el.children.length === 0) s = el.textContent;
        else { for (const n of el.childNodes) { if (n.nodeType === 3 && n.textContent.trim()) { s = n.textContent.trim(); break; } } if (!s) s = el.textContent; }
        el.dataset.i18nEn = s;
      }
      const src = el.dataset.i18nEn; if (!src) return;
      if (!isTranslatable(lang)) { setSrc(el, src); return; }
      const k = lang + ':' + src;
      if (__i18nCache[k]) setSrc(el, __i18nCache[k]); else enqueueTranslation(el, src, lang, 'text');
    });
  }

  /* ---------- Loader ---------- */
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
  setTimeout(killLoader, 1500);
  window.addEventListener('load', killLoader);
  window.addEventListener('error', killLoader);
  window.addEventListener('unhandledrejection', killLoader);

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
  const IS_PC = (() => {
    const ua = navigator.userAgent || '';
    const mobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|Mobile/i.test(ua);
    const touchOnly = (('ontouchstart' in window) || navigator.maxTouchPoints > 1) && !window.matchMedia('(pointer: fine)').matches;
    return !mobile && !touchOnly;
  })();

  const FALLBACK_MODELS = [
    { id: 'mirox-luna-1.2', label: 'Luna', tier: 'free', tagline: 'Fast, unlimited', icon: 'ri-moon-line' },
    { id: 'mirox-gen-1', label: 'Gen', tier: 'free', tagline: 'Concise, unlimited', icon: 'ri-flashlight-line' },
    { id: 'mirox-pro-5', label: 'Pro', tier: 'pro', tagline: 'Deeper reasoning', icon: 'ri-vip-diamond-line' },
    { id: 'mirox-ultra-10', label: 'Ultra', tier: 'pro', tagline: 'Long context', icon: 'ri-rocket-2-line' },
    { id: 'mirox-eclipse-2.0', label: 'Eclipse', tier: 'ultimate', tagline: 'Most powerful', icon: 'ri-sun-fill' },
  ];
  const LS_KEY = 'miroxai_conversations_v50';
  const TOKEN_KEY = 'mirox_token';
  const LOCAL_USER_KEY = 'mirox_local_user_v3';
  const GUEST_KEY = 'miroxai_guest_id_v1';
  const APPEARANCE_KEY = 'miroxai_appearance_v50';
  const PREFS_KEY = 'miroxai_prefs_v12';
  const BRIDGE_OPTS_KEY = 'miroxai_bridge_opts_v1';
  const PASTE_ATTACH_THRESHOLD = 1024;
  const NET_TIMEOUT_MS = 15000;
  const STREAM_TIMEOUT_MS = 600000;   // ⚡ 10 min for long code
  const MAX_IMAGE_DIM = 1600;
  const MAX_TEXT_FILE_BYTES = 300000;
  const MAX_BRIDGE_ITER = 40;
  const MAX_AUTO_CONTINUES = 6;
  const MAX_DUP_COMMANDS = 3;
  const MAX_DUP_REPLIES = 2;

  let __config = null, __user = null, __tier = 'free', __model = 'mirox-luna-1.2';
  let currentConversationId = null, isReplying = false;
  let continuationBusy = false, streamRenderAt = 0, userIsAtBottom = true;
  let autoScrollEnabled = true;
  let __conversations = [], pendingFiles = [], activeStreamController = null;
  let forceSearchNext = false, __historyQuery = '';
  let __ivDataUrl = '';
  let __prefs = {};
  let __bridge = { name: 'My Laptop', port: 8765, connected: false, baseUrl: null, env: null };
  let bridgeRunning = false, bridgeAbort = false, bridgeConversation = [], bridgeProgress = 0;
  let bridgeTurn = null, bridgeTaskComplete = true, bridgeWaitingForUser = false;
  let __lastBuildFolder = null, __lastPreviewFile = null;
  let __sudoPassword = '', __sudoRemember = false, __sudoResolver = null;
  let __bridgeAutoRun = true, __bridgeShowCode = false;
  let __voiceRecognition = null;
  let __voiceListening = false;
  let __previewFileRef = null;
  let __supportConv = null;
  let __supportPollTimer = null;
  let __supportSending = false;
  let __hrCurrentCode = '';

  const uid = () => 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const escapeHtml = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  function safeGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
  function safeSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
  function safeRemove(k) { try { localStorage.removeItem(k); } catch {} }
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
  function setToken(tk) { try { tk ? localStorage.setItem(TOKEN_KEY, tk) : localStorage.removeItem(TOKEN_KEY); } catch {} }
  function isApiKey(tk) { return typeof tk === 'string' && /^mxk_live_/.test(tk); }
  function getLocalUser() { const u = safeGet(LOCAL_USER_KEY, null); if (u && u.email && u.name && u.signedIn) return u; return null; }
  function setLocalUser(u) { u ? safeSet(LOCAL_USER_KEY, u) : safeRemove(LOCAL_USER_KEY); }
  function getGuestId() {
    let id = null;
    try { id = localStorage.getItem(GUEST_KEY); } catch {}
    if (!id || id.length < 8) { id = 'g_' + Math.random().toString(36).slice(2, 14) + Date.now().toString(36).slice(-6); try { localStorage.setItem(GUEST_KEY, id); } catch {} }
    return id;
  }
  function authHeaders(extra) {
    const h = { 'Content-Type': 'application/json', ...(extra || {}) };
    const tk = getToken();
    if (isApiKey(tk)) h.Authorization = 'Bearer ' + tk;
    if (__prefs.responseLanguage && __prefs.responseLanguage !== 'auto') h['X-Mirox-Lang'] = __prefs.responseLanguage;
    return h;
  }
  async function netFetch(url, opts = {}, ms = NET_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctrl.signal, credentials: 'same-origin', cache: 'no-store' }); }
    finally { clearTimeout(timer); }
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

  /* ---------- Prefs ---------- */
  const DEFAULT_PREFS = { autoScroll: true, enterSend: true, vision: true, compact: false, reduceMotion: false, fontSize: 'md', mode: 'light', theme: 'default', responseLanguage: 'auto', uiLanguage: 'en', deepThink: false };
  function loadPrefs() {
    __prefs = Object.assign({}, DEFAULT_PREFS, safeGet(PREFS_KEY, {}));
    const app = safeGet(APPEARANCE_KEY, {});
    if (app.mode) __prefs.mode = app.mode;
    if (app.theme) __prefs.theme = app.theme;
  }
  function savePrefs() { safeSet(PREFS_KEY, __prefs); safeSet(APPEARANCE_KEY, { mode: __prefs.mode, theme: __prefs.theme }); }
  function applyPrefs() {
    const root = document.documentElement;
    root.setAttribute('data-fontsize', __prefs.fontSize || 'md');
    root.classList.toggle('reduce-motion', !!__prefs.reduceMotion);
    root.classList.toggle('compact-mode', !!__prefs.compact);
    autoScrollEnabled = __prefs.autoScroll !== false;
    const syncChk = (id, val) => { const el = document.getElementById(id); if (el && el.checked !== !!val) el.checked = !!val; };
    syncChk('autoScrollToggle', __prefs.autoScroll);
    syncChk('enterSendToggle', __prefs.enterSend);
    syncChk('visionToggle', __prefs.vision);
    syncChk('compactToggle', __prefs.compact);
    syncChk('reduceMotionToggle', __prefs.reduceMotion);
    syncChk('deepThinkToggle', __prefs.deepThink);
    $$('#modeSegmented .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === (__prefs.mode || 'light')));
    $$('#fontSizeSegmented .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.fontsize === (__prefs.fontSize || 'md')));
    $$('#accentSwatches .swatch').forEach((b) => b.classList.toggle('active', b.dataset.theme === (__prefs.theme || 'default')));
    const uiSel = document.getElementById('uiLanguageSelect');
    if (uiSel && uiSel.value !== (__prefs.uiLanguage || 'en')) uiSel.value = __prefs.uiLanguage || 'en';
    const langSel = document.getElementById('languageSelect');
    if (langSel && langSel.value !== (__prefs.responseLanguage || 'auto')) langSel.value = __prefs.responseLanguage || 'auto';
    applyDeepThinkUI();
  }
  function applyAppearanceFromPrefs() {
    const root = document.documentElement;
    let mode = __prefs.mode || 'light';
    if (mode === 'auto') mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    root.setAttribute('data-mode', mode);
    root.setAttribute('data-theme', __prefs.theme || 'default');
  }
  function applyDeepThinkUI() {
    const btn = document.getElementById('deepThinkBtn');
    if (btn) btn.classList.toggle('active', !!__prefs.deepThink);
    const inp = document.getElementById('messageInput');
    if (inp) inp.placeholder = __prefs.deepThink ? 'DeepThink is on — ask anything complex…' : 'How can I help you today?';
  }

  /* ---------- Mascot ---------- */
  const MOODS = ['idle','happy','thinking','coding','celebrate','error','learning','wink','study','searching','reading'];
  function blobSvg() {
    return `<svg class="blob-svg" viewBox="0 0 200 180" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mirox avatar"><g class="blob-float"><rect class="leg leg-1" x="46" y="126" width="14" height="32" rx="7"/><rect class="leg leg-2" x="76" y="126" width="14" height="32" rx="7"/><rect class="leg leg-3" x="110" y="126" width="14" height="32" rx="7"/><rect class="leg leg-4" x="140" y="126" width="14" height="32" rx="7"/><rect class="blob-body" x="20" y="30" width="160" height="110" rx="26"/><g class="blob-eyes"><rect class="eye eye-left" x="62" y="64" width="18" height="34" rx="9"/><rect class="eye eye-right" x="120" y="64" width="18" height="34" rx="9"/></g><g class="blob-glasses" fill="none" stroke="var(--blob-eye)" stroke-width="4" stroke-linecap="round"><rect x="50" y="52" width="44" height="46" rx="12"/><rect x="106" y="52" width="44" height="46" rx="12"/><path d="M94 72 Q100 68 106 72"/></g></g></svg>`;
  }
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
  const lbEl = document.getElementById('loadingBlob');
  if (lbEl) lbEl.innerHTML = `<div class="mascot mascot-lg m-idle" data-mood="idle">${blobSvg()}</div>`;
  function startIdleMascot() {
    const cuteMoods = ['wink', 'study', 'searching', 'happy', 'thinking', 'learning', 'reading'];
    setInterval(() => {
      const w = document.getElementById('welcomeMascot');
      if (!w || isReplying || !w.parentElement) return;
      setMascotMood(cuteMoods[Math.floor(Math.random() * cuteMoods.length)], w.parentElement);
    }, 6000);
  }
  function pickMoodFor(text) {
    const t2 = String(text || '').toLowerCase();
    if (/\b(search|look up|google|latest|news|find)\b/.test(t2)) return 'searching';
    if (/\b(build|code|script|fix|bug|function|debug|lua|python|javascript|html|css)\b/.test(t2)) return 'coding';
    if (/\b(explain|teach|learn|how does|why|what is|study)\b/.test(t2)) return 'study';
    if (/\b(read|paper|article|document)\b/.test(t2)) return 'reading';
    return 'thinking';
  }

  /* ═══════════ THINK PANEL ═══════════ */
  function createThinkPanel(deep) {
    const el = document.createElement('div');
    el.className = 'think-panel';
    el.dataset.state = 'thinking';
    el.dataset.collapsed = 'false';
    el.dataset.mode = deep ? 'deep' : 'normal';
    el.innerHTML = `
      <div class="think-header">
        <div class="think-icon"><i class="ri-loader-4-line"></i></div>
        <div class="think-title"><span class="think-title-text">${deep ? 'DeepThink' : 'Thinking'}</span></div>
        <div class="think-timer-pill">0.0s</div>
        <button class="think-toggle" type="button" title="Minimize" aria-label="Minimize">
          <i class="ri-arrow-up-s-line"></i>
        </button>
      </div>
      <div class="think-body-wrap">
        <div class="think-body" data-think-body></div>
      </div>`;
    const titleTextEl = el.querySelector('.think-title-text');
    const timerPill = el.querySelector('.think-timer-pill');
    const toggle = el.querySelector('.think-toggle');
    const body = el.querySelector('.think-body');
    const iconEl = el.querySelector('.think-icon i');

    const t0 = performance.now();
    let done = false;

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsed = el.dataset.collapsed === 'true';
      el.dataset.collapsed = collapsed ? 'false' : 'true';
      toggle.title = collapsed ? 'Minimize' : 'Expand';
      toggle.setAttribute('aria-label', toggle.title);
      const arrowI = toggle.querySelector('i');
      if (arrowI) arrowI.className = (collapsed ? 'ri-arrow-up-s-line' : 'ri-arrow-down-s-line');
    });

    const timer = setInterval(() => {
      if (done) { clearInterval(timer); return; }
      timerPill.textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's';
    }, 100);

    function replaceText(full) {
      body.innerHTML = '';
      const sentences = String(full || '').split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
      if (!sentences.length) return;
      for (let i = 0; i < sentences.length; i++) {
        const line = document.createElement('div');
        line.className = 'think-line';
        line.style.animationDelay = (i * 60) + 'ms';
        line.innerHTML = `<span class="think-line-dot"></span><span class="think-line-text">${escapeHtml(sentences[i].trim())}</span>`;
        body.appendChild(line);
      }
    }

    function setState(next) {
      el.dataset.state = next;
      if (next === 'thinking') {
        iconEl.className = 'ri-loader-4-line';
        titleTextEl.textContent = deep ? 'DeepThink' : 'Thinking';
      } else if (next === 'done') {
        iconEl.className = 'ri-checkbox-circle-fill';
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        titleTextEl.textContent = (deep ? 'DeepThink · ' : 'Thought for ') + secs + 's';
      } else if (next === 'failed') {
        iconEl.className = 'ri-error-warning-fill';
        titleTextEl.textContent = 'Stopped thinking';
      }
    }

    function finalize() {
      if (done) return;
      done = true;
      clearInterval(timer);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      timerPill.textContent = secs + 's';
      setState('done');
      setTimeout(() => {
        if (el.isConnected && el.dataset.collapsed === 'false') {
          el.dataset.collapsed = 'true';
          const arrowI = toggle.querySelector('i');
          if (arrowI) arrowI.className = 'ri-arrow-down-s-line';
        }
      }, 1200);
    }

    function fail(msg) {
      if (done) return;
      done = true;
      clearInterval(timer);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      timerPill.textContent = secs + 's';
      setState('failed');
      if (msg) {
        const line = document.createElement('div');
        line.className = 'think-line';
        line.style.animation = 'none';
        line.style.opacity = '1';
        line.style.transform = 'none';
        line.innerHTML = `<span class="think-line-dot"></span><span class="think-line-text">${escapeHtml(msg)}</span>`;
        body.appendChild(line);
      }
    }

    return { el, replaceText, finalize, fail, setState, isDone() { return done; }, destroy() { clearInterval(timer); } };
  }

  /* ---------- Canvas watermark ---------- */
  const WM_TEXT = 'Mirox AI';
  function paintWatermark(canvas, img) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.drawImage(img, 0, 0, W, H);
    const minDim = Math.min(W, H);
    const pad = Math.max(12, Math.round(minDim * 0.028));
    const textSize = Math.max(16, Math.round(minDim * 0.038));
    const blobR = textSize * 0.55;
    const blobW = blobR * 2;
    const blobH = blobR * 1.75;
    const bx = pad + blobR;
    const by = H - pad - blobR;
    const grad = ctx.createLinearGradient(0, H - textSize * 3, 0, H);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, H - textSize * 3, W, textSize * 3);
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = '#d97757';
    const radius = blobR * 0.55;
    const bxL = bx - blobR, byT = by - blobR * 0.9;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(bxL, byT, blobW, blobH, radius);
    else { const r = radius; ctx.moveTo(bxL + r, byT); ctx.lineTo(bxL + blobW - r, byT); ctx.quadraticCurveTo(bxL + blobW, byT, bxL + blobW, byT + r); ctx.lineTo(bxL + blobW, byT + blobH - r); ctx.quadraticCurveTo(bxL + blobW, byT + blobH, bxL + blobW - r, byT + blobH); ctx.lineTo(bxL + r, byT + blobH); ctx.quadraticCurveTo(bxL, byT + blobH, bxL, byT + blobH - r); ctx.lineTo(bxL, byT + r); ctx.quadraticCurveTo(bxL, byT, bxL + r, byT); ctx.closePath(); }
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    const eyeW = blobR * 0.28, eyeH = blobR * 0.72;
    ctx.fillRect(bx - blobR * 0.5, by - blobR * 0.35, eyeW, eyeH);
    ctx.fillRect(bx + blobR * 0.22, by - blobR * 0.35, eyeW, eyeH);
    ctx.font = `700 ${textSize}px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = Math.max(4, textSize * 0.22);
    ctx.shadowOffsetY = 1.2;
    const tx = bx + blobR + textSize * 0.55;
    const ty = by + textSize * 0.03;
    ctx.fillText(WM_TEXT, tx, ty);
    ctx.shadowBlur = Math.max(3, textSize * 0.15);
    ctx.font = `500 ${Math.round(textSize * 0.62)}px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.fillText('miroxai.org', tx, ty + textSize * 0.85);
    ctx.restore();
  }
  function watermarkedDataUrl(srcDataUrl) {
    return new Promise((resolve) => {
      if (!srcDataUrl) return resolve('');
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth || 1024;
          c.height = img.naturalHeight || 1024;
          paintWatermark(c, img);
          resolve(c.toDataURL('image/png'));
        } catch { resolve(srcDataUrl); }
      };
      img.onerror = () => resolve(srcDataUrl);
      img.src = srcDataUrl;
    });
  }
  function openImageViewer(url) {
    if (!url) return; __ivDataUrl = url;
    const iv = $('#imageViewer'); if (!iv) return;
    iv.classList.add('open');
    const c = $('#ivCanvas'); if (!c) return;
    const img = new Image();
    img.onload = () => { c.width = img.naturalWidth; c.height = img.naturalHeight; paintWatermark(c, img); };
    img.src = url;
  }
  function closeImageViewer() { $('#imageViewer')?.classList.remove('open'); }

  /* ---------- Conversations ---------- */
  function currentConvo() { return __conversations.find((c) => c.id === currentConversationId) || null; }
  function saveChats() {
    const slim = __conversations.map((c) => ({
      ...c,
      messages: (c.messages || []).map((m) => ({
        id: m.id, role: m.role, content: m.content, ts: m.ts,
        thinking: m.thinking || '',
        imageKey: m.imageKey || null,
        files: (m.files || []).map((f) => ({
          name: f.name, size: f.size, type: f.type, mime: f.mime,
          dataUrl: (f.type === 'image' && f.dataUrl && f.dataUrl.length < 200000) ? f.dataUrl : undefined,
          width: f.width, height: f.height,
          content: (f.type === 'text' && f.content && f.content.length < 60000) ? f.content : undefined,
        })),
      })),
    }));
    safeSet(LS_KEY, slim);
  }
  function loadChats() { const v = safeGet(LS_KEY, []); __conversations = Array.isArray(v) ? v : []; }

  function welcomeHTML() {
    return `<div class="welcome-screen">
      <div class="welcome-mascot"><div class="mascot mascot-lg m-idle" id="welcomeMascot" data-mood="idle">${blobSvg()}</div></div>
      <h1 class="welcome-title">Hi, I'm Mirox</h1>
      <p class="welcome-sub">Luna and Gen are unlimited and free. <strong>Sign in</strong> to use Pro, Ultra, Eclipse and image generation.</p>
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
    const ttl = $('#chatTitle'); if (ttl) ttl.textContent = 'New chat';
    const c = $('#chatMessages'); if (c) c.innerHTML = welcomeHTML();
    bindSuggestionClicks(); updateTokenUsage(); renderHistory();
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
    if (q) items = __conversations.filter((c) => (c.title || '').toLowerCase().includes(q));
    if (!items.length) { list.innerHTML = `<li class="history-empty">No conversations yet</li>`; return; }
    list.innerHTML = items.map((c) =>
      `<li class="history-item${c.id === currentConversationId ? ' active' : ''}" data-id="${c.id}">
        <i class="ri-chat-3-line"></i>
        <span class="history-title">${escapeHtml(c.title || 'Chat')}</span>
        <button class="history-delete icon-btn" aria-label="Delete chat"><i class="ri-delete-bin-line"></i></button>
      </li>`).join('');
  }
  function estimateTokens(text) { return Math.ceil(String(text || '').length / 4); }
  function conversationTokenUsage(convo = currentConvo()) { if (!convo) return 0; return (convo.messages || []).reduce((s, m) => s + estimateTokens(m.content || ''), 0); }
  function formatK(n) { return n >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k' : String(n); }
  function updateTokenUsage() {
    const el = $('#tokenUsage'); if (!el) return;
    const used = conversationTokenUsage();
    const span = el.querySelector('span');
    if (span) span.textContent = formatK(used) + ' tokens';
  }
  function atChatBottom(c = $('#chatMessages')) { return !c || c.scrollHeight - c.scrollTop - c.clientHeight < 100; }
  function scrollToBottom(force = false) {
    const c = $('#chatMessages'); if (!c) return;
    if (force || (autoScrollEnabled && userIsAtBottom && __prefs.autoScroll !== false)) c.scrollTop = c.scrollHeight;
    updateScrollButton();
  }
  function updateScrollButton() { const c = $('#chatMessages'), b = $('#scrollBottomBtn'); if (!c || !b) return; b.classList.toggle('visible', !atChatBottom(c)); }
  function fmtSize(n) { if (n == null) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }

  /* ---------- File meta ---------- */
  function getFileMeta(name) {
    const m = String(name || '').match(/\.([a-z0-9]+)$/i);
    if (!m) return { label: 'TXT', icon: 'ri-file-text-line' };
    const ext = m[1].toLowerCase();
    const map = {
      py:{label:'PY',icon:'devicon-python-plain colored'},js:{label:'JS',icon:'devicon-javascript-plain colored'},
      mjs:{label:'JS',icon:'devicon-javascript-plain colored'},ts:{label:'TS',icon:'devicon-typescript-plain colored'},
      tsx:{label:'TSX',icon:'devicon-typescript-plain colored'},jsx:{label:'JSX',icon:'devicon-javascript-plain colored'},
      html:{label:'HTML',icon:'devicon-html5-plain colored'},htm:{label:'HTML',icon:'devicon-html5-plain colored'},
      css:{label:'CSS',icon:'devicon-css3-plain colored'},scss:{label:'SCSS',icon:'devicon-css3-plain colored'},
      json:{label:'JSON',icon:'devicon-json-plain colored'},md:{label:'MD',icon:'ri-markdown-line'},
      txt:{label:'TXT',icon:'ri-file-text-line'},csv:{label:'CSV',icon:'ri-file-list-2-line'},
      log:{label:'LOG',icon:'ri-file-list-line'},lua:{label:'LUA',icon:'devicon-lua-plain colored'},
      sh:{label:'SH',icon:'devicon-bash-plain colored'},bash:{label:'SH',icon:'devicon-bash-plain colored'},
      java:{label:'JAVA',icon:'devicon-java-plain colored'},cpp:{label:'C++',icon:'devicon-cplusplus-plain colored'},
      hpp:{label:'C++',icon:'devicon-cplusplus-plain colored'},c:{label:'C',icon:'devicon-c-plain colored'},
      h:{label:'C',icon:'devicon-c-plain colored'},go:{label:'GO',icon:'devicon-go-plain colored'},
      rs:{label:'RS',icon:'devicon-rust-plain colored'},rb:{label:'RB',icon:'devicon-ruby-plain colored'},
      php:{label:'PHP',icon:'devicon-php-plain colored'},sql:{label:'SQL',icon:'ri-database-2-line'},
      yml:{label:'YAML',icon:'ri-file-list-2-line'},yaml:{label:'YAML',icon:'ri-file-list-2-line'},
      xml:{label:'XML',icon:'ri-file-code-line'},svg:{label:'SVG',icon:'devicon-html5-plain colored'},
      zip:{label:'ZIP',icon:'ri-file-zip-line'},
    };
    return map[ext] || { label: ext.toUpperCase().slice(0, 4), icon: 'ri-file-text-line' };
  }
  const TEXT_EXTS = ['txt','md','json','csv','log','py','js','mjs','ts','tsx','jsx','html','htm','css','scss','yml','yaml','xml','sh','bash','sql','java','c','h','cpp','hpp','go','rs','rb','php','lua','svg'];
  function isTextFile(f) { const name = String(f.name || '').toLowerCase(); const m = name.match(/\.([a-z0-9]+)$/); if (!m) return false; return TEXT_EXTS.includes(m[1]); }
  function countLines(text) { if (!text) return 0; const s = String(text); let n = 1; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++; return n; }

  /* ---------- Code lang ---------- */
  const LANG_META = {
    lua:{label:'LUA',icon:'devicon-lua-plain colored',hljs:'lua'},python:{label:'PY',icon:'devicon-python-plain colored',hljs:'python'},
    javascript:{label:'JS',icon:'devicon-javascript-plain colored',hljs:'javascript'},typescript:{label:'TS',icon:'devicon-typescript-plain colored',hljs:'typescript'},
    html:{label:'HTML',icon:'devicon-html5-plain colored',hljs:'xml'},css:{label:'CSS',icon:'devicon-css3-plain colored',hljs:'css'},
    json:{label:'JSON',icon:'devicon-json-plain colored',hljs:'json'},bash:{label:'SH',icon:'devicon-bash-plain colored',hljs:'bash'},
    java:{label:'JAVA',icon:'devicon-java-plain colored',hljs:'java'},cpp:{label:'C++',icon:'devicon-cplusplus-plain colored',hljs:'cpp'},
    c:{label:'C',icon:'devicon-c-plain colored',hljs:'c'},go:{label:'GO',icon:'devicon-go-plain colored',hljs:'go'},
    rust:{label:'RUST',icon:'devicon-rust-plain colored',hljs:'rust'},ruby:{label:'RB',icon:'devicon-ruby-plain colored',hljs:'ruby'},
    php:{label:'PHP',icon:'devicon-php-plain colored',hljs:'php'},sql:{label:'SQL',icon:'ri-database-2-line',hljs:'sql'},
    yaml:{label:'YAML',icon:'ri-file-list-2-line',hljs:'yaml'},markdown:{label:'MD',icon:'ri-markdown-line',hljs:'markdown'},
    svg:{label:'SVG',icon:'devicon-html5-plain colored',hljs:'xml'},
  };
  function langMeta(lang) { const k = String(lang || '').toLowerCase().trim(); return LANG_META[k] || { label: (k || 'CODE').toUpperCase().slice(0, 6), icon: 'ri-code-s-slash-line', hljs: k || 'plaintext' }; }
  function highlightCode(lang, code) {
    const raw = String(code || '').replace(/\n$/, '');
    const meta = langMeta(lang);
    try { if (window.hljs && hljs.getLanguage && hljs.getLanguage(meta.hljs)) return hljs.highlight(raw, { language: meta.hljs }).value; if (window.hljs) return hljs.highlightAuto(raw).value; } catch {}
    return escapeHtml(raw);
  }
  function renderCode(lang, code, closed, codeId) {
    const meta = langMeta(lang);
    const raw = String(code || '').replace(/\n$/, '');
    const isRunnable = /^(html|htm|svg|xml)$/i.test(meta.hljs) || /^(html|htm|svg)$/i.test(String(lang).trim());
    const actions = closed
      ? `<div class="code-block-actions">
          ${isRunnable ? `<button class="code-action-btn run-btn" data-run="${codeId || ''}" title="Run in sandbox"><i class="ri-play-circle-line"></i> Run</button>` : ''}
          <button class="code-action-btn" data-copy><i class="ri-file-copy-line"></i> Copy</button>
        </div>`
      : '<span class="writing-tag"><i class="ri-loader-4-line spin"></i> writing…</span>';
    return `<div class="code-block" data-lang="${escapeHtml(meta.hljs)}" data-code-id="${codeId || ''}"><div class="code-block-header"><span class="code-lang-badge"><i class="${meta.icon}"></i><span>${escapeHtml(meta.label)}</span></span>${actions}</div><pre><code class="hljs language-${escapeHtml(meta.hljs)}">${highlightCode(lang, raw)}</code></pre></div>`;
  }

  /* ---------- Markdown ---------- */
  function renderMarkdown(rawText) {
    if (!rawText) return '';
    const src = String(rawText);
    const parts = [];
    const re = /```([a-zA-Z0-9+#._-]*)\n?([\s\S]*?)```/g;
    let last = 0, m, idx = 0;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) parts.push({ type: 'text', content: src.slice(last, m.index) });
      parts.push({ type: 'code', lang: (m[1] || '').trim(), content: m[2], closed: true, id: 'c' + (idx++) });
      last = re.lastIndex;
    }
    const rest = src.slice(last);
    const openM = rest.match(/```([a-zA-Z0-9+#._-]*)\n?([\s\S]*)$/);
    if (openM) {
      const before = rest.slice(0, openM.index);
      if (before) parts.push({ type: 'text', content: before });
      parts.push({ type: 'code', lang: (openM[1] || '').trim(), content: openM[2], closed: false, id: 'c' + (idx++) });
    } else if (rest) parts.push({ type: 'text', content: rest });
    return parts.map((p) => p.type === 'code' ? renderCode(p.lang, p.content, p.closed, p.id) : renderText(p.content)).join('');
  }
  function renderText(text) {
    const lines = String(text).split('\n');
    let out = ''; const buf = [];
    const flush = () => { if (buf.length) { out += `<p>${inlineFmt(buf.join(' '))}</p>`; buf.length = 0; } };
    const splitRow = (line) => { let s = line.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|')) s = s.slice(0, -1); return s.split('|').map((v) => v.trim()); };
    const isSepRow = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
    for (let i = 0; i < lines.length; i++) {
      const tt = lines[i].trim();
      if (!tt) { flush(); continue; }
      if (tt.includes('|') && i + 1 < lines.length && isSepRow(lines[i + 1])) {
        flush(); const headers = splitRow(tt); i += 1;
        let table = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
        headers.forEach((c) => { table += `<th>${inlineFmt(c)}</th>`; });
        table += '</tr></thead><tbody>';
        while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim() !== '') { i++; const row = splitRow(lines[i]); table += '<tr>'; for (let j = 0; j < headers.length; j++) table += `<td>${inlineFmt(row[j] || '')}</td>`; table += '</tr>'; }
        out += table + '</tbody></table></div>'; continue;
      }
      const hm = tt.match(/^(#{1,6})\s+(.+)$/);
      if (hm) { flush(); const lvl = hm[1].length; out += `<h${lvl} class="md-h md-h${lvl}">${inlineFmt(hm[2])}</h${lvl}>`; continue; }
      const hr = tt.match(/^([-*_])\1{2,}$/);
      if (hr) { flush(); out += '<hr class="md-hr">'; continue; }
      const um = tt.match(/^[-*+]\s+(.+)$/);
      if (um) { flush(); out += `<div class="md-li md-ul">• ${inlineFmt(um[1])}</div>`; continue; }
      const om = tt.match(/^(\d+)\.\s+(.+)$/);
      if (om) { flush(); out += `<div class="md-li md-ol">${om[1]}. ${inlineFmt(om[2])}</div>`; continue; }
      if (/^>\s?/.test(tt)) { flush(); out += `<blockquote class="md-quote">${inlineFmt(tt.replace(/^>\s?/, ''))}</blockquote>`; continue; }
      buf.push(tt);
    }
    flush();
    return out;
  }
  function inlineFmt(t2) {
    let s = escapeHtml(t2);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000C${codes.length - 1}\u0000`; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
    return s;
  }
  function wireCodeButtons(scope) {
    (scope || document).querySelectorAll('.code-action-btn').forEach((btn) => {
      if (btn.__wired) return; btn.__wired = true;
      btn.onclick = async () => {
        const block = btn.closest('.code-block');
        const code = block?.querySelector('pre code')?.textContent || '';
        if (btn.hasAttribute('data-copy')) {
          try {
            await navigator.clipboard.writeText(code);
            const old = btn.innerHTML;
            btn.innerHTML = '<i class="ri-check-line"></i> Copied';
            setTimeout(() => { btn.innerHTML = old; }, 1200);
          } catch {}
        } else if (btn.hasAttribute('data-run')) {
          openHtmlRunner(code);
        }
      };
    });
  }

  /* ---------- HTML Runner ---------- */
  function openHtmlRunner(code) {
    __hrCurrentCode = code || '';
    const modal = $('#htmlRunnerModal'); if (!modal) return;
    const iframe = $('#hrIframe');
    const src = $('#hrSource');
    if (iframe) iframe.srcdoc = __hrCurrentCode;
    if (src) src.textContent = __hrCurrentCode;
    // Reset to Preview tab
    $$('.html-runner-tab').forEach((t) => t.classList.toggle('active', t.dataset.hrTab === 'preview'));
    $$('.html-runner-pane').forEach((p) => { p.style.display = p.dataset.hrPane === 'preview' ? 'flex' : 'none'; });
    modal.classList.add('open');
  }
  function closeHtmlRunner() { $('#htmlRunnerModal')?.classList.remove('open'); }

  /* ---------- Message DOM ---------- */
  function renderAttachmentChip(f, forMessage) {
    if (f.type === 'image' && f.dataUrl) {
      const dims = f.width && f.height ? `<span class="attach-size">${f.width}×${f.height}</span>` : '';
      const vision = f.vision ? '<span class="attach-vision"><i class="ri-eye-line"></i> vision</span>' : '';
      return `<div class="attach-chip attach-chip-image"><img src="${f.dataUrl}" alt="">${escapeHtml(f.name || '')}${dims}${vision}</div>`;
    }
    const meta = getFileMeta(f.name);
    const lines = f.content ? countLines(f.content) : 0;
    const idx = pendingFiles.indexOf(f);
    const previewAttr = forMessage ? '' : ` data-preview-file="${idx}"`;
    return `<div class="attach-chip attach-chip-file"${previewAttr} title="${escapeHtml(f.name || 'file')}${lines ? ` · ${lines} lines` : ''}"><span class="attach-file-badge"><i class="${meta.icon}"></i> ${escapeHtml(meta.label)}</span><span class="attach-chip-file-name">${escapeHtml(f.name || 'file')}</span>${f.size ? `<span class="attach-size">${fmtSize(f.size)}</span>` : ''}${lines > 1 ? `<span class="attach-lines">${lines} lines</span>` : ''}</div>`;
  }
  function addMessageToDOM(role, content, ts, msgId, files, image, thinking) {
    const container = $('#chatMessages'); if (!container) return null;
    container.querySelector('.welcome-screen')?.remove();
    const id = msgId || uid();
    const el = document.createElement('div');
    el.className = 'message ' + (role === 'user' ? 'user' : 'ai');
    el.dataset.msgId = id; el.dataset.role = role;
    let avatar = '';
    if (role === 'ai') avatar = `<div class="message-avatar" data-mood="idle"><div class="mascot mascot-sm m-idle" data-mood="idle">${blobSvg()}</div></div>`;
    let inner = '';
    if (role === 'user' && files && files.length) {
      inner += '<div class="attach-row">';
      for (const f of files) {
        if (f.type === 'image' && f.dataUrl) {
          const dims = f.width && f.height ? `<span class="attach-size">${f.width}×${f.height}</span>` : '';
          const vision = f.vision ? '<span class="attach-vision"><i class="ri-eye-line"></i> vision</span>' : '';
          inner += `<div class="attach-chip attach-chip-image"><img src="${f.dataUrl}" alt="">${escapeHtml(f.name || '')}${dims}${vision}</div>`;
        } else {
          const meta = getFileMeta(f.name);
          const lines = f.content ? countLines(f.content) : 0;
          inner += `<div class="attach-chip attach-chip-file" title="${escapeHtml(f.name || 'file')}"><span class="attach-file-badge"><i class="${meta.icon}"></i> ${escapeHtml(meta.label)}</span><span class="attach-chip-file-name">${escapeHtml(f.name || 'file')}</span>${f.size ? `<span class="attach-size">${fmtSize(f.size)}</span>` : ''}${lines > 1 ? `<span class="attach-lines">${lines} lines</span>` : ''}</div>`;
        }
      }
      inner += '</div>';
    }
    if (role === 'ai' && image) inner += `<div class="gen-image"><img src="${image}" draggable="false" alt=""></div>`;
    inner += '<div class="bubble-text"></div>';
    el.innerHTML = `
      ${avatar}
      <div class="message-body">
        <div class="bubble">${inner}</div>
        <div class="message-actions">
          <button class="action-btn" data-action="copy" aria-label="Copy"><i class="ri-file-copy-line"></i></button>
          ${role === 'ai' ? '<button class="action-btn" data-action="retry" aria-label="Retry"><i class="ri-refresh-line"></i></button>' : ''}
        </div>
        <div class="message-time">${ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</div>
      </div>`;
    container.appendChild(el);
    if (role === 'ai' && thinking) {
      const panel = createThinkPanel(false);
      panel.replaceText(thinking);
      panel.finalize();
      const bodyEl = el.querySelector('.message-body');
      bodyEl.insertBefore(panel.el, bodyEl.firstChild);
    }
    const bt = el.querySelector('.bubble-text');
    if (role === 'user') { bt.textContent = content || ''; if (!content) bt.style.display = 'none'; }
    else if (content) { bt.innerHTML = renderMarkdown(content); wireCodeButtons(bt); }
    if (role === 'ai' && image) { const img = el.querySelector('.gen-image img'); if (img) img.onclick = () => openImageViewer(image); }
    wireMessageActions(el);
    scrollToBottom();
    return el;
  }
  function wireMessageActions(el) {
    el.querySelectorAll('.action-btn').forEach((btn) => {
      if (btn.__wired) return; btn.__wired = true;
      btn.onclick = async () => {
        const action = btn.dataset.action;
        if (action === 'copy') { try { await navigator.clipboard.writeText(el.querySelector('.bubble')?.innerText || ''); btn.innerHTML = '<i class="ri-check-line"></i>'; setTimeout(() => { btn.innerHTML = '<i class="ri-file-copy-line"></i>'; }, 1200); } catch {} }
        else if (action === 'retry') { if (!isReplying) handleRetry(el); }
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
    convo.messages = convo.messages.slice(0, idx); saveChats();
    let s = el.nextElementSibling; while (s) { const n = s.nextElementSibling; s.remove(); s = n; }
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
  function requireSignIn(reason) {
    setLoginError('');
    const sub = $('#loginModalSub');
    if (sub && reason) sub.textContent = reason;
    openModal('loginModal');
    toast(reason || 'Please sign in to continue.', 3000, 'err');
  }
  function looksLikeImageRequest(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    return /\b(generate|create|make|draw|render|paint|show\s+me|give\s+me)\b[^.!?]{0,60}\b(image|picture|photo|illustration|drawing|painting)\b/i.test(t)
      || /^(?:an?\s+)?(image|picture|photo|illustration)\s+of\s+/i.test(t);
  }
  function handleSend() {
    if (isReplying) return;
    const inp = $('#messageInput'); if (!inp) return;
    const text = inp.value.trim();
    if (!text && !pendingFiles.length) return;
    const hasImageFile = pendingFiles.some((f) => f.type === 'image');

    /* DeepThink disables image generation */
    if (__prefs.deepThink && !hasImageFile && looksLikeImageRequest(text)) {
      toast('Image generation is disabled while DeepThink is on. Turn it off to generate images.', 4500, 'err');
      return;
    }

    /* Sign-in required for image gen */
    if (!__user && looksLikeImageRequest(text)) { requireSignIn('Sign in to generate images with Mirox.'); return; }
    if (!__user && hasImageFile && detectImageEditIntent(text, true)) { requireSignIn('Sign in to edit images with Mirox.'); return; }

    if (!currentConversationId) {
      currentConversationId = uid();
      __conversations.unshift({ id: currentConversationId, title: text.slice(0, 60) || 'New chat', messages: [], created: Date.now() });
    }
    const msgId = uid();
    const convo = currentConvo();
    if (convo) convo.messages.push({ id: msgId, role: 'user', content: text, ts: Date.now(), files: pendingFiles.slice() });
    addMessageToDOM('user', text, Date.now(), msgId, pendingFiles.slice());
    inp.value = ''; inp.style.height = 'auto';
    const files = pendingFiles.slice();
    pendingFiles = []; updatePreview(); updateSendButtonState();
    saveChats(); renderHistory(); updateTokenUsage();
    sendToAPI(text, files, forceSearchNext);
    forceSearchNext = false;
    $('#searchModeBtn')?.classList.remove('active');
  }

  function countFences(text) {
    let n = 0;
    const s = String(text || '');
    for (let i = 0; i < s.length - 2; i++) if (s.charCodeAt(i) === 96 && s.charCodeAt(i + 1) === 96 && s.charCodeAt(i + 2) === 96) { n++; i += 2; }
    return n;
  }
  function shouldShowContinue(full, streamComplete) {
    if (!full) return false;
    if (!streamComplete) return true;
    const fences = countFences(full);
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
    btn.disabled = true;
    btn.innerHTML = '<i class="ri-loader-4-line spin"></i><span>Continuing…</span>';
    try {
      await sendToAPI(
        'Continue EXACTLY from where you stopped. Do NOT repeat any prior text. Do NOT add a preamble. Do NOT open a new code fence if the previous message ended inside one — just keep writing. Output only the raw continuation.',
        [], false,
        { existingMsgEl: msgEl, existingBubble: bubble, messageObj, continuation: true }
      );
    } finally { continuationBusy = false; if (btn.isConnected) btn.remove(); }
  }

  /* ---------- Image edit intent ---------- */
  function detectImageEditIntent(text, hasImage) {
    if (!hasImage) return null;
    const t = String(text || '').toLowerCase().trim();
    if (!t) return null;
    const editVerbs = /\b(edit|modify|change|make|turn|transform|adjust|retouch|enhance|fix|recolor|colour|colorize|swap|replace|add|remove|delete|paint|redraw|restyle|redesign|update|redo)\b/;
    const refersToImage = /\b(image|photo|picture|pic|it|this|that|him|her|them|cat|dog|person|face|hair|background|color|colour|smile|eyes?|nose|mouth|shirt|clothes?)\b/;
    if (!editVerbs.test(t) || !refersToImage.test(t)) return false;
    return t;
  }

  /* ---------- Send to API ---------- */
  async function sendToAPI(text, files, forceSearch, continuation = null) {
    const isContinuation = !!(continuation && continuation.continuation);
    isReplying = true; updateSendButtonState();
    const stopBtn = $('#stopBtn'); if (stopBtn) stopBtn.style.display = 'grid';
    const convo = currentConvo();
    const history = convo ? convo.messages.slice(-14).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })) : [];
    const model = __model || 'mirox-luna-1.2';
    const container = $('#chatMessages');
    container?.querySelector('.welcome-screen')?.remove();
    let msgEl, bubble, bubbleText, timeEl, avatarMascot, thinkPanel;
    const aiMsgId = isContinuation ? continuation.messageObj.id : uid();
    let full = '';

    if (isContinuation) {
      msgEl = continuation.existingMsgEl;
      bubble = continuation.existingBubble;
      bubbleText = bubble.querySelector('.bubble-text');
      timeEl = msgEl.querySelector('.message-time');
      avatarMascot = msgEl.querySelector('.message-avatar .mascot');
      bubble.querySelector('[data-continue]')?.remove();
      full = String(continuation.messageObj.content || '');
    } else {
      msgEl = document.createElement('div');
      msgEl.className = 'message ai';
      msgEl.dataset.msgId = aiMsgId; msgEl.dataset.role = 'ai';
      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      const initialMood = 'thinking';
      avatar.innerHTML = `<div class="mascot mascot-sm m-${initialMood}" data-mood="${initialMood}">${blobSvg()}</div>`;
      avatarMascot = avatar.querySelector('.mascot');
      msgEl.appendChild(avatar);
      const body = document.createElement('div');
      body.className = 'message-body';
      thinkPanel = createThinkPanel(!!__prefs.deepThink);
      body.appendChild(thinkPanel.el);
      timeEl = document.createElement('div'); timeEl.className = 'message-time';
      body.appendChild(timeEl);
      msgEl.appendChild(body);
      container?.appendChild(msgEl);
      bubble = null; bubbleText = null;
      scrollToBottom(true);
    }

    const visionFiles = files.filter((f) => f.type === 'image' && f.dataUrl);
    const contentParts = [];
    if (text) contentParts.push({ type: 'text', text });
    for (const f of visionFiles) contentParts.push({ type: 'image_url', image_url: { url: f.pngDataUrl || f.dataUrl, detail: 'auto' } });
    const hasAttachedImage = visionFiles.length > 0;
    const editIntent = hasAttachedImage ? detectImageEditIntent(text, true) : null;
    const sourceImage = editIntent ? (visionFiles[0].pngDataUrl || visionFiles[0].dataUrl) : null;

    activeStreamController = new AbortController();
    let generatedImage = null, gotToken = false;
    let streamComplete = false;
    let renderTimer = null;
    let rawAll = '';          // full text including <thinking>…</thinking>
    let answerText = '';
    let thinkingText = '';
    let thinkingClosed = false;

    const renderStreamText = () => {
      renderTimer = null;
      if (!bubbleText) return;
      const chat = $('#chatMessages');
      const wasAtBottom = chat && (chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120);
      bubbleText.innerHTML = renderMarkdown(answerText);
      wireCodeButtons(bubbleText);
      if (wasAtBottom) scrollToBottom();
    };
    const scheduleRender = () => {
      const now = performance.now();
      if (renderTimer) return;
      renderTimer = setTimeout(renderStreamText, Math.max(60, 140 - (now - streamRenderAt)));
      streamRenderAt = now;
    };
    const streamTimeout = setTimeout(() => { try { activeStreamController?.abort(); } catch {} }, STREAM_TIMEOUT_MS);

    try {
      const reqBody = {
        message: text,
        history,
        model,
        stream: true,
        search: !!forceSearch,
        deep_think: !!__prefs.deepThink,
        files: files.map((f) => ({
          name: f.name, size: f.size, type: f.type, mime: f.mime,
          width: f.width, height: f.height,
          dataUrl: f.dataUrl,
          base64: f.base64 || null,
          svgText: f.svgText || null,
          vision: !!f.vision,
          content: f.type === 'text' ? f.content : undefined,
        })),
        content_parts: contentParts.length ? contentParts : null,
        guest_id: getGuestId(),
        language: __prefs.responseLanguage || 'auto',
        edit_image: !!editIntent,
        source_image: sourceImage,
        continuation: !!isContinuation,
      };
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
        throw new Error(detail);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const bodyEl = msgEl.querySelector('.message-body');
      const ensureBubble = () => {
        if (!bubble) {
          bubble = document.createElement('div');
          bubble.className = 'bubble';
          bodyEl.insertBefore(bubble, timeEl);
        }
      };
      let signinTriggered = false;

      /* Recompute thinking/answer split from rawAll. */
      const updateSplit = () => {
        const s = rawAll;
        const openIdx = s.indexOf('<thinking>');
        const closeIdx = s.indexOf('</thinking>');
        if (openIdx >= 0 && closeIdx > openIdx) {
          thinkingText = s.slice(openIdx + '<thinking>'.length, closeIdx).trim();
          answerText = s.slice(closeIdx + '</thinking>'.length).replace(/^\s+/, '');
          thinkingClosed = true;
        } else if (openIdx >= 0) {
          thinkingText = s.slice(openIdx + '<thinking>'.length);
          answerText = '';
          thinkingClosed = false;
        } else {
          thinkingText = '';
          answerText = s;
          thinkingClosed = true;
        }
      };

      let lastThinkRender = 0;
      const maybeRenderThink = () => {
        if (!thinkPanel || !thinkPanel.el.isConnected) return;
        const now = performance.now();
        if (now - lastThinkRender < 90) return;
        lastThinkRender = now;
        thinkPanel.replaceText(thinkingText);
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const pl = line.slice(5).trim(); if (!pl) continue;
          if (pl === '[DONE]') { streamComplete = true; continue; }
          let o; try { o = JSON.parse(pl); } catch { continue; }

          if (o.signin_required && !signinTriggered) {
            signinTriggered = true;
            requireSignIn(o.message || 'Sign in to continue.');
            try { await reader.cancel(); } catch {}
            break;
          }

          if (o.img) {
            generatedImage = o.img;
            if (avatarMascot) setMascotMood('celebrate', avatarMascot.parentElement.parentElement);
            ensureBubble();
            bubble.innerHTML = `<div class="gen-image"><img src="${o.img}" draggable="false" alt=""></div><div class="bubble-text"></div>`;
            bubbleText = bubble.querySelector('.bubble-text');
            const img = bubble.querySelector('img'); if (img) img.onclick = () => openImageViewer(o.img);
            if (thinkPanel) thinkPanel.replaceText('Generating image…');
            scrollToBottom();
            continue;
          }

          if (o.d) {
            rawAll += o.d;
            updateSplit();
            // Update thinking panel while inside thinking
            if (!thinkingClosed) maybeRenderThink();
            // Only create/update answer bubble when we have answer text
            if (answerText.length > 0) {
              if (!gotToken) {
                gotToken = true;
                if (avatarMascot) setMascotMood('coding', avatarMascot.parentElement.parentElement);
                ensureBubble();
                bubble.innerHTML = '<div class="bubble-text"></div>';
                bubbleText = bubble.querySelector('.bubble-text');
              }
              scheduleRender();
            }
          }
          if (o.error) throw new Error(o.error.message || 'Stream error');
        }
        if (signinTriggered) break;
      }
      clearTimeout(streamTimeout);
      if (signinTriggered) { try { reader.cancel(); } catch {} }

      // Final thinking panel state
      if (thinkPanel) {
        updateSplit();
        if (thinkPanel.el.isConnected) {
          thinkPanel.replaceText(thinkingText || '');
          if (/<thinking>/.test(rawAll)) thinkPanel.finalize();
          else thinkPanel.el.style.display = 'none';
        }
      }
      full = answerText;

      if (avatarMascot) setMascotMood('happy', avatarMascot.parentElement.parentElement);
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      if (bubbleText) { bubbleText.innerHTML = renderMarkdown(full); wireCodeButtons(bubbleText); }
      wireMessageActions(msgEl);

      // Watermark generated image
      let imageKey = null;
      if (generatedImage) {
        const wm = await watermarkedDataUrl(generatedImage);
        generatedImage = wm;
        const imgEl = msgEl.querySelector('.gen-image img');
        if (imgEl) { imgEl.src = wm; imgEl.onclick = () => openImageViewer(wm); }
        imageKey = 'img:' + aiMsgId;
        await idb.set(imageKey, wm).catch(() => { imageKey = null; });
      }

      let savedMsg;
      if (convo) {
        if (isContinuation) {
          savedMsg = convo.messages.find((m) => m.id === aiMsgId) || continuation.messageObj;
          savedMsg.content = full;
          savedMsg.thinking = thinkingText;
          savedMsg.ts = Date.now();
          if (imageKey) savedMsg.imageKey = imageKey;
        } else {
          savedMsg = { id: aiMsgId, role: 'assistant', content: full, thinking: thinkingText, ts: Date.now(), imageKey };
          convo.messages.push(savedMsg);
        }
      }
      saveChats(); updateTokenUsage();
      timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (savedMsg && shouldShowContinue(full, streamComplete)) {
        ensureBubble();
        attachContinueButton(msgEl, bubble, savedMsg);
      }
    } catch (e) {
      clearTimeout(streamTimeout);
      const aborted = e.name === 'AbortError';
      const msg = aborted ? 'Stopped.' : (e.message || 'Something went wrong.');
      if (thinkPanel && thinkPanel.el.isConnected) thinkPanel.fail(msg);
      if (avatarMascot) setMascotMood('error', avatarMascot.parentElement.parentElement);
      const bodyEl = msgEl.querySelector('.message-body');
      if (!bubble) { bubble = document.createElement('div'); bubble.className = 'bubble'; bodyEl.insertBefore(bubble, timeEl); }
      if (full) {
        if (!bubbleText) { bubbleText = document.createElement('div'); bubbleText.className = 'bubble-text'; bubble.prepend(bubbleText); }
        bubbleText.innerHTML = renderMarkdown(full); wireCodeButtons(bubbleText);
        let savedMsg = convo?.messages.find((m) => m.id === aiMsgId);
        if (isContinuation && continuation.messageObj) savedMsg = continuation.messageObj;
        if (!savedMsg && convo) { savedMsg = { id: aiMsgId, role: 'assistant', content: full, ts: Date.now() }; convo.messages.push(savedMsg); }
        if (savedMsg) { savedMsg.content = full; saveChats(); attachContinueButton(msgEl, bubble, savedMsg); }
      } else {
        bubble.textContent = aborted ? '(stopped)' : 'Error: ' + msg;
      }
      toast(msg, 5000, 'err'); updateTokenUsage();
    } finally {
      clearTimeout(streamTimeout);
      if (thinkPanel) thinkPanel.destroy();
      isReplying = false;
      activeStreamController = null;
      if (stopBtn) stopBtn.style.display = 'none';
      updateSendButtonState(); updateTokenUsage();
    }
  }
  function stopStreaming() {
    if (activeStreamController) { try { activeStreamController.abort(); } catch {} activeStreamController = null; }
    isReplying = false;
    const s = $('#stopBtn'); if (s) s.style.display = 'none';
    updateSendButtonState();
  }

  function toast(msg, ms, kind) {
    const el = document.createElement('div');
    el.className = 'mirox-toast' + (kind ? ' ' + kind : '');
    el.textContent = typeof msg === 'string' ? msg : '';
    document.body.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, ms || 2200);
  }

  /* ---------- Voice ---------- */
  function setupVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = document.getElementById('voiceBtn');
    if (!SR || !btn) { if (btn) { btn.disabled = true; btn.title = 'Voice input is not supported'; btn.style.opacity = '0.4'; } return; }
    const recog = new SR();
    recog.continuous = false; recog.interimResults = true; recog.lang = (navigator.language || 'en-US');
    recog.onstart = () => { __voiceListening = true; btn.classList.add('listening'); btn.innerHTML = '<i class="ri-mic-fill"></i>'; };
    recog.onend = () => { __voiceListening = false; btn.classList.remove('listening'); btn.innerHTML = '<i class="ri-mic-line"></i>'; };
    recog.onerror = (e) => { __voiceListening = false; btn.classList.remove('listening'); btn.innerHTML = '<i class="ri-mic-line"></i>'; if (e.error === 'not-allowed') toast('Microphone permission denied.', 3000, 'err'); else if (e.error !== 'no-speech') toast('Voice error: ' + e.error, 3000, 'err'); };
    recog.onresult = (event) => {
      const inp = document.getElementById('messageInput'); if (!inp) return;
      let interim = '', final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) { const r = event.results[i]; if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript; }
      const base = inp.dataset.voiceBase || inp.value || '';
      if (final) { inp.value = (inp.dataset.voiceBase || '').trim() ? (inp.dataset.voiceBase + ' ' + final).trim() : final.trim(); inp.dataset.voiceBase = inp.value; }
      else inp.value = base ? (base + ' ' + interim).trim() : interim;
      inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 180) + 'px';
      updateSendButtonState();
    };
    __voiceRecognition = recog;
    btn.addEventListener('click', () => {
      const inp = document.getElementById('messageInput'); if (!inp) return;
      if (__voiceListening) { try { recog.stop(); } catch {} return; }
      inp.dataset.voiceBase = inp.value || '';
      try { recog.start(); } catch (e) { toast('Could not start voice: ' + e.message, 3000, 'err'); }
    });
  }

  /* ---------- Attachments ---------- */
  function imageToBase64DataURL(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const raw = reader.result;
        const img = new Image();
        img.onload = () => {
          let w = img.naturalWidth, h = img.naturalHeight;
          if (w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM) { const r = Math.min(MAX_IMAGE_DIM / w, MAX_IMAGE_DIM / h); w = Math.round(w * r); h = Math.round(h * r); }
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          let out;
          try { const m = (file.type || 'image/jpeg').toLowerCase(); out = (m === 'image/png' || m === 'image/webp') ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.88); } catch { out = raw; }
          const b64 = String(out).split(',')[1] || '';
          const mime = (String(out).split(';')[0].split(':')[1]) || file.type || 'image/jpeg';
          resolve({ type: 'image', name: file.name, size: file.size, mime, dataUrl: out, base64: b64, width: w, height: h, vision: true });
        };
        img.onerror = () => resolve(null);
        img.src = raw;
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }
  function svgToVisionData(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const svgText = String(reader.result);
        let base64 = ''; try { base64 = btoa(unescape(encodeURIComponent(svgText))); } catch {}
        const dataUrl = 'data:image/svg+xml;base64,' + base64;
        const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
        const objUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          let w = img.naturalWidth || 512, h = img.naturalHeight || 512;
          if (w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM) { const r = Math.min(MAX_IMAGE_DIM / w, MAX_IMAGE_DIM / h); w = Math.round(w * r); h = Math.round(h * r); }
          let png = null;
          try { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h); png = c.toDataURL('image/png'); } catch {}
          URL.revokeObjectURL(objUrl);
          resolve({ type: 'image', name: file.name, size: file.size, mime: 'image/svg+xml', dataUrl, base64, svgText, pngDataUrl: png, pngBase64: png ? png.split(',')[1] : '', width: w, height: h, vision: true, isSvg: true });
        };
        img.onerror = () => { URL.revokeObjectURL(objUrl); resolve({ type: 'image', name: file.name, size: file.size, mime: 'image/svg+xml', dataUrl, base64, svgText, vision: true, isSvg: true }); };
        img.src = objUrl;
      };
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });
  }
  function readTextFile(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => { const text = String(reader.result || '').slice(0, MAX_TEXT_FILE_BYTES); resolve({ type: 'text', name: file.name, size: file.size, mime: file.type || 'text/plain', content: text }); };
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });
  }
  function hasAttachment(name, size) { return pendingFiles.some((f) => f.name === name && f.size === size); }
  function handleFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const arr = []; for (const f of Array.from(fileList)) { if (hasAttachment(f.name, f.size)) continue; arr.push(f); }
    if (!arr.length) return;
    let done = 0; const newFiles = [];
    const finish = () => { newFiles.sort((a, b) => (a.order || 0) - (b.order || 0)); for (const nf of newFiles) if (!hasAttachment(nf.name, nf.size)) pendingFiles.push(nf); updatePreview(); updateSendButtonState(); };
    arr.forEach((f, idx) => {
      const isSvg = f.type === 'image/svg+xml' || /\.svg$/i.test(f.name);
      const isImg = !isSvg && ((f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name));
      const isTxt = !isSvg && !isImg && (isTextFile(f) || (f.type || '').startsWith('text/') || !f.type);
      const one = () => { done++; if (done === arr.length) finish(); };
      if (isSvg) svgToVisionData(f).then((d) => { if (d) newFiles.push({ ...d, order: idx }); one(); }).catch(one);
      else if (isImg) imageToBase64DataURL(f).then((d) => { if (d) newFiles.push({ ...d, order: idx }); one(); }).catch(one);
      else if (isTxt) readTextFile(f).then((d) => { if (d) newFiles.push({ ...d, order: idx }); one(); }).catch(one);
      else one();
    });
  }
  function updatePreview() {
    const p = $('#attachmentPreview'), list = $('#attachmentList');
    if (!p || !list) return;
    if (!pendingFiles.length) { p.style.display = 'none'; list.innerHTML = ''; return; }
    p.style.display = 'flex';
    list.innerHTML = pendingFiles.map((f) => renderAttachmentChip(f, false)).join('');
    list.querySelectorAll('[data-preview-file]').forEach((chip) => {
      chip.onclick = (e) => {
        e.stopPropagation();
        const idx = parseInt(chip.dataset.previewFile, 10);
        const file = pendingFiles[idx];
        if (file) openFilePreview(file);
      };
    });
  }
  function addTextAttachment(text, name) {
    const body = String(text).slice(0, 80000);
    const fname = name || ('pasted-' + new Date().toISOString().slice(11, 19).replace(/:/g, '-') + '.txt');
    if (pendingFiles.some((f) => f.type === 'text' && f.content === body)) return;
    pendingFiles.push({ name: fname, size: text.length, type: 'text', mime: 'text/plain', content: body });
    updatePreview(); updateSendButtonState();
  }

  /* ---------- File preview ---------- */
  function openFilePreview(file) {
    if (!file) return;
    __previewFileRef = file;
    const modal = $('#filePreviewModal'), icon = $('#filePreviewIcon'), name = $('#filePreviewName'), info = $('#filePreviewInfo'), content = $('#filePreviewContent');
    if (!modal) return;
    const meta = getFileMeta(file.name);
    if (icon) icon.innerHTML = `<i class="${meta.icon}"></i>`;
    if (name) name.textContent = file.name || 'file';
    const lines = file.content ? countLines(file.content) : 0;
    const parts = [];
    if (file.size) parts.push(fmtSize(file.size));
    if (lines > 1) parts.push(lines + ' lines');
    if (file.mime) parts.push(file.mime);
    if (info) info.textContent = parts.join(' · ') || '—';
    if (content) content.textContent = file.content || '(no content)';
    modal.classList.add('open');
  }
  function closeFilePreview() { $('#filePreviewModal')?.classList.remove('open'); __previewFileRef = null; }

  /* ---------- Models ---------- */
  function getModelsList() { return __config?.models?.length ? __config.models : FALLBACK_MODELS; }
  function canUseModel(tier) {
    if (tier === 'free') return true;
    if (__tier === 'ultimate') return true;
    if (__tier === 'pro' && tier === 'pro') return true;
    return false;
  }
  function tierLabel(tier) { if (tier === 'ultimate') return 'ULT'; if (tier === 'pro') return 'PRO'; return 'FREE'; }
  function tierFullLabel(tier) { if (tier === 'ultimate') return 'Ultimate'; if (tier === 'pro') return 'Pro'; return 'Free'; }
  function renderModelPicker() {
    const menu = $('#modelPickerMenu'); if (!menu) return;
    const models = getModelsList(); const cur = __model || models[0].id;
    let html = '';
    html += models.map((m) => {
      const usable = canUseModel(m.tier); const isActive = m.id === cur;
      const lockIcon = usable ? '' : '<i class="ri-lock-2-line model-option-lock"></i>';
      const icon = m.icon || 'ri-sparkling-2-line';
      return `<div class="model-option${isActive ? ' active' : ''}${usable ? '' : ' locked'}" data-model-id="${m.id}" data-usable="${usable}" data-tier="${m.tier}"><span class="model-option-icon"><i class="${icon}"></i></span><span class="model-option-body"><span class="model-option-top"><span class="model-option-name">${escapeHtml(m.label)}</span><span class="model-tier-badge tier-${m.tier}">${tierLabel(m.tier)}</span>${lockIcon}</span><span class="model-option-tagline">${escapeHtml(m.tagline || '')}</span></span></div>`;
    }).join('');
    menu.innerHTML = html;
    menu.querySelectorAll('.model-option').forEach((opt) => {
      opt.onclick = (e) => {
        e.stopPropagation();
        if (opt.dataset.usable === 'false') {
          if (!__user) { closeModelPicker(); requireSignIn('Sign in to unlock this model.'); }
          else { toast('Upgrade your plan to use this model.'); closeModelPicker(); }
          return;
        }
        selectModel(opt.dataset.modelId);
      };
    });
    const c = models.find((m) => m.id === cur);
    if (c) { const lbl = $('#currentModelLabel'); if (lbl) lbl.textContent = c.label; }
  }
  function selectModel(id) { const m = getModelsList().find((x) => x.id === id); if (!m || !canUseModel(m.tier)) return; __model = id; const lbl = $('#currentModelLabel'); if (lbl) lbl.textContent = m.label; renderModelPicker(); closeModelPicker(); }
  function openModelPicker() { $('#modelPicker')?.classList.add('open'); $('#modelPickerMenu')?.classList.add('open'); renderModelPicker(); }
  function closeModelPicker() { $('#modelPicker')?.classList.remove('open'); $('#modelPickerMenu')?.classList.remove('open'); }

  /* ---------- Account UI ---------- */
  function updateAccountUI() {
    const signedIn = !!__user;
    const chip = document.getElementById('userChip');
    const avatar = document.getElementById('userAvatar');
    const label = document.getElementById('accountLabel');
    const sub = document.getElementById('accountSub');
    const tierBadge = document.getElementById('accountTierBadge');
    const sLabel = document.getElementById('settingsAccountLabel');
    const sSub = document.getElementById('settingsAccountSub');
    const signInBtn = document.getElementById('signInFromSettingsBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    if (signedIn) {
      const name = __user.name || __user.email || 'User';
      const email = __user.email || '';
      const initial = (name.trim().charAt(0) || '?').toUpperCase();
      if (label) label.textContent = name;
      if (sub) sub.textContent = email || 'Signed in';
      if (sLabel) sLabel.textContent = name;
      if (sSub) sSub.textContent = email || 'Signed in';
      if (avatar) { avatar.innerHTML = `<span>${escapeHtml(initial)}</span>`; avatar.style.fontSize = '15px'; avatar.style.fontWeight = '600'; }
      if (tierBadge) { const t = (__user.tier || 'free'); tierBadge.textContent = tierLabel(t); tierBadge.className = 'user-tier-badge tier-' + t; tierBadge.style.display = ''; }
      if (chip) chip.classList.add('signed-in');
      if (signInBtn) signInBtn.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = '';
    } else {
      if (label) label.textContent = 'Guest mode';
      if (sub) sub.textContent = 'Sign in to save chats';
      if (sLabel) sLabel.textContent = 'Guest mode';
      if (sSub) sSub.textContent = 'Chats saved locally in this browser';
      if (avatar) { avatar.innerHTML = '<i class="ri-user-line"></i>'; avatar.style.fontSize = ''; avatar.style.fontWeight = ''; }
      if (tierBadge) tierBadge.style.display = 'none';
      if (chip) chip.classList.remove('signed-in');
      if (signInBtn) signInBtn.style.display = '';
      if (logoutBtn) logoutBtn.style.display = 'none';
    }
  }

  /* ---------- Usage/config ---------- */
  async function refreshUsage() {
    const local = getLocalUser();
    const res = await jsonOr('/api/me', {}, null, 7000);
    let user = null;
    if (res && res.user) user = { ...res.user, local: false };
    else if (local) user = { name: local.name, email: local.email, tier: 'free', local: true };
    __user = user;
    __tier = user ? (user.tier || 'free') : 'free';
    updateAccountUI();
    renderModelPicker();
    updateTokenUsage();
  }
  async function loadConfig() {
    const data = await jsonOr('/api/config', {}, null, 7000);
    if (data && Array.isArray(data.models) && data.models.length) __config = data;
    if (!__config) __config = { models: FALLBACK_MODELS };
    __model = getModelsList()[0].id; renderModelPicker();
  }

  /* ---------- Login ---------- */
  function setLoginError(msg, kind) {
    const el = $('#loginError');
    if (!el) return;
    if (!msg) { el.style.display = 'none'; el.textContent = ''; el.classList.remove('ok'); return; }
    el.style.display = 'block'; el.textContent = msg; el.classList.toggle('ok', kind === 'ok');
  }
  async function doLogin(e) {
    if (e) e.preventDefault();
    setLoginError('');
    const name = ($('#loginName')?.value || '').trim();
    const email = ($('#loginEmail')?.value || '').trim().toLowerCase();
    const btn = $('#loginSubmitBtn');
    if (!name) { setLoginError('Please enter your name.'); $('#loginName')?.focus(); return; }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setLoginError('Please enter a valid email address.'); $('#loginEmail')?.focus(); return; }
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ri-loader-4-line spin"></i> Signing in…'; }
    setLocalUser({ name, email, signedIn: true, ts: Date.now() });
    __user = { name, email, tier: 'free', local: true };
    __tier = 'free';
    updateAccountUI();
    try { await netFetch('/api/auth/simple-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email }) }, 10000); } catch {}
    setLoginError('Signed in!', 'ok');
    if (btn) btn.innerHTML = '<i class="ri-check-line"></i> Welcome';
    setTimeout(async () => {
      closeModal('loginModal');
      await refreshUsage();
      toast('Welcome, ' + name + '!', 2400, 'ok');
      setLoginError('');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span>Continue</span><i class="ri-arrow-right-line"></i>'; }
    }, 500);
  }
  async function doLogout() {
    try { await jsonOr('/api/logout', { method: 'POST' }, null, 4000); } catch {}
    setToken(''); setLocalUser(null);
    __user = null; __tier = 'free';
    updateAccountUI();
    closeModal('settingsModal');
    toast('Signed out', 1800, 'ok');
    refreshUsage().catch(() => {});
  }
  async function loadPlans() {
    const grid = $('#plansGrid'); if (!grid) return;
    grid.innerHTML = '<div class="studio-empty">Loading…</div>';
    const res = await jsonOr('/api/subscription/plans', {}, null);
    if (!res || !Array.isArray(res.plans)) { grid.innerHTML = '<div class="studio-empty">Could not load plans.</div>'; return; }
    grid.innerHTML = res.plans.map((p) => {
      const price = p.id === 'free' ? '<div class="plan-price">Free</div>' : `<div class="plan-price">$${Number(p.price_usd).toFixed(2)}</div>`;
      const t = p.id;
      return `<div class="plan-card${p.id === __tier ? ' current' : ''}"><span class="plan-card-badge tier-${t}">${tierFullLabel(t)}</span><div class="plan-name">${escapeHtml(p.label)}</div>${price}<ul class="plan-perks">${(p.perks || []).map((x) => `<li>✓ ${escapeHtml(x)}</li>`).join('')}</ul></div>`;
    }).join('');
  }
  async function genImage() {
    if (!__user) { closeModal('imageModal'); requireSignIn('Sign in to generate images with Mirox.'); return; }
    if (__prefs.deepThink) { toast('Turn off DeepThink to generate images.', 3500, 'err'); return; }
    const prompt = $('#imagePrompt')?.value.trim(); if (!prompt) return;
    const btn = $('#generateImageBtn'), result = $('#imageResult');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ri-loader-4-line spin"></i> …'; }
    if (result) result.innerHTML = '<div class="studio-empty"><i class="ri-loader-4-line spin"></i> …</div>';
    try {
      const res = await netFetch('/v1/images/generations', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ prompt, guest_id: getGuestId() }) }, 90000);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok && data.image) {
        const wm = await watermarkedDataUrl(data.image);
        if (result) { result.innerHTML = `<img src="${wm}" alt="">`; result.querySelector('img').onclick = () => openImageViewer(wm); }
      } else if (res.status === 401) {
        closeModal('imageModal'); requireSignIn('Sign in to generate images with Mirox.');
      } else { if (result) result.innerHTML = `<div class="studio-error">Failed</div>`; }
    } catch { if (result) result.innerHTML = `<div class="studio-error">Error</div>`; }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ri-image-add-line"></i> Generate'; } }
  }

  /* ---------- Support ---------- */
  function supportSetHead() {
    const el = $('#supportHeadSub'); if (!el) return;
    if (!__user) { el.textContent = 'Sign in to chat with our team'; return; }
    if (!__supportConv) { el.textContent = 'Live chat with our team'; return; }
    if (__supportConv.status === 'closed') { el.textContent = 'Conversation closed'; return; }
    el.textContent = 'Live · usually replies in a few hours';
  }
  function supportUpdateComposeState() {
    const input = $('#supportInput'), send = $('#supportSendBtn'), catRow = $('#supportCatRow'), resolveBtn = $('#supportResolveBtn'), hint = $('#supportInputHint');
    const conv = __supportConv;
    const closed = conv && conv.status === 'closed';
    const canChat = !!__user;
    if (input) { input.disabled = !canChat || closed; input.placeholder = !canChat ? 'Sign in to send a message…' : (closed ? 'This conversation is closed.' : 'Type your message…'); }
    if (send) { const enabled = canChat && !closed && (input?.value || '').trim().length > 0; send.classList.toggle('is-disabled', !enabled); send.setAttribute('aria-disabled', String(!enabled)); }
    if (catRow) catRow.style.display = (conv ? 'none' : (canChat ? '' : 'none'));
    if (resolveBtn) resolveBtn.style.display = (conv && conv.status === 'open') ? '' : 'none';
    if (hint) hint.textContent = !canChat ? 'Sign in to chat with support' : (closed ? 'Conversation closed.' : 'Enter to send · Shift+Enter for a new line');
  }
  function supportRenderMessages() {
    const box = $('#supportChatMessages'); if (!box) return;
    const conv = __supportConv;
    if (!conv || !conv.messages || !conv.messages.length) {
      box.innerHTML = `<div class="support-chat-empty"><div class="support-chat-empty-icon"><i class="ri-chat-smile-2-line"></i></div><div class="support-chat-empty-title">${__user ? 'How can we help?' : 'Sign in to chat'}</div><div class="support-chat-empty-sub">${__user ? 'Send us a message and a member of our team will reply right here.' : 'Sign in with your name and email so we can help you.'}</div></div>`;
      return;
    }
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
    box.innerHTML = conv.messages.map((m) => {
      const role = m.role === 'agent' ? 'agent' : (m.role === 'system' ? 'system' : 'user');
      const author = role === 'agent' ? 'Support' : (role === 'system' ? '' : 'You');
      const time = m.ts ? new Date(m.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      return `<div class="support-msg ${role}">${role === 'agent' ? `<div class="support-msg-author">${escapeHtml(author)}</div>` : ''}<div class="support-bubble">${escapeHtml(m.content || '').replace(/\n/g, '<br>')}</div>${role !== 'system' ? `<div class="support-msg-meta">${time}</div>` : ''}</div>`;
    }).join('');
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }
  async function supportLoad() {
    if (!__user) { __supportConv = null; supportSetHead(); supportUpdateComposeState(); supportRenderMessages(); return; }
    const data = await jsonOr('/api/support/conversation', {}, null, 10000);
    if (data && data.ok) __supportConv = data.conversation;
    supportSetHead(); supportUpdateComposeState(); supportRenderMessages();
  }
  async function supportSend() {
    if (!__user) { toast('Sign in to chat with support'); return; }
    if (__supportSending) return;
    const input = $('#supportInput');
    const content = (input?.value || '').trim();
    if (!content) return;
    const category = ($('#supportCategory')?.value || 'other');
    __supportSending = true;
    const send = $('#supportSendBtn'); if (send) send.classList.add('is-disabled');
    const r = await netFetch('/api/support/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, category }) }, 15000).catch(() => null);
    __supportSending = false;
    if (!r || !r.ok) { const d = r ? await r.json().catch(() => ({})) : null; toast((d && d.error) || 'Could not send', 3000, 'err'); supportUpdateComposeState(); return; }
    const d = await r.json().catch(() => ({}));
    if (d && d.ok) { if (input) { input.value = ''; input.style.height = 'auto'; } __supportConv = d.conversation; supportSetHead(); supportUpdateComposeState(); supportRenderMessages(); }
  }
  async function supportResolve() {
    if (!__user) return;
    if (!confirm('Mark this conversation as resolved?')) return;
    await jsonOr('/api/support/close', { method: 'POST' }, null, 10000);
    await supportLoad();
  }
  function supportStartPolling() { if (__supportPollTimer) return; __supportPollTimer = setInterval(() => { if ($('#supportModal')?.classList.contains('open')) supportLoad(); }, 6000); }
  function supportStopPolling() { if (__supportPollTimer) { clearInterval(__supportPollTimer); __supportPollTimer = null; } }
  function openSupportModal() { openModal('supportModal'); supportLoad(); supportStartPolling(); }
  function closeSupportModal() { closeModal('supportModal'); supportStopPolling(); }

  /* ---------- Bridge (kept simple; unchanged behaviour) ---------- */
  function loadBridgeOpts() { const o = safeGet(BRIDGE_OPTS_KEY, {}); if (typeof o.autoRun === 'boolean') __bridgeAutoRun = o.autoRun; if (typeof o.showCode === 'boolean') __bridgeShowCode = o.showCode; }
  function saveBridgeOpts() { safeSet(BRIDGE_OPTS_KEY, { autoRun: __bridgeAutoRun, showCode: __bridgeShowCode }); }
  function renderBridgeStatus() {
    [['#bridgeStatus'], ['#bwStatusPill'], ['#bwStatusBox']].forEach(([sel]) => {
      const wrap = document.querySelector(sel); if (!wrap) return;
      const dot = wrap.querySelector('.bridge-status-dot'); const txt = wrap.querySelector('span');
      if (dot) { dot.classList.toggle('online', __bridge.connected); dot.classList.toggle('offline', !__bridge.connected); }
      if (txt) txt.textContent = __bridge.connected ? 'Connected' : 'Disconnected';
    });
    const c = $('#bwConnectBtn'), d = $('#bwDisconnectBtn');
    if (c) c.style.display = __bridge.connected ? 'none' : 'flex';
    if (d) d.style.display = __bridge.connected ? 'flex' : 'none';
    updateBridgeSendBtn(); renderToggles();
  }
  function renderToggles() { $('#bwToggleAutoRun')?.classList.toggle('active', __bridgeAutoRun); $('#bwToggleShowCode')?.classList.toggle('active', __bridgeShowCode); const sb = $('#bwStopBtn'); if (sb) sb.style.display = bridgeRunning ? 'inline-flex' : 'none'; }
  function renderSudoStatus() { const s = $('#bwSudoStatus'); if (!s) return; s.textContent = __sudoPassword ? 'Password set' : 'No password saved'; }
  async function testBridge(port) { for (const host of ['localhost', '127.0.0.1']) { try { const r = await netFetch(`http://${host}:${port}/ping`, { mode: 'cors' }, 4000); if (r.ok) { const d = await r.json(); if (d && d.ok) return { ok: true, base: `http://${host}:${port}` }; } } catch {} } return { ok: false }; }
  async function fetchEnv(base) { try { const r = await netFetch(`${base}/env`, { mode: 'cors' }, 5000); if (!r.ok) return null; const d = await r.json(); return d && d.ok ? d : null; } catch { return null; } }
  async function startBridge() {
    if (!IS_PC) { toast('Bridge is only available on desktop computers.', 2600, 'err'); return; }
    const name = ($('#bwNameInput')?.value || __bridge.name).trim() || 'My Laptop';
    const port = parseInt($('#bwPortInput')?.value || __bridge.port, 10) || 8765;
    __bridge.name = name; __bridge.port = port;
    setBwHint('Connecting…');
    const res = await testBridge(port);
    if (res.ok) { __bridge.connected = true; __bridge.baseUrl = res.base; __bridge.env = await fetchEnv(res.base); renderBridgeStatus(); $('#bridgeEmpty')?.remove(); setBwHint(`Connected · Home: ${__bridge.env?.home || '?'}`, 'ok'); addBridgeSystemMsg(`Connected. Home: ${__bridge.env?.home || '?'}`); }
    else { __bridge.connected = false; setBwHint(`Could not reach port ${port}.`, 'err'); renderBridgeStatus(); }
  }
  function stopBridge() { __bridge.connected = false; __bridge.baseUrl = null; __bridge.env = null; __sudoPassword = ''; renderBridgeStatus(); setBwHint(''); }
  async function bridgeCall(endpoint, payload) {
    if (!__bridge.connected || !__bridge.baseUrl) throw new Error('Bridge not connected');
    const r = await netFetch(__bridge.baseUrl + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}), credentials: 'omit' }, 130000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }
  function setBwHint(text, cls = '') { const el = $('#bwConnectHint'); if (!el) return; el.textContent = text; el.className = 'bw-hint' + (cls ? ' ' + cls : ''); }
  function updateBridgeSendBtn() { const btn = $('#bridgeSendBtn'), inp = $('#bridgeInput'); if (!btn || !inp) return; const enabled = __bridge.connected && !bridgeRunning && inp.value.trim().length > 0; btn.classList.toggle('is-disabled', !enabled); btn.setAttribute('aria-disabled', String(!enabled)); renderToggles(); }
  function openBridgeWorkspace() { if (!IS_PC) { toast('Bridge is only available on desktop computers.', 2600, 'err'); return; } $('#bridgeWorkspace')?.classList.add('open'); document.body.style.overflow = 'hidden'; if (!__bridge.connected) setTimeout(() => startBridge(), 50); }
  function closeBridgeWorkspace() { $('#bridgeWorkspace')?.classList.remove('open'); document.body.style.overflow = ''; }
  function clearBridgeChat() { const m = $('#bridgeMessages'); if (m) m.innerHTML = ''; bridgeConversation = []; bridgeProgress = 0; bridgeTurn = null; bridgeTaskComplete = true; bridgeWaitingForUser = false; __lastBuildFolder = null; updateBridgeProgress(0, 'Ready'); const w = $('#bwProgress'); if (w) w.style.display = 'none'; renderBuildStatus(); }
  function scrollBridgeBottom() { const c = $('#bridgeMessages'); if (c) c.scrollTop = c.scrollHeight; }
  function renderBuildStatus() { const s = $('#bwBuildStatus'); if (!s) return; s.textContent = __lastBuildFolder || 'No project yet'; }
  function addBridgeUserMsg(text) { const c = $('#bridgeMessages'); if (!c) return; $('#bridgeEmpty')?.remove(); const el = document.createElement('div'); el.className = 'bridge-msg user'; el.innerHTML = `<div class="bridge-bubble">${escapeHtml(text).replace(/\n/g, '<br>')}</div><div class="bridge-meta">You</div>`; c.appendChild(el); scrollBridgeBottom(); }
  function addBridgeAiMsg(text) { if (!text) return; const c = $('#bridgeMessages'); if (!c) return; $('#bridgeEmpty')?.remove(); const el = document.createElement('div'); el.className = 'bridge-msg ai'; el.innerHTML = `<div class="bridge-bubble">${escapeHtml(text).replace(/\n/g, '<br>')}</div><div class="bridge-meta">Mirox</div>`; c.appendChild(el); scrollBridgeBottom(); }
  function addBridgeSystemMsg(text) { const c = $('#bridgeMessages'); if (!c) return; $('#bridgeEmpty')?.remove(); const el = document.createElement('div'); el.className = 'bridge-msg system'; el.innerHTML = `<div class="bridge-bubble">${escapeHtml(text)}</div>`; c.appendChild(el); scrollBridgeBottom(); }
  function addBridgeSuccessMsg(text, extras) {
    const c = $('#bridgeMessages'); if (!c) return;
    const e = extras || {};
    let buttons = '';
    if (e.previewPath) buttons += `<button class="bridge-success-btn" data-preview="${escapeHtml(e.previewPath)}"><i class="ri-eye-line"></i> Preview</button>`;
    if (e.folder) buttons += `<button class="bridge-success-btn" data-copy-folder="${escapeHtml(e.folder)}"><i class="ri-folder-open-line"></i> Copy path</button>`;
    const el = document.createElement('div'); el.className = 'bridge-msg ai';
    el.innerHTML = `<div class="bridge-success"><div class="bridge-success-head"><i class="ri-checkbox-circle-fill"></i><span>${escapeHtml(text)}</span></div>${buttons ? `<div class="bridge-success-actions">${buttons}</div>` : ''}</div>`;
    el.querySelectorAll('[data-preview]').forEach((b) => { b.onclick = () => openPreview(b.dataset.preview); });
    el.querySelectorAll('[data-copy-folder]').forEach((b) => { b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copyFolder); toast('Copied'); } catch {} }; });
    c.appendChild(el); scrollBridgeBottom();
  }
  function addBridgeActionBubble(cmd) {
    const c = $('#bridgeMessages'); if (!c) return null;
    const data = getActionData(cmd);
    const el = document.createElement('div'); el.className = 'bridge-msg ai';
    el.innerHTML = `<div class="bridge-action"><div class="bridge-action-head"><div class="bridge-action-icon ${data.iconClass}"><i class="${data.icon}"></i></div><div class="bridge-action-label">${data.label}</div><span class="bridge-action-status working"><i class="ri-loader-4-line spin"></i> Working</span></div></div>`;
    c.appendChild(el); scrollBridgeBottom(); return el;
  }
  function updateBridgeActionBubble(el, cmd, result) {
    if (!el) return; const status = el.querySelector('.bridge-action-status'); if (!status) return;
    if (result && result.ok) { status.className = 'bridge-action-status ok'; status.innerHTML = '<i class="ri-check-line"></i> Done'; }
    else if (result && result.cancelled) { status.className = 'bridge-action-status err'; status.innerHTML = '<i class="ri-close-line"></i> Cancelled'; }
    else { status.className = 'bridge-action-status err'; status.innerHTML = '<i class="ri-close-line"></i> Failed'; }
    scrollBridgeBottom();
  }
  function getBaseName(p) { if (!p) return ''; const parts = String(p).split('/'); return parts[parts.length - 1] || p; }
  function getActionData(cmd) {
    const t2 = cmd.type; const base = getBaseName(cmd.path) || '';
    if (t2 === 'write') return { icon: 'ri-file-add-line', iconClass: 'write', label: `Writing <code>${escapeHtml(base)}</code>` };
    if (t2 === 'append') return { icon: 'ri-file-edit-line', iconClass: 'write', label: `Appending <code>${escapeHtml(base)}</code>` };
    if (t2 === 'exec') return { icon: 'ri-terminal-box-line', iconClass: 'exec', label: 'Running command' };
    if (t2 === 'sudo') return { icon: 'ri-shield-keyhole-line', iconClass: 'exec', label: 'sudo' };
    if (t2 === 'read') return { icon: 'ri-file-text-line', iconClass: 'read', label: `Reading <code>${escapeHtml(base)}</code>` };
    if (t2 === 'list') return { icon: 'ri-folder-line', iconClass: 'list', label: `Listing <code>${escapeHtml(base)}</code>` };
    if (t2 === 'delete') return { icon: 'ri-delete-bin-line', iconClass: 'exec', label: `Deleting <code>${escapeHtml(base)}</code>` };
    return { icon: 'ri-terminal-line', iconClass: '', label: 'Working' };
  }
  function setProgressText(text) { const el = $('#bwProgressText'); if (el && text) el.textContent = text; }
  function updateBridgeProgress(pct, text) { const np = Math.max(0, Math.min(100, Math.round(pct))); if (np > bridgeProgress) bridgeProgress = np; const bar = $('#bwProgress'), fill = $('#bwProgressFill'), pctEl = $('#bwProgressPct'); if (bar) bar.style.display = 'block'; if (fill) { fill.style.width = bridgeProgress + '%'; fill.classList.toggle('done', bridgeProgress >= 100); } if (pctEl) pctEl.textContent = bridgeProgress + '%'; if (text) setProgressText(text); }
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
      [/<bridge-move\s+from="([^"]+)"\s+to="([^"]+)"\s*\/>/g, 'move', (m) => ({ from: m[1], to: m[2] })],
      [/<bridge-copy\s+from="([^"]+)"\s+to="([^"]+)"\s*\/>/g, 'copy', (m) => ({ from: m[1], to: m[2] })],
      [/<bridge-sysinfo\s*\/>/g, 'sysinfo', () => ({})],
      [/<bridge-syscheck\s*\/>/g, 'syscheck', () => ({})],
      [/<bridge-processes\s*\/>/g, 'processes', () => ({})],
      [/<bridge-email\s+to="([^"]+)"\s+subject="([^"]*)">([\s\S]*?)<\/bridge-email>/g, 'email', (m) => ({ to: m[1], subject: m[2], body: m[3] })],
      [/<bridge-http\s+url="([^"]+)"(?:\s+method="([^"]*)")?(?:\s+body="([^"]*)")?\s*\/>/g, 'http', (m) => ({ url: m[1], method: m[2] || 'GET', body: m[3] || '' })],
      [/<bridge-clipboard\s+action="get"\s*\/>/g, 'clipboard-get', () => ({})],
      [/<bridge-clipboard\s+action="set">([\s\S]*?)<\/bridge-clipboard>/g, 'clipboard-set', (m) => ({ content: m[1] })],
      [/<bridge-screenshot(?:\s+path="([^"]+)")?\s*\/>/g, 'screenshot', (m) => ({ path: m[1] || '' })],
      [/<bridge-git\s+action="([^"]+)"(?:\s+cwd="([^"]*)")?(?:\s+message="([^"]*)")?\s*\/>/g, 'git', (m) => ({ action: m[1], cwd: m[2] || '', message: m[3] || '' })],
      [/<bridge-pkgs\s+type="([^"]+)"\s*\/>/g, 'pkgs', (m) => ({ type: m[1] })],
    ];
    for (const [re, type, fn] of rules) { re.lastIndex = 0; let m; while ((m = re.exec(text)) !== null) add(type, m, fn(m)); }
    cmds.sort((a, b) => a.index - b.index);
    return cmds;
  }
  function hasUnclosedWriteOrAppend(text) { const t2 = String(text || ''); return (t2.match(/<bridge-write\b/g) || []).length > (t2.match(/<\/bridge-write>/g) || []).length || (t2.match(/<bridge-append\b/g) || []).length > (t2.match(/<\/bridge-append>/g) || []).length; }
  function lastWriteOrAppendPath(text) { const matches = [...String(text || '').matchAll(/<bridge-(?:write|append)\s+path="([^"]+)"/g)]; return matches.length ? matches[matches.length - 1][1] : null; }
  function buildEnvBlockString() { const env = __bridge.env || {}; const home = env.home || '(unknown)'; return [`[Bridge environment]`, `home=${home}`, `cwd=${env.cwd || home}`, `platform=${env.platform || '?'}`].join('\n'); }
  function absBridgePath(p, home) { let s = String(p || '').trim().replace(/\\/g, '/'); if (!home) return s; if (s === '' || s === '~' || s === '.' || s === './') return home; if (s.startsWith('~/')) return home + s.slice(1); if (s.startsWith('./')) return home + '/' + s.slice(2); if (!s.startsWith('/')) return home + '/' + s; return s; }
  function showSudoModal(command) { return new Promise((resolve) => { __sudoResolver = resolve; const modal = $('#sudoModal'); if (!modal) { resolve(null); return; } const cmdText = $('#sudoCommandText'); if (cmdText) cmdText.textContent = command || ''; const pwd = $('#sudoPasswordInput'); if (pwd) { pwd.value = ''; pwd.type = 'password'; } modal.classList.add('open'); setTimeout(() => pwd?.focus(), 100); }); }
  function closeSudoModal() { $('#sudoModal')?.classList.remove('open'); }
  function submitSudo() { const pwd = $('#sudoPasswordInput')?.value || ''; const remember = !!$('#sudoRememberChk')?.checked; if (!pwd) return; __sudoPassword = pwd; __sudoRemember = remember; closeSudoModal(); renderSudoStatus(); if (__sudoResolver) { __sudoResolver({ password: pwd, remember }); __sudoResolver = null; } }
  function skipSudo() { closeSudoModal(); if (__sudoResolver) { __sudoResolver(null); __sudoResolver = null; } }
  function forgetSudo() { __sudoPassword = ''; __sudoRemember = false; renderSudoStatus(); toast('Sudo forgotten'); }
  async function askSudo(cmd) { if (__sudoPassword) return { password: __sudoPassword, remember: __sudoRemember, reused: true }; return await showSudoModal(cmd); }
  async function executeBridgeCommand(cmd) {
    const home = __bridge.env?.home || '';
    if (cmd.path) cmd.path = absBridgePath(cmd.path, home);
    if (cmd.from) cmd.from = absBridgePath(cmd.from, home);
    if (cmd.to) cmd.to = absBridgePath(cmd.to, home);
    const t2 = cmd.type;
    if (t2 === 'sudo') { const sudo = await askSudo(cmd.command); if (!sudo || !sudo.password) return { ok: false, cancelled: true }; try { return await bridgeCall('/sudo-exec', { command: cmd.command, password: sudo.password, timeout: 120 }); } catch (e) { return { ok: false, error: e.message }; } }
    if (t2 === 'exec') return bridgeCall('/exec', { command: cmd.command });
    if (t2 === 'write') return bridgeCall('/write', { path: cmd.path, content: cmd.content });
    if (t2 === 'append') return bridgeCall('/append', { path: cmd.path, content: cmd.content });
    if (t2 === 'delete') return bridgeCall('/delete', { path: cmd.path });
    if (t2 === 'read') return bridgeCall('/read', { path: cmd.path });
    if (t2 === 'list') return bridgeCall('/list', { path: cmd.path });
    if (t2 === 'move') return bridgeCall('/move', { from: cmd.from, to: cmd.to });
    if (t2 === 'copy') return bridgeCall('/copy', { from: cmd.from, to: cmd.to });
    return { ok: false, error: 'Unknown command type: ' + t2 };
  }
  function formatResultForAI(cmd, result) {
    if (!result || !result.ok) return `[${cmd.type}] ERROR: ${(result && result.error) || 'unknown'}`;
    const trunc = (s, n = 3000) => String(s || '').slice(0, n);
    switch (cmd.type) {
      case 'sudo': case 'exec': return `[exec] exit=${result.exit_code}\nSTDOUT:\n${trunc(result.stdout)}\nSTDERR:\n${trunc(result.stderr, 1500)}`;
      case 'write': return `[write] ok path=${result.path} bytes=${result.bytes}`;
      case 'append': return `[append] ok path=${result.path}`;
      case 'read': return `[read] path=${result.path}\n${trunc(result.content)}`;
      case 'list': return `[list] path=${result.path}\n` + (result.items || []).map((i) => (i.is_dir ? 'D ' : 'F ') + i.name).join('\n');
      default: return `[${cmd.type}] ok`;
    }
  }
  function newTurnState() { return { runs: 0, plannedFiles: new Set(), writtenFiles: new Set(), commandLog: new Map(), failedSignatures: new Set(), lastReplyFingerprint: '', lastReplyCount: 0 }; }
  function cmdSignature(cmd) { const t2 = cmd.type; if (t2 === 'exec' || t2 === 'sudo') return t2 + ':' + (cmd.command || '').trim(); if (t2 === 'write' || t2 === 'append') return t2 + ':' + cmd.path + ':' + (cmd.content || '').length; return t2 + ':' + (cmd.path || ''); }
  function shouldBlockSignature(sig) { if (!bridgeTurn) return false; if (bridgeTurn.failedSignatures.has(sig)) return true; return (bridgeTurn.commandLog.get(sig) || 0) >= MAX_DUP_COMMANDS; }
  function fingerprintReply(text) { return String(text || '').replace(/<bridge-[^>]+>[\s\S]*?<\/bridge-[^>]+>/g, '').replace(/<bridge-[^>]+\s+[^>]*\/>/g, '').replace(/\s+/g, ' ').trim().slice(0, 400); }
  async function fetchBridgeReply(history) {
    const envBlock = buildEnvBlockString();
    const lastMsg = history[history.length - 1];
    const r = await netFetch('/v1/chat/completions', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ message: `${envBlock}\n\n${lastMsg.content}`, history: history.slice(0, -1).map((h) => ({ role: h.role, content: h.content })), model: 'mirox-luna-1.2', stream: false, deep_think: !!__prefs.deepThink }) }, 120000);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
    return data.reply || '';
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  async function runBridgeTurn(userText, isResume = false) {
    if (!__bridge.connected || !IS_PC) return;
    if (bridgeRunning) return;
    bridgeRunning = true; bridgeAbort = false; updateBridgeSendBtn();
    if (!isResume) { bridgeTaskComplete = false; bridgeWaitingForUser = false; bridgeTurn = newTurnState(); bridgeProgress = 0; updateBridgeProgress(2, 'Starting…'); addBridgeUserMsg(userText); bridgeConversation.push({ role: 'user', content: `[System] Rules: use <bridge-write> for files, close tags. Reply DONE when finished.\n\n${userText}` }); }
    let iter = 0, autoContinues = 0;
    try {
      while (iter++ < MAX_BRIDGE_ITER) {
        if (bridgeAbort) { addBridgeSystemMsg('Stopped.'); break; }
        bridgeTurn.runs++;
        const lastUser = bridgeConversation.filter((h) => h.role === 'user').slice(-1)[0];
        const userLast = lastUser?.content || '';
        let reply = '';
        try { reply = await fetchBridgeReply(bridgeConversation); }
        catch (e) { addBridgeSystemMsg('AI error: ' + e.message); break; }
        if (!reply || !reply.trim()) { if (autoContinues < MAX_AUTO_CONTINUES && __bridgeAutoRun) { autoContinues++; await sleep(600); bridgeConversation.push({ role: 'user', content: '[System] Continue.' }); continue; } break; }
        const fp = fingerprintReply(reply);
        if (fp && fp === bridgeTurn.lastReplyFingerprint) { bridgeTurn.lastReplyCount++; if (bridgeTurn.lastReplyCount >= MAX_DUP_REPLIES) { addBridgeSystemMsg('Stopping — the AI repeated itself.'); bridgeTaskComplete = true; break; } }
        else { bridgeTurn.lastReplyFingerprint = fp; bridgeTurn.lastReplyCount = 1; }
        const cmdsInReply = extractBridgeCommands(reply);
        const saidDone = /\bDONE\b/i.test(reply);
        const truncatedWrite = hasUnclosedWriteOrAppend(reply);
        const lastPath = lastWriteOrAppendPath(reply);
        const narration = reply.replace(/<bridge-[^>]+>[\s\S]*?<\/bridge-[^>]+>/g, '').replace(/<bridge-[^>]+\s+[^>]*\/>/g, '').replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
        if (narration) addBridgeAiMsg(narration);
        bridgeConversation.push({ role: 'assistant', content: reply });
        if (cmdsInReply.length > 0) {
          const resultLines = [];
          for (const cmd of cmdsInReply) {
            if (bridgeAbort) break;
            const sig = cmdSignature(cmd);
            if (shouldBlockSignature(sig)) continue;
            bridgeTurn.commandLog.set(sig, (bridgeTurn.commandLog.get(sig) || 0) + 1);
            if (cmd.type === 'write' || cmd.type === 'append') bridgeTurn.plannedFiles.add(cmd.path);
            const bubble = addBridgeActionBubble(cmd);
            let result;
            try { result = await executeBridgeCommand(cmd); } catch (e) { result = { ok: false, error: e.message }; }
            updateBridgeActionBubble(bubble, cmd, result);
            if (result && result.ok && cmd.type === 'write') bridgeTurn.writtenFiles.add(cmd.path);
            else if (!result || !result.ok) bridgeTurn.failedSignatures.add(sig);
            resultLines.push(formatResultForAI(cmd, result));
          }
          const tp2 = bridgeTurn.plannedFiles.size, dc2 = bridgeTurn.writtenFiles.size;
          if (tp2 > 0) updateBridgeProgress(2 + Math.round((dc2 / tp2) * 93), `Files: ${dc2} / ${tp2}`);
          bridgeConversation.push({ role: 'user', content: ['[Results]', resultLines.join('\n\n'), 'If done, reply DONE. Otherwise continue.'].join('\n') });
          if (truncatedWrite && lastPath) bridgeConversation.push({ role: 'user', content: `[System] Continue with <bridge-append path="${lastPath}">.` });
          continue;
        }
        if (truncatedWrite) { if (__bridgeAutoRun && autoContinues < MAX_AUTO_CONTINUES) { autoContinues++; bridgeConversation.push({ role: 'user', content: `[System] Continue with <bridge-append path="${lastPath}">.` }); continue; } bridgeWaitingForUser = true; break; }
        const hasPlan = bridgeTurn.plannedFiles.size > 0;
        const allFilesWritten = hasPlan && bridgeTurn.writtenFiles.size >= bridgeTurn.plannedFiles.size;
        if (saidDone && (allFilesWritten || !hasPlan)) {
          updateBridgeProgress(100, 'Complete');
          const toVerify = [...bridgeTurn.writtenFiles];
          if (toVerify.length) {
            const rows = [];
            for (const p of toVerify) { let exists = false; try { const res = await bridgeCall('/read', { path: p }); if (res && res.ok) exists = true; } catch {} rows.push({ path: p, exists }); }
            const allOk = rows.every((r) => r.exists);
            const projRoot = toVerify[0]?.replace(/\/[^/]*$/, '') || __bridge.env?.home || '';
            __lastBuildFolder = projRoot;
            __lastPreviewFile = toVerify.find((p) => /index\.html?$/i.test(p)) || toVerify[0];
            addBridgeSuccessMsg(allOk ? `Project complete · ${rows.length} files` : `Finished · ${rows.filter((r) => r.exists).length}/${rows.length}`, { folder: projRoot, previewPath: __lastPreviewFile || '' });
            renderBuildStatus();
          } else addBridgeSuccessMsg('Task complete');
          bridgeTaskComplete = true; break;
        }
        if (!saidDone) { if (__bridgeAutoRun && autoContinues < MAX_AUTO_CONTINUES) { autoContinues++; await sleep(600); bridgeConversation.push({ role: 'user', content: '[System] Continue.' }); continue; } bridgeWaitingForUser = true; break; }
      }
    } catch (e) { addBridgeSystemMsg('Bridge error: ' + e.message); }
    finally { bridgeRunning = false; updateBridgeSendBtn(); setProgressText(bridgeTaskComplete ? 'Done' : 'Paused'); }
  }
  function handleBridgeSend() {
    if (!IS_PC) { toast('Bridge is only available on desktop computers.', 2600, 'err'); return; }
    const inp = $('#bridgeInput'); if (!inp) return;
    const text = inp.value.trim();
    if (!text || bridgeRunning || !__bridge.connected) return;
    if (bridgeWaitingForUser) { bridgeWaitingForUser = false; if (!bridgeTurn) bridgeTurn = newTurnState(); }
    else { bridgeConversation = []; bridgeTaskComplete = true; bridgeTurn = null; }
    inp.value = ''; inp.style.height = 'auto';
    updateBridgeSendBtn();
    runBridgeTurn(text, false);
  }

  function resolveRelativePath(baseFile, rel) {
    if (!rel) return '';
    if (/^([a-z]+:)?\/\//i.test(rel) || rel.startsWith('data:')) return rel;
    const baseDir = baseFile.replace(/\/[^/]*$/, '');
    if (rel.startsWith('/')) return baseDir + rel;
    const parts = (baseDir + '/' + rel).split('/');
    const out = [];
    for (const p of parts) { if (!p || p === '.') continue; if (p === '..') out.pop(); else out.push(p); }
    return '/' + out.join('/');
  }
  async function inlineLocalAssets(html, htmlPath) {
    let out = html;
    const linkRe = /<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi;
    const links = [...out.matchAll(linkRe)];
    for (const m of links) {
      const tag = m[0];
      const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/i);
      if (!hrefMatch) continue;
      const href = hrefMatch[1];
      if (/^([a-z]+:)?\/\//i.test(href) || href.startsWith('data:')) continue;
      const cssPath = resolveRelativePath(htmlPath, href);
      try { const cr = await bridgeCall('/read', { path: cssPath }); if (cr && cr.ok) out = out.replace(tag, `<style>\n${cr.content}\n</style>`); } catch {}
    }
    const scriptRe = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi;
    const scripts = [...out.matchAll(scriptRe)];
    for (const m of scripts) {
      const tag = m[0]; const src = m[1];
      if (/^([a-z]+:)?\/\//i.test(src) || src.startsWith('data:')) continue;
      const jsPath = resolveRelativePath(htmlPath, src);
      try { const jr = await bridgeCall('/read', { path: jsPath }); if (jr && jr.ok) out = out.replace(tag, `<script>\n${jr.content}\n</script>`); } catch {}
    }
    return out;
  }
  async function openPreview(pathOrEmpty) {
    const modal = $('#bwPreviewModal'); if (!modal) return;
    const frame = $('#bwPreviewFrame'); const subtitle = $('#bwPreviewSubtitle'); const pathInput = $('#bwPreviewPath');
    modal.classList.add('open');
    const targetPath = absBridgePath(pathOrEmpty || pathInput?.value.trim() || __lastPreviewFile || '', __bridge.env?.home || '');
    if (pathInput) pathInput.value = targetPath;
    if (!targetPath) { if (subtitle) subtitle.textContent = 'No project yet'; return; }
    if (subtitle) subtitle.textContent = targetPath;
    try {
      const r = await bridgeCall('/read', { path: targetPath });
      if (!r || !r.ok) throw new Error(r?.error || 'could not read file');
      let html = r.content || '';
      if (/\.html?$/i.test(targetPath)) html = await inlineLocalAssets(html, targetPath);
      if (frame) frame.srcdoc = html;
    } catch (e) { if (frame) frame.srcdoc = `<html><body style="font-family:system-ui;padding:40px;color:#b91c1c"><h2>Preview failed</h2><p>${escapeHtml(e.message)}</p></body></html>`; }
  }
  function closePreview() { $('#bwPreviewModal')?.classList.remove('open'); }

  function openModal(id) { const el = document.getElementById(id); if (el) el.classList.add('open'); }
  function closeModal(id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); }
  function openSidebar() { $('#sidebar')?.classList.add('open'); $('#sidebarScrim')?.classList.add('open'); }
  function closeSidebar() { $('#sidebar')?.classList.remove('open'); $('#sidebarScrim')?.classList.remove('open'); }

  /* ---------- Wiring ---------- */
  function wireAll() {
    on('#hamburgerBtn', 'click', openSidebar);
    on('#sidebarCloseBtn', 'click', closeSidebar);
    on('#sidebarScrim', 'click', closeSidebar);
    on('#brandLogo', 'click', (e) => { e.preventDefault(); startNewChat(); if (window.innerWidth <= 860) closeSidebar(); });
    on('#newChatBtn', 'click', () => { startNewChat(); if (window.innerWidth <= 860) closeSidebar(); });
    $$('.sidebar-tab').forEach((tab) => {
      tab.onclick = () => {
        const tabKey = tab.dataset.tab;
        $$('.sidebar-tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tabKey));
        $$('.sidebar-section').forEach((s) => { s.style.display = s.dataset.pane === tabKey ? '' : 'none'; });
      };
    });
    on('#historyList', 'click', (e) => {
      const item = e.target.closest('.history-item'); if (!item) return;
      const id = item.dataset.id;
      if (e.target.closest('.history-delete')) { __conversations = __conversations.filter((c) => c.id !== id); if (currentConversationId === id) startNewChat(); saveChats(); renderHistory(); return; }
      openConversation(id);
      if (window.innerWidth <= 860) closeSidebar();
    });
    $('#historySearch')?.addEventListener('input', (e) => { __historyQuery = e.target.value; renderHistory(); });
    const inp = $('#messageInput');
    if (inp) {
      inp.addEventListener('input', () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 180) + 'px'; updateSendButtonState(); });
      inp.addEventListener('keydown', (e) => { const es = __prefs.enterSend !== false; if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && es) { e.preventDefault(); handleSend(); } });
      inp.addEventListener('paste', (e) => { const text = e.clipboardData?.getData('text/plain') || ''; if (text.length > PASTE_ATTACH_THRESHOLD) { e.preventDefault(); addTextAttachment(text); } });
    }
    on('#sendBtn', 'click', handleSend);
    on('#scrollBottomBtn', 'click', () => { autoScrollEnabled = true; userIsAtBottom = true; scrollToBottom(true); });
    on('#chatMessages', 'scroll', () => { const c = $('#chatMessages'); userIsAtBottom = atChatBottom(c); updateScrollButton(); });
    on('#attachBtn', 'click', () => $('#fileInput')?.click());
    on('#fileInput', 'change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
    on('#removeAttachmentBtn', 'click', () => { pendingFiles = []; updatePreview(); updateSendButtonState(); });
    on('#stopBtn', 'click', stopStreaming);
    on('#modelPickerBtn', 'click', (e) => { e.stopPropagation(); if ($('#modelPickerMenu')?.classList.contains('open')) closeModelPicker(); else openModelPicker(); });
    document.addEventListener('click', (e) => { if (!e.target.closest('#modelPicker')) closeModelPicker(); });

    /* DeepThink button */
    on('#deepThinkBtn', 'click', () => {
      __prefs.deepThink = !__prefs.deepThink;
      savePrefs();
      applyDeepThinkUI();
      if (__prefs.deepThink) toast('DeepThink is on — model reasons longer. Image generation disabled.', 3500, 'ok');
      else toast('DeepThink off.', 1800);
    });

    on('#searchModeBtn', 'click', (e) => { e.preventDefault(); forceSearchNext = !forceSearchNext; $('#searchModeBtn')?.classList.toggle('active', forceSearchNext); });
    on('#imageModeBtn', 'click', () => {
      if (__prefs.deepThink) { toast('Turn off DeepThink to generate images.', 3500, 'err'); return; }
      if (!__user) { requireSignIn('Sign in to use Lumenal and generate images.'); return; }
      openModal('imageModal');
    });
    on('#plansModeBtn', 'click', () => { openModal('plansModal'); loadPlans(); });
    on('#supportModeBtn', 'click', (e) => { e.preventDefault(); openSupportModal(); });
    on('#supportModeBtn2', 'click', () => openSupportModal());
    on('#bridgeModeBtn', 'click', openBridgeWorkspace);
    on('#bridgeOpenBtn', 'click', openBridgeWorkspace);
    on('#generateImageBtn', 'click', genImage);
    on('#settingsBtn', 'click', (e) => { e.preventDefault(); openSettingsModal(); });
    on('#logoutBtn', 'click', doLogout);
    on('#signInFromSettingsBtn', 'click', () => { closeModal('settingsModal'); setLoginError(''); openModal('loginModal'); });
    on('#supportResolveBtn', 'click', supportResolve);
    on('#supportSendBtn', 'click', supportSend);
    const supInput = $('#supportInput');
    if (supInput) {
      supInput.addEventListener('input', () => { supInput.style.height = 'auto'; supInput.style.height = Math.min(supInput.scrollHeight, 140) + 'px'; supportUpdateComposeState(); });
      supInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); supportSend(); } });
    }

    /* HTML Runner controls */
    $$('.html-runner-tab').forEach((t) => {
      t.onclick = () => {
        $$('.html-runner-tab').forEach((x) => x.classList.toggle('active', x === t));
        $$('.html-runner-pane').forEach((p) => { p.style.display = p.dataset.hrPane === t.dataset.hrTab ? 'flex' : 'none'; });
      };
    });
    on('#hrReloadBtn', 'click', () => { const f = $('#hrIframe'); if (f) f.srcdoc = __hrCurrentCode; });
    on('#hrCopyBtn', 'click', async () => { try { await navigator.clipboard.writeText(__hrCurrentCode); toast('Source copied', 1800, 'ok'); } catch {} });
    on('#hrOpenBtn', 'click', () => {
      const w = window.open('', '_blank');
      if (w) { w.document.open(); w.document.write(__hrCurrentCode); w.document.close(); }
    });

    $$('.settings-tab').forEach((tab) => {
      tab.onclick = () => {
        const tabKey = tab.dataset.tab;
        $$('.settings-tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tabKey));
        $$('.settings-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tabKey));
      };
    });
    $$('#modeSegmented .seg-btn').forEach((b) => { b.onclick = () => { __prefs.mode = b.dataset.mode; savePrefs(); applyAppearanceFromPrefs(); applyPrefs(); }; });
    $$('#accentSwatches .swatch').forEach((b) => { b.onclick = () => { __prefs.theme = b.dataset.theme; savePrefs(); applyAppearanceFromPrefs(); applyPrefs(); }; });
    $$('#fontSizeSegmented .seg-btn').forEach((b) => { b.onclick = () => { __prefs.fontSize = b.dataset.fontsize; savePrefs(); applyPrefs(); }; });
    const bindToggle = (id, key) => { const el = document.getElementById(id); if (!el) return; el.addEventListener('change', () => { __prefs[key] = el.checked; savePrefs(); applyPrefs(); }); };
    bindToggle('autoScrollToggle', 'autoScroll');
    bindToggle('enterSendToggle', 'enterSend');
    bindToggle('visionToggle', 'vision');
    bindToggle('compactToggle', 'compact');
    bindToggle('reduceMotionToggle', 'reduceMotion');
    bindToggle('deepThinkToggle', 'deepThink');
    on('#uiLanguageSelect', 'change', (e) => { __prefs.uiLanguage = e.target.value; savePrefs(); if (isTranslatable(__prefs.uiLanguage)) toast('Translating…'); applyTranslations(); });
    on('#languageSelect', 'change', (e) => { __prefs.responseLanguage = e.target.value; savePrefs(); });
    on('#exportChatsBtn', 'click', () => {
      const blob = new Blob([JSON.stringify(__conversations, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `mirox-chats-${Date.now()}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); toast('Exported');
    });
    on('#clearChatsBtn', 'click', () => { if (!confirm('Clear all chats?')) return; __conversations = []; saveChats(); startNewChat(); toast('Cleared'); });
    on('#clearI18nCacheBtn', 'click', () => { __i18nCache = {}; saveI18nCache(); toast('Cache cleared'); });
    on('#bwCloseBtn', 'click', closeBridgeWorkspace);
    on('#bwNewBtn', 'click', clearBridgeChat);
    on('#bwConnectBtn', 'click', startBridge);
    on('#bwDisconnectBtn', 'click', stopBridge);
    on('#bwSudoForgetBtn', 'click', forgetSudo);
    on('#bwToggleAutoRun', 'click', () => { __bridgeAutoRun = !__bridgeAutoRun; saveBridgeOpts(); renderToggles(); });
    on('#bwToggleShowCode', 'click', () => { __bridgeShowCode = !__bridgeShowCode; saveBridgeOpts(); renderToggles(); });
    on('#bwPreviewBtn', 'click', () => openPreview(__lastPreviewFile || ''));
    on('#bwStopBtn', 'click', () => { bridgeAbort = true; });
    on('#bwBuildOpenBtn', 'click', () => openPreview(__lastPreviewFile || ''));
    on('#bwBuildFolderBtn', 'click', async () => { if (!__lastBuildFolder) return; try { await navigator.clipboard.writeText(__lastBuildFolder); toast('Copied'); } catch {} });
    on('#bwPreviewCloseBtn', 'click', closePreview);
    on('#bwPreviewReloadBtn', 'click', () => openPreview());
    on('#bwPreviewLoadBtn', 'click', () => openPreview());
    on('#sudoSubmitBtn', 'click', submitSudo);
    on('#sudoSkipBtn', 'click', skipSudo);
    on('#sudoCloseBtn', 'click', skipSudo);
    on('#sudoPasswordInput', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitSudo(); } });
    const bwInp = $('#bridgeInput');
    if (bwInp) {
      bwInp.addEventListener('input', () => { bwInp.style.height = 'auto'; bwInp.style.height = Math.min(bwInp.scrollHeight, 140) + 'px'; updateBridgeSendBtn(); });
      bwInp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleBridgeSend(); } });
    }
    on('#bridgeSendBtn', 'click', handleBridgeSend);
    $$('.bw-quick').forEach((btn) => { btn.onclick = () => { const inp2 = $('#bridgeInput'); if (inp2) { inp2.value = btn.dataset.q; updateBridgeSendBtn(); } handleBridgeSend(); }; });

    document.addEventListener('click', (e) => {
      const cb = e.target.closest('[data-close]');
      if (cb) {
        const target = cb.dataset.close;
        if (target === 'supportModal') { closeSupportModal(); return; }
        if (target === 'htmlRunnerModal') { closeHtmlRunner(); return; }
        closeModal(target);
        return;
      }
      if (e.target.classList.contains('modal-overlay')) {
        if (e.target.id === 'supportModal') { closeSupportModal(); return; }
        if (e.target.id === 'htmlRunnerModal') { closeHtmlRunner(); return; }
        e.target.classList.remove('open');
      }
      if (e.target.closest('[data-iv-close]')) closeImageViewer();
    });
    on('#userChip', 'click', () => { if (!__user) { setLoginError(''); openModal('loginModal'); } });
    on('#upgradeBtn', 'click', (e) => { e.stopPropagation(); if (!__user) { setLoginError(''); openModal('loginModal'); } else { openModal('plansModal'); loadPlans(); } });
    on('#simpleLoginForm', 'submit', doLogin);
    on('#ivDownload', 'click', () => {
      if (!__ivDataUrl) return;
      const c = $('#ivCanvas');
      const href = (c && c.width > 0) ? c.toDataURL('image/png') : __ivDataUrl;
      const a = document.createElement('a');
      a.href = href;
      a.download = `mirox-${Date.now()}.png`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    });
    on('#filePreviewCopyBtn', 'click', async () => {
      if (!__previewFileRef) return;
      try { await navigator.clipboard.writeText(__previewFileRef.content || ''); toast('Copied file content', 1800, 'ok'); } catch {}
    });
    on('#filePreviewAskBtn', 'click', () => {
      const f = __previewFileRef;
      if (!f) return;
      closeFilePreview();
      const inp2 = $('#messageInput');
      if (inp2) {
        inp2.value = `Please read the attached file "${f.name}" and explain what it does, then suggest improvements.`;
        inp2.style.height = 'auto'; inp2.style.height = Math.min(inp2.scrollHeight, 180) + 'px';
        updateSendButtonState(); inp2.focus();
      }
    });

    bindSuggestionClicks();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeImageViewer(); closeModelPicker();
        if ($('#filePreviewModal')?.classList.contains('open')) { closeFilePreview(); return; }
        if ($('#htmlRunnerModal')?.classList.contains('open')) { closeHtmlRunner(); return; }
        if ($('#bridgeWorkspace')?.classList.contains('open')) { closeBridgeWorkspace(); return; }
        if ($('#sudoModal')?.classList.contains('open')) { skipSudo(); return; }
        if ($('#supportModal')?.classList.contains('open')) { closeSupportModal(); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('#messageInput')?.focus(); }
    });
    window.addEventListener('resize', () => { if (window.innerWidth > 860) closeSidebar(); });
    if (!IS_PC) document.querySelectorAll('#bridgeModeBtn, #bridgeOpenBtn, [data-pane="bridge"], .sidebar-tab[data-tab="bridge"]').forEach((el) => { el.style.display = 'none'; });
  }

  function openSettingsModal() { applyPrefs(); updateAccountUI(); openModal('settingsModal'); }

  async function openConversation(id) {
    const convo = __conversations.find((c) => c.id === id);
    if (!convo) return;
    currentConversationId = id;
    const ttl = $('#chatTitle'); if (ttl) ttl.textContent = convo.title || 'Chat';
    const c = $('#chatMessages'); if (c) c.innerHTML = '';
    let lastAiEl = null, lastAiMessage = null;
    for (const m of convo.messages || []) {
      const img = m.imageKey ? await idb.get(m.imageKey).catch(() => null) : null;
      const rendered = addMessageToDOM(m.role, m.content, m.ts, m.id, m.files || [], img, m.thinking);
      if (m.role === 'assistant') { lastAiEl = rendered; lastAiMessage = m; }
    }
    if (lastAiEl && lastAiMessage) {
      const lastBubble = lastAiEl.querySelector('.bubble');
      if (lastBubble && shouldShowContinue(lastAiMessage.content || '', true)) attachContinueButton(lastAiEl, lastBubble, lastAiMessage);
    }
    renderHistory(); updateTokenUsage(); scrollToBottom(true);
  }

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
      async set(k, v) { const db = await open(); return new Promise((res, rej) => { const t2 = db.transaction('kv', 'readwrite'); t2.objectStore('kv').put(v, k); t2.oncomplete = () => res(true); t2.onerror = () => rej(t2.error); }); },
      async get(k) { const db = await open(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); }); }
    };
  })();

  async function init() {
    try {
      try { const t = localStorage.getItem('mirox_token'); if (t && !isApiKey(t)) localStorage.removeItem('mirox_token'); } catch {}
      loadPrefs();
      loadI18nCache();
      applyAppearanceFromPrefs();
      applyPrefs();
      loadChats();
      loadBridgeOpts();
      wireAll();
      setupVoice();
      const local = getLocalUser();
      if (local) { __user = { name: local.name, email: local.email, tier: 'free', local: true }; __tier = 'free'; }
      updateAccountUI();
      renderHistory();
      renderModelPicker();
      renderBridgeStatus();
      startIdleMascot();
      updateTokenUsage();
      applyTranslations();
      applyDeepThinkUI();
    } catch (e) { console.error('[Mirox init]', e); }
    finally { killLoader(); }
    loadConfig().catch(() => {});
    refreshUsage().catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
