// Analytics numbers from the snapshot (proxy/src/analytics.js). Pure functions, no DOM, so they can move to the
// server if the snapshot ever grows too large. Days are Asia/Jerusalem calendar days as YYYY-MM-DD strings.
// An unknown value is null and is never summed as zero; every KPI says how many tickets it could use.
export const SOURCES = ['jira', 'internal', 'odoo'];
export const AGE_BUCKETS = [['0–7 days', 0, 7], ['8–14 days', 8, 14], ['15–30 days', 15, 30], ['31–60 days', 31, 60], ['61+ days', 61, Infinity]];
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

export const openAt = (t, day) => !!t.createdDay && t.createdDay <= day && !(t.cat === 'done' && t.completedDay && t.completedDay <= day);
export const isOverdue = (t, today) => t.cat !== 'done' && !!t.dueDay && t.dueDay < today;

function count(tickets, period) {
  const created = tickets.filter(t => within(t.createdDay, period.from, period.to)).length;
  const completed = tickets.filter(t => within(t.completedDay, period.from, period.to)).length;
  const onTime = tickets.filter(t => within(t.completedDay, period.from, period.to) && t.dueDay);
  const onTimeKept = onTime.filter(t => t.completedDay <= t.dueDay).length;
  return { created, completed, open: tickets.filter(t => openAt(t, period.to)).length, onTime: { kept: onTimeKept, of: onTime.length, percent: pct(onTimeKept, onTime.length) } };
}
// Minutes of work dated inside the period; null when the work log could not be read.
export const loggedMinutes = (entries, period) => entries === null ? null : entries.reduce((s, [, day, , minutes]) => within(day, period.from, period.to) ? s + minutes : s, 0);
const toHours = m => m === null ? null : round2(m / 60);

export function kpis({ tickets, entries }, period, today) {
  const prior = priorPeriod(period), now = count(tickets, period), before = count(tickets, prior);
  const done = tickets.filter(t => t.cat === 'done'), unknownCompletion = done.filter(t => !t.completedDay).length;
  const hours = toHours(loggedMinutes(entries, period)), priorHours = toHours(loggedMinutes(entries, prior));
  const bySource = entries === null ? null : SOURCES.map((name, i) => ({ source: name, hours: round2(entries.reduce((s, e) => e[4] === i && within(e[1], period.from, period.to) ? s + e[3] : s, 0) / 60) }));
  return {
    period, prior, total: tickets.length,
    created: { value: now.created, prior: before.created },
    completed: { value: now.completed, prior: before.completed, unknownCompletion },
    open: { value: now.open, prior: before.open, netFlow: now.created - now.completed },
    overdue: { value: tickets.filter(t => isOverdue(t, today)).length, withDueDate: tickets.filter(t => t.cat !== 'done' && t.dueDay).length },
    onTime: { ...now.onTime, prior: before.onTime.percent },
    hours: { value: hours, prior: priorHours, bySource },
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

// Open work now, by age since creation; tickets with no readable creation day are counted apart, not hidden.
export function openByAge(tickets, today) {
  const open = tickets.filter(t => t.cat !== 'done'), buckets = AGE_BUCKETS.map(([label]) => ({ label, count: 0 }));
  let unknown = 0;
  for (const t of open) {
    if (!t.createdDay) { unknown++; continue; }
    const age = Math.max(0, dayNumber(today) - dayNumber(t.createdDay)), i = AGE_BUCKETS.findIndex(([, a, b]) => age >= a && age <= b);
    buckets[i].count++;
  }
  return { open: open.length, buckets, unknown };
}
