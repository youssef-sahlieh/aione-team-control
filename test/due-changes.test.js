// Report: due dates changed directly in Jira, against a fake Jira and the in-memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { makeToken } from '../proxy/src/handler.js';
import { memoryStore, saveUser } from '../proxy/src/users.js';
import { recordTicketEvent } from '../proxy/src/ticket-log.js';

const admin = { email: 'admin@example.invalid', name: 'Manager', role: 'admin', dev: '', v: 1 };
const user = { email: 'dev@example.invalid', name: 'Developer', role: 'user', dev: 'builder', v: 1 };
// Jira's own timestamp format, in Israel time: 2026-10-26T13:48:24.643+0200.
const jiraTime = (hoursAgo) => { const d = new Date(Date.now() - hoursAgo * 3600000 + 2 * 3600000); return d.toISOString().replace('Z', '+0200'); };

// truncated: the search returns only each ticket's newest entry (as when a history is long), so the report
// must read the rest of that ticket's history on its own.
async function setup({ truncated = false } = {}) {
  const env = { SESSION_SECRET: 's', JIRA_PROJECT: 'AION', JIRA_SITE: 'https://jira.invalid', JIRA_EMAIL: 'bot', JIRA_API_TOKEN: 't', STORE: memoryStore() };
  for (const u of [admin, user]) await saveUser(env.STORE, u);
  const tokens = {}; for (const u of [admin, user]) tokens[u.role] = (await makeToken(env, u.email, Date.now(), 1)).token;
  const dashboard = { accountId: 'acc-dashboard', displayName: 'Youssef Sahlieh' }, karim = { accountId: 'acc-karim', displayName: 'karim dababneh' }, rami = { accountId: 'acc-rami', displayName: 'Rami' };
  const status = (h, who) => ({ created: jiraTime(h), author: who, items: [{ field: 'status', fieldtype: 'jira', fieldId: 'status', fromString: 'Open', toString: 'In QA' }] });
  // Newest first, as the search returns them.
  const histories = {
    'AION-10': [status(1, karim), { created: jiraTime(2), author: karim, items: [{ field: 'duedate', fieldtype: 'jira', fieldId: 'duedate', from: '2026-10-20', fromString: '2026-10-20 00:00:00.0', to: '2026-11-05', toString: '2026-11-05 00:00:00.0' }] },
      { created: jiraTime(24 * 40), author: karim, items: [{ field: 'duedate', fieldId: 'duedate', from: '2026-09-01', to: '2026-10-20' }] }],
    'AION-11': [{ created: jiraTime(5), author: dashboard, items: [{ field: 'duedate', fieldId: 'duedate', to: '2026-11-01', toString: '2026-11-01 00:00:00.0' }] }],
    // Made in Jira with the dashboard's own account (the AION-598 case): no dashboard record.
    'AION-12': [{ created: jiraTime(8), author: dashboard, items: [{ field: 'duedate', fieldtype: 'jira', fieldId: 'duedate', from: '2026-10-18', fromString: '2026-10-18 00:00:00.0', to: '2026-10-26', toString: '2026-10-26 00:00:00.0' }] }],
    'AION-13': [status(3, rami), { created: jiraTime(30), author: rami, items: [{ field: 'duedate', fieldId: 'duedate', from: '2026-10-22', to: '2026-10-29' }] }]
  };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), body = init.body ? JSON.parse(init.body) : null; calls.push(u.pathname);
    if (u.pathname === '/rest/api/3/myself') return Response.json(dashboard);
    if (u.pathname === '/rest/api/3/search/jql') {
      assert.equal(body.expand, 'changelog');
      return Response.json({ isLast: true, issues: Object.entries(histories).map(([key, list], n) => ({ id: String(10 + n), key,
        fields: { summary: 'Ticket ' + key, labels: key === 'AION-10' ? ['ai1_bashar'] : key === 'AION-13' ? ['ai1_rami'] : [], status: { name: 'Open' } },
        changelog: truncated ? { startAt: 0, maxResults: 1, total: list.length, histories: list.slice(0, 1) } : { startAt: 0, maxResults: list.length, total: list.length, histories: list } })) });
    }
    const m = /\/rest\/api\/3\/issue\/(AION-\d+)\/changelog$/.exec(u.pathname);
    if (m) return Response.json({ isLast: true, values: [...(histories[m[1]] || [])].reverse() }); // oldest first
    return Response.json({}, { status: 404 });
  };
  // The dashboard applied AION-11's date (an approved date request) at that moment; nothing recorded for AION-12.
  await recordTicketEvent(env, 'AION-11', admin, { action: 'due', changes: { duedate: { from: 'Not set', to: '2026-11-01' } } });
  const log = JSON.parse(await env.STORE.get('tlog:AION-11')); log[0].at = new Date(Date.now() - 5 * 3600000 + 60000).toISOString(); await env.STORE.set('tlog:AION-11', JSON.stringify(log));
  const call = (path, role = 'admin') => worker.fetch(new Request('https://proxy.invalid' + path, { headers: { Authorization: 'Bearer ' + tokens[role] } }), env);
  return { env, call, calls };
}

