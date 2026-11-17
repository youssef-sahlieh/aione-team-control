import { test } from "node:test";
import assert from "node:assert/strict";
import { mordiAccount, assigneeChanges, analyzeAssignments, readHistories, readRecentHistories, checkTickets, assignmentHistoryRoute } from "../proxy/src/assignment-history.js";

const MORDI = "mordi-acc-1", OTHER = "other-acc-2";
const team = (people) => JSON.stringify({ people });
const envWith = (people) => ({ TEAM_CONFIG: team(people) });
const memoryStore = () => {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async set(k, v) { m.set(k, v); }, _m: m };
};
// A changelog entry with one assignee change.
const change = (at, from, to, by = "Ellen") => ({
  created: at, author: { displayName: by },
  items: [{ field: "assignee", fieldId: "assignee", from, fromString: from ? "name-" + from : "", to, toString: to ? "name-" + to : "" }]
});
const otherField = (at) => ({ created: at, author: { displayName: "x" }, items: [{ field: "status", from: "a", to: "b" }] });

// A Jira double: serves the changelog by key, one page of 100 at a time.
function fakeJira(histories, { fail = false } = {}) {
  const calls = [];
  const jira = async (path) => {
    calls.push(path);
    if (fail) return { ok: false, res: null };
    const m = /\/issue\/([A-Z0-9-]+)\/changelog\?startAt=(\d+)/.exec(path);
    const all = histories[m[1]] || [];
    const start = Number(m[2]);
    const values = all.slice(start, start + 100);
    return { ok: true, data: { values, startAt: start, total: all.length, isLast: start + 100 >= all.length } };
  };
  return { jira, calls };
}

const cfg = { TEAM_CONFIG: team({ mordi: { id: MORDI, name: "Mordi Levi", ini: "ML" }, ellen: { id: OTHER, name: "Ellen", ini: "E" } }) };

test("Mordi is found by his Jira account id from TEAM_CONFIG, and a missing or ambiguous entry is explained, never guessed", () => {
  assert.deepEqual(mordiAccount(cfg), { id: MORDI, name: "Mordi Levi" });
  assert.equal(mordiAccount({ TEAM_CONFIG: team({ ellen: { id: OTHER, name: "Ellen" } }) }).id, null);
  assert.match(mordiAccount({ TEAM_CONFIG: team({ ellen: { id: OTHER, name: "Ellen" } }) }).reason, /Add Mordi/);
  assert.match(mordiAccount({ TEAM_CONFIG: team({ mordi: { id: MORDI, name: "Mordi" }, Mordi: { id: "x-1", name: "Mordi Two" } }) }).reason, /More than one/);
  assert.match(mordiAccount({ TEAM_CONFIG: team({ mordi: { name: "Mordi" } }) }).reason, /no Jira account id/);
  assert.match(mordiAccount({ TEAM_CONFIG: "{not json" }).reason, /not valid JSON/);
  assert.equal(mordiAccount({}).id, null);
});

test("a person whose first name is Mordi is found, and the display name is never used to match an assignee", () => {
  const found = mordiAccount({ TEAM_CONFIG: team({ dev7: { id: MORDI, name: "Mordi Cohen" } }) });
  assert.equal(found.id, MORDI);
});

test("currently assigned to Mordi with no changes: ever, dated from creation", () => {
  const r = analyzeAssignments({ changes: [], complete: true, currentId: MORDI, mordiId: MORDI, created: "2026-01-02T10:00:00.000+0000" });
  assert.equal(r.state, "ever");
  assert.deepEqual(r.events, [{ at: "2026-01-02T10:00:00.000+0000", by: "", kind: "creation" }]);
});

