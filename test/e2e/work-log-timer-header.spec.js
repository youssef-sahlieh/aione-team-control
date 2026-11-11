import { test, expect } from "@playwright/test";

// The timer in the ticket header, beside "Log work". Synthetic data only: the proxy's timer and time-entry answers are
// simulated here, nothing reaches Jira or Odoo, and the saved entry lives in this test's memory.
async function mockTimerTicket(page, { timer = null } = {}) {
  const unexpected = [], starts = [], saves = [], entries = [];
  const st = { timer };
  await page.addInitScript(() => { localStorage.setItem("aione-session", JSON.stringify({ token: "t", email: "admin@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" })); });
  const issue = (key) => ({ key, fields: { summary: "Fix login redirect", status: { name: "To Do", statusCategory: { key: "new" } }, labels: ["ai1_builder"], assignee: { accountId: "acc-b", displayName: "Builder" }, updated: "2026-10-14T10:00:00.000+0000", created: "2026-10-01T10:00:00.000+0000" } });
  const view = () => (st.timer ? { ...st.timer } : null);
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname, method = req.method(), body = req.postDataJSON();
    const json = (v, status) => route.fulfill(status ? { status, json: v } : { json: v });
    if (path === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people: { builder: { id: "acc-b", name: "Builder" } }, devs: ["builder"], role: "admin", dev: "builder", email: "admin@example.invalid", accounts: true, odoo: true, mail: false, ai: { enabled: false } });
    if (path === "/jira/search") return json({ issues: [issue("AION-7")], isLast: true });
    if (path === "/jira/issue/AION-7") return json({ ...issue("AION-7"), comments: [], attachments: [] });
    if (path === "/time-entries/timer" && method === "GET") return json({ timer: view(), canLog: true });
    if (path === "/time-entries/timer" && method === "POST") {
      if (body.action === "start") {
        starts.push(body);
        if (st.timer && ["running", "paused", "stopped"].includes(st.timer.state)) return json({ code: "timer", error: "A timer is already running on " + st.timer.ticket + ".", details: { timer: view() } }, 409);
        st.timer = { id: body.id, ticket: body.ticket, ticketTitle: "Fix login redirect", state: "running", startedAt: new Date().toISOString(), stoppedAt: null, elapsedMs: 0, suggestedMinutes: null, workDate: "2026-10-15", crossesMidnight: false, description: "", revision: 0 };
        return json({ timer: view() });
      }
      if (body.action === "stop" && st.timer) {
        st.timer = { ...st.timer, state: "stopped", stoppedAt: new Date().toISOString(), elapsedMs: 90 * 60000, suggestedMinutes: 90, revision: st.timer.revision + 1 };
        return json({ timer: view() });
      }
      if (body.action === "draft" && st.timer) {
        st.timer = { ...st.timer, description: body.description, revision: st.timer.revision + 1 };
        return json({ timer: view() });
      }
      unexpected.push({ path, method, action: body.action });
      return json({ code: "forbidden", error: "Unconfigured test request" }, 403);
    }
    if (path === "/time-entries" && method === "GET") {
      const minutes = entries.reduce((n, e) => n + e.minutes, 0);
      return json({ ticket: "AION-7", source: "jira", closed: false, logging: true, canLog: true, today: "2026-10-15", maxMinutes: 1440, lockDate: null, entries, summary: { loggedMinutes: minutes, pendingMinutes: 0 }, baselineHours: null, totalHours: null, destination: null });
    }
    if (path === "/time-entries" && method === "POST") {
      saves.push(body);
      // The timer's id is the entry id: a repeated save returns the same entry.
      if (!entries.some((e) => e.id === body.id)) entries.push({ id: body.id, ticket: body.ticket, source: "jira", date: body.date, minutes: body.minutes, description: body.description, user: "Builder", status: "synced", statusLabel: "Saved in Odoo", synced: true, clientName: null, subClientName: null });
      if (st.timer && st.timer.id === body.id) st.timer = { ...st.timer, state: "logged" };
      return json({ entry: entries.find((e) => e.id === body.id), summary: { loggedMinutes: entries.reduce((n, e) => n + e.minutes, 0), pendingMinutes: 0 } });
    }
    if (path === "/internal") return json({ tickets: [] });
    if (path === "/date-requests") return json({ requests: [] });
    if (path === "/inbox") return json({ items: [], seenAt: null, readTickets: [] });
    // Other dashboard reads are answered empty; only unexpected timer and time-entry requests fail the test.
    if (path.startsWith("/time-entries")) unexpected.push({ path, method });
    return json({});
  });
  return { unexpected, starts, saves };
}

