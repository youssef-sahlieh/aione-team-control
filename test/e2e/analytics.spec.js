import { test, expect } from "@playwright/test";
// Paused: Checks & Reports, Workload and Analytics are hidden (HIDDEN_PAGES in public/assets/app/router.js). Remove this skip when a page is restored.
test.skip(true, "page hidden by HIDDEN_PAGES");

// Analytics page against a synthetic proxy. Every request is intercepted; nothing here is real data.
const jerusalem = (offset = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offset * 86400000));
const TODAY = jerusalem(), ago = (n) => jerusalem(-n);
const ticket = (over) => ({ key: "AION-1", source: "jira", title: "Synthetic", status: "Open", cat: "indeterminate", createdDay: ago(3), completedDay: null, dueDay: null, clientId: "c1", clientName: "Acme", subClientId: null, subClientName: null, devs: ["dana"], estimatedHours: null, agreedHours: null, loggedMinutes: 0, ...over });
const SNAPSHOT = {
  builtAt: new Date().toISOString(), timeZone: "Asia/Jerusalem", window: { from: ago(700), to: TODAY },
  complete: { jira: true, internal: true, time: true }, warnings: ["Synthetic warning for the test."], people: ["Dana"],
  tickets: [ticket({}), ticket({ key: "AION-2", title: "Late one", createdDay: ago(40), dueDay: ago(5), clientId: "c2", clientName: "Beta" }), ticket({ key: "AION-3", cat: "done", createdDay: ago(10), completedDay: ago(2), dueDay: ago(1) })],
  entries: [["AION-1", ago(2), 0, 120, 0, 1], ["AION-2", ago(1), 0, 60, 1, 0]],
};

const field = (page, label) => page.locator(".an-field", { hasText: label }).locator("select");

async function open(page, snapshot = SNAPSHOT, role = "admin", search = "", { refreshFails = false } = {}) {
  const errors = [], violations = [], requested = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  await page.addInitScript((r) => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "boss@example.invalid", expiresAt: Date.now() + 3600000, role: r }));
  }, role);
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    requested.push(url.pathname);
    const json = (v, status = 200) => route.fulfill({ status, json: v });
    if (url.pathname === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people: {}, devs: [], role, email: "boss@example.invalid", accounts: true, odoo: false, mail: false, ai: { enabled: false }, capabilities: ["analytics-v1"] });
    if (url.pathname === "/jira/search") return json({ issues: [] });
    if (url.pathname === "/internal") return json({ tickets: [] });
    if (url.pathname === "/date-requests") return json({ requests: [] });
    if (url.pathname === "/analytics/snapshot") return json({ snapshot, cached: true, stale: false });
    if (url.pathname === "/analytics/refresh") return refreshFails ? json({ code: "down", error: "Jira is not answering." }, 502) : json({ snapshot, cached: false, stale: false });
    return json({ code: "forbidden", error: "Unconfigured test request" }, 403);
  });
  await page.goto("http://127.0.0.1:4173/dashboard.html?page=analytics" + search);
  return { errors, violations, requested };
}

