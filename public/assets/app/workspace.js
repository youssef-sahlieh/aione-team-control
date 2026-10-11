import { readRoute, routeUrl } from "./router.js";
import { calculateWorkload } from "../models/workload.js";
const $ = id => document.getElementById(id);
const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const button = (text, cls, action) => { const b = node("button", cls, text); b.type = "button"; b.addEventListener("click", action); return b; };
const icons = {
  overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  mytasks: "M9 6h11 M9 12h11 M9 18h11 M3 6l1 1 2-2 M3 12l1 1 2-2 M3 18l1 1 2-2",
  tickets: "M4 4h16v16H4z M8 9h8 M8 14h5",
  boards: "M3 4h5v16H3z M10 4h5v11h-5z M17 4h5v14h-5z",
  workload: "M4 20V10 M10 20V4 M16 20v-7 M22 20H2",
  calendar: "M4 5h16v16H4z M8 2v6 M16 2v6 M4 10h16 M8 14h2 M14 14h2",
  history: "M3 5v6h6 M3 11a9 9 0 1 1 2 7 M12 7v5l3 2"
};
const pages = [
  ["overview", "Overview", "Your team's work, at a glance."],
  ["mytasks", "My tasks", "Your assignments and the work that needs your attention."],
  ["tickets", "All tickets", "A clear view of your team's work, from first task to final delivery."],
  ["boards", "Boards", "Keep work moving with a shared view of every stage."],
  ["workload", "Workload", "Understand assignments, deadlines, and where support is needed."],
  ["calendar", "Calendar", "Make space for what's next. Plan around your ticket due dates."],
  ["history", "Due date history", "Follow the due date changes recorded for your tickets."]
];
function icon(name) {
  const box = node("span", "nav-icon");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
  const p = document.createElementNS(svg.namespaceURI, "path"); p.setAttribute("d", icons[name]); svg.appendChild(p); box.appendChild(svg); return box;
}

