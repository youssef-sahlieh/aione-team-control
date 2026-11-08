import { test, expect } from "@playwright/test";

// Clients & Projects: the Odoo projects table and Map tickets against a synthetic proxy. Every request is intercepted; nothing here is real data.
const CATALOG = { revision: 3, entries: [
  { id: "c1", name: "Acme", parentId: null, sources: [{ source: "odoo-customer", row: 1 }] },
  { id: "p1", name: "Branch A", parentId: "c1", sources: [{ source: "odoo", row: 10 }] },
  { id: "p2", name: "Branch B", parentId: "c1", sources: [] },
] };
const row = (o) => ({ client: "", company: "All in One", url: "https://odoo.example.invalid/web#id=" + o.odooId, linkable: true, pendingHours: 0, mapped: false,
  links: { projects: [], epics: [], helpdesk: false, tickets: { count: 0, byProject: {}, keys: [] } }, overHours: 0,
  missingClient: !o.client, archived: false, ticketCount: 0, openTickets: 0, reviewTickets: 0, reviewKeys: [], lastWorkDate: null, usedPercent: null,
  label: (o.client || "No client") + " → " + o.name, assignable: !!o.client, blocked: o.client ? null : "No client in Odoo.", ...o });
const PROJECTS = [
  row({ odooId: 10, name: "Branch A", client: "Acme", createdAt: "2026-03-01T09:00:00.000Z", mapped: true, allocatedHours: 10, loggedHours: 12.5, remainingHours: -2.5, overHours: 2.5, status: "over", pendingHours: 0.5, usedPercent: 125,
    ticketCount: 4, openTickets: 3, reviewTickets: 1, reviewKeys: ["AION-2"], lastWorkDate: "2026-06-02",
    links: { projects: [{ id: "p1", name: "Acme / Branch A" }], epics: ["AION-100"], helpdesk: false, tickets: { count: 3, byProject: { AION: 2, INT: 1 }, keys: ["AION-1", "AION-2", "INT-3"] } } }),
  row({ odooId: 11, name: "Odoo only", createdAt: "2026-05-01T09:00:00.000Z", allocatedHours: null, loggedHours: 0, remainingHours: null, status: "not_set" }),
  row({ odooId: 12, name: "Holding job", client: "Holding", company: "Holding", createdAt: "2026-04-01T09:00:00.000Z", linkable: false, allocatedHours: 5, loggedHours: 4.5, remainingHours: 0.5, status: "near", usedPercent: 90 }),
];

const MAPPING = { scanned: 5, mapped: 1, ready: 1, missing: 1, ambiguous: 1, conflict: 1, projectsSyncedAt: 1, rows: [
  { key: "AION-7", revision: 2, current: null, kind: "ready", client: "Acme", project: "Branch A", odooProjectId: 10, label: "Acme → Branch A", message: "Its project links Acme → Branch A." },
  { key: "AION-8", revision: 1, current: null, kind: "missing", client: "", project: "", message: "No client or project chosen." },
  { key: "AION-9", revision: 5, current: null, kind: "ambiguous", client: "Acme", project: "Website", candidates: [{ id: 12, label: "Holding → Holding job" }, { id: 21, label: "Acme → Website (#21)" }], message: "Its project links 2 Odoo projects." },
  { key: "AION-10", revision: 3, current: null, kind: "conflict", client: "Acme", project: "Branch B", message: "Its work went to Odoo project #12." }] };
const DETAILS = { project: PROJECTS[0], allocation: true, nearLimit: 0.8, sync: null,
  tickets: [{ key: "AION-1", open: true, completedAt: null, prs: [] }, { key: "AION-2", open: true, completedAt: null, prs: [{ id: 5, number: 41, title: "Fix totals", url: "https://github.example.invalid/pr/41", state: "pending" }] }],
  reviews: [{ key: "AION-2", open: true, completedAt: null, prs: [{ id: 5, number: 41, title: "Fix totals", url: "https://github.example.invalid/pr/41", state: "pending" }] }],
  workLogs: { total: 1, lines: [{ id: 1, date: "2026-06-02", description: "Totals", hours: 2.5, person: "Dana", task: "[AION-1] Totals" }] },
  history: [{ type: "allocation", from: 8, to: 10, at: "2026-06-01T10:00:00Z", by: { name: "Manager" } }] };

