import { test, expect } from "@playwright/test";

// Needs review, administrators: every open pull request that names a ticket and needs a review, grouped by ticket, with the
// longest real review wait first. Search and filters narrow it on the page; a failed read is never shown as an empty
// queue, and a partly failed refresh keeps the last results with a short warning. A developer keeps the personal list,
// and never asks for the administrators' queue. Everything here is mocked: no GitHub, Jira or proxy is reached.
const NOW = new Date("2026-11-08T12:00:00Z");
const LONG_TITLE = "Forecourt opening cash is counted twice when the shift starts before midnight and the till was reopened after a power cut";
const shared = { id: "acme/web#20", repo: "acme/web", number: 20, title: "Shared rounding helper", url: "https://github.example.invalid/acme/web/pull/20", author: "dev-one", created: "2026-11-01T09:00:00Z", state: "awaiting", reason: "", since: "2026-11-03T10:00:00Z", sinceKind: "requested", reviewerState: "pending", stale: false, statusAt: "2026-11-08T11:00:00Z",
  reviewers: [{ name: "Mobile", login: "", kind: "team", review: "", pending: true }, { name: "Lee", login: "lee", kind: "user", review: "", pending: true }, { name: "Sam", login: "sam", kind: "user", review: "", pending: true }, { name: "Ana", login: "ana", kind: "user", review: "", pending: true }] };
const queue = (over = {}) => ({
  configured: true, syncedAt: "2026-11-08T11:00:00Z", syncError: "Couldn't list pull requests for acme/mobile: GitHub answered 502", ticketsError: "", reviewers: ["Ana", "Lee", "Mobile", "Sam"], clients: ["Acme", "Beta"],
  counts: { tickets: 3, prs: 5 },
  refresh: { attemptedAt: "2026-11-08T11:00:00Z", okAt: "2026-11-08T10:00:00Z", repos: 3, failedRepos: 1, failures: [{ repo: "acme/mobile", stage: "list", error: "GitHub answered 502", lastOkAt: "2026-11-07T09:00:00Z" }] },
  tickets: [
    { key: "AION-71", title: LONG_TITLE, status: "In Review", ticketDone: false, assignee: "Dev One", devs: ["Builder"], client: "Acme", subClient: "Till", since: "2026-11-01T10:00:00Z", sinceKind: "commit", prs: [
      { id: "acme/api#7", repo: "acme/api", number: 7, title: "Cash drawer totals", url: "https://github.example.invalid/acme/api/pull/7", author: "dev-one", created: "2026-10-20T10:00:00Z", state: "awaiting", reason: "new_commits", since: "2026-11-01T10:00:00Z", sinceKind: "commit", reviewers: [], reviewerState: "none", stale: false, statusAt: "2026-11-08T11:00:00Z" },
      shared,
      { id: "acme/web#12", repo: "acme/web", number: 12, title: "Fix opening cash", url: "https://github.example.invalid/acme/web/pull/12", author: "dev-two", created: "2026-10-25T10:00:00Z", state: "changes_requested", reason: "", since: "2026-11-02T10:00:00Z", sinceKind: "changes", reviewers: [{ name: "Lee", login: "lee", kind: "user", review: "CHANGES_REQUESTED", pending: false }], reviewerState: "given", stale: false, statusAt: "2026-11-08T11:00:00Z" }
    ] },
    { key: "AION-84", title: "Refund rounding", status: "To Do", ticketDone: false, assignee: "", devs: [], client: "Beta", subClient: "", since: "2026-11-03T10:00:00Z", sinceKind: "requested", prs: [
      shared,
      { id: "acme/web#15", repo: "acme/web", number: 15, title: "Round refunds", url: "https://github.example.invalid/acme/web/pull/15", author: "dev-two", created: "2026-10-06T10:00:00Z", state: "awaiting", reason: "", since: "2026-10-06T10:00:00Z", sinceKind: "opened", reviewers: [], reviewerState: "none", stale: false, statusAt: "2026-11-08T11:00:00Z" }
    ] },
    { key: "AION-90", title: "Old export", status: "Done", ticketDone: true, assignee: "Dev One", devs: [], client: "", subClient: "", since: "", sinceKind: "", prs: [
      { id: "acme/mobile#3", repo: "acme/mobile", number: 3, title: "Export follow-up", url: "javascript:alert(1)", author: "", created: null, state: "unknown", reason: "", since: "", sinceKind: "", reviewers: [], reviewerState: "unavailable", stale: true, statusAt: null }
    ] }
  ],
  ...over
});
const healthy = (over = {}) => queue({ syncError: "", refresh: { attemptedAt: "2026-11-08T11:00:00Z", okAt: "2026-11-08T11:00:00Z", repos: 3, failedRepos: 0, failures: [] }, ...over });

