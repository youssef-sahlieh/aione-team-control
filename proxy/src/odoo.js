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
  const users = await odoo(env, "res.users", "search_read", [[["share", "=", false]]], { fields: ["name", "login", "email", "partner_id"], limit: 500 });
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

// Many Helpdesk tickets in one read (the project workspace's ticket list): title, a plain-text description, stage,
// whether it's closed, and the developer (Odoo's assigned user, who is also the assignee).
export async function odooTicketsDetails(env, keys) {
  const refs = [...new Set(keys.map(refOf).filter(Boolean))], out = {};
  if (!odooConfigured(env) || !refs.length) return out;
  const [rows, users, allStages] = await Promise.all([
    odoo(env, "helpdesk.ticket", "search_read", [[["ticket_ref", "in", refs]]], { fields: ["name", "ticket_ref", "user_id", "stage_id", "description"], limit: refs.length }),
    odooUsers(env), stages(env)]);
  const maps = devMaps(env, users);
  for (const t of rows) {
    const stage = allStages.find((s) => Array.isArray(t.stage_id) && s.id === t.stage_id[0]), dev = Array.isArray(t.user_id) ? maps.toDev.get(t.user_id[0]) : null;
    const text = String(t.description || "").replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    out["HD-" + (t.ticket_ref || t.id)] = { title: t.name || "", description: text.slice(0, 2000), devs: dev ? [dev] : [], closed: !!(stage && stage.fold),
      status: stage ? stage.name : Array.isArray(t.stage_id) ? t.stage_id[1] : "New", assignee: Array.isArray(t.user_id) ? t.user_id[1] : "" };
  }
  return out;
}

// A dashboard internal note, copied into the Odoo ticket's chatter as an internal note (not emailed).
export async function postOdooNote(env, key, me, text) {
  if (!odooConfigured(env) || !refOf(key)) throw new Error("Not an Odoo ticket.");
  const [t] = await odoo(env, "helpdesk.ticket", "search_read", [byRef(key)], { fields: ["id"], limit: 1 });
  if (!t) throw new Error("The Odoo ticket wasn't found.");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const body = "<p>" + esc(text).replace(/\n/g, "<br>") + "</p><p><i>— " + esc(me.name || me.email) + ", internal note via AION Team Control</i></p>";
  await odoo(env, "helpdesk.ticket", "message_post", [[t.id]], { body, message_type: "comment", subtype_xmlid: "mail.mt_note" });
}

// Odoo HTML (descriptions, chatter) is shown as text by the dashboard's own sanitizer; this only trims size.
const clip = (html, n = 50000) => String(html || "").slice(0, n);

// Files attached to the ticket in Odoo (added on the ticket or in its chatter). Links are not files.
const ticketFiles = (env, id, extra = []) => odoo(env, "ir.attachment", "search_read",
  [[["res_model", "=", "helpdesk.ticket"], ["res_id", "=", id], ["type", "=", "binary"], ...extra]],
  { fields: ["name", "mimetype", "file_size", "create_date", "create_uid"], order: "create_date desc", limit: 100 });
// Files attached to the ticket's chatter messages (an email's attachments, a note's files), by id.
const messageFiles = (env, ids) => !ids.length ? Promise.resolve([]) : odoo(env, "ir.attachment", "read", [ids],
  { fields: ["name", "mimetype", "file_size", "create_date", "create_uid", "type"] }).then((rows) => rows.filter((x) => x.type !== "url"));
// Same shape the dashboard shows for Jira and internal attachments.
const fileView = (x) => ({
  id: x.id, filename: x.name || "attachment", mimeType: x.mimetype || "application/octet-stream", size: x.file_size || 0,
  created: iso(x.create_date), author: { displayName: Array.isArray(x.create_uid) ? x.create_uid[1] : "" }
});

