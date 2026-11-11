// The Work log overview: every logged work entry in one list, across clients, projects and tickets.
// Each actual work session appears once. Dashboard entries come from the work log store; Odoo timesheet lines
// come from Odoo. A dashboard entry already in Odoo is matched by its stable entry id (the Odoo entry-id field) or
// its Odoo line id, never by description or duration. Agreed-hours lines ("agreed:<KEY>") are accounting lines:
// they are counted apart and only administrators see them.
//
// Read-only. Filters, totals, groups, paging and the CSV export are computed over the complete matching set, so the
// page, its counts and its export agree. Permissions: administrators see all work; everyone else sees their own
// dashboard entries and the Odoo lines whose Users field names them.
import { odoo, odooConfigured } from './odoo.js';
import { requireStore, readCatalog, readAllMetadata, readOdooProjects, projectIndex, selectionOf, shownName, BusinessError } from './ticket-metadata.js';
import { readConfig, todayIn, TIME_ZONE, sourceOf, isSynced, canLog } from './time-entries.js';
import { readBillingConfig, readProjectDefaults, readTicketRecords, valueOfTask, effectiveBilling } from './billing.js';
import { normEmail } from './users.js';

const problem = (message, status = 400, code = 'work_overview', details = {}) => { throw new BusinessError(message, status, code, details); };
export const MAX_LINES = 20000;   // Odoo timesheet lines read for one overview; more than this asks for a shorter period.
const PAGE = 500;                 // Odoo read page size.
export const MAX_PAGE = 200;      // rows per page.
const PERIODS = ['this_month', 'last_month', 'last_30', 'custom', 'all'];
const SYNC_FILTERS = ['all', 'posted', 'unsynced', 'attention'];
export const GROUPS = ['day', 'person', 'client', 'project'];
const BILLING_LABEL = { billable: 'Billable', not_billable: 'Not billable', unclassified: 'Unclassified' };
const STATUS_LABEL = { synced: 'Posted in Odoo', odoo: 'Posted in Odoo', syncing: 'Sending to Odoo', held: 'Held for agreed hours', setup: 'Needs setup', review: 'Needs review' };
const PENDING = new Set(['syncing', 'setup', 'review']);  // dashboard entries not yet in Odoo and needing attention or on their way
const ATTENTION = new Set(['setup', 'review']);
const KEY_IN_NAME = /\[([A-Z][A-Z0-9_]*-\d+)\]/;

const m2oId = v => (Array.isArray(v) ? Number(v[0]) || null : null);
const m2oName = v => (Array.isArray(v) ? String(v[1] || '') : '');
const low = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const lastDayOf = ym => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);
const validDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(Date.parse(d + 'T00:00:00Z')).toISOString().slice(0, 10) === d;
const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
// H:MM, the duration format the work log uses everywhere it shows a total.
export const formatHM = m => Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');

// ---- Period: the resolved date range, in Israel time ----
// This month is the whole calendar month; last 30 days is today and the 29 days before; all dates has no bounds.
export function resolvePeriod(period, today, from, to) {
  const p = PERIODS.includes(period) ? period : 'this_month';
  if (p === 'all') return { key: 'all', from: null, to: null };
  if (p === 'last_30') return { key: p, from: addDays(today, -29), to: today };
  if (p === 'last_month') {
    const prevLast = addDays(today.slice(0, 8) + '01', -1);
    return { key: p, from: prevLast.slice(0, 8) + '01', to: prevLast };
  }
  if (p === 'custom') {
    if (!validDate(from) || !validDate(to)) problem('Choose a valid from and to date.');
    if (from > to) problem('The start date is after the end date.');
    return { key: p, from, to };
  }
  return { key: 'this_month', from: today.slice(0, 8) + '01', to: lastDayOf(today.slice(0, 7)) };
}

