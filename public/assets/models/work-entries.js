// The work view of Clients & projects (administrators): its filters, the request it sends, and its labels and CSV. Pure
// logic only; the page is components/work-entries.js and the rows come from GET /clients/odoo-projects/work-entries
// (proxy/src/work-entries.js). Every filter but the page resets the page to the first one.
import { csvCell } from './billing.js';

export const PERIODS = { month: 'This month', last_month: 'Last month', last_30: 'Last 30 days', all: 'All dates', custom: 'Custom dates' };
export const PAGE_SIZES = [25, 50, 100];
export const DEFAULT_WORK = { q: '', client: '', project: '', period: 'month', from: '', to: '', billable: false, offset: 0, limit: 50 };
export const BILLING_LABEL = { billable: 'Billable', not_billable: 'Not billable', unclassified: 'Not classified' };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = d => { if (!DAY.test(d)) return false; const t = Date.parse(d + 'T00:00:00Z'); return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d; };

// Why the custom dates cannot be used, in words. Empty: they can.
export function customPeriodError(from, to) {
  if (!validDay(from) || !validDay(to)) return 'Choose valid start and end dates.';
  if (from > to) return 'The start date is after the end date.';
  if (Date.parse(to) - Date.parse(from) > 400 * 86400000) return 'Choose at most about a year.';
  return '';
}

// The request for one page of work: every filter the view holds. The server checks the same rules again.
export function workQuery(v) {
  const p = new URLSearchParams();
  p.set('period', v.period || 'month');
  if (v.period === 'custom') { p.set('from', v.from || ''); p.set('to', v.to || ''); }
  if (v.client) p.set('client', v.client);
  if (v.project) p.set('project', v.project);
  if (v.q && v.q.trim()) p.set('search', v.q.trim());
  if (v.billable) p.set('billable', '1');
  p.set('limit', String(v.limit || 50));
  p.set('offset', String(v.offset || 0));
  return p.toString();
}
// The same filters for the export: every matching row, not one page.
export const exportQuery = v => workQuery({ ...v, offset: 0 }).replace(/&limit=\d+&offset=\d+$/, '') + '&export=1';
// A filter changed: the same view, from its first page.
export const withFilter = (v, patch) => ({ ...v, ...patch, offset: 0 });

export const taskLabel = r => r.task ? (r.task.key ? r.task.key + ' ' : '') + r.task.name : 'No task';
export function billingLabel(b) {
  const base = BILLING_LABEL[b.value] || 'Not classified';
  if (b.value === 'unclassified') return base;
  return base + (b.source === 'project' ? ' (project default)' : b.source === 'ticket' ? ' (set on the ticket)' : '');
}
export const hoursText = h => (Math.round((h || 0) * 100) / 100).toString();
export const summaryText = t => t.count + (t.count === 1 ? ' entry' : ' entries') + ' · ' + hoursText(t.hours) + ' h actual · ' + hoursText(t.billableHours) + ' h billable actual';
export const pendingText = t => t.count + (t.count === 1 ? ' entry' : ' entries') + ' · ' + hoursText(t.hours) + ' h not in Odoo yet';

// The rows of the CSV: the Odoo lines, then the dashboard work not in Odoo yet, marked as such.
const HEAD = ['Work date', 'Client', 'Project', 'Ticket / task', 'Person', 'Description', 'Hours', 'Billing', 'Source'];
export function workCsv(entries, pending = []) {
  const line = r => [r.date, r.client?.name || '', r.project?.name || '', taskLabel(r), r.person || '', r.description || '', r.hours, billingLabel(r.billing), r.source === 'dashboard' ? 'Dashboard, not in Odoo yet' : 'Odoo'];
  return '﻿' + [HEAD, ...entries.map(line), ...pending.map(line)].map(r => r.map(csvCell).join(',')).join('\r\n');
}
