// Review assignments on pull requests: who is asked to review, the Needs review queue, read-only ticket access,
// GitHub review requests. GitHub and Jira are faked; the store is in memory.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { makeToken } from "../proxy/src/handler.js";
import { memoryStore, saveUser } from "../proxy/src/users.js";
import { adfText, prReviewState, reviewStatus } from "../proxy/src/reviews.js";

const PR_ID = "KAD-org/flutter_pos#553";
const now = new Date().toISOString();
const pr = (over = {}) => ({
  id: PR_ID, repo: "flutter_pos", number: 553, title: "feat: forecourt opening (AION-71)", state: "open", url: "https://github.com/KAD-org/flutter_pos/pull/553",
  author: "dev1", branch: "codex/forecourt", base: "main", updated: now, merged: null, keys: ["AION-71", "INT-45"],
  status: { reviews: [], requested: [], decision: null, comments: 0, unresolved: 0 }, ...over
});

const issue = (key, summary, assignee) => ({ key, fields: { summary, status: { name: "In Progress" }, assignee: assignee ? { displayName: assignee } : null } });
const ISSUES = [
  issue("AION-71", "Forecourt opening cash", "Dev One"), issue("AION-80", "Till float", "Dev Two"), issue("AION-81", "Shift report", "Dev Two"),
  issue("AION-82", "Price boards", "Dev Three"), issue("AION-83", "Card terminals", "Dev Three"), issue("AION-84", "Refund rounding", "")
];

