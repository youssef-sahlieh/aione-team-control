// Synthetic Odoo for the local preview only: sample clients, projects, tasks and timesheet lines, generated from today's date.
// Nothing here reads or writes a real Odoo; the preview's fetch sends only odoo.preview.invalid calls to this module.
import { todayIn } from '../proxy/src/time-entries.js';

const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const matches = (rec, [field, op, v]) => {
  const x = rec[field], id = Array.isArray(x) ? x[0] : x;
  if (op === '=') return v === false ? (x === false || x == null) : id === v;
  if (op === 'in') return v.includes(id);
  if (op === 'ilike') return String(x ?? '').toLowerCase().includes(String(v).toLowerCase());
  // =like: % is any text, _ is one character; case is kept, as in Odoo.
  if (op === '=like') return new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$').test(String(x ?? ''));
  if (op === '>=') return x >= v;
  if (op === '<=') return x <= v;
  throw new Error('operator ' + op);
};
const evalDomain = (rec, dom) => {
  let i = 0;
  const one = () => { if (dom[i] === '|') { i++; const a = one(), b = one(); return a || b; } return matches(rec, dom[i++]); };
  let ok = true; while (i < dom.length) ok = one() && ok; return ok;
};
const pick = (rec, fields) => { const out = { id: rec.id }; for (const f of fields?.length ? fields : Object.keys(rec)) if (f in rec) out[f] = rec[f]; return out; };

const PROJECTS = [
  { id: 10, name: 'Branch A redesign', partner_id: [900, 'Acme'], active: true, allocated_hours: 40, description: false },
  { id: 20, name: 'Website relaunch', partner_id: [901, 'Beta & Co'], active: true, allocated_hours: false, description: false },
];
const TASKS = [
  { id: 1, name: '[AION-101] Checkout fails on retry', project_id: [10, 'Branch A redesign'], x_billing: 'n', create_date: '2026-01-05 09:00:00' },
  { id: 2, name: 'Fix login page layout', project_id: [10, 'Branch A redesign'], x_billing: 'b', create_date: '2026-01-05 09:00:00' },
  { id: 3, name: 'Docs', project_id: [10, 'Branch A redesign'], x_billing: 'i', create_date: '2026-01-05 09:00:00' },
  { id: 4, name: 'Support call', project_id: [10, 'Branch A redesign'], x_billing: 'n', create_date: '2026-01-05 09:00:00' },
  { id: 5, name: 'Website copy', project_id: [20, 'Website relaunch'], x_billing: false, create_date: '2026-01-05 09:00:00' },
  { id: 6, name: 'Late task created in 2025', project_id: [10, 'Branch A redesign'], x_billing: 'b', create_date: '2025-06-01 00:00:00' },
];
const DESCRIPTIONS = ['Reviewed the pull request', 'Client call about scope', 'Wrote regression tests', 'Updated the copy', 'Set up the staging data', 'Triage of incoming requests'];

// The sample timesheet: about 120 lines over the last 45 days, mostly in Odoo, some on tasks and some without a task.
export function sampleLines(today = todayIn()) {
  const lines = [];
  for (let i = 0; i < 120; i++) {
    const date = addDays(today, -(i % 45));
    const onSecond = i % 3 === 0;
    const pid = onSecond ? 20 : 10;
    const task = pid === 20 ? 5 : [1, 2, 3, 4, 6][i % 5];
    lines.push({
      id: 1000 + i, date, unit_amount: [0.5, 1, 1.5, 2, 3][i % 5],
      name: DESCRIPTIONS[i % DESCRIPTIONS.length] + ' #' + i,
      project_id: [pid, pid === 10 ? 'Branch A redesign' : 'Website relaunch'],
      task_id: i % 7 === 0 ? false : [task, TASKS.find(t => t.id === task)?.name || ''],
      user_id: [7, i % 2 ? 'Dana Developer' : 'Sam Builder'], x_entry_uuid: false,
    });
  }
  return lines;
}

// Answers one Odoo JSON-RPC call from the sample data. Unknown models answer with an empty list.
export function respondOdoo(init, lines = sampleLines()) {
  const b = JSON.parse(init.body), { service, args } = b.params;
  const reply = result => Response.json({ jsonrpc: '2.0', id: b.id, result });
  if (service === 'common') return reply(7);
  const [, , , model, method, a = [], kw = {}] = args;
  if (model === 'res.users' && method === 'search_read') return reply([{ id: 7, company_ids: [1, 2] }]);
  if (model === 'project.project' && method === 'search_read') return reply(PROJECTS.filter(p => evalDomain(p, a[0])).map(p => pick(p, kw.fields)));
  if (model === 'project.task' && method === 'search_read') return reply(TASKS.filter(t => evalDomain(t, a[0])).map(t => pick(t, kw.fields)));
  if (model === 'account.analytic.line' && method === 'search_read') {
    let rows = lines.filter(l => evalDomain(l, a[0]));
    if (kw.order) rows = [...rows].sort((x, y) => (y.date.localeCompare(x.date)) || (y.id - x.id));
    if (kw.limit) rows = rows.slice(0, kw.limit);
    return reply(rows.map(l => pick(l, kw.fields)));
  }
  return reply([]);
}

// The sample clients and projects the Clients & projects page reads from the store, as the Odoo sync leaves them.
export const sampleProjects = () => [
  { id: 10, name: 'Branch A redesign', active: true, clientId: 900, clientName: 'Acme', label: 'Acme → Branch A redesign' },
  { id: 20, name: 'Website relaunch', active: true, clientId: 901, clientName: 'Beta & Co', label: 'Beta & Co → Website relaunch' },
];
