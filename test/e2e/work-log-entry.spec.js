import { test, expect } from "@playwright/test";

// Work log page: "+ Log work" picks an open ticket, then the time. Every request is intercepted.
async function mockWorkLog(page, { canLog = true, failFirstPost = false } = {}) {
  const calls = [], unexpected = [], rows = [], dialogs = [];
  let posts = 0;
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
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
    if (path === "/time-entries/timer" && method === "GET") return json({ timer: null });
    if (path === "/time-entries/report") return json({ from: "2026-10-01", to: "2026-10-15", timeZone: "Asia/Jerusalem", statuses: { synced: "Saved in Odoo" }, canLog, rows: [...rows], baselines: [] });
    if (path === "/time-entries" && method === "GET") {
      if (url.searchParams.get("ticket") !== "AION-7") return route.fulfill({ status: 404, json: { code: "not_found", error: "Ticket unavailable." } });
      return json({ ticket: "AION-7", source: "jira", closed: false, logging: true, canLog, today: "2026-10-15", maxMinutes: 1440, lockDate: null, entries: [], summary: { loggedMinutes: 0, pendingMinutes: 0 }, baselineHours: null, totalHours: null, destination: null });
    }
    if (path === "/time-entries" && method === "POST") {
      posts += 1;
      if (failFirstPost && posts === 1) return route.fulfill({ status: 500, json: { code: "odoo", error: "Odoo is busy. Try again." } });
      const entry = { id: body.id, ticket: body.ticket, source: "jira", date: body.date, minutes: body.minutes, description: body.description, user: "Builder", status: "synced", statusLabel: "Saved in Odoo", synced: true, clientName: null, subClientName: null };
      rows.push(entry);
      return json({ entry: { ...entry, statusLabel: "Saved in Odoo" }, summary: { loggedMinutes: body.minutes, pendingMinutes: 0 } });
    }
    unexpected.push({ path, method });
    return route.fulfill({ status: 403, json: { code: "forbidden", error: "Unconfigured test request" } });
  });
  return { calls, unexpected, dialogs };
}

