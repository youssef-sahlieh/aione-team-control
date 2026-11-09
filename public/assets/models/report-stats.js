// Statistics for the Checks & Reports dashboard. Pure functions over the report rows after the report's filters.
// Conventions:
// - Hours: a finite number is a recorded value (0 included, the work log recorded none); null, missing or invalid is unknown.
//   Unknown hours are never summed as zero. Sums cover known values only, and coverage is reported beside them.
// - Dates: calendar days in Asia/Jerusalem. Report days use that zone.
// - Classification uses unrounded values; rounding happens only for display.
const TZ = 'Asia/Jerusalem';
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

export const hoursOf = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export const jerusalemDay = value => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? dayFormat.format(new Date(ms)) : null;
};
// Whole days since 1970-01-01 for a YYYY-MM-DD string, so day differences are exact calendar differences.
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

// ---- Overview cards and coverage ----
// Known sum of one hours field, with the count of tickets it covers.
export function knownSum(tickets, field) {
  let sum = 0, known = 0;
  for (const t of tickets) { const v = hoursOf(t[field]); if (v !== null) { sum += v; known++; } }
  return { sum, known, total: tickets.length };
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

// Chart selections narrow the same dataset that the table and CSV use. Each kind holds one value; null means none.
export const EMPTY_SELECTION = { client: null, project: null, ticket: null };
export function applySelection(tickets, sel, snapshotDay) {
  return tickets.filter(t =>
    (!sel.client || (t.clientId || '__none') === sel.client) &&
    (!sel.project || (t.subClientId || '__none') === sel.project) &&
    (!sel.ticket || t.key === sel.ticket));
}

// Display helpers shared by the views.
export const formatHours = v => v == null ? '—' : (Math.round(v * 100) / 100).toLocaleString('en-GB') + ' h';
export const formatPercent = v => v == null || !Number.isFinite(v) ? '—' : (Math.round(v * 1000) / 10).toLocaleString('en-GB') + '%';
export const shortDay = day => { const [, m, d] = day.split('-'); return d + '/' + m; };