export function createWorkspace({ state, context, render, openIssue, today, allowedItems, canLeave }) {
  let route = readRoute(new URL(location.href), true), ready = false;
  let month = today().slice(0, 7), weekAnchor = today(), calendarMode = "month", workloadMode = "dev";
  let menuOpen = false;
  const mobile = () => matchMedia("(max-width:820px)").matches;
  function setMenu(open) {
    menuOpen = open;
    document.body.classList.toggle("nav-open", open);
    $("mobile-menu").setAttribute("aria-expanded", String(open));
    $("mobile-menu").setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    $("nav-scrim").hidden = !open;
    if (open) $("main-nav").querySelector("a")?.focus();
    else if (mobile()) $("mobile-menu").focus();
    $("app-sidebar").inert = mobile() && !open;
  }
  $("mobile-menu").addEventListener("click", () => setMenu(!menuOpen));
  $("nav-scrim").addEventListener("click", () => setMenu(false));
  $("sidebar-collapse").addEventListener("click", () => {
    const collapsed = document.body.classList.toggle("sidebar-collapsed");
    $("sidebar-collapse").setAttribute("aria-expanded", String(!collapsed));
    $("sidebar-collapse").setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  });
  matchMedia("(max-width:820px)").addEventListener("change", () => setMenu(false));
  $("app-sidebar").inert = mobile();
  document.addEventListener("keydown", e => {
    if (!menuOpen) return;
    if (e.key === "Escape") { e.preventDefault(); setMenu(false); }
    if (e.key === "Tab") {
      const focusable = [...$("app-sidebar").querySelectorAll("a,button")].filter(n => n.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  function synchronize() {
    if (route.page === "boards") state.view = route.mode;
    else if (route.page === "history") state.view = "history";
    else state.view = "list";
    state.sel.clear();
    state.pageIndex = 0;
  }
  function navigate(page, { mode, focus } = {}) {
    if (!canLeave()) return;
    const url = routeUrl(page, mode, location.href);
    history.pushState(null, "", url);
    route = readRoute(url, context().admin);
    if (focus) state.focus = focus;
    synchronize();
    if (menuOpen) setMenu(false);
    render();
    $("page-heading").focus();
  }
  window.addEventListener("popstate", () => { route = readRoute(new URL(location.href), context().admin); synchronize(); render(); });
  const nav = $("main-nav");
  for (const [id, label] of pages) {
    const a = node("a", "nav-link"); a.href = `dashboard.html?page=${id}`; a.dataset.page = id; a.title = label;
    a.append(icon(id), node("span", "", label));
    if (id === "tickets") { const count = node("span", "nav-count", "—"); count.id = "nav-ticket-count"; a.appendChild(count); }
    a.addEventListener("click", e => { if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; e.preventDefault(); navigate(id); });
    nav.appendChild(a);
  }
  function configure() {
    route = readRoute(new URL(location.href), context().admin);
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
    const cards = node("div", "summary-cards");
    for (const [label, value, foot, focus] of [["Open tickets", open.length, "Ready to move forward", "open"], ["Overdue", late.length, "A little attention goes a long way", "overdue"], ["Due today", due.length, "Today's priorities", "today"], ["Completed", items.filter(i => i.cat === "done").length, "Within the loaded history window", "closed"]]) {
      const card = button("", "summary-card", () => navigate("tickets", { focus }));
      card.append(node("span", "metric-label", label), node("strong", "", String(value)), node("span", "metric-foot", foot)); cards.appendChild(card);
    }
    target.appendChild(cards);
    const banner = node("div", "overview-banner"), copy = node("div");
    copy.append(node("h2", "", late.length ? `${late.length} ticket${late.length === 1 ? " needs" : "s need"} a little attention` : "A little clarity for your working day"), node("p", "", late.length ? "Review overdue work and help the team get back on track." : "Review upcoming work, set dates, and keep your team moving."));
    banner.append(node("span", "banner-icon", "↗"), copy, button("Review tickets →", "btn", () => navigate("tickets", { focus: late.length ? "overdue" : "open" }))); target.appendChild(banner);
    const grid = node("div", "workspace-grid"), priorities = panel("Needs attention", "Open tickets, ordered by deadline");
    priorities.querySelector(".panel-heading").appendChild(button("View all →", "linkbtn", () => navigate("tickets")));
    const selected = open.slice().sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999")).slice(0, 6);
    if (!selected.length) priorities.appendChild(node("div", "empty-copy", "No open tickets in this view."));
    selected.forEach(i => priorities.appendChild(compactIssue(i)));
    const status = panel("Work by status", "The actual workflow stages of your loaded tickets");
    const counts = new Map(); open.forEach(i => counts.set(i.status, (counts.get(i.status) || 0) + 1));
    const track = node("div", "status-track");
    for (const [name, count] of counts) { const part = node("span"); part.style.setProperty("--weight", count); part.title = `${name}: ${count}`; track.appendChild(part); }
    status.appendChild(track);
    for (const [name, count] of counts) { const row = node("div", "status-line"); row.append(node("span", "status-dot"), node("span", "", name), node("strong", "", String(count))); status.appendChild(row); }
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
        state.f[workloadMode === "dev" ? "dev" : "assignee"] = new Set([name]); navigate("tickets", { focus: "open" });
      })); row.appendChild(member);
      for (const [value, cls, label] of [[metric.open, "","Open"], [metric.inProgress,"","In progress"], [metric.overdue, "late-count","Overdue"], [metric.noDueDate, "","No date"], [metric.completed, "","Done"]]){const td=node("td",cls,String(value));td.dataset.label=label;row.appendChild(td);}
      const distribution = node("td", "workload-distribution"), bar = node("div", "workload-bar");
      for (const stage of metric.statuses) { const part = node("span"); part.style.setProperty("--weight", stage.count);part.title=`${stage.status}: ${stage.count}`;bar.appendChild(part); }
      bar.setAttribute("aria-label",metric.statuses.map(stage=>`${stage.status}: ${stage.count}`).join(", ")); distribution.appendChild(bar); row.appendChild(distribution); body.appendChild(row);
    }
    table.appendChild(body); p.appendChild(table); if (!names.length) p.appendChild(node("div", "empty-copy", "No assignments in this view.")); target.appendChild(p);
  }
  function calendar(items, target) {
    const p = panel("Due date calendar", "Select a ticket to review its details or change its due date."); p.classList.add("calendar-panel");
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
    p.appendChild(grid); target.appendChild(p);
    const unscheduled = panel("Unscheduled tickets", "Give open work a place on the calendar."); unscheduled.classList.add("calendar-unscheduled");
    const noDate = items.filter(i => !i.due && i.cat !== "done"); noDate.slice(0,25).forEach(i => unscheduled.appendChild(compactIssue(i))); if (!noDate.length) unscheduled.appendChild(node("div", "empty-copy", "All open tickets have a due date."));if(noDate.length>25)unscheduled.appendChild(button(`View all ${noDate.length} unscheduled tickets →`,"btn",()=>navigate("tickets",{focus:"nodue"}))); target.appendChild(unscheduled);
  }
  function renderPage(items) {
    if (!ready) return false;
    const page = pages.find(p => p[0] === route.page);
    $("page-heading").textContent = page[1]; $("page-description").textContent = page[2]; $("breadcrumbs").textContent = page[1];
    for (const link of nav.children) { if (link.dataset.page === route.page) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current"); }
    $("nav-ticket-count").textContent = String(state.issues?.length || 0);
    const custom = ["overview", "workload", "calendar"].includes(route.page);
    $("tickets-area").hidden = custom; $("workspace-content").hidden = !custom;
    if (!custom) return false;
    const target = $("workspace-content"); target.replaceChildren();
    if(context().filterCount){const info=node("div","summary-filter-info");info.append(node("span","","Using your current ticket filters"),button("Adjust filters →","linkbtn",()=>navigate("tickets")));target.appendChild(info);}
    // Respect all active filters but include closed tickets for summary metrics.
    const data = allowedItems();
    if (route.page === "overview") overview(data, target);
    if (route.page === "workload") workload(context().admin ? data : data.filter(i => i.devs.includes(context().dev)), target);
    if (route.page === "calendar") calendar(data, target);
    return true;
  }
  function personalItems(items) {
    if (route.page !== "mytasks" || !context().admin) return items;
    const ctx = context();
    const me = Object.keys(ctx.people).find(k => ctx.people[k].email?.toLowerCase() === ctx.email.toLowerCase() || k.toLowerCase() === ctx.email.split("@")[0].toLowerCase());
    return items.filter(i => (ctx.dev && i.devs.includes(ctx.dev)) || (me && i.assignee === me));
  }
  return { configure, renderPage, navigate, personalItems, route: () => route };
}
