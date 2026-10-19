(function () {
  'use strict';

  /* ============================================================
     MiroxAI frontend v156
     · Kimi-inspired UI · KenSearch integration
     · Persona works with search · Plugins popover · My Mirox
     · Welcome brand uses logo.png + "Mirox AI" text
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
    { id: 'mirox-tail-r1', label: 'Tail r1', tier: 'free', tagline: 'Flagship · 350k context · strongest reasoning', icon: 'ri-star-smile-line' },
    { id: 'mirox-pro-5', label: 'Pro', tier: 'pro', tagline: 'Deeper reasoning', icon: 'ri-vip-diamond-line' },
    { id: 'mirox-ultra-10', label: 'Ultra', tier: 'pro', tagline: 'Long context', icon: 'ri-rocket-2-line' },
    { id: 'mirox-eclipse-2.0', label: 'Eclipse', tier: 'ultimate', tagline: 'High quality', icon: 'ri-sun-fill' },
  ];
  const LS_KEY = 'miroxai_conversations_v50';
  const REACTIONS_KEY = 'miroxai_reactions_v1';
  const DELETED_IMAGES_KEY = 'miroxai_deleted_images_v1';
  const TOKEN_KEY = 'mirox_token';
  const LOCAL_USER_KEY = 'mirox_local_user_v3';
  const GUEST_KEY = 'miroxai_guest_id_v1';
  const APPEARANCE_KEY = 'miroxai_appearance_v50';
  const PREFS_KEY = 'miroxai_prefs_v16';
  const LOCAL_SETTINGS_KEY = 'miroxai_local_settings_v2';
  const BRIDGE_OPTS_KEY = 'miroxai_bridge_opts_v1';
  const TAIL_PROMO_SEEN_KEY = 'miroxai_tail_promo_seen_v1';
  const GROWTH_KEY = 'mirox_growth_v1';
  const PLUGINS_KEY = 'miroxai_plugins_v1';
  const LIMIT_REACHED_KEY = 'miroxai_limit_reached_v1';
  const PASTE_ATTACH_THRESHOLD = 1024;
  const NET_TIMEOUT_MS = 15000;
  const STREAM_TIMEOUT_MS = 600000;
  const MAX_IMAGE_DIM = 1600;
  const MAX_TEXT_FILE_BYTES = 300000;
  const MAX_BRIDGE_ITER = 40;
  const MAX_AUTO_CONTINUES = 6;
  const MAX_DUP_COMMANDS = 3;
  const MAX_DUP_REPLIES = 2;
  const CALL_SILENCE_MS = 5000;
  const FREE_IMAGE_UPLOAD_CAP = 10;

  const APP_CHAT_URL   = '/v1/chat/completions';
  const APP_IMAGES_URL = '/v1/images/generations';

  const RESPONSE_QUALITY_NOTE = 'RESPONSE QUALITY: Give a genuinely useful, complete answer rather than an overly short reply. For explanations and open-ended questions, normally write several well-developed paragraphs with context, clear reasoning summaries, examples, and practical details when useful. Answer the exact question first, then expand enough that the user can understand the topic without needing to ask for basic missing details. Do not pad with repetition; use headings and bullets only when they improve readability. Match the requested length: if the user asks for detail, provide a long, thorough answer; if they ask for a simple answer, stay concise.';
  const IDEA_FORMAT_NOTE = 'IDEA-ANSWER FORMAT: Use a clean editorial layout with numbered options and short fit badges. Do not fetch or attach images unless explicitly requested.';
  const WEB_SEARCH_NOTE = 'WEB SEARCH MODE: Web search results were provided above. Use them. When you cite, use numbered references like [1], [2]. Prefer facts from the results over your own training data. If results conflict, note the conflict.';

  /* ---------- Plugin registry ---------- */
  const PLUGIN_REGISTRY = [
    { id: 'web',      name: 'Web Browsing',  desc: 'Fetch and read live web pages',       icon: 'ri-global-line',     enabled: true,  core: true },
    { id: 'search',   name: 'Web Search',    desc: 'Search the internet for fresh info',  icon: 'ri-search-line',     enabled: true,  core: true },
    { id: 'lumenal',  name: 'Lumenal Images', desc: 'Generate and edit images',           icon: 'ri-image-line',      enabled: true },
    { id: 'files',    name: 'Files',          desc: 'Read and analyze attached files',    icon: 'ri-file-text-line',  enabled: true,  core: true },
    { id: 'zip',      name: 'Archive Tools',  desc: 'Extract and inspect ZIP archives',   icon: 'ri-file-zip-line',   enabled: true },
    { id: 'tls',      name: 'TLS Inspector',  desc: 'Inspect public TLS certificates',    icon: 'ri-shield-keyhole-line', enabled: false },
    { id: 'memory',   name: 'Memory',         desc: 'Remember durable facts about you',   icon: 'ri-brain-line',      enabled: true },
    { id: 'call',     name: 'Voice Call',     desc: 'Live voice conversation mode',       icon: 'ri-phone-line',      enabled: true },
    { id: 'bridge',   name: 'Bridge',         desc: 'Control your desktop locally',       icon: 'ri-link',            enabled: IS_PC, pcOnly: true },
  ];

  let __config = null, __user = null, __tier = 'free', __model = 'mirox-luna-1.2';
  let currentConversationId = null, isReplying = false;
  let continuationBusy = false, streamRenderAt = 0, userIsAtBottom = true;
  let autoScrollEnabled = true;
  let __conversations = [], pendingFiles = [], activeStreamController = null;
  let forceSearchNext = false, __historyQuery = '';
  let __ivDataUrl = '';
  let __prefs = {};
  let __reactions = {};
  let __imageHistoryItems = [];
  let __plugins = {};
  let __limitReached = false;
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
  let __imageHistoryLoading = false;
  let __currentRawSource = '';
  let __call = { active: false, lang: 'en-US', phase: 'idle', recog: null, shouldListen: false, holding: false, currentAbort: null, currentHistory: [], busy: false, capturedText: '' };
  let __currentSpeakMsgId = null;
  let __growth = { days: {}, totalMessages: 0, totalChats: 0, createdAt: Date.now() };

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
  const DEFAULT_PREFS = { autoScroll: true, enterSend: true, vision: true, compact: false, reduceMotion: false, fontSize: 'md', mode: 'light', theme: 'default', responseLanguage: 'auto', uiLanguage: 'en', deepThink: false, autoSpeak: false, ttsVoice: '', selfGrowth: false };
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
    syncChk('autoSpeakToggle', __prefs.autoSpeak);
    $$('#modeSegmented .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === (__prefs.mode || 'light')));
    $$('#fontSizeSegmented .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.fontsize === (__prefs.fontSize || 'md')));
    $$('#accentSwatches .swatch').forEach((b) => b.classList.toggle('active', b.dataset.theme === (__prefs.theme || 'default')));
    const uiSel = document.getElementById('uiLanguageSelect');
    if (uiSel && uiSel.value !== (__prefs.uiLanguage || 'en')) uiSel.value = __prefs.uiLanguage || 'en';
    const langSel = document.getElementById('languageSelect');
    if (langSel && langSel.value !== (__prefs.responseLanguage || 'auto')) langSel.value = __prefs.responseLanguage || 'auto';
    applyDeepThinkUI();
    updateModePill();
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
    if (inp) inp.placeholder = __prefs.deepThink ? 'DeepThink is on — ask anything complex…' : 'Ask anything, or task an agent…';
  }

  /* ---------- Mode pill ---------- */
  function updateModePill() {
    const pill = document.getElementById('modePill');
    const val = document.getElementById('modePillValue');
    if (!pill || !val) return;
    const deep = !!__prefs.deepThink && !__limitReached;
    const web  = !!forceSearchNext;
    if (deep && web)  { pill.firstChild.textContent = 'Agent '; val.textContent = 'Deep + Web'; }
    else if (deep)     { pill.firstChild.textContent = 'Agent '; val.textContent = 'Deep'; }
    else if (web)      { pill.firstChild.textContent = 'Instant '; val.textContent = 'Web'; }
    else               { pill.firstChild.textContent = 'Instant '; val.textContent = 'Standard'; }
  }

  /* ---------- Quota row ---------- */
  function showQuotaRow(text) {
    const row = document.getElementById('quotaRow');
    const t = document.getElementById('quotaText');
    if (row) row.style.display = '';
    if (t && text) t.textContent = text;
  }
  function hideQuotaRow() {
    const row = document.getElementById('quotaRow');
    if (row) row.style.display = 'none';
  }
  function markLimitReached(reason) {
    __limitReached = true;
    safeSet(LIMIT_REACHED_KEY, { at: Date.now(), reason });
    if (__tier === 'free') {
      __prefs.deepThink = false;
      savePrefs();
      applyDeepThinkUI();
      toast('Free tier limit reached — switched to Instant mode.', 4000, 'err');
    }
    showQuotaRow(reason || 'Free quota used up');
    updateModePill();
  }

  function loadReactions() { __reactions = safeGet(REACTIONS_KEY, {}); if (typeof __reactions !== 'object' || !__reactions) __reactions = {}; }
  function saveReactions() { safeSet(REACTIONS_KEY, __reactions); }

  /* ---------- Plugins ---------- */
  function loadPlugins() {
    const saved = safeGet(PLUGINS_KEY, {});
    __plugins = {};
    for (const p of PLUGIN_REGISTRY) {
      __plugins[p.id] = typeof saved[p.id] === 'boolean' ? saved[p.id] : !!p.enabled;
    }
    for (const p of PLUGIN_REGISTRY) if (p.core) __plugins[p.id] = true;
    if (!IS_PC) __plugins.bridge = false;
  }
  function savePlugins() { safeSet(PLUGINS_KEY, __plugins); }
  function pluginEnabled(id) { return !!__plugins[id]; }
  function renderPluginsList() {
    const list = document.getElementById('pluginsList');
    if (!list) return;
    list.innerHTML = PLUGIN_REGISTRY.map((p) => {
      if (p.pcOnly && !IS_PC) return '';
      const on = pluginEnabled(p.id);
      const lock = p.core ? '' : '';
      return `<div class="plugins-item${on ? ' on' : ''}" data-plugin-id="${p.id}" ${p.core ? 'data-core="1"' : ''}>
        <div class="plugins-item-icon"><i class="${p.icon}"></i></div>
        <div class="plugins-item-body">
          <div class="plugins-item-name">${escapeHtml(p.name)}${p.core ? ' <span style="font-size:10px;color:var(--text-faint);font-weight:500;">· core</span>' : ''}</div>
          <div class="plugins-item-desc">${escapeHtml(p.desc)}</div>
        </div>
        <div class="plugins-item-toggle"></div>${lock}
      </div>`;
    }).join('');
    list.querySelectorAll('.plugins-item').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation();
        if (el.dataset.core === '1') { toast('This plugin is always on.', 1600); return; }
        const id = el.dataset.pluginId;
        __plugins[id] = !__plugins[id];
        savePlugins();
        el.classList.toggle('on', __plugins[id]);
        toast(`${PLUGIN_REGISTRY.find((p) => p.id === id)?.name || 'Plugin'} ${__plugins[id] ? 'enabled' : 'disabled'}`, 1500, __plugins[id] ? 'ok' : '');
      };
    });
  }
  function openPluginsPopover() {
    const pop = document.getElementById('pluginsPopover');
    if (!pop) return;
    renderPluginsList();
    pop.classList.add('open');
    pop.setAttribute('aria-hidden', 'false');
  }
  function closePluginsPopover() {
    const pop = document.getElementById('pluginsPopover');
    if (!pop) return;
    pop.classList.remove('open');
    pop.setAttribute('aria-hidden', 'true');
  }
  function togglePluginsPopover() {
    const pop = document.getElementById('pluginsPopover');
    if (!pop) return;
    if (pop.classList.contains('open')) closePluginsPopover(); else openPluginsPopover();
  }

  /* ---------- Growth ---------- */
  function loadGrowth() {
    const g = safeGet(GROWTH_KEY, null);
    if (g && typeof g === 'object') __growth = Object.assign(__growth, g);
    if (!__growth.days || typeof __growth.days !== 'object') __growth.days = {};
    if (typeof __growth.totalMessages !== 'number') __growth.totalMessages = 0;
    if (typeof __growth.totalChats !== 'number') __growth.totalChats = 0;
  }
  function saveGrowth() { safeSet(GROWTH_KEY, __growth); }
  function recordGrowth(messageCount = 1) {
    const d = new Date().toISOString().slice(0, 10);
    __growth.days[d] = (__growth.days[d] || 0) + messageCount;
    __growth.totalMessages += messageCount;
    __growth.totalChats = (__conversations || []).length;
    saveGrowth();
  }
  function closenessLevel() {
    const m = __growth.totalMessages;
    if (m >= 500) return { label: 'Inseparable', icon: 'ri-heart-3-fill', pct: 100 };
    if (m >= 250) return { label: 'Very close',  icon: 'ri-heart-3-line', pct: 80 };
    if (m >= 100) return { label: 'Close',       icon: 'ri-heart-2-line', pct: 60 };
    if (m >= 40)  return { label: 'Friendly',    icon: 'ri-heart-line',   pct: 40 };
    if (m >= 10)  return { label: 'Warming up',  icon: 'ri-seedling-line', pct: 20 };
    return { label: 'Just met', icon: 'ri-sparkling-2-line', pct: 5 };
  }
  function activeDaysCount() { return Object.keys(__growth.days || {}).length; }
  function streakCount() {
    const days = Object.keys(__growth.days || {}).sort();
    if (!days.length) return 0;
    let streak = 0;
    const d = new Date(); d.setHours(0, 0, 0, 0);
    for (let i = 0; i < 400; i++) {
      const key = d.toISOString().slice(0, 10);
      if (__growth.days[key]) { streak++; d.setDate(d.getDate() - 1); }
      else break;
    }
    return streak;
  }
  function renderMyMirox() {
    const root = document.getElementById('myMiroxBody');
    if (!root) return;
    const lvl = closenessLevel();
    const streak = streakCount();
    const active = activeDaysCount();
    const userLabel = (__user?.name ? `${__user.name}'s Mirox` : 'Your Mirox');
    const COLS = 48, ROWS = 8;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (COLS * 7 - 1));
    start.setDate(start.getDate() - start.getDay());
    const cells = [];
    for (let col = 0; col < COLS; col++) {
      for (let row = 0; row < ROWS; row++) {
        const d = new Date(start);
        d.setDate(d.getDate() + col * 7 + row);
        const key = d.toISOString().slice(0, 10);
        const c = __growth.days[key] || 0;
        const lvl2 = c === 0 ? 0 : c < 3 ? 1 : c < 8 ? 2 : c < 20 ? 3 : 4;
        const disabled = d > today;
        cells.push(`<div class="mm-cell lvl-${lvl2}" title="${key} · ${c} messages" style="${disabled ? 'opacity:.35;' : ''}"></div>`);
      }
    }
    const gridHTML = cells.join('');
    const months = ['Nov','Dec','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct'];
    const monthLabels = `<div class="mm-month-labels">${months.map((m) => `<span>${m}</span>`).join('')}</div>`;
    const DOT_N = 12;
    let dotHTML = '';
    for (let y = 0; y < DOT_N; y++) for (let x = 0; x < DOT_N; x++) {
      const dx = x - (DOT_N - 1) / 2, dy = y - (DOT_N - 1) / 2;
      const r = Math.sqrt(dx * dx + dy * dy) / (DOT_N / 2);
      const isOn = r < 0.42, isMid = r >= 0.42 && r < 0.7;
      dotHTML += `<span class="mm-dot${isOn ? ' on' : isMid ? ' mid' : ''}" style="animation-delay:${(x + y) * 30}ms"></span>`;
    }
    root.innerHTML = `
      <div class="mm-header">
        <div class="mm-avatar"><i class="ri-sparkling-2-fill"></i></div>
        <div class="mm-title-wrap">
          <div class="mm-title">${escapeHtml(userLabel)}</div>
          <div class="mm-subtitle">Mirox has been with you for <strong>${active}</strong> day${active === 1 ? '' : 's'} across <strong>${__growth.totalChats}</strong> chat${__growth.totalChats === 1 ? '' : 's'}, and we've chatted <strong>${streak}</strong> day${streak === 1 ? '' : 's'} in a row</div>
        </div>
        <button class="mm-self-growth-btn" type="button" id="mmEnableGrowth"><i class="ri-flashlight-fill"></i><span>Enable self-growth</span></button>
      </div>
      <div class="mm-tabs"><button class="mm-tab active" type="button">Closeness</button><button class="mm-tab" type="button">Growth</button></div>
      <div class="mm-tab-hint">The more you chat or assign tasks, the closer you grow</div>
      <div class="mm-heat-block"><div class="mm-heat-grid">${gridHTML}</div>${monthLabels}</div>
      <div class="mm-growth-grid">
        <div class="mm-growth-left">
          <h3>Mirox can now learn and grow on its own</h3>
          <p>Once enabled, Mirox keeps learning your preferences, habits, and ways of working, making every collaboration the start of the next one.</p>
          <button class="mm-self-growth-btn" type="button" id="mmEnableGrowth2"><i class="ri-flashlight-fill"></i><span>Enable self-growth</span></button>
        </div>
        <div class="mm-dotmatrix">${dotHTML}</div>
      </div>`;
    const enable = () => { __prefs.selfGrowth = true; savePrefs(); toast('Self-growth enabled.', 2600, 'ok'); };
    root.querySelector('#mmEnableGrowth')?.addEventListener('click', enable);
    root.querySelector('#mmEnableGrowth2')?.addEventListener('click', enable);
    root.querySelectorAll('.mm-tab').forEach((t) => t.addEventListener('click', () => {
      root.querySelectorAll('.mm-tab').forEach((x) => x.classList.toggle('active', x === t));
    }));
  }

  /* ---------- Confetti ---------- */
  function fireConfetti() {
    const colors = ['#d97757','#f0a184','#4d6bfe','#16a34a','#9333ea','#e11d48','#fbbf24','#0284c7'];
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99999;overflow:hidden;';
    document.body.appendChild(host);
    const N = 140;
    for (let i = 0; i < N; i++) {
      const p = document.createElement('div');
      const size = 6 + Math.random() * 9;
      const color = colors[(Math.random() * colors.length) | 0];
      const x = Math.random() * 100;
      const drift = (Math.random() - 0.5) * 500;
      const dur = 2200 + Math.random() * 1800;
      const delay = Math.random() * 300;
      const rot = 360 + Math.random() * 1080;
      const shape = Math.random() > 0.55 ? '50%' : '2px';
      p.style.cssText = `position:absolute;left:${x}%;top:-20px;width:${size}px;height:${size * (0.6 + Math.random() * 0.9)}px;background:${color};border-radius:${shape};opacity:0;--drift:${drift}px;--rot:${rot}deg;animation:confettiFall ${dur}ms cubic-bezier(.22,.68,.42,1) ${delay}ms forwards;`;
      host.appendChild(p);
    }
    setTimeout(() => host.remove(), 5200);
  }

  /* ---------- TTS ---------- */
  const ttsAvailable = typeof window !== 'undefined' && 'speechSynthesis' in window;
  let __voices = [];
  function loadVoices() {
    if (!ttsAvailable) return;
    __voices = speechSynthesis.getVoices() || [];
    const sel = document.getElementById('ttsVoiceSelect');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">Auto (match language)</option>';
    for (const v of __voices) { const opt = document.createElement('option'); opt.value = v.name; opt.textContent = `${v.name} — ${v.lang}${v.default ? ' · default' : ''}`; sel.appendChild(opt); }
    if (__prefs.ttsVoice) sel.value = __prefs.ttsVoice;
    else if (cur) sel.value = cur;
  }
  if (ttsAvailable) { speechSynthesis.onvoiceschanged = loadVoices; setTimeout(loadVoices, 250); setTimeout(loadVoices, 900); }
  function pickVoiceForLang(lang) {
    if (!ttsAvailable) return null;
    if (__prefs.ttsVoice) { const v = __voices.find((x) => x.name === __prefs.ttsVoice); if (v) return v; }
    const norm = String(lang || '').toLowerCase();
    let v = __voices.find((x) => String(x.lang || '').toLowerCase() === norm); if (v) return v;
    const primary = norm.split('-')[0];
    v = __voices.find((x) => String(x.lang || '').toLowerCase().startsWith(primary + '-')); if (v) return v;
    return __voices.find((x) => String(x.lang || '').toLowerCase() === primary) || null;
  }
  function stopSpeaking() {
    if (!ttsAvailable) return;
    try { speechSynthesis.cancel(); } catch {}
    __currentSpeakMsgId = null;
    $$('.action-btn.speaking').forEach((b) => b.classList.remove('speaking'));
  }
  function speak(text, lang, msgId) {
    if (!ttsAvailable) { toast('Text-to-speech not supported.', 3000, 'err'); return Promise.resolve(); }
    return new Promise((resolve) => {
      stopSpeaking();
      const clean = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
      if (!clean) return resolve();
      const parts = []; let buf = '';
      for (const s of clean.split(/(?<=[.!?。！？])\s+/)) {
        if ((buf + ' ' + s).length > 220) { if (buf) parts.push(buf); buf = s; } else buf = buf ? buf + ' ' + s : s;
      }
      if (buf) parts.push(buf);
      if (!parts.length) return resolve();
      const voice = pickVoiceForLang(lang || __prefs.responseLanguage || 'en');
      let i = 0;
      __currentSpeakMsgId = msgId || null;
      if (msgId) { const btn = document.querySelector(`.message[data-msg-id="${msgId}"] .action-btn[data-action="speak"]`); if (btn) btn.classList.add('speaking'); }
      let done = false;
      const finish = () => { if (done) return; done = true; if (msgId) { const btn = document.querySelector(`.message[data-msg-id="${msgId}"] .action-btn[data-action="speak"]`); if (btn) btn.classList.remove('speaking'); } __currentSpeakMsgId = null; resolve(); };
      const next = () => { if (i >= parts.length) return finish(); const u = new SpeechSynthesisUtterance(parts[i++]); if (voice) u.voice = voice; u.lang = (voice && voice.lang) || lang || 'en-US'; u.rate = 1; u.pitch = 1; u.volume = 1; u.onend = next; u.onerror = next; try { speechSynthesis.speak(u); } catch { next(); } };
      next();
      setTimeout(finish, Math.max(3000, clean.length * 95));
    });
  }

  /* ---------- Mascot ---------- */
  const MOODS = ['idle','happy','thinking','coding','celebrate','error','learning','wink','study','searching','reading'];
  function blobSvg() {
    return `<svg class="blob-svg" viewBox="0 0 200 180" xmlns="http://www.w3.org/2000/svg"><g class="blob-float"><rect class="leg leg-1" x="46" y="126" width="14" height="32" rx="7"/><rect class="leg leg-2" x="76" y="126" width="14" height="32" rx="7"/><rect class="leg leg-3" x="110" y="126" width="14" height="32" rx="7"/><rect class="leg leg-4" x="140" y="126" width="14" height="32" rx="7"/><rect class="blob-body" x="20" y="30" width="160" height="110" rx="26"/><g class="blob-eyes"><rect class="eye eye-left" x="62" y="64" width="18" height="34" rx="9"/><rect class="eye eye-right" x="120" y="64" width="18" height="34" rx="9"/></g><g class="blob-glasses" fill="none" stroke="var(--blob-eye)" stroke-width="4" stroke-linecap="round"><rect x="50" y="52" width="44" height="46" rx="12"/><rect x="106" y="52" width="44" height="46" rx="12"/><path d="M94 72 Q100 68 106 72"/></g></g></svg>`;
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
    root.querySelectorAll('.mascot').forEach((el) => { el.className = el.className.split(' ').filter((c) => !/^m-/.test(c)).join(' '); el.classList.add('m-' + m); el.dataset.mood = m; });
  }
  upgradeStaticMascots();

  /* ---------- Thinking-leak scrubber ---------- */
  function stripThinkingLeak(s) {
    let out = String(s == null ? '' : s);
    out = out.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
    const lastOpen = out.lastIndexOf('<thinking>');
    if (lastOpen >= 0 && out.indexOf('</thinking>', lastOpen) === -1) out = out.slice(0, lastOpen);
    out = out.replace(/<\/?thinking>/g, '');
    const lastLt = out.lastIndexOf('<');
    if (lastLt >= 0) { const tail = out.slice(lastLt); if (['<thinking>','</thinking>'].some((c) => c.toLowerCase().startsWith(tail.toLowerCase()) && tail.length < c.length)) out = out.slice(0, lastLt); }
    out = out.replace(/^\s*thought\s+for\s+\d+(?:\.\d+)?\s*s\s*/im, '');
    out = out.replace(/^\s*\d+(?:\.\d+)?s\s*$/gm, '');
    out = out.replace(/^\s*(?:thought|reasoning|analysis)\s*:\s*/im, '');
    const NARRATION = [
      /^\s*it\s+seems\s+(?:there\s+was\s+)?(?:an?\s+)?(?:issue|problem|error|difficulty)[^\n.!?]*[.!?]?\s*/gim,
      /^\s*let\s+me\s+try\s+again[^\n.!?]*[.!?]?\s*/gim,
      /^\s*i[''']ll\s+(?:attempt\s+to\s+|try\s+to\s+|now\s+)?(?:extract|inspect|open|read|load|check|look\s+at|look\s+inside|unzip|analyse|analyze|review|fetch|download|search|browse|process|parse|scan|verify|test|write|create|run|execute|use|call)[^\n.!?]*[.!?]?\s*/gim,
      /^\s*i[''']m\s+going\s+to\s+[^\n.!?]*[.!?]?\s*/gim,
      /^\s*i\s+will\s+(?:now\s+)?(?:attempt\s+to\s+)?(?:extract|inspect|open|read|load|check|look|unzip|analyse|analyze|review|fetch|download|search|browse|process|parse|scan|verify|test|write|create|run|execute|use|call)[^\n.!?]*[.!?]?\s*/gim,
      /^\s*let\s+me\s+(?:first\s+)?(?:extract|inspect|open|read|load|check|look\s+at|look\s+inside|unzip|analyse|analyze|review|fetch|download|search|browse|process|parse|scan|verify|test|write|create|run|execute|use|call)[^\n.!?]*[.!?]?\s*/gim,
      /^\s*i[''']ve\s+(?:extracted|inspected|opened|read|loaded|checked|analy|unzipped|reviewed|fetched|downloaded|searched|browsed|processed|parsed|scanned|verified|tested|written|created|run|executed|used|called)[^\n.!?]*[.!?]?\s*/gim,
      /^\s*i\s+need\s+to\s+(?:extract|inspect|open|read|load|check|look|unzip|analyse|analyze|review|fetch|download|search|browse|process|parse|scan|verify|test|write|create|run|execute|use|call)[^\n.!?]*[.!?]?\s*/gim,
      /^\s*now\s+that\s+the\s+(?:file|zip|archive|content|image|pdf)[^\n.!?]*[.!?]?\s*/gim,
      /^\s*here[''']s\s+what\s+i\s+found[^\n.!?]*[.!?]?\s*/gim,
      /^\s*(?:ok(?:ay)?|alright|sure|got\s+it)[,.]\s+(?:i[''']ve|i[''']ll|let\s+me|i\s+will)[^\n.!?]*[.!?]?\s*/gim,
      /^\s*using\s+the\s+[^\n.!?]{1,60}?\s+tool[^\n.!?]*[.!?]?\s*/gim,
      /^\s*i\s+will\s+use\s+the\s+[^\n.!?]{1,60}?\s+tool[^\n.!?]*[.!?]?\s*/gim,
      /^\s*let\s+me\s+use\s+[^\n.!?]*[.!?]?\s*/gim,
      /^\s*i[''']ll\s+now\s+use\s+[^\n.!?]*[.!?]?\s*/gim,
      /^\s*proceeding\s+to\s+[^\n.!?]*[.!?]?\s*/gim,
      /^\s*next[,]?\s+i[''']ll\s+[^\n.!?]*[.!?]?\s*/gim,
      /^\s*first[,]?\s+(?:i[''']ll|let\s+me)\s+[^\n.!?]*[.!?]?\s*/gim,
      /^\s*based\s+on\s+the\s+(?:tool\s+)?(?:result|output)[^\n.!?]*[.!?]?\s*/gim,
      /^\s*the\s+tool\s+(?:returned|reported|showed|gave)[^\n.!?]*[.!?]?\s*/gim,
      /^\s*i[''']ve\s+successfully\s+[^\n.!?]*[.!?]?\s*/gim,
      /^\s*successfully\s+(?:extracted|read|loaded|opened|unzipped|created|written|run|executed)[^\n.!?]*[.!?]?\s*/gim,
    ];
    for (const re of NARRATION) out = out.replace(re, '');
    out = out.replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '');
    return out;
  }

  /* ---------- Thinking panel ---------- */
  const __toolHistory = new WeakMap();
  function humanizeToolName(name) {
    const map = { 'extract_zip': 'Extracting archive', 'make_zip': 'Creating archive', 'read_file': 'Reading file', 'write_file': 'Writing file', 'append_file': 'Appending to file', 'list_files': 'Listing files', 'create_directory': 'Creating folder', 'search_files': 'Searching files', 'workspace_info': 'Checking workspace', 'fetch_url': 'Fetching URL', 'inspect_tls': 'Inspecting TLS certificate', 'remember': 'Saving memory', 'run_command': 'Running command' };
    if (map[name]) return map[name];
    return String(name || 'tool').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  function renderToolStatus(_msgEl, tool, thinkPanel) {
    if (!thinkPanel || !thinkPanel.isConnected()) return;
    const name = humanizeToolName(tool.name || 'tool');
    const status = String(tool.status || 'running');
    if (!__toolHistory.has(thinkPanel.el)) __toolHistory.set(thinkPanel.el, []);
    const hist = __toolHistory.get(thinkPanel.el);
    if (status === 'running') thinkPanel.setStatus('Running ' + name + '…');
    else if (status === 'done') { if (!hist.includes(name)) hist.push(name); thinkPanel.setStatus('Reading results…'); }
    else if (status === 'error') thinkPanel.setStatus('Tool failed — retrying…');
    thinkPanel.setFinalSuffix(hist.length ? hist.join(' · ') : '');
  }
  function createThinkPanel(_deep) {
    const el = document.createElement('div');
    el.className = 'think-panel';
    el.dataset.state = 'thinking';
    el.innerHTML = `<div class="think-header"><div class="think-icon"><i class="ri-loader-4-line"></i></div><div class="think-title"><span class="think-title-text">Thinking</span></div><div class="think-timer-pill">0.0s</div></div>`;
    const titleTextEl = el.querySelector('.think-title-text');
    const timerPill = el.querySelector('.think-timer-pill');
    const iconEl = el.querySelector('.think-icon i');
    const t0 = performance.now();
    let done = false, finalSuffix = '';
    const timer = setInterval(() => { if (done) { clearInterval(timer); return; } timerPill.textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's'; }, 100);
    function setStatus(text) { if (done) return; if (text) titleTextEl.textContent = text; }
    function setFinalSuffix(t) { finalSuffix = t || ''; }
    function finalize() { if (done) return; done = true; clearInterval(timer); const secs = ((performance.now() - t0) / 1000).toFixed(1); timerPill.style.display = 'none'; iconEl.className = 'ri-checkbox-circle-fill'; el.dataset.state = 'done'; titleTextEl.textContent = 'Thought for ' + secs + 's' + (finalSuffix ? '  ·  ' + finalSuffix : ''); }
    function fail() { if (done) return; done = true; clearInterval(timer); timerPill.style.display = 'none'; iconEl.className = 'ri-error-warning-fill'; el.dataset.state = 'failed'; titleTextEl.textContent = 'Thinking stopped'; }
    function hide() { el.style.display = 'none'; done = true; clearInterval(timer); }
    return { el, replaceText: () => {}, setStatus, setFinalSuffix, finalize, fail, hide, isConnected: () => el.isConnected, destroy: () => clearInterval(timer) };
  }

  /* ---------- Watermark ---------- */
  function paintWatermark(canvas, img) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.drawImage(img, 0, 0, W, H);
    const minDim = Math.min(W, H);
    const textSize = Math.max(9, Math.round(minDim * 0.020));
    const pad = Math.max(6, Math.round(minDim * 0.012));
    const blobR = textSize * 0.55;
    const blobW = blobR * 2, blobH = blobR * 1.7;
    const bx = pad + blobR, by = H - pad - blobR;
    const gradH = textSize * 1.8;
    const grad = ctx.createLinearGradient(0, H - gradH, 0, H);
    grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,0.16)');
    ctx.fillStyle = grad; ctx.fillRect(0, H - gradH, W, gradH);
    ctx.save();
    ctx.globalAlpha = 0.72; ctx.fillStyle = '#d97757';
    const r = blobR * 0.5;
    const bxL = bx - blobR, byT = by - blobR * 0.85;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(bxL, byT, blobW, blobH, r);
    else { ctx.moveTo(bxL + r, byT); ctx.lineTo(bxL + blobW - r, byT); ctx.quadraticCurveTo(bxL + blobW, byT, bxL + blobW, byT + r); ctx.lineTo(bxL + blobW, byT + blobH - r); ctx.quadraticCurveTo(bxL + blobW, byT + blobH, bxL + blobW - r, byT + blobH); ctx.lineTo(bxL + r, byT + blobH); ctx.quadraticCurveTo(bxL, byT + blobH, bxL, byT + blobH - r); ctx.lineTo(bxL, byT + r); ctx.quadraticCurveTo(bxL, byT, bxL + r, byT); ctx.closePath(); }
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    const eyeW = blobR * 0.24, eyeH = blobR * 0.66;
    ctx.fillRect(bx - blobR * 0.45, by - blobR * 0.30, eyeW, eyeH);
    ctx.fillRect(bx + blobR * 0.20, by - blobR * 0.30, eyeW, eyeH);
    ctx.font = `700 ${textSize}px Inter, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = Math.max(2, textSize * 0.18); ctx.shadowOffsetY = 0.8;
    const tx = bx + blobR + textSize * 0.5, ty = by + textSize * 0.02;
    ctx.fillText('Mirox AI', tx, ty);
    ctx.shadowBlur = Math.max(2, textSize * 0.12);
    ctx.font = `500 ${Math.round(textSize * 0.58)}px Inter, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.fillText('miroxai.org', tx, ty + textSize * 0.78);
    ctx.restore();
  }
  function watermarkedDataUrl(srcDataUrl) {
    return new Promise((resolve) => {
      if (!srcDataUrl) return resolve('');
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => { try { const c = document.createElement('canvas'); c.width = img.naturalWidth || 1024; c.height = img.naturalHeight || 1024; paintWatermark(c, img); resolve(c.toDataURL('image/png')); } catch { resolve(srcDataUrl); } };
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

  /* ---------- Image history ---------- */
  function updateImageCountLabel() { const el = $('#sidebarImagesCount'); if (!el) return; const n = __imageHistoryItems.length; el.textContent = n === 0 ? 'No images' : (n === 1 ? '1 image' : `${n} images`); const d = $('#sidebarImagesDeleteAll'); if (d) d.disabled = n === 0; }
  function readDeletedImageIds() { const ids = safeGet(DELETED_IMAGES_KEY, []); return new Set(Array.isArray(ids) ? ids.map(String) : []); }
  function writeDeletedImageIds(ids) { safeSet(DELETED_IMAGES_KEY, [...new Set(Array.from(ids, String))].slice(-500)); }
  function imageHistoryIds(it, i = 0) { const s = it && (it.id || it.key || it.image_id || it.imageKey); const f = 'img-' + String(it && (it.ts || it.created_at || it.prompt) || 'unknown') + '-' + i; return [s, it && it.id, it && it.key, f].filter(Boolean).map(String); }
  async function loadImageHistory() {
    const grid = $('#sidebarImageHistory'); if (!grid || __imageHistoryLoading) return;
    __imageHistoryLoading = true;
    grid.innerHTML = '<div class="sidebar-image-empty"><i class="ri-loader-4-line spin"></i> Loading…</div>';
    try {
      const res = await netFetch('/api/images/history', { method: 'GET' }, 12000);
      if (res.status === 401) { __imageHistoryItems = []; grid.innerHTML = '<div class="sidebar-image-empty">Sign in to see your images.</div>'; updateImageCountLabel(); return; }
      if (!res.ok) throw new Error();
      const data = await res.json().catch(() => null);
      const images = (data && Array.isArray(data.images)) ? data.images : [];
      const deleted = readDeletedImageIds();
      const mapped = images.map((it, i) => ({ ...it, _id: String(it.id || it.key || it.image_id || ('img-' + String(it.ts || it.created_at || it.prompt || 'unknown') + '-' + i)), _historyIds: imageHistoryIds(it, i) }));
      __imageHistoryItems = mapped.filter(it => !it._historyIds.some(id => deleted.has(id)));
      const stillReturned = new Set(mapped.flatMap(it => it._historyIds));
      writeDeletedImageIds([...deleted].filter(id => stillReturned.has(id)));
      renderImageGrid(); updateImageCountLabel();
    } catch { if (!__imageHistoryItems.length) grid.innerHTML = '<div class="sidebar-image-empty">Could not load images.</div>'; updateImageCountLabel(); }
    finally { __imageHistoryLoading = false; }
  }
  function renderImageGrid() {
    const grid = $('#sidebarImageHistory'); if (!grid) return;
    if (!__imageHistoryItems.length) { grid.innerHTML = '<div class="sidebar-image-empty"><i class="ri-image-line"></i> No images yet.</div>'; return; }
    grid.innerHTML = '';
    __imageHistoryItems.slice(0, 60).forEach((it, idx) => {
      const item = document.createElement('div'); item.className = 'sidebar-image-item'; item.title = it.prompt || 'Generated image'; item.dataset.idx = String(idx);
      const img = document.createElement('img'); img.src = it.image; img.alt = it.prompt || 'generated image'; img.loading = 'lazy'; img.onerror = () => { item.style.display = 'none'; }; item.appendChild(img);
      const del = document.createElement('button'); del.type = 'button'; del.className = 'sidebar-image-delete'; del.title = 'Delete image'; del.innerHTML = '<i class="ri-delete-bin-line"></i>'; del.onclick = (e) => { e.stopPropagation(); e.preventDefault(); deleteImageAt(idx); }; item.appendChild(del);
      item.onclick = () => openImageViewer(it.image);
      grid.appendChild(item);
    });
  }
  async function deleteImageAt(idx) {
    const it = __imageHistoryItems[idx]; if (!it) return;
    const ids = new Set(readDeletedImageIds()); (it._historyIds || [it._id, it.id, it.key].filter(Boolean)).forEach(id => ids.add(String(id))); writeDeletedImageIds([...ids]);
    __imageHistoryItems.splice(idx, 1); renderImageGrid(); updateImageCountLabel();
    toast('Image deleted', 1600, 'ok');
    try { const res = await netFetch('/api/images/delete', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ id: it.id || it._id, key: it.key || null, image_id: it.image_id || null, prompt: it.prompt || '', ts: it.ts || it.created_at || null }) }, 8000); if (res && res.ok) setTimeout(() => { loadImageHistory().catch(() => {}); }, 900); } catch {}
  }
  async function deleteAllImages() {
    if (!__imageHistoryItems.length) { toast('No images to delete', 1800); return; }
    if (!confirm('Delete all generated images? This cannot be undone.')) return;
    const deleted = readDeletedImageIds(); __imageHistoryItems.forEach(it => (it._historyIds || [it._id, it.id, it.key].filter(Boolean)).forEach(id => deleted.add(String(id)))); writeDeletedImageIds([...deleted]);
    __imageHistoryItems = []; renderImageGrid(); updateImageCountLabel(); toast('All images deleted', 1800, 'ok');
    try { await netFetch('/api/images/clear', { method: 'POST', headers: authHeaders(), body: '{}' }, 8000); } catch {}
  }
  function refreshImageHistorySoon() { setTimeout(() => { loadImageHistory().catch(() => {}); }, 500); }

  /* ---------- Conversations ---------- */
  function currentConvo() { return __conversations.find((c) => c.id === currentConversationId) || null; }
  function saveChats() {
    const slim = __conversations.map((c) => ({ ...c, messages: (c.messages || []).map((m) => ({ id: m.id, role: m.role, content: m.content, ts: m.ts, thinking: m.thinking || '', imageKey: m.imageKey || null, imageData: (m.imageData && m.imageData.length < 350000) ? m.imageData : undefined, files: (m.files || []).map((f) => ({ name: f.name, size: f.size, type: f.type, mime: f.mime, dataUrl: (f.type === 'image' && f.dataUrl && f.dataUrl.length < 200000) ? f.dataUrl : undefined, width: f.width, height: f.height, content: (f.type === 'text' && f.content && f.content.length < 60000) ? f.content : undefined })) })) }));
    safeSet(LS_KEY, slim);
  }
  function loadChats() { const v = safeGet(LS_KEY, []); __conversations = Array.isArray(v) ? v : []; }
  function welcomeHTML() {
    return `<div class="welcome-screen">
      <div class="welcome-brand">
        <img class="welcome-brand-logo" src="/logo.png" alt="Mirox AI logo" onerror="this.style.display='none'">
        <span class="welcome-brand-text">Mirox AI</span>
      </div>
      <div class="kimi-tagline">Your AI copilot for building, research, and every-day work.</div>
      <div class="kimi-chips">
        <button class="kimi-chip" type="button" data-prompt="Make me a slide deck about the solar system"><i class="ri-slideshow-line"></i><span>Slides</span></button>
        <button class="kimi-chip" type="button" data-prompt="Do deep research on quantum computing and summarize the state of the art"><i class="ri-search-eye-line"></i><span>Deep Research</span></button>
        <button class="kimi-chip" type="button" data-prompt="Help me build a to-do web app with HTML, CSS and JS"><i class="ri-tools-line"></i><span>Build</span></button>
        <button class="kimi-chip" type="button" data-prompt="Write a professional doc for a science fair project on AI"><i class="ri-file-text-line"></i><span>Docs</span></button>
        <button class="kimi-chip" type="button" data-prompt="Create a spreadsheet plan for a school science fair budget"><i class="ri-table-line"></i><span>Sheets</span></button>
        <button class="kimi-chip" type="button" data-prompt="Design a clean poster layout for a science fair project"><i class="ri-palette-line"></i><span>Design</span></button>
      </div>
      <div class="kimi-suggest">
        <button class="suggestion-card" type="button" data-prompt="Latest Mirox Models?"><i class="ri-global-line"></i><span>Latest Mirox Models?</span></button>
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
    $$('.suggestion-card, .kimi-chip').forEach((card) => {
      if (card.__wired) return; card.__wired = true;
      card.onclick = () => { const p = card.dataset.prompt; const inp = $('#messageInput'); if (p && inp) { inp.value = p; updateSendButtonState(); handleSend(); } };
    });
  }
  function renderHistory() {
    const list = $('#historyList'); if (!list) return;
    const q = __historyQuery.trim().toLowerCase();
    const items = q ? __conversations.filter((c) => (c.title || '').toLowerCase().includes(q)) : __conversations;
    if (!items.length) { list.innerHTML = `<li class="history-empty">No conversations yet</li>`; return; }
    list.innerHTML = items.map((c) => `<li class="history-item${c.id === currentConversationId ? ' active' : ''}" data-id="${c.id}"><i class="ri-chat-3-line"></i><span class="history-title">${escapeHtml(c.title || 'Chat')}</span><button class="history-delete icon-btn" aria-label="Delete chat"><i class="ri-delete-bin-line"></i></button></li>`).join('');
  }
  function estimateTokens(text) { return Math.ceil(String(text || '').length / 4); }
  function conversationTokenUsage(convo = currentConvo()) { if (!convo) return 0; return (convo.messages || []).reduce((s, m) => s + estimateTokens(m.content || ''), 0); }
  function formatK(n) { return n >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k' : String(n); }
  function updateTokenUsage() { const el = $('#tokenUsage'); if (!el) return; const span = el.querySelector('span'); if (span) span.textContent = formatK(conversationTokenUsage()) + ' tokens'; }
  function atChatBottom(c = $('#chatMessages')) { return !c || c.scrollHeight - c.scrollTop - c.clientHeight < 100; }
  function scrollToBottom(force = false) { const c = $('#chatMessages'); if (!c) return; if (force || (autoScrollEnabled && userIsAtBottom && __prefs.autoScroll !== false)) c.scrollTop = c.scrollHeight; updateScrollButton(); }
  function updateScrollButton() { const c = $('#chatMessages'), b = $('#scrollBottomBtn'); if (!c || !b) return; b.classList.toggle('visible', !atChatBottom(c)); }
  function fmtSize(n) { if (n == null) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }

  /* ---------- File meta ---------- */
  function getFileMeta(name) {
    const m = String(name || '').match(/\.([a-z0-9]+)$/i);
    if (!m) return { label: 'TXT', icon: 'ri-file-text-line' };
    const ext = m[1].toLowerCase();
    const map = { py:{label:'PY',icon:'devicon-python-plain colored'},js:{label:'JS',icon:'devicon-javascript-plain colored'},mjs:{label:'JS',icon:'devicon-javascript-plain colored'},ts:{label:'TS',icon:'devicon-typescript-plain colored'},tsx:{label:'TSX',icon:'devicon-typescript-plain colored'},jsx:{label:'JSX',icon:'devicon-javascript-plain colored'},html:{label:'HTML',icon:'devicon-html5-plain colored'},htm:{label:'HTML',icon:'devicon-html5-plain colored'},css:{label:'CSS',icon:'devicon-css3-plain colored'},scss:{label:'SCSS',icon:'devicon-css3-plain colored'},json:{label:'JSON',icon:'devicon-json-plain colored'},md:{label:'MD',icon:'ri-markdown-line'},txt:{label:'TXT',icon:'ri-file-text-line'},csv:{label:'CSV',icon:'ri-file-list-2-line'},log:{label:'LOG',icon:'ri-file-list-line'},lua:{label:'LUA',icon:'devicon-lua-plain colored'},sh:{label:'SH',icon:'devicon-bash-plain colored'},bash:{label:'SH',icon:'devicon-bash-plain colored'},java:{label:'JAVA',icon:'devicon-java-plain colored'},cpp:{label:'C++',icon:'devicon-cplusplus-plain colored'},hpp:{label:'C++',icon:'devicon-cplusplus-plain colored'},c:{label:'C',icon:'devicon-c-plain colored'},h:{label:'C',icon:'devicon-c-plain colored'},go:{label:'GO',icon:'devicon-go-plain colored'},rs:{label:'RS',icon:'devicon-rust-plain colored'},rb:{label:'RB',icon:'devicon-ruby-plain colored'},php:{label:'PHP',icon:'devicon-php-plain colored'},sql:{label:'SQL',icon:'ri-database-2-line'},yml:{label:'YAML',icon:'ri-file-list-2-line'},yaml:{label:'YAML',icon:'ri-file-list-2-line'},xml:{label:'XML',icon:'ri-file-code-line'},svg:{label:'SVG',icon:'devicon-html5-plain colored'},zip:{label:'ZIP',icon:'ri-file-zip-line'} };
    return map[ext] || { label: ext.toUpperCase().slice(0, 4), icon: 'ri-file-text-line' };
  }
  const TEXT_EXTS = ['txt','md','json','csv','log','py','js','mjs','ts','tsx','jsx','html','htm','css','scss','yml','yaml','xml','sh','bash','sql','java','c','h','cpp','hpp','go','rs','rb','php','lua','svg'];
  function isTextFile(f) { const m = String(f.name || '').toLowerCase().match(/\.([a-z0-9]+)$/); return m && TEXT_EXTS.includes(m[1]); }
  function countLines(text) { if (!text) return 0; const s = String(text); let n = 1; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++; return n; }

  /* ---------- Code lang ---------- */
  const LANG_META = { lua:{label:'LUA',icon:'devicon-lua-plain colored',hljs:'lua'},python:{label:'PY',icon:'devicon-python-plain colored',hljs:'python'},javascript:{label:'JS',icon:'devicon-javascript-plain colored',hljs:'javascript'},typescript:{label:'TS',icon:'devicon-typescript-plain colored',hljs:'typescript'},html:{label:'HTML',icon:'devicon-html5-plain colored',hljs:'xml'},css:{label:'CSS',icon:'devicon-css3-plain colored',hljs:'css'},json:{label:'JSON',icon:'devicon-json-plain colored',hljs:'json'},bash:{label:'SH',icon:'devicon-bash-plain colored',hljs:'bash'},java:{label:'JAVA',icon:'devicon-java-plain colored',hljs:'java'},cpp:{label:'C++',icon:'devicon-cplusplus-plain colored',hljs:'cpp'},c:{label:'C',icon:'devicon-c-plain colored',hljs:'c'},go:{label:'GO',icon:'devicon-go-plain colored',hljs:'go'},rust:{label:'RUST',icon:'devicon-rust-plain colored',hljs:'rust'},ruby:{label:'RB',icon:'devicon-ruby-plain colored',hljs:'ruby'},php:{label:'PHP',icon:'devicon-php-plain colored',hljs:'php'},sql:{label:'SQL',icon:'ri-database-2-line',hljs:'sql'},yaml:{label:'YAML',icon:'ri-file-list-2-line',hljs:'yaml'},markdown:{label:'MD',icon:'ri-markdown-line',hljs:'markdown'},svg:{label:'SVG',icon:'devicon-html5-plain colored',hljs:'xml'} };
  function langMeta(lang) { const k = String(lang || '').toLowerCase().trim(); return LANG_META[k] || { label: (k || 'CODE').toUpperCase().slice(0, 6), icon: 'ri-code-s-slash-line', hljs: k || 'plaintext' }; }
  function highlightCode(lang, code) {
    const raw = String(code || '').replace(/\n$/, ''); const meta = langMeta(lang);
    try { if (window.hljs && hljs.getLanguage && hljs.getLanguage(meta.hljs)) return hljs.highlight(raw, { language: meta.hljs }).value; if (window.hljs) return hljs.highlightAuto(raw).value; } catch {}
    return escapeHtml(raw);
  }
  function renderCode(lang, code, closed, codeId) {
    const meta = langMeta(lang); const raw = String(code || '').replace(/\n$/, '');
    const isRunnable = /^(html|htm|svg|xml)$/i.test(meta.hljs) || /^(html|htm|svg)$/i.test(String(lang).trim());
    const actions = closed ? `<div class="code-block-actions">${isRunnable ? `<button class="code-action-btn run-btn" data-run="${codeId || ''}" title="Run in sandbox"><i class="ri-play-circle-line"></i> Run</button>` : ''}<button class="code-action-btn" data-copy><i class="ri-file-copy-line"></i> Copy</button></div>` : '<span class="writing-tag"><i class="ri-loader-4-line spin"></i> writing…</span>';
    return `<div class="code-block" data-lang="${escapeHtml(meta.hljs)}" data-code-id="${codeId || ''}"><div class="code-block-header"><span class="code-lang-badge"><i class="${meta.icon}"></i><span>${escapeHtml(meta.label)}</span></span>${actions}</div><pre><code class="hljs language-${escapeHtml(meta.hljs)}">${highlightCode(lang, raw)}</code></pre></div>`;
  }

  /* ---------- Markdown ---------- */
  function renderMarkdown(rawText) {
    if (!rawText) return '';
    const src = String(rawText); const parts = [];
    const re = /```([a-zA-Z0-9+#._-]*)\n?([\s\S]*?)```/g; let last = 0, m, idx = 0;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) parts.push({ type: 'text', content: src.slice(last, m.index) });
      parts.push({ type: 'code', lang: (m[1] || '').trim(), content: m[2], closed: true, id: 'c' + (idx++) });
      last = re.lastIndex;
    }
    const rest = src.slice(last); const openM = rest.match(/```([a-zA-Z0-9+#._-]*)\n?([\s\S]*)$/);
    if (openM) { const before = rest.slice(0, openM.index); if (before) parts.push({ type: 'text', content: before }); parts.push({ type: 'code', lang: (openM[1] || '').trim(), content: openM[2], closed: false, id: 'c' + (idx++) }); }
    else if (rest) parts.push({ type: 'text', content: rest });
    return parts.map((p) => p.type === 'code' ? renderCode(p.lang, p.content, p.closed, p.id) : renderText(p.content)).join('');
  }
  function renderText(text) {
    const lines = String(text).split('\n'); let out = ''; const buf = [];
    const flush = () => { if (buf.length) { out += `<p>${inlineFmt(buf.join(' '))}</p>`; buf.length = 0; } };
    const splitRow = (line) => { let s = line.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|')) s = s.slice(0, -1); return s.split('|').map((v) => v.trim()); };
    const isSepRow = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
    for (let i = 0; i < lines.length; i++) {
      const tt = lines[i].trim(); if (!tt) { flush(); continue; }
      if (tt.includes('|') && i + 1 < lines.length && isSepRow(lines[i + 1])) {
        flush(); const headers = splitRow(tt); i += 1;
        let table = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
        headers.forEach((c) => { table += `<th>${inlineFmt(c)}</th>`; });
        table += '</tr></thead><tbody>';
        while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim() !== '') { i++; const row = splitRow(lines[i]); table += '<tr>'; for (let j = 0; j < headers.length; j++) table += `<td>${inlineFmt(row[j] || '')}</td>`; table += '</tr>'; }
        out += table + '</tbody></table></div>'; continue;
      }
      const hm = tt.match(/^(#{1,6})\s+(.+)$/); if (hm) { flush(); const lvl = hm[1].length; out += `<h${lvl} class="md-h md-h${lvl}">${inlineFmt(hm[2])}</h${lvl}>`; continue; }
      const hr = tt.match(/^([-*_])\1{2,}$/); if (hr) { flush(); out += '<hr class="md-hr">'; continue; }
      const um = tt.match(/^[-*+]\s+(.+)$/); if (um) { flush(); out += `<div class="md-li md-ul">• ${inlineFmt(um[1])}</div>`; continue; }
      const om = tt.match(/^(\d+)\.\s+(.+)$/); if (om) { flush(); out += `<div class="md-li md-ol">${om[1]}. ${inlineFmt(om[2])}</div>`; continue; }
      if (/^>\s?/.test(tt)) { flush(); out += `<blockquote class="md-quote">${inlineFmt(tt.replace(/^>\s?/, ''))}</blockquote>`; continue; }
      buf.push(tt);
    }
    flush(); return out;
  }
  function inlineFmt(t2) {
    let s = escapeHtml(t2); const codes = [];
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
        const block = btn.closest('.code-block'); const code = block?.querySelector('pre code')?.textContent || '';
        if (btn.hasAttribute('data-copy')) { try { await navigator.clipboard.writeText(code); const old = btn.innerHTML; btn.innerHTML = '<i class="ri-check-line"></i> Copied'; setTimeout(() => { btn.innerHTML = old; }, 1200); } catch {} }
        else if (btn.hasAttribute('data-run')) { openHtmlRunner(code); }
      };
    });
  }

  function openHtmlRunner(code) {
    __hrCurrentCode = code || '';
    const modal = $('#htmlRunnerModal'); if (!modal) return;
    const iframe = $('#hrIframe'), src = $('#hrSource');
    if (iframe) iframe.srcdoc = __hrCurrentCode;
    if (src) src.textContent = __hrCurrentCode;
    $$('.html-runner-tab').forEach((t) => t.classList.toggle('active', t.dataset.hrTab === 'preview'));
    $$('.html-runner-pane').forEach((p) => { p.style.display = p.dataset.hrPane === 'preview' ? 'flex' : 'none'; });
    modal.classList.add('open');
  }
  function closeHtmlRunner() { $('#htmlRunnerModal')?.classList.remove('open'); }
  function openRawView(text) { __currentRawSource = text || ''; const modal = $('#rawViewModal'); const content = $('#rawViewContent'); if (content) content.textContent = __currentRawSource || '(empty)'; if (modal) modal.classList.add('open'); }
  function closeRawView() { $('#rawViewModal')?.classList.remove('open'); }

  /* ---------- Message actions ---------- */
  function buildActions(role, msgId) {
    if (role === 'user') return `<button class="action-btn" data-action="copy" aria-label="Copy" title="Copy"><i class="ri-file-copy-line"></i></button>`;
    const react = __reactions[msgId]; const liked = react === 'like'; const disliked = react === 'dislike';
    return `<button class="action-btn${liked ? ' active-liked' : ''}" data-action="like" title="Good response"><i class="${liked ? 'ri-thumb-up-fill' : 'ri-thumb-up-line'}"></i><span>Like</span></button><button class="action-btn${disliked ? ' active-disliked' : ''}" data-action="dislike" title="Bad response"><i class="${disliked ? 'ri-thumb-down-fill' : 'ri-thumb-down-line'}"></i><span>Dislike</span></button><button class="action-btn" data-action="copy" title="Copy"><i class="ri-file-copy-line"></i><span>Copy</span></button><button class="action-btn" data-action="speak" title="Read aloud"><i class="ri-volume-up-line"></i><span>Read</span></button><button class="action-btn" data-action="raw" title="Source"><i class="ri-code-box-line"></i><span>Source</span></button><button class="action-btn" data-action="retry" title="Regenerate"><i class="ri-refresh-line"></i><span>Retry</span></button>`;
  }
  function addMessageToDOM(role, content, ts, msgId, files, image, thinking) {
    const container = $('#chatMessages'); if (!container) return null;
    container.querySelector('.welcome-screen')?.remove();
    const id = msgId || uid();
    const el = document.createElement('div');
    el.className = 'message ' + (role === 'user' ? 'user' : 'ai'); el.dataset.msgId = id; el.dataset.role = role; el.dataset.rawContent = content || '';
    let avatar = ''; if (role === 'ai') avatar = `<div class="message-avatar"><div class="mascot mascot-sm m-idle" data-mood="idle">${blobSvg()}</div></div>`;
    let inner = '';
    if (role === 'user' && files && files.length) {
      inner += '<div class="attach-row">';
      for (const f of files) {
        if (f.type === 'image' && f.dataUrl) { const dims = f.width && f.height ? `<span class="attach-size">${f.width}×${f.height}</span>` : ''; inner += `<div class="attach-chip attach-chip-image"><img src="${f.dataUrl}" alt="">${escapeHtml(f.name || '')}${dims}</div>`; }
        else { const meta = getFileMeta(f.name); const lines = f.content ? countLines(f.content) : 0; inner += `<div class="attach-chip attach-chip-file"><span class="attach-file-badge"><i class="${meta.icon}"></i> ${escapeHtml(meta.label)}</span><span class="attach-chip-file-name">${escapeHtml(f.name || 'file')}</span>${f.size ? `<span class="attach-size">${fmtSize(f.size)}</span>` : ''}${lines > 1 ? `<span class="attach-lines">${lines} lines</span>` : ''}</div>`; }
      }
      inner += '</div>';
    }
    if (role === 'ai' && image) inner += `<div class="gen-image"><img src="${image}" draggable="false" alt=""></div>`;
    inner += '<div class="bubble-text"></div>';
    el.innerHTML = `${avatar}<div class="message-body"><div class="bubble">${inner}</div><div class="message-actions">${buildActions(role, id)}</div><div class="message-time">${ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</div></div>`;
    container.appendChild(el);
    const bt = el.querySelector('.bubble-text');
    if (role === 'user') { bt.textContent = content || ''; if (!content) bt.style.display = 'none'; }
    else if (content) { bt.innerHTML = renderMarkdown(stripThinkingLeak(content)); wireCodeButtons(bt); }
    if (role === 'ai' && image) { const img = el.querySelector('.gen-image img'); if (img) img.onclick = () => openImageViewer(image); }
    wireMessageActions(el); scrollToBottom();
    return el;
  }
  function wireMessageActions(el) {
    const msgId = el.dataset.msgId;
    el.querySelectorAll('.action-btn').forEach((btn) => {
      if (btn.__wired) return; btn.__wired = true;
      btn.onclick = async (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'copy') { const raw = el.dataset.rawContent || el.querySelector('.bubble-text')?.innerText || ''; try { await navigator.clipboard.writeText(raw); const old = btn.innerHTML; btn.innerHTML = '<i class="ri-check-line"></i><span>Copied</span>'; setTimeout(() => { btn.innerHTML = old; }, 1200); } catch { toast('Copy failed', 1800, 'err'); } }
        else if (action === 'speak') { const text = el.querySelector('.bubble-text')?.innerText || ''; const convo = currentConvo(); const msg = convo?.messages.find((m) => m.id === msgId); const lang = (__prefs.responseLanguage && __prefs.responseLanguage !== 'auto') ? __prefs.responseLanguage : (msg && msg.lang) || 'en'; if (__currentSpeakMsgId === msgId) stopSpeaking(); else speak(text, lang, msgId); }
        else if (action === 'raw') openRawView(el.dataset.rawContent || '');
        else if (action === 'like') { const cur = __reactions[msgId]; if (cur === 'like') delete __reactions[msgId]; else __reactions[msgId] = 'like'; saveReactions(); updateActionBar(el); }
        else if (action === 'dislike') { const cur = __reactions[msgId]; if (cur === 'dislike') delete __reactions[msgId]; else __reactions[msgId] = 'dislike'; saveReactions(); updateActionBar(el); }
        else if (action === 'retry') { if (!isReplying) handleRetry(el); }
      };
    });
  }
  function updateActionBar(el) { const bar = el.querySelector('.message-actions'); if (!bar) return; bar.innerHTML = buildActions(el.dataset.role, el.dataset.msgId); el.querySelectorAll('.action-btn').forEach((b) => { b.__wired = false; }); wireMessageActions(el); }
  async function handleRetry(el) {
    if (isReplying) return;
    const convo = currentConvo(); if (!convo) return;
    const idx = (convo.messages || []).findIndex((m) => m.id === el.dataset.msgId); if (idx < 0) return;
    let userMsg = null; for (let i = idx - 1; i >= 0; i--) if (convo.messages[i].role === 'user') { userMsg = convo.messages[i]; break; }
    if (!userMsg) return;
    convo.messages = convo.messages.slice(0, idx); saveChats();
    let s = el.nextElementSibling; while (s) { const n = s.nextElementSibling; s.remove(); s = n; }
    el.remove();
    sendToAPI(userMsg.content, userMsg.files || []);
  }
  function updateSendButtonState() { const btn = $('#sendBtn'), inp = $('#messageInput'); if (!btn || !inp) return; const enable = (inp.value.trim().length > 0 || pendingFiles.length > 0) && !isReplying; btn.classList.toggle('is-disabled', !enable); btn.setAttribute('aria-disabled', String(!enable)); }
  function requireSignIn(reason) { setLoginError(''); const sub = $('#loginModalSub'); if (sub && reason) sub.textContent = reason; openModal('loginModal'); toast(reason || 'Please sign in to continue.', 3000, 'err'); }

  /* ---------- Search intent detection ---------- */
  function looksLikeIdeasRequest(text) {
    const t = String(text || '').trim(); if (!t) return false;
    return /\b(ideas?|inspiration|things to build|project ideas|science fair|recommendations|examples of|concepts for|what can i make|what should i build|suggestions|best (?:way|ways|projects|options|tools|topics)|for beginners|beginner friendly)\b/i.test(t) && !looksLikeImageRequest(t);
  }
  function looksLikeImageRequest(text) {
    const t = String(text || '').trim(); if (!t) return false;
    return /\b(generate|create|make|draw|render|paint|show\s+me|give\s+me)\b[^.!?]{0,60}\b(image|picture|photo|illustration|drawing|painting)\b/i.test(t) || /^(?:an?\s+)?(image|picture|photo|illustration)\s+of\s+/i.test(t);
  }
  function looksTimeSensitive(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return false;
    if (looksLikeImageRequest(t)) return false;
    const CURRENT_YEAR = new Date().getFullYear();
    const patterns = [
      /\b(latest|newest|current|currently|today|right now|just released|just announced|recent|recently|upcoming|breaking|live|this (?:week|month|year))\b/,
      new RegExp(`\\b20(?:${CURRENT_YEAR - 1}|${CURRENT_YEAR}|${CURRENT_YEAR + 1})\\b`),
      /\b(iphone|ipad|macbook|airpods|galaxy|pixel|surface|watch|vision\s?pro|quest)\s*\d+/i,
      /\b(gpt|claude|gemini|llama|deepseek|qwen|mixtral|o[1-9])\s*-?\s*\d/i,
      /\b(price|prices|cost|worth|score|scores|results|standings|ranking|rankings|news|update|updates|version|release|released|launch|launched|announced)\b/,
      /\b(who (?:won|is|are|was)|what(?:'s| is) the (?:latest|current|newest))\b/,
      /\b(stock|share|market|weather|forecast)\b/,
      /\b(best|top|most popular|fastest|cheapest|newest|oldest) \w+/,
      /\b(when (?:was|is|did)|where (?:is|can i)|how much (?:is|does|do))\b/,
    ];
    return patterns.some((re) => re.test(t));
  }

  /* ---------- Tool limit modal ---------- */
  function showToolLimitModal(message) {
    const existing = document.getElementById('toolLimitModal'); if (existing) existing.remove();
    const wrap = document.createElement('div');
    wrap.id = 'toolLimitModal'; wrap.className = 'modal-overlay open'; wrap.style.zIndex = '9999';
    wrap.innerHTML = `<div class="modal" style="max-width:420px;text-align:center;"><div class="card-icon" style="margin:0 auto 14px;background:var(--accent-soft);color:var(--accent);width:52px;height:52px;border-radius:14px;display:grid;place-items:center;font-size:26px;"><i class="ri-timer-flash-line"></i></div><h2 class="modal-title" style="margin-bottom:8px;">Free quota reached</h2><p class="modal-sub" style="margin-bottom:20px;">${escapeHtml(message)}</p><button class="modal-btn primary" type="button" id="toolLimitOk">Got it</button></div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('#toolLimitOk').onclick = () => wrap.remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
  }

  function handleSend() {
    if (isReplying) return;
    const inp = $('#messageInput'); if (!inp) return;
    const text = inp.value.trim();
    if (!text && !pendingFiles.length) return;
    const hasImageFile = pendingFiles.some((f) => f.type === 'image');
    if (__prefs.deepThink && !hasImageFile && looksLikeImageRequest(text)) { toast('Image generation is disabled while DeepThink is on.', 4500, 'err'); return; }
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
    recordGrowth(1);
    const ideaSearch = looksLikeIdeasRequest(text);
    const timeSearch = looksTimeSensitive(text);
    const autoSearch = ideaSearch || timeSearch;
    if (timeSearch) {
      forceSearchNext = true;
      $('#searchModeBtn')?.classList.add('active');
      updateModePill();
    }
    sendToAPI(text, files, forceSearchNext || autoSearch);
    forceSearchNext = false;
    $('#searchModeBtn')?.classList.remove('active');
    updateModePill();
  }
  function countFences(text) { let n = 0; const s = String(text || ''); for (let i = 0; i < s.length - 2; i++) if (s.charCodeAt(i) === 96 && s.charCodeAt(i + 1) === 96 && s.charCodeAt(i + 2) === 96) { n++; i += 2; } return n; }
  function shouldShowContinue(full, streamComplete) {
    if (!full) return false;
    if (!streamComplete) return true;
    if (countFences(full) % 2 === 1) return true;
    return /(\.\.\.|…|,|\bto be continued\b|\bcontinue\b|\bnext part\b)$/i.test(String(full).trim());
  }
  function attachContinueButton(msgEl, bubble, messageObj) {
    if (!msgEl || !bubble || !messageObj || bubble.querySelector('[data-continue]')) return;
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'continue-response-btn'; btn.dataset.continue = '1';
    btn.innerHTML = '<i class="ri-play-circle-line"></i><span>Continue</span>';
    btn.addEventListener('click', () => continueAssistantMessage(msgEl, bubble, messageObj, btn));
    bubble.appendChild(btn);
  }
  async function continueAssistantMessage(msgEl, bubble, messageObj, btn) {
    if (isReplying || continuationBusy) return;
    continuationBusy = true; btn.disabled = true; btn.innerHTML = '<i class="ri-loader-4-line spin"></i><span>Continuing…</span>';
    try { await sendToAPI('Continue EXACTLY from where you stopped. Do NOT repeat any prior text.', [], false, { existingMsgEl: msgEl, existingBubble: bubble, messageObject: messageObj, continuation: true }); }
    finally { continuationBusy = false; if (btn.isConnected) btn.remove(); }
  }
  function detectImageEditIntent(text, hasImage) {
    if (!hasImage) return null;
    const t = String(text || '').toLowerCase().trim(); if (!t) return null;
    const editVerbs = /\b(edit|modify|change|make|turn|transform|adjust|retouch|enhance|fix|recolor|colour|colorize|swap|replace|add|remove|delete|paint|redraw|restyle|redesign|update|redo)\b/;
    const refersToImage = /\b(image|photo|picture|pic|it|this|that|him|her|them|cat|dog|person|face|hair|background|color|colour|smile|eyes?|nose|mouth|shirt|clothes?)\b/;
    if (!editVerbs.test(t) || !refersToImage.test(t)) return false;
    return t;
  }

  /* ---------- Chat send ---------- */
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
    const aiMsgId = isContinuation ? continuation.messageObject.id : uid();
    let full = '';
    if (isContinuation) {
      msgEl = continuation.existingMsgEl; bubble = continuation.existingBubble;
      bubbleText = bubble.querySelector('.bubble-text');
      timeEl = msgEl.querySelector('.message-time');
      avatarMascot = msgEl.querySelector('.message-avatar .mascot');
      bubble.querySelector('[data-continue]')?.remove();
      full = String(continuation.messageObject.content || '');
    } else {
      msgEl = document.createElement('div');
      msgEl.className = 'message ai'; msgEl.dataset.msgId = aiMsgId; msgEl.dataset.role = 'ai';
      const avatar = document.createElement('div'); avatar.className = 'message-avatar';
      avatar.innerHTML = `<div class="mascot mascot-sm m-thinking" data-mood="thinking">${blobSvg()}</div>`;
      avatarMascot = avatar.querySelector('.mascot'); msgEl.appendChild(avatar);
      const body = document.createElement('div'); body.className = 'message-body';
      thinkPanel = createThinkPanel(!!__prefs.deepThink); body.appendChild(thinkPanel.el);
      timeEl = document.createElement('div'); timeEl.className = 'message-time'; body.appendChild(timeEl);
      msgEl.appendChild(body); container?.appendChild(msgEl);
      bubble = null; bubbleText = null; scrollToBottom(true);
    }
    const visionFiles = files.filter((f) => f.type === 'image' && f.dataUrl);
    const contentParts = [];
    if (text) contentParts.push({ type: 'text', text });
    for (const f of visionFiles) contentParts.push({ type: 'image_url', image_url: { url: f.pngDataUrl || f.dataUrl, detail: 'auto' } });
    const hasAttachedImage = visionFiles.length > 0;
    const editIntent = hasAttachedImage ? detectImageEditIntent(text, true) : null;
    const sourceImage = editIntent ? (visionFiles[0].pngDataUrl || visionFiles[0].dataUrl) : null;
    activeStreamController = new AbortController();
    let generatedImage = null;
    let streamComplete = false;
    let renderTimer = null;
    let rawAll = '', answerText = '', thinkingText = '';
    let hasReasoning = false, thinkingTagSeen = false, toolSeen = false, searchSeen = false;
    const renderStreamText = () => {
      renderTimer = null; if (!bubbleText) return;
      const chat = $('#chatMessages');
      const wasAtBottom = chat && (chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120);
      bubbleText.innerHTML = renderMarkdown(answerText); wireCodeButtons(bubbleText);
      if (wasAtBottom) scrollToBottom();
    };
    const scheduleRender = () => {
      const now = performance.now(); if (renderTimer) return;
      renderTimer = setTimeout(renderStreamText, Math.max(60, 140 - (now - streamRenderAt)));
      streamRenderAt = now;
    };
    const streamTimeout = setTimeout(() => { try { activeStreamController?.abort(); } catch {} }, STREAM_TIMEOUT_MS);
    try {
      const sysExtra = RESPONSE_QUALITY_NOTE + (looksLikeIdeasRequest(text) ? '\n\n' + IDEA_FORMAT_NOTE : '');
      const toolsOn = !!__prefs.tools || pluginEnabled('zip') || pluginEnabled('files') || pluginEnabled('tls') || pluginEnabled('memory');

      const reqBody = {
        message: text, history, model, stream: true, search: !!forceSearch,
        deep_think: !!__prefs.deepThink && !__limitReached,
        tools: toolsOn,
        system_extra: sysExtra,
        files: files.map((f) => ({ name: f.name, size: f.size, type: f.type, mime: f.mime, width: f.width, height: f.height, dataUrl: f.dataUrl, base64: f.base64 || null, svgText: f.svgText || null, vision: !!f.vision, content: f.type === 'text' ? f.content : undefined })),
        content_parts: contentParts.length ? contentParts : null,
        guest_id: getGuestId(), language: __prefs.responseLanguage || 'auto',
        edit_image: !!editIntent, source_image: sourceImage,
        continuation: !!isContinuation,
        plugins: __plugins,
      };

      const res = await fetch(APP_CHAT_URL, { method: 'POST', headers: authHeaders(), credentials: 'same-origin', body: JSON.stringify(reqBody), signal: activeStreamController.signal });
      if (!res.ok) { let detail = `HTTP ${res.status}`; try { const d = await res.json(); detail = d.error?.message || d.error || d.message || detail; } catch {} throw new Error(detail); }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      const bodyEl = msgEl.querySelector('.message-body');
      const ensureBubble = () => { if (!bubble) { bubble = document.createElement('div'); bubble.className = 'bubble'; bodyEl.insertBefore(bubble, timeEl); } };
      let signinTriggered = false;
      const updateSplit = () => {
        const s = rawAll;
        const openIdx = s.indexOf('<thinking>');
        const closeIdx = s.indexOf('</thinking>');
        if (openIdx >= 0 && closeIdx > openIdx) { thinkingTagSeen = true; thinkingText = s.slice(openIdx + 10, closeIdx); answerText = s.slice(0, openIdx) + s.slice(closeIdx + 11); }
        else if (openIdx >= 0) { thinkingTagSeen = true; thinkingText = s.slice(openIdx + 10); answerText = s.slice(0, openIdx); }
        else answerText = s;
        answerText = stripThinkingLeak(answerText);
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

          if (o.signin_required && !signinTriggered) { signinTriggered = true; requireSignIn(o.message || 'Sign in to continue.'); try { await reader.cancel(); } catch {} break; }
          if (o.limit) {
            try { await reader.cancel(); } catch {}
            const msg = (o.limit && o.limit.message) || 'You have used all 20 free tool steps. Your allowance refreshes 3 hours after the first step in this window.';
            showToolLimitModal(msg);
            markLimitReached('Free quota used up');
            if (thinkPanel && thinkPanel.isConnected()) thinkPanel.fail();
            return;
          }
          if (o.t) { hasReasoning = true; thinkingText += o.t; }
          if (o.tool) { toolSeen = true; renderToolStatus(msgEl, o.tool, thinkPanel); }
          if (o.search) { searchSeen = true; if (thinkPanel && thinkPanel.isConnected()) thinkPanel.setStatus('Searching the web…'); }
          if (o.search_done && thinkPanel && thinkPanel.isConnected()) thinkPanel.setStatus('Reading search results…');
          if (o.source && thinkPanel && thinkPanel.isConnected()) thinkPanel.setStatus('Reading sources…');
          if (o.img) {
            generatedImage = o.img;
            if (avatarMascot) setMascotMood('celebrate', avatarMascot.parentElement.parentElement);
            ensureBubble();
            bubble.innerHTML = `<div class="gen-image"><img src="${o.img}" draggable="false" alt=""></div><div class="bubble-text"></div>`;
            bubbleText = bubble.querySelector('.bubble-text');
            const img = bubble.querySelector('img'); if (img) img.onclick = () => openImageViewer(o.img);
            scrollToBottom(); continue;
          }
          if (o.reasoning_content || o.reasoning) { const r = String(o.reasoning_content || o.reasoning || ''); if (r) { hasReasoning = true; thinkingText += r; } }
          const delta = o.d || o.content || (o.delta && o.delta.content) || '';
          if (delta) {
            rawAll += delta; updateSplit();
            if (answerText.length > 0) {
              if (!bubbleText) {
                if (avatarMascot) setMascotMood('coding', avatarMascot.parentElement.parentElement);
                ensureBubble(); bubble.innerHTML = '<div class="bubble-text"></div>';
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
      updateSplit();
      if (thinkPanel && thinkPanel.isConnected()) {
        if (thinkingTagSeen || hasReasoning || toolSeen || searchSeen) thinkPanel.finalize();
        else thinkPanel.hide();
      }
      full = answerText;
      if (avatarMascot) setMascotMood('happy', avatarMascot.parentElement.parentElement);
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      if (bubbleText) { bubbleText.innerHTML = renderMarkdown(full); wireCodeButtons(bubbleText); }
      if (!msgEl.querySelector('.message-actions')) {
        const bodyEl2 = msgEl.querySelector('.message-body');
        const actions = document.createElement('div'); actions.className = 'message-actions';
        actions.innerHTML = buildActions('ai', aiMsgId);
        bodyEl2.insertBefore(actions, timeEl);
      }
      msgEl.dataset.rawContent = full; updateActionBar(msgEl);
      let imageKey = null;
      if (generatedImage) {
        const wm = await watermarkedDataUrl(generatedImage);
        generatedImage = wm;
        const imgEl = msgEl.querySelector('.gen-image img');
        if (imgEl) { imgEl.src = wm; imgEl.onclick = () => openImageViewer(wm); }
        imageKey = 'img:' + aiMsgId;
        try { await idb.set(imageKey, wm); } catch { imageKey = null; }
        refreshImageHistorySoon();
      }
      let savedMsg;
      if (convo) {
        if (isContinuation) { savedMsg = convo.messages.find((m) => m.id === aiMsgId) || continuation.messageObject; savedMsg.content = full; savedMsg.thinking = thinkingText; savedMsg.ts = Date.now(); if (imageKey) savedMsg.imageKey = imageKey; if (generatedImage && generatedImage.length < 350000) savedMsg.imageData = generatedImage; }
        else { savedMsg = { id: aiMsgId, role: 'assistant', content: full, thinking: thinkingText, ts: Date.now(), imageKey, imageData: (generatedImage && generatedImage.length < 350000) ? generatedImage : undefined, lang: __prefs.responseLanguage || 'auto' }; convo.messages.push(savedMsg); }
      }
      saveChats(); updateTokenUsage();
      timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (savedMsg && shouldShowContinue(full, streamComplete)) { ensureBubble(); attachContinueButton(msgEl, bubble, savedMsg); }
      if (__prefs.autoSpeak && full && !__call.active) { const lang = (__prefs.responseLanguage && __prefs.responseLanguage !== 'auto') ? __prefs.responseLanguage : (savedMsg && savedMsg.lang) || 'en'; setTimeout(() => { speak(full, lang, aiMsgId); }, 250); }
    } catch (e) {
      clearTimeout(streamTimeout);
      const aborted = e.name === 'AbortError';
      const msg = aborted ? 'Stopped.' : (e.message || 'Something went wrong.');
      if (thinkPanel && thinkPanel.isConnected()) thinkPanel.fail();
      if (avatarMascot) setMascotMood('error', avatarMascot.parentElement.parentElement);
      const bodyEl = msgEl.querySelector('.message-body');
      if (!bubble) { bubble = document.createElement('div'); bubble.className = 'bubble'; bodyEl.insertBefore(bubble, timeEl); }
      if (full) {
        if (!bubbleText) { bubbleText = document.createElement('div'); bubbleText.className = 'bubble-text'; bubble.prepend(bubbleText); }
        bubbleText.innerHTML = renderMarkdown(full); wireCodeButtons(bubbleText);
        msgEl.dataset.rawContent = full;
        if (!msgEl.querySelector('.message-actions')) {
          const bodyEl2 = msgEl.querySelector('.message-body');
          const actions = document.createElement('div'); actions.className = 'message-actions';
          actions.innerHTML = buildActions('ai', aiMsgId);
          bodyEl2.insertBefore(actions, timeEl);
        }
        updateActionBar(msgEl);
        let savedMsg = convo?.messages.find((m) => m.id === aiMsgId);
        if (isContinuation && continuation.messageObject) savedMsg = continuation.messageObject;
        if (!savedMsg && convo) { savedMsg = { id: aiMsgId, role: 'assistant', content: full, ts: Date.now() }; convo.messages.push(savedMsg); }
        if (savedMsg) { savedMsg.content = full; saveChats(); attachContinueButton(msgEl, bubble, savedMsg); }
      } else { bubble.textContent = aborted ? '(stopped)' : 'Error: ' + msg; }
      toast(msg, 5000, 'err'); updateTokenUsage();
    } finally {
      clearTimeout(streamTimeout);
      if (thinkPanel) thinkPanel.destroy();
      isReplying = false; activeStreamController = null;
      if (stopBtn) stopBtn.style.display = 'none';
      updateSendButtonState(); updateTokenUsage();
    }
  }
  function stopStreaming() {
    if (activeStreamController) { try { activeStreamController.abort(); } catch {} activeStreamController = null; }
    isReplying = false; const s = $('#stopBtn'); if (s) s.style.display = 'none';
    updateSendButtonState();
  }
  function toast(msg, ms, kind) {
    const el = document.createElement('div');
    el.className = 'mirox-toast' + (kind ? ' ' + kind : '');
    el.textContent = typeof msg === 'string' ? msg : '';
    document.body.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, ms || 2200);
  }

  /* ---------- Voice typing ---------- */
  function setupVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = document.getElementById('voiceBtn');
    if (!SR || !btn) { if (btn) { btn.disabled = true; btn.style.opacity = '0.4'; } return; }
    const recog = new SR(); recog.continuous = false; recog.interimResults = true;
    const lang = () => (__prefs.responseLanguage && __prefs.responseLanguage !== 'auto') ? __prefs.responseLanguage : (navigator.language || 'en-US');
    recog.lang = lang();
    recog.onstart = () => { __voiceListening = true; btn.classList.add('listening'); btn.innerHTML = '<i class="ri-mic-fill"></i>'; };
    recog.onend = () => { __voiceListening = false; btn.classList.remove('listening'); btn.innerHTML = '<i class="ri-mic-line"></i>'; };
    recog.onerror = (e) => { __voiceListening = false; btn.classList.remove('listening'); btn.innerHTML = '<i class="ri-mic-line"></i>'; if (e.error === 'not-allowed') toast('Microphone permission denied.', 3000, 'err'); };
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
      recog.lang = lang(); inp.dataset.voiceBase = inp.value || '';
      try { recog.start(); } catch (e) { toast('Could not start voice: ' + e.message, 3000, 'err'); }
    });
  }

  /* ---------- Attachments ---------- */
  function imageToBase64DataURL(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const raw = reader.result; const img = new Image();
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
        img.onerror = () => resolve(null); img.src = raw;
      };
      reader.onerror = () => resolve(null); reader.readAsDataURL(file);
    });
  }
  const MAX_BINARY_FILE_BYTES = 25 * 1024 * 1024;
  const BINARY_EXT_RE = /\.(zip|rar|7z|tar|gz|tgz|pdf|docx|xlsx|pptx|jar|apk|exe|bin|mp3|wav|mp4|mov)$/i;
  function readBinaryFile(file) {
    return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => { const dataUrl = String(reader.result || ''); const base64 = dataUrl.split(',')[1] || ''; resolve({ type: 'file', name: file.name, size: file.size, mime: file.type || 'application/octet-stream', dataUrl, base64 }); }; reader.onerror = () => resolve(null); reader.readAsDataURL(file); });
  }
  function readTextFile(file) { return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => { const text = String(reader.result || '').slice(0, MAX_TEXT_FILE_BYTES); resolve({ type: 'text', name: file.name, size: file.size, mime: file.type || 'text/plain', content: text }); }; reader.onerror = () => resolve(null); reader.readAsText(file); }); }
  function hasAttachment(name, size) { return pendingFiles.some((f) => f.name === name && f.size === size); }
  function handleFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const arr0 = Array.from(fileList).filter((f) => !hasAttachment(f.name, f.size));
    if (!arr0.length) return;
    const incomingImages = arr0.filter((f) => (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name));
    const currentImages = pendingFiles.filter((f) => f.type === 'image').length;
    if (__tier === 'free' && (currentImages + incomingImages.length) > FREE_IMAGE_UPLOAD_CAP) { toast(`Free users can attach up to ${FREE_IMAGE_UPLOAD_CAP} images per message.`, 4500, 'err'); return; }
    let done = 0; const newFiles = [];
    const finish = () => { newFiles.sort((a, b) => (a.order || 0) - (b.order || 0)); for (const nf of newFiles) if (!hasAttachment(nf.name, nf.size)) pendingFiles.push(nf); updatePreview(); updateSendButtonState(); };
    arr0.forEach((f, idx) => {
      const isImg = (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name);
      const isBin = !isImg && BINARY_EXT_RE.test(f.name);
      const isTxt = !isImg && !isBin && (isTextFile(f) || (f.type || '').startsWith('text/') || (!f.type && !isBin));
      const one = () => { done++; if (done === arr0.length) finish(); };
      if (isImg) imageToBase64DataURL(f).then((d) => { if (d) newFiles.push({ ...d, order: idx }); one(); }).catch(one);
      else if (isBin) { if (f.size > MAX_BINARY_FILE_BYTES) { toast('File too large (max 25 MB): ' + f.name, 4500, 'err'); one(); } else readBinaryFile(f).then((d) => { if (d) newFiles.push({ ...d, order: idx }); one(); }).catch(one); }
      else if (isTxt) readTextFile(f).then((d) => { if (d) newFiles.push({ ...d, order: idx }); one(); }).catch(one);
      else readBinaryFile(f).then((d) => { if (d) newFiles.push({ ...d, order: idx }); one(); }).catch(one);
    });
  }
  function updatePreview() {
    const p = $('#attachmentPreview'), list = $('#attachmentList');
    if (!p || !list) return;
    if (!pendingFiles.length) { p.style.display = 'none'; list.innerHTML = ''; return; }
    p.style.display = 'flex';
    list.innerHTML = pendingFiles.map((f) => {
      if (f.type === 'image' && f.dataUrl) { const dims = f.width && f.height ? `<span class="attach-size">${f.width}×${f.height}</span>` : ''; return `<div class="attach-chip attach-chip-image"><img src="${f.dataUrl}" alt="">${escapeHtml(f.name || '')}${dims}</div>`; }
      const meta = getFileMeta(f.name); const lines = f.content ? countLines(f.content) : 0; const idx = pendingFiles.indexOf(f);
      return `<div class="attach-chip attach-chip-file" data-preview-file="${idx}" title="${escapeHtml(f.name || 'file')}"><span class="attach-file-badge"><i class="${meta.icon}"></i> ${escapeHtml(meta.label)}</span><span class="attach-chip-file-name">${escapeHtml(f.name || 'file')}</span>${f.size ? `<span class="attach-size">${fmtSize(f.size)}</span>` : ''}${lines > 1 ? `<span class="attach-lines">${lines} lines</span>` : ''}</div>`;
    }).join('');
    list.querySelectorAll('[data-preview-file]').forEach((chip) => { chip.onclick = (e) => { e.stopPropagation(); const idx = parseInt(chip.dataset.previewFile, 10); const file = pendingFiles[idx]; if (file) openFilePreview(file); }; });
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
    if (!file) return; __previewFileRef = file;
    const modal = $('#filePreviewModal'), icon = $('#filePreviewIcon'), name = $('#filePreviewName'), info = $('#filePreviewInfo'), content = $('#filePreviewContent');
    if (!modal) return;
    const meta = getFileMeta(file.name);
    if (icon) icon.innerHTML = `<i class="${meta.icon}"></i>`;
    if (name) name.textContent = file.name || 'file';
    const lines = file.content ? countLines(file.content) : 0;
    const parts = []; if (file.size) parts.push(fmtSize(file.size)); if (lines > 1) parts.push(lines + ' lines'); if (file.mime) parts.push(file.mime);
    if (info) info.textContent = parts.join(' · ') || '—';
    if (content) content.textContent = file.content || '(no content)';
    modal.classList.add('open');
  }
  function closeFilePreview() { $('#filePreviewModal')?.classList.remove('open'); __previewFileRef = null; }

  /* ---------- Models ---------- */
  function getModelsList() { return __config?.models?.length ? __config.models : FALLBACK_MODELS; }
  function canUseModel(tier) { if (tier === 'free') return true; if (__tier === 'ultimate') return true; if (__tier === 'pro' && tier === 'pro') return true; return false; }
  function tierLabel(tier) { if (tier === 'ultimate') return 'ULT'; if (tier === 'pro') return 'PRO'; return 'FREE'; }
  function tierFullLabel(tier) { if (tier === 'ultimate') return 'Ultimate'; if (tier === 'pro') return 'Pro'; return 'Free'; }
  function modelIconFor(id) { const f = FALLBACK_MODELS.find((m) => m.id === id); return f ? f.icon : 'ri-sparkling-2-line'; }
  function renderModelPicker() {
    const menu = $('#modelPickerMenu'); if (!menu) return;
    const models = getModelsList(); const cur = __model || models[0].id;
    menu.innerHTML = models.map((m) => {
      const usable = canUseModel(m.tier); const isActive = m.id === cur;
      const lockIcon = usable ? '' : '<i class="ri-lock-2-line model-option-lock"></i>';
      const icon = m.icon || modelIconFor(m.id);
      return `<div class="model-option${isActive ? ' active' : ''}${usable ? '' : ' locked'}" data-model-id="${m.id}" data-usable="${usable}"><span class="model-option-icon"><i class="${icon}"></i></span><span class="model-option-body"><span class="model-option-top"><span class="model-option-name">${escapeHtml(m.label)}</span><span class="model-tier-badge tier-${m.tier}">${tierLabel(m.tier)}</span>${lockIcon}</span><span class="model-option-tagline">${escapeHtml(m.tagline || '')}</span></span></div>`;
    }).join('');
    menu.querySelectorAll('.model-option').forEach((opt) => {
      opt.onclick = (e) => {
        e.stopPropagation();
        if (opt.dataset.usable === 'false') { if (!__user) { closeModelPicker(); requireSignIn('Sign in to unlock this model.'); } else { toast('Upgrade your plan to use this model.'); closeModelPicker(); } return; }
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

  /* ---------- Usage/config (FIXED guest sign-in) ---------- */
  async function refreshUsage() {
    const local = getLocalUser();
    const res = await jsonOr('/api/me', {}, null, 7000);
    let user = null;
    if (res && res.user) user = { ...res.user, local: false };
    else if (local) user = { name: local.name, email: local.email, tier: 'free', local: true };
    __user = user; // stays null for guests → sign-in UI works
    __tier = user ? (user.tier || 'free') : 'free';
    updateAccountUI();
    renderModelPicker();
    updateTokenUsage();
    if (user && !user.local) {
      const s = await jsonOr('/api/settings', {}, null, 6000);
      if (s && s.ok && s.settings) __user.settings = s.settings;
    } else if (user) {
      __user.settings = safeGet(LOCAL_SETTINGS_KEY, {});
    }
  }
  async function loadConfig() {
    const data = await jsonOr('/api/config', {}, null, 7000);
    if (data && Array.isArray(data.models) && data.models.length) __config = data;
    if (!__config) __config = { models: FALLBACK_MODELS };
    __model = getModelsList()[0].id; renderModelPicker();
  }

  /* ---------- Login ---------- */
  function setLoginError(msg, kind) {
    const el = $('#loginError'); if (!el) return;
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
    __user = { name, email, tier: 'free', local: true }; __tier = 'free';
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
      loadImageHistory().catch(() => {});
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
    __imageHistoryItems = []; renderImageGrid(); updateImageCountLabel();
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
      const res = await netFetch(APP_IMAGES_URL, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ prompt, guest_id: getGuestId() }) }, 90000);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok && data.image) {
        const wm = await watermarkedDataUrl(data.image);
        if (result) { result.innerHTML = `<img src="${wm}" alt="">`; result.querySelector('img').onclick = () => openImageViewer(wm); }
        refreshImageHistorySoon();
      } else if (res.status === 401) { closeModal('imageModal'); requireSignIn('Sign in to generate images with Mirox.'); }
      else { if (result) result.innerHTML = `<div class="studio-error">Failed</div>`; }
    } catch { if (result) result.innerHTML = `<div class="studio-error">Error</div>`; }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ri-image-add-line"></i> Generate'; } }
  }

  /* ---------- Tail promo ---------- */
  function showTailPromo() {
    if (safeGet(TAIL_PROMO_SEEN_KEY, false)) return;
    const modal = document.getElementById('tailPromoModal'); if (!modal) return;
    setTimeout(() => { modal.classList.add('open'); }, 900);
  }
  function dismissTailPromo() { safeSet(TAIL_PROMO_SEEN_KEY, true); closeModal('tailPromoModal'); }
  function tryTailPromo() {
    safeSet(TAIL_PROMO_SEEN_KEY, true); closeModal('tailPromoModal');
    __model = 'mirox-tail-r1';
    const lbl = document.getElementById('currentModelLabel'); if (lbl) lbl.textContent = 'Tail r1';
    renderModelPicker(); fireConfetti(); setTimeout(fireConfetti, 350);
    toast('Tail r1 is ready — ask anything!', 2600, 'ok');
    const inp = document.getElementById('messageInput'); if (inp) setTimeout(() => inp.focus(), 400);
  }

  /* ---------- Call Mode ---------- */
  function setCallPhase(phase) {
    __call.phase = phase;
    const overlay = $('#callOverlay'); if (overlay) overlay.setAttribute('data-phase', phase);
    const blobWrap = $('#callBlobWrap'); if (blobWrap) blobWrap.setAttribute('data-state', phase === 'idle' ? 'listening' : phase);
    const statusEl = $('#callStatus'); if (statusEl) statusEl.className = 'call-status';
    if (phase === 'listening') { if (statusEl) { statusEl.textContent = 'Listening…'; statusEl.classList.add('listening'); } }
    else if (phase === 'thinking') { if (statusEl) { statusEl.textContent = 'Thinking…'; statusEl.classList.add('thinking'); } }
    else if (phase === 'speaking') { if (statusEl) { statusEl.textContent = 'Speaking…'; statusEl.classList.add('speaking'); } }
    else if (phase === 'waiting') { if (statusEl) { statusEl.textContent = 'Tap Send or speak again'; statusEl.classList.add('waiting'); } }
    else if (phase === 'held') { if (statusEl) statusEl.textContent = 'On hold'; }
    else { if (statusEl) { statusEl.textContent = 'Listening…'; statusEl.classList.add('listening'); } }
    updateCallSendVisibility();
  }
  function updateCallSendVisibility() {
    const btn = $('#callSendNowBtn'); if (!btn) return;
    const show = __call.active && !__call.holding && (__call.phase === 'listening' || __call.phase === 'idle' || __call.phase === 'waiting');
    btn.style.display = show ? 'flex' : 'none';
  }
  function callStopRecog() { if (__call.recog) { try { __call.recog.onend = null; __call.recog.onresult = null; __call.recog.onerror = null; __call.recog.stop(); } catch {} __call.recog = null; } }
  function setCallTranscript(text, interim) { const el = $('#callTranscript'); if (!el) return; el.textContent = text || ''; el.classList.toggle('interim', !!interim); __call.capturedText = text || ''; }
  function startCallRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('Speech recognition is not supported.', 5000, 'err'); endCall(); return; }
    if (!__call.active || !__call.shouldListen || __call.holding || __call.busy) return;
    callStopRecog();
    const recog = new SR(); recog.lang = __call.lang; recog.continuous = true; recog.interimResults = true; recog.maxAlternatives = 1;
    let finalText = ''; let sent = false; let silenceTimer = null;
    const resetSilence = () => { clearTimeout(silenceTimer); silenceTimer = setTimeout(onSilence, CALL_SILENCE_MS); };
    const onSilence = () => { if (sent || !__call.active || __call.holding) return; if (finalText.trim()) { sent = true; callStopRecog(); setCallTranscript(finalText, false); callSendToAI(finalText.trim()); return; } callStopRecog(); __call.shouldListen = false; setCallPhase('waiting'); __call.shouldListen = true; };
    recog.onstart = () => { setCallPhase('listening'); resetSilence(); };
    recog.onresult = (event) => {
      let interim = '', final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) { const r = event.results[i]; if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript; }
      if (final) { finalText = (finalText + ' ' + final).trim(); setCallTranscript(finalText, false); }
      else if (interim) setCallTranscript((finalText + ' ' + interim).trim(), true);
      resetSilence();
    };
    recog.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { toast('Microphone permission denied.', 3500, 'err'); endCall(); } };
    recog.onend = () => { clearTimeout(silenceTimer); __call.recog = null; if (sent) return; if (finalText.trim() && __call.active && !__call.holding) { sent = true; callSendToAI(finalText.trim()); return; } if (__call.active && __call.shouldListen && !__call.holding && !__call.busy) setTimeout(() => { if (__call.active && __call.shouldListen && !__call.holding && !__call.busy) startCallRecognition(); }, 300); };
    __call.recog = recog;
    try { recog.start(); } catch (e) {}
  }
  function callForceSend() {
    if (!__call.active || __call.holding || __call.busy) return;
    const text = (__call.capturedText || '').trim();
    if (!text) { toast('Say something first, or tap the mic.', 2200); __call.shouldListen = true; callStopRecog(); setCallPhase('idle'); setTimeout(() => { if (__call.active && __call.shouldListen && !__call.holding) startCallRecognition(); }, 150); return; }
    callStopRecog(); setCallTranscript(text, false); callSendToAI(text);
  }
  async function callSendToAI(userText) {
    if (!__call.active) return;
    __call.busy = true; setCallPhase('thinking');
    const replyEl = $('#callReply'); if (replyEl) { replyEl.textContent = ''; replyEl.classList.remove('typing'); }
    __call.currentHistory.push({ role: 'user', content: userText });
    if (__call.currentHistory.length > 12) __call.currentHistory.splice(0, __call.currentHistory.length - 12);
    const langTag = __call.lang.split('-')[0];
    const turnIndex = __call.currentHistory.filter((m) => m.role === 'user').length;
    const isFirstReply = turnIndex <= 1;
    const callSystem = `You are Mirox on a live voice call. Reply ONLY in language code "${langTag}". Keep replies short — 1 to 2 sentences. No markdown, no <thinking>, no code blocks, no emojis. Be warm. ${isFirstReply ? 'Greet them briefly.' : 'Do not re-greet.'}`;
    let fullReply = '';
    const controller = new AbortController(); __call.currentAbort = controller;
    try {
      const res = await fetch(APP_CHAT_URL, { method: 'POST', headers: authHeaders(), credentials: 'same-origin', body: JSON.stringify({ message: userText, history: __call.currentHistory.slice(0, -1).map((m) => ({ role: m.role, content: m.content })), model: __model || 'mirox-luna-1.2', stream: true, deep_think: false, system_extra: callSystem, guest_id: getGuestId(), language: langTag }), signal: controller.signal });
      if (!res.ok) { let detail = 'HTTP ' + res.status; try { const d = await res.json(); detail = d.error?.message || d.error || d.message || detail; } catch {} throw new Error(detail); }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const pl = line.slice(5).trim();
          if (!pl || pl === '[DONE]') continue;
          let o; try { o = JSON.parse(pl); } catch { continue; }
          if (o.error) throw new Error(typeof o.error === 'string' ? o.error : (o.error.message || 'error'));
          const delta = o.d || o.content || '';
          if (delta) { fullReply += delta; const clean = stripThinkingLeak(fullReply).replace(/```[\s\S]*?```/g, '').trim(); setCallPhase('speaking'); if (replyEl) replyEl.textContent = clean; }
        }
      }
      const finalReply = stripThinkingLeak(fullReply).replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim() || "Hmm, I didn't catch that. Say again?";
      if (replyEl) { replyEl.textContent = finalReply; replyEl.classList.remove('typing'); }
      __call.currentHistory.push({ role: 'assistant', content: finalReply });
      __call.busy = false;
      if (!__call.active) return;
      if (__call.holding) { setCallPhase('held'); return; }
      await speak(finalReply, __call.lang);
      if (__call.active && !__call.holding) { await new Promise((r) => setTimeout(r, 300)); if (__call.active && !__call.holding) { __call.shouldListen = true; setCallTranscript('', false); setCallPhase('idle'); startCallRecognition(); } }
      else if (__call.active) setCallPhase('held');
    } catch (e) {
      if (e && e.name === 'AbortError') { __call.busy = false; return; }
      if (replyEl) { replyEl.textContent = 'Connection issue — try again.'; replyEl.classList.remove('typing'); }
      __call.busy = false;
      if (__call.active && !__call.holding) setTimeout(() => { if (__call.active && !__call.holding) { __call.shouldListen = true; setCallPhase('idle'); startCallRecognition(); } }, 1200);
    } finally { __call.currentAbort = null; __call.busy = false; }
  }
  function startCall() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('Your browser does not support speech recognition.', 4500, 'err'); return; }
    if (!ttsAvailable) { toast('Your browser does not support text-to-speech.', 4000, 'err'); return; }
    __call.active = true; __call.shouldListen = true; __call.holding = false; __call.busy = false;
    __call.currentHistory = []; __call.currentAbort = null; __call.capturedText = '';
    const overlay = $('#callOverlay'); if (overlay) overlay.classList.add('open');
    const langSel = $('#callLangSelect');
    if (langSel) { const pref = (__prefs.responseLanguage && __prefs.responseLanguage !== 'auto') ? __prefs.responseLanguage : (navigator.language || 'en-US'); const match = Array.from(langSel.options).find((o) => o.value.toLowerCase().startsWith(pref.toLowerCase().split('-')[0])); if (match) langSel.value = match.value; __call.lang = langSel.value || 'en-US'; }
    setCallTranscript('', false);
    const replyEl = $('#callReply'); if (replyEl) { replyEl.textContent = ''; replyEl.classList.remove('typing'); }
    const liveText = $('#callLiveText'); if (liveText) liveText.textContent = 'Live';
    const holdBtn = $('#callHoldBtn'); if (holdBtn) holdBtn.classList.remove('active');
    setCallPhase('idle');
    setTimeout(() => { if (__call.active && __call.shouldListen && !__call.holding) startCallRecognition(); }, 400);
  }
  function toggleCallHold() {
    if (!__call.active) return;
    __call.holding = !__call.holding;
    const holdBtn = $('#callHoldBtn'); const liveText = $('#callLiveText');
    if (__call.holding) { callStopRecog(); stopSpeaking(); setCallPhase('held'); holdBtn?.classList.add('active'); if (liveText) liveText.textContent = 'On hold'; }
    else { holdBtn?.classList.remove('active'); if (liveText) liveText.textContent = 'Live'; __call.shouldListen = true; setCallPhase('idle'); if (!__call.busy) startCallRecognition(); }
  }
  function endCall() {
    __call.active = false; __call.shouldListen = false; __call.holding = false; __call.busy = false;
    callStopRecog();
    if (__call.currentAbort) { try { __call.currentAbort.abort(); } catch {} __call.currentAbort = null; }
    stopSpeaking();
    const overlay = $('#callOverlay'); if (overlay) overlay.classList.remove('open');
    setCallPhase('idle');
    const liveText = $('#callLiveText'); if (liveText) liveText.textContent = 'Live';
    const holdBtn = $('#callHoldBtn'); if (holdBtn) holdBtn.classList.remove('active');
  }

  /* ---------- Support ---------- */
  function supportSetHead() { const el = $('#supportHeadSub'); if (!el) return; if (!__user) { el.textContent = 'Sign in to chat with our team'; return; } if (!__supportConv) { el.textContent = 'Live chat with our team'; return; } if (__supportConv.status === 'closed') { el.textContent = 'Conversation closed'; return; } el.textContent = 'Live · usually replies in a few hours'; }
  function supportUpdateComposeState() {
    const input = $('#supportInput'), send = $('#supportSendBtn'), catRow = $('#supportCatRow'), resolveBtn = $('#supportResolveBtn'), hint = $('#supportInputHint');
    const conv = __supportConv; const closed = conv && conv.status === 'closed'; const canChat = !!__user;
    if (input) { input.disabled = !canChat || closed; input.placeholder = !canChat ? 'Sign in to send a message…' : (closed ? 'This conversation is closed.' : 'Type your message…'); }
    if (send) { const enabled = canChat && !closed && (input?.value || '').trim().length > 0; send.classList.toggle('is-disabled', !enabled); send.setAttribute('aria-disabled', String(!enabled)); }
    if (catRow) catRow.style.display = (conv ? 'none' : (canChat ? '' : 'none'));
    if (resolveBtn) resolveBtn.style.display = (conv && conv.status === 'open') ? '' : 'none';
    if (hint) hint.textContent = !canChat ? 'Sign in to chat with support' : (closed ? 'Conversation closed.' : 'Enter to send · Shift+Enter for a new line');
  }
  function supportRenderMessages() {
    const box = $('#supportChatMessages'); if (!box) return;
    const conv = __supportConv;
    if (!conv || !conv.messages || !conv.messages.length) { box.innerHTML = `<div class="support-chat-empty"><div class="support-chat-empty-icon"><i class="ri-chat-smile-2-line"></i></div><div class="support-chat-empty-title">${__user ? 'How can we help?' : 'Sign in to chat'}</div><div class="support-chat-empty-sub">${__user ? 'Send us a message and a member of our team will reply right here.' : 'Sign in with your name and email so we can help you.'}</div></div>`; return; }
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
    const input = $('#supportInput'); const content = (input?.value || '').trim(); if (!content) return;
    const category = ($('#supportCategory')?.value || 'other');
    __supportSending = true; const send = $('#supportSendBtn'); if (send) send.classList.add('is-disabled');
    const r = await netFetch('/api/support/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, category }) }, 15000).catch(() => null);
    __supportSending = false;
    if (!r || !r.ok) { toast('Could not send', 3000, 'err'); supportUpdateComposeState(); return; }
    const d = await r.json().catch(() => ({}));
    if (d && d.ok) { if (input) { input.value = ''; input.style.height = 'auto'; } __supportConv = d.conversation; supportSetHead(); supportUpdateComposeState(); supportRenderMessages(); }
  }
  async function supportResolve() { if (!__user) return; if (!confirm('Mark this conversation as resolved?')) return; await jsonOr('/api/support/close', { method: 'POST' }, null, 10000); await supportLoad(); }
  function supportStartPolling() { if (__supportPollTimer) return; __supportPollTimer = setInterval(() => { if ($('#supportModal')?.classList.contains('open')) supportLoad(); }, 6000); }
  function supportStopPolling() { if (__supportPollTimer) { clearInterval(__supportPollTimer); __supportPollTimer = null; } }
  function openSupportModal() { openModal('supportModal'); supportLoad(); supportStartPolling(); }
  function closeSupportModal() { closeModal('supportModal'); supportStopPolling(); }

  /* ---------- Bridge ---------- */
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
  function addBridgeActionBubble(cmd) { const c = $('#bridgeMessages'); if (!c) return null; const data = getActionData(cmd); const el = document.createElement('div'); el.className = 'bridge-msg ai'; el.innerHTML = `<div class="bridge-action"><div class="bridge-action-head"><div class="bridge-action-icon"><i class="${data.icon}"></i></div><div class="bridge-action-label">${data.label}</div><span class="bridge-action-status"><i class="ri-loader-4-line spin"></i> Working</span></div></div>`; c.appendChild(el); scrollBridgeBottom(); return el; }
  function updateBridgeActionBubble(el, cmd, result) { if (!el) return; const status = el.querySelector('.bridge-action-status'); if (!status) return; if (result && result.ok) { status.className = 'bridge-action-status ok'; status.innerHTML = '<i class="ri-check-line"></i> Done'; } else if (result && result.cancelled) { status.className = 'bridge-action-status err'; status.innerHTML = '<i class="ri-close-line"></i> Cancelled'; } else { status.className = 'bridge-action-status err'; status.innerHTML = '<i class="ri-close-line"></i> Failed'; } scrollBridgeBottom(); }
  function getBaseName(p) { if (!p) return ''; const parts = String(p).split('/'); return parts[parts.length - 1] || p; }
  function getActionData(cmd) { const t2 = cmd.type; const base = getBaseName(cmd.path) || ''; if (t2 === 'write') return { icon: 'ri-file-add-line', label: `Writing <code>${escapeHtml(base)}</code>` }; if (t2 === 'append') return { icon: 'ri-file-edit-line', label: `Appending <code>${escapeHtml(base)}</code>` }; if (t2 === 'exec') return { icon: 'ri-terminal-box-line', label: 'Running command' }; if (t2 === 'sudo') return { icon: 'ri-shield-keyhole-line', label: 'sudo' }; return { icon: 'ri-terminal-line', label: 'Working' }; }
  function setProgressText(text) { const el = $('#bwProgressText'); if (el && text) el.textContent = text; }
  function updateBridgeProgress(pct, text) { const np = Math.max(0, Math.min(100, Math.round(pct))); if (np > bridgeProgress) bridgeProgress = np; const bar = $('#bwProgress'), fill = $('#bwProgressFill'), pctEl = $('#bwProgressPct'); if (bar) bar.style.display = 'block'; if (fill) { fill.style.width = bridgeProgress + '%'; fill.classList.toggle('done', bridgeProgress >= 100); } if (pctEl) pctEl.textContent = bridgeProgress + '%'; if (text) setProgressText(text); }
  function extractBridgeCommands(text) {
    const cmds = []; const add = (type, mm, extra) => cmds.push(Object.assign({ type, index: mm.index }, extra));
    const rules = [[/<bridge-sudo>([\s\S]*?)<\/bridge-sudo>/g, 'sudo', (m) => ({ command: m[1].trim() })], [/<bridge-exec>([\s\S]*?)<\/bridge-exec>/g, 'exec', (m) => ({ command: m[1].trim() })], [/<bridge-write\s+path="([^"]+)">([\s\S]*?)<\/bridge-write>/g, 'write', (m) => ({ path: m[1], content: m[2] })], [/<bridge-append\s+path="([^"]+)">([\s\S]*?)<\/bridge-append>/g, 'append', (m) => ({ path: m[1], content: m[2] })], [/<bridge-delete\s+path="([^"]+)"\s*\/>/g, 'delete', (m) => ({ path: m[1] })], [/<bridge-read\s+path="([^"]+)"\s*\/>/g, 'read', (m) => ({ path: m[1] })], [/<bridge-list\s+path="([^"]+)"\s*\/>/g, 'list', (m) => ({ path: m[1] })]];
    for (const [re, type, fn] of rules) { re.lastIndex = 0; let m; while ((m = re.exec(text)) !== null) add(type, m, fn(m)); }
    cmds.sort((a, b) => a.index - b.index); return cmds;
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
    if (t2 === 'write') return bridgeCall('/write', { path: cmd.path, content: cmd.content });
    if (t2 === 'append') return bridgeCall('/append', { path: cmd.path, content: cmd.content });
    if (t2 === 'delete') return bridgeCall('/delete', { path: cmd.path });
    if (t2 === 'read') return bridgeCall('/read', { path: cmd.path });
    if (t2 === 'list') return bridgeCall('/list', { path: cmd.path });
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
    const r = await netFetch(APP_CHAT_URL, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ message: `${envBlock}\n\n${lastMsg.content}`, history: history.slice(0, -1).map((h) => ({ role: h.role, content: h.content })), model: 'mirox-tail-r1', stream: false, deep_think: !!__prefs.deepThink && !__limitReached }) }, 120000);
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
        let reply = '';
        try { reply = await fetchBridgeReply(bridgeConversation); } catch (e) { addBridgeSystemMsg('AI error: ' + e.message); break; }
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
            const sig = cmdSignature(cmd); if (shouldBlockSignature(sig)) continue;
            bridgeTurn.commandLog.set(sig, (bridgeTurn.commandLog.get(sig) || 0) + 1);
            if (cmd.type === 'write' || cmd.type === 'append') bridgeTurn.plannedFiles.add(cmd.path);
            const bubble = addBridgeActionBubble(cmd);
            let result; try { result = await executeBridgeCommand(cmd); } catch (e) { result = { ok: false, error: e.message }; }
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
        if (saidDone && (allFilesWritten || !hasPlan)) { updateBridgeProgress(100, 'Complete'); bridgeTaskComplete = true; break; }
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
    inp.value = ''; inp.style.height = 'auto'; updateBridgeSendBtn(); runBridgeTurn(text, false);
  }
  async function openPreview(pathOrEmpty) {
    const modal = $('#bwPreviewModal'); if (!modal) return;
    const frame = $('#bwPreviewFrame'); const subtitle = $('#bwPreviewSubtitle'); const pathInput = $('#bwPreviewPath');
    modal.classList.add('open');
    const targetPath = absBridgePath(pathOrEmpty || pathInput?.value.trim() || __lastPreviewFile || '', __bridge.env?.home || '');
    if (pathInput) pathInput.value = targetPath;
    if (!targetPath) { if (subtitle) subtitle.textContent = 'No project yet'; return; }
    if (subtitle) subtitle.textContent = targetPath;
    try { const r = await bridgeCall('/read', { path: targetPath }); if (!r || !r.ok) throw new Error(r?.error || 'could not read file'); if (frame) frame.srcdoc = r.content || ''; } catch (e) { if (frame) frame.srcdoc = `<html><body style="font-family:system-ui;padding:40px;color:#b91c1c"><h2>Preview failed</h2><p>${escapeHtml(e.message)}</p></body></html>`; }
  }
  function closePreview() { $('#bwPreviewModal')?.classList.remove('open'); }

  /* ---------- MCP manager ---------- */
  function renderMcpList() {
    const list = document.getElementById('mcpList'); if (!list) return;
    const settings = (__user && __user.settings) || safeGet(LOCAL_SETTINGS_KEY, {});
    const servers = settings.mcp_servers || [];
    if (!servers.length) { list.innerHTML = '<div class="mcp-empty">No MCP servers configured.</div>'; return; }
    list.innerHTML = servers.map((s, i) => `<div class="mcp-item" data-idx="${i}"><div class="mcp-item-body"><div class="mcp-item-name">${escapeHtml(s.name || s.id)} <span class="mcp-item-badge ${s.enabled ? 'on' : 'off'}">${s.enabled ? 'On' : 'Off'}</span></div><div class="mcp-item-url">${escapeHtml(s.url || '(stdio)')}</div></div><div class="mcp-item-actions"><button class="icon-btn" data-mcp-act="edit"><i class="ri-edit-line"></i></button><button class="icon-btn" data-mcp-act="del"><i class="ri-delete-bin-line"></i></button></div></div>`).join('');
    list.querySelectorAll('.mcp-item').forEach((item) => {
      const idx = parseInt(item.dataset.idx, 10);
      item.querySelector('[data-mcp-act="edit"]').onclick = () => openMcpEditor(idx);
      item.querySelector('[data-mcp-act="del"]').onclick = () => deleteMcpServer(idx);
    });
  }
  function openMcpEditor(idx) {
    const editor = document.getElementById('mcpEditor'); if (!editor) return;
    editor.style.display = '';
    const settings = (__user && __user.settings) || safeGet(LOCAL_SETTINGS_KEY, {});
    const servers = settings.mcp_servers || [];
    const s = typeof idx === 'number' ? servers[idx] : null;
    editor.dataset.editingIdx = typeof idx === 'number' ? String(idx) : '';
    document.getElementById('mcpId').value = s?.id || '';
    document.getElementById('mcpName').value = s?.name || '';
    document.getElementById('mcpUrl').value = s?.url || '';
    document.getElementById('mcpHeaders').value = s?.headers ? JSON.stringify(s.headers) : '';
    document.getElementById('mcpEnabled').checked = s ? s.enabled !== false : true;
  }
  function closeMcpEditor() { const e = document.getElementById('mcpEditor'); if (e) e.style.display = 'none'; }
  async function saveMcpServer() {
    const id = (document.getElementById('mcpId')?.value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const name = (document.getElementById('mcpName')?.value || '').trim() || id;
    const url = (document.getElementById('mcpUrl')?.value || '').trim();
    const enabled = !!document.getElementById('mcpEnabled')?.checked;
    let headers = {};
    try { const raw = document.getElementById('mcpHeaders')?.value.trim(); if (raw) headers = JSON.parse(raw); } catch { toast('Headers must be valid JSON', 3000, 'err'); return; }
    if (!id || !url) { toast('ID and URL are required', 3000, 'err'); return; }
    const existing = await jsonOr('/api/settings', {}, null, 7000);
    const current = existing?.settings || safeGet(LOCAL_SETTINGS_KEY, {});
    const servers = Array.isArray(current.mcp_servers) ? current.mcp_servers.slice() : [];
    const editingIdx = document.getElementById('mcpEditor')?.dataset.editingIdx;
    const entry = { id, name, url, headers, transport: 'http', enabled };
    if (editingIdx !== '' && editingIdx != null) servers[parseInt(editingIdx, 10)] = entry;
    else { if (servers.some((x) => x.id === id)) { toast('ID already exists', 3000, 'err'); return; } servers.push(entry); }
    const body = { ...current, mcp_servers: servers };
    safeSet(LOCAL_SETTINGS_KEY, body);
    if (!__user || __user.local) { toast('MCP server saved locally', 1800, 'ok'); await refreshUsage(); renderMcpList(); closeMcpEditor(); return; }
    const result = await jsonOr('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, null, 9000);
    if (result?.ok) { toast('MCP server saved', 1800, 'ok'); await refreshUsage(); renderMcpList(); closeMcpEditor(); }
    else toast('Saved locally', 1800, 'ok');
    renderMcpList(); closeMcpEditor();
  }
  async function deleteMcpServer(idx) {
    if (!confirm('Delete this MCP server?')) return;
    const existing = await jsonOr('/api/settings', {}, null, 7000);
    const current = existing?.settings || safeGet(LOCAL_SETTINGS_KEY, {});
    const servers = Array.isArray(current.mcp_servers) ? current.mcp_servers.slice() : [];
    servers.splice(idx, 1);
    const body = { ...current, mcp_servers: servers };
    safeSet(LOCAL_SETTINGS_KEY, body);
    if (__user && !__user.local) await jsonOr('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, null, 9000);
    toast('MCP server deleted', 1800, 'ok'); await refreshUsage(); renderMcpList();
  }

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
    on('#myMiroxBtn', 'click', (e) => { e.preventDefault(); openModal('myMiroxModal'); renderMyMirox(); });
    $$('.sidebar-tab').forEach((tab) => {
      tab.onclick = () => {
        const tabKey = tab.dataset.tab;
        $$('.sidebar-tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tabKey));
        $$('.sidebar-section').forEach((s) => { s.style.display = s.dataset.pane === tabKey ? '' : 'none'; });
        if (tabKey === 'images') loadImageHistory().catch(() => {});
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
    document.addEventListener('click', (e) => { if (!e.target.closest('#modelPicker')) closeModelPicker(); if (!e.target.closest('#pluginsPopover') && !e.target.closest('#pluginsModeBtn')) closePluginsPopover(); });
    on('#deepThinkBtn', 'click', () => {
      if (__limitReached && __tier === 'free') { toast('Free quota reached. Upgrade to use DeepThink.', 3500, 'err'); return; }
      __prefs.deepThink = !__prefs.deepThink;
      savePrefs(); applyDeepThinkUI(); updateModePill();
      if (__prefs.deepThink) toast('DeepThink is on — model reasons longer. Image generation disabled.', 3500, 'ok');
      else toast('DeepThink off.', 1800);
    });
    on('#searchModeBtn', 'click', (e) => { e.preventDefault(); forceSearchNext = !forceSearchNext; $('#searchModeBtn')?.classList.toggle('active', forceSearchNext); updateModePill(); });
    on('#imageModeBtn', 'click', () => {
      if (__prefs.deepThink) { toast('Turn off DeepThink to generate images.', 3500, 'err'); return; }
      if (!__user) { requireSignIn('Sign in to use Lumenal and generate images.'); return; }
      openModal('imageModal');
    });
    on('#pluginsModeBtn', 'click', (e) => { e.stopPropagation(); togglePluginsPopover(); });
    on('#pluginsCloseBtn', 'click', (e) => { e.stopPropagation(); closePluginsPopover(); });
    on('#sidebarImagesDeleteAll', 'click', deleteAllImages);
    on('#tailPromoTryBtn', 'click', tryTailPromo);
    on('#tailPromoLaterBtn', 'click', dismissTailPromo);
    on('#callModeBtn', 'click', startCall);
    on('#callEndBtn', 'click', endCall);
    on('#callHoldBtn', 'click', toggleCallHold);
    on('#callSendNowBtn', 'click', callForceSend);
    on('#callLangSelect', 'change', (e) => { __call.lang = e.target.value; if (__call.active && !__call.busy) { __call.shouldListen = true; callStopRecog(); setTimeout(() => { if (__call.active && __call.shouldListen && !__call.holding) startCallRecognition(); }, 220); } });
    on('#plansModeBtn', 'click', () => { openModal('plansModal'); loadPlans(); });
    on('#supportModeBtn', 'click', (e) => { e.preventDefault(); openSupportModal(); });
    on('#supportModeBtn2', 'click', () => openSupportModal());
    on('#bridgeModeBtn', 'click', openBridgeWorkspace);
    on('#bridgeOpenBtn', 'click', openBridgeWorkspace);
    on('#generateImageBtn', 'click', genImage);
    on('#settingsBtn', 'click', (e) => { e.preventDefault(); openSettingsModal(); });
    on('#logoutBtn', 'click', doLogout);
    on('#savePersonalizationBtn', 'click', () => savePersonalizationSettings().catch(() => { const s = document.getElementById('personalizationSaveStatus'); if (s) s.textContent = 'Save failed. Please retry.'; }));
    on('#signInFromSettingsBtn', 'click', () => { closeModal('settingsModal'); setLoginError(''); openModal('loginModal'); });
    on('#supportResolveBtn', 'click', supportResolve);
    on('#supportSendBtn', 'click', supportSend);
    on('#clearImagesBtn', 'click', () => { closeModal('settingsModal'); deleteAllImages(); });
    const supInput = $('#supportInput');
    if (supInput) {
      supInput.addEventListener('input', () => { supInput.style.height = 'auto'; supInput.style.height = Math.min(supInput.scrollHeight, 140) + 'px'; supportUpdateComposeState(); });
      supInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); supportSend(); } });
    }
    on('#rawViewCopyBtn', 'click', async () => { try { await navigator.clipboard.writeText(__currentRawSource || ''); toast('Source copied', 1800, 'ok'); } catch {} });
    $$('.html-runner-tab').forEach((t) => { t.onclick = () => { $$('.html-runner-tab').forEach((x) => x.classList.toggle('active', x === t)); $$('.html-runner-pane').forEach((p) => { p.style.display = p.dataset.hrPane === t.dataset.hrTab ? 'flex' : 'none'; }); }; });
    on('#hrReloadBtn', 'click', () => { const f = $('#hrIframe'); if (f) f.srcdoc = __hrCurrentCode; });
    on('#hrCopyBtn', 'click', async () => { try { await navigator.clipboard.writeText(__hrCurrentCode); toast('Source copied', 1800, 'ok'); } catch {} });
    on('#hrOpenBtn', 'click', () => { const w = window.open('', '_blank'); if (w) { w.document.open(); w.document.write(__hrCurrentCode); w.document.close(); } });
    $$('.settings-tab').forEach((tab) => {
      tab.onclick = () => {
        const tabKey = tab.dataset.tab;
        $$('.settings-tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tabKey));
        $$('.settings-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tabKey));
        if (tabKey === 'mcp') renderMcpList();
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
    bindToggle('autoSpeakToggle', 'autoSpeak');
    bindToggle('toolsToggle', 'tools');
    const ttsSel = document.getElementById('ttsVoiceSelect');
    if (ttsSel) ttsSel.addEventListener('change', () => { __prefs.ttsVoice = ttsSel.value; savePrefs(); });
    on('#uiLanguageSelect', 'change', (e) => { __prefs.uiLanguage = e.target.value; savePrefs(); if (isTranslatable(__prefs.uiLanguage)) toast('Translating…'); applyTranslations(); });
    on('#languageSelect', 'change', (e) => { __prefs.responseLanguage = e.target.value; savePrefs(); });
    on('#exportChatsBtn', 'click', () => { const blob = new Blob([JSON.stringify(__conversations, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `mirox-chats-${Date.now()}.json`; document.body.appendChild(a); a.click(); document.body.removeChild(a); toast('Exported'); });
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
    if (bwInp) { bwInp.addEventListener('input', () => { bwInp.style.height = 'auto'; bwInp.style.height = Math.min(bwInp.scrollHeight, 140) + 'px'; updateBridgeSendBtn(); }); bwInp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleBridgeSend(); } }); }
    on('#bridgeSendBtn', 'click', handleBridgeSend);
    $$('.bw-quick').forEach((btn) => { btn.onclick = () => { const inp2 = $('#bridgeInput'); if (inp2) { inp2.value = btn.dataset.q; updateBridgeSendBtn(); } handleBridgeSend(); }; });
    on('#mcpAddBtn', 'click', () => openMcpEditor());
    on('#mcpCancelBtn', 'click', closeMcpEditor);
    on('#mcpSaveBtn', 'click', () => saveMcpServer().catch(() => {}));
    on('#quotaUpgradeBtn', 'click', () => { if (!__user) { setLoginError(''); openModal('loginModal'); } else { openModal('plansModal'); loadPlans(); } });
    document.addEventListener('click', (e) => {
      const cb = e.target.closest('[data-close]');
      if (cb) { const target = cb.dataset.close; if (target === 'supportModal') { closeSupportModal(); return; } if (target === 'htmlRunnerModal') { closeHtmlRunner(); return; } if (target === 'rawViewModal') { closeRawView(); return; } if (target === 'tailPromoModal') { dismissTailPromo(); return; } closeModal(target); return; }
      if (e.target.classList.contains('modal-overlay')) {
        if (e.target.id === 'supportModal') { closeSupportModal(); return; }
        if (e.target.id === 'htmlRunnerModal') { closeHtmlRunner(); return; }
        if (e.target.id === 'rawViewModal') { closeRawView(); return; }
        if (e.target.id === 'tailPromoModal') { dismissTailPromo(); return; }
        e.target.classList.remove('open');
      }
      if (e.target.closest('[data-iv-close]')) closeImageViewer();
    });
    on('#userChip', 'click', () => { if (!__user) { setLoginError(''); openModal('loginModal'); } });
    on('#upgradeBtn', 'click', (e) => { e.stopPropagation(); if (!__user) { setLoginError(''); openModal('loginModal'); } else { openModal('plansModal'); loadPlans(); } });
    on('#simpleLoginForm', 'submit', doLogin);
    on('#ivDownload', 'click', () => { if (!__ivDataUrl) return; const c = $('#ivCanvas'); const href = (c && c.width > 0) ? c.toDataURL('image/png') : __ivDataUrl; const a = document.createElement('a'); a.href = href; a.download = `mirox-${Date.now()}.png`; document.body.appendChild(a); a.click(); document.body.removeChild(a); });
    on('#filePreviewCopyBtn', 'click', async () => { if (!__previewFileRef) return; try { await navigator.clipboard.writeText(__previewFileRef.content || ''); toast('Copied file content', 1800, 'ok'); } catch {} });
    on('#filePreviewAskBtn', 'click', () => { const f = __previewFileRef; if (!f) return; closeFilePreview(); const inp2 = $('#messageInput'); if (inp2) { inp2.value = `Please read the attached file "${f.name}" and explain what it does, then suggest improvements.`; inp2.style.height = 'auto'; inp2.style.height = Math.min(inp2.scrollHeight, 180) + 'px'; updateSendButtonState(); inp2.focus(); } });
    bindSuggestionClicks();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if ($('#callOverlay')?.classList.contains('open')) { endCall(); return; }
        closeImageViewer(); closeModelPicker(); closePluginsPopover(); stopSpeaking();
        if ($('#filePreviewModal')?.classList.contains('open')) { closeFilePreview(); return; }
        if ($('#htmlRunnerModal')?.classList.contains('open')) { closeHtmlRunner(); return; }
        if ($('#rawViewModal')?.classList.contains('open')) { closeRawView(); return; }
        if ($('#bridgeWorkspace')?.classList.contains('open')) { closeBridgeWorkspace(); return; }
        if ($('#sudoModal')?.classList.contains('open')) { skipSudo(); return; }
        if ($('#supportModal')?.classList.contains('open')) { closeSupportModal(); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('#messageInput')?.focus(); }
    });
    window.addEventListener('resize', () => { if (window.innerWidth > 860) closeSidebar(); });
    if (!IS_PC) document.querySelectorAll('#bridgeModeBtn, #bridgeOpenBtn, [data-pane="bridge"], .sidebar-tab[data-tab="bridge"]').forEach((el) => { el.style.display = 'none'; });
  }

  function openSettingsModal() {
    applyPrefs(); updateAccountUI(); loadVoices(); openModal('settingsModal');
    loadPersonalizationSettings().catch(() => {});
    renderMcpList();
  }
  async function loadPersonalizationSettings() {
    const status = document.getElementById('personalizationSaveStatus');
    const local = safeGet(LOCAL_SETTINGS_KEY, {});
    const put = (id, value) => { const el = document.getElementById(id); if (el) el.value = value || ''; };
    put('personaSettingInput', local.persona || '');
    put('personalizationNameInput', local.personalization?.name);
    put('personalizationNicknameInput', local.personalization?.nickname);
    put('personalizationAboutInput', local.personalization?.about);
    put('personalizationToneSelect', local.personalization?.tone || 'default');
    if (status) status.textContent = __user && !__user.local ? '' : 'Saved on this device.';
    if (__user && !__user.local) {
      const data = await jsonOr('/api/settings', {}, null, 7000);
      const settings = data?.settings || {};
      const p = settings.personalization || {};
      put('personaSettingInput', settings.persona || '');
      put('personalizationNameInput', p.name);
      put('personalizationNicknameInput', p.nickname);
      put('personalizationAboutInput', p.about);
      put('personalizationToneSelect', p.tone || 'default');
    }
  }
  async function savePersonalizationSettings() {
    const status = document.getElementById('personalizationSaveStatus');
    const local = safeGet(LOCAL_SETTINGS_KEY, {});
    const body = {
      ...local,
      persona: document.getElementById('personaSettingInput')?.value || '',
      personalization: {
        ...(local.personalization || {}),
        name: document.getElementById('personalizationNameInput')?.value || '',
        nickname: document.getElementById('personalizationNicknameInput')?.value || '',
        about: document.getElementById('personalizationAboutInput')?.value || '',
        tone: document.getElementById('personalizationToneSelect')?.value || 'default',
      },
    };
    safeSet(LOCAL_SETTINGS_KEY, body);
    if (__user && __user.settings) __user.settings = { ...(__user.settings || {}), ...body };

    if (!__user || __user.local) {
      if (status) status.textContent = 'Saved on this device.';
      toast('Persona saved locally', 1800, 'ok');
      return;
    }
    try {
      const result = await jsonOr('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, null, 9000);
      if (result?.ok) { if (status) status.textContent = 'Saved.'; toast('Persona saved', 1800, 'ok'); }
      else { if (status) status.textContent = 'Saved locally. Sign in to sync across devices.'; toast('Persona saved locally', 1800, 'ok'); }
    } catch {
      if (status) status.textContent = 'Saved locally.';
      toast('Persona saved locally', 1800, 'ok');
    }
  }

  async function openConversation(id) {
    const convo = __conversations.find((c) => c.id === id); if (!convo) return;
    currentConversationId = id;
    const ttl = $('#chatTitle'); if (ttl) ttl.textContent = convo.title || 'Chat';
    const c = $('#chatMessages'); if (c) c.innerHTML = '';
    let lastAiEl = null, lastAiMessage = null;
    for (const m of convo.messages || []) {
      const img = (m.imageKey ? await idb.get(m.imageKey).catch(() => null) : null) || m.imageData || null;
      const rendered = addMessageToDOM(m.role, m.content, m.ts, m.id, m.files || [], img, m.thinking);
      if (m.role === 'assistant') { lastAiEl = rendered; lastAiMessage = m; }
    }
    if (lastAiEl && lastAiMessage) { const lastBubble = lastAiEl.querySelector('.bubble'); if (lastBubble && shouldShowContinue(lastAiMessage.content || '', true)) attachContinueButton(lastAiEl, lastBubble, lastAiMessage); }
    renderHistory(); updateTokenUsage(); scrollToBottom(true);
  }

  const idb = (() => {
    let p = null;
    const open = () => p || (p = new Promise((res, rej) => { if (!('indexedDB' in window)) return rej(new Error('no idb')); const r = indexedDB.open('mirox', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    return { async set(k, v) { const db = await open(); return new Promise((res, rej) => { const t2 = db.transaction('kv', 'readwrite'); t2.objectStore('kv').put(v, k); t2.oncomplete = () => res(true); t2.onerror = () => rej(t2.error); }); }, async get(k) { const db = await open(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); }); } };
  })();

  async function init() {
    try {
      try { const t = localStorage.getItem('mirox_token'); if (t && !isApiKey(t)) localStorage.removeItem('mirox_token'); } catch {}
      loadPrefs();
      loadI18nCache();
      loadReactions();
      loadGrowth();
      loadPlugins();
      const limitState = safeGet(LIMIT_REACHED_KEY, null);
      if (limitState && limitState.at && Date.now() - limitState.at < 3 * 3600 * 1000) { __limitReached = true; }
      applyAppearanceFromPrefs();
      applyPrefs();
      loadChats();
      loadBridgeOpts();
      wireAll();
      setupVoice();
      if (ttsAvailable) loadVoices();
      const local = getLocalUser();
      if (local) { __user = { name: local.name, email: local.email, tier: 'free', local: true, settings: safeGet(LOCAL_SETTINGS_KEY, {}) }; __tier = 'free'; }
      updateAccountUI();
      renderHistory();
      renderModelPicker();
      renderBridgeStatus();
      updateModePill();
      if (__limitReached) showQuotaRow(limitState.reason || 'Free quota used up');
      else hideQuotaRow();
      updateTokenUsage();
      applyTranslations();
      applyDeepThinkUI();
      setTimeout(() => loadImageHistory().catch(() => {}), 800);
      showTailPromo();
    } catch (e) { console.error('[Mirox init]', e); }
    finally { killLoader(); }
    loadConfig().catch(() => {});
    refreshUsage().catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
