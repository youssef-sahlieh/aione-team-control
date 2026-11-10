import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { jiraIssue } from "../fixtures/issues.js";

// The project billing workspace in Clients & Projects (billing-v1), against a synthetic proxy: every request is
// intercepted and nothing here reaches Odoo, Jira or mail. Names, tickets and hours are made up.
const row = (o) => ({ client: "Acme", company: "All in One", url: "https://odoo.example.invalid/web#id=" + o.odooId, linkable: true, pendingHours: 0, mapped: true,
  links: { projects: [], epics: [], helpdesk: false, tickets: { count: 0, byProject: {}, keys: [] } }, overHours: 0, missingClient: false, archived: false,
  ticketCount: 3, openTickets: 2, reviewTickets: 0, reviewKeys: [], lastWorkDate: null, usedPercent: null, allocatedHours: 10, loggedHours: 4, remainingHours: 6, status: "on_track",
  label: "Acme → " + o.name, assignable: true, blocked: null, ...o });
const billing = (o) => ({ default: "billable", actualMinutes: 240, billableMinutes: 180, chargeableMinutes: 180, unclassifiedMinutes: 0, pendingSyncMinutes: 0, status: "available",
  allowance: { consumedMinutes: 180, capacityMinutes: 600, remainingMinutes: 420, overageMinutes: 0 }, email: null, ...o });
const PROJECTS = [row({ odooId: 10, name: "Support pack", createdAt: "2026-06-01T09:00:00Z", billing: billing() }), row({ odooId: 11, name: "Other", createdAt: "2026-05-01T09:00:00Z", billing: billing({ default: "not_billable", status: "not_billable" }) })];
const ticket = (o) => ({ source: "internal", projectId: 10, onProject: true, revision: 1, override: null, effective: { value: "billable", source: "project" }, estimatedHours: null, agreedHours: null, agreedDeveloper: null, agreedDev: null,
  actualMinutes: 0, chargeableMinutes: 0, entries: 0, consumedMinutes: 0, sync: { pendingMinutes: 0, review: 0, billingField: null }, exported: { charges: 0, minutes: 0 }, completedAt: null,
  title: "", description: "", descriptionLength: 0, status: "Open", closed: false, devs: [], assignee: "", ...o });
const LONG = "תיאור הפרויקט: support for the Acme branches. ".repeat(8);
const TICKETS = () => ({ project: { odooId: 10, name: "Support pack", description: LONG, default: "billable" }, scope: { from: "2026-10-01", to: "2026-11-09", label: "Since the allocation started (2026-10-01)" }, classification: true, total: 3, truncated: false, limit: 500, detailsError: null,
  tickets: [
    ticket({ key: "AION-101", source: "jira", revision: 3, title: "Synthetic Jira task", description: "=cmd() in a description", status: "Pending QA", devs: ["builder"], assignee: "Test Lead", actualMinutes: 90, chargeableMinutes: 90, entries: 1 }),
    ticket({ key: "INT-7", revision: 5, title: "שלום: internal work", devs: ["dana", "eli"], assignee: "Manager Mo", estimatedHours: 3, actualMinutes: 120, chargeableMinutes: 90, sync: { pendingMinutes: 30, review: 0, billingField: null } }),
    ticket({ key: "HD-3", source: "odoo", title: "Printer", status: "Solved", closed: true, override: "not_billable", effective: { value: "not_billable", source: "ticket" }, actualMinutes: 30 })
  ] });

