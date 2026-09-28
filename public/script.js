/* ============================================================
   MiroxAI — frontend (browser)
   ============================================================ */

let __config = null;
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

let currentConversationId = null, isReplying = false;
let __user = null, __tier = "free";
let __imagesAllowed = true, __dailyRemaining = 50, __dailyLimit = 50;
let __trialRemaining = 10, __trialLimit = 10;

const LS_KEY = "miroxai_conversations_v1";
let __conversations = [];

/* ============================================================
   BOOT
   ============================================================ */
window.addEventListener("load", async () => {
  await loadConfig();
  setTimeout(() => { const l = $("#loadingScreen"); if (l) l.classList.add("hidden"); }, 350);
  loadBackground();
  loadAppearance();
  await loadMe();                 // <- user session loaded
  loadChatsFromLS();
  renderHistory();
  syncRailDefault();
  wireAll();
  setTimeout(showLunaAnnouncementOnce, 900);
});

/* ============================================================
   CONFIG
   ============================================================ */
async function loadConfig() {
  try {
    const r = await fetch("/config.json", { cache: "no-store" });
    __config = await r.json();
  } catch {
    __config = {
      app: { name: "MiroxAI", made_by: "OpenSurr" },
      models: [
        { id: "mirox-luna-1.2", label: "Luna", tagline: "Warm & friendly", tier: "free", default: true },
        { id: "mirox-gen-1",    label: "Gen",  tagline: "Quick & concise", tier: "free", fallback: true }
      ],
      plans: { free: { label: "Free", daily_limit: 50, ultimate_trial_limit: 10 } },
      announcement: { enabled: false },
    };
  }
  window.__config = __config;
  buildModelPickerMenu();
  updateDisclaimer();
}
const getDefaultModel = () => {
  const d = (__config?.models || []).find(m => m.default);
  return d ? d.id : "mirox-luna-1.2";
};
function updateDisclaimer() {
  const el = $("#disclaimer"); if (!el) return;
  const brand = __config?.app?.made_by || "OpenSurr";
  el.innerHTML = `Mirox can make mistakes. Made by the <b>${brand}</b> team.`;
}

/* ============================================================
   MODALS
   ============================================================ */
const openModal  = id => { const el = document.getElementById(id); if (el) el.classList.add("open"); };
const closeModal = id => { const el = document.getElementById(id); if (el) el.classList.remove("open"); };

document.querySelectorAll("[data-close]").forEach(b =>
  b.addEventListener("click", () => closeModal(b.dataset.close))
);
document.querySelectorAll(".modal-overlay").forEach(o =>
  o.addEventListener("click", e => { if (e.target === o) o.classList.remove("open"); })
);
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  document.querySelectorAll(".modal-overlay.open").forEach(o => o.classList.remove("open"));
  $("#modelPickerMenu")?.classList.remove("open");
});

/* ============================================================
   ANNOUNCEMENT
   ============================================================ */
