// Statistics for the Checks & Reports dashboard. Pure functions over the report rows after the report's filters.
// Conventions:
// - Hours: a finite number is a recorded value (0 included, the work log recorded none); null, missing or invalid is unknown.
//   Unknown hours are never summed as zero. Sums cover known values only, and coverage is reported beside them.
// - Dates: calendar days in Asia/Jerusalem. Ticket age and week boundaries use that zone. Weeks start on Sunday.
// - Classification uses unrounded values; rounding happens only for display.
const TZ = 'Asia/Jerusalem';
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const DAY_MS = 86400000;

export const hoursOf = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export const jerusalemDay = value => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? dayFormat.format(new Date(ms)) : null;
};
// Whole days since 1970-01-01 for a YYYY-MM-DD string, so day differences are exact calendar differences.
const dayNumber = day => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY_MS; };
const dayString = n => new Date(n * DAY_MS).toISOString().slice(0, 10);
const inRange = (day, start, end) => !!day && day >= start && day <= end;
const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

// ---- Hours and agreement ----
// State of one ticket's agreement: 'matched' (agreed and logged both known), 'logged-unknown', or 'no-agreement'.
export function agreementState(t) {
  const agreed = hoursOf(t.agreedHours);
  if (agreed === null || agreed <= 0) return 'no-agreement';
  return hoursOf(t.loggedHours) === null ? 'logged-unknown' : 'matched';
}
// Within a matched ticket: 'over' above agreement, 'approaching' at 80% to 100%, 'within' below 80%.
export function usageBand(t) {
  const agreed = hoursOf(t.agreedHours), logged = hoursOf(t.loggedHours);
  if (agreed === null || agreed <= 0 || logged === null) return null;
  if (logged > agreed) return 'over';
  return logged >= agreed * 0.8 ? 'approaching' : 'within';
}
// Totals over a set of tickets. Only matched tickets feed hours and ratios.
export function agreementSummary(tickets) {
  const s = { tickets: tickets.length, matched: 0, noAgreement: 0, loggedUnknown: 0, agreedHours: 0, loggedHours: 0, excessHours: 0, netVariance: 0, over: 0, approaching: 0, within: 0 };
  for (const t of tickets) {
    const state = agreementState(t);
    if (state === 'no-agreement') { s.noAgreement++; continue; }
    if (state === 'logged-unknown') { s.loggedUnknown++; continue; }
    const agreed = t.agreedHours, logged = t.loggedHours;
    s.matched++; s[usageBand(t)]++;
    s.agreedHours += agreed; s.loggedHours += logged; s.netVariance += logged - agreed;
    s.excessHours += Math.max(logged - agreed, 0);
  }
  s.ratio = s.matched && s.agreedHours > 0 ? s.loggedHours / s.agreedHours : null;
  return s;
}
// Client or project comparison. Each group reports its own matched cohort and what was left out of it.
export function agreementGroups(tickets, keyOf) {
  const groups = new Map();
  for (const t of tickets) {
    const { key, label } = keyOf(t);
    if (!groups.has(key)) groups.set(key, { key, label, tickets: [] });
    groups.get(key).tickets.push(t);
  }
  return [...groups.values()].map(g => ({ key: g.key, label: g.label, keys: g.tickets.map(t => t.key), ...agreementSummary(g.tickets) }));
}
export const GROUP_SORTS = {
  excess: (a, b) => b.excessHours - a.excessHours || b.loggedHours - a.loggedHours || a.label.localeCompare(b.label),
  logged: (a, b) => b.loggedHours - a.loggedHours || a.label.localeCompare(b.label),
  name: (a, b) => a.label.localeCompare(b.label),
};
// Overrun Pareto: matched tickets over agreement, largest excess first. Cumulative shares use the full total, so
// the "Other" group (tickets after the top N) closes the series at 100%.
export function paretoOverruns(tickets, topN = 10) {
  const over = tickets.filter(t => agreementState(t) === 'matched' && t.loggedHours > t.agreedHours)
    .map(t => ({ key: t.key, title: t.title, client: t.clientName || 'Client not set', excess: t.loggedHours - t.agreedHours, agreed: t.agreedHours, logged: t.loggedHours }))
    .sort((a, b) => b.excess - a.excess || a.key.localeCompare(b.key));
  const total = over.reduce((n, t) => n + t.excess, 0);
  let running = 0;
  const bars = over.slice(0, topN).map(t => { running += t.excess; return { ...t, share: total ? t.excess / total : 0, cumulativeShare: total ? running / total : 0 }; });
  const rest = over.slice(topN);
  const otherExcess = rest.reduce((n, t) => n + t.excess, 0);
  const other = rest.length ? { count: rest.length, excess: otherExcess, share: total ? otherExcess / total : 0, cumulativeShare: 1 } : null;
  return { total, count: over.length, bars, other, all: over };
}

