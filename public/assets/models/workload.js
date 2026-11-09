// Counts only the supplied authorized dataset. Multi-label issues count once per
// developer; assignee grouping is independent of developer labels.
export function calculateWorkload(issues, names, today, kind = "dev") {
  return names.map(name => {
    const assigned = issues.filter(issue => kind === "dev" ? (name === "__none" ? !issue.devs.length : issue.devs.includes(name)) : (issue.assignee || "other") === name);
    return { name, ...summarize(assigned, today), statuses: statusCounts(assigned.filter(isOpen)) };
  });
}

// `statuses` is the mix of open tickets only (current assignments).
// Team-wide figures count each issue once, so a ticket with two developers is not doubled.
export function workloadTotals(issues, today) {
  return { tickets: issues.length, ...summarize(issues, today), statuses: statusCounts(issues.filter(isOpen)) };
}

// The same rules as the ticket list's views (FOCUS in dashboard.js), so a number opens exactly that many tickets:
// Odoo Helpdesk tickets have no due dates here, so they are never overdue or "no date". `today` is the Asia/Jerusalem day.
export const isOpen = issue => issue.cat !== "done";
export const isOverdue = (issue, today) => isOpen(issue) && !issue.odoo && !!issue.due && issue.due < today;
export const hasNoDueDate = issue => isOpen(issue) && !issue.odoo && !issue.due;
export const hasNoDeveloper = issue => isOpen(issue) && !issue.devs.length;

function summarize(assigned, today) {
  const open = assigned.filter(isOpen);
  return { open: open.length, inProgress: open.filter(issue => issue.cat === "indeterminate").length,
    overdue: open.filter(issue => isOverdue(issue, today)).length,
    noDueDate: open.filter(hasNoDueDate).length, noDeveloper: open.filter(hasNoDeveloper).length,
    // Open tickets that carry more than one developer label: these are why member rows add up to more than the team.
    shared: open.filter(issue => issue.devs.length > 1).length, completed: assigned.length - open.length };
}

function statusCounts(assigned) {
  return [...new Set(assigned.map(issue => issue.status))].map(status => ({ status, count: assigned.filter(issue => issue.status === status).length }));
}
