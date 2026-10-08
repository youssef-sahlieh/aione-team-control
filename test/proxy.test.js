// Run with: npm test  (Node 20+). Checks the proxy's sign-in, its limits on Jira, and what it sends to Jira.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { makeToken, readToken } from "../proxy/src/handler.js";
import { POST as vercelPost, GET as vercelGet } from "../proxy/api/proxy.js";

const ORIGIN = "https://youssef-sahlieh.github.io";
const env = {
  ALLOWED_ORIGIN: ORIGIN, TEAM_EMAILS: "youssef@aione.biz,ellen@aione.biz", JIRA_PROJECT: "AION",
  TEAM_PASSWORD: "right-password", SESSION_SECRET: "test-session-secret", TEAM_CONFIG: JSON.stringify({ people: { youssef: { id: "acc-1", name: "Youssef", ini: "Y" } } }),
  JIRA_SITE: "https://example.atlassian.net", JIRA_EMAIL: "bot@aione.biz", JIRA_API_TOKEN: "jira-token",
  LOGIN_LIMIT: { limit: async () => ({ success: true }) } // tests sign in many times; the limit itself is tested separately
};

// Fake Jira: records every call and answers with canned data.
let jiraCalls = [];
let jiraReply = () => Response.json({});
globalThis.fetch = async (url, init = {}) => {
  jiraCalls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body ? (() => { try { return JSON.parse(init.body); } catch { return init.body; } })() : undefined });
  return jiraReply(String(url), init);
};

const call = (path, { method = "GET", body, token, origin = ORIGIN } = {}) => worker.fetch(new Request("https://proxy.test" + path, {
  method, body: body !== undefined ? JSON.stringify(body) : undefined,
  headers: { ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: "Bearer " + token } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }
}), env);
const login = async (email = "youssef@aione.biz", password = "right-password") => (await (await call("/login", { method: "POST", body: { email, password } })).json()).token;

