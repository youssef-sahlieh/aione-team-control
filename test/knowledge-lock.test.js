// Odoo knowledge base: only admins set the extra password, it is stored hashed, wrong guesses are counted and paused,
// and entries are read and written through the shared Odoo API only with the right password.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../proxy/src/users.js';
import { setKnowledgePassword, unlockKnowledge, saveKnowledgeEntry, knowledgeStatus, knowledgeRoutes } from '../proxy/src/knowledge-lock.js';
import { toHtml, toText, resetFieldCache, pictureIds } from '../proxy/src/knowledge-articles.js';

const admin = { email: 'admin@example.invalid', name: 'Admin', role: 'admin' };
const user = { email: 'user@example.invalid', name: 'Developer', role: 'user' };
const setup = () => ({ STORE: memoryStore(), ODOO_URL: 'https://odoo.example.invalid/', ODOO_DB: 'db', ODOO_LOGIN: 'bot', ODOO_API_KEY: 'key' });
const code = (status, errorCode) => e => e.status === status && e.code === errorCode;

// A fake Odoo JSON-RPC server (the same endpoint the rest of the app uses) that keeps knowledge articles and their
// picture attachments in memory.
function fakeOdoo() {
  resetFieldCache();
  const calls = [];
  const articles = [
    { id: 7, name: 'Customer 554', body: '<p>login: shop<br>pass: a &amp; b</p>', write_date: '2026-11-01 10:00:00', parent_id: false, sequence: 2, icon: '🏪', category: 'workspace', is_article_item: false },
    { id: 9, name: 'Workflow', body: '<p>Steps</p><img src="/web/image/41?access_token=t1"><img src="/web/image/42-ab12/x.png"><img src="/web/content/43">', write_date: '2026-11-01 11:00:00', parent_id: [7, 'Customer 554'], sequence: 1, icon: false, category: 'workspace', is_article_item: false },
    { id: 10, name: 'Row of a list', body: '', write_date: '2026-11-01 11:00:00', parent_id: [9, 'Workflow'], sequence: 1, icon: false, category: 'workspace', is_article_item: true }
  ];
  const files = [
    { id: 41, res_model: 'knowledge.article', mimetype: 'image/png', file_size: 3, datas: 'AAAA' },
    { id: 42, res_model: 'knowledge.article', mimetype: 'image/jpeg', file_size: 3, datas: 'BBBB' },
    { id: 43, res_model: 'account.move', mimetype: 'image/png', file_size: 3, datas: 'SECRET' }
  ];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://odoo.example.invalid/jsonrpc')) return original(url, init);
    const body = JSON.parse(init.body);
    const { service, method, args } = body.params;
    const reply = (result) => Response.json({ jsonrpc: '2.0', id: body.id, result });
    if (service === 'common' && method === 'authenticate') return reply(args[2] === 'key' ? 7 : false);
    const [db, , key, model, m, a, kw = {}] = args;
    calls.push({ model, method: m, db, key, args: a, kwargs: kw });
    const pick = (row, fields) => Object.fromEntries([['id', row.id], ...fields.filter(f => f in row).map(f => [f, row[f]])]);
    if (model === 'ir.attachment') {
      if (m === 'read') return reply(files.filter(x => a[0].includes(x.id)).map(x => pick(x, a[1])));
      if (m === 'create') { files.push({ id: 50, ...a[0], file_size: 3 }); return reply(50); }
      if (m === 'generate_access_token') return reply(['tok50']);
      return reply(false);
    }
    if (model !== 'knowledge.article') return reply(false);
    if (m === 'fields_get') return reply({ name: {}, body: {}, parent_id: {}, sequence: {}, icon: {}, category: {}, is_article_item: {}, write_date: {} });
    if (m === 'search_read') return reply((a[0].length ? articles.filter(x => x.id === 9) : articles).map(x => pick(x, kw.fields)));
    if (m === 'read') return reply(articles.filter(x => a[0].includes(x.id)).map(x => pick(x, a[1])));
    if (m === 'create') { const id = articles.some(x => x.id === 8) ? 11 : 8; articles.push({ id, ...a[0][0], parent_id: a[0][0].parent_id ? [a[0][0].parent_id, ''] : false, write_date: '2026-11-02 09:00:00', is_article_item: false }); return reply([id]); }
    if (m === 'write') { Object.assign(articles.find(x => x.id === a[0][0]), a[1], { write_date: '2026-11-03 08:00:00' }); return reply(true); }
    if (m === 'move_to') { articles.find(x => x.id === a[0][0]).parent_id = kw.parent_id ? [kw.parent_id, ''] : false; return reply(true); }
    if (m === 'action_send_to_trash') { articles.splice(articles.findIndex(x => x.id === a[0][0]), 1); return reply(true); }
    return reply(false);
  };
  return { calls, articles, files, restore: () => { globalThis.fetch = original; } };
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
    assert.deepEqual(result.articles, [
      { id: 7, name: 'Customer 554', parentId: null, sequence: 2, icon: '🏪', category: 'workspace', updatedAt: '2026-11-01 10:00:00' },
      { id: 9, name: 'Workflow', parentId: 7, sequence: 1, icon: '', category: 'workspace', updatedAt: '2026-11-01 11:00:00' }
    ], 'the tree, without article items');
    assert.equal(odoo.calls[0].method, 'fields_get');
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
    assert.equal(odoo.articles.find(a => a.id === 7).body, '<p>login: changed</p>');
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

