import { test, expect } from "@playwright/test";

// Clients & Projects: the Odoo projects table against a synthetic proxy. Every request is intercepted; nothing here is real data.
const CATALOG = { revision: 3, entries: [
  { id: "c1", name: "Acme", parentId: null, sources: [{ source: "odoo-customer", row: 1 }] },
  { id: "p1", name: "Branch A", parentId: "c1", sources: [{ source: "odoo", row: 10 }] },
  { id: "p2", name: "Branch B", parentId: "c1", sources: [] },
] };
const row = (o) => ({ client: "", company: "All in One", url: "https://odoo.example.invalid/web#id=" + o.odooId, linkable: true, pendingHours: 0, mapped: false,
  links: { projects: [], epics: [], helpdesk: false, tickets: { count: 0, byProject: {}, keys: [] } }, overHours: 0, ...o });
const PROJECTS = [
  row({ odooId: 10, name: "Branch A", client: "Acme", mapped: true, allocatedHours: 10, loggedHours: 12.5, remainingHours: -2.5, overHours: 2.5, status: "over", pendingHours: 0.5,
    links: { projects: [{ id: "p1", name: "Acme / Branch A" }], epics: ["AION-100"], helpdesk: false, tickets: { count: 3, byProject: { AION: 2, INT: 1 }, keys: ["AION-1", "AION-2", "INT-3"] } } }),
  row({ odooId: 11, name: "Odoo only", allocatedHours: null, loggedHours: 0, remainingHours: null, status: "not_set" }),
  row({ odooId: 12, name: "Holding job", client: "Holding", company: "Holding", linkable: false, allocatedHours: 5, loggedHours: 4.5, remainingHours: 0.5, status: "near" }),
];

async function open(page) {
  const errors = [], sent = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "boss@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" }));
  });
  const catalog = structuredClone(CATALOG), projects = structuredClone(PROJECTS);
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
    if (url.pathname === "/clients/odoo-sync") return json({ odoo: true, changed: false, added: 0, projects: 3 });
    if (url.pathname === "/clients/odoo-projects") return json({ allocation: true, nearLimit: 0.8, unplacedPendingHours: 0, projects });
    if (url.pathname === "/clients/odoo-projects/allocation") {
      const b = JSON.parse(req.postData()); sent.push(b);
      Object.assign(projects.find((p) => p.odooId === b.odooId), { allocatedHours: b.hours, remainingHours: b.hours, status: "on_track" });
      return json({ odooId: b.odooId, allocatedHours: b.hours });
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
const table = (page) => page.locator(".budget-table");
const rowOf = (page, name) => table(page).locator("tbody tr", { has: page.getByRole("link", { name, exact: true }) });

test("Clients & Projects lists every Odoo project with its links, hours and budget status", async ({ page }) => {
  const seen = await open(page);
  await expect(table(page)).toBeVisible();
  await expect(table(page).locator("thead th")).toHaveText(["Odoo Project", "Linked Jira Project / Tickets", "Allocated Hours", "Logged Hours", "Remaining Hours", "Budget Status"].map((t) => new RegExp("^" + t)));
  // Sorted by status: over budget first, then near the limit, then allocation not set.
  await expect(table(page).locator("tbody tr td:first-child a")).toHaveText(["Branch A", "Holding job", "Odoo only"]);
  const over = rowOf(page, "Branch A");
  await expect(over).toContainText("Acme / Branch A");
  await expect(over).toContainText("Epic AION-100");
  await expect(over).toContainText("AION: 2 · INT: 1 tickets");
  await expect(over).toContainText("+0.5 h not in Odoo yet");
  await expect(over.locator(".budget-status")).toHaveText("Over by 2.5 h");
  await expect(over.locator("td").nth(4)).toHaveText("−2.5 h");
  const unset = rowOf(page, "Odoo only");
  await expect(unset).toContainText("Not mapped");
  await expect(unset.locator("td").nth(2)).toContainText("Allocation not set");
  await expect(unset.locator(".budget-status")).toHaveText("Allocation not set");
  await expect(rowOf(page, "Holding job")).toContainText("Other Odoo company");
  await expect(table(page).locator("tfoot")).toContainText("Total");
  await expect(table(page).locator("tfoot")).toContainText("17 h");
  // Filters narrow the rows.
  await page.getByLabel("Filter by budget status").selectOption("unmapped");
  await expect(table(page).locator("tbody tr td:first-child a")).toHaveText(["Holding job", "Odoo only"]);
  await page.getByLabel("Filter by budget status").selectOption("");
  await page.getByLabel("Search Odoo projects").fill("INT-3");
  await expect(table(page).locator("tbody tr td:first-child a")).toHaveText(["Branch A"]);
  await page.getByLabel("Search Odoo projects").fill("");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^odoo-projects-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await (await import("node:fs/promises")).readFile(await download.path(), "utf8");
  expect(csv).toContain("Odoo only,,All in One,Not mapped,Allocation not set,0,,Allocation not set");
  expect(seen.errors).toEqual([]);
});

test("Clients & Projects: an administrator sets allocated hours and links a project", async ({ page }) => {
  const seen = await open(page);
  await page.getByRole("button", { name: "Set allocated hours for Odoo only" }).click();
  await page.getByLabel("Allocated hours for Odoo only").fill("40");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(rowOf(page, "Odoo only").locator(".budget-status")).toHaveText("On track");
  await expect(rowOf(page, "Odoo only").locator("td").nth(2)).toContainText("40 h");
  expect(seen.sent[0]).toEqual({ odooId: 11, hours: 40 });
  await rowOf(page, "Odoo only").getByRole("button", { name: "Link project" }).click();
  const combo = rowOf(page, "Odoo only").getByRole("combobox");
  await combo.fill("Branch B");
  await page.getByRole("option", { name: "Acme / Branch B" }).click();
  await rowOf(page, "Odoo only").getByRole("button", { name: "Link", exact: true }).click();
  await expect(rowOf(page, "Odoo only")).toContainText("Acme / Branch B");
  expect(seen.sent[1]).toEqual({ revision: 3, odooId: 11, entryId: "p2", unlink: false });
  expect(seen.errors).toEqual([]);
});
