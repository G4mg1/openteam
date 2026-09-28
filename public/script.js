/* ============================================================
   MiroxAI — frontend (bulletproof, session-persistent)
   ============================================================ */

const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

let __config = null;
let __user = null, __tier = "free";
let __model = null;
let currentConversationId = null, isReplying = false;
let __conversations = [];
let bgState = { url: null, dim: 45, blur: 0 };
let recognition = null;

const LS_KEY = "miroxai_conversations_v1";
const TOKEN_KEY = "mirox_token";

/* ============================================================
   AUTH HELPERS — token in localStorage + cookie fallback
   ============================================================ */
function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
function setToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}
function authFetch(url, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const t = getToken();
  if (t) headers["Authorization"] = "Bearer " + t;
  return fetch(url, { ...opts, headers, credentials: "same-origin", cache: "no-store" });
}

/* ---------- LOADER KILLER ---------- */
function killLoader() {
  const l = document.getElementById("loadingScreen");
  if (l) { l.classList.add("hidden", "force-hidden"); l.style.display = "none"; }
}
killLoader();
setTimeout(killLoader, 400);
setTimeout(killLoader, 1500);

/* ---------- UTIL ---------- */
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}
const getDefaultModel = () => (__config?.models || []).find(m => m.default)?.id || "mirox-luna-1.2";
function uid() { return "c_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

/* ---------- MODALS ---------- */
function openModal(id) { const el = document.getElementById(id); if (el) el.classList.add("open"); }
function closeModal(id) { const el = document.getElementById(id); if (el) el.classList.remove("open"); }
function openSidebar() { $("#sidebar")?.classList.add("open"); $("#sidebarScrim")?.classList.add("open"); }
function closeSidebar() { $("#sidebar")?.classList.remove("open"); $("#sidebarScrim")?.classList.remove("open"); }

/* ============================================================
   ONE CLICK HANDLER FOR THE ENTIRE APP
   ============================================================ */
document.addEventListener("click", function (e) {
  const t = e.target;
  const closest = s => t.closest(s);

  const closer = closest("[data-close]");
  if (closer) { closeModal(closer.dataset.close); return; }

  if (t.classList.contains("modal-overlay")) { t.classList.remove("open"); return; }

  if (closest("#hamburgerBtn")) { openSidebar(); return; }
  if (closest("#sidebarCloseBtn")) { closeSidebar(); return; }
  if (t.id === "sidebarScrim") { closeSidebar(); return; }
  if (closest("#brandLogo")) { startNewChat(); if (window.innerWidth <= 860) closeSidebar(); return; }

  if (closest("#newChatBtn")) { startNewChat(); if (window.innerWidth <= 860) closeSidebar(); return; }

  if (closest("#userChip")) { if (!__user) openModal("loginModal"); return; }

  if (closest("#upgradeBtn")) {
    if (!__user) openModal("loginModal");
    else { openModal("plansModal"); loadPlans(); loadUserKeys(); }
    return;
  }

  if (closest("#settingsBtn")) { openModal("settingsModal"); loadPersona(); loadMemory(); return; }

  if (closest("#imageModeBtn")) { openModal("imageModal"); return; }
  if (closest("#videoModeBtn")) { openModal("videoModal"); return; }
  if (closest("#backgroundModeBtn")) { openModal("backgroundModal"); populateBackgroundUI(); return; }
  if (closest("#plansModeBtn")) { openModal("plansModal"); loadPlans(); loadUserKeys(); return; }
  if (closest("#supportModeBtn")) { openModal("supportModal"); loadMyReports(); return; }
  if (closest("#talkModeBtn")) {
    $("#callOverlay")?.classList.add("open");
    const s = $("#callStatus"); if (s) s.textContent = "Voice calling unavailable";
    const tr = $("#callTranscript"); if (tr) tr.textContent = "Use the chat instead.";
    return;
  }
  if (closest("#callEndBtn")) { $("#callOverlay")?.classList.remove("open"); return; }
  if (closest("#callMuteBtn")) { $("#callMuteBtn")?.classList.toggle("muted"); return; }

  if (closest("#modelPickerBtn")) {
    e.stopPropagation();
    $("#modelPickerMenu")?.classList.toggle("open");
    return;
  }
  const modelOpt = closest(".model-option");
  if (modelOpt) { selectModel(modelOpt.dataset.modelId); return; }
  if (!closest("#modelPicker")) $("#modelPickerMenu")?.classList.remove("open");

  const tab = closest(".settings-tab");
  if (tab) {
    document.querySelectorAll(".settings-tab").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".settings-pane").forEach(x => x.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`.settings-pane[data-pane="${tab.dataset.tab}"]`)?.classList.add("active");
    return;
  }

  const modeBtn = closest("[data-mode]"); if (modeBtn && modeBtn.closest("#modeOptions")) return saveAppearance({ mode: modeBtn.dataset.mode });
  const swatch = closest(".swatch"); if (swatch && swatch.dataset.theme) return saveAppearance({ theme: swatch.dataset.theme });
  const cornerBtn = closest("[data-corner]"); if (cornerBtn && cornerBtn.closest("#cornerOptions")) return saveAppearance({ corner: cornerBtn.dataset.corner });
  const fontBtn = closest("[data-font]"); if (fontBtn && fontBtn.closest("#fontOptions")) return saveAppearance({ font: fontBtn.dataset.font });

  if (closest("#railToggleBtn")) {
    document.body.classList.toggle("rail-collapsed");
    try { localStorage.setItem("miroxai_rail_collapsed", document.body.classList.contains("rail-collapsed") ? "1" : "0"); } catch {}
    updateRailToggleIcon();
    return;
  }

  if (closest("#attachBtn")) { $("#fileInput")?.click(); return; }
  if (closest("#removeAttachmentBtn")) {
    const p = $("#attachmentPreview"); if (p) p.style.display = "none"; return;
  }

  if (closest("#micBtn")) {
    if (!recognition) { alert("Voice input isn't supported in this browser."); return; }
    try { recognition.start(); $("#micBtn")?.classList.add("recording"); } catch {}
    return;
  }

  if (closest("#editTitleBtn")) {
    const cur = $("#chatTitle")?.textContent || "";
    const nxt = prompt("Rename this chat", cur);
    if (nxt === null) return;
    const trimmed = nxt.trim(); if (!trimmed) return;
    if ($("#chatTitle")) $("#chatTitle").textContent = trimmed;
    const convo = currentConvo();
    if (convo) { convo.title = trimmed; saveChatsToLS(); renderHistory(); }
    return;
  }

  if (closest("#logoutBtn")) { doLogout(); return; }

  if (closest("#connectServerBtn")) {
    const s = $("#serverStatus"); if (s) s.textContent = "Checking…";
    fetch("/api/health", { cache: "no-store" }).then(r => r.json()).then(d => {
      if (s) s.textContent = `Connected ✅ (HF: ${d.hf ? "yes" : "no"})`;
    }).catch(() => { if (s) s.textContent = "Server unreachable."; });
    return;
  }

  if (closest("#savePersonaBtn")) {
    if (!__user) { $("#personaStatus").textContent = "Sign in first."; return; }
    const p = $("#personaInput")?.value || "";
    const s = $("#personaStatus"); if (s) s.textContent = "Saving…";
    authFetch("/api/settings/persona", {
      method: "POST",
      body: JSON.stringify({ persona: p }),
    }).then(r => r.json()).then(d => { if (s) s.textContent = d.ok ? "Saved." : "Failed."; })
      .catch(() => { if (s) s.textContent = "Failed."; });
    return;
  }

  if (closest("#addMemoryBtn")) {
    if (!__user) return;
    const v = $("#memoryInput")?.value.trim(); if (!v) return;
    authFetch("/api/memory", {
      method: "POST",
      body: JSON.stringify({ fact: v }),
    }).then(() => { if ($("#memoryInput")) $("#memoryInput").value = ""; loadMemory(); });
    return;
  }

  if (closest("#submitReportBtn")) {
    if (!__user) { $("#reportStatus").textContent = "Sign in to send a ticket."; return; }
    const sub = $("#reportSubject")?.value.trim() || "";
    const msg = $("#reportMessage")?.value.trim() || "";
    const s = $("#reportStatus");
    if (!msg) { if (s) s.textContent = "Please describe your issue."; return; }
    if (s) s.textContent = "Sending…";
    authFetch("/api/report", {
      method: "POST",
      body: JSON.stringify({ subject: sub, message: msg, category: "general" }),
    }).then(r => r.json()).then(d => {
      if (d.ok) { if (s) s.textContent = "Ticket sent ✅"; if ($("#reportSubject")) $("#reportSubject").value = ""; if ($("#reportMessage")) $("#reportMessage").value = ""; loadMyReports(); }
      else if (s) s.textContent = d.error || "Failed.";
    }).catch(() => { if (s) s.textContent = "Failed."; });
    return;
  }

  if (closest("#generateKeyBtn")) {
    if (!__user) { $("#keyGenStatus").textContent = "Sign in first."; return; }
    const n = $("#newKeyNameInput")?.value.trim() || "My key";
    const s = $("#keyGenStatus"); if (s) s.textContent = "Generating…";
    authFetch("/api/keys/generate", {
      method: "POST",
      body: JSON.stringify({ name: n }),
    }).then(r => r.json()).then(d => {
      if (d.ok) { if (s) s.innerHTML = `Created ✅ — <code>${escapeHtml(d.key)}</code>`; if ($("#newKeyNameInput")) $("#newKeyNameInput").value = ""; loadUserKeys(); }
      else if (s) s.textContent = d.error || "Failed.";
    }).catch(() => { if (s) s.textContent = "Failed."; });
    return;
  }

  if (closest("#generateImageBtn")) {
    const prompt = $("#imagePromptInput")?.value.trim(); if (!prompt) return;
    const btn = $("#generateImageBtn"); if (btn) btn.disabled = true;
    const status = $("#imageStudioStatus"); if (status) status.textContent = "Generating…";
    const card = document.createElement("div");
    card.className = "gallery-card";
    card.innerHTML = `<div class="gallery-skeleton"></div>`;
    $("#imageGallery")?.prepend(card);
    authFetch("/api/image/generate", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    }).then(r => r.json()).then(d => {
      if (!d.ok) throw new Error(d.error || "Failed");
      card.innerHTML = `<img src="${d.image}" alt="">`;
      if (status) status.textContent = "";
    }).catch(err => {
      card.innerHTML = `<div class="gallery-error"><i class="ri-error-warning-line"></i><span>${escapeHtml(err.message)}</span></div>`;
      if (status) status.textContent = err.message;
    }).finally(() => { if (btn) btn.disabled = false; });
    return;
  }

  if (closest("#generateVideoBtn")) {
    const s = $("#videoStudioStatus"); if (s) s.textContent = "Video generation isn't enabled on this deployment.";
    return;
  }

  if (closest("#bgUploadZone")) { $("#bgFileInput")?.click(); return; }
  if (closest("#bgUrlApplyBtn")) {
    const u = $("#bgUrlInput")?.value.trim(); if (!u) return;
    bgState.url = u; saveBackgroundPrefs(); applyBackground();
    return;
  }
  if (closest("#bgRemoveBtn")) {
    bgState.url = null; saveBackgroundPrefs(); applyBackground();
    if ($("#bgUrlInput")) $("#bgUrlInput").value = "";
    return;
  }

  const hist = closest(".history-item");
  if (hist) {
    if (t.closest(".history-delete")) {
      const id = hist.dataset.id;
      __conversations = __conversations.filter(x => x.id !== id);
      if (currentConversationId === id) startNewChat();
      saveChatsToLS(); renderHistory();
      e.stopPropagation();
      return;
    }
    const id = hist.dataset.id;
    if (id) { openConversationLS(id); if (window.innerWidth <= 860) closeSidebar(); }
    return;
  }
});

