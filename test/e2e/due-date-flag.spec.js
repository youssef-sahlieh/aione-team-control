import { test, expect } from "@playwright/test";

// The "+ set date" button is red when a ticket has a developer but no due date.
test("a ticket with a developer and no due date shows its set-date button in red; others don't", async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("aione-session", JSON.stringify({ token: "t", email: "x@example.invalid", expiresAt: Date.now() + 3600000, role: "user" })); });
  const issue = (key, labels, duedate) => ({ key, fields: { summary: "Ticket " + key, status: { name: "To Do", statusCategory: { key: "new" } }, labels, duedate, assignee: { accountId: "acc-b", displayName: "Builder" }, updated: "2026-10-14T10:00:00.000+0000", created: "2026-10-01T10:00:00.000+0000" } });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    if (url.pathname === "/config") return route.fulfill({ json: { site: "https://jira.example.invalid", project: "AION", people: { builder: { id: "acc-b", name: "Builder" } }, devs: ["builder"], role: "user", dev: "builder", email: "x@example.invalid", accounts: true, odoo: false, mail: false, ai: { enabled: false } } });
    if (url.pathname === "/jira/search") return route.fulfill({ json: { issues: [
      issue("AION-1", ["ai1_builder"], null),
      issue("AION-2", [], null),
      issue("AION-3", ["ai1_builder"], "2026-12-31"),
    ], isLast: true } });
    if (url.pathname === "/internal") return route.fulfill({ json: { tickets: [] } });
    if (url.pathname === "/date-requests") return route.fulfill({ json: { requests: [] } });
    if (url.pathname === "/inbox") return route.fulfill({ json: { items: [], seenAt: null, readTickets: [] } });
    return route.fulfill({ status: 403, json: { code: "forbidden", error: "x" } });
  });
  await page.goto("/dashboard.html#tickets");
  await expect(page.locator("#view")).toContainText("Ticket AION-1");
  await expect(page.locator(".duebtn.unset")).toHaveCount(1);
  await expect(page.locator(".duebtn.unset")).toHaveText("+ set date");
  await expect(page.locator(".duebtn.none")).toHaveCount(2);
});
