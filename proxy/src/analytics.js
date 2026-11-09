// Analytics snapshot: every Jira and internal ticket in a bounded window, joined with client names, agreed
// hours and the work log, in one redacted payload. The browser computes the KPIs from it (see
// public/assets/models/analytics-stats.js), so changing the period or a filter needs no further request.
//
// Rules: administrators only; an allowlist of fields (no billing, history, emails or descriptions); an unknown
// value is null, never zero; days are Asia/Jerusalem calendar days.
import { BusinessError, requireStore, readCatalog, metadataKey, shownName, selectionOf } from './ticket-metadata.js';
import { entriesBetween, readSummaries, todayIn, isSynced } from './time-entries.js';
import { localDate } from './reports.js';

export const WINDOW_MONTHS = 24;
const BUDGET_MS = 20000, MAX_PAGES = 40;
export const snapshotKey = (env) => 'analytics:v1:' + encodeURIComponent(env.JIRA_SITE || '') + ':' + env.JIRA_PROJECT;
// Entry source codes in snapshot.entries: [ticket, day, personIndex, minutes, source, odoo].
export const SOURCES = ['jira', 'internal', 'odoo'];
// The entry's Odoo state (the same rule as the work log's totals): confirmed in Odoo at its current revision, held under the
// ticket's agreed hours (the agreed line goes to Odoo instead), or pending (syncing, needs setup, needs review).
export const ODOO_PENDING = 0, ODOO_CONFIRMED = 1, ODOO_HELD = 2;
const odooState = (e) => (isSynced(e) ? ODOO_CONFIRMED : e.state === 'agreed' ? ODOO_HELD : ODOO_PENDING);

const dayOf = (value) => { const t = Date.parse(value); return Number.isFinite(t) ? localDate(new Date(t)) : null; };
const dateOnly = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);
const hours = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const isComplete = (s) => s?.complete?.jira === true && s.complete.internal === true;

export function windowStart(now = new Date(), months = WINDOW_MONTHS) {
  const d = new Date(todayIn(now).slice(0, 8) + '01T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

// One ticket in the shape the page uses. `meta` is the raw business record, `me` decides what an admin-only field shows.
export function normalize(t, meta, catalog, loggedMinutes, me) {
  const completedAt = t.closed ? (t.completedAt || t.closedAt || meta.completedAt || null) : null;
  const name = (id) => shownName(catalog.entries.find((e) => e.id === id)) || null, sel = selectionOf(meta, catalog);
  return {
    key: t.key, source: t.internal ? 'internal' : 'jira', title: String(t.title || t.summary || '').slice(0, 200),
    status: t.status, cat: t.cat || (t.closed ? 'done' : 'indeterminate'),
    createdDay: dayOf(t.created), completedDay: completedAt ? dayOf(completedAt) : null, dueDay: dateOnly(t.due),
    // The client and project follow the ticket's Odoo project when it has one.
    clientId: sel.clientId, clientName: name(sel.clientId), subClientId: sel.subClientId, subClientName: name(sel.subClientId),
    devs: Array.isArray(t.devs) ? t.devs : [],
    estimatedHours: hours(meta.estimatedHours), agreedHours: me.role === 'admin' ? hours(meta.agreedHours) : null,
    loggedMinutes,
  };
}

async function readJira(env, readSearch, since, started, warnings) {
  const rows = [], seen = new Set();
  let token, complete = false;
  const jql = 'project = "' + env.JIRA_PROJECT + '" AND issuetype != Epic AND (statusCategory != Done OR created >= "' + since + '" OR resolutiondate >= "' + since + '") ORDER BY created DESC';
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      if (Date.now() - started > BUDGET_MS) { warnings.push('Jira search reached the analytics time limit.'); break; }
      const r = await readSearch({ jql, fields: ['summary', 'status', 'labels', 'created', 'duedate', 'resolutiondate'], maxResults: 100, ...(token ? { nextPageToken: token } : {}) });
      for (const issue of r.issues || []) {
        if (!issue.key?.startsWith(env.JIRA_PROJECT + '-') || !/^\d+$/.test(issue.key.slice(env.JIRA_PROJECT.length + 1))) continue;
        const f = issue.fields || {};
        if (!f.status?.statusCategory?.key) { warnings.push('A Jira ticket lacked status details.'); continue; }
        rows.push({ key: issue.key, title: f.summary, status: f.status.name, cat: f.status.statusCategory.key, closed: f.status.statusCategory.key === 'done', devs: (f.labels || []).filter((l) => /^ai1_/i.test(l)).map((l) => l.slice(4).toLowerCase()), created: f.created, due: f.duedate, completedAt: f.resolutiondate || null, internal: false });
      }
      if (r.isLast === true || (r.isLast !== false && !r.nextPageToken)) { complete = true; break; }
      if (!r.nextPageToken || seen.has(r.nextPageToken)) { warnings.push('Jira pagination was incomplete or repeated.'); break; }
      seen.add(r.nextPageToken); token = r.nextPageToken;
    }
  } catch { warnings.push('Jira data could not be fully retrieved.'); }
  if (!complete) warnings.push('Jira results are partial; analytics cover only retrieved tickets.');
  return { rows, complete };
}