// syncedAt: when the pull request index was last synced (0 makes the next read sync). pulls: the answer to GitHub's pull
// list; jiraStatus: the answer to Jira's search; configured: whether GitHub is set up; issues: what Jira's search finds.
function setup({ prs = { [PR_ID]: pr() }, githubStatus = 201, syncedAt = Date.now(), pulls = 200, jiraStatus = 200, configured = true, issues = ISSUES } = {}) {
  const STORE = memoryStore(), github = [], jira = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === "api.github.com" && u.pathname.startsWith("/repos/") && u.pathname.endsWith("/pulls")) return Response.json([], { status: pulls });
    if (u.pathname === "/rest/api/3/search/jql") {
      if (jiraStatus !== 200) return new Response("{}", { status: jiraStatus });
      const wanted = JSON.parse(init.body).jql.match(/key in \(([^)]*)\)/)[1].split(",");
      return Response.json({ issues: issues.filter((i) => wanted.includes(i.key)) });
    }
    if (u.hostname === "api.github.com" && u.pathname.endsWith("/requested_reviewers")) {
      const body = JSON.parse(init.body || "{}");
      github.push({ method: init.method, path: u.pathname, reviewers: body.reviewers, auth: init.headers.Authorization });
      return Response.json({}, { status: githubStatus });
    }
    if (u.href.startsWith("https://jira.test/rest/api/3/issue/AION-71")) {
      jira.push(u.pathname);
      return Response.json({
        key: "AION-71", fields: {
          project: { key: "AION" }, summary: "Forecourt opening cash", status: { name: "In Progress" }, priority: { name: "High" },
          issuetype: { name: "Task" }, assignee: { displayName: "Dev One" }, reporter: { displayName: "Pat" }, labels: ["ai1_bashar.k", "ai1_dev1"],
          duedate: "2026-11-20", created: "2026-10-01T09:00:00.000+0000", updated: "2026-11-01T09:00:00.000+0000",
          description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Open the till at " }, { type: "text", text: "06:00" }] }] },
          comment: { total: 1, comments: [{ author: { displayName: "Dev One" }, created: "2026-11-02", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Done" }] }] } }] },
          attachment: [{ id: "10001", filename: "plan.pdf", size: 10, mimeType: "application/pdf", created: "2026-11-01" }]
        }
      });
    }
    return new Response("not mocked: " + url, { status: 599 });
  };
  const env = {
    JIRA_PROJECT: "AION", JIRA_SITE: "https://jira.test", JIRA_EMAIL: "bot", JIRA_API_TOKEN: "t", SESSION_SECRET: "s", STORE,
    GITHUB_TOKEN: configured ? "gh-token" : "", GITHUB_REPOS: "KAD-org/flutter_pos", GITHUB_JIRA_ALIASES: "AIONE"
  };
  // The PR index is seeded as synced at syncedAt (now, so the proxy never asks GitHub for a sync unless a test says so).
  STORE.set("github:prs:v4", JSON.stringify({ prs, cursors: {}, syncedAt }));
  const people = {};
  const seed = async (id, email, name, role, extra = {}) => {
    const u = { id, email, name, role, dev: email.split("@")[0], pw: null, v: 1, createdAt: now, ...extra };
    people[id] = u;
    await saveUser(STORE, u);
    return (await makeToken(env, email, Date.now(), 1)).token;
  };
  return { env, STORE, github, jira, people, seed, call: (method, path, token, body) => worker.fetch(new Request("https://p" + path, {
    method, headers: { Authorization: token ? "Bearer " + token : "", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: "manual"
  }), env) };
}

test("the review status is worked out from the assignment, the pull request and the reviewer's GitHub review", () => {
  const open = pr(), closed = pr({ state: "merged" });
  const a = { status: "active", startedAt: null };
  assert.equal(reviewStatus(a, open, "bashar-gh"), "needs_review");
  assert.equal(reviewStatus({ ...a, startedAt: now }, open, "bashar-gh"), "in_review");
  assert.equal(reviewStatus(a, pr({ status: { reviews: [{ by: "Bashar-GH", state: "APPROVED" }] } }), "bashar-gh"), "approved");
  assert.equal(reviewStatus(a, pr({ status: { reviews: [{ by: "bashar-gh", state: "CHANGES_REQUESTED" }] } }), "bashar-gh"), "changes_requested");
  assert.equal(reviewStatus(a, closed, "bashar-gh"), "closed");
  assert.equal(reviewStatus(a, null, "bashar-gh"), "unlinked");
});

test("Jira's rich text becomes plain text for the read-only ticket view", () => {
  const doc = { type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "Plan" }] }, { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] }, { type: "paragraph", content: [{ type: "mention", attrs: { text: "@Bashar" } }, { type: "hardBreak" }, { type: "text", text: "<b>x</b>" }] }] };
  assert.equal(adfText(doc).replace(/\n+/g, "|"), "Plan|one|@Bashar|<b>x</b>|");
  assert.equal(adfText(null), "");
});

test("an administrator asks people with and without a GitHub username to review; GitHub gets the request only where there is one", async () => {
  const t = setup();
  const adminToken = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const linked = await t.seed("u-linked", "bashar@aione.test", "Bashar", "user", { githubLogin: "bashar-gh" });
  const unlinked = await t.seed("u-plain", "sam@aione.test", "Sam", "user");
  const res = await t.call("PUT", "/reviews/pr?id=" + encodeURIComponent(PR_ID), adminToken, { reviewerIds: ["u-linked", "u-plain"] });
  assert.equal(res.status, 200);
  const view = await res.json();
  const byName = Object.fromEntries(view.assignments.map((a) => [a.reviewer.name, a]));
  assert.equal(byName.Bashar.github.state, "requested");
  assert.equal(byName.Sam.github.state, "no_login");
  assert.deepEqual(t.github, [{ method: "POST", path: "/repos/KAD-org/flutter_pos/pulls/553/requested_reviewers", reviewers: ["bashar-gh"], auth: "Bearer gh-token" }]);

  // The reviewer sees one assignment in their queue, with the GitHub state.
  const queue = await (await t.call("GET", "/reviews/me", linked)).json();
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].status, "needs_review");
  assert.equal(queue.items[0].pr.title, "feat: forecourt opening (AION-71)");
  const sam = await (await t.call("GET", "/reviews/me", unlinked)).json();
  assert.equal(sam.items[0].github.state, "no_login");
});