test("previously assigned to Mordi, then reassigned away: ever, with the date he was moved away", () => {
  const changes = assigneeChanges([change("2026-02-01T09:00:00.000+0000", null, MORDI, "Ellen"), change("2026-03-01T09:00:00.000+0000", MORDI, OTHER, "Ellen")]);
  const r = analyzeAssignments({ changes, complete: true, currentId: OTHER, mordiId: MORDI, created: "2026-01-01T00:00:00.000+0000" });
  assert.equal(r.state, "ever");
  assert.equal(r.events.filter((e) => e.kind === "assigned").length, 1);
  assert.equal(r.lastLeftAt, "2026-03-01T09:00:00.000+0000");
  assert.equal(r.lastLeftBy, "Ellen");
});

test("assigned to Mordi several times: ever, every assignment listed", () => {
  const changes = assigneeChanges([
    change("2026-02-01T09:00:00.000+0000", null, MORDI), change("2026-02-05T09:00:00.000+0000", MORDI, OTHER),
    change("2026-02-09T09:00:00.000+0000", OTHER, MORDI), change("2026-02-12T09:00:00.000+0000", MORDI, null)
  ]);
  const r = analyzeAssignments({ changes, complete: true, currentId: null, mordiId: MORDI, created: null });
  assert.equal(r.state, "ever");
  assert.equal(r.events.filter((e) => e.kind === "assigned").length, 2);
});

test("never assigned to Mordi, with the whole history read: never", () => {
  const changes = assigneeChanges([change("2026-02-01T09:00:00.000+0000", null, OTHER), otherField("2026-02-02T09:00:00.000+0000")]);
  const r = analyzeAssignments({ changes, complete: true, currentId: OTHER, mordiId: MORDI, created: "2026-01-01T00:00:00.000+0000" });
  assert.equal(r.state, "never");
  assert.equal(r.events.length, 0);
});

test("initially assigned to Mordi, then reassigned: ever, and no creation date is invented", () => {
  const changes = assigneeChanges([change("2026-04-01T09:00:00.000+0000", MORDI, OTHER)]);
  const r = analyzeAssignments({ changes, complete: true, currentId: OTHER, mordiId: MORDI, created: "2026-01-01T00:00:00.000+0000" });
  assert.equal(r.state, "ever");
  assert.deepEqual(r.events[0], { at: null, before: "2026-04-01T09:00:00.000+0000", by: "", kind: "start" });
});

test("an incomplete history is unknown, not never, unless Mordi already appears", () => {
  const changes = assigneeChanges([change("2026-02-01T09:00:00.000+0000", null, OTHER)]);
  assert.equal(analyzeAssignments({ changes, complete: false, currentId: OTHER, mordiId: MORDI, created: null }).state, "unknown");
  const seen = assigneeChanges([change("2026-02-01T09:00:00.000+0000", null, MORDI)]);
  assert.equal(analyzeAssignments({ changes: seen, complete: false, currentId: OTHER, mordiId: MORDI, created: null }).state, "ever");
});

test("a change that doesn't say who it was assigned from makes the start unknown, so never is not claimed", () => {
  const entry = { created: "2026-02-01T09:00:00.000+0000", author: { displayName: "x" }, items: [{ field: "assignee", to: OTHER }] };
  const r = analyzeAssignments({ changes: assigneeChanges([entry]), complete: true, currentId: OTHER, mordiId: MORDI, created: null });
  assert.equal(r.state, "unknown");
});

test("no assignment history entries: never when the full history is read and Mordi isn't the current assignee", () => {
  const r = analyzeAssignments({ changes: [], complete: true, currentId: OTHER, mordiId: MORDI, created: "2026-01-01T00:00:00.000+0000" });
  assert.equal(r.state, "never");
});

test("assignee changes are picked from the changelog, ignoring other fields", () => {
  const changes = assigneeChanges([otherField("2026-01-01T00:00:00.000+0000"), change("2026-01-02T00:00:00.000+0000", null, MORDI)]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].to, MORDI);
});

