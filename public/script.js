/* ============================================================
   MiroxAI — frontend
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

/* ---------- GUARANTEED loading screen dismissal ---------- */
function hideLoader() {
  const l = document.getElementById("loadingScreen");
  if (l) l.classList.add("hidden");
}
setTimeout(hideLoader, 1500); // hard ceiling — never stays up more than 1.5s

/* ============================================================
   BOOT — fire-and-forget, never blocks the UI
   ============================================================ */
window.addEventListener("load", () => {
  loadConfig();               // no await
  loadBackground();
  loadAppearance();
  loadMe().then(() => {
    loadChatsFromLS();
    renderHistory();
  });
  syncRailDefault();
  wireAll();
  setTimeout(showLunaAnnouncementOnce, 1200);
  hideLoader();
});

/* ============================================================
   CONFIG
   ============================================================ */
async function loadConfig() {
  try {
    const r = await fetch("/api/config", { cache: "no-store" });
    if (!r.ok) throw new Error("bad status");
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

/* ============================================================
   SIDEBAR
   ============================================================ */
const sidebar      = $("#sidebar");
const sidebarScrim = $("#sidebarScrim");
const openSidebar  = () => { sidebar?.classList.add("open"); sidebarScrim?.classList.add("open"); };
const closeSidebar = () => { sidebar?.classList.remove("open"); sidebarScrim?.classList.remove("open"); };

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

/* ============================================================
   CHAT STORAGE
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
      messages: [], updatedAt: Date.now(),
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
            bubble.textContent = full || "(empty reply)";
            $("#chatSubtitle").textContent =
              (evt.model || "") + (evt.ms ? ` · ${evt.ms}ms` : "");
          } else if (evt.error) {
            throw new Error(evt.error);
          }
        }
      }
    }
    bubble.textContent = full || "(empty reply)";
    convo.messages.push({ role: "ai", text: full });
    convo.updatedAt = Date.now();
    saveChatsToLS();
  } catch (err) {
    bubble.textContent = err.message || "Something went wrong.";
  } finally {
    isReplying = false;
    $("#sendBtn").disabled = !$("#messageInput").value.trim();
  }
}

/* ============================================================
   WIRE EVERYTHING
   ============================================================ */
function wireAll() {

  railToggleBtn?.addEventListener("click", () => {
    document.body.classList.toggle("rail-collapsed");
    try { localStorage.setItem("miroxai_rail_collapsed", document.body.classList.contains("rail-collapsed") ? "1" : "0"); } catch {}
    updateRailToggleIcon();
  });

  $("#hamburgerBtn")?.addEventListener("click", openSidebar);
  $("#sidebarCloseBtn")?.addEventListener("click", closeSidebar);
  sidebarScrim?.addEventListener("click", closeSidebar);
  $("#brandLogo")?.addEventListener("click", () => { startNewChat(); if (window.innerWidth <= 860) closeSidebar(); });

  document.addEventListener("click", e => {
    const t = e.target.closest("[data-mode]"); if (t && t.closest("#modeOptions")) saveAppearance({ mode: t.dataset.mode });
    const s = e.target.closest(".swatch");     if (s && s.dataset.theme)        saveAppearance({ theme: s.dataset.theme });
    const c = e.target.closest("[data-corner]"); if (c && c.closest("#cornerOptions")) saveAppearance({ corner: c.dataset.corner });
    const f = e.target.closest("[data-font]"); if (f && f.closest("#fontOptions"))   saveAppearance({ font: f.dataset.font });
  });

  $("#newChatBtn")?.addEventListener("click", () => {
    startNewChat();
    if (window.innerWidth <= 860) closeSidebar();
  });

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

  $("#composerForm")?.addEventListener("submit", e => {
    e.preventDefault();
    if (isReplying) return;
    const t = $("#messageInput").value.trim();
    if (!t) return;
    $("#messageInput").value = "";
    sendMessage(t);
  });
  $("#messageInput")?.addEventListener("input", () => {
    $("#sendBtn").disabled = isReplying || !$("#messageInput").value.trim();
  });

  $("#attachBtn")?.addEventListener("click", () => $("#fileInput").click());
  $("#fileInput")?.addEventListener("change", () => {
    const f = $("#fileInput").files[0]; if (!f) return;
    $("#attachmentPreview").style.display = "flex";
    $("#attachmentName").textContent = f.name;
  });
  $("#removeAttachmentBtn")?.addEventListener("click", () => {
    $("#attachmentPreview").style.display = "none";
  });

  const micBtn = $("#micBtn");
  let recognition = null;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = e => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      $("#messageInput").value = t;
      $("#sendBtn").disabled = false;
    };
    recognition.onend = () => micBtn?.classList.remove("recording");
  }
  micBtn?.addEventListener("click", () => {
    if (!recognition) { alert("Voice input isn't supported in this browser."); return; }
    try { recognition.start(); micBtn.classList.add("recording"); } catch {}
  });

  $("#settingsBtn")?.addEventListener("click", () => {
    openModal("settingsModal");
    loadPersona();
    loadMemory();
  });
  document.querySelectorAll(".settings-tab").forEach(t => t.addEventListener("click", () => {
    document.querySelectorAll(".settings-tab").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".settings-pane").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    document.querySelector(`.settings-pane[data-pane="${t.dataset.tab}"]`)?.classList.add("active");
  }));

  $("#talkModeBtn")?.addEventListener("click", () => {
    $("#callOverlay").classList.add("open");
    $("#callStatus").textContent = "Voice calling unavailable";
    $("#callTranscript").textContent = "Use the chat instead.";
  });
  $("#callEndBtn")?.addEventListener("click", () => $("#callOverlay").classList.remove("open"));
  $("#callMuteBtn")?.addEventListener("click", () => $("#callMuteBtn")?.classList.toggle("muted"));

  $("#imageModeBtn")?.addEventListener("click", () => openModal("imageModal"));
  $("#videoModeBtn")?.addEventListener("click", () => openModal("videoModal"));
  $("#backgroundModeBtn")?.addEventListener("click", () => { openModal("backgroundModal"); populateBackgroundUI(); });
  $("#plansModeBtn")?.addEventListener("click", () => { openModal("plansModal"); loadPlans(); loadUserKeys(); });
  $("#supportModeBtn")?.addEventListener("click", () => { openModal("supportModal"); loadMyReports(); });
  $("#upgradeBtn")?.addEventListener("click", () => {
    if (!__user) openModal("loginModal");
    else { openModal("plansModal"); loadPlans(); loadUserKeys(); }
  });

  $("#userChip")?.addEventListener("click", () => { if (!__user) openModal("loginModal"); });

  $("#editTitleBtn")?.addEventListener("click", () => {
    const current = $("#chatTitle").textContent;
    const next = prompt("Rename this chat", current);
    if (next === null) return;
    const trimmed = next.trim(); if (!trimmed) return;
    $("#chatTitle").textContent = trimmed;
    const convo = currentConvo();
    if (convo) { convo.title = trimmed; saveChatsToLS(); renderHistory(); }
  });

  $("#simpleLoginForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const status = $("#loginStatus");
    const name   = $("#simpleLoginName").value.trim();
    const email  = $("#simpleLoginEmail").value.trim();
    if (!name || !email) { status.textContent = "Name and email required."; return; }
    status.textContent = "Signing in…";
    try {
      const r = await fetch("/api/auth/simple-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name, email }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "Failed");
      status.textContent = "Signed in ✅";
      closeModal("loginModal");
      await loadMe();
      loadChatsFromLS();
      renderHistory();
    } catch (err) {
      status.textContent = err.message;
    }
  });

  $("#logoutBtn")?.addEventListener("click", async () => {
    try { await fetch("/api/logout", { method: "POST" }); } catch {}
    __user = null; window.__user = null; __tier = "free";
    __conversations = [];
    $("#userChipLabel").textContent = "Sign in";
    $("#simpleLoginName").value = "";
    $("#simpleLoginEmail").value = "";
    $("#tierLabel").textContent = "Guest mode";
    $("#tierMeta").textContent = "Sign in to save chats";
    $("#upgradeBtn").textContent = "Sign in";
    startNewChat();
  });

  $("#savePersonaBtn")?.addEventListener("click", async () => {
    if (!__user) { $("#personaStatus").textContent = "Sign in first."; return; }
    const p = $("#personaInput").value;
    const s = $("#personaStatus"); s.textContent = "Saving…";
    try {
      const r = await fetch("/api/settings/persona", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona: p }),
      });
      const d = await r.json();
      s.textContent = d.ok ? "Saved." : "Failed.";
    } catch { s.textContent = "Failed."; }
  });

  $("#addMemoryBtn")?.addEventListener("click", async () => {
    if (!__user) return;
    const v = $("#memoryInput").value.trim(); if (!v) return;
    await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fact: v }),
    });
    $("#memoryInput").value = "";
    loadMemory();
  });

  $("#connectServerBtn")?.addEventListener("click", async () => {
    const s = $("#serverStatus"); s.textContent = "Checking…";
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      const d = await r.json();
      s.textContent = `Connected ✅ (HF: ${d.hf ? "yes" : "no"})`;
    } catch { s.textContent = "Server unreachable."; }
  });

  $("#submitReportBtn")?.addEventListener("click", async () => {
    const status  = $("#reportStatus");
    if (!__user) { status.textContent = "Sign in to send a ticket."; return; }
    const subject = $("#reportSubject").value.trim();
    const message = $("#reportMessage").value.trim();
    if (!message) { status.textContent = "Please describe your issue."; return; }
    status.textContent = "Sending…";
    try {
      const r = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, message, category: "general" }),
      });
      const d = await r.json();
      if (d.ok) {
        status.textContent = "Ticket sent ✅";
        $("#reportSubject").value = ""; $("#reportMessage").value = "";
        loadMyReports();
      } else status.textContent = d.error || "Failed.";
    } catch { status.textContent = "Failed."; }
  });

  $("#generateKeyBtn")?.addEventListener("click", async () => {
    const status = $("#keyGenStatus");
    if (!__user) { status.textContent = "Sign in first."; return; }
    const name = $("#newKeyNameInput").value.trim() || "My key";
    status.textContent = "Generating…";
    try {
      const r = await fetch("/api/keys/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const d = await r.json();
      if (d.ok) {
        status.innerHTML = `Created ✅ — <code>${escapeHtml(d.key)}</code>`;
        $("#newKeyNameInput").value = "";
        loadUserKeys();
      } else status.textContent = d.error || "Failed.";
    } catch { status.textContent = "Failed."; }
  });

  $("#generateImageBtn")?.addEventListener("click", async () => {
    const prompt = $("#imagePromptInput").value.trim(); if (!prompt) return;
    const btn    = $("#generateImageBtn");
    const status = $("#imageStudioStatus");
    btn.disabled = true;
    status.textContent = "Generating… this can take 15–30 seconds.";

    const card = document.createElement("div");
    card.className = "gallery-card";
    card.innerHTML = `<div class="gallery-skeleton"></div>`;
    $("#imageGallery").prepend(card);

    try {
      const r = await fetch("/api/image/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "Failed");
      card.innerHTML = `<img src="${d.image}" alt="">`;
      status.textContent = "";
    } catch (e) {
      card.innerHTML = `<div class="gallery-error"><i class="ri-error-warning-line"></i><span>${escapeHtml(e.message)}</span></div>`;
      status.textContent = e.message;
    } finally { btn.disabled = false; }
  });

  $("#generateVideoBtn")?.addEventListener("click", () => {
    $("#videoStudioStatus").textContent = "Video generation isn't enabled on this deployment.";
  });

  $("#modelPickerBtn")?.addEventListener("click", e => {
    e.stopPropagation();
    $("#modelPickerMenu")?.classList.toggle("open");
  });
  document.addEventListener("click", e => {
    if (!e.target.closest("#modelPicker")) $("#modelPickerMenu")?.classList.remove("open");
  });

  /* Background */
  $("#bgUploadZone")?.addEventListener("click", () => $("#bgFileInput").click());
  $("#bgFileInput")?.addEventListener("change", () => {
    const f = $("#bgFileInput").files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      bgState.url = reader.result;
      saveBackgroundPrefs(); applyBackground(); populateBackgroundUI();
    };
    reader.readAsDataURL(f);
  });
  $("#bgUrlApplyBtn")?.addEventListener("click", () => {
    const u = $("#bgUrlInput").value.trim(); if (!u) return;
    bgState.url = u; saveBackgroundPrefs(); applyBackground();
  });
  $("#bgDimInput")?.addEventListener("input", e => {
    bgState.dim = parseInt(e.target.value);
    $("#bgDimLabel").textContent = bgState.dim + "%";
    applyBackground(); saveBackgroundPrefs();
  });
  $("#bgBlurInput")?.addEventListener("input", e => {
    bgState.blur = parseInt(e.target.value);
    $("#bgBlurLabel").textContent = bgState.blur + "px";
    applyBackground(); saveBackgroundPrefs();
  });
  $("#bgRemoveBtn")?.addEventListener("click", () => {
    bgState.url = null; saveBackgroundPrefs(); applyBackground();
    $("#bgUrlInput").value = "";
  });
}