test("only administrators can choose reviewers, and only dashboard people can be chosen", async () => {
  const t = setup();
  const adminToken = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const userToken = await t.seed("u-1", "sam@aione.test", "Sam", "user");
  const path = "/reviews/pr?id=" + encodeURIComponent(PR_ID);
  assert.equal((await t.call("PUT", path, userToken, { reviewerIds: ["u-1"] })).status, 403);
  assert.equal((await t.call("GET", "/reviews/people", userToken)).status, 403);
  assert.equal((await t.call("PUT", path, adminToken, { reviewerIds: ["nobody"] })).status, 400);
  assert.equal((await t.call("PUT", path, adminToken, { reviewerIds: "u-1" })).status, 400);
  assert.equal(t.github.length, 0);
});

test("a reviewer reads the linked ticket read-only, and nobody else can", async () => {
  const t = setup();
  const adminToken = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const reviewer = await t.seed("u-1", "sam@aione.test", "Sam", "user");
  const outsider = await t.seed("u-2", "lee@aione.test", "Lee", "user");
  await t.call("PUT", "/reviews/pr?id=" + encodeURIComponent(PR_ID), adminToken, { reviewerIds: ["u-1"] });
  const ticket = await (await t.call("GET", "/reviews/ticket?key=AION-71", reviewer)).json();
  assert.equal(ticket.ticket.title, "Forecourt opening cash");
  assert.equal(ticket.ticket.description, "Open the till at 06:00");
  assert.deepEqual(ticket.ticket.devs, ["bashar.k", "dev1"]);
  assert.equal(ticket.ticket.comments[0].body, "Done");
  assert.equal(ticket.ticket.attachments[0].filename, "plan.pdf");
  assert.equal((await t.call("GET", "/reviews/ticket?key=AION-71", outsider)).status, 404);
  assert.equal((await t.call("GET", "/reviews/ticket?key=AION-99", reviewer)).status, 404);
  assert.equal((await t.call("GET", "/reviews/ticket?key=AION-71", reviewer)).status, 200);
  // Read-only: the review routes have no way to change the ticket.
  assert.equal((await t.call("POST", "/reviews/ticket?key=AION-71", reviewer, {})).status, 404);
});

test("a reviewer is never removed: a save that leaves them out keeps them, and only closing the pull request ends the review", async () => {
  const t = setup();
  const adminToken = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const reviewer = await t.seed("u-1", "sam@aione.test", "Sam", "user", { githubLogin: "sam-gh" });
  const path = "/reviews/pr?id=" + encodeURIComponent(PR_ID);
  await t.call("PUT", path, adminToken, { reviewerIds: ["u-1"] });
  const left = await t.call("PUT", path, adminToken, { reviewerIds: [] });
  assert.equal(left.status, 200);
  assert.equal((await left.json()).assignments.length, 1);
  assert.equal(t.github.length, 1, "leaving Sam out asks GitHub for nothing");
  assert.equal((await (await t.call("GET", "/reviews/me", reviewer)).json()).items.length, 1);
  assert.equal((await t.call("GET", "/reviews/ticket?key=AION-71", reviewer)).status, 200);
  // Asking again does not add a second assignment or a second GitHub request.
  await t.call("PUT", path, adminToken, { reviewerIds: ["u-1"] });
  assert.equal((await (await t.call("GET", "/reviews/me", reviewer)).json()).items.length, 1);
  assert.equal(t.github.length, 1);
});

test("the read-only ticket view ends when the pull request closes", async () => {
  const t = setup();
  const adminToken = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const reviewer = await t.seed("u-1", "sam@aione.test", "Sam", "user");
  await t.call("PUT", "/reviews/pr?id=" + encodeURIComponent(PR_ID), adminToken, { reviewerIds: ["u-1"] });
  t.STORE.set("github:prs:v4", JSON.stringify({ prs: { [PR_ID]: pr({ state: "merged", merged: now }) }, cursors: {}, syncedAt: Date.now() }));
  assert.equal((await t.call("GET", "/reviews/ticket?key=AION-71", reviewer)).status, 404);
});

