import { test, expect } from "@playwright/test";

// Users, Databases, Knowledge base and Monitor share the app's sidebar and top bar, with the open page marked.
async function setUp(page) {
  await page.addInitScript(() => localStorage.setItem("aione-session", JSON.stringify({ token: "t", email: "ada@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" })));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    if (url.pathname === "/config") return route.fulfill({ json: { role: "admin", email: "ada@example.invalid", accounts: true, odoo: true, dbReport: true, knowledge: true, devs: [], people: {} } });
    if (url.pathname === "/users") return route.fulfill({ json: { users: [] } });
    if (url.pathname === "/db-report") return route.fulfill({ json: { report: { builtAt: Date.now(), count: 0, rows: [] } } });
    if (url.pathname === "/knowledge/open") return route.fulfill({ json: { url: "https://odoo.example.invalid/odoo/knowledge", articles: [] } });
    return route.fulfill({ status: 403, json: { code: "forbidden", error: "x" } });
  });
}

for (const [file, link, crumb] of [["users", "#users-link", "Users & access"], ["databases", "#dbreport-link", "Databases"], ["knowledge", "#knowledge-link", "Knowledge base"], ["monitor", null, "Audit & Deploy"]]) {
  test(`${file}: the sidebar and top bar are there, with this page marked`, async ({ page }) => {
    await setUp(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${file}.html`);
    await expect(page.locator("#app-sidebar")).toBeVisible();
    await expect(page.locator("#main-nav .nav-link").first()).toBeVisible();
    await expect(page.locator(".app-topbar .breadcrumbs b")).toHaveText(crumb);
    await expect(page.locator("#account-role")).toHaveText("Administrator");
    if (link) await expect(page.locator(link)).toHaveAttribute("aria-current", "page");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test("on a phone the menu button opens the sidebar", async ({ page }) => {
  await setUp(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/databases.html");
  await expect(page.locator("#app-sidebar")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.locator("#mobile-menu").click();
  await expect(page.locator("#app-sidebar")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#app-sidebar")).toBeHidden();
});
