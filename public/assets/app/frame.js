// The app's sidebar and top bar on the pages beside the dashboard (Users, Databases, Knowledge base, Audit & Deploy).
// The markup is in each page; this fills the navigation, marks the current page and shows the account, and adds
// the same AIONE AI button and notification bell as the dashboard (see header-tools.js).
import { api, getSession } from "../session.js";
import { buildNav, arrangeNav, applyNavConfig, wireSidebar, setNavCount } from "./nav.js";
import { mountHeaderTools } from "./header-tools.js";
import { createAIAssistant } from "../ai-assistant.js";
import { createInboxBell } from "../components/inbox-bell.js";
import { fetchDateRequests, pendingDateCount } from "../components/date-requests.js";

const $ = id => document.getElementById(id);
let config = null;

// The proxy's /config, asked for once per page view and shared with the page's own script.
export function appConfig() {
  if (!config) config = api("/config");
  return config;
}

// Tickets open on the dashboard (from a notification or an AI answer).
const openTicket = key => { location.href = "dashboard.html#" + encodeURIComponent(key); };
// The tickets the dashboard loaded last (its saved copy, see saveCache in dashboard.js), so the bell counts the same new tickets here.
function savedTickets() {
  try {
    const c = JSON.parse(localStorage.getItem("aion.cache.v1." + (getSession()?.email || "")) || "null");
    if (c) return { issues: [...new Map([...(c.main || []), ...(c.closed || []), ...(c.internal || []), ...(c.odoo || [])].map(i => [i.key, i])).values()], INT: c.INT || {} };
  } catch { /* no storage */ }
  return { issues: [], INT: {} };
}
// A short message for a new notification, in the page's toast when it has one.
function toast(text) {
  const t = $("toast"); if (!t) return;
  t.className = "toast"; t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 5000);
}

// The sidebar counts this page can work out again: date requests and (administrators) the review queue. The ticket
// count needs every ticket and your filters, so the dashboard's last one stays. A failed read keeps the last count.
function refreshCounts(cfg, admin) {
  fetchDateRequests(api).then(all => setNavCount("requests", pendingDateCount(all, { admin, email: cfg.email || "" })), () => {});
  if (admin) api("/reviews/queue").then(q => setNavCount("reviews", q.configured ? q.counts.tickets : 0), () => {});
  else setNavCount("reviews", 0);
}

// current: the nav link's data-link ("databases", "knowledge") or "users"; nothing is marked for other pages.
export function startFrame({ current } = {}) {
  const nav = $("main-nav"), session = getSession();
  buildNav(nav);
  arrangeNav(nav, { admin: session?.role !== "user" });
  wireSidebar();
  const tools = mountHeaderTools();
  const ai = tools ? createAIAssistant({ openIssue: openTicket, beforeOpen: () => true }) : null;
  let cfg = null, saved = savedTickets();
  const bell = tools ? createInboxBell({ api, button: $("inbox-btn"), count: $("inbox-count"), panel: $("inbox-panel"), issues: () => saved.issues, toast, open: openTicket,
    // As on the dashboard: yours (all of them for administrators), not ones you opened yourself.
    mine: i => !!cfg && (cfg.role !== "user" || (i.devs || []).includes(cfg.dev)) && String(saved.INT[i.key]?.createdBy?.email || "").toLowerCase() !== String(cfg.email || "").toLowerCase() }) : null;
  const link = current === "users" ? $("users-link") : nav.querySelector(`[data-link="${current}"]`);
  link?.setAttribute("aria-current", "page");
  if (session) $("account-avatar").textContent = session.email.slice(0, 2).toUpperCase();
  appConfig().then(c => {
    cfg = c;
    const admin = cfg.role !== "user";
    arrangeNav(nav, { admin });
    applyNavConfig(cfg);
    // The page you are on stays in the sidebar even if its setting would hide it.
    if (link) link.hidden = false;
    $("account-avatar").textContent = (cfg.name || cfg.email || "").slice(0, 2).toUpperCase();
    $("account-role").textContent = admin ? "Administrator" : "Developer";
    ai?.configure(cfg);
    bell?.start();
    refreshCounts(cfg, admin);
  }, () => { /* the page shows its own error */ });
  // The dashboard may have loaded newer tickets in another tab.
  window.addEventListener("storage", e => { if (e.key && e.key.startsWith("aion.cache.v1.")) { saved = savedTickets(); bell?.update(); } });
}