test("a closed pull request shows its reviews as closed and blocks new reviewers", async () => {
  const t = setup({ prs: { [PR_ID]: pr({ state: "merged", merged: now }) } });
  const adminToken = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  await t.seed("u-1", "sam@aione.test", "Sam", "user", { githubLogin: "sam-gh" });
  const put = await t.call("PUT", "/reviews/pr?id=" + encodeURIComponent(PR_ID), adminToken, { reviewerIds: ["u-1"] });
  assert.equal(put.status, 409);
  assert.equal(t.github.length, 0);
  // Reviews added before the merge stay visible as closed.
  const seeded = setup({ prs: { [PR_ID]: pr() } });
  const admin2 = await seeded.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const r2 = await seeded.seed("u-1", "sam@aione.test", "Sam", "user", { githubLogin: "sam-gh" });
  await seeded.call("PUT", "/reviews/pr?id=" + encodeURIComponent(PR_ID), admin2, { reviewerIds: ["u-1"] });
  seeded.STORE.set("github:prs:v4", JSON.stringify({ prs: { [PR_ID]: pr({ state: "merged", merged: now }) }, cursors: {}, syncedAt: Date.now() }));
  const queue = await (await seeded.call("GET", "/reviews/me", r2)).json();
  assert.equal(queue.items[0].status, "closed");
  assert.equal((await seeded.call("GET", "/reviews/ticket?key=AION-71", r2)).status, 404);
});

test("a GitHub refusal is kept as a retryable state, and a retry after an unknown answer checks GitHub first", async () => {
  const t = setup({ githubStatus: 422 });
  const adminToken = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const reviewer = await t.seed("u-1", "sam@aione.test", "Sam", "user", { githubLogin: "sam-gh" });
  await t.call("PUT", "/reviews/pr?id=" + encodeURIComponent(PR_ID), adminToken, { reviewerIds: ["u-1"] });
  const queue = await (await t.call("GET", "/reviews/me", reviewer)).json();
  assert.equal(queue.items[0].github.state, "failed");
  assert.equal(queue.items[0].github.code, "not_eligible");
  // A retry sends the request again, and the administrator sees the result.
  const retry = await t.call("POST", "/reviews/retry?id=" + encodeURIComponent(PR_ID) + "&assignment=" + queue.items[0].id, adminToken);
  assert.equal(retry.status, 200);
  assert.equal(t.github.length, 2);
});

test("an administrator sets a developer's GitHub username, and their waiting reviews are then requested", async () => {
  const t = setup();
  const adminToken = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const reviewer = await t.seed("u-1", "sam@aione.test", "Sam", "user");
  await t.call("PUT", "/reviews/pr?id=" + encodeURIComponent(PR_ID), adminToken, { reviewerIds: ["u-1"] });
  assert.equal(t.github.length, 0);
  const saved = await t.call("PUT", "/users/" + encodeURIComponent("sam@aione.test"), adminToken, { githubLogin: "@sam-gh" });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).user.githubLogin, "sam-gh");
  assert.deepEqual(t.github, [{ method: "POST", path: "/repos/KAD-org/flutter_pos/pulls/553/requested_reviewers", reviewers: ["sam-gh"], auth: "Bearer gh-token" }]);
  const queue = await (await t.call("GET", "/reviews/me", reviewer)).json();
  assert.equal(queue.items[0].github.state, "requested");
  // Clearing the username keeps the request already on GitHub, and asks for nothing new.
  const cleared = await t.call("PUT", "/users/" + encodeURIComponent("sam@aione.test"), adminToken, { githubLogin: "" });
  assert.equal((await cleared.json()).user.githubLogin, "");
  assert.equal(t.github.length, 1);
});