// ---- Ticket aging (current open tickets) ----
export const AGE_BUCKETS = [['0–7 days', 0, 7], ['8–14 days', 8, 14], ['15–30 days', 15, 30], ['31–60 days', 31, 60], ['61+ days', 61, Infinity]];
// Age in calendar days from the creation day to the snapshot day (both Asia/Jerusalem). Returns the bucket label,
// 'unknown' when creation is missing or unreadable, or 'invalid' when it is after the snapshot day.
export function agingBucket(t, snapshotDay) {
  const created = jerusalemDay(t.created);
  if (!created || !snapshotDay) return 'unknown';
  const age = dayNumber(snapshotDay) - dayNumber(created);
  if (age < 0) return 'invalid';
  return AGE_BUCKETS.find(([, from, to]) => age >= from && age <= to)[0];
}
export function aging(tickets, snapshotDay) {
  const open = tickets.filter(t => !t.closed);
  const labels = [...AGE_BUCKETS.map(([label]) => label), 'unknown', 'invalid'];
  const counts = new Map(labels.map(label => [label, { label, count: 0, keys: [] }]));
  for (const t of open) { const c = counts.get(agingBucket(t, snapshotDay)); c.count++; c.keys.push(t.key); }
  return { open: open.length, buckets: AGE_BUCKETS.map(([label]) => counts.get(label)), unknown: counts.get('unknown'), invalid: counts.get('invalid') };
}

// ---- Overview cards and coverage ----
// Known sum of one hours field, with the count of tickets it covers.
export function knownSum(tickets, field) {
  let sum = 0, known = 0;
  for (const t of tickets) { const v = hoursOf(t[field]); if (v !== null) { sum += v; known++; } }
  return { sum, known, total: tickets.length };
}
export function overdueOpen(tickets, snapshotDay) {
  return tickets.filter(t => !t.closed && t.due && snapshotDay && t.due < snapshotDay);
}
export function completedInPeriod(tickets, start, end) {
  return tickets.filter(t => t.closed && inRange(jerusalemDay(t.completedAt), start, end));
}

// ---- Employee × client heatmap (attributable hours only) ----
// A person's hours appear only in their own cell. A ticket's total is never given to each person who worked on it.
export function employeeClientMatrix(tickets) {
  const cells = new Map(), people = new Map(), clients = new Map();
  for (const t of tickets) {
    if (!Array.isArray(t.employees)) continue;
    const clientKey = t.clientId || '__none', clientLabel = t.clientName || 'Client not set';
    for (const e of t.employees) {
      const hours = hoursOf(e.hours);
      if (hours === null || hours <= 0) continue;
      if (!clients.has(clientKey)) clients.set(clientKey, { key: clientKey, label: clientLabel, hours: 0, keys: new Set() });
      const cellKey = e.name + '\u0001' + clientKey;
      if (!cells.has(cellKey)) cells.set(cellKey, { employee: e.name, client: clientKey, clientLabel, hours: 0, keys: [] });
      const cell = cells.get(cellKey);
      cell.hours += hours; cell.keys.push(t.key);
      if (!people.has(e.name)) people.set(e.name, { name: e.name, hours: 0, keys: new Set() });
      const p = people.get(e.name); p.hours += hours; p.keys.add(t.key);
      const c = clients.get(clientKey); c.hours += hours; c.keys.add(t.key);
    }
  }
  return {
    employees: [...people.values()].map(p => ({ name: p.name, hours: p.hours, tickets: p.keys.size })).sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name)),
    clients: [...clients.values()].map(c => ({ key: c.key, label: c.label, hours: c.hours, tickets: c.keys.size })).sort((a, b) => b.hours - a.hours || a.label.localeCompare(b.label)),
    cells: [...cells.values()],
    max: Math.max(0, ...[...cells.values()].map(c => c.hours)),
  };
}

