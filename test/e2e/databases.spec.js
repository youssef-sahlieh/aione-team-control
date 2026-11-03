import { test, expect } from "@playwright/test";

// Databases page against a synthetic proxy. Every request is intercepted.
const row = (over) => ({ company: "", companyNames: [], companySource: "", database: "DbProd", instance: "odoo101", url: "https://101.example.invalid", odooVersion: "18", loginFound: false, loginOk: false, flutter: false, addons: [], created: "2026-01-01T00:00:00Z", ...over });
const REPORT = {
  builtAt: Date.now(), count: 2,
  rows: [
    row({ company: "Ronit Yam Ltd", companySource: "database", database: "RonitYamProd", instance: "odoo503", url: "https://503.example.invalid", loginFound: true, loginOk: true, flutter: true, addons: ["flutter_pos_api", "sale"], posVersion: "19.0.3.97.2", posVersionDate: "" }),
    row({ instance: "odoo101", database: "db101", loginFound: true, loginOk: true }),
    // No working login: still listed. Offline: not listed.
    row({ instance: "odoo102", database: "db102", url: "https://102.example.invalid", loginFound: true }),
    row({ instance: "odoo103", database: "db103", url: "https://103.example.invalid", loginFound: true, offline: true })
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
  // A database without access is listed; an offline one isn't, and the line above the table says so.
  await expect(page.locator("#rows tr", { hasText: "db102" })).toContainText("no access");
  await expect(page.locator("#rows")).not.toContainText("db103");
  await expect(page.locator("#meta")).toContainText("3 of 3 databases · 2 with data · 1 offline not shown");
  // Open goes to the instance's page on AI1 Monitor, in a new tab.
  await expect(ronit.getByRole("link", { name: "Open" })).toHaveAttribute("href", "https://monitor.ai1.host/dashboard#instance/odoo503/info");
  await expect(ronit.getByRole("link", { name: "Open" })).toHaveAttribute("target", "_blank");

  // Actions opens the preview with all three actions.
  await ronit.getByRole("button", { name: "Actions" }).click();
  const dlg = page.locator("#action-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.locator(".db-act-card")).toHaveCount(4);
  // Extend is offered on Main too (a test database can share a production server's address).
  await expect(dlg.getByRole("button", { name: /Extend Database/ })).toBeEnabled();
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

test("Databases: the saved report shows at once and updates in the background; offline servers aren't listed", async ({ page }) => {
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
  await expect(page.locator("#meta")).toContainText("0 of 0 databases · 0 with data · 1 offline not shown");
  await expect(page.locator("#rows")).not.toContainText("600test");
  expect(errors).toEqual([]);
});

test("Databases: Extend Database on a test copy picks a date, needs a confirm, and shows the new expiry", async ({ page }) => {
  const posts = [], errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "boss@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" }));
    localStorage.setItem("aion.dbreport.view", JSON.stringify({ section: "tests" }));
  });
  const copy = row({ database: "RonitYamProd_test", instance: "odoo503test", url: "https://503test.example.invalid", section: "tests", loginFound: true, loginOk: true, expires: "2026-01-01 00:00:00", expired: true });
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const json = (v) => route.fulfill({ json: v });
    if (url.pathname === "/config") return json({ role: "admin", odoo: true, email: "boss@example.invalid", people: {}, devs: [], capabilities: ["db-report-company-v1", "db-report-pos-version-v1"] });
    if (url.pathname === "/db-report") return json({ report: { ...REPORT, rows: [...REPORT.rows, copy] } });
    if (url.pathname === "/db-report/action" && req.method() === "POST") { posts.push(req.postDataJSON()); return json({ ok: true, result: null }); }
    return route.fulfill({ status: 403, json: { code: "forbidden", error: "Unconfigured test request" } });
  });
  await page.goto("http://127.0.0.1:4173/databases.html");
  const tr = page.locator("#rows tr", { hasText: "RonitYamProd_test" });
  await expect(tr.locator("td.db-col-expired")).toContainText("Expired");
  await tr.getByRole("button", { name: "Actions" }).click();
  const dlg = page.locator("#action-dialog");
  await expect(dlg.locator("#extend-date")).toBeHidden();
  await dlg.getByRole("button", { name: /Extend Database/ }).click();
  const date = dlg.locator("#extend-date");
  await expect(date).toBeVisible();
  await expect(dlg).toContainText("now 2026-01-01");
  const d = new Date(); d.setDate(d.getDate() + 60);
  const picked = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  await date.fill(picked);
  await page.screenshot({ path: "test-results/databases-extend.png" });
  expect(posts).toEqual([]);
  await dlg.getByRole("button", { name: "Confirm" }).click();
  await expect(dlg).toBeHidden();
  expect(posts).toEqual([{ instance: "odoo503test", action: "extend", date: picked }]);
  await expect(page.locator("#toast")).toContainText("now expires on " + picked);
  await expect(tr.locator("td.db-col-expired")).toContainText("Valid " + picked);
  expect(errors).toEqual([]);
});