test("GitHub usernames are checked, one username belongs to one person, and only administrators set them", async () => {
  const t = setup();
  const adminToken = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const userToken = await t.seed("u-0", "dana@aione.test", "Dana", "user");
  await t.seed("u-1", "sam@aione.test", "Sam", "user", { githubLogin: "sam-gh" });
  await t.seed("u-2", "lee@aione.test", "Lee", "user");
  const put = (email, githubLogin, token = adminToken) => t.call("PUT", "/users/" + encodeURIComponent(email), token, { githubLogin });
  assert.equal((await put("lee@aione.test", "bad name")).status, 400);
  assert.equal((await put("lee@aione.test", "-leading")).status, 400);
  assert.equal((await put("lee@aione.test", "a".repeat(40))).status, 400);
  const taken = await put("lee@aione.test", "SAM-gh");
  assert.equal(taken.status, 400);
  assert.match((await taken.json()).error, /already set for Sam/);
  assert.equal((await put("lee@aione.test", "sam-gh", userToken)).status, 403);
  assert.equal((await put("lee@aione.test", "lee-gh")).status, 200);
  assert.equal((await t.call("GET", "/reviews/github/link", userToken)).status, 404);
});

test("internal tickets are readable by their reviewers, with the same read-only rule", async () => {
  const t = setup({ prs: { [PR_ID]: pr({ keys: ["INT-45"] }) } });
  const adminToken = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const reviewer = await t.seed("u-1", "sam@aione.test", "Sam", "user");
  const attachmentId = "a".repeat(32);
  await t.STORE.set("it:INT-45", JSON.stringify({
    key: "INT-45", summary: "Refund rounding", status: "Open", description: "Round to 2dp", devs: ["sam"],
    comments: [{ author: { name: "Ellen" }, created: "2026-11-01", body: "Looks right" }],
    attachments: [{ id: attachmentId, filename: "notes.txt", size: 5, mimeType: "text/plain", parts: 1 }]
  }));
  await t.STORE.set("ia:" + attachmentId + ":0", Buffer.from("hello").toString("base64"));
  await t.call("PUT", "/reviews/pr?id=" + encodeURIComponent(PR_ID), adminToken, { reviewerIds: ["u-1"] });
  const ticket = await (await t.call("GET", "/reviews/ticket?key=INT-45", reviewer)).json();
  assert.equal(ticket.ticket.title, "Refund rounding");
  assert.equal(ticket.ticket.comments[0].body, "Looks right");
  const file = await t.call("GET", "/reviews/ticket/attachment?key=INT-45&id=" + attachmentId, reviewer);
  assert.equal(file.status, 200);
  assert.equal(await file.text(), "hello");
  assert.equal(file.headers.get("X-Content-Type-Options"), "nosniff");
});

const day = (n) => new Date(Date.UTC(2026, 10, 1) + n * 86400000).toISOString();
const pulled = (n, over = {}) => pr({ id: "KAD-org/flutter_pos#" + n, number: n, url: "https://github.com/KAD-org/flutter_pos/pull/" + n, keys: ["AION-" + (70 + n)], ...over });

