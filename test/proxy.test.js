// Run with: npm test  (Node 20+). Checks the proxy's sign-in, its limits on Jira, and what it sends to Jira.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { makeToken, readToken } from "../worker/src/index.js";

const ORIGIN = "https://youssef-sahlieh.github.io";
const env = {
  ALLOWED_ORIGIN: ORIGIN, TEAM_EMAILS: "youssef@aione.biz,ellen@aione.biz", JIRA_PROJECT: "AION",
  TEAM_PASSWORD: "right-password", SESSION_SECRET: "test-session-secret", TEAM_CONFIG: JSON.stringify({ people: { youssef: { id: "acc-1", name: "Youssef", ini: "Y" } } }),
  JIRA_SITE: "https://example.atlassian.net", JIRA_EMAIL: "bot@aione.biz", JIRA_API_TOKEN: "jira-token"
};

// Fake Jira: records every call and answers with canned data.
let jiraCalls = [];
let jiraReply = () => Response.json({});
globalThis.fetch = async (url, init = {}) => {
  jiraCalls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
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
