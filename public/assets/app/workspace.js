import { readRoute, routeUrl } from "./router.js";
import { calculateWorkload, workloadTotals } from "../models/workload.js";
import { assigneeOptions } from "../models/assignees.js";
import { pages, adminPages, buildNav, arrangeNav, wireSidebar } from "./nav.js";
const $ = id => document.getElementById(id);
const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const button = (text, cls, action) => { const b = node("button", cls, text); b.type = "button"; b.addEventListener("click", action); return b; };
export function createWorkspace({ state, context, render, openIssue, today, allowedItems, canLeave }) {
  let route = readRoute(new URL(location.href), true), ready = false;
  let month = today().slice(0, 7), weekAnchor = today(), calendarMode = "month", workloadMode = "dev";
  const sidebar = wireSidebar();
  function synchronize() {
    state.view = "list";
    state.sel.clear();
    state.pageIndex = 0;
  }
  function navigate(page, { mode, focus } = {}) {
    if (!canLeave()) return;
    const requestedUrl = routeUrl(page, mode, location.href);
    const resolved = readRoute(requestedUrl, context().admin);
    const url = routeUrl(resolved.page, resolved.mode, requestedUrl);
    history.pushState(null, "", url);
    route = readRoute(url, context().admin);
    if (focus) state.focus = focus;
    synchronize();
    sidebar.close();
    render();
    $("page-heading").focus();
  }
  // Back/Forward between dashboard pages; a step that only opens or closes a ticket (#KEY) leaves the page as it is.
  window.addEventListener("popstate", () => { const next = readRoute(new URL(location.href), context().admin); if (next.page === route.page && next.mode === route.mode) { if (next.page === "analytics") context().syncAnalytics(); return; } route = next; synchronize(); render(); });
  const nav = $("main-nav");
  buildNav(nav, { onPage: id => navigate(id) });
  function configure() {
    route = readRoute(new URL(location.href), context().admin);
    document.body.dataset.workspaceRole=context().admin?"manager":"user";
    arrangeNav(nav, { admin: context().admin });
    const current = new URL(location.href);
    if(current.searchParams.get("page") === "mytasks")history.replaceState(null,"",routeUrl("tickets",null,current));
    // Preserve the old saved ticket modes when there is no explicit page route.
    if (new URL(location.href).searchParams.has("page")) synchronize();
    ready = true;
    $("account-avatar").textContent = context().name.slice(0, 2).toUpperCase();
    $("account-role").textContent = context().admin ? "Administrator" : "Developer";
    $("create-ticket").hidden = !context().internal;
  }
  function compactIssue(i) {
    const b = button("", "compact-ticket", () => openIssue(i.key));
    const info = node("span", "ticket-info");
    info.append(node("b", "", i.summary), node("small", "", `${i.key} · ${i.status} · ${i.internal ? "Internal" : "Jira"}`));
    b.append(node("span", "ticket-dot"), info, node("span", "ticket-date" + (i.due && i.due < today() && i.cat !== "done" ? " late" : ""), i.due || "No due date"));
    return b;
  }
  function panel(title, subtitle) {
    const p = node("section", "panel"), head = node("div", "panel-heading"), text = node("div");
    text.appendChild(node("h2", "", title)); if (subtitle) text.appendChild(node("p", "panel-subtitle", subtitle)); head.appendChild(text); p.appendChild(head); return p;
  }
  function overview(items, target) {
    const open = items.filter(i => i.cat !== "done");
    const late = open.filter(i => i.due && i.due < today());
    const due = open.filter(i => i.due === today());
    const cards = node("div", "summary-cards overview-metrics");
    for (const [label, value, focus] of [["Open tickets", open.length, "open"], ["Overdue", late.length, "overdue"], ["Due today", due.length, "today"], ["Completed", items.filter(i => i.cat === "done").length, "closed"]]) {
      const card = button("", "summary-card", () => navigate("tickets", { focus }));
      card.dataset.focus = focus;
      card.append(node("span", "metric-label", label), node("strong", "", String(value)));
      if(focus === "closed") card.appendChild(node("span", "metric-foot", `Last ${state.closedDays} days`));
      cards.appendChild(card);
    }
    target.appendChild(cards);
    const grid = node("div", "workspace-grid overview-grid"), priorities = panel("Needs attention", "Next open tickets, ordered by due date.");
    priorities.querySelector(".panel-heading").appendChild(button("View all →", "linkbtn", () => navigate("tickets", {focus:"open"})));
    const selected = open.slice().sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999")).slice(0, 6);
    if (!selected.length) priorities.appendChild(node("div", "empty-copy", "No open tickets in this view."));
    selected.forEach(i => {
      const ticket=compactIssue(i);ticket.classList.add("overview-ticket");
      ticket.querySelector("small").textContent=`${i.key} · ${i.status}`;
      const date=ticket.querySelector(".ticket-date");
      if(i.due){const text=new Date(i.due+"T00:00:00Z").toLocaleDateString("en-GB",{day:"numeric",month:"short",...(i.due.slice(0,4)!==today().slice(0,4)?{year:"numeric"}:{}),timeZone:"UTC"});date.textContent=(i.due<today()?"Overdue · ":i.due===today()?"Today · ":"")+text;}
      priorities.appendChild(ticket);
    });
    const status = panel("Open by status");status.classList.add("overview-status");
    const counts = new Map(); open.forEach(i => counts.set(i.status, (counts.get(i.status) || 0) + 1));
    for (const [name, count] of counts) { const row = node("div", "status-line"); row.append(node("span", "", name), node("strong", "", String(count))); status.appendChild(row); }
    if (!counts.size) status.appendChild(node("div", "empty-copy", "No open work to display."));
    grid.append(priorities, status); target.appendChild(grid);
  }
  function workload(items, target) {
    const ctx = context();
    const tabs = node("div", "seg workload-tabs");
    for (const [id, name] of [["dev", "Developer labels"], ["assignee", "Jira assignees"]]) {
      if (!ctx.admin && id === "assignee") continue;
      const b = button(name, "", () => { workloadMode = id; render(); }); b.setAttribute("aria-pressed", String(workloadMode === id)); tabs.appendChild(b);
    }
    target.appendChild(tabs);
    const p = panel(workloadMode === "dev" ? "Developer workload" : "Assignee workload", workloadMode === "dev" ? "A ticket with multiple developer labels counts for each developer." : "Jira assignees are shown separately from developer labels.");
    const table = node("table", "workload-table"), head = node("thead"), header = node("tr");
    ["Team member", "Open", "In progress", "Overdue", "No date", "Done", "Distribution"].forEach(text => { const th = node("th", text === "Distribution" ? "workload-distribution" : "", text); th.scope = "col"; header.appendChild(th); }); head.appendChild(header); table.appendChild(head);
    const body = node("tbody");
    const names = workloadMode === "dev" ? (ctx.admin ? [...new Set(items.flatMap(i => i.devs.length?i.devs:["__none"]))].sort() : [ctx.dev]) : [...new Set(items.map(i => i.assignee || "other"))].sort();
    for (const metric of calculateWorkload(items,names.filter(Boolean),today(),workloadMode)) {
      const name=metric.name;
      const row = node("tr"), member = node("td");
      member.appendChild(button(workloadMode === "dev" ? name==="__none"?"No developer":name : ctx.people[name]?.name || "Other assignees", "", () => {
        if(ctx.admin) state.f[workloadMode === "dev" ? "dev" : "assignee"] = new Set([workloadMode === "assignee"&&!assigneeOptions(ctx.people).some(([key])=>key===name)?"other":name]); navigate("tickets", { focus: "open" });
      })); row.appendChild(member);
      for (const [value, cls, label] of [[metric.open, "","Open"], [metric.inProgress,"","In progress"], [metric.overdue, "late-count","Overdue"], [metric.noDueDate, "","No date"], [metric.completed, "","Done"]]){const td=node("td",cls,String(value));td.dataset.label=label;row.appendChild(td);}
      const distribution = node("td", "workload-distribution"), bar = node("div", "workload-bar");
      for (const stage of metric.statuses) { const part = node("span"); part.style.setProperty("--weight", stage.count);part.title=`${stage.status}: ${stage.count}`;bar.appendChild(part); }
      bar.setAttribute("aria-label",metric.statuses.map(stage=>`${stage.status}: ${stage.count}`).join(", ")); distribution.appendChild(bar); row.appendChild(distribution); body.appendChild(row);
    }
    table.appendChild(body);
    if (names.length) {
      const totals = workloadTotals(items, today()), foot = node("tfoot"), row = node("tr", "workload-total");
      const label = workloadMode === "dev" ? "All tickets" : "All assignees";
      row.appendChild(node("td", "", `${label} (${totals.tickets})`));
      for (const [value, text] of [[totals.open, "Open"], [totals.inProgress, "In progress"], [totals.overdue, "Overdue"], [totals.noDueDate, "No date"], [totals.completed, "Done"]]) { const td = node("td", "", String(value)); td.dataset.label = text; row.appendChild(td); }
      const distribution = node("td", "workload-distribution"), bar = node("div", "workload-bar");
      for (const stage of totals.statuses) { const part = node("span"); part.style.setProperty("--weight", stage.count); part.title = `${stage.status}: ${stage.count}`; bar.appendChild(part); }
      distribution.appendChild(bar); row.appendChild(distribution); foot.appendChild(row); table.appendChild(foot);
    }
    p.appendChild(table); if (!names.length) p.appendChild(node("div", "empty-copy", "No assignments in this view.")); target.appendChild(p);
  }
  function calendar(items, target) {
    const p = panel("Approved deadlines"); p.classList.add("calendar-panel");
    const controls = node("div", "calendar-controls");
    const anchor = new Date(month + "-01T00:00:00Z");
    const move = delta => { if(calendarMode === "week"){ const day=new Date(weekAnchor+"T00:00:00Z");day.setUTCDate(day.getUTCDate()+delta*7);weekAnchor=day.toISOString().slice(0,10);month=weekAnchor.slice(0,7);}else{anchor.setUTCMonth(anchor.getUTCMonth()+delta);month=anchor.toISOString().slice(0,7);weekAnchor=month+"-01";} render(); };
    controls.append(button("‹", "btn", () => move(-1)), node("strong", "", anchor.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })), button("›", "btn", () => move(1)), button("Today", "btn", () => { month = today().slice(0, 7);weekAnchor=today();render(); }));
    controls.children[0].setAttribute("aria-label", "Previous "+calendarMode); controls.children[2].setAttribute("aria-label", "Next "+calendarMode);
    const modes = node("div", "seg");
    for (const mode of ["month", "week"]) { const b = button(mode === "month" ? "Month" : "Week", "", () => { calendarMode = mode; render(); }); b.setAttribute("aria-pressed", String(calendarMode === mode)); modes.appendChild(b); } controls.appendChild(modes);
    p.appendChild(controls);
    const grid = node("div", "calendar-grid");
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) grid.appendChild(node("div", "calendar-label", day));
    let start;
    if (calendarMode === "week") {
      start = new Date(weekAnchor + "T00:00:00Z");
      start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
    } else { start = new Date(anchor); start.setUTCDate(1 - (start.getUTCDay() + 6) % 7); }
    for (let n = 0; n < (calendarMode === "week" ? 7 : 42); n++) {
      const date = new Date(start); date.setUTCDate(start.getUTCDate() + n); const key = date.toISOString().slice(0, 10);
      const scheduled=items.filter(i=>i.due===key);
      const cell = node("div", "calendar-day" + (key.slice(0, 7) !== month ? " outside" : "") + (key === today() ? " today" : "")+(scheduled.length?" has-events":""));
      cell.append(node("span", "day-number", String(date.getUTCDate())),node("span","day-detail",date.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short",timeZone:"UTC"})));
      for (const i of scheduled) { const b = button(i.key, "calendar-ticket" + (i.internal ? " internal" : ""), () => openIssue(i.key)); b.title = `${i.key}: ${i.summary}`; b.appendChild(node("small", "", i.summary)); cell.appendChild(b); }
      if(!scheduled.length)cell.appendChild(node("span","calendar-empty","No tickets due"));
      grid.appendChild(cell);
    }
    p.appendChild(grid); p.appendChild(node("p", "calendar-note", "Calendar dates change only after admin approval. Open a ticket to propose a change.")); target.appendChild(p);
    const unscheduled = panel("Unscheduled tickets", "Give open work a place on the calendar."); unscheduled.classList.add("calendar-unscheduled");
    const noDate = items.filter(i => !i.due && i.cat !== "done"); noDate.slice(0,25).forEach(i => unscheduled.appendChild(compactIssue(i))); if (!noDate.length) unscheduled.appendChild(node("div", "empty-copy", "All open tickets have a due date."));if(noDate.length>25)unscheduled.appendChild(button(`View all ${noDate.length} unscheduled tickets →`,"btn",()=>navigate("tickets",{focus:"nodue"}))); target.appendChild(unscheduled);
  }
  function renderPage(items) {
    if (!ready) return false;
    const page = pages.find(p => p[0] === route.page);
    document.body.dataset.workspacePage = route.page;
    $("page-heading").textContent = page[1]; $("page-description").textContent = route.page==="tickets"&&!context().admin?"The tickets you’re authorized to work on.":page[2]; $("breadcrumbs").textContent = adminPages.has(route.page) ? "Admin" : "Workspace";
    for (const link of nav.querySelectorAll("a[data-page]")) { if (link.dataset.page === route.page) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current"); }
    $("nav-date-count").textContent=String(context().pendingDates||0);
    $("nav-ticket-count").textContent = String(state.issues?.length || 0);
    const custom = ["overview", "requests", "workload", "calendar", "reports", "analytics", "clients", "worklog", "errors", "reviews"].includes(route.page);
    $("tickets-area").hidden = custom; $("workspace-content").hidden = !custom;
    if (!custom) return false;
    const target = $("workspace-content");
    target.replaceChildren();
    if(context().filterCount&&!["requests","reports","analytics","clients","worklog","errors","calendar","reviews"].includes(route.page)){const info=node("div","summary-filter-info");info.append(node("span","","Using your current ticket filters"),button("Adjust filters →","linkbtn",()=>navigate("tickets")));target.appendChild(info);}
    // Respect all active filters but include closed tickets for summary metrics.
    const data = allowedItems();
    if(route.page==="reports"&&context().admin)context().renderReports(target);
    if(route.page==="analytics"&&context().admin)context().renderAnalytics(target);
    if(route.page==="clients"&&context().admin)context().renderCatalog(target);
    if(route.page==="reviews")context().renderReviews(target);
    if(route.page==="errors")context().renderErrors(target);
    if(route.page==="worklog")context().renderWorkLog(target);
    if (route.page === "requests") context().renderRequests(target);
    if (route.page === "overview") {overview(data, target);const p=panel(context().admin?"Date requests awaiting review":"My date requests and decisions");p.classList.add("date-summary");const list=node("div");context().renderRequests(list,{summary:true});p.append(list,button("View all date requests →","linkbtn",()=>navigate("requests")));target.append(p);}
    if (route.page === "workload" && context().admin) workload(data, target);
    if (route.page === "calendar") calendar(data, target);
    return true;
  }
  return { configure, renderPage, navigate, route: () => route };
}
