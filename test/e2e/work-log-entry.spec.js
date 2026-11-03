import { test, expect } from "@playwright/test";

// Work log page: "+ Log work" picks an open ticket, then the time. Every request is intercepted.
async function mockWorkLog(page, { canLog = true } = {}) {
  const calls = [], unexpected = [], rows = [];
  page.on("dialog", (d) => d.accept());
  await page.addInitScript(() => { localStorage.setItem("aione-session", JSON.stringify({ token: "t", email: "builder@example.invalid", expiresAt: Date.now() + 3600000, role: "user" })); });
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname, method = req.method(), body = req.postDataJSON();
    calls.push({ path, method, body, ticket: url.searchParams.get("ticket") });
    const json = (v) => route.fulfill({ json: v });
    if (path === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people: { builder: { id: "acc-b", name: "Builder" } }, devs: ["builder"], role: "user", dev: "builder", email: "builder@example.invalid", accounts: true, odoo: true, mail: false, ai: { enabled: false } });
    if (path === "/jira/search") return json({ issues: [{ key: "AION-7", fields: { summary: "Fix login redirect", status: { name: "To Do", statusCategory: { key: "new" } }, labels: ["ai1_builder"], assignee: { accountId: "acc-b", displayName: "Builder" }, updated: "2026-10-14T10:00:00.000+0000", created: "2026-10-01T10:00:00.000+0000" } }], isLast: true });
    if (path === "/internal" || path === "/odoo/tickets") return json({ tickets: [] });
    if (path === "/date-requests") return json({ requests: [] });
    if (path === "/inbox") return json({ items: [], seenAt: null, readTickets: [] });
    if (path === "/time-entries/report") return json({ from: "2026-10-01", to: "2026-10-15", timeZone: "Asia/Jerusalem", statuses: { synced: "Saved in Odoo" }, canLog, rows: [...rows], baselines: [] });
    if (path === "/time-entries" && method === "GET") {
      if (url.searchParams.get("ticket") !== "AION-7") return route.fulfill({ status: 404, json: { code: "not_found", error: "Ticket unavailable." } });
      return json({ ticket: "AION-7", source: "jira", closed: false, logging: true, canLog, today: "2026-10-15", maxMinutes: 1440, lockDate: null, entries: [], summary: { loggedMinutes: 0, pendingMinutes: 0 }, baselineHours: null, totalHours: null, destination: null });
    }
    if (path === "/time-entries" && method === "POST") {
      const entry = { id: body.id, ticket: body.ticket, source: "jira", date: body.date, minutes: body.minutes, description: body.description, user: "Builder", status: "synced", statusLabel: "Saved in Odoo", synced: true, clientName: null, subClientName: null };
      rows.push(entry);
      return json({ entry: { ...entry, statusLabel: "Saved in Odoo" }, summary: { loggedMinutes: body.minutes, pendingMinutes: 0 } });
    }
    unexpected.push({ path, method });
    return route.fulfill({ status: 403, json: { code: "forbidden", error: "Unconfigured test request" } });
  });
  return { calls, unexpected };
}

test("a user picks one of their open tickets on the Work log page, enters the time, and it appears in the report", async ({ page }) => {
  const mock = await mockWorkLog(page);
  await page.goto("/dashboard.html?page=worklog");
  const logButton = page.getByRole("button", { name: "+ Log work", exact: true });
  await expect(logButton).toBeVisible();

  await logButton.click();
  const picker = page.getByRole("dialog", { name: "Log work" });
  await picker.getByLabel("Ticket").fill("login");
  await picker.getByRole("button", { name: /AION-7/ }).click();

  const form = page.getByRole("dialog", { name: "Log work · AION-7" });
  await expect(form).toBeVisible();
  await form.getByRole("spinbutton", { name: /^Hours/ }).fill("1");
  await form.getByRole("spinbutton", { name: /^Minutes/ }).fill("30");
  await form.getByLabel(/^Description/).fill("Fixed the redirect after login");
  await form.getByRole("button", { name: "Save", exact: true }).click();

  await expect.poll(() => mock.calls.find((c) => c.method === "POST" && c.path === "/time-entries")?.body)
    .toMatchObject({ ticket: "AION-7", date: "2026-10-15", minutes: 90, description: "Fixed the redirect after login" });
  await expect(page.locator(".wl-page")).toContainText("Fixed the redirect after login");
  await expect(page.locator(".wl-page")).toContainText("1h 30m");
  expect(mock.unexpected).toEqual([]);
});

test("the Log work button is hidden when this person may not log work", async ({ page }) => {
  await mockWorkLog(page, { canLog: false });
  await page.goto("/dashboard.html?page=worklog");
  await expect(page.locator(".wl-page")).toBeVisible();
  await expect(page.getByRole("button", { name: "+ Log work", exact: true })).toBeHidden();
});