// queueBody: an answer, or a function of the call (n from 1, forced: ?refresh=1) that returns { status, json, delay }.
async function mockReviews(page, { role = "admin", queueBody = queue(), queueStatus = 200 } = {}) {
  const calls = { queue: 0, forced: 0, me: 0, writes: 0 };
  const email = role === "admin" ? "admin@example.invalid" : "user@example.invalid";
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(({ role, email }) => { localStorage.setItem("aione-session", JSON.stringify({ token: "t", email, expiresAt: Date.now() + 3600000, role })); }, { role, email });
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname;
    if (req.method() !== "GET" && path.startsWith("/reviews")) calls.writes++;
    if (path === "/config") return route.fulfill({ json: { site: "https://jira.example.invalid", project: "AION", people: { builder: { id: "acc-b", name: "Builder" } }, devs: ["builder"], role, dev: "builder", email, accounts: true, odoo: false, mail: false, ai: { enabled: false } } });
    if (path === "/jira/search") return route.fulfill({ json: { issues: [], isLast: true } });
    if (path === "/reviews/queue") {
      calls.queue++;
      const forced = url.searchParams.get("refresh") === "1";
      if (forced) calls.forced++;
      if (typeof queueBody === "function") {
        const r = queueBody(calls.queue, forced);
        if (r.delay) await new Promise((done) => setTimeout(done, r.delay));
        return r.status && r.status !== 200 ? route.fulfill({ status: r.status, json: { code: "unavailable", error: "Proxy is down. Try again." } }) : route.fulfill({ json: r.json });
      }
      return queueStatus === 200 ? route.fulfill({ json: queueBody }) : route.fulfill({ status: queueStatus, json: { code: "unavailable", error: "Proxy is down. Try again." } });
    }
    if (path === "/reviews/me") { calls.me++; return route.fulfill({ json: { items: [], prError: "" } }); }
    if (path === "/reviews/ticket") return route.fulfill({ json: { pr: null, ticket: { key: "AION-84", title: "Refund rounding", status: "To Do", priority: "High", type: "Bug", epic: "", assignee: "", reporter: "Ellen", devs: ["builder"], due: null, created: "2026-10-01T10:00:00.000+0000", updated: "2026-10-14T10:00:00.000+0000", description: "Rounds the refund down.", attachments: [], comments: [], commentsTotal: 0 } } });
    if (path === "/internal") return route.fulfill({ json: { tickets: [] } });
    if (path === "/date-requests") return route.fulfill({ json: { requests: [] } });
    if (path === "/inbox") return route.fulfill({ json: { items: [], seenAt: null, readTickets: [] } });
    return route.fulfill({ json: {} });
  });
  return calls;
}

const ticket = (page, key) => page.locator(".queue-ticket").filter({ has: page.locator(".queue-key", { hasText: key }) });
const prRow = (page, ref) => page.locator(".queue-pr").filter({ has: page.locator(".queue-repo", { hasText: ref }) });
const stat = (page, label) => page.locator(".queue-stat").filter({ hasText: label }).locator("b");

