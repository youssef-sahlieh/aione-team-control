import { test, expect } from "@playwright/test";

// Needs review, administrators: every open pull request that names a ticket and needs a review, grouped by ticket, with the
// longest wait first. Search and filters narrow it; a failed read is never shown as an empty queue. A developer keeps the
// personal list, and never asks for the administrators' queue.
const queue = (over = {}) => ({
  configured: true, syncedAt: "2026-11-08T11:00:00Z", syncError: "", ticketsError: "", reviewers: ["Lee"], clients: ["Acme", "Beta"],
  counts: { tickets: 2, prs: 3 },
  tickets: [
    { key: "AION-71", title: "Forecourt opening cash", status: "In Review", assignee: "Dev One", client: "Acme", subClient: "Till", since: "2026-11-01T10:00:00Z", prs: [
      { id: "acme/web#12", repo: "acme/web", number: 12, title: "Fix opening cash", url: "https://github.example.invalid/acme/web/pull/12", author: "dev-two", state: "changes_requested", reason: "", since: "2026-11-02T10:00:00Z", reviewers: [{ name: "Lee", login: "lee" }] },
      { id: "acme/api#7", repo: "acme/api", number: 7, title: "Cash drawer totals", url: "https://github.example.invalid/acme/api/pull/7", author: "dev-one", state: "awaiting", reason: "new_commits", since: "2026-11-01T10:00:00Z", reviewers: [] }
    ] },
    { key: "AION-84", title: "Refund rounding", status: "To Do", assignee: "", client: "Beta", subClient: "", since: "2026-11-06T10:00:00Z", prs: [
      { id: "acme/web#15", repo: "acme/web", number: 15, title: "Round refunds", url: "https://github.example.invalid/acme/web/pull/15", author: "dev-two", state: "awaiting", reason: "", since: "2026-11-06T10:00:00Z", reviewers: [] }
    ] }
  ],
  ...over
});

async function mockReviews(page, { role = "admin", queueBody = queue(), queueStatus = 200 } = {}) {
  const calls = { queue: 0, me: 0 };
  const email = role === "admin" ? "admin@example.invalid" : "user@example.invalid";
  await page.addInitScript(({ role, email }) => { localStorage.setItem("aione-session", JSON.stringify({ token: "t", email, expiresAt: Date.now() + 3600000, role })); }, { role, email });
  await page.route("**/*", (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname;
    if (path === "/config") return route.fulfill({ json: { site: "https://jira.example.invalid", project: "AION", people: { builder: { id: "acc-b", name: "Builder" } }, devs: ["builder"], role, dev: "builder", email, accounts: true, odoo: false, mail: false, ai: { enabled: false } } });
    if (path === "/jira/search") return route.fulfill({ json: { issues: [], isLast: true } });
    if (path === "/reviews/queue") { calls.queue++; return queueStatus === 200 ? route.fulfill({ json: queueBody }) : route.fulfill({ status: queueStatus, json: { code: "unavailable", error: "Proxy is down. Try again." } }); }
    if (path === "/reviews/me") { calls.me++; return route.fulfill({ json: { items: [], prError: "" } }); }
    if (path === "/reviews/ticket") return route.fulfill({ json: { pr: null, ticket: { key: "AION-84", title: "Refund rounding", status: "To Do", priority: "High", type: "Bug", epic: "", assignee: "", reporter: "Ellen", devs: ["builder"], due: null, created: "2026-10-01T10:00:00.000+0000", updated: "2026-10-14T10:00:00.000+0000", description: "Rounds the refund down.", attachments: [], comments: [], commentsTotal: 0 } } });
    if (path === "/internal") return route.fulfill({ json: { tickets: [] } });
    if (path === "/date-requests") return route.fulfill({ json: { requests: [] } });
    if (path === "/inbox") return route.fulfill({ json: { items: [], seenAt: null, readTickets: [] } });
    return route.fulfill({ json: {} });
  });
  return calls;
}