/* ---------- Enter key ---------- */
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    document.querySelectorAll(".modal-overlay.open").forEach(o => o.classList.remove("open"));
    $("#modelPickerMenu")?.classList.remove("open");
    return;
  }
  if (e.key === "Enter" && e.target && e.target.id === "messageInput" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

/* ---------- Form submits ---------- */
document.addEventListener("submit", function (e) {
  e.preventDefault();
  const f = e.target;
  if (!f || !f.id) return;
  if (f.id === "composerForm") { handleSend(); return; }
  if (f.id === "simpleLoginForm") { doLogin(); return; }
}, true);

/* ---------- Send button ---------- */
document.addEventListener("click", function (e) {
  if (e.target && e.target.closest && e.target.closest("#sendBtn")) {
    e.preventDefault();
    handleSend();
  }
});

/* ---------- Input ---------- */
document.addEventListener("input", function (e) {
  if (e.target && e.target.id === "messageInput") {
    const sb = $("#sendBtn"); if (sb) sb.disabled = isReplying || !e.target.value.trim();
  }
});

/* ============================================================
   SEND
   ============================================================ */
function handleSend() {
  if (isReplying) return;
  const inp = $("#messageInput"); if (!inp) return;
  const text = (inp.value || "").trim();
  if (!text) return;
  inp.value = "";
  const sb = $("#sendBtn"); if (sb) sb.disabled = true;
  sendMessage(text);
}

async function sendMessage(userText) {
  if (isReplying) return;
  userText = (userText || "").trim();
  if (!userText) return;

  $("#mainEl")?.classList.remove("new-chat");

  let convo;
  if (__user) {
    convo = currentConvo();
    if (!convo) {
      convo = { id: uid(), title: userText.slice(0, 48) || "New chat", messages: [], updatedAt: Date.now() };
      __conversations.unshift(convo);
      currentConversationId = convo.id;
      const t = $("#chatTitle"); if (t) t.textContent = convo.title;
      renderHistory();
    }
  } else {
    convo = { id: "guest", title: userText.slice(0, 48), messages: [], updatedAt: Date.now() };
    const t = $("#chatTitle"); if (t) t.textContent = convo.title;
  }

  convo.messages.push({ role: "user", text: userText });
  convo.updatedAt = Date.now();
  if (__user) saveChatsToLS();
  addMessage(userText, "user");

  const bubble = addThinking();
  isReplying = true;
  const sb = $("#sendBtn"); if (sb) sb.disabled = true;

  try {
    const history = convo.messages.slice(0, -1).map(m => ({
      role: m.role === "ai" ? "assistant" : "user",
      content: m.text || m.content,
    }));

    const r = await authFetch("/api/chat/stream", {
      method: "POST",
      body: JSON.stringify({ message: userText, history, model: __model || getDefaultModel() }),
    });

    if (!r.ok || !r.body) {
      let m = "Request failed";
      try { const e = await r.json(); m = e.error || m; } catch {}
      throw new Error(m);
    }

    const reader  = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", full = "", first = true;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }
          if (evt.d) {
            if (first) { bubble.innerHTML = ""; first = false; }
            full += evt.d;
            bubble.textContent = full;
            const cur = document.createElement("span");
            cur.className = "stream-cursor";
            bubble.appendChild(cur);
            const chat = $("#chat");
            if (chat.scrollHeight - chat.scrollTop - chat.clientHeight < 200)
              chat.scrollTop = chat.scrollHeight;
          } else if (evt.done) {
            bubble.textContent = full || "(empty reply)";
            const sub = $("#chatSubtitle");
            if (sub) sub.textContent = (evt.model || "") + (evt.ms ? ` · ${evt.ms}ms` : "");
          } else if (evt.error) {
            throw new Error(evt.error);
          }
        }
      }
    }
    bubble.textContent = full || "(empty reply)";
    convo.messages.push({ role: "ai", text: full });
    convo.updatedAt = Date.now();
    if (__user) saveChatsToLS();
  } catch (err) {
    bubble.textContent = err.message || "Something went wrong.";
  } finally {
    isReplying = false;
    if (sb) sb.disabled = !($("#messageInput")?.value.trim());
  }
}

