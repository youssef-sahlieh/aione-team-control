// Replying to one Jira comment from the dashboard (proxy/src/comment-reply.js and POST /jira/issue/KEY/comment).
// Jira is faked below: nothing here reaches a real Jira site.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import worker from "../proxy/src/handler.js";
import { memoryStore } from "../proxy/src/users.js";
import { wikiText, htmlText, excerpt, commentLink, replyAuthor, replyBody, QUOTE_CHARS } from "../proxy/src/comment-reply.js";

const ORIGIN = "https://youssef-sahlieh.github.io", SITE = "https://jira.test";
const HEBREW = "שלום, הבדיקה עברה בהצלחה";
const LONG = Array.from({ length: 8 }, (_, i) => "<p>Line " + (i + 1) + " " + "word ".repeat(30) + "</p>").join("");
// Comments on AION-7 (issue id 10007). 200 belongs to another issue.
const COMMENTS = {
  100: { author: { accountId: "acc-dana", displayName: "Dana Client", active: true, accountType: "atlassian" }, body: "Can you check *the export*?", renderedBody: "<p>Can you check <b>the export</b>?<br/>It fails &amp; stops.</p>" },
  200: { issue: "99999", author: { accountId: "acc-x", displayName: "Other", active: true }, body: "x", renderedBody: "<p>secret of another ticket</p>" },
  300: { author: { accountId: "acc-lead", displayName: "Lead", active: true, accountType: "atlassian" }, body: "internal", renderedBody: "<p>Only developers see this</p>", visibility: { type: "role", value: "Developers" } },
  400: { author: { accountId: "acc-gone", displayName: "Former user", active: false, accountType: "atlassian" }, body: "old", renderedBody: "<p>Old note</p>" },
  500: { author: { accountId: "acc-dana", displayName: "Dana Client", active: true, accountType: "atlassian" }, body: "long", renderedBody: "<p>" + HEBREW + "</p>" + LONG },
  600: { author: { accountId: "acc-bot", displayName: "AION Bot", emailAddress: "bot@x", active: true, accountType: "atlassian" }, body: "Deployed\n\n— Ellen", renderedBody: "<p>Deployed</p><p>— Ellen</p>" },
  700: { author: { accountId: "acc-dana", displayName: "Dana Client", active: true, accountType: "atlassian" }, body: "jsd", renderedBody: "<p>Agent-only note</p>", jsdPublic: false }
};
let calls = [], nextId = 900, postFails = null;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), method = init.method || "GET", body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ path: u.pathname + u.search, method, body });
  if (u.pathname === "/rest/api/3/issue/AION-7" && method === "GET") return Response.json({ id: "10007", key: "AION-7", fields: { labels: ["ai1_ellen"], summary: "Export" } });
  if (u.pathname === "/rest/api/2/issue/AION-7" && method === "GET") return Response.json({ id: "10007", key: "AION-7", fields: { summary: "Export" } });
  const one = /^\/rest\/api\/2\/issue\/AION-7\/comment\/(\d+)$/.exec(u.pathname);
  if (one && method === "GET") {
    const c = COMMENTS[one[1]];
    if (!c) return Response.json({ errorMessages: ["Can not find a comment for the id: " + one[1] + "."] }, { status: 404 });
    return Response.json({ id: one[1], self: SITE + "/rest/api/2/issue/" + (c.issue || "10007") + "/comment/" + one[1], created: "2026-11-01T10:00:00.000+0000", ...c });
  }
  if (u.pathname === "/rest/api/2/issue/AION-7/comment" && method === "POST") {
    if (postFails) return postFails();
    return Response.json({ id: String(nextId++), body: body.body }, { status: 201 });
  }
  return Response.json({});
};

