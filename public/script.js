(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     i18n — uses MyMemory API (free, no key) with localStorage cache
     English strings live in the HTML. On language switch we translate
     each English source text and cache the result forever.
     ═══════════════════════════════════════════════════════════ */

  const I18N_CACHE_KEY = 'miroxai_i18n_cache_v1';
  const RTL_LANGS = ['fa','ps','ar','he','ur'];
  const TRANSLATE_CONCURRENCY = 3; // max parallel API calls

  let __i18nCache = {};
  let __translationQueue = [];
  let __translating = false;
  let __translationStatusEl = null;

  function loadI18nCache() {
    try { __i18nCache = JSON.parse(localStorage.getItem(I18N_CACHE_KEY) || '{}') || {}; } catch { __i18nCache = {}; }
  }
  function saveI18nCache() {
    try { localStorage.setItem(I18N_CACHE_KEY, JSON.stringify(__i18nCache)); } catch {}
  }
  function setTranslateStatus(text, cls) {
    if (!__translationStatusEl) __translationStatusEl = document.getElementById('translateStatus');
    if (!__translationStatusEl) return;
    __translationStatusEl.textContent = text || '';
    __translationStatusEl.className = 'translate-status' + (cls ? ' ' + cls : '');
  }

  // Fetch translation for a single string from cache or API
  async function translateString(text, targetLang) {
    if (!text || !targetLang || targetLang === 'en') return text;
    const key = targetLang + ':' + text;
    if (__i18nCache[key]) return __i18nCache[key];
    // MyMemory doesn't like very long strings — split at 400 chars
    const chunk = text.length > 400 ? text.slice(0, 400) : text;
    try {
      const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(chunk) + '&langpair=en|' + encodeURIComponent(targetLang);
      const r = await fetch(url, { method: 'GET' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const out = (d && d.responseData && d.responseData.translatedText) || chunk;
      // MyMemory sometimes returns the query echo or quotes — clean up
      let clean = String(out).trim();
      if (clean.startsWith('"') && clean.endsWith('"')) clean = clean.slice(1, -1);
      __i18nCache[key] = clean;
      saveI18nCache();
      return clean;
    } catch (e) {
      // On failure, fall back to English and don't cache (so we retry next time)
      return text;
    }
  }

  // Queue system: 3 parallel workers pull from the queue
  function enqueueTranslation(element, sourceText, targetLang, mode) {
    __translationQueue.push({ element, sourceText, targetLang, mode });
    processQueue();
  }
  async function processQueue() {
    if (__translating) return;
    if (!__translationQueue.length) { setTranslateStatus(''); return; }
    __translating = true;
    const total = __translationQueue.length;
    let done = 0;
    setTranslateStatus('Translating… (0/' + total + ')');
    while (__translationQueue.length) {
      const batch = __translationQueue.splice(0, TRANSLATE_CONCURRENCY);
      const results = await Promise.all(batch.map((job) => translateString(job.sourceText, job.targetLang)));
      results.forEach((translated, i) => {
        const job = batch[i];
        if (!job.element || !job.element.isConnected) return;
        if (typeof translated !== 'string' || !translated) return;
        if (job.mode === 'text') {
          // Preserve any nested icon children: only replace if the element has no child elements
          if (job.element.children.length === 0) job.element.textContent = translated;
          else {
            // Find first text node and replace
            for (const node of job.element.childNodes) {
              if (node.nodeType === 3 && node.textContent.trim()) { node.textContent = translated; break; }
            }
          }
        } else if (job.mode === 'placeholder') {
          job.element.placeholder = translated;
        } else if (job.mode === 'title') {
          job.element.title = translated;
        } else if (job.mode === 'html') {
          job.element.innerHTML = translated;
        }
      });
      done += batch.length;
      setTranslateStatus('Translating… (' + Math.min(done, total) + '/' + total + ')');
    }
    __translating = false;
    setTranslateStatus(''); // done
  }

  // Apply translations: iterate all data-i18n elements
  function applyTranslations() {
    const lang = (__prefs && __prefs.uiLanguage) || 'en';
    const isRtl = RTL_LANGS.includes(lang);
    document.documentElement.lang = lang;
    document.documentElement.setAttribute('data-dir', isRtl ? 'rtl' : 'ltr');

    // For each translatable element, first capture the English source ONCE
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      if (!el.dataset.i18nEn) {
        // Store the source English only the first time
        let src = '';
        if (el.children.length === 0) src = el.textContent;
        else {
          for (const node of el.childNodes) {
            if (node.nodeType === 3 && node.textContent.trim()) { src = node.textContent.trim(); break; }
          }
          if (!src) src = el.textContent;
        }
        el.dataset.i18nEn = src;
      }
      const src = el.dataset.i18nEn;
      if (!src) return;
      if (lang === 'en') {
        // Restore English
        if (el.children.length === 0) el.textContent = src;
        else {
          for (const node of el.childNodes) {
            if (node.nodeType === 3 && node.textContent.trim()) { node.textContent = src; break; }
          }
        }
        return;
      }
      // Look up cache first for instant update
      const cacheKey = lang + ':' + src;
      if (__i18nCache[cacheKey]) {
        if (el.children.length === 0) el.textContent = __i18nCache[cacheKey];
        else {
          for (const node of el.childNodes) {
            if (node.nodeType === 3 && node.textContent.trim()) { node.textContent = __i18nCache[cacheKey]; break; }
          }
        }
      } else {
        enqueueTranslation(el, src, lang, 'text');
      }
    });

    document.querySelectorAll('[data-i18n-html]').forEach((el) => {
      if (!el.dataset.i18nHtmlEn) el.dataset.i18nHtmlEn = el.innerHTML;
      const srcHtml = el.dataset.i18nHtmlEn;
      if (!srcHtml) return;
      // For HTML strings, translate the plain-text portion only
      const tmp = document.createElement('div');
      tmp.innerHTML = srcHtml;
      const plain = tmp.textContent.trim();
      if (lang === 'en') { el.innerHTML = srcHtml; return; }
      const cacheKey = lang + ':html:' + plain;
      if (__i18nCache[cacheKey]) {
        // Rebuild with translated plain text but keep any <strong>/<code> highlights as-is
        // Simplest: replace whole HTML with translated text
        el.textContent = __i18nCache[cacheKey];
      } else {
        enqueueTranslation(el, plain, lang, 'html');
      }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      if (!el.dataset.i18nPhEn) el.dataset.i18nPhEn = el.placeholder || '';
      const src = el.dataset.i18nPhEn;
      if (!src) return;
      if (lang === 'en') { el.placeholder = src; return; }
      const cacheKey = lang + ':ph:' + src;
      if (__i18nCache[cacheKey]) el.placeholder = __i18nCache[cacheKey];
      else enqueueTranslation(el, src, lang, 'placeholder');
    });

    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      if (!el.dataset.i18nTitleEn) el.dataset.i18nTitleEn = el.title || '';
      const src = el.dataset.i18nTitleEn;
      if (!src) return;
      if (lang === 'en') { el.title = src; return; }
      const cacheKey = lang + ':title:' + src;
      if (__i18nCache[cacheKey]) el.title = __i18nCache[cacheKey];
      else enqueueTranslation(el, src, lang, 'title');
    });
  }

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
  setTimeout(killLoader, 1500);
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
  const LS_KEY = 'miroxai_conversations_v38';
  const TOKEN_KEY = 'mirox_token';
  const GUEST_KEY = 'miroxai_guest_id_v1';
  const APPEARANCE_KEY = 'miroxai_appearance_v38';
  const SHARE_KEY = 'miroxai_share_v9';
  const BONUS_KEY = 'miroxai_bonus_v9';
  const PREFS_KEY = 'miroxai_prefs_v5';
  const BRIDGE_KEY = 'miroxai_bridge_v1';
  const BRIDGE_OPTS_KEY = 'miroxai_bridge_opts_v1';
  const PASTE_ATTACH_THRESHOLD = 1024;
  const NET_TIMEOUT_MS = 15000;
  const STREAM_TIMEOUT_MS = 120000;
  const BASE_FREE_LIMIT = 10000;
  const BONUS_TOKENS = 50000;
  const BONUS_MS = 7 * 24 * 60 * 60 * 1000;
  const BONUS_CHECK_MS = 30 * 1000;
  const MAX_IMAGE_DIM = 1600;
  const MAX_BRIDGE_ITER = 200;
  const MAX_AUTO_CONTINUES = 100;
  const MAX_DUP_COMMANDS = 40;

  let __config = null, __user = null, __tier = 'free', __model = 'mirox-luna-1.2';
  let currentConversationId = null, isReplying = false;
  let continuationBusy = false, streamRenderAt = 0, userIsAtBottom = true;
  let autoScrollEnabled = true;
  let __conversations = [], pendingFiles = [], activeStreamController = null;
  let forceSearchNext = false, __historyQuery = '';
  let __ivDataUrl = '';
  let __shareState = { claimed: false, claimedAt: 0, dismissedAt: 0 };
  let __bonusTimer = null;
  let __lastBonusActive = false;
  let __prefs = {};
  let __bridge = { name: 'My Laptop', port: 8765, connected: false, baseUrl: null, env: null };
  let bridgeRunning = false, bridgeAbort = false, bridgeConversation = [], bridgeProgress = 0;
  let bridgeTurn = null, bridgeTaskComplete = true, bridgeWaitingForUser = false;
  let __lastBuildFolder = null, __lastPreviewFile = null;
  let __sudoPassword = '', __sudoRemember = false, __sudoResolver = null;
  let __bridgeAutoRun = true, __bridgeShowCode = false;

  const uid = () => 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const escapeHtml = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  function safeGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
  function safeSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
  function safeRemove(k) { try { localStorage.removeItem(k); } catch {} }
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
  function setToken(tk) { try { tk ? localStorage.setItem(TOKEN_KEY, tk) : localStorage.removeItem(TOKEN_KEY); } catch {} }

  function getGuestId() {
    let id = null;
    try { id = localStorage.getItem(GUEST_KEY); } catch {}
    if (!id || id.length < 8) {
      id = 'g_' + Math.random().toString(36).slice(2, 14) + Date.now().toString(36).slice(-6);
      try { localStorage.setItem(GUEST_KEY, id); } catch {}
    }
    return id;
  }
  function bonusProofHeaders() {
    const b = loadBonusRaw();
    if (!b || !isBonusValid(b)) return {};
    return { 'X-Mirox-Guest': getGuestId(), 'X-Mirox-Bonus-Tokens': String(b.tokens), 'X-Mirox-Bonus-Expires': String(b.expiresAt) };
  }
  function authHeaders(extra) {
    const h = { 'Content-Type': 'application/json', ...(extra || {}) };
    const tk = getToken(); if (tk) h.Authorization = 'Bearer ' + tk;
    Object.assign(h, bonusProofHeaders());
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

  /* ═══════════ BONUS ═══════════ */
  function loadBonusRaw() { const b = safeGet(BONUS_KEY, null); return (b && typeof b === 'object') ? b : null; }
  function saveBonusRaw(b) { b ? safeSet(BONUS_KEY, b) : safeRemove(BONUS_KEY); }
  function isBonusValid(b) {
    if (!b) return false;
    const tokens = parseInt(b.tokens, 10) || 0;
    const expiresAt = parseInt(b.expiresAt, 10) || 0;
    return tokens > 0 && expiresAt > 0 && Date.now() < expiresAt;
  }
  function getActiveBonus() {
    const b = loadBonusRaw();
    if (!b) return 0;
    if (!isBonusValid(b)) { saveBonusRaw(null); if (__shareState.claimed) { __shareState.claimed = false; saveShareState(); } return 0; }
    return b.tokens;
  }
  function getBonusExpiryMs() { const b = loadBonusRaw(); return isBonusValid(b) ? b.expiresAt - Date.now() : 0; }
  function isBonusActive() { return getActiveBonus() > 0; }
  function grantLocalBonus(tokens) {
    const prev = loadBonusRaw(); const now = Date.now();
    let newTokens, newExpiry;
    if (isBonusValid(prev)) { newTokens = (prev.tokens || 0) + tokens; newExpiry = Math.max(prev.expiresAt, now + BONUS_MS); }
    else { newTokens = tokens; newExpiry = now + BONUS_MS; }
    const bonus = { tokens: newTokens, expiresAt: newExpiry, grantedAt: now, guest: getGuestId() };
    saveBonusRaw(bonus); return bonus;
  }
  function getFreeLimit() { return BASE_FREE_LIMIT + getActiveBonus(); }
  function formatBonusRemaining() {
    const ms = getBonusExpiryMs(); if (ms <= 0) return '';
    const days = Math.floor(ms / 86400000), hours = Math.floor((ms % 86400000) / 3600000);
    if (days >= 1) return days + 'd';
    if (hours >= 1) return hours + 'h';
    return Math.max(1, Math.floor(ms / 60000)) + 'm';
  }

  /* ═══════════ PREFS ═══════════ */
  const DEFAULT_PREFS = { autoScroll: true, enterSend: true, vision: true, compact: false, reduceMotion: false, fontSize: 'md', mode: 'light', theme: 'default', responseLanguage: 'auto', uiLanguage: 'en' };
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
    const mode = __prefs.mode || 'light';
    $$('#modeSegmented .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    const fs = __prefs.fontSize || 'md';
    $$('#fontSizeSegmented .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.fontsize === fs));
    const theme = __prefs.theme || 'default';
    $$('#accentSwatches .swatch').forEach((b) => b.classList.toggle('active', b.dataset.theme === theme));
    const uiSel = document.getElementById('uiLanguageSelect');
    if (uiSel && uiSel.value !== (__prefs.uiLanguage || 'en')) uiSel.value = __prefs.uiLanguage || 'en';
    const langSel = document.getElementById('languageSelect');
    if (langSel && langSel.value !== (__prefs.responseLanguage || 'auto')) langSel.value = __prefs.responseLanguage || 'auto';
  }
  function applyAppearanceFromPrefs() {
    const root = document.documentElement;
    let mode = __prefs.mode || 'light';
    if (mode === 'auto') mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    root.setAttribute('data-mode', mode);
    root.setAttribute('data-theme', __prefs.theme || 'default');
  }

  /* ═══════════ BLOB MASCOT with new moods ═══════════ */
  const MOODS = ['idle','happy','thinking','coding','celebrate','error','learning','wink','study','searching','reading'];

  // Blob path — organic 4-lobe shape
  const BLOB_PATH = 'M100 20 C126 20 144 32 154 54 C178 56 194 76 194 102 C194 128 178 148 154 152 C144 174 126 186 100 186 C74 186 56 174 46 152 C22 148 6 128 6 102 C6 76 22 56 46 54 C56 32 74 20 100 20 Z';

  // Full mascot SVG with separate eye elements and optional glasses for study/reading moods
  function blobSvg() {
    return `<svg class="blob-svg" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mirox avatar">
      <g class="blob-float">
        <path class="blob-body" d="${BLOB_PATH}" fill="currentColor"/>
        <g class="blob-eyes">
          <ellipse class="eye eye-left" cx="78" cy="88" rx="6.5" ry="15" transform="rotate(14 78 88)" fill="var(--bg)"/>
          <ellipse class="eye eye-right" cx="122" cy="85" rx="6.5" ry="15" transform="rotate(14 122 85)" fill="var(--bg)"/>
        </g>
        <g class="blob-glasses" fill="none" stroke="var(--bg)" stroke-width="4" stroke-linecap="round">
          <rect x="58" y="66" width="40" height="36" rx="11"/>
          <rect x="102" y="63" width="40" height="36" rx="11"/>
          <path d="M98 82 Q100 76 102 80"/>
        </g>
      </g>
    </svg>`;
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
  if (lb) lb.innerHTML = `<div class="mascot mascot-lg m-idle" data-mood="idle">${blobSvg()}</div>`;

  // Idle mascot: rotates through cute moods including wink, study, searching
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
  function pickStatusLabel(text) {
    const t2 = String(text || '').toLowerCase();
    if (!t2) return 'Thinking';
    if (/\b(build|create|make|write|code|script)\b/.test(t2)) return 'Building';
    if (/\b(search|find|look up|google)\b/.test(t2)) return 'Searching';
    if (/\b(fix|bug|error|debug)\b/.test(t2)) return 'Debugging';
    return 'Thinking';
  }

  /* ═══════════ THINKING PANEL ═══════════ */
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

  /* ═══════════ CONVERSATIONS ═══════════ */
  function currentConvo() { return __conversations.find((c) => c.id === currentConversationId) || null; }
  function saveChats() {
    const slim = __conversations.map((c) => ({
      ...c,
      messages: (c.messages || []).map((m) => ({
        id: m.id, role: m.role, content: m.content, ts: m.ts,
        imageKey: m.imageKey || null,
        files: (m.files || []).map((f) => ({ name: f.name, size: f.size, type: f.type, mime: f.mime, dataUrl: (f.type === 'image' && f.dataUrl && f.dataUrl.length < 200000) ? f.dataUrl : undefined, width: f.width, height: f.height })),
      })),
    }));
    safeSet(LS_KEY, slim);
  }
  function loadChats() { const v = safeGet(LS_KEY, []); __conversations = Array.isArray(v) ? v : []; }

  function welcomeHTML() {
    return `<div class="welcome-screen">
      <div class="welcome-mascot"><div class="mascot mascot-lg m-idle" id="welcomeMascot" data-mood="idle">${blobSvg()}</div></div>
      <h1 class="welcome-title" data-i18n="welcomeTitle">Hi, I'm Mirox</h1>
      <p class="welcome-sub" data-i18n-html="welcomeSub">Luna and Gen are unlimited and free. Share to unlock <strong>Pro, Ultra &amp; Eclipse</strong> free for 7 days.</p>
      <div class="suggestion-grid">
        <button class="suggestion-card" type="button" data-prompt="Show me a simple Lua script that prints numbers 1 to 5"><i class="ri-code-box-line"></i><span data-i18n="suggestLua">Write a Lua script</span></button>
        <button class="suggestion-card" type="button" data-prompt="Show me an HTML example with a table"><i class="ri-html5-line"></i><span data-i18n="suggestHtml">Show an HTML table</span></button>
        <button class="suggestion-card" type="button" data-prompt="Generate me an image of a cat"><i class="ri-image-line"></i><span data-i18n="suggestImage">Generate an image</span></button>
        <button class="suggestion-card" type="button" data-prompt="Explain a concept simply"><i class="ri-lightbulb-line"></i><span data-i18n="suggestExplain">Explain a concept</span></button>
      </div>
    </div>`;
  }
  function startNewChat() {
    currentConversationId = null;
    const ttl = $('#chatTitle'); if (ttl) ttl.textContent = 'New chat';
    const c = $('#chatMessages'); if (c) c.innerHTML = welcomeHTML();
    bindSuggestionClicks(); updateTokenUsage(); renderHistory();
    // Re-apply translations to newly created content
    applyTranslations();
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
    if (!items.length) { list.innerHTML = `<li class="history-empty" data-i18n="noChats">No conversations yet</li>`; return; }
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
  function formatK(n) { return n >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k' : String(n); }
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
  function freeLimitReached(convo = currentConvo()) { return __tier === 'free' && conversationTokenUsage(convo) >= getFreeLimit(); }
  function fmtSize(n) { if (n == null) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
  function fileIconHTML() { return '<span class="file-glyph" aria-hidden="true"><i class="ri-file-text-line"></i></span>'; }

  /* ═══════════ CODE LANG ═══════════ */
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
  function renderCode(lang, code, closed) {
    const meta = langMeta(lang);
    const raw = String(code || '').replace(/\n$/, '');
    const btn = closed ? '<button class="code-action-btn" data-copy><i class="ri-file-copy-line"></i> Copy</button>' : '<span class="writing-tag"><i class="ri-loader-4-line spin"></i> writing…</span>';
    return `<div class="code-block" data-lang="${escapeHtml(meta.hljs)}"><div class="code-block-header"><span class="code-lang-badge"><i class="${meta.icon}"></i><span>${escapeHtml(meta.label)}</span></span>${btn}</div><pre><code class="hljs language-${escapeHtml(meta.hljs)}">${highlightCode(lang, raw)}</code></pre></div>`;
  }

  /* ═══════════ MARKDOWN ═══════════ */
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
    if (openM) { const before = rest.slice(0, openM.index); if (before) parts.push({ type: 'text', content: before }); parts.push({ type: 'code', lang: (openM[1] || '').trim(), content: openM[2], closed: false }); }
    else if (rest) parts.push({ type: 'text', content: rest });
    return parts.map((p) => p.type === 'code' ? renderCode(p.lang, p.content, p.closed) : renderText(p.content)).join('');
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
  function wireCopyButtons(scope) {
    (scope || document).querySelectorAll('.code-action-btn[data-copy]').forEach((btn) => {
      if (btn.__wired) return; btn.__wired = true;
      btn.onclick = async () => {
        const code = btn.closest('.code-block')?.querySelector('pre code')?.textContent || '';
        try { await navigator.clipboard.writeText(code); btn.innerHTML = '<i class="ri-check-line"></i> Copied'; setTimeout(() => { btn.innerHTML = '<i class="ri-file-copy-line"></i> Copy'; }, 1200); } catch {}
      };
    });
  }

  /* ═══════════ MESSAGE DOM ═══════════ */
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
        if (f.type === 'image' && f.dataUrl) {
          const dims = f.width && f.height ? `<span class="attach-size">${f.width}×${f.height}</span>` : '';
          const vision = f.vision ? '<span class="attach-vision"><i class="ri-eye-line"></i> vision</span>' : '';
          inner += `<div class="attach-chip attach-chip-image"><img src="${f.dataUrl}" alt="">${escapeHtml(f.name || '')}${dims}${vision}</div>`;
        } else inner += `<div class="attach-chip">${fileIconHTML()}${escapeHtml(f.name || 'file')}${f.size ? ` <span class="attach-size">${fmtSize(f.size)}</span>` : ''}</div>`;
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
  function handleSend() {
    if (isReplying) return;
    const inp = $('#messageInput'); if (!inp) return;
    const text = inp.value.trim();
    if (!text && !pendingFiles.length) return;
    if (freeLimitReached()) { toast('Max tokens reached.'); return; }
    const files = pendingFiles.slice();
    const searchFlag = forceSearchNext; forceSearchNext = false;
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
    try { await sendToAPI('Continue your previous response from exactly where it stopped.', [], false, { existingMsgEl: msgEl, existingBubble: bubble, messageObj, continuation: true }); }
    finally { continuationBusy = false; if (btn.isConnected) btn.remove(); }
  }

  /* ═══════════ API ═══════════ */
  async function sendToAPI(text, files, forceSearch, continuation = null) {
    const isContinuation = !!(continuation && continuation.continuation);
    const convoAtStart = currentConvo();
    if (!isContinuation && freeLimitReached(convoAtStart)) { toast('Max tokens reached.'); return; }
    isReplying = true; updateSendButtonState();
    const stopBtn = $('#stopBtn'); if (stopBtn) stopBtn.style.display = 'grid';
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

    const visionFiles = files.filter((f) => f.type === 'image' && f.dataUrl);
    const contentParts = [];
    if (text) contentParts.push({ type: 'text', text });
    for (const f of visionFiles) contentParts.push({ type: 'image_url', image_url: { url: f.pngDataUrl || f.dataUrl, detail: 'auto' } });

    activeStreamController = new AbortController();
    let generatedImage = null, gotToken = !!isContinuation, limitHit = false;
    let streamComplete = false;
    let renderTimer = null;
    const renderStreamText = () => { renderTimer = null; if (bubbleText) { bubbleText.innerHTML = renderMarkdown(full); wireCopyButtons(bubbleText); } scrollToBottom(); };
    const scheduleRender = () => { const now = performance.now(); if (renderTimer) return; renderTimer = setTimeout(renderStreamText, Math.max(50, 120 - (now - streamRenderAt))); streamRenderAt = now; };
    const streamTimeout = setTimeout(() => { try { activeStreamController?.abort(); } catch {} }, STREAM_TIMEOUT_MS);

    try {
      const reqBody = { message: text, history, model, stream: true, search: !!forceSearch, files: files.map((f) => ({ name: f.name, size: f.size, type: f.type, mime: f.mime, width: f.width, height: f.height, dataUrl: f.dataUrl, base64: f.base64 || null, svgText: f.svgText || null, vision: !!f.vision })), content_parts: contentParts.length ? contentParts : null, guest_id: getGuestId(), bonus_active: isBonusActive(), language: __prefs.responseLanguage || 'auto' };
      const res = await fetch('/v1/chat/completions', { method: 'POST', headers: authHeaders(), credentials: 'same-origin', body: JSON.stringify(reqBody), signal: activeStreamController.signal });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const d = await res.json(); detail = d.error?.message || d.error || d.message || detail; } catch {}
        throw new Error(detail);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const ensureBubble = () => { if (!bubble) { bubble = document.createElement('div'); bubble.className = 'bubble'; msgEl.insertBefore(bubble, timeEl); } };
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
          if (o.n) panel.addNarration(o.n);
          if (o.img) { generatedImage = o.img; panel.markWriting(); panel.setMood('celebrate'); ensureBubble(); bubble.innerHTML = `<div class="gen-image"><img src="${o.img}" draggable="false" alt=""></div><div class="bubble-text"></div>`; bubbleText = bubble.querySelector('.bubble-text'); const img = bubble.querySelector('img'); if (img) img.onclick = () => openImageViewer(o.img); scrollToBottom(); continue; }
          if (o.d) {
            full += o.d;
            const limit = getFreeLimit();
            if (__tier === 'free' && convo && conversationTokenUsage(convo) + estimateTokens(full) >= limit) { full = full.slice(0, Math.max(0, (limit - conversationTokenUsage(convo)) * 4)); limitHit = true; if (!gotToken) { gotToken = true; ensureBubble(); bubble.innerHTML = '<div class="bubble-text"></div>'; bubbleText = bubble.querySelector('.bubble-text'); } if (bubbleText) bubbleText.innerHTML = renderMarkdown(full); try { await reader.cancel(); } catch {} break; }
            if (!gotToken) { gotToken = true; panel.markWriting(); panel.setMood('learning'); ensureBubble(); bubble.innerHTML = '<div class="bubble-text"></div>'; bubbleText = bubble.querySelector('.bubble-text'); }
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
      if (generatedImage) { imageKey = 'img:' + aiMsgId; await idb.set(imageKey, generatedImage).catch(() => { imageKey = null; }); }
      let savedMsg;
      if (convo) {
        if (isContinuation) { savedMsg = convo.messages.find((m) => m.id === aiMsgId) || continuation.messageObj; savedMsg.content = full; savedMsg.ts = Date.now(); if (imageKey) savedMsg.imageKey = imageKey; }
        else { savedMsg = { id: aiMsgId, role: 'assistant', content: full, ts: Date.now(), imageKey }; convo.messages.push(savedMsg); }
      }
      saveChats(); updateTokenUsage();
      timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (savedMsg && shouldShowContinue(full, convo, streamComplete)) attachContinueButton(msgEl, bubble, savedMsg);
    } catch (e) {
      clearTimeout(streamTimeout);
      const aborted = e.name === 'AbortError';
      const msg = aborted ? 'Stopped.' : (e.message || 'Something went wrong.');
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
      toast(msg, 5000); updateTokenUsage();
    } finally {
      clearTimeout(streamTimeout);
      panel.destroy();
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

  function toast(msg, ms) {
    const el = document.createElement('div');
    el.className = 'mirox-toast';
    el.textContent = typeof msg === 'string' ? msg : '';
    document.body.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, ms || 1800);
  }

  /* ═══════════ SHARE ═══════════ */
  function loadShareState() { __shareState = safeGet(SHARE_KEY, { claimed: false, claimedAt: 0, dismissedAt: 0 }); }
  function saveShareState() { safeSet(SHARE_KEY, __shareState); }
  function shouldShowShareAd() { if (__tier !== 'free') return false; if (isBonusActive()) return false; if (__shareState.dismissedAt && Date.now() - __shareState.dismissedAt < 6 * 3600 * 1000) return false; return true; }
  function openShareAd() { if (!shouldShowShareAd()) return; setTimeout(() => $('#shareAdModal')?.classList.add('open'), 1800); }
  function closeShareAd(dismiss) { const m = $('#shareAdModal'); if (m) m.classList.remove('open'); if (dismiss) { __shareState.dismissedAt = Date.now(); saveShareState(); } }
  function setShareStatus(text, cls) { const el = $('#shareAdStatus'); if (!el) return; el.textContent = String(text || ''); el.className = 'share-ad-status' + (cls ? ' ' + cls : ''); }
  function celebrateReward() {
    launchConfetti();
    const chip = $('#tokenUsage'); if (chip) { chip.classList.add('pulse'); setTimeout(() => chip.classList.remove('pulse'), 1200); }
    const wm = document.getElementById('welcomeMascot');
    if (wm) { setMascotMood('celebrate', wm.parentElement); setTimeout(() => setMascotMood('happy', wm.parentElement), 2000); }
  }
  function grantShareRewardLocal() {
    const bonus = grantLocalBonus(BONUS_TOKENS);
    __shareState.claimed = true; __shareState.claimedAt = Date.now(); __shareState.dismissedAt = 0;
    saveShareState(); updateTokenUsage(); renderModelPicker(); celebrateReward();
    const days = Math.round((bonus.expiresAt - Date.now()) / 86400000);
    toast(`🎉 ${BONUS_TOKENS.toLocaleString()} bonus tokens for ${days} days!`, 6500);
  }
  async function grantShareReward() {
    grantShareRewardLocal();
    try { await jsonOr('/api/share/reward', { method: 'POST', body: JSON.stringify({ bonus_tokens: BONUS_TOKENS, valid_days: 7, verified: true, guest_id: getGuestId() }) }, null); } catch {}
    try { if (__user) await refreshUsage(); } catch {}
  }
  async function attemptShare() {
    const btn = $('#shareAdShareBtn');
    const shareData = { title: 'MiroxAI', text: 'Try MiroxAI — free unlimited AI chat!', url: location.origin + '/?ref=share&g=' + getGuestId() };
    if (btn) btn.disabled = true;
    if (navigator.share) {
      try { setShareStatus('…'); await navigator.share(shareData); setShareStatus('Share confirmed!', 'ok'); await grantShareReward(); setTimeout(() => closeShareAd(false), 2400); return; }
      catch (e) { if (e && e.name === 'AbortError') { setShareStatus('Cancelled.', 'warn'); if (btn) btn.disabled = false; return; } }
    }
    const shareText = encodeURIComponent(shareData.text + ' ' + shareData.url);
    window.open(`https://twitter.com/intent/tweet?text=${shareText}`, '_blank', 'noopener,width=600,height=500');
    setShareStatus('…');
    let resolved = false;
    const focusHandler = () => { if (resolved) return; resolved = true; window.removeEventListener('focus', focusHandler); setTimeout(async () => { setShareStatus('Share detected!', 'ok'); await grantShareReward(); setTimeout(() => closeShareAd(false), 2400); }, 800); };
    window.addEventListener('focus', focusHandler);
    setTimeout(() => { if (!resolved) { resolved = true; window.removeEventListener('focus', focusHandler); setShareStatus('No share detected.', 'warn'); if (btn) btn.disabled = false; } }, 90000);
  }

  /* ═══════════ CONFETTI ═══════════ */
  function launchConfetti() {
    if (__prefs.reduceMotion) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'confetti-canvas';
    document.body.appendChild(canvas);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth, H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    const colors = ['#4d6bfe','#7c8aff','#16a34a','#4ade80','#f59e0b','#fbbf24','#ec4899','#f472b6','#06b6d4','#22d3ee','#a855f7','#c084fc'];
    const particles = [];
    const origins = [{ x: W*0.15, y: H*0.25 }, { x: W*0.85, y: H*0.25 }, { x: W*0.5, y: H*0.2 }];
    for (let i = 0; i < 180; i++) {
      const origin = origins[i % origins.length];
      const angle = (Math.random() - 0.5) * Math.PI * 1.4 - Math.PI / 2;
      const speed = 6 + Math.random() * 12;
      particles.push({ x: origin.x + (Math.random() - 0.5) * 60, y: origin.y + (Math.random() - 0.5) * 40, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 4, gravity: 0.28 + Math.random() * 0.14, drag: 0.988, size: 6 + Math.random() * 8, color: colors[Math.floor(Math.random() * colors.length)], rotation: Math.random() * Math.PI * 2, rotationSpeed: (Math.random() - 0.5) * 0.34, shape: Math.random() < 0.55 ? 'rect' : 'circle' });
    }
    const start = performance.now();
    let stopped = false;
    function frame(now) {
      if (stopped) return;
      const tt = (now - start) / 4200;
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = tt > 0.7 ? Math.max(0, 1 - (tt - 0.7) / 0.3) : 1;
      for (const p of particles) {
        p.vy += p.gravity; p.vx *= p.drag; p.vy *= p.drag;
        p.x += p.vx; p.y += p.vy; p.rotation += p.rotationSpeed;
        if (p.y > H + 40) continue;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rotation); ctx.fillStyle = p.color;
        if (p.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(-p.size/2, -p.size/3, p.size, p.size * 0.7);
        ctx.restore();
      }
      if (tt < 1) requestAnimationFrame(frame);
      else { stopped = true; canvas.remove(); }
    }
    requestAnimationFrame(frame);
    setTimeout(() => { stopped = true; if (canvas.parentNode) canvas.remove(); }, 6000);
  }

  /* ═══════════ IMAGES ═══════════ */
  function imageToBase64DataURL(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const rawDataUrl = reader.result;
        const img = new Image();
        img.onload = () => {
          let w = img.naturalWidth, h = img.naturalHeight;
          if (w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM) { const ratio = Math.min(MAX_IMAGE_DIM / w, MAX_IMAGE_DIM / h); w = Math.round(w * ratio); h = Math.round(h * ratio); }
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          let outUrl;
          try { const srcMime = (file.type || 'image/jpeg').toLowerCase(); outUrl = (srcMime === 'image/png' || srcMime === 'image/webp') ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.88); } catch { outUrl = rawDataUrl; }
          const base64 = String(outUrl).split(',')[1] || '';
          const mime = (String(outUrl).split(';')[0].split(':')[1]) || file.type || 'image/jpeg';
          resolve({ type: 'image', name: file.name, size: file.size, mime, dataUrl: outUrl, base64, width: w, height: h, vision: true });
        };
        img.onerror = () => resolve(null);
        img.src = rawDataUrl;
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
        let base64 = '';
        try { base64 = btoa(unescape(encodeURIComponent(svgText))); } catch {}
        const dataUrl = 'data:image/svg+xml;base64,' + base64;
        const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
        const objUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          let w = img.naturalWidth || 512, h = img.naturalHeight || 512;
          if (w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM) { const ratio = Math.min(MAX_IMAGE_DIM / w, MAX_IMAGE_DIM / h); w = Math.round(w * ratio); h = Math.round(h * ratio); }
          let pngDataUrl = null;
          try { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h); pngDataUrl = c.toDataURL('image/png'); } catch {}
          URL.revokeObjectURL(objUrl);
          resolve({ type: 'image', name: file.name, size: file.size, mime: 'image/svg+xml', dataUrl, base64, svgText, pngDataUrl, pngBase64: pngDataUrl ? pngDataUrl.split(',')[1] : '', width: w, height: h, vision: true, isSvg: true });
        };
        img.onerror = () => { URL.revokeObjectURL(objUrl); resolve({ type: 'image', name: file.name, size: file.size, mime: 'image/svg+xml', dataUrl, base64, svgText, vision: true, isSvg: true }); };
        img.src = objUrl;
      };
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });
  }
  function hasAttachment(name, size) { return pendingFiles.some((f) => f.name === name && f.size === size); }
  function handleFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const arr = [];
    for (const f of Array.from(fileList)) { if (hasAttachment(f.name, f.size)) continue; arr.push(f); }
    if (!arr.length) return;
    let done = 0; const newFiles = [];
    const finish = () => { newFiles.sort((a, b) => (a.order || 0) - (b.order || 0)); for (const nf of newFiles) if (!hasAttachment(nf.name, nf.size)) pendingFiles.push(nf); updatePreview(); updateSendButtonState(); };
    arr.forEach((f, idx) => {
      const isSvg = f.type === 'image/svg+xml' || /\.svg$/i.test(f.name);
      const isImg = !isSvg && ((f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name));
      const one = () => { done++; if (done === arr.length) finish(); };
      if (isSvg) svgToVisionData(f).then((d) => { if (d) newFiles.push({ ...d, order: idx }); one(); }).catch(one);
      else if (isImg) imageToBase64DataURL(f).then((d) => { if (d) newFiles.push({ ...d, order: idx }); one(); }).catch(one);
      else { const r = new FileReader(); r.onload = () => { newFiles.push({ name: f.name, size: f.size, type: 'text', mime: f.type || 'text/plain', content: String(r.result).slice(0, 80000), order: idx }); one(); }; r.onerror = one; r.readAsText(f); }
    });
  }
  function updatePreview() {
    const p = $('#attachmentPreview'), list = $('#attachmentList');
    if (!p || !list) return;
    if (!pendingFiles.length) { p.style.display = 'none'; list.innerHTML = ''; return; }
    p.style.display = 'flex';
    list.innerHTML = pendingFiles.map((f) => {
      if (f.type === 'image' && f.dataUrl) { const dims = f.width && f.height ? `<span class="attach-size">${f.width}×${f.height}</span>` : ''; const vision = f.vision ? '<span class="attach-vision"><i class="ri-eye-line"></i> vision</span>' : ''; return `<div class="attach-chip attach-chip-image"><img src="${f.dataUrl}" alt="">${escapeHtml(f.name)}${dims}${vision}</div>`; }
      return `<div class="attach-chip">${fileIconHTML()}${escapeHtml(f.name)}${f.size ? ` <span class="attach-size">${fmtSize(f.size)}</span>` : ''}</div>`;
    }).join('');
  }
  function addTextAttachment(text, name) {
    const body = String(text).slice(0, 80000);
    const fname = name || ('pasted-' + new Date().toISOString().slice(11, 19).replace(/:/g, '-') + '.txt');
    if (pendingFiles.some((f) => f.type === 'text' && f.content === body)) return;
    pendingFiles.push({ name: fname, size: text.length, type: 'text', mime: 'text/plain', content: body });
    updatePreview(); updateSendButtonState();
  }

  /* ═══════════ IMAGE VIEWER ═══════════ */
  function openImageViewer(url) {
    if (!url) return; __ivDataUrl = url;
    const iv = $('#imageViewer'); if (!iv) return;
    iv.classList.add('open');
    const img = new Image();
    img.onload = () => { const c = $('#ivCanvas'); if (!c) return; c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); };
    img.src = url;
  }
  function closeImageViewer() { $('#imageViewer')?.classList.remove('open'); }

  /* ═══════════ MODELS ═══════════ */
  function getModelsList() { return __config?.models?.length ? __config.models : FALLBACK_MODELS; }
  function canUseModel(tier) { if (__tier === 'free' && isBonusActive()) return true; if (tier === 'free') return true; if (__tier === 'ultimate') return true; if (__tier === 'pro' && tier === 'pro') return true; return false; }
  function modelAccessReason(tier) { if (__tier === 'free' && isBonusActive() && tier !== 'free') return 'bonus'; if (tier === 'free') return 'free'; if (__tier === 'ultimate' || (__tier === 'pro' && tier === 'pro')) return 'tier'; return 'locked'; }
  function tierLabel(tier) { return tier === 'free' ? 'FREE' : (tier === 'pro' ? 'PRO' : (tier === 'ultimate' ? 'ULT' : tier.toUpperCase())); }
  function renderModelPicker() {
    const menu = $('#modelPickerMenu'); if (!menu) return;
    const models = getModelsList(); const cur = __model || models[0].id;
    const bonusActive = __tier === 'free' && isBonusActive();
    let html = '';
    if (bonusActive) html += `<div class="model-picker-banner"><i class="ri-vip-crown-fill"></i><div class="model-picker-banner-text"><strong>All models unlocked</strong><span>Bonus active · ${formatBonusRemaining()} left</span></div></div>`;
    html += models.map((m) => {
      const usable = canUseModel(m.tier); const reason = modelAccessReason(m.tier); const isActive = m.id === cur;
      const reasonClass = usable ? (reason === 'bonus' ? 'via-bonus' : 'via-tier') : 'locked';
      const lockIcon = usable ? '' : '<i class="ri-lock-2-line model-option-lock"></i>';
      const bonusCrown = reason === 'bonus' ? '<i class="ri-vip-crown-fill model-option-crown"></i>' : '';
      const modelIcon = m.icon || 'ri-sparkling-2-line';
      return `<div class="model-option${isActive ? ' active' : ''}${usable ? '' : ' locked'} ${reasonClass}" data-model-id="${m.id}" data-usable="${usable}" data-tier="${m.tier}"><span class="model-option-icon"><i class="${modelIcon}"></i></span><span class="model-option-body"><span class="model-option-top"><span class="model-option-name">${escapeHtml(m.label)}</span><span class="model-tier-badge tier-${m.tier}">${tierLabel(m.tier)}</span>${bonusCrown}${lockIcon}</span><span class="model-option-tagline">${escapeHtml(m.tagline || '')}</span></span></div>`;
    }).join('');
    if (!bonusActive && __tier === 'free') html += `<div class="model-picker-cta" id="modelPickerShareCta"><i class="ri-gift-2-line"></i><span>Share to unlock <strong>Pro, Ultra &amp; Eclipse</strong> free for 7 days</span></div>`;
    menu.innerHTML = html;
    menu.querySelectorAll('.model-option').forEach((opt) => {
      opt.onclick = (e) => { e.stopPropagation(); if (opt.dataset.usable === 'false') { toast('Share to unlock this model'); closeModelPicker(); setTimeout(() => openShareAd(), 400); return; } selectModel(opt.dataset.modelId); };
    });
    const cta = menu.querySelector('#modelPickerShareCta');
    if (cta) cta.onclick = (e) => { e.stopPropagation(); closeModelPicker(); setTimeout(() => openShareAd(), 200); };
    const c = models.find((m) => m.id === cur);
    if (c) { const lbl = $('#currentModelLabel'); if (lbl) lbl.textContent = c.label; }
    const btn = $('#modelPickerBtn');
    if (btn) { btn.classList.toggle('has-bonus', bonusActive); btn.querySelector('.model-picker-crown')?.remove(); if (bonusActive) { const cr = document.createElement('i'); cr.className = 'ri-vip-crown-fill model-picker-crown'; btn.appendChild(cr); } }
  }
  function selectModel(id) { const m = getModelsList().find((x) => x.id === id); if (!m || !canUseModel(m.tier)) return; __model = id; const lbl = $('#currentModelLabel'); if (lbl) lbl.textContent = m.label; renderModelPicker(); closeModelPicker(); }
  function openModelPicker() { $('#modelPicker')?.classList.add('open'); $('#modelPickerMenu')?.classList.add('open'); renderModelPicker(); }
  function closeModelPicker() { $('#modelPicker')?.classList.remove('open'); $('#modelPickerMenu')?.classList.remove('open'); }

  /* ═══════════ USAGE ═══════════ */
  async function refreshUsage() {
    const res = await jsonOr('/api/me', {}, null, 7000);
    if (!res || !res.user) {
      __user = null; __tier = 'free';
      const label = $('#accountLabel'); if (label) label.textContent = 'Guest mode';
      const sb = $('#signInFromSettingsBtn'); if (sb) sb.style.display = '';
      const lo = $('#logoutBtn'); if (lo) lo.style.display = 'none';
      renderModelPicker(); updateTokenUsage(); return;
    }
    __user = res.user; __tier = res.user.tier || 'free';
    const label = $('#accountLabel'); if (label) label.textContent = res.user.name || res.user.email;
    const sb = $('#signInFromSettingsBtn'); if (sb) sb.style.display = 'none';
    const lo = $('#logoutBtn'); if (lo) lo.style.display = '';
    renderModelPicker(); updateTokenUsage();
  }
  async function loadConfig() {
    const data = await jsonOr('/api/config', {}, null, 7000);
    if (data && Array.isArray(data.models) && data.models.length) __config = data;
    if (!__config) __config = { models: FALLBACK_MODELS };
    __model = getModelsList()[0].id; renderModelPicker();
  }
  async function doLogin(e) { if (e) e.preventDefault(); const name = $('#loginName')?.value.trim(); const email = $('#loginEmail')?.value.trim().toLowerCase(); if (!name || !email) return; const res = await jsonOr('/api/auth/simple-login', { method: 'POST', body: JSON.stringify({ name, email }) }, null); if (res && res.ok) { setToken(res.token || ''); closeModal('loginModal'); await refreshUsage(); toast('Welcome, ' + name + '!'); } }
  async function doLogout() { await jsonOr('/api/logout', { method: 'POST' }, null); setToken(''); await refreshUsage(); closeModal('settingsModal'); toast('Signed out'); }
  async function loadPlans() {
    const grid = $('#plansGrid'); if (!grid) return;
    grid.innerHTML = '<div class="studio-empty">Loading…</div>';
    const res = await jsonOr('/api/subscription/plans', {}, null);
    if (!res || !Array.isArray(res.plans)) { grid.innerHTML = '<div class="studio-empty">Could not load plans.</div>'; return; }
    grid.innerHTML = res.plans.map((p) => { const price = p.id === 'free' ? '<div class="plan-price">Free</div>' : `<div class="plan-price">$${Number(p.price_usd).toFixed(2)}</div>`; return `<div class="plan-card${p.id === __tier ? ' current' : ''}"><div class="plan-name">${escapeHtml(p.label)}</div>${price}<ul class="plan-perks">${(p.perks || []).map((x) => `<li>✓ ${escapeHtml(x)}</li>`).join('')}</ul></div>`; }).join('');
  }
  async function genImage() {
    const prompt = $('#imagePrompt')?.value.trim(); if (!prompt) return;
    const btn = $('#generateImageBtn'), result = $('#imageResult');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ri-loader-4-line spin"></i> …'; }
    if (result) result.innerHTML = '<div class="studio-empty"><i class="ri-loader-4-line spin"></i> …</div>';
    try {
      const res = await netFetch('/v1/images/generations', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ prompt, guest_id: getGuestId() }) }, 90000);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok && data.image) { if (result) { result.innerHTML = `<img src="${data.image}" alt="">`; result.querySelector('img').onclick = () => openImageViewer(data.image); } }
      else { if (result) result.innerHTML = `<div class="studio-error">Failed</div>`; }
    } catch (e) { if (result) result.innerHTML = `<div class="studio-error">Error</div>`; }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ri-image-add-line"></i> Generate'; } }
  }

  /* ═══════════ BRIDGE ═══════════ */
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
  function openBridgeWorkspace() { $('#bridgeWorkspace')?.classList.add('open'); document.body.style.overflow = 'hidden'; if (!__bridge.connected) setTimeout(() => startBridge(), 50); }
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
  function addBridgeThinkingPanel(label, steps) { const c = $('#bridgeMessages'); if (!c) return null; $('#bridgeEmpty')?.remove(); const panel = createThinkPanel(label || 'Thinking', steps || []); panel.el.classList.add('bridge-think'); c.appendChild(panel.el); scrollBridgeBottom(); return panel; }
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
  function updateBridgeProgress(pct, text) { const newPct = Math.max(0, Math.min(100, Math.round(pct))); if (newPct > bridgeProgress) bridgeProgress = newPct; const bar = $('#bwProgress'), fill = $('#bwProgressFill'), pctEl = $('#bwProgressPct'); if (bar) bar.style.display = 'block'; if (fill) { fill.style.width = bridgeProgress + '%'; fill.classList.toggle('done', bridgeProgress >= 100); } if (pctEl) pctEl.textContent = bridgeProgress + '%'; if (text) setProgressText(text); }
  function extractBridgeCommands(text) {
    const cmds = []; const add = (type, mm, extra) => cmds.push(Object.assign({ type, index: mm.index }, extra));
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
    const t2 = cmd.type;
    if (t2 === 'sudo') { const sudo = await askSudo(cmd.command); if (!sudo || !sudo.password) return { ok: false, cancelled: true }; try { return await bridgeCall('/sudo-exec', { command: cmd.command, password: sudo.password, timeout: 120 }); } catch (e) { return { ok: false, error: e.message }; } }
    if (t2 === 'exec') return bridgeCall('/exec', { command: cmd.command });
    const map = { write: ['/write', { path: cmd.path, content: cmd.content }], append: ['/append', { path: cmd.path, content: cmd.content }], delete: ['/delete', { path: cmd.path }], read: ['/read', { path: cmd.path }], list: ['/list', { path: cmd.path }] };
    if (map[t2]) return bridgeCall(map[t2][0], map[t2][1]);
    return { ok: false, error: 'Unknown command' };
  }
  function formatResultForAI(cmd, result) {
    if (!result || !result.ok) return `[${cmd.type}] ERROR: ${(result && result.error) || 'unknown'}`;
    const trunc = (s, n = 3000) => String(s || '').slice(0, n);
    switch (cmd.type) {
      case 'sudo': case 'exec': return `[exec] exit=${result.exit_code}\nSTDOUT:\n${trunc(result.stdout)}\nSTDERR:\n${trunc(result.stderr, 1500)}`;
      case 'write': return `[write] ok path=${result.path} bytes=${result.bytes}`;
      case 'read': return `[read] path=${result.path}\n${trunc(result.content)}`;
      case 'list': return `[list] path=${result.path}\n` + (result.items || []).map((i) => (i.is_dir ? 'D ' : 'F ') + i.name).join('\n');
      default: return `[${cmd.type}] ok`;
    }
  }
  function newTurnState() { return { runs: 0, plannedFiles: new Set(), writtenFiles: new Set(), commandLog: new Map(), failedSignatures: new Set() }; }
  function cmdSignature(cmd) { const t2 = cmd.type; if (t2 === 'exec' || t2 === 'sudo') return t2 + ':' + (cmd.command || '').trim(); if (t2 === 'write' || t2 === 'append') return t2 + ':' + cmd.path + ':' + (cmd.content || '').length; return t2 + ':' + (cmd.path || ''); }
  function shouldBlockSignature(sig) { if (!bridgeTurn) return false; if (bridgeTurn.failedSignatures.has(sig)) return true; return (bridgeTurn.commandLog.get(sig) || 0) >= MAX_DUP_COMMANDS; }
  async function fetchBridgeReply(history) {
    const envBlock = buildEnvBlockString();
    const lastMsg = history[history.length - 1];
    const r = await netFetch('/v1/chat/completions', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ message: `${envBlock}\n\n${lastMsg.content}`, history: history.slice(0, -1).map((h) => ({ role: h.role, content: h.content })), model: 'mirox-luna-1.2', stream: false }) }, 120000);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
    return data.reply || '';
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  async function runBridgeTurn(userText, isResume = false) {
    if (!__bridge.connected) return;
    if (bridgeRunning) return;
    bridgeRunning = true; bridgeAbort = false; updateBridgeSendBtn();
    if (!isResume) {
      bridgeTaskComplete = false; bridgeWaitingForUser = false;
      bridgeTurn = newTurnState(); bridgeProgress = 0;
      updateBridgeProgress(2, 'Starting…');
      addBridgeUserMsg(userText);
      bridgeConversation.push({ role: 'user', content: `[System] Rules: use <bridge-write> for files, close tags. Reply DONE when finished.\n\n${userText}` });
    }
    let iter = 0, autoContinues = 0;
    try {
      while (iter++ < MAX_BRIDGE_ITER) {
        if (bridgeAbort) { addBridgeSystemMsg('Stopped.'); break; }
        bridgeTurn.runs++;
        const lastUser = bridgeConversation.filter((h) => h.role === 'user').slice(-1)[0];
        const userLast = lastUser?.content || '';
        const thinking = addBridgeThinkingPanel(pickStatusLabel(userLast), []);
        let reply = '';
        try { reply = await fetchBridgeReply(bridgeConversation); thinking?.finish(); }
        catch (e) { thinking?.fail('AI error: ' + e.message); break; }
        if (!reply || !reply.trim()) { if (autoContinues < MAX_AUTO_CONTINUES && __bridgeAutoRun) { autoContinues++; await sleep(600); bridgeConversation.push({ role: 'user', content: '[System] Continue.' }); continue; } break; }
        const cmdsInReply = extractBridgeCommands(reply);
        const saidDone = /\bDONE\b/i.test(reply);
        const truncatedWrite = hasUnclosedWriteOrAppend(reply);
        const lastPath = lastWriteOrAppendPath(reply);
        const narration = reply.replace(/<bridge-[^>]+>[\s\S]*?<\/bridge-[^>]+>/g, '').replace(/<bridge-[^>]+\s+[^>]*\/>/g, '').trim();
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
  function handleBridgeSend() { const inp = $('#bridgeInput'); if (!inp) return; const text = inp.value.trim(); if (!text || bridgeRunning || !__bridge.connected) return; if (bridgeWaitingForUser) { bridgeWaitingForUser = false; if (!bridgeTurn) bridgeTurn = newTurnState(); } else { bridgeConversation = []; bridgeTaskComplete = true; bridgeTurn = null; } inp.value = ''; inp.style.height = 'auto'; updateBridgeSendBtn(); runBridgeTurn(text, false); }
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
      if (frame) frame.srcdoc = r.content || '';
    } catch (e) { if (frame) frame.srcdoc = `<html><body style="font-family:system-ui;padding:40px;color:#b91c1c"><h2>Preview failed</h2><p>${escapeHtml(e.message)}</p></body></html>`; }
  }
  function closePreview() { $('#bwPreviewModal')?.classList.remove('open'); }

  /* ═══════════ MODALS ═══════════ */
  function openModal(id) { const el = document.getElementById(id); if (el) el.classList.add('open'); }
  function closeModal(id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); }
  function openSidebar() { $('#sidebar')?.classList.add('open'); $('#sidebarScrim')?.classList.add('open'); }
  function closeSidebar() { $('#sidebar')?.classList.remove('open'); $('#sidebarScrim')?.classList.remove('open'); }

  /* ═══════════ WIRING ═══════════ */
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
      inp.addEventListener('keydown', (e) => { const enterSend = __prefs.enterSend !== false; if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && enterSend) { e.preventDefault(); handleSend(); } });
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
    on('#searchModeBtn', 'click', (e) => { e.preventDefault(); forceSearchNext = !forceSearchNext; $('#searchModeBtn')?.classList.toggle('active', forceSearchNext); });
    on('#imageModeBtn', 'click', () => openModal('imageModal'));
    on('#plansModeBtn', 'click', () => { openModal('plansModal'); loadPlans(); });
    on('#supportModeBtn', 'click', (e) => { e.preventDefault(); openModal('supportModal'); });
    on('#supportModeBtn2', 'click', () => openModal('supportModal'));
    on('#bridgeModeBtn', 'click', openBridgeWorkspace);
    on('#bridgeOpenBtn', 'click', openBridgeWorkspace);
    on('#generateImageBtn', 'click', genImage);
    on('#submitReportBtn', 'click', () => { toast('Submitted!'); closeModal('supportModal'); });
    on('#settingsBtn', 'click', (e) => { e.preventDefault(); openSettingsModal(); });
    on('#logoutBtn', 'click', doLogout);
    on('#signInFromSettingsBtn', 'click', () => { closeModal('settingsModal'); openModal('loginModal'); });
    on('#shareFromSettingsBtn', 'click', () => { closeModal('settingsModal'); setTimeout(() => openShareAd(), 100); });

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

    // LANGUAGE SELECT — the main new feature
    on('#uiLanguageSelect', 'change', (e) => {
      __prefs.uiLanguage = e.target.value;
      savePrefs();
      applyTranslations();
      toast('Translating interface… this may take a moment');
    });
    on('#languageSelect', 'change', (e) => { __prefs.responseLanguage = e.target.value; savePrefs(); });

    on('#exportChatsBtn', 'click', () => {
      const blob = new Blob([JSON.stringify(__conversations, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `mirox-chats-${Date.now()}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); toast('Exported');
    });
    on('#clearChatsBtn', 'click', () => { if (!confirm('Clear all chats?')) return; __conversations = []; saveChats(); startNewChat(); toast('Cleared'); });
    on('#clearI18nCacheBtn', 'click', () => { __i18nCache = {}; saveI18nCache(); toast('Translation cache cleared'); });

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
    if (bwInp) { bwInp.addEventListener('input', () => { bwInp.style.height = 'auto'; bwInp.style.height = Math.min(bwInp.scrollHeight, 140) + 'px'; updateBridgeSendBtn(); }); bwInp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleBridgeSend(); } }); }
    on('#bridgeSendBtn', 'click', handleBridgeSend);
    $$('.bw-quick').forEach((btn) => { btn.onclick = () => { const inp2 = $('#bridgeInput'); if (inp2) { inp2.value = btn.dataset.q; updateBridgeSendBtn(); } handleBridgeSend(); }; });

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
        if ($('#bridgeWorkspace')?.classList.contains('open')) { closeBridgeWorkspace(); return; }
        if ($('#sudoModal')?.classList.contains('open')) { skipSudo(); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('#messageInput')?.focus(); }
    });
    window.addEventListener('resize', () => { if (window.innerWidth > 860) closeSidebar(); });
  }

  function openSettingsModal() { renderMcpListSafe(); applyPrefs(); openModal('settingsModal'); }
  function renderMcpListSafe() {} // placeholder for compatibility

  async function openConversation(id) {
    const convo = __conversations.find((c) => c.id === id);
    if (!convo) return;
    currentConversationId = id;
    const ttl = $('#chatTitle'); if (ttl) ttl.textContent = convo.title || 'Chat';
    const c = $('#chatMessages'); if (c) c.innerHTML = '';
    let lastAiEl = null, lastAiMessage = null;
    for (const m of convo.messages || []) {
      const img = m.imageKey ? await idb.get(m.imageKey).catch(() => null) : null;
      const rendered = addMessageToDOM(m.role, m.content, m.ts, m.id, m.files || [], img);
      if (m.role === 'assistant') { lastAiEl = rendered; lastAiMessage = m; }
    }
    if (lastAiEl && lastAiMessage) {
      const lastBubble = lastAiEl.querySelector('.bubble');
      if (lastBubble && shouldShowContinue(lastAiMessage.content || '', convo, true)) attachContinueButton(lastAiEl, lastBubble, lastAiMessage);
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
    return { async set(k, v) { const db = await open(); return new Promise((res, rej) => { const t2 = db.transaction('kv', 'readwrite'); t2.objectStore('kv').put(v, k); t2.oncomplete = () => res(true); t2.onerror = () => rej(t2.error); }); }, async get(k) { const db = await open(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); }); } };
  })();

  async function init() {
    try {
      loadPrefs();
      loadI18nCache();
      applyAppearanceFromPrefs();
      applyPrefs();
      loadShareState();
      loadChats();
      loadBridgeOpts();
      wireAll();
      __lastBonusActive = isBonusActive();
      renderHistory();
      renderModelPicker();
      renderBridgeStatus();
      startIdleMascot();
      updateTokenUsage();
      // Apply translations after DOM is wired
      applyTranslations();
    } catch (e) { console.error('[Mirox init]', e); }
    finally { killLoader(); }
    loadConfig().catch(() => {});
    refreshUsage().then(() => openShareAd()).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
