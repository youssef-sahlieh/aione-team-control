import { test, expect } from "@playwright/test";

// Followers of a synthetic Odoo Helpdesk ticket. Every request is intercepted: the followers and the contacts live in
// this file, so nothing reaches Odoo, and no subscription or notification is sent.
const odooTicket = { key: "HD-300", id: 300, ref: "300", odoo: true, summary: "Synthetic Odoo request", status: "In Progress", statusCat: "indeterminate", devs: ["builder"], developerName: "Builder", customer: { name: "Ariel Amiri", email: "ariel@example.invalid" }, team: "ai1 | Support", priority: "Medium", created: "2026-10-09T08:00:00Z", updated: "2026-10-10T08:00:00Z", closed: "", due: null, url: "https://odoo.example.invalid/web#id=300&model=helpdesk.ticket&view_type=form" };
const contacts = [
  { id: 31, name: "Karim Ali", email: "karim@example.invalid" },
  { id: 33, name: "Dana Haddad", email: "dana@example.invalid" },
  { id: 34, name: "Layla Nasser", email: "layla@example.invalid" },
];

async function open(page, { role = "admin", followers = [{ id: 33, name: "Dana Haddad", email: "dana@example.invalid" }] } = {}) {
  const state = { followers: followers.map((f) => ({ ...f })), posts: [], searches: [], errors: [], failNext: null };
  page.on("pageerror", (e) => state.errors.push(e.message));
  await page.addInitScript((role) => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "boss@example.invalid", expiresAt: Date.now() + 3600000, role }));
  }, role);
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname, method = req.method();
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    const json = (v, status = 200) => route.fulfill({ status, json: v });
    if (path === "/config") return json({
      site: "https://jira.example.invalid", project: "AION", people: {}, devs: ["builder", "reviewer"],
      devNames: { builder: "Builder", reviewer: "Reviewer" }, role, dev: role === "admin" ? "" : "builder",
      email: "boss@example.invalid", name: "Synthetic Admin", accounts: true, odoo: true, mail: false,
      ai: { enabled: false }, capabilities: ["ticket-business-v1", "agreed-hours-v1"],
    });
    if (path === "/odoo/tickets" && method === "GET") return json({ tickets: [odooTicket] });
    if (path === "/odoo/tickets/HD-300" && method === "GET") return json({ ticket: odooTicket, description: "<p>Customer description</p>", attachments: [], messages: [], stages: [{ id: 1, name: "New", cat: "new" }, { id: 2, name: "In Progress", cat: "indeterminate" }] });
    if (path === "/odoo/tickets/HD-300/followers" && method === "GET") return json({ followers: state.followers });
    if (path === "/odoo/tickets/HD-300/followers/search" && method === "GET") {
      const q = url.searchParams.get("q") || "";
      state.searches.push(q);
      const rows = contacts.filter((c) => (c.name + " " + c.email).toLowerCase().includes(q.toLowerCase()))
        .map((c) => ({ ...c, following: state.followers.some((f) => f.id === c.id) }));
      return json({ contacts: rows, hasMore: false });
    }
    if (path === "/odoo/tickets/HD-300/followers" && method === "POST") {
      state.posts.push(body);
      const failure = state.failNext;
      state.failNext = null;
      if (failure?.apply) for (const id of body.partnerIds) if (!state.followers.some((f) => f.id === id)) state.followers.push({ ...contacts.find((c) => c.id === id) });
      if (failure) return json(failure.body, failure.status);
      for (const id of body.partnerIds) if (!state.followers.some((f) => f.id === id)) state.followers.push({ ...contacts.find((c) => c.id === id) });
      return json({ followers: state.followers, added: body.partnerIds.length });
    }
    if (path === "/time-entries" && method === "GET") return json({ ticket: url.searchParams.get("ticket"), source: "odoo", closed: false, logging: false, canLog: false, today: "2026-10-11", maxMinutes: 1440, lockDate: null, entries: [], summary: { entries: 0, loggedMinutes: 0, confirmedMinutes: 0, pendingMinutes: 0, unsynced: 0 }, baselineHours: null, totalHours: 0 });
    if (path === "/jira/search") return json({ issues: [], isLast: true });
    if (path === "/date-requests") return json({ requests: [] });
    if (path === "/clients") return json({ revision: 1, entries: [] });
    if (path === "/clients/odoo-projects/options") return json({ syncedAt: Date.now(), projects: [] });
    if (path === "/ticket-metadata/batch") return json({ records: {} });
    if (method === "GET") return json({ issues: [], tickets: [], isLast: true, records: {}, entries: [], requests: [], revision: 1 });
    return json({ code: "forbidden", error: "Unconfigured test request" }, 403);
  });
  await page.goto("http://127.0.0.1:4173/dashboard.html#HD-300");
  await expect(page.locator(".fol-btn")).toContainText(String(state.followers.length));
  return state;
}