const openTicket = async (page) => {
  await page.goto("/dashboard.html?page=tickets");
  await page.locator("#view [data-key] .ttl").filter({ hasText: "Fix login redirect" }).first().click();
  await expect(page.locator("#drawer")).toBeVisible();
  await expect(page.locator("#d-timer")).toBeAttached();
};

const runningTimer = () => ({ id: "t-running", ticket: "AION-7", ticketTitle: "Fix login redirect", state: "running", startedAt: new Date().toISOString(), stoppedAt: null, elapsedMs: 0, suggestedMinutes: null, workDate: "2026-10-15", crossesMidnight: false, description: "", revision: 0 });

test("the header's Start timer starts the server timer, and the clock shows beside Log work", async ({ page }) => {
  const mock = await mockTimerTicket(page);
  await openTicket(page);
  const header = page.locator("#d-timer");
  await expect(header.getByRole("button", { name: "Start timer", exact: true })).toBeVisible();
  // A double click sends one start: the button is disabled while the first one is in flight.
  await header.getByRole("button", { name: "Start timer", exact: true }).dblclick();
  await expect(header.getByText("Running", { exact: true })).toBeVisible();
  await expect(header.getByRole("timer")).toBeVisible();
  await expect(header.getByRole("button", { name: "Stop timer", exact: true })).toBeVisible();
  await expect(page.locator("#d-logwork")).toBeVisible();
  // No panel in the ticket body any more.
  expect(await page.locator("#work-log .wl-timer").count()).toBe(0);
  expect(mock.starts.length).toBe(1);
  expect(mock.unexpected).toEqual([]);
});

test("the running timer survives a refresh; Stop opens the form with the elapsed time, and dismissing it keeps the stopped timer", async ({ page }) => {
  const mock = await mockTimerTicket(page);
  await openTicket(page);
  await page.locator("#d-timer").getByRole("button", { name: "Start timer", exact: true }).click();
  await expect(page.locator("#d-timer").getByRole("button", { name: "Stop timer", exact: true })).toBeVisible();

  await page.reload();
  await openTicket(page);
  const header = page.locator("#d-timer");
  await expect(header.getByText("Running", { exact: true })).toBeVisible();

  await header.getByRole("button", { name: "Stop timer", exact: true }).click();
  const form = page.getByRole("dialog", { name: /Log timer · AION-7/ });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Duration", { exact: true })).toHaveValue("1:30");

  // Dismissed: the stopped timer stays, with Log time… to finish it later.
  await form.getByRole("button", { name: "Keep stopped", exact: true }).click();
  await expect(form).toBeHidden();
  await expect(header.getByText("Stopped · not logged yet")).toBeVisible();
  await header.getByRole("button", { name: "Log time…", exact: true }).click();

  const again = page.getByRole("dialog", { name: /Log timer · AION-7/ });
  await expect(again.getByLabel("Duration", { exact: true })).toHaveValue("1:30");
  await again.getByLabel(/^Description/).fill("Fixed the redirect after login");
  await again.getByRole("button", { name: "Log time", exact: true }).click();

  await expect.poll(() => mock.saves.length).toBe(1);
  expect(mock.saves[0]).toMatchObject({ ticket: "AION-7", minutes: 90, description: "Fixed the redirect after login" });
  expect(mock.saves[0].id).toBe(mock.starts[0].id);
  await expect(page.locator("#work-log")).toContainText("1:30");
  await expect(header.getByRole("button", { name: "Start timer", exact: true })).toBeVisible();
  expect(mock.unexpected).toEqual([]);
});

test("with a timer on another ticket, the header names it and links to it instead of starting one", async ({ page }) => {
  await mockTimerTicket(page, { timer: { id: "t-other", ticket: "AION-2", ticketTitle: "Other ticket", state: "paused", startedAt: new Date().toISOString(), stoppedAt: null, elapsedMs: 600000, suggestedMinutes: null, workDate: "2026-10-15", crossesMidnight: false, description: "", revision: 1 } });
  await openTicket(page);
  const header = page.locator("#d-timer");
  await expect(header.getByText("Timer on AION-2", { exact: true })).toBeVisible();
  await expect(header.getByRole("button", { name: "Go to AION-2", exact: true })).toBeVisible();
  await expect(header.getByRole("button", { name: "Start timer", exact: true })).toHaveCount(0);
});

test("on a phone the header timer fits the screen and its buttons stay in view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockTimerTicket(page, { timer: runningTimer() });
  await openTicket(page);
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(fits).toBe(true);
  const stop = page.locator("#d-timer").getByRole("button", { name: "Stop timer", exact: true });
  await expect(stop).toBeVisible();
  await stop.scrollIntoViewIfNeeded();
  await expect(stop).toBeInViewport();
});
