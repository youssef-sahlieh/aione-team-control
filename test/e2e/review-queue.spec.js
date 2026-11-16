import { test, expect } from "@playwright/test";

// Needs review, administrators: every open GitHub pull request, one row each, linked to a ticket or not, drafts included,
// with the longest real review wait first. Search, quick filters and menus combine on the page; a "By ticket" view groups
// the same rows. The Rami box is a reference flag only: it saves itself and nothing else. A failed read is never shown as
// an empty queue, and a partly failed refresh keeps the last results with a short warning. A developer keeps the personal
// list, and never asks for the administrators' queue. Everything here is mocked: no GitHub, Jira or proxy is reached.
const NOW = new Date("2026-11-08T12:00:00Z");
const LONG_TITLE = "Forecourt opening cash is counted twice when the shift starts before midnight and the till was reopened after a power cut";
const T71 = { key: "AION-71", title: LONG_TITLE, status: "In Review", done: false, assignee: "Dev One", devs: ["Builder"], client: "Acme", subClient: "Till" };
const T84 = { key: "AION-84", title: "Refund rounding", status: "To Do", done: false, assignee: "", devs: [], client: "Beta", subClient: "" };
const T90 = { key: "AION-90", title: "Old export", status: "Done", done: true, assignee: "Dev One", devs: [], client: "", subClient: "" };
const row = (repo, number, over) => ({ id: repo + "#" + number, repo, number, url: "https://github.example.invalid/" + repo + "/pull/" + number, author: "dev-one", created: "2026-10-20T10:00:00Z", draft: false, state: "awaiting", reason: "", since: "", sinceKind: "", reviewers: [], reviewerState: "none", tickets: [], rami: false, stale: false, statusAt: "2026-11-08T11:00:00Z", ...over });
const PRS = () => [
  row("acme/api", 7, { title: "Cash drawer totals", reason: "new_commits", since: "2026-11-01T10:00:00Z", sinceKind: "commit", tickets: [T71] }),
  row("acme/web", 20, { title: "Shared rounding helper", since: "2026-11-03T10:00:00Z", sinceKind: "requested", reviewerState: "pending", tickets: [T71, T84], rami: true,
    reviewers: [{ name: "Mobile", login: "", kind: "team", review: "", pending: true }, { name: "Lee", login: "lee", kind: "user", review: "", pending: true }, { name: "Sam", login: "sam", kind: "user", review: "", pending: true }, { name: "Ana", login: "ana", kind: "user", review: "", pending: true }] }),
  row("acme/web", 12, { title: "Fix opening cash", author: "dev-two", state: "changes_requested", since: "2026-11-02T10:00:00Z", sinceKind: "changes", reviewerState: "given", tickets: [T71], reviewers: [{ name: "Lee", login: "lee", kind: "user", review: "CHANGES_REQUESTED", pending: false }] }),
  row("acme/web", 15, { title: "Round refunds", author: "dev-two", since: "2026-10-06T10:00:00Z", sinceKind: "opened", tickets: [T84] }),
  row("acme/mobile", 3, { title: "Export follow-up", url: "javascript:alert(1)", author: "", state: "unknown", reviewerState: "unavailable", tickets: [T90], stale: true, statusAt: null }),
  row("acme/web", 30, { title: "Tidy the settings screen", author: "dev-three", since: "2026-11-07T10:00:00Z", sinceKind: "opened" }),
  row("acme/api", 31, { title: "Experiment: faster sync", author: "dev-three", draft: true, state: "draft", since: "2026-11-05T10:00:00Z", sinceKind: "opened" })
];
const queue = (over = {}) => ({
  configured: true, syncedAt: "2026-11-08T11:00:00Z", syncError: "Couldn't list pull requests for acme/mobile: GitHub answered 502", ticketsError: "", reviewers: ["Ana", "Lee", "Mobile", "Sam"], clients: ["Acme", "Beta"],
  counts: { prs: 7, tickets: 3, awaiting: 4 }, canFlag: true,
  refresh: { attemptedAt: "2026-11-08T11:00:00Z", okAt: "2026-11-08T10:00:00Z", repos: 3, failedRepos: 1, failures: [{ repo: "acme/mobile", stage: "list", error: "GitHub answered 502", lastOkAt: "2026-11-07T09:00:00Z" }] },
  prs: PRS(),
  ...over
});
const healthy = (over = {}) => queue({ syncError: "", refresh: { attemptedAt: "2026-11-08T11:00:00Z", okAt: "2026-11-08T11:00:00Z", repos: 3, failedRepos: 0, failures: [] }, ...over });
const EMPTY = { prs: [], counts: { prs: 0, tickets: 0, awaiting: 0 } };