test("an administrator sees the tickets grouped with their pull requests, longest real wait first, with honest counts", async ({ page }) => {
  const calls = await mockReviews(page, { queueBody: healthy() });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.locator("#page-heading")).toHaveText("Needs review");
  await expect(page.locator("#page-description")).toHaveText("Open pull requests linked to tickets that still need a review. Tickets open read-only.");
  // A pull request on two tickets counts once: 5 distinct pull requests across 3 tickets.
  await expect(stat(page, "open pull requests")).toHaveText("5");
  await expect(stat(page, "linked tickets")).toHaveText("3");
  await expect(stat(page, "no reviewer")).toHaveText("2");
  await expect(stat(page, "changes requested")).toHaveText("1");
  await expect(stat(page, "review data unavailable")).toHaveText("1");
  await expect(page.locator(".queue-stats-scope")).toHaveText("All pull requests in the queue");
  await expect(page.locator(".queue-showing")).toHaveText("Showing 3 tickets · 5 pull requests");
  await expect(page.locator(".queue-updated")).toContainText("Last successful update");
  await expect(page.locator("#nav-review-count")).toHaveText("3");
  await expect(page.locator(".queue-ticket .queue-key")).toHaveText(["AION-71", "AION-84", "AION-90"]);
  await expect(ticket(page, "AION-71").locator(".queue-repo")).toHaveText(["acme/api#7", "acme/web#20", "acme/web#12"]);
  await expect(page.locator(".queue-alert")).toHaveCount(0);

  // The ticket header: the full title wraps, the ticket's status is not the pull request's, and who works on it is named.
  const t71 = ticket(page, "AION-71");
  await expect(t71.locator(".queue-ticket-title")).toContainText(LONG_TITLE);
  await expect(t71.locator(".ticket-status")).toHaveText("Ticket: In Review");
  await expect(t71).toContainText("Acme › Till");
  await expect(t71).toContainText("Assignee: Dev One");
  await expect(t71).toContainText("Developer: Builder");
  await expect(t71.locator(".queue-pr-count")).toHaveText("3 PRs");
  await expect(ticket(page, "AION-84")).toContainText("Assignee: Unassigned");

  // A closed ticket with an open pull request stays, and says so; a ticket without a project mapping says that too.
  const t90 = ticket(page, "AION-90");
  await expect(t90.locator(".ticket-status")).toHaveText("Ticket: Done");
  await expect(t90.locator(".queue-closed-note")).toHaveText("Ticket closed · PR still open");
  await expect(t90).toContainText("No project mapped");

  // Pull request rows: state, reason, reviewers (teams included) and what the time means.
  await expect(prRow(page, "acme/web#12").first().locator(".review-status")).toHaveText("Changes requested");
  await expect(prRow(page, "acme/web#12").first()).toContainText("Lee · changes requested");
  await expect(prRow(page, "acme/api#7").locator(".review-status")).toHaveText("Awaiting review");
  await expect(prRow(page, "acme/api#7")).toContainText("New commits since changes were requested");
  await expect(prRow(page, "acme/api#7").locator(".queue-none")).toHaveText("No reviewer requested");
  await expect(prRow(page, "acme/api#7").locator(".queue-wait-label")).toHaveText("Waiting since new commits");
  await expect(prRow(page, "acme/api#7").locator(".queue-wait.long time")).toHaveText("7 days");
  const sharedRow = prRow(page, "acme/web#20").first();
  await expect(sharedRow.locator(".queue-wait-label")).toHaveText("Waiting for review");
  await expect(sharedRow.locator("time")).toHaveText("5 days");
  await expect(sharedRow.locator("time")).toHaveAttribute("datetime", "2026-11-03T10:00:00Z");
  await expect(sharedRow.locator("time")).toHaveAttribute("title", /3 Nov 2026/);
  await expect(sharedRow).toContainText("Mobile (team) · requested, Lee · requested, Sam · requested");
  // Without a known request time, the age of the pull request is shown as such, never as a long review wait.
  await expect(prRow(page, "acme/web#15").locator(".queue-wait-label")).toHaveText("PR age");
  await expect(prRow(page, "acme/web#15").locator(".queue-wait.long")).toHaveCount(0);

  // Unknown review data is never called awaiting; no time and no safe link are said in words.
  const unknown = prRow(page, "acme/mobile#3");
  await expect(unknown.locator(".review-status")).toHaveText("Review information unavailable");
  await expect(unknown.locator(".queue-none").first()).toHaveText("Reviewer data unavailable");
  await expect(unknown.locator(".queue-wait-label")).toHaveText("Waiting time unknown");
  await expect(unknown.locator(".queue-stale")).toHaveText("Last known");
  await expect(unknown).toContainText("Link unavailable");
  await expect(unknown.getByRole("link")).toHaveCount(0);

  const openPr = page.getByRole("link", { name: "Open pull request acme/web#12 on GitHub (opens in a new tab)" }).first();
  await expect(openPr).toHaveAttribute("href", "https://github.example.invalid/acme/web/pull/12");
  await expect(openPr).toHaveAttribute("target", "_blank");
  await expect(openPr).toHaveAttribute("rel", "noopener noreferrer");
  // Nothing here merges, approves or assigns reviewers.
  for (const name of [/merge/i, /approve/i, /assign/i, /request changes/i]) await expect(page.locator(".queue").getByRole("button", { name })).toHaveCount(0);
  expect(calls.writes).toBe(0);
});

