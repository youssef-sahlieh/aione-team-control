// Odoo knowledge base, behind an extra password that administrators preset. The password is stored only as
// a PBKDF2 hash. Every list, add and edit needs the right password again, and failed attempts are counted
// and paused for 15 minutes after five misses. The page keeps the password in memory only, never in browser storage.
import { BusinessError, requireStore } from './ticket-metadata.js';
import { odooConfigured } from './odoo.js';
import { listArticles, saveArticle } from './knowledge-articles.js';

const LOCK_KEY = 'knowledge:lock:v1';
const FAILS_KEY = 'knowledge:failures:v1';
const ITERATIONS = 210000;
const MAX_FAILS = 5;
const PAUSE_SECONDS = 900;
const MIN_LENGTH = 8;
const MAX_LENGTH = 200;

const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
async function derive(password, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, material, 256);
  return hex(bits);
}
// Compares every character so the time taken does not show how much of the hash matched.
const same = (a, b) => { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; };

export const knowledgeLink = env => String(env.ODOO_URL).replace(/\/+$/, '') + '/odoo/knowledge';

async function readLock(env) { const raw = await requireStore(env).get(LOCK_KEY); return raw ? JSON.parse(raw) : null; }

export async function setKnowledgePassword(env, me, password) {
  if (me.role !== 'admin') throw new BusinessError('Only administrators can set the knowledge base password.', 403, 'forbidden');
  if (typeof password !== 'string' || password.length < MIN_LENGTH || password.length > MAX_LENGTH) throw new BusinessError(`Use a password of ${MIN_LENGTH} to ${MAX_LENGTH} characters.`, 400, 'weak_password');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const record = { v: 1, salt: hex(salt), hash: await derive(password, salt), iterations: ITERATIONS, updatedAt: new Date().toISOString(), by: me.email };
  await requireStore(env).set(LOCK_KEY, JSON.stringify(record));
  return { configured: true, updatedAt: record.updatedAt };
}

// Checks the extra password. Every knowledge action goes through here, so a wrong guess is always counted.
async function verifyKnowledgePassword(env, password) {
  if (!odooConfigured(env)) throw new BusinessError('Odoo is not connected.', 503, 'odoo_unavailable');
  const store = requireStore(env);
  const record = await readLock(env);
  if (!record) throw new BusinessError('No password has been set yet. An administrator sets it first.', 409, 'not_configured');
  const fails = Number(await store.get(FAILS_KEY)) || 0;
  if (fails >= MAX_FAILS) throw new BusinessError('Too many wrong passwords. Wait 15 minutes and try again.', 429, 'locked_out');
  const attempt = typeof password === 'string' ? await derive(password, Uint8Array.from(record.salt.match(/../g), h => parseInt(h, 16))) : '';
  if (!attempt || !same(attempt, record.hash)) {
    await store.incr(FAILS_KEY, PAUSE_SECONDS);
    throw new BusinessError('That password is not right.', 403, 'wrong_password');
  }
  await store.del(FAILS_KEY);
}

export async function unlockKnowledge(env, password) {
  await verifyKnowledgePassword(env, password);
  return { url: knowledgeLink(env), articles: await listArticles(env) };
}

export async function saveKnowledgeEntry(env, body) {
  await verifyKnowledgePassword(env, body.password);
  const saved = await saveArticle(env, { id: body.id ? Number(body.id) : null, name: body.name, text: body.text });
  return { ...saved, articles: await listArticles(env) };
}

export async function knowledgeStatus(env, me) {
  const record = await readLock(env);
  return { configured: !!record, updatedAt: record?.updatedAt || null, canSetPassword: me.role === 'admin', odoo: odooConfigured(env) };
}

const noStore = { 'Cache-Control': 'no-store' };
export async function knowledgeRoutes(request, env, me, path) {
  if (path === '/knowledge/status' && request.method === 'GET') return Response.json(await knowledgeStatus(env, me), { headers: noStore });
  if (path === '/knowledge/password' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return Response.json(await setKnowledgePassword(env, me, body.password), { headers: noStore });
  }
  if (path === '/knowledge/unlock' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return Response.json(await unlockKnowledge(env, body.password), { headers: noStore });
  }
  if (path === '/knowledge/save' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return Response.json(await saveKnowledgeEntry(env, body), { headers: noStore });
  }
  throw new BusinessError('Not found.', 404, 'not_found');
}