// skip: ticket keys the apply endpoint refuses as changed since the list was read. syncChanged: Sync from Odoo now finds something new.
async function open(page, { extra = [], skip = [], syncChanged = false, clock = false } = {}) {
  const errors = [], sent = [], calls = {};
  page.on("pageerror", (e) => errors.push(e.message));
  if (clock) await page.clock.install();
  await page.addInitScript(() => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "boss@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" }));
  });
  const catalog = structuredClone(CATALOG), projects = structuredClone([...PROJECTS, ...extra]), mapping = structuredClone(MAPPING);
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const call = req.method() + " " + url.pathname + url.search; calls[call] = (calls[call] || 0) + 1;
    const json = (v, status = 200) => route.fulfill({ status, json: v });
    if (url.pathname === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people: {}, devs: [], role: "admin", email: "boss@example.invalid", accounts: true, odoo: true, mail: false, ai: { enabled: false }, capabilities: ["ticket-business-v1", "project-budget-v1"] });
    if (url.pathname === "/jira/search") return json({ issues: [] });
    if (url.pathname === "/internal") return json({ tickets: [] });
    if (url.pathname === "/date-requests") return json({ requests: [] });
    if (url.pathname === "/clients") return json(catalog);
    if (url.pathname === "/clients/odoo-sync") return json(req.method() === "GET" ? { odoo: true, syncedAt: Date.parse("2026-06-03T08:00:00Z"), projectsSyncedAt: Date.parse("2026-06-03T08:00:00Z"), error: null }
      : syncChanged && url.search === "?force=1" ? { odoo: true, changed: true, added: 1, projects: 3 } : { odoo: true, changed: false, added: 0, projects: 3 });
    if (url.pathname === "/clients/odoo-projects/options") return json({ syncedAt: 1, projects: [{ id: 10, name: "Branch A", clientName: "Acme", label: "Acme → Branch A", archived: false, missingClient: false, known: true }] });
    if (url.pathname === "/clients/needs-mapping/apply") {
      const b = JSON.parse(req.postData()); sent.push({ apply: b });
      const linked = [], skipped = [];
      for (const i of b.items) {
        const r = mapping.rows.find((x) => x.key === i.key);
        if (skip.includes(i.key)) { skipped.push({ key: i.key, message: "Changed since the list was opened. Refresh the list to see it." }); continue; }
        const id = i.odooProjectId ?? r.odooProjectId;
        linked.push({ key: i.key, odooProjectId: id, label: projects.find((p) => p.odooId === id).label });
      }
      mapping.rows = mapping.rows.filter((r) => !linked.some((l) => l.key === r.key));
      return json({ applied: linked.length, skipped, linked, plan: mapping });
    }
    if (url.pathname === "/clients/needs-mapping") return json(mapping);
    if (url.pathname === "/clients/odoo-projects/details") return json(DETAILS);
    if (url.pathname === "/clients/odoo-projects") return json({ allocation: true, nearLimit: 0.8, unplacedPendingHours: 0, projects });
    if (url.pathname === "/clients/odoo-projects/allocation") {
      const b = JSON.parse(req.postData()); sent.push(b);
      Object.assign(projects.find((p) => p.odooId === b.odooId), { allocatedHours: b.hours, remainingHours: b.hours, status: "on_track" });
      return json({ odooId: b.odooId, allocatedHours: b.hours });
    }
    if (url.pathname === "/clients/odoo/project") {
      sent.push(JSON.parse(req.postData()));
      return json({ catalog }, 201);
    }
    if (url.pathname === "/clients/odoo/customer") {
      const b = JSON.parse(req.postData()); sent.push(b);
      if (b.name === "Duplicate") return json({ code: "duplicate", error: "A contact named Duplicate already exists in Odoo." }, 409);
      catalog.entries.push({ id: "c" + (catalog.entries.length + 1), name: b.name, parentId: null, sources: [{ source: "odoo-customer", row: 9 }] }); catalog.revision++;
      return json({ catalog }, 201);
    }
    if (url.pathname === "/clients/odoo-projects/link") {
      const b = JSON.parse(req.postData()); sent.push(b);
      catalog.entries.find((e) => e.id === b.entryId).sources.push({ source: "odoo", row: b.odooId }); catalog.revision++;
      Object.assign(projects.find((p) => p.odooId === b.odooId), { mapped: true, links: { projects: [{ id: b.entryId, name: "Acme / Branch B" }], epics: [], helpdesk: false, tickets: { count: 0, byProject: {}, keys: [] } } });
      return json(catalog);
    }
    return json({ code: "forbidden", error: "Unconfigured test request" }, 403);
  });
  await page.goto("http://127.0.0.1:4173/dashboard.html?page=clients");
  return { errors, sent, calls };
}
// The projects table is the first .budget-table (the details dialog has its own for work logs).
const table = (page) => page.locator(".budget-table").first();
const names = (page) => table(page).locator("tbody tr.budget-main td:first-child .linkbtn");
const rowOf = (page, name) => table(page).locator("tbody tr.budget-main", { has: page.getByRole("button", { name, exact: true }) });
// The secondary row under a project, opened with its ▸ button.
const detailOf = (page, name) => rowOf(page, name).locator("xpath=following-sibling::tr[1]");
const dialogNamed = (page, name) => page.getByRole("dialog", { name, exact: true });
const createButton = (page, text) => page.getByRole("button", { name: text, exact: true });
// The secondary actions are in the More menu.
async function fromMore(page, item) { await page.locator(".clients-more > summary").click(); await page.getByRole("button", { name: item, exact: true }).click(); }
const showFilters = (page) => page.getByRole("button", { name: /^Filters/ }).click();

