import { createFilters } from "./filters.js";
import { defaultAssigneeKeys } from "./assignees.js";
const fields = ["reporter", "assignee", "dev", "status", "type", "priority"];
const modes = ["list", "dev", "status", "assignee", "history"];
const focuses = ["open", "nodev", "reply", "overdue", "today", "approval", "nodue", "recent", "duechg", "closed"];
export const savedViewKey = email => "aion.savedViews.v1." + encodeURIComponent(email.toLowerCase());
export function serializeView(state, name) {
  const f = state.f;
  return { version: 1, name: name.trim().slice(0, 60), focus: state.focus, mode: state.view, group: state.group, query: state.q,
    filters: { ...Object.fromEntries(fields.map(key => [key, [...f[key]]])), epic: f.epic, due: f.due, activity: f.activity } };
}
export function validateView(v) {
  if (!v || v.version !== 1 || typeof v.name !== "string" || !v.name.trim() || v.name.length > 60 || !focuses.includes(v.focus) || !modes.includes(v.mode) || !["", "reporter", "epic", "assignee", "dev", "status"].includes(v.group)) return false;
  if (typeof v.query !== "string" || v.query.length > 500 || !v.filters) return false;
  const f = v.filters;
  return fields.every(key => Array.isArray(f[key]) && f[key].length <= 100 && f[key].every(x => typeof x === "string" && x.length <= 255)) &&
    typeof f.epic === "string" && f.epic.length <= 255 && ["any", "overdue", "today", "week", "later", "none"].includes(f.due) && ["any", "reply", "new3", "upd1"].includes(f.activity);
}
export function readViews(storage, email) {
  try { const views = JSON.parse(storage.getItem(savedViewKey(email)) || "[]"); return Array.isArray(views) ? views.filter(validateView).slice(0, 20) : []; } catch { return []; }
}
export function restoreView(v, admin, people) {
  if (!validateView(v)) return null;
  const f = createFilters(); fields.forEach(key => { f[key] = new Set(v.filters[key]); });
  Object.assign(f, { epic: v.filters.epic, due: v.filters.due, activity: v.filters.activity });
  const team=defaultAssigneeKeys(people);
  f.assignee=new Set([...f.assignee].filter(key=>key==="other"||team.includes(key)));
  if(!f.assignee.size) team.forEach(key=>f.assignee.add(key));
  if (!admin) f.dev.clear();
  return { f, q: v.query, focus: !admin && ["nodev", "duechg"].includes(v.focus) ? "open" : v.focus, view: !admin && ["dev", "assignee", "history"].includes(v.mode) ? "list" : v.mode, group: v.group };
}
