// Replying to one Jira comment from the ticket drawer. Every request is intercepted by the fake proxy below; nothing
// reaches Jira. The proxy side (what the reply says, who may see it, the comment being on this ticket) is tested in
// test/comment-reply.test.js.
import { test, expect } from "@playwright/test";
import { jiraIssue, people } from "../fixtures/issues.js";

const comments = [
  { id: "10100", author: { accountId: "dana-1", displayName: "Dana Client" }, created: "2026-10-10T07:00:00Z", body: "The export fails\nwhen the date is empty" },
  { id: "10200", author: { accountId: "aion-bot", displayName: "AION Bot" }, created: "2026-10-10T08:00:00Z", body: "Fixed on staging\n\n— Ellen Example" },
  { id: "10300", author: { accountId: "lead-1", displayName: "Test Lead" }, created: "2026-10-10T09:00:00Z", body: "Developers only", visibility: { type: "role", value: "Developers" } },
];
const rendered = ["<p>The export fails<br/>when the date is empty</p>", "<p>Fixed on staging</p><p>— Ellen Example</p>", "<p>Developers only</p>"];
const issue = (key, list = comments, html = rendered) => ({ ...jiraIssue, key, fields: { ...jiraIssue.fields, summary: "Ticket " + key, comment: { comments: list, total: list.length } }, renderedFields: { ...jiraIssue.renderedFields, comment: { comments: html.map((body) => ({ body })) } } });

// sends: what each comment POST answers, in turn (the last one repeats). A function gets the request body.
async function mockJira(page, { sends = [{ json: { id: "10900" } }] } = {}) {
  await page.clock.setFixedTime(new Date("2026-10-11T09:00:00Z"));
  const calls = [], unexpected = [], errors = [], posts = [];
  const state = { issues: [issue("AION-101"), issue("AION-102", [comments[0]], [rendered[0]])] };
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1"); localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "test@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" }));
    localStorage.setItem("aion.notify", "0");
  });
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname, method = req.method(), body = req.postDataJSON();
    calls.push({ path, method, body });
    const json = (value) => route.fulfill({ json: value });
    if (path === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people, devs: ["builder", "reviewer"], devNames: {}, role: "admin", dev: "builder", email: "test@example.invalid", accounts: true, odoo: false, github: false, mail: false, capabilities: [], ai: { enabled: false } });
    if (path === "/ticket-log") return json({ events: url.searchParams.get("key") === "AION-101" ? [{ action: "comment", commentId: "10200", by: { email: "ellen@example.invalid", name: "Ellen Example" } }] : [] });
    if (path === "/jira/search") { const one = /^key = (\S+)/.exec(body.jql); return json({ issues: body.jql.includes("statusCategory = Done") ? [] : state.issues.filter((i) => !one || i.key === one[1]), isLast: true }); }
    if (path === "/internal" && method === "GET") return json({ tickets: [] });
    if (path === "/inbox") return json({ items: [], seenAt: "2026-10-11T08:00:00.000Z", readTickets: [] });
    if (path === "/ticket-notes") return json({ notes: [], people: [] });
    if (path === "/date-requests") return json({ requests: [] });
    if (path === "/clients") return json({ revision: 1, entries: [] });
    if (path === "/ticket-metadata/batch") return json({ records: {} });
    if (path === "/ticket-metadata") return json({ metadata: { revision: 0 }, history: [], closed: false });
    if (path === "/time-entries") return json({ ticket: url.searchParams.get("key"), entries: [], summary: {}, logging: false, canLog: false });
    if (path === "/jira/users") return json([]);
    if (path.endsWith("/changelog")) return json({ changelog: { histories: [] } });
    if (path.endsWith("/history")) return json({ startAt: 0, total: 0, isLast: true, values: [] });
    if (path.endsWith("/transitions")) return json({ transitions: [] });
    if (/^\/jira\/issue\/AION-\d+\/comment$/.test(path) && method === "POST") {
      posts.push(body);
      const next = sends[Math.min(posts.length - 1, sends.length - 1)];
      const answer = typeof next === "function" ? await next(body) : next;
      if (answer.abort) return route.abort("connectionreset");
      if (answer.delay) await new Promise((r) => setTimeout(r, answer.delay));
      return route.fulfill({ status: answer.status || 201, json: answer.json });
    }
    if (/^\/jira\/issue\/AION-\d+\/comment\/\w+$/.test(path) && method === "PUT") return json({ id: path.split("/").pop(), body: body.text });
    unexpected.push({ path, method });
    return route.fulfill({ status: 403, json: { code: "forbidden", error: "Unconfigured test request" } });
  });
  return { calls, unexpected, errors, posts, state };
}

const comment = (page, id) => page.locator(`#d-comments .cmt[data-comment-id="${id}"]`);
const replyTo = (page, id) => comment(page, id).getByRole("button", { name: /^Reply to / }).click();