test("Clients & Projects: a heading, four actions, a one-line sync status and the projects table", async ({ page }) => {
  const seen = await open(page);
  await expect(table(page)).toBeVisible();
  await expect(page.locator(".clients-actions > .btn")).toHaveText(["Sync from Odoo now", "+ Create project", "Map tickets (4)"]);
  await expect(page.locator(".clients-more > summary")).toHaveText("More");
  await expect(page.locator(".clients-sync")).toHaveText(/^Synced from Odoo /);
  await expect(page.locator(".clients-sync-error")).toHaveCount(0);
  // The inline Needs mapping section and the long explanations are gone from the page.
  await expect(page.locator(".needs-mapping")).toHaveCount(0);
  await expect(page.getByText("appear here automatically")).toHaveCount(0);
  expect(seen.errors).toEqual([]);
});

test("Clients & Projects lists every active Odoo project with its client, hours, budget, tickets and actions", async ({ page }) => {
  const seen = await open(page);
  await expect(table(page).locator("thead th")).toHaveText(["Project", "Client", "Allocated", "Logged", "Remaining", "Budget status", "Open tickets", "Actions"].map((t) => new RegExp("^" + t)));
  // Sorted by Odoo creation date, newest first.
  await expect(names(page)).toHaveText(["Odoo only", "Holding job", "Branch A"]);
  const over = rowOf(page, "Branch A");
  await expect(over.locator("td").nth(1)).toHaveText("Acme");
  await expect(over.locator("td").nth(2)).toHaveText("10 h");
  await expect(over.locator(".budget-status")).toHaveText("Over by 2.5 h");
  await expect(over.locator("td").nth(4)).toHaveText("−2.5 h");
  await expect(over.locator("td").nth(6)).toHaveText("3");
  // Created, %, reviews, pending hours, the Odoo id and the Jira links are in the expandable row.
  const more = detailOf(page, "Branch A");
  await expect(more).toBeHidden();
  await over.getByRole("button", { name: "More about Branch A" }).click();
  await expect(more).toBeVisible();
  for (const t of ["Created", "125%", "1 (AION-2)", "Not in Odoo yet", "0.5 h", "#10", "Acme / Branch A", "Epic AION-100", "AION: 2 · INT: 1 tickets"]) await expect(more).toContainText(t);
  await expect(more.getByRole("link", { name: "Open Branch A in Odoo" })).toHaveAttribute("href", /id=10$/);
  // Not set is not zero.
  const unset = rowOf(page, "Odoo only");
  await expect(unset.locator("td").nth(1)).toHaveText("No client");
  await expect(unset.locator("td").nth(2)).toHaveText("Not set");
  await expect(unset.locator(".budget-status")).toHaveText("Allocation not set");
  await expect(page.locator(".budget-scope")).toHaveText("3 projects · 1 over budget · 1 near limit");
  await expect(table(page).locator("tfoot")).toContainText("Total");
  await expect(table(page).locator("tfoot")).toContainText("17 h");
  // Search and the client filter are in view; the other filters are behind Filters, which counts them.
  await expect(page.getByLabel("Filter by budget status")).toBeHidden();
  await page.locator(".clients-page").getByLabel("Filter by client").selectOption("Holding");
  await expect(names(page)).toHaveText(["Holding job"]);
  await page.locator(".clients-page").getByLabel("Filter by client").selectOption("");
  await showFilters(page);
  await page.getByLabel("Filter by budget status").selectOption("unmapped");
  await expect(names(page)).toHaveText(["Odoo only", "Holding job"]);
  await expect(page.locator(".budget-scope")).toContainText("2 of 3 projects");
  await expect(page.getByRole("button", { name: "Filters (1)" })).toBeVisible();
  await page.getByLabel("Filter by budget status").selectOption("");
  await page.getByLabel("Filter by missing client").selectOption("missing");
  await expect(names(page)).toHaveText(["Odoo only"]);
  await page.getByLabel("Filter by missing client").selectOption("");
  await page.getByLabel("Filter by linked tickets").selectOption("with");
  await expect(names(page)).toHaveText(["Branch A"]);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByLabel("Search Odoo projects by project or client").fill("acme");
  await expect(names(page)).toHaveText(["Branch A"]);
  // Export CSV (under More) takes the rows the filters leave.
  const [download] = await Promise.all([page.waitForEvent("download"), fromMore(page, "Export CSV")]);
  expect(download.suggestedFilename()).toMatch(/^odoo-projects-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await (await import("node:fs/promises")).readFile(await download.path(), "utf8");
  const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("Budget Used %,Budget Status");
  expect(lines[1]).toMatch(/^Branch A,Acme,2026-03-01,10,12\.5,-2\.5,125,Over by 2\.5 h,2\.5,3,1,2026-06-02,0\.5,/);
  expect(seen.errors).toEqual([]);
});

test("Clients & Projects: Created sorts every project, newest first, and the order holds across pages", async ({ page }) => {
  const extra = Array.from({ length: 30 }, (_, i) => row({ odooId: 200 + i, name: "Job " + String(i).padStart(2, "0"), createdAt: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString(), allocatedHours: null, loggedHours: 0, remainingHours: null, status: "not_set" }));
  const seen = await open(page, { extra });
  // 33 projects: the first page holds the 25 newest; the oldest 8 are on the next page.
  await expect(names(page)).toHaveCount(25);
  await expect(names(page).first()).toHaveText("Odoo only");
  await expect(names(page).last()).toHaveText("Job 08");
  await page.getByRole("button", { name: /Next/ }).click();
  await expect(names(page)).toHaveCount(8);
  await expect(names(page).last()).toHaveText("Job 00");
  // Oldest first turns the whole list, from the first page.
  await showFilters(page);
  await page.getByLabel("Sort projects").selectOption("created:1");
  await expect(names(page).first()).toHaveText("Job 00");
  expect(seen.errors).toEqual([]);
});

test("Clients & Projects: a project's name opens its details: budget, tickets, pull requests, work logs and history", async ({ page }) => {
  const seen = await open(page);
  await rowOf(page, "Branch A").getByRole("button", { name: "Branch A", exact: true }).click();
  const details = page.locator("dialog.project-details");
  await expect(details.getByRole("heading", { name: "Branch A" })).toBeVisible();
  await expect(details.locator(".project-budget-summary")).toContainText("Over by 2.5 h");
  await expect(details.locator(".project-budget-summary")).toContainText("125%");
  await expect(details).toContainText("Tickets (2)");
  await expect(details.getByRole("link", { name: "#41 Fix totals" })).toBeVisible();
  await expect(details).toContainText("[AION-1] Totals");
  await expect(details).toContainText("Allocated hours: 8 h → 10 h");
  expect(seen.errors).toEqual([]);
});

test("Clients & Projects: nothing refreshes on a timer, and an open Map tickets choice stays as it is", async ({ page }) => {
  const seen = await open(page, { clock: true });
  await expect(names(page)).toHaveCount(3);
  await page.getByLabel("Search Odoo projects by project or client").fill("o");
  await rowOf(page, "Branch A").getByRole("button", { name: "More about Branch A" }).click();
  await createButton(page, "Map tickets (4)").click();
  const map = dialogNamed(page, "Map tickets");
  await map.getByLabel("Odoo project for AION-8").fill("Holding");
  await map.getByRole("option", { name: "Holding → Holding job" }).click();
  const before = structuredClone(seen.calls);
  await page.clock.fastForward("30:00");
  await expect(map.getByLabel("Odoo project for AION-8")).toHaveValue("Holding → Holding job");
  await expect(page.getByLabel("Search Odoo projects by project or client")).toHaveValue("o");
  await expect(detailOf(page, "Branch A")).toBeVisible();
  // No request at all for the page's data, and no sync, in 30 minutes.
  const clientsCalls = (c) => Object.entries(c).filter(([k]) => /\/clients/.test(k));
  expect(clientsCalls(seen.calls)).toEqual(clientsCalls(before));
  expect(seen.calls["POST /clients/odoo-sync?force=1"]).toBeUndefined();
  expect(seen.errors).toEqual([]);
});

test("Clients & Projects: Sync from Odoo now reads once, and the dashboard render after it keeps filters, open rows and scroll", async ({ page }) => {
  const seen = await open(page, { syncChanged: true });
  await expect(names(page)).toHaveCount(3);
  await page.getByLabel("Search Odoo projects by project or client").fill("o");
  await showFilters(page);
  await page.getByLabel("Filter by missing client").selectOption("present");
  await rowOf(page, "Branch A").getByRole("button", { name: "More about Branch A" }).click();
  const panel = page.locator(".clients-page");
  const handle = await panel.elementHandle();
  const sync = createButton(page, "Sync from Odoo now");
  await sync.click();
  await expect(page.getByText("1 new from Odoo (3 projects).")).toBeVisible();
  await expect(sync).toBeEnabled();
  // The same page element: nothing was rebuilt, so the filters, the open row and the Filters panel are as they were.
  expect(await handle.evaluate((n) => n.isConnected)).toBe(true);
  await expect(page.getByLabel("Search Odoo projects by project or client")).toHaveValue("o");
  await expect(page.getByLabel("Filter by missing client")).toHaveValue("present");
  await expect(detailOf(page, "Branch A")).toBeVisible();
  expect(seen.calls["POST /clients/odoo-sync?force=1"]).toBe(1);
  expect(seen.calls["GET /clients/odoo-projects"]).toBe(2);
  expect(seen.errors).toEqual([]);
});

test("Map tickets: Ready, Missing, Ambiguous and Conflict; a ticket is applied on its own, and Apply all ready skips conflicts", async ({ page }) => {
  const seen = await open(page);
  page.on("dialog", (d) => d.accept());
  await createButton(page, "Map tickets (4)").click();
  const map = dialogNamed(page, "Map tickets");
  await expect(map.locator(".map-kind")).toHaveText(["All 4", "Ready 1", "Missing 1", "Ambiguous 1", "Conflict 1"]);
  // Only the ready ticket has a project chosen for it; the ambiguous one lists its linked projects first, none chosen.
  await expect(map.getByLabel("Odoo project for AION-7")).toHaveValue("Acme → Branch A · suggested");
  await expect(map.getByLabel("Odoo project for AION-8")).toHaveValue("");
  await expect(map.getByLabel("Odoo project for AION-9")).toHaveValue("");
  await map.getByLabel("Odoo project for AION-9").click();
  await expect(map.getByRole("option").first()).toHaveText("Holding → Holding job · linked from its project");
  // The picker has only the table's assignable projects: Odoo only has no client.
  await expect(map.getByRole("option", { name: /Odoo only/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await map.getByRole("button", { name: "Ready 1" }).click();
  await expect(map.locator(".map-row")).toHaveCount(1);
  await map.getByRole("button", { name: "All 4" }).click();
  // One ticket: the client comes from the project chosen.
  await map.getByLabel("Odoo project for AION-8").fill("Branch");
  await map.getByRole("option", { name: "Acme → Branch A" }).click();
  await map.getByRole("button", { name: "Apply the project to AION-8" }).click();
  await expect(map.locator('[data-key="AION-8"]')).toContainText("✓ Linked to Acme → Branch A.");
  expect(seen.sent.at(-1)).toEqual({ apply: { items: [{ key: "AION-8", revision: 1, odooProjectId: 10 }] } });
  await expect(createButton(page, "Map tickets (3)")).toBeAttached();
  // Apply all ready sends only the ready ticket, with the revision read when the list opened.
  await map.getByRole("button", { name: "Apply all ready (1)" }).click();
  await expect(map.locator('[data-key="AION-7"]')).toContainText("✓ Linked");
  expect(seen.sent.at(-1)).toEqual({ apply: { items: [{ key: "AION-7", revision: 2 }] } });
  await expect(map.getByRole("button", { name: "Apply all ready (0)" })).toBeDisabled();
  // A conflict is applied only on its own, after a confirm, and says so.
  await map.getByLabel("Odoo project for AION-10").fill("Holding");
  await map.getByRole("option", { name: "Holding → Holding job" }).click();
  await map.getByRole("button", { name: "Apply the project to AION-10" }).click();
  expect(seen.sent.at(-1)).toEqual({ apply: { items: [{ key: "AION-10", revision: 3, odooProjectId: 12, resolveConflict: true }] } });
  await expect(dialogNamed(page, "Map tickets")).toBeVisible();
  expect(seen.errors).toEqual([]);
});

test("Map tickets: a ticket changed since the list opened is skipped, with the reason under it", async ({ page }) => {
  const seen = await open(page, { skip: ["AION-7"] });
  page.on("dialog", (d) => d.accept());
  await createButton(page, "Map tickets (4)").click();
  const map = dialogNamed(page, "Map tickets");
  await map.getByRole("button", { name: "Apply all ready (1)" }).click();
  await expect(map.locator('[data-key="AION-7"]')).toContainText("Skipped: Changed since the list was opened.");
  await expect(map.locator(".msg").last()).toContainText("0 tickets linked. 1 ticket skipped");
  expect(seen.errors).toEqual([]);
});

test("Map tickets from a project's row: the project and client are shown, conflicts cannot be ticked, the chosen tickets are given the project", async ({ page }) => {
  const seen = await open(page);
  page.on("dialog", (d) => d.accept());
  // A project tickets cannot be given has its Map tickets turned off, with the reason.
  await expect(rowOf(page, "Odoo only").getByRole("button", { name: "Map tickets to Odoo only" })).toBeDisabled();
  await expect(rowOf(page, "Odoo only").getByRole("button", { name: "Map tickets to Odoo only" })).toHaveAttribute("title", /No client in Odoo/);
  await rowOf(page, "Branch A").getByRole("button", { name: "Map tickets to Branch A" }).click();
  const map = dialogNamed(page, "Map tickets to Branch A");
  await expect(map.locator(".map-target")).toContainText("Acme → Branch A");
  await expect(map.locator(".map-target")).toContainText("Acme");
  // Its own ready ticket comes first.
  await expect(map.locator(".map-row").first()).toHaveAttribute("data-key", "AION-7");
  await expect(map.getByLabel("Give AION-10 Acme → Branch A")).toBeDisabled();
  await expect(map.getByRole("button", { name: "Assign 0 tickets to Acme → Branch A" })).toBeDisabled();
  await map.getByLabel("Give AION-8 Acme → Branch A").check();
  await map.getByLabel("Give AION-9 Acme → Branch A").check();
  await map.getByRole("button", { name: "Assign 2 tickets to Acme → Branch A" }).click();
  await expect(map.locator('[data-key="AION-8"]')).toContainText("✓ Linked to Acme → Branch A.");
  expect(seen.sent.at(-1)).toEqual({ apply: { items: [{ key: "AION-8", revision: 1, odooProjectId: 10 }, { key: "AION-9", revision: 5, odooProjectId: 10 }] } });
  expect(seen.errors).toEqual([]);
});

test("Map tickets: closing with a project chosen and not applied asks first", async ({ page }) => {
  await open(page);
  await createButton(page, "Map tickets (4)").click();
  const map = dialogNamed(page, "Map tickets");
  await map.getByLabel("Odoo project for AION-8").fill("Branch");
  await map.getByRole("option", { name: "Acme → Branch A" }).click();
  page.once("dialog", (d) => d.dismiss());
  await map.getByRole("button", { name: "Close", exact: true }).click();
  await expect(map).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await map.getByRole("button", { name: "Close", exact: true }).click();
  await expect(map).toBeHidden();
  await expect(createButton(page, "Map tickets (4)")).toBeFocused();
});

test("Clients & Projects: Create project opens a dialog beside Sync; Create contact is under More", async ({ page }) => {
  await open(page);
  await expect(page.getByLabel("New project name")).toHaveCount(0);
  await createButton(page, "+ Create project").click();
  await expect(dialogNamed(page, "Create project")).toBeVisible();
  await expect(dialogNamed(page, "Create project").getByLabel("Project name")).toBeFocused();
  await page.keyboard.press("Escape");
  await fromMore(page, "Create contact");
  await expect(dialogNamed(page, "Create contact")).toBeVisible();
});

test("Clients & Projects: a new Odoo project takes a decimal allocation, or none when left empty", async ({ page }) => {
  const seen = await open(page);
  await createButton(page, "+ Create project").click();
  const form = dialogNamed(page, "Create project");
  await form.getByLabel("Project name").fill("Shop POS");
  await form.getByLabel("Contact").fill("Acme");
  await form.getByRole("option", { name: "Acme", exact: true }).click();
  await form.getByLabel("Allocated hours (optional)").fill("12.5");
  await form.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(form).toBeHidden();
  await expect.poll(() => seen.sent.length).toBe(1);
  expect(seen.sent[0]).toEqual({ name: "Shop POS", clientId: "c1", allocatedHours: "12.5" });
  await expect(page.getByText("Project “Shop POS” created in Odoo.")).toBeVisible();
  await createButton(page, "+ Create project").click();
  await form.getByLabel("Project name").fill("Shop Online");
  await form.getByLabel("Contact").fill("Acme");
  await form.getByRole("option", { name: "Acme", exact: true }).click();
  await form.getByLabel("Allocated hours (optional)").fill("");
  await form.getByRole("button", { name: "Create project", exact: true }).click();
  await expect.poll(() => seen.sent.length).toBe(2);
  expect(seen.sent[1]).toEqual({ name: "Shop Online", clientId: "c1", allocatedHours: "" });
  expect(seen.errors).toEqual([]);
});

test("Clients & Projects: the project dialog checks its fields and rejects negative or non-number hours", async ({ page }) => {
  const seen = await open(page);
  await createButton(page, "+ Create project").click();
  const form = dialogNamed(page, "Create project");
  await form.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(form.getByText("Enter the project name.")).toBeVisible();
  await expect(form.getByText("Choose the contact this project belongs to.")).toBeVisible();
  await expect(form.getByLabel("Project name")).toHaveAttribute("aria-invalid", "true");
  await form.getByLabel("Project name").fill("Shop POS");
  await form.getByLabel("Allocated hours (optional)").fill("-3");
  await form.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(form.getByText("Enter 0 or more hours, such as 40 or 12.5.")).toBeVisible();
  await expect(form.getByLabel("Project name")).toHaveAttribute("aria-invalid", "false");
  // Zero is a real allocation; the dialog keeps the typed values until the save works.
  await form.getByLabel("Allocated hours (optional)").fill("0");
  await form.getByLabel("Contact").fill("Acme");
  await form.getByRole("option", { name: "Acme", exact: true }).click();
  await form.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(form).toBeHidden();
  expect(seen.sent).toEqual([{ name: "Shop POS", clientId: "c1", allocatedHours: "0" }]);
  expect(seen.errors).toEqual([]);
});

test("Clients & Projects: the contact dialog validates, keeps values after a failed save, and adds the contact to the project selector", async ({ page }) => {
  const seen = await open(page);
  await fromMore(page, "Create contact");
  const form = dialogNamed(page, "Create contact");
  await form.getByRole("button", { name: "Create contact", exact: true }).click();
  await expect(form.getByText("Enter the contact name.")).toBeVisible();
  await expect(seen.sent).toEqual([]);
  await form.getByLabel("Contact name").fill("Duplicate");
  await form.getByLabel("Email (optional)").fill("not-an-email");
  await form.getByRole("button", { name: "Create contact", exact: true }).click();
  await expect(form.getByText("Enter an email address like name@example.com")).toBeVisible();
  await form.getByLabel("Email (optional)").fill("info@duplicate.example.invalid");
  await form.getByLabel("Phone (optional)").fill("+972 50 000 0000");
  await form.getByRole("button", { name: "Create contact", exact: true }).click();
  // Odoo refuses the name: the message shows and everything typed stays.
  await expect(form.locator(".msg.err")).toContainText("A contact named Duplicate already exists in Odoo.");
  await expect(form.getByLabel("Contact name")).toHaveValue("Duplicate");
  await expect(form.getByLabel("Phone (optional)")).toHaveValue("+972 50 000 0000");
  // A new name works: the dialog closes, the page reports it, and the contact is in the project's contact list.
  await form.getByLabel("Contact name").fill("Globex");
  await form.getByRole("button", { name: "Create contact", exact: true }).click();
  await expect(form).toBeHidden();
  await expect(page.getByText("Contact “Globex” created in Odoo.")).toBeVisible();
  await expect(page.locator(".clients-more > summary")).toBeFocused();
  expect(seen.sent.at(-1)).toEqual({ name: "Globex", email: "info@duplicate.example.invalid", phone: "+972 50 000 0000" });
  await createButton(page, "+ Create project").click();
  const project = dialogNamed(page, "Create project");
  await project.getByLabel("Contact").fill("Globex");
  await expect(project.getByRole("option", { name: "Globex", exact: true })).toBeVisible();
  expect(seen.errors).toEqual([]);
});

test("Clients & Projects: Escape asks before discarding typed values, then returns focus to the button", async ({ page }) => {
  await open(page);
  await createButton(page, "+ Create project").click();
  const form = dialogNamed(page, "Create project");
  await form.getByLabel("Project name").fill("Half typed");
  page.once("dialog", (d) => d.dismiss());
  await page.keyboard.press("Escape");
  await expect(form).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.keyboard.press("Escape");
  await expect(form).toBeHidden();
  await expect(createButton(page, "+ Create project")).toBeFocused();
});

test("Clients & Projects: on a phone the page, the create dialog and Map tickets stay inside the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await open(page);
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  await expect(table(page)).toBeVisible();
  expect(await fits()).toBe(true);
  await createButton(page, "+ Create project").click();
  const form = dialogNamed(page, "Create project");
  const box = await form.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(form.getByRole("button", { name: "Create project", exact: true })).toBeInViewport();
  expect(await fits()).toBe(true);
  await page.keyboard.press("Escape");
  await createButton(page, "Map tickets (4)").click();
  const map = dialogNamed(page, "Map tickets");
  const mbox = await map.boundingBox();
  expect(mbox.x + mbox.width).toBeLessThanOrEqual(390);
  await expect(map.getByRole("button", { name: "Apply the project to AION-7" })).toBeVisible();
  expect(await fits()).toBe(true);
});

test("Clients & Projects: an administrator sets allocated hours and links a project; only those rows change", async ({ page }) => {
  const seen = await open(page);
  await page.getByRole("button", { name: "Set allocation for Odoo only" }).click();
  await page.getByLabel("Allocated hours for Odoo only").fill("40");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(rowOf(page, "Odoo only").locator(".budget-status")).toHaveText("Within budget");
  await expect(rowOf(page, "Odoo only").locator("td").nth(2)).toHaveText("40 h");
  expect(seen.sent[0]).toEqual({ odooId: 11, hours: 40 });
  expect(seen.calls["GET /clients/odoo-projects"]).toBe(1);
  await rowOf(page, "Odoo only").getByRole("button", { name: "More about Odoo only" }).click();
  const more = detailOf(page, "Odoo only");
  await more.getByRole("button", { name: "Link project" }).click();
  await more.getByRole("combobox").fill("Branch B");
  await page.getByRole("option", { name: "Acme / Branch B" }).click();
  await more.getByRole("button", { name: "Link", exact: true }).click();
  await expect(page.getByText("Linked Acme / Branch B to “Odoo only”.")).toBeVisible();
  // The table refreshed in place: the row stays open and shows the link.
  await expect(detailOf(page, "Odoo only")).toContainText("Acme / Branch B");
  expect(seen.sent[1]).toEqual({ revision: 3, odooId: 11, entryId: "p2", unlink: false });
  expect(seen.errors).toEqual([]);
});
