// Internal tickets: kept in the proxy's database, never sent to Jira. Keys are INT-1, INT-2, ...
// Administrators create them for any developer and can change everything. Users only see, create and
// work on tickets for their own developer name.
//
// Store keys: "it:<KEY>" ticket (JSON), "itickets" set of keys, "it:seq" counter for the next number,
// "ia:<attachment id>:<n>" the attachment's bytes in base64 chunks (files are listed on the ticket).

export const MAX_FILE = 4 * 1024 * 1024; // Vercel accepts request bodies up to 4.5 MB
export const MAX_FILES = 20;
const CHUNK = 700 * 1024;

const toB64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const cleanName = (n) => String(n || "file").replace(/[\\/\r\n"<>:|?*\x00-\x1f]/g, "_").trim().slice(0, 150) || "file";

async function saveFile(store, id, bytes) {
  const parts = Math.max(1, Math.ceil(bytes.length / CHUNK));
  for (let i = 0; i < parts; i++) await store.set("ia:" + id + ":" + i, toB64(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)));
  return parts;
}
async function readFile(store, a) {
  const out = new Uint8Array(a.size);
  let at = 0;
  for (let i = 0; i < a.parts; i++) {
    const c = await store.get("ia:" + a.id + ":" + i);
    if (c == null) return null;
    const b = fromB64(c); out.set(b, at); at += b.length;
  }
  return out;
}
async function dropFile(store, a) {
  for (let i = 0; i < (a.parts || 1); i++) await store.del("ia:" + a.id + ":" + i);
}

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
// The people a ticket can be assigned to: the team in TEAM_CONFIG (Karim, Youssef, Rami), by key.
function teamPeople(env) {
  try { return Object.keys(JSON.parse(env.TEAM_CONFIG || "{}").people || {}); } catch { return []; }
}

function applyFields(t, b, me, creating, people = []) {
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
  if (b.assignee !== undefined) {
    if (!creating && me.role !== "admin" && b.assignee !== t.assignee) return "Only administrators can change the assignee.";
    if (people.length && !people.includes(b.assignee)) return "Choose the assignee: " + people.join(", ") + ".";
    t.assignee = b.assignee;
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
    const t = { summary: "", description: "", priority: "Medium", due: null, status: "Open", assignee: null, devs: [], comments: [], dueHistory: [] };
    const people = teamPeople(env);
    if (people.length && b.assignee === undefined) return fail("bad_request", "Choose the assignee: " + people.join(", ") + ".", 400);
    const err = applyFields(t, { ...b, status: undefined, devs: me.role === "admin" ? b.devs || [] : [me.dev] }, me, true, people);
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

  const a = /^\/internal\/(INT-\d+)\/attachments(?:\/([a-f0-9]{32}))?$/.exec(path);
  if (a) {
    const t = await getTicket(store, a[1]);
    if (!t || !canSee(me, t)) return fail("not_found", "No such internal ticket.", 404);
    t.attachments = t.attachments || [];

    // Upload: the file's bytes are the request body; its name is in ?name=.
    if (!a[2] && method === "POST") {
      if (t.attachments.length >= MAX_FILES) return fail("bad_request", "A ticket can have at most " + MAX_FILES + " attachments.", 400);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.length) return fail("bad_request", "The file is empty.", 400);
      if (bytes.length > MAX_FILE) return fail("too_large", "Files can be up to 4 MB.", 413);
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
      const parts = await saveFile(store, id, bytes);
      const type = String(request.headers.get("Content-Type") || "").split(";")[0].trim();
      const att = { id, filename: cleanName(url.searchParams.get("name")), mimeType: /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "application/octet-stream", size: bytes.length, parts, created: now(), author: by(me) };
      t.attachments.push(att);
      t.updated = now();
      await saveTicket(store, t);
      return json({ ticket: view(t), attachment: att }, 201);
    }

    const att = a[2] && t.attachments.find((x) => x.id === a[2]);
    if (!att) return fail("not_found", "No such attachment.", 404);

    // Download: only through the proxy, so only people who can see the ticket get the file.
    if (method === "GET") {
      const bytes = await readFile(store, att);
      if (!bytes) return fail("not_found", "The file is missing.", 404);
      return new Response(bytes, { status: 200, headers: {
        "Content-Type": att.mimeType, "Content-Length": String(bytes.length), "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff", "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(att.filename)
      } });
    }

    if (method === "DELETE") {
      if (me.role !== "admin" && att.author.email !== me.email) return fail("forbidden", "Only administrators or the person who added it can remove an attachment.", 403);
      await dropFile(store, att);
      t.attachments = t.attachments.filter((x) => x.id !== att.id);
      t.updated = now();
      await saveTicket(store, t);
      return json({ ticket: view(t) });
    }
    return fail("not_found", "Not found.", 404);
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
    const err = applyFields(t, b, me, false, teamPeople(env));
    if (err) return fail("bad_request", err, 400);
    if (!t.devs.length) return fail("bad_request", "A ticket needs at least one developer.", 400);
    t.updated = now();
    t.updatedBy = by(me);
    await saveTicket(store, t);
    return json({ ticket: view(t), added: t.devs.filter((d) => !before.includes(d)) });
  }

  if (!m[2] && method === "DELETE") {
    if (me.role !== "admin") return fail("forbidden", "Only administrators can delete internal tickets.", 403);
    for (const att of t.attachments || []) await dropFile(store, att);
    await store.del("it:" + t.key);
    await store.srem("itickets", t.key);
    return json({ ok: true });
  }

  return fail("not_found", "Not found.", 404);
}
