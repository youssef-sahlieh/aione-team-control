// Each person's dashboard notifications: @mentions in comments and internal notes sent to them.
// New tickets are worked out in the browser from the loaded tickets and the "seen" time kept here.
//
// Store keys: "inbox:<email>" newest-first list (JSON, last 100), "inbox-seen:<email>" when the bell was last opened.
import { listUsers, validEmail } from "./users.js";

const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const KEEP = 100, YEARS = 315360000;
const norm = (e) => String(e || "").trim().toLowerCase();

// Adds one item to each person's inbox (never to the person who caused it). Failures never block the action.
export async function addToInbox(store, emails, item, from) {
  if (!store?.get || !store?.set) return;
  const entry = { id: crypto.randomUUID(), at: new Date().toISOString(), type: item.type, key: item.key, title: String(item.title || "").slice(0, 200), by: item.by || "", text: String(item.text || "").replace(/\s+/g, " ").trim().slice(0, 240) };
  for (const email of new Set(emails.map(norm))) {
    if (!email || email === norm(from)) continue;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await store.get("inbox:" + email);
        const next = JSON.stringify([entry, ...JSON.parse(raw || "[]")].slice(0, KEEP));
        if (!store.compareAndSet || raw === null) { await store.set("inbox:" + email, next, YEARS); break; }
        if (await store.compareAndSet("inbox:" + email, raw, next)) break;
      }
    } catch { console.warn("inbox_failed"); }
  }
}

// The people who can be @mentioned: everyone with a dashboard account plus the fixed note contacts.
export async function mentionablePeople(env) {
  const users = env.STORE?.smembers ? await listUsers(env.STORE) : [];
  const contacts = (env.INTERNAL_NOTE_RECIPIENTS || []).filter((r) => validEmail(r.email) && r.email.endsWith("@" + env.MAIL_DOMAIN));
  const all = new Map();
  for (const u of users) all.set(norm(u.email), { email: norm(u.email), name: u.name || u.email, dev: u.dev || "", role: u.role });
  for (const c of contacts) if (!all.has(norm(c.email))) all.set(norm(c.email), { email: norm(c.email), name: c.name || c.email, dev: "", role: "contact" });
  return [...all.values()];
}

// Jira mentions are account ids ([~accountid:X]). Team people in TEAM_CONFIG link an account id to a
// team key; the dashboard user with that developer name (or first name) gets the notification.
export async function jiraMentionEmails(env, text) {
  const ids = [...String(text || "").matchAll(/\[~accountid:([\w:-]{1,128})\]/g)].map((m) => m[1]);
  if (!ids.length) return [];
  let team = {};
  try { team = JSON.parse(env.TEAM_CONFIG || "{}").people || {}; } catch {}
  const people = await mentionablePeople(env), first = (s) => String(s || "").trim().split(/\s+/)[0].toLowerCase();
  const out = [];
  for (const [k, p] of Object.entries(team)) {
    if (!ids.includes(p?.id)) continue;
    const match = people.find((u) => u.dev && u.dev.toLowerCase() === k.toLowerCase()) || people.find((u) => first(u.name) === first(p.name) || first(u.name) === k.toLowerCase());
    if (match) out.push(match.email);
  }
  return out;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Someone was @mentioned in a comment: a dashboard notification, and an email when mail is set up.
// Returns the names of the people notified. Only dashboard people can be notified this way.
export async function notifyMentions(env, me, { emails, key, title, text, sendMail }) {
  const people = await mentionablePeople(env), wanted = new Set((emails || []).map(norm));
  const to = people.filter((p) => wanted.has(p.email) && p.email !== norm(me.email));
  if (!to.length) return [];
  const by = me.name || me.email;
  await addToInbox(env.STORE, to.map((p) => p.email), { type: "mention", key, title, by, text }, me.email);
  if (sendMail) {
    const link = String(env.APP_URL || "").replace(/\/$/, "") + "/dashboard.html?page=tickets#" + key;
    try {
      await sendMail(me.email, { to: to.map((p) => p.email), subject: "[AION] " + by + " mentioned you on " + key, html: "<p>" + esc(by) + " mentioned you in a comment on <b>" + esc(key) + "</b> — " + esc(title) + ":</p><blockquote style=\"white-space:pre-wrap\">" + esc(text) + "</blockquote><p><a href=\"" + esc(link) + "\">Open the ticket in AION Team Control</a></p>" });
    } catch { console.warn("mention_mail_failed"); }
  }
  return to.map((p) => p.name);
}

export async function inboxRoutes(request, env, url, me) {
  const store = env.STORE;
  if (!store?.get || !store?.set) return json({ items: [], seenAt: null, off: true });
  const email = norm(me.email);
  if (request.method === "GET" && url.pathname.endsWith("/inbox")) {
    let seenAt = await store.get("inbox-seen:" + email);
    // First visit: start now, so older tickets don't all show up as new.
    if (!seenAt) { seenAt = new Date().toISOString(); await store.set("inbox-seen:" + email, seenAt, YEARS); }
    return json({ items: JSON.parse((await store.get("inbox:" + email)) || "[]"), seenAt });
  }
  if (request.method === "POST" && url.pathname.endsWith("/inbox/seen")) {
    const seenAt = new Date().toISOString();
    await store.set("inbox-seen:" + email, seenAt, YEARS);
    return json({ seenAt });
  }
  if (request.method === "POST" && url.pathname.endsWith("/inbox/clear")) {
    await store.set("inbox:" + email, "[]", YEARS);
    return json({ items: [] });
  }
  return json({ code: "not_found", error: "Not found." }, 404);
}