// ---- Reading the two sources ----
// The work log's own keys (time-entries.js): month index "tw:<project>:m:<YYYY-MM>" holds entry ids; "tw:<project>:e:<id>" holds the entry.
// Bounded periods read the months they span; "all dates" reads every month the index has.
async function dashboardEntries(env, from, to) {
  const store = requireStore(env), base = 'tw:' + env.JIRA_PROJECT + ':';
  let ids;
  if (from && to) {
    const months = [];
    for (let ym = from.slice(0, 7); ym <= to.slice(0, 7); ) {
      months.push(ym);
      const [y, m] = ym.split('-').map(Number);
      ym = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
    }
    ids = (await Promise.all(months.map(m => store.smembers(base + 'm:' + m)))).flat();
  } else {
    // All dates: every stored entry record (the month sets are not scanned by every store).
    ids = (store.scanKeys ? await store.scanKeys(base + 'e:') : []).map(k => k.slice((base + 'e:').length));
  }
  ids = [...new Set(ids.filter(Boolean))];
  const found = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200).map(id => base + 'e:' + id);
    const raws = store.mget ? await store.mget(batch) : await Promise.all(batch.map(k => store.get(k)));
    for (const raw of raws) if (raw) found.push(JSON.parse(raw));
  }
  return found.filter(e => (!from || e.date >= from) && (!to || e.date <= to));
}

// Odoo timesheet lines in the period, by their Date value (a calendar date, so no time zone shift).
async function odooLines(env, from, to, fields) {
  const domain = [['project_id', '!=', false]];
  if (from) domain.push(['date', '>=', from]);
  if (to) domain.push(['date', '<=', to]);
  const total = await odoo(env, 'account.analytic.line', 'search_count', [domain]);
  if (total > MAX_LINES) problem('This period has ' + total + ' timesheet lines in Odoo. Choose a shorter period.', 400, 'too_many_lines', { total });
  const lines = [];
  for (let offset = 0; lines.length < total; offset += PAGE) {
    const batch = await odoo(env, 'account.analytic.line', 'search_read', [domain], { fields, order: 'id', limit: PAGE, offset });
    lines.push(...batch);
    if (!batch.length) break;
  }
  return lines;
}

// The timesheet fields this Odoo has. Optional fields (the worker's employee) are read only when they exist.
async function lineFieldNames(env, wanted) {
  const all = await odoo(env, 'account.analytic.line', 'fields_get', [], { attributes: ['type'] });
  return wanted.filter(f => f && all[f]);
}

// ---- Rows ----
// Every row has the same keys. Fields starting with "_" stay on the server.
function rowOf(base) {
  return {
    billing: 'unclassified', billingSource: 'none', client: '', project: '', projectId: null, ticket: null, ticketTitle: '',
    ticketOpenable: false, task: '', taskId: null, taskUrl: null, openUrl: null, entryId: null, lineId: null, reason: '', description: '',
    source: '', person: '', ...base
  };
}

