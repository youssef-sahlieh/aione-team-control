// The Odoo projects table (Clients page) and the Odoo project picker on tickets, without the page: filters, sorting,
// the CSV rows and the budget wording, so the table, its totals and Export CSV always agree.

// Near limit: logged hours at or above this share of the allocated hours (the backend's NEAR_LIMIT, sent with the list).
export const NEAR_LIMIT = 0.8;
export const BUDGET_LABEL = { over: 'Over budget', near: 'Near limit', on_track: 'Within budget', not_set: 'Allocation not set' };
const round = n => Math.round(n * 100) / 100;

// The same rule as the backend's budgetStatus, for a row updated in place after an allocation change. An empty allocation
// is not set (no remaining hours, no share); an explicit zero is an allocation that any logged time is over.
export function budgetStatus(allocated, logged, near = NEAR_LIMIT) {
  if (allocated == null) return { status: 'not_set', remainingHours: null, overHours: 0, usedPercent: null };
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

export const DEFAULT_VIEW = { q: '', status: '', client: '', missingClient: '', tickets: '', sort: 'created', dir: -1, page: 0 };
export const SORTS = {
  name: p => p.name.toLowerCase(), client: p => (p.client || '').toLowerCase() || null, created: p => p.createdAt ? Date.parse(p.createdAt) : null,
  allocated: p => p.allocatedHours, logged: p => p.loggedHours, remaining: p => p.remainingHours, used: p => p.usedPercent,
  status: p => ({ over: 0, near: 1, on_track: 2, not_set: 3 })[p.status] * 1e7 - p.overHours,
  open: p => p.openTickets || 0, review: p => p.reviewTickets || 0, lastWork: p => p.lastWorkDate || null
};
// One project against the table's search and filters. Search covers the project and client names (and its tickets).
export function budgetMatches(p, v = DEFAULT_VIEW) {
  const q = String(v.q || '').trim().toLowerCase();
  return (!v.status || (v.status === 'unmapped' ? !p.mapped : p.status === v.status))
    && (!v.client || (v.client === '__none' ? !p.client : p.client === v.client))
    && (!v.missingClient || (v.missingClient === 'missing' ? !!p.missingClient : !p.missingClient))
    && (!v.tickets || (v.tickets === 'with' ? hasTickets(p) : !hasTickets(p)))
    && (!q || [p.name, p.client, String(p.odooId), ...(p.links?.tickets?.keys || [])].join(' ').toLowerCase().includes(q));
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
export function budgetCsvRows(list) {
  return [CSV_HEADER, ...list.map(p => [p.name, p.client || (p.missingClient ? 'No client' : ''), p.createdAt ? p.createdAt.slice(0, 10) : '', p.allocatedHours ?? 'Allocation not set', p.loggedHours, p.remainingHours ?? '', p.usedPercent ?? '', budgetText(p), p.overHours || '', p.openTickets ?? '', p.reviewTickets ?? '', p.lastWorkDate || '', p.pendingHours || '', linkText(p), p.company || '', p.odooId])];
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
