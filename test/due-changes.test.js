// Report: due dates changed directly in Jira, against a fake Jira and the in-memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { makeToken } from '../proxy/src/handler.js';
import { memoryStore, saveUser } from '../proxy/src/users.js';
import { recordTicketEvent } from '../proxy/src/ticket-log.js';

const admin = { email: 'admin@example.invalid', name: 'Manager', role: 'admin', dev: '', v: 1 };
const user = { email: 'dev@example.invalid', name: 'Developer', role: 'user', dev: 'builder', v: 1 };
const ago = (h) => new Date(Date.now() - h * 3600000).toISOString().replace('Z', '+0000');

async function setup({ bulk = true } = {}) {
  const env = { SESSION_SECRET: 's', JIRA_PROJECT: 'AION', JIRA_SITE: 'https://jira.invalid', JIRA_EMAIL: 'bot', JIRA_API_TOKEN: 't', STORE: memoryStore() };
  for (const u of [admin, user]) await saveUser(env.STORE, u);
  const tokens = {}; for (const u of [admin, user]) tokens[u.role] = (await makeToken(env, u.email, Date.now(), 1)).token;
  const dashboard = { accountId: 'acc-dashboard', displayName: 'Youssef Sahlieh' }, karim = { accountId: 'acc-karim', displayName: 'Karim' };
  const changes = {
    10: [{ created: ago(2), author: karim, items: [{ fieldId: 'duedate', from: '2026-10-20', to: '2026-11-05' }] },
         { created: ago(24 * 40), author: karim, items: [{ fieldId: 'duedate', from: '2026-09-01', to: '2026-10-20' }] }],
    11: [{ created: ago(5), author: dashboard, items: [{ fieldId: 'duedate', from: null, fromString: null, to: '2026-11-01', toString: '2026-11-01' }] }],
    12: [{ created: ago(8), author: dashboard, items: [{ fieldId: 'duedate', from: '2026-10-25', to: '2026-10-30' }] }]
  };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), body = init.body ? JSON.parse(init.body) : null; calls.push(u.pathname);
    if (u.pathname === '/rest/api/3/myself') return Response.json(dashboard);
    if (u.pathname === '/rest/api/3/search/jql') return Response.json({ isLast: true, issues: [
      { id: '10', key: 'AION-10', fields: { summary: 'Printer', labels: ['ai1_bashar'], status: { name: 'In Development' } } },
      { id: '11', key: 'AION-11', fields: { summary: 'Export', labels: ['ai1_ellen'], status: { name: 'Open' } } },
      { id: '12', key: 'AION-12', fields: { summary: 'Login', labels: [], status: { name: 'Open' } } }] });
    if (u.pathname === '/rest/api/3/changelog/bulkfetch') {
      if (!bulk) return Response.json({ errorMessages: ['Not found'] }, { status: 404 });
      assert.deepEqual(body.fieldIds, ['duedate']);
      return Response.json({ issueChangeLogs: body.issueIdsOrKeys.map((id) => ({ issueId: id, changeHistories: changes[id] || [] })) });
    }
    const m = /\/rest\/api\/3\/issue\/AION-(\d+)\/changelog$/.exec(u.pathname);
    if (m) return Response.json({ isLast: true, values: [...(changes[m[1]] || []), { created: ago(1), author: karim, items: [{ field: 'status', fromString: 'Open', toString: 'Done' }] }] });
    return Response.json({}, { status: 404 });
  };
  // The dashboard applied AION-11's date (an approved date request) at that moment; nothing recorded for AION-12.
  await recordTicketEvent(env, 'AION-11', admin, { action: 'due', changes: { duedate: { from: 'Not set', to: '2026-11-01' } } });
  const log = JSON.parse(await env.STORE.get('tlog:AION-11')); log[0].at = new Date(Date.now() - 5 * 3600000 + 60000).toISOString(); await env.STORE.set('tlog:AION-11', JSON.stringify(log));
  const call = (path, role = 'admin') => worker.fetch(new Request('https://proxy.invalid' + path, { headers: { Authorization: 'Bearer ' + tokens[role] } }), env);
  return { env, call, calls };
}

for (const bulk of [true, false]) test('due date changes: direct in Jira vs through the dashboard' + (bulk ? '' : ' (per-ticket history when the bulk read is unavailable)'), async () => {
  const s = await setup({ bulk });
  const r = await s.call('/reports/due-changes?days=30'); assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ticketsChecked, 3); assert.equal(d.dashboardAccount.name, 'Youssef Sahlieh');
  assert.equal(d.rows.length, 3, 'the 40-day-old change is outside 30 days; the status change is not a due date');
  const [karim, dash, ownAccount] = ['AION-10', 'AION-11', 'AION-12'].map((k) => d.rows.find((x) => x.key === k));
  assert.deepEqual([karim.via, karim.by.name, karim.from, karim.to, karim.developers], ['jira', 'Karim', '2026-10-20', '2026-11-05', ['bashar']]);
  assert.deepEqual([dash.via, dash.dashboardBy, dash.from, dash.to], ['dashboard', 'Manager', null, '2026-11-01']);
  assert.equal(ownAccount.via, 'jira'); assert.match(ownAccount.note, /dashboard's account/);
  assert.deepEqual(d.rows.map((x) => x.key), ['AION-10', 'AION-11', 'AION-12'], 'newest first');
  assert.equal(s.calls.includes('/rest/api/3/changelog/bulkfetch'), true);
  assert.equal(s.calls.some((p) => /\/issue\/AION-\d+\/changelog$/.test(p)), !bulk);
});

test('due date changes: administrators only, chosen periods, kept 2 minutes', async () => {
  const s = await setup();
  assert.equal((await s.call('/reports/due-changes', 'user')).status, 403);
  assert.equal((await s.call('/reports/due-changes?days=5')).status, 400);
  const first = await (await s.call('/reports/due-changes?days=90')).json();
  assert.equal(first.rows.length, 4, '90 days includes the older change');
  const before = s.calls.length, again = await (await s.call('/reports/due-changes?days=90')).json();
  assert.equal(again.cached, true); assert.equal(s.calls.length, before);
  await s.call('/reports/due-changes?days=90&refresh=1'); assert.ok(s.calls.length > before);
});