// queueBody: an answer, or a function of the call (n from 1, forced: ?refresh=1) that returns { status, json, delay }.
// ramiStatus: the answer to PUT /reviews/rami. calls.rami lists what each PUT asked for.
async function mockReviews(page, { role = "admin", queueBody = queue(), queueStatus = 200, ramiStatus = 200, meItems = [], meExtra = {} } = {}) {
  const calls = { queue: 0, forced: 0, me: 0, writes: 0, rami: [], other: [] };
  const email = role === "admin" ? "admin@example.invalid" : "user@example.invalid";
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(({ role, email }) => { localStorage.setItem("aione-session", JSON.stringify({ token: "t", email, expiresAt: Date.now() + 3600000, role })); }, { role, email });
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname;
    if (req.method() !== "GET" && path.startsWith("/reviews")) calls.writes++;
    // Every write other than the Rami flag (the dashboard reads Jira with a POST search; that is not a write).
    if (req.method() !== "GET" && path !== "/reviews/rami" && path !== "/jira/search") calls.other.push(req.method() + " " + path);
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
    if (path === "/reviews/rami") {
      const body = req.postDataJSON();
      calls.rami.push({ method: req.method(), id: url.searchParams.get("id"), flagged: body.flagged });
      return ramiStatus === 200 ? route.fulfill({ json: { id: url.searchParams.get("id"), rami: body.flagged } }) : route.fulfill({ status: ramiStatus, json: { code: "unavailable", error: "Store is down." } });
    }
    if (path === "/reviews/me") { calls.me++; return route.fulfill({ json: { items: meItems, prError: "", ...meExtra } }); }
    if (path === "/reviews/ticket") return route.fulfill({ json: { pr: null, ticket: { key: "AION-84", title: "Refund rounding", status: "To Do", priority: "High", type: "Bug", epic: "", assignee: "", reporter: "Ellen", devs: ["builder"], due: null, created: "2026-10-01T10:00:00.000+0000", updated: "2026-10-14T10:00:00.000+0000", description: "Rounds the refund down.", attachments: [], comments: [], commentsTotal: 0 } } });
    if (path === "/internal") return route.fulfill({ json: { tickets: [] } });
    if (path === "/date-requests") return route.fulfill({ json: { requests: [] } });
    if (path === "/inbox") return route.fulfill({ json: { items: [], seenAt: null, readTickets: [] } });
    return route.fulfill({ json: {} });
  });
  return calls;
}

const ticket = (page, key) => page.locator(".queue-ticket").filter({ has: page.locator(".queue-key", { hasText: key }) });
const prRow = (page, ref) => page.locator(".queue-pr").filter({ has: page.locator(".queue-repo", { hasText: new RegExp("^" + ref.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "$") }) });
const stat = (page, label) => page.locator(`.queue-stat[data-stat="${label}"] b`);
const refs = (page) => page.locator(".queue-repo");
const ramiBox = (page, ref) => prRow(page, ref).first().locator(".queue-rami input[type=checkbox]");
const ALL_DEFAULT = ["acme/api #7", "acme/web #20", "acme/web #15", "acme/web #12", "acme/api #31", "acme/web #30", "acme/mobile #3"];

