// Local ticket history: who changed what from this dashboard. Jira records every change under the one
// account whose API token the proxy uses, so this log keeps the real signed-in person for each change.
//
// Store key: "tlog:<KEY>" -> JSON array of events, oldest first, at most MAX. An event:
//   { at, by: { email, name }, action, changes: { field: { from, to } }, text?, commentId? }
// action: "status" | "assignee" | "developers" | "comment" | "due" | "edit" | "created".

const MAX = 300;
const logKey = (key) => "tlog:" + key;
const clip = (v, n = 300) => (v == null ? v : String(v).slice(0, n));

// Adds one event. Never throws: a log write must not undo or fail the change it describes.
export async function recordTicketEvent(env, key, me, event) {
  const store = env.STORE;
  if (!store || !me || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return;
  const entry = { at: new Date().toISOString(), by: { email: me.email, name: me.name || me.email }, ...event };
  if (entry.text) entry.text = clip(entry.text);
  for (const f of Object.keys(entry.changes || {})) entry.changes[f] = { from: clip(entry.changes[f].from), to: clip(entry.changes[f].to) };
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const raw = await store.get(logKey(key));
      const next = JSON.stringify([...(raw ? JSON.parse(raw) : []), entry].slice(-MAX));
      const saved = raw === null || raw === undefined
        ? (store.setIfAbsent ? await store.setIfAbsent(logKey(key), next, 315360000) : (await store.set(logKey(key), next), true))
        : store.compareAndSet ? await store.compareAndSet(logKey(key), raw, next) : (await store.set(logKey(key), next), true);
      if (saved) return;
    }
  } catch { console.warn("ticket_log_failed"); }
}

export async function readTicketLog(env, key) {
  try { return JSON.parse((await env.STORE?.get(logKey(key))) || "[]"); } catch { return []; }
}

// GET /ticket-log?key=KEY - the ticket's local history, for people who may see the ticket.
export async function ticketLogRoutes(request, env, url, readTicket) {
  const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
  if (request.method !== "GET") return json({ code: "method", error: "Ticket history is read-only." }, 405);
  const key = url.searchParams.get("key") || "";
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return json({ code: "bad_request", error: "Choose a ticket." }, 400);
  if (!(await readTicket(key))) return json({ code: "not_found", error: "Ticket unavailable." }, 404);
  return json({ events: await readTicketLog(env, key) });
}