async function open(page) {
  const errors = [], sent = [], calls = {};
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "boss@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" }));
  });
  const projects = structuredClone(PROJECTS), data = TICKETS();
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname, method = req.method(), body = req.postData() ? JSON.parse(req.postData()) : null;
    calls[method + " " + path] = (calls[method + " " + path] || 0) + 1;
    if (method !== "GET") sent.push({ path, method, body });
    const json = (v, status = 200) => route.fulfill({ status, json: v });
    if (path === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people: {}, devs: [], role: "admin", email: "boss@example.invalid", accounts: true, odoo: true, mail: false, ai: { enabled: false }, capabilities: ["ticket-business-v1", "project-budget-v1", "billing-v1"] });
    if (path === "/jira/search") return json({ issues: [jiraIssue], isLast: true });
    if (path === "/internal") return json({ tickets: [] });
    if (path === "/date-requests") return json({ requests: [] });
    if (path === "/clients") return json({ revision: 1, entries: [] });
    if (path === "/clients/odoo-sync") return json({ odoo: true, changed: false, syncedAt: Date.parse("2026-11-03T08:00:00Z"), error: null });
    if (path === "/clients/odoo-projects/options") return json({ syncedAt: 1, projects: projects.map((p) => ({ id: p.odooId, name: p.name, clientName: "Acme", label: p.label, archived: false, missingClient: false, known: true })) });
    if (path === "/clients/needs-mapping") return json({ rows: [] });
    if (path === "/clients/odoo-projects") return json({ allocation: true, nearLimit: 0.8, unplacedPendingHours: 0, projects, billing: { scan: null } });
    if (path === "/clients/odoo-projects/tickets") return url.searchParams.get("id") === "10" ? json(data) : json({ code: "not_found", error: "That Odoo project was not found." }, 404);
    if (path === "/clients/odoo-projects/import/preview") return json({ scope: { label: "Chargeable hours from 2025-11-09 to 2026-11-09" }, counts: { ok: 1, unchanged: 0, error: 1, warning: 1 },
      impact: { beforeMinutes: 90, afterMinutes: 120, deltaMinutes: 30, tickets: 1, allocation: [] },
      rows: [{ sheet: "tickets", row: 2, id: "INT-7", title: "", customer: "Acme", status: "ok", errors: [], warnings: ["Already exported (1 charge, 1.5 h): the next billable export carries the difference as an adjustment."], changes: [{ field: "billing", label: "Billing override", from: "Inherit project", to: "Billable" }], impact: { beforeMinutes: 90, afterMinutes: 120, deltaMinutes: 30 } },
        { sheet: "tickets", row: 3, id: "HD-3", title: "", customer: "Acme", status: "error", errors: ["Helpdesk tickets have no agreed hours."], warnings: [], changes: [] }] });
    if (path === "/clients/odoo-projects/import") return json({ scope: {}, impact: {}, counts: { applied: 1, partial: 0, failed: 0, not_applied: 1, unchanged: 0 },
      rows: [{ sheet: "tickets", row: 2, id: "INT-7", customer: "Acme", result: "applied", applied: ["billing"], message: "Saved.", errors: [], warnings: [], changes: [{ field: "billing", label: "Billing override", from: "Inherit project", to: "Billable" }] },
        { sheet: "tickets", row: 3, id: "HD-3", customer: "Acme", result: "not_applied", message: "Helpdesk tickets have no agreed hours.", errors: ["Helpdesk tickets have no agreed hours."], warnings: [], changes: [] }] });
    if (path === "/billing/ticket" && method === "PUT") { const t = data.tickets.find((x) => x.key === body.key); t.override = body.billing === "inherit" ? null : body.billing; t.revision++; t.effective = { value: body.billing === "not_billable" ? "not_billable" : "billable", source: "ticket" }; t.chargeableMinutes = body.billing === "not_billable" ? 0 : t.actualMinutes; return json({ key: body.key }); }
    if (path === "/ticket-metadata/batch") return json({ records: {} });
    if (path === "/ticket-metadata" && method === "GET") return json({ metadata: { revision: 5, odooProjectId: 10, agreedHours: null, agreedDev: null }, history: [], closed: false, agreedDevelopers: [{ dev: "dana", name: "Dana Developer" }, { dev: "eli", name: "Eli Developer" }] });
    if (path === "/ticket-metadata" && method === "PUT") { const t = data.tickets.find((x) => x.key === body.key); t.agreedHours = body.fields.agreedHours; t.agreedDeveloper = "Eli Developer"; return json({ metadata: { revision: 6 } }); }
    if (path === "/billing/export/preview") return json({ rows: [{ chargeId: "e1", ticket: "AION-101", date: "2026-11-03", customer: "Acme", project: "Support pack", worker: "Dana", description: "@risky", actualMinutes: 90, chargeableMinutes: 90, billing: { value: "billable" }, exportState: "new" },
      { chargeId: "e2", ticket: "INT-99", date: "2026-11-04", customer: "Acme", project: "Support pack", worker: "Eli", description: "other", actualMinutes: 30, chargeableMinutes: 30, billing: { value: "billable" }, exportState: "new" }], tasks: [], totals: {}, exceptions: [], warnings: [] });
    return json({ code: "forbidden", error: "Unconfigured test request" }, 403);
  });
  await page.goto("http://127.0.0.1:4173/dashboard.html?page=clients");
  return { errors, sent, calls };
}
const rowOf = (page, name) => page.locator(".budget-table tbody tr.budget-main", { has: page.getByRole("button", { name, exact: true }) });
async function expand(page, name = "Support pack") { await rowOf(page, name).getByRole("button", { name: "More about " + name }).click(); return page.locator("#budget-detail-10 .ws"); }
const wsRows = (ws) => ws.locator("tbody tr.ws-row");