// New tickets start unassigned, so an administrator assigns them, even when Odoo assigned someone (e.g. the
// project manager). Each ticket created after this started is unassigned once, the first time the dashboard
// sees it; assigning it afterwards (here or in Odoo) sticks. Tickets that already existed keep their assignee.
const odooNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");
export async function unassignNew(env, rows) {
  const store = env.STORE;
  if (!store?.setIfAbsent) return;
  const since = await store.get("odoo:unassign-new-since");
  if (!since) { await store.set("odoo:unassign-new-since", odooNow()); return; }
  for (const t of rows) {
    if (!Array.isArray(t.user_id) || String(t.create_date || "") < since) continue;
    if (!await store.setIfAbsent("odoo:unassigned:" + t.id, "1", 400 * 86400)) continue;
    try { await odoo(env, "helpdesk.ticket", "write", [[t.id], { user_id: false }]); t.user_id = false; }
    catch (e) { await store.del("odoo:unassigned:" + t.id); console.log("odoo unassign failed:", e && e.message); }
  }
}

// Which tickets the dashboard lists:
// - open ticket (any stage that isn't folded): always shown, like Odoo's kanban.
// - Solved or Cancelled: hidden, unless the ticket's own customer wrote after it was closed (emails and replies;
//   internal notes don't count): then it's shown with its real stage. The dashboard never changes the stage itself.
//   Only the ticket's customer (its contact, or its email address) counts: Odoo's automatic emails (solved,
//   rating requests), OdooBot, archived staff and people in copy don't.
const isNote = (x) => Array.isArray(x.subtype_id) && /note/i.test(String(x.subtype_id[1]));
export async function conversation(env, rows, users, allStages) {
  const stageOf = (t) => allStages.find((x) => Array.isArray(t.stage_id) && x.id === t.stage_id[0]);
  const closed = rows.filter((t) => stageOf(t)?.fold);
  if (!closed.length) return rows;
  const ours = new Set(users.map((u) => (Array.isArray(u.partner_id) ? u.partner_id[0] : 0)).filter(Boolean));
  const byId = new Map(closed.map((t) => [t.id, t]));
  const fromCustomer = (x) => {
    const t = byId.get(x.res_id);
    if (!t || (Array.isArray(x.author_id) && ours.has(x.author_id[0]))) return false;
    if (Array.isArray(x.author_id) && Array.isArray(t.partner_id) && x.author_id[0] === t.partner_id[0]) return true;
    const email = customerOf(t).email.toLowerCase();
    return !!email && String(x.email_from || "").toLowerCase().includes(email);
  };
  const msgs = await odoo(env, "mail.message", "search_read", [[["model", "=", "helpdesk.ticket"], ["res_id", "in", closed.map((t) => t.id)], ["message_type", "in", ["email", "comment"]]]],
    { fields: ["res_id", "date", "author_id", "email_from", "subtype_id", "message_type"], order: "date desc", limit: 5000 });
  const last = new Map(); // ticket id -> { customer }
  for (const x of msgs) {
    if (isNote(x) || !fromCustomer(x)) continue;
    const s = last.get(x.res_id) || {};
    if (!s.customer || String(x.date) > s.customer) s.customer = String(x.date);
    last.set(x.res_id, s);
  }
  const shown = [];
  for (const t of rows) {
    const s = last.get(t.id) || {}, stage = stageOf(t);
    if (stage && stage.fold) {
      const closedAt = String(t.close_date || t.write_date || "");
      if (!s.customer || s.customer <= closedAt) continue;
    }
    shown.push(t);
  }
  return shown;
}

// Standard chatter followers (mail.followers) of a helpdesk.ticket. A follower is added through the ticket's own
// message_subscribe, or, when the caller asks to notify, through Odoo's invite wizard (mail.wizard.invite). No follower
// record is written directly, and subtype_ids is never sent, so existing followers keep their subscriptions.
const CONTACT_PAGE = 20;
const followerIds = async (env, id) => (await odoo(env, "mail.followers", "search_read",
  [[["res_model", "=", "helpdesk.ticket"], ["res_id", "=", id]]], { fields: ["partner_id"], limit: 500 }))
  .flatMap((r) => (Array.isArray(r.partner_id) ? [r.partner_id[0]] : []));

async function followersOf(env, id) {
  const ids = [...new Set(await followerIds(env, id))];
  const partners = ids.length ? await odoo(env, "res.partner", "read", [ids], { fields: ["name", "email"] }) : [];
  return partners.map((p) => ({ id: p.id, name: p.name || "", email: p.email || "" })).sort((a, b) => a.name.localeCompare(b.name));
}

