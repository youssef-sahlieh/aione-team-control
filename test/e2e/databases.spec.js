import { test, expect } from "@playwright/test";

// Databases page against a synthetic proxy. Every request is intercepted.
const row = (over) => ({ company: "", companyNames: [], companySource: "", database: "DbProd", instance: "odoo101", url: "https://101.example.invalid", odooVersion: "18", loginFound: false, loginOk: false, flutter: false, addons: [], created: "2026-01-01T00:00:00Z", ...over });
const REPORT = {
  builtAt: Date.now(), count: 2,
  rows: [
    row({ company: "Ronit Yam Ltd", companySource: "database", database: "RonitYamProd", instance: "odoo503", url: "https://503.example.invalid", loginFound: true, loginOk: true, flutter: true, addons: ["flutter_pos_api", "sale"], posVersion: "19.0.3.97.2", posVersionDate: "" }),
    row({ instance: "odoo101", database: "db101" })
  ]
};

test("Databases: POS version column, Actions preview, restart needs a confirm", async ({ page }) => {
  const posts = [], errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "boss@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" }));
  });
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const json = (v) => route.fulfill({ json: v });
    if (url.pathname === "/config") return json({ role: "admin", odoo: true, email: "boss@example.invalid", people: {}, devs: [], capabilities: ["db-report-company-v1", "db-report-pos-version-v1"] });
    if (url.pathname === "/db-report") return json({ report: REPORT });
    if (url.pathname === "/db-report/action" && req.method() === "POST") { posts.push(req.postDataJSON()); return json({ ok: true, result: null }); }
    return route.fulfill({ status: 403, json: { code: "forbidden", error: "Unconfigured test request" } });
  });

  await page.goto("http://127.0.0.1:4173/databases.html");
  // The POS version shows in its own column, for the row that has it.
  const ronit = page.locator("#rows tr", { hasText: "RonitYamProd" });
  await expect(ronit.locator("td.db-col-posver")).toContainText("19.0.3.97.2");
  await expect(page.locator("#rows tr", { hasText: "db101" }).locator("td.db-col-posver")).toHaveText("—");
  // Without a company name from the database, the company is the id before the first underscore.
  await expect(page.locator("#rows tr", { hasText: "db101" }).locator("td.db-col-company")).toContainText("db101");
  await expect(page.locator("#notice")).toBeHidden();

  // Actions opens the preview with all three actions.
  await ronit.getByRole("button", { name: "Actions" }).click();
  const dlg = page.locator("#action-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.locator(".db-act-card")).toHaveCount(3);
  await expect(dlg.getByRole("button", { name: /Start Instance/ })).toBeDisabled();
  await expect(dlg.getByRole("button", { name: /Stop Instance/ })).toBeDisabled();
  // Nothing happens until an action is chosen, and then it needs its own Confirm.
  const confirm = dlg.getByRole("button", { name: "Confirm" });
  await expect(confirm).toBeDisabled();
  await dlg.getByRole("button", { name: /Restart Instance/ }).click();
  await expect(confirm).toBeEnabled();
  await expect(dlg.locator(".db-act-note")).toContainText("unavailable");
  await page.screenshot({ path: "test-results/databases-actions.png" });
  expect(posts).toEqual([]);
  await confirm.click();
  await expect(dlg).toBeHidden();
  expect(posts).toEqual([{ instance: "odoo503", action: "restart" }]);
  await expect(page.locator("#toast")).toContainText("Restart Instance sent to odoo503");

  // Esc closes the preview without doing anything.
  await ronit.getByRole("button", { name: "Actions" }).click();
  await expect(dlg).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  expect(posts.length).toBe(1);
  expect(errors).toEqual([]);
});

test("Databases: the saved report shows at once and updates in the background; offline servers say so", async ({ page }) => {
  const errors = [], refreshes = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "boss@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" }));
  });
  const fresh = { ...REPORT, builtAt: Date.now(), rows: [...REPORT.rows, row({ instance: "odoo600test", database: "", url: "https://600test.example.invalid", section: "tests", offline: true, loginFound: true })] };
  let current = { ...REPORT, builtAt: Date.now() - 5 * 3600000 }, release;
  const gate = new Promise((r) => { release = r; });
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    if (url.pathname === "/config") return route.fulfill({ json: { role: "admin", odoo: true, email: "boss@example.invalid", people: {}, devs: [], capabilities: ["db-report-company-v1", "db-report-pos-version-v1"] } });
    if (url.pathname === "/db-report") return route.fulfill({ json: { report: current, building: current !== fresh } });
    if (url.pathname === "/db-report/refresh") {
      refreshes.push(url.search);
      if (refreshes.length === 1) return route.fulfill({ json: { done: false, progress: { done: 2, total: 3 }, report: current } });
      await gate; current = fresh; return route.fulfill({ json: { done: true, report: fresh } });
    }
    return route.fulfill({ status: 403, json: { code: "forbidden", error: "Unconfigured test request" } });
  });
  await page.goto("http://127.0.0.1:4173/databases.html");
  // The saved (old) report is there straight away, while the update runs.
  await expect(page.locator("#rows tr", { hasText: "RonitYamProd" })).toBeVisible();
  await expect(page.locator("#meta")).toContainText("Updating in the background… 2 of 3 databases");
  expect(refreshes[0]).toBe("?continue=1");
  release();
  await page.getByRole("button", { name: "Tests" }).click().catch(() => {});
  await expect.poll(() => refreshes.length).toBe(2);
  await expect(page.locator("#rows")).toContainText("offline");
  expect(errors).toEqual([]);
});
