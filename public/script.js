(function () {
  'use strict';

  /* ----- Loader failsafe ----- */
  function killLoader() {
    const el = document.getElementById('loadingScreen');
    if (!el) return;
    el.classList.add('hidden');
    setTimeout(() => { el.style.display = 'none'; }, 700);
  }
  window.__miroxKillLoader = killLoader;
  setTimeout(killLoader, 1000);
  setTimeout(killLoader, 2500);
  window.addEventListener('error', () => killLoader());

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };

  /* ----- Models & constants ----- */
  const FALLBACK_MODELS = [
    { id: 'mirox-luna-1.2', label: 'Luna', tagline: 'Fast · warm · unlimited', tier: 'free', default: true },
    { id: 'mirox-gen-1', label: 'Gen', tagline: 'Ultra concise · unlimited', tier: 'free' },
    { id: 'mirox-pro-5', label: 'Pro', tagline: 'Balanced · deeper', tier: 'pro' },
    { id: 'mirox-ultra-10', label: 'Ultra', tagline: 'Deep reasoning', tier: 'pro' },
    { id: 'mirox-eclipse-2.0', label: 'Eclipse', tagline: 'Best quality · 5/day free', tier: 'ultimate' },
  ];
  const TIER_RANK = { free: 0, pro: 1, ultimate: 2 };
  const LS_KEY = 'miroxai_conversations_v23';
  const TOKEN_KEY = 'mirox_token';
  const APPEARANCE_KEY = 'miroxai_appearance_v23';
  const BRIDGE_KEY = 'miroxai_bridge_v23';
  const MAX_BRIDGE_QUESTIONS = 6;
  const MAX_BRIDGE_ITER = 12;

  let __config = null;
  let __user = null;
  let __tier = 'free';
  let __model = 'mirox-luna-1.2';
  let currentConversationId = null;
  let isReplying = false;
  let __conversations = [];
  let pendingFiles = [];
  let activeStreamController = null;
  let __usage = null;
  let __bridge = { name: 'My Laptop', model: 'mirox-luna-1.2', port: 8765, connected: false, baseUrl: null, log: [] };
  let bridgeConversation = [];
  let bridgeRunning = false;
  let bridgeQuestionCount = 0;

  /* ----- Utils ----- */
  const uid = () => 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const escapeHtml = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  function safeGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
  function safeSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
  function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }

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

  /* ----- Modals ----- */
  const openModal = (id) => { const el = document.getElementById(id); if (el) el.classList.add('open'); };
  const closeModal = (id) => { const el = document.getElementById(id); if (el) el.classList.remove('open'); };
  const openSidebar = () => { $('#sidebar')?.classList.add('open'); $('#sidebarScrim')?.classList.add('open'); };
  const closeSidebar = () => { $('#sidebar')?.classList.remove('open'); $('#sidebarScrim')?.classList.remove('open'); };

  /* ----- Appearance ----- */
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

  /* ----- Markdown ----- */
  function renderMarkdown(text) {
    if (!text) return '';
    let src = String(text);
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
      : `<span style="font-size:11px;color:var(--accent);opacity:.75;">writing…</span>`;
    return `<div class="code-block"><div class="code-block-header"><span class="code-lang-label">${escapeHtml(label)}</span>${btn}</div><pre><code>${escapeHtml(raw)}</code></pre></div>`;
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
    (scope || document).querySelectorAll('.code-action-btn[data-copy]').forEach(btn => {
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

  /* ----- Conversations ----- */
  function currentConvo() { return __conversations.find(c => c.id === currentConversationId) || null; }
  function saveChats() { safeSet(LS_KEY, __conversations); }
  function loadChats() { __conversations = safeGet(LS_KEY, []); }
  function welcomeHTML() {
    return `<div class="welcome-screen">
      <img src="/logo.png" alt="MiroxAI" class="welcome-logo theme-aware-logo" onerror="this.style.display='none'; this.nextElementSibling.style.display='grid';">
      <div class="logo-fallback logo-fallback-lg" style="display:none;">M</div>
      <h1 class="welcome-title">Hi, I'm Mirox</h1>
      <p class="welcome-sub">Luna and Gen are unlimited and free.</p>
      <div class="suggestion-grid">
        <button class="suggestion-card" type="button" data-prompt="Generate me an image of a cat"><i class="ri-image-line"></i><span>Generate me an image of a cat</span></button>
        <button class="suggestion-card" type="button" data-prompt="Help me write code"><i class="ri-code-line"></i><span>Help me write code</span></button>
        <button class="suggestion-card" type="button" data-prompt="Explain a concept simply"><i class="ri-lightbulb-line"></i><span>Explain a concept simply</span></button>
        <button class="suggestion-card" type="button" data-prompt="Open the Bridge workspace"><i class="ri-link"></i><span>Bridge to my laptop</span></button>
      </div>
    </div>`;
  }
  function startNewChat() {
    currentConversationId = null;
    const t = $('#chatTitle'); if (t) t.textContent = 'New chat';
    const c = $('#chatMessages'); if (c) c.innerHTML = welcomeHTML();
    bindSuggestionClicks();
    renderHistory();
  }
  function bindSuggestionClicks() {
    $$('.suggestion-card').forEach(card => {
      if (card.__wired) return; card.__wired = true;
      card.onclick = () => {
        const p = card.dataset.prompt;
        if (p === 'Open the Bridge workspace') { openBridgeWorkspace(); return; }
        const inp = $('#messageInput');
        if (p && inp) { inp.value = p; updateSendButtonState(); handleSend(); }
      };
    });
  }
  function renderHistory() {
    const list = $('#historyList'); if (!list) return;
    if (!__conversations.length) { list.innerHTML = '<li class="history-empty">No conversations yet</li>'; return; }
    list.innerHTML = __conversations.map(c =>
      `<li class="history-item${c.id === currentConversationId ? ' active' : ''}" data-id="${c.id}">
        <i class="ri-chat-3-line"></i>
        <span class="history-title">${escapeHtml(c.title || 'Chat')}</span>
        <button class="history-delete icon-btn"><i class="ri-delete-bin-line"></i></button>
      </li>`
    ).join('');
  }
  function scrollToBottom() { const c = $('#chatMessages'); if (c) c.scrollTop = c.scrollHeight; }

  /* ----- Messages ----- */
  function addMessageToDOM(role, content, ts, msgId, files, image) {
    const container = $('#chatMessages'); if (!container) return null;
    const welcome = container.querySelector('.welcome-screen'); if (welcome) welcome.remove();
    const id = msgId || uid();
    const el = document.createElement('div');
    el.className = 'message ' + (role === 'user' ? 'user' : 'ai');
    el.dataset.msgId = id;
    el.dataset.role = role;

    let inner = '';
    if (role === 'user' && files && files.length) {
      inner += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;">';
      for (const f of files) {
        if (f.type === 'image' && f.dataUrl) inner += `<div class="attach-chip"><img src="${f.dataUrl}" alt="">${escapeHtml(f.name || '')}</div>`;
        else inner += `<div class="attach-chip"><i class="ri-file-line"></i>${escapeHtml(f.name || 'file')}</div>`;
      }
      inner += '</div>';
    }
    if (role === 'ai' && image) {
      inner += `<div style="margin-bottom:10px;border-radius:14px;overflow:hidden;border:1px solid var(--border);max-width:400px;cursor:zoom-in;"><img src="${image}" style="display:block;width:100%;" draggable="false"></div>`;
    }
    inner += '<div class="bubble-text"></div>';

    el.innerHTML = `<div class="bubble">${inner}</div>
      <div class="message-actions">
        <button class="action-btn" data-action="copy" title="Copy"><i class="ri-file-copy-line"></i></button>
        ${role === 'ai' ? '<button class="action-btn" data-action="retry" title="Retry"><i class="ri-refresh-line"></i></button>' : ''}
      </div>
      <div class="message-time">${ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</div>`;

    container.appendChild(el);
    const bt = el.querySelector('.bubble-text');
    const bubble = el.querySelector('.bubble');

    if (role === 'user') {
      bt.textContent = content || '';
      if (!content) bt.style.display = 'none';
    } else {
      bubble.dataset.rawText = content || '';
      if (content) { bt.innerHTML = renderMarkdown(content); wireCopyButtons(bt); }
    }

    if (role === 'ai' && image) {
      const img = el.querySelector('img');
      if (img) img.onclick = () => openImageViewer(image);
    }

    wireMessageActions(el);
    scrollToBottom();
    return el;
  }
  function addThinkingBubble() {
    const container = $('#chatMessages'); if (!container) return null;
    const welcome = container.querySelector('.welcome-screen'); if (welcome) welcome.remove();
    const id = uid();
    const el = document.createElement('div');
    el.className = 'message ai'; el.dataset.msgId = id; el.dataset.role = 'ai';
    el.innerHTML = `<div class="bubble thinking"><span class="thinking-text">Thinking</span><span class="thinking-dots"><span></span><span></span><span></span></span></div><div class="message-time"></div>`;
    container.appendChild(el);
    scrollToBottom();
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
    convo.messages = convo.messages.slice(0, idx);
    saveChats();
    let s = el.nextElementSibling;
    while (s) { const n = s.nextElementSibling; s.remove(); s = n; }
    el.remove();
    sendToAPI(userMsg.content, userMsg.files || []);
  }

  /* ----- Send ----- */
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
    sendToAPI(text, files);
  }

  async function sendToAPI(text, files) {
    isReplying = true; updateSendButtonState();
    const stopBtn = $('#stopBtn'); if (stopBtn) stopBtn.style.display = 'grid';
    const convo = currentConvo();
    const history = convo ? convo.messages.slice(-14).map(m => ({ role: m.role, content: m.content })) : [];
    const model = __model || 'mirox-luna-1.2';
    const el = addThinkingBubble();
    if (!el) { isReplying = false; return; }
    const bubble = el.querySelector('.bubble');
    const timeEl = el.querySelector('.message-time');
    const aiMsgId = el.dataset.msgId;
    activeStreamController = new AbortController();

    let full = '', generatedImage = null, finishReason = 'stop';
    let bubbleText = null, firstChunk = true;

    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text, history, model, stream: true, files,
          bridge: __bridge.connected ? { connected: true, name: __bridge.name, model: __bridge.model } : null,
        }),
        signal: activeStreamController.signal,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error?.message || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
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
            if (o.img) {
              generatedImage = o.img;
              bubble.classList.remove('thinking');
              bubble.innerHTML = `<div style="margin-bottom:10px;border-radius:14px;overflow:hidden;border:1px solid var(--border);max-width:400px;cursor:zoom-in;"><img src="${o.img}" style="display:block;width:100%;" draggable="false"></div><div class="bubble-text"></div>`;
              bubbleText = bubble.querySelector('.bubble-text');
              const img = bubble.querySelector('img'); if (img) img.onclick = () => openImageViewer(o.img);
              firstChunk = false;
              scrollToBottom();
              refreshUsage();
              continue;
            }
            if (o.d) {
              full += o.d;
              if (firstChunk) {
                bubble.classList.remove('thinking');
                if (!generatedImage) { bubble.innerHTML = '<div class="bubble-text"></div>'; bubbleText = bubble.querySelector('.bubble-text'); }
                firstChunk = false;
              }
              const target = bubbleText || bubble.querySelector('.bubble-text');
              if (target) { target.innerHTML = renderMarkdown(full); wireCopyButtons(target); }
              scrollToBottom();
            }
            if (o.error) throw new Error(o.error.message || o.error);
            if (o.done && o.finish_reason) finishReason = o.finish_reason;
          } catch {}
        }
      }

      finalizeBubble(bubble, full);
      if (convo) convo.messages.push({ id: aiMsgId, role: 'assistant', content: full, ts: Date.now(), image: generatedImage, finish_reason: finishReason });
      saveChats();
      if (timeEl) timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      refreshUsage();
    } catch (e) {
      bubble.classList.remove('thinking');
      if (e.name !== 'AbortError') bubble.textContent = 'Error: ' + e.message;
      else bubble.textContent = '(stopped)';
    } finally {
      isReplying = false;
      activeStreamController = null;
      if (stopBtn) stopBtn.style.display = 'none';
      updateSendButtonState();
    }
  }
  function finalizeBubble(bubble, text) {
    const bt = bubble?.querySelector('.bubble-text');
    if (!bt) return;
    bt.innerHTML = renderMarkdown(text || '');
    wireCopyButtons(bt);
  }
  function stopStreaming() {
    if (activeStreamController) { try { activeStreamController.abort(); } catch {} activeStreamController = null; }
    isReplying = false;
    const s = $('#stopBtn'); if (s) s.style.display = 'none';
    updateSendButtonState();
  }

  /* ----- Files ----- */
  function handleFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const arr = Array.from(fileList);
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
    function finish() {
      newFiles.sort((a, b) => (a.order || 0) - (b.order || 0));
      pendingFiles = pendingFiles.concat(newFiles);
      updatePreview();
      updateSendButtonState();
    }
  }
  function updatePreview() {
    const p = $('#attachmentPreview'), list = $('#attachmentList');
    if (!p || !list) return;
    if (!pendingFiles.length) { p.style.display = 'none'; list.innerHTML = ''; return; }
    p.style.display = 'flex';
    list.innerHTML = pendingFiles.map(f => f.type === 'image' && f.dataUrl
      ? `<div class="attach-chip"><img src="${f.dataUrl}" alt="">${escapeHtml(f.name)}</div>`
      : `<div class="attach-chip"><i class="ri-file-line"></i>${escapeHtml(f.name)}</div>`
    ).join('');
  }

  /* ----- Image viewer ----- */
  let __ivDataUrl = '';
  function openImageViewer(url) {
    if (!url) return;
    __ivDataUrl = url;
    const iv = $('#imageViewer'); if (!iv) return;
    iv.classList.add('open');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = $('#ivCanvas'); if (!c) return;
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
    };
    img.src = url;
  }
  function closeImageViewer() { $('#imageViewer')?.classList.remove('open'); }

  /* ----- Model picker ----- */
  function getModelsList() { return __config?.models?.length ? __config.models : FALLBACK_MODELS; }
  function canUseModel(tier) {
    // Luna and Gen (free) → always allowed
    if (tier === 'free') return true;
    // Eclipse → only free users get 5/day; pro users blocked from eclipse
    if (tier === 'ultimate') return true; // we check the quota in the backend
    // Pro tier → free tier blocked
    return TIER_RANK[__tier] >= TIER_RANK[tier];
  }
  function renderModelPicker() {
    const menu = $('#modelPickerMenu'); if (!menu) return;
    const models = getModelsList();
    const cur = __model || models[0].id;
    menu.innerHTML = models.map(m => {
      const usable = canUseModel(m.tier);
      const lock = usable ? '' : ' locked';
      let lockLabel = '';
      if (!usable) lockLabel = ' · <span style="color:var(--accent);font-size:10.5px;">UPGRADE</span>';
      else if (m.tier === 'ultimate' && __tier === 'free') lockLabel = ' · <span style="color:var(--accent);font-size:10.5px;">5/day free</span>';
      return `<div class="model-option${m.id === cur ? ' active' : ''}${lock}" data-model-id="${m.id}" data-usable="${usable}">
        <span class="model-option-label"><span class="dot"></span>${escapeHtml(m.label)}${lockLabel}</span>
        <span class="model-option-tag">${escapeHtml(m.tagline || '')}</span>
      </div>`;
    }).join('');
    menu.querySelectorAll('.model-option').forEach(opt => {
      opt.onclick = (e) => {
        e.stopPropagation();
        if (opt.dataset.usable === 'false') {
          alert('This model requires the Pro plan.');
          return;
        }
        selectModel(opt.dataset.modelId);
      };
    });
    const c = models.find(m => m.id === cur);
    if (c) { const lbl = $('#currentModelLabel'); if (lbl) lbl.textContent = c.label; }
  }
  function selectModel(id) {
    if (!id) return;
    __model = id;
    const m = getModelsList().find(x => x.id === id);
    if (m) { const lbl = $('#currentModelLabel'); if (lbl) lbl.textContent = m.label; }
    renderModelPicker();
    closeModelPicker();
  }
  function openModelPicker() { $('#modelPicker')?.classList.add('open'); $('#modelPickerMenu')?.classList.add('open'); }
  function closeModelPicker() { $('#modelPicker')?.classList.remove('open'); $('#modelPickerMenu')?.classList.remove('open'); }

  /* ----- Credit bar ----- */
  function renderCreditBar() {
    const bar = $('#creditBar'); if (!bar) return;
    // Hide for paid users
    if (!__usage || __tier !== 'free') { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';

    const vl = __usage.vision_limit ?? 10, vu = __usage.vision_used ?? 0;
    const il = __usage.image_limit ?? 10, iu = __usage.image_used ?? 0;
    const el = __usage.eclipse_limit ?? 5, eu = __usage.eclipse_used ?? 0;

    const setPill = (sel, used, limit) => {
      const pill = bar.querySelector(sel); if (!pill) return;
      const txt = pill.querySelector('span');
      const rem = Math.max(0, limit - used);
      if (txt) txt.textContent = `${rem}/${limit}`;
      pill.classList.toggle('low', rem <= Math.max(1, Math.floor(limit * 0.25)) && rem > 0);
      pill.classList.toggle('empty', rem <= 0);
    };
    setPill('[data-credit="vision"]', vu, vl);
    setPill('[data-credit="image"]', iu, il);
    setPill('[data-credit="eclipse"]', eu, el);
  }
  async function refreshUsage() {
    const res = await authJson('/api/me', {}, null);
    if (!res?.user) {
      __user = null; __usage = null; __tier = 'free';
      renderCreditBar();
      const chip = $('#userChip');
      if (chip) {
        chip.querySelector('.user-name').textContent = 'Guest mode';
        chip.querySelector('.user-sub').textContent = 'Sign in to save chats';
      }
      return;
    }
    __user = res.user;
    __tier = res.user.tier || 'free';
    __usage = {
      daily_limit: res.user.daily_limit ?? null,
      daily_used: res.user.daily_used ?? 0,
      unlimited_chat: !!res.user.unlimited_chat,
      vision_limit: res.user.vision_limit ?? 10,
      vision_used: res.user.vision_used ?? 0,
      image_limit: res.user.image_limit ?? 10,
      image_used: res.user.image_used ?? 0,
      eclipse_limit: res.user.eclipse_limit ?? 5,
      eclipse_used: res.user.eclipse_used ?? 0,
    };
    renderCreditBar();
    const chip = $('#userChip');
    if (chip) {
      chip.querySelector('.user-name').textContent = res.user.name || res.user.email;
      chip.querySelector('.user-sub').textContent = (__tier.charAt(0).toUpperCase() + __tier.slice(1)) + ' plan';
    }
    renderModelPicker();
  }

  /* ----- Config ----- */
  async function loadConfig() {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      const data = await res.json();
      if (data?.models?.length) __config = data;
    } catch {}
    if (!__config) __config = { models: FALLBACK_MODELS };
    __model = getModelsList()[0].id;
    renderModelPicker();
  }

  /* ----- Auth ----- */
  async function doLogin(e) {
    if (e) e.preventDefault();
    const name = $('#loginName')?.value.trim();
    const email = $('#loginEmail')?.value.trim().toLowerCase();
    if (!name || !email) return;
    const res = await authJson('/api/auth/simple-login', { method: 'POST', body: JSON.stringify({ name, email }) }, null);
    if (res?.ok) {
      setToken(res.token);
      closeModal('loginModal');
      await refreshUsage();
    } else alert(res?.error || 'Login failed');
  }
  async function doLogout() {
    await authJson('/api/logout', { method: 'POST' }, null);
    setToken('');
    await refreshUsage();
    closeModal('settingsModal');
  }

  /* ----- Plans ----- */
  async function loadPlans() {
    const grid = $('#plansGrid'); if (!grid) return;
    const res = await authJson('/api/subscription/plans', {}, null);
    if (!res?.plans) { grid.innerHTML = '<div class="history-empty">Could not load.</div>'; return; }
    grid.innerHTML = res.plans.map(p => {
      const isCurrent = p.id === __tier;
      const price = p.id === 'free'
        ? '<div style="font-size:26px;font-weight:700;">Free</div>'
        : `<div style="font-size:32px;font-weight:700;">$${p.price_usd.toFixed(2)}</div><div style="font-size:12px;color:var(--text-muted);">≈ ${p.price_afg} AFG / mo</div>`;
      return `<div class="plan-card${isCurrent ? ' current' : ''}">
        <div class="plan-name">${escapeHtml(p.label)}</div>
        <div class="plan-tagline">${escapeHtml(p.tagline || '')}</div>
        ${price}
        <ul style="font-size:13px;color:var(--text-muted);line-height:1.8;margin-top:8px;">
          ${(p.perks || []).map(x => `<li>✓ ${escapeHtml(x)}</li>`).join('')}
        </ul>
      </div>`;
    }).join('');
  }

  /* ----- Persona ----- */
  async function loadPersona() {
    if (!__user) return;
    const res = await authJson('/api/persona', {}, null);
    const inp = $('#personaInput');
    if (inp && res?.persona) inp.value = res.persona;
  }
  async function savePersona() {
    const status = $('#personaStatus');
    if (!__user) { if (status) { status.textContent = 'Sign in first.'; status.className = 'persona-status err'; } return; }
    const inp = $('#personaInput'); if (!inp) return;
    if (status) { status.textContent = 'Saving…'; status.className = 'persona-status'; }
    const res = await authJson('/api/persona', { method: 'POST', body: JSON.stringify({ persona: inp.value.trim() }) }, null);
    if (res?.ok) { if (status) { status.textContent = 'Saved ✓'; status.className = 'persona-status ok'; } setTimeout(() => { if (status) status.textContent = ''; }, 2000); }
    else { if (status) { status.textContent = 'Failed.'; status.className = 'persona-status err'; } }
  }

  /* ----- Image gen ----- */
  async function genImage() {
    const inp = $('#imagePrompt'); const prompt = inp?.value.trim();
    if (!prompt) return alert('Describe the image first.');
    const btn = $('#generateImageBtn'), result = $('#imageResult');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
    if (result) result.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">Generating…</div>';
    try {
      const res = await fetch('/v1/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, aspect_ratio: '1:1' }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok && data.image) {
        if (result) result.innerHTML = `<img src="${data.image}" alt="${escapeHtml(prompt)}">`;
        refreshUsage();
      } else if (result) {
        result.innerHTML = `<div style="color:#dc2626;font-size:13px;">Failed: ${escapeHtml(data.error?.message || 'Unknown')}</div>`;
      }
    } catch (e) {
      if (result) result.innerHTML = `<div style="color:#dc2626;font-size:13px;">Error: ${escapeHtml(e.message)}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ri-image-add-line"></i> Generate'; }
    }
  }

  /* =========================================================
     BRIDGE
     ========================================================= */
  function loadBridgeLS() {
    const b = safeGet(BRIDGE_KEY, {});
    __bridge = { ...__bridge, ...b, connected: false, baseUrl: null, log: b.log || [] };
  }
  function saveBridgeLS() { safeSet(BRIDGE_KEY, { name: __bridge.name, model: __bridge.model, port: __bridge.port, log: __bridge.log.slice(0, 100) }); }
  function bridgeLog(msg, type = 'info') {
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    __bridge.log.unshift({ ts: t, msg, type });
    __bridge.log = __bridge.log.slice(0, 100);
    saveBridgeLS();
    renderBridgeLog();
  }
  function renderBridgeLog() {
    const el = $('#bridgeLog'); if (!el) return;
    if (!__bridge.log.length) { el.innerHTML = '<div style="color:var(--text-faint);">No bridge activity yet.</div>'; return; }
    el.innerHTML = __bridge.log.map(l => `<div class="log-line log-${l.type}"><span class="log-time">${l.ts}</span>${escapeHtml(l.msg)}</div>`).join('');
  }
  function renderBridgeStatus() {
    [['#bridgeStatus', '.bridge-status-dot'], ['#bwStatusPill', '.bridge-status-dot'], ['#bwStatusBox', '.bridge-status-dot']].forEach(([sel, dotSel]) => {
      const wrap = document.querySelector(sel); if (!wrap) return;
      const dot = wrap.querySelector(dotSel);
      const txt = wrap.querySelector('span');
      if (dot) { dot.classList.toggle('online', __bridge.connected); dot.classList.toggle('offline', !__bridge.connected); }
      if (txt) txt.textContent = __bridge.connected ? 'Connected' : 'Disconnected';
    });
    const c = $('#bwConnectBtn'), d = $('#bwDisconnectBtn');
    if (c) c.style.display = __bridge.connected ? 'none' : 'flex';
    if (d) d.style.display = __bridge.connected ? 'flex' : 'none';
    updateBridgeSendBtn();
  }
  function setBridgeStatusStrip(mode, mainText, subText) {
    const strip = $('#bwStatusStrip');
    if (!strip) return;
    if (!mode) { strip.style.display = 'none'; return; }
    strip.style.display = 'flex';
    const t = $('#bwStatusText'); if (t) t.textContent = mainText || '';
    const s = $('#bwStatusSub'); if (s) s.textContent = subText || '';
  }
  async function testBridge(port) {
    for (const host of ['localhost', '127.0.0.1']) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(`http://${host}:${port}/ping`, { signal: ctrl.signal, mode: 'cors' });
        clearTimeout(t);
        if (r.ok) { const d = await r.json(); if (d && d.ok) return { ok: true, data: d, base: `http://${host}:${port}` }; }
      } catch {}
    }
    return { ok: false };
  }
  async function startBridge() {
    const name = ($('#bwNameInput')?.value || __bridge.name).trim();
    const model = $('#bwModelSelect')?.value || __bridge.model;
    const port = parseInt($('#bwPortInput')?.value || __bridge.port, 10);
    __bridge.name = name; __bridge.model = model; __bridge.port = port;
    saveBridgeLS();
    renderBridgeStatus();
    bridgeLog(`Connecting to http://localhost:${port}…`, 'info');
    setBwHint('Connecting…', '');
    const res = await testBridge(port);
    if (res.ok) {
      __bridge.connected = true;
      __bridge.baseUrl = res.base;
      renderBridgeStatus();
      bridgeLog(`✓ Connected to "${res.data.name}"`, 'ok');
      const empty = $('#bridgeEmpty'); if (empty) empty.remove();
      setBwHint('Connected. Ready.', 'ok');
    } else {
      __bridge.connected = false;
      __bridge.baseUrl = null;
      renderBridgeStatus();
      bridgeLog(`✗ Failed on port ${port}`, 'err');
      setBwHint(`Could not reach the bridge on port ${port}.\n\n1. Make sure you ran "python runner.py".\n2. Test in browser: http://localhost:${port}/ping`, 'err');
    }
  }
  function stopBridge() {
    __bridge.connected = false;
    __bridge.baseUrl = null;
    renderBridgeStatus();
    bridgeLog('Disconnected', 'info');
    setBwHint('', '');
  }
  async function bridgeCall(endpoint, payload) {
    if (!__bridge.connected || !__bridge.baseUrl) throw new Error('Bridge not connected');
    const r = await fetch(__bridge.baseUrl + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }
  function downloadBridgeClient() {
    const params = new URLSearchParams({ name: __bridge.name, port: String(__bridge.port), model: __bridge.model });
    const a = document.createElement('a');
    a.href = '/api/bridge/download?' + params.toString();
    a.download = 'mirox_client_bridge.zip';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    bridgeLog('Downloading client package…', 'info');
  }
  function setBwHint(text, cls = '') {
    const el = $('#bwConnectHint'); if (!el) return;
    el.textContent = text;
    el.className = 'bw-hint' + (cls ? ' ' + cls : '');
  }
  function updateBridgeSendBtn() {
    const btn = $('#bridgeSendBtn'), inp = $('#bridgeInput');
    if (!btn || !inp) return;
    const has = inp.value.trim().length > 0;
    const enabled = __bridge.connected && !bridgeRunning && has;
    btn.classList.toggle('is-disabled', !enabled);
    btn.setAttribute('aria-disabled', String(!enabled));
  }

  /* ----- Bridge command parsing ----- */
  function extractBridgeCommands(text) {
    const cmds = [];
    let m;
    const execRe = /<bridge-exec>([\s\S]*?)<\/bridge-exec>/g;
    while ((m = execRe.exec(text)) !== null) cmds.push({ type: 'exec', command: m[1].trim(), index: m.index });
    const writeRe = /<bridge-write\s+path="([^"]+)">([\s\S]*?)<\/bridge-write>/g;
    while ((m = writeRe.exec(text)) !== null) cmds.push({ type: 'write', path: m[1], content: m[2], index: m.index });
    const readRe = /<bridge-read\s+path="([^"]+)"\s*\/>/g;
    while ((m = readRe.exec(text)) !== null) cmds.push({ type: 'read', path: m[1], index: m.index });
    const listRe = /<bridge-list\s+path="([^"]+)"\s*\/>/g;
    while ((m = listRe.exec(text)) !== null) cmds.push({ type: 'list', path: m[1], index: m.index });
    return cmds;
  }
  function extractBridgeQuestions(text) {
    const qs = [];
    const re = /<bridge-ask>([\s\S]*?)<\/bridge-ask>/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const body = m[1].trim();
      const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      const question = lines[0];
      const options = [];
      for (let i = 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('-') || l.startsWith('*')) {
          options.push(l.replace(/^[-*]\s*/, '').trim());
        }
      }
      qs.push({ question, options, index: m.index });
    }
    return qs;
  }

  /* ----- Bridge command execution ----- */
  async function executeBridgeCommand(cmd) {
    if (cmd.type === 'exec') return bridgeCall('/exec', { command: cmd.command });
    if (cmd.type === 'write') return bridgeCall('/write', { path: cmd.path, content: cmd.content });
    if (cmd.type === 'read') return bridgeCall('/read', { path: cmd.path });
    if (cmd.type === 'list') return bridgeCall('/list', { path: cmd.path });
    return { ok: false, error: 'Unknown' };
  }
  function formatResultForAI(cmd, result) {
    const ok = result && result.ok;
    if (!ok) return `[${cmd.type}] ERROR: ${(result && result.error) || 'unknown'}`;
    if (cmd.type === 'exec') return `[exec] exit=${result.exit_code}\nSTDOUT:\n${(result.stdout || '').slice(0, 4000)}\nSTDERR:\n${(result.stderr || '').slice(0, 2000)}`;
    if (cmd.type === 'write') return `[write] ok path=${result.path} bytes=${result.bytes}`;
    if (cmd.type === 'read') return `[read] path=${result.path}\n${(result.content || '').slice(0, 4000)}`;
    if (cmd.type === 'list') return `[list] path=${result.path}\n` + (result.items || []).map(i => (i.is_dir ? 'D ' : 'F ') + i.name).join('\n');
    return '[unknown]';
  }
  function addBridgeCmdResult(cmd, result) {
    const container = $('#bridgeMessages'); if (!container) return;
    const ok = result && result.ok;
    const label = { exec: `$ ${cmd.command}`, write: `→ write ${cmd.path}`, read: `← read ${cmd.path}`, list: `≡ list ${cmd.path}` }[cmd.type] || cmd.type;
    let body = '';
    if (ok) {
      if (cmd.type === 'exec') body = (result.stdout || '') + (result.stderr ? '\n[stderr]\n' + result.stderr : '') + `\n[exit ${result.exit_code}]`;
      else if (cmd.type === 'write') body = `Wrote ${result.bytes} bytes → ${result.path}`;
      else if (cmd.type === 'read') body = result.content || '(empty)';
      else if (cmd.type === 'list') body = (result.items || []).map(i => (i.is_dir ? '📁 ' : '📄 ') + i.name).join('\n');
    } else body = (result && result.error) || 'Unknown error';
    const el = document.createElement('div');
    el.className = 'bridge-cmd-result' + (ok ? '' : ' err');
    el.innerHTML = `<div class="bridge-cmd-label"><i class="ri-terminal-box-line"></i> ${escapeHtml(label)}</div><pre>${escapeHtml(String(body).slice(0, 5000))}</pre>`;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  /* ----- Bridge workspace chat ----- */
  function openBridgeWorkspace() {
    $('#bridgeWorkspace')?.classList.add('open');
    setTimeout(() => { if (__bridge.connected) startBridge(); }, 50);
  }
  function closeBridgeWorkspace() { $('#bridgeWorkspace')?.classList.remove('open'); }
  function clearBridgeChat() {
    const m = $('#bridgeMessages'); if (m) m.innerHTML = '';
    bridgeConversation = [];
    bridgeQuestionCount = 0;
  }
  function addBridgeMsg(role, text) {
    const container = $('#bridgeMessages'); if (!container) return null;
    const empty = $('#bridgeEmpty'); if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'bridge-msg ' + role;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const body = role === 'ai' ? renderMarkdown(text) : escapeHtml(text).replace(/\n/g, '<br>');
    el.innerHTML = `<div class="bridge-bubble">${body}</div><div class="bridge-meta">${role === 'ai' ? 'Mirox' : role === 'user' ? 'You' : 'System'} · ${time}</div>`;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    wireCopyButtons(el);
    return el;
  }

  /* ----- Bridge question modal (Lovable-style) ----- */
  let __bqResolver = null;
  let __bqSelected = null;
  function showBridgeQuestionModal(q, counterText) {
    return new Promise((resolve) => {
      __bqResolver = resolve;
      __bqSelected = null;

      const modal = $('#bridgeQuestionModal'); if (!modal) { resolve(''); return; }
      const txt = $('#bqText'); if (txt) txt.textContent = q.question || '';
      const ctr = $('#bqCounter'); if (ctr) ctr.textContent = counterText;

      const optsWrap = $('#bqOptions'); if (!optsWrap) { resolve(''); return; }
      optsWrap.innerHTML = '';

      if (q.options && q.options.length) {
        q.options.forEach(opt => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'bridge-q-option';
          b.textContent = opt;
          b.onclick = () => {
            __bqSelected = opt;
            optsWrap.querySelectorAll('.bridge-q-option').forEach(x => x.classList.remove('selected'));
            b.classList.add('selected');
          };
          optsWrap.appendChild(b);
        });
      } else {
        // No options → show custom input directly
        const cw = $('#bqCustomWrap'); if (cw) cw.style.display = 'block';
      }

      const cw = $('#bqCustomWrap'); if (cw) cw.style.display = 'none';
      const ci = $('#bqCustomInput'); if (ci) ci.value = '';

      modal.classList.add('open');
      setTimeout(() => { $('#bqCustomInput')?.focus(); }, 100);
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

  /* ----- Fetch AI reply for bridge (non-stream) ----- */
  async function fetchBridgeReply(history) {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: history[history.length - 1].content,
        history: history.slice(0, -1).map(h => ({ role: h.role, content: h.content })),
        model: __bridge.model,
        stream: false,
        bridge: { connected: true, name: __bridge.name, model: __bridge.model, mode: 'developer' },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    return data.reply || data.choices?.[0]?.message?.content || '';
  }

  /* ----- Run the bridge loop ----- */
  async function runBridgeTurn(userText) {
    if (!__bridge.connected) { setBwHint('Bridge is not connected.', 'err'); return; }
    if (bridgeRunning) return;
    bridgeRunning = true;
    bridgeQuestionCount = 0;
    updateBridgeSendBtn();

    addBridgeMsg('user', userText);
    bridgeConversation.push({ role: 'user', content: userText });

    let iter = 0;
    try {
      while (iter++ < MAX_BRIDGE_ITER) {
        // ---- Thinking ----
        setBridgeStatusStrip(true, 'Thinking…', 'model is reasoning');
        bridgeLog('→ thinking…', 'info');

        let reply = '';
        try {
          reply = await fetchBridgeReply(bridgeConversation);
        } catch (e) {
          setBridgeStatusStrip(false);
          addBridgeMsg('system', 'AI error: ' + e.message);
          bridgeLog('AI error: ' + e.message, 'err');
          break;
        }
        if (!reply || !reply.trim()) {
          setBridgeStatusStrip(false);
          break;
        }
        addBridgeMsg('ai', reply);
        bridgeConversation.push({ role: 'assistant', content: reply });
        if (bridgeConversation.length > 30) bridgeConversation = bridgeConversation.slice(-30);

        // ---- Questions (only if we haven't hit 6) ----
        const questions = extractBridgeQuestions(reply);
        if (questions.length > 0 && bridgeQuestionCount < MAX_BRIDGE_QUESTIONS) {
          setBridgeStatusStrip(true, 'Waiting for your answer…', '');
          const q = questions[0];
          const remaining = MAX_BRIDGE_QUESTIONS - bridgeQuestionCount;
          const counterText = `Question ${bridgeQuestionCount + 1} of ${MAX_BRIDGE_QUESTIONS}`;
          const answer = await showBridgeQuestionModal(q, counterText);
          bridgeQuestionCount++;
          addBridgeMsg('user', answer);
          bridgeConversation.push({ role: 'user', content: `[Answer to "${q.question}"] ${answer}` });
          setBridgeStatusStrip(false);
          continue;
        }
        if (questions.length > 0 && bridgeQuestionCount >= MAX_BRIDGE_QUESTIONS) {
          bridgeLog(`Question limit (${MAX_BRIDGE_QUESTIONS}) reached`, 'err');
          addBridgeMsg('system', `Reached question limit (${MAX_BRIDGE_QUESTIONS}). AI must proceed without further questions.`);
          bridgeConversation.push({ role: 'user', content: `[System] Question limit reached. Continue with best-effort defaults and do not ask more questions.` });
          continue;
        }

        // ---- Commands ----
        const cmds = extractBridgeCommands(reply);
        if (cmds.length > 0) {
          const resultLines = [];
          for (let i = 0; i < cmds.length; i++) {
            const cmd = cmds[i];
            const preview = (cmd.command || cmd.path || '').slice(0, 70);
            const label = cmd.type === 'exec' ? `$ ${preview}` : `${cmd.type} ${preview}`;
            setBridgeStatusStrip(true, `Executing (${i + 1}/${cmds.length})…`, label);
            bridgeLog(`→ ${cmd.type}: ${preview}`, 'info');

            let result;
            try {
              result = await executeBridgeCommand(cmd);
            } catch (e) {
              result = { ok: false, error: e.message };
            }
            addBridgeCmdResult(cmd, result);
            resultLines.push(formatResultForAI(cmd, result));
            bridgeLog(`${result.ok ? '✓' : '✗'} ${cmd.type}`, result.ok ? 'ok' : 'err');
          }

          bridgeConversation.push({
            role: 'user',
            content: `[Bridge results]\n${resultLines.join('\n\n')}\n\nContinue with the next step. If the task is completely done, reply with exactly "DONE".`,
          });
          continue;
        }

        // No questions, no commands → done
        if (/\bDONE\b/i.test(reply)) {
          setBridgeStatusStrip(false);
          bridgeLog('✓ Task complete', 'ok');
          addBridgeMsg('system', 'Task complete.');
          break;
        }
        // Otherwise, break out
        setBridgeStatusStrip(false);
        break;
      }
      if (iter >= MAX_BRIDGE_ITER) {
        setBridgeStatusStrip(false);
        addBridgeMsg('system', 'Reached iteration limit.');
      }
    } finally {
      bridgeRunning = false;
      updateBridgeSendBtn();
      setBridgeStatusStrip(false);
    }
  }

  function handleBridgeSend() {
    const inp = $('#bridgeInput'); if (!inp) return;
    const text = inp.value.trim();
    if (!text || bridgeRunning || !__bridge.connected) return;
    inp.value = ''; inp.style.height = 'auto';
    updateBridgeSendBtn();
    runBridgeTurn(text);
  }

  /* ----- Wire everything ----- */
  function wireAll() {
    // Sidebar
    on('#hamburgerBtn', 'click', openSidebar);
    on('#sidebarCloseBtn', 'click', closeSidebar);
    on('#sidebarScrim', 'click', closeSidebar);
    on('#brandLogo', 'click', (e) => { e.preventDefault(); startNewChat(); if (window.innerWidth <= 860) closeSidebar(); });
    on('#newChatBtn', 'click', () => { startNewChat(); if (window.innerWidth <= 860) closeSidebar(); });

    // Sidebar tabs
    $$('.sidebar-tab').forEach(tab => {
      tab.onclick = () => {
        const t = tab.dataset.tab;
        $$('.sidebar-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === t));
        $$('.sidebar-section').forEach(s => { s.style.display = s.dataset.pane === t ? '' : 'none'; });
      };
    });

    // History
    on('#historyList', 'click', (e) => {
      const item = e.target.closest('.history-item'); if (!item) return;
      if (e.target.closest('.history-delete')) {
        const id = item.dataset.id;
        __conversations = __conversations.filter(c => c.id !== id);
        if (currentConversationId === id) startNewChat();
        saveChats(); renderHistory();
        return;
      }
      const id = item.dataset.id;
      const convo = __conversations.find(c => c.id === id);
      if (!convo) return;
      currentConversationId = id;
      const t = $('#chatTitle'); if (t) t.textContent = convo.title || 'Chat';
      const c = $('#chatMessages'); if (c) c.innerHTML = '';
      for (const m of convo.messages || []) addMessageToDOM(m.role, m.content, m.ts, m.id, m.files || [], m.image);
      renderHistory();
      scrollToBottom();
      if (window.innerWidth <= 860) closeSidebar();
    });

    // Composer
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
    }
    on('#sendBtn', 'click', handleSend);
    on('#attachBtn', 'click', () => $('#fileInput')?.click());
    on('#fileInput', 'change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
    on('#removeAttachmentBtn', 'click', () => { pendingFiles = []; updatePreview(); updateSendButtonState(); });
    on('#stopBtn', 'click', stopStreaming);

    // Model picker
    on('#modelPickerBtn', 'click', (e) => {
      e.stopPropagation();
      const menu = $('#modelPickerMenu');
      if (menu?.classList.contains('open')) closeModelPicker(); else openModelPicker();
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('#modelPicker')) closeModelPicker(); });

    // Tools
    on('#imageModeBtn', 'click', () => openModal('imageModal'));
    on('#plansModeBtn', 'click', () => { openModal('plansModal'); loadPlans(); });
    on('#supportModeBtn', 'click', () => openModal('supportModal'));
    on('#supportModeBtn2', 'click', () => openModal('supportModal'));
    on('#bridgeModeBtn', 'click', openBridgeWorkspace);
    on('#bridgeOpenBtn', 'click', openBridgeWorkspace);
    on('#generateImageBtn', 'click', genImage);

    // Support submit
    on('#submitReportBtn', 'click', () => {
      const s = $('#supportSubject')?.value.trim();
      const m = $('#supportMessage')?.value.trim();
      if (!s || !m) return alert('Fill subject and message.');
      alert('Ticket submitted!');
      closeModal('supportModal');
    });

    // Settings
    on('#settingsBtn', 'click', () => { openModal('settingsModal'); loadPersona(); });
    on('#logoutBtn', 'click', doLogout);
    on('#savePersonaBtn', 'click', savePersona);
    $$('.settings-tab').forEach(tab => {
      tab.onclick = () => {
        const t = tab.dataset.tab;
        $$('.settings-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === t));
        $$('.settings-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === t));
      };
    });

    // Appearance
    $$('[data-mode]').forEach(b => b.onclick = () => applyAppearance({ mode: b.dataset.mode, theme: document.documentElement.getAttribute('data-theme') || 'default' }));
    $$('.swatch').forEach(b => b.onclick = () => applyAppearance({ mode: document.documentElement.getAttribute('data-mode') || 'light', theme: b.dataset.theme }));

    // Modal close
    document.addEventListener('click', (e) => {
      const cb = e.target.closest('[data-close]');
      if (cb) { closeModal(cb.dataset.close); return; }
      if (e.target.classList.contains('modal-overlay') && e.target.id !== 'bridgeQuestionModal') e.target.classList.remove('open');
    });

    // User chip / upgrade
    on('#userChip', 'click', () => { if (!__user) openModal('loginModal'); });
    on('#upgradeBtn', 'click', (e) => { e.stopPropagation(); if (!__user) openModal('loginModal'); else { openModal('plansModal'); loadPlans(); } });

    // Login
    on('#simpleLoginForm', 'submit', doLogin);

    // Image viewer
    document.addEventListener('click', (e) => { if (e.target.closest('[data-iv-close]')) closeImageViewer(); });
    on('#ivDownload', 'click', () => {
      if (!__ivDataUrl) return;
      const a = document.createElement('a');
      a.href = __ivDataUrl; a.download = `mirox-${Date.now()}.png`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    });

    // Bridge
    on('#bwCloseBtn', 'click', closeBridgeWorkspace);
    on('#bwNewBtn', 'click', clearBridgeChat);
    on('#bwDownloadBtn', 'click', downloadBridgeClient);
    on('#bridgeDownloadBtn', 'click', downloadBridgeClient);
    on('#bwConnectBtn', 'click', startBridge);
    on('#bwDisconnectBtn', 'click', stopBridge);
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
    $$('.bw-quick').forEach(btn => {
      btn.onclick = () => {
        const q = btn.dataset.q;
        const inp = $('#bridgeInput');
        if (inp) { inp.value = q; updateBridgeSendBtn(); }
        handleBridgeSend();
      };
    });

    // Bridge question modal buttons
    on('#bqCustomToggle', 'click', () => {
      const cw = $('#bqCustomWrap');
      if (cw) { cw.style.display = cw.style.display === 'none' ? 'block' : 'none'; if (cw.style.display === 'block') $('#bqCustomInput')?.focus(); }
    });
    on('#bqSubmit', 'click', submitBridgeQuestion);
    on('#bqCustomInput', 'keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitBridgeQuestion(); }
    });

    // Suggestion cards
    bindSuggestionClicks();

    // Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeImageViewer();
        closeModelPicker();
        if ($('#bridgeWorkspace')?.classList.contains('open')) closeBridgeWorkspace();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        $('#messageInput')?.focus();
      }
    });
  }

  /* ----- Init ----- */
  async function init() {
    try {
      loadAppearance();
      loadBridgeLS();
      wireAll();
      renderModelPicker();
      renderBridgeStatus();
      renderBridgeLog();
      updateBridgeSendBtn();
      await loadConfig();
      loadChats();
      renderHistory();
      await refreshUsage();
    } catch (e) {
      console.error('[Mirox init]', e);
    } finally {
      killLoader();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