test("Project workspace: opening a row reads its tickets once; Jira, internal and Helpdesk each show with their billing and hours", async ({ page }) => {
  const seen = await open(page);
  await expect(rowOf(page, "Support pack").locator("td").nth(6)).toContainText("2of 3");
  expect(seen.calls["GET /clients/odoo-projects/tickets"]).toBeUndefined();
  const ws = await expand(page);
  await expect(wsRows(ws)).toHaveCount(3);
  await expect(ws.locator("thead th")).toHaveText(["", "Ticket", "Title", "Status", "People", "Billing", "Est.", "Agreed", "Actual", "Commercial", "Odoo sync"]);
  await expect(ws.locator("tr[data-key='AION-101'] .ws-source")).toHaveText("Jira");
  await expect(ws.locator("tr[data-key='INT-7'] .ws-source")).toHaveText("Internal");
  await expect(ws.locator("tr[data-key='HD-3'] .ws-source")).toHaveText("Helpdesk");
  await expect(ws.locator("tr[data-key='INT-7'] .ws-people")).toContainText("Developers: dana, eli");
  await expect(ws.locator("tr[data-key='INT-7'] .ws-people")).toContainText("Assignee: Manager Mo");
  await expect(ws.locator("tr[data-key='INT-7'] .ws-sync")).toHaveText("0.5 h not in Odoo yet");
  await expect(ws.getByLabel("Billing of HD-3")).toHaveValue("not_billable");
  await expect(ws.getByLabel("Billing of INT-7").locator("option:checked")).toHaveText("Inherits project: Billable");
  await expect(ws.locator("tr[data-key='AION-101'] .ws-sync")).toHaveText("—");
  // Actual work and commercial hours stay apart; the totals say what they cover.
  await expect(ws.locator(".ws-scope")).toHaveText("3 tickets · 2 open · Actual 4 h · Commercial 3 h · Agreed 0 h · Estimated 3 h");
  await expect(ws.locator(".ws-totals")).toContainText("Hours: since the allocation started (2026-10-01)");
  // The description is short until Show more.
  await expect(ws.locator(".ws-desc-text")).toContainText("…");
  await ws.getByRole("button", { name: "Show more" }).click();
  await expect(ws.locator(".ws-desc-text")).toHaveText(LONG.trim());
  // Search, a filter, and the selection with its hours.
  await ws.getByLabel("Search the tickets of Support pack").fill("printer");
  await expect(wsRows(ws)).toHaveCount(1);
  await ws.getByLabel("Search the tickets of Support pack").fill("");
  await ws.getByRole("button", { name: /^Filters/ }).click();
  await ws.getByLabel("Source", { exact: true }).selectOption("jira");
  await expect(wsRows(ws)).toHaveCount(1);
  await expect(ws.locator(".ws-scope")).toContainText("1 of 3 tickets");
  await ws.getByRole("button", { name: "Clear filters" }).click();
  await ws.getByLabel("Select INT-7").check();
  await expect(ws.locator(".ws-selected")).toContainText("1 selected · Actual 2 h · Commercial 1.5 h");
  // Closing and opening the row again uses what was read.
  await rowOf(page, "Support pack").getByRole("button", { name: "More about Support pack" }).click();
  await rowOf(page, "Support pack").getByRole("button", { name: "More about Support pack" }).click();
  await expect(wsRows(ws)).toHaveCount(3);
  expect(seen.calls["GET /clients/odoo-projects/tickets"]).toBe(1);
  expect(seen.errors).toEqual([]);
});

