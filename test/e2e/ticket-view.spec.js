import { test, expect } from "@playwright/test";

// On a computer an open ticket stays inside the app: the sidebar and top bar remain usable, there is no dark
// overlay, and J / K (or the arrows) go to the next and previous ticket in the list.
async function setUp(page, { full }) {
  await page.addInitScript((full) => {
    localStorage.setItem("aione-session", JSON.stringify({ token: "t", email: "x@example.invalid", expiresAt: Date.now() + 3600000, role: "user" }));
    localStorage.setItem("aion.drawer.full", full ? "1" : "0");
  }, full);
  const issue = (key) => ({ key, fields: { summary: "Ticket " + key, status: { name: "To Do", statusCategory: { key: "new" } }, labels: ["ai1_builder"], duedate: "2026-12-31", assignee: { accountId: "acc-b", displayName: "Builder" }, updated: "2026-10-14T10:00:00.000+0000", created: "2026-10-01T10:00:00.000+0000" } });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    if (url.pathname === "/config") return route.fulfill({ json: { site: "https://jira.example.invalid", project: "AION", people: { builder: { id: "acc-b", name: "Builder" } }, devs: ["builder"], role: "user", dev: "builder", email: "x@example.invalid", accounts: true, odoo: false, mail: false, ai: { enabled: false } } });
    if (url.pathname === "/jira/search") return route.fulfill({ json: { issues: [issue("AION-1"), issue("AION-2"), issue("AION-3")], isLast: true } });
    if (url.pathname === "/internal") return route.fulfill({ json: { tickets: [] } });
    if (url.pathname === "/date-requests") return route.fulfill({ json: { requests: [] } });
    if (url.pathname === "/inbox") return route.fulfill({ json: { items: [], seenAt: null, readTickets: [] } });
    return route.fulfill({ status: 403, json: { code: "forbidden", error: "x" } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dashboard.html");
  await expect(page.locator("#view")).toContainText("Ticket AION-1");
}

test("a full-page ticket keeps the sidebar and top bar, with a breadcrumb and J / K between tickets", async ({ page }) => {
  await setUp(page, { full: true });
  const first = await page.locator("#view [data-key]").first().getAttribute("data-key");
  await page.locator("#view [data-key] .ttl").first().click();
  await expect(page.locator("#drawer")).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/ticket-page/);
  await expect(page.locator("#scrim")).toBeHidden();
  await expect(page.locator("#drawer")).toHaveAttribute("role", "region");
  await expect(page.locator("#drawer")).not.toHaveAttribute("aria-modal", "true");
  expect(await page.locator(".app-shell").evaluate((n) => n.inert)).toBe(false);
  await expect(page.locator("#app-sidebar")).toBeVisible();
  await expect(page.locator("#d-crumb")).toHaveText(first);
  await expect(page.locator("#d-pos")).toHaveText("1 of 3");
  await expect(page).toHaveTitle(new RegExp("^" + first + " · Ticket " + first));
  // The work log (timer first) is at the top of the ticket's main column, above the description and Activity.
  expect(await page.evaluate(() => { const log = document.getElementById("work-log"); return log.parentElement.classList.contains("jira-main") && !log.previousElementSibling && !!log.nextElementSibling; })).toBe(true);

  await page.keyboard.press("j");
  await expect(page.locator("#d-pos")).toHaveText("2 of 3");
  const second = await page.locator("#d-crumb").textContent();
  expect(second).not.toBe(first);
  await page.keyboard.press("k");
  await expect(page.locator("#d-crumb")).toHaveText(first);
  await expect(page.locator("#d-prev")).toBeDisabled();

  await page.locator("#d-back").click();
  await expect(page.locator("#drawer")).toBeHidden();
  await expect(page.locator("body")).not.toHaveClass(/ticket-page/);
  await expect(page).toHaveTitle("AIONE Team Control");
});

test("side by side keeps the list usable next to the ticket, and marks the open ticket in it", async ({ page }) => {
  await setUp(page, { full: false });
  await page.locator("#view [data-key] .ttl").first().click();
  await expect(page.locator("body")).toHaveClass(/ticket-split/);
  await expect(page.locator("#view .is-open")).toHaveCount(1);
  await page.locator("#view [data-key] .ttl").nth(2).click();
  await expect(page.locator("#d-pos")).toHaveText("3 of 3");
  await expect(page.locator("#view [data-key]").nth(2)).toHaveClass(/is-open/);
  await expect(page.locator("#d-next")).toBeDisabled();
});

test("on a phone the ticket still covers the app as a dialog", async ({ page }) => {
  await setUp(page, { full: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#view [data-key] .ttl").first().click();
  await expect(page.locator("#drawer")).toHaveAttribute("aria-modal", "true");
  expect(await page.locator(".app-shell").evaluate((n) => n.inert)).toBe(true);
  await expect(page.locator("body")).not.toHaveClass(/ticket-page|ticket-split/);
});
