import { readRoute, routeUrl } from "./router.js";
import { calculateWorkload, workloadTotals, isOverdue } from "../models/workload.js";
import { assigneeOptions } from "../models/assignees.js";
import { pages, adminPages, buildNav, arrangeNav, wireSidebar, setNavCount } from "./nav.js";
const $ = id => document.getElementById(id);
const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const button = (text, cls, action) => { const b = node("button", cls, text); b.type = "button"; b.addEventListener("click", action); return b; };
const icons = {
  overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  tickets: "M4 4h16v16H4z M8 9h8 M8 14h5",
  internal: "M4 3h12l4 4v14H4z M16 3v5h4 M8 12h8 M8 16h5",
  workload: "M4 20V10 M10 20V4 M16 20v-7 M22 20H2",
  calendar: "M4 5h16v16H4z M8 2v6 M16 2v6 M4 10h16 M8 14h2 M14 14h2",
  reports: "M4 3h16v18H4z M8 8h8 M8 12h8 M8 16h5",
  analytics: "M3 20h18 M6 16v-5 M11 16V6 M16 16v-8 M21 16v-3",
  clients: "M3 6h18v15H3z M7 6V3h10v3 M7 11h10",
  requests: "M3 5v6h6 M3 11a9 9 0 1 1 2 7 M12 7v5l3 2",
  audit: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4",
  worklog: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M12 7v5l3 3",
  errors: "M12 3l9 16H3z M12 10v4 M12 17h.01",
  reviews: "M4 4h12l4 4v12H4z M8 12l2 2 4-4"
};
// AI1 Monitor is a full page on its own site, opened in a new tab so the dashboard stays open. Its sign-in starts
// there, passes through this dashboard (in that new tab, which shares the dashboard sign-in) and ends on the Monitor.
const MONITOR_START_URL = "https://monitor.ai1.host/auth/aione/start";
function icon(name) {
  const box = node("span", "nav-icon");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
  const p = document.createElementNS(svg.namespaceURI, "path"); p.setAttribute("d", icons[name]); svg.appendChild(p); box.appendChild(svg); return box;
}

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
  // "All open" starts from the same built-in view as the dashboard's All open tile, so the filters reset too.
  // All tickets resets to the All open view for users; administrators go back to All open with the filters they set.
  buildNav(nav, { onPage: id => (id !== "tickets" ? navigate(id) : context().admin ? navigate(id, { focus: "open" }) : context().openAllOpen()) });
  // Pages only administrators see; the breadcrumb names the section they belong to.
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
    const late = open.filter(i => isOverdue(i, today()));
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
  // Workload (administrators): who carries which open work right now. Every count opens the ticket list with the same rule
  // (models/workload.js, shared with the list's views) and that member's filter, so the list shows exactly that many tickets.
  // Nothing runs on a timer here: the header's Refresh re-reads the tickets (a failed read keeps the last ones and the
  // page notice says why), and the tab and ticket filters stay as they are.
  function workload(items, target) {
    const ctx = context(), day = today(), dev = workloadMode === "dev";
    const toolbar = node("div", "workload-toolbar"), tabs = node("div", "seg workload-tabs");
    for (const [id, name] of [["dev", "Developer labels"], ["assignee", "Jira assignees"]]) {
      if (!ctx.admin && id === "assignee") continue;
      const b = button(name, "", () => { workloadMode = id; render(); }); b.setAttribute("aria-pressed", String(workloadMode === id)); tabs.appendChild(b);
    }
    toolbar.append(tabs); target.appendChild(toolbar);
    // The member a row stands for, as the ticket list's filter knows it.
    const filterKey = name => dev ? name : !assigneeOptions(ctx.people).some(([key]) => key === name) ? "other" : name;
    const drill = (name, focus) => { if (ctx.admin && name != null) state.f[dev ? "dev" : "assignee"] = new Set([filterKey(name)]); navigate("tickets", { focus }); };
    // Team figures: each ticket once, however many developers it has.
    const totals = workloadTotals(items, day), cards = node("div", "summary-cards overview-metrics workload-summary");
    for (const [label, value, focus] of [["Open tickets", totals.open, "open"], ["Overdue", totals.overdue, "overdue"], ["No due date", totals.noDueDate, "nodue"], ["No developer", totals.noDeveloper, "nodev"]]) {
      const card = button("", "summary-card", () => drill(null, focus)); card.dataset.focus = focus;
      card.append(node("span", "metric-label", label), node("strong", "", String(value))); cards.appendChild(card);
    }
    target.appendChild(cards);
    const p = panel(dev ? "Developer workload" : "Assignee workload", dev ? "Open tickets per developer label. A ticket with two developers counts for each of them (Shared), so the rows can add up to more than the team total." : "Open tickets per Jira assignee, separate from developer labels.");
    const columns = [["Open", "open", "open"], ["In progress", "inProgress", null], ["Overdue", "overdue", "overdue"], ["No date", "noDueDate", "nodue"], ...(dev ? [["Shared", "shared", null]] : [])];
    const table = node("table", "workload-table"), head = node("thead"), header = node("tr");
    ["Team member", ...columns.map(([label]) => label), "Open by status"].forEach((text, n, all) => { const th = node("th", n === all.length - 1 ? "workload-distribution" : "", text); th.scope = "col"; header.appendChild(th); }); head.appendChild(header); table.appendChild(head);
    const body = node("tbody");
    // With a developer filter on, only those developers get a row: each row's count is then also what its drill-down shows.
    const chosen = dev ? state.f.dev : new Set();
    const names = (dev ? (ctx.admin ? [...new Set(items.filter(i => i.cat !== "done").flatMap(i => i.devs.length ? i.devs : ["__none"]))].sort() : [ctx.dev]) : [...new Set(items.filter(i => i.cat !== "done").map(i => i.assignee || "other"))].sort()).filter(n => n && (!chosen.size || chosen.has(n)));
    const distribution = statuses => { const td = node("td", "workload-distribution"), bar = node("div", "workload-bar"); for (const stage of statuses) { const part = node("span"); part.style.setProperty("--weight", stage.count); part.title = `${stage.status}: ${stage.count}`; bar.appendChild(part); } bar.setAttribute("aria-label", statuses.map(stage => `${stage.status}: ${stage.count}`).join(", ") || "No open tickets"); td.appendChild(bar); return td; };
    for (const metric of calculateWorkload(items, names, day, workloadMode)) {
      const name = metric.name, label = dev ? (name === "__none" ? "No developer" : name) : ctx.people[name]?.name || "Other assignees";
      const row = node("tr"), member = node("td");
      member.appendChild(button(label, "", () => drill(name, "open"))); row.appendChild(member);
      for (const [text, key, focus] of columns) {
        const td = node("td", key === "overdue" && metric[key] ? "late-count" : ""), value = metric[key]; td.dataset.label = text;
        if (focus && value) { const b = button(String(value), "linkbtn workload-count", () => drill(name, focus)); b.setAttribute("aria-label", `${label}: ${value} ${text.toLowerCase()}`); td.appendChild(b); } else td.textContent = String(value);
        row.appendChild(td);
      }
      row.appendChild(distribution(metric.statuses)); body.appendChild(row);
    }
    table.appendChild(body);
    if (names.length) {
      const foot = node("tfoot"), row = node("tr", "workload-total");
      row.appendChild(node("td", "", `Team, each ticket once (${totals.open} open)`));
      for (const [text, key] of columns) { const td = node("td", "", String(totals[key])); td.dataset.label = text; row.appendChild(td); }
      row.appendChild(distribution(totals.statuses)); foot.appendChild(row); table.appendChild(foot);
    }
    p.appendChild(table); if (!names.length) p.appendChild(node("div", "empty-copy", "No open tickets in this view.")); target.appendChild(p);
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
    // The tickets page is named after the view it shows (All open, Closed, Overdue…), so the heading never disagrees with the list.
    $("page-heading").textContent = route.page === "tickets" ? context().focusLabel() : page[1]; $("page-description").textContent = route.page==="tickets"&&!context().admin?"The tickets you’re authorized to work on.":route.page==="reviews"&&context().admin?"Open pull requests that name a ticket and are waiting for a review, longest wait first. Tickets are read-only here.":page[2]; $("breadcrumbs").textContent = adminPages.has(route.page) ? "Admin" : "Workspace";
    for (const link of nav.querySelectorAll("a[data-page]")) { if (link.dataset.page === route.page) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current"); }
    // Pending date requests (null until they have loaded once: the last known count stays until then).
    setNavCount("requests", context().pendingDates);
    // Same count as the All open tile: open tickets in the current scope (see openCount in dashboard.js).
    setNavCount("tickets", context().openCount());
    const custom = ["overview", "requests", "workload", "calendar", "reports", "analytics", "clients", "worklog", "errors", "reviews"].includes(route.page);
    $("tickets-area").hidden = custom; $("workspace-content").hidden = !custom;
    if (!custom) return false;
    const target = $("workspace-content");
    // Clients, Checks & Reports and Analytics load their own data and refresh only when asked: once open, a dashboard
    // render leaves them in place, so their filters, scroll, open sections and dialogs stay as they are.
    if (["clients", "reports", "analytics"].includes(route.page) && target.querySelector(`:scope > [data-keep="${route.page}"]`)) return true;
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
