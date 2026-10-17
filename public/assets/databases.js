// Databases report (administrators only). Reads the cached report from the proxy; the proxy builds it
// from Audit & Deploy (production instances) plus one read-only login per database for the inside numbers.
// No credential ever reaches this page - only the numbers do.
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

// The 11 report columns. value() returns display text; csv() the plain value; cls() an optional cell class.
const num = (n) => (n === null || n === undefined ? "—" : String(n));
const COLUMNS = [
  { key: "url", label: "URL", value: (r) => r.url ? linkCell(r.url) : el("span", "db-muted", "—"), csv: (r) => r.url || "" },
  { key: "database", label: "Database", value: (r) => el("span", "db-strong", r.database || r.instance || "—"), csv: (r) => r.database || r.instance || "" },
  { key: "users", label: "Users", value: (r) => numCell(r, "users"), csv: (r) => num(r.users) },
  { key: "pos", label: "POS", value: (r) => numCell(r, "pos"), csv: (r) => num(r.pos) },
  { key: "created", label: "Created", value: (r) => el("span", "", fmtDate(r.created)), csv: (r) => fmtDate(r.created) },
  { key: "branches", label: "Branches", value: (r) => branchCell(r), csv: (r) => r.loginOk ? (r.branches ? "yes (" + r.branches + ")" : "no") : "" },
  { key: "lastLogin", label: "Last login", value: (r) => timeCell(r, "lastLogin"), csv: (r) => fmtDateTime(r.lastLogin) },
  { key: "lastOrder", label: "Last order", value: (r) => timeCell(r, "lastOrder"), csv: (r) => fmtDateTime(r.lastOrder) },
  { key: "expired", label: "Expiry", value: (r) => expiryCell(r), csv: (r) => !r.loginOk ? "" : r.expired === null ? "none" : r.expired ? "EXPIRED " + fmtDate(r.expires) : "ok " + fmtDate(r.expires) },
  { key: "flutter", label: "Flutter POS", value: (r) => r.flutter ? el("span", "db-pill ok", "Installed") : el("span", "db-pill", "No"), csv: (r) => r.flutter ? "yes" : "no" },
  { key: "addons", label: "Add-ons", value: (r) => addonCell(r), csv: (r) => (r.addons || []).join("; ") }
];

