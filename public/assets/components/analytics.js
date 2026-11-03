// Analytics page (administrators): who is delivering what, how fast, and how many hours it takes.
// Order follows the questions a manager asks: headline numbers with last period beside them, then the trend,
// then where the hours go, then what needs attention. Numbers come from models/analytics-stats.js.
import { applyFilters, kpis, weeklyFlow, weeklyHours, hoursByClient, openByAge, isOverdue, dayNumber } from "../models/analytics-stats.js";
import { PRESETS, SOURCE_CHOICES, readFilters, writeFilters, rangeEndingAt } from "../models/analytics-url.js";
import { loadChartJs, drawBars, watchTheme, theme, shortDay } from "./analytics-charts.js";

const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const button = (text, cls, action) => { const b = node("button", cls, text); b.type = "button"; b.addEventListener("click", action); return b; };
const num = v => v === null || v === undefined ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
const SOURCE_NAMES = { all: "All sources", jira: "Jira", internal: "Internal", odoo: "Odoo Helpdesk" };

// The change against the previous period of the same length, as an arrow chip.
// `good` says which direction is good news: "up", "down", or null when neither is (then the chip stays grey).
function delta(value, prior, { good = null, unit = "" } = {}) {
  const chip = node("span", "an-delta");
  if (value === null || prior === null || prior === undefined) { chip.classList.add("flat"); chip.textContent = "No earlier period to compare"; return chip; }
  const d = Math.round((value - prior) * 10) / 10, dir = d > 0 ? "up" : d < 0 ? "down" : "same";
  chip.classList.add(dir === "same" || !good ? "flat" : dir === good ? "good" : "bad");
  chip.textContent = (dir === "up" ? "▲ " : dir === "down" ? "▼ " : "● ") + (dir === "same" ? "No change" : num(Math.abs(d)) + unit) + " vs " + num(prior) + unit + " before";
  return chip;
}

const ICON_REFRESH = "M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5";

