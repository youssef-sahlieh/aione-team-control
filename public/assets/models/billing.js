// The billable export and billing labels without the page: CSV rows for the entry detail and the task summary, and the
// cell escaping that keeps a spreadsheet from running text as a formula. Minutes stay whole minutes in the file.

export const KIND_LABEL = { package: 'Commercial package', estimate: 'Internal estimate', fixed_fee: 'Fixed-fee budget', t_and_m: 'Unlimited time & materials', none: 'No allocation' };
export const EFFECTIVE_LABEL = { billable: 'Billable', not_billable: 'Not billable', unclassified: 'Not classified' };
export const SOURCE_LABEL = { ticket: 'set on the ticket', project: 'from the project default', none: 'no project default yet', export: 'exported before' };
export const EXPORT_STATE = { new: 'New', adjustment: 'Adjustment', exported: 'Exported', none: 'Not charged' };
export const SYNC_LABEL = { not_configured: 'No Odoo field mapped', not_sent: 'Not sent to Odoo', waiting: 'Waiting for the Odoo task', synced: 'Saved in Odoo', failed: 'Not saved in Odoo' };
export const minutesText = m => { if (m == null) return '—'; const s = m < 0 ? '−' : '', a = Math.abs(m), h = Math.floor(a / 60), r = a % 60; return s + (h ? h + 'h' + (r ? ' ' + r + 'm' : '') : r + 'm'); };

// A cell: quoted when it holds a comma, quote or line break; text a spreadsheet would run as a formula (= + - @) gets a
// leading apostrophe. Numbers stay numbers, negative ones included.
export const csvCell = v => { const s = String(v ?? ''), formula = typeof v === 'string' && /^[=+\-@]/.test(s); return /[",\n\r]/.test(s) || formula ? '"' + (formula ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
export const csvText = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');

export const ENTRY_HEADER = ['Batch ID', 'Entry / Charge ID', 'Date', 'Customer', 'Project', 'Ticket', 'Odoo Task ID', 'Worker', 'Description', 'Actual Minutes', 'Chargeable Minutes', 'Exported Before (min)', 'Change (min)', 'Billing', 'Billing Origin', 'Allowance / Order Line', 'Coverage', 'Sync State', 'Export State'];
const allowanceRef = (r, names = {}) => [r.allowanceId ? names[r.allowanceId] || r.allowanceId : '', r.saleOrderLineId ? 'SO line ' + r.saleOrderLineId : ''].filter(Boolean).join(' / ');
export function entryCsvRows(rows, { batchId = '', allowances = {} } = {}) {
  return [ENTRY_HEADER, ...rows.map(r => [r.batchId || batchId, r.chargeId, r.date, r.customer, r.project, r.ticket, r.taskId ?? '', r.worker, r.description, r.actualMinutes, r.chargeableMinutes, r.exportedMinutes ?? 0, r.deltaMinutes ?? r.chargeableMinutes,
    EFFECTIVE_LABEL[r.billing?.value] || '', r.originLabel || '', allowanceRef(r, allowances), r.coverageLabel || '', r.syncLabel || r.state || '', EXPORT_STATE[r.exportState] || r.exportState || ''])];
}
export const TASK_HEADER = ['Customer', 'Project', 'Ticket', 'Title', 'Odoo Task ID', 'Rows', 'Actual Minutes', 'Chargeable Minutes', 'Change (min)', 'Billing Origin', 'Coverage'];
export function taskCsvRows(tasks) {
  return [TASK_HEADER, ...tasks.map(t => [t.customer, t.project, t.ticket, t.title, t.taskId ?? '', t.entries, t.actualMinutes, t.chargeableMinutes, t.deltaMinutes, t.origins, t.coverage])];
}
// The allowance line on the Allowances list: "7h of 10h · 3h left" or "12h of 10h · 2h over".
export function allowanceText(a) {
  if (a.capacityMinutes == null) return KIND_LABEL[a.kind] || a.kind;
  return minutesText(a.consumedMinutes) + ' of ' + minutesText(a.capacityMinutes) + ' · ' + (a.overageMinutes ? minutesText(a.overageMinutes) + ' over' : minutesText(a.remainingMinutes) + ' left');
}
