import { test, expect } from "@playwright/test";

// Clients & Projects: the Odoo projects table against a synthetic proxy. Every request is intercepted; nothing here is real data.
const CATALOG = { revision: 3, entries: [
  { id: "c1", name: "Acme", parentId: null, sources: [{ source: "odoo-customer", row: 1 }] },
  { id: "p1", name: "Branch A", parentId: "c1", sources: [{ source: "odoo", row: 10 }] },
  { id: "p2", name: "Branch B", parentId: "c1", sources: [] },
] };
const row = (o) => ({ client: "", company: "All in One", url: "https://odoo.example.invalid/web#id=" + o.odooId, linkable: true, pendingHours: 0, mapped: false,
  links: { projects: [], epics: [], helpdesk: false, tickets: { count: 0, byProject: {}, keys: [] } }, overHours: 0,
  missingClient: !o.client, archived: false, ticketCount: 0, openTickets: 0, reviewTickets: 0, reviewKeys: [], lastWorkDate: null, usedPercent: null, ...o });
const PROJECTS = [
  row({ odooId: 10, name: "Branch A", client: "Acme", createdAt: "2026-03-01T09:00:00.000Z", mapped: true, allocatedHours: 10, loggedHours: 12.5, remainingHours: -2.5, overHours: 2.5, status: "over", pendingHours: 0.5, usedPercent: 125,
    ticketCount: 4, openTickets: 3, reviewTickets: 1, reviewKeys: ["AION-2"], lastWorkDate: "2026-06-02",
    links: { projects: [{ id: "p1", name: "Acme / Branch A" }], epics: ["AION-100"], helpdesk: false, tickets: { count: 3, byProject: { AION: 2, INT: 1 }, keys: ["AION-1", "AION-2", "INT-3"] } } }),
  row({ odooId: 11, name: "Odoo only", createdAt: "2026-05-01T09:00:00.000Z", allocatedHours: null, loggedHours: 0, remainingHours: null, status: "not_set" }),
  row({ odooId: 12, name: "Holding job", client: "Holding", company: "Holding", createdAt: "2026-04-01T09:00:00.000Z", linkable: false, allocatedHours: 5, loggedHours: 4.5, remainingHours: 0.5, status: "near", usedPercent: 90 }),
];

const MAPPING = { scanned: 4, mapped: 1, ready: 1, missing: 1, ambiguous: 1, conflict: 0, projectsSyncedAt: 1, rows: [
  { key: "AION-7", kind: "ready", client: "Acme", project: "Branch A", odooProjectId: 10, label: "Acme → Branch A", message: "Will be linked to Acme → Branch A." },
  { key: "AION-8", kind: "missing", client: "", project: "", message: "No client or project chosen." },
  { key: "AION-9", kind: "ambiguous", client: "Acme", project: "Website", candidates: [{ id: 20, label: "Acme → Website (#20)" }, { id: 21, label: "Acme → Website (#21)" }], message: "Its project links 2 Odoo projects." }] };
const DETAILS = { project: PROJECTS[0], allocation: true, nearLimit: 0.8, sync: null,
  tickets: [{ key: "AION-1", open: true, completedAt: null, prs: [] }, { key: "AION-2", open: true, completedAt: null, prs: [{ id: 5, number: 41, title: "Fix totals", url: "https://github.example.invalid/pr/41", state: "pending" }] }],
  reviews: [{ key: "AION-2", open: true, completedAt: null, prs: [{ id: 5, number: 41, title: "Fix totals", url: "https://github.example.invalid/pr/41", state: "pending" }] }],
  workLogs: { total: 1, lines: [{ id: 1, date: "2026-06-02", description: "Totals", hours: 2.5, person: "Dana", task: "[AION-1] Totals" }] },
  history: [{ type: "allocation", from: 8, to: 10, at: "2026-06-01T10:00:00Z", by: { name: "Manager" } }] };

async function open(page, extra = []) {
  const errors = [], sent = [];
  page.on("pageerror", (e) => errors.push(e.message));
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
    const json = (v, status = 200) => route.fulfill({ status, json: v });
    if (url.pathname === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people: {}, devs: [], role: "admin", email: "boss@example.invalid", accounts: true, odoo: true, mail: false, ai: { enabled: false }, capabilities: ["ticket-business-v1", "project-budget-v1"] });
    if (url.pathname === "/jira/search") return json({ issues: [] });
    if (url.pathname === "/internal") return json({ tickets: [] });
    if (url.pathname === "/date-requests") return json({ requests: [] });
    if (url.pathname === "/clients") return json(catalog);
    if (url.pathname === "/clients/odoo-sync") return json(req.method === "GET" ? { odoo: true, syncedAt: Date.parse("2026-06-03T08:00:00Z"), projectsSyncedAt: Date.parse("2026-06-03T08:00:00Z"), error: null } : { odoo: true, changed: false, added: 0, projects: 3 });
    if (url.pathname === "/clients/odoo-projects/options") return json({ syncedAt: 1, projects: [{ id: 10, name: "Branch A", clientName: "Acme", label: "Acme → Branch A", archived: false, missingClient: false, known: true }] });
    if (url.pathname === "/clients/needs-mapping/apply") { sent.push({ apply: JSON.parse(req.postData()) }); mapping.rows = mapping.rows.filter((r) => r.kind !== "ready"); Object.assign(mapping, { ready: 0, mapped: mapping.mapped + 1 }); return json({ applied: 1, skipped: [], plan: mapping }); }
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
  return { errors, sent };
}
// The projects table is the first .budget-table (the details dialog has its own for work logs).
const table = (page) => page.locator(".budget-table").first();
const names = (page) => table(page).locator("tbody tr.budget-main td:first-child .linkbtn");
const rowOf = (page, name) => table(page).locator("tbody tr.budget-main", { has: page.getByRole("button", { name, exact: true }) });
// The secondary row under a project, opened with its ▸ button.
const detailOf = (page, name) => rowOf(page, name).locator("xpath=following-sibling::tr[1]");

