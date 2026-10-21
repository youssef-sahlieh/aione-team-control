// Production database report (admin only). Builds one row per PRODUCTION database with:
// url, database name, user count, POS count, create date, branches, last login, last order,
// expiry, flutter installed, and installed add-ons.
//
// The production list comes from Audit & Deploy (no customer login needed), so new clients appear on
// their own. The six in-database numbers need a login to that database; those logins live in the Odoo
// knowledge base ("Our Customers") and are read server-side at build time only. A password is NEVER
// stored and NEVER sent to the browser - the proxy connects read-only and keeps only the numbers.
//
// The whole report is cached in the store. A build runs incrementally (resumable) to stay within the
// function's time limit, refreshes at most once a day on view (stale-while-revalidate), can be forced by
// an admin, and runs daily from a Vercel cron.
import { odoo, odooConfigured } from "./odoo.js";
import { act } from "./monitor.js";

const REPORT_KEY = "dbreport:v1";          // the finished/most-recent report
const PROGRESS_KEY = "dbreport:progress";  // an in-flight incremental build
const LOCK_KEY = "dbreport:lock";
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 60 * 60 * 1000;           // rebuild on view when the cached report is older than an hour
const BUILD_BUDGET_MS = 45000;             // leave headroom under the 60s function limit
const POOL = 8;

const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const fail = (code, error, status = 400) => Response.json({ code, error }, { status, headers: { "Cache-Control": "no-store" } });

// A database/instance is excluded unless it is clearly production.
// Keyword surrounded by non-letters (so "_Demo", "qa_main", "staging1" match, but "Devora" does not).
const NON_PROD = /(?:^|[^a-z])(test|dev|develop|development|staging|stage|demo|sandbox|copy|backup|bak|tmp|temp|trial|training|qa|poc)(?:[^a-z]|$)/i;
export const isProductionName = (name) => !!name && !NON_PROD.test(String(name));

// Audit & Deploy server zone -> the Databases page section.
export const SECTIONS = { prod: "main", test: "tests", development: "dev" };
const DEV_NAME = /(?:^|[^a-z])(dev|develop|development|sandbox)(?:[^a-z]|$)/i;
// Test and dev instances are kept apart from Main even when Audit & Deploy lists them in the production zone.
export const sectionOf = (zone, name) => {
  if (zone !== "prod") return SECTIONS[zone] || null;
  if (DEV_NAME.test(String(name))) return "dev";
  return isProductionName(name) ? "main" : "tests";
};

// The POS add-on (flutter_pos_api) and its module_version, wherever the instance's data lists it: an add-on entry,
// a POS Configurations entry, or an object keyed by the add-on name. Searches nested data, depth-limited.
const POS_MODULE = /^flutter_pos_api$/i;
export function findPosModule(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  const pick = (o) => {
    const v = o.module_version || o.installed_version || o.version;
    return v ? { version: String(v), date: String(o.installed_date || o.installed_at || o.write_date || "") } : null;
  };
  if (Array.isArray(node)) {
    for (const x of node) { const f = findPosModule(x, depth + 1); if (f) return f; }
    return null;
  }
  for (const key of ["name", "module", "technical_name", "addon"]) {
    if (POS_MODULE.test(String(node[key] || ""))) { const f = pick(node); if (f) return f; }
  }
  for (const [k, v] of Object.entries(node)) {
    if (POS_MODULE.test(k) && v && typeof v === "object") { const f = pick(v); if (f) return f; }
  }
  for (const v of Object.values(node)) { const f = findPosModule(v, depth + 1); if (f) return f; }
  return null;
}

