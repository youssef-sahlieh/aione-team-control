import { test, expect } from "@playwright/test";

// The top bar and sidebar the dashboard shares with the pages beside it: the bell (with its unread count) and AIONE AI are
// on every page, once; the AI conversation carries on from page to page; the sidebar counts (All tickets, Date requests,
// Needs review) show the last known numbers straight away on every page and never drop to zero while they refresh.
async function mockApp(page, { datesDelay = 0, pendingDates = 1 } = {}) {
  const calls = { chat: [], dates: 0 };
  await page.addInitScript(() => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "t", email: "admin@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" }));
  });
  const issue = (key, cat) => ({ key, fields: { summary: "Ticket " + key, status: { name: cat === "done" ? "Done" : "To Do", statusCategory: { key: cat } }, labels: ["ai1_builder"], assignee: { accountId: "acc-b", displayName: "Builder" }, updated: "2026-10-14T10:00:00.000+0000", created: "2026-10-01T10:00:00.000+0000" } });
  const request = (key, status) => ({ id: key, key, status, requester: { email: "dev@example.invalid", name: "Dev" }, createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T10:00:00Z", proposedDue: "2026-11-20", reason: "More time" });
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname, json = (v) => route.fulfill({ json: v });
    if (path === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people: { builder: { id: "acc-b", name: "Builder" } }, devs: ["builder"], role: "admin", dev: "", email: "admin@example.invalid", name: "Ada Admin", accounts: true, odoo: false, mail: false, ai: { enabled: true } });
    if (path === "/jira/search") return json({ issues: [issue("AION-1", "new"), issue("AION-2", "indeterminate"), issue("AION-3", "new"), issue("AION-4", "done")], isLast: true });
    if (path === "/internal") return json({ tickets: [] });
    if (path === "/date-requests") {
      calls.dates++;
      if (datesDelay && calls.dates > 1) await new Promise((r) => setTimeout(r, datesDelay));
      return json({ requests: [...Array.from({ length: calls.dates > 1 ? pendingDates : 1 }, (_, i) => request("AION-" + (i + 1), "pending")), request("AION-9", "approved")] });
    }
    if (path === "/reviews/queue") return json({ configured: true, syncedAt: "2026-11-08T11:00:00Z", syncError: "", ticketsError: "", reviewers: [], clients: [], counts: { tickets: 2, prs: 2 }, tickets: [] });
    if (path === "/inbox") return json({ seenAt: "2026-11-01T00:00:00.000Z", readTickets: [], items: [
      { id: "m1", type: "mention", key: "AION-1", title: "Ticket AION-1", by: "Lee", text: "Can you look?", at: "2026-11-08T10:00:00Z", read: false },
      { id: "m2", type: "note", key: "AION-2", title: "Ticket AION-2", by: "Lee", text: "Note", at: "2026-11-08T09:00:00Z", read: false }
    ] });
    if (path === "/ai/chat") { const body = req.postDataJSON(); calls.chat.push(body); return json({ answer: "Answer to: " + body.message, references: [] }); }
    if (path === "/users") return json({ users: [] });
    return json({});
  });
  return calls;
}

test("the bell, its unread count and AIONE AI are in the top bar of every page, once", async ({ page }) => {
  await mockApp(page);
  for (const path of ["/dashboard.html", "/dashboard.html?page=requests", "/users.html"]) {
    await page.goto(path);
    await expect(page.locator("#inbox-count")).toHaveText("2");
    await expect(page.locator("#inbox-btn")).toHaveAttribute("aria-label", "Notifications, 2 unread");
    await expect(page.locator("#ai-launcher")).toBeVisible();
    await expect(page.locator("#ai-launcher, #inbox-btn, #ai-panel")).toHaveCount(3);
    await expect(page.locator(".app-topbar")).toHaveCount(1);
  }
  // On the Users page the bell opens its list, and a notification opens the ticket on the dashboard.
  await page.locator("#inbox-btn").click();
  await expect(page.locator("#inbox-panel")).toContainText("Lee mentioned you");
  await page.locator("#inbox-panel .inbox-item").first().click();
  await expect(page).toHaveURL(/dashboard\.html#AION-1$/);
});

test("the AI conversation carries on from the dashboard to another page and after a reload", async ({ page }) => {
  const calls = await mockApp(page);
  await page.goto("/dashboard.html");
  await page.locator("#ai-launcher").click();
  await page.locator("#ai-question").fill("What is due this week?");
  await page.locator("#ai-send").click();
  await expect(page.locator("#ai-messages")).toContainText("Answer to: What is due this week?");
  await page.goto("/users.html");
  await page.locator("#ai-launcher").click();
  await expect(page.locator("#ai-messages .ai-message")).toHaveCount(2);
  await expect(page.locator("#ai-messages")).toContainText("Answer to: What is due this week?");
  await page.locator("#ai-question").fill("And next week?");
  await page.locator("#ai-send").click();
  await expect(page.locator("#ai-messages")).toContainText("Answer to: And next week?");
  expect(calls.chat[1].history.map((h) => h.content)).toEqual(["What is due this week?", "Answer to: What is due this week?"]);
  await page.reload();
  await page.locator("#ai-launcher").click();
  await expect(page.locator("#ai-messages .ai-message")).toHaveCount(4);
  // New chat starts over, here and on the next page.
  await page.locator("#ai-new").click();
  await page.goto("/dashboard.html");
  await page.locator("#ai-launcher").click();
  await expect(page.locator("#ai-messages .ai-message")).toHaveCount(0);
});

test("the sidebar counts show on every page straight away, and never as zero while they refresh", async ({ page }) => {
  await mockApp(page, { datesDelay: 1500, pendingDates: 3 });
  await page.goto("/dashboard.html");
  await expect(page.locator("#nav-ticket-count")).toHaveText("3");
  await expect(page.locator("#nav-date-count")).toHaveText("1");
  await expect(page.locator("#nav-review-count")).toHaveText("2");
  // Users page: the dashboard's counts at once, while the date requests are read again in the background.
  await page.goto("/users.html");
  await expect(page.locator("#nav-ticket-count")).toHaveText("3");
  await expect(page.locator("#nav-date-count")).toHaveText("1");
  await expect(page.locator("#nav-review-count")).toHaveText("2");
  await expect(page.locator("#nav-date-count")).toHaveText("3");
  await expect(page.locator("#nav-ticket-count")).toHaveText("3");
  // Back on the dashboard the new date count is there before the dashboard has loaded its own.
  await page.goto("/dashboard.html?page=calendar");
  const first = await page.locator("#nav-date-count").textContent();
  expect(first).toBe("3");
  await expect(page.locator("#nav-ticket-count")).toHaveText("3");
});
