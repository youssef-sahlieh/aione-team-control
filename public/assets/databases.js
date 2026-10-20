// Databases report (administrators only). Reads the cached report from the proxy; the proxy builds it
// from Audit & Deploy (production instances) plus one read-only login per database for the inside numbers.
// No credential ever reaches this page - only the numbers do.
//
// The table sorts by any column (click its header), filters by search and by access, Odoo version, expiry,
// Flutter POS and order activity, and shows the columns you pick. Choices are kept in this browser.
import { api, getSession, signOut } from "./session.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const errText = (err) => err && err.code === "network" ? "Can't reach the AION server. Try again." : (err && err.message) || "Something went wrong.";

function showState(text, isErr) { const s = $("pagestate"); s.hidden = !text; s.className = "state" + (isErr ? " err" : ""); s.textContent = text || ""; }
let toastTimer = null;
function toast(text, isErr) { const t = $("toast"); t.replaceChildren(el("span", "t", text)); t.className = "toast" + (isErr ? " err" : ""); t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 4000); }

const pad = (n) => String(n).padStart(2, "0");
function parseDate(v) { if (!v) return null; const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(String(v)) ? v : String(v).replace(" ", "T") + "Z"); return isNaN(d) ? null : d; }
function fmtDateTime(v) { const d = parseDate(v); if (!d) return v ? String(v) : "—"; return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function fmtDate(v) { const d = parseDate(v); if (!d) return v ? String(v) : "—"; return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function ago(v) { const d = parseDate(v); if (!d) return ""; const days = Math.floor((Date.now() - d.getTime()) / 86400000); return days <= 0 ? "today" : days === 1 ? "1 day ago" : days + " days ago"; }
const time = (v) => { const d = parseDate(v); return d ? d.getTime() : null; };
const daysSince = (v) => { const t = time(v); return t == null ? null : (Date.now() - t) / 86400000; };

// The report columns. value() draws the cell; sort() the value it sorts by (null sorts last); csv() the plain value.
const num = (n) => (n === null || n === undefined ? "—" : String(n));
const inside = (r, v) => (r.loginOk ? v : null);
const COLUMNS = [
  { key: "company", label: "Company", value: (r) => companyCell(r), sort: (r) => companyOf(r).toLowerCase() || null, csv: (r) => companyOf(r) },
  { key: "database", label: "Database", value: (r) => databaseCell(r), sort: (r) => (r.database || r.instance || "").toLowerCase(), csv: (r) => r.database || r.instance || "" },
  { key: "url", label: "URL", value: (r) => r.url ? linkCell(r.url) : el("span", "db-muted", "—"), sort: (r) => r.url || null, csv: (r) => r.url || "" },
  { key: "adlink", label: "Audit & Deploy", value: (r) => adLinkCell(r), sort: (r) => (r.instance || null), csv: (r) => (r.instance ? adLinkUrl(r) : "") },
  { key: "version", label: "Odoo", value: (r) => r.odooVersion ? el("span", "db-ver", r.odooVersion) : el("span", "db-muted", "—"), sort: (r) => Number(r.odooVersion) || null, csv: (r) => r.odooVersion || "" },
  { key: "users", label: "Users", num: true, value: (r) => numCell(r, "users"), sort: (r) => inside(r, r.users), csv: (r) => num(r.users) },
  { key: "pos", label: "POS", num: true, value: (r) => numCell(r, "pos"), sort: (r) => inside(r, r.pos), csv: (r) => num(r.pos) },
  { key: "branches", label: "Branches", num: true, value: (r) => branchCell(r), sort: (r) => inside(r, r.branches), csv: (r) => r.loginOk ? (r.branches ? "yes (" + r.branches + ")" : "no") : "" },
  { key: "created", label: "Created", value: (r) => el("span", "", fmtDate(r.created)), sort: (r) => time(r.created), csv: (r) => fmtDate(r.created) },
  { key: "lastLogin", label: "Last login", value: (r) => timeCell(r, "lastLogin"), sort: (r) => inside(r, time(r.lastLogin)), csv: (r) => fmtDateTime(r.lastLogin) },
  { key: "lastOrder", label: "Last order", value: (r) => timeCell(r, "lastOrder"), sort: (r) => inside(r, time(r.lastOrder)), csv: (r) => fmtDateTime(r.lastOrder) },
  { key: "expired", label: "Expiry", value: (r) => expiryCell(r), sort: (r) => inside(r, time(r.expires)), csv: (r) => !r.loginOk ? "" : r.expired === null ? "none" : r.expired ? "EXPIRED " + fmtDate(r.expires) : "ok " + fmtDate(r.expires) },
  { key: "flutter", label: "Flutter POS", value: (r) => r.flutter ? el("span", "db-pill ok", "Installed") : el("span", "db-pill", "No"), sort: (r) => (r.flutter ? 1 : 0), csv: (r) => r.flutter ? "yes" : "no" },
  { key: "posver", label: "POS version", value: (r) => posVersionCell(r), sort: (r) => (r.posVersion ? r.posVersion.split(".").map((n) => n.padStart(6, "0")).join(".") : null), csv: (r) => posVersionText(r) },
  { key: "addons", label: "Add-ons", value: (r) => addonCell(r), sort: (r) => (r.addons || []).length, csv: (r) => (r.addons || []).join("; ") },
  { key: "control", label: "Actions", action: true, value: (r) => actionCell(r), sort: () => null, csv: () => "" }
];
// Audit & Deploy link for each instance: the instance's page in Audit & Deploy.
const AD_PAGE = "audit-deploy.html";
const adLinkUrl = (r) => new URL(AD_PAGE + "#instances/" + encodeURIComponent(r.instance), location.href).href;
function adLinkCell(r) {
  if (!r.instance) return el("span", "db-muted", "—");
  const a = el("a", "db-link", "Open"); a.href = adLinkUrl(r); a.target = "_blank"; a.rel = "noopener";
  return a;
}
const WEIGHT = { company: 2.2, database: 1.6, url: 1.5, adlink: 1.1, version: 0.6, users: 0.75, pos: 0.6, branches: 0.85, created: 1, lastLogin: 1.3, lastOrder: 1.3, expired: 1.2, flutter: 0.95, posver: 1.1, addons: 2, control: 0.9 };
// Every column shows by default; phones swipe the table sideways to see them all.


// Only a company name read from inside the database is shown (reports built earlier may carry Knowledge names).
const companyOf = (r) => (r.companySource === "database" ? r.company || "" : "");
function companyCell(r) {
  if (!companyOf(r)) return el("span", "db-muted", "—");
  const box = el("span", "db-company");
  box.append(el("span", "db-strong", companyOf(r)));
  const more = (r.companyNames || []).slice(1);
  if (more.length) { const s = el("small", "db-src", "+" + more.length + " compan" + (more.length === 1 ? "y" : "ies")); s.title = more.join("\n"); box.append(s); }
  return box;
}
function databaseCell(r) {
  const box = el("span", "db-company");
  box.append(el("span", "db-strong", r.database || r.instance || "—"));
  if ((r.duplicates || []).length) { const n = r.duplicates.length, s = el("small", "db-src", "+" + n + " more instance" + (n === 1 ? "" : "s")); s.title = "Same web address in Audit & Deploy: " + r.duplicates.map((d) => d.instance + (d.database ? " (" + d.database + ")" : "")).join(", "); s.tabIndex = 0; box.append(s); }
  return box;
}
function linkCell(url) { const a = el("a", "db-link", url.replace(/^https?:\/\//, "")); a.href = url; a.target = "_blank"; a.rel = "noopener"; return a; }
function numCell(r, key) { if (!r.loginOk) return key === "users" ? el("span", "db-muted", "no access") : el("span", "db-muted", "—"); return el("span", "", num(r[key])); }
function branchCell(r) { if (!r.loginFound) return el("span", "db-muted", "—"); if (!r.loginOk) return el("span", "db-muted", "—"); if (!r.branches) return el("span", "db-muted", "none"); return el("span", "db-strong", String(r.branches)); }
function timeCell(r, key) { if (!r.loginFound) return el("span", "db-muted", "—"); if (!r.loginOk) return el("span", "db-muted", "—"); if (!r[key]) return el("span", "db-muted", "never"); const s = el("span", "", fmtDateTime(r[key])); const a = ago(r[key]); if (a) s.append(el("small", "db-ago", " · " + a)); return s; }
function expiryCell(r) { if (!r.loginFound || !r.loginOk) return el("span", "db-muted", "—"); if (r.expired === null) return el("span", "db-muted", "none"); return el("span", "db-pill " + (r.expired ? "bad" : "ok"), (r.expired ? "Expired " : "Valid ") + fmtDate(r.expires)); }
// The installed POS add-on's version, with its date when Audit & Deploy gives one.
const posVersionText = (r) => (r.posVersion ? r.posVersion + (r.posVersionDate ? " (" + fmtDate(r.posVersionDate) + ")" : "") : "");
function posVersionCell(r) {
  if (!r.posVersion) return el("span", "db-muted", "—");
  const box = el("span", "", r.posVersion);
  if (r.posVersionDate) box.append(el("small", "db-ago", " · " + fmtDate(r.posVersionDate)));
  return box;
}
function addonCell(r) {
  const list = r.addons || [];
  const box = el("span", "db-addons");
  if (!list.length) { box.append(el("span", "db-muted", r.configError ? "unavailable" : "—")); return box; }
  box.append(el("span", "db-count", list.length + " · "));
  const names = el("span", "db-addon-names", list.slice(0, 4).join(", "));
  box.append(names);
  box.title = list.join("\n");
  // The rest open in the cell with a tap (a hover tooltip doesn't work on phones).
  if (list.length > 4) {
    const more = el("button", "db-more", "+" + (list.length - 4) + " more");
    more.type = "button"; more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", () => {
      const open = more.getAttribute("aria-expanded") !== "true";
      names.textContent = open ? list.join(", ") : list.slice(0, 4).join(", ");
      more.textContent = open ? "Show less" : "+" + (list.length - 4) + " more";
      more.setAttribute("aria-expanded", String(open));
    });
    box.append(" ", more);
  }
  return box;
}

// Instance actions. Each opens a preview with all three; the chosen one needs its own confirm button.
// Only restart reaches Odoo for now; start and stop are shown but not available yet.
const ACTIONS = [
  { key: "restart", title: "Restart Instance", desc: "Restart the container", tone: "warn", icon: "↻", note: "The site is unavailable for a short time while the container restarts.", enabled: true },
  { key: "start", title: "Start Instance", desc: "Scale to 1 replica", tone: "ok", icon: "▶", note: "", enabled: false },
  { key: "stop", title: "Stop Instance", desc: "Scale to 0 replicas", tone: "bad", icon: "■", note: "", enabled: false }
];
function actionCell(r) {
  if (!r.instance) return el("span", "db-muted", "—");
  const b = el("button", "btn db-act-open", "Actions"); b.type = "button"; b.setAttribute("aria-haspopup", "dialog");
  b.addEventListener("click", () => openActions(r, b));
  return b;
}
function openActions(r, opener) {
  const dlg = $("action-dialog");
  let picked = null;
  const title = el("h2", "", "Instance actions"); title.id = "action-title";
  const who = el("p", "db-act-who", (companyOf(r) || r.database || r.instance) + " · " + r.instance + (r.url ? " · " + r.url.replace(/^https?:\/\//, "") : ""));
  const cards = el("div", "db-act-cards");
  const note = el("p", "db-act-note", "Choose an action to see what it does.");
  const cancel = el("button", "btn", "Cancel"); cancel.type = "button";
  const confirm = el("button", "btn primary", "Confirm"); confirm.type = "button"; confirm.disabled = true;
  for (const a of ACTIONS) {
    const card = el("button", "db-act-card db-act-" + a.tone); card.type = "button"; card.disabled = !a.enabled;
    card.setAttribute("aria-pressed", "false");
    card.append(el("span", "db-act-icon", a.icon), el("span", "db-act-title", a.title), el("span", "db-act-desc", a.enabled ? a.desc : a.desc + " · not available yet"));
    card.addEventListener("click", () => {
      picked = a;
      for (const c of cards.children) c.setAttribute("aria-pressed", String(c === card));
      note.textContent = a.note + " Press Confirm to continue.";
      confirm.disabled = false;
    });
    cards.append(card);
  }
  confirm.addEventListener("click", async () => {
    if (!picked) return;
    confirm.disabled = true; confirm.textContent = "Working…";
    try {
      await api("/db-report/action", { method: "POST", body: { instance: r.instance, action: picked.key } });
      confirm.textContent = "Confirm";
      dlg.close();
      toast(picked.title + " sent to " + r.instance + ". It can take a minute.");
    } catch (err) {
      if (err && err.code === "session") { signOut(true); return; }
      confirm.disabled = false; confirm.textContent = "Confirm";
      note.textContent = errText(err);
    }
  });
  cancel.addEventListener("click", () => dlg.close());
  const foot = el("div", "db-dlg-foot"); foot.append(cancel, confirm);
  const body = el("div", "db-dlg-body"); body.append(title, who, cards, note, foot);
  dlg.replaceChildren(body);
  dlg.onclose = () => opener && opener.focus();
  dlg.showModal();
  cancel.focus(); // Enter or Space does nothing until an action is chosen and confirmed
}

// Filters: [id, label, options [value, label, test(row)]]. The Odoo options are filled from the report.
const FILTERS = [
  ["access", "Access", [["", "All", null], ["ok", "With data", (r) => r.loginOk], ["none", "No access", (r) => !r.loginOk]]],
  ["version", "Odoo", [["", "All versions", null]]],
  ["expiry", "Expiry", [["", "Any", null], ["expired", "Expired", (r) => r.loginOk && r.expired === true], ["soon", "Expires in 30 days", (r) => r.loginOk && r.expired === false && time(r.expires) - Date.now() < 30 * 86400000], ["valid", "Valid", (r) => r.loginOk && r.expired === false], ["none", "No expiry", (r) => r.loginOk && r.expired === null]]],
  ["flutter", "Flutter POS", [["", "Any", null], ["yes", "Installed", (r) => r.flutter], ["no", "Not installed", (r) => !r.flutter]]],
  ["activity", "Last order", [["", "Any time", null], ["7", "Within 7 days", (r) => r.loginOk && daysSince(r.lastOrder) !== null && daysSince(r.lastOrder) <= 7], ["30", "Within 30 days", (r) => r.loginOk && daysSince(r.lastOrder) !== null && daysSince(r.lastOrder) <= 30], ["idle", "None in 30+ days", (r) => r.loginOk && (daysSince(r.lastOrder) === null || daysSince(r.lastOrder) > 30)]]]
];

// What this person last chose (sort, filters, columns), kept in this browser.
const PREFS_KEY = "aion.dbreport.view";
const view = { sort: { key: "company", dir: 1 }, filters: {}, columns: null };
try { Object.assign(view, JSON.parse(localStorage.getItem(PREFS_KEY) || "{}")); } catch {}
const saveView = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(view)); } catch {} };
const shownColumns = () => { const keys = view.columns || COLUMNS.map((c) => c.key); return COLUMNS.filter((c) => keys.includes(c.key)); };

let REPORT = null, pollTimer = null;
let filtersOpen = false;

function filterOptions(id) {
  const f = FILTERS.find((x) => x[0] === id);
  if (id !== "version") return f[2];
  const versions = [...new Set((REPORT?.rows || []).map((r) => r.odooVersion).filter(Boolean))].sort((a, b) => Number(b) - Number(a));
  return [f[2][0], ...versions.map((v) => [v, "Odoo " + v, (r) => r.odooVersion === v]), ["unknown", "Unknown", (r) => !r.odooVersion]];
}

function visibleRows() {
  const q = $("search").value.trim().toLowerCase();
  const tests = FILTERS.map(([id]) => (filterOptions(id).find((o) => o[0] === (view.filters[id] || "")) || [])[2]).filter(Boolean);
  const rows = (REPORT.rows || []).filter((r) => (!q || [companyOf(r), (r.companyNames || []).join(" "), r.url, r.database, r.instance, (r.addons || []).join(" ")].join(" ").toLowerCase().includes(q)) && tests.every((t) => t(r)));
  const col = COLUMNS.find((c) => c.key === view.sort.key) || COLUMNS[0];
  return rows.sort((a, b) => {
    const x = col.sort(a), y = col.sort(b);
    if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1; // empty values always last
    return (x < y ? -1 : x > y ? 1 : 0) * view.sort.dir || (a.database || "").localeCompare(b.database || "");
  });
}

function renderFilters() {
  const box = $("filters"); box.replaceChildren(); box.hidden = !filtersOpen;
  // Filters, Columns and Reset fold behind one toolbar button, hidden until pressed; it shows how many filters are on.
  const count = Object.keys(view.filters).length, toggle = el("button", "btn db-filter-toggle" + (count ? " on" : ""), (filtersOpen ? "Hide filters" : "Filters") + (count ? " · " + count : ""));
  toggle.type = "button"; toggle.setAttribute("aria-expanded", String(filtersOpen)); toggle.setAttribute("aria-controls", "filters");
  toggle.addEventListener("click", () => { filtersOpen = !filtersOpen; renderFilters(); });
  $("filter-toggle").replaceChildren(toggle);
  for (const [id, label] of FILTERS) {
    const field = el("label", "db-filter"), select = el("select", "fsel");
    field.append(el("span", "", label)); select.setAttribute("aria-label", label);
    for (const [value, text] of filterOptions(id)) select.append(new Option(text, value));
    select.value = view.filters[id] || ""; if (select.value !== (view.filters[id] || "")) { delete view.filters[id]; select.value = ""; }
    field.classList.toggle("on", !!select.value);
    select.addEventListener("change", () => { if (select.value) view.filters[id] = select.value; else delete view.filters[id]; saveView(); renderFilters(); render(); });
    field.append(select); box.append(field);
  }
  // Columns: a checklist; at least one column stays on.
  const cols = el("details", "db-columns"), sum = el("summary", "btn", "Columns"), list = el("div", "db-columns-list");
  cols.append(sum, list);
  const on = shownColumns().map((c) => c.key);
  for (const c of COLUMNS) {
    const row = el("label", "db-col-opt"), ck = el("input"); ck.type = "checkbox"; ck.checked = on.includes(c.key);
    ck.addEventListener("change", () => { const next = COLUMNS.map((x) => x.key).filter((k) => (k === c.key ? ck.checked : on.includes(k))); if (!next.length) { ck.checked = true; return; } view.columns = next; saveView(); render(); renderFilters(); $("filters").querySelector(".db-columns").open = true; });
    row.append(ck, " " + c.label); list.append(row);
  }
  const all = el("button", "btn", "Show all"); all.type = "button"; all.addEventListener("click", () => { view.columns = COLUMNS.map((c) => c.key); saveView(); render(); renderFilters(); });
  list.append(all);
  box.append(cols);
  const active = Object.keys(view.filters).length + ($("search").value.trim() ? 1 : 0);
  const reset = el("button", "btn", "Reset"); reset.type = "button"; reset.disabled = !active;
  reset.addEventListener("click", () => { view.filters = {}; $("search").value = ""; saveView(); renderFilters(); render(); });
  box.append(reset);
}

function render() {
  if (!REPORT) return;
  const rows = visibleRows(), cols = shownColumns();
  // The table fits the page width: each shown column gets its share (weight) of it.
  const total = cols.reduce((n, c) => n + (WEIGHT[c.key] || 1), 0), colgroup = $("cols"); colgroup.replaceChildren();
  for (const c of cols) { const col = el("col"); col.style.width = ((WEIGHT[c.key] || 1) / total * 100).toFixed(2) + "%"; colgroup.append(col); }
  const head = $("head"); head.replaceChildren();
  for (const c of cols) {
    const th = el("th", "db-col-" + c.key + (c.num ? " db-num" : "")), b = el("button", "db-sort", c.label);
    const active = view.sort.key === c.key;
    b.type = "button"; b.append(el("span", "db-arrow", active ? (view.sort.dir > 0 ? " ▲" : " ▼") : " ↕"));
    b.setAttribute("aria-label", "Sort by " + c.label);
    th.setAttribute("aria-sort", active ? (view.sort.dir > 0 ? "ascending" : "descending") : "none");
    b.addEventListener("click", () => { view.sort = { key: c.key, dir: active ? -view.sort.dir : 1 }; saveView(); render(); });
    th.append(b); head.append(th);
  }
  const body = $("rows"); body.replaceChildren();
  for (const r of rows) {
    const tr = el("tr"); if (!r.loginOk) tr.className = "db-off";
    for (const c of cols) { const td = el("td", "db-col-" + c.key + (c.num ? " db-num" : "")); td.append(c.value(r)); tr.append(td); }
    body.append(tr);
  }
  if (!rows.length) { const tr = el("tr"), td = el("td", "db-empty", "No databases match. Change the search or filters."); td.colSpan = cols.length; tr.append(td); body.append(tr); }
  const working = (REPORT.rows || []).filter((r) => r.loginOk).length;
  $("meta").textContent = rows.length + " of " + (REPORT.rows || []).length + " databases · " + working + " with data · built " + fmtDateTime(new Date(REPORT.builtAt).toISOString());
}

// One row per web address: Audit & Deploy can list two production instances on the same domain (an old and a
// new one, or a second service). The row kept is the one whose login works and has the newest activity; the
// other instances are named on it.
function oneRowPerSite(rows) {
  const score = (r) => [r.loginOk ? 1 : 0, String(r.lastOrder || r.lastLogin || ""), r.database ? 1 : 0, String(r.created || "")];
  const better = (a, b) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
  const bySite = new Map(), out = [];
  for (const r of rows) {
    const site = String(r.url || "").toLowerCase().replace(/\/+$/, "");
    if (!site) { out.push(r); continue; }
    const kept = bySite.get(site);
    if (!kept) { bySite.set(site, r); out.push(r); continue; }
    const [keep, drop] = better(r, kept) ? [r, kept] : [kept, r];
    const others = [...(kept.duplicates || []), ...(r.duplicates || []), { instance: drop.instance, database: drop.database || "" }];
    const merged = { ...keep, duplicates: others.filter((d, n, all) => all.findIndex((x) => x.instance === d.instance) === n && d.instance !== keep.instance) };
    bySite.set(site, merged); out[out.indexOf(kept)] = merged;
  }
  return out;
}

function showReport(report) { REPORT = { ...report, rows: oneRowPerSite(report.rows || []) }; $("toolbar").hidden = false; $("tablewrap").hidden = false; showState(""); renderFilters(); render(); explainCompanies(); }

// Says why company names are missing, instead of only showing empty cells.
let serverHasCompanies = null, serverHasPosVersion = null;
function explainCompanies() {
  const box = $("notice"), rows = (REPORT && REPORT.rows) || [];
  let text = "";
  if (serverHasCompanies === false) text = "Company names need the updated server: redeploy aione-team-proxy in Vercel (its /health page should list db-report-company-v1), then press Refresh now.";
  else if (serverHasPosVersion === false) text = "POS versions need the updated server: redeploy aione-team-proxy in Vercel (its /health page should list db-report-pos-version-v1), then press Refresh now.";
  else if (rows.length && !rows.some((r) => "companySource" in r)) text = "This report was built before company names were added. Press Refresh now to rebuild it with company names.";
  box.hidden = !text; box.textContent = text;
}

async function load() {
  try {
    api("/config").then((cfg) => { serverHasCompanies = (cfg.capabilities || []).includes("db-report-company-v1"); serverHasPosVersion = (cfg.capabilities || []).includes("db-report-pos-version-v1"); explainCompanies(); }).catch(() => {});
    const data = await api("/db-report");
    if (data.report) showReport(data.report);
    else showState(data.building ? "Building the report for the first time… this can take a minute." : "No report yet.", false);
    if (data.building) { showState("", false); scheduleContinue(); }
  } catch (err) {
    if (err && err.code === "session") { signOut(true); return; }
    if (err && err.code === "forbidden") { showState("This page is for administrators only.", true); return; }
    showState(errText(err), true);
  }
}

// Drive an in-progress build to completion, one slice per call, refreshing the table as it fills.
function scheduleContinue() { clearTimeout(pollTimer); pollTimer = setTimeout(() => continueBuild(false), 1500); }
async function continueBuild(force) {
  try {
    const r = await api("/db-report/refresh" + (force ? "" : "?continue=1"), { method: "POST" });
    if (r.report) showReport(r.report);
    if (r.busy) { scheduleContinue(); return; }
    if (!r.done) { if (r.progress) $("meta").textContent = "Building… " + r.progress.done + " of " + r.progress.total + " databases"; scheduleContinue(); }
    else { toast("Report refreshed."); load(); }
  } catch (err) { showState(errText(err), true); }
}

// The CSV has every column for the databases that match the search and filters, in the table's order.
function downloadCsv() {
  if (!REPORT) return;
  const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  const csvCols = COLUMNS.filter((c) => !c.action);
  const lines = [csvCols.map((c) => esc(c.label)).join(",")];
  for (const r of visibleRows()) lines.push(csvCols.map((c) => esc(c.csv(r))).join(","));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = "aion-databases-" + fmtDate(new Date().toISOString()) + ".csv";
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function start() {
  const s = getSession(); if (!s) { signOut(true); return; }
  $("me").textContent = s.email;
  $("signout").addEventListener("click", () => signOut());
  let typing = null;
  $("search").addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(() => { render(); renderFilters(); }, 120); });
  $("csv").addEventListener("click", downloadCsv);
  $("refresh").addEventListener("click", () => { showState("Refreshing…", false); continueBuild(true); });
  load();
}
start();