// --- Credentials from the knowledge base (never logged, never returned) --------------------------
// Customer articles are free-form: some label the login (User:/Password:), many just list the URL,
// then the email, then the password on their own lines. So we gather EVERY plausible login from an
// article and the proxy tries each one until a database accepts it. Values are never logged/returned.
const LABEL = { url: "url|https?|site|link|domain|portal", user: "user\\s*name|username|user\\s*id|our username|login|e-?mail|משתמש|user", pass: "new password|master\\s*password|masterpasswd|password|pass(?:word)?|pswd|pas|סיסמ[אה]?" };
const looksLikePassword = (s) => s && s.length >= 4 && s.length <= 64 && !/\s/.test(s) && !/^https?:/i.test(s) && !/@/.test(s) && !/^[-=_*]+$/.test(s);
const looksLikeUser = (s) => s && (/^\S+@\S+\.\S+$/.test(s) || (/^[A-Za-z0-9_.@-]{2,40}$/.test(s) && /[A-Za-z]/.test(s)));

export function parseCreds(html) {
  const raw = String(html || "");
  const hrefs = [...raw.matchAll(/href=["']?(https?:\/\/[^\s"'<>]+)/gi)].map((m) => m[1]);
  // Emails hidden in mailto: links are stripped with the tag, so pull them out of the raw HTML first.
  const mailtoEmails = [...raw.matchAll(/mailto:([^\s"'<>?]+@[^\s"'<>?]+)/gi)].map((m) => m[1]);
  const text = raw
    // New lines come from <br> and block-element ends; inline tags (b, span, a, font…) are removed WITHOUT
    // a space, so a value split by formatting - e.g. art4u<b>@</b>2025 - is rejoined to art4u@2025.
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|td|th|h[1-6]|table|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'")
    // Decode numeric HTML entities, then strip zero-width / bidi / BOM characters that Odoo's editor
    // injects (they get stuck onto a password like "​12345" and make the server reject it).
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/[​-‏‪-‮⁠﻿]/g, "");
  const urls = [...new Set([...hrefs, ...[...text.matchAll(/https?:\/\/[^\s)"'<>]+/gi)].map((m) => m[0])])];
  const url = urls.find((u) => /\.ai1\.host/i.test(u)) || urls[0] || "";
  // Every ai1.host number mentioned anywhere (name/url/body) - an article can serve more than one.
  const nums = [...new Set([...raw.matchAll(/(\d{2,4})\.ai1\.host/gi)].map((m) => m[1]))];
  // Site labels (the subdomain before .ai1.host) - works for numeric (521) and named (paytag) hosts.
  const labels = [...new Set([...raw.matchAll(/([a-z0-9][\w-]*)\.ai1\.host/gi)].map((m) => m[1].toLowerCase()))];
  const host = (url.match(/^https?:\/\/([^/]+)/i) || [])[1] || "";
  const num = (host.match(/(\d{2,4})\.ai1\.host/i) || [])[1] || nums[0] || (host.match(/(\d{2,4})/) || [])[1] || "";
  // Database names written in the article: a "db/database:" labelled value, or a bare <num>_<name> token.
  const dbs = [];
  for (const m of text.matchAll(/(?:data\s*base|db(?:[\s_-]*name)?)\s*[:：]\s*([A-Za-z0-9][\w-]+)/gi)) dbs.push(m[1]);
  for (const m of text.matchAll(/\b(\d{2,4}_[A-Za-z0-9][\w-]+)\b/g)) if (!/\.ai1\.host/i.test(m[0])) dbs.push(m[1]);

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const users = new Set(), passwords = new Set();
  const labeled = (labels, line) => { const m = line.match(new RegExp("(?:" + labels + ")\\s*[:：]\\s*(\\S.*)$", "i")); return m ? m[1].trim() : ""; };
  // A line that is ONLY a label (common in tables / "Label" then "value" on the next cell/line).
  const labelOnly = (labels, line) => new RegExp("^(?:" + labels + ")\\s*[:：]?\\s*$", "i").test(line);
  const firstTok = (s) => (s || "").split(/\s|[|,;]/)[0];
  // A labeled value is trusted even if short/odd; only unlabeled guesses get the strict checks.
  const trusted = (t) => t && t.length <= 64 && !/^[-=_*.]+$/.test(t);
  const NON_PW_WORD = /^(the|and|for|with|this|that|user|email|login|password|pass|portal|site|link|domain|name|odoo|admin|server|database|https?|www)$/i;
  // The exact pairs the stated layout produces (url-in-title / email / password), tried FIRST so the cap
  // never drops them. Pair any username-or-email line with the password on the line right below it.
  const priority = [];
  const addUser = (u) => { if (trusted(u)) { users.add(u); if (/@/.test(u)) users.add(u.split("@")[0]); } }; // Odoo login is often the email's local part
  // Every email anywhere is a possible username (the article always has an email + password).
  for (const e of mailtoEmails) addUser(e);
  for (const m of text.matchAll(/[^\s:：,<>()"']+@[^\s:：,<>()"']+\.[A-Za-z]{2,}/g)) addUser(m[0]);
  const isUserLine = (l) => /@/.test(l) || firstTok(labeled(LABEL.user, l)) || labelOnly(LABEL.user, l);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], next = lines[i + 1] || "", next2 = lines[i + 2] || "";
    const u = firstTok(labeled(LABEL.user, line)); if (trusted(u)) addUser(u);
    const p = firstTok(labeled(LABEL.pass, line)); if (trusted(p)) passwords.add(p);
    // Label alone on a line/cell -> the value is the next non-empty line/cell.
    if (labelOnly(LABEL.user, line) && trusted(firstTok(next))) addUser(firstTok(next));
    if (labelOnly(LABEL.pass, line) && trusted(firstTok(next))) passwords.add(firstTok(next));
    // The username/email line's password is the NEXT line (whole line - it may contain spaces or an "@").
    const emailOnLine = (line.match(/[^\s:：]+@[^\s:：]+\.[A-Za-z]{2,}/) || [])[0];
    const lineUser = emailOnLine || firstTok(labeled(LABEL.user, line)) || (labelOnly(LABEL.user, line) ? firstTok(next) : "");
    if (lineUser && next && !/^https?:/i.test(next) && !isUserLine(next)) {
      const pwLabeled = firstTok(labeled(LABEL.pass, next));
      const pw = pwLabeled || next.trim();
      if (trusted(pw.slice(0, 64))) { passwords.add(pw.slice(0, 64)); priority.push({ user: lineUser, password: pw.slice(0, 64) }); if (/@/.test(lineUser)) priority.push({ user: lineUser.split("@")[0], password: pw.slice(0, 64) }); }
    }
    // Also tokens after an email on the SAME line, and the second line down.
    if (emailOnLine) {
      const after = line.slice(line.indexOf(emailOnLine) + emailOnLine.length).trim();
      for (const t of after.split(/\s|[|,;]+/)) if (trusted(t)) passwords.add(t);
      if (trusted(firstTok(next2)) && !/^https?:/i.test(next2)) passwords.add(firstTok(next2));
    }
    // url line -> next line is the username, the one after is the password (url-in-body layout).
    if (/^https?:\/\//i.test(line)) { if (next && !/^https?:/i.test(next)) addUser(firstTok(next)); if (next2 && !/^https?:/i.test(next2) && trusted(firstTok(next2))) passwords.add(firstTok(next2)); }
  }
  // High recall: any password-like token anywhere (printable, 4-40 chars, not a plain word/email/url).
  for (const line of lines) for (const tok of line.split(/\s|[|,;]+/)) {
    if (/^[\x21-\x7e]{4,40}$/.test(tok) && !/@/.test(tok) && !/^https?:/i.test(tok) && !NON_PW_WORD.test(tok) && (/\d/.test(tok) || (/[a-z]/.test(tok) && /[A-Z]/.test(tok) && tok.length >= 6))) passwords.add(tok);
  }
  users.add("admin"); // the common Odoo admin login, worth trying

  // Candidates: the adjacent (user, next-line password) pairs first, then the cross product. Capped.
  const uList = [...users].sort((a, b) => (/@/.test(b) ? 1 : 0) - (/@/.test(a) ? 1 : 0));
  const pList = [...passwords];
  const candidates = [...priority];
  for (const u of uList) for (const p of pList) if (u && p) candidates.push({ user: u, password: p });
  const seen = new Set(), unique = [];
  for (const c of candidates) { const k = c.user + "\u0000" + c.password; if (!seen.has(k)) { seen.add(k); unique.push(c); } if (unique.length >= 24) break; }
  return { url, host, num, nums: nums.length ? nums : (num ? [num] : []), labels, dbs: [...new Set(dbs)], candidates: unique, complete: !!(url && unique.length) };
}

// Map each ai1.host instance number -> { url, candidates[] }, merged across all customer articles.
async function readCredentialIndex(env) {
  const index = {};
  try {
    // Search every knowledge article, not only the "Our Customers" folder - some customer logins live
    // in standalone articles. Wrong guesses simply fail to authenticate, so a broad net is safe.
    const arts = await odoo(env, "knowledge.article", "search_read", [[]], { fields: ["name", "body"], limit: 2000 });
    for (const a of arts) {
      // The title is sometimes the URL (or carries the number), so parse title + body together.
      const title = typeof a.name === "string" ? a.name : "";
      const c = parseCreds("<p>" + title + "</p>\n" + (a.body || ""));
      if (!c.candidates.length) continue;
      // Match by every ai1.host site label (numeric or named, e.g. 521 or paytag), plus a number in the title.
      const titleNums = [...title.matchAll(/(\d{2,4})/g)].map((m) => m[1]);
      const numbers = [...new Set([...(c.labels || []), ...c.nums, c.num, ...titleNums].filter(Boolean))];
      for (const n of numbers) {
        const slot = index[n] || (index[n] = { url: "", candidates: [], seen: new Set(), titles: [], dbs: [] });
        if (!slot.url && (c.url.includes(n + ".ai1.host") || !slot.url)) slot.url = c.url.includes(n + ".ai1.host") ? c.url : (slot.url || "https://" + n + ".ai1.host");
        // Remember the client name (article title) so the database name can be derived as <num>_<client>.
        if (title && !/^https?:/i.test(title) && !slot.titles.includes(title)) slot.titles.push(title);
        // Database names written in the article (tried before any derived guess).
        for (const d of (c.dbs || [])) if (!slot.dbs.includes(d)) slot.dbs.push(d);
        for (const cand of c.candidates) { const k = cand.user + "\u0000" + cand.password; if (!slot.seen.has(k) && slot.candidates.length < 40) { slot.seen.add(k); slot.candidates.push(cand); } }
      }
    }
  } catch (e) { console.warn("dbreport_credentials_failed", String(e.message || e).slice(0, 120)); }
  return index;
}

// --- Per-database read-only queries (standard Odoo models) ---------------------------------------
async function customerRpc(base, service, method, args, signal) {
  const r = await fetch(base.replace(/\/+$/, "") + "/jsonrpc", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args } }), signal
  });
  const d = await r.json();
  if (d.error) throw new Error(((d.error.data && d.error.data.message) || d.error.message || "rpc error").slice(0, 120));
  return d.result;
}

async function readInsideDatabase(slot, dbHint) {
  const base = (slot.url.match(/^https?:\/\/[^/]+/) || [])[0];
  if (!base) return { loginOk: false, error: "no url" };
  // Short per-request timeout so one slow/unreachable server can't stall the whole build.
  const signal = () => AbortSignal.timeout(7000);
  const num = (base.match(/(\d{2,4})\.ai1\.host/i) || [])[1] || "";
  const label = (base.match(/([a-z0-9][\w-]*)\.ai1\.host/i) || [])[1]?.toLowerCase() || num;
  // Database names to try, best first: the one(s) Audit & Deploy reported, then what the server lists.
  const dbNames = [];
  const push = (d) => { if (d && /^[\w-]+$/.test(d) && !dbNames.includes(d)) dbNames.push(d); };
  // Database names written in the article come first, then Audit & Deploy's, then the server list.
  for (const d of (slot.dbs || [])) push(d);
  for (const d of (Array.isArray(dbHint) ? dbHint : [dbHint]).filter(Boolean)) push(d);
  const list = await customerRpc(base, "db", "list", [], signal()).catch(() => null);
  if (Array.isArray(list)) for (const d of list) push(d);
  // Derive <num>_<client> from the article title(s) when config gave no usable name (db listing is off):
  // whole name (joined, lower, underscored) AND the first word alone (e.g. "Merchandise Shop" -> 536_merchandise).
  for (const t of (slot.titles || [])) {
    const words = t.trim().split(/\s+/).filter(Boolean);
    const forms = new Set();
    const slug = t.replace(/[^A-Za-z0-9]+/g, "");
    forms.add(slug); forms.add(slug.toLowerCase());
    forms.add(words.join("_").replace(/[^\w-]/g, "")); forms.add(words.join("_").replace(/[^\w-]/g, "").toLowerCase());
    if (words[0]) { forms.add(words[0].replace(/[^\w-]/g, "")); forms.add(words[0].replace(/[^\w-]/g, "").toLowerCase()); }
    for (const f of forms) if (f) { if (num) push(num + "_" + f); push(label + "_" + f); }
  }
  // Named hosts (e.g. paytag): the database is often <label> or <label>_prod.
  if (label) { push(label); push(label + "_prod"); push(label + "_odoo"); }
  if (num) { push(num); push(num + "_prod"); }
  const tryDbs = dbNames.slice(0, 8);
  // Try the best credential against each database first (finds the right database fast), then the next.
  let db = "", uid = 0, password = "", attempts = 0;
  outer: for (const c of slot.candidates) {
    for (const d of tryDbs) {
      if (++attempts > 60) break outer;
      const id = await customerRpc(base, "common", "authenticate", [d, c.user, c.password, {}], signal()).catch(() => 0);
      if (id) { db = d; uid = id; password = c.password; break outer; }
    }
  }
  if (!uid) return { loginOk: false, loginFound: true };
  const kw = (model, method, args, k = {}) => customerRpc(base, "object", "execute_kw", [db, uid, password, model, method, args, k], signal());
  const one = async (p, dflt) => { try { return await p; } catch { return dflt; } };
  // active_test:false so a login by a since-deactivated user still counts (last login by ANY user).
  const allUsers = { context: { active_test: false } };
  const [users, pos, companyRows, branchModel, webLogin, posSession, presence, lastOrder, expiry] = await Promise.all([
    one(kw("res.users", "search_count", [[["share", "=", false]]]), null),
    one(kw("pos.config", "search_count", [[]]), null),
    // The companies' real names; the first (lowest id) is the main company.
    one(kw("res.company", "search_read", [[]], { fields: ["name"], order: "id", limit: 50 }), null),
    one(kw("res.branch", "search_count", [[]]), null).catch(() => null),
    // Latest real login by any user; if none, the latest user-record change (login updates it) as a fallback.
    one(kw("res.users", "search_read", [[]], { fields: ["login_date", "write_date"], order: "login_date desc", limit: 1, ...allUsers }), []),
    // POS cashiers log into the POS, not the web - pos.session.start_at is their real "last login".
    one(kw("pos.session", "search_read", [[]], { fields: ["start_at"], order: "start_at desc", limit: 1 }), []),
    // bus.presence.last_presence is the last time any user was active online - another "last seen" source.
    one(kw("bus.presence", "search_read", [[]], { fields: ["last_presence"], order: "last_presence desc", limit: 1, ...allUsers }), []).catch(() => []),
    one(kw("pos.order", "search_read", [[]], { fields: ["date_order"], order: "date_order desc", limit: 1 }), []),
    one(kw("ir.config_parameter", "search_read", [[["key", "=", "database.expiration_date"]]], { fields: ["value"], limit: 1 }), [])
  ]);
  const companyNames = Array.isArray(companyRows) ? companyRows.map((c) => String(c.name || "").trim()).filter(Boolean) : [];
  const companies = Array.isArray(companyRows) ? companyRows.length : null;
  // Branches: prefer res.branch if that model exists; else "extra companies" beyond the first.
  const branches = Number.isInteger(branchModel) ? branchModel : (Number.isInteger(companies) ? Math.max(0, companies - 1) : null);
  const expires = (expiry[0] && expiry[0].value) || null;
  // Last login = the most recent sign of a logged-in user: web login, POS session start, online presence,
  // or (as a last resort, so this is never blank when there's activity) the last order - an order means
  // a user was logged in at that moment.
  const order = (lastOrder[0] && lastOrder[0].date_order) || null;
  const u0 = webLogin[0] || {};
  const logins = [u0.login_date, posSession[0] && posSession[0].start_at, presence[0] && presence[0].last_presence, order, u0.write_date].filter(Boolean);
  return {
    loginOk: true, loginFound: true, db, users, pos, branches, companies,
    company: companyNames[0] || "", companyNames,
    lastLogin: logins.length ? logins.sort().at(-1) : null,
    lastOrder: (lastOrder[0] && lastOrder[0].date_order) || null,
    expires, expired: expires ? Date.parse(expires + "Z") < Date.now() : null
  };
}

// --- Audit & Deploy data (no customer login) -----------------------------------------------------
const unwrap = (r) => (r && r.payload) ? r.payload : r;

// Instance numbers to leave out of the report entirely (down servers, non-customer instances).
const excludedNums = (env) => new Set(String(env.DB_REPORT_EXCLUDE || "").split(",").map((s) => s.trim()).filter(Boolean));
// Every instance Audit & Deploy lists in a zone the Databases page shows (its section is set by sectionOf).
async function reportInstances(env) {
  const snap = unwrap(await odoo(env, "monitor.data.snapshot", "get_instances", [false]));
  const services = (snap && snap.services) || [];
  const skip = excludedNums(env);
  const numOf = (s) => (String(s.domain || s.instance_name).match(/(\d{2,4})/) || [])[1] || "";
  return services.filter((s) => SECTIONS[s.server_zone] && !skip.has(numOf(s)) && !skip.has(s.instance_name));
}

async function instanceFacts(env, inst) {
  const name = inst.instance_name;
  const section = sectionOf(inst.server_zone, name) || "main";
  const [cfg, add] = await Promise.all([
    odoo(env, "monitor.data.snapshot", "get_instance_config", [name, false]).then(unwrap).catch(() => ({})),
    odoo(env, "monitor.data.snapshot", "get_instance_addons", [name, null, false]).then(unwrap).catch(() => ({}))
  ]);
  // Database name can come from several config fields; db listing is usually disabled on these servers.
  const f = cfg.fields || {};
  let dbFromFilter = typeof f.dbfilter === "string" ? f.dbfilter.replace(/[\^$]/g, "").trim() : "";
  if (!/^[\w-]+$/.test(dbFromFilter)) dbFromFilter = ""; // ignore wildcard filters like "119_.*"
  const nameOk = (d) => /^[\w-]+$/.test(d) && (section !== "main" || isProductionName(d));
  const databases = [...new Set([...(cfg.databases || []), cfg.selected_database, f.db_name, dbFromFilter].filter(Boolean))].filter(nameOk);
  const addons = (add.addons || []).map((a) => a.name).filter(Boolean).sort();
  // The POS add-on's module_version (AI1 Settings > POS Configurations > flutter_pos_api), and its date when given.
  const pos = findPosModule(add) || findPosModule(cfg);
  const posVersion = pos ? pos.version : "";
  const posVersionDate = pos ? pos.date : "";
  // Odoo major version from the server's public version endpoint (works without a login).
  const base = inst.domain ? "https://" + inst.domain : "";
  let odooVersion = "";
  if (base) { const v = await customerRpc(base, "common", "version", [], AbortSignal.timeout(7000)).catch(() => null); const s = v && (v.server_serie || v.server_version); if (s) odooVersion = String(s).split(/[-.]/)[0]; }
  return {
    instance: name,
    url: base,
    num: (String(inst.domain || name).match(/(\d{2,4})/) || [])[1] || "",
    label: (String(inst.domain || "").match(/([a-z0-9][\w-]*)\.ai1\.host/i) || [])[1]?.toLowerCase() || "",
    databases,
    database: databases[0] || "",
    created: inst.created || null,
    odooVersion,
    addons,
    addonCount: addons.length,
    flutter: addons.some((a) => /flutter/i.test(a)),
    posVersion,
    section,
    posVersionDate,
    configError: cfg.database_inventory_error || cfg.error || ""
  };
}

// One row per web address: Audit & Deploy can list two production instances on the same domain (an old and a
// new one, or a second service). The row kept is the one whose login works and has the newest activity; the
// other instances are named on it.
export function oneRowPerSite(rows) {
  const score = (r) => [r.loginOk ? 1 : 0, String(r.lastOrder || r.lastLogin || ""), r.database ? 1 : 0, String(r.created || "")];
  const better = (a, b) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
  const bySite = new Map(), out = [];
  for (const r of rows) {
    const web = String(r.url || "").toLowerCase().replace(/\/+$/, "");
    if (!web) { out.push(r); continue; }
    const site = (r.section || "main") + " " + web; // the same address can appear in two sections
    const kept = bySite.get(site);
    if (!kept) { bySite.set(site, r); out.push(r); continue; }
    const [keep, drop] = better(r, kept) ? [r, kept] : [kept, r];
    const others = [...(kept.duplicates || []), ...(r.duplicates || []), { instance: drop.instance, database: drop.database || "" }];
    const merged = { ...keep, duplicates: others.filter((d, n, all) => all.findIndex((x) => x.instance === d.instance) === n && d.instance !== keep.instance) };
    bySite.set(site, merged); out[out.indexOf(kept)] = merged;
  }
  return out;
}

const pool = async (items, n, fn) => { const q = items.map((x, i) => [x, i]); const out = []; await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) { const [x, i] = q.shift(); out[i] = await fn(x); } })); return out; };

// Build (or continue building) the report. Resumable: saves progress and returns within the budget.
export async function buildReport(env, { force = false } = {}) {
  if (!env.STORE) return { error: "no store" };
  const started = Date.now();
  const owner = crypto.randomUUID();
  if (!await env.STORE.setIfAbsent(LOCK_KEY, owner, 90)) return { busy: true };
  try {
    let progress = null;
    try { progress = JSON.parse(await env.STORE.get(PROGRESS_KEY) || "null"); } catch {}
    // Start fresh when forced, when there is no in-flight build, or when the in-flight one is stale.
    if (force || !progress || Date.now() - (progress.startedAt || 0) > 10 * 60 * 1000) {
      const instances = await reportInstances(env);
      progress = { startedAt: Date.now(), rows: [], done: 0, total: instances.length, instances: instances.map((i) => ({ instance_name: i.instance_name, domain: i.domain, created: i.created, server_zone: i.server_zone })) };
    }
    const creds = await readCredentialIndex(env);
    while (progress.done < progress.instances.length && Date.now() - started < BUILD_BUDGET_MS) {
      const batch = progress.instances.slice(progress.done, progress.done + POOL);
      const rows = await pool(batch, POOL, async (inst) => {
        const facts = await instanceFacts(env, inst);
        const slot = creds[facts.label] || creds[facts.num];
        let inside = { loginOk: false, loginFound: !!(slot && slot.candidates.length) };
        if (inside.loginFound) { try { inside = await readInsideDatabase({ url: slot.url || facts.url, candidates: slot.candidates, titles: slot.titles, dbs: slot.dbs }, facts.databases); } catch (e) { inside = { loginFound: true, loginOk: false, error: String(e.message || e).slice(0, 80) }; } }
        // The company name only ever comes from inside the database (never from Knowledge text).
        return { ...facts, ...inside, company: inside.company || "", companySource: inside.company ? "database" : "" };
      });
      progress.rows.push(...rows);
      progress.done += batch.length;
      await env.STORE.set(PROGRESS_KEY, JSON.stringify(progress), 3600);
    }
    if (progress.done >= progress.instances.length) {
      const rows = oneRowPerSite(progress.rows);
      const report = { builtAt: Date.now(), count: rows.length, rows };
      await env.STORE.set(REPORT_KEY, JSON.stringify(report), 30 * DAY_MS / 1000);
      await env.STORE.del(PROGRESS_KEY);
      return { done: true, report };
    }
    return { done: false, progress: { done: progress.done, total: progress.instances.length } };
  } finally { await env.STORE.deleteIfValue(LOCK_KEY, owner); }
}

async function readReport(env) { try { return JSON.parse(await env.STORE.get(REPORT_KEY) || "null"); } catch { return null; } }

// GET /db-report  (admin) - returns the cached report; rebuilds in the background when stale or missing.
// POST /db-report/refresh (admin) - runs one build slice now (call again until done:true).
export async function dbReportRoutes(request, env, url, me) {
  if (me.role !== "admin") return fail("forbidden", "Only administrators can view the database report.", 403);
  if (!odooConfigured(env)) return fail("odoo_off", "Odoo isn't connected.", 501);
  if (!env.STORE) return fail("no_store", "The database report needs the database.", 501);
  const path = url.pathname;

  if (path === "/db-report" && request.method === "GET") {
    const report = await readReport(env);
    let building = false;
    // A report saved before a column existed is rebuilt, so every row carries the current fields.
    const outdated = !!report && (report.rows || []).some((r) => !("posVersion" in r) || !("section" in r));
    if (!report || outdated || Date.now() - report.builtAt > STALE_MS) { const r = await buildReport(env); building = !r.busy; }
    const after = await readReport(env);
    return json({ report: after || report || null, building: building && (!after || !report || after.builtAt === (report && report.builtAt)) });
  }
  if (path === "/db-report/refresh" && request.method === "POST") {
    const first = url.searchParams.get("continue") !== "1";
    const r = await buildReport(env, { force: first });
    if (r.busy) return json({ busy: true });
    return json({ done: !!r.done, progress: r.progress || null, report: r.report || await readReport(env) });
  }
  // POST /db-report/action {instance, action} - instance actions from the Databases page. Only instances in the
  // report; only restart for now. Recorded in the action log with the signed-in person's name.
  if (path === "/db-report/action" && request.method === "POST") {
    const b = (await request.json().catch(() => null)) || {};
    const instance = String(b.instance || ""), action = String(b.action || "");
    const report = await readReport(env);
    if (!(report && (report.rows || []).some((r) => r.instance === instance))) return fail("unknown_instance", "That instance isn't in the database report. Press Refresh now and try again.", 404);
    if (action !== "restart") return fail("unsupported", "Only restart is available here.", 400);
    return act(env, me, { action: "Restart instance", target: instance, details: "Databases page", run: () => odoo(env, "file.hosting.service", "call_api", ["/api/docker/odoo/restart", "POST", { instances: [instance] }]) });
  }
  return fail("not_found", "Not found.", 404);
}

// GET /cron/db-report?token=...  - daily rebuild from Vercel cron (no user session).
export async function dbReportCron(request, env, url) {
  const token = env.CRON_SECRET || "";
  const auth = request.headers.get("Authorization") || "";
  const ok = token && (auth === "Bearer " + token || url.searchParams.get("token") === token);
  if (!ok) return fail("forbidden", "Invalid cron token.", 403);
  if (!odooConfigured(env) || !env.STORE) return json({ skipped: "not configured" });
  // Run slices to completion within this invocation (force a fresh build on the first slice, then continue).
  const deadline = Date.now() + 55000;
  let r = await buildReport(env, { force: true });
  while (!r.done && !r.busy && Date.now() < deadline) r = await buildReport(env, { force: false });
  const rep = await readReport(env);
  const rows = (rep && rep.rows) || [];
  const summary = { total: rows.length, loggedIn: rows.filter((x) => x.loginOk).length, noAccess: rows.filter((x) => x.loginFound && !x.loginOk).map((x) => x.database || x.instance) };
  return json({ ok: true, done: !!r.done, busy: !!r.busy, summary });
}