// Builds the complete set of rows the user may see (before any filter). Pure: all data is passed in.
export function buildRows({ entries, lines, cfg, catalog, metas, billingCfg, projects, hd, known, odooBase, me, integrationEmployeeId, taskBilling, env }) {
  const catById = new Map(catalog.entries.map(c => [c.id, c]));
  const catName = id => (id ? shownName(catById.get(id)) : '');
  const defaultBilling = id => (id == null ? null : projects.items?.[id]?.billing ?? null);
  const lineLink = id => (odooBase ? odooBase + '/web#id=' + id + '&model=account.analytic.line&view_type=form' : null);
  const taskLink = id => (odooBase && id ? odooBase + '/web#id=' + id + '&model=project.task&view_type=form' : null);
  const myEmail = normEmail(me.email), myName = low(me.name || me.email);
  const entryIds = new Set(entries.map(e => e.id)), lineIds = new Set(entries.map(e => e.lineId).filter(Boolean));

  // Odoo lines are classified before anything is shown. A line whose entry id or line id is a dashboard entry is
  // that entry in Odoo, so it is shown once (as the dashboard row). Agreed-hours lines are kept apart.
  const odooByEntry = new Map(), agreed = [], native = [];
  for (const l of lines) {
    const uuid = cfg.fields.entryUuid ? l[cfg.fields.entryUuid] : false;
    if (typeof uuid === 'string' && uuid.startsWith('agreed:')) { agreed.push(l); continue; }
    if (typeof uuid === 'string' && entryIds.has(uuid)) { odooByEntry.set(uuid, l); continue; }
    if (lineIds.has(l.id)) continue;
    native.push(l);
  }

  const rows = [];
  // Dashboard entries: the client and project come from the ticket's selection; the billing override from the ticket.
  for (const e of entries) {
    const ticketKey = e.ticket;
    const m = metas.get(ticketKey) || {};
    const sel = selectionOf(m, catalog, known);
    const projectId = e.projectId || e.hdProjectId || m.odooProjectId || null;
    const override = hd[ticketKey]?.billing ?? m.billing ?? null;
    const billing = effectiveBilling(defaultBilling(projectId), override);
    const kn = known.get(projectId);
    const matched = odooByEntry.get(e.id);
    let status = e.state === 'agreed' ? 'held' : isSynced(e) ? 'synced' : e.state;
    let lineId = e.lineId || null;
    let reason = e.state === 'setup' ? (e.setup || '') : e.state === 'review' ? (e.review?.message || '') : e.state === 'syncing' ? (e.error || '') : e.state === 'agreed' ? "Odoo records this ticket's agreed hours instead." : '';
    // In Odoo already, under this entry's id, same day and minutes: posted.
    if (matched && status !== 'held' && status !== 'synced' && matched.date === e.date && Math.round(Number(matched.unit_amount) * 60) === e.minutes) {
      status = 'synced'; lineId = matched.id; reason = '';
    }
    if (matched && status === 'synced' && !lineId) lineId = matched.id;
    const posted = status === 'synced';
    rows.push(rowOf({
      id: 'd:' + e.id, origin: 'dashboard', entryId: e.id, lineId, openUrl: lineId ? lineLink(lineId) : null,
      date: e.date, person: e.author?.name || e.author?.email || '', minutes: e.minutes, description: e.description || '',
      source: e.source || sourceOf(env, ticketKey) || '',
      client: catName(sel.clientId) || kn?.clientName || '',
      project: catName(sel.subClientId) || kn?.name || (projectId ? 'Odoo project #' + projectId : ''), projectId,
      ticket: ticketKey, ticketTitle: e.ticketTitle || m.title || '', ticketOpenable: true,
      billing: billing.value, billingSource: billing.source,
      status: posted ? 'synced' : status, statusLabel: STATUS_LABEL[posted ? 'synced' : status] || status, reason,
      _owner: normEmail(e.author?.email || '')
    }));
  }

  // Odoo timesheet lines entered directly in Odoo, and lines on tasks that no dashboard ticket maps to.
  for (const l of native) {
    const pid = m2oId(l.project_id), tid = m2oId(l.task_id), taskName = m2oName(l.task_id);
    const users = cfg.fields.users && typeof l[cfg.fields.users] === 'string' ? l[cfg.fields.users].trim() : '';
    const empId = m2oId(l.employee_id), empName = m2oName(l.employee_id);
    // The worker is the Users field. The integration employee the proxy writes lines under is never the worker.
    const person = users || (empId && empId !== integrationEmployeeId ? empName : '') || 'Not recorded';
    const ticket = KEY_IN_NAME.exec(taskName)?.[1] || null;
    const dashTicket = !!ticket && metas.has(ticket);
    const m = dashTicket ? metas.get(ticket) : {};
    const sel = dashTicket ? selectionOf(m, catalog, known) : { clientId: null, subClientId: null };
    const override = (ticket && (hd[ticket]?.billing ?? m.billing)) ?? taskBilling.get(tid) ?? null;
    const billing = effectiveBilling(defaultBilling(pid), override);
    const kn = known.get(pid);
    const ticketTitle = ticket ? taskName.replace(KEY_IN_NAME, '').replace(/^\s*\/?\s*/, '').trim() : '';
    rows.push(rowOf({
      id: 'o:' + l.id, origin: 'odoo', lineId: l.id, openUrl: lineLink(l.id), date: l.date, person,
      minutes: Math.round(Number(l.unit_amount) * 60), description: String(l.name || ''), source: 'odoo',
      client: catName(sel.clientId) || kn?.clientName || '',
      project: catName(sel.subClientId) || kn?.name || (pid ? 'Odoo project #' + pid : ''), projectId: pid,
      ticket, ticketTitle, ticketOpenable: dashTicket,
      task: ticket ? '' : (taskName || 'No task.'), taskId: tid, taskUrl: tid && odooBase ? odooBase + '/web#id=' + tid + '&model=project.task&view_type=form' : null,
      billing: billing.value, billingSource: billing.source, status: 'odoo', statusLabel: STATUS_LABEL.odoo,
      reason: '', _owner: '', _name: low(person)
    }));
  }

  // Permissions: administrators see everything. Everyone else sees their own dashboard entries and the Odoo lines
  // whose Users field names them. Enforced here, on the server, for the page and for the export alike.
  const visible = rows.filter(r => me.role === 'admin' || (r.origin === 'dashboard' ? r._owner === myEmail : r._name === myName));
  return {
    rows: visible,
    agreed: agreed.map(l => ({ minutes: Math.round(Number(l.unit_amount) * 60), date: l.date, lineId: l.id })),
    odooBase: odooBase || null
  };
}