// Existing active contacts whose name or email contains the term, one page at a time, with whether each already follows.
async function contactsFor(env, id, term, offset) {
  const q = term.replace(/[%_\\]/g, " ").trim();
  const following = new Set(await followerIds(env, id));
  const rows = await odoo(env, "res.partner", "search_read",
    [["&", ["active", "=", true], "|", ["name", "ilike", q], ["email", "ilike", q]]],
    { fields: ["name", "email"], order: "name asc", limit: CONTACT_PAGE + 1, offset });
  return { contacts: rows.slice(0, CONTACT_PAGE).map((p) => ({ id: p.id, name: p.name || "", email: p.email || "", following: following.has(p.id) })), hasMore: rows.length > CONTACT_PAGE };
}

// Adds the partners that are not following yet. Returns those added (none when all already follow).
async function addFollowers(env, id, partnerIds, notify) {
  const already = new Set(await followerIds(env, id));
  const fresh = partnerIds.filter((p) => !already.has(p));
  if (!fresh.length) return [];
  const active = await odoo(env, "res.partner", "search_read", [[["id", "in", fresh], ["active", "=", true]]], { fields: ["id"] });
  if (active.length !== fresh.length) throw new OdooError("Some contacts can't be added: they no longer exist or are inactive.", { definite: true });
  try {
    if (notify) {
      const wizard = await odoo(env, "mail.wizard.invite", "create", [{ res_model: "helpdesk.ticket", res_id: id, partner_ids: [[6, 0, fresh]], send_email: true }]);
      await odoo(env, "mail.wizard.invite", "action_invite", [[wizard]]);
    } else {
      await odoo(env, "helpdesk.ticket", "message_subscribe", [[id]], { partner_ids: fresh });
    }
  } catch (err) {
    // The call may have been saved even though no answer came back: read the followers before reporting a failure.
    const now = new Set(await followerIds(env, id));
    if (fresh.every((p) => now.has(p))) return fresh;
    throw err;
  }
  return fresh;
}

