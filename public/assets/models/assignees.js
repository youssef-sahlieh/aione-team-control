const names = ["karim", "youssef", "rami", "razan"];
const firstName = text => String(text || "").toLowerCase().trim().split(/[\s._@-]+/)[0].replace(/^yousef$|^yousif$/, "youssef");
const personName = (key, person) => names.find(name => firstName(key) === name || firstName(person?.name) === name);

// Resolve configured account keys without inventing Jira IDs. A missing named
// person can still match the display name returned by an authorized Jira search.
export function defaultAssigneeKeys(people) {
  const entries = Object.entries(people);
  const matched = names.map(name => entries.find(([key, person]) => personName(key, person) === name)?.[0]);
  // Retain compatibility with workspaces that configure a different team.
  if (!matched.some(Boolean) && entries.length) return entries.map(([key]) => key);
  return matched.map((key, index) => key || names[index]);
}
export function assigneeOptions(people) {
  return defaultAssigneeKeys(people).map(key => [key, people[key]?.name || key[0].toUpperCase() + key.slice(1)]);
}
export function assigneeFilterKey(issue, people) {
  const keys = defaultAssigneeKeys(people);
  if (keys.includes(issue.assignee)) return issue.assignee;
  const named = personName(issue.assignee, { name: issue.assigneeName });
  if (named) return keys.find(key => personName(key, people[key]) === named) || named;
  return "other";
}