/* ============================================================
   UI BUILDERS
   ============================================================ */
function addMessage(text, sender) {
  const chat = $("#chat"); if (!chat) return null;
  const m = document.createElement("div");
  m.className = `message ${sender}`;
  const avatarHtml = sender === "ai"
    ? `<div class="avatar ai-avatar"><img src="/logo.png" alt=""></div>`
    : `<div class="avatar"><i class="ri-user-3-line"></i></div>`;
  m.innerHTML = `${avatarHtml}<div class="bubble-wrap"><div class="bubble"></div></div>`;
  const bubble = m.querySelector(".bubble");
  bubble.textContent = text || "";
  chat.appendChild(m);
  chat.scrollTop = chat.scrollHeight;
  return { message: m, bubble };
}

function addThinking() {
  const chat = $("#chat"); if (!chat) return null;
  const m = document.createElement("div");
  m.className = "message ai";
  m.innerHTML = `<div class="avatar ai-avatar"><img src="/logo.png" alt=""></div><div class="bubble-wrap"><div class="bubble"><div class="thinking"><span class="thinking-dots"><span></span><span></span><span></span></span></div></div></div>`;
  chat.appendChild(m);
  chat.scrollTop = chat.scrollHeight;
  return m.querySelector(".bubble");
}

/* ============================================================
   CHATS
   ============================================================ */
