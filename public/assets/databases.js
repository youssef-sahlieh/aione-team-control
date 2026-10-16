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
function noAccessCell(r) {
  const s = el("span", "db-muted", "no access"); const d = r.diag;
  s.title = d ? ("host " + d.host + "\ndatabases tried: " + d.dbs + "\nlogins tried: " + (d.tried || 0) + " (" + d.users + " user×" + d.pws + " password)" + "\ndb list available: " + (d.dbListed ? "yes" : "no") + (r.error ? "\nserver said: " + r.error : "")) : (r.error || "");
  return s;
}
function numCell(r, key) { if (!r.loginFound) return el("span", "db-muted", "login not found"); if (!r.loginOk) return noAccessCell(r); return el("span", "", num(r[key])); }
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

function render() {
  if (!REPORT) return;
  const q = $("search").value.trim().toLowerCase();
  const rows = (REPORT.rows || []).filter((r) => !q || [r.url, r.database, r.instance, (r.addons || []).join(" ")].join(" ").toLowerCase().includes(q));
  const head = $("head"); head.replaceChildren(); for (const c of COLUMNS) head.append(el("th", "db-col-" + c.key, c.label));
  const body = $("rows"); body.replaceChildren();
  for (const r of rows.sort((a, b) => (a.database || a.instance || "").localeCompare(b.database || b.instance || ""))) {
    const tr = el("tr"); if (!r.loginFound) tr.className = "db-no-login";
    for (const c of COLUMNS) { const td = el("td", "db-col-" + c.key); td.append(c.value(r)); tr.append(td); }
    body.append(tr);
  }
  $("meta").textContent = rows.length + " of " + (REPORT.rows || []).length + " production databases · built " + fmtDateTime(new Date(REPORT.builtAt).toISOString());
}

async function load() {
  try {
    const data = await api("/db-report");
    if (data.report) { REPORT = data.report; $("toolbar").hidden = false; $("tablewrap").hidden = false; showState(""); render(); }
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
    if (r.report) { REPORT = r.report; $("toolbar").hidden = false; $("tablewrap").hidden = false; showState(""); render(); }
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
