// The project billing workspace (Clients & projects, administrators): one project's tickets with their billing and
// hours, and the export/import files. Pure logic only: the page is components/project-workspace.js, the figures come
// from GET /clients/odoo-projects/tickets and the import is checked and saved by the server (project-workspace.js).
import { csvCell } from './billing.js';
import { detectColumns, pickTable, rowsFromTable } from './table-import.js';

export const CLEAR = '[clear]';
export const SOURCE = { jira: 'Jira', internal: 'Internal', odoo: 'Helpdesk' };
export const OVERRIDE = { billable: 'Billable', not_billable: 'Not billable' };
export const EFFECTIVE = { billable: 'Billable', not_billable: 'Not billable', unclassified: 'Not classified' };
export const ORIGIN = { ticket: 'Set on the ticket', project: 'Project default', none: 'No project default' };
export const STATUS_FILTERS = { open: 'Open', closed: 'Closed' };
export const PROBLEM_FILTERS = { any: 'Any sync or setup problem', pending: 'Work not in Odoo yet', review: 'Work needing review', failed: 'Billing not saved in Odoo', unclassified: 'Not classified' };
export const SORTS = { key: 'Ticket', title: 'Title', status: 'Status', actual: 'Actual hours', commercial: 'Commercial hours', agreed: 'Agreed hours', estimated: 'Estimated hours' };
export const DEFAULT_VIEW = { q: '', status: '', dev: '', source: '', billing: '', problems: '', sort: 'key', dir: 1, page: 0, size: 25 };
export const PAGE_SIZES = [25, 50, 100];

const round = n => Math.round(n * 100) / 100;
export const minutesHours = m => round((m || 0) / 60);
const text = s => String(s ?? '').toLowerCase();
const byKey = (a, b) => a.key.localeCompare(b.key, undefined, { numeric: true });

// What is wrong with a ticket's billing or its sync, in words. Empty: nothing.
export function ticketProblems(t) {
  const out = [];
  if (t.sync?.pendingMinutes > 0) out.push({ kind: 'pending', label: minutesHours(t.sync.pendingMinutes) + ' h not in Odoo yet' });
  if (t.sync?.review > 0) out.push({ kind: 'review', label: t.sync.review + (t.sync.review === 1 ? ' entry needs' : ' entries need') + ' review' });
  if (t.sync?.billingField?.state === 'failed') out.push({ kind: 'failed', label: 'Billing not saved in Odoo' + (t.sync.billingField.error ? ': ' + t.sync.billingField.error : '') });
  if (t.effective?.value === 'unclassified') out.push({ kind: 'unclassified', label: 'Not classified: set the project default or the ticket' });
  return out;
}
export const syncLabel = t => { const p = ticketProblems(t); if (p.length) return p.map(x => x.label).join(' · '); return t.sync?.billingField?.state === 'synced' ? 'Saved in Odoo' : 'OK'; };
// Commercial hours: what the ticket charges in the period (agreed hours once, else billable work; not billable: 0).
export const commercialHours = t => minutesHours(t.chargeableMinutes);
export const actualHours = t => minutesHours(t.actualMinutes);
export const isOpen = t => !t.closed && !t.completedAt;

