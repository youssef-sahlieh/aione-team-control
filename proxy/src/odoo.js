// Odoo Helpdesk tickets (HD-<id>): read from Odoo through its external JSON-RPC API with a service
// account, and changed there (stage, developer, internal notes). Nothing is stored by the proxy.
//
// Settings (Vercel environment variables): ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_API_KEY.
// The Odoo "Assigned to" user is the ticket's developer: matched to the ai1_ developer list by email
// (TEAM_CONFIG devEmails), otherwise the part of their email before "@" (ireen@aione.biz -> ireen).

import { withTicketLock } from "./ticket-metadata.js";
import { timeClosureErrors } from "./time-entries.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const fail = (code, error, status) => json({ code, error }, status);
async function readJson(request) { try { return await request.json(); } catch { return null; } }

export const odooConfigured = (env) => !!(env.ODOO_URL && env.ODOO_DB && env.ODOO_LOGIN && env.ODOO_API_KEY);
const base = (env) => String(env.ODOO_URL).replace(/\/+$/, "");

let uidCache = { key: "", uid: 0 };
let rpcId = 0;
// definite: Odoo answered with an error, so nothing was saved (its transaction was rolled back).
// Otherwise (no answer, timeout, bad gateway) the outcome is unknown: a create may or may not have happened.
// kind is Odoo's exception name, e.g. "odoo.exceptions.ValidationError".
export class OdooError extends Error {
  constructor(message, { definite = false, kind = "" } = {}) { super(message); this.definite = definite; this.kind = kind; }
}
async function rpc(env, service, method, args) {
  let res;
  try {
    res = await fetch(base(env) + "/jsonrpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: ++rpcId, params: { service, method, args } }),
      signal: AbortSignal.timeout(20000)
    });
  } catch (e) { throw new OdooError("Odoo didn't answer: " + ((e && e.message) || "network error")); }
  const data = await res.json().catch(() => null);
  if (data && data.error) throw new OdooError((data.error.data && data.error.data.message) || data.error.message || "Odoo error.", { definite: true, kind: String((data.error.data && data.error.data.name) || "") });
  if (!res.ok || !data) throw new OdooError("Odoo answered " + res.status + ".");
  return data.result;
}
async function uid(env) {
  const key = env.ODOO_URL + "|" + env.ODOO_DB + "|" + env.ODOO_LOGIN;
  // One sign-in is shared by every request at the same time (and reused afterwards); a failed one is retried next time.
  if (uidCache.key === key && uidCache.uid) return uidCache.uid;
  const pending = (async () => {
    const id = await rpc(env, "common", "authenticate", [env.ODOO_DB, env.ODOO_LOGIN, env.ODOO_API_KEY, {}]);
    if (!id) throw new Error("Odoo didn't accept the proxy's login and API key. Check ODOO_LOGIN and ODOO_API_KEY.");
    return id;
  })();
  uidCache = { key, uid: pending };
  pending.catch(() => { if (uidCache.uid === pending) uidCache = { key: "", uid: 0 }; });
  return pending;
}
// The Odoo user id the proxy signs in as (to read that user's own API keys, for their expiry).
export const odooUid = (env) => uid(env);
export async function odoo(env, model, method, args, kwargs = {}) {
  return rpc(env, "object", "execute_kw", [env.ODOO_DB, await uid(env), env.ODOO_API_KEY, model, method, args, kwargs]);
}

const FIELDS = ["name", "stage_id", "user_id", "partner_id", "partner_name", "partner_email", "priority", "team_id", "create_date", "write_date", "close_date", "sla_deadline", "ticket_ref"];
const PRIORITY = { "0": "Low", "1": "Medium", "2": "High", "3": "Urgent" };

// Odoo dates are "YYYY-MM-DD HH:MM:SS" in UTC.
const iso = (d) => (d ? String(d).replace(" ", "T") + "Z" : "");