/* ============================================================
   USER / TIER
   ============================================================ */
async function loadMe() {
  try {
    const r = await fetch("/api/me", { credentials: "same-origin" });
    const d = await r.json();
    window.__user = d.user || null;
    __user = window.__user;
  } catch { window.__user = null; __user = null; }

  const chipLabel = $("#userChipLabel");
  if (chipLabel) chipLabel.textContent = __user ? __user.name : "Sign in";

  const titleEl = $("#loginTitle");
  if (titleEl) titleEl.textContent = __user ? "Update profile" : "Sign in";

  if (__user) {
    const n = $("#simpleLoginName");  if (n) n.value = __user.name  || "";
    const e = $("#simpleLoginEmail"); if (e) e.value = __user.email || "";
    updateTierUI(__user.tier || "free", __user.tier_label || "Free");
    loadSubscriptionInfo();
  } else {
    __tier = "free";
    const label = $("#tierLabel"); if (label) label.textContent = "Guest mode";
    const meta  = $("#tierMeta");  if (meta)  meta.textContent  = "Sign in to save chats";
    const ub    = $("#upgradeBtn"); if (ub)   ub.textContent    = "Sign in";
    refreshModelLocks();
  }
}

function updateTierUI(tier, label) {
  __tier = tier || "free";
  const labelEl = $("#tierLabel");
  if (labelEl) labelEl.textContent = (label || "Free") + " plan";

  const icon = document.querySelector(".tier-chip-icon");
  if (icon) {
    if (__tier === "ultimate")  icon.style.background = "linear-gradient(135deg,#8b5cf6,#6d28d9)";
    else if (__tier === "pro")  icon.style.background = "linear-gradient(135deg,#3b82f6,#1d4ed8)";
    else                        icon.style.background = "linear-gradient(135deg,var(--accent),var(--accent-hover))";
  }
  const ub = $("#upgradeBtn");
  if (ub) ub.textContent = __tier === "free" ? "Upgrade" : "Manage";
  refreshModelLocks();
}