test("a pull request needs a review until someone approves it; a stale approval or a missing approval brings it back", () => {
  assert.deepEqual(prReviewState(pr({ readyAt: day(0), status: { reviews: [], requests: [], requested: [] } })), { state: "awaiting", reason: "", since: day(0), counts: true });
  // The wait starts with the oldest open request, or the assignment if that is older.
  assert.deepEqual(prReviewState(pr({ status: { reviews: [], requests: [{ at: day(3) }, { at: day(1) }] } }), [{ createdAt: day(2) }]), { state: "awaiting", reason: "", since: day(1), counts: true });
  const changes = [{ by: "rev", state: "CHANGES_REQUESTED", at: day(2) }];
  assert.deepEqual(prReviewState(pr({ status: { reviews: changes, lastCommitAt: day(1) } })), { state: "changes_requested", reason: "", since: day(2), counts: false });
  assert.deepEqual(prReviewState(pr({ status: { reviews: changes, lastCommitAt: day(3) } })), { state: "awaiting", reason: "new_commits", since: day(3), counts: true });
  const approved = [{ by: "rev", state: "APPROVED", at: day(2) }];
  assert.deepEqual(prReviewState(pr({ status: { reviews: approved, lastCommitAt: day(1), decision: "APPROVED" } })), { state: "approved", reason: "", since: day(2), counts: false });
  assert.deepEqual(prReviewState(pr({ status: { reviews: approved, lastCommitAt: day(3), decision: "APPROVED" } })), { state: "approved", reason: "stale", since: day(3), counts: true });
  assert.deepEqual(prReviewState(pr({ status: { reviews: approved, lastCommitAt: day(1), decision: "REVIEW_REQUIRED" } }), [{ createdAt: day(0) }]), { state: "awaiting", reason: "more_approvals", since: day(0), counts: true });
});

test("administrators see the queue of tickets whose pull requests need a review; everyone else gets 403", async () => {
  const t = setup();
  const adminToken = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const reviewer = await t.seed("u-1", "sam@aione.test", "Sam", "user");
  await t.STORE.set("it:INT-45", JSON.stringify({ key: "INT-45", summary: "Refund rounding", status: "Open", assignee: { name: "Sam" } }));
  const res = await t.call("GET", "/reviews/queue", adminToken);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, true);
  assert.equal(body.syncError, "");
  assert.equal(body.ticketsError, "");
  assert.deepEqual(body.counts, { tickets: 2, prs: 1 }, "one pull request naming two tickets: two tickets, one pull request");
  const jiraTicket = body.tickets.find((x) => x.key === "AION-71");
  assert.equal(jiraTicket.title, "Forecourt opening cash");
  assert.equal(jiraTicket.assignee, "Dev One");
  assert.equal(jiraTicket.status, "In Progress");
  assert.deepEqual(jiraTicket.prs.map((p) => [p.state, p.reviewers]), [["awaiting", []]], "no reviewer assigned");
  assert.equal(body.tickets.find((x) => x.key === "INT-45").assignee, "Sam");
  assert.equal((await t.call("GET", "/reviews/queue", reviewer)).status, 403);
});

test("the queue leaves out drafts, merged and closed pull requests, and approvals that need nothing more", async () => {
  const t = setup({ prs: {
    "KAD-org/flutter_pos#10": pulled(10, { state: "draft" }),
    "KAD-org/flutter_pos#11": pulled(11, { state: "merged", merged: now }),
    "KAD-org/flutter_pos#12": pulled(12, { state: "closed" }),
    "KAD-org/flutter_pos#13": pulled(13, { status: { reviews: [{ by: "rev", state: "APPROVED", at: day(2) }], lastCommitAt: day(1), decision: "APPROVED" } }),
    "KAD-org/flutter_pos#14": pulled(14, { status: { reviews: [{ by: "rev", state: "APPROVED", at: day(1) }], lastCommitAt: day(2), decision: "APPROVED" } }),
  } });
  const adminToken = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const body = await (await t.call("GET", "/reviews/queue", adminToken)).json();
  assert.deepEqual(body.tickets.map((x) => x.key), ["AION-84"]);
  assert.deepEqual(body.tickets[0].prs.map((p) => [p.number, p.state, p.reason]), [[14, "approved", "stale"]]);
  assert.deepEqual(body.counts, { tickets: 1, prs: 1 });
});

