let __config = null;
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

let currentConversationId = null, isReplying = false;
let __user = null, __tier = "free";
let __imagesAllowed = true, __dailyRemaining = 50, __dailyLimit = 50;
let __trialRemaining = 10, __trialLimit = 10;
let __emailConnected = false;
let expandedTickets = new Set();

window.addEventListener("load", async () => {
  await loadConfig();
  setTimeout(() => { const l = $("#loadingScreen"); if (l) l.classList.add("hidden"); }, 350);
  loadBackground();
  loadAppearance();
  await loadMe();
  renderHistoryFromLS();
  syncRailDefault();
  setTimeout(showLunaAnnouncementOnce, 900);
});

// ---------- CONFIG ----------
async function loadConfig() {
  try {
    const r = await fetch("/config.json", { cache: "no-store" });
    __config = await r.json();
  } catch {
    __config = {
      app: { name: "MiroxAI", made_by: "OpenSurr" },
      models: [
        { id: "mirox-luna-1.2", label: "Luna", tagline: "Smart and fast", tier: "free", default: true },
        { id: "mirox-gen-1", label: "Gen", tagline: "Quick and light", tier: "free", fallback: true }
      ],
      plans: { free: { label: "Free", daily_limit: 50, ultimate_trial_limit: 10 } },
      payments: { hesabpay: { enabled: false }, robux: { enabled: true }, afg_cash: { enabled: true } },
      email: { enabled: true, free_daily_limit: 5 },
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

// ---------- MODALS ----------
const openModal = id => { const el = document.getElementById(id); if (el) el.classList.add("open"); };
const closeModal = id => { const el = document.getElementById(id); if (el) el.classList.remove("open"); };
document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => closeModal(b.dataset.close)));
document.querySelectorAll(".modal-overlay").forEach(o => o.addEventListener("click", e => { if (e.target === o) o.classList.remove("open"); }));
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  document.querySelectorAll(".modal-overlay.open").forEach(o => o.classList.remove("open"));
  $("#modelPickerMenu")?.classList.remove("open");
});

// ---------- ANNOUNCEMENT ----------
function showLunaAnnouncementOnce() {
  const a = __config?.announcement;
  if (!a || !a.enabled) return;
  const key = "miroxai_announce_" + (a.version || "v1");
  try { if (localStorage.getItem(key) === "1") return; } catch {}
  $("#announceTitle").textContent = a.title || "Announcement";
  $("#announceBody").textContent = a.body || "";
  const imgEl = document.querySelector(".announce-img");
  if (imgEl && a.image) imgEl.src = a.image;
  const pointsEl = $("#announcePoints");
  pointsEl.innerHTML = (a.highlights || []).map(h => `<div class="announce-point"><i class="ri-check-line"></i><span>${escapeHtml(h)}</span></div>`).join("");
  openModal("lunaAnnounceModal");
  const dismiss = () => { try { localStorage.setItem(key, "1"); } catch {} closeModal("lunaAnnounceModal"); };
  $("#announceOkBtn").onclick = dismiss;
  document.querySelector('#lunaAnnounceModal [data-close]')?.addEventListener("click", dismiss);
}

// ---------- RAIL ----------
const railToggleBtn = $("#railToggleBtn");
const railToggleIcon = $("#railToggleIcon");
function syncRailDefault() {
  try { if (localStorage.getItem("miroxai_rail_collapsed") === "1") document.body.classList.add("rail-collapsed"); } catch {}
  updateRailToggleIcon();
}
function updateRailToggleIcon() {
  if (!railToggleIcon) return;
  const collapsed = document.body.classList.contains("rail-collapsed");
  railToggleIcon.className = collapsed ? "ri-side-bar-line" : "ri-contract-left-line";
}
railToggleBtn?.addEventListener("click", () => {
  document.body.classList.toggle("rail-collapsed");
  try { localStorage.setItem("miroxai_rail_collapsed", document.body.classList.contains("rail-collapsed") ? "1" : "0"); } catch {}
  updateRailToggleIcon();
});

// ---------- SIDEBAR ----------
const sidebar = $("#sidebar"), sidebarScrim = $("#sidebarScrim");
const openSidebar = () => { sidebar?.classList.add("open"); sidebarScrim?.classList.add("open"); };
const closeSidebar = () => { sidebar?.classList.remove("open"); sidebarScrim?.classList.remove("open"); };
$("#hamburgerBtn")?.addEventListener("click", openSidebar);
$("#sidebarCloseBtn")?.addEventListener("click", closeSidebar);
sidebarScrim?.addEventListener("click", closeSidebar);
$("#brandLogo")?.addEventListener("click", () => { startNewChat(); if (window.innerWidth <= 860) closeSidebar(); });

// ---------- APPEARANCE ----------
const root = document.documentElement;
function applyAppearance({ mode, theme, corner, font }) {
  if (mode) root.setAttribute("data-mode", mode);
  if (theme) root.setAttribute("data-theme", theme);
  if (corner) root.setAttribute("data-corner", corner);
  if (font) root.setAttribute("data-font", font);
  $$("#modeOptions .option-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === (
