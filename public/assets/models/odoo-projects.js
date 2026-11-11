// The Odoo projects table (Clients page) and the Odoo project picker on tickets, without the page: filters, sorting,
// the CSV rows and the budget wording, so the table, its totals and Export CSV always agree.

// Near limit: logged hours at or above this share of the allocated hours (the backend's NEAR_LIMIT, sent with the list).
export const NEAR_LIMIT = 0.8;
export const BUDGET_LABEL = { over: 'Over budget', near: 'Near limit', on_track: 'Within budget', not_set: 'No allocation' };
const round = n => Math.round(n * 100) / 100;

// The same rule as the backend's budgetStatus, for a row updated in place after an allocation change. An empty allocation
// or zero allocation has no remaining hours or budget status to compare against.
export function budgetStatus(allocated, logged, near = NEAR_LIMIT) {
  if (allocated == null || allocated <= 0) return { status: 'not_set', remainingHours: null, overHours: 0, usedPercent: null };
  const remaining = round(allocated - logged);
  return { status: remaining < 0 ? 'over' : allocated > 0 && logged >= allocated * near ? 'near' : 'on_track', remainingHours: remaining, overHours: remaining < 0 ? -remaining : 0, usedPercent: allocated > 0 ? Math.round(logged / allocated * 1000) / 10 : null };
}

export const hours = n => n == null ? '' : round(n).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' h';
export const signedHours = n => n < 0 ? '−' + hours(-n) : hours(n);
export const percent = n => n == null ? '—' : (Math.round(n * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 }) + '%';
export const budgetText = p => p.status === 'over' ? 'Over by ' + hours(p.overHours) : BUDGET_LABEL[p.status];
// Linked tickets: dashboard tickets on the project, else tickets with an Odoo task there (older work).
export const hasTickets = p => (p.ticketCount || 0) > 0 || (p.links?.tickets?.count || 0) > 0;
export const linkText = p => p.mapped ? [...(p.links?.projects || []).map(l => l.name), ...(p.links?.epics || []), ...(p.links?.helpdesk ? ['Helpdesk'] : []), ...Object.entries(p.links?.tickets?.byProject || {}).map(([k, n]) => k + ': ' + n + (n === 1 ? ' ticket' : ' tickets'))].join('; ') : 'Not mapped';

// Billing (billing-v1, while classification is on): each row's billing default, consumption against its allowance and the
// last "allocated hours exhausted" alert. Minutes from the backend; shown in hours.
export const BILLING_DEFAULT = { billable: 'Billable', not_billable: 'Not billable' };
export const BILLING_STATUS = { needs_setup: 'Needs setup', not_billable: 'Not billable', no_allocation: 'No allocation', available: 'Available', near: 'Near limit', exhausted: 'Exhausted', overage: 'Over allocation', unlimited: 'Time & materials', disabled: 'Allowance off' };
export const BILLING_FILTERS = { billable: 'Billable', not_billable: 'Not billable', unclassified: 'Has unclassified work', needs_setup: 'Needs setup (no default)', no_allocation: 'No allocation', near: 'Near limit', exhausted: 'Exhausted', overage: 'Over allocation' };
const mh = m => m == null ? null : round(m / 60);
export const billingFigures = p => { const b = p.billing; if (!b) return null; const a = b.allowance;
  return { defaultLabel: BILLING_DEFAULT[b.default] || 'Not classified', workedHours: mh(b.actualMinutes), billableHours: mh(b.billableMinutes), consumedHours: a ? mh(a.consumedMinutes) : mh(b.chargeableMinutes),
    remainingHours: a && a.capacityMinutes != null ? (a.overageMinutes ? -mh(a.overageMinutes) : mh(a.remainingMinutes)) : null, allocatedHours: a ? mh(a.capacityMinutes) : null,
    statusLabel: BILLING_STATUS[b.status] || b.status, emailLabel: b.email ? b.email.label : '', unclassifiedHours: mh(b.unclassifiedMinutes), pool: !!a?.pool }; };
export function billingMatches(p, f) {
  const b = p.billing; if (!f) return true; if (!b) return false;
  if (f === 'billable' || f === 'not_billable') return b.default === f;
  if (f === 'unclassified') return b.unclassifiedMinutes > 0;
  if (f === 'exhausted') return b.status === 'exhausted' || b.status === 'overage';
  return b.status === f;
}
export const DEFAULT_VIEW = { q: '', status: '', client: '', missingClient: '', tickets: '', billing: '', dateField: 'created', dateFrom: '', dateTo: '', sort: 'created', dir: -1, page: 0 };
export const SORTS = {
  name: p => p.name.toLowerCase(), client: p => (p.client || '').toLowerCase() || null, created: p => p.createdAt ? Date.parse(p.createdAt) : null,
  allocated: p => p.allocatedHours, logged: p => p.loggedHours, remaining: p => p.remainingHours, used: p => p.usedPercent,
  status: p => ({ over: 0, near: 1, on_track: 2, not_set: 3 })[p.status] * 1e7 - p.overHours,
  consumed: p => p.billing ? (p.billing.allowance ? p.billing.allowance.consumedMinutes : p.billing.chargeableMinutes) : null,
  open: p => p.openTickets || 0, review: p => p.reviewTickets || 0, lastWork: p => p.lastWorkDate || null
};
// One project against the table's search and filters. Search covers the project and client names (and its tickets).
export function budgetMatches(p, v = DEFAULT_VIEW) {
  const q = String(v.q || '').trim().toLowerCase();
  return (!v.status || (v.status === 'unmapped' ? !p.mapped : p.status === v.status))
    && (!v.client || (v.client === '__none' ? !p.client : p.client === v.client))
    && (!v.missingClient || (v.missingClient === 'missing' ? !!p.missingClient : !p.missingClient))
    && (!v.tickets || (v.tickets === 'with' ? hasTickets(p) : !hasTickets(p)))
    && billingMatches(p, v.billing)
    && dateMatches(p, v)
    && (!q || [p.name, p.client, String(p.odooId), ...(p.links?.tickets?.keys || [])].join(' ').toLowerCase().includes(q));
}
// The calendar day (Asia/Jerusalem) of an instant as YYYY-MM-DD; '' when there is none.
export const jerusalemDay = iso => iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }) : '';
// Date ranges include both boundary days. Undated projects stay visible only without a range.
export function dateMatches(p, v) {
  if (!v.dateFrom && !v.dateTo) return true;
    const day = v.dateField==='lastWork'?String(p.lastWorkDate||'').slice(0,10):jerusalemDay(p.createdAt);
  return !!day && (!v.dateFrom || day >= v.dateFrom) && (!v.dateTo || day <= v.dateTo);
}
// Filtered and sorted. Rows with no value sort last whichever way; ties go by name, then Odoo id, so the order is stable.
export function budgetRows(rows, v = DEFAULT_VIEW) {
  const key = SORTS[v.sort] || SORTS.created, dir = v.dir || 1;
  return rows.filter(p => budgetMatches(p, v)).sort((a, b) => {
    const x = key(a), y = key(b), tie = a.name.localeCompare(b.name) || a.odooId - b.odooId;
    if (x == null || y == null) return x == null && y == null ? tie : x == null ? 1 : -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir || tie;
  });
}
// Export CSV: exactly the rows the table shows with its filters (every page), one line each.
export const CSV_HEADER = ['Odoo Project', 'Client', 'Created', 'Allocated Hours', 'Logged Hours', 'Remaining Hours', 'Budget Used %', 'Budget Status', 'Hours Over', 'Open Tickets', 'Tickets Needing PR Review', 'Last Work Log', 'Not in Odoo yet (h)', 'Linked Jira Project / Tickets', 'Company', 'Odoo ID'];
// With billing, the billing columns follow (hours; remaining is negative when over the allocation).
export const BILLING_CSV_HEADER = ['Billing Default', 'Worked Hours', 'Billable Hours', 'Consumed Hours', 'Allowance Hours', 'Allowance Remaining Hours', 'Billing Status', 'Unclassified Hours', 'Alert Email'];
export function budgetCsvRows(list) {
  const billing = list.some(p => p.billing);
  const extra = p => { const f = billingFigures(p); return f ? [f.defaultLabel, f.workedHours, f.billableHours, f.consumedHours, f.allocatedHours ?? '', f.remainingHours ?? '', f.statusLabel, f.unclassifiedHours || '', f.emailLabel] : BILLING_CSV_HEADER.map(() => ''); };
  return [billing ? [...CSV_HEADER, ...BILLING_CSV_HEADER] : CSV_HEADER, ...list.map(p => [p.name, p.client || (p.missingClient ? 'No client' : ''), p.createdAt ? p.createdAt.slice(0, 10) : '', p.allocatedHours ?? 'No allocation', p.loggedHours, p.remainingHours ?? '', p.usedPercent ?? '', budgetText(p), p.overHours || '', p.openTickets ?? '', p.reviewTickets ?? '', p.lastWorkDate || '', p.pendingHours || '', linkText(p), p.company || '', p.odooId, ...(billing ? extra(p) : [])])];
}
// Counts for the summary chips, for the rows given (all projects, or the filtered ones), so each label can say which.
export function budgetCounts(list) {
  const n = f => list.filter(f).length;
  return { projects: list.length, over: n(p => p.status === 'over'), near: n(p => p.status === 'near'), notSet: n(p => p.status === 'not_set'), unmapped: n(p => !p.mapped), missingClient: n(p => p.missingClient) };
}

// The Odoo project picker on a ticket: active projects with a client, by label ("Client → Project", with the Odoo id
// where two read the same). The ticket's own project stays listed when it is archived or has lost its client, so it shows.
export function projectChoices(projects, currentId = null) {
  const sorted = [...projects].sort((a, b) => a.label.localeCompare(b.label));
  const choices = sorted.filter(p => !p.archived && !p.missingClient).map(p => ({ id: p.id, label: p.label, clientName: p.clientName, disabled: false }));
  const current = currentId != null && sorted.find(p => p.id === currentId);
  if (current && !choices.some(c => c.id === currentId)) choices.push({ id: current.id, label: current.label + (current.archived ? ' (archived)' : ' (no client)'), clientName: current.clientName, disabled: true });
  if (currentId != null && !current) choices.push({ id: currentId, label: 'Odoo project #' + currentId + ' (not found)', clientName: '', disabled: true });
  return { choices, noClient: sorted.filter(p => !p.archived && p.missingClient) };
}

// The filters behind the Clients page's Filters button (search and client stay in view), for its count.
export const hiddenFilterCount = v => ['status', 'missingClient', 'tickets', 'billing'].filter(k => v[k]).length;
// Map tickets offers the table's own rows: the projects a ticket can be given (in the last sync, active, with a client).
export const assignableProjects = rows => rows.filter(p => p.assignable)
  .map(p => ({ id: p.odooId, label: p.label || (p.client || 'No client') + ' → ' + p.name, client: p.client, name: p.name }))
  .sort((a, b) => a.label.localeCompare(b.label));
export const MAPPING_KINDS = { ready: 'Ready', missing: 'Missing', ambiguous: 'Ambiguous', conflict: 'Conflict' };
// A ticket's suggested project: only a ready ticket's, the one Odoo project its catalog project links, and only while the
// table offers it. linked: the projects an ambiguous ticket's project links, listed first in its picker but not chosen.
export function mappingSuggestion(row, choices) {
  const offered = id => choices.some(c => c.id === id);
  return { id: row.kind === 'ready' && offered(row.odooProjectId) ? row.odooProjectId : null,
    linked: row.kind === 'ambiguous' ? (row.candidates || []).map(c => c.id).filter(offered) : [] };
}
// The rows Map tickets lists: by kind and by search over key, title, client and project. For one project, the tickets
// already pointing at it (ready or linked) come first; otherwise the plan's order (by key) stays.
export function mappingRows(rows, { kind = '', q = '', titles = {}, project = null } = {}) {
  const s = String(q || '').trim().toLowerCase();
  const out = rows.filter(r => (!kind || r.kind === kind) && (!s || [r.key, titles[r.key], r.client, r.project].some(x => String(x || '').toLowerCase().includes(s))));
  if (project == null) return out;
  const near = r => r.odooProjectId === project || (r.candidates || []).some(c => c.id === project);
  return [...out.filter(near), ...out.filter(r => !near(r))];
}
export const mappingCounts = (rows, done = new Set()) => {
  const left = rows.filter(r => !done.has(r.key)), c = { all: left.length };
  for (const k of Object.keys(MAPPING_KINDS)) c[k] = left.filter(r => r.kind === k).length;
  return c;
};