test("an administrator sees every open pull request once, linked or not, longest real wait first, with honest counts", async ({ page }) => {
  const calls = await mockReviews(page, { queueBody: healthy() });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.locator("#page-heading")).toHaveText("Needs review");
  await expect(page.locator("#page-description")).toHaveText("All open GitHub pull requests · Linked and unlinked");
  await expect(stat(page, "Open PRs")).toHaveText("7");
  await expect(stat(page, "Linked tickets")).toHaveText("3");
  await expect(stat(page, "Unlinked PRs")).toHaveText("2");
  await expect(stat(page, "No reviewer")).toHaveText("4");
  await expect(stat(page, "Flagged for Rami")).toHaveText("1");
  await expect(stat(page, "Awaiting review")).toHaveText("4");
  await expect(page.locator(".queue-showing")).toHaveText("Showing 7 pull requests");
  await expect(page.locator(".queue-updated")).toContainText("Last successful update");
  await expect(page.locator("#nav-review-count")).toHaveText("4");
  // One row per pull request: the one naming two tickets is listed once. Real review waits first, then other times,
  // then the unknown.
  await expect(refs(page)).toHaveText(ALL_DEFAULT);
  await expect(page.locator(".queue-alert")).toHaveCount(0);

  // Linked rows name their tickets (each opens read-only); unlinked ones say so; a draft is marked as one.
  await expect(prRow(page, "acme/web #20").locator(".queue-ticket-link")).toHaveText(["AION-71", "AION-84"]);
  await expect(prRow(page, "acme/web #30").locator(".queue-unlinked")).toHaveText("Unlinked");
  await expect(prRow(page, "acme/web #30").locator(".queue-ticket-link")).toHaveCount(0);
  const draft = prRow(page, "acme/api #31");
  await expect(draft.locator(".queue-draft")).toHaveText("Draft");
  await expect(draft.locator(".review-status")).toHaveText("Draft");
  await expect(draft).toContainText("by dev-three");

  // Pull request rows: state, reason, reviewers (teams included) and what the time means.
  await expect(prRow(page, "acme/web #12").locator(".review-status")).toHaveText("Changes requested");
  await expect(prRow(page, "acme/web #12")).toContainText("Lee · changes requested");
  await expect(prRow(page, "acme/api #7").locator(".review-status")).toHaveText("Awaiting review");
  await expect(prRow(page, "acme/api #7")).toContainText("New commits since changes were requested");
  await expect(prRow(page, "acme/api #7").locator(".queue-none")).toHaveText("No reviewer requested");
  await expect(prRow(page, "acme/api #7").locator(".queue-wait-label")).toHaveText("Waiting since new commits");
  await expect(prRow(page, "acme/api #7").locator(".queue-wait.long time")).toHaveText("7 days");
  const sharedRow = prRow(page, "acme/web #20");
  await expect(sharedRow.locator(".queue-wait-label")).toHaveText("Waiting for review");
  await expect(sharedRow.locator("time")).toHaveText("5 days");
  await expect(sharedRow.locator("time")).toHaveAttribute("datetime", "2026-11-03T10:00:00Z");
  await expect(sharedRow.locator("time")).toHaveAttribute("title", /3 Nov 2026/);
  await expect(sharedRow).toContainText("Mobile (team) · requested, Lee · requested, Sam · requested");
  // Without a known request time, the age of the pull request is shown as such, never as a long review wait.
  await expect(prRow(page, "acme/web #15").locator(".queue-wait-label")).toHaveText("PR age");
  await expect(prRow(page, "acme/web #15").locator(".queue-wait.long")).toHaveCount(0);

  // Unknown review data is never called awaiting; no time and no safe link are said in words.
  const unknown = prRow(page, "acme/mobile #3");
  await expect(unknown.locator(".review-status")).toHaveText("Review information unavailable");
  await expect(unknown.locator(".queue-none").first()).toHaveText("Reviewer data unavailable");
  await expect(unknown.locator(".queue-wait-label")).toHaveText("Waiting time unknown");
  await expect(unknown.locator(".queue-stale")).toHaveText("Last known");
  await expect(unknown).toContainText("Link unavailable");
  await expect(unknown.getByRole("link")).toHaveCount(0);

  const openPr = page.getByRole("link", { name: "Open pull request acme/web #12 on GitHub (opens in a new tab)" });
  await expect(openPr).toHaveAttribute("href", "https://github.example.invalid/acme/web/pull/12");
  await expect(openPr).toHaveAttribute("target", "_blank");
  await expect(openPr).toHaveAttribute("rel", "noopener noreferrer");
  // Every row has its Rami box; only #20 is ticked.
  await expect(page.locator(".queue-rami input[type=checkbox]")).toHaveCount(7);
  await expect(ramiBox(page, "acme/web #20")).toBeChecked();
  await expect(ramiBox(page, "acme/web #12")).not.toBeChecked();
  // Nothing here merges, approves, assigns reviewers or makes a ticket.
  for (const name of [/merge/i, /approve/i, /assign/i, /request changes/i, /create ticket/i]) await expect(page.locator(".queue").getByRole("button", { name })).toHaveCount(0);
  expect(calls.writes).toBe(0);
});

