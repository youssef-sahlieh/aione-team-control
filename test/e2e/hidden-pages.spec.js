import { test, expect } from "@playwright/test";

// Paused pages (HIDDEN_PAGES in public/assets/app/router.js): no sidebar link, direct links open Clients & Projects, and
// nothing that belongs to them is requested. Every request is intercepted; nothing here is real data.
const PROJECT = { odooId: 10, name: "Branch A", label: "Acme → Branch A", client: "Acme", company: "All in One", url: "https://odoo.example.invalid/web#id=10", linkable: true, pendingHours: 0, mapped: false, assignable: true, blocked: null, missingClient: false, archived: false, linkableCount: 0, ticketCount: 0, openTickets: 0, reviewTickets: 0, reviewKeys: [], lastWorkDate: null, usedPercent: null, overHours: 0, allocatedHours: 10, loggedHours: 2, remainingHours: 8, status: "on_track", createdAt: "2026-03-01T09:00:00.000Z", links: { projects: [], epics: [], helpdesk: false, tickets: { count: 0, byProject: {}, keys: [] } } };
const CATALOG = { revision: 1, entries: [{ id: "c1", name: "Acme", parentId: null, sources: [{ source: "odoo-customer", row: 1 }] }] };

async function open(page, { role = "admin", path = "/dashboard.html" } = {}) {
  const errors = [], calls = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((role) => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "boss@example.invalid", expiresAt: Date.now() + 3600000, role }));
  }, role);
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    calls.push(req.method() + " " + url.pathname);
    const json = (v, status = 200) => route.fulfill({ status, json: v });
    if (url.pathname === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people: {}, devs: [], role: role === "user" ? "user" : "admin", email: "boss@example.invalid", accounts: true, odoo: true, mail: false, ai: { enabled: false }, capabilities: ["ticket-business-v1", "project-budget-v1"] });
    if (url.pathname === "/jira/search") return json({ issues: [] });
    if (url.pathname === "/internal") return json({ tickets: [] });
    if (url.pathname === "/date-requests") return json({ requests: [] });
    if (url.pathname === "/clients") return json(CATALOG);
    if (url.pathname === "/clients/odoo-sync") return json({ odoo: true, syncedAt: Date.parse("2026-06-03T08:00:00Z"), projectsSyncedAt: Date.parse("2026-06-03T08:00:00Z"), error: null });
    if (url.pathname === "/clients/odoo-projects") return json({ allocation: true, nearLimit: 0.8, unplacedPendingHours: 0, projects: [PROJECT] });
    if (url.pathname === "/clients/needs-mapping") return json({ scanned: 0, mapped: 0, ready: 0, missing: 0, ambiguous: 0, conflict: 0, projectsSyncedAt: 1, rows: [] });
    if (url.pathname === "/clients/odoo-projects/options") return json({ syncedAt: 1, projects: [] });
    return json({ code: "forbidden", error: "Unconfigured test request" }, 403);
  });
  await page.goto("http://127.0.0.1:4173" + path);
  return { errors, calls };
}

const HIDDEN = ["workload", "reports", "analytics"];

test("administrators see no link, badge or shortcut to a paused page", async ({ page }) => {
  await open(page);
  const nav = page.locator("#main-nav");
  for (const id of HIDDEN) await expect(nav.locator(`[data-page="${id}"]`)).toHaveCount(0);
  await expect(nav.getByText("Checks & Reports", { exact: true })).toHaveCount(0);
  await expect(nav.getByText("Workload", { exact: true })).toHaveCount(0);
  await expect(nav.getByText("Analytics", { exact: true })).toHaveCount(0);
  // The other admin pages keep their place, and the ADMIN label sits above Clients.
  await expect(nav.locator('[data-page="clients"]')).toBeVisible();
  const order = await nav.evaluate((n) => [...n.children].filter((c) => c.offsetParent !== null).map((c) => c.id || c.dataset.page || c.textContent.trim()));
  expect(order.indexOf("nav-admin-label")).toBe(order.indexOf("clients") - 1);
});

test("a direct link to a paused page opens Clients & Projects and rewrites the address", async ({ page }) => {
  for (const id of HIDDEN) {
    const { errors, calls } = await open(page, { path: `/dashboard.html?page=${id}#AION-101` });
    await expect(page).toHaveURL(/page=clients/);
    await expect(page).toHaveURL(/#AION-101$/);
    await expect(page.locator("#page-heading")).toHaveText("Clients");
    expect(errors).toEqual([]);
    expect(calls.filter((c) => /\/(reports|analytics)\//.test(c) || c === "GET /analytics/snapshot")).toEqual([]);
  }
});

test("paused pages never mount or request their data", async ({ page }) => {
  const { calls } = await open(page, { path: "/dashboard.html?page=analytics" });
  await expect(page.locator("#page-heading")).toHaveText("Clients");
  const requested = (await page.evaluate(() => performance.getEntriesByType("resource").map((r) => r.name))).join("\n");
  // report-browser.js is a static import of the ticket view and only sets flags; the Analytics chart module is lazy.
  expect(requested).not.toMatch(/components\/analytics\.js/);
  expect(calls.filter((c) => /\/(reports|analytics)\b/.test(c))).toEqual([]);
});

test("a developer following a paused page's link lands on All tickets", async ({ page }) => {
  await open(page, { role: "user", path: "/dashboard.html?page=reports" });
  await expect(page).toHaveURL(/page=tickets/);
  await expect(page.locator('#main-nav [data-page="reports"]')).toHaveCount(0);
});

test("Clients & Projects still works, from the sidebar and from the redirect", async ({ page }) => {
  await open(page, { path: "/dashboard.html?page=workload" });
  await page.getByRole("button", { name: "Projects", exact: true }).click();   // the redirect lands on Clients, where Work entries is the default view
  await expect(page.locator(".budget-table").first().getByText("Branch A", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: /^Clients$/ }).first().click();
  await expect(page).toHaveURL(/page=clients/);
  await page.getByRole("button", { name: "Projects", exact: true }).click();   // Work entries is the default view
  await expect(page.locator(".budget-table").first().getByText("Branch A", { exact: true })).toBeVisible();
});
