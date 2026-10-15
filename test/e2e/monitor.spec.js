import { test, expect } from "@playwright/test";

// Audit & Deploy page against a synthetic proxy. Every request is intercepted.
async function mockMonitor(page, { role = "user" } = {}) {
  const calls = [], unexpected = [], errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.addInitScript(({ role }) => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "dev@example.invalid", expiresAt: Date.now() + 3600000, role }));
  }, { role });
  const log = [];
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname, method = req.method(), body = req.postDataJSON();
    calls.push({ path, method, body });
    const json = (v) => route.fulfill({ json: v });
    if (path === "/config") return json({ role, odoo: true, email: "dev@example.invalid", people: {}, devs: [] });
    if (path === "/monitor/instances") return json({ payload: { services: [{ instance_name: "odoo101", domain: "101.example.invalid", health: "healthy", status: "running", server_zone: "prod", db_host: "db1", created: "2026-01-01T00:00:00Z" }, { instance_name: "odoo102", domain: "102.example.invalid", health: null, status: "running", server_zone: "test" }] } });
    if (path === "/monitor/instances/odoo101/config") return json({ payload: { databases: ["db101"], read_only: true } });
    if (path === "/monitor/test-envs") return json({ envs: [{ id: 7, name: "101 Test", instance_name: "dev-101t1", source_instance: "odoo101", domain: "101.dev1.example.invalid", status: "running", is_persistent: false, expires_at: "2026-10-20T10:00:00", template: "standard" }], maxActive: 10 });
    if (path === "/monitor/test-envs/options") return json({ databases: ["db101"], targets: [{ id: "test_app_mnt", label: "Test volume", zone: "test", freeGiB: 73 }] });
    if (path === "/monitor/test-envs/reserve") return json({ token: "tok", estimate: { ready: true, confirmation_allowed: true, required_gib: 3 }, executionEnabled: true });
    if (path === "/monitor/test-envs" && method === "POST") { log.unshift({ id: log.length + 1, when: "2026-10-15T09:00:00Z", name: "Dev", email: "dev@example.invalid", action: "Create test environment", target: "odoo101", result: "success" }); return json({ ok: true }); }
    if (/^\/monitor\/test-envs\/7\/extend$/.test(path)) { log.unshift({ id: log.length + 1, when: "2026-10-15T09:01:00Z", name: "Dev", email: "dev@example.invalid", action: "Extend test environment by 24h", target: "dev-101t1", result: "success" }); return json({ ok: true }); }
    if (path === "/monitor/approvals") return json({ access: { pending: [{ id: 3, instance_name: "odoo101", database: "db101", reason: "Investigate", state: "pending" }], mine: [] }, unlock: { pending: [], mine: [] }, expiry: [] });
    if (path === "/monitor/approvals/access/3") return json({ ok: true });
    if (path === "/monitor/pipeline-runs") return json({ runs: [] });
    if (path === "/monitor/odoo-audit") return json({ actions: [{ id: 1, action_type: "instance_view", target_name: "odoo101", result: "success", user_name: "Synthetic Person", create_date: "2026-10-15T08:00:00Z", details: "{}" }], has_more: false });
    if (path === "/monitor/log") return json({ entries: log, hasMore: false });
    unexpected.push({ path, method });
    return route.fulfill({ status: 403, json: { code: "forbidden", error: "Unconfigured test request" } });
  });
  return { calls, unexpected, errors };
}

test("a developer sees Audit & Deploy and every change is logged with their name", async ({ page }) => {
  const mock = await mockMonitor(page);
  await page.goto("/monitor.html");
  await expect(page.locator("#ov-cards .tile").first()).toContainText("2");
  await expect(page.locator("#ov-audit")).toContainText("Synthetic Person");

  await page.locator('[data-tab="instances"]').click();
  await expect(page.locator("#in-count")).toHaveText("2 of 2");
  await page.locator("#in-health").selectOption("__unknown");
  await expect(page.locator("#in-count")).toHaveText("1 of 2");
  await page.locator("#in-health").selectOption("");
  await page.getByRole("button", { name: "odoo101", exact: true }).click();
  await expect(page.locator("#dr-body")).toContainText("db101");
  await page.locator("#dr-close").click();

  await page.locator('[data-tab="testenvs"]').click();
  await expect(page.locator("#te-table")).toContainText("dev-101t1");
  await page.locator("#te-table").getByRole("button", { name: "+24h", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Recorded in the action log");
  await page.locator("#te-new").click();
  await page.locator("#te-source").selectOption("odoo101");
  await expect(page.locator("#te-target option")).toHaveCount(1);
  await expect(page.locator("#te-create")).toBeDisabled();
  await page.locator("#te-reserve").click();
  await expect(page.locator("#te-create")).toBeEnabled();
  await page.locator("#te-create").click();
  await expect.poll(() => mock.calls.find((c) => c.path === "/monitor/test-envs" && c.method === "POST")?.body).toMatchObject({ source: "odoo101", target: "test_app_mnt", token: "tok", template: "standard", ttl: 72, persistent: false });

  await page.locator('[data-tab="approvals"]').click();
  await page.locator("#ap-access").getByRole("button", { name: "Approve", exact: true }).click();
  await expect.poll(() => mock.calls.find((c) => c.path === "/monitor/approvals/access/3")?.body).toEqual({ decision: "approve", note: "" });

  await page.locator('[data-tab="log"]').click();
  await expect(page.locator("#lg-list")).toContainText("Extend test environment by 24h");
  await expect(page.locator("#lg-list")).toContainText("Dev <dev@example.invalid>");
  expect(mock.unexpected).toEqual([]); expect(mock.errors).toEqual([]);
});

test("dashboard sidebar links to Audit & Deploy when Odoo is connected", async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("aione-session", JSON.stringify({ token: "t", email: "x@example.invalid", expiresAt: Date.now() + 3600000, role: "user" })); });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    if (url.pathname === "/config") return route.fulfill({ json: { site: "https://jira.example.invalid", project: "AION", people: {}, devs: ["builder"], role: "user", dev: "builder", email: "x@example.invalid", accounts: true, odoo: true, mail: false, ai: { enabled: false } } });
    if (url.pathname === "/jira/search") return route.fulfill({ json: { issues: [], isLast: true } });
    if (url.pathname === "/odoo/tickets") return route.fulfill({ json: { tickets: [] } });
    if (url.pathname === "/internal") return route.fulfill({ json: { tickets: [] } });
    if (url.pathname === "/date-requests") return route.fulfill({ json: { requests: [] } });
    return route.fulfill({ status: 403, json: { code: "forbidden", error: "x" } });
  });
  await page.goto("/dashboard.html");
  await expect(page.locator("#monitor-link")).toBeVisible();
  await expect(page.locator("#monitor-link")).toHaveAttribute("href", "audit-deploy.html");
  // Sidebar order: no "More" menu; Audit & Deploy right after All tickets; Boards right before Calendar.
  await expect(page.locator("#manager-more-nav")).toHaveCount(0);
  const order = await page.locator("#main-nav > a:visible").evaluateAll((links) => links.map((a) => a.textContent.replace(/[—\d]+$/, "").trim()));
  expect(order.indexOf("Audit & Deploy")).toBe(order.indexOf("All tickets") + 1);
  expect(order.indexOf("Boards")).toBe(order.indexOf("Calendar") - 1);
});