function loadChatsFromLS() {
  if (!__user) { __conversations = []; return; }
  try { __conversations = JSON.parse(localStorage.getItem(LS_KEY)) || []; }
  catch { __conversations = []; }
}
function saveChatsToLS() {
  if (!__user) return;
  try { localStorage.setItem(LS_KEY, JSON.stringify(__conversations.slice(0, 100))); } catch {}
}
function currentConvo() {
  return __conversations.find(c => c.id === currentConversationId) || null;
}

function renderHistory() {
  const list = $("#historyList"); if (!list) return;
  list.innerHTML = "";
  if (!__user) {
    list.innerHTML = '<li class="history-empty">Guest mode — chats aren\'t saved. Sign in to keep them.</li>';
    return;
  }
  const sorted = __conversations.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!sorted.length) { list.innerHTML = '<li class="history-empty">No conversations yet</li>'; return; }
  sorted.forEach(c => {
    const li = document.createElement("li");
    li.className = "history-item" + (c.id === currentConversationId ? " active" : "");
    li.dataset.id = c.id;
    li.innerHTML = `<i class="ri-chat-3-line"></i><div><span>${escapeHtml(c.title || "New chat")}</span></div><button class="history-delete"><i class="ri-delete-bin-line"></i></button>`;
    list.appendChild(li);
  });
}

