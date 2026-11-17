import { test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_FILTERS, historyResultFor, historyView, passesHistoryFilter, historyDetails } from "../../public/assets/models/assignment-history.js";

const jiraIssue = { key: "AION-5", internal: false, odoo: false };

test("the filter offers All, ever, never and unknown", () => {
  assert.deepEqual(HISTORY_FILTERS.map(([v]) => v), ["", "ever", "never", "unknown"]);
});

test("internal and Odoo tickets are not applicable, never Never assigned", () => {
  assert.equal(historyResultFor({ key: "INT-3", internal: true }, null).state, "na");
  assert.equal(historyResultFor({ key: "HD-9", odoo: true }, null).state, "na");
  assert.equal(historyResultFor({ key: "INT-4" }, { result: { state: "never" } }).state, "na");
  assert.equal(historyView({ state: "na" }).label, "");
});

test("a Jira ticket with no result yet is Unknown", () => {
  assert.equal(historyResultFor(jiraIssue, undefined).state, "unknown");
  assert.equal(historyView(historyResultFor(jiraIssue, undefined)).label, "Mordi: unknown");
});

test("the three states have their labels and tones", () => {
  assert.deepEqual(historyView({ state: "ever" }), { state: "ever", label: "Mordi: assigned before", tone: "ever" });
  assert.deepEqual(historyView({ state: "never" }), { state: "never", label: "Mordi: never assigned", tone: "never" });
  assert.equal(historyView({ state: "unknown" }).tone, "unknown");
});

test("the filter shows everything with no choice, and only the chosen state otherwise, hiding internal tickets", () => {
  const ever = { state: "ever" }, never = { state: "never" }, unknown = { state: "unknown" }, na = { state: "na" };
  assert.equal(passesHistoryFilter(na, ""), true);
  assert.equal(passesHistoryFilter(ever, "ever"), true);
  assert.equal(passesHistoryFilter(never, "ever"), false);
  assert.equal(passesHistoryFilter(never, "never"), true);
  assert.equal(passesHistoryFilter(unknown, "unknown"), true);
  assert.equal(passesHistoryFilter(na, "never"), false);
  assert.equal(passesHistoryFilter(na, "unknown"), false);
});

test("details say what the history shows and invent no dates", () => {
  const lines = historyDetails({ state: "ever", events: [{ kind: "creation", at: null }], verifiedAt: null });
  assert.equal(lines[0], "Mordi was assigned to this ticket.");
  assert.equal(lines[1], "Assigned to Mordi from creation.");
  assert.equal(lines.some((l) => /\bundefined\b|NaN|Invalid/.test(l)), false);
});

test("details give the assignment, who did it and when Mordi was moved away, when Jira says so", () => {
  const lines = historyDetails({
    state: "ever",
    events: [{ kind: "assigned", at: "2026-02-01T09:00:00.000+0000", by: "Ellen" }],
    lastLeftAt: "2026-03-01T09:00:00.000+0000", lastLeftBy: "Ellen", verifiedAt: "2026-04-01T09:00:00.000+0000"
  });
  assert.match(lines[1], /^Assigned to Mordi on .+ by Ellen\.$/);
  assert.match(lines[2], /^Last moved away from Mordi on .+ by Ellen\.$/);
  assert.match(lines[3], /^Jira history checked /);
});

test("a never verdict says the complete history was checked; an unknown one gives its reason", () => {
  assert.match(historyDetails({ state: "never" })[0], /complete Jira history was checked/);
  assert.equal(historyDetails({ state: "unknown", reason: "The history is longer than the check reads." })[0], "Unknown: The history is longer than the check reads.");
  assert.match(historyDetails({ state: "na" })[0], /not created in Jira/);
});
