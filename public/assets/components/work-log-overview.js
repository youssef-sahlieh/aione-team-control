// The Work log overview: every logged work entry, one row each, across clients, projects and tickets. The server
// (proxy/src/work-overview.js) does the filtering, totals, groups, paging and export over the complete set; this
// page sends the filters, shows the answer, and keeps only the latest response (an older reply never replaces it).
// Filters are remembered in this browser, so they survive a refresh.
import { formatDuration } from '../models/work-duration.js';

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const FILTER_KEY = 'aione.workLog.overview';
const PAGE = 50;
const PERIODS = [['this_month', 'This month'], ['last_month', 'Last month'], ['last_30', 'Last 30 days'], ['custom', 'Custom dates'], ['all', 'All dates']];
const SYNC = [['all', 'All entries'], ['posted', 'Posted in Odoo'], ['unsynced', 'Not in Odoo yet'], ['attention', 'Needs attention']];
const GROUPS = [['', 'No grouping'], ['day', 'Day'], ['person', 'Person'], ['client', 'Client'], ['project', 'Project']];
const BILLING = { billable: 'Billable', not_billable: 'Not billable', unclassified: 'Unclassified' };
const DEFAULTS = { period: 'this_month', from: '', to: '', q: '', person: '', client: '', project: '', billable: false, sync: 'all', groupBy: '' };
const DATE = d => { try { return new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch { return d; } };
const LONG = 140;

// Only the known filter keys are read back; anything else in storage is ignored.
export function loadFilters(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(FILTER_KEY) || 'null');
    const out = { ...DEFAULTS };
    if (saved && typeof saved === 'object') for (const k of Object.keys(DEFAULTS)) if (typeof saved[k] === typeof DEFAULTS[k]) out[k] = saved[k];
    if (!PERIODS.some(([v]) => v === out.period)) out.period = DEFAULTS.period;
    if (!SYNC.some(([v]) => v === out.sync)) out.sync = DEFAULTS.sync;
    if (!GROUPS.some(([v]) => v === out.groupBy)) out.groupBy = DEFAULTS.groupBy;
    return out;
  } catch { return { ...DEFAULTS }; }
}
function saveFilters(f, storage = globalThis.localStorage) { try { storage.setItem(FILTER_KEY, JSON.stringify(f)); } catch { /* private browsing: the filters just are not remembered */ } }

// The query for the server: only the filters that differ from the defaults, so the URL stays short.
export function queryOf(f, extra = {}) {
  const p = new URLSearchParams();
  for (const k of Object.keys(DEFAULTS)) {
    const v = f[k];
    if (v === DEFAULTS[k] || v === '' || v == null || v === false) continue;
    if (k === 'billable') p.set('billable', '1'); else p.set(k, String(v));
  }
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return p.toString();
}

const statusClass = s => (s === 'synced' || s === 'odoo' ? 'wl-ok' : s === 'held' ? 'wl-busy' : s === 'syncing' ? 'wl-busy' : 'wl-warn');
const sel = (label, options, value, onChange) => {
  const s = el('select', 'fsel'); s.setAttribute('aria-label', label);
  for (const [v, t] of options) s.append(new Option(t, v));
  s.value = options.some(([v]) => v === value) ? value : options[0][0];
  s.addEventListener('change', () => onChange(s.value));
  return s;
};
const dateInput = (label, value, onChange) => {
  const i = el('input', 'inp'); i.type = 'date'; i.value = value || ''; i.setAttribute('aria-label', label);
  i.addEventListener('change', () => onChange(i.value));
  return i;
};