function openConversationLS(id) {
  const c = __conversations.find(x => x.id === id);
  if (!c) return;
  currentConversationId = id;
  const t = $("#chatTitle"); if (t) t.textContent = c.title || "Chat";
  $("#mainEl")?.classList.remove("new-chat");
  const chat = $("#chat"); if (chat) chat.innerHTML = "";
  (c.messages || []).forEach(m => addMessage(m.text || m.content || "", m.role === "ai" ? "ai" : "user"));
  renderHistory();
}

function startNewChat() {
  currentConversationId = null;
  const chat = $("#chat"); if (chat) chat.innerHTML = "";
  const t = $("#chatTitle"); if (t) t.textContent = "New chat";
  const s = $("#chatSubtitle"); if (s) s.textContent = "";
  $("#mainEl")?.classList.add("new-chat");
  renderHistory();
}

/* ============================================================
   LOGIN / LOGOUT
   ============================================================ */
async function doLogin() {
  const s = $("#loginStatus");
  const name = $("#simpleLoginName")?.value.trim() || "";
  const email = $("#simpleLoginEmail")?.value.trim() || "";
  if (!name || !email) { if (s) s.textContent = "Name and email required."; return; }
  if (s) s.textContent = "Signing in…";
  try {
    const r = await authFetch("/api/auth/simple-login", {
      method: "POST",
      body: JSON.stringify({ name, email }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "Failed");
    if (d.token) setToken(d.token);
    if (s) s.textContent = "Signed in ✅";
    closeModal("loginModal");
    await loadMe();
    loadChatsFromLS();
    renderHistory();
  } catch (err) { if (s) s.textContent = err.message; }
}

async function doLogout() {
  try { await authFetch("/api/logout", { method: "POST" }); } catch {}
  setToken(null);
  __user = null; __tier = "free"; __conversations = [];
  const cl = $("#userChipLabel"); if (cl) cl.textContent = "Sign in";
  const n = $("#simpleLoginName"); if (n) n.value = "";
  const e = $("#simpleLoginEmail"); if (e) e.value = "";
  const tl = $("#tierLabel"); if (tl) tl.textContent = "Guest mode";
  const tm = $("#tierMeta"); if (tm) tm.textContent = "Sign in to save chats";
  const ub = $("#upgradeBtn"); if (ub) ub.textContent = "Sign in";
  startNewChat();
}

/* ============================================================
   LOADERS
   ============================================================ */
async function loadConfig() {
  try {
    const r = await fetch("/api/config", { cache: "no-store" });
    if (!r.ok) throw new Error();
    __config = await r.json();
  } catch {
    __config = {
      app: { name: "MiroxAI", made_by: "OpenSurr" },
      models: [
        { id: "mirox-luna-1.2", label: "Luna", tagline: "Warm & friendly", tier: "free", default: true },
        { id: "mirox-gen-1", label: "Gen", tagline: "Quick & concise", tier: "free", fallback: true }
      ],
      announcement: { enabled: false },
    };
  }
  window.__config = __config;
  buildModelPickerMenu();
}

async function loadMe() {
  try {
    const r = await authFetch("/api/me");
    const d = await r.json();
    __user = d.user || null;
    if (!__user) setToken(null);
  } catch { __user = null; }
  const cl = $("#userChipLabel"); if (cl) cl.textContent = __user ? __user.name : "Sign in";
  const lt = $("#loginTitle"); if (lt) lt.textContent = __user ? "Update profile" : "Sign in";
  if (__user) {
    if ($("#simpleLoginName")) $("#simpleLoginName").value = __user.name || "";
    if ($("#simpleLoginEmail")) $("#simpleLoginEmail").value = __user.email || "";
    __tier = __user.tier || "free";
    const tl = $("#tierLabel"); if (tl) tl.textContent = (__user.tier_label || "Free") + " plan";
    const ub = $("#upgradeBtn"); if (ub) ub.textContent = __tier === "free" ? "Upgrade" : "Manage";
    loadSubscriptionInfo();
  } else {
    __tier = "free";
    const tl = $("#tierLabel"); if (tl) tl.textContent = "Guest mode";
    const tm = $("#tierMeta"); if (tm) tm.textContent = "Sign in to save chats";
    const ub = $("#upgradeBtn"); if (ub) ub.textContent = "Sign in";
  }
  refreshModelLocks();
}

async function loadSubscriptionInfo() {
  if (!__user) return;
  try {
    const r = await authFetch("/api/subscription/me");
    const d = await r.json();
    if (!d.ok) return;
    __tier = d.tier || "free";
    const parts = [];
    if (__tier === "free") parts.push(`${d.trial_remaining}/${d.trial_limit} Ultimate`);
    parts.push(`${d.daily_remaining}/${d.daily_limit} msgs`);
    const meta = $("#tierMeta"); if (meta) meta.textContent = parts.join(" · ");
    const ku = $("#keysUsage");
    if (ku) ku.textContent = `${d.keys_remaining}/${d.keys_per_period} keys · refill every ${d.refill_days}d`;
  } catch {}
}

async function loadPersona() {
  if (!__user) { if ($("#personaInput")) $("#personaInput").value = ""; return; }
  try {
    const r = await authFetch("/api/settings/persona");
    const d = await r.json();
    if ($("#personaInput")) $("#personaInput").value = d.persona || "";
  } catch {}
}

async function loadMemory() {
  const list = $("#memoryList"); if (!list) return;
  list.innerHTML = "";
  if (!__user) { list.innerHTML = '<li class="memory-empty">Sign in to use memory.</li>'; return; }
  try {
    const r = await authFetch("/api/memory");
    const d = await r.json();
    const facts = d.facts || [];
    if (!facts.length) { list.innerHTML = '<li class="memory-empty">Nothing remembered yet.</li>'; return; }
    facts.forEach(f => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${escapeHtml(f.text)}</span><button class="memory-delete" data-id="${f.id}"><i class="ri-delete-bin-line"></i></button>`;
      li.querySelector(".memory-delete").addEventListener("click", async () => {
        await authFetch("/api/memory/" + f.id, { method: "DELETE" });
        loadMemory();
      });
      list.appendChild(li);
    });
  } catch {}
}

async function loadPlans() {
  try {
    const r = await fetch("/api/subscription/plans", { cache: "no-store" });
    const d = await r.json();
    const plans = d.plans || [];
    const grid = $("#plansGrid"); if (!grid) return;
    grid.innerHTML = plans.map(p => {
      const isCurrent = __user && __tier === p.id;
      const featured = p.id === "pro";
      let priceHtml = '<span style="color:var(--text-muted);font-weight:700">Free</span>';
      if (p.price_robux > 0) priceHtml = `R$ ${p.price_robux}<span style="font-size:11px;color:var(--text-muted);display:block">or ${p.price_afg} AFG</span>`;
      let buyBtn;
      if (p.id === "free") buyBtn = `<div class="plan-buy disabled">Free forever</div>`;
      else if (isCurrent) buyBtn = `<div class="plan-buy disabled">Current plan</div>`;
      else buyBtn = `<div class="plan-buy">Contact admin</div>`;
      return `<div class="plan-card${featured ? " featured" : ""}${isCurrent ? " current" : ""}">
        ${isCurrent ? '<span class="plan-badge current">Current</span>' : (featured ? '<span class="plan-badge">Popular</span>' : "")}
        <div class="plan-name">${escapeHtml(p.label)}</div>
        <div class="plan-tagline">${escapeHtml(p.tagline)}</div>
        <div class="plan-price">${priceHtml}</div>
        <ul class="plan-perks">${p.perks.map(x => `<li><i class="ri-check-line"></i><span>${escapeHtml(x)}</span></li>`).join("")}</ul>
        ${buyBtn}
      </div>`;
    }).join("");
  } catch {}
}

async function loadUserKeys() {
  const list = $("#keysList"); if (!list) return;
  if (!__user) { list.innerHTML = '<li class="key-empty">Sign in to manage API keys.</li>'; return; }
  try {
    const r = await authFetch("/api/keys");
    const d = await r.json();
    const keys = d.keys || [];
    if (!keys.length) { list.innerHTML = '<li class="key-empty">No keys yet.</li>'; return; }
    list.innerHTML = keys.map(k => `<li class="key-item"><div class="key-info"><div class="key-name">${escapeHtml(k.name)}</div>
      <div class="key-value">${escapeHtml(k.preview || "")}</div></div></li>`).join("");
  } catch {}
}

async function loadMyReports() {
  const box = $("#supportMine"); if (!box) return;
  if (!__user) { box.innerHTML = ""; return; }
  try {
    const r = await authFetch("/api/report/mine");
    const d = await r.json();
    const reports = d.reports || [];
    if (!reports.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<h4 style="font-size:12px;color:var(--text-muted);margin-bottom:10px">YOUR TICKETS</h4>` +
      reports.map(t => `<div style="background:var(--panel-2);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px;font-size:13px">
        <b>${escapeHtml(t.subject)}</b>
        <span style="color:var(--text-muted);font-size:11.5px"> · ${escapeHtml(t.status)}</span>
        <div style="color:var(--text-muted);font-size:12px;margin-top:4px">${escapeHtml((t.messages[0]||{}).text || "")}</div>
      </div>`).join("");
  } catch {}
}

/* ============================================================
   MODEL PICKER
   ============================================================ */
function buildModelPickerMenu() {
  const menu = $("#modelPickerMenu"); if (!menu) return;
  const models = __config?.models || [];
  menu.innerHTML = models.map(m => {
    const tier = m.tier || "free";
    const badge = tier !== "free" ? `<span class="model-tier-badge ${tier}">${tier}</span>` : "";
    return `<button type="button" class="model-option" data-model-id="${m.id}" data-tier="${tier}">
      <span class="model-option-icon">${(m.label || "?")[0]}</span>
      <span class="model-option-body">
        <span class="model-option-name">${escapeHtml(m.label)} ${badge}</span>
        <span class="model-option-tag">${escapeHtml(m.tagline || "")}</span>
      </span>
    </button>`;
  }).join("");
  const def = getDefaultModel();
  __model = def;
  updateModelPickerLabel(def);
}

function updateModelPickerLabel(id) {
  const model = (__config?.models || []).find(m => m.id === id);
  if (model && $("#modelPickerLabel")) $("#modelPickerLabel").textContent = model.label;
  const menu = $("#modelPickerMenu");
  if (menu) menu.querySelectorAll(".model-option").forEach(o => o.classList.toggle("active", o.dataset.modelId === id));
  __model = id;
}

function selectModel(id) {
  const model = (__config?.models || []).find(m => m.id === id);
  if (!model) return;
  const rank = { free: 0, pro: 1, ultimate: 2 };
  if ((rank[model.tier] || 0) > (rank[__tier] || 0) && model.tier !== "ultimate") {
    $("#modelPickerMenu")?.classList.remove("open");
    openModal("plansModal"); loadPlans();
    return;
  }
  updateModelPickerLabel(id);
  $("#modelPickerMenu")?.classList.remove("open");
}

function refreshModelLocks() {
  const menu = $("#modelPickerMenu"); if (!menu) return;
  const rank = { free: 0, pro: 1, ultimate: 2 };
  const u = rank[__tier] || 0;
  menu.querySelectorAll(".model-option").forEach(o => {
    const t = o.dataset.tier;
    let locked;
    if (!__user) locked = (rank[t] || 0) > 0 && t !== "ultimate";
    else if (__tier === "free" && t === "ultimate") locked = false;
    else locked = (rank[t] || 0) > u;
    o.classList.toggle("locked", locked);
  });
}

/* ============================================================
   APPEARANCE
   ============================================================ */
const root = document.documentElement;
function applyAppearance({ mode, theme, corner, font }) {
  if (mode) root.setAttribute("data-mode", mode);
  if (theme) root.setAttribute("data-theme", theme);
  if (corner) root.setAttribute("data-corner", corner);
  if (font) root.setAttribute("data-font", font);
  $$("#modeOptions .option-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === (mode || root.getAttribute("data-mode"))));
  $$("#themeSwatches .swatch").forEach(s => s.classList.toggle("active", s.dataset.theme === (theme || root.getAttribute("data-theme"))));
  $$("#cornerOptions .option-btn").forEach(b => b.classList.toggle("active", b.dataset.corner === (corner || root.getAttribute("data-corner"))));
  $$("#fontOptions .option-btn").forEach(b => b.classList.toggle("active", b.dataset.font === (font || root.getAttribute("data-font"))));
}
function loadAppearance() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem("miroxai_appearance") || "{}"); } catch {}
  applyAppearance({ mode: s.mode || "light", theme: s.theme || "warm", corner: s.corner || "soft", font: s.font || "system" });
}
function saveAppearance(patch) {
  let c = {};
  try { c = JSON.parse(localStorage.getItem("miroxai_appearance") || "{}"); } catch {}
  const m = { ...c, ...patch };
  try { localStorage.setItem("miroxai_appearance", JSON.stringify(m)); } catch {}
  applyAppearance(m);
}

/* ============================================================
   BACKGROUND
   ============================================================ */
function loadBackground() {
  try {
    const saved = JSON.parse(localStorage.getItem("miroxai_bg") || "{}");
    bgState = { url: saved.url || null, dim: saved.dim ?? 45, blur: saved.blur ?? 0 };
  } catch {}
  applyBackground();
  populateBackgroundUI();
}
function applyBackground() {
  const el = $("#userBackground"); if (!el) return;
  if (!bgState.url) {
    el.classList.remove("active"); el.style.backgroundImage = "";
    root.style.setProperty("--bg-dim", "0");
    root.style.setProperty("--bg-blur", "0px");
    return;
  }
  el.style.backgroundImage = `url('${bgState.url}')`;
  root.style.setProperty("--bg-dim", (bgState.dim / 100).toFixed(2));
  root.style.setProperty("--bg-blur", bgState.blur + "px");
  el.classList.add("active");
}
function saveBackgroundPrefs() {
  try { localStorage.setItem("miroxai_bg", JSON.stringify(bgState)); } catch {}
}
function populateBackgroundUI() {
  if ($("#bgDimInput")) $("#bgDimInput").value = bgState.dim;
  if ($("#bgBlurInput")) $("#bgBlurInput").value = bgState.blur;
  if ($("#bgDimLabel")) $("#bgDimLabel").textContent = bgState.dim + "%";
  if ($("#bgBlurLabel")) $("#bgBlurLabel").textContent = bgState.blur + "px";
  const urlEl = $("#bgUrlInput");
  if (urlEl) urlEl.value = bgState.url && !bgState.url.startsWith("data:") ? bgState.url : "";
}

document.addEventListener("input", function (e) {
  if (e.target?.id === "bgDimInput") { bgState.dim = parseInt(e.target.value); if ($("#bgDimLabel")) $("#bgDimLabel").textContent = bgState.dim + "%"; applyBackground(); saveBackgroundPrefs(); }
  if (e.target?.id === "bgBlurInput") { bgState.blur = parseInt(e.target.value); if ($("#bgBlurLabel")) $("#bgBlurLabel").textContent = bgState.blur + "px"; applyBackground(); saveBackgroundPrefs(); }
});

document.addEventListener("change", function (e) {
  if (e.target?.id === "bgFileInput") {
    const f = e.target.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { bgState.url = reader.result; saveBackgroundPrefs(); applyBackground(); populateBackgroundUI(); };
    reader.readAsDataURL(f);
  }
  if (e.target?.id === "fileInput") {
    const f = e.target.files[0]; if (!f) return;
    if ($("#attachmentPreview")) $("#attachmentPreview").style.display = "flex";
    if ($("#attachmentName")) $("#attachmentName").textContent = f.name;
  }
});

/* ============================================================
   RAIL
   ============================================================ */
function updateRailToggleIcon() {
  const i = $("#railToggleIcon"); if (!i) return;
  i.className = document.body.classList.contains("rail-collapsed") ? "ri-side-bar-line" : "ri-contract-left-line";
}
(function syncRail() {
  try { if (localStorage.getItem("miroxai_rail_collapsed") === "1") document.body.classList.add("rail-collapsed"); } catch {}
  updateRailToggleIcon();
})();

/* ============================================================
   ANNOUNCEMENT
   ============================================================ */
function showLunaAnnouncementOnce() {
  const a = __config?.announcement;
  if (!a || !a.enabled) return;
  const key = "miroxai_announce_" + (a.version || "v1");
  try { if (localStorage.getItem(key) === "1") return; } catch {}
  if ($("#announceTitle")) $("#announceTitle").textContent = a.title || "Announcement";
  if ($("#announceBody")) $("#announceBody").textContent = a.body || "";
  const imgEl = document.querySelector(".announce-img");
  if (imgEl && a.image) imgEl.src = "/" + a.image.replace(/^\//, "");
  if ($("#announcePoints")) {
    $("#announcePoints").innerHTML = (a.highlights || [])
      .map(h => `<div class="announce-point"><i class="ri-check-line"></i><span>${escapeHtml(h)}</span></div>`).join("");
  }
  openModal("lunaAnnounceModal");
  const dismiss = () => {
    try { localStorage.setItem(key, "1"); } catch {}
    closeModal("lunaAnnounceModal");
  };
  const btn = $("#announceOkBtn"); if (btn) btn.onclick = dismiss;
  document.querySelector('#lunaAnnounceModal [data-close]')?.addEventListener("click", dismiss);
}

/* ============================================================
   MIC
   ============================================================ */
(function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.onresult = e => {
    let t = "";
    for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
    if ($("#messageInput")) $("#messageInput").value = t;
    const sb = $("#sendBtn"); if (sb) sb.disabled = false;
  };
  recognition.onend = () => $("#micBtn")?.classList.remove("recording");
})();

/* ============================================================
   BOOT
   ============================================================ */
async function boot() {
  killLoader();
  loadAppearance();
  loadBackground();
  await loadConfig();
  await loadMe();
  loadChatsFromLS();
  renderHistory();
  updateRailToggleIcon();
  setTimeout(showLunaAnnouncementOnce, 1200);
  killLoader();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

setTimeout(() => { try { renderHistory(); } catch {} }, 1200);