export function createAnalytics({ api, today, openIssue }) {
  let customOpen = false, snapshot = null, meta = null, filters = null, host = null, charts = [], stopTheme = null, status = "idle", problem = "", ChartJs = null;

  const destroyCharts = () => { charts.forEach(c => c.destroy()); charts = []; };
  const sync = () => history.replaceState(history.state, "", writeFilters(location.href, filters));
  const set = patch => { filters = { ...filters, ...patch }; sync(); draw(); };

  async function load(refresh) {
    status = "loading"; problem = ""; draw();
    try {
      const r = await api(refresh ? "/analytics/refresh" : "/analytics/snapshot", refresh ? { method: "POST" } : undefined);
      snapshot = r.snapshot; meta = { cached: r.cached, stale: r.stale, refreshWarning: r.refreshWarning, refreshing: r.refreshing };
      status = "ready";
    } catch (e) {
      status = "error";
      problem = e && e.status === 404 ? "The analytics service isn't on the server yet. Deploy the updated proxy." : e && e.status === 409 ? "The first snapshot is being prepared. Try again in a moment." : (e && e.message) || "Analytics could not be loaded.";
    }
    draw();
  }

  function select(label, value, options, onChange) {
    const wrap = node("label", "an-field"), s = node("select"), t = node("span", "", label);
    for (const [v, text] of options) { const o = node("option", "", text); o.value = v; s.appendChild(o); }
    s.value = value; s.addEventListener("change", () => onChange(s.value)); wrap.append(t, s); return wrap;
  }
  function dateInput(label, value, onChange) {
    const wrap = node("label", "an-field"), i = node("input"); i.type = "date"; i.value = value; i.max = today(); i.addEventListener("change", () => i.value && onChange(i.value));
    wrap.append(node("span", "", label), i); return wrap;
  }

  function refreshButton() {
    const b = button("", "an-refresh", () => load(true)); b.title = "Rebuild the data from Jira, internal tickets and the work log";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); path.setAttribute("d", ICON_REFRESH); svg.appendChild(path);
    b.append(svg, node("span", "", "Refresh data")); return b;
  }

  function controls() {
    const bar = node("div", "an-controls");
    const activePreset = PRESETS.find(([d]) => { const r = rangeEndingAt(filters.to, d); return filters.to === today() && r.from === filters.from; });
    // Period: one segmented control. "Custom" reveals the two dates.
    const seg = node("div", "an-seg"); seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Period");
    for (const [d, l] of PRESETS) { const b = button(l, "an-seg-btn", () => set(rangeEndingAt(today(), d))); b.setAttribute("aria-pressed", String(activePreset?.[0] === d)); seg.appendChild(b); }
    const custom = button("Custom", "an-seg-btn", () => { customOpen = true; draw(); });
    custom.setAttribute("aria-pressed", String(!activePreset)); seg.appendChild(custom);
    bar.appendChild(seg);
    if (!activePreset || customOpen) { bar.appendChild(dateInput("From", filters.from, v => set({ from: v, to: v > filters.to ? v : filters.to }))); bar.appendChild(dateInput("To", filters.to, v => set({ to: v, from: v < filters.from ? v : filters.from }))); }
    const clients = [...new Map(snapshot.tickets.filter(t => t.clientId).map(t => [t.clientId, t.clientName || t.clientId])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    bar.appendChild(select("Client", filters.client, [["", "All clients"], ...clients], v => set({ client: v })));
    const devs = [...new Set(snapshot.tickets.flatMap(t => t.devs))].sort();
    bar.appendChild(select("Developer", filters.dev, [["", "Everyone"], ...devs.map(d => [d, d])], v => set({ dev: v })));
    bar.appendChild(select("Source", filters.source, SOURCE_CHOICES.map(s => [s, SOURCE_NAMES[s]]), v => set({ source: v })));
    const grow = node("span", "an-grow"); bar.append(grow, refreshButton());
    return bar;
  }

  // A headline number: the value, what it is, how it moved, and one line of context.
  function tile(label, value, chip, note, hint) {
    const t = node("div", "an-tile");
    t.append(node("div", "an-l", label), node("div", "an-n", value), chip, node("div", "an-h", note));
    if (hint) t.title = hint; return t;
  }

  function legend(items) {
    const box = node("ul", "an-legend");
    for (const [label, color] of items) { const li = node("li"), sw = node("span", "an-sw"); sw.style.background = color; li.append(sw, node("span", "", label)); box.appendChild(li); }
    return box;
  }

  // A chart with a "Show as table" switch: the same numbers for keyboard and screen-reader users.
  function chartCard(title, question, build, tableOf, wide) {
    const card = node("section", "an-card" + (wide ? " an-wide" : "")), head = node("div", "an-card-head"), body = node("div", "an-chart"), titles = node("div", "an-card-titles");
    titles.append(node("h3", "", title), node("p", "an-sub", question)); head.appendChild(titles);
    const data = build();
    if (!data) { card.append(head, node("div", "state", "Not available: the source for this chart could not be read.")); return card; }
    if (data.empty) { card.append(head, node("div", "an-empty", data.empty)); return card; }
    const canvas = node("canvas"); canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", title + ". " + data.summary);
    body.appendChild(canvas);
    const table = node("table", "an-table"); table.hidden = true;
    const [heads, rows] = tableOf(data);
    const thead = node("thead"), tr = node("tr"); heads.forEach(h => tr.appendChild(node("th", "", h))); thead.appendChild(tr);
    const tbody = node("tbody"); rows.forEach(r => { const row = node("tr"); r.forEach(c => row.appendChild(node("td", "", c))); tbody.appendChild(row); }); table.append(thead, tbody);
    const toggle = button("Show as table", "an-link", () => { table.hidden = !table.hidden; body.hidden = !table.hidden; leg && (leg.hidden = !table.hidden); toggle.textContent = table.hidden ? "Show as table" : "Show as chart"; });
    head.appendChild(toggle);
    const t = theme(), leg = data.legend ? legend(data.legend.map(([l, i]) => [l, t.series[i]])) : null;
    card.append(head); if (leg) card.appendChild(leg); card.append(body, table);
    if (ChartJs) charts.push(drawBars(ChartJs, canvas, { ...data.spec, colors: data.spec.colors ?? undefined }));
    return card;
  }

  function attention(data, day) {
    const card = node("section", "an-card an-wide"), head = node("div", "an-card-head"), titles = node("div", "an-card-titles");
    const rows = data.tickets.filter(t => isOverdue(t, day)).sort((a, b) => a.dueDay.localeCompare(b.dueDay));
    titles.append(node("h3", "", "Overdue now"), node("p", "an-sub", "Open tickets past their approved due date, oldest first.")); head.appendChild(titles);
    if (rows.length) head.appendChild(node("span", "an-count bad", `${rows.length} overdue`));
    card.appendChild(head);
    if (!rows.length) { card.appendChild(node("div", "an-empty ok", "✓ Nothing is overdue for the current filters.")); return card; }
    const wrap = node("div", "an-table-wrap"), table = node("table", "an-table"), thead = node("thead"), tr = node("tr");
    ["Ticket", "Title", "Client", "Developer", "Due", "Late by"].forEach(h => tr.appendChild(node("th", "", h))); thead.appendChild(tr);
    const tbody = node("tbody");
    for (const t of rows.slice(0, 10)) {
      const row = node("tr"), key = node("td", "an-key"), late = Math.max(1, dayNumber(day) - dayNumber(t.dueDay)), badge = node("td"), pill = node("span", "an-pill bad", late + (late === 1 ? " day" : " days"));
      if (openIssue) key.appendChild(button(t.key, "an-link", () => openIssue(t.key))); else key.textContent = t.key;
      badge.appendChild(pill);
      row.append(key, node("td", "an-title", t.title), node("td", "", t.clientName || "—"), node("td", "", t.devs.join(", ") || "—"), node("td", "", shortDay(t.dueDay)), badge); tbody.appendChild(row);
    }
    table.append(thead, tbody); wrap.appendChild(table); card.appendChild(wrap);
    if (rows.length > 10) card.appendChild(node("p", "an-sub", `Showing the 10 oldest of ${rows.length}.`));
    return card;
  }

  const sentence = (iso, stale) => {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    return (mins < 1 ? "Updated just now" : mins < 60 ? `Updated ${mins} min ago` : `Updated ${new Date(iso).toLocaleString()}`) + (stale ? " · older than an hour, use Refresh data" : "");
  };

  function skeleton() {
    const wrap = node("div", "an-skeleton"); wrap.setAttribute("aria-busy", "true");
    const tiles = node("div", "an-tiles"); for (let i = 0; i < 6; i++) tiles.appendChild(node("div", "an-tile an-sk"));
    const grid = node("div", "an-grid"); for (let i = 0; i < 4; i++) grid.appendChild(node("div", "an-card an-sk an-sk-card"));
    wrap.append(node("p", "an-sub", "Loading analytics…"), tiles, grid); return wrap;
  }

  function draw() {
    if (!host) return;
    destroyCharts(); host.replaceChildren();
    const page = node("div", "an-page");
    if (status === "loading" && !snapshot) { page.appendChild(skeleton()); host.appendChild(page); return; }
    if (status === "error" && !snapshot) { page.append(node("div", "state err", problem), button("Try again", "btn", () => load(false))); host.appendChild(page); return; }
    const day = today(), data = applyFilters(snapshot, filters), period = { from: filters.from, to: filters.to }, k = kpis(data, period, day);
    page.appendChild(controls());
    const notes = [...snapshot.warnings];
    if (meta?.refreshWarning) notes.push(meta.refreshWarning);
    if (problem) notes.push(problem);
    if (notes.length) { const box = node("div", "state"); box.setAttribute("role", "status"); notes.forEach(n => box.appendChild(node("div", "", n))); page.appendChild(box); }

    const tiles = node("div", "an-tiles"), flow = k.open.netFlow;
    tiles.append(
      tile("Created", num(k.created.value), delta(k.created.value, k.created.prior), "New tickets in the period", "Tickets created in the period"),
      tile("Completed", num(k.completed.value), delta(k.completed.value, k.completed.prior, { good: "up" }), k.completed.unknownCompletion ? `${k.completed.unknownCompletion} done tickets have no completion date` : "Tickets finished in the period", "Tickets completed in the period"),
      tile("Open at period end", num(k.open.value), (() => { const c = node("span", "an-delta " + (flow > 0 ? "bad" : flow < 0 ? "good" : "flat"), (flow > 0 ? "▲ +" : flow < 0 ? "▼ −" : "● ±") + Math.abs(flow) + " net"); return c; })(), "Created minus completed in the period", "Tickets not yet done on the last day of the period"),
      tile("Overdue now", num(k.overdue.value), node("span", "an-delta " + (k.overdue.value > 0 ? "bad" : "good"), k.overdue.value > 0 ? "● Needs attention" : "✓ All on track"), `of ${k.overdue.withDueDate} open tickets with a due date`, "Open tickets past their approved due date, as of today"),
      tile("On time", k.onTime.percent === null ? "—" : num(k.onTime.percent) + "%", node("span", "an-delta flat", k.onTime.of ? `${k.onTime.kept} of ${k.onTime.of} on or before due date` : "No completed ticket had a due date"), "Share finished by the approved due date", "Completed in the period on or before the approved due date"),
      tile("Hours logged", k.hours.value === null ? "—" : num(k.hours.value) + " h", k.hours.value === null ? node("span", "an-delta flat", "Unknown, not zero") : delta(k.hours.value, k.hours.prior, { unit: " h" }), k.hours.value === null ? "The work log could not be read" : "Work dated inside the period", "Work dated inside the period"),
    );
    page.appendChild(tiles);

    const grid = node("div", "an-grid");
    grid.append(
      chartCard("Created and completed per week", "Is the team keeping up with the work coming in?", () => {
        const w = weeklyFlow(data.tickets, period);
        return { legend: [["Created", 0], ["Completed", 1]], spec: { labels: w.map(x => x.start), weekly: true, datasets: [{ label: "Created", data: w.map(x => x.created) }, { label: "Completed", data: w.map(x => x.completed) }] }, weeks: w, summary: `${w.reduce((s, x) => s + x.created, 0)} created and ${w.reduce((s, x) => s + x.completed, 0)} completed over ${w.length} weeks. Weeks start on Sunday.` };
      }, d => [["Week starting", "Created", "Completed"], d.weeks.map(x => [x.start, x.created, x.completed])]),
      chartCard("Hours logged per week", "How much work is being logged, and where?", () => {
        const w = weeklyHours(data.entries, period); if (!w) return null;
        if (!w.some(x => x.jira || x.internal || x.odoo)) return { empty: "No work was logged in this period for the current filters." };
        return { legend: [["Jira", 0], ["Internal", 1], ["Odoo Helpdesk", 2]], spec: { labels: w.map(x => x.start), weekly: true, stacked: true, unit: " h", datasets: ["jira", "internal", "odoo"].map(s => ({ label: SOURCE_NAMES[s], data: w.map(x => x[s]) })) }, weeks: w, summary: `${num(w.reduce((s, x) => s + x.jira + x.internal + x.odoo, 0))} hours over ${w.length} weeks, by source.` };
      }, d => [["Week starting", "Jira (h)", "Internal (h)", "Odoo (h)"], d.weeks.map(x => [x.start, x.jira, x.internal, x.odoo])]),
      chartCard("Hours by client", "Which clients take the most time? Click a bar to filter by that client.", () => {
        const rows = hoursByClient(data, period); if (!rows) return null;
        if (!rows.length) return { empty: "No work was logged in this period for the current filters." };
        const top = rows.slice(0, 12), t = theme();
        return { spec: { labels: top.map(r => r.client), horizontal: true, unit: " h", colors: top.map(r => filters.client && r.clientId !== filters.client ? t.line : t.series[0]), datasets: [{ label: "Hours", data: top.map(r => r.hours) }], onPick: i => top[i].clientId && set({ client: top[i].clientId }) }, rows, summary: `${rows.length} clients; the most hours: ${top[0].client}, ${num(top[0].hours)} hours.` };
      }, d => [["Client", "Hours"], d.rows.map(r => [r.client, r.hours])]),
      chartCard("Open work by age", "How long has open work been waiting? (As of today, not the selected period.)", () => {
        const a = openByAge(data.tickets, day);
        if (!a.open) return { empty: "There is no open work for the current filters." };
        const t = theme();
        return { spec: { labels: a.buckets.map(b => b.label), colors: a.buckets.map((_, i) => t.ramp[Math.min(i, t.ramp.length - 1)]), datasets: [{ label: "Open tickets", data: a.buckets.map(b => b.count) }] }, a, summary: `${a.open} open tickets${a.unknown ? `, ${a.unknown} with no creation date` : ""}.` };
      }, d => [["Age", "Open tickets"], [...d.a.buckets.map(b => [b.label, b.count]), ...(d.a.unknown ? [["Unknown creation date", d.a.unknown]] : [])]]),
    );
    page.append(grid, attention(data, day));
    const foot = node("p", "an-foot", `${sentence(snapshot.builtAt, meta?.stale)} · ${data.tickets.length} tickets match the filters · Days are Asia/Jerusalem calendar days · “—” means unknown, not zero`);
    page.appendChild(foot);
    host.appendChild(page);
  }

  return {
    // The page. The snapshot loads once; filters and period changes are calculated in the browser.
    render(target) {
      host = target; filters = readFilters(location.search, today()); customOpen = false;
      if (stopTheme) stopTheme();
      stopTheme = watchTheme(() => { if (host && host.isConnected && snapshot) draw(); });
      loadChartJs().then(c => { ChartJs = c; if (snapshot) draw(); }).catch(e => { problem = e.message; });
      if (snapshot) { draw(); return; }
      load(false);
    },
    // Called when the browser's Back/Forward changes only the filters in the address.
    syncFromUrl() { if (host && snapshot) { filters = readFilters(location.search, today()); draw(); } },
  };
}
