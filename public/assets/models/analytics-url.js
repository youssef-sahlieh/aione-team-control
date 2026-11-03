// The Analytics page keeps its filters in the address (?page=analytics&from=…&to=…&client=…&dev=…&source=…) so a
// view can be shared and survives a reload. Every value is checked; anything invalid falls back to the default.
import { dayNumber, dayString } from "./analytics-stats.js";
export const PRESETS = [[7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"], [365, "Last 12 months"]];
export const MAX_DAYS = 365;
export const SOURCE_CHOICES = ["all", "jira", "internal", "odoo"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const real = day => DAY.test(day) && Number.isFinite(Date.parse(day)) && dayString(dayNumber(day)) === day;
export const rangeEndingAt = (today, days) => ({ from: dayString(dayNumber(today) - days + 1), to: today });

export function readFilters(search, today) {
  const q = new URLSearchParams(search);
  let from = q.get("from"), to = q.get("to");
  if (!real(from) || !real(to) || from > to) ({ from, to } = rangeEndingAt(today, 30));
  if (to > today) to = today;
  if (from > to) from = to;
  if (dayNumber(to) - dayNumber(from) + 1 > MAX_DAYS) from = rangeEndingAt(to, MAX_DAYS).from;
  const tidy = value => String(value || "").slice(0, 80);
  return { from, to, client: tidy(q.get("client")), dev: tidy(q.get("dev")).toLowerCase(), source: SOURCE_CHOICES.includes(q.get("source")) ? q.get("source") : "all" };
}

export function writeFilters(url, filters) {
  const next = new URL(url);
  for (const k of ["from", "to", "client", "dev", "source"]) next.searchParams.delete(k);
  next.searchParams.set("from", filters.from); next.searchParams.set("to", filters.to);
  if (filters.client) next.searchParams.set("client", filters.client);
  if (filters.dev) next.searchParams.set("dev", filters.dev);
  if (filters.source && filters.source !== "all") next.searchParams.set("source", filters.source);
  return next;
}

export const withoutFilters = url => { const next = new URL(url); for (const k of ["from", "to", "client", "dev", "source"]) next.searchParams.delete(k); return next; };