export function createWorkLogOverview({ api, apiFile, isAdmin = () => false, openIssue = () => {}, onLogWork = null, onSettings = null, toast = () => {}, storage = globalThis.localStorage }) {
  let f = loadFilters(storage), offset = 0, seq = 0, data = null, lastError = null, exportBusy = false;
  let root = null, nodes = {};
  let searchTimer = null;

  function build(wrap) {
    wrap.replaceChildren();
    const head = el('div', 'wl-ov-head');
    const titles = el('div', 'wl-ov-titles');
    titles.append(el('h2', 'wl-ov-title', 'Work log'), el('p', 'msg', isAdmin() ? 'Everyone\'s logged work, one row per entry. Work dates are Israel time.' : 'Your logged work, one row per entry. Work dates are Israel time.'));
    const actions = el('div', 'wl-ov-actions');
    nodes.refresh = el('button', 'btn', 'Refresh'); nodes.refresh.type = 'button'; nodes.refresh.addEventListener('click', () => load());
    nodes.export = el('button', 'btn', 'Export CSV'); nodes.export.type = 'button'; nodes.export.addEventListener('click', exportCsv);
    actions.append(nodes.refresh, nodes.export);
    if (onLogWork) { nodes.log = el('button', 'btn primary', '+ Log work'); nodes.log.type = 'button'; nodes.log.hidden = true; nodes.log.addEventListener('click', () => onLogWork()); actions.append(nodes.log); }
    if (isAdmin() && onSettings) { nodes.settings = el('button', 'btn', 'Work log settings'); nodes.settings.type = 'button'; nodes.settings.addEventListener('click', () => onSettings()); actions.append(nodes.settings); }
    head.append(titles, actions);

    // Toolbar: every control is a labelled native control, so the keyboard reaches all of them in order.
    const bar = el('form', 'wl-ov-toolbar'); bar.setAttribute('role', 'search'); bar.setAttribute('aria-label', 'Filter logged work');
    bar.addEventListener('submit', e => { e.preventDefault(); clearTimeout(searchTimer); commit({ q: nodes.q.value.trim() }); });
    nodes.q = el('input', 'inp wl-ov-search'); nodes.q.type = 'search'; nodes.q.placeholder = 'Ticket, task or description'; nodes.q.setAttribute('aria-label', 'Search ticket, task or description'); nodes.q.value = f.q;
    nodes.q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => commit({ q: nodes.q.value.trim() }), 300); });
    nodes.period = sel('Work period', PERIODS, f.period, v => commit({ period: v }));
    nodes.from = dateInput('Custom from date', f.from, v => commit({ from: v }));
    nodes.to = dateInput('Custom to date (inclusive)', f.to, v => commit({ to: v }));
    nodes.person = el('select', 'fsel'); nodes.person.setAttribute('aria-label', 'Person');
    nodes.person.addEventListener('change', () => commit({ person: nodes.person.value }));
    nodes.client = el('select', 'fsel'); nodes.client.setAttribute('aria-label', 'Client');
    nodes.client.addEventListener('change', () => commit({ client: nodes.client.value }));
    nodes.project = el('select', 'fsel'); nodes.project.setAttribute('aria-label', 'Project');
    nodes.project.addEventListener('change', () => commit({ project: nodes.project.value }));
    // Billing is for administrators only: the billable filter exists only for them.
    const billLabel = el('span');
    if (isAdmin()) {
      nodes.billable = el('input'); nodes.billable.type = 'checkbox'; nodes.billable.id = 'wl-ov-billable'; nodes.billable.checked = f.billable;
      nodes.billable.addEventListener('change', () => commit({ billable: nodes.billable.checked }));
      billLabel.className = 'wl-ov-check'; billLabel.htmlFor = nodes.billable.id; billLabel.append(nodes.billable, ' Only billable');
    }
    nodes.sync = sel('Sync status', SYNC, f.sync, v => commit({ sync: v }));
    nodes.groupBy = sel('Group by', GROUPS, f.groupBy, v => commit({ groupBy: v }));
    nodes.reset = el('button', 'btn', 'Reset filters'); nodes.reset.type = 'button'; nodes.reset.addEventListener('click', () => commit({ ...DEFAULTS }));
    const dates = el('div', 'wl-ov-dates'); dates.append(el('span', 'wl-ov-lbl', 'From'), nodes.from, el('span', 'wl-ov-lbl', 'to'), nodes.to);
    nodes.dates = dates;
    bar.append(
      labelled('Search', nodes.q, 'wl-ov-search-field'), labelled('Period', nodes.period), dates,
      labelled('Person', nodes.person), labelled('Client', nodes.client), labelled('Project', nodes.project),
      billLabel, labelled('Sync status', nodes.sync), labelled('Group by', nodes.groupBy), nodes.reset
    );
    nodes.range = el('p', 'wl-ov-range', ''); nodes.range.setAttribute('aria-live', 'polite');
    nodes.cards = el('div', 'wl-cards wl-ov-cards');
    nodes.status = el('p', 'msg wl-ov-status'); nodes.status.setAttribute('role', 'status');
    nodes.subtotals = el('div', 'wl-ov-subtotals');
    nodes.body = el('div', 'wl-ov-body');
    nodes.pager = el('nav', 'wl-ov-pager'); nodes.pager.setAttribute('aria-label', 'Pages');
    wrap.append(head, bar, nodes.range, nodes.cards, nodes.status, nodes.subtotals, nodes.body, nodes.pager);
    syncControls();
  }

  function labelled(text, control, extra = '') {
    const l = el('label', 'wl-field wl-ov-field ' + extra); l.append(el('span', '', text), control); return l;
  }

  // Moves the controls to match the filters (after a reset, or on first draw).
  function syncControls() {
    nodes.q.value = f.q; nodes.period.value = f.period; nodes.from.value = f.from; nodes.to.value = f.to;
    nodes.sync.value = f.sync; nodes.groupBy.value = f.groupBy;
    if (nodes.billable) nodes.billable.checked = f.billable;
    nodes.dates.hidden = f.period !== 'custom';
    if (nodes.log) nodes.log.hidden = !data?.canLog;
    fillSelect(nodes.person, 'All people', data?.options.persons || [], f.person);
    fillSelect(nodes.client, 'All clients', data?.options.clients || [], f.client);
    fillSelect(nodes.project, 'All projects', data?.options.projects || [], f.project);
  }
  // Options come from the server (the complete matching scope). Entries without a client or project have no option;
  // they still appear in the table and in the totals when no client or project is chosen.
  function fillSelect(s, all, values, current) {
    s.replaceChildren(new Option(all, ''));
    for (const v of values) if (v) s.append(new Option(v, v));
    if (current && ![...s.options].some(o => o.value === current)) s.append(new Option(current, current));
    s.value = current || '';
  }

  // Any filter change resets the paging to the first page and reloads.
  function commit(change) {
    f = { ...f, ...change };
    if (change.period && change.period !== 'custom') { f.from = ''; f.to = ''; }
    offset = 0;
    saveFilters(f, storage);
    syncControls();
    if (f.period === 'custom' && (!f.from || !f.to)) { nodes.status.className = 'msg'; nodes.status.textContent = 'Choose both dates for a custom period.'; return; }
    load();
  }

  async function load() {
    const mine = ++seq;
    nodes.body.setAttribute('aria-busy', 'true');
    nodes.status.className = 'msg'; nodes.status.textContent = 'Loading…';
    try {
      const r = await api('/time-entries/overview?' + queryOf(f, { offset, limit: PAGE }));
      if (mine !== seq) return;      // an older reply never replaces a newer one
      data = r; lastError = null;
      draw();
    } catch (err) {
      if (mine !== seq) return;
      lastError = err; draw();
    } finally {
      if (mine === seq) nodes.body.removeAttribute('aria-busy');
    }
  }

  function draw() {
    if (!root) return;
    syncControls();
    if (lastError) {
      nodes.status.className = 'msg err'; nodes.status.textContent = lastError.message || 'The work log could not be loaded.';
      nodes.range.textContent = ''; nodes.cards.replaceChildren(); nodes.subtotals.replaceChildren(); nodes.pager.replaceChildren();
      const retry = el('button', 'btn', 'Try again'); retry.type = 'button'; retry.addEventListener('click', () => load());
      nodes.body.replaceChildren(retry);
      return;
    }
    if (!data) return;
    const p = data.period;
    nodes.range.textContent = p.key === 'all' ? 'All dates, Israel time' : DATE(p.from) + ' to ' + DATE(p.to) + ' (Israel time, inclusive)';
    nodes.status.className = 'msg'; nodes.status.textContent = '';
    drawCards();
    drawSubtotals();
    if (!data.paging.total) return drawEmpty();
    drawTable();
    drawPager();
  }

  function card(label, value, note, cls = '') {
    const c = el('div', 'wl-card ' + cls); c.append(el('span', '', label), el('b', '', value)); if (note) c.append(el('small', '', note)); return c;
  }
  function drawCards() {
    const t = data.totals;
    nodes.cards.replaceChildren(
      card('Matching entries', String(t.count), data.filters.q || data.filters.person ? 'With these filters' : ''),
      card('Total time', t.durationText, t.count ? t.minutes + ' minutes' : ''),
      ...(isAdmin() ? [card('Billable time', t.billableText, t.minutes ? Math.round((t.billableMinutes / t.minutes) * 100) + '% of the total' : '')] : []),
      card('Pending or failed sync', String(t.pendingCount), t.heldCount ? t.heldCount + ' held for agreed hours' : '', t.pendingCount ? 'warn' : '')
    );
    if (data.agreed) nodes.cards.append(card('Agreed hours (accounting)', data.agreed.durationText, data.agreed.count + ' agreement line' + (data.agreed.count === 1 ? '' : 's') + ', not work sessions', 'acct'));
  }

  function drawSubtotals() {
    nodes.subtotals.replaceChildren();
    if (!data.groups?.length) return;
    const t = el('table', 'wl-table wl-ov-subtable');
    const head = t.createTHead().insertRow();
    const headers = isAdmin() ? ['Group', 'Entries', 'Total', 'Billable'] : ['Group', 'Entries', 'Total'];
    for (const h of headers) { const th = el('th', h === 'Entries' || h === 'Total' || h === 'Billable' ? 'num' : '', h); head.append(th); }
    const body = t.createTBody();
    for (const g of data.groups) { const r = body.insertRow(); r.append(el('td', '', data.filters.groupBy === 'day' ? DATE(g.label) : g.label), el('td', 'num', String(g.count)), el('td', 'num', g.durationText), ...(isAdmin() ? [el('td', 'num', g.billableText)] : [])); }
    const scroll = el('div', 'wl-scroll'); scroll.append(t);
    const d = el('details', 'wl-detail'); d.open = true; d.append(el('summary', '', 'Subtotals by ' + (GROUPS.find(([v]) => v === data.filters.groupBy)?.[1] || '').toLowerCase()), scroll);
    nodes.subtotals.append(d);
  }

  function drawEmpty() {
    const anyFilter = queryOf(f) !== '';
    const box = el('div', 'wl-ov-empty');
    box.append(el('p', '', anyFilter ? 'No work matches these filters.' : 'No work in this period.'));
    const reset = el('button', 'btn primary', 'Reset filters'); reset.type = 'button'; reset.addEventListener('click', () => commit({ ...DEFAULTS }));
    box.append(reset);
    nodes.body.replaceChildren(box);
    nodes.pager.replaceChildren();
    nodes.status.className = 'msg';
  }

  function drawTable() {
    const wrap = el('div', 'wl-scroll wl-ov-scroll');
    const t = el('table', 'wl-table wl-ov-table');
    t.setAttribute('aria-label', 'Logged work, one row per entry');
    const head = t.createTHead().insertRow();
    const columns = ['Date', 'Person', 'Client', 'Project', 'Ticket or task', 'Description', 'Duration', ...(isAdmin() ? ['Billing'] : []), 'Sync', 'Actions'];
    for (const h of columns) {
      const th = el('th', h === 'Duration' ? 'num' : '', h); th.setAttribute('scope', 'col'); head.append(th);
    }
    const body = t.createTBody();
    let lastGroup = null;
    for (const r of data.rows) {
      const key = data.filters.groupBy ? groupKey(r, data.filters.groupBy) : null;
      if (data.filters.groupBy && key !== lastGroup) {
        const gr = body.insertRow(); gr.className = 'wl-ov-group';
        const td = gr.insertCell(); td.colSpan = head.cells.length; td.textContent = (groupLabel(r, data.filters.groupBy)); lastGroup = key;
      }
      body.append(rowNode(r));
    }
    t.append(body);
    wrap.append(t);
    nodes.body.replaceChildren(wrap);
  }
  const groupKey = (r, by) => (by === 'day' ? r.date : by === 'person' ? r.person : by === 'client' ? (r.client || '') : (r.project || ''));
  const groupLabel = (r, by) => {
    const label = by === 'day' ? DATE(r.date) : by === 'person' ? r.person : by === 'client' ? (r.client || 'No client') : (r.project || 'No project');
    return GROUPS.find(([v]) => v === by)[1] + ': ' + label;
  };

  function cell(label, content, cls = '') {
    const td = el('td', cls); td.dataset.label = label;
    if (typeof content === 'string') td.textContent = content; else td.append(content);
    return td;
  }

  function rowNode(r) {
    const tr = el('tr', 'wl-ov-row' + (r.origin === 'odoo' ? ' wl-ov-odoo' : ''));
    const time = el('time', '', DATE(r.date)); time.dateTime = r.date;
    tr.append(cell('Date', time));
    tr.append(cell('Person', r.person || 'Not recorded'));
    tr.append(cell('Client', r.client || '—'));
    tr.append(cell('Project', r.project || '—'));
    // Ticket or task: a dashboard ticket opens in the drawer; a native Odoo task shows its name.
    const tt = el('div', 'wl-ov-ticket');
    if (r.ticket && r.ticketOpenable) tt.append(button(r.ticket, () => openIssue(r.ticket), 'linkbtn'));
    else if (r.ticket) tt.append(el('span', '', r.ticket));
    else tt.append(el('span', 'wl-ov-muted', r.task || 'No task.'));
    if (r.ticketTitle) tt.append(el('div', 'wl-ov-muted', r.ticketTitle));
    tr.append(cell('Ticket or task', tt));
    tr.append(cell('Description', descriptionNode(r.description || '')));
    tr.append(cell('Duration', r.duration || '0:00', 'num wl-dur'));
    const bill = el('div', 'wl-ov-bill', BILLING[r.billing] || r.billing);
    bill.append(el('small', 'wl-ov-muted', r.billingSource === 'ticket' ? 'Ticket setting' : r.billingSource === 'project' ? 'From project' : 'No setting'));
    if (isAdmin()) tr.append(cell('Billing', bill));
    const badge = el('span', 'wl-status ' + statusClass(r.status), r.statusLabel || r.status);
    if (r.reason) badge.title = r.reason;
    const syncCell = el('div', ''); syncCell.append(badge);
    if (r.reason) syncCell.append(el('small', 'wl-ov-muted', r.reason));
    tr.append(cell('Sync', syncCell));
    const acts = el('div', 'wl-ov-acts');
    if (r.openUrl) { const a = el('a', 'linkbtn', 'Open in Odoo'); a.href = r.openUrl; a.target = '_blank'; a.rel = 'noopener'; acts.append(a); }
    else if (r.taskUrl) { const a = el('a', 'linkbtn', 'Task in Odoo'); a.href = r.taskUrl; a.target = '_blank'; a.rel = 'noopener'; acts.append(a); }
    if (r.ticket && r.ticketOpenable) acts.append(button('Open ticket', () => openIssue(r.ticket), 'linkbtn'));
    tr.append(cell('Actions', acts));
    return tr;
  }

  function descriptionNode(text) {
    const box = el('div', 'wl-ov-desc');
    const p = el('p', 'wl-desc', text || '—');
    box.append(p);
    if (text.length > LONG) {
      p.classList.add('wl-ov-clamp');
      const more = button('Show more', () => { const open = p.classList.toggle('wl-ov-clamp') === false; more.textContent = open ? 'Show less' : 'Show more'; more.setAttribute('aria-expanded', String(open)); }, 'linkbtn');
      more.setAttribute('aria-expanded', 'false');
      box.append(more);
    }
    return box;
  }

  function button(text, fn, cls = 'btn') { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; }

  function drawPager() {
    nodes.pager.replaceChildren();
    const { offset: from, limit, total } = data.paging;
    const last = Math.min(total, from + limit);
    const prev = button('Previous page', () => { offset = Math.max(0, offset - limit); load(); }, 'btn');
    const next = button('Next page', () => { offset += limit; load(); }, 'btn');
    prev.disabled = from <= 0; next.disabled = last >= total;
    nodes.pager.append(prev, el('span', 'wl-ov-pagetext', 'Showing ' + (total ? from + 1 : 0) + '–' + last + ' of ' + total), next);
  }

  async function exportCsv() {
    if (exportBusy) return;
    exportBusy = true; nodes.export.disabled = true;
    try {
      const res = await apiFile('/time-entries/overview/export?' + queryOf(f));
      if (!res.ok) throw new Error('The export could not be made.');
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') || '';
      const name = /filename="([^"]+)"/.exec(cd)?.[1] || 'work-log.csv';
      const url = URL.createObjectURL(blob);
      const a = el('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Export ready: ' + name);
    } catch (err) { toast(err.message || 'The export could not be made.'); }
    finally { exportBusy = false; nodes.export.disabled = false; }
  }

  // Shows the overview in the given node: a rebuild when it is first shown, a reload otherwise.
  function render(wrap) {
    if (!isAdmin() && f.billable) f = { ...f, billable: false };   // a remembered billable filter does not apply to non-admins
    if (!root || root !== wrap) { root = wrap; build(wrap); }
    load();
  }

  return { render, reload: () => load(), reset: () => { seq++; data = null; lastError = null; root = null; nodes = {}; } };
}