// The row as the page receives it (no server-only fields), with the H:MM duration.
export function publicRow(r) {
  const out = {};
  for (const [k, v] of Object.entries(r)) if (!k.startsWith('_')) out[k] = v;
  out.duration = formatHM(r.minutes);
  return out;
}

// ---- Filters, totals, groups, order ----
// Filters run over the complete set. q: every word must appear in the ticket key, title, task or description.
export function applyFilters(rows, f) {
  const words = low(f.q).split(' ').filter(Boolean);
  return rows.filter(r => {
    if (f.person && r.person !== f.person) return false;
    if (f.client && (r.client || '') !== f.client) return false;
    if (f.project && (r.project || '') !== f.project) return false;
    if (f.billable && r.billing !== 'billable') return false;
    const posted = r.status === 'synced' || r.status === 'odoo';
    if (f.sync === 'posted' && !posted) return false;
    if (f.sync === 'unsynced' && posted) return false;
    if (f.sync === 'attention' && !ATTENTION.has(r.status)) return false;
    if (words.length) {
      const text = low([r.ticket, r.ticketTitle, r.task, r.description].join(' '));
      if (!words.every(w => text.includes(w))) return false;
    }
    return true;
  });
}

export function totalsOf(rows) {
  const t = { count: rows.length, minutes: 0, billableMinutes: 0, notBillableMinutes: 0, unclassifiedMinutes: 0, pendingCount: 0, heldCount: 0 };
  for (const r of rows) {
    t.minutes += r.minutes;
    if (r.billing === 'billable') t.billableMinutes += r.minutes;
    else if (r.billing === 'not_billable') t.notBillableMinutes += r.minutes;
    else t.unclassifiedMinutes += r.minutes;
    if (r.origin === 'dashboard' && PENDING.has(r.status)) t.pendingCount++;
    if (r.status === 'held') t.heldCount++;
  }
  return { ...t, durationText: formatHM(t.minutes), billableText: formatHM(t.billableMinutes) };
}

const groupKeyOf = (r, by) => (by === 'day' ? r.date : by === 'person' ? r.person : by === 'client' ? (r.client || '') : (r.project || ''));
const groupLabelOf = (key, by) => (!key && (by === 'client' || by === 'project') ? (by === 'client' ? 'No client' : 'No project') : key);

// Groups: days newest first; people, clients and projects by name with the empty ones last.
export function groupsOf(rows, by) {
  if (!GROUPS.includes(by)) return [];
  const map = new Map();
  for (const r of rows) {
    const k = groupKeyOf(r, by);
    const g = map.get(k) || { key: k, label: groupLabelOf(k, by), count: 0, minutes: 0, billableMinutes: 0 };
    g.count++; g.minutes += r.minutes; if (r.billing === 'billable') g.billableMinutes += r.minutes;
    map.set(k, g);
  }
  return [...map.values()]
    .map(g => ({ ...g, durationText: formatHM(g.minutes), billableText: formatHM(g.billableMinutes) }))
    .sort((a, b) => {
      if (by === 'day') return b.key < a.key ? -1 : b.key > a.key ? 1 : 0;
      if (!a.key !== !b.key) return a.key ? -1 : 1;
      return byName(a.label, b.label);
    });
}