test("long reviewer lists fold into an accessible disclosure", async ({ page }) => {
  await mockReviews(page, { queueBody: healthy() });
  await page.goto("/dashboard.html?page=reviews");
  const more = prRow(page, "acme/web#20").first().locator("details.queue-more");
  await expect(more.locator("summary")).toHaveText("+1 more");
  await expect(more.getByText("Ana · requested")).toBeHidden();
  await more.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(more.getByText("Ana · requested")).toBeVisible();
});

test("a partly failed refresh keeps the last results and says so briefly, with the details folded away", async ({ page }) => {
  const calls = await mockReviews(page);
  await page.goto("/dashboard.html?page=reviews");
  const alert = page.locator(".queue-alert");
  await expect(alert.locator(".queue-alert-title")).toHaveText("Some pull requests could not be refreshed. Showing the last available results.");
  await expect(alert.locator(".queue-alert-facts")).toContainText("Last refresh attempt: 8 Nov 2026");
  await expect(alert.locator(".queue-alert-facts")).toContainText("Last successful update: 8 Nov 2026");
  await expect(alert.locator(".queue-alert-facts")).toContainText("1 of 3 repositories affected");
  // GitHub's message is only in the technical details, which start closed.
  await expect(alert.locator(".queue-alert-title")).not.toContainText("502");
  const details = alert.locator("details.queue-diagnostics");
  await expect(details.getByText(/acme\/mobile — pull request list: GitHub answered 502/)).toBeHidden();
  await details.locator("summary").click();
  await expect(details.getByText(/acme\/mobile — pull request list: GitHub answered 502 \(last read 7 Nov 2026/)).toBeVisible();
  await expect(page.locator(".queue-ticket")).toHaveCount(3);
  await expect(page.getByText("Nothing needs review right now.")).toHaveCount(0);

  const before = calls.forced;
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => calls.forced).toBe(before + 1);
});

