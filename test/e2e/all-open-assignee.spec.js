import { test, expect } from "@playwright/test";

// Ticket details: an administrator, or a developer on the ticket, picks the Assignee from a searchable list (Unassigned included for
// Jira tickets). A refused save puts the previous owner back. Anyone else sees the owner as text, with no picker. The sidebar count matches "All open".
async function mockDashboard(page, { role = "admin", dev = "builder" } = {}) {
  const writes = [];
  writes.fail = false;
  const email = role === "admin" ? "admin@example.invalid" : "user@example.invalid";
  await page.addInitScript(({ role, email }) => { localStorage.setItem("aione-session", JSON.stringify({ token: "t", email, expiresAt: Date.now() + 3600000, role })); }, { role, email });
  const issue = (key, accountId, name, cat) => ({ key, fields: { summary: "Ticket " + key, status: { name: cat === "done" ? "Done" : "To Do", statusCategory: { key: cat } }, labels: ["ai1_builder"], assignee: accountId ? { accountId, displayName: name } : null, updated: "2026-10-14T10:00:00.000+0000", created: "2026-10-01T10:00:00.000+0000" } });
  let assignee = { accountId: "acc-b", displayName: "Builder" };
  await page.route("**/*", (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname;
    if (path === "/config") return route.fulfill({ json: { site: "https://jira.example.invalid", project: "AION", people: { builder: { id: "acc-b", name: "Builder" }, reviewer: { id: "acc-r", name: "Reviewer" } }, devs: ["builder"], role, dev, email, accounts: true, odoo: false, mail: false, ai: { enabled: false } } });
    if (path === "/jira/search") return route.fulfill({ json: { issues: [
      { ...issue("AION-1", "acc-b", "Builder", "new") },
      { ...issue("AION-2", null, "", "indeterminate") },
      { ...issue("AION-3", "acc-r", "Reviewer", "done") },
    ], isLast: true } });
    if (path.startsWith("/jira/issue/") && req.method() === "PUT") {
      writes.push({ path, body: req.postDataJSON() });
      if (writes.fail) return route.fulfill({ status: 503, json: { code: "jira", error: "Jira is busy. Try again." } });
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

const openTicket = async (page) => {
  await page.goto("/dashboard.html#tickets");
  await page.getByRole("button", { name: "Ticket AION-1", exact: true }).first().click();
};

test("the sidebar count matches the All open tile", async ({ page }) => {
  await mockDashboard(page);
  await page.goto("/dashboard.html#tickets");
  await expect(page.locator("#view")).toContainText("Ticket AION-1");
  const tile = await page.locator(".tile.k1 .n").textContent();
  await expect(page.locator("#nav-ticket-count")).toHaveText(tile.trim());
  await expect(page.locator("#page-heading")).toHaveText("All open");
});

test("an administrator types to find a person and presses Enter; only the assignee is sent to Jira", async ({ page }) => {
  const writes = await mockDashboard(page);
  await openTicket(page);
  const pick = page.getByRole("combobox", { name: "Assignee" });
  await expect(pick).toHaveValue("Builder");
  await pick.fill("Rev");
  await pick.press("Enter");
  await expect(page.locator("#d-asgmsg")).toHaveText("Saved.");
  await expect(page.locator("#d-asgname")).toContainText("Reviewer");
  await expect(pick).toHaveValue("Reviewer");
  expect(writes.length).toBe(1);
  expect(Object.keys(writes[0].body.fields)).toEqual(["assignee"]);
  expect(writes[0].body.fields.assignee.accountId).toBe("acc-r");
});

test("a developer on the ticket can change its assignee; only the assignee is sent", async ({ page }) => {
  const writes = await mockDashboard(page, { role: "user", dev: "builder" });
  await openTicket(page);
  const pick = page.getByRole("combobox", { name: "Assignee" });
  await pick.fill("Rev");
  await pick.press("Enter");
  await expect(page.locator("#d-asgmsg")).toHaveText("Saved.");
  expect(writes.length).toBe(1);
  expect(Object.keys(writes[0].body.fields)).toEqual(["assignee"]);
});
test("Unassigned is offered for a Jira ticket and clears the owner", async ({ page }) => {
  const writes = await mockDashboard(page);
  await openTicket(page);
  const pick = page.getByRole("combobox", { name: "Assignee" });
  await pick.click();
  await page.locator(".combo-list li", { hasText: "Unassigned" }).click();
  await expect(page.locator("#d-asgmsg")).toHaveText("Saved.");
  await expect(page.locator("#d-asgname")).toContainText("Unassigned");
  expect(writes.length).toBe(1);
  expect(writes[0].body.fields.assignee).toBeNull();
});

test("a refused save puts the previous owner back and says so", async ({ page }) => {
  const writes = await mockDashboard(page);
  writes.fail = true;
  await openTicket(page);
  const pick = page.getByRole("combobox", { name: "Assignee" });
  await pick.fill("Rev");
  await pick.press("Enter");
  await expect(page.locator("#d-asgmsg")).toHaveText("Not saved. The owner was put back.");
  await expect(page.locator("#d-asgname")).toContainText("Builder");
  await expect(pick).toHaveValue("Builder");
  expect(writes.length).toBe(1);
});

test("someone who is not on the ticket sees the current assignee and no picker", async ({ page }) => {
  const writes = await mockDashboard(page, { role: "user", dev: "reviewer" });
  await openTicket(page);
  await expect(page.locator("#d-asgname")).toContainText("Builder");
  await expect(page.getByRole("combobox", { name: "Assignee" })).toBeHidden();
  await expect(page.locator("#d-asg")).toBeHidden();
  expect(writes.length).toBe(0);
});

test("on a phone the Assignee picker fits the ticket details and the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDashboard(page);
  await openTicket(page);
  const pick = page.getByRole("combobox", { name: "Assignee" });
  await pick.scrollIntoViewIfNeeded();
  await expect(pick).toBeInViewport();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(fits).toBe(true);
  await pick.click();
  await expect(page.locator(".combo-list")).toBeVisible();
});

for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`Work log (timer first) is the first section of the ticket main column on ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockDashboard(page);
    await openTicket(page);
    const top = (sel) => page.locator(sel).first().evaluate(n => n.getBoundingClientRect().top);
    expect(await page.locator("#drawer .jira-main > *").first().getAttribute("id")).toBe("work-log");
    const workLog = await top("#drawer #work-log");
    const activity = await top("#drawer .jira-activity");
    expect(workLog).toBeLessThan(activity);
    await expect(page.locator("#drawer .jira-activity")).toBeVisible();
    await expect(page.getByRole("button", { name: /Log work/ }).first()).toBeVisible();
  });
}

test("All tickets in the sidebar keeps an administrator's filters", async ({ page }) => {
  await mockDashboard(page);
  await page.goto("/dashboard.html?page=tickets");
  await expect(page.locator("#view")).toContainText("Ticket AION-1");
  await page.getByRole("searchbox", { name: "Search tickets" }).fill("AION-2");
  await page.locator('a[data-page="overview"]').click();
  await page.locator('a[data-page="tickets"]').click();
  await expect(page.getByRole("searchbox", { name: "Search tickets" })).toHaveValue("AION-2");
});

test("All tickets in the sidebar resets a user's search to the All open view", async ({ page }) => {
  await mockDashboard(page, { role: "user" });
  await page.goto("/dashboard.html?page=tickets");
  await expect(page.locator("#view")).toContainText("Ticket AION-1");
  await page.getByRole("searchbox", { name: "Search tickets" }).fill("AION-2");
  await page.locator('a[data-page="overview"]').click();
  await page.locator('a[data-page="tickets"]').click();
  await expect(page.getByRole("searchbox", { name: "Search tickets" })).toHaveValue("");
  await expect(page.locator("#page-heading")).toHaveText("All open");
});

test("An administrator going from No due date back to All open keeps the filters", async ({ page }) => {
  await mockDashboard(page);
  await page.goto("/dashboard.html?page=tickets");
  await expect(page.locator("#view")).toContainText("Ticket AION-1");
  const search = page.getByRole("searchbox", { name: "Search tickets" }), tile = l => page.locator("button.tile", { hasText: l });
  await search.fill("AION");
  await tile("No due date").click();
  await page.locator('a[data-page="tickets"]').click();
  await expect(page.locator("#page-heading")).toHaveText("All open");
  await expect(search).toHaveValue("AION");
  await tile("No due date").click();
  await tile("All open").click();
  await expect(tile("All open")).toHaveAttribute("aria-pressed", "true");
  await expect(search).toHaveValue("AION");
});
