// Odoo knowledge base: only admins set the extra password, it is stored hashed, wrong guesses are counted and paused,
// and entries are read and written through the shared Odoo API only with the right password.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../proxy/src/users.js';
import { setKnowledgePassword, unlockKnowledge, saveKnowledgeEntry, knowledgeStatus } from '../proxy/src/knowledge-lock.js';
import { toHtml, toText } from '../proxy/src/knowledge-articles.js';

const admin = { email: 'admin@example.invalid', name: 'Admin', role: 'admin' };
const user = { email: 'user@example.invalid', name: 'Developer', role: 'user' };
const setup = () => ({ STORE: memoryStore(), ODOO_URL: 'https://odoo.example.invalid/', ODOO_DB: 'db', ODOO_LOGIN: 'bot', ODOO_API_KEY: 'key' });
const code = (status, errorCode) => e => e.status === status && e.code === errorCode;

// A fake Odoo JSON-RPC server (the same endpoint the rest of the app uses) that keeps knowledge articles in memory.
function fakeOdoo() {
  const calls = [];
  const articles = [{ id: 7, name: 'Customer 554', body: '<p>login: shop<br>pass: a &amp; b</p>', write_date: '2026-11-01 10:00:00' }];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://odoo.example.invalid/jsonrpc')) return original(url, init);
    const body = JSON.parse(init.body);
    const { service, method, args } = body.params;
    const reply = (result) => Response.json({ jsonrpc: '2.0', id: body.id, result });
    if (service === 'common' && method === 'authenticate') return reply(args[2] === 'key' ? 7 : false);
    const [db, , key, model, m, a, kw = {}] = args;
    if (model !== 'knowledge.article') return reply(false);
    calls.push({ method: m, db, key, args: a, kwargs: kw });
    if (m === 'search_read') return reply(articles);
    if (m === 'create') { const id = 8; articles.push({ id, name: a[0][0].name, body: a[0][0].body, write_date: '2026-11-02 09:00:00' }); return reply([id]); }
    if (m === 'write') { Object.assign(articles.find(x => x.id === a[0][0]), a[1]); return reply(true); }
    return reply(false);
  };
  return { calls, articles, restore: () => { globalThis.fetch = original; } };
}

test('only administrators set the knowledge password, and it must be a usable length', async () => {
  const env = setup();
  await assert.rejects(setKnowledgePassword(env, user, 'long-enough-1'), code(403, 'forbidden'));
  await assert.rejects(setKnowledgePassword(env, admin, 'short'), code(400, 'weak_password'));
  assert.equal((await knowledgeStatus(env, user)).configured, false);
  await setKnowledgePassword(env, admin, 'long-enough-1');
  assert.equal((await knowledgeStatus(env, user)).configured, true);
  assert.equal((await knowledgeStatus(env, user)).canSetPassword, false);
});

test('the password is stored only as a hash', async () => {
  const env = setup();
  await setKnowledgePassword(env, admin, 'long-enough-1');
  const raw = await env.STORE.get('knowledge:lock:v1');
  assert.ok(!raw.includes('long-enough-1'));
});

test('unlocking returns the Odoo link and the entries read through the shared Odoo API', async () => {
  const env = setup(); const odoo = fakeOdoo();
  try {
    await setKnowledgePassword(env, admin, 'long-enough-1');
    await assert.rejects(unlockKnowledge(env, 'wrong-password'), code(403, 'wrong_password'));
    const result = await unlockKnowledge(env, 'long-enough-1');
    assert.equal(result.url, 'https://odoo.example.invalid/odoo/knowledge');
    assert.deepEqual(result.articles, [{ id: 7, name: 'Customer 554', text: 'login: shop\npass: a & b', updatedAt: '2026-11-01 10:00:00' }]);
    assert.equal(odoo.calls[0].method, 'search_read');
    assert.equal(odoo.calls[0].db, 'db');
    assert.equal(odoo.calls[0].key, 'key');
  } finally { odoo.restore(); }
});