test("search, quick filters, menus and sort narrow the list on the page, and Clear filters brings it back", async ({ page }) => {
  const calls = await mockReviews(page, { queueBody: healthy() });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.locator(".queue-ticket")).toHaveCount(3);
  const reads = calls.queue;
  const search = page.getByRole("searchbox", { name: "Search the review queue" });

  await search.fill("acme/api");
  await expect(page.locator(".queue-ticket .queue-key")).toHaveText(["AION-71"]);
  await expect(page.locator(".queue-pr")).toHaveCount(1);
  await expect(page.locator(".queue-showing")).toHaveText("Showing 1 ticket · 1 pull request of 3 · 5");
  await expect(page.locator(".queue-stats-scope")).toHaveText("Counts for the filtered list");
  await expect(stat(page, "open pull request")).toHaveText("1");
  await search.fill("refund");
  await expect(page.locator(".queue-ticket .queue-key")).toHaveText(["AION-84"]);
  await search.fill("nothing matches this");
  await expect(page.getByText("No pull requests match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Remove filter Search: nothing matches this" }).click();
  await expect(search).toHaveValue("");
  await expect(page.locator(".queue-ticket")).toHaveCount(3);

  await page.getByRole("button", { name: "No reviewer", exact: true }).click();
  await expect(page.getByRole("button", { name: "No reviewer", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".queue-repo")).toHaveText(["acme/api#7", "acme/web#15"]);
  await page.locator(".queue-quick").getByRole("button", { name: "Changes requested" }).click();
  await expect(page.locator(".queue-repo")).toHaveText(["acme/web#12"]);
  await page.locator(".queue-quick").getByRole("button", { name: "Review data unavailable" }).click();
  await expect(page.locator(".queue-repo")).toHaveText(["acme/mobile#3"]);
  await page.locator(".queue-quick").getByRole("button", { name: "All" }).click();

  await page.getByRole("combobox", { name: "Reviewer" }).selectOption("Mobile");
  await expect(page.locator(".queue-ticket .queue-key")).toHaveText(["AION-71", "AION-84"]);
  // The shared pull request is under both tickets but counts once.
  await expect(page.locator(".queue-showing")).toContainText("Showing 2 tickets · 1 pull request of 3 · 5");
  await page.getByRole("combobox", { name: "Reviewer" }).selectOption("");
  await page.getByRole("combobox", { name: "Project" }).selectOption("Beta");
  await expect(page.locator(".queue-ticket .queue-key")).toHaveText(["AION-84"]);
  await page.getByRole("combobox", { name: "Repository" }).selectOption("acme/web");
  await page.getByRole("combobox", { name: "Review state" }).selectOption("awaiting");
  await expect(page.locator(".queue-chip", { hasText: "Project: Beta" })).toBeVisible();
  await expect(page.locator(".queue-chip", { hasText: "State: Awaiting review" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".queue-ticket")).toHaveCount(3);
  await expect(page.locator(".queue-active .queue-chip")).toHaveCount(0);

  await page.getByRole("combobox", { name: "Sort" }).selectOption("key");
  await expect(page.locator(".queue-ticket .queue-key")).toHaveText(["AION-71", "AION-84", "AION-90"]);
  await page.getByRole("combobox", { name: "Sort" }).selectOption("recent");
  // Newest first within each ticket; tickets with the same newest time (the shared pull request) fall back to key order.
  await expect(ticket(page, "AION-71").locator(".queue-repo")).toHaveText(["acme/web#20", "acme/web#12", "acme/api#7"]);
  await expect(page.locator(".queue-ticket .queue-key")).toHaveText(["AION-71", "AION-84", "AION-90"]);
  // All of this happened on the page: the queue wasn't read again.
  expect(calls.queue).toBe(reads);
});

test("filters and folded tickets stay through Refresh and the read-only ticket view, and the list stays on screen while it refreshes", async ({ page }) => {
  const calls = await mockReviews(page, { queueBody: (n, forced) => ({ json: healthy(), delay: forced ? 600 : 0 }) });
  await page.goto("/dashboard.html?page=reviews");
  await page.getByRole("searchbox", { name: "Search the review queue" }).fill("AION-7");
  await page.getByRole("combobox", { name: "Sort" }).selectOption("key");
  const toggle = page.getByRole("button", { name: "Pull requests for AION-71" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#queue-prs-AION-71")).toBeHidden();

  const refresh = page.getByRole("button", { name: "Refresh the review queue from GitHub" });
  await refresh.click();
  await expect(refresh).toHaveText("Refreshing…");
  await expect(page.locator(".queue")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".queue-ticket")).toHaveCount(1);
  await expect(refresh).toHaveText("Refresh");
  expect(calls.forced).toBe(1);
  await expect(page.getByRole("searchbox", { name: "Search the review queue" })).toHaveValue("AION-7");
  await expect(page.getByRole("combobox", { name: "Sort" })).toHaveValue("key");
  await expect(page.getByRole("button", { name: "Pull requests for AION-71" })).toHaveAttribute("aria-expanded", "false");

  await page.getByRole("button", { name: "Open ticket AION-71 (read-only)" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Read-only.");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("searchbox", { name: "Search the review queue" })).toHaveValue("AION-7");
  await expect(page.getByRole("button", { name: "Pull requests for AION-71" })).toHaveAttribute("aria-expanded", "false");

  // The page has one Refresh: the dashboard's is hidden here. Its timed reload doesn't rebuild the page either.
  await expect(page.locator("#refresh")).toBeHidden();
  await page.evaluate(() => document.getElementById("refresh").click());
  await expect.poll(() => calls.queue).toBeGreaterThan(2);
  await expect(page.getByRole("searchbox", { name: "Search the review queue" })).toHaveValue("AION-7");
  await expect(page.getByRole("button", { name: "Pull requests for AION-71" })).toHaveAttribute("aria-expanded", "false");
});

test("the ticket groups open and close from the keyboard", async ({ page }) => {
  await mockReviews(page, { queueBody: healthy() });
  await page.goto("/dashboard.html?page=reviews");
  const toggle = page.getByRole("button", { name: "Pull requests for AION-84" });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#" + await toggle.getAttribute("aria-controls"))).toBeHidden();
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Open ticket AION-84 (read-only)" })).toBeFocused();
});

test("wide screens line the pull request columns up; narrow screens stack them without scrolling sideways", async ({ page }) => {
  await mockReviews(page, { queueBody: healthy() });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/dashboard.html?page=reviews");
  const row = prRow(page, "acme/web#15");
  await expect(page.locator(".queue-cols")).toBeVisible();
  const wide = { main: await row.locator(".queue-pr-main").boundingBox(), state: await row.locator(".queue-state").boundingBox(), wait: await row.locator(".queue-wait").boundingBox() };
  expect(Math.abs(wide.main.y - wide.state.y)).toBeLessThan(4);
  expect(Math.abs(wide.main.y - wide.wait.y)).toBeLessThan(4);
  expect(wide.state.x).toBeGreaterThan(wide.main.x + wide.main.width - 1);
  // The page uses the full width, not the narrow reviewer's column.
  expect((await page.locator(".queue").boundingBox()).width).toBeGreaterThan(1000);

  await page.setViewportSize({ width: 600, height: 900 });
  await expect(page.locator(".queue-cols")).toBeHidden();
  const main = await row.locator(".queue-pr-main").boundingBox(), state = await row.locator(".queue-state").boundingBox();
  expect(state.y).toBeGreaterThan(main.y + main.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a read that fails with nothing to show is a failure with Retry, never an empty queue", async ({ page }) => {
  const calls = await mockReviews(page, { queueBody: (n, forced) => (forced ? { json: healthy() } : { status: 503 }) });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.getByText(/The review queue couldn't be loaded: /)).toBeVisible();
  await expect(page.getByText("Nothing needs review right now.")).toHaveCount(0);
  await expect(page.locator(".queue-stats")).toBeHidden();
  await page.locator(".queue-alert").getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(".queue-ticket")).toHaveCount(3);
  await expect(page.locator(".queue-alert")).toHaveCount(0);
  expect(calls.forced).toBe(1);
});

test("a failed refresh keeps the last list on screen", async ({ page }) => {
  await mockReviews(page, { queueBody: (n, forced) => (forced ? { status: 503 } : { json: healthy() }) });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.locator(".queue-ticket")).toHaveCount(3);
  await page.getByRole("button", { name: "Refresh the review queue from GitHub" }).click();
  await expect(page.getByText("Refresh failed. Showing the last available results.")).toBeVisible();
  await expect(page.locator(".queue-ticket")).toHaveCount(3);
});

test("a sync failure with no pull requests says the list can't be trusted, not that nothing needs review", async ({ page }) => {
  await mockReviews(page, { queueBody: queue({ tickets: [], counts: { tickets: 0, prs: 0 } }) });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.getByText("Some pull requests could not be refreshed. Showing the last available results.")).toBeVisible();
  await expect(page.getByText("No pull requests to show. Some data couldn't be read, see above.")).toBeVisible();
  await expect(page.getByText("Nothing needs review right now.")).toHaveCount(0);
});

test("an empty queue says nothing needs review", async ({ page }) => {
  await mockReviews(page, { queueBody: healthy({ tickets: [], counts: { tickets: 0, prs: 0 } }) });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.getByText("Nothing needs review right now.")).toBeVisible();
  await expect(stat(page, "open pull requests")).toHaveText("0");
});

test("when GitHub isn't set up, the page says so", async ({ page }) => {
  await mockReviews(page, { queueBody: queue({ configured: false, syncError: "", refresh: null, tickets: [], counts: { tickets: 0, prs: 0 } }) });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.getByText("Pull requests aren't connected, so no reviews can be listed.")).toBeVisible();
  await expect(page.locator("#nav-review-count")).toBeHidden();
});

test("Open ticket shows the shared read-only ticket view, with no way to save changes", async ({ page }) => {
  await mockReviews(page);
  await page.goto("/dashboard.html?page=reviews");
  await page.getByRole("button", { name: "Open ticket AION-84 (read-only)" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Read-only.");
  await expect(dialog).toContainText("Rounds the refund down.");
  await expect(dialog.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(dialog.locator("input, textarea, select")).toHaveCount(0);
});

test("a developer keeps the personal list and never asks for the administrators' queue", async ({ page }) => {
  const calls = await mockReviews(page, { role: "user" });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.getByText("Nothing needs your review right now.")).toBeVisible();
  await expect(page.locator(".queue")).toHaveCount(0);
  expect(calls.me).toBeGreaterThan(0);
  expect(calls.queue).toBe(0);
  await expect(page.locator("#nav-review-count")).toBeHidden();
});
