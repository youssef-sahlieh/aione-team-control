// Odoo knowledge base: only admins set the extra password, it is stored hashed, wrong guesses are counted and paused,
// and entries are read and written through Odoo's JSON-2 API only with the right password.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../proxy/src/users.js';
import { setKnowledgePassword, unlockKnowledge, saveKnowledgeEntry, knowledgeStatus } from '../proxy/src/knowledge-lock.js';
import { toHtml, toText } from '../proxy/src/knowledge-articles.js';

const admin = { email: 'admin@example.invalid', name: 'Admin', role: 'admin' };
const user = { email: 'user@example.invalid', name: 'Developer', role: 'user' };
const setup = () => ({ STORE: memoryStore(), ODOO_URL: 'https://odoo.example.invalid/', ODOO_DB: 'db', ODOO_LOGIN: 'bot', ODOO_API_KEY: 'key' });
const code = (status, errorCode) => e => e.status === status && e.code === errorCode;

// A fake Odoo JSON-2 endpoint that keeps knowledge articles in memory.
function fakeOdoo() {
  const calls = [];
  const articles = [{ id: 7, name: 'Customer 554', body: '<p>login: shop<br>pass: a &amp; b</p>', write_date: '2026-11-01 10:00:00' }];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://odoo.example.invalid/json/2/knowledge.article/')) return original(url, init);
    const method = String(url).split('/').pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body, headers: init.headers });
    if (method === 'search_read') return Response.json(articles);
    if (method === 'create') { const id = 8; articles.push({ id, name: body.vals_list[0].name, body: body.vals_list[0].body, write_date: '2026-11-02 09:00:00' }); return Response.json([id]); }
    if (method === 'write') { Object.assign(articles.find(a => a.id === body.ids[0]), body.vals); return Response.json(true); }
    return Response.json({ message: 'unknown' }, { status: 404 });
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

test('unlocking returns the Odoo link and the entries read through the JSON-2 API', async () => {
  const env = setup(); const odoo = fakeOdoo();
  try {
    await setKnowledgePassword(env, admin, 'long-enough-1');
    await assert.rejects(unlockKnowledge(env, 'wrong-password'), code(403, 'wrong_password'));
    const result = await unlockKnowledge(env, 'long-enough-1');
    assert.equal(result.url, 'https://odoo.example.invalid/odoo/knowledge');
    assert.deepEqual(result.articles, [{ id: 7, name: 'Customer 554', text: 'login: shop\npass: a & b', updatedAt: '2026-11-01 10:00:00' }]);
    assert.equal(odoo.calls[0].method, 'search_read');
    assert.equal(odoo.calls[0].headers.Authorization, 'bearer key');
    assert.equal(odoo.calls[0].headers['X-Odoo-Database'], 'db');
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
    assert.equal(created.body.vals_list[0].name, 'New customer');
    assert.equal(created.body.vals_list[0].body, '<p>pass: &lt;b&gt;1&lt;/b&gt;<br>next</p>');
    const edited = await saveKnowledgeEntry(env, { password: 'long-enough-1', id: 7, name: 'Customer 554', text: 'login: changed' });
    assert.equal(edited.id, 7);
    assert.deepEqual(odoo.calls.find(c => c.method === 'write').body.ids, [7]);
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

test('a correct password still unlocks when Odoo fails, and the reason says what went wrong', async () => {
  const env = setup();
  const original = globalThis.fetch;
  const failWith = (error) => { globalThis.fetch = async () => { throw error; }; };
  try {
    await setKnowledgePassword(env, admin, 'long-enough-1');
    failWith(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    await assert.rejects(unlockKnowledge(env, 'long-enough-1'), e => e.status === 502 && /took too long/.test(e.message));
    failWith(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }));
    await assert.rejects(unlockKnowledge(env, 'long-enough-1'), e => e.status === 502 && /Could not reach Odoo/.test(e.message));
    failWith(new TypeError('redirect mode is set to error'));
    await assert.rejects(unlockKnowledge(env, 'long-enough-1'), e => e.status === 502 && /redirected/.test(e.message));
  } finally { globalThis.fetch = original; }
});

test('a redirect from Odoo is not followed, and the error names the address to set in ODOO_URL', async () => {
  const env = setup();
  const original = globalThis.fetch;
  try {
    await setKnowledgePassword(env, admin, 'long-enough-1');
    globalThis.fetch = async () => new Response(null, { status: 308, headers: { Location: 'https://odoo.example.invalid/json/2/knowledge.article/search_read' } });
    await assert.rejects(unlockKnowledge(env, 'long-enough-1'), e => e.status === 502 && e.code === 'odoo_redirect' && /Set ODOO_URL to https:\/\/odoo\.example\.invalid\b/.test(e.message));
    const seen = [];
    globalThis.fetch = async (url, init) => { seen.push(init.redirect); throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); };
    await assert.rejects(unlockKnowledge(env, 'long-enough-1'), e => /redirected/.test(e.message));
    assert.deepEqual(seen, ['manual']);
  } finally { globalThis.fetch = original; }
});