test("Analytics: KPIs, charts, filters in the address, table view and no CSP violations", async ({ page }) => {
  const seen = await open(page);
  await expect(page.getByRole("link", { name: "Analytics" })).toBeVisible();
  const tiles = page.locator(".an-tile");
  await expect(tiles).toHaveCount(5);
  await expect(tiles.nth(0)).toContainText("Created");
  await expect(tiles.nth(0).locator(".an-n")).toHaveText("2"); // AION-1 and AION-3 are inside the last 30 days; AION-2 is 40 days old
  await expect(tiles.nth(1).locator(".an-n")).toHaveText("1");
  await expect(tiles.nth(2)).toContainText("Net backlog change");
  await expect(tiles.nth(2).locator(".an-n")).toHaveText("+1"); // 2 created − 1 completed
  await expect(page.locator(".an-tile", { hasText: "Overdue" })).toHaveCount(0); // current state is Workload's
  await expect(tiles.nth(4)).toContainText("Work-log hours");
  await expect(tiles.nth(4).locator(".an-n")).toHaveText("3 h");
  await expect(tiles.nth(4)).toContainText("2 h confirmed in Odoo · 1 h pending sync");
  await expect(page.locator(".an-page .state").first()).toContainText("Synthetic warning");
  // The vendored Chart.js drew its canvases from our own origin.
  await expect(page.locator(".an-chart canvas")).toHaveCount(4);
  expect(await page.evaluate(() => typeof window.Chart)).toBe("function");
  await expect(page.locator(".an-card", { hasText: "Hours by person" })).toBeVisible();
  await expect(page.locator(".an-card", { hasText: "Open work by age" })).toHaveCount(0);

  // A filter changes the numbers instantly (no new request) and is kept in the address.
  const before = seen.requested.filter((p) => p === "/analytics/snapshot").length;
  await field(page, "Client").selectOption("c2");
  await expect(tiles.nth(0).locator(".an-n")).toHaveText("0");
  await expect(page).toHaveURL(/client=c2/);
  expect(seen.requested.filter((p) => p === "/analytics/snapshot").length).toBe(before);

  // Every chart has the same numbers as a table.
  await field(page, "Client").selectOption("");
  await page.getByRole("button", { name: "Show as table" }).first().click();
  await expect(page.locator(".an-card .an-table:visible").first()).toContainText("Week starting");

  expect(seen.errors).toEqual([]);
  expect(seen.violations).toEqual([]);
});

test("Analytics: opens with the filters from the address, and leaving the page drops them", async ({ page }) => {
  await open(page, SNAPSHOT, "admin", `&from=${ago(60)}&to=${TODAY}&source=internal`);
  await expect(field(page, "Source")).toHaveValue("internal");
  await expect(page.locator(".an-tile").nth(0).locator(".an-n")).toHaveText("0");
  await page.locator('a[data-page="tickets"]').click();
  await expect(page).toHaveURL(/page=tickets/);
  expect(page.url()).not.toMatch(/source=|from=/);
});

test("Analytics: an unreadable work log shows hours as unknown, not zero", async ({ page }) => {
  await open(page, { ...SNAPSHOT, entries: null, complete: { jira: true, internal: true, time: false }, warnings: ["The work log could not be read, so logged hours are unknown."] });
  await expect(page.locator(".an-tile").nth(4).locator(".an-n")).toHaveText("—");
  await expect(page.locator(".an-card", { hasText: "Hours by client" })).toContainText("could not be read");
});

test("Analytics: a developer account cannot reach the page", async ({ page }) => {
  const seen = await open(page, SNAPSHOT, "user");
  await expect(page.locator(".an-page")).toHaveCount(0);
  await expect(page.locator('a[data-page="analytics"]')).toBeHidden();
  expect(seen.requested).not.toContain("/analytics/snapshot");
});

test("Analytics: a snapshot built before the Odoo state was recorded shows it as unknown, not zero", async ({ page }) => {
  await open(page, { ...SNAPSHOT, entries: SNAPSHOT.entries.map((e) => e.slice(0, 5)) });
  await expect(page.locator(".an-tile").nth(4).locator(".an-n")).toHaveText("3 h");
  await expect(page.locator(".an-tile").nth(4)).toContainText("Odoo confirmation unknown");
});

test("Analytics: no timer refreshes the page, and a failed Refresh data keeps the numbers and the filters", async ({ page }) => {
  await page.clock.install();
  const seen = await open(page, SNAPSHOT, "admin", "", { refreshFails: true });
  const tiles = page.locator(".an-tile");
  await field(page, "Developer").selectOption("dana");
  await expect(tiles.nth(0).locator(".an-n")).toHaveText("2");
  const reads = () => seen.requested.filter((p) => p.startsWith("/analytics") || p === "/jira/search").length, before = reads();
  await page.clock.runFor(5 * 60 * 1000); // past the dashboard's 2-minute ticket refresh, twice
  expect(reads()).toBe(before);
  await page.getByRole("button", { name: "Refresh data" }).click();
  await expect(page.locator(".an-page .state").first()).toContainText("Jira is not answering.");
  await expect(tiles.nth(0).locator(".an-n")).toHaveText("2");
  await expect(field(page, "Developer")).toHaveValue("dana");
});