test("changelog pages are read until the last page; a page that fails makes the history unknown", async () => {
  const entries = Array.from({ length: 150 }, (_, n) => change("2026-01-" + String(10 + (n % 10)).padStart(2, "0") + "T00:00:00.000+0000", null, OTHER));
  const { jira, calls } = fakeJira({ "AION-1": entries });
  const read = await readHistories(jira, "AION-1");
  assert.equal(read.complete, true);
  assert.equal(read.histories.length, 150);
  assert.equal(calls.length, 2);
  const failing = await readHistories(fakeJira({}, { fail: true }).jira, "AION-2");
  assert.equal(failing.failed, true);
});

test("a history longer than the check reads is incomplete", async () => {
  // 1000 entries fit in the 10 pages read; 1100 need an 11th, which the check doesn't read.
  const entries = Array.from({ length: 1100 }, () => otherField("2026-01-01T00:00:00.000+0000"));
  const read = await readHistories(fakeJira({ "AION-3": entries }).jira, "AION-3");
  assert.equal(read.complete, false);
});

test("only the last 6 assignee changes decide: Mordi only in older changes is unknown, in the last 6 is ever", async () => {
  const at = (n) => "2026-01-" + String(10 + n).padStart(2, "0") + "T00:00:00.000+0000";
  // 20 assignee changes; Mordi was assignee in change 3 only, which is outside the last 6.
  const older = Array.from({ length: 20 }, (_, n) => change(at(n), n === 0 ? null : OTHER, n === 2 ? MORDI : OTHER));
  const oldOnly = await readRecentHistories(fakeJira({ "AION-20": older }).jira, "AION-20");
  const oldVerdict = analyzeAssignments({ changes: assigneeChanges(oldOnly.histories).slice(-6), complete: false, currentId: OTHER, mordiId: MORDI, created: null });
  assert.equal(oldVerdict.state, "unknown");

  // Mordi in change 16 of 20 is inside the last 6, so it is ever.
  const recent = Array.from({ length: 20 }, (_, n) => change(at(n), n === 0 ? null : OTHER, n === 15 ? MORDI : OTHER));
  const f = fakeJira({ "AION-21": recent });
  const recentRead = await readRecentHistories(f.jira, "AION-21");
  const recentVerdict = analyzeAssignments({ changes: assigneeChanges(recentRead.histories).slice(-6), complete: false, currentId: OTHER, mordiId: MORDI, created: null });
  assert.equal(recentVerdict.state, "ever");
});

test("the newest changelog page is read first, and reading stops once 6 assignee changes are held", async () => {
  // 250 entries over 3 pages; the 6 assignee changes sit at the end, so only pages 0 and 2 are read.
  const entries = Array.from({ length: 250 }, (_, n) => (n >= 244 ? change("2026-01-" + String(10 + (n % 10)).padStart(2, "0") + "T00:00:00.000+0000", OTHER, MORDI) : otherField("2026-01-01T00:00:00.000+0000")));
  const { jira, calls } = fakeJira({ "AION-22": entries });
  const read = await readRecentHistories(jira, "AION-22");
  assert.equal(calls.length, 2);
  assert.equal(read.reachedStart, false);
  assert.equal(assigneeChanges(read.histories).length, 6);
});

test("tickets are checked, cached while Jira's updated time is the same, and re-read after a reassignment", async () => {
  const store = memoryStore();
  const env = { ...cfg, STORE: store };
  const histories = { "AION-10": [change("2026-02-01T09:00:00.000+0000", null, OTHER)] };
  let f = fakeJira(histories);
  const issues = [{ key: "AION-10", assigneeId: OTHER, created: "2026-01-01T00:00:00.000+0000", updated: "2026-02-01T09:00:00.000+0000" }];

  let out = await checkTickets({ env, jira: f.jira, issues });
  assert.equal(out.results[0].state, "never");
  assert.equal(f.calls.length, 1);

  f = fakeJira(histories);
  out = await checkTickets({ env, jira: f.jira, issues });
  assert.equal(out.results[0].state, "never");
  assert.equal(f.calls.length, 0, "unchanged ticket: nothing fetched from Jira");

  // Reassigned to Mordi in Jira: the updated time moves on and the next check reads the history again.
  histories["AION-10"].push(change("2026-03-01T09:00:00.000+0000", OTHER, MORDI));
  f = fakeJira(histories);
  const moved = [{ ...issues[0], assigneeId: MORDI, updated: "2026-03-01T09:00:00.000+0000" }];
  out = await checkTickets({ env, jira: f.jira, issues: moved });
  assert.equal(out.results[0].state, "ever");
  assert.equal(f.calls.length, 1);
});

