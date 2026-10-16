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

const REPORT_KEY = "dbreport:v1";          // the finished/most-recent report
const PROGRESS_KEY = "dbreport:progress";  // an in-flight incremental build
const LOCK_KEY = "dbreport:lock";
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 20 * 60 * 60 * 1000;      // refresh on view when older than this
const BUILD_BUDGET_MS = 45000;             // leave headroom under the 60s function limit
const POOL = 8;

const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const fail = (code, error, status = 400) => Response.json({ code, error }, { status, headers: { "Cache-Control": "no-store" } });

// A database/instance is excluded unless it is clearly production.
// Keyword surrounded by non-letters (so "_Demo", "qa_main", "staging1" match, but "Devora" does not).
const NON_PROD = /(?:^|[^a-z])(test|dev|develop|development|staging|stage|demo|sandbox|copy|backup|bak|tmp|temp|trial|training|qa|poc)(?:[^a-z]|$)/i;
export const isProductionName = (name) => !!name && !NON_PROD.test(String(name));

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
  const text = raw
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|td|th|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'");
  const urls = [...new Set([...hrefs, ...[...text.matchAll(/https?:\/\/[^\s)"'<>]+/gi)].map((m) => m[0])])];
  const url = urls.find((u) => /\.ai1\.host/i.test(u)) || urls[0] || "";
  // Every ai1.host number mentioned anywhere (name/url/body) - an article can serve more than one.
  const nums = [...new Set([...raw.matchAll(/(\d{2,4})\.ai1\.host/gi)].map((m) => m[1]))];
  const host = (url.match(/^https?:\/\/([^/]+)/i) || [])[1] || "";
  const num = (host.match(/(\d{2,4})\.ai1\.host/i) || [])[1] || nums[0] || (host.match(/(\d{2,4})/) || [])[1] || "";

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const users = new Set(), passwords = new Set();
  const labeled = (labels, line) => { const m = line.match(new RegExp("(?:" + labels + ")\\s*[:：]\\s*(\\S.*)$", "i")); return m ? m[1].trim() : ""; };
  // A line that is ONLY a label (common in tables / "Label" then "value" on the next cell/line).
  const labelOnly = (labels, line) => new RegExp("^(?:" + labels + ")\\s*[:：]?\\s*$", "i").test(line);
  const firstTok = (s) => (s || "").split(/\s|[|,;]/)[0];
  // A labeled value is trusted even if short/odd; only unlabeled guesses get the strict checks.
  const trusted = (t) => t && t.length <= 64 && !/^[-=_*.]+$/.test(t);
  const NON_PW_WORD = /^(the|and|for|with|this|that|user|email|login|password|pass|portal|site|link|domain|name|odoo|admin|server|database|https?|www)$/i;
  // Every email anywhere is a possible username. (The user confirms each article has an email + password.)
  for (const m of text.matchAll(/[^\s:：,<>()"']+@[^\s:：,<>()"']+\.[A-Za-z]{2,}/g)) users.add(m[0]);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], next = lines[i + 1] || "";
    const u = firstTok(labeled(LABEL.user, line)); if (trusted(u)) users.add(u);
    const p = firstTok(labeled(LABEL.pass, line)); if (trusted(p)) passwords.add(p);
    // Label alone on a line/cell -> the value is the next non-empty line/cell.
    if (labelOnly(LABEL.user, line) && trusted(firstTok(next))) users.add(firstTok(next));
    if (labelOnly(LABEL.pass, line) && trusted(firstTok(next))) passwords.add(firstTok(next));
    // The token right after an email on the SAME line is often its password ("a@b.com  secret").
    const inlineEmail = line.match(/\S+@\S+\.\S+\s+(\S+)/); if (inlineEmail && looksLikePassword(inlineEmail[1])) passwords.add(inlineEmail[1]);
    // The non-empty line right after an email line, or right after the URL line, is often the password.
    if (/^\S+@\S+\.\S+$/.test(line) && looksLikePassword(firstTok(next))) passwords.add(firstTok(next));
    if (/^https?:\/\//i.test(line) && next && !/^https?:/i.test(next)) { const t = firstTok(next); if (looksLikePassword(t)) passwords.add(t); if (looksLikeUser(t)) users.add(t); }
  }
  // High recall: any password-like token anywhere (printable, 4-40 chars, not a plain word/email/url).
  for (const line of lines) for (const tok of line.split(/\s|[|,;]+/)) {
    // A password guess must have a digit, or be a length>=6 mixed-case token - this skips prose words.
    if (/^[\x21-\x7e]{4,40}$/.test(tok) && !/@/.test(tok) && !/^https?:/i.test(tok) && !NON_PW_WORD.test(tok) && (/\d/.test(tok) || (/[a-z]/.test(tok) && /[A-Z]/.test(tok) && tok.length >= 6))) passwords.add(tok);
  }
  users.add("admin"); // the common Odoo admin login, worth trying

  // Build candidate (user, password) pairs, emails first, capped to bound login attempts.
  const uList = [...users].sort((a, b) => (/@/.test(b) ? 1 : 0) - (/@/.test(a) ? 1 : 0));
  const pList = [...passwords];
  const candidates = [];
  for (const u of uList) for (const p of pList) if (u && p) candidates.push({ user: u, password: p });
  const seen = new Set(), unique = [];
  for (const c of candidates) { const k = c.user + "\u0000" + c.password; if (!seen.has(k)) { seen.add(k); unique.push(c); } if (unique.length >= 20) break; }
  return { url, host, num, nums: nums.length ? nums : (num ? [num] : []), candidates: unique, complete: !!(url && unique.length) };
}

// Map each ai1.host instance number -> { url, candidates[] }, merged across all customer articles.
async function readCredentialIndex(env) {
  const index = {};
  try {
    // Search every knowledge article, not only the "Our Customers" folder - some customer logins live
    // in standalone articles. Wrong guesses simply fail to authenticate, so a broad net is safe.
    const arts = await odoo(env, "knowledge.article", "search_read", [[]], { fields: ["name", "body"], limit: 2000 });
    for (const a of arts) {
      const c = parseCreds(a.body);
      if (!c.candidates.length) continue;
      // Match by the ai1.host numbers in the body, and also by a 2-4 digit number in the article's title.
      const nameNum = typeof a.name === "string" ? (a.name.match(/\b(\d{2,4})\b/) || [])[1] : "";
      const numbers = [...new Set([...c.nums, c.num, nameNum].filter(Boolean))];
      for (const n of numbers) {
        const slot = index[n] || (index[n] = { url: "", candidates: [], seen: new Set() });
        if (!slot.url && (c.url.includes(n + ".ai1.host") || !slot.url)) slot.url = c.url.includes(n + ".ai1.host") ? c.url : (slot.url || "https://" + n + ".ai1.host");
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
  const signal = () => AbortSignal.timeout(10000);
  const num = (base.match(/(\d{2,4})\.ai1\.host/i) || [])[1] || "";
  // Database names to try, best first: the one Audit & Deploy reported, then what the server lists.
  const dbNames = [];
  if (dbHint) dbNames.push(dbHint);
  const list = await customerRpc(base, "db", "list", [], signal()).catch(() => null);
  if (Array.isArray(list)) for (const d of list) if (!dbNames.includes(d)) dbNames.push(d);
  if (num && !dbNames.includes(num)) dbNames.push(num);
  // Try each (database, login) until one authenticates. "Try any of them."
  let db = "", uid = 0, password = "", attempts = 0;
  outer: for (const d of dbNames.slice(0, 4)) {
    for (const c of slot.candidates) {
      if (++attempts > 48) break outer;
      const id = await customerRpc(base, "common", "authenticate", [d, c.user, c.password, {}], signal()).catch(() => 0);
      if (id) { db = d; uid = id; password = c.password; break outer; }
    }
  }
  if (!uid) return { loginOk: false, loginFound: true, error: "no login accepted", tried: attempts };
  const kw = (model, method, args, k = {}) => customerRpc(base, "object", "execute_kw", [db, uid, password, model, method, args, k], signal());
  const one = async (p, dflt) => { try { return await p; } catch { return dflt; } };
  const [users, pos, companies, branchModel, webLogin, posSession, lastOrder, expiry] = await Promise.all([
    one(kw("res.users", "search_count", [[["share", "=", false]]]), null),
    one(kw("pos.config", "search_count", [[]]), null),
    one(kw("res.company", "search_count", [[]]), null),
    one(kw("res.branch", "search_count", [[]]), null).catch(() => null),
    one(kw("res.users", "search_read", [[["login_date", "!=", false]]], { fields: ["login_date"], order: "login_date desc", limit: 1 }), []),
    // POS cashiers log into the POS, not the web - pos.session.start_at is their real "last login".
    one(kw("pos.session", "search_read", [[]], { fields: ["start_at"], order: "start_at desc", limit: 1 }), []),
    one(kw("pos.order", "search_read", [[]], { fields: ["date_order"], order: "date_order desc", limit: 1 }), []),
    one(kw("ir.config_parameter", "search_read", [[["key", "=", "database.expiration_date"]]], { fields: ["value"], limit: 1 }), [])
  ]);
  // Branches: prefer res.branch if that model exists; else "extra companies" beyond the first.
  const branches = Number.isInteger(branchModel) ? branchModel : (Number.isInteger(companies) ? Math.max(0, companies - 1) : null);
  const expires = (expiry[0] && expiry[0].value) || null;
  // Last login = the most recent of a web login and a POS session start (same datetime format, so max works).
  const logins = [webLogin[0] && webLogin[0].login_date, posSession[0] && posSession[0].start_at].filter(Boolean);
  return {
    loginOk: true, loginFound: true, db, users, pos, branches, companies: Number.isInteger(companies) ? companies : null,
    lastLogin: logins.length ? logins.sort().at(-1) : null,
    lastOrder: (lastOrder[0] && lastOrder[0].date_order) || null,
    expires, expired: expires ? Date.parse(expires + "Z") < Date.now() : null
  };
}

// --- Audit & Deploy data (no customer login) -----------------------------------------------------
const unwrap = (r) => (r && r.payload) ? r.payload : r;

async function productionInstances(env) {
  const snap = unwrap(await odoo(env, "monitor.data.snapshot", "get_instances", [false]));
  const services = (snap && snap.services) || [];
  return services.filter((s) => s.server_zone === "prod" && isProductionName(s.instance_name));
}

async function instanceFacts(env, inst) {
  const name = inst.instance_name;
  const [cfg, add] = await Promise.all([
    odoo(env, "monitor.data.snapshot", "get_instance_config", [name, false]).then(unwrap).catch(() => ({})),
    odoo(env, "monitor.data.snapshot", "get_instance_addons", [name, null, false]).then(unwrap).catch(() => ({}))
  ]);
  const databases = (cfg.databases || []).filter(isProductionName);
  const addons = (add.addons || []).map((a) => a.name).filter(Boolean).sort();
  return {
    instance: name,
    url: inst.domain ? "https://" + inst.domain : "",
    num: (String(inst.domain || name).match(/(\d{2,4})/) || [])[1] || "",
    databases,
    database: databases[0] || "",
    created: inst.created || null,
    addons,
    addonCount: addons.length,
    flutter: addons.some((a) => /flutter/i.test(a)),
    configError: cfg.database_inventory_error || cfg.error || ""
  };
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
      const instances = await productionInstances(env);
      progress = { startedAt: Date.now(), rows: [], done: 0, total: instances.length, instances: instances.map((i) => ({ instance_name: i.instance_name, domain: i.domain, created: i.created })) };
    }
    const creds = await readCredentialIndex(env);
    while (progress.done < progress.instances.length && Date.now() - started < BUILD_BUDGET_MS) {
      const batch = progress.instances.slice(progress.done, progress.done + POOL);
      const rows = await pool(batch, POOL, async (inst) => {
        const facts = await instanceFacts(env, inst);
        const slot = creds[facts.num];
        let inside = { loginOk: false, loginFound: !!(slot && slot.candidates.length) };
        if (inside.loginFound) { try { inside = await readInsideDatabase({ url: slot.url || facts.url, candidates: slot.candidates }, facts.database); } catch (e) { inside = { loginFound: true, loginOk: false, error: String(e.message || e).slice(0, 80) }; } }
        return { ...facts, ...inside };
      });
      progress.rows.push(...rows);
      progress.done += batch.length;
      await env.STORE.set(PROGRESS_KEY, JSON.stringify(progress), 3600);
    }
    if (progress.done >= progress.instances.length) {
      const report = { builtAt: Date.now(), count: progress.rows.length, rows: progress.rows };
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
    if (!report || Date.now() - report.builtAt > STALE_MS) { const r = await buildReport(env); building = !r.busy; }
    const after = await readReport(env);
    return json({ report: after || report || null, building: building && (!after || !report || after.builtAt === (report && report.builtAt)) });
  }
  if (path === "/db-report/refresh" && request.method === "POST") {
    const first = url.searchParams.get("continue") !== "1";
    const r = await buildReport(env, { force: first });
    if (r.busy) return json({ busy: true });
    return json({ done: !!r.done, progress: r.progress || null, report: r.report || await readReport(env) });
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
  // One slice per invocation; Vercel calls daily, and a stale build auto-continues on the next view.
  const r = await buildReport(env, { force: true });
  return json({ ok: true, ...r, report: undefined });
}