// Newest work date first. With a grouping, the rows are ordered by the group order first. Ties: higher Odoo line id,
// then the row id, so the order is the same on every request. No timestamps are invented.
export function sortRows(rows, by) {
  const order = GROUPS.includes(by) ? new Map(groupsOf(rows, by).map((g, i) => [g.key, i])) : null;
  return [...rows].sort((a, b) => {
    if (order) { const d = order.get(groupKeyOf(a, by)) - order.get(groupKeyOf(b, by)); if (d) return d; }
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    const la = a.lineId || 0, lb = b.lineId || 0;
    if (la !== lb) return lb - la;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

// ---- Loading everything for one request ----
export async function loadOverview(env, me, period) {
  const cfg = await readConfig(env);
  const [entries, metas, catalog, projects, billingCfg, hd, snapshot] = await Promise.all([
    dashboardEntries(env, period.from, period.to),
    readAllMetadata(env),
    readCatalog(env),
    readProjectDefaults(env),
    readBillingConfig(env),
    readTicketRecords(env),
    readOdooProjects(env)
  ]);
  const known = projectIndex(snapshot);
  const odooInfo = { configured: odooConfigured(env), complete: true, error: null };
  let lines = [];
  const taskBilling = new Map();
  if (odooInfo.configured) {
    try {
      const wanted = [...new Set([cfg.fields.users, cfg.fields.entryUuid, 'date', 'unit_amount', 'name', 'project_id', 'task_id', 'employee_id'].filter(Boolean))];
      const fields = await lineFieldNames(env, wanted);
      lines = await odooLines(env, period.from, period.to, fields);
      // Task-level billing, read only for the tasks in these lines (when a task billing field is set up).
      if (billingCfg.fields?.task) {
        const taskIds = [...new Set(lines.map(l => m2oId(l.task_id)).filter(Boolean))];
        if (taskIds.length) {
          const tasks = await odoo(env, 'project.task', 'search_read', [[['id', 'in', taskIds]]], { fields: ['id', billingCfg.fields.task], context: { active_test: false } });
          for (const t of tasks) taskBilling.set(t.id, valueOfTask(billingCfg, t) ?? null);
        }
      }
    } catch (err) {
      if (err instanceof BusinessError) throw err;
      problem("Couldn't read the timesheets from Odoo. Nothing is shown for this period, so the totals aren't partial.", 503, 'odoo', { detail: String(err?.message || err).slice(0, 200) });
    }
  } else {
    odooInfo.complete = false;
  }
  const built = buildRows({
    entries, lines, cfg, catalog, metas, billingCfg, projects, hd, known, env,
    odooBase: String(env.ODOO_URL || '').replace(/\/+$/, '') || null, me,
    integrationEmployeeId: cfg.verified?.employee?.id ?? null, taskBilling
  });
  return { cfg, rows: built.rows, agreed: me.role === 'admin' ? built.agreed : [], odooInfo, odooBase: built.odooBase };
}

// Reads the filter parameters from the URL. Unknown values fall back to the defaults.
export function readFilters(q) {
  const period = resolvePeriod(q.get('period') || 'this_month', todayIn(), q.get('from') || '', q.get('to') || '');
  const filters = {
    q: String(q.get('q') || '').slice(0, 200), person: String(q.get('person') || '').slice(0, 120),
    client: String(q.get('client') || '').slice(0, 200), project: String(q.get('project') || '').slice(0, 200),
    billable: q.get('billable') === '1' || q.get('billable') === 'true',
    sync: SYNC_FILTERS.includes(q.get('sync')) ? q.get('sync') : 'all',
    groupBy: GROUPS.includes(q.get('groupBy')) ? q.get('groupBy') : ''
  };
  return { period, filters };
}

// Billing is for administrators only. Everyone else sees their own logged hours and each entry's sync status:
// the billing fields are removed from rows, totals, groups and the export, and the billable filter is ignored.
const isAdminView = me => me.role === 'admin';
const without = (o, keys) => { const out = { ...o }; for (const k of keys) delete out[k]; return out; };
const BILLING_ROW_KEYS = ['billing', 'billingSource'];
const BILLING_TOTAL_KEYS = ['billableMinutes', 'notBillableMinutes', 'unclassifiedMinutes', 'billableText'];
const BILLING_GROUP_KEYS = ['billableMinutes', 'billableText'];
const BILLING_EXPORT_HEADERS = ['Billing', 'Billing source'];
export const viewRow = (r, admin) => (admin ? publicRow(r) : without(publicRow(r), BILLING_ROW_KEYS));
export const viewTotals = (t, admin) => (admin ? t : without(t, BILLING_TOTAL_KEYS));
export const viewGroups = (gs, admin) => (admin ? gs : gs.map(g => without(g, BILLING_GROUP_KEYS)));
export const exportColumns = admin => EXPORT_COLUMNS.filter(([h]) => admin || !BILLING_EXPORT_HEADERS.includes(h));

// The overview for one request: filters, totals and groups over everything; one page of rows.
export async function overviewView(env, me, url) {
  const admin = isAdminView(me);
  const { period, filters } = readFilters(url.searchParams);
  if (!admin) filters.billable = false;
  const q = url.searchParams;
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(q.get('limit')) || 50)));
  const offset = Math.max(0, Math.floor(Number(q.get('offset')) || 0));
  const all = await loadOverview(env, me, period);
  const matching = sortRows(applyFilters(all.rows, filters), filters.groupBy);
  const scope = all.rows;
  const options = {
    persons: [...new Set(scope.map(r => r.person).filter(Boolean))].sort(byName),
    clients: [...new Set(scope.map(r => r.client || ''))].sort(byName),
    projects: [...new Set(scope.map(r => r.project || ''))].sort(byName)
  };
  const agreed = me.role === 'admin' ? { count: all.agreed.length, minutes: all.agreed.reduce((n, a) => n + a.minutes, 0), durationText: formatHM(all.agreed.reduce((n, a) => n + a.minutes, 0)) } : null;
  return {
    period: { key: period.key, from: period.from, to: period.to, timeZone: TIME_ZONE },
    filters,
    rows: matching.slice(offset, offset + limit).map(r => viewRow(r, admin)),
    paging: { offset, limit, total: matching.length },
    totals: viewTotals(totalsOf(matching), admin),
    groups: filters.groupBy ? viewGroups(groupsOf(matching, filters.groupBy), admin) : [],
    agreed, options,
    odoo: all.odooInfo,
    canLog: canLog(all.cfg, me),
    isAdmin: admin
  };
}

