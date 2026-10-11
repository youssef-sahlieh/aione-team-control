export const createFilters = () => ({ reporter: new Set(), assignee: new Set(), dev: new Set(), status: new Set(), type: new Set(), priority: new Set(), epic: "", due: "any", activity: "any" });
const dayMs = 86400000, dayNumber = s => Date.parse(s + "T00:00:00Z") / dayMs;
// Extracted from the dashboard's original engine. skip applies only to faceted Sets.
export function matchesFilters(i, today, { filters: f, query, needsReply, now = Date.now() }, skip) {
  if (skip !== "reporter" && f.reporter.size && !f.reporter.has(i.reporter)) return false;
  if (skip !== "assignee" && f.assignee.size && !f.assignee.has(i.assignee || "other")) return false;
  if (skip !== "dev" && f.dev.size && ![...f.dev].some(d => d === "__none" ? !i.devs.length : i.devs.includes(d))) return false;
  if (skip !== "status" && f.status.size && !f.status.has(i.status)) return false;
  if (skip !== "type" && f.type.size && !f.type.has(i.type)) return false;
  if (skip !== "priority" && f.priority.size && !f.priority.has(i.priority || "None")) return false;
  if (f.epic && !(f.epic === "none" ? !i.parent : i.parent && i.parent.key === f.epic)) return false;
  if (f.due !== "any") {
    const d = i.due;
    if (f.due === "none" && d) return false;
    if (f.due === "overdue" && !(d && d < today)) return false;
    if (f.due === "today" && d !== today) return false;
    if (f.due === "week" && !(d && d > today && dayNumber(d) <= dayNumber(today) + 7)) return false;
    if (f.due === "later" && !(d && dayNumber(d) > dayNumber(today) + 7)) return false;
  }
  if (f.activity === "reply" && !needsReply(i)) return false;
  if (f.activity === "new3" && !(dayNumber(today) - dayNumber(i.created) <= 3)) return false;
  if (f.activity === "upd1" && !(i.updated && Date.parse(i.updated) >= now - dayMs)) return false;
  const q = query.toLowerCase();
  if (q && !(i.key.toLowerCase().includes(q) || i.reporter.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q) || (i.parent && i.parent.name.toLowerCase().includes(q)))) return false;
  return true;
}