export async function buildSnapshot(env, me, { readSearch, readInternal, readHistory }, now = new Date()) {
  const store = requireStore(env);
  if (me.role !== 'admin') throw new BusinessError('Only administrators can read analytics.', 403, 'forbidden');
  const started = Date.now(), warnings = [], since = windowStart(now), today = todayIn(now);
  const jira = await readJira(env, readSearch, since, started, warnings);
  let internal = [], internalComplete = true;
  try { internal = await readInternal(); } catch { internalComplete = false; warnings.push('Internal tickets could not be fully retrieved.'); }
  const unique = [...new Map([...jira.rows, ...internal].map((t) => [t.key, t])).values()];
  const catalog = await readCatalog(env), keys = unique.map((t) => t.key);
  // Hours: the ticket totals and the dated entries. If the work log cannot be read they are unknown (null), not zero.
  let sums = {}, entries = null, timeComplete = true;
  try {
    sums = await readSummaries(env, keys);
    entries = await entriesBetween(env, since, today);
  } catch { timeComplete = false; sums = {}; entries = null; warnings.push('The work log could not be read, so logged hours are unknown.'); }
  const raws = [];
  for (let i = 0; i < keys.length; i += 200) {
    const part = keys.slice(i, i + 200).map((k) => metadataKey(env, k));
    raws.push(...(store.mget ? await store.mget(part) : await Promise.all(part.map((k) => store.get(k)))));
  }
  const tickets = []; let unknownCompletion = 0, historyReads = 0;
  unique.forEach((t, n) => {
    let meta = {}; try { meta = raws[n] ? JSON.parse(raws[n]) : {}; } catch { warnings.push('A ticket business record could not be read.'); }
    tickets.push(normalize(t, meta, catalog, timeComplete ? (sums[t.key]?.loggedMinutes || 0) : null, me));
  });
  // A closed Jira ticket with no resolution date: read its history, a few per build.
  for (const t of tickets) {
    if (t.cat !== 'done' || t.completedDay) continue;
    if (t.source === 'jira' && readHistory && historyReads < 20 && Date.now() - started < 24000) {
      historyReads++;
      try { const at = await readHistory(t.key, t.status); if (at) t.completedDay = dayOf(at); } catch { /* counted as unknown below */ }
    }
    if (!t.completedDay) unknownCompletion++;
  }
  if (unknownCompletion) warnings.push(unknownCompletion + ' completed tickets have no verified completion date. They are left out of completion counts.');
  const people = [], personIndex = new Map();
  const flat = entries === null ? null : entries.map((e) => {
    const name = e.author?.name || 'Unknown';
    if (!personIndex.has(name)) { personIndex.set(name, people.length); people.push(name); }
    return [e.ticket, e.date, personIndex.get(name), e.minutes, Math.max(0, SOURCES.indexOf(e.source)), odooState(e)];
  });
  return {
    builtAt: now.toISOString(), timeZone: 'Asia/Jerusalem', window: { from: since, to: today },
    complete: { jira: jira.complete, internal: internalComplete, time: timeComplete },
    warnings: [...new Set(warnings)], people, tickets, entries: flat,
  };
}

export async function analyticsSnapshot(env, me, deps, { refresh = false, now = new Date() } = {}) {
  if (me.role !== 'admin') throw new BusinessError('Only administrators can read analytics.', 403, 'forbidden');
  const store = requireStore(env), key = snapshotKey(env), raw = await store.get(key);
  let previous = null;
  try { previous = raw ? JSON.parse(raw) : null; } catch { if (!refresh) throw new BusinessError('The saved analytics could not be read. Refresh to rebuild them.', 503, 'analytics_cache'); }
  const response = (snapshot, cached, extra = {}) => ({ snapshot, cached, stale: now.getTime() - Date.parse(snapshot.builtAt) > 3600000, ...extra });
  if (previous && !refresh) return response(previous, true);
  const owner = crypto.randomUUID(), lock = key + ':lock';
  if (!await store.setIfAbsent(lock, owner, 90)) {
    if (previous) return response(previous, true, { refreshing: true });
    throw new BusinessError('The first analytics snapshot is being prepared. Try again shortly.', 409, 'analytics_building');
  }
  try {
    if (!refresh) { const ready = await store.get(key); if (ready) return response(JSON.parse(ready), true); }
    const snapshot = await buildSnapshot(env, me, deps, now);
    if (isComplete(previous) && !isComplete(snapshot)) return response(previous, true, { refreshWarning: 'The refresh returned incomplete source data. The previous complete snapshot is still shown.' });
    await store.set(key, JSON.stringify(snapshot));
    return response(snapshot, false);
  } finally { await store.deleteIfValue(lock, owner); }
}

export async function analyticsRoutes(request, env, me, deps, path) {
  if ((path === '/analytics/snapshot' && request.method === 'GET') || (path === '/analytics/refresh' && request.method === 'POST')) {
    return Response.json(await analyticsSnapshot(env, me, deps, { refresh: path === '/analytics/refresh' }), { headers: { 'Cache-Control': 'no-store' } });
  }
  throw new BusinessError('Use GET for the snapshot or POST to refresh it.', 405);
}
