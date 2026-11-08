// The sidebar's links, shared by the dashboard and the pages beside it (Users, Databases, Knowledge base, Audit &
// Deploy), so every page shows the same navigation in the same order.
const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const icons = {
  overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  tickets: "M4 4h16v16H4z M8 9h8 M8 14h5",
  internal: "M4 3h12l4 4v14H4z M16 3v5h4 M8 12h8 M8 16h5",
  workload: "M4 20V10 M10 20V4 M16 20v-7 M22 20H2",
  calendar: "M4 5h16v16H4z M8 2v6 M16 2v6 M4 10h16 M8 14h2 M14 14h2",
  reports: "M4 3h16v18H4z M8 8h8 M8 12h8 M8 16h5",
  analytics: "M3 20h18 M6 16v-5 M11 16V6 M16 16v-8 M21 16v-3",
  clients: "M3 6h18v15H3z M7 6V3h10v3 M7 11h10",
  requests: "M3 5v6h6 M3 11a9 9 0 1 1 2 7 M12 7v5l3 2",
  audit: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4",
  databases: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  knowledge: "M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4z M20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z",
  worklog: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M12 7v5l3 3",
  errors: "M12 3l9 16H3z M12 10v4 M12 17h.01",
  reviews: "M4 4h12l4 4v12H4z M8 12l2 2 4-4"
};
export const pages = [
  ["overview", "Overview", "Your work, at a glance."],
  ["tickets", "All tickets", "A clear view of your team's work, from first task to final delivery."],
  ["workload", "Workload", "Understand assignments, deadlines, and where support is needed."],
  ["calendar", "Calendar", "Make space for what's next. Plan around your ticket due dates."],
  ["requests", "Date requests", "Review and decide proposed date changes."],
  ["reports", "Checks & Reports", "Run ticket checks and review management reports."],
  ["analytics", "Analytics", "How much work comes in, gets done and takes time, over the period you choose."],
  ["clients", "Clients", "Manage clients (Odoo contacts) and their projects."],
  ["worklog", "Work log", "Time logged on tickets and sent to Odoo timesheets."],
  ["reviews", "Needs review", "Pull requests waiting for your review. The linked tickets are read-only here."],
  ["errors", "Sync errors","Changes that didn't reach Jira, Odoo or the dashboard, ready to retry, and the state of the API keys."]
];
// Pages only administrators see; the breadcrumb names the section they belong to.
export const adminPages = new Set(["workload", "reports", "analytics", "clients"]);
// AI1 Monitor is a full page on its own site, opened in a new tab so the dashboard stays open. Its sign-in starts
// there, passes through this dashboard (in that new tab, which shares the dashboard sign-in) and ends on the Monitor.
const MONITOR_START_URL = "https://monitor.ai1.host/auth/aione/start";
// Work pages first, then the administrator pages under their own label (hidden for users).
const navOrder = ["overview", "tickets", "requests", "reviews", "calendar", "worklog", "errors", "monitor", "knowledge", "workload", "reports", "analytics", "clients", "databases"];

export function icon(name) {
  const box = node("span", "nav-icon");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
  const p = document.createElementNS(svg.namespaceURI, "path"); p.setAttribute("d", icons[name]); svg.appendChild(p); box.appendChild(svg); return box;
}

