import { test, expect } from "@playwright/test";

// Checks & Reports exceptions, export across pages and refresh failure, against a synthetic proxy. Nothing here is real data.
const ticket = (i, extra = {}) => ({ key: "AION-" + i, source: "jira", title: "Ticket " + i, status: "Open", clientId: "c1", clientName: "Acme", subClientId: null, subClientName: null, billing: "billable", devs: ["dana"], employees: [], estimatedHours: null, agreedHours: 4, loggedHours: 2, actualHours: 2, overage: "ok", created: "2026-10-01", ...extra });
// 60 tickets: 55 with agreed hours, 3 with none (one of them without a client), 2 over.
const TICKETS = Array.from({ length: 60 }, (_, i) => i < 3 ? ticket(i + 1, { agreedHours: null, overage: null, ...(i === 0 ? { clientId: null, clientName: null } : {}) })
  : i < 5 ? ticket(i + 1, { agreedHours: 1, loggedHours: 3, overHours: 2, overage: "overage" }) : ticket(i + 1));
const REPORT = { workflow: "all", generatedAt: new Date().toISOString(), coverage: { examined: 60 }, warnings: [], tickets: TICKETS };

async function open(page, { refreshFails = false } = {}) {
  const errors = [], requested = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "boss@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" }));
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    requested.push(url.pathname);
    const json = (v, status = 200) => route.fulfill({ status, json: v });
    if (url.pathname === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people: {}, devs: [], role: "admin", email: "boss@example.invalid", accounts: true, odoo: false, mail: false, ai: { enabled: false }, capabilities: ["reports-saved-v1", "agreed-hours-v1"] });
    if (url.pathname === "/jira/search") return json({ issues: [] });
    if (url.pathname === "/internal") return json({ tickets: [] });
    if (url.pathname === "/date-requests") return json({ requests: [] });
    if (url.pathname === "/reports/latest") return json({ report: REPORT, stale: false });
    if (url.pathname === "/reports/refresh") return refreshFails ? json({ code: "down", error: "Jira is not answering." }, 502) : json({ report: REPORT, stale: false });
    if (url.pathname === "/time-entries/report") return json({ rows: [], statuses: {} });
    return json({ code: "forbidden", error: "Unconfigured test request" }, 403);
  });
  await page.goto("http://127.0.0.1:4173/dashboard.html?page=reports");
  await expect(page.getByText("Tickets: 60")).toBeVisible();
  return { errors, requested };
}
const exception = (page, key) => page.locator(`.report-exception[data-exception="${key}"]`);
const rows = (page) => page.locator(".report-ticket-table tbody tr");

test("Checks & Reports: each exception count is the number of rows it shows, and filtering asks the server nothing", async ({ page }) => {
  const seen = await open(page), before = seen.requested.length;
  for (const [key, n] of [["flag:none", 3], ["flag:overage", 2], ["clientId:__none", 1]]) {
    await expect(exception(page, key).locator("strong")).toHaveText(String(n));
    await exception(page, key).click();
    await expect(exception(page, key)).toHaveAttribute("aria-pressed", "true");
    await expect(rows(page)).toHaveCount(n);
    await expect(page.getByText("Tickets: " + n, { exact: true })).toBeVisible();
    await exception(page, key).click(); // again clears it
    await expect(rows(page)).toHaveCount(50); // first page of 60
  }
  expect(seen.requested.slice(before).filter((p) => p.startsWith("/reports"))).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("Checks & Reports: CSV export has every filtered ticket, not just the page on screen", async ({ page }) => {
  await open(page);
  await expect(rows(page)).toHaveCount(50);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  const text = await (await import("node:fs/promises")).readFile(await download.path(), "utf8");
  const keys = new Set(text.match(/AION-\d+/g));
  expect(keys.size).toBe(60);
});

test("Checks & Reports: a failed Refresh report keeps the rows and the filters", async ({ page }) => {
  await open(page, { refreshFails: true });
  await exception(page, "flag:none").click();
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole("button", { name: "Refresh report" }).click();
  await expect(page.getByText("Jira is not answering.")).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  await expect(exception(page, "flag:none")).toHaveAttribute("aria-pressed", "true");
});
