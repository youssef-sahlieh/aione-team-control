// The Work entries view of Clients & projects (administrators): one flat table of Odoo timesheet rows across projects,
// with one toolbar, a summary, the work not in Odoo yet, paging and CSV export. Every figure comes from the server, which
// applies the period and the filters to every matching row; this page only sends the filters and shows the answer.
import { DEFAULT_WORK, PAGE_SIZES, PERIODS, customPeriodError, workQuery, exportQuery, withFilter, taskLabel, billingLabel, hoursText, summaryText, pendingText, workCsv } from '../models/work-entries.js';

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const button = (text, fn, cls = 'btn') => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; };
const labelled = (parent, label, node) => { const l = el('label', 'work-field'); l.append(el('span', 'work-field-label', label), node); parent.append(l); return node; };
const option = (sel, label, value) => sel.append(new Option(label, value));

// mountWorkEntries(host, {api, openIssue}): builds the view in host and loads it. Returns {reload} for a refresh.
export function mountWorkEntries(host, { api, openIssue }) {
  let v = { ...DEFAULT_WORK }, seq = 0, timer = 0, projects = [], last = null;
  const root = el('section', 'work-entries');
  const bar = el('div', 'work-bar'), range = el('p', 'work-range'), summary = el('p', 'work-summary'), notes = el('div', 'work-notes');
  const pendingBox = el('section', 'work-pending'), tableBox = el('div', 'work-table-wrap'), pager = el('div', 'work-pager');
  root.append(bar, range, summary, notes, tableBox, pager, pendingBox);
  host.replaceChildren(root);

  // Toolbar: search, client, project, period (with custom dates), only billable, more filters, export.
  const search = el('input', 'work-search'); search.type = 'search'; search.placeholder = 'Search entries, tickets or people'; search.setAttribute('aria-label', 'Search work entries');
  const clientSel = el('select', 'work-select'); clientSel.setAttribute('aria-label', 'Filter by client');
  const projectSel = el('select', 'work-select'); projectSel.setAttribute('aria-label', 'Filter by project');
  const periodSel = el('select', 'work-select'); periodSel.setAttribute('aria-label', 'Work period');
  for (const [k, l] of Object.entries(PERIODS)) option(periodSel, l, k);
  const fromIn = el('input', 'work-date'), toIn = el('input', 'work-date');
  fromIn.type = toIn.type = 'date'; fromIn.setAttribute('aria-label', 'Custom start date'); toIn.setAttribute('aria-label', 'Custom end date');
  const billLbl = el('label', 'work-check'), billBox = el('input'); billBox.type = 'checkbox'; billLbl.append(billBox, document.createTextNode(' Only billable'));
  const more = el('details', 'work-more'), moreSum = el('summary', 'btn', 'More filters');
  const pageSel = el('select', 'work-select'); pageSel.setAttribute('aria-label', 'Entries per page');
  for (const n of PAGE_SIZES) option(pageSel, n + ' per page', String(n));
  const resetBtn = button('Clear filters', () => change({ q: '', client: '', project: '', period: 'month', from: '', to: '', billable: false }), 'btn');
  const moreList = el('div', 'work-more-list');
  labelled(moreList, 'Entries per page', pageSel);
  moreList.append(resetBtn);
  more.append(moreSum, moreList);
  const exportBtn = button('Export CSV', exportCsv, 'btn');
  labelled(bar, 'Search', search);
  labelled(bar, 'Client', clientSel);
  labelled(bar, 'Project', projectSel);
  labelled(bar, 'Work period', periodSel);
  const customBox = el('div', 'work-custom'); customBox.append(labelled(customBox, 'From', fromIn), labelled(customBox, 'To', toIn)); customBox.hidden = true;
  bar.append(customBox, billLbl, more, exportBtn);

  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => change({ q: search.value }), 300); });
  clientSel.addEventListener('change', () => change({ client: clientSel.value, project: '' }));
  projectSel.addEventListener('change', () => change({ project: projectSel.value }));
  periodSel.addEventListener('change', () => change({ period: periodSel.value }));
  fromIn.addEventListener('change', () => change({ from: fromIn.value }));
  toIn.addEventListener('change', () => change({ to: toIn.value }));
  billBox.addEventListener('change', () => change({ billable: billBox.checked }));
  pageSel.addEventListener('change', () => change({ limit: Number(pageSel.value) }));

  function syncControls() {
    search.value = v.q; clientSel.value = v.client; projectSel.value = v.project; periodSel.value = v.period;
    fromIn.value = v.from; toIn.value = v.to; billBox.checked = v.billable; pageSel.value = String(v.limit);
    customBox.hidden = v.period !== 'custom';
    // The project list follows the client: only that client's projects are offered.
    const shown = projects.filter(p => !v.client || String(p.clientId) === String(v.client));
    projectSel.replaceChildren(); option(projectSel, 'All projects', '');
    for (const p of shown) option(projectSel, p.name + (p.client ? ' (' + p.client + ')' : ''), String(p.odooId));
    projectSel.value = v.project;
    moreSum.textContent = 'More filters' + (v.limit !== 50 || v.period === 'all' ? ' · changed' : '');
  }
  function change(patch) {
    v = withFilter(v, patch);
    syncControls();
    if (v.period === 'custom') {
      const err = customPeriodError(v.from, v.to);
      if (err) { notes.replaceChildren(el('p', 'msg err', err)); summary.textContent = ''; tableBox.replaceChildren(); pager.replaceChildren(); pendingBox.replaceChildren(); return; }
    }
    load();
  }

  async function load() {
    const my = ++seq;
    summary.textContent = 'Loading work…';
    try {
      const d = await api('/clients/odoo-projects/work-entries?' + workQuery(v));
      if (my !== seq) return; // a newer request has been sent: this answer is stale
      last = d; render(d);
    } catch (err) {
      if (my !== seq) return;
      notes.replaceChildren(el('p', 'msg err', err.message || 'Work could not be loaded.'));
      summary.textContent = '';
    }
  }

  function render(d) {
    range.textContent = 'Showing ' + d.period.label;
    summary.textContent = summaryText(d.totals);
    notes.replaceChildren(...(d.warnings || []).map(w => el('p', 'msg', w)));
    tableBox.replaceChildren(entriesTable(d.entries, d.totals.count));
    renderPager(d);
    renderPending(d.pending);
  }

  function entriesTable(rows, count) {
    if (!rows.length) return el('p', 'work-empty', count === 0 ? 'No work matches these filters.' : 'No entries on this page.');
    const t = el('table', 'work-table'), head = el('tr');
    for (const h of ['Work date', 'Client', 'Project', 'Ticket / task', 'Person', 'Description', 'Hours', 'Billing', 'Open'])
      head.append(el('th', h === 'Hours' ? 'num' : '', h));
    t.append(el('thead')); t.tHead.append(head);
    const body = el('tbody');
    for (const r of rows) body.append(rowEl(r));
    t.append(body);
    return t;
  }
  function rowEl(r) {
    const tr = el('tr');
    tr.append(el('td', '', r.date), el('td', '', r.client?.name || '—'), el('td', '', r.project?.name || '—'));
    tr.append(el('td', '', taskLabel(r)), el('td', '', r.person || ''), el('td', 'work-desc', r.description || ''));
    tr.append(el('td', 'num', hoursText(r.hours)), el('td', 'work-billing ' + r.billing.value, billingLabel(r.billing)));
    const open = el('td', 'work-open');
    if (r.task?.key) open.append(button('Open ticket', () => openIssue(r.task.key), 'linkbtn'));
    if (r.url) { const a = el('a', 'linkbtn', 'Open in Odoo'); a.href = r.url; a.target = '_blank'; a.rel = 'noopener'; open.append(a); }
    tr.append(open);
    return tr;
  }

  function renderPager(d) {
    pager.replaceChildren();
    if (!d.totals.count) return;
    const from = d.offset + 1, to = d.offset + d.entries.length;
    pager.append(el('span', 'work-page-text', 'Showing ' + from + '–' + to + ' of ' + d.totals.count));
    // Paging keeps the filters: only the offset moves.
    const prev = button('Previous', () => { v = { ...v, offset: Math.max(0, v.offset - v.limit) }; load(); }, 'btn');
    prev.disabled = d.offset === 0;
    const next = button('Next', () => { v = { ...v, offset: d.nextOffset }; load(); }, 'btn');
    next.disabled = d.nextOffset == null;
    pager.append(prev, next);
  }

  // Dashboard work with no Odoo line yet: its own group, never added to the Odoo hours above.
  function renderPending(p) {
    pendingBox.replaceChildren();
    if (!p || !p.totals.count) return;
    const det = el('details', 'work-pending-box');
    det.append(el('summary', '', 'Not in Odoo yet · ' + pendingText(p.totals)));
    det.append(el('p', 'work-note', 'Entered on the dashboard and not sent to Odoo yet. These hours are not in the Odoo totals above.'));
    const wrap = el('div', 'work-table-wrap'), t = el('table', 'work-table'), head = el('tr');
    for (const h of ['Work date', 'Client', 'Project', 'Ticket / task', 'Person', 'Description', 'Hours', 'Billing', 'Open'])
      head.append(el('th', h === 'Hours' ? 'num' : '', h));
    t.append(el('thead')); t.tHead.append(head);
    const body = el('tbody');
    for (const r of p.entries) body.append(rowEl(r));
    t.append(body); wrap.append(t); det.append(wrap);
    pendingBox.append(det);
  }

  async function exportCsv(e) {
    const btn = e.currentTarget; btn.disabled = true;
    try {
      const d = await api('/clients/odoo-projects/work-entries?' + exportQuery(v));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([workCsv(d.entries, d.pending?.entries || [])], { type: 'text/csv' }));
      a.download = 'work-entries-' + (d.period.from || 'all') + '-' + (d.period.to || '') + '.csv';
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      notes.replaceChildren(el('p', 'msg err', err.message || 'The export could not be made.'));
    } finally { btn.disabled = false; }
  }

  // The client and project lists come from the Odoo projects the view can read.
  api('/clients/odoo-projects').then(d => {
    const seen = new Map();
    for (const p of d.projects || []) if (p.clientId != null && !seen.has(p.clientId)) seen.set(p.clientId, p.client);
    clientSel.replaceChildren(); option(clientSel, 'All clients', '');
    for (const [id, name] of seen) option(clientSel, name, String(id));
    projects = (d.projects || []).filter(p => p.clientId != null).map(p => ({ odooId: p.odooId, name: p.name, client: p.client, clientId: p.clientId }));
    syncControls();
  }).catch(() => {});

  syncControls();
  load();
  return { reload: () => load(), last: () => last };
}