test("Reply names the comment, keeps the draft apart, and sends the comment's id with no assignee change", async ({ page }) => {
  const mock = await mockJira(page);
  await page.goto("/dashboard.html#AION-101");
  await expect(comment(page, "10100")).toBeVisible();
  await page.locator("#d-reply").fill("Draft written first");
  await replyTo(page, "10100");
  const box = page.locator("#d-replyto");
  await expect(box).toBeVisible();
  await expect(box).toContainText("Replying to");
  await expect(box.locator(".rt-who")).toHaveText("Dana Client");
  await expect(box.locator(".rt-quote")).toHaveText("The export fails when the date is empty");
  await expect(page.locator("#d-send")).toHaveText("Send reply");
  await expect(page.locator("#d-reply")).toBeFocused();
  await expect(page.locator("#d-reply")).toHaveValue("Draft written first");
  await expect(page.locator("#d-after-row")).toBeHidden();
  // Cancel reply keeps the text and goes back to an ordinary comment.
  await box.getByRole("button", { name: "Cancel reply" }).click();
  await expect(box).toBeHidden();
  await expect(page.locator("#d-send")).toHaveText("Add comment");
  await expect(page.locator("#d-reply")).toHaveValue("Draft written first");
  // Reply again and send.
  await replyTo(page, "10100");
  await page.locator("#d-reply").fill("Fixed — please try again");
  await page.locator("#d-send").click();
  await expect.poll(() => mock.posts.length).toBe(1);
  expect(mock.posts[0]).toMatchObject({ text: "Fixed — please try again", replyTo: "10100", requestId: expect.stringMatching(/^[\w-]{8,64}$/) });
  await expect(box).toBeHidden();
  await expect(page.locator("#d-reply")).toHaveValue("");
  await expect(page.locator("#d-send")).toHaveText("Add comment");
  await expect(page.locator("#d-cmsg")).toContainText("Reply sent");
  expect(mock.calls.some((c) => c.method === "PUT" && /assignee/.test(c.path))).toBe(false);
  expect(mock.errors).toEqual([]);
});

test("a blank reply is not sent", async ({ page }) => {
  const mock = await mockJira(page);
  await page.goto("/dashboard.html#AION-101");
  await replyTo(page, "10100");
  await page.locator("#d-send").click();
  await expect(page.locator("#d-cmsg")).toContainText("Write your reply first.");
  expect(mock.posts).toEqual([]);
  await expect(page.locator("#d-replyto")).toBeVisible();
});

test("an ordinary comment is unchanged: no replyTo, and the assignee option is still there", async ({ page }) => {
  const mock = await mockJira(page);
  await page.goto("/dashboard.html#AION-101");
  await expect(page.locator("#d-after-row")).toBeVisible();
  await page.locator("#d-reply").fill("Just a note");
  await page.locator("#d-send").click();
  await expect.poll(() => mock.posts.length).toBe(1);
  expect(mock.posts[0].replyTo).toBeUndefined();
  expect(mock.posts[0].text).toBe("Just a note");
  expect(mock.errors).toEqual([]);
});

test("the reply target is cleared by another ticket and by editing a comment", async ({ page }) => {
  const mock = await mockJira(page);
  await page.goto("/dashboard.html#AION-101");
  await replyTo(page, "10100");
  await expect(page.locator("#d-replyto")).toBeVisible();
  await comment(page, "10300").getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#d-replyto")).toBeHidden();
  await expect(page.locator("#d-send")).toHaveText("Add comment");
  await page.keyboard.press("Escape");
  await page.goto("/dashboard.html#AION-101");
  await replyTo(page, "10100");
  await expect(page.locator("#d-replyto")).toBeVisible();
  await page.evaluate(() => { location.hash = "AION-102"; });
  await expect(page.locator("#d-comments .cmt")).toHaveCount(1);
  await expect(page.locator("#d-replyto")).toBeHidden();
  await expect(page.locator("#d-send")).toHaveText("Add comment");
  expect(mock.errors).toEqual([]);
});

test("a failed reply keeps the text and the target, and the retry reuses the same request id", async ({ page }) => {
  const mock = await mockJira(page, { sends: [{ status: 503, json: { code: "jira", error: "Jira is not answering." } }, { json: { id: "10900", reply: { to: "Dana Client", commentId: "10100", mentioned: true, restricted: "" } } }] });
  await page.goto("/dashboard.html#AION-101");
  await replyTo(page, "10100");
  await page.locator("#d-reply").fill("שלום,\nזה תוקן");
  await page.locator("#d-send").click();
  await expect(page.locator("#d-cmsg")).toContainText("Reply not sent");
  await expect(page.locator("#d-cmsg")).toContainText("Your text and the comment you're replying to are kept.");
  await expect(page.locator("#d-replyto .rt-who")).toHaveText("Dana Client");
  await expect(page.locator("#d-reply")).toHaveValue("שלום,\nזה תוקן");
  await expect(page.locator("#d-send")).toHaveText("Send reply");
  await page.locator("#d-send").click();
  await expect.poll(() => mock.posts.length).toBe(2);
  expect(mock.posts[1].requestId).toBe(mock.posts[0].requestId);
  expect(mock.posts[1].text).toBe("שלום,\nזה תוקן");
  await expect(page.locator("#d-cmsg")).toContainText("Reply sent to Dana Client's comment. Dana Client was mentioned in Jira.");
  await expect(page.locator("#d-replyto")).toBeHidden();
  expect(mock.errors).toEqual([]);
});