// Fills the sidebar's nav. onPage(id, event) runs when a dashboard page link is clicked (the dashboard switches page
// in place); without it the links are plain links to the dashboard.
export function buildNav(nav, { onPage } = {}) {
  for (const [id, label] of pages) {
    const a = node("a", "nav-link"); a.href = `dashboard.html?page=${id}`; a.dataset.page = id; a.title = label;
    a.append(icon(id), node("span", "", label));
    if (id === "tickets") { const count = node("span", "nav-count", "—"); count.id = "nav-ticket-count"; count.hidden = !onPage; a.appendChild(count); }
    if (id === "requests") { const count = node("span", "nav-count", "0"); count.id = "nav-date-count"; count.hidden = !onPage; a.append(count); }
    if (id === "errors") { const count = node("span", "nav-count nav-alert", "0"); count.id = "nav-error-count"; count.hidden = true; a.appendChild(count); }
    if (onPage) a.addEventListener("click", e => { if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; e.preventDefault(); onPage(id); });
    nav.appendChild(a);
  }
  // Databases report is its own admin-only page; shown when Odoo is connected.
  const dbReport = node("a", "nav-link"); dbReport.id = "dbreport-link"; dbReport.href = "databases.html"; dbReport.dataset.link = "databases"; dbReport.title = "Databases"; dbReport.hidden = true;
  dbReport.append(icon("databases"), node("span", "", "Databases"));
  // AI1 Monitor opens in a new tab on the Monitor's own site (its sign-in starts from the link). Every dashboard role may use it.
  const monitor = node("a", "nav-link"); monitor.id = "ai1-monitor-link"; monitor.href = MONITOR_START_URL; monitor.target = "_blank"; monitor.rel = "noopener"; monitor.title = "AI1 Monitor (opens in a new tab)"; monitor.hidden = true;
  monitor.append(icon("audit"), node("span", "", "AI1 Monitor"), node("span", "nav-ext", "↗"));
  // The Odoo knowledge base is its own page; shown when Odoo is connected.
  const knowledge = node("a", "nav-link"); knowledge.id = "knowledge-link"; knowledge.href = "knowledge.html"; knowledge.dataset.link = "knowledge"; knowledge.title = "Odoo knowledge base"; knowledge.hidden = true;
  knowledge.append(icon("knowledge"), node("span", "", "Knowledge base"));
  nav.append(dbReport, monitor, knowledge);
  const label = node("p", "nav-label nav-group", "ADMIN"); label.id = "nav-admin-label";
  nav.appendChild(label);
}

// Puts the links in order and shows what this role may open.
export function arrangeNav(nav, { admin }) {
  const item = id => nav.querySelector(id === "databases" ? "#dbreport-link" : id === "monitor" ? "#ai1-monitor-link" : id === "knowledge" ? "#knowledge-link" : `[data-page="${id}"]`);
  const label = nav.querySelector("#nav-admin-label");
  label.hidden = !admin;
  for (const id of navOrder) { if (id === "workload") nav.appendChild(label); nav.appendChild(item(id)); }
  for (const id of adminPages) item(id).hidden = !admin;
  item("monitor").hidden = false;
}

// Shows the links that depend on the server's settings: Databases, Knowledge base and Users & access.
export function applyNavConfig(cfg) {
  const admin = cfg.role !== "user";
  const show = (id, on) => { const n = document.getElementById(id); if (n) n.hidden = !on; };
  show("dbreport-link", !!cfg.dbReport);
  show("knowledge-link", !!cfg.knowledge);
  show("users-link", admin && !!cfg.accounts);
}

// The sidebar on phones (a menu that slides in) and on computers (collapsed to icons, remembered between pages).
export function wireSidebar() {
  const $ = id => document.getElementById(id);
  let menuOpen = false;
  const mobile = () => matchMedia("(max-width:820px)").matches;
  function setMenu(open) {
    menuOpen = open;
    document.body.classList.toggle("nav-open", open);
    $("mobile-menu").setAttribute("aria-expanded", String(open));
    $("mobile-menu").setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    $("nav-scrim").hidden = !open;
    if (open) $("main-nav").querySelector("a:not([hidden])")?.focus();
    else if (mobile()) $("mobile-menu").focus();
    $("app-sidebar").inert = mobile() && !open;
  }
  function collapse(collapsed) {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    $("sidebar-collapse").setAttribute("aria-expanded", String(!collapsed));
    $("sidebar-collapse").setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    try { if (collapsed) localStorage.setItem("aione.sidebar.collapsed", "1"); else localStorage.removeItem("aione.sidebar.collapsed"); } catch { /* no storage */ }
  }
  try { if (localStorage.getItem("aione.sidebar.collapsed") === "1") collapse(true); } catch { /* no storage */ }
  $("mobile-menu").addEventListener("click", () => setMenu(!menuOpen));
  $("nav-scrim").addEventListener("click", () => setMenu(false));
  $("sidebar-collapse").addEventListener("click", () => collapse(!document.body.classList.contains("sidebar-collapsed")));
  matchMedia("(max-width:820px)").addEventListener("change", () => setMenu(false));
  $("app-sidebar").inert = mobile();
  document.addEventListener("keydown", e => {
    if (!menuOpen) return;
    if (e.key === "Escape") { e.preventDefault(); setMenu(false); }
    if (e.key === "Tab") {
      const focusable = [...$("app-sidebar").querySelectorAll("a,button,summary")].filter(n => n.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  return { close: () => { if (menuOpen) setMenu(false); } };
}