function linkCell(url) { const a = el("a", "db-link", url.replace(/^https?:\/\//, "")); a.href = url; a.target = "_blank"; a.rel = "noopener"; return a; }
function numCell(r, key) { if (!r.loginOk) return key === "users" ? el("span", "db-muted", "no access") : el("span", "db-muted", "—"); return el("span", "", num(r[key])); }
function branchCell(r) { if (!r.loginFound) return el("span", "db-muted", "—"); if (!r.loginOk) return el("span", "db-muted", "—"); if (!r.branches) return el("span", "db-muted", "none"); return el("span", "db-strong", String(r.branches)); }
function timeCell(r, key) { if (!r.loginFound) return el("span", "db-muted", "—"); if (!r.loginOk) return el("span", "db-muted", "—"); if (!r[key]) return el("span", "db-muted", "never"); const s = el("span", "", fmtDateTime(r[key])); const a = ago(r[key]); if (a) s.append(el("small", "db-ago", " · " + a)); return s; }
function expiryCell(r) { if (!r.loginFound || !r.loginOk) return el("span", "db-muted", "—"); if (r.expired === null) return el("span", "db-muted", "none"); return el("span", "db-pill " + (r.expired ? "bad" : "ok"), (r.expired ? "Expired " : "Valid ") + fmtDate(r.expires)); }
function addonCell(r) {
  const list = r.addons || [];
  const box = el("span", "db-addons");
  if (!list.length) { box.append(el("span", "db-muted", r.configError ? "unavailable" : "—")); return box; }
  box.append(el("span", "db-count", list.length + " · "));
  box.append(el("span", "db-addon-names", list.slice(0, 4).join(", ") + (list.length > 4 ? " +" + (list.length - 4) : "")));
  box.title = list.join("\n");
  return box;
}

let REPORT = null, pollTimer = null;

// One compact stat (label + value) inside a card.
function stat(label, valueNode) { const s = el("div", "db-stat"); s.append(el("span", "db-stat-label", label), valueNode instanceof Node ? valueNode : el("span", "db-stat-val", valueNode == null ? "—" : String(valueNode))); return s; }
function statText(label, text, cls) { return stat(label, el("span", "db-stat-val" + (cls ? " " + cls : ""), text)); }

function card(r) {
  const c = el("div", "db-card" + (r.loginOk ? "" : " db-card-off"));
  // Header: name + badges
  const head = el("div", "db-card-head");
  head.append(el("span", "db-card-name", r.database || r.instance || "—"));
  const badges = el("span", "db-card-badges");
  if (r.flutter) badges.append(el("span", "db-pill ok", "Flutter POS"));
  if (r.loginOk && r.expired !== null) badges.append(el("span", "db-pill " + (r.expired ? "bad" : "ok"), r.expired ? "Expired" : "Active"));
  head.append(badges);
  c.append(head);
  // URL
  if (r.url) { const a = el("a", "db-card-url", r.url.replace(/^https?:\/\//, "")); a.href = r.url; a.target = "_blank"; a.rel = "noopener"; c.append(a); }
  if (!r.loginOk) { c.append(el("div", "db-card-noaccess", "no access")); addedStats(c, r, true); return c; }
  addedStats(c, r, false);
  return c;
}

function addedStats(c, r, off) {
  const grid = el("div", "db-card-stats");
  grid.append(
    statText("Users", off ? "—" : num(r.users)),
    statText("POS", off ? "—" : num(r.pos)),
    statText("Branches", off ? "—" : (r.branches ? String(r.branches) : "none")),
    statText("Created", fmtDate(r.created)),
    statText("Last login", off ? "—" : fmtDateTime(r.lastLogin), "db-stat-wide"),
    statText("Last order", off ? "—" : fmtDateTime(r.lastOrder), "db-stat-wide"),
    statText("Expiry", off || r.expired === null ? "—" : fmtDate(r.expires))
  );
  c.append(grid);
  // Add-ons: count + names, wraps naturally
  const list = r.addons || [];
  const ad = el("div", "db-card-addons");
  ad.append(el("span", "db-stat-label", "Add-ons"));
  if (list.length) { ad.append(el("span", "db-addon-count", String(list.length))); ad.append(el("span", "db-addon-names", list.join(", "))); }
  else ad.append(el("span", "db-muted", "—"));
  c.append(ad);
}

function render() {
  if (!REPORT) return;
  const q = $("search").value.trim().toLowerCase();
  const rows = (REPORT.rows || []).filter((r) => !q || [r.url, r.database, r.instance, (r.addons || []).join(" ")].join(" ").toLowerCase().includes(q));
  rows.sort((a, b) => (a.loginOk === b.loginOk ? 0 : a.loginOk ? -1 : 1) || (a.database || a.instance || "").localeCompare(b.database || b.instance || ""));
  const box = $("cards"); box.replaceChildren();
  for (const r of rows) box.append(card(r));
  const working = (REPORT.rows || []).filter((r) => r.loginOk).length;
  $("meta").textContent = rows.length + " of " + (REPORT.rows || []).length + " databases · " + working + " with data · built " + fmtDateTime(new Date(REPORT.builtAt).toISOString());
}

async function load() {
  try {
    const data = await api("/db-report");
    if (data.report) { REPORT = data.report; $("toolbar").hidden = false; $("cards").hidden = false; showState(""); render(); }
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
    if (r.report) { REPORT = r.report; $("toolbar").hidden = false; $("cards").hidden = false; showState(""); render(); }
    if (r.busy) { scheduleContinue(); return; }
    if (!r.done) { if (r.progress) $("meta").textContent = "Building… " + r.progress.done + " of " + r.progress.total + " databases"; scheduleContinue(); }
    else { toast("Report refreshed."); load(); }
  } catch (err) { showState(errText(err), true); }
}

function downloadCsv() {
  if (!REPORT) return;
  const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  const lines = [COLUMNS.map((c) => esc(c.label)).join(",")];
  for (const r of REPORT.rows || []) lines.push(COLUMNS.map((c) => esc(c.csv(r))).join(","));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = "aion-databases-" + fmtDate(new Date().toISOString()) + ".csv";
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function start() {
  const s = getSession(); if (!s) { signOut(true); return; }
  $("me").textContent = s.email;
  $("signout").addEventListener("click", () => signOut());
  $("search").addEventListener("input", render);
  $("csv").addEventListener("click", downloadCsv);
  $("refresh").addEventListener("click", () => { showState("Refreshing…", false); continueBuild(true); });
  load();
}
start();