async function loadSubscriptionInfo() {
  if (!__user) return;
  try {
    const r = await fetch("/api/subscription/me");
    const d = await r.json(); if (!d.ok) return;
    __imagesAllowed  = !!d.images_allowed;
    __dailyRemaining = d.daily_remaining || 0;
    __dailyLimit     = d.daily_limit || 50;
    __trialRemaining = d.trial_remaining || 0;
    __trialLimit     = d.trial_limit || 10;
    updateTierUI(d.tier, d.tier_label);

    const parts = [];
    if (__tier === "free") parts.push(`${__trialRemaining}/${__trialLimit} Ultimate`);
    parts.push(`${__dailyRemaining}/${__dailyLimit} msgs`);
    const meta = $("#tierMeta"); if (meta) meta.textContent = parts.join(" · ");

    const ku = $("#keysUsage");
    if (ku) ku.textContent = `${d.keys_remaining}/${d.keys_per_period} keys · refill every ${d.refill_days}d`;
  } catch {}
}

/* ============================================================
   MODEL PICKER
   ============================================================ */
function buildModelPickerMenu() {
  const menu = $("#modelPickerMenu"); if (!menu) return;
  const models = __config?.models || [];
  menu.innerHTML = models.map(m => {
    const tier  = m.tier || "free";
    const badge = tier !== "free" ? `<span class="model-tier-badge ${tier}">${tier}</span>` : "";
    return `<button type="button" class="model-option" data-model-id="${m.id}" data-tier="${tier}">
      <span class="model-option-icon">${(m.label || "?")[0]}</span>
      <span class="model-option-body">
        <span class="model-option-name">${escapeHtml(m.label)} ${badge}</span>
        <span class="model-option-tag">${escapeHtml(m.tagline || "")}</span>
      </span>
    </button>`;
  }).join("");
  menu.querySelectorAll("[data-model-id]").forEach(btn =>
    btn.addEventListener("click", () => selectModel(btn.dataset.modelId))
  );
  const def = getDefaultModel();
  window.__model = def;
  updateModelPickerLabel(def);
}
function updateModelPickerLabel(id) {
  const model = (__config?.models || []).find(m => m.id === id);
  if (model) $("#modelPickerLabel").textContent = model.label;
  const menu = $("#modelPickerMenu");
  if (menu) menu.querySelectorAll(".model-option").forEach(o =>
    o.classList.toggle("active", o.dataset.modelId === id));
  window.__model = id;
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
   BACKGROUND
   ============================================================ */
let bgState = { url: null, dim: 45, blur: 0 };
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
    el.classList.remove("active");
    el.style.backgroundImage = "";
    root.style.setProperty("--bg-dim", "0");
    root.style.setProperty("--bg-blur", "0px");
    return;
  }
  el.style.backgroundImage = `url('${bgState.url}')`;
  el.style.setProperty("--bg-dim", (bgState.dim / 100).toFixed(2));
  el.style.setProperty("--bg-blur", bgState.blur + "px");
  el.classList.add("active");
}
function saveBackgroundPrefs() {
  try { localStorage.setItem("miroxai_bg", JSON.stringify(bgState)); } catch {}
}
function populateBackgroundUI() {
  const d = $("#bgDimInput");  if (d) d.value = bgState.dim;
  const b = $("#bgBlurInput"); if (b) b.value = bgState.blur;
  const dl = $("#bgDimLabel");  if (dl) dl.textContent = bgState.dim + "%";
  const bl = $("#bgBlurLabel"); if (bl) bl.textContent = bgState.blur + "px";
  const urlEl = $("#bgUrlInput");
  if (urlEl) urlEl.value = bgState.url && !bgState.url.startsWith("data:") ? bgState.url : "";
}

