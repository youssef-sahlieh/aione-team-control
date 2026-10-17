// Audit & Deploy page: Odoo's Audit & Deployment System (log_monitor) through the AION proxy.
// Users and administrators see and do the same things. Every change goes through the proxy, which runs
// it in Odoo and records it in the dashboard's action log with the signed-in person's name.
import { api, getSession, signOut } from "./session.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const errText = (err) => err.code === "network" ? "Can't reach the AION server. Try again." : err.message;
const when = (v) => { if (!v) return ""; const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(v) ? v : String(v).replace(" ", "T") + "Z"); return isNaN(d) ? String(v) : d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); };
const ago = (v) => { const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(v || "") ? v : String(v || "").replace(" ", "T") + "Z"); if (isNaN(d)) return ""; const m = (Date.now() - d) / 60000; return m < 60 ? Math.max(1, Math.round(m)) + "m ago" : m < 1440 ? Math.round(m / 60) + "h ago" : Math.round(m / 1440) + "d ago"; };
const siteUrl = (domain) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain || "") ? "https://" + domain : null;

let toastTimer = null;
function toast(text, isErr) { const t = $("toast"); t.replaceChildren(el("span", "t", text)); t.className = "toast" + (isErr ? " err" : ""); t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), isErr ? 9000 : 3500); }
function showState(text, isErr) { const s = $("pagestate"); s.hidden = !text; s.className = "state" + (isErr ? " err" : ""); s.textContent = text || ""; }
const badge = (text, kind) => el("span", "flag " + (kind || "k8"), text);
const healthKind = (h) => (h === "healthy" ? "k7" : h ? "k2" : "k8");
const statusKind = (s) => (/running|ready|success|approved|done/.test(s || "") ? "k7" : /error|fail|denied|reject/.test(s || "") ? "k2" : /pending|creat|destroy|queue|progress/.test(s || "") ? "k3" : "k8");

// Runs an action through the proxy, then refreshes. The proxy records it with the person's name.
async function action(label, path, body, after) {
  try {
    await api(path, { method: "POST", body: body || {} });
    toast(label + " — done. Recorded in the action log.");
  } catch (err) { toast(label + " failed: " + errText(err), true); }
  if (after) await after();
  loadLog(true);
}