// ---- Estimate accuracy (completed tickets) ----
// Points need a positive estimate and known logged hours. Logged hours can differ from the legacy actual-hours fields.
export function estimateAccuracy(tickets) {
  const done = tickets.filter(t => t.closed);
  const points = [], excluded = { noEstimate: 0, loggedUnknown: 0 };
  for (const t of done) {
    const estimate = hoursOf(t.estimatedHours), logged = hoursOf(t.loggedHours);
    if (estimate === null || estimate <= 0) { excluded.noEstimate++; continue; }
    if (logged === null) { excluded.loggedUnknown++; continue; }
    points.push({ key: t.key, title: t.title, client: t.clientName || 'Client not set', estimate, logged, variance: logged - estimate, variancePct: round((logged - estimate) / estimate * 100, 1) });
  }
  return { completed: done.length, points, excluded, sample: points.length };
}

// ---- Open workload by developer and status (assignments, not time) ----
// A shared ticket counts once per developer on the developer rows, and once in the team totals.
export function workloadByStatus(tickets) {
  const open = tickets.filter(t => !t.closed);
  const people = new Map(), team = { tickets: open.length, statuses: new Map(), shared: 0, unassigned: 0 };
  for (const t of open) {
    const devs = [...new Set(t.devs || [])];
    const status = t.status || 'No status';
    team.statuses.set(status, (team.statuses.get(status) || 0) + 1);
    if (devs.length > 1) team.shared++;
    if (!devs.length) { team.unassigned++; }
    for (const name of devs.length ? devs : ['__none']) {
      if (!people.has(name)) people.set(name, { name, tickets: 0, shared: 0, statuses: new Map() });
      const p = people.get(name); p.tickets++; if (devs.length > 1) p.shared++;
      p.statuses.set(status, (p.statuses.get(status) || 0) + 1);
    }
  }
  const rows = [...people.values()].map(p => ({ name: p.name, tickets: p.tickets, shared: p.shared, statuses: [...p.statuses].map(([status, count]) => ({ status, count })) }))
    .sort((a, b) => (a.name === '__none') - (b.name === '__none') || b.tickets - a.tickets || a.name.localeCompare(b.name));
  return { rows, team: { tickets: team.tickets, shared: team.shared, unassigned: team.unassigned, statuses: [...team.statuses].map(([status, count]) => ({ status, count })) } };
}

// ---- Weekly created and completed (Asia/Jerusalem Sunday-to-Saturday weeks) ----
// Created uses the original creation timestamp. Completed uses the recorded completion date, which is the latest
// completion only: reopened and re-closed tickets are not counted per transition.
export function weeklyFlow(tickets, start, end) {
  if (!start || !end || start > end) return { weeks: [], totals: { created: 0, completed: 0 }, unknownCompletion: 0, unknownCreated: 0 };
  const first = dayNumber(start) - new Date(dayNumber(start) * DAY_MS).getUTCDay();
  const weeks = [];
  for (let w = first; w <= dayNumber(end); w += 7) weeks.push({ start: dayString(w), created: 0, completed: 0, partial: dayString(w) < start || dayString(w + 6) > end });
  let unknownCompletion = 0, unknownCreated = 0;
  for (const t of tickets) {
    const created = jerusalemDay(t.created);
    if (!created) unknownCreated++;
    else if (inRange(created, start, end)) weeks[Math.floor((dayNumber(created) - first) / 7)].created++;
    if (t.closed && !t.completedAt) unknownCompletion++;
    const done = jerusalemDay(t.completedAt);
    if (done && inRange(done, start, end)) weeks[Math.floor((dayNumber(done) - first) / 7)].completed++;
  }
  return { weeks, totals: { created: weeks.reduce((n, w) => n + w.created, 0), completed: weeks.reduce((n, w) => n + w.completed, 0) }, unknownCompletion, unknownCreated };
}