test("ticking Rami saves only the flag, keyed by the pull request, and the counts and filter follow", async ({ page }) => {
  const calls = await mockReviews(page, { queueBody: healthy() });
  await page.goto("/dashboard.html?page=reviews");
  const box = ramiBox(page, "acme/web #12");
  await expect(box).toHaveAttribute("aria-label", "Rami: flag acme/web #12 for Rami's reference");
  await expect(box).toHaveAttribute("title", /Reference only/);
  await box.check();
  await expect.poll(() => calls.rami).toEqual([{ method: "PUT", id: "acme/web#12", flagged: true }]);
  await expect(stat(page, "Flagged for Rami")).toHaveText("2");
  await expect(ramiBox(page, "acme/web #12")).toBeChecked();
  await expect(ramiBox(page, "acme/web #12")).toBeFocused();
  await page.locator(".queue-quick").getByRole("button", { name: "Rami flagged" }).click();
  await expect(refs(page)).toHaveText(["acme/web #20", "acme/web #12"]);
  await ramiBox(page, "acme/web #20").uncheck();
  await expect.poll(() => calls.rami.length).toBe(2);
  expect(calls.rami[1]).toEqual({ method: "PUT", id: "acme/web#20", flagged: false });
  await expect(refs(page)).toHaveText(["acme/web #12"]);
  await expect(stat(page, "Flagged for Rami")).toHaveText("1");
  // Nothing else was written: no reviewer, no GitHub request, no ticket, no notification.
  expect(calls.other).toEqual([]);
  // Unchanged review state and reviewers.
  await page.locator(".queue-quick").getByRole("button", { name: "All PRs" }).click();
  await expect(prRow(page, "acme/web #12").locator(".review-status")).toHaveText("Changes requested");
  await expect(prRow(page, "acme/web #20")).toContainText("Mobile (team) · requested");
});

test("a Rami flag that couldn't be saved goes back and says so", async ({ page }) => {
  await mockReviews(page, { queueBody: healthy(), ramiStatus: 503 });
  await page.goto("/dashboard.html?page=reviews");
  const box = ramiBox(page, "acme/web #12");
  await box.click();
  await expect(page.getByText("Couldn't save the Rami flag")).toBeVisible();
  await expect(box).not.toBeChecked();
  await expect(box).toBeEnabled();
  await expect(stat(page, "Flagged for Rami")).toHaveText("1");
});

test("without permission to flag, the Rami boxes show the flags but can't be changed", async ({ page }) => {
  const calls = await mockReviews(page, { queueBody: healthy({ canFlag: false }) });
  await page.goto("/dashboard.html?page=reviews");
  await expect(ramiBox(page, "acme/web #20")).toBeChecked();
  await expect(ramiBox(page, "acme/web #20")).toBeDisabled();
  await expect(ramiBox(page, "acme/web #12")).toBeDisabled();
  expect(calls.rami).toEqual([]);
});

test("long reviewer lists fold into an accessible disclosure", async ({ page }) => {
  await mockReviews(page, { queueBody: healthy() });
  await page.goto("/dashboard.html?page=reviews");
  const more = prRow(page, "acme/web #20").locator("details.queue-more");
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
  await expect(page.locator(".queue-pr")).toHaveCount(7);
  await expect(page.getByText("No open pull requests right now.")).toHaveCount(0);

  const before = calls.forced;
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => calls.forced).toBe(before + 1);
});

