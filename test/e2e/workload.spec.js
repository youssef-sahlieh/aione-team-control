import { test, expect } from "@playwright/test";

// Workload against a synthetic proxy: team figures count a shared ticket once, a developer row counts it for each developer,
// every count opens the ticket list showing exactly those tickets, and nothing reads the tickets on a timer.
const ago = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const issue = (key, devs, cat, due) => ({ key, fields: { summary: "Ticket " + key, status: { name: cat === "done" ? "Done" : cat === "indeterminate" ? "In Development" : "To Do", statusCategory: { key: cat } }, labels: devs.map((d) => "ai1_" + d), assignee: { accountId: "acc-d", displayName: "Dana" }, duedate: due, updated: "2026-10-14T10:00:00.000+0000", created: "2026-10-01T10:00:00.000+0000" } });
const ISSUES = [
  issue("AION-1", ["dana", "lee"], "new", ago(3)), // shared and overdue
  issue("AION-2", ["dana"], "indeterminate", null),
  issue("AION-3", ["lee"], "new", ago(-10)),
  issue("AION-4", [], "new", null),
  issue("AION-5", ["dana"], "done", ago(5)),
];

async function open(page) {
  const searches = [];
  await page.addInitScript(() => { localStorage.setItem("aione-session", JSON.stringify({ token: "t", email: "admin@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" })); });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const json = (v) => route.fulfill({ json: v });
    if (url.pathname === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people: { dana: { id: "acc-d", name: "Dana" }, lee: { id: "acc-l", name: "Lee" } }, devs: ["dana", "lee"], role: "admin", email: "admin@example.invalid", accounts: true, odoo: false, mail: false, ai: { enabled: false } });
    if (url.pathname === "/jira/search") { searches.push(Date.now()); return json({ issues: ISSUES, isLast: true }); }
    if (url.pathname === "/internal") return json({ tickets: [] });
    if (url.pathname === "/date-requests") return json({ requests: [] });
    if (url.pathname === "/inbox") return json({ items: [], seenAt: null, readTickets: [] });
    return json({});
  });
  await page.goto("/dashboard.html?page=workload");
  return searches;
}
const card = (page, focus) => page.locator(`.workload-summary .summary-card[data-focus="${focus}"] strong`);
const shows = async (page, keys) => {
  for (const n of [1, 2, 3, 4, 5]) {
    const key = "Ticket AION-" + n;
    if (keys.includes(n)) await expect(page.locator("#view")).toContainText(key);
    else await expect(page.locator("#view")).not.toContainText(key);
  }
};

test("Workload: team figures count a shared ticket once, developer rows count it for each developer", async ({ page }) => {
  await open(page);
  await expect(card(page, "open")).toHaveText("4");
  await expect(card(page, "overdue")).toHaveText("1");
  await expect(card(page, "nodue")).toHaveText("2");
  await expect(card(page, "nodev")).toHaveText("1");
  const row = (name) => page.locator(".workload-table tbody tr", { hasText: name });
  const cell = (name, label) => row(name).locator(`td[data-label="${label}"]`);
  await expect(cell("dana", "Open")).toHaveText("2");
  await expect(cell("dana", "Overdue")).toHaveText("1");
  await expect(cell("dana", "Shared")).toHaveText("1");
  await expect(cell("lee", "Open")).toHaveText("2");
  await expect(cell("lee", "Shared")).toHaveText("1");
  await expect(page.locator(".workload-table thead")).not.toContainText("Done");
});

test("Workload: every count opens the ticket list with exactly the tickets it counted", async ({ page }) => {
  await open(page);
  await page.locator(".workload-summary .summary-card[data-focus=overdue]").click();
  await shows(page, [1]);
  await page.goto("/dashboard.html?page=workload");
  await page.getByRole("button", { name: "dana: 2 open" }).click();
  await shows(page, [1, 2]);
  await page.goto("/dashboard.html?page=workload");
  await page.getByRole("button", { name: "lee: 1 overdue" }).click();
  await shows(page, [1]);
});

test("Workload: nothing reads the tickets again on a timer", async ({ page }) => {
  await page.clock.install();
  const searches = await open(page);
  await expect(card(page, "open")).toHaveText("4");
  const before = searches.length;
  await page.clock.runFor(5 * 60 * 1000);
  expect(searches.length).toBe(before);
});
