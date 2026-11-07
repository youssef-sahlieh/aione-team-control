// The app's sidebar and top bar on the pages beside the dashboard (Users, Databases, Knowledge base, Audit & Deploy).
// The markup is in each page; this fills the navigation, marks the current page and shows the account.
import { api, getSession } from "../session.js";
import { buildNav, arrangeNav, applyNavConfig, wireSidebar } from "./nav.js";

const $ = id => document.getElementById(id);
let config = null;

// The proxy's /config, asked for once per page view and shared with the page's own script.
export function appConfig() {
  if (!config) config = api("/config");
  return config;
}

// current: the nav link's data-link ("databases", "knowledge") or "users"; nothing is marked for other pages.
export function startFrame({ current } = {}) {
  const nav = $("main-nav"), session = getSession();
  buildNav(nav);
  arrangeNav(nav, { admin: session?.role !== "user" });
  wireSidebar();
  const link = current === "users" ? $("users-link") : nav.querySelector(`[data-link="${current}"]`);
  link?.setAttribute("aria-current", "page");
  if (session) $("account-avatar").textContent = session.email.slice(0, 2).toUpperCase();
  appConfig().then(cfg => {
    const admin = cfg.role !== "user";
    arrangeNav(nav, { admin });
    applyNavConfig(cfg);
    // The page you are on stays in the sidebar even if its setting would hide it.
    if (link) link.hidden = false;
    $("account-avatar").textContent = (cfg.name || cfg.email || "").slice(0, 2).toUpperCase();
    $("account-role").textContent = admin ? "Administrator" : "Developer";
  }, () => { /* the page shows its own error */ });
}
