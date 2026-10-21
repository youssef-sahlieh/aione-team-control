import { listUsers } from './users.js';

const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control':'no-store'}});
const fail = (error, status = 400) => json({code:'ticket_notes', error}, status);
const INBOX_LIMIT = 200;

// Internal notes are kept inside AION, like Jira comments: everyone who can open a ticket reads its notes, and
// anyone @mentioned gets an entry in their inbox. Nothing is emailed and nothing is posted to Jira.
export async function ticketNoteRoutes(request, env, url, me, {readTicket}) {
  const store = env.STORE;
  if (!store?.compareAndSet || !store?.setIfAbsent) return fail('Internal notes need the account database.', 503);
  if (!['GET','POST'].includes(request.method)) return fail('Use GET or POST for internal notes.', 405);
  let body;
  if (request.method === 'POST') {
    const raw = await request.text();
    if (raw.length > 12000) return fail('Note is too large.', 413);
    try { body = JSON.parse(raw); } catch { return fail('Invalid note.'); }
  }
  const key = body?.key ?? url.searchParams.get('key');
  if (typeof key !== 'string' || key.length > 80 || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key) || !['INT','HD',env.JIRA_PROJECT].includes(key.split('-')[0])) return fail('Choose a valid ticket.');
  const ticket = await readTicket(key);
  if (!ticket || (me.role !== 'admin' && (!me.dev || !ticket.devs.includes(me.dev)))) return fail('This ticket is unavailable.', 404);
  const storageKey = 'notes:' + env.JIRA_PROJECT + ':' + key;
  // People who can be @mentioned: everyone in the dashboard except yourself.
  const people = (await listUsers(store)).filter(u => u.email !== me.email).map(u => ({email:u.email, name:u.name || u.email, role:u.role}));
  if (request.method === 'GET') return json({notes: JSON.parse(await store.get(storageKey) || '[]'), people});
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 5000) return fail('Write a note (up to 5000 characters).');
  if (typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.id)) return fail('Invalid note identifier.');
  const mentionEmails = body.mentions === undefined ? [] : body.mentions;
  if (!Array.isArray(mentionEmails) || mentionEmails.length > 20 || mentionEmails.some(e => typeof e !== 'string' || !people.some(p => p.email === e))) return fail('Mention people from the list.');
  const mentioned = people.filter(p => mentionEmails.includes(p.email));
  const lock = storageKey + ':lock', owner = crypto.randomUUID();
  if (!await store.setIfAbsent(lock, owner, 60)) return fail('Another note is being saved. Please retry.', 409);
  try {
    await store.setIfAbsent(storageKey, '[]', 315360000);
    const raw = await store.get(storageKey);
    const notes = JSON.parse(raw);
    const existing = notes.find(n => n.id === body.id);
    if (existing) return existing.author.email === me.email ? json({note:existing}) : fail('Invalid note identifier.', 409);
    if (notes.length >= 500) return fail('This ticket has reached its note limit. Contact an admin.', 409);
    if (notes.filter(n => n.author.email === me.email && Date.parse(n.createdAt) > Date.now()-3600000).length >= 20) return fail('Too many notes. Try again later.', 429);
    const note = {id:body.id, key, text, author:{email:me.email, name:me.name || me.email, dev:me.dev || null}, mentions:mentioned, createdAt:new Date().toISOString()};
    if (!await store.compareAndSet(storageKey, raw, JSON.stringify([...notes, note]))) throw new Error('Notes changed concurrently');
    for (const person of mentioned) {
      try { await addInbox(store, person.email, {id:note.id, key, by:note.author.name, excerpt:text.slice(0, 140), createdAt:note.createdAt}); }
      catch { console.warn('Mention notification failed for one person.'); }
    }
    return json({note}, 201);
  } finally { await store.deleteIfValue(lock, owner); }
}

// GET /ticket-notes/inbox - the signed-in person's mentions, newest first.
// POST /ticket-notes/inbox {ids?} - mark those mentions read (all of them when ids is left out).
export async function ticketInboxRoutes(request, env, me) {
  const store = env.STORE;
  if (!store?.compareAndSet || !store?.setIfAbsent) return fail('Notifications need the account database.', 503);
  if (request.method === 'GET') {
    const items = await readInbox(store, me.email);
    return json({items: items.slice().reverse().slice(0, 100), unread: items.filter(i => !i.readAt).length});
  }
  if (request.method !== 'POST') return fail('Use GET or POST.', 405);
  const body = (await request.json().catch(() => null)) || {};
  if (body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.length > 200 || body.ids.some(id => typeof id !== 'string'))) return fail('Invalid notification list.');
  const ids = body.ids ? new Set(body.ids) : null, now = new Date().toISOString();
  await updateInbox(store, me.email, items => items.map(i => (!i.readAt && (!ids || ids.has(i.id)) ? {...i, readAt:now} : i)));
  const items = await readInbox(store, me.email);
  return json({unread: items.filter(i => !i.readAt).length});
}

const inboxKey = email => 'inbox:' + email.toLowerCase();
async function readInbox(store, email) {
  try { return JSON.parse(await store.get(inboxKey(email)) || '[]'); } catch { return []; }
}
async function updateInbox(store, email, change) {
  const k = inboxKey(email);
  await store.setIfAbsent(k, '[]', 315360000);
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await store.get(k);
    const next = JSON.stringify(change(JSON.parse(raw || '[]')).slice(-INBOX_LIMIT));
    if (await store.compareAndSet(k, raw, next)) return;
  }
  throw new Error('Inbox changed concurrently');
}
async function addInbox(store, email, item) {
  await updateInbox(store, email, items => [...items, {...item, readAt:null}]);
}
