const $ = id => document.getElementById(id);
// The ticket view is laid out like Jira: a main column (description, attachments, then Activity with its own
// tabs: comments, history, due date changes, internal notes) and a side column (status, details, assignee,
// developers, due date, development and the ticket's work fields). On narrow screens the side column comes first.
export function createIssueDrawer({ isDirty, canViewHistory, canViewFullHistory = () => false, onSelect = () => {} }) {
  const drawer = $("drawer"), body = $("d-body"), tabs = $("drawer-tabs");
  let opener = null, active = "comments";
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const blocks = [...body.children], has = (child, sel) => child.matches(sel) || !!child.querySelector(sel);
  const pick = sel => blocks.find(child => has(child, sel));

  const layout = el("div", "jira-layout"), main = el("div", "jira-main"), side = el("aside", "jira-side");
  side.setAttribute("aria-label", "Ticket details");
  layout.append(main, side);

  // Side column: status, Details (the facts), people and dates, development, ticket work.
  const details = el("section", "blk jira-details"); details.append(el("h3", "", "Details"));
  const facts = pick("#d-facts"); if (facts) details.append(facts);
  for (const part of [pick("#d-trans"), details, pick("#d-asgname"), pick("#d-devs"), pick("#d-due"), pick("#d-prs-blk"), pick("#business-fields")]) if (part) side.append(part);

  // Main column: description, attachments, then Activity.
  for (const part of [pick("#d-desc"), pick("#d-att"), pick("#i-att")]) if (part) main.append(part);
  const activity = el("section", "jira-activity"); activity.append(el("h3", "jira-activity-title", "Activity"));
  tabs.setAttribute("aria-label", "Activity"); activity.append(tabs);
  const panels = {};
  for (const [id, label] of [["comments", "Comments"], ["history", "History"], ["activity", "Due date changes"], ["notes", "Internal notes"]]) {
    const tab = el("button", "drawer-tab", label); tab.type = "button";
    tab.id = "tab-" + id; tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", "panel-" + id);
    tab.addEventListener("click", () => select(id)); tabs.appendChild(tab);
    const panel = el("div", "drawer-panel"); panel.id = "panel-" + id; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", tab.id); panels[id] = panel;
  }
  for (const [id, sel] of [["comments", "#d-comments"], ["history", "#d-full-history"], ["activity", "#d-hist"]]) { const part = pick(sel); if (part) panels[id].append(part); }
  panels.activity.prepend(el("p", "msg", "Recorded due date changes. This timeline is not a complete ticket audit."));
  Object.values(panels).forEach(panel => activity.append(panel));
  main.append(activity);
  // Anything not placed above stays in the main column, so nothing is lost.
  for (const child of blocks) if (!layout.contains(child)) main.insertBefore(child, activity);
  body.replaceChildren(layout);

  // "overview" (opening a ticket) shows the comments, like Jira.
  function select(id) {
    if (id === "overview") id = "comments";
    if (id === "activity" && !canViewHistory()) id = "comments";
    if (id === "history" && !canViewFullHistory()) id = "comments";
    $("tab-activity").hidden = !canViewHistory();
    $("tab-history").hidden = !canViewFullHistory();
    active = id;
    for (const tab of tabs.children) { const selected = tab.id === "tab-" + id; tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; }
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== id;
    onSelect(id);
  }
  tabs.addEventListener("keydown", e => {
    const list = [...tabs.children].filter(tab => !tab.hidden), index = list.indexOf(document.activeElement);
    if (index < 0) return;
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % list.length;
    else if (e.key === "ArrowLeft") next = (index + list.length - 1) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else return;
    e.preventDefault(); select(list[next].id.slice(4)); list[next].focus();
  });
  document.addEventListener("keydown", e => {
    if (drawer.hidden || e.key !== "Tab" || !$("pop").hidden || document.querySelector("dialog[open]")) return;
    const targets = [...drawer.querySelectorAll('button,a[href],input,textarea,select,[tabindex="0"]')].filter(n => !n.disabled && n.getClientRects().length);
    const first = targets[0], last = targets.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  });
  select(active);
  return {
    select,
    open() { opener = document.activeElement; select("overview"); body.scrollTop = 0; $("main-content").closest(".app-shell").inert = true; document.body.classList.add("drawer-open"); },
    allowClose() { return !isDirty() || confirm("Discard your unsaved ticket edits?"); },
    close() { $("main-content").closest(".app-shell").inert = false; document.body.classList.remove("drawer-open"); if (opener?.isConnected) opener.focus(); else $("page-heading").focus(); }
  };
}
