// Internal tickets: kept in the proxy's database, never sent to Jira. Keys are INT-1, INT-2, ...
// Administrators create them for any developer and can change everything. Users only see, create and
// work on tickets for their own developer name.
//
// Store keys: "it:<KEY>" ticket (JSON), "itickets" set of keys, "it:seq" counter for the next number.

import { normDev, validDev } from "./users.js";

export const STATUSES = [
  { name: "Open", cat: "new" },
  { name: "In Development", cat: "indeterminate" },
  { name: "Closed", cat: "done" }
];
export const PRIORITIES = ["Highest", "High", "Medium", "Low"];

const statusCat = (name) => (STATUSES.find((s) => s.name === name) || STATUSES[0]).cat;
const now = () => new Date().toISOString();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const fail = (code, error, status) => json({ code, error }, status);
async function readJson(request) { try { return await request.json(); } catch { return null; } }

async function getTicket(store, key) {
  const raw = await store.get("it:" + key);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
const saveTicket = (store, t) => store.set("it:" + t.key, JSON.stringify(t));

// A user may only reach tickets that include their developer name.
const canSee = (me, t) => me.role === "admin" || (me.dev && (t.devs || []).includes(me.dev));

function cleanDevs(list) {
  if (!Array.isArray(list)) return null;
  const devs = [...new Set(list.map(normDev).filter(Boolean))];
  return devs.length <= 10 && devs.every(validDev) ? devs : null;
}

const by = (me) => ({ email: me.email, name: me.name });

// Checks and applies the fields in b to ticket t. Returns an error message, or "" when fine.
function applyFields(t, b, me, creating) {
  if (b.summary !== undefined) {
    const s = String(b.summary).trim();
    if (!s || s.length > 200) return "Write a title (up to 200 characters).";
    t.summary = s;
  }
  if (b.description !== undefined) {
    const d = String(b.description);
    if (d.length > 20000) return "The description is too long.";
    t.description = d;
  }
  if (b.priority !== undefined) {
    if (!PRIORITIES.includes(b.priority)) return "Choose a priority.";
    t.priority = b.priority;
  }
  if (b.due !== undefined) {
    if (!(b.due === null || /^\d{4}-\d{2}-\d{2}$/.test(b.due))) return "Pick a valid due date.";
    if ((t.due || null) !== b.due) {
      if (!creating) t.dueHistory = [{ when: now(), by: me.name, from: t.due || null, to: b.due }, ...(t.dueHistory || [])].slice(0, 100);
      t.due = b.due;
    }
  }
  if (b.status !== undefined) {
    if (!STATUSES.some((s) => s.name === b.status)) return "Unknown status.";
    if (t.status !== b.status) {
      t.status = b.status;
      t.closedAt = b.status === "Closed" ? now() : null;
    }
  }
  if (b.devs !== undefined) {
    const devs = cleanDevs(b.devs);
    if (!devs) return "Developer names use letters, numbers, dots and dashes.";
    if (me.role !== "admin") {
      // Users can only work on tickets for themselves.
      if (devs.length !== 1 || devs[0] !== me.dev) return "You can only open tickets for yourself.";
    }
    t.devs = devs;
  }
  return "";
}

// What the dashboard gets: the ticket with its status category for the existing views.
const view = (t) => ({ ...t, statusCat: statusCat(t.status), internal: true });

export async function internalRoutes(request, env, url, me) {
  const store = env.STORE, path = url.pathname, method = request.method;
  if (!store) return fail("no_store", "Internal tickets need the database. See SETUP.md.", 501);
  if (me.role !== "admin" && !me.dev) return fail("forbidden", "Your account has no developer name.", 403);

  if (path === "/internal" && method === "GET") {
    const keys = (await store.smembers("itickets")) || [];
    const all = (await Promise.all(keys.map((k) => getTicket(store, k)))).filter(Boolean);
    return json({ tickets: all.filter((t) => canSee(me, t)).map(view), statuses: STATUSES, priorities: PRIORITIES });
  }

  if (path === "/internal" && method === "POST") {
    const b = (await readJson(request)) || {};
    const t = { summary: "", description: "", priority: "Medium", due: null, status: "Open", devs: [], comments: [], dueHistory: [] };
    const err = applyFields(t, { ...b, status: undefined, devs: me.role === "admin" ? b.devs || [] : [me.dev] }, me, true);
    if (err) return fail("bad_request", err, 400);
    if (!t.summary) return fail("bad_request", "Write a title.", 400);
    if (me.role === "admin" && !t.devs.length) return fail("bad_request", "Choose at least one developer.", 400);
    t.key = "INT-" + (await store.incr("it:seq"));
    t.created = t.updated = now();
    t.createdBy = by(me);
    await saveTicket(store, t);
    await store.sadd("itickets", t.key);
    return json({ ticket: view(t) }, 201);
  }

  const m = /^\/internal\/(INT-\d+)(\/comment)?$/.exec(path);
  if (!m) return fail("not_found", "Not found.", 404);
  const t = await getTicket(store, m[1]);
  if (!t || !canSee(me, t)) return fail("not_found", "No such internal ticket.", 404);

  if (m[2] && method === "POST") {
    const text = String(((await readJson(request)) || {}).text || "").trim();
    if (!text || text.length > 20000) return fail("bad_request", "Write a comment first.", 400);
    t.comments = [...(t.comments || []), { author: by(me), created: now(), body: text }].slice(-500);
    t.updated = now();
    await saveTicket(store, t);
    return json({ ticket: view(t) }, 201);
  }

  if (!m[2] && method === "PUT") {
    const b = (await readJson(request)) || {};
    const before = [...(t.devs || [])];
    const err = applyFields(t, b, me, false);
    if (err) return fail("bad_request", err, 400);
    if (!t.devs.length) return fail("bad_request", "A ticket needs at least one developer.", 400);
    t.updated = now();
    t.updatedBy = by(me);
    await saveTicket(store, t);
    return json({ ticket: view(t), added: t.devs.filter((d) => !before.includes(d)) });
  }

  if (!m[2] && method === "DELETE") {
    if (me.role !== "admin") return fail("forbidden", "Only administrators can delete internal tickets.", 403);
    await store.del("it:" + t.key);
    await store.srem("itickets", t.key);
    return json({ ok: true });
  }

  return fail("not_found", "Not found.", 404);
}