// Calls a knowledge route the way the page does. A refusal comes back as the BusinessError it throws.
const post = (env, path, body) => knowledgeRoutes(new Request('https://proxy.example.invalid' + path, { method: 'POST', body: JSON.stringify(body) }), env, user, path)
  .then(r => r.json());

test('an article opens with its pictures, and only Knowledge pictures are given out', async () => {
  const env = setup(); const odoo = fakeOdoo();
  try {
    await setKnowledgePassword(env, admin, 'long-enough-1');
    await assert.rejects(post(env, '/knowledge/article', { password: 'nope-nope-nope', id: 9 }), code(403, 'wrong_password'));
    const r = await post(env, '/knowledge/article', { password: 'long-enough-1', id: 9 });
    assert.equal(r.article.name, 'Workflow');
    assert.equal(r.article.parentId, 7);
    assert.match(r.article.body, /<img src="\/web\/image\/41/);
    assert.deepEqual(r.pictures, { 41: 'data:image/png;base64,AAAA', 42: 'data:image/jpeg;base64,BBBB' }, 'not the accounting file (43)');
    assert.deepEqual(pictureIds('<img alt="x" src="https://odoo.example.invalid/web/image/5?unique=1"><img src="/web/image/x">'), [5]);
  } finally { odoo.restore(); }
});

test('a nested article is added under its parent, edited with HTML, and refused if Odoo changed it meanwhile', async () => {
  const env = setup(); const odoo = fakeOdoo();
  try {
    await setKnowledgePassword(env, admin, 'long-enough-1');
    const added = await saveKnowledgeEntry(env, { password: 'long-enough-1', name: 'Step 2', body: '<h2>Two</h2>', parentId: 9 });
    assert.equal(added.id, 8);
    assert.equal(added.articles.find(a => a.id === 8).parentId, 9);
    assert.equal(odoo.calls.filter(c => c.method === 'create').at(-1).args[0][0].internal_permission, undefined, "a nested article takes its parent's access");
    await saveKnowledgeEntry(env, { password: 'long-enough-1', name: 'Root', body: '<p>x</p>' });
    assert.equal(odoo.calls.filter(c => c.method === 'create').at(-1).args[0][0].internal_permission, 'write', 'a top-level article goes to the Workspace');

    const saved = await saveKnowledgeEntry(env, { password: 'long-enough-1', id: 9, name: 'Workflow', body: '<p>New <b>steps</b></p>', icon: '📦', updatedAt: '2026-11-01 11:00:00' });
    assert.equal(saved.updatedAt, '2026-11-03 08:00:00');
    assert.equal(odoo.articles.find(a => a.id === 9).body, '<p>New <b>steps</b></p>');
    assert.equal(odoo.articles.find(a => a.id === 9).icon, '📦');
    await assert.rejects(saveKnowledgeEntry(env, { password: 'long-enough-1', id: 9, name: 'Workflow', body: '<p>old copy</p>', updatedAt: '2026-11-01 11:00:00' }), code(409, 'changed'));
    assert.equal(odoo.articles.find(a => a.id === 9).body, '<p>New <b>steps</b></p>');
  } finally { odoo.restore(); }
});

test('a picture added in the editor is attached to the article in Odoo with an access token', async () => {
  const env = setup(); const odoo = fakeOdoo();
  try {
    await setKnowledgePassword(env, admin, 'long-enough-1');
    const r = await post(env, '/knowledge/picture', { password: 'long-enough-1', articleId: 9, name: 'shot.png', type: 'image/png', data: 'iVBORw0K' });
    assert.deepEqual(r, { id: 50, src: '/web/image/50?access_token=tok50', picture: 'data:image/png;base64,iVBORw0K' });
    assert.deepEqual(odoo.files.at(-1), { id: 50, name: 'shot.png', datas: 'iVBORw0K', mimetype: 'image/png', res_model: 'knowledge.article', res_id: 9, file_size: 3 });
    await assert.rejects(post(env, '/knowledge/picture', { password: 'long-enough-1', articleId: 9, name: 'x.svg', type: 'image/svg+xml', data: 'AAAA' }), code(400, 'invalid_type'));
  } finally { odoo.restore(); }
});

test('articles are found by their text, moved and sent to the trash in Odoo', async () => {
  const env = setup(); const odoo = fakeOdoo();
  try {
    await setKnowledgePassword(env, admin, 'long-enough-1');
    assert.deepEqual((await post(env, '/knowledge/search', { password: 'long-enough-1', query: 'steps' })).ids, [9]);
    const moved = await post(env, '/knowledge/move', { password: 'long-enough-1', id: 9, parentId: null });
    assert.equal(moved.articles.find(a => a.id === 9).parentId, null);
    await assert.rejects(post(env, '/knowledge/move', { password: 'long-enough-1', id: 9, parentId: 9 }), code(400, 'invalid_parent'));
    const trashed = await post(env, '/knowledge/trash', { password: 'long-enough-1', id: 9 });
    assert.ok(!trashed.articles.some(a => a.id === 9));
    assert.equal(odoo.calls.find(c => c.method === 'action_send_to_trash').args[0][0], 9);
  } finally { odoo.restore(); }
});