test("search, quick filters, menus and sort combine on the page, the cards stay whole, and Clear filters brings it back", async ({ page }) => {
  const calls = await mockReviews(page, { queueBody: healthy() });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.locator(".queue-pr")).toHaveCount(7);
  const reads = calls.queue;
  const search = page.getByRole("searchbox", { name: "Search the review queue" });
  const quick = (name) => page.locator(".queue-quick").getByRole("button", { name, exact: true });

  await search.fill("acme/api#7");
  await expect(refs(page)).toHaveText(["acme/api #7"]);
  await expect(page.locator(".queue-showing")).toHaveText("Showing 1 of 7 pull requests");
  // The cards always count every open pull request.
  await expect(stat(page, "Open PRs")).toHaveText("7");
  await search.fill("refund");
  await expect(refs(page)).toHaveText(["acme/web #20", "acme/web #15"], { timeout: 5000 });
  await search.fill("dev-three");
  await expect(refs(page)).toHaveText(["acme/api #31", "acme/web #30"]);
  await search.fill("nothing matches this");
  await expect(page.getByText("No pull requests match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Remove filter Search: nothing matches this" }).click();
  await expect(search).toHaveValue("");
  await expect(page.locator(".queue-pr")).toHaveCount(7);

  await expect(quick("All PRs")).toHaveAttribute("aria-pressed", "true");
  await quick("Linked to ticket").click();
  await expect(quick("Linked to ticket")).toHaveAttribute("aria-pressed", "true");
  await expect(refs(page)).toHaveText(["acme/api #7", "acme/web #20", "acme/web #15", "acme/web #12", "acme/mobile #3"]);
  await quick("Unlinked PRs").click();
  await expect(refs(page)).toHaveText(["acme/api #31", "acme/web #30"]);
  await quick("Rami flagged").click();
  await expect(refs(page)).toHaveText(["acme/web #20"]);
  await quick("No reviewer").click();
  await expect(refs(page)).toHaveText(["acme/api #7", "acme/web #15", "acme/api #31", "acme/web #30"]);
  await quick("Changes requested").click();
  await expect(refs(page)).toHaveText(["acme/web #12"]);

  // Quick filters and menus combine.
  await quick("No reviewer").click();
  await page.getByRole("combobox", { name: "Repository" }).selectOption("acme/api");
  await expect(refs(page)).toHaveText(["acme/api #7", "acme/api #31"]);
  await page.getByRole("combobox", { name: "Review state" }).selectOption("draft");
  await expect(refs(page)).toHaveText(["acme/api #31"]);
  await expect(page.locator(".queue-chip", { hasText: "Repository: acme/api" })).toBeVisible();
  await expect(page.locator(".queue-chip", { hasText: "State: Draft" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".queue-pr")).toHaveCount(7);
  await expect(page.locator(".queue-active .queue-chip")).toHaveCount(0);

  await page.getByRole("combobox", { name: "Reviewer" }).selectOption("Mobile");
  await expect(refs(page)).toHaveText(["acme/web #20"]);
  await page.getByRole("combobox", { name: "Reviewer" }).selectOption("");
  // A project matches through a linked ticket: unlinked pull requests have none.
  await page.getByRole("combobox", { name: "Project" }).selectOption("Beta");
  await expect(refs(page)).toHaveText(["acme/web #20", "acme/web #15"]);
  await page.getByRole("combobox", { name: "Project" }).selectOption("");

  await page.getByRole("combobox", { name: "Sort" }).selectOption("key");
  await expect(refs(page)).toHaveText(["acme/api #7", "acme/web #20", "acme/web #12", "acme/web #15", "acme/mobile #3", "acme/api #31", "acme/web #30"]);
  await page.getByRole("combobox", { name: "Sort" }).selectOption("repo");
  await expect(refs(page)).toHaveText(["acme/api #7", "acme/api #31", "acme/mobile #3", "acme/web #12", "acme/web #15", "acme/web #20", "acme/web #30"]);
  await page.getByRole("combobox", { name: "Sort" }).selectOption("recent");
  await expect(refs(page).first()).toHaveText("acme/web #30");
  // All of this happened on the page: the queue wasn't read again.
  expect(calls.queue).toBe(reads);
});