test("an administrator sees every open pull request that waits on a ticket, longest wait first, with the counts", async ({ page }) => {
  await mockReviews(page);
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.locator("#page-heading")).toHaveText("Needs review");
  await expect(page.locator(".queue-summary .queue-count").nth(0)).toHaveText("2 tickets");
  await expect(page.locator(".queue-summary .queue-count").nth(1)).toHaveText("3 pull requests");
  await expect(page.locator(".queue-ticket").first()).toContainText("AION-71");
  await expect(page.locator("#nav-review-count")).toHaveText("2");
  await expect(page.locator(".review-status.changes_requested")).toHaveText("Changes requested");
  await expect(page.locator(".review-status.awaiting")).toHaveCount(2);
  await expect(page.getByText("New commits since changes were requested")).toBeVisible();
  await expect(page.locator(".queue-none")).toHaveText(["No reviewer assigned", "No reviewer assigned"]);
  await expect(page.getByRole("link", { name: "Open PR" }).first()).toHaveAttribute("href", "https://github.example.invalid/acme/web/pull/12");
});

test("search and the filters narrow the queue, and Clear filters brings it back", async ({ page }) => {
  await mockReviews(page);
  await page.goto("/dashboard.html?page=reviews");
  const search = page.getByRole("searchbox", { name: "Search the review queue" });
  await search.fill("refund");
  await expect(page.locator(".queue-ticket")).toHaveCount(1);
  await expect(page.locator(".queue-ticket")).toContainText("AION-84");
  await search.fill("nothing matches this");
  await expect(page.getByText("No pull requests match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(page.locator(".queue-ticket")).toHaveCount(2);
  await page.getByRole("combobox", { name: "Reviewer" }).selectOption("__none");
  await expect(page.locator(".queue-pr")).toHaveCount(2);
  await expect(page.locator(".queue-summary .queue-count").nth(1)).toHaveText("2 pull requests");
});

test("a read that fails is shown as a failure, never as an empty queue", async ({ page }) => {
  await mockReviews(page, { queueStatus: 503 });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.getByText(/The review queue couldn't be loaded:/)).toBeVisible();
  await expect(page.getByText("Nothing needs review right now.")).toHaveCount(0);
});

test("a sync failure with no pull requests says the list can't be trusted, not that nothing needs review", async ({ page }) => {
  await mockReviews(page, { queueBody: queue({ syncError: "GitHub is busy.", tickets: [], counts: { tickets: 0, prs: 0 } }) });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.getByText("Pull requests couldn't be refreshed, so this list may be out of date. GitHub is busy.")).toBeVisible();
  await expect(page.getByText("Nothing needs review right now.")).toHaveCount(0);
});

test("when GitHub isn't set up, the page says so", async ({ page }) => {
  await mockReviews(page, { queueBody: queue({ configured: false, tickets: [], counts: { tickets: 0, prs: 0 } }) });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.getByText("Pull requests aren't connected, so no reviews can be listed.")).toBeVisible();
  await expect(page.locator("#nav-review-count")).toBeHidden();
});

test("Open ticket shows the ticket read-only, with no way to save changes", async ({ page }) => {
  await mockReviews(page);
  await page.goto("/dashboard.html?page=reviews");
  await page.locator(".queue-ticket").nth(1).getByRole("button", { name: "Open ticket" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Read-only.");
  await expect(dialog).toContainText("Rounds the refund down.");
  await expect(dialog.getByRole("button", { name: "Save" })).toHaveCount(0);
});

test("a developer keeps the personal list and never asks for the administrators' queue", async ({ page }) => {
  const calls = await mockReviews(page, { role: "user" });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.getByText("Nothing needs your review right now.")).toBeVisible();
  expect(calls.me).toBeGreaterThan(0);
  expect(calls.queue).toBe(0);
  await expect(page.locator("#nav-review-count")).toBeHidden();
});
