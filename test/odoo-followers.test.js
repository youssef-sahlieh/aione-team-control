// Helpdesk followers: the standard chatter followers of an Odoo ticket, read and added through the proxy. Every Odoo call
// goes to a fake JSON-RPC server in memory (no request leaves the test), and the fake records each call so the tests can
// check exactly which methods ran.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { makeToken } from '../proxy/src/handler.js';
import { memoryStore, saveUser } from '../proxy/src/users.js';

const ODOO = 'https://odoo.example.invalid';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const users = {
  admin: { email: 'admin@example.invalid', name: 'Manager', role: 'admin', dev: 'builder', v: 1 },
  rami: { email: 'rami@aione.invalid', name: 'Rami Ahmad', role: 'user', dev: 'rami', v: 1 },
  sondos: { email: 'sondos@aione.invalid', name: 'Sondos Ali', role: 'user', dev: 'sondos', v: 1 },
};

// Partners: 30-33 are named contacts (32 is archived), 100-121 are a bulk list for paging.
function fakeOdoo() {
  const calls = [];
  const partners = [
    { id: 30, name: 'Ariel Amiri', email: 'ariel@example.invalid', active: true },
    { id: 31, name: 'Karim Ali', email: 'karim@example.invalid', active: true },
    { id: 32, name: 'Old Contact', email: 'old@example.invalid', active: false },
    { id: 33, name: 'Dana Haddad', email: 'dana@example.invalid', active: true },
    ...Array.from({ length: 22 }, (_, i) => ({ id: 100 + i, name: `Bulk ${String(i).padStart(2, '0')}`, email: `bulk${i}@example.invalid`, active: true })),
  ];
  const ticket = { id: 900, name: 'Printer jam', ticket_ref: '302', user_id: [5, 'Rami Ahmad'], stage_id: [1, 'New'],
    partner_id: [30, 'Ariel Amiri'], partner_name: 'Ariel Amiri', partner_email: 'ariel@example.invalid', priority: '1', team_id: false,
    create_date: '2026-11-01 09:00:00', write_date: '2026-11-02 09:00:00', close_date: false, sla_deadline: false, description: '<p>Synthetic</p>' };
  // Dana follows already, with a customised subscription (subtype 1 and 7): it must survive every change below.
  const followers = [{ id: 1, res_model: 'helpdesk.ticket', res_id: 900, partner_id: [33, 'Dana Haddad'], subtype_ids: [1, 7] }];
  const state = { failNext: '', nextId: 2, wizards: 0 };
  const messages = [];

  const subscribe = (ids, subtypes = [1]) => {
    for (const pid of ids) if (!followers.some((f) => f.partner_id[0] === pid)) followers.push({ id: state.nextId++, res_model: 'helpdesk.ticket', res_id: 900, partner_id: [pid, ''], subtype_ids: subtypes });
  };
  const rowsFor = (domain) => {
    const flat = JSON.stringify(domain);
    let rows = partners;
    if (flat.includes('"active"')) rows = rows.filter((p) => p.active);
    const q = /"ilike","([^"]*)"/.exec(flat);
    if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q[1].toLowerCase()) || p.email.toLowerCase().includes(q[1].toLowerCase()));
    const ids = /"id","in",\[([\d,]+)\]/.exec(flat);
    if (ids) { const set = ids[1].split(',').map(Number); rows = rows.filter((p) => set.includes(p.id)); }
    return rows;
  };

  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith(ODOO + '/jsonrpc')) return originalFetch(url, init);
    const body = JSON.parse(init.body);
    const { service, method, args } = body.params;
    const reply = (result) => Response.json({ jsonrpc: '2.0', id: body.id, result });
    const fail = (message, name) => Response.json({ jsonrpc: '2.0', id: body.id, error: { message, data: { message, name } } });
    if (service === 'common') return reply(7);
    const [, , , model, m, a, kw = {}] = args;
    calls.push({ model, method: m, args: a, kwargs: kw });

    if (model === 'res.users') return reply([{ id: 5, name: 'Rami Ahmad', login: 'rami@aione.invalid', email: 'rami@aione.invalid', partner_id: [21, 'Rami'] },
      { id: 6, name: 'Sondos Ali', login: 'sondos@aione.invalid', email: 'sondos@aione.invalid', partner_id: [22, 'Sondos'] }]);
    if (model === 'helpdesk.ticket' && m === 'search_read') return reply(JSON.stringify(a[0]).includes('"302"') ? [ticket] : []);
    if (model === 'mail.followers' && m === 'search_read') {
      return reply(followers.filter((f) => f.res_id === 900).map((f) => ({ ...f, partner_id: [f.partner_id[0], (partners.find((p) => p.id === f.partner_id[0]) || {}).name || ''] })));
    }
    if (model === 'res.partner') {
      if (m === 'search_read') return reply(rowsFor(a[0]).slice(kw.offset || 0, (kw.offset || 0) + (kw.limit || 80)).map((p) => ({ id: p.id, name: p.name, email: p.email })));
      if (m === 'read') return reply(partners.filter((p) => a[0].includes(p.id)).map((p) => ({ id: p.id, name: p.name, email: p.email })));
    }
    if (model === 'helpdesk.ticket' && m === 'message_subscribe') {
      if (state.failNext === 'reject') { state.failNext = ''; return fail('You are not allowed to follow this ticket.', 'odoo.exceptions.AccessError'); }
      if (state.failNext === 'drop') { state.failNext = ''; throw new TypeError('socket hang up'); }
      subscribe(kw.partner_ids);
      if (state.failNext === 'lost') { state.failNext = ''; throw new TypeError('socket hang up'); }
      return reply(true);
    }
    if (model === 'mail.wizard.invite' && m === 'create') { state.wizards += 1; return reply(state.wizards); }
    if (model === 'mail.wizard.invite' && m === 'action_invite') {
      const wiz = calls.filter((c) => c.model === 'mail.wizard.invite' && c.method === 'create').at(-1).args[0];
      subscribe(wiz.partner_ids[0][2]);
      messages.push({ kind: 'invite', partners: wiz.partner_ids[0][2], send_email: wiz.send_email });
      return reply(true);
    }
    if (model === 'mail.message' && m === 'create') { messages.push(a[0]); return reply(messages.length); }
    if (m === 'search_read' || m === 'search') return reply([]);
    return reply(false);
  };
  return { calls, followers, state, partners, messages };
}