const dialog = (page) => page.locator("dialog.followers-dialog");
const search = (page) => page.getByLabel("Search contacts by name or email");
const pick = (page, name) => dialog(page).locator(".fol-pick").filter({ hasText: name });

test("the ticket shows a Followers count, and the list has names, emails and an Add followers action", async ({ page }) => {
  const s = await open(page);
  await expect(page.locator(".fol-btn")).toContainText("(1)");
  await page.locator(".fol-btn").click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("heading", { name: "Followers" })).toBeVisible();
  await expect(dialog(page)).toContainText("Dana Haddad");
  await expect(dialog(page)).toContainText("dana@example.invalid");
  await expect(dialog(page).getByRole("button", { name: "Add followers" })).toBeFocused();
  expect(s.errors).toEqual([]);
});

test("no followers yet: the dialog says so, and the count shows zero", async ({ page }) => {
  await open(page, { followers: [] });
  await expect(page.locator(".fol-btn")).toContainText("(0)");
  await page.locator(".fol-btn").click();
  await expect(dialog(page)).toContainText("Nobody is following this ticket yet.");
});

test("adding: search by name or email, an existing follower can't be picked, chips can be removed, and only new contacts are sent", async ({ page }) => {
  const s = await open(page);
  await page.locator(".fol-btn").click();
  await dialog(page).getByRole("button", { name: "Add followers" }).click();
  await expect(search(page)).toBeFocused();
  // One letter is too short: nothing is searched.
  await search(page).pressSequentially("d");
  await expect(dialog(page)).toContainText("Type at least 2 letters");
  expect(s.searches).toEqual([]);
  // Typing is debounced into one search.
  await search(page).pressSequentially("ana");
  await expect(pick(page, "Dana Haddad")).toBeVisible();
  await expect(pick(page, "Dana Haddad")).toBeDisabled();
  await expect(pick(page, "Dana Haddad")).toContainText("Already following");
  expect(s.searches).toEqual(["dana"]);
  await search(page).fill("karim");
  await pick(page, "Karim Ali").click();
  await expect(pick(page, "Karim Ali")).toHaveAttribute("aria-pressed", "true");
  await search(page).fill("layla");
  await pick(page, "Layla Nasser").click();
  await expect(dialog(page).getByRole("group", { name: "Chosen contacts" })).toContainText("Karim Ali");
  await expect(dialog(page).getByRole("group", { name: "Chosen contacts" })).toContainText("Layla Nasser");
  await dialog(page).getByRole("button", { name: "Remove Layla Nasser" }).click();
  await expect(pick(page, "Layla Nasser")).toHaveAttribute("aria-pressed", "false");
  await pick(page, "Layla Nasser").click();
  const send = dialog(page).getByRole("button", { name: "Add and close" });
  await expect(dialog(page)).toContainText("Off: the contacts are added to the followers list without the invitation email.");
  await send.click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator(".fol-btn")).toContainText("(3)");
  expect(s.posts).toEqual([{ partnerIds: [31, 34], notify: false }]);
  expect(s.errors).toEqual([]);
});