// ---- Dated logged effort (work entries, attributable to a person) ----
// Entries come from the authenticated work-entry report for the period. Only entries on the selected tickets count,
// and rows without a readable date, person or minutes are reported as unattributed.
export function weeklyEffort(entries, tickets, start, end, groupBy = 'employee') {
  const keys = new Set(tickets.map(t => t.key));
  const clientOf = new Map(tickets.map(t => [t.key, t.clientName || 'Client not set']));
  const weeks = new Map(), groups = new Map();
  let unattributed = 0, counted = 0;
  const first = start ? dayNumber(start) - new Date(dayNumber(start) * DAY_MS).getUTCDay() : 0;
  for (const e of entries) {
    if (String(e.id || '').startsWith('agreed:')) continue;
    if (!keys.has(e.ticket)) continue;
    const hours = typeof e.minutes === 'number' && Number.isFinite(e.minutes) && e.minutes >= 0 ? e.minutes / 60 : null;
    const day = typeof e.date === 'string' ? e.date : null;
    if (hours === null || !day || !inRange(day, start, end)) { unattributed++; continue; }
    const label = groupBy === 'client' ? (clientOf.get(e.ticket) || 'Client not set') : (e.user || 'Unknown person');
    const weekStart = dayString(first + Math.floor((dayNumber(day) - first) / 7) * 7);
    if (!weeks.has(weekStart)) weeks.set(weekStart, { start: weekStart, total: 0, groups: new Map() });
    const w = weeks.get(weekStart);
    w.total += hours; w.groups.set(label, (w.groups.get(label) || 0) + hours);
    groups.set(label, (groups.get(label) || 0) + hours);
    counted++;
  }
  return {
    weeks: [...weeks.values()].sort((a, b) => a.start.localeCompare(b.start)).map(w => ({ start: w.start, total: w.total, groups: [...w.groups].map(([label, hours]) => ({ label, hours })) })),
    groups: [...groups].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, hours]) => ({ label, hours })),
    counted, unattributed,
  };
}

// Chart selections narrow the same dataset that the table and CSV use. Each kind holds one value; null means none.
export const EMPTY_SELECTION = { client: null, project: null, aging: null, cell: null, ticket: null };
export function applySelection(tickets, sel, snapshotDay) {
  return tickets.filter(t =>
    (!sel.client || (t.clientId || '__none') === sel.client) &&
    (!sel.project || (t.subClientId || '__none') === sel.project) &&
    (!sel.aging || (!t.closed && agingBucket(t, snapshotDay) === sel.aging)) &&
    (!sel.cell || ((t.clientId || '__none') === sel.cell.client && Array.isArray(t.employees) && t.employees.some(e => e.name === sel.cell.employee && hoursOf(e.hours) > 0))) &&
    (!sel.ticket || t.key === sel.ticket));
}

// Display helpers shared by the views.
export const formatHours = v => v == null ? '—' : (Math.round(v * 100) / 100).toLocaleString('en-GB') + ' h';
export const formatPercent = v => v == null || !Number.isFinite(v) ? '—' : (Math.round(v * 1000) / 10).toLocaleString('en-GB') + '%';
export const shortDay = day => { const [, m, d] = day.split('-'); return d + '/' + m; };
