import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeJiraIssue, normalizeInternalIssue, withRendered, labelsWith } from "../../public/assets/models/issue.js";
import { jiraIssue, internalTicket, people, byId } from "../fixtures/issues.js";

test("Jira retains raw workflow and priority and separates assignee from developers", () => {
  const issue = normalizeJiraIssue(jiraIssue, byId, body => body);
  assert.equal(issue.status, "Pending QA");
  assert.equal(issue.cat, "indeterminate");
  assert.equal(issue.priority, "High");
  assert.equal(issue.assignee, "lead");
  assert.deepEqual(issue.devs, ["builder", "reviewer"]);
  assert.equal(issue.due, "2026-10-10");
  assert.equal(issue.created, "2026-10-09T08:00:00Z");
  assert.deepEqual(issue.parent, { key: "AION-100", name: "Synthetic epic" });
  assert.equal(issue.last.fromTeam, false);
});
test("comments use the supplied browser text sanitizer and team membership", () => {
  const raw = structuredClone(jiraIssue);
  raw.fields.comment.comments.push({ author: { accountId: "test-lead" }, body: "<b>Latest</b>" });
  const seen = [];
  const issue = normalizeJiraIssue(raw, byId, body => { seen.push(body); return "Latest"; });
  assert.deepEqual(seen, ["<b>Latest</b>"]);
  assert.equal(issue.last.fromTeam, true);
  assert.equal(issue.last.text, "Latest");
});
test("unknown assignees retain their Jira ID and display name", () => {
  const issue = normalizeJiraIssue(jiraIssue, {}, body => body);
  assert.equal(issue.assignee, null);
  assert.equal(issue.assigneeId, "test-lead");
  assert.equal(issue.assigneeName, "Test Lead");
});
test("missing Jira fields retain existing defaults", () => {
  assert.deepEqual(normalizeJiraIssue({ key: "AION-9" }, {}, body => body), {
    key: "AION-9", summary: "(no summary)", status: "", cat: "", assignee: null,
    assigneeName: "Unassigned", labels: [], devs: [], due: null, created: "", updated: "",
    priority: "", type: "", reporter: "Unknown", reporterId: null, assigneeId: null, parent: null, last: null
  });
});
test("rendered text replaces ADF without mutating the API response", () => {
  const raw = structuredClone(jiraIssue), before = structuredClone(raw);
  raw.fields.description = { type: "doc" };
  before.fields.description = { type: "doc" };
  const rendered = withRendered(raw);
  assert.equal(rendered.fields.description, "<p>Rendered description</p>");
  assert.equal(rendered.fields.comment.comments[0].body, "<p>Please check</p>");
  assert.deepEqual(raw, before);
  assert.equal(withRendered({ fields: { description: { type: "doc" }, comment: { comments: [{ body: {} }] } } }).fields.comment.comments[0].body, "");
});
test("developer changes preserve unrelated labels and retained label casing", () => {
  const labels = [...jiraIssue.fields.labels];
  assert.deepEqual(labelsWith(labels, new Set(["builder", "newdev"])), ["keep-label", "ai1_builder", "ai1_newdev"]);
  assert.deepEqual(labelsWith(["AI1_BUILDER", "release"], new Set(["builder"])), ["release", "AI1_BUILDER"]);
  assert.deepEqual(labelsWith(labels, new Set()), ["keep-label"]);
  assert.deepEqual(labels, jiraIssue.fields.labels);
});
test("internal shape retains source, own status category and plain-text comments", () => {
  const ticket = structuredClone(internalTicket);
  ticket.comments.push({ author: { name: "Test Builder" }, created: "2026-10-11", body: "<literal text>" });
  const issue = normalizeInternalIssue(ticket, people);
  assert.equal(issue.internal, true);
  assert.equal(issue.type, "Internal");
  assert.equal(issue.status, "Open");
  assert.equal(issue.cat, "new");
  assert.equal(issue.assigneeId, "test-lead");
  assert.deepEqual(issue.labels, ["ai1_builder"]);
  assert.equal(issue.last.fromTeam, true);
  assert.equal(issue.last.text, "<literal text>");
  issue.devs.push("other");
  assert.deepEqual(ticket.devs, ["builder"]);
});
test("internal missing fields keep defaults distinct from Jira", () => {
  const issue = normalizeInternalIssue({ key: "INT-9", status: "Closed", statusCat: "done" }, {});
  assert.equal(issue.summary, "(no title)");
  assert.equal(issue.assignee, null);
  assert.equal(issue.assigneeId, null);
  assert.equal(issue.due, null);
  assert.equal(issue.last, null);
  assert.deepEqual(issue.devs, []);
});