// '"Ariel Amiri" <ariel@x.com>' -> { name: "Ariel Amiri", email: "ariel@x.com" }
export function customerOf(t) {
  const raw = String(t.partner_email || "").trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  let email = m ? m[2].trim() : raw, name = m ? m[1].trim() : "";
  if (!name) name = String(t.partner_name || "").replace(/<[^>]*>/g, "").replace(/"/g, "").trim();
  if (!name && Array.isArray(t.partner_id)) name = String(t.partner_id[1] || "");
  if (!email && /@/.test(name)) email = name;
  if (name === email) name = "";
  return { name, email };
}

// Odoo user -> ai1_ developer name, and back.
function devMaps(env, users) {
  let devEmails = {};
  try { devEmails = JSON.parse(env.TEAM_CONFIG || "{}").devEmails || {}; } catch {}
  const byEmail = new Map(Object.entries(devEmails).map(([dev, e]) => [String(e).toLowerCase(), dev]));
  const toDev = new Map(), toUser = new Map();
  for (const u of users) {
    const email = String(u.email || u.login || "").toLowerCase();
    const dev = byEmail.get(email) || email.split("@")[0].replace(/[^a-z0-9._-]/g, "");
    if (!dev) continue;
    toDev.set(u.id, dev);
    if (!toUser.has(dev)) toUser.set(dev, u.id);
  }
  return { toDev, toUser };
}

let usersCache = { at: 0, users: [] };
async function odooUsers(env) {
  if (Date.now() - usersCache.at < 10 * 60 * 1000 && usersCache.users.length) return usersCache.users;
  const users = await odoo(env, "res.users", "search_read", [[["share", "=", false]]], { fields: ["name", "login", "email"], limit: 500 });
  usersCache = { at: Date.now(), users };
  return users;
}

let stagesCache = { at: 0, stages: [] };
async function stages(env) {
  if (Date.now() - stagesCache.at < 10 * 60 * 1000 && stagesCache.stages.length) return stagesCache.stages;
  const s = await odoo(env, "helpdesk.stage", "search_read", [[]], { fields: ["name", "fold", "sequence", "team_ids"], order: "sequence, id" });
  stagesCache = { at: Date.now(), stages: s };
  return s;
}
const stageCat = (s, all) => (!s ? "new" : s.fold ? "done" : all.filter((x) => !x.fold)[0]?.id === s.id ? "new" : "indeterminate");

function view(env, t, maps, allStages) {
  const stage = allStages.find((s) => Array.isArray(t.stage_id) && s.id === t.stage_id[0]);
  const dev = Array.isArray(t.user_id) ? maps.toDev.get(t.user_id[0]) : null;
  return {
    // The key uses the ticket number people see in Odoo (ticket_ref, e.g. #302), not the record id.
    key: "HD-" + (t.ticket_ref || t.id), id: t.id, ref: t.ticket_ref || String(t.id), odoo: true,
    summary: t.name || "(no subject)",
    status: stage ? stage.name : (Array.isArray(t.stage_id) ? t.stage_id[1] : "New"), statusCat: stageCat(stage, allStages),
    devs: dev ? [dev] : [], developerName: Array.isArray(t.user_id) ? t.user_id[1] : "",
    customer: customerOf(t), team: Array.isArray(t.team_id) ? t.team_id[1] : "",
    priority: PRIORITY[t.priority] || "Low",
    created: iso(t.create_date), updated: iso(t.write_date), closed: iso(t.close_date),
    due: t.sla_deadline ? String(t.sla_deadline).slice(0, 10) : null,
    url: base(env) + "/web#id=" + t.id + "&model=helpdesk.ticket&view_type=form"
  };
}

// HD-302 -> Odoo domain for the ticket whose number (ticket_ref) is 302.
const refOf = (key) => { const m = /^HD-(\d+)$/.exec(String(key || "")); return m ? m[1] : ""; };
const byRef = (key) => [["ticket_ref", "=", refOf(key)]];

// Title and developer of one Odoo ticket, for features that check access (private ticket notes).
export async function odooTicketInfo(env, key) {
  if (!odooConfigured(env) || !refOf(key)) return null;
  const [t] = await odoo(env, "helpdesk.ticket", "search_read", [byRef(key)], { fields: ["name", "user_id"], limit: 1 });
  if (!t) return null;
  const maps = devMaps(env, await odooUsers(env));
  const dev = Array.isArray(t.user_id) ? maps.toDev.get(t.user_id[0]) : null;
  return { title: t.name, devs: dev ? [dev] : [] };
}

// One Helpdesk ticket for the work log: title, developer, whether it's closed, and its Odoo project (when
// Helpdesk timesheets are installed, the ticket has one).
let hdFields = null;
export async function odooTicketForTime(env, key) {
  if (!odooConfigured(env) || !refOf(key)) return null;
  if (!hdFields) hdFields = await odoo(env, "helpdesk.ticket", "fields_get", [], { attributes: ["type"] });
  const [t] = await odoo(env, "helpdesk.ticket", "search_read", [byRef(key)], { fields: ["name", "user_id", "stage_id", ...(hdFields.project_id ? ["project_id"] : [])], limit: 1 });
  if (!t) return null;
  const [users, allStages] = await Promise.all([odooUsers(env), stages(env)]);
  const dev = Array.isArray(t.user_id) ? devMaps(env, users).toDev.get(t.user_id[0]) : null;
  const stage = allStages.find((s) => Array.isArray(t.stage_id) && s.id === t.stage_id[0]);
  return { key, title: t.name || "", devs: dev ? [dev] : [], closed: !!(stage && stage.fold), projectId: Array.isArray(t.project_id) ? t.project_id[0] : null };
}

// Odoo HTML (descriptions, chatter) is shown as text by the dashboard's own sanitizer; this only trims size.
const clip = (html, n = 50000) => String(html || "").slice(0, n);

export async function odooRoutes(request, env, url, me) {
  const path = url.pathname, method = request.method;
  if (!odooConfigured(env)) return fail("odoo_off", "Odoo isn't connected. See SETUP.md.", 501);
  const isAdmin = me.role === "admin";
  if (!isAdmin && !me.dev) return fail("forbidden", "Your account has no developer name.", 403);

  try {
    const [users, allStages] = await Promise.all([odooUsers(env), stages(env)]);
    const maps = devMaps(env, users);
    const mine = (t) => isAdmin || (Array.isArray(t.user_id) && maps.toDev.get(t.user_id[0]) === me.dev);

    // List: every open ticket, plus the ones closed in the last N days.
    if (path === "/odoo/tickets" && method === "GET") {
      const days = Math.min(Math.max(Number(url.searchParams.get("closedDays")) || 30, 1), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace("T", " ");
      let domain = ["|", ["stage_id.fold", "=", false], ["write_date", ">=", since]];
      if (!isAdmin) {
        const uidFor = maps.toUser.get(me.dev);
        if (!uidFor) return json({ tickets: [] });
        domain = ["&", ["user_id", "=", uidFor], ...domain];
      }
      const rows = await odoo(env, "helpdesk.ticket", "search_read", [domain], { fields: FIELDS, order: "write_date desc", limit: 500 });
      return json({ tickets: rows.filter(mine).map((t) => view(env, t, maps, allStages)) });
    }

    const m = /^\/odoo\/tickets\/(HD-\d+)(\/note)?$/.exec(path);
    if (!m) return fail("not_found", "Not found.", 404);
    const [t] = await odoo(env, "helpdesk.ticket", "search_read", [byRef(m[1])], { fields: [...FIELDS, "description"], limit: 1 });
    if (!t || !mine(t)) return fail("not_found", "No such Odoo ticket.", 404);
    const id = t.id;
    const teamId = Array.isArray(t.team_id) ? t.team_id[0] : 0;
    const teamStages = allStages.filter((s) => !teamId || !s.team_ids.length || s.team_ids.includes(teamId));

    if (!m[2] && method === "GET") {
      const msgs = await odoo(env, "mail.message", "search_read", [[["model", "=", "helpdesk.ticket"], ["res_id", "=", id], ["message_type", "in", ["comment", "email"]]]],
        { fields: ["body", "author_id", "email_from", "date", "subtype_id", "message_type"], order: "date asc", limit: 200 });
      return json({
        ticket: view(env, t, maps, allStages),
        description: clip(t.description),
        messages: msgs.filter((x) => String(x.body || "").replace(/<[^>]*>/g, "").trim()).map((x) => ({
          author: Array.isArray(x.author_id) ? x.author_id[1] : String(x.email_from || "Someone").replace(/<[^>]*>/g, "").replace(/"/g, "").trim(),
          when: iso(x.date), body: clip(x.body, 20000),
          note: Array.isArray(x.subtype_id) && /note/i.test(x.subtype_id[1]), email: x.message_type === "email"
        })),
        stages: teamStages.map((s) => ({ id: s.id, name: s.name, cat: stageCat(s, allStages) }))
      });
    }

    if (!m[2] && method === "PUT") {
      const b = (await readJson(request)) || {};
      const vals = {};
      if (b.stage !== undefined) {
        const s = teamStages.find((x) => x.id === Number(b.stage) || x.name === b.stage);
        if (!s) return fail("bad_request", "That stage isn't available for this ticket.", 400);
        vals.stage_id = s.id;
      }
      if (b.devs !== undefined) {
        if (!isAdmin) return fail("forbidden", "Only administrators can change the developer.", 403);
        const devs = Array.isArray(b.devs) ? [...new Set(b.devs.map((d) => String(d).replace(/^ai1_/i, "").toLowerCase()))] : null;
        if (!devs || devs.length > 1) return fail("bad_request", "An Odoo ticket has one developer. Pick only one.", 400);
        if (devs.length) {
          const u = maps.toUser.get(devs[0]);
          if (!u) return fail("bad_request", "ai1_" + devs[0] + " has no Odoo user.", 400);
          vals.user_id = u;
        } else vals.user_id = false;
      }
      if (!Object.keys(vals).length) return fail("bad_request", "Nothing to change.", 400);
      // Closing (a move to a folded stage): every work entry must be in Odoo first. Checked under the ticket lock,
      // which new work entries also take, so none can slip in while it closes.
      const wasOpen = !allStages.find((s) => Array.isArray(t.stage_id) && s.id === t.stage_id[0])?.fold;
      const closing = vals.stage_id && wasOpen && teamStages.find((s) => s.id === vals.stage_id)?.fold;
      if (closing && env.STORE?.writeIndexed) {
        const blocked = await withTicketLock(env, m[1], async () => {
          const missing = await timeClosureErrors(env, m[1]);
          if (missing.length) return fail("time_not_synced", "Cannot close: " + missing.join("; ") + ".", 409);
          await odoo(env, "helpdesk.ticket", "write", [[id], vals]);
          return null;
        });
        if (blocked) return blocked;
      } else await odoo(env, "helpdesk.ticket", "write", [[id], vals]);
      const [after] = await odoo(env, "helpdesk.ticket", "search_read", [[["id", "=", id]]], { fields: FIELDS, limit: 1 });
      const before = Array.isArray(t.user_id) ? maps.toDev.get(t.user_id[0]) : null;
      const now = view(env, after, maps, allStages);
      return json({ ticket: now, added: now.devs.filter((d) => d !== before) });
    }

    // Internal note in the Odoo chatter (not emailed to the customer), signed with the dashboard user.
    if (m[2] && method === "POST") {
      const text = String(((await readJson(request)) || {}).text || "").trim();
      if (!text || text.length > 20000) return fail("bad_request", "Write a note first.", 400);
      const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
      const body = "<p>" + esc(text).replace(/\n/g, "<br>") + "</p><p><i>— " + esc(me.name || me.email) + ", via AION Team Control</i></p>";
      await odoo(env, "helpdesk.ticket", "message_post", [[id]], { body, message_type: "comment", subtype_xmlid: "mail.mt_note" });
      return json({ ok: true }, 201);
    }
  } catch (err) {
    if (err && typeof err.status === "number" && typeof err.code === "string") throw err;
    console.log("odoo error:", err && err.message);
    return fail("odoo", "Odoo: " + ((err && err.message) || "unknown error"), 502);
  }
  return fail("not_found", "Not found.", 404);
}