export function ticketMatches(t, v = DEFAULT_VIEW) {
  if (v.q) { const q = text(v.q).trim(); if (q && ![t.key, t.title, t.description, t.assignee, ...(t.devs || []), t.agreedDeveloper].some(x => text(x).includes(q))) return false; }
  if (v.status === 'open' && !isOpen(t)) return false;
  if (v.status === 'closed' && isOpen(t)) return false;
  if (v.dev && !(t.devs || []).includes(v.dev)) return false;
  if (v.source && t.source !== v.source) return false;
  if (v.billing) {
    if (v.billing === 'inherit' ? t.override : v.billing.startsWith('override:') ? t.override !== v.billing.slice(9) : t.effective?.value !== v.billing) return false;
  }
  if (v.problems) { const p = ticketProblems(t); if (v.problems === 'any' ? !p.length : !p.some(x => x.kind === v.problems)) return false; }
  return true;
}
const SORT_VALUE = { key: null, title: t => text(t.title), status: t => text(t.status), actual: t => t.actualMinutes || 0, commercial: t => t.chargeableMinutes || 0, agreed: t => t.agreedHours ?? -1, estimated: t => t.estimatedHours ?? -1 };
export function sortTickets(list, sort = 'key', dir = 1) {
  const f = SORT_VALUE[sort];
  return [...list].sort((a, b) => { if (!f) return dir * byKey(a, b); const x = f(a), y = f(b); return (x < y ? -dir : x > y ? dir : 0) || byKey(a, b); });
}
// The page of rows to show, and how many match: filters and sort cover the whole list, not one page.
export function ticketView(list, v = DEFAULT_VIEW) {
  const matching = sortTickets(list.filter(t => ticketMatches(t, v)), v.sort, v.dir), size = v.size || 25, pages = Math.max(1, Math.ceil(matching.length / size)), page = Math.min(Math.max(0, v.page || 0), pages - 1);
  return { matching, rows: matching.slice(page * size, page * size + size), page, pages, from: page * size };
}
export function ticketTotals(list) {
  const sum = f => round(list.reduce((n, t) => n + (f(t) || 0), 0));
  return { tickets: list.length, open: list.filter(isOpen).length, estimatedHours: sum(t => t.estimatedHours), agreedHours: sum(t => t.agreedHours), actualHours: round(sum(t => t.actualMinutes) / 60), commercialHours: round(sum(t => t.chargeableMinutes) / 60) };
}
export const developers = list => [...new Set(list.flatMap(t => t.devs || []))].sort((a, b) => a.localeCompare(b));
export const hiddenCount = v => ['status', 'dev', 'source', 'billing', 'problems'].filter(k => v[k]).length;

// ---- Files ----
// One header list for each sheet, used by both the export and the import (the import finds the columns by these names).
export const PROJECT_COLUMNS = ['Odoo Project ID', 'Project', 'Customer', 'Billing Default', 'Allocated Hours', 'Logged Hours (Odoo)', 'Worked Hours (period)', 'Billable Hours (period)', 'Consumed Hours', 'Allowance Remaining Hours', 'Billing Status', 'Open Tickets', 'Tickets', 'Exported At'];
export const TICKET_COLUMNS = ['Ticket', 'Source', 'Odoo Project ID', 'Project', 'Customer', 'Title', 'Description', 'Status', 'Developers', 'Assignee', 'Billing Override', 'Effective Billing', 'Billing Origin', 'Estimated Hours', 'Agreed Hours', 'Agreed Developer', 'Actual Hours (period)', 'Commercial Hours (period)', 'Consumed Hours (lifetime)', 'Period From', 'Period To', 'Odoo Sync', 'Revision', 'Exported At'];
const BILLING_DEFAULT_TEXT = { billable: 'Billable', not_billable: 'Not billable' };
const n = v => v == null ? '' : v;