// ---- CSV export: every matching row, not one page, with the same filters ----
const csvCell = v => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // a spreadsheet must not read a cell as a formula
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export const EXPORT_COLUMNS = [
  ['Work date', r => r.date], ['Person', r => r.person], ['Client', r => r.client], ['Project', r => r.project],
  ['Ticket', r => r.ticket || ''], ['Ticket title', r => r.ticketTitle], ['Task', r => r.task], ['Description', r => r.description],
  ['Duration', r => formatHM(r.minutes)], ['Minutes', r => r.minutes], ['Billing', r => BILLING_LABEL[r.billing] || r.billing],
  ['Billing source', r => r.billingSource], ['Source', r => (r.origin === 'odoo' ? 'Odoo' : 'Dashboard')], ['Sync status', r => r.statusLabel],
  ['Odoo line', r => r.lineId || ''], ['Work entry id', r => r.entryId || '']
];
export function csvOf(rows, columns = EXPORT_COLUMNS) {
  const head = columns.map(([h]) => csvCell(h)).join(',');
  return '﻿' + [head, ...rows.map(r => columns.map(([, f]) => csvCell(f(r))).join(','))].join('\r\n') + '\r\n';
}
export async function exportView(env, me, url) {
  const admin = isAdminView(me);
  const { period, filters } = readFilters(url.searchParams);
  if (!admin) filters.billable = false;
  const all = await loadOverview(env, me, period);
  const rows = sortRows(applyFilters(all.rows, filters), '');
  return { csv: csvOf(rows.map(publicRow), exportColumns(admin)), name: 'work-log-' + (period.from || 'all') + '-to-' + (period.to || 'all') + '.csv', count: rows.length };
}
