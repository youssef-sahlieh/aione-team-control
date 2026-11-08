import { test, expect } from "@playwright/test";

// Sidebar count matches the "All open" tile, the assignee selector saves to Jira, and Work log is the last section of ticket details.
async function mockDashboard(page) {
  const writes = [];
  await page.addInitScript(() => { localStorage.setItem("aione-session", JSON.stringify({ token: "t", email: "admin@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" })); });
  const issue = (key, accountId, name, cat) => ({ key, fields: { summary: "Ticket " + key, status: { name: cat === "done" ? "Done" : "To Do", statusCategory: { key: cat } }, labels: ["ai1_builder"], assignee: accountId ? { accountId, displayName: name } : null, updated: "2026-10-14T10:00:00.000+0000", created: "2026-10-01T10:00:00.000+0000" } });
  let assignee = { accountId: "acc-b", displayName: "Builder" };
  await page.route("**/*", (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname;
    if (path === "/config") return route.fulfill({ json: { site: "https://jira.example.invalid", project: "AION", people: { builder: { id: "acc-b", name: "Builder" }, reviewer: { id: "acc-r", name: "Reviewer" } }, devs: ["builder"], role: "admin", dev: "builder", email: "admin@example.invalid", accounts: true, odoo: false, mail: false, ai: { enabled: false } } });
    if (path === "/jira/search") return route.fulfill({ json: { issues: [
      { ...issue("AION-1", "acc-b", "Builder", "new") },
      { ...issue("AION-2", null, "", "indeterminate") },
      { ...issue("AION-3", "acc-r", "Reviewer", "done") },
    ], isLast: true } });
    if (path.startsWith("/jira/issue/") && req.method() === "PUT") {
      writes.push({ path, body: req.postDataJSON() });
      const accountId = req.postDataJSON()?.fields?.assignee?.accountId ?? null;
      assignee = accountId ? { accountId, displayName: accountId === "acc-r" ? "Reviewer" : "Builder" } : null;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/jira/issue/AION-1") return route.fulfill({ json: { ...issue("AION-1", assignee?.accountId, assignee?.displayName, "new"), comments: [], attachments: [] } });
    if (path === "/time-entries" && req.method() === "GET") return route.fulfill({ json: { ticket: "AION-1", source: "jira", closed: false, logging: true, canLog: true, today: "2026-10-15", maxMinutes: 1440, lockDate: null, entries: [], summary: { loggedMinutes: 0, pendingMinutes: 0 } } });
    if (path === "/internal") return route.fulfill({ json: { tickets: [] } });
    if (path === "/date-requests") return route.fulfill({ json: { requests: [] } });
    if (path === "/inbox") return route.fulfill({ json: { items: [], seenAt: null, readTickets: [] } });
    return route.fulfill({ json: {} });
  });
  return writes;
}

test("the sidebar count matches the All open tile", async ({ page }) => {
  await mockDashboard(page);
  await page.goto("/dashboard.html#tickets");
  await expect(page.locator("#view")).toContainText("Ticket AION-1");
  const tile = await page.locator(".tile.k1 .n").textContent();
  await expect(page.locator("#nav-ticket-count")).toHaveText(tile.trim());
  await expect(page.locator("#page-heading")).toHaveText("All open");
});

test("changing the assignee in ticket details saves it to Jira", async ({ page }) => {
  const writes = await mockDashboard(page);
  await page.goto("/dashboard.html#tickets");
  await page.getByRole("button", { name: "Ticket AION-1", exact: true }).first().click();
  const pick = page.locator("#d-asg-pick");
  await expect(pick).toHaveValue("acc-b");
  await pick.selectOption("acc-r");
  await expect(page.locator("#d-asgmsg")).toHaveText("Saved.");
  await expect(page.locator("#d-asgname")).toContainText("Reviewer");
  expect(writes.length).toBe(1);
  expect(writes[0].body.fields.assignee.accountId).toBe("acc-r");
});

for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`Work log is the last section of ticket details on ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockDashboard(page);
    await page.goto("/dashboard.html#tickets");
    await page.getByRole("button", { name: "Ticket AION-1", exact: true }).first().click();
    const top = (sel) => page.locator(sel).first().evaluate(n => n.getBoundingClientRect().top);
    const workLog = await top("#drawer .work-log, #drawer #work-log");
    const activity = await top("#drawer .jira-activity");
    const details = await top("#drawer .jira-details");
    expect(workLog).toBeGreaterThan(activity);
    expect(workLog).toBeGreaterThan(details);
    await expect(page.locator("#drawer .jira-activity")).toBeVisible();
    await expect(page.getByRole("button", { name: /Log work/ }).first()).toBeVisible();
  });
}