function showLunaAnnouncementOnce() {
  const a = __config?.announcement;
  if (!a || !a.enabled) return;
  const key = "miroxai_announce_" + (a.version || "v1");
  try { if (localStorage.getItem(key) === "1") return; } catch {}

  $("#announceTitle").textContent = a.title || "Announcement";
  $("#announceBody").textContent  = a.body  || "";
  const imgEl = document.querySelector(".announce-img");
  if (imgEl && a.image) imgEl.src = "/" + a.image.replace(/^\//, "");

  const pointsEl = $("#announcePoints");
  pointsEl.innerHTML = (a.highlights || [])
    .map(h => `<div class="announce-point"><i class="ri-check-line"></i><span>${escapeHtml(h)}</span></div>`)
    .join("");

  openModal("lunaAnnounceModal");
  const dismiss = () => {
    try { localStorage.setItem(key, "1"); } catch {}
    closeModal("lunaAnnounceModal");
  };
  $("#announceOkBtn").onclick = dismiss;
  document.querySelector('#lunaAnnounceModal [data-close]')?.addEventListener("click", dismiss);
}

/* ============================================================
   RAIL
   ============================================================ */
const railToggleBtn  = $("#railToggleBtn");
const railToggleIcon = $("#railToggleIcon");
function syncRailDefault() {
  try { if (localStorage.getItem("miroxai_rail_collapsed") === "1") document.body.classList.add("rail-collapsed"); } catch {}
  updateRailToggleIcon();
}
function updateRailToggleIcon() {
  if (!railToggleIcon) return;
  railToggleIcon.className = document.body.classList.contains("rail-collapsed")
    ? "ri-side-bar-line" : "ri-contract-left-line";
}
railToggleBtn?.addEventListener("click", () => {
  document.body.classList.toggle("rail-collapsed");
  try { localStorage.setItem("miroxai_rail_collapsed", document.body.classList.contains("rail-collapsed") ? "1" : "0"); } catch {}
  updateRailToggleIcon();
});

/* ============================================================
   SIDEBAR
   ============================================================ */
const sidebar      = $("#sidebar");
const sidebarScrim = $("#sidebarScrim");
const openSidebar  = () => { sidebar?.classList.add("open"); sidebarScrim?.classList.add("open"); };
const closeSidebar = () => { sidebar?.classList.remove("open"); sidebarScrim?.classList.remove("open"); };

$("#hamburgerBtn")?.addEventListener("click", openSidebar);
$("#sidebarCloseBtn")?.addEventListener("click", closeSidebar);
sidebarScrim?.addEventListener("click", closeSidebar);
$("#brandLogo")?.addEventListener("click", () => { startNewChat(); if (window.innerWidth <= 860) closeSidebar(); });

/* ============================================================
   APPEARANCE
   ============================================================ */
const root = document.documentElement;
function applyAppearance({ mode, theme, corner, font }) {
  if (mode)   root.setAttribute("data-mode",   mode);
  if (theme)  root.setAttribute("data-theme",  theme);
  if (corner) root.setAttribute("data-corner", corner);
  if (font)   root.setAttribute("data-font",   font);
  $$("#modeOptions .option-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === (mode || root.getAttribute("data-mode"))));
  $$("#themeSwatches .swatch").forEach(s => s.classList.toggle("active", s.dataset.theme === (theme || root.getAttribute("data-theme"))));
  $$("#cornerOptions .option-btn").forEach(b => b.classList.toggle("active", b.dataset.corner === (corner || root.getAttribute("data-corner"))));
  $$("#fontOptions .option-btn").forEach(b => b.classList.toggle("active", b.dataset.font === (font || root.getAttribute("data-font"))));
}
function loadAppearance() {
  const s = JSON.parse(localStorage.getItem("miroxai_appearance") || "{}");
  applyAppearance({ mode: s.mode || "light", theme: s.theme || "warm", corner: s.corner || "soft", font: s.font || "system" });
}
function saveAppearance(patch) {
  const c = JSON.parse(localStorage.getItem("miroxai_appearance") || "{}");
  const m = { ...c, ...patch };
  localStorage.setItem("miroxai_appearance", JSON.stringify(m));
  applyAppearance(m);
}
document.addEventListener("click", e => {
  const t = e.target.closest("[data-mode]"); if (t && t.closest("#modeOptions")) saveAppearance({ mode: t.dataset.mode });
  const s = e.target.closest(".swatch");     if (s && s.dataset.theme)        saveAppearance({ theme: s.dataset.theme });
  const c = e.target.closest("[data-corner]"); if (c && c.closest("#cornerOptions")) saveAppearance({ corner: c.dataset.corner });
  const f = e.target.closest("[data-font]"); if (f && f.closest("#fontOptions"))   saveAppearance({ font: f.dataset.font });
});

/* ============================================================
   CHAT STORAGE (only persists for signed-in users)
   ============================================================ */
function loadChatsFromLS() {
  if (!__user) { __conversations = []; return; }
  try { __conversations = JSON.parse(localStorage.getItem(LS_KEY)) || []; }
  catch { __conversations = []; }
}
function saveChatsToLS() {
  if (!__user) return;   // guests don't persist
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
    li.innerHTML = `<i class="ri-chat-3-line"></i><div><span>${escapeHtml(c.title || "New chat")}</span></div><button class="history-delete"><i class="ri-delete-bin-line"></i></button>`;
    li.addEventListener("click", e => {
      if (e.target.closest(".history-delete")) return;
      openConversationLS(c.id);
      if (window.innerWidth <= 860) closeSidebar();
    });
    li.querySelector(".history-delete").addEventListener("click", e => {
      e.stopPropagation();
      __conversations = __conversations.filter(x => x.id !== c.id);
      if (currentConversationId === c.id) startNewChat();
      saveChatsToLS();
      renderHistory();
    });
    list.appendChild(li);
  });
}