test("Project workspace: billing and agreed hours are edited in place; agreed hours need one of the ticket's developers", async ({ page }) => {
  const seen = await open(page);
  const ws = await expand(page);
  await ws.getByLabel("Billing of AION-101").selectOption("not_billable");
  await expect(ws.locator("tr[data-key='AION-101'] td").nth(9)).toHaveText("0 h");
  await expect.poll(() => seen.calls["GET /clients/odoo-projects"]).toBe(2); // the figures were read again after the save
  await page.waitForLoadState("networkidle");
  expect(seen.sent.find((s) => s.path === "/billing/ticket").body).toEqual({ key: "AION-101", revision: 3, billing: "not_billable" });
  await ws.locator("tr[data-key='INT-7']").getByRole("button", { name: /^Agreed hours of INT-7/ }).click();
  await ws.getByLabel("Agreed hours for INT-7").fill("2");
  await ws.locator("tr[data-key='INT-7']").getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".clients-page > .msg")).toHaveText("Choose who the agreed hours go to.");
  await ws.getByLabel("Agreed hours go to").selectOption("eli");
  await ws.locator("tr[data-key='INT-7']").getByRole("button", { name: "Save" }).click();
  await expect(ws.locator("tr[data-key='INT-7'] .ws-agreed")).toHaveText("2 h · Eli Developer");
  expect(seen.sent.find((s) => s.path === "/ticket-metadata").body).toEqual({ key: "INT-7", fields: { revision: 5, agreedHours: 2, agreedDev: "eli" } });
  // Helpdesk tickets have no agreed hours to edit.
  await expect(ws.locator("tr[data-key='HD-3'] .ws-agreed button")).toHaveCount(0);
  expect(seen.errors).toEqual([]);
});

test("Project workspace: a ticket key opens the drawer; closing it keeps the search, the open row and the page", async ({ page }) => {
  const seen = await open(page);
  const ws = await expand(page);
  await ws.getByLabel("Search the tickets of Support pack").fill("synthetic");
  await expect(wsRows(ws)).toHaveCount(1);
  await ws.getByRole("button", { name: "AION-101", exact: true }).click();
  await expect(page.locator("#drawer")).toBeVisible();
  await page.locator("#d-close").click();
  await expect(page.locator("#drawer")).toBeHidden();
  await expect(ws.getByLabel("Search the tickets of Support pack")).toHaveValue("synthetic");
  await expect(wsRows(ws)).toHaveCount(1);
  await expect(page.locator("#budget-detail-10")).toBeVisible();
  expect(seen.errors).toEqual([]);
});

test("Project workspace: Create ticket opens the new-ticket form with the project chosen", async ({ page }) => {
  const seen = await open(page);
  const ws = await expand(page);
  await ws.getByRole("button", { name: "+ Create ticket" }).click();
  await expect(page.locator("#pop")).toBeVisible();
  await expect(page.locator("#pop select.combo-native").first()).toHaveValue("10");
  expect(seen.errors).toEqual([]);
});