test("notify: unchecked by default, and when checked the request says so and the warning explains the email", async ({ page }) => {
  const s = await open(page);
  await page.locator(".fol-btn").click();
  await dialog(page).getByRole("button", { name: "Add followers" }).click();
  await search(page).fill("karim");
  await pick(page, "Karim Ali").click();
  const box = dialog(page).getByLabel("Notify newly added followers");
  await expect(box).not.toBeChecked();
  await box.check();
  await expect(dialog(page)).toContainText("On: Odoo emails the new followers");
  await dialog(page).getByRole("button", { name: "Add and close" }).click();
  await expect(dialog(page)).toBeHidden();
  expect(s.posts).toEqual([{ partnerIds: [31], notify: true }]);
});

test("Escape closes the dialog and returns focus to the Followers button", async ({ page }) => {
  await open(page);
  await page.locator(".fol-btn").click();
  await dialog(page).getByRole("button", { name: "Add followers" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator(".fol-btn")).toBeFocused();
  // Escape closed only the dialog: the ticket drawer behind it stays open.
  await expect(page.locator("#drawer")).toBeVisible();
});

test("keyboard: the contacts are reachable with Tab and picked with Enter", async ({ page }) => {
  const s = await open(page);
  await page.locator(".fol-btn").click();
  await dialog(page).getByRole("button", { name: "Add followers" }).click();
  await search(page).fill("karim");
  await expect(pick(page, "Karim Ali")).toBeVisible();
  await search(page).press("Tab");
  await expect(pick(page, "Karim Ali")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(pick(page, "Karim Ali")).toHaveAttribute("aria-pressed", "true");
  await expect(pick(page, "Karim Ali")).toBeFocused();
  expect(s.posts).toEqual([]);
});

test("a refused change shows Odoo's reason and keeps the chosen contacts", async ({ page }) => {
  const s = await open(page);
  s.failNext = { status: 403, body: { code: "odoo", error: "You are not allowed to follow this ticket." } };
  await page.locator(".fol-btn").click();
  await dialog(page).getByRole("button", { name: "Add followers" }).click();
  await search(page).fill("karim");
  await pick(page, "Karim Ali").click();
  await dialog(page).getByRole("button", { name: "Add and close" }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("You are not allowed to follow this ticket.");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("group", { name: "Chosen contacts" })).toContainText("Karim Ali");
  await expect(dialog(page).getByRole("button", { name: "Add and close" })).toBeEnabled();
  expect(s.errors).toEqual([]);
});

test("a double click sends one request", async ({ page }) => {
  const s = await open(page);
  await page.locator(".fol-btn").click();
  await dialog(page).getByRole("button", { name: "Add followers" }).click();
  await search(page).fill("karim");
  await pick(page, "Karim Ali").click();
  await dialog(page).getByRole("button", { name: "Add and close" }).dblclick();
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator(".fol-btn")).toContainText("(2)");
  expect(s.posts).toHaveLength(1);
});

test("an unconfirmed answer reloads the real list and keeps the chosen contacts", async ({ page }) => {
  const s = await open(page);
  // Odoo saved the change, but the answer was lost.
  s.failNext = { apply: true, status: 502, body: { code: "odoo_unknown", error: "Odoo didn't confirm the change. Reload the followers before trying again." } };
  await page.locator(".fol-btn").click();
  await dialog(page).getByRole("button", { name: "Add followers" }).click();
  await search(page).fill("karim");
  await pick(page, "Karim Ali").click();
  await dialog(page).getByRole("button", { name: "Add and close" }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("didn’t confirm the change");
  await expect(dialog(page).getByRole("group", { name: "Chosen contacts" })).toContainText("Karim Ali");
  await expect(page.locator(".fol-btn")).toContainText("(2)");
  expect(s.posts).toHaveLength(1);
});

test("on a phone the dialog fits the screen and the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.locator(".fol-btn").click();
  await dialog(page).getByRole("button", { name: "Add followers" }).click();
  const box = await dialog(page).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