test("Clients & Projects lists every active Odoo project with its client, hours, budget, tickets and actions", async ({ page }) => {
  const seen = await open(page);
  await expect(table(page)).toBeVisible();
  await expect(table(page).locator("thead th")).toHaveText(["Odoo Project", "Client", "Created", "Allocated", "Logged", "Remaining", "Used", "Budget Status", "Open Tickets", "Needs PR Review", "Last Work Log", "Actions"].map((t) => new RegExp("^" + t)));
  // Sorted by Odoo creation date, newest first.
  await expect(names(page)).toHaveText(["Odoo only", "Holding job", "Branch A"]);
  const over = rowOf(page, "Branch A");
  await expect(over.locator("td").nth(1)).toHaveText("Acme");
  await expect(over).toContainText("+0.5 h not in Odoo yet");
  await expect(over.locator(".budget-status")).toHaveText("Over by 2.5 h");
  await expect(over.locator("td").nth(5)).toHaveText("−2.5 h");
  await expect(over.locator("td").nth(6)).toHaveText("125%");
  await expect(over.locator("td").nth(8)).toHaveText("3");
  await expect(over.locator("td").nth(9)).toHaveText("1");
  await expect(over.getByRole("link", { name: "Open Branch A in Odoo" })).toHaveAttribute("href", /id=10$/);
  // Links and the rest are in the expandable row.
  const more = detailOf(page, "Branch A");
  await expect(more).toBeHidden();
  await over.getByRole("button", { name: "More about Branch A" }).click();
  await expect(more).toBeVisible();
  await expect(more).toContainText("Acme / Branch A");
  await expect(more).toContainText("Epic AION-100");
  await expect(more).toContainText("AION: 2 · INT: 1 tickets");
  await expect(more).toContainText("Needs PR review: AION-2");
  const unset = rowOf(page, "Odoo only");
  await expect(unset.locator("td").nth(1)).toHaveText("No client");
  await expect(unset.locator("td").nth(3)).toHaveText("Not set");
  await expect(unset.locator("td").nth(6)).toHaveText("—");
  await expect(unset.locator(".budget-status")).toHaveText("Allocation not set");
  await expect(page.getByText("All active projects: 3")).toBeVisible();
  await expect(table(page).locator("tfoot")).toContainText("Total (all projects)");
  await expect(table(page).locator("tfoot")).toContainText("17 h");
  // Filters narrow the rows, and the counts say they are for the filtered rows.
  await page.getByLabel("Filter by budget status").selectOption("unmapped");
  await expect(names(page)).toHaveText(["Odoo only", "Holding job"]);
  await expect(page.locator(".budget-scope")).toContainText("Matching the filters: 2 projects");
  await page.getByLabel("Filter by budget status").selectOption("");
  await page.getByLabel("Filter by missing client").selectOption("missing");
  await expect(names(page)).toHaveText(["Odoo only"]);
  await page.getByLabel("Filter by missing client").selectOption("");
  await page.getByLabel("Filter by linked tickets").selectOption("with");
  await expect(names(page)).toHaveText(["Branch A"]);
  await page.getByLabel("Filter by linked tickets").selectOption("");
  await page.getByLabel("Search Odoo projects by project or client").fill("acme");
  await expect(names(page)).toHaveText(["Branch A"]);
  // Export CSV takes the rows the filters leave.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
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
  const seen = await open(page, extra);
  // 33 projects: the first page holds the 25 newest; the oldest 8 are on the next page.
  await expect(names(page)).toHaveCount(25);
  await expect(names(page).first()).toHaveText("Odoo only");
  await expect(names(page).last()).toHaveText("Job 08");
  await page.getByRole("button", { name: /Next/ }).click();
  await expect(names(page)).toHaveCount(8);
  await expect(names(page).last()).toHaveText("Job 00");
  // A click on Created turns the whole list oldest first, from the first page.
  await page.getByRole("button", { name: /^Created/ }).click();
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

test("Clients & Projects: Needs mapping lists the tickets without an Odoo project and applies only the ready ones", async ({ page }) => {
  const seen = await open(page);
  const panel = page.locator(".needs-mapping");
  await expect(panel).toContainText("All tickets: 1 of 4 have an Odoo project");
  await expect(panel).toContainText("AION-8");
  await expect(panel).toContainText("Its project links 2 Odoo projects.");
  await expect(page.locator(".catalog-sync-status")).toContainText("Last successful sync");
  await panel.getByRole("button", { name: "Apply all ready (1)" }).click();
  await expect(page.getByText("1 ticket linked.")).toBeVisible();
  await expect(panel).not.toContainText("AION-7");
  await expect(panel).toContainText("AION-9");
  expect(seen.sent).toEqual([{ apply: {} }]);
  expect(seen.errors).toEqual([]);
});

// The create dialogs open from the Clients & Projects buttons; the inline forms are gone.
const dialogNamed = (page, name) => page.getByRole("dialog", { name, exact: true });
const createButton = (page, text) => page.getByRole("button", { name: text, exact: true });

test("Clients & Projects: the creation forms are in dialogs opened from buttons beside Sync", async ({ page }) => {
  await open(page);
  await expect(page.getByLabel("New project name")).toHaveCount(0);
  await expect(page.getByLabel("New contact name")).toHaveCount(0);
  await expect(createButton(page, "Sync from Odoo now")).toBeVisible();
  await expect(createButton(page, "+ Create contact")).toBeVisible();
  await expect(createButton(page, "+ Create project")).toBeVisible();
  await createButton(page, "+ Create project").click();
  await expect(dialogNamed(page, "Create project")).toBeVisible();
  await expect(dialogNamed(page, "Create project").getByLabel("Project name")).toBeFocused();
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
  await createButton(page, "+ Create contact").click();
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
  // A new name works: the dialog closes, the panel reports it, and the contact is in the project's contact list.
  await form.getByLabel("Contact name").fill("Globex");
  await form.getByRole("button", { name: "Create contact", exact: true }).click();
  await expect(form).toBeHidden();
  await expect(page.getByText("Contact “Globex” created in Odoo.")).toBeVisible();
  await expect(createButton(page, "+ Create contact")).toBeFocused();
  expect(seen.sent.at(-1)).toEqual({ name: "Globex", email: "info@duplicate.example.invalid", phone: "+972 50 000 0000" });
  await createButton(page, "+ Create project").click();
  const project = dialogNamed(page, "Create project");
  await project.getByLabel("Contact").fill("Globex");
  await expect(project.getByRole("option", { name: "Globex", exact: true })).toBeVisible();
  expect(seen.errors).toEqual([]);
});

test("Clients & Projects: Escape asks before discarding typed values, then returns focus to the button", async ({ page }) => {
  await open(page);
  await createButton(page, "+ Create contact").click();
  const form = dialogNamed(page, "Create contact");
  await form.getByLabel("Contact name").fill("Half typed");
  page.once("dialog", (d) => d.dismiss());
  await page.keyboard.press("Escape");
  await expect(form).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.keyboard.press("Escape");
  await expect(form).toBeHidden();
  await expect(createButton(page, "+ Create contact")).toBeFocused();
});

test("Clients & Projects: on a phone the create dialog stays inside the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await open(page);
  await createButton(page, "+ Create project").click();
  const form = dialogNamed(page, "Create project");
  const box = await form.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(form.getByRole("button", { name: "Create project", exact: true })).toBeInViewport();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(fits).toBe(true);
});

test("Clients & Projects: an administrator sets allocated hours and links a project", async ({ page }) => {
  const seen = await open(page);
  await page.getByRole("button", { name: "Set allocation for Odoo only" }).click();
  await page.getByLabel("Allocated hours for Odoo only").fill("40");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(rowOf(page, "Odoo only").locator(".budget-status")).toHaveText("Within budget");
  await expect(rowOf(page, "Odoo only").locator("td").nth(3)).toContainText("40 h");
  await expect(rowOf(page, "Odoo only").locator("td").nth(6)).toHaveText("0%");
  expect(seen.sent[0]).toEqual({ odooId: 11, hours: 40 });
  await rowOf(page, "Odoo only").getByRole("button", { name: "More about Odoo only" }).click();
  const more = detailOf(page, "Odoo only");
  await more.getByRole("button", { name: "Link project" }).click();
  await more.getByRole("combobox").fill("Branch B");
  await page.getByRole("option", { name: "Acme / Branch B" }).click();
  await more.getByRole("button", { name: "Link", exact: true }).click();
  await expect(page.getByText("Linked Acme / Branch B to “Odoo only”.")).toBeVisible();
  await rowOf(page, "Odoo only").getByRole("button", { name: "More about Odoo only" }).click();
  await expect(detailOf(page, "Odoo only")).toContainText("Acme / Branch B");
  expect(seen.sent[1]).toEqual({ revision: 3, odooId: 11, entryId: "p2", unlink: false });
  expect(seen.errors).toEqual([]);
});