test('unlocking before a password is set says so, and Odoo is not called', async () => {
  const odoo = fakeOdoo();
  try {
    await assert.rejects(unlockKnowledge(setup(), 'anything-long'), code(409, 'not_configured'));
    assert.equal(odoo.calls.length, 0);
  } finally { odoo.restore(); }
});

test('adding and editing entries needs the right password and never reaches Odoo with a wrong one', async () => {
  const env = setup(); const odoo = fakeOdoo();
  try {
    await setKnowledgePassword(env, admin, 'long-enough-1');
    await assert.rejects(saveKnowledgeEntry(env, { password: 'nope-nope-nope', name: 'New', text: 'x' }), code(403, 'wrong_password'));
    assert.equal(odoo.calls.length, 0);
    const added = await saveKnowledgeEntry(env, { password: 'long-enough-1', name: ' New customer ', text: 'pass: <b>1</b>\nnext' });
    assert.equal(added.id, 8);
    const created = odoo.calls.find(c => c.method === 'create');
    assert.equal(created.args[0][0].name, 'New customer');
    assert.equal(created.args[0][0].body, '<p>pass: &lt;b&gt;1&lt;/b&gt;<br>next</p>');
    const edited = await saveKnowledgeEntry(env, { password: 'long-enough-1', id: 7, name: 'Customer 554', text: 'login: changed' });
    assert.equal(edited.id, 7);
    assert.deepEqual(odoo.calls.find(c => c.method === 'write').args[0], [7]);
    assert.equal(edited.articles.find(a => a.id === 7).text, 'login: changed');
    await assert.rejects(saveKnowledgeEntry(env, { password: 'long-enough-1', name: '  ', text: 'x' }), code(400, 'invalid_name'));
  } finally { odoo.restore(); }
});

test('five wrong passwords pause attempts, even the right one; a right one before that clears the count', async () => {
  const env = setup(); const odoo = fakeOdoo();
  try {
    await setKnowledgePassword(env, admin, 'long-enough-1');
    for (let i = 0; i < 4; i++) await assert.rejects(unlockKnowledge(env, 'nope-nope-nope'), code(403, 'wrong_password'));
    assert.ok(await unlockKnowledge(env, 'long-enough-1'));
    for (let i = 0; i < 5; i++) await assert.rejects(unlockKnowledge(env, 'nope-nope-nope'), e => e.status === 403 || e.status === 429);
    await assert.rejects(unlockKnowledge(env, 'long-enough-1'), code(429, 'locked_out'));
  } finally { odoo.restore(); }
});

test('HTML text round trips: tags are dropped and line breaks and special characters are kept', () => {
  assert.equal(toHtml('a <b> & "c"\nd'), '<p>a &lt;b&gt; &amp; &quot;c&quot;<br>d</p>');
  assert.equal(toText('<p>x<br>y &amp;amp; &lt;z&gt;</p><p>w</p>'), 'x\ny &amp; <z>\nw');
});

test('when Odoo cannot be reached, the right password still passes and the error says so', async () => {
  const env = setup();
  const original = globalThis.fetch;
  try {
    await setKnowledgePassword(env, admin, 'long-enough-1');
    globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); };
    await assert.rejects(unlockKnowledge(env, 'long-enough-1'), e => e.status === 502 && e.code === 'odoo_unavailable' && /didn't answer/.test(e.message));
  } finally { globalThis.fetch = original; }
});

test('an error Odoo returns for the request is passed on as Odoo\'s own message', async () => {
  const env = setup();
  const original = globalThis.fetch;
  try {
    await setKnowledgePassword(env, admin, 'long-enough-1');
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.params.service === 'common') return Response.json({ jsonrpc: '2.0', id: body.id, result: 7 });
      return Response.json({ jsonrpc: '2.0', id: body.id, error: { message: 'Access Denied', data: { message: 'You are not allowed to read knowledge articles.', name: 'odoo.exceptions.AccessError' } } });
    };
    await assert.rejects(unlockKnowledge(env, 'long-enough-1'), e => e.status === 502 && e.code === 'odoo_error' && e.message === 'You are not allowed to read knowledge articles.');
  } finally { globalThis.fetch = original; }
});