test("a failed Jira read is Unknown with a reason, and is not cached as a verdict", async () => {
  const store = memoryStore();
  const env = { ...cfg, STORE: store };
  const issues = [{ key: "AION-11", assigneeId: OTHER, created: null, updated: "u1" }];
  const out = await checkTickets({ env, jira: fakeJira({}, { fail: true }).jira, issues });
  assert.equal(out.results[0].state, "unknown");
  assert.match(out.results[0].reason, /couldn't be read/);
  assert.equal(store._m.size, 0);
});

test("without a configured Mordi, every ticket is Unknown and Jira is never asked", async () => {
  const f = fakeJira({});
  const out = await checkTickets({ env: { TEAM_CONFIG: team({}) }, jira: f.jira, issues: [{ key: "AION-12", assigneeId: OTHER, updated: "u" }] });
  assert.equal(out.configured, false);
  assert.equal(out.results[0].state, "unknown");
  assert.equal(f.calls.length, 0);
});

// Route tests: the caller's scoped search decides which tickets are checked.
const routeDeps = (visibleKeys, histories, extra = {}) => {
  const f = fakeJira(histories);
  const searchIssues = async (body) => {
    assert.match(body.jql, /^key in \(/);
    return { issues: visibleKeys.map((key) => ({ key, fields: { assignee: { accountId: OTHER }, created: "2026-01-01T00:00:00.000+0000", updated: "u-" + key } })) };
  };
  return {
    calls: f.calls,
    deps: {
      searchIssues: extra.searchIssues || searchIssues,
      jira: f.jira,
      json: (data, status = 200) => Response.json(data, { status }),
      fail: (code, error, status = 400) => Response.json({ code, error }, { status }),
      readJson: async (req) => req.json().catch(() => null)
    }
  };
};
const post = (body, method = "POST") => new Request("https://p/jira/assignment-history", { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined });

test("the route answers per ticket: checked tickets, not-applicable internal tickets, and tickets the caller can't see", async () => {
  const env = { ...cfg, STORE: memoryStore() };
  const { deps } = routeDeps(["AION-20"], { "AION-20": [change("2026-02-01T09:00:00.000+0000", null, MORDI)] });
  const res = await assignmentHistoryRoute(post({ keys: ["AION-20", "AION-21", "INT-4"] }), env, deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, true);
  const byKey = Object.fromEntries(body.results.map((r) => [r.key, r]));
  assert.equal(byKey["AION-20"].state, "ever");
  assert.equal(byKey["AION-21"].state, "unknown");
  assert.equal(byKey["AION-21"].reason, "Not available to you.");
  assert.equal(byKey["INT-4"].state, "na");
});

test("the route refuses bad input and non-POST requests", async () => {
  const env = { ...cfg, STORE: memoryStore() };
  const { deps } = routeDeps([], {});
  assert.equal((await assignmentHistoryRoute(post({ keys: "AION-1" }), env, deps)).status, 400);
  assert.equal((await assignmentHistoryRoute(post({ keys: Array.from({ length: 51 }, (_, n) => "AION-" + n) }), env, deps)).status, 400);
  assert.equal((await assignmentHistoryRoute(post({}, "GET"), env, deps)).status, 405);
});

test("when the caller's search fails, the route says so and checks nothing", async () => {
  const env = { ...cfg, STORE: memoryStore() };
  const { deps, calls } = routeDeps([], {}, { searchIssues: async () => { throw new Error("Authorized search failed"); } });
  const res = await assignmentHistoryRoute(post({ keys: ["AION-30"] }), env, deps);
  assert.equal(res.status, 502);
  assert.equal(calls.length, 0);
});
