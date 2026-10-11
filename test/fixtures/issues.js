// Synthetic data only; never copied from production accounts or tickets.
export const people = { lead: { id: "test-lead", name: "Test Lead", ini: "TL" } };
export const byId = { "test-lead": "lead" };
export const jiraIssue = {
  key: "AION-101", fields: {
    summary: "Synthetic Jira task", status: { name: "Pending QA", statusCategory: { key: "indeterminate" } },
    assignee: { accountId: "test-lead", displayName: "Test Lead" },
    labels: ["keep-label", "ai1_builder", "AI1_BUILDER", "ai1_reviewer"], duedate: "2026-10-10",
    created: "2026-10-09T08:00:00Z", updated: "2026-10-11T08:00:00Z",
    priority: { name: "High" }, issuetype: { name: "Bug" },
    reporter: { accountId: "test-reporter", displayName: "Test Reporter" },
    parent: { key: "AION-100", fields: { summary: "Synthetic epic" } },
    description: "Plain description",
    comment: { comments: [{ id: "c1", author: { accountId: "test-reporter", displayName: "Test Reporter" }, created: "2026-10-11T07:00:00Z", body: "Please check" }] },
    attachment: []
  },
  renderedFields: { description: "<p>Rendered description</p>", comment: { comments: [{ body: "<p>Please check</p>" }] } }
};
export const internalTicket = {
  key: "INT-101", internal: true, summary: "Synthetic internal task", description: "Internal description",
  status: "Open", statusCat: "new", assignee: "lead", devs: ["builder"], due: null,
  created: "2026-10-09T08:00:00Z", updated: "2026-10-11T08:00:00Z", priority: "Medium",
  createdBy: { name: "Test Builder" }, comments: [], attachments: [], dueHistory: []
};
