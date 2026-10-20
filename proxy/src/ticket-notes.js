import { listUsers, validEmail } from './users.js';
import { addToInbox } from './inbox.js';

const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control':'no-store'}});
const fail = (error, status = 400) => json({code:'ticket_notes', error}, status);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Separate storage prevents private notes from appearing in Jira or internal ticket comments.
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
  // Notes go between everyone in the dashboard (administrators and developers, not yourself), plus any
  // configured contacts. Administrators and contacts are the default choice; other people are opt-in.
  const people = (await listUsers(store)).filter(u => u.email !== me.email);
  const contacts = (env.INTERNAL_NOTE_RECIPIENTS || []).filter(r => validEmail(r.email) && r.email.endsWith('@'+env.MAIL_DOMAIN));
  const recipients = [...new Map([...people.map(u => ({email:u.email, name:u.name || u.email, role:u.role})), ...contacts.map(r => ({...r, role:'contact'}))].map(r => [r.email,{email:r.email,name:r.name || r.email,role:r.role}])).values()];
  // A note is seen by administrators, its writer and the people it was sent to.
  const visible = notes => notes.filter(n => me.role === 'admin' || n.author.email === me.email || (n.recipients || []).some(r => r.email === me.email));
  if (request.method === 'GET') return json({notes:visible(JSON.parse(await store.get(storageKey) || '[]')), recipients});
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 5000) return fail('Write a note (up to 5000 characters).');
  if (body.subject !== undefined && (typeof body.subject !== 'string' || body.subject.length > 200 || /[\r\n]/.test(body.subject))) return fail('Subject must be a single line up to 200 characters.');
  if (body.includeDetails !== undefined && typeof body.includeDetails !== 'boolean') return fail('Invalid ticket details option.');
  if (typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.id)) return fail('Invalid note identifier.');
  const lock = storageKey + ':lock', owner = crypto.randomUUID();
  if (!await store.setIfAbsent(lock, owner, 60)) return fail('Another note is being saved. Please retry.', 409);
  try {
    await store.setIfAbsent(storageKey, '[]', 315360000);
    let raw = await store.get(storageKey);
    const notes = JSON.parse(raw);
    const existing = notes.find(n => n.id === body.id);
    if (existing) return existing.author.email === me.email ? json({note:existing}) : fail('Invalid note identifier.', 409);
    const selected = body.recipients === undefined ? recipients.filter(r => r.role !== 'user').map(r => r.email) : body.recipients;
    if (!Array.isArray(selected) || !selected.length || selected.length > 30 || selected.some(email => typeof email !== 'string' || !recipients.some(r => r.email === email))) return fail('Choose one or more people from the recipient list.');
    const to = [...new Set(selected)];
    if (notes.length >= 500) return fail('This ticket has reached its note limit. Contact an admin.', 409);
    if (notes.filter(n => n.author.email === me.email && Date.parse(n.createdAt) > Date.now()-3600000).length >= 20) return fail('Too many notes. Try again later.', 429);
    const note = {id:body.id, key, text, subject:body.subject?.trim() || '[AION] Internal note: '+key, includeDetails:body.includeDetails !== false, recipients:recipients.filter(r => to.includes(r.email)), author:{email:me.email, name:me.name || me.email, dev:me.dev || null}, createdAt:new Date().toISOString(), notification:'pending'};
    notes.push(note);
    const save = async () => { const next = JSON.stringify(notes); if (!await store.compareAndSet(storageKey, raw, next)) throw new Error('Notes changed concurrently'); raw = next; };
    await save();
    try {
      if (!to.length) throw new Error('No recipients');
      const result = await sendMail(me.email, {to, subject:note.subject, html:'<p>From '+esc(note.author.name)+' ('+esc(me.email)+')</p><p style="white-space:pre-wrap">'+esc(text)+'</p>'+(note.includeDetails?'<hr><p><b>'+esc(key)+' — '+esc(ticket.title)+'</b></p><p><a href="'+esc(String(env.APP_URL || '').replace(/\/$/, '')+'/dashboard.html?page=tickets#'+key)+'">Open ticket in AION Team Control</a></p>':'')});
      note.notification = result.ok ? 'sent' : 'failed';
    } catch { note.notification = 'failed'; }
    await save();
    await addToInbox(store, to, {type:'note', key, title:ticket.title, by:note.author.name, text}, me.email);
    return json({note}, 201);
  } finally { await store.deleteIfValue(lock, owner); }
}