/* ============================================================
   PERSONA / MEMORY loaders
   ============================================================ */
async function loadPersona() {
  if (!__user) { $("#personaInput").value = ""; return; }
  try {
    const r = await fetch("/api/settings/persona");
    const d = await r.json();
    $("#personaInput").value = d.persona || "";
  } catch {}
}
async function loadMemory() {
  const list = $("#memoryList"); if (!list) return;
  list.innerHTML = "";
  if (!__user) {
    list.innerHTML = '<li class="memory-empty">Sign in to use memory.</li>';
    return;
  }
  try {
    const r = await fetch("/api/memory");
    const d = await r.json();
    const facts = d.facts || [];
    if (!facts.length) { list.innerHTML = '<li class="memory-empty">Nothing remembered yet.</li>'; return; }
    facts.forEach(f => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${escapeHtml(f.text)}</span><button class="memory-delete"><i class="ri-delete-bin-line"></i></button>`;
      li.querySelector(".memory-delete").addEventListener("click", async () => {
        await fetch("/api/memory/" + f.id, { method: "DELETE" });
        loadMemory();
      });
      list.appendChild(li);
    });
  } catch {}
}

/* ============================================================
   PLANS / KEYS / REPORTS loaders
   ============================================================ */
async function loadPlans() {
  try {
    const r = await fetch("/api/subscription/plans");
    const d = await r.json();
    const plans = d.plans || [];
    const grid = $("#plansGrid");
    grid.innerHTML = plans.map(p => {
      const isCurrent = __user && __tier === p.id;
      const featured  = p.id === "pro";
      let priceHtml = '<span style="color:var(--text-muted);font-weight:700">Free</span>';
      if (p.price_robux > 0) priceHtml = `R$ ${p.price_robux}<span style="font-size:11px;color:var(--text-muted);display:block">or ${p.price_afg} AFG</span>`;
      let buyBtn;
      if (p.id === "free")       buyBtn = `<div class="plan-buy disabled">Free forever</div>`;
      else if (isCurrent)        buyBtn = `<div class="plan-buy disabled">Current plan</div>`;
      else                       buyBtn = `<div class="plan-buy" data-buy="${p.id}">Contact admin</div>`;
      return `<div class="plan-card${featured ? " featured" : ""}${isCurrent ? " current" : ""}">
        ${isCurrent ? '<span class="plan-badge current">Current</span>' : (featured ? '<span class="plan-badge">Popular</span>' : "")}
        <div class="plan-name">${escapeHtml(p.label)}</div>
        <div class="plan-tagline">${escapeHtml(p.tagline)}</div>
        <div class="plan-price">${priceHtml}</div>
        <ul class="plan-perks">${p.perks.map(x => `<li><i class="ri-check-line"></i><span>${escapeHtml(x)}</span></li>`).join("")}</ul>
        ${buyBtn}
      </div>`;
    }).join("");
    grid.querySelectorAll("[data-buy]").forEach(b =>
      b.addEventListener("click", () => alert("Contact the admin to activate your plan."))
    );
  } catch {}
}

async function loadUserKeys() {
  const list = $("#keysList"); if (!list) return;
  if (!__user) { list.innerHTML = '<li class="key-empty">Sign in to manage API keys.</li>'; return; }
  try {
    const r = await fetch("/api/keys");
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
    const r = await fetch("/api/report/mine");
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