async function setup() {
  const env = { SESSION_SECRET: 'synthetic-secret', JIRA_PROJECT: 'AION', JIRA_SITE: 'https://jira.invalid', STORE: memoryStore(),
    TIME_SYNC_SECRET: 's'.repeat(32), MAIL_DOMAIN: 'example.invalid', ODOO_URL: ODOO, ODOO_DB: 'synthetic', ODOO_LOGIN: 'synthetic', ODOO_API_KEY: 'synthetic',
    TEAM_CONFIG: JSON.stringify({ devEmails: { rami: 'rami@aione.invalid', sondos: 'sondos@aione.invalid' } }) };
  const fake = fakeOdoo();
  const tokens = {};
  for (const [k, u] of Object.entries(users)) {
    await saveUser(env.STORE, u);
    tokens[k] = (await makeToken(env, u.email, Date.now(), 1)).token;
  }
  const call = async (as, path, method = 'GET', body) => {
    const r = await worker.fetch(new Request('https://proxy.invalid' + path, { method, headers: { Authorization: 'Bearer ' + tokens[as], 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { ...fake, call };
}

const names = (data) => data.followers.map((f) => f.name);
const mailCalls = (s) => s.calls.filter((c) => c.model !== 'res.users' && c.model !== 'res.partner' && c.model !== 'mail.followers' && c.model !== 'helpdesk.stage' && c.model !== 'ir.attachment');

test('followers of an Odoo ticket are read from the record behind its ticket number, with names and emails', async () => {
  const s = await setup();
  const r = await s.call('admin', '/odoo/tickets/HD-302/followers');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.followers, [{ id: 33, name: 'Dana Haddad', email: 'dana@example.invalid' }]);
  // Followers are looked up on the ticket's record id (900), never on the dashboard number (302).
  const lookup = s.calls.find((c) => c.model === 'mail.followers');
  assert.deepEqual(lookup.args[0], [['res_model', '=', 'helpdesk.ticket'], ['res_id', '=', 900]]);
});

test('a developer sees only the followers of their own tickets; other tickets answer not found', async () => {
  const s = await setup();
  assert.equal((await s.call('rami', '/odoo/tickets/HD-302/followers')).status, 200);
  s.calls.length = 0;
  assert.equal((await s.call('sondos', '/odoo/tickets/HD-302/followers')).status, 404);
  assert.equal((await s.call('sondos', '/odoo/tickets/HD-302/followers/search?q=ariel')).status, 404);
  assert.equal((await s.call('sondos', '/odoo/tickets/HD-302/followers', 'POST', { partnerIds: [30] })).status, 404);
  assert.equal(s.calls.some((c) => c.model === 'mail.followers' || c.model === 'res.partner' || c.method === 'message_subscribe'), false, 'no follower or contact data read or written for the denied developer');
});

test('contact search is by name or email, excludes archived contacts, and pages with a bounded size', async () => {
  const s = await setup();
  assert.equal((await s.call('admin', '/odoo/tickets/HD-302/followers/search?q=a')).status, 400, 'one letter is refused');
  const found = await s.call('admin', '/odoo/tickets/HD-302/followers/search?q=ariel');
  assert.deepEqual(found.data.contacts.map((c) => [c.id, c.following]), [[30, false]]);
  const byEmail = await s.call('admin', '/odoo/tickets/HD-302/followers/search?q=dana@');
  assert.deepEqual(byEmail.data.contacts, [{ id: 33, name: 'Dana Haddad', email: 'dana@example.invalid', following: true }]);
  assert.equal((await s.call('admin', '/odoo/tickets/HD-302/followers/search?q=old')).data.contacts.length, 0, 'archived contacts are not offered');
  const page1 = await s.call('admin', '/odoo/tickets/HD-302/followers/search?q=bulk');
  assert.equal(page1.data.contacts.length, 20);
  assert.equal(page1.data.hasMore, true);
  const page2 = await s.call('admin', '/odoo/tickets/HD-302/followers/search?q=bulk&offset=20');
  assert.deepEqual(page2.data.contacts.map((c) => c.name), ['Bulk 20', 'Bulk 21']);
  assert.equal(page2.data.hasMore, false);
  const search = s.calls.filter((c) => c.model === 'res.partner' && c.method === 'search_read').at(-1);
  assert.equal(search.kwargs.limit, 21, 'Odoo is asked for one page plus one, never the whole directory');
});

test('adding followers subscribes only the new contacts and leaves existing subscriptions untouched', async () => {
  const s = await setup();
  const r = await s.call('admin', '/odoo/tickets/HD-302/followers', 'POST', { partnerIds: [31, 33] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.added, 1, 'Dana already follows, so only Karim is added');
  const sub = s.calls.find((c) => c.method === 'message_subscribe');
  assert.deepEqual(sub.args, [[900]]);
  assert.deepEqual(sub.kwargs, { partner_ids: [31] }, 'no subtype_ids: existing followers keep theirs');
  assert.deepEqual(r.data.followers.map((f) => f.id).sort(), [31, 33]);
  assert.deepEqual(s.followers.find((f) => f.partner_id[0] === 33).subtype_ids, [1, 7], 'Dana’s subscription is unchanged');
  assert.equal(s.calls.some((c) => c.model === 'mail.followers' && c.method !== 'search_read'), false, 'no follower record is written directly');
  assert.equal(s.calls.some((c) => c.model === 'helpdesk.ticket' && ['write', 'create'].includes(c.method)), false, 'customer, assignee and Watchers are not written');
  assert.equal(s.messages.length, 0, 'no chatter message is posted by the proxy');
});

test('choosing only existing followers adds nothing and calls nothing', async () => {
  const s = await setup();
  const r = await s.call('admin', '/odoo/tickets/HD-302/followers', 'POST', { partnerIds: [33] });
  assert.equal(r.status, 200);
  assert.equal(r.data.added, 0);
  assert.equal(s.calls.some((c) => c.method === 'message_subscribe'), false);
});

test('invalid selections are refused before Odoo is asked to change anything', async () => {
  const s = await setup();
  const bad = [{ partnerIds: [] }, { partnerIds: ['31'] }, { partnerIds: [31, 31] }, { partnerIds: [0] }, { partnerIds: Array.from({ length: 21 }, (_, i) => 100 + i) },
    { partnerIds: [31], notify: 'yes' }, {}];
  for (const body of bad) assert.equal((await s.call('admin', '/odoo/tickets/HD-302/followers', 'POST', body)).status, 400, JSON.stringify(body));
  const archived = await s.call('admin', '/odoo/tickets/HD-302/followers', 'POST', { partnerIds: [32] });
  assert.equal(archived.status, 422);
  assert.match(archived.data.error, /can't be added/);
  assert.equal(s.calls.some((c) => c.method === 'message_subscribe' || c.model === 'mail.wizard.invite'), false);
});

test('notify: the invite wizard sends the email only for the newly selected followers', async () => {
  const s = await setup();
  const r = await s.call('admin', '/odoo/tickets/HD-302/followers', 'POST', { partnerIds: [31, 33], notify: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const create = s.calls.find((c) => c.model === 'mail.wizard.invite' && c.method === 'create').args[0];
  assert.deepEqual(create, { res_model: 'helpdesk.ticket', res_id: 900, partner_ids: [[6, 0, [31]]], send_email: true });
  assert.equal(s.calls.some((c) => c.method === 'message_subscribe'), false, 'notify takes the wizard path, not the silent one');
  assert.deepEqual(s.messages, [{ kind: 'invite', partners: [31], send_email: true }]);
  assert.deepEqual(s.followers.find((f) => f.partner_id[0] === 33).subtype_ids, [1, 7]);
});

test('an answer lost after Odoo saved the change is read back and reported as success, without a second subscription', async () => {
  const s = await setup();
  s.state.failNext = 'lost';
  const r = await s.call('admin', '/odoo/tickets/HD-302/followers', 'POST', { partnerIds: [31] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.added, 1);
  assert.deepEqual(r.data.followers.map((f) => f.id).sort(), [31, 33]);
  assert.equal(s.calls.filter((c) => c.method === 'message_subscribe').length, 1);
});

test('a request that never reached Odoo is reported as unknown, and a retry then adds the contact once', async () => {
  const s = await setup();
  s.state.failNext = 'drop';
  const r = await s.call('admin', '/odoo/tickets/HD-302/followers', 'POST', { partnerIds: [31] });
  assert.equal(r.status, 502);
  assert.equal(r.data.code, 'odoo_unknown');
  assert.equal(s.followers.some((f) => f.partner_id[0] === 31), false);
  const retry = await s.call('admin', '/odoo/tickets/HD-302/followers', 'POST', { partnerIds: [31] });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.added, 1);
  assert.equal(s.followers.filter((f) => f.partner_id[0] === 31).length, 1);
});

test('Odoo refusing the change (access rules) returns its readable message as a 403', async () => {
  const s = await setup();
  s.state.failNext = 'reject';
  const r = await s.call('rami', '/odoo/tickets/HD-302/followers', 'POST', { partnerIds: [31] });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'You are not allowed to follow this ticket.');
  assert.equal(s.followers.some((f) => f.partner_id[0] === 31), false);
});

test('followers added directly in Odoo appear on the next read', async () => {
  const s = await setup();
  assert.equal((await s.call('admin', '/odoo/tickets/HD-302/followers')).data.followers.length, 1);
  s.followers.push({ id: 50, res_model: 'helpdesk.ticket', res_id: 900, partner_id: [30, 'Ariel Amiri'], subtype_ids: [1] });
  const r = await s.call('admin', '/odoo/tickets/HD-302/followers');
  assert.deepEqual(names(r.data), ['Ariel Amiri', 'Dana Haddad']);
});

test('unsupported follower routes are not found, and the ticket read itself is unchanged', async () => {
  const s = await setup();
  assert.equal((await s.call('admin', '/odoo/tickets/HD-302/followers', 'DELETE')).status, 404);
  assert.equal((await s.call('admin', '/odoo/tickets/HD-302/followers/add', 'POST', { partnerIds: [31] })).status, 404);
  assert.equal(s.calls.some((c) => c.method === 'message_subscribe'), false);
});