export function projectSheetRows(projects, exportedAt) {
  return projects.map(p => { const b = p.billing, a = b?.allowance;
    return [p.odooId, p.name, p.client || '', b ? BILLING_DEFAULT_TEXT[b.default] || 'Not classified' : '', n(p.allocatedHours), n(p.loggedHours), b ? minutesHours(b.actualMinutes) : '', b ? minutesHours(b.billableMinutes) : '',
      b ? minutesHours(a ? a.consumedMinutes : b.chargeableMinutes) : '', a && a.capacityMinutes != null ? round((a.overageMinutes ? -a.overageMinutes : a.remainingMinutes) / 60) : '', b?.status || '', p.openTickets || 0, p.ticketCount || 0, exportedAt]; });
}
// tickets: rows from the tickets endpoint; project: {odooId,name,client} by id; scope: the period of each row.
export function ticketSheetRows(tickets, projectsById, exportedAt, scopeOf = t => t.scope) {
  return tickets.map(t => { const p = projectsById[t.projectId] || {}, s = scopeOf(t) || {};
    return [t.key, SOURCE[t.source] || t.source, n(t.projectId), p.name || '', p.client || '', t.title || '', t.description || '', t.status || (t.closed ? 'Closed' : ''), (t.devs || []).join(', '), t.assignee || '',
      OVERRIDE[t.override] || 'Inherit', EFFECTIVE[t.effective?.value] || '', ORIGIN[t.effective?.source] || '', n(t.estimatedHours), n(t.agreedHours), t.agreedDeveloper || '',
      actualHours(t), commercialHours(t), minutesHours(t.consumedMinutes), s.from || '', s.to || '', syncLabel(t), t.revision ?? 0, exportedAt]; });
}
const HOURS = new Set(['Allocated Hours', 'Logged Hours (Odoo)', 'Worked Hours (period)', 'Billable Hours (period)', 'Consumed Hours', 'Allowance Remaining Hours', 'Estimated Hours', 'Agreed Hours', 'Actual Hours (period)', 'Commercial Hours (period)', 'Consumed Hours (lifetime)']);
export const sheetColumns = header => header.map(h => ({ header: h, ...(HOURS.has(h) ? { type: 'hours' } : {}), width: /Description|Title/.test(h) ? 50 : undefined }));
// CSV: UTF-8 with a BOM (Excel reads Hebrew), CRLF, quoted multiline text, and a quote before text a spreadsheet would run.
export const csvFile = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
// A file name part from a project name, keeping Hebrew and other letters.
export const fileSlug = s => String(s || '').normalize('NFKC').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';