test("Project workspace: export as CSV keeps IDs and Hebrew and guards formulas; selected tickets narrow the work entries; Excel has a sheet each", async ({ page }) => {
  const seen = await open(page);
  const ws = await expand(page);
  await ws.getByRole("button", { name: "Export…" }).click();
  const dlg = page.locator("dialog.ws-dialog");
  await dlg.getByLabel("CSV, one file each").check();
  await dlg.getByLabel("A. Project settings & allocations").uncheck();
  let wait = page.waitForEvent("download");
  await dlg.getByRole("button", { name: "Download" }).click();
  const csv = await readFile(await (await wait).path(), "utf8");
  expect(csv.startsWith("﻿Ticket,Source,Odoo Project ID,Project,Customer,Title,Description")).toBe(true);
  expect(csv).toContain("INT-7,Internal,10,Support pack,Acme,שלום: internal work");
  expect(csv).toContain("\"'=cmd() in a description\"");
  await expect(dlg.locator(".msg")).toContainText("Tickets (3 rows)");
  await dlg.getByRole("button", { name: "Close" }).click();
  // Selected tickets: the work entries of only those.
  await ws.getByLabel("Select AION-101").check();
  await ws.getByRole("button", { name: "Export…" }).click();
  await dlg.getByLabel("Selected tickets (1)").check();
  await dlg.getByLabel("A. Project settings & allocations").uncheck();
  await dlg.getByLabel("B. Tickets & billing (hours in each project’s period)").uncheck();
  await dlg.getByLabel("C. Billing / work entries for a period").check();
  await dlg.getByLabel("CSV, one file each").check();
  wait = page.waitForEvent("download");
  await dlg.getByRole("button", { name: "Download" }).click();
  const entries = await readFile(await (await wait).path(), "utf8");
  expect(entries).toContain("AION-101");
  expect(entries).not.toContain("INT-99");
  expect(entries).toContain("\"'@risky\"");
  await dlg.getByLabel("A. Project settings & allocations").check();
  await dlg.getByLabel("Excel (.xlsx), one sheet each").check();
  wait = page.waitForEvent("download");
  await dlg.getByRole("button", { name: "Download" }).click();
  const xlsx = await wait;
  expect(xlsx.suggestedFilename()).toMatch(/^Support-pack-\d{4}-\d{2}-\d{2}\.xlsx$/);
  expect((await readFile(await xlsx.path())).subarray(0, 2).toString()).toBe("PK");
  await expect(dlg.locator(".msg")).toContainText("Projects (1 rows), Work entries (1 rows)");
  expect(seen.errors).toEqual([]);
});

test("Project workspace: import shows each row before saving, applies only ready rows and reports the rest", async ({ page }) => {
  const seen = await open(page);
  page.on("dialog", (d) => d.accept());
  const ws = await expand(page);
  await ws.getByRole("button", { name: "Import…" }).click();
  const dlg = page.locator("dialog.ws-dialog");
  await dlg.getByLabel("File to import").setInputFiles({ name: "tickets.csv", mimeType: "text/csv", buffer: Buffer.from("﻿Ticket,Billing Override,Agreed Hours\r\nINT-7,Billable,\r\nHD-3,,5\r\n") });
  await expect(dlg.locator(".ws-import-table tbody tr")).toHaveCount(2);
  expect(seen.sent.find((s) => s.path === "/clients/odoo-projects/import/preview").body).toEqual({ projects: [], tickets: [{ row: 2, key: "INT-7", billing: "Billable", agreedHours: "" }, { row: 3, key: "HD-3", billing: "", agreedHours: "5" }] });
  await expect(dlg).toContainText("1 ready · 0 unchanged · 1 with errors · 1 with warnings");
  await expect(dlg).toContainText("Billing override: Inherit project → Billable");
  await expect(dlg).toContainText("Helpdesk tickets have no agreed hours.");
  await expect(dlg).toContainText("Already exported");
  await dlg.getByRole("button", { name: "Apply 1 ready row" }).click();
  await expect(dlg.locator(".msg").last()).toHaveText("1 applied, 1 not applied.");
  await expect(dlg.getByRole("button", { name: "Check the 1 rows again" })).toBeVisible();
  const wait = page.waitForEvent("download");
  await dlg.getByRole("button", { name: "Download report" }).click();
  const report = await readFile(await (await wait).path(), "utf8");
  expect(report).toContain("Tickets,3,HD-3,,Not applied");
  expect(seen.calls["POST /clients/odoo-projects/import"]).toBe(1);
  expect(seen.errors).toEqual([]);
});