const env = {
  ALLOWED_ORIGIN: ORIGIN, TEAM_EMAILS: "youssef@aione.biz,ellen@aione.biz", JIRA_PROJECT: "AION", MAIL_DOMAIN: "aione.biz",
  APP_URL: "https://dash.test", TEAM_PASSWORD: "Team-password-1", SESSION_SECRET: "s3cret",
  TEAM_CONFIG: "{}", JIRA_SITE: SITE, JIRA_EMAIL: "bot@x", JIRA_API_TOKEN: "t", STORE: memoryStore()
};
const call = async (path, { method = "GET", body, token } = {}) => {
  const r = await worker.fetch(new Request("https://p" + path, { method, headers: { Origin: ORIGIN, "x-real-ip": "1.1.1.1", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json().catch(() => null) };
};
let admin = "";
const send = (body, token = admin) => call("/jira/issue/AION-7/comment", { method: "POST", token, body });
const posted = () => calls.filter((c) => c.method === "POST" && c.path === "/rest/api/2/issue/AION-7/comment");

before(async () => {
  admin = (await call("/login", { method: "POST", body: { email: "youssef@aione.biz", password: "Team-password-1" } })).data.token;
  // Comment 600 was sent from the dashboard by Ellen (Jira shows the proxy's account).
  await env.STORE.set("tlog:AION-7", JSON.stringify([{ at: "2026-11-01T10:00:00Z", by: { email: "ellen@aione.biz", name: "Ellen" }, action: "comment", text: "Deployed", commentId: "600" }]));
});

test("wiki text is shown as itself: formatting, links, macros and mentions are escaped", () => {
  assert.equal(wikiText("*bold* [link|x] {quote} [~accountid:1] a\\b"), "\\*bold\\* \\[link\\|x\\] \\{quote\\} \\[\\~accountid:1\\] a&#92;b");
  assert.equal(wikiText(HEBREW), HEBREW);
});

test("Jira's rendered HTML becomes plain text with its line breaks", () => {
  assert.equal(htmlText("<p>One<br/>Two &amp; &lt;three&gt; &#1513;</p><p>Four</p>"), "One\nTwo & <three> ש\nFour");
});

test("the quote is bounded in lines and characters, never cuts a character, and marks what was left out", () => {
  const long = htmlText(COMMENTS[500].renderedBody), q = excerpt(long);
  assert.ok([...q].length <= QUOTE_CHARS + 1); assert.ok(q.endsWith("…")); assert.ok(q.split("\n").length <= 4);
  assert.ok(q.startsWith(HEBREW));
  assert.equal(excerpt("short"), "short");
  assert.equal(excerpt("😀".repeat(400)), "😀".repeat(QUOTE_CHARS) + "…");
});

test("the link is Jira's comment permalink on the configured site", () => {
  assert.equal(commentLink(SITE + "/", "AION-7", "100"), SITE + "/browse/AION-7?focusedCommentId=100");
});

test("who is answered: a Jira author is mentioned by account id; an unavailable, app or proxy account only named", () => {
  assert.deepEqual(replyAuthor(COMMENTS[100], null), { name: "Dana Client", email: "", accountId: "acc-dana", viaDashboard: false });
  assert.equal(replyAuthor(COMMENTS[400], null).accountId, "");
  assert.equal(replyAuthor({ author: { accountId: "app-1", displayName: "Automation", accountType: "app" } }, null).accountId, "");
  assert.equal(replyAuthor(COMMENTS[600], null, "bot@x").accountId, "");
  assert.deepEqual(replyAuthor(COMMENTS[600], { by: { name: "Ellen", email: "ellen@aione.biz" } }), { name: "Ellen", email: "ellen@aione.biz", accountId: "", viaDashboard: true });
});

test("the reply's body: who and which comment, the quote, the reply, then the sender's name", () => {
  const body = replyBody({ site: SITE, key: "AION-7", commentId: "100", author: { name: "Dana", accountId: "acc-dana" }, quote: "a *b*\nc", text: "Fixed.\n" + HEBREW, signature: "Ellen" });
  assert.equal(body, "In reply to [~accountid:acc-dana] — [view comment|" + SITE + "/browse/AION-7?focusedCommentId=100]\n{quote}\na \\*b\\*\nc\n{quote}\nFixed.\n" + HEBREW + "\n\n— Ellen");
  // Plain text such as "Ellen," is never turned into a mention.
  assert.doesNotMatch(replyBody({ site: SITE, key: "AION-7", commentId: "1", author: { name: "Ellen,", accountId: "" }, quote: "", text: "Ellen, done" }), /accountid/);
});

test("a reply to a specific comment: read from Jira on this ticket, posted with link, quote and mention", async () => {
  calls = [];
  const r = await send({ text: "Done, see the new export.\nשורה שנייה", replyTo: "100", requestId: "req-reply-100" });
  assert.equal(r.status, 200);
  assert.ok(calls.some((c) => c.path === "/rest/api/2/issue/AION-7/comment/100?expand=renderedBody"));
  const [p] = posted();
  assert.equal(p.body.body, "In reply to [~accountid:acc-dana] — [view comment|" + SITE + "/browse/AION-7?focusedCommentId=100]\n{quote}\nCan you check the export?\nIt fails & stops.\n{quote}\nDone, see the new export.\nשורה שנייה\n\n— Youssef");
  assert.equal(p.body.visibility, undefined);
  assert.deepEqual(r.data.reply, { to: "Dana Client", commentId: "100", mentioned: true, restricted: "" });
  // Never edits the comment answered, never changes the assignee.
  assert.ok(!calls.some((c) => c.method === "PUT"));
  const log = JSON.parse(await env.STORE.get("tlog:AION-7"));
  assert.deepEqual({ action: log.at(-1).action, replyTo: log.at(-1).replyTo, commentId: log.at(-1).commentId }, { action: "comment", replyTo: "100", commentId: r.data.id });
});

test("an ordinary comment is unchanged: no link, no quote", async () => {
  calls = [];
  const r = await send({ text: "hello" });
  assert.equal(r.status, 200);
  assert.deepEqual(posted()[0].body, { body: "hello\n\n— Youssef" });
  assert.ok(!calls.some((c) => /\/comment\/\d+/.test(c.path)));
});

test("a comment of another ticket, a deleted one or a bad id is refused clearly and nothing is posted", async () => {
  calls = [];
  for (const replyTo of ["200", "404404"]) {
    const r = await send({ text: "reply", replyTo });
    assert.equal(r.status, 404); assert.equal(r.data.code, "reply_target_unavailable"); assert.match(r.data.error, /Cancel the reply/);
  }
  assert.equal((await send({ text: "reply", replyTo: "../12" })).status, 400);
  assert.equal(posted().length, 0);
});

test("a restricted comment's reply keeps the same restriction (never visible to more people)", async () => {
  calls = [];
  const r = await send({ text: "ok", replyTo: "300" });
  assert.equal(r.status, 200);
  assert.deepEqual(posted()[0].body.visibility, { type: "role", value: "Developers" });
  assert.equal(r.data.reply.restricted, "Visible only to Developers (role)");
  calls = [];
  await send({ text: "ok", replyTo: "700" });
  assert.deepEqual(posted()[0].body.properties, [{ key: "sd.public.comment", value: { internal: true } }]);
});

test("an unavailable author is named, not mentioned, and the reply says so", async () => {
  calls = [];
  const r = await send({ text: "noted", replyTo: "400" });
  assert.match(posted()[0].body.body, /^In reply to Former user — \[view comment\|/);
  assert.equal(r.data.reply.mentioned, false);
});

test("a long Hebrew comment is quoted short; a blank reply is refused", async () => {
  calls = [];
  await send({ text: "תודה", replyTo: "500" });
  const quote = /\{quote\}\n([\s\S]*)\n\{quote\}/.exec(posted()[0].body.body)[1];
  assert.ok(quote.startsWith(HEBREW)); assert.ok(quote.endsWith("…")); assert.ok([...quote].length < 340);
  assert.equal((await send({ text: "   ", replyTo: "500" })).status, 400);
});

test("a reply to a comment sent from the dashboard names its sender, not the proxy account, and notifies them", async () => {
  calls = [];
  const r = await send({ text: "Thanks!", replyTo: "600" });
  const body = posted()[0].body.body;
  assert.match(body, /^In reply to Ellen \(via AION Team Control\) — /);
  assert.match(body, /\{quote\}\nDeployed\n\{quote\}/);
  assert.doesNotMatch(body, /accountid:acc-bot/);
  assert.deepEqual(r.data.reply, { to: "Ellen", commentId: "600", mentioned: false, restricted: "" });
  const inbox = await env.STORE.get("inbox:ellen@aione.biz");
  assert.ok(inbox === null || /AION-7/.test(inbox));
});

test("the same send arriving twice posts once; a send still in progress is not posted again", async () => {
  calls = [];
  const a = await send({ text: "once", replyTo: "100", requestId: "req-twice-1" });
  const b = await send({ text: "once", replyTo: "100", requestId: "req-twice-1" });
  assert.equal(posted().length, 1);
  assert.equal(b.status, 200); assert.equal(b.data.duplicate, true); assert.equal(b.data.id, a.data.id);
  await env.STORE.setIfAbsent("csend:AION-7:req-in-flight", "sending", 120);
  const c = await send({ text: "once", requestId: "req-in-flight" });
  assert.equal(c.status, 409); assert.equal(c.data.code, "comment_pending"); assert.equal(posted().length, 1);
});

test("a failed post can be sent again with the same id", async () => {
  calls = []; postFails = () => Response.json({ errorMessages: ["down"] }, { status: 503 });
  const a = await send({ text: "retry me", replyTo: "100", requestId: "req-retry-1" });
  assert.equal(a.status, 502);
  postFails = null;
  const b = await send({ text: "retry me", replyTo: "100", requestId: "req-retry-1" });
  assert.equal(b.status, 200); assert.equal(b.data.duplicate, undefined);
  assert.equal(posted().length, 2);
});

test("another project's ticket is refused before Jira is asked anything (project restrictions stay)", async () => {
  calls = [];
  const r = await call("/jira/issue/OTHER-1/comment", { method: "POST", token: admin, body: { text: "x", replyTo: "100" } });
  assert.equal(r.status, 404);
  assert.equal(calls.length, 0);
});