// ---- Import ----
export const PROJECT_FIELDS = { odooId: { label: 'Odoo Project ID', aliases: ['odoo id', 'project id'], required: true }, customer: { label: 'Customer', aliases: ['client'] }, billing: { label: 'Billing Default', aliases: ['billing', 'default billing'] }, allocatedHours: { label: 'Allocated Hours', aliases: ['allocation', 'allocated'] }, exportedAt: { label: 'Exported At' } };
export const TICKET_FIELDS = { key: { label: 'Ticket', aliases: ['ticket key', 'key', 'issue'], required: true }, odooProjectId: { label: 'Odoo Project ID', aliases: ['odoo id', 'project id'] }, customer: { label: 'Customer', aliases: ['client'] }, billing: { label: 'Billing Override', aliases: ['billing', 'ticket billing'] }, agreedHours: { label: 'Agreed Hours', aliases: ['agreed'] }, agreedDeveloper: { label: 'Agreed Developer' }, revision: { label: 'Revision' } };
export const IMPORT_LIMIT = 300;
// The two tables from a file: an .xlsx with Projects and Tickets sheets, or a CSV of either.
export function importTables(sheets) {
  const find = (fields, prefer) => { const named = sheets.filter(s => s.name.toLowerCase().startsWith(prefer)), t = pickTable(named.length ? named : sheets, fields); return t && !t.missing.length ? t : null; };
  let tickets = find(TICKET_FIELDS, 'ticket'), projects = find(PROJECT_FIELDS, 'project');
  // One CSV: a table with a Ticket column is the tickets, else it is the projects.
  if (tickets && projects && tickets.sheet === projects.sheet && tickets.headerRow === projects.headerRow) projects = null;
  return { projects, tickets };
}
// Rows for the import endpoint. Blank cells stay blank (unchanged); [clear] is passed as it is.
export function importBody(sheets) {
  const { projects, tickets } = importTables(sheets), out = { projects: [], tickets: [] }, notes = [];
  if (!projects && !tickets) return { body: out, notes: ['No Projects or Tickets table found. Use a file exported here, or the template: it needs an "Odoo Project ID" or "Ticket" column.'] };
  for (const [name, t, fields] of [['projects', projects, PROJECT_FIELDS], ['tickets', tickets, TICKET_FIELDS]]) {
    if (!t) continue;
    const { rows, skippedBlank, truncated } = rowsFromTable(t, t.map, fields, { limit: IMPORT_LIMIT });
    for (const r of rows) { const row = { row: r.line }; for (const k in fields) if (t.map[k] >= 0) row[k] = r.values[k]; out[name].push(row); }
    if (truncated) notes.push('Only the first ' + IMPORT_LIMIT + ' ' + name + ' rows are read. Split the file.');
    if (skippedBlank) notes.push(skippedBlank + ' empty ' + name + ' row' + (skippedBlank === 1 ? '' : 's') + ' skipped.');
    const unused = Object.keys(fields).filter(k => t.map[k] < 0 && !fields[k].required);
    if (unused.length) notes.push(name[0].toUpperCase() + name.slice(1) + ': no ' + unused.map(k => '"' + fields[k].label + '"').join(', ') + ' column, so ' + (unused.length === 1 ? 'it stays' : 'they stay') + ' as ' + (unused.length === 1 ? 'it is' : 'they are') + '.');
  }
  return { body: out, notes };
}
export const RESULT = { applied: 'Applied', partial: 'Partly applied', failed: 'Failed', not_applied: 'Not applied', unchanged: 'Unchanged', ok: 'Ready', error: 'Error' };
const changeText = c => c.label + ': ' + (c.from ?? 'empty') + ' → ' + (c.to ?? 'empty');
// The downloadable report: every row with its result, so failed rows can be fixed and imported again.
export function reportRows(result) {
  return [['Sheet', 'Row', 'ID', 'Name', 'Result', 'Changes', 'Errors', 'Warnings', 'Message'],
    ...result.rows.map(r => [r.sheet === 'projects' ? 'Projects' : 'Tickets', r.row, r.id, r.name || r.title || '', RESULT[r.result || r.status] || r.result || r.status, (r.changes || []).map(changeText).join('; '), (r.errors || []).join(' '), (r.warnings || []).join(' '), r.message || ''])];
}
// The rows to send again: only those that did not apply (failed, partial or not applied), by their row numbers.
export function retryBody(body, result) {
  const again = new Set(result.rows.filter(r => ['failed', 'partial', 'not_applied'].includes(r.result)).map(r => r.sheet + ':' + r.row));
  return { projects: body.projects.filter(r => again.has('projects:' + r.row)), tickets: body.tickets.filter(r => again.has('tickets:' + r.row)) };
}
export const changeLine = changeText;
// The template: the columns, one example row each, and how blank and [clear] work.
export function templateSheets() {
  return [
    { name: 'Projects', columns: sheetColumns(['Odoo Project ID', 'Customer', 'Billing Default', 'Allocated Hours', 'Exported At']), rows: [[123, 'Customer name (checked)', 'Billable', 40, '']], validations: [{ column: 2, list: ['Billable', 'Not billable', 'Not classified'] }] },
    { name: 'Tickets', columns: sheetColumns(['Ticket', 'Odoo Project ID', 'Customer', 'Billing Override', 'Agreed Hours', 'Agreed Developer', 'Revision']), rows: [['INT-1', 123, 'Customer name (checked)', 'Inherit', 3, '', '']], validations: [{ column: 3, list: ['Inherit', 'Billable', 'Not billable'] }] },
    { name: 'How to fill', columns: [{ header: 'Rule', width: 100 }], rows: [['A blank cell leaves the value as it is. To empty a value, write [clear].'], ['Billing Default: Billable, Not billable or Not classified. Billing Override: Inherit, Billable or Not billable.'], ['Hours use a dot or a comma for decimals (12.5 or 12,5).'], ['Customer is checked against the project and never changed by the import.'], ['Revision and Exported At come from an export: a row changed since then is refused. Export again to get fresh values.'], ['Agreed Developer: one of the ticket’s developers (its id or name). Needed when the ticket has several.']] }
  ];
}
