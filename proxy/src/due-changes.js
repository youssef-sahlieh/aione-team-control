// Due dates changed directly in Jira, for administrators: every due date change in the period, read from
// Jira's own history, and whether it went through the dashboard's date approvals or not.
//
// The dashboard writes to Jira with one account (the proxy's API token), and records each date it applies in
// the ticket's local history (ticket-log.js, action "due"). So a change counts as "through the dashboard" only
// when it was made with the dashboard's account AND the dashboard recorded it at that moment. Everything else
// was done directly in Jira. Developers who sign in to Jira with a shared account (e.g. Karim's or Rami's) show under
// that account; the ticket's developers (ai1_ labels) are listed beside it.
import { readTicketLog } from './ticket-log.js';

const DAY = 86400000, MATCH_MS = 5 * 60 * 1000, BUDGET_MS = 40000;
const dateOf = (v, s) => { const x = String(v || s || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null; };
const isDue = (it) => it && (it.fieldId === 'duedate' || it.field === 'duedate');

// jira(env, path, init) -> {ok, data} | {ok:false, res}
export async function dueChangesReport(env, { jira }, { days = 30, now = Date.now() } = {}) {
  const started = Date.now(), since = now - days * DAY, warnings = [];
  const me = await jira(env, '/rest/api/3/myself', { signal: AbortSignal.timeout(10000) });
  const dashboardAccount = me.ok ? { id: me.data.accountId || '', name: me.data.displayName || '' } : { id: '', name: '' };
  if (!me.ok) warnings.push("Couldn't identify the dashboard's Jira account: every change is shown as made in Jira.");

  // The project's tickets changed in the period.
  const issues = [];
  let token;
  for (let page = 0; page < 20; page++) {
    const r = await jira(env, '/rest/api/3/search/jql', { method: 'POST', body: { jql: 'project = "' + env.JIRA_PROJECT + '" AND updated >= -' + days + 'd ORDER BY updated DESC', fields: ['summary', 'labels', 'status'], maxResults: 100, ...(token ? { nextPageToken: token } : {}) }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('Jira search failed');
    for (const i of r.data.issues || []) issues.push({ id: String(i.id), key: i.key, title: i.fields?.summary || '', status: i.fields?.status?.name || '', developers: (i.fields?.labels || []).filter((l) => /^ai1_/i.test(l)).map((l) => l.slice(4).toLowerCase()) });
    if (r.data.isLast !== false || !r.data.nextPageToken) break;
    token = r.data.nextPageToken;
  }
  const byId = new Map(issues.map((i) => [i.id, i])), byKey = new Map(issues.map((i) => [i.key, i]));

  // Their due date history: one bulk read of the due date field only; per ticket when that isn't available.
  const histories = []; // {issue, created, author, items}
  let bulk = issues.length > 0;
  for (let n = 0; bulk && n < issues.length; n += 1000) {
    let next;
    for (let page = 0; page < 20; page++) {
      const r = await jira(env, '/rest/api/3/changelog/bulkfetch', { method: 'POST', body: { issueIdsOrKeys: issues.slice(n, n + 1000).map((i) => i.id), fieldIds: ['duedate'], maxResults: 1000, ...(next ? { nextPageToken: next } : {}) }, signal: AbortSignal.timeout(25000) });
      if (!r.ok) { bulk = false; histories.length = 0; break; }
      for (const log of r.data.issueChangeLogs || []) { const issue = byId.get(String(log.issueId)) || byKey.get(log.issueId); if (issue) for (const h of log.changeHistories || []) histories.push({ issue, ...h }); }
      if (!r.data.nextPageToken) break;
      next = r.data.nextPageToken;
    }
  }
  let partial = false;
  if (!bulk && issues.length) {
    const queue = [...issues];
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (queue.length) {
        if (Date.now() - started > BUDGET_MS) { partial = true; return; }
        const issue = queue.shift();
        for (let start = 0, page = 0; page < 5; page++) {
          const r = await jira(env, '/rest/api/3/issue/' + issue.key + '/changelog?startAt=' + start + '&maxResults=100', { signal: AbortSignal.timeout(10000) });
          if (!r.ok || !Array.isArray(r.data.values)) { partial = true; break; }
          for (const h of r.data.values) if ((h.items || []).some(isDue)) histories.push({ issue, ...h });
          if (r.data.isLast === true || r.data.values.length < 100) break;
          start += 100;
        }
      }
    }));
  }
  if (partial) warnings.push('Some tickets could not be read in time: the list may be incomplete. Try a shorter period.');

  // Each due date change in the period, and whether the dashboard applied it.
  const logs = new Map();
  const dashboardRecord = async (key, at, to) => {
    if (!logs.has(key)) logs.set(key, await readTicketLog(env, key));
    const t = Date.parse(at);
    return logs.get(key).find((e) => e.action === 'due' && Math.abs(Date.parse(e.at) - t) <= MATCH_MS && dateOf(e.changes?.duedate?.to) === to) || null;
  };
  const rows = [];
  for (const h of histories) {
    const at = h.created, t = Date.parse(at);
    if (!Number.isFinite(t) || t < since || t > now) continue;
    for (const it of (h.items || []).filter(isDue)) {
      const from = dateOf(it.from, it.fromString), to = dateOf(it.to, it.toString);
      const author = { id: h.author?.accountId || '', name: h.author?.displayName || 'Unknown' };
      const viaDashboardAccount = !!dashboardAccount.id && author.id === dashboardAccount.id;
      const record = viaDashboardAccount ? await dashboardRecord(h.issue.key, at, to) : null;
      rows.push({ key: h.issue.key, title: h.issue.title, status: h.issue.status, developers: h.issue.developers, at, by: author, from, to,
        via: record ? 'dashboard' : 'jira', ...(record ? { dashboardBy: record.by?.name || record.by?.email || '' } : {}),
        ...(viaDashboardAccount && !record ? { note: "Made in Jira with the dashboard's account" } : {}) });
    }
  }
  rows.sort((a, b) => b.at.localeCompare(a.at));
  return { days, generatedAt: new Date(now).toISOString(), dashboardAccount, ticketsChecked: issues.length, rows, partial, warnings };
}

// GET /reports/due-changes?days=7|30|90 (administrators). Kept 2 minutes, so reopening the page is instant.
export async function dueChangesRoutes(request, env, url, me, deps) {
  const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
  if (me.role !== 'admin') return json({ code: 'forbidden', error: 'Only administrators can see this report.' }, 403);
  if (request.method !== 'GET') return json({ code: 'method', error: 'Use GET.' }, 405);
  const days = Number(url.searchParams.get('days') || 30);
  if (![7, 30, 90].includes(days)) return json({ code: 'bad_request', error: 'Choose 7, 30 or 90 days.' }, 400);
  const key = 'reports:due-changes:' + env.JIRA_PROJECT + ':' + days;
  if (url.searchParams.get('refresh') !== '1' && env.STORE) { const cached = await env.STORE.get(key).catch(() => null); if (cached) return json({ ...JSON.parse(cached), cached: true }); }
  let report;
  try { report = await dueChangesReport(env, deps, { days }); }
  catch { return json({ code: 'jira', error: "Couldn't read the ticket history from Jira. Try again." }, 502); }
  if (env.STORE) await env.STORE.set(key, JSON.stringify(report), 120).catch(() => {});
  return json(report);
}
