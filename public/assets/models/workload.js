// Counts only the supplied authorized dataset. Multi-label issues count once per
// developer; assignee grouping is independent of developer labels.
export function calculateWorkload(issues, names, today, kind = "dev") {
  return names.map(name => {
    const assigned = issues.filter(issue => kind === "dev" ? (name === "__none" ? !issue.devs.length : issue.devs.includes(name)) : (issue.assignee || "other") === name);
    const open = assigned.filter(issue => issue.cat !== "done");
    return { name, open: open.length, inProgress: open.filter(issue => issue.cat === "indeterminate").length,
      overdue: open.filter(issue => issue.due && issue.due < today).length,
      noDueDate: open.filter(issue => !issue.due).length, completed: assigned.length - open.length,
      statuses: [...new Set(assigned.map(issue => issue.status))].map(status => ({ status, count: assigned.filter(issue => issue.status === status).length })) };
  });
}