// ---------- Tabs ----------
let current = "overview";
function showTab(tab) {
  current = tab;
  document.querySelectorAll("#tabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== tab));
  history.replaceState(null, "", "#" + tab);
  ({ overview: loadOverview, instances: loadInstances, testenvs: loadTestEnvs, approvals: loadApprovals, audit: () => loadAudit(true), log: () => loadLog(true) })[tab]?.();
}
document.querySelectorAll("#tabs [data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------- Data ----------
let instances = [], envs = [], maxActive = 10;
async function getInstances(refresh) {
  const r = await api("/monitor/instances" + (refresh ? "?refresh=1" : ""));
  instances = (r.payload && (r.payload.services || r.payload.instances)) || [];
  if (r.error && !instances.length) throw new Error(r.error);
  return r;
}
async function getEnvs() { const r = await api("/monitor/test-envs"); envs = r.envs || []; maxActive = r.maxActive || 10; }

// ---------- Overview ----------
function card(n, label, hint, kind) { const c = el("div", "tile " + (kind || "k1")); c.appendChild(el("span", "n", String(n))); c.appendChild(el("span", "l", label)); if (hint) c.appendChild(el("span", "h", hint)); return c; }
async function loadOverview() {
  const box = $("ov-cards"); box.replaceChildren(el("span", "msg", "Loading…"));
  try {
    const [, , ap] = await Promise.all([getInstances(false), getEnvs(), api("/monitor/approvals")]);
    const healthy = instances.filter((i) => i.health === "healthy").length;
    const zones = {}; instances.forEach((i) => (zones[i.server_zone || "other"] = (zones[i.server_zone || "other"] || 0) + 1));
    const running = envs.filter((e) => e.status === "running").length, broken = envs.filter((e) => e.status === "error").length;
    const pending = (ap.access?.pending?.length || 0) + (ap.unlock?.pending?.length || 0);
    box.replaceChildren(
      card(instances.length, "Instances", Object.entries(zones).map(([z, n]) => z + " " + n).join(" · "), "k1"),
      card(healthy, "Healthy", (instances.length - healthy) + " without a health check", "k7"),
      card(running, "Test environments running", "limit " + maxActive + " active", "k5"),
      card(broken, "Test environments in error", "", broken ? "k2" : "k8"),
      card(pending, "Requests waiting", "database access and add-on unlocks", pending ? "k3" : "k8"),
      card((ap.expiry || []).length, "Expiring soon", "test environments", "k4")
    );
  } catch (err) { box.replaceChildren(el("span", "msg err", errText(err))); }
  try { const r = await api("/monitor/odoo-audit"); renderAudit($("ov-audit"), (r.actions || []).slice(0, 10)); } catch (err) { $("ov-audit").replaceChildren(el("span", "msg err", errText(err))); }
  try { const r = await api("/monitor/log"); renderLog($("ov-log"), (r.entries || []).slice(0, 10)); } catch (err) { $("ov-log").replaceChildren(el("span", "msg err", errText(err))); }
}

// ---------- Instances ----------
async function loadInstances(refresh) {
  const tb = $("in-table").querySelector("tbody");
  if (!instances.length || refresh === true) { tb.replaceChildren(row1(7, "Loading instances…")); try { await getInstances(refresh === true); } catch (err) { tb.replaceChildren(row1(7, errText(err))); return; } }
  const zones = [...new Set(instances.map((i) => i.server_zone).filter(Boolean))].sort(), sel = $("in-zone"), keep = sel.value;
  sel.replaceChildren(new Option("All zones", "")); zones.forEach((z) => sel.appendChild(new Option(z, z))); sel.value = keep;
  renderInstances();
}
// Each cell gets its column name, shown as a label when rows become cards on phones.
const labelCells = (table) => { const names = [...table.querySelectorAll("thead th")].map((th) => th.textContent); table.querySelectorAll("tbody tr").forEach((tr) => [...tr.cells].forEach((td, i) => { if (td.colSpan === 1 && names[i]) td.dataset.label = names[i]; })); };
const row1 = (cols, text) => { const tr = el("tr"); const td = el("td", "msg", text); td.colSpan = cols; tr.appendChild(td); return tr; };
function renderInstances() {
  const q = $("in-q").value.trim().toLowerCase(), z = $("in-zone").value, h = $("in-health").value;
  const list = instances.filter((i) => (!z || i.server_zone === z) && (!h || (h === "__unknown" ? !i.health : i.health === h)) && (!q || [i.instance_name, i.domain, i.db_host].some((v) => String(v || "").toLowerCase().includes(q))))
    .sort((a, b) => String(a.instance_name).localeCompare(String(b.instance_name), undefined, { numeric: true }));
  $("in-count").textContent = list.length + " of " + instances.length;
  const tb = $("in-table").querySelector("tbody"); tb.replaceChildren();
  if (!list.length) { tb.appendChild(row1(7, "No instances match.")); return; }
  for (const i of list) {
    const tr = el("tr");
    const nameTd = el("td"); const b = el("button", "linkbtn", i.instance_name); b.type = "button"; b.addEventListener("click", () => openInstance(i)); nameTd.appendChild(b); tr.appendChild(nameTd);
    const dTd = el("td"); const url = siteUrl(i.domain); if (url) { const a = el("a", "key", i.domain); a.href = url; a.target = "_blank"; a.rel = "noopener"; dTd.appendChild(a); } else dTd.textContent = i.domain || ""; tr.appendChild(dTd);
    const hTd = el("td"); hTd.appendChild(badge(i.health || "unknown", healthKind(i.health))); tr.appendChild(hTd);
    const sTd = el("td"); sTd.appendChild(badge(i.status || "", statusKind(i.status))); tr.appendChild(sTd);
    tr.appendChild(el("td", null, i.server_zone || "")); tr.appendChild(el("td", "mono", i.db_host || "")); tr.appendChild(el("td", "upd", when(i.created)));
    tb.appendChild(tr);
  }
  labelCells($("in-table"));
}
["in-q", "in-zone", "in-health"].forEach((id) => $(id).addEventListener("input", renderInstances));
$("in-refresh").addEventListener("click", () => loadInstances(true));

// Instance details: the add-on's own read views, shown as tables and lists.
let drInstance = null;
function openInstance(i) {
  drInstance = i; $("dr-title").textContent = i.instance_name;
  const url = siteUrl(i.domain); $("dr-open").hidden = !url; if (url) $("dr-open").href = url;
  $("drawer").hidden = false; $("scrim").hidden = false; loadPart("config");
}
function closeDrawer() { $("drawer").hidden = true; $("scrim").hidden = true; drInstance = null; }
$("dr-close").addEventListener("click", closeDrawer); $("scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("drawer").hidden) closeDrawer(); });
document.querySelectorAll("#dr-tabs [data-part]").forEach((b) => b.addEventListener("click", () => loadPart(b.dataset.part)));
async function loadPart(part) {
  document.querySelectorAll("#dr-tabs [data-part]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.part === part)));
  const body = $("dr-body"), name = drInstance.instance_name; body.replaceChildren(el("span", "msg", "Loading…"));
  try {
    const r = await api("/monitor/instances/" + encodeURIComponent(name) + "/" + part);
    if (!drInstance || drInstance.instance_name !== name) return;
    const data = r.payload || r;
    const problem = (r.error && !r.payload) ? r.error : (data && data.success === false && data.error) ? data.error : "";
    if (problem) { body.replaceChildren(el("div", "msg err", "The Audit & Deploy servers couldn't load this: " + cleanError(problem))); return; }
    body.replaceChildren(renderValue(data, 0));
  } catch (err) { body.replaceChildren(el("span", "msg err", errText(err))); }
}
// "HTTP 404: {\"error\":\"Config not found\"}" -> "Config not found"
function cleanError(text) {
  let t = String(text || "");
  for (let i = 0; i < 3; i++) { const m = /\{[\s\S]*\}/.exec(t); if (!m) break; try { const j = JSON.parse(m[0]); if (j && typeof j.error === "string") { t = j.error; continue; } } catch {} break; }
  return t.replace(/^HTTP \d+:\s*/, "").slice(0, 400);
}
// Shows any JSON shape: objects as label/value lists, lists of objects as tables, the rest as text.
function renderValue(v, depth) {
  if (v == null || v === "") return el("span", "msg", "—");
  if (Array.isArray(v)) {
    if (!v.length) return el("span", "msg", "None");
    if (v.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      const cols = [...new Set(v.slice(0, 50).flatMap((x) => Object.keys(x)))].filter((k) => v.some((x) => x[k] != null && typeof x[k] !== "object")).slice(0, 8);
      const wrap = el("div", "mon-table-wrap"), t = el("table", "mon-table"), hr = el("tr"); cols.forEach((c) => hr.appendChild(el("th", null, c.replace(/_/g, " "))));
      const head = el("thead"); head.appendChild(hr); t.appendChild(head); const tb = el("tbody");
      v.slice(0, 300).forEach((x) => { const tr = el("tr"); cols.forEach((c) => tr.appendChild(el("td", null, x[c] == null ? "" : typeof x[c] === "boolean" ? (x[c] ? "yes" : "no") : String(x[c])))); tb.appendChild(tr); });
      t.appendChild(tb); labelCells(t); wrap.appendChild(t); if (v.length > 300) wrap.appendChild(el("div", "msg", "Showing 300 of " + v.length)); return wrap;
    }
    return el("div", "mono mon-text", v.map((x) => typeof x === "object" ? JSON.stringify(x) : String(x)).join("\n"));
  }
  if (typeof v === "object") {
    const dl = el("dl", "facts mon-facts");
    for (const [k, val] of Object.entries(v)) {
      if (["success"].includes(k)) continue;
      const w = el("div" + "", val && typeof val === "object" && depth < 2 ? "mon-wide" : null); w.appendChild(el("dt", null, k.replace(/_/g, " ")));
      const dd = el("dd"); dd.appendChild(val && typeof val === "object" ? (depth < 2 ? renderValue(val, depth + 1) : el("span", "mono", JSON.stringify(val).slice(0, 300))) : el("span", null, typeof val === "boolean" ? (val ? "yes" : "no") : String(val))); w.appendChild(dd); dl.appendChild(w);
    }
    return dl;
  }
  return el("span", null, String(v));
}

// ---------- Test environments ----------
async function loadTestEnvs() {
  const tb = $("te-table").querySelector("tbody"); tb.replaceChildren(row1(7, "Loading…"));
  try { await getEnvs(); } catch (err) { tb.replaceChildren(row1(7, errText(err))); return; }
  const byStatus = {}; envs.forEach((e) => (byStatus[e.status || "unknown"] = (byStatus[e.status || "unknown"] || 0) + 1));
  $("te-count").textContent = envs.length + " environments · " + Object.entries(byStatus).map(([s, n]) => n + " " + s).join(" · ");
  tb.replaceChildren(); if (!envs.length) tb.appendChild(row1(7, "No test environments."));
  for (const e of envs.slice().sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")))) {
    const tr = el("tr");
    const n = el("td"); n.appendChild(el("b", null, e.instance_name || e.name)); if (e.name && e.name !== e.instance_name) n.appendChild(el("div", "upd", e.name)); tr.appendChild(n);
    const d = el("td"); const url = siteUrl(e.domain); if (url) { const a = el("a", "key", e.domain); a.href = url; a.target = "_blank"; a.rel = "noopener"; d.appendChild(a); } tr.appendChild(d);
    tr.appendChild(el("td", null, e.source_instance || e.root_source_instance || ""));
    const s = el("td"); s.appendChild(badge(e.status || "", statusKind(e.status)));
    if (e.operation_phase && e.operation_phase !== "completed") s.appendChild(el("div", "upd", e.operation_phase + (e.operation_progress != null ? " " + e.operation_progress + "%" : "")));
    if (e.error_message) s.appendChild(el("div", "msg err", e.error_message)); tr.appendChild(s);
    tr.appendChild(el("td", "upd", e.is_persistent ? "persistent" : e.expires_at ? when(e.expires_at) : ""));
    tr.appendChild(el("td", "nowrap", e.template || ""));
    const acts = el("td", "mon-acts"), label = e.instance_name || e.name;
    const btn = (text, fn, cls) => { const b = el("button", "btn " + (cls || ""), text); b.type = "button"; b.addEventListener("click", async () => { b.disabled = true; await fn(); b.disabled = false; }); acts.appendChild(b); };
    btn("Refresh", () => action("Refresh " + label, "/monitor/test-envs/" + e.id + "/refresh", {}, loadTestEnvs));
    if (!["destroyed", "destroying", "expired"].includes(e.status)) {
      if (!e.is_persistent) btn("+24h", () => action("Extend " + label, "/monitor/test-envs/" + e.id + "/extend", {}, loadTestEnvs));
      if (!e.is_persistent) btn("Keep", () => action("Make " + label + " persistent", "/monitor/test-envs/" + e.id + "/persistent", {}, loadTestEnvs));
      else btn("Set expiry", async () => { const h = prompt("Expire " + label + " in how many hours?", "24"); if (h && Number(h) > 0) await action("Set expiry for " + label, "/monitor/test-envs/" + e.id + "/temporary", { hours: Number(h) }, loadTestEnvs); });
      btn("Destroy", async () => { if (confirm("Destroy " + label + "? Its data is deleted. This can't be undone.")) await action("Destroy " + label, "/monitor/test-envs/" + e.id + "/destroy", {}, loadTestEnvs); }, "danger");
    }
    tr.appendChild(acts); tb.appendChild(tr);
  }
  labelCells($("te-table"));
}
$("te-reload").addEventListener("click", loadTestEnvs);

// New test environment: options → reserve (capacity check) → create.
let reservation = null;
const setTeMsg = (t, ok) => { const m = $("te-msg"); m.textContent = t || ""; m.className = "msg" + (t ? (ok ? " ok" : " err") : ""); };
async function releaseReservation() { if (reservation?.token) { try { await api("/monitor/test-envs/release", { method: "POST", body: { token: reservation.token } }); } catch {} } reservation = null; $("te-create").disabled = true; $("te-estimate").hidden = true; }
async function loadOptions() {
  await releaseReservation();
  const source = $("te-source").value, zone = $("te-zone").value;
  $("te-db").replaceChildren(); $("te-target").replaceChildren(); if (!source) return;
  setTeMsg("Loading databases and storage…", true);
  try {
    const r = await api("/monitor/test-envs/options?source=" + encodeURIComponent(source) + "&zone=" + zone);
    r.databases.forEach((d) => $("te-db").appendChild(new Option(d, d)));
    if (!r.databases.length) $("te-db").appendChild(new Option("No databases found", ""));
    r.targets.forEach((t) => $("te-target").appendChild(new Option(t.label + " · " + t.freeGiB + " GiB free", t.id)));
    if (!r.targets.length) $("te-target").appendChild(new Option("No storage available in this zone", ""));
    setTeMsg("");
  } catch (err) { setTeMsg(errText(err)); }
}
$("te-new").addEventListener("click", async () => {
  $("te-form").hidden = false; setTeMsg("");
  if (!instances.length) { try { await getInstances(false); } catch {} }
  const s = $("te-source"); s.replaceChildren(new Option("Choose an instance…", ""));
  instances.map((i) => i.instance_name).filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach((n) => s.appendChild(new Option(n, n)));
});
$("te-cancel").addEventListener("click", async () => { await releaseReservation(); $("te-form").hidden = true; });
["te-source", "te-zone"].forEach((id) => $(id).addEventListener("change", loadOptions));
["te-db", "te-target"].forEach((id) => $(id).addEventListener("change", releaseReservation));
$("te-reserve").addEventListener("click", async () => {
  const body = { source: $("te-source").value, zone: $("te-zone").value, db: $("te-db").value || null, target: $("te-target").value };
  if (!body.source || !body.target) { setTeMsg("Choose the instance and a storage target first."); return; }
  await releaseReservation(); $("te-reserve").disabled = true; setTeMsg("Checking capacity…", true);
  try {
    reservation = await api("/monitor/test-envs/reserve", { method: "POST", body });
    const est = reservation.estimate || {}, box = $("te-estimate"); box.hidden = false;
    box.replaceChildren(renderValue(est, 1));
    const ok = reservation.token && est.ready !== false && est.confirmation_allowed !== false && reservation.executionEnabled;
    $("te-create").disabled = !ok;
    setTeMsg(ok ? "Capacity reserved. You can create it now." : !reservation.executionEnabled ? "Test clones are switched off in the Audit & Deploy settings." : "There isn't enough capacity for this copy. Try another storage target.", ok);
  } catch (err) { setTeMsg(errText(err)); }
  $("te-reserve").disabled = false;
});
$("te-create").addEventListener("click", async () => {
  if (!reservation?.token) return;
  const ttl = Number($("te-ttl").value);
  const body = { source: $("te-source").value, zone: $("te-zone").value, db: $("te-db").value || null, target: $("te-target").value, token: reservation.token,
    template: $("te-template").value, name: $("te-name").value.trim() || null, persistent: ttl === 0, ttl: ttl || 72 };
  $("te-create").disabled = true; setTeMsg("Creating…", true);
  try {
    await api("/monitor/test-envs", { method: "POST", body });
    reservation = null; $("te-form").hidden = true; $("te-estimate").hidden = true; toast("Test environment creation started. Recorded in the action log.");
    await loadTestEnvs();
  } catch (err) { setTeMsg(errText(err)); $("te-create").disabled = false; }
  loadLog(true);
});

// ---------- Approvals & pipelines ----------
function requestRow(item, kind) {
  const r = el("div", "mon-item");
  const title = [item.instance_name || item.instance, item.database || item.addon_name || item.addon, item.access_mode || item.mode].filter(Boolean).join(" · ") || "Request #" + item.id;
  r.appendChild(el("b", null, title));
  r.appendChild(el("div", "upd", [item.requester_name || item.user_name || item.requested_by, item.reason, item.state || item.status, ago(item.create_date || item.requested_at)].filter(Boolean).join(" · ")));
  if (kind && /pending|requested|waiting/i.test(item.state || item.status || "pending")) {
    const acts = el("div", "mon-acts");
    for (const decision of ["approve", "deny"]) {
      const b = el("button", "btn " + (decision === "deny" ? "danger" : "primary"), decision === "approve" ? "Approve" : "Deny"); b.type = "button";
      b.addEventListener("click", async () => { const note = prompt((decision === "approve" ? "Approve" : "Deny") + " — note (optional):", "") ?? null; if (note === null) return; await action((decision === "approve" ? "Approve " : "Deny ") + title, "/monitor/approvals/" + kind + "/" + item.id, { decision, note }, loadApprovals); });
      acts.appendChild(b);
    }
    r.appendChild(acts);
  }
  return r;
}
function fillList(box, items, render, empty) { box.replaceChildren(); if (!items || !items.length) { box.appendChild(el("div", "msg", empty)); return; } items.forEach((i) => box.appendChild(render(i))); }
async function loadApprovals() {
  try {
    const [ap, pr] = await Promise.all([api("/monitor/approvals"), api("/monitor/pipeline-runs")]);
    fillList($("ap-access"), [...(ap.access?.pending || []), ...(ap.access?.mine || [])], (i) => requestRow(i, "access"), "No database access requests.");
    fillList($("ap-unlock"), [...(ap.unlock?.pending || []), ...(ap.unlock?.mine || [])], (i) => requestRow(i, "unlock"), "No add-on unlock requests.");
    fillList($("ap-expiry"), ap.expiry || [], (i) => requestRow(i, null), "Nothing expiring soon.");
    fillList($("ap-runs"), pr.runs || [], (run) => {
      const r = el("div", "mon-item");
      r.appendChild(el("b", null, (run.pr_number ? "PR #" + run.pr_number + " · " : "") + (run.branch || run.name || "Run " + run.id)));
      r.appendChild(el("div", "upd", [run.state || run.status, run.stage, run.repository, ago(run.create_date)].filter(Boolean).join(" · ")));
      if (/pending|waiting|awaiting/i.test(String(run.staging_state || run.state || run.status || ""))) {
        const acts = el("div", "mon-acts");
        for (const [verb, label] of [["approve", "Approve staging"], ["reject", "Reject staging"]]) { const b = el("button", "btn " + (verb === "reject" ? "danger" : "primary"), label); b.type = "button"; b.addEventListener("click", () => action(label + " for " + (run.pr_number ? "PR #" + run.pr_number : run.branch || run.id), "/monitor/pipeline-runs/" + run.id + "/" + verb, {}, loadApprovals)); acts.appendChild(b); }
        r.appendChild(acts);
      }
      return r;
    }, "No pipeline runs.");
  } catch (err) { $("ap-access").replaceChildren(el("span", "msg err", errText(err))); }
}

// ---------- Logs ----------
function renderAudit(box, actions, append) {
  if (!append) box.replaceChildren();
  if (!actions.length && !append) { box.appendChild(el("div", "msg", "No actions recorded.")); return; }
  for (const a of actions) {
    let details = ""; try { const d = JSON.parse(a.details || "{}"); details = d.via ? "via " + d.via + " by " + d.by + (d.action ? " — " + d.action : "") : Object.entries(d).map(([k, v]) => k + ": " + v).join(", "); } catch { details = a.details || ""; }
    const r = el("div", "mon-item"); const top = el("div", "mon-line");
    top.appendChild(badge(a.result || "", statusKind(a.result))); top.appendChild(el("b", null, String(a.action_type || "").replace(/_/g, " "))); top.appendChild(el("span", null, a.target_name || ""));
    top.appendChild(el("span", "upd sp", (a.user_name || "") + " · " + when(a.create_date))); r.appendChild(top);
    if (details) r.appendChild(el("div", "upd", details)); if (a.error_message) r.appendChild(el("div", "msg err", a.error_message));
    box.appendChild(r);
  }
}
let auditCursor = null;
async function loadAudit(reset) {
  if (reset) auditCursor = null;
  try { const r = await api("/monitor/odoo-audit" + (auditCursor ? "?before=" + auditCursor : "")); const list = r.actions || []; renderAudit($("au-list"), list, !reset); auditCursor = list.length ? list[list.length - 1].id : auditCursor; $("au-more").hidden = !r.has_more; }
  catch (err) { $("au-list").replaceChildren(el("span", "msg err", errText(err))); }
}
$("au-more").addEventListener("click", () => loadAudit(false));
function renderLog(box, entries, append) {
  if (!append) box.replaceChildren();
  if (!entries.length && !append) { box.appendChild(el("div", "msg", "No changes made from the dashboard yet.")); return; }
  for (const e of entries) {
    const r = el("div", "mon-item"), top = el("div", "mon-line");
    top.appendChild(badge(e.result, statusKind(e.result))); top.appendChild(el("b", null, e.action)); top.appendChild(el("span", null, e.target || ""));
    top.appendChild(el("span", "upd sp", e.name + " <" + e.email + "> · " + when(e.when))); r.appendChild(top);
    if (e.details) r.appendChild(el("div", "upd", e.details)); if (e.error) r.appendChild(el("div", "msg err", e.error));
    box.appendChild(r);
  }
}
let logCursor = null;
async function loadLog(reset) {
  if (reset) logCursor = null;
  try { const r = await api("/monitor/log" + (logCursor ? "?before=" + logCursor : "")); const list = r.entries || []; renderLog($("lg-list"), list, !reset); if (current === "overview") renderLog($("ov-log"), list.slice(0, 10)); logCursor = list.length ? list[list.length - 1].id : logCursor; $("lg-more").hidden = !r.hasMore; }
  catch (err) { $("lg-list").replaceChildren(el("span", "msg err", errText(err))); }
}
$("lg-more").addEventListener("click", () => loadLog(false));

// ---------- Start ----------
$("signout").addEventListener("click", () => signOut());
async function start() {
  const s = getSession(); if (!s) return signOut(true);
  $("me").textContent = s.email;
  try {
    const cfg = await api("/config");
    if (!cfg.odoo) { showState("Odoo isn't connected, so Audit & Deploy isn't available. See SETUP.md.", true); return; }
    showState(""); $("tabs").hidden = false;
    const tab = location.hash.slice(1);
    showTab(["overview", "instances", "testenvs", "approvals", "audit", "log"].includes(tab) ? tab : "overview");
  } catch (err) { showState(errText(err), true); }
}
start();