test("the queue lists the longest wait first, and a ticket with two pull requests shows both", async () => {
  const t = setup({ prs: {
    "KAD-org/flutter_pos#20": pulled(20, { keys: ["AION-71"], status: { reviews: [], requests: [{ at: day(1) }], requested: [] } }),
    "KAD-org/flutter_pos#21": pulled(21, { keys: ["AION-71", "AION-80"], status: { reviews: [], requests: [{ at: day(5) }], requested: [] } }),
    "KAD-org/flutter_pos#22": pulled(22, { keys: ["AION-80"], status: { reviews: [{ by: "rev", state: "CHANGES_REQUESTED", at: day(3) }], lastCommitAt: day(0), requested: [] } }),
  } });
  const adminToken = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const body = await (await t.call("GET", "/reviews/queue", adminToken)).json();
  assert.deepEqual(body.tickets.map((x) => x.key), ["AION-71", "AION-80"]);
  assert.deepEqual(body.tickets[0].prs.map((p) => p.number), [20, 21]);
  assert.deepEqual(body.tickets[1].prs.map((p) => [p.number, p.state]), [[22, "changes_requested"], [21, "awaiting"]]);
  assert.deepEqual(body.counts, { tickets: 2, prs: 3 });
});

test("the queue names each pull request's reviewers, including ones asked on GitHub, and says when there are none", async () => {
  const t = setup({ prs: { [PR_ID]: pr({ status: { reviews: [], requested: ["sam-gh"], requests: [{ by: "sam-gh", at: day(1) }] } }) } });
  const adminToken = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  await t.seed("u-1", "sam@aione.test", "Sam", "user", { githubLogin: "sam-gh" });
  await t.seed("u-2", "lee@aione.test", "Lee", "user");
  await t.call("PUT", "/reviews/pr?id=" + encodeURIComponent(PR_ID), adminToken, { reviewerIds: ["u-2"] });
  const body = await (await t.call("GET", "/reviews/queue", adminToken)).json();
  const aion = body.tickets.find((x) => x.key === "AION-71");
  assert.deepEqual(aion.prs[0].reviewers.map((r) => r.name), ["Lee", "Sam"]);
  assert.deepEqual(body.reviewers, ["Lee", "Sam"]);
});

test("a failed sync or a failed Jira read is said so, and the queue is never reported empty when reading failed", async () => {
  const pullsDown = setup({ syncedAt: 0, pulls: 500 });
  const a1 = await pullsDown.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const stale = await (await pullsDown.call("GET", "/reviews/queue", a1)).json();
  assert.match(stale.syncError, /Couldn't read pull requests/);
  assert.ok(stale.tickets.some((x) => x.key === "AION-71"), "the last synced pull requests still show");

  const statusDown = setup({ syncedAt: 0 });
  const a2 = await statusDown.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const partial = await (await statusDown.call("GET", "/reviews/queue", a2)).json();
  assert.match(partial.syncError, /Review states couldn't be read for KAD-org\/flutter_pos/);

  const jiraDown = setup({ jiraStatus: 500 });
  const a3 = await jiraDown.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const noTitles = await (await jiraDown.call("GET", "/reviews/queue", a3)).json();
  assert.equal(noTitles.ticketsError, "Jira couldn't be read, so titles and assignees may be missing.");
  assert.equal(noTitles.tickets.find((x) => x.key === "AION-71").title, "AION-71");

  const off = setup({ configured: false });
  const a4 = await off.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const notSet = await (await off.call("GET", "/reviews/queue", a4)).json();
  assert.equal(notSet.configured, false);
  assert.deepEqual(notSet.tickets, []);

  const none = setup({ prs: {} });
  const a5 = await none.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const empty = await (await none.call("GET", "/reviews/queue", a5)).json();
  assert.equal(empty.configured, true);
  assert.equal(empty.syncError, "");
  assert.deepEqual(empty.tickets, []);
});

test("an administrator reads any ticket read-only, whether or not a pull request names it", async () => {
  const t = setup({ prs: {} });
  const adminToken = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const res = await t.call("GET", "/reviews/ticket?key=AION-71", adminToken);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ticket.title, "Forecourt opening cash");
  assert.equal(body.pr, null);
  assert.equal((await t.call("POST", "/reviews/ticket?key=AION-71", adminToken, {})).status, 404);
});
