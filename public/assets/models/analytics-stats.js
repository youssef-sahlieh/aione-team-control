// Analytics numbers from the snapshot (proxy/src/analytics.js). Pure functions, no DOM, so they can move to the
// server if the snapshot ever grows too large. Days are Asia/Jerusalem calendar days as YYYY-MM-DD strings.
// An unknown value is null and is never summed as zero; every KPI says how many tickets it could use.
// Entries are [ticket, day, personIndex, minutes, source, odoo]; `odoo` is 0 pending, 1 confirmed, 2 held under agreed hours,
// and missing on snapshots built before it was recorded (then the split is unknown, not zero).
export const SOURCES = ['jira', 'internal', 'odoo'];
export const ODOO_STATES = ['pending', 'confirmed', 'held'];
const DAY_MS = 86400000;
export const dayNumber = day => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY_MS; };
export const dayString = n => new Date(n * DAY_MS).toISOString().slice(0, 10);
const within = (day, from, to) => !!day && day >= from && day <= to;
const pct = (n, d) => d ? Math.round(n / d * 1000) / 10 : null;
const round2 = n => Math.round(n * 100) / 100;

// The previous period of the same length, ending the day before this one starts.
export function priorPeriod({ from, to }) {
  const length = dayNumber(to) - dayNumber(from) + 1;
  return { from: dayString(dayNumber(from) - length), to: dayString(dayNumber(from) - 1) };
}

// Keep tickets (and the entries on them) that match the filters; an entry on a ticket outside the snapshot
// (Odoo Helpdesk) only matches while no client or developer filter is set.
export function applyFilters(snapshot, { client = '', dev = '', source = 'all' } = {}) {
  const tickets = snapshot.tickets.filter(t =>
    (!client || t.clientId === client) && (!dev || t.devs.includes(dev)) && (source === 'all' || t.source === source));
  const keys = new Set(tickets.map(t => t.key)), known = new Map(snapshot.tickets.map(t => [t.key, t]));
  const entries = snapshot.entries === null ? null : snapshot.entries.filter(([key,, , , src]) => {
    if (source !== 'all' && SOURCES[src] !== source) return false;
    if (known.has(key)) return keys.has(key);
    return !client && !dev;
  });
  return { tickets, entries };
}

function count(tickets, period) {
  const created = tickets.filter(t => within(t.createdDay, period.from, period.to)).length;
  const completed = tickets.filter(t => within(t.completedDay, period.from, period.to)).length;
  const onTime = tickets.filter(t => within(t.completedDay, period.from, period.to) && t.dueDay);
  const onTimeKept = onTime.filter(t => t.completedDay <= t.dueDay).length;
  return { created, completed, onTime: { kept: onTimeKept, of: onTime.length, percent: pct(onTimeKept, onTime.length) } };
}
// Minutes of work dated inside the period; null when the work log could not be read.
export const loggedMinutes = (entries, period) => entries === null ? null : entries.reduce((s, [, day, , minutes]) => within(day, period.from, period.to) ? s + minutes : s, 0);
const toHours = m => m === null ? null : round2(m / 60);
// Work-log hours in the period by Odoo state. `unknown` is work whose state the snapshot did not record.
export function odooSplit(entries, period) {
  if (entries === null) return null;
  const m = { confirmed: 0, pending: 0, held: 0, unknown: 0 };
  for (const [, day, , minutes, , state] of entries) if (within(day, period.from, period.to)) m[ODOO_STATES[state] || 'unknown'] += minutes;
  return { confirmed: toHours(m.confirmed), pending: toHours(m.pending), held: toHours(m.held), unknown: toHours(m.unknown) };
}

// There is no "open at period end": the snapshot has no status history (see docs/admin-pages-redesign.md).
export function kpis({ tickets, entries }, period) {
  const prior = priorPeriod(period), now = count(tickets, period), before = count(tickets, prior);
  const done = tickets.filter(t => t.cat === 'done'), unknownCompletion = done.filter(t => !t.completedDay).length;
  const hours = toHours(loggedMinutes(entries, period)), priorHours = toHours(loggedMinutes(entries, prior));
  const bySource = entries === null ? null : SOURCES.map((name, i) => ({ source: name, hours: round2(entries.reduce((s, e) => e[4] === i && within(e[1], period.from, period.to) ? s + e[3] : s, 0) / 60) }));
  return {
    period, prior, total: tickets.length,
    created: { value: now.created, prior: before.created },
    completed: { value: now.completed, prior: before.completed, unknownCompletion },
    // Created minus completed: positive when more work came in than was finished. A change, not an open count.
    netChange: { value: now.created - now.completed, prior: before.created - before.completed },
    onTime: { ...now.onTime, prior: before.onTime.percent },
    hours: { value: hours, prior: priorHours, bySource, odoo: odooSplit(entries, period) },
  };
}

// Created and completed per Sunday-start week across the period (the first and last week may be partial).
export function weeklyFlow(tickets, { from, to }) {
  const first = dayNumber(from) - new Date(dayNumber(from) * DAY_MS).getUTCDay(), weeks = [];
  for (let w = first; w <= dayNumber(to); w += 7) weeks.push({ start: dayString(w), created: 0, completed: 0 });
  const slot = day => weeks[Math.floor((dayNumber(day) - first) / 7)];
  for (const t of tickets) {
    if (within(t.createdDay, from, to)) slot(t.createdDay).created++;
    if (within(t.completedDay, from, to)) slot(t.completedDay).completed++;
  }
  return weeks;
}

// Hours per week, split by source; null when the work log could not be read.
export function weeklyHours(entries, { from, to }) {
  if (entries === null) return null;
  const first = dayNumber(from) - new Date(dayNumber(from) * DAY_MS).getUTCDay(), weeks = [];
  for (let w = first; w <= dayNumber(to); w += 7) weeks.push({ start: dayString(w), jira: 0, internal: 0, odoo: 0 });
  for (const [, day, , minutes, src] of entries) if (within(day, from, to)) weeks[Math.floor((dayNumber(day) - first) / 7)][SOURCES[src]] += minutes / 60;
  return weeks.map(w => ({ ...w, jira: round2(w.jira), internal: round2(w.internal), odoo: round2(w.odoo) }));
}

// Hours by client (largest first) for work dated inside the period; work with no client is its own row.
export function hoursByClient({ tickets, entries }, { from, to }) {
  if (entries === null) return null;
  const owner = new Map(tickets.map(t => [t.key, t])), rows = new Map();
  for (const [key, day, , minutes] of entries) {
    if (!within(day, from, to)) continue;
    const t = owner.get(key), id = t?.clientId || '', row = rows.get(id) || { clientId: id, client: t?.clientName || 'No client', hours: 0 };
    row.hours += minutes / 60; rows.set(id, row);
  }
  return [...rows.values()].map(r => ({ ...r, hours: round2(r.hours) })).sort((a, b) => b.hours - a.hours);
}

// Hours by person (largest first) for work dated inside the period. A person is who logged the entry, so shared
// tickets are not doubled: each entry belongs to one person.
export function hoursByPerson(entries, people, { from, to }) {
  if (entries === null) return null;
  const rows = new Map();
  for (const [, day, person, minutes] of entries) if (within(day, from, to)) rows.set(person, (rows.get(person) || 0) + minutes);
  return [...rows].map(([i, m]) => ({ person: people?.[i] || 'Unknown', hours: round2(m / 60) })).sort((a, b) => b.hours - a.hours || a.person.localeCompare(b.person));
}