// Opens the form for AION-7 from the Work log page and returns it.
async function openForm(page) {
  await page.goto("/dashboard.html?page=worklog");
  await page.getByRole("button", { name: "+ Log work", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Log work" });
  await picker.getByLabel("Ticket").fill("login");
  await picker.getByRole("button", { name: /AION-7/ }).click();
  const form = page.getByRole("dialog", { name: "Log work · AION-7" });
  await expect(form).toBeVisible();
  return form;
}

// One duration field, H:MM (decimal hours also work).
const duration = (form) => form.getByLabel("Duration", { exact: true });
const description = (form) => form.getByLabel(/^Description/);
const chip = (form, label) => form.getByRole("button", { name: label, exact: true });

test("a user picks one of their open tickets on the Work log page, enters the time, and it appears in the report", async ({ page }) => {
  const mock = await mockWorkLog(page);
  const form = await openForm(page);
  await duration(form).fill("1:30");
  await description(form).fill("Fixed the redirect after login");
  await form.getByRole("button", { name: "Save work", exact: true }).click();

  await expect.poll(() => mock.calls.find((c) => c.method === "POST" && c.path === "/time-entries")?.body)
    .toMatchObject({ ticket: "AION-7", date: "2026-10-15", minutes: 90, description: "Fixed the redirect after login" });
  await expect(page.locator(".wl-page")).toContainText("Fixed the redirect after login");
  await expect(page.locator(".wl-page")).toContainText("1:30");
  expect(mock.unexpected).toEqual([]);
});

test("the Log work button is hidden when this person may not log work", async ({ page }) => {
  await mockWorkLog(page, { canLog: false });
  await page.goto("/dashboard.html?page=worklog");
  await expect(page.locator(".wl-page")).toBeVisible();
  await expect(page.getByRole("button", { name: "+ Log work", exact: true })).toBeHidden();
});

test("the shortcuts set the total, are highlighted when they match, and the total is shown", async ({ page }) => {
  await mockWorkLog(page);
  const form = await openForm(page);
  await chip(form, "1:00").click();
  await expect(duration(form)).toHaveValue("1:00");
  await expect(form.getByText("Total: 1:00", { exact: true })).toBeVisible();
  await expect(chip(form, "1:00")).toHaveAttribute("aria-pressed", "true");
  // A shortcut sets the total rather than adding to it.
  await chip(form, "0:15").click();
  await expect(duration(form)).toHaveValue("0:15");
  await expect(form.getByText("Total: 0:15", { exact: true })).toBeVisible();
  await expect(chip(form, "0:15")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(form, "1:00")).toHaveAttribute("aria-pressed", "false");
  // Typing a total that matches no shortcut clears the highlight.
  await duration(form).fill("0:20");
  await expect(form.locator(".wl-chip[aria-pressed='true']")).toHaveCount(0);
});

test("invalid durations are named beside their box, and nothing is saved", async ({ page }) => {
  const mock = await mockWorkLog(page);
  const form = await openForm(page);
  await description(form).fill("Checked the redirect");
  await duration(form).fill("24:30");
  await form.getByRole("button", { name: "Save work", exact: true }).click();
  await expect(duration(form)).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByText("Enter at most 24:00.")).toBeVisible();
  await duration(form).fill("0:00");
  await form.getByRole("button", { name: "Save work", exact: true }).click();
  await expect(form.getByText("Enter at least 0:01.")).toBeVisible();
  expect(mock.calls.some((c) => c.method === "POST" && c.path === "/time-entries")).toBe(false);
});

test("Save & add another keeps the ticket and date, and clears the duration and description", async ({ page }) => {
  const mock = await mockWorkLog(page);
  const form = await openForm(page);
  await duration(form).fill("1:00");
  await description(form).fill("First part");
  await form.getByRole("button", { name: "Save & add another", exact: true }).click();
  await expect(form.locator(".msg.ok")).toContainText("Add the next one.");
  await expect(duration(form)).toHaveValue("");
  await expect(description(form)).toHaveValue("");
  await expect(duration(form)).toBeFocused();
  await expect(form.getByLabel("Work date")).toHaveValue("2026-10-15");
  await expect(form.getByText(/15 Oct 2026/)).toBeVisible();
  expect(mock.calls.find((c) => c.method === "POST" && c.path === "/time-entries")?.body).toMatchObject({ ticket: "AION-7", date: "2026-10-15", minutes: 60 });
});

test("a failed save keeps every value, shows the error, and the retry is the same entry", async ({ page }) => {
  const mock = await mockWorkLog(page, { failFirstPost: true });
  const form = await openForm(page);
  await duration(form).fill("2:05");
  await description(form).fill("Kept after a failure");
  await form.getByRole("button", { name: "Save work", exact: true }).click();
  await expect(form.locator(".msg.err")).toContainText("Odoo is busy");
  await expect(duration(form)).toHaveValue("2:05");
  await expect(description(form)).toHaveValue("Kept after a failure");
  await form.getByRole("button", { name: "Save work", exact: true }).click();
  await expect.poll(() => mock.calls.filter((c) => c.method === "POST" && c.path === "/time-entries").length).toBe(2);
  const [first, second] = mock.calls.filter((c) => c.method === "POST" && c.path === "/time-entries").map((c) => c.body);
  expect(second.id).toBe(first.id);
  expect(second.minutes).toBe(125);
});

test("Escape with unsaved values asks before discarding them; without them the form just closes", async ({ page }) => {
  const mock = await mockWorkLog(page);
  const form = await openForm(page);
  await description(form).fill("Not saved yet");
  await page.keyboard.press("Escape");
  await expect.poll(() => mock.dialogs.length).toBe(1);
  expect(mock.dialogs[0]).toContain("Discard this work entry");
  await expect(form).toBeHidden();
  // Focus goes back to the button that opened the form.
  await expect(page.getByRole("button", { name: "+ Log work", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "+ Log work", exact: true }).click();
  const again = page.getByRole("dialog", { name: "Log work" });
  await again.getByLabel("Ticket").fill("login");
  await again.getByRole("button", { name: /AION-7/ }).click();
  await expect(page.getByRole("dialog", { name: "Log work · AION-7" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Log work · AION-7" })).toBeHidden();
  expect(mock.dialogs.length).toBe(1);
});

test("on a phone the form fits the screen and the actions stay in view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await mockWorkLog(page);
  const form = await openForm(page);
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(fits).toBe(true);
  const save = form.getByRole("button", { name: "Save work", exact: true });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await expect(form.getByRole("button", { name: "Save & add another", exact: true })).toBeVisible();
  await expect(form.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
});