function openConversationLS(id) {
  const c = __conversations.find(x => x.id === id);
  if (!c) return;
  currentConversationId = id;
  $("#chatTitle").textContent = c.title || "Chat";
  $("#mainEl")?.classList.remove("new-chat");
  $("#chat").innerHTML = "";
  (c.messages || []).forEach(m =>
    addMessage(m.text || m.content || "", m.role === "ai" ? "ai" : "user")
  );
  renderHistory();
}

function startNewChat() {
  currentConversationId = null;
  $("#chat").innerHTML = "";
  $("#chatTitle").textContent = "New chat";
  $("#chatSubtitle").textContent = "";
  $("#mainEl")?.classList.add("new-chat");
  renderHistory();
}
$("#newChatBtn")?.addEventListener("click", () => {
  startNewChat();
  if (window.innerWidth <= 860) closeSidebar();
});

/* ============================================================
   SIDEBAR SEARCH
   ============================================================ */
const chatSearchInput = $("#chatSearchInput");
const clearSearchBtn  = $("#clearSearchBtn");
chatSearchInput?.addEventListener("input", () => {
  const q = chatSearchInput.value.trim();
  clearSearchBtn?.classList.toggle("visible", !!q);
  const list = $("#historyList"); if (!list) return;
  list.innerHTML = "";
  if (!__user) { list.innerHTML = '<li class="history-empty">Sign in to search</li>'; return; }
  const items = __conversations.filter(c => !q || (c.title || "").toLowerCase().includes(q.toLowerCase()));
  if (!items.length) { list.innerHTML = '<li class="history-empty">No matches</li>'; return; }
  items.forEach(c => {
    const li = document.createElement("li");
    li.className = "history-item";
    li.innerHTML = `<i class="ri-chat-3-line"></i><div><span>${escapeHtml(c.title || "New chat")}</span></div>`;
    li.addEventListener("click", () => openConversationLS(c.id));
    list.appendChild(li);
  });
});
clearSearchBtn?.addEventListener("click", () => {
  chatSearchInput.value = "";
  clearSearchBtn.classList.remove("visible");
  renderHistory();
});

/* ============================================================
   MESSAGE HELPERS
   ============================================================ */
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function addMessage(text, sender) {
  const chat = $("#chat"); if (!chat) return null;
  const m = document.createElement("div");
  m.className = `message ${sender}`;
  const avatarHtml = sender === "ai"
    ? `<div class="avatar ai-avatar"><img src="/logo.png" alt="" onerror="this.style.display='none'"></div>`
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
  m.innerHTML = `<div class="avatar ai-avatar"><img src="/logo.png" alt="" onerror="this.style.display='none'"></div><div class="bubble-wrap"><div class="bubble"><div class="thinking"><span class="thinking-dots"><span></span><span></span><span></span></span></div></div></div>`;
  chat.appendChild(m);
  chat.scrollTop = chat.scrollHeight;
  return m.querySelector(".bubble");
}

/* ============================================================
   SEND
   ============================================================ */
async function sendMessage(userText) {
  if (isReplying) return;
  userText = (userText || "").trim();
  if (!userText) return;

  $("#mainEl")?.classList.remove("new-chat");

  let convo = currentConvo();
  if (!convo) {
    convo = {
      id: "c_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4),
      title: userText.slice(0, 48) || "New chat",
      messages: [],
      updatedAt: Date.now(),
    };
    __conversations.unshift(convo);
    currentConversationId = convo.id;
    $("#chatTitle").textContent = convo.title;
    renderHistory();
  }

  convo.messages.push({ role: "user", text: userText });
  convo.updatedAt = Date.now();
  saveChatsToLS();
  addMessage(userText, "user");

  const bubble = addThinking();
  isReplying = true;
  $("#sendBtn").disabled = true;

  try {
    const history = convo.messages
      .slice(0, -1)
      .map(m => ({ role: m.role === "ai" ? "assistant" : "user", content: m.text || m.content }));

    const r = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: userText, history,
        model: window.__model || getDefaultModel(),
      }),
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
            bubble.textContent = full