export async function odooRoutes(request, env, url, me) {
  const path = url.pathname, method = request.method;
  if (!odooConfigured(env)) return fail("odoo_off", "Odoo isn't connected. See SETUP.md.", 501);
  const isAdmin = me.role === "admin";
  if (!isAdmin && !me.dev) return fail("forbidden", "Your account has no developer name.", 403);

  try {
    const [users, allStages] = await Promise.all([odooUsers(env), stages(env)]);
    const maps = devMaps(env, users);
    const mine = (t) => isAdmin || (Array.isArray(t.user_id) && maps.toDev.get(t.user_id[0]) === me.dev);

    // List: every open ticket, plus closed ones the customer wrote to again (see conversation()). Candidates are every
    // open ticket and every ticket the customer wrote to in the last N days (it may be Solved or Cancelled).
    if (path === "/odoo/tickets" && method === "GET") {
      const days = Math.min(Math.max(Number(url.searchParams.get("closedDays")) || 30, 1), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace("T", " ");
      const wroteTo = [...new Set((await odoo(env, "mail.message", "search_read", [[["model", "=", "helpdesk.ticket"], ["message_type", "=", "email"], ["date", ">=", since]]], { fields: ["res_id"], limit: 3000 })).map((x) => x.res_id))];
      let domain = wroteTo.length ? ["|", ["stage_id.fold", "=", false], ["id", "in", wroteTo]] : [["stage_id.fold", "=", false]];
      if (!isAdmin) {
        const uidFor = maps.toUser.get(me.dev);
        if (!uidFor) return json({ tickets: [] });
        domain = ["&", ["user_id", "=", uidFor], ...domain];
      }
      const found = await odoo(env, "helpdesk.ticket", "search_read", [domain], { fields: FIELDS, order: "write_date desc", limit: 500 });
      await unassignNew(env, found);
      const rows = found.filter(mine);
      const shown = await conversation(env, rows, users, allStages);
      return json({ tickets: shown.map((t) => view(env, t, maps, allStages)) });
    }

    const m = /^\/odoo\/tickets\/(HD-\d+)(\/note|\/followers(?:\/search)?|\/attachments(?:\/\d{1,20})?)?$/.exec(path);
    if (!m) return fail("not_found", "Not found.", 404);
    const [t] = await odoo(env, "helpdesk.ticket", "search_read", [byRef(m[1])], { fields: [...FIELDS, "description"], limit: 1 });
    if (!t || !mine(t)) return fail("not_found", "No such Odoo ticket.", 404);
    const id = t.id;
    const teamId = Array.isArray(t.team_id) ? t.team_id[0] : 0;
    const teamStages = allStages.filter((s) => !teamId || !s.team_ids.length || s.team_ids.includes(teamId));

    // Download one file of this ticket through the proxy, so the Odoo login stays on the server.
    const file = /^\/attachments\/(\d{1,20})$/.exec(m[2] || "");
    if (file && method === "GET") {
      const fileId = Number(file[1]);
      let [x] = await ticketFiles(env, id, [["id", "=", fileId]]);
      // Or a file of one of this ticket's chatter messages.
      if (!x) {
        const onMessage = await odoo(env, "mail.message", "search_count", [[["model", "=", "helpdesk.ticket"], ["res_id", "=", id], ["attachment_ids", "in", [fileId]]]]);
        if (onMessage) [x] = await messageFiles(env, [fileId]);
      }
      if (!x) return fail("not_found", "No such attachment on this ticket.", 404);
      const [{ datas }] = await odoo(env, "ir.attachment", "read", [[x.id], ["datas"]]);
      if (!datas) return fail("not_found", "The file is missing.", 404);
      const bytes = Uint8Array.from(atob(datas), (c) => c.charCodeAt(0));
      const type = String(x.mimetype || "application/octet-stream").split(";")[0].trim();
      return new Response(bytes, { status: 200, headers: {
        "Content-Type": /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "application/octet-stream", "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(x.name || "attachment")
      } });
    }
    // Upload one file to the ticket (raw body, ?name=), to attach to the note being written. Up to 4 MB.
    if (m[2] === "/attachments" && method === "POST") {
      const name = String(url.searchParams.get("name") || "file").replace(/[\\/\r\n"<>:|?*\x00-\x1f]/g, "_").trim().slice(0, 150) || "file";
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.length) return fail("bad_request", "The file is empty.", 400);
      if (bytes.length > 4 * 1024 * 1024) return fail("too_large", "Files can be up to 4 MB.", 413);
      const type = String(request.headers.get("Content-Type") || "application/octet-stream").split(";")[0].trim();
      let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const fileId = await odoo(env, "ir.attachment", "create", [{ name, datas: btoa(bin), res_model: "helpdesk.ticket", res_id: id, ...(/^[\w.+-]+\/[\w.+-]+$/.test(type) ? { mimetype: type } : {}) }]);
      return json({ attachment: { id: fileId, filename: name, mimeType: type, size: bytes.length } }, 201);
    }
    // Followers: the same access as the ticket itself (administrators, or the ticket's developer).
    if (m[2] && m[2].startsWith("/followers")) {
      if (m[2] === "/followers" && method === "GET") return json({ followers: await followersOf(env, id) });
      if (m[2] === "/followers/search" && method === "GET") {
        const term = String(url.searchParams.get("q") || "").trim();
        if (term.length < 2 || term.length > 80) return fail("bad_request", "Type at least 2 letters of a name or email.", 400);
        const offset = Math.min(Math.max(Number(url.searchParams.get("offset")) || 0, 0), 5000);
        return json(await contactsFor(env, id, term, offset));
      }
      if (m[2] === "/followers" && method === "POST") {
        const b = await readJson(request);
        const ids = b && Array.isArray(b.partnerIds) ? b.partnerIds : null;
        if (!ids || !ids.length || ids.length > CONTACT_PAGE || ids.some((x) => !Number.isInteger(x) || x <= 0) || new Set(ids).size !== ids.length)
          return fail("bad_request", "Choose up to 20 different contacts.", 400);
        if (b.notify !== undefined && typeof b.notify !== "boolean") return fail("bad_request", "The notify option must be yes or no.", 400);
        let added;
        try {
          added = await addFollowers(env, id, ids, b.notify === true);
        } catch (err) {
          if (err && err.definite) return fail("odoo", err.message || "Odoo refused the change.", /access/i.test(err.kind || "") ? 403 : 422);
          return fail("odoo_unknown", "Odoo didn't confirm the change. Reload the followers before trying again.", 502);
        }
        return json({ followers: await followersOf(env, id), added: added.length });
      }
      return fail("not_found", "Not found.", 404);
    }
    if (m[2] && m[2] !== "/note") return fail("not_found", "Not found.", 404);

    if (!m[2] && method === "GET") {
      const msgs = await odoo(env, "mail.message", "search_read", [[["model", "=", "helpdesk.ticket"], ["res_id", "=", id], ["message_type", "in", ["comment", "email"]]]],
        { fields: ["body", "author_id", "email_from", "date", "subtype_id", "message_type", "attachment_ids"], order: "date asc", limit: 200 });
      const attachedIds = [...new Set(msgs.flatMap((x) => Array.isArray(x.attachment_ids) ? x.attachment_ids : []))].slice(0, 300);
      const [ticketOwn, onMessages] = await Promise.all([ticketFiles(env, id), messageFiles(env, attachedIds)]);
      const byId = new Map(onMessages.map((x) => [x.id, x]));
      // The ticket's attachments: its own files and every message's, once each, newest first.
      const files = [...new Map([...ticketOwn, ...onMessages].map((x) => [x.id, x])).values()].sort((a, b) => String(b.create_date || "").localeCompare(String(a.create_date || "")));
      return json({
        ticket: view(env, t, maps, allStages),
        description: clip(t.description),
        attachments: files.map(fileView),
        messages: msgs.filter((x) => String(x.body || "").replace(/<[^>]*>/g, "").trim() || (x.attachment_ids || []).length).map((x) => ({
          attachments: (x.attachment_ids || []).map((n) => byId.get(n)).filter(Boolean).map(fileView),
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
      const b = (await readJson(request)) || {}, text = String(b.text || "").trim();
      // Files uploaded to this ticket for the note (only this ticket's files can be attached).
      const fileIds = Array.isArray(b.attachmentIds) ? [...new Set(b.attachmentIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
      if (fileIds.length > 10) return fail("bad_request", "Attach up to 10 files to a note.", 400);
      if (fileIds.length && (await ticketFiles(env, id, [["id", "in", fileIds]])).length !== fileIds.length) return fail("bad_request", "A file isn't attached to this ticket. Add it again.", 400);
      if ((!text && !fileIds.length) || text.length > 20000) return fail("bad_request", "Write a note first.", 400);
      const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
      const toCustomer = b.toCustomer === true;
      if (toCustomer && !text) return fail("bad_request", "Write the reply first.", 400);
      const files = fileIds.length ? { attachment_ids: fileIds } : {};
      if (toCustomer) {
        // Sent to the customer by Odoo (and kept in the chatter), signed with the person's name.
        const body = "<p>" + esc(text).replace(/\n/g, "<br>") + "</p><p>— " + esc(me.name || me.email) + "</p>";
        const customer = Array.isArray(t.partner_id) ? { partner_ids: [t.partner_id[0]] } : {};
        await odoo(env, "helpdesk.ticket", "message_post", [[id]], { body, message_type: "comment", subtype_xmlid: "mail.mt_comment", ...customer, ...files });
        return json({ ok: true, replied: true }, 201);
      }
      const body = "<p>" + esc(text).replace(/\n/g, "<br>") + "</p><p><i>— " + esc(me.name || me.email) + ", via AION Team Control</i></p>";
      await odoo(env, "helpdesk.ticket", "message_post", [[id]], { body, message_type: "comment", subtype_xmlid: "mail.mt_note", ...files });
      return json({ ok: true }, 201);
    }
  } catch (err) {
    if (err && typeof err.status === "number" && typeof err.code === "string") throw err;
    console.log("odoo error:", err && err.message);
    return fail("odoo", "Odoo: " + ((err && err.message) || "unknown error"), 502);
  }
  return fail("not_found", "Not found.", 404);
}