const tests = [
  ["sign-in works for youssef", async () => { const r = await call("/login", { method: "POST", body: { email: "youssef@aione.biz", password: "right-password" } }); assert.equal(r.status, 200); const d = await r.json(); assert.equal(d.email, "youssef@aione.biz"); assert.ok(d.token && d.expiresAt > Date.now()); }],
  ["sign-in works for ellen, any case and spaces", async () => assert.ok(await login("  Ellen@AIONE.biz ")) ],
  ["wrong password refused", async () => { const r = await call("/login", { method: "POST", body: { email: "youssef@aione.biz", password: "nope" } }); assert.equal(r.status, 401); assert.equal((await r.json()).code, "login"); }],
  ["unknown email refused", async () => assert.equal((await call("/login", { method: "POST", body: { email: "x@aione.biz", password: "right-password" } })).status, 401)],
  ["empty body refused", async () => assert.equal((await call("/login", { method: "POST" })).status, 401)],
  ["sign-in refused when no password is configured", async () => { const r = await worker.fetch(new Request("https://p/login", { method: "POST", body: JSON.stringify({ email: "youssef@aione.biz", password: "" }) }), { ...env, TEAM_PASSWORD: "" }); assert.equal(r.status, 401); }],
  ["rate limit blocks sign-in", async () => { const r = await worker.fetch(new Request("https://p/login", { method: "POST", body: "{}" }), { ...env, LOGIN_LIMIT: { limit: async () => ({ success: false }) } }); assert.equal(r.status, 429); }],

  ["no token: Jira blocked", async () => { jiraCalls = []; const r = await call("/jira/search", { method: "POST", body: { jql: "project = AION", fields: [] } }); assert.equal(r.status, 401); assert.equal((await r.json()).code, "session"); assert.equal(jiraCalls.length, 0); }],
  ["forged token blocked", async () => { const t = await login(); const [body] = t.split("."); assert.equal((await call("/config", { token: body + ".AAAA" })).status, 401); }],
  ["token from another secret blocked", async () => { const { token } = await makeToken({ ...env, SESSION_SECRET: "other" }, "youssef@aione.biz"); assert.equal(await readToken(env, "Bearer " + token), null); }],
  ["expired token blocked", async () => { const { token } = await makeToken(env, "youssef@aione.biz", Date.now() - 13 * 3600e3); assert.equal(await readToken(env, "Bearer " + token), null); }],
  ["token stops working when the email is removed", async () => { const { token } = await makeToken(env, "ellen@aione.biz"); assert.equal(await readToken({ ...env, TEAM_EMAILS: "youssef@aione.biz" }, "Bearer " + token), null); }],

  ["config returns team details, site and email", async () => { const d = await (await call("/config", { token: await login() })).json(); assert.equal(d.people.youssef.id, "acc-1"); assert.equal(d.site, env.JIRA_SITE); assert.equal(d.project, "AION"); assert.equal(d.email, "youssef@aione.biz"); }],

  ["search goes to Jira with the proxy's credentials and rendered HTML", async () => {
    jiraCalls = []; jiraReply = () => Response.json({ issues: [{ key: "AION-1" }], isLast: true });
    const r = await call("/jira/search", { method: "POST", token: await login(), body: { jql: "project = AION ORDER BY updated DESC", fields: ["summary"], maxResults: 500 } });
    assert.equal(r.status, 200);
    const c = jiraCalls[0];
    assert.equal(c.url, "https://example.atlassian.net/rest/api/3/search/jql");
    assert.equal(c.headers.Authorization, "Basic " + btoa("bot@aione.biz:jira-token"));
    assert.equal(c.body.expand, "renderedFields"); assert.equal(c.body.maxResults, 100);
  }],
  ["search never returns other projects' tickets", async () => {
    jiraReply = () => Response.json({ issues: [{ key: "AION-1" }, { key: "SECRET-9" }, { key: "AIONX-2" }], isLast: true });
    const d = await (await call("/jira/search", { method: "POST", token: await login(), body: { jql: "project = AION OR project = SECRET", fields: [] } })).json();
    assert.deepEqual(d.issues.map((i) => i.key), ["AION-1"]);
  }],
  ["other projects' tickets can't be changed", async () => { jiraCalls = []; const r = await call("/jira/issue/SECRET-1", { method: "PUT", token: await login(), body: { fields: { duedate: null } } }); assert.equal(r.status, 404); assert.equal(jiraCalls.length, 0); }],
  ["edit: due date, labels and assignee pass through", async () => {
    jiraCalls = []; jiraReply = () => new Response(null, { status: 204 });
    const r = await call("/jira/issue/AION-7", { method: "PUT", token: await login(), body: { fields: { duedate: "2026-10-20", labels: ["ai1_ellen"], assignee: { accountId: "acc-1" } } } });
    assert.equal(r.status, 200);
    assert.equal(jiraCalls[0].url, "https://example.atlassian.net/rest/api/3/issue/AION-7"); assert.equal(jiraCalls[0].method, "PUT");
    assert.deepEqual(jiraCalls[0].body, { fields: { duedate: "2026-10-20", labels: ["ai1_ellen"], assignee: { accountId: "acc-1" } } });
  }],
  ["edit: other fields refused", async () => { jiraCalls = []; const r = await call("/jira/issue/AION-7", { method: "PUT", token: await login(), body: { fields: { summary: "hacked" } } }); assert.equal(r.status, 400); assert.equal(jiraCalls.length, 0); }],
  ["edit: bad due date refused", async () => assert.equal((await call("/jira/issue/AION-7", { method: "PUT", token: await login(), body: { fields: { duedate: "soon" } } })).status, 400)],
  ["status move", async () => { jiraCalls = []; jiraReply = () => new Response(null, { status: 204 }); await call("/jira/issue/AION-7/transitions", { method: "POST", token: await login(), body: { id: 31 } }); assert.deepEqual(jiraCalls[0].body, { transition: { id: "31" } }); }],
  ["comment uses plain text", async () => { jiraCalls = []; jiraReply = () => Response.json({ id: "1" }, { status: 201 }); await call("/jira/issue/AION-7/comment", { method: "POST", token: await login(), body: { text: " hello " } }); assert.equal(jiraCalls[0].url, "https://example.atlassian.net/rest/api/2/issue/AION-7/comment"); assert.deepEqual(jiraCalls[0].body, { body: "hello" }); }],
  ["changelog", async () => { jiraCalls = []; jiraReply = () => Response.json({ changelog: { histories: [] } }); await call("/jira/issue/AION-7/changelog", { token: await login() }); assert.equal(jiraCalls[0].url, "https://example.atlassian.net/rest/api/3/issue/AION-7?fields=duedate&expand=changelog"); }],
  ["user search", async () => { jiraCalls = []; jiraReply = () => Response.json([]); await call("/jira/users?q=ka%20ri", { token: await login() }); assert.equal(jiraCalls[0].url, "https://example.atlassian.net/rest/api/3/user/search?maxResults=8&query=ka%20ri"); }],
  ["Jira errors come back readable, without signing the user out", async () => {
    jiraReply = () => Response.json({ errorMessages: ["You can't do that."] }, { status: 403 });
    const r = await call("/jira/issue/AION-7/transitions", { method: "POST", token: await login(), body: { id: 1 } });
    assert.equal(r.status, 403); assert.deepEqual(await r.json(), { code: "jira", error: "You can't do that." });
  }],
  ["bad Jira token reported as a proxy problem, not a sign-in problem", async () => { jiraReply = () => new Response("", { status: 401 }); const r = await call("/jira/issue/AION-7/changelog", { token: await login() }); assert.equal(r.status, 502); assert.equal((await r.json()).code, "jira"); }],

  ["email off without Microsoft settings", async () => {
    const t = await login();
    assert.equal((await (await call("/config", { token: t })).json()).mail, false);
    const r = await call("/mail", { method: "POST", token: t, body: { to: ["ellen@aione.biz"], subject: "Hi", html: "<p>x</p>" } });
    assert.equal(r.status, 501); assert.equal((await r.json()).code, "mail_off");
  }],
  ["email sent from the signed-in person's mailbox through Microsoft Graph", async () => {
    const menv = { ...env, MAIL_DOMAIN: "aione.biz", MS_TENANT_ID: "tenant-1", MS_CLIENT_ID: "client-1", MS_CLIENT_SECRET: "shh" };
    jiraCalls = []; jiraReply = (url) => url.includes("login.microsoftonline.com") ? Response.json({ access_token: "graph-token", expires_in: 3600 }) : new Response(null, { status: 202 });
    const { token } = await makeToken(menv, "ellen@aione.biz");
    const req = (body) => worker.fetch(new Request("https://p/mail", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) }), menv);
    const r = await req({ to: ["Bashar.B@aione.biz"], subject: "Internal note", html: "<p>Hello</p>" });
    assert.equal(r.status, 200);
    const tok = jiraCalls.find((c) => c.url.includes("/oauth2/v2.0/token"));
    assert.equal(tok.url, "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
    const send = jiraCalls.find((c) => c.url.includes("graph.microsoft.com"));
    assert.equal(send.url, "https://graph.microsoft.com/v1.0/users/ellen%40aione.biz/sendMail");
    assert.equal(send.headers.Authorization, "Bearer graph-token");
    assert.deepEqual(send.body.message.toRecipients, [{ emailAddress: { address: "Bashar.B@aione.biz" } }]);
    assert.equal(send.body.message.body.contentType, "HTML"); assert.equal(send.body.saveToSentItems, true);
    jiraCalls = [];
    assert.equal((await req({ to: ["someone@gmail.com"], subject: "x", html: "<p>x</p>" })).status, 400, "outside addresses refused");
    assert.equal((await req({ to: ["a@aione.biz.evil.com"], subject: "x", html: "<p>x</p>" })).status, 400, "look-alike domain refused");
    assert.equal(jiraCalls.length, 0);
    jiraReply = (url) => url.includes("graph.microsoft.com") ? Response.json({ error: { message: "denied" } }, { status: 403 }) : Response.json({ access_token: "graph-token", expires_in: 3600 });
    const bad = await req({ to: ["ellen@aione.biz"], subject: "x", html: "<p>x</p>" });
    assert.equal(bad.status, 502); assert.match((await bad.json()).error, /Mail\.Send/);
  }],

  ["Vercel entry restores the path and reads secrets from the environment", async () => {
    Object.assign(process.env, { TEAM_PASSWORD: "vercel-pass", SESSION_SECRET: "s", TEAM_CONFIG: "{}", JIRA_SITE: "https://example.atlassian.net" });
    const r = await vercelPost(new Request("https://p.vercel.app/api/proxy?__path=login", { method: "POST", headers: { Origin: ORIGIN, "x-forwarded-for": "1.2.3.4" }, body: JSON.stringify({ email: "ellen@aione.biz", password: "vercel-pass" }) }));
    assert.equal(r.status, 200); assert.equal(r.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    const bad = await vercelPost(new Request("https://p.vercel.app/api/proxy?__path=login", { method: "POST", body: JSON.stringify({ email: "ellen@aione.biz", password: "right-password" }) }));
    assert.equal(bad.status, 401, "uses Vercel's password, not another one");
  }],
  ["email through the host's mailer (Gmail): sender name, reply-to and recipients", async () => {
    const sent = [];
    const genv = { ...env, MAIL_DOMAIN: "aione.biz", MAILER: async (m) => { sent.push(m); } };
    const { token } = await makeToken(genv, "ellen@aione.biz");
    const send = (body) => worker.fetch(new Request("https://p/mail", { method: "POST", headers: { Authorization: "Bearer " + token }, body: JSON.stringify(body) }), genv);
    assert.equal((await (await worker.fetch(new Request("https://p/config", { headers: { Authorization: "Bearer " + token } }), genv)).json()).mail, true);
    const r = await send({ to: ["sondos@aione.biz"], subject: "New Jira assignment", html: "<p>Hi</p>" });
    assert.equal(r.status, 200);
    assert.deepEqual(sent[0], { fromName: "Ellen via AION Team Control", replyTo: "ellen@aione.biz", to: ["sondos@aione.biz"], subject: "New Jira assignment", html: "<p>Hi</p>" });
    assert.equal((await send({ to: ["x@gmail.com"], subject: "s", html: "<p>x</p>" })).status, 400, "outside addresses refused");
    assert.equal(sent.length, 1);
  }],
  ["mailer failures come back readable", async () => {
    const genv = { ...env, MAIL_DOMAIN: "aione.biz", MAILER: async () => { throw new Error("Invalid login: 535-5.7.8 Username and Password not accepted"); } };
    const { token } = await makeToken(genv, "youssef@aione.biz");
    const r = await worker.fetch(new Request("https://p/mail", { method: "POST", headers: { Authorization: "Bearer " + token }, body: JSON.stringify({ to: ["ellen@aione.biz"], subject: "s", html: "<p>x</p>" }) }), genv);
    assert.equal(r.status, 502); assert.match((await r.json()).error, /GMAIL_APP_PASSWORD/);
  }],
  ["Vercel entry turns Gmail on only when both Gmail settings are set", async () => {
    const t = await (await vercelPost(new Request("https://p.vercel.app/api/proxy?__path=login", { method: "POST", headers: { "x-forwarded-for": "5.6.7.8" }, body: JSON.stringify({ email: "youssef@aione.biz", password: "vercel-pass" }) }))).json();
    const mailFlag = async () => (await (await vercelGet(new Request("https://p.vercel.app/api/proxy?__path=config", { headers: { Authorization: "Bearer " + t.token } }))).json()).mail;
    delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD;
    assert.equal(await mailFlag(), false);
    process.env.GMAIL_USER = "aione.bot@gmail.com";
    assert.equal(await mailFlag(), false, "user alone isn't enough");
    process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
    assert.equal(await mailFlag(), true);
    delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD;
  }],
  ["built-in sign-in limit: 11th try in a minute from one address is refused", async () => {
    const { LOGIN_LIMIT, ...noLimit } = env;
    const tryOnce = () => worker.fetch(new Request("https://p/login", { method: "POST", headers: { "x-real-ip": "9.9.9.9" }, body: "{}" }), noLimit);
    for (let n = 0; n < 10; n++) assert.equal((await tryOnce()).status, 401);
    assert.equal((await tryOnce()).status, 429);
  }],

  ["CORS allows the dashboard", async () => { const r = await call("/login", { method: "OPTIONS" }); assert.equal(r.status, 204); assert.equal(r.headers.get("Access-Control-Allow-Origin"), ORIGIN); }],
  ["CORS refuses other sites", async () => { const r = await call("/login", { method: "OPTIONS", origin: "https://evil.example" }); assert.equal(r.headers.get("Access-Control-Allow-Origin"), null); }],

  ["pages have no inline scripts or style attributes (blocked by their security policy)", () => {
    for (const f of ["../public/index.html", "../public/dashboard.html"]) {
      const page = readFileSync(new URL(f, import.meta.url), "utf8");
      assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)[^>]*>/, f);
      assert.doesNotMatch(page, /\sstyle="/, f);
    }
  }],
  ["no team details or Jira site in the public dashboard code", () => {
    const code = readFileSync(new URL("../public/assets/dashboard.js", import.meta.url), "utf8");
    const found = code.match(/712020:|atlassian\.net|(?<!name)@aione\.biz/);
    assert.equal(found, null, "found " + (found && found[0]));
  }]
];

let pass = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log("ok   -", name); }
  catch (e) { console.log("FAIL -", name, "\n      ", e.message); process.exitCode = 1; }
}
console.log(`\n${pass}/${tests.length} passed`);