for (const truncated of [false, true]) test('due date changes: direct in Jira (any account) vs through the dashboard' + (truncated ? ' (long histories read per ticket)' : ''), async () => {
  const s = await setup({ truncated });
  const r = await s.call('/reports/due-changes?days=30'); assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ticketsChecked, 4); assert.equal(d.dashboardAccount.name, 'Youssef Sahlieh');
  assert.equal(d.rows.length, 4, 'the 40-day-old change is outside 30 days; status changes are not due dates');
  const row = (k) => d.rows.find((x) => x.key === k);
  assert.deepEqual([row('AION-10').via, row('AION-10').by.name, row('AION-10').from, row('AION-10').to, row('AION-10').developers], ['jira', 'karim dababneh', '2026-10-20', '2026-11-05', ['bashar']]);
  assert.deepEqual([row('AION-13').via, row('AION-13').by.name, row('AION-13').developers], ['jira', 'Rami', ['rami']]);
  assert.deepEqual([row('AION-11').via, row('AION-11').dashboardBy, row('AION-11').from, row('AION-11').to], ['dashboard', 'Manager', null, '2026-11-01']);
  // Your own change made directly in Jira (the AION-598 case) is listed as direct.
  assert.deepEqual([row('AION-12').via, row('AION-12').by.name, row('AION-12').from, row('AION-12').to], ['jira', 'Youssef Sahlieh', '2026-10-18', '2026-10-26']);
  assert.match(row('AION-12').note, /dashboard's account/);
  assert.deepEqual(d.rows.map((x) => x.key), ['AION-10', 'AION-11', 'AION-12', 'AION-13'], 'newest first');
  const perTicket = s.calls.filter((p) => /\/issue\/AION-\d+\/changelog$/.test(p)).length;
  assert.equal(perTicket, truncated ? 2 : 0, 'only tickets whose history in the period did not fully fit are read on their own (AION-10, AION-13)');
  assert.equal(d.historiesReadSeparately, perTicket);
});

test('due date changes: administrators only, chosen periods, kept 2 minutes', async () => {
  const s = await setup();
  assert.equal((await s.call('/reports/due-changes', 'user')).status, 403);
  assert.equal((await s.call('/reports/due-changes?days=5')).status, 400);
  const first = await (await s.call('/reports/due-changes?days=90')).json();
  assert.equal(first.rows.length, 5, '90 days includes the older change');
  const before = s.calls.length, again = await (await s.call('/reports/due-changes?days=90')).json();
  assert.equal(again.cached, true); assert.equal(s.calls.length, before);
  await s.call('/reports/due-changes?days=90&refresh=1'); assert.ok(s.calls.length > before);
});