test("clicking Send reply twice sends once", async ({ page }) => {
  const mock = await mockJira(page, { sends: [{ delay: 600, json: { id: "10900" } }] });
  await page.goto("/dashboard.html#AION-101");
  await replyTo(page, "10100");
  await page.locator("#d-reply").fill("Once only");
  await page.locator("#d-send").dblclick();
  await page.locator("#d-send").click({ force: true }).catch(() => {});
  await expect(page.locator("#d-cmsg")).toContainText("Reply sent");
  expect(mock.posts.length).toBe(1);
  expect(mock.errors).toEqual([]);
});

test("a deleted comment says so and keeps the text", async ({ page }) => {
  const mock = await mockJira(page, { sends: [{ status: 404, json: { code: "reply_target_unavailable", error: "The comment you're replying to was deleted or can't be read any more. Cancel the reply to send your text as an ordinary comment." } }] });
  await page.goto("/dashboard.html#AION-101");
  await replyTo(page, "10100");
  await page.locator("#d-reply").fill("Are you still there?");
  await page.locator("#d-send").click();
  await expect(page.locator("#d-cmsg")).toContainText("was deleted or can't be read any more");
  await expect(page.locator("#d-reply")).toHaveValue("Are you still there?");
  await expect(page.locator("#d-replyto")).toBeVisible();
  // The refused send's id is dropped: sending it as an ordinary comment is a new send.
  await page.locator("#d-replyto").getByRole("button", { name: "Cancel reply" }).click();
  await page.locator("#d-send").click();
  await expect.poll(() => mock.posts.length).toBe(2);
  expect(mock.posts[1].replyTo).toBeUndefined();
  expect(mock.posts[1].requestId).not.toBe(mock.posts[0].requestId);
  expect(mock.errors).toEqual([]);
});

test("a comment sent from the dashboard shows its Jira author and who sent it, without the signature line; Reply goes to the sender", async ({ page }) => {
  const mock = await mockJira(page);
  await page.goto("/dashboard.html#AION-101");
  const c = comment(page, "10200");
  await expect(c.locator(".cmeta b")).toHaveText("AION Bot");
  await expect(c.locator(".cmeta .via")).toHaveText("Submitted from dashboard by Ellen Example");
  await expect(c.locator(".rich")).toHaveText("Fixed on staging");
  await expect(c.getByRole("button", { name: "Reply to Ellen Example's comment" })).toBeVisible();
  await c.getByRole("button", { name: /^Reply to / }).click();
  await expect(page.locator("#d-replyto .rt-who")).toHaveText("Ellen Example");
  await expect(page.locator("#d-replyto .rt-quote")).toHaveText("Fixed on staging");
  expect(mock.errors).toEqual([]);
});

test("replying to a restricted comment says the reply keeps the restriction", async ({ page }) => {
  const mock = await mockJira(page);
  await page.goto("/dashboard.html#AION-101");
  await replyTo(page, "10300");
  await expect(page.locator("#d-replyto .rt-note")).toHaveText("Your reply will be visible only to Developers (role), like the comment it answers.");
  expect(mock.errors).toEqual([]);
});

test("after a reload the reply still reads as a reply: its context is in the comment itself", async ({ page }) => {
  const reply = { id: "10900", author: { accountId: "aion-bot", displayName: "AION Bot" }, created: "2026-10-11T09:00:00Z", body: "In reply to [~accountid:dana-1] — [view comment|https://jira.example.invalid/browse/AION-101?focusedCommentId=10100]\n{quote}\nThe export fails\n{quote}\nFixed" };
  const html = '<p>In reply to <a class="user-hover" href="#">Dana Client</a> — <a href="https://jira.example.invalid/browse/AION-101?focusedCommentId=10100">view comment</a></p><blockquote><p>The export fails</p></blockquote><p>Fixed</p>';
  const mock = await mockJira(page);
  mock.state.issues[0] = issue("AION-101", [...comments, reply], [...rendered, html]);
  await page.goto("/dashboard.html#AION-101");
  await page.reload();
  const c = comment(page, "10900");
  await expect(c).toContainText("In reply to Dana Client");
  await expect(c.getByRole("link", { name: "view comment" })).toHaveAttribute("href", /focusedCommentId=10100$/);
  await expect(c.locator("blockquote")).toContainText("The export fails");
  expect(mock.errors).toEqual([]);
});
