(function () {
  'use strict';

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
  const MAX_BRIDGE_ITER = 40;
  const MAX_AUTO_CONTINUES = 3;
  const MAX_DUP_COMMANDS = 1;

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
  let __bridge = { name: 'My Laptop', model: 'mirox-luna-1.2', port: 8765, connected: false, baseUrl: null, env: null };
  let bridgeConversation = [];
  let bridgeRunning = false;
  let bridgeQuestionCount = 0;
  let bridgeProgress = 0;
  let bridgeTurn = null;
  let __pendingQuestions = [];
  let __bqResolver = null;
  let __bqSelected = null;

  const uid = () => 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const escapeHtml = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  function safeGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
  function safeSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
  function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }

  async function authJson(url, opts = {}, fallback = null) {
    try {
      const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      const t = getToken();
      if (t) headers.Authorization = 'Bearer ' + t;
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
      inner += `<div style="margin-bottom:10px;border-radius:14px;overflow:hidden;border:1px solid var(--border);max-width:100%;cursor:zoom-in;"><img src="${image}" style="display:block;width:100%;" draggable="false"></div>`;
    }
    inner += '<div class="bubble-text"></div>';
    el.innerHTML = `<div class="bubble">${inner}</div>
      <div class="message-actions">
        <button class="action-btn" data-action="copy"><i class="ri-file-copy-line"></i></button>
        ${role === 'ai' ? '<button class="action-btn" data-action="retry"><i class="ri-refresh-line"></i></button>' : ''}
      </div>
      <div class="message-time">${ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</div>`;
    container.appendChild(el);
    const bt = el.querySelector('.bubble-text');
    const bubble = el.querySelector('.bubble');
    if (role === 'user') { bt.textContent = content || ''; if (!content) bt.style.display = 'none'; }
    else { bubble.dataset.rawText = content || ''; if (content) { bt.innerHTML = renderMarkdown(content); wireCopyButtons(bt); } }
    if (role === 'ai' && image) { const img = el.querySelector('img'); if (img) img.onclick = () => openImageViewer(image); }
    wireMessageActions(el);
    scrollToBottom();
    return el;
  }
  function addThinkingBubble() {
    const container = $('#chatMessages'); if (!container) return null;
    const welcome = container.querySelector('.welcome-screen'); if (welcome) welcome.remove();
    const id = uid();
    const el = document.createElement('div');
    el.className = 'message ai';
    el.dataset.msgId = id;
    el.dataset.role = 'ai';
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
        body: JSON.stringify({ message: text, history, model, stream: true, files, bridge: __bridge.connected ? { connected: true, name: __bridge.name, model: __bridge.model, env: __bridge.env } : null }),
        signal: activeStreamController.signal,
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error?.message || `HTTP ${res.status}`); }
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
              bubble.innerHTML = `<div style="margin-bottom:10px;border-radius:14px;overflow:hidden;border:1px solid var(--border);max-width:100%;cursor:zoom-in;"><img src="${o.img}" style="display:block;width:100%;" draggable="false"></div><div class="bubble-text"></div>`;
              bubbleText = bubble.querySelector('.bubble-text');
              const img = bubble.querySelector('img'); if (img) img.onclick = () => openImageViewer(o.img);
              firstChunk = false; scrollToBottom(); refreshUsage(); continue;
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
      const bt = bubble.querySelector('.bubble-text');
      if (bt) { bt.innerHTML = renderMarkdown(full); wireCopyButtons(bt); }
      if (convo) convo.messages.push({ id: aiMsgId, role: 'assistant', content: full, ts: Date.now(), image: generatedImage, finish_reason: finishReason });
      saveChats();
      if (timeEl) timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      refreshUsage();
    } catch (e) {
      bubble.classList.remove('thinking');
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
    function finish() { newFiles.sort((a, b) => (a.order || 0) - (b.order || 0)); pendingFiles = pendingFiles.concat(newFiles); updatePreview(); updateSendButtonState(); }
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

  function getModelsList() { return __config?.models?.length ? __config.models : FALLBACK_MODELS; }
  function canUseModel(tier) {
    if (tier === 'free') return true;
    if (tier === 'ultimate') return true;
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
      else if (m.tier === 'ultimate' && __tier === 'free') lockLabel = ' · <span style="color:var(--accent);font-size:10.5px;">5/day</span>';
      return `<div class="model-option${m.id === cur ? ' active' : ''}${lock}" data-model-id="${m.id}" data-usable="${usable}">
        <span class="model-option-label"><span class="dot"></span>${escapeHtml(m.label)}${lockLabel}</span>
        <span class="model-option-tag">${escapeHtml(m.tagline || '')}</span>
      </div>`;
    }).join('');
    menu.querySelectorAll('.model-option').forEach(opt => {
      opt.onclick = (e) => {
        e.stopPropagation();
        if (opt.dataset.usable === 'false') { alert('This model requires the Pro plan.'); return; }
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
      const txt = pill.querySelector('span');
      const rem = Math.max(0, limit - used);
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
    renderModelPicker();
  }
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
  async function doLogin(e) {
    if (e) e.preventDefault();
    const name = $('#loginName')?.value.trim();
    const email = $('#loginEmail')?.value.trim().toLowerCase();
    if (!name || !email) return;
    const res = await authJson('/api/auth/simple-login', { method: 'POST', body: JSON.stringify({ name, email }) }, null);
    if (res?.ok) { setToken(res.token); closeModal('loginModal'); await refreshUsage(); }
    else alert(res?.error || 'Login failed');
  }
  async function doLogout() {
    await authJson('/api/logout', { method: 'POST' }, null);
    setToken('');
    await refreshUsage();
    closeModal('settingsModal');
  }
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
  async function genImage() {
    const inp = $('#imagePrompt'); const prompt = inp?.value.trim();
    if (!prompt) return alert('Describe the image first.');
    const btn = $('#generateImageBtn'), result = $('#imageResult');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
    if (result) result.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">Generating…</div>';
    try {
      const res = await fetch('/v1/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, aspect_ratio: '1:1' }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok && data.image) { if (result) result.innerHTML = `<img src="${data.image}" alt="${escapeHtml(prompt)}">`; refreshUsage(); }
      else if (result) result.innerHTML = `<div style="color:#dc2626;font-size:13px;">Failed: ${escapeHtml(data.error?.message || 'Unknown')}</div>`;
    } catch (e) { if (result) result.innerHTML = `<div style="color:#dc2626;font-size:13px;">Error: ${escapeHtml(e.message)}</div>`; }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ri-image-add-line"></i> Generate'; } }
  }

  /* ============================================================
     BRIDGE
     ============================================================ */
  function loadBridgeLS() {
    const b = safeGet(BRIDGE_KEY, {});
    __bridge = { ...__bridge, ...b, connected: false, baseUrl: null, env: null };
  }
  function saveBridgeLS() {
    safeSet(BRIDGE_KEY, { name: __bridge.name, model: __bridge.model, port: __bridge.port });
  }
  function renderBridgeStatus() {
    [['#bridgeStatus', '.bridge-status-dot'], ['#bwStatusPill', '.bridge-status-dot'], ['#bwStatusBox', '.bridge-status-dot']]
      .forEach(([sel, dotSel]) => {
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
  async function fetchEnv(base) {
    try {
      const r = await fetch(`${base}/env`, { mode: 'cors' });
      if (!r.ok) return null;
      const d = await r.json();
      if (d && d.ok) return d;
    } catch {}
    return null;
  }
  async function startBridge() {
    const name = ($('#bwNameInput')?.value || __bridge.name).trim();
    const model = $('#bwModelSelect')?.value || __bridge.model;
    const port = parseInt($('#bwPortInput')?.value || __bridge.port, 10);
    __bridge.name = name; __bridge.model = model; __bridge.port = port;
    saveBridgeLS(); renderBridgeStatus();
    setBwHint('Connecting…', '');
    const res = await testBridge(port);
    if (res.ok) {
      __bridge.connected = true;
      __bridge.baseUrl = res.base;
      __bridge.env = await fetchEnv(res.base);
      renderBridgeStatus();
      const empty = $('#bridgeEmpty'); if (empty) empty.remove();
      const home = __bridge.env?.home || '(unknown)';
      const os = __bridge.env?.platform || '(unknown)';
      setBwHint(`Connected · Home: ${home} · OS: ${os}`, 'ok');
      addBridgeSystemMsg(`Connected to ${res.data.name} · Home directory: ${home} · OS: ${os}`);
    } else {
      __bridge.connected = false; __bridge.baseUrl = null; __bridge.env = null;
      renderBridgeStatus();
      setBwHint(`Could not reach the bridge on port ${port}.\n\n1. Make sure you ran "python runner.py".\n2. Test in browser: http://localhost:${port}/ping`, 'err');
    }
  }
  function stopBridge() {
    __bridge.connected = false; __bridge.baseUrl = null; __bridge.env = null;
    renderBridgeStatus(); setBwHint('', '');
  }
  async function bridgeCall(endpoint, payload) {
    if (!__bridge.connected || !__bridge.baseUrl) throw new Error('Bridge not connected');
    const r = await fetch(__bridge.baseUrl + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
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
    const has = inp.value.trim().length > 0;
    const enabled = __bridge.connected && !bridgeRunning && has;
    btn.classList.toggle('is-disabled', !enabled);
    btn.setAttribute('aria-disabled', String(!enabled));
  }
  function openBridgeWorkspace() {
    $('#bridgeWorkspace')?.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => { if (__bridge.connected) startBridge(); }, 50);
  }
  function closeBridgeWorkspace() {
    $('#bridgeWorkspace')?.classList.remove('open');
    document.body.style.overflow = '';
  }
  function clearBridgeChat() {
    const m = $('#bridgeMessages'); if (m) m.innerHTML = '';
    bridgeConversation = [];
    bridgeQuestionCount = 0;
    bridgeProgress = 0;
    bridgeTurn = null;
    __pendingQuestions = [];
    updateBridgeProgress(0, 'Ready');
    const w = $('#bwProgress'); if (w) w.style.display = 'none';
  }
  function scrollBridgeBottom() { const c = $('#bridgeMessages'); if (c) c.scrollTop = c.scrollHeight; }

  function addBridgeUserMsg(text) {
    const container = $('#bridgeMessages'); if (!container) return;
    const empty = $('#bridgeEmpty'); if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'bridge-msg user';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `<div class="bridge-bubble">${escapeHtml(text).replace(/\n/g, '<br>')}</div><div class="bridge-meta">You · ${time}</div>`;
    container.appendChild(el);
    scrollBridgeBottom();
  }
  function addBridgeAiMsg(text) {
    if (!text || !text.trim()) return null;
    const container = $('#bridgeMessages'); if (!container) return null;
    const empty = $('#bridgeEmpty'); if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'bridge-msg ai';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `<div class="bridge-bubble">${renderMarkdown(text)}</div><div class="bridge-meta">Mirox · ${time}</div>`;
    container.appendChild(el);
    wireCopyButtons(el);
    scrollBridgeBottom();
    return el;
  }
  function addBridgeSystemMsg(text) {
    const container = $('#bridgeMessages'); if (!container) return;
    const empty = $('#bridgeEmpty'); if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'bridge-msg system';
    el.innerHTML = `<div class="bridge-bubble">${escapeHtml(text)}</div>`;
    container.appendChild(el);
    scrollBridgeBottom();
  }
  function addBridgeSuccessMsg(text) {
    const container = $('#bridgeMessages'); if (!container) return;
    const el = document.createElement('div');
    el.className = 'bridge-msg ai';
    el.innerHTML = `<div class="bridge-success"><i class="ri-checkbox-circle-fill"></i><span>${escapeHtml(text)}</span></div>`;
    container.appendChild(el);
    scrollBridgeBottom();
  }
  function addBridgeThinkingBubble() {
    const container = $('#bridgeMessages'); if (!container) return null;
    const empty = $('#bridgeEmpty'); if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'bridge-msg ai';
    el.innerHTML = `<div class="bridge-thinking"><span>Thinking</span><span class="thinking-dots"><span></span><span></span><span></span></span></div>`;
    container.appendChild(el);
    scrollBridgeBottom();
    return el;
  }
  function addBridgeQuestionBubble(question) {
    const container = $('#bridgeMessages'); if (!container) return null;
    const el = document.createElement('div');
    el.className = 'bridge-msg ai';
    el.innerHTML = `<div class="bridge-question-bubble"><div class="qb-head"><i class="ri-question-line"></i> Waiting for your answer…</div><div class="qb-text">${escapeHtml(question)}</div></div>`;
    container.appendChild(el);
    scrollBridgeBottom();
    return el;
  }
  function addBridgePlanBubble(plannedFiles) {
    const container = $('#bridgeMessages'); if (!container) return;
    const empty = $('#bridgeEmpty'); if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'bridge-msg ai';
    el.dataset.planId = 'plan-' + Date.now();
    el.innerHTML = `<div class="bridge-plan-bubble">
      <div class="bp-head"><i class="ri-list-check-2"></i> Project plan (${plannedFiles.length} file${plannedFiles.length === 1 ? '' : 's'})</div>
      <div class="bp-list">
        ${plannedFiles.map(f => `<div class="bp-file" data-path="${escapeHtml(f)}"><i class="ri-file-add-line"></i> ${escapeHtml(f)}</div>`).join('')}
      </div>
    </div>`;
    container.appendChild(el);
    scrollBridgeBottom();
    return el;
  }
  function markPlanFileDone(path) {
    const container = $('#bridgeMessages'); if (!container) return;
    container.querySelectorAll('.bp-file').forEach(f => {
      if (f.dataset.path === path) {
        f.classList.add('done');
        const ic = f.querySelector('i'); if (ic) ic.className = 'ri-check-line';
      }
    });
  }
  function getActionData(cmd) {
    if (cmd.type === 'write') return { icon: 'ri-file-add-line', iconClass: 'write', label: `Writing <code>${escapeHtml(getBaseName(cmd.path))}</code>` };
    if (cmd.type === 'exec') {
      const short = cmd.command.length > 55 ? cmd.command.slice(0, 55) + '…' : cmd.command;
      return { icon: 'ri-play-line', iconClass: 'exec', label: `Running <code>${escapeHtml(short)}</code>` };
    }
    if (cmd.type === 'read') return { icon: 'ri-file-text-line', iconClass: 'read', label: `Reading <code>${escapeHtml(getBaseName(cmd.path))}</code>` };
    if (cmd.type === 'list') return { icon: 'ri-folder-line', iconClass: 'list', label: `Listing <code>${escapeHtml(getBaseName(cmd.path) || cmd.path)}</code>` };
    return { icon: 'ri-terminal-line', iconClass: '', label: cmd.type };
  }
  function getBaseName(p) { if (!p) return ''; const parts = String(p).split('/'); return parts[parts.length - 1] || p; }
  function addBridgeActionBubble(cmd) {
    const container = $('#bridgeMessages'); if (!container) return null;
    const el = document.createElement('div');
    el.className = 'bridge-msg ai';
    const data = getActionData(cmd);
    el.innerHTML = `<div class="bridge-action">
      <div class="bridge-action-head">
        <div class="bridge-action-icon ${data.iconClass}"><i class="${data.icon}"></i></div>
        <div class="bridge-action-label">${data.label}</div>
        <span class="bridge-action-status working"><i class="ri-loader-4-line"></i> Working</span>
      </div>
      <div class="bridge-action-output" style="display:none;"></div>
    </div>`;
    container.appendChild(el);
    scrollBridgeBottom();
    return el;
  }
  function updateBridgeActionBubble(el, cmd, result) {
    if (!el) return;
    const status = el.querySelector('.bridge-action-status');
    const output = el.querySelector('.bridge-action-output');
    if (!status || !output) return;
    const ok = result && result.ok;
    if (ok) { status.className = 'bridge-action-status ok'; status.innerHTML = '<i class="ri-check-line"></i> Done'; }
    else { status.className = 'bridge-action-status err'; status.innerHTML = '<i class="ri-close-line"></i> Failed'; }
    let body = '';
    if (ok) {
      if (cmd.type === 'exec') {
        body = (result.stdout || '').trim();
        if (result.stderr && result.stderr.trim()) body += (body ? '\n' : '') + '[stderr]\n' + result.stderr.trim();
        if (!body) body = `exit ${result.exit_code}`;
      } else if (cmd.type === 'write') body = `Wrote ${result.bytes} bytes`;
      else if (cmd.type === 'read') body = (result.content || '').slice(0, 500) || '(empty)';
      else if (cmd.type === 'list') body = (result.items || []).slice(0, 20).map(i => (i.is_dir ? '📁 ' : '📄 ') + i.name).join('\n');
    } else body = (result && result.error) || 'Unknown error';
    if (body) {
      output.textContent = body.length > 800 ? body.slice(0, 800) + '\n…' : body;
      output.style.display = 'block';
      if (!ok) output.classList.add('err');
    }
    scrollBridgeBottom();
  }
  function updateBridgeProgress(pct, text) {
    bridgeProgress = Math.max(0, Math.min(100, Math.round(pct)));
    const bar = $('#bwProgress'), fill = $('#bwProgressFill'), pctEl = $('#bwProgressPct'), txtEl = $('#bwProgressText');
    if (bar) bar.style.display = 'block';
    if (fill) { fill.style.width = bridgeProgress + '%'; fill.classList.toggle('done', bridgeProgress >= 100); }
    if (pctEl) { pctEl.textContent = bridgeProgress + '%'; pctEl.classList.toggle('done', bridgeProgress >= 100); }
    if (txtEl && text) txtEl.textContent = text;
  }
  function extractBridgeCommands(text) {
    const cmds = []; let m;
    const execRe = /<bridge-exec>([\s\S]*?)<\/bridge-exec>/g;
    while ((m = execRe.exec(text)) !== null) cmds.push({ type: 'exec', command: m[1].trim(), index: m.index });
    const writeRe = /<bridge-write\s+path="([^"]+)">([\s\S]*?)<\/bridge-write>/g;
    while ((m = writeRe.exec(text)) !== null) cmds.push({ type: 'write', path: m[1], content: m[2], index: m.index });
    const readRe = /<bridge-read\s+path="([^"]+)"\s*\/>/g;
    while ((m = readRe.exec(text)) !== null) cmds.push({ type: 'read', path: m[1], index: m.index });
    const listRe = /<bridge-list\s+path="([^"]+)"\s*\/>/g;
    while ((m = listRe.exec(text)) !== null) cmds.push({ type: 'list', path: m[1], index: m.index });
    cmds.sort((a, b) => a.index - b.index);
    return cmds;
  }
  function extractBridgePlan(text) {
    const m = /<bridge-plan>([\s\S]*?)<\/bridge-plan>/.exec(text);
    if (!m) return null;
    const body = m[1];
    const files = [];
    for (const line of body.split('\n')) {
      const l = line.trim().replace(/^[-*+]\s*/, '').replace(/^["']|["']$/g, '');
      if (!l) continue;
      if (l.includes('/') || /\.\w{1,8}$/.test(l)) files.push(l);
    }
    return files.length ? files : null;
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
  function getNarrationText(text) {
    let t = String(text || '');
    t = t.replace(/<bridge-exec>[\s\S]*?<\/bridge-exec>/g, '');
    t = t.replace(/<bridge-write\s+[^>]*>[\s\S]*?<\/bridge-write>/g, '');
    t = t.replace(/<bridge-read\s+[^>]*\/>/g, '');
    t = t.replace(/<bridge-list\s+[^>]*\/>/g, '');
    t = t.replace(/<bridge-ask>[\s\S]*?<\/bridge-ask>/g, '');
    t = t.replace(/<bridge-plan>[\s\S]*?<\/bridge-plan>/g, '');
    t = t.replace(/<bridge-progress[^>]*\/>/g, '');
    t = t.replace(/```[\s\S]*?```/g, '');
    t = t.replace(/\bDONE\b/g, '');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }
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
    if (cmd.type === 'exec') return `[exec] exit=${result.exit_code}\nSTDOUT:\n${(result.stdout || '').slice(0, 3000)}\nSTDERR:\n${(result.stderr || '').slice(0, 1500)}`;
    if (cmd.type === 'write') return `[write] ok path=${result.path} bytes=${result.bytes}`;
    if (cmd.type === 'read') return `[read] path=${result.path}\n${(result.content || '').slice(0, 3000)}`;
    if (cmd.type === 'list') return `[list] path=${result.path}\n` + (result.items || []).map(i => (i.is_dir ? 'D ' : 'F ') + i.name).join('\n');
    return '[unknown]';
  }
  function cmdSignature(cmd) {
    if (cmd.type === 'exec') return 'exec:' + cmd.command.trim();
    if (cmd.type === 'write') return 'write:' + cmd.path + ':' + (cmd.content || '').length;
    if (cmd.type === 'read') return 'read:' + cmd.path;
    if (cmd.type === 'list') return 'list:' + cmd.path;
    return 'unknown';
  }
  function shouldBlockSignature(sig) {
    if (!bridgeTurn) return false;
    const count = bridgeTurn.commandLog.get(sig) || 0;
    if (bridgeTurn.failedSignatures.has(sig)) return true;
    if (count >= MAX_DUP_COMMANDS) return true;
    return false;
  }

  /* ============================================================
     QUESTION MODAL — pause & resume
     ============================================================ */
  function showBridgeQuestionModal(q, index, total) {
    return new Promise((resolve) => {
      __bqResolver = resolve;
      __bqSelected = null;
      const modal = $('#bridgeQuestionModal');
      if (!modal) { resolve(''); return; }

      const txt = $('#bqText'); if (txt) txt.textContent = q.question || '';
      const ctr = $('#bqCounter'); if (ctr) ctr.textContent = `Question ${index} of ${total}`;
      const progFill = $('#bqProgressFill');
      if (progFill) progFill.style.width = Math.round(((index - 1) / total) * 100) + '%';

      const optsWrap = $('#bqOptions');
      if (optsWrap) {
        optsWrap.innerHTML = '';
        const cw = $('#bqCustomWrap');
        if (q.options && q.options.length) {
          if (cw) cw.style.display = 'none';
          q.options.forEach(opt => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'bridge-q-option';
            b.textContent = opt;
            b.onclick = () => {
              __bqSelected = opt;
              optsWrap.querySelectorAll('.bridge-q-option').forEach(x => x.classList.remove('selected'));
              b.classList.add('selected');
              const ci = $('#bqCustomInput'); if (ci) ci.value = '';
            };
            optsWrap.appendChild(b);
          });
        } else {
          if (cw) cw.style.display = 'block';
        }
      }

      const ci = $('#bqCustomInput');
      if (ci) {
        ci.value = '';
        ci.oninput = () => {
          if (ci.value.trim()) {
            __bqSelected = null;
            const optsWrap2 = $('#bqOptions');
            if (optsWrap2) optsWrap2.querySelectorAll('.bridge-q-option').forEach(x => x.classList.remove('selected'));
          }
        };
      }

      modal.classList.add('open');
      setTimeout(() => {
        const firstOpt = document.querySelector('.bridge-q-option');
        if (firstOpt) firstOpt.focus();
        else $('#bqCustomInput')?.focus();
      }, 100);
    });
  }
  function closeBridgeQuestionModal() { $('#bridgeQuestionModal')?.classList.remove('open'); }
  function submitBridgeQuestion() {
    const custom = $('#bqCustomInput')?.value.trim();
    const answer = custom || __bqSelected || '';
    if (!answer && !__bqSelected) {
      // Nothing selected — flash hint
      const wrap = $('#bqOptions');
      if (wrap) {
        wrap.style.animation = 'none';
        setTimeout(() => { wrap.style.animation = ''; }, 10);
      }
      return;
    }
    closeBridgeQuestionModal();
    const progFill = $('#bqProgressFill');
    if (progFill && __pendingQuestions.length > 0) {
      const done = __pendingQuestions._currentIndex || 1;
      progFill.style.width = Math.round((done / __pendingQuestions.length) * 100) + '%';
    }
    if (__bqResolver) { __bqResolver(answer); __bqResolver = null; }
  }
  function skipBridgeQuestion() {
    closeBridgeQuestionModal();
    if (__bqResolver) { __bqResolver('[Skipped by user]'); __bqResolver = null; }
  }

  /* ============================================================
     Fetch AI reply for bridge
     ============================================================ */
  async function fetchBridgeReply(history) {
    const env = __bridge.env || {};
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: history[history.length - 1].content,
        history: history.slice(0, -1).map(h => ({ role: h.role, content: h.content })),
        model: __bridge.model,
        stream: false,
        bridge: {
          connected: true,
          name: __bridge.name,
          model: __bridge.model,
          mode: 'developer',
          env,
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

  /* ============================================================
     MAIN LOOP — pauses on questions, resumes on answers
     ============================================================ */
  async function runBridgeTurn(userText, isResume = false) {
    if (!__bridge.connected) { setBwHint('Bridge is not connected.', 'err'); return; }
    if (bridgeRunning) return;
    bridgeRunning = true;
    updateBridgeSendBtn();

    if (!isResume) {
      bridgeQuestionCount = 0;
      bridgeTurn = {
        runs: 0,
        plannedFiles: new Set(),
        writtenFiles: new Set(),
        commandLog: new Map(),
        failedSignatures: new Set(),
        commandsRun: 0,
      };
      updateBridgeProgress(2, 'Starting…');
      addBridgeUserMsg(userText);
      bridgeConversation.push({ role: 'user', content: userText });
    } else {
      updateBridgeProgress(Math.max(20, bridgeProgress - 15), 'Resuming…');
    }

    let iter = 0;
    let autoContinues = 0;

    try {
      while (iter++ < MAX_BRIDGE_ITER) {
        bridgeTurn.runs++;
        const thinkingEl = addBridgeThinkingBubble();
        let reply = '';
        try {
          reply = await fetchBridgeReply(bridgeConversation);
        } catch (e) {
          if (thinkingEl) thinkingEl.remove();
          addBridgeSystemMsg('AI error: ' + e.message);
          break;
        }
        if (thinkingEl) thinkingEl.remove();
        if (!reply || !reply.trim()) {
          if (autoContinues < MAX_AUTO_CONTINUES) {
            autoContinues++;
            addBridgeSystemMsg(`Empty response — asking AI to continue (${autoContinues}/${MAX_AUTO_CONTINUES})`);
            bridgeConversation.push({ role: 'user', content: '[System] You returned an empty response. Continue building.' });
            continue;
          }
          break;
        }

        const prog = extractProgressTag(reply);
        if (prog && prog.total > 0) {
          const pct = Math.min(98, Math.round((prog.step / prog.total) * 100));
          updateBridgeProgress(pct, prog.label || `Step ${prog.step} of ${prog.total}`);
        } else {
          const pct = Math.min(90, 5 + iter * 4);
          const doneCount = bridgeTurn.writtenFiles.size;
          const totalPlanned = bridgeTurn.plannedFiles.size;
          let text = `Working… (step ${iter})`;
          if (totalPlanned > 0) text = `Files written: ${doneCount} / ${totalPlanned}`;
          updateBridgeProgress(pct, text);
        }

        const plan = extractBridgePlan(reply);
        if (plan && plan.length) {
          for (const f of plan) bridgeTurn.plannedFiles.add(f);
          addBridgePlanBubble(plan);
        }

        // Narration (no tags shown)
        const narration = getNarrationText(reply);
        if (narration) addBridgeAiMsg(narration);

        bridgeConversation.push({ role: 'assistant', content: reply });
        if (bridgeConversation.length > 40) bridgeConversation = bridgeConversation.slice(-40);

        /* ============================================================
           PAUSE — Ask ALL questions in this reply, wait for answers
           ============================================================ */
        const questions = extractBridgeQuestions(reply);
        if (questions.length > 0) {
          const remaining = MAX_BRIDGE_QUESTIONS - bridgeQuestionCount;
          const toAsk = questions.slice(0, Math.max(0, remaining));

          if (toAsk.length > 0) {
            addBridgeSystemMsg(`Paused — Mirox needs ${toAsk.length} answer${toAsk.length === 1 ? '' : 's'} before continuing.`);

            // Ask each question, one at a time, in the modal
            for (let qi = 0; qi < toAsk.length; qi++) {
              const q = toAsk[qi];
              addBridgeQuestionBubble(q.question);
              bridgeQuestionCount++;

              const answer = await showBridgeQuestionModal(q, qi + 1, toAsk.length);
              addBridgeUserMsg(answer);
              bridgeConversation.push({
                role: 'user',
                content: `[Answer to "${q.question}"] ${answer}`,
              });
            }

            addBridgeSystemMsg('Answers received — resuming build.');
            bridgeConversation.push({
              role: 'user',
              content: `[System] User answered all pending questions. Continue building now using <bridge-write> and <bridge-exec> tags. Do not repeat the questions.`,
            });
            // Loop continues → AI receives the answers → keeps building
            continue;
          } else {
            addBridgeSystemMsg(`Question limit (${MAX_BRIDGE_QUESTIONS}) reached.`);
            bridgeConversation.push({
              role: 'user',
              content: `[System] Question limit reached. Continue with best-effort defaults. Do not ask more questions.`,
            });
            continue;
          }
        }

        /* ============================================================
           Run commands
           ============================================================ */
        const cmds = extractBridgeCommands(reply);
        if (cmds.length > 0) {
          const resultLines = [];
          let blockedAny = false;
          for (let i = 0; i < cmds.length; i++) {
            const cmd = cmds[i];
            const sig = cmdSignature(cmd);
            if (shouldBlockSignature(sig)) {
              const wasFail = bridgeTurn.failedSignatures.has(sig);
              const reason = wasFail
                ? 'Already failed earlier — do not retry this exact command. Try a different approach.'
                : 'Already executed successfully — do not run again.';
              addBridgeSystemMsg(`Blocked duplicate: ${sig} — ${reason}`);
              resultLines.push(`[${cmd.type}] BLOCKED: ${sig}\nREASON: ${reason}`);
              blockedAny = true;
              continue;
            }
            bridgeTurn.commandLog.set(sig, (bridgeTurn.commandLog.get(sig) || 0) + 1);
            bridgeTurn.commandsRun++;
            const bubble = addBridgeActionBubble(cmd);
            let result;
            try { result = await executeBridgeCommand(cmd); }
            catch (e) { result = { ok: false, error: e.message }; }
            updateBridgeActionBubble(bubble, cmd, result);
            if (result && result.ok) {
              if (cmd.type === 'write') {
                bridgeTurn.writtenFiles.add(cmd.path);
                markPlanFileDone(cmd.path);
              }
            } else {
              bridgeTurn.failedSignatures.add(sig);
            }
            resultLines.push(formatResultForAI(cmd, result));
          }

          const env = __bridge.env || {};
          const doneCount = bridgeTurn.writtenFiles.size;
          const totalPlanned = bridgeTurn.plannedFiles.size;
          const progressLine = totalPlanned > 0
            ? `Progress: ${doneCount}/${totalPlanned} planned files written.`
            : `Progress: ${doneCount} file(s) written.`;

          const bridgeResults = [
            `[Bridge environment] home=${env.home || '?'} platform=${env.platform || '?'}`,
            `[Bridge progress] ${progressLine}`,
            blockedAny ? `[Note] Some commands were blocked as duplicates. Use different approaches.` : '',
            `[Bridge results]`,
            resultLines.join('\n\n'),
            '',
            `Continue with the next step. If ALL planned files are written AND verified, reply with exactly: DONE.`,
            `Otherwise, output the next batch of <bridge-*> tags to keep building.`,
          ].filter(Boolean).join('\n');

          bridgeConversation.push({ role: 'user', content: bridgeResults });
          continue;
        }

        /* ============================================================
           No commands, no questions — decide done / continue
           ============================================================ */
        const saidDone = /\bDONE\b/i.test(reply);
        const hasPlan = bridgeTurn.plannedFiles.size > 0;
        const allFilesWritten = hasPlan && bridgeTurn.writtenFiles.size >= bridgeTurn.plannedFiles.size;

        if (saidDone && (allFilesWritten || !hasPlan)) {
          updateBridgeProgress(100, 'Complete');
          addBridgeSuccessMsg('Project complete');
          break;
        }

        if (saidDone && hasPlan && !allFilesWritten) {
          const missing = [...bridgeTurn.plannedFiles].filter(f => !bridgeTurn.writtenFiles.has(f));
          addBridgeSystemMsg(`AI said DONE but ${missing.length} file(s) are missing — asking it to finish.`);
          bridgeConversation.push({
            role: 'user',
            content: `[System] You said DONE but these files are missing:\n${missing.map(r => '- ' + r).join('\n')}\n\nWrite them with <bridge-write> tags, then verify. Do NOT say DONE until every file exists.`
          });
          continue;
        }

        if (!saidDone) {
          if (autoContinues < MAX_AUTO_CONTINUES) {
            autoContinues++;
            const remaining = hasPlan ? [...bridgeTurn.plannedFiles].filter(f => !bridgeTurn.writtenFiles.has(f)) : [];
            const msg = remaining.length
              ? `Continue. Still missing: ${remaining.slice(0, 5).join(', ')}${remaining.length > 5 ? ' …' : ''}`
              : 'Continue. Output more <bridge-write> or <bridge-exec> tags to keep building.';
            addBridgeSystemMsg(`Auto-continue (${autoContinues}/${MAX_AUTO_CONTINUES}): ${msg}`);
            bridgeConversation.push({ role: 'user', content: `[System] ${msg}` });
            continue;
          }
          break;
        }
      }

      /* ============================================================
         Post-loop — did we actually finish?
         ============================================================ */
      const hasPlan = bridgeTurn.plannedFiles.size > 0;
      const allFilesWritten = hasPlan && bridgeTurn.writtenFiles.size >= bridgeTurn.plannedFiles.size;
      const missing = hasPlan ? [...bridgeTurn.plannedFiles].filter(f => !bridgeTurn.writtenFiles.has(f)) : [];

      if (!(allFilesWritten || !hasPlan)) {
        updateBridgeProgress(Math.min(95, bridgeProgress), `Paused at ${bridgeTurn.writtenFiles.size}/${bridgeTurn.plannedFiles.size || '?'} files`);
        addBridgeSystemMsg(
          missing.length > 0
            ? `Paused — ${missing.length} file${missing.length === 1 ? '' : 's'} left. Type anything to keep building.`
            : 'Paused — AI ran out of turns. Type anything to keep building.'
        );
      }
    } finally {
      bridgeRunning = false;
      updateBridgeSendBtn();
    }
  }

  function handleBridgeSend() {
    const inp = $('#bridgeInput'); if (!inp) return;
    const text = inp.value.trim();
    if (!text || bridgeRunning || !__bridge.connected) return;
    inp.value = ''; inp.style.height = 'auto';
    updateBridgeSendBtn();
    runBridgeTurn(text, false);
  }

  /* Wiring */
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
      };
    });
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
    on('#modelPickerBtn', 'click', (e) => {
      e.stopPropagation();
      const menu = $('#modelPickerMenu');
      if (menu?.classList.contains('open')) closeModelPicker(); else openModelPicker();
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('#modelPicker')) closeModelPicker(); });
    on('#imageModeBtn', 'click', () => openModal('imageModal'));
    on('#plansModeBtn', 'click', () => { openModal('plansModal'); loadPlans(); });
    on('#supportModeBtn', 'click', () => openModal('supportModal'));
    on('#supportModeBtn2', 'click', () => openModal('supportModal'));
    on('#bridgeModeBtn', 'click', openBridgeWorkspace);
    on('#bridgeOpenBtn', 'click', openBridgeWorkspace);
    on('#generateImageBtn', 'click', genImage);
    on('#submitReportBtn', 'click', () => {
      const s = $('#supportSubject')?.value.trim();
      const m = $('#supportMessage')?.value.trim();
      if (!s || !m) return alert('Fill subject and message.');
      alert('Ticket submitted!');
      closeModal('supportModal');
    });
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
    $$('[data-mode]').forEach(b => b.onclick = () => applyAppearance({ mode: b.dataset.mode, theme: document.documentElement.getAttribute('data-theme') || 'default' }));
    $$('.swatch').forEach(b => b.onclick = () => applyAppearance({ mode: document.documentElement.getAttribute('data-mode') || 'light', theme: b.dataset.theme }));
    document.addEventListener('click', (e) => {
      const cb = e.target.closest('[data-close]');
      if (cb) { closeModal(cb.dataset.close); return; }
      if (e.target.classList.contains('modal-overlay') && e.target.id !== 'bridgeQuestionModal') e.target.classList.remove('open');
    });
    on('#userChip', 'click', () => { if (!__user) openModal('loginModal'); });
    on('#upgradeBtn', 'click', (e) => {
      e.stopPropagation();
      if (!__user) openModal('loginModal');
      else { openModal('plansModal'); loadPlans(); }
    });
    on('#simpleLoginForm', 'submit', doLogin);
    document.addEventListener('click', (e) => { if (e.target.closest('[data-iv-close]')) closeImageViewer(); });
    on('#ivDownload', 'click', () => {
      if (!__ivDataUrl) return;
      const a = document.createElement('a');
      a.href = __ivDataUrl; a.download = `mirox-${Date.now()}.png`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    });
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
    on('#bqCustomToggle', 'click', () => {
      const cw = $('#bqCustomWrap');
      if (cw) {
        cw.style.display = cw.style.display === 'none' ? 'block' : 'none';
        if (cw.style.display === 'block') $('#bqCustomInput')?.focus();
      }
    });
    on('#bqSubmit', 'click', submitBridgeQuestion);
    on('#bqSkipOne', 'click', skipBridgeQuestion);
    on('#bqCustomInput', 'keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitBridgeQuestion(); }
    });
    bindSuggestionClicks();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeImageViewer(); closeModelPicker();
        if ($('#bridgeQuestionModal')?.classList.contains('open')) return; // don't close question
        if ($('#bridgeWorkspace')?.classList.contains('open')) closeBridgeWorkspace();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('#messageInput')?.focus(); }
    });
    window.addEventListener('resize', () => { if (window.innerWidth > 860) closeSidebar(); });
  }

  async function init() {
    try {
      loadAppearance();
      loadBridgeLS();
      wireAll();
      renderModelPicker();
      renderBridgeStatus();
      updateBridgeSendBtn();
      await loadConfig();
      loadChats();
      renderHistory();
      await refreshUsage();
    } catch (e) { console.error('[Mirox init]', e); }
    finally { killLoader(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