test("the By ticket view groups the same pull requests under their tickets, with the unlinked last", async ({ page }) => {
  await mockReviews(page, { queueBody: healthy() });
  await page.goto("/dashboard.html?page=reviews");
  const views = page.getByRole("group", { name: "View" });
  await expect(views.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  await views.getByRole("button", { name: "By ticket" }).click();
  await expect(views.getByRole("button", { name: "By ticket" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".queue-ticket .queue-key")).toHaveText(["AION-71", "AION-84", "AION-90"]);
  await expect(ticket(page, "AION-71").locator(".queue-repo")).toHaveText(["acme/api #7", "acme/web #20", "acme/web #12"]);
  // The pull request naming two tickets is under both.
  await expect(ticket(page, "AION-84").locator(".queue-repo")).toHaveText(["acme/web #20", "acme/web #15"]);
  const unlinked = page.locator(".queue-ticket").last();
  await expect(unlinked.locator(".queue-ticket-title")).toContainText("Unlinked");
  await expect(unlinked.locator(".queue-repo")).toHaveText(["acme/api #31", "acme/web #30"]);
  await expect(unlinked.getByRole("button", { name: /Open ticket/ })).toHaveCount(0);

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
  // Filters still apply.
  await page.locator(".queue-quick").getByRole("button", { name: "Rami flagged" }).click();
  await expect(page.locator(".queue-ticket .queue-key")).toHaveText(["AION-71", "AION-84"]);
});

test("filters, the view and folded tickets stay through Refresh and the read-only ticket view, and the list stays on screen while it refreshes", async ({ page }) => {
  const calls = await mockReviews(page, { queueBody: (n, forced) => ({ json: healthy(), delay: forced ? 600 : 0 }) });
  await page.goto("/dashboard.html?page=reviews");
  await page.getByRole("searchbox", { name: "Search the review queue" }).fill("AION-7");
  await page.getByRole("combobox", { name: "Sort" }).selectOption("key");
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "By ticket" }).click();
  const toggle = page.getByRole("button", { name: "Pull requests for AION-71" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#queue-prs-AION-71")).toBeHidden();

  const refresh = page.getByRole("button", { name: "Refresh the review queue from GitHub" });
  await refresh.click();
  await expect(refresh).toHaveText("Refreshing…");
  await expect(page.locator(".queue")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".queue-ticket")).toHaveCount(2);
  await expect(refresh).toHaveText("Refresh");
  expect(calls.forced).toBe(1);
  await expect(page.getByRole("searchbox", { name: "Search the review queue" })).toHaveValue("AION-7");
  await expect(page.getByRole("combobox", { name: "Sort" })).toHaveValue("key");
  await expect(page.getByRole("button", { name: "Pull requests for AION-71" })).toHaveAttribute("aria-expanded", "false");

  await ticket(page, "AION-71").locator(".queue-ticket-head").getByRole("button", { name: "Open ticket AION-71 (read-only)" }).click();
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
  await expect(page.getByRole("group", { name: "View" }).getByRole("button", { name: "By ticket" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Pull requests for AION-71" })).toHaveAttribute("aria-expanded", "false");
});

test("the ticket groups open and close from the keyboard", async ({ page }) => {
  await mockReviews(page, { queueBody: healthy() });
  await page.goto("/dashboard.html?page=reviews");
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "By ticket" }).click();
  const toggle = page.getByRole("button", { name: "Pull requests for AION-84" });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#" + await toggle.getAttribute("aria-controls"))).toBeHidden();
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(ticket(page, "AION-84").locator(".queue-ticket-head").getByRole("button", { name: "Open ticket AION-84 (read-only)" })).toBeFocused();
});

test("wide screens line the pull request columns up; narrow screens stack them without scrolling sideways", async ({ page }) => {
  await mockReviews(page, { queueBody: healthy() });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/dashboard.html?page=reviews");
  const r = prRow(page, "acme/web #15");
  await expect(page.locator(".queue-cols")).toBeVisible();
  const wide = { main: await r.locator(".queue-pr-main").boundingBox(), state: await r.locator(".queue-state").boundingBox(), wait: await r.locator(".queue-wait").boundingBox(), rami: await r.locator(".queue-rami").boundingBox() };
  expect(Math.abs(wide.main.y - wide.state.y)).toBeLessThan(4);
  expect(Math.abs(wide.main.y - wide.wait.y)).toBeLessThan(4);
  expect(wide.state.x).toBeGreaterThan(wide.main.x + wide.main.width - 1);
  expect(wide.rami.x).toBeGreaterThan(wide.wait.x);
  // The page uses the full width, not the narrow reviewer's column.
  expect((await page.locator(".queue").boundingBox()).width).toBeGreaterThan(1000);

  await page.setViewportSize({ width: 600, height: 900 });
  await expect(page.locator(".queue-cols")).toBeHidden();
  const main = await r.locator(".queue-pr-main").boundingBox(), state = await r.locator(".queue-state").boundingBox();
  expect(state.y).toBeGreaterThan(main.y + main.height - 1);
  await expect(r.locator(".queue-rami input")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a read that fails with nothing to show is a failure with Retry, never an empty queue", async ({ page }) => {
  const calls = await mockReviews(page, { queueBody: (n, forced) => (forced ? { json: healthy() } : { status: 503 }) });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.getByText(/The review queue couldn't be loaded: /)).toBeVisible();
  await expect(page.getByText("No open pull requests right now.")).toHaveCount(0);
  await expect(page.locator(".queue-stats")).toBeHidden();
  await page.locator(".queue-alert").getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(".queue-pr")).toHaveCount(7);
  await expect(page.locator(".queue-alert")).toHaveCount(0);
  expect(calls.forced).toBe(1);
});

test("a failed refresh keeps the last list on screen", async ({ page }) => {
  await mockReviews(page, { queueBody: (n, forced) => (forced ? { status: 503 } : { json: healthy() }) });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.locator(".queue-pr")).toHaveCount(7);
  await page.getByRole("button", { name: "Refresh the review queue from GitHub" }).click();
  await expect(page.getByText("Refresh failed. Showing the last available results.")).toBeVisible();
  await expect(page.locator(".queue-pr")).toHaveCount(7);
});

test("a sync failure with no pull requests says the list can't be trusted, not that there are none", async ({ page }) => {
  await mockReviews(page, { queueBody: queue(EMPTY) });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.getByText("Some pull requests could not be refreshed. Showing the last available results.")).toBeVisible();
  await expect(page.getByText("No pull requests to show. Some data couldn't be read, see above.")).toBeVisible();
  await expect(page.getByText("No open pull requests right now.")).toHaveCount(0);
});

test("an empty queue says there are no open pull requests, with every card at zero", async ({ page }) => {
  await mockReviews(page, { queueBody: healthy(EMPTY) });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.getByText("No open pull requests right now.")).toBeVisible();
  for (const label of ["Open PRs", "Linked tickets", "Unlinked PRs", "No reviewer", "Flagged for Rami", "Awaiting review"]) await expect(stat(page, label)).toHaveText("0");
});

