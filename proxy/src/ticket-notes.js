import { listUsers } from './users.js';
import { notifyMentions } from './inbox.js';

const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control':'no-store'}});
const fail = (error, status = 400) => json({code:'ticket_notes', error}, status);

// Internal notes are kept inside AION, like Jira comments: everyone who can open a ticket reads its notes, and
// anyone @mentioned gets an entry in their notification inbox and an email. Nothing is posted to Jira.
export async function ticketNoteRoutes(request, env, url, me, {readTicket, sendMail}) {
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
    const note = {id:body.id, key, text, author:{email:me.email, name:me.name || me.email, dev:me.dev || null}, mentions:mentioned.map(p => ({email:p.email, name:p.name})), createdAt:new Date().toISOString()};
    if (!await store.compareAndSet(storageKey, raw, JSON.stringify([...notes, note]))) throw new Error('Notes changed concurrently');
    if (mentioned.length) {
      try { await notifyMentions(env, me, {emails:mentioned.map(p => p.email), key, title:ticket.title, text, sendMail, type:'note'}); }
      catch { console.warn('Mention notification failed.'); }
    }
    return json({note}, 201);
  } finally { await store.deleteIfValue(lock, owner); }
}
