// Counts only the supplied authorized dataset. Multi-label issues count once per
// developer; assignee grouping is independent of developer labels.
export function calculateWorkload(issues, names, today, kind = "dev") {
  return names.map(name => {
    const assigned = issues.filter(issue => kind === "dev" ? (name === "__none" ? !issue.devs.length : issue.devs.includes(name)) : (issue.assignee || "other") === name);
    return { name, ...summarize(assigned, today), statuses: statusCounts(assigned) };
  });
}

// Team-wide figures count each issue once, so a ticket with two developers is not doubled.
export function workloadTotals(issues, today) {
  return { tickets: issues.length, ...summarize(issues, today), statuses: statusCounts(issues) };
}

function summarize(assigned, today) {
  const open = assigned.filter(issue => issue.cat !== "done");
  return { open: open.length, inProgress: open.filter(issue => issue.cat === "indeterminate").length,
    overdue: open.filter(issue => issue.due && issue.due < today).length,
    noDueDate: open.filter(issue => !issue.due).length, completed: assigned.length - open.length };
}

function statusCounts(assigned) {
  return [...new Set(assigned.map(issue => issue.status))].map(status => ({ status, count: assigned.filter(issue => issue.status === status).length }));
}