test("when GitHub isn't set up, the page says so", async ({ page }) => {
  await mockReviews(page, { queueBody: queue({ configured: false, syncError: "", refresh: null, ...EMPTY }) });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.getByText("Pull requests aren't connected, so no reviews can be listed.")).toBeVisible();
  await expect(page.locator("#nav-review-count")).toBeHidden();
});

test("Open ticket shows the shared read-only ticket view, with no way to save changes", async ({ page }) => {
  await mockReviews(page);
  await page.goto("/dashboard.html?page=reviews");
  await prRow(page, "acme/web #15").getByRole("button", { name: "Open ticket AION-84 (read-only)" }).click();
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

test("Rami sees the pull requests flagged for him to check, apart from his reviews, and opens them on GitHub to comment", async ({ page }) => {
  const flagged = [
    { id: "acme/web#15", repo: "acme/web", number: 15, title: "Round refunds", url: "https://github.com/acme/web/pull/15", author: "dev-one", draft: false, updated: "2026-11-08T10:00:00Z", tickets: [{ key: "AION-84", title: "Refund rounding" }] },
    { id: "acme/api#7", repo: "acme/api", number: 7, title: "Bump dependencies", url: "https://github.com/acme/api/pull/7", author: "dev-two", draft: true, updated: "2026-11-07T10:00:00Z", tickets: [] }
  ];
  const calls = await mockReviews(page, { role: "user", meExtra: { flagged, ticketsError: "" } });
  await page.goto("/dashboard.html?page=reviews");
  const section = page.locator(".review-flagged-list");
  await expect(section.getByRole("heading", { name: "Flagged for you to check (2)" })).toBeVisible();
  await expect(section).toContainText("This isn't a review request.");
  const cards = section.locator(".review-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).getByRole("link", { name: "Open on GitHub to comment" })).toHaveAttribute("href", "https://github.com/acme/web/pull/15");
  await expect(cards.nth(1)).toContainText("Draft");
  await expect(cards.nth(1)).toContainText("No linked ticket");
  await expect(page.getByRole("heading", { name: "Your reviews" })).toBeVisible();
  await expect(page.getByText("Nothing needs your review right now.")).toBeVisible();
  await cards.nth(0).getByRole("button", { name: "Read AION-84" }).click();
  await expect(page.getByRole("dialog")).toContainText("Rounds the refund down.");
  expect(calls.queue).toBe(0);
  expect(calls.other).toEqual([]);
});

test("someone who isn't Rami gets no flagged section", async ({ page }) => {
  await mockReviews(page, { role: "user" });
  await page.goto("/dashboard.html?page=reviews");
  await expect(page.getByText("Nothing needs your review right now.")).toBeVisible();
  await expect(page.locator(".review-flagged-list")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your reviews" })).toHaveCount(0);
});
