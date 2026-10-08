// Run with: npm test  (Node 20+). Checks user accounts: first sign-in, roles, invitations, password resets,
// and that users only reach the tickets labelled with their developer name.
import assert from "node:assert/strict";
import worker from "../proxy/src/handler.js";
import { memoryStore } from "../proxy/src/users.js";

const ORIGIN = "https://youssef-sahlieh.github.io";
const mails = [];
let jiraCalls = [];
// Fake Jira: AION-1 belongs to developer "bashar", AION-2 to "ellen".
const LABELS = { "AION-1": ["ai1_bashar"], "AION-2": ["ai1_ellen"] };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), body = init.body ? JSON.parse(init.body) : undefined;
  jiraCalls.push({ path: u.pathname + u.search, method: init.method || "GET", body });
  if (u.pathname === "/rest/api/3/search/jql") return Response.json({ issues: Object.entries(LABELS).map(([key, labels]) => ({ key, fields: { labels } })), isLast: true });
  const m = /\/issue\/(AION-\d+)$/.exec(u.pathname);
  if (m && (init.method || "GET") === "GET") return Response.json({ key: m[1], fields: { labels: LABELS[m[1]] || [] } });
  if ((init.method || "GET") === "PUT") return new Response(null, { status: 204 });
  if (/\/transitions$/.test(u.pathname)) return init.method === "POST" ? new Response(null, { status: 204 }) : Response.json({ transitions: [] });
  return Response.json({});
};

function makeEnv() {
  return {
    ALLOWED_ORIGIN: ORIGIN, TEAM_EMAILS: "youssef@aione.biz,ellen@aione.biz", JIRA_PROJECT: "AION", MAIL_DOMAIN: "aione.biz",
    APP_URL: "https://youssef-sahlieh.github.io/aione-team-control", TEAM_PASSWORD: "Team-password-1", SESSION_SECRET: "s3cret",
    TEAM_CONFIG: "{}", JIRA_SITE: "https://jira.test", JIRA_EMAIL: "bot@x", JIRA_API_TOKEN: "t",
    STORE: memoryStore(), MAILER: async (m) => { mails.push(m); }
  };
}
let env = makeEnv();
const call = async (path, { method = "GET", body, token, ip = "1.1.1.1" } = {}) => {
  const r = await worker.fetch(new Request("https://p" + path, { method, headers: { Origin: ORIGIN, "x-real-ip": ip, ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json().catch(() => null) };
};
const login = async (email, password, ip) => (await call("/login", { method: "POST", body: { email, password }, ip })).data;
const linkToken = (mail) => /reset\.html#t=([\w-]+)/.exec(mail.html)[1];

const tests = [
  ["first sign-in with the team password creates both admins", async () => {
    const d = await login("youssef@aione.biz", "Team-password-1");
    assert.equal(d.role, "admin"); assert.ok(d.token);
    const e = await login("ellen@aione.biz", "Team-password-1");
    assert.equal(e.role, "admin");
    assert.match(env.STORE._data.get("u:youssef@aione.biz"), /"hash"/);
    assert.doesNotMatch(env.STORE._data.get("u:youssef@aione.biz"), /Team-password-1/);
  }],
  ["wrong password and unknown email refused", async () => {
    assert.equal((await call("/login", { method: "POST", body: { email: "youssef@aione.biz", password: "nope" }, ip: "2.2.2.2" })).status, 401);
    assert.equal((await call("/login", { method: "POST", body: { email: "x@aione.biz", password: "Team-password-1" }, ip: "2.2.2.2" })).status, 401);
  }],
  ["sign-in limit is shared through the database", async () => {
    for (let n = 0; n < 10; n++) await call("/login", { method: "POST", body: { email: "youssef@aione.biz", password: "nope" }, ip: "3.3.3.3" });
    assert.equal((await call("/login", { method: "POST", body: { email: "youssef@aione.biz", password: "Team-password-1" }, ip: "3.3.3.3" })).status, 429);
  }],
  ["admin adds a user: invitation email with a set-password link, no password yet", async () => {
    const admin = await login("youssef@aione.biz", "Team-password-1", "4.4.4.4");
    mails.length = 0;
    const r = await call("/users", { method: "POST", token: admin.token, body: { email: "Bashar.B@aione.biz", name: "Bashar", role: "user", dev: "ai1_bashar" } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.data.user, { email: "bashar.b@aione.biz", name: "Bashar", role: "user", dev: "bashar", hasPassword: false, createdAt: r.data.user.createdAt });
    assert.equal(r.data.invited, true); assert.equal(r.data.link, undefined);
    assert.equal(mails.length, 1); assert.deepEqual(mails[0].to, ["bashar.b@aione.biz"]);
    assert.match(mails[0].html, /Youssef added you/); assert.match(mails[0].html, /developer \(ai1_bashar\)/);
    assert.equal((await login("bashar.b@aione.biz", "")).token, undefined, "can't sign in before choosing a password");
    assert.equal((await call("/users", { method: "POST", token: admin.token, body: { email: "bashar.b@aione.biz", name: "B", role: "user", dev: "bashar" } })).status, 409);
    assert.equal((await call("/users", { method: "POST", token: admin.token, body: { email: "new@aione.biz", name: "N", role: "user" } })).status, 400, "a user needs a developer");
  }],
  ["invitation link: check, set password once, then sign in", async () => {
    const t = linkToken(mails[0]);
    const c = await call("/reset/check", { method: "POST", body: { token: t } });
    assert.equal(c.data.purpose, "invite"); assert.equal(c.data.email, "bashar.b@aione.biz");
    assert.equal((await call("/reset", { method: "POST", body: { token: t, password: "short" } })).status, 400, "too short");
    assert.equal((await call("/reset", { method: "POST", body: { token: t, password: "Bashar-pass-123" } })).status, 200);
    assert.equal((await call("/reset", { method: "POST", body: { token: t, password: "Again-pass-123" } })).status, 400, "link works once");
    const d = await login("bashar.b@aione.biz", "Bashar-pass-123", "5.5.5.5");
    assert.equal(d.role, "user");
  }],
  ["user sees only their developer's tickets", async () => {
    const u = await login("bashar.b@aione.biz", "Bashar-pass-123", "5.5.5.5");
    const cfg = await call("/config", { token: u.token });
    assert.equal(cfg.data.role, "user"); assert.equal(cfg.data.dev, "bashar"); assert.equal(cfg.data.mail, false);
    jiraCalls = [];
    const s = await call("/jira/search", { method: "POST", token: u.token, body: { jql: "project = AION ORDER BY updated DESC", fields: ["summary"] } });
    assert.deepEqual(s.data.issues.map((i) => i.key), ["AION-1"]);
    assert.equal(jiraCalls[0].body.jql, 'labels = "ai1_bashar" AND (project = AION) ORDER BY updated DESC');
    assert.ok(jiraCalls[0].body.fields.includes("labels"));
  }],
  ["user can set due dates, move status and comment on their tickets only", async () => {
    const u = await login("bashar.b@aione.biz", "Bashar-pass-123", "5.5.5.5");
    assert.equal((await call("/jira/issue/AION-1", { method: "PUT", token: u.token, body: { fields: { duedate: "2026-12-01" } } })).status, 200);
    assert.equal((await call("/jira/issue/AION-1/transitions", { method: "POST", token: u.token, body: { id: 5 } })).status, 200);
    assert.equal((await call("/jira/issue/AION-2", { method: "PUT", token: u.token, body: { fields: { duedate: "2026-12-01" } } })).status, 403, "someone else's ticket");
    assert.equal((await call("/jira/issue/AION-2/changelog", { token: u.token })).status, 403);
    assert.equal((await call("/jira/issue/AION-1", { method: "PUT", token: u.token, body: { fields: { labels: ["ai1_bashar", "ai1_x"] } } })).status, 403, "can't change developers");
    assert.equal((await call("/jira/issue/AION-1", { method: "PUT", token: u.token, body: { fields: { assignee: null } } })).status, 403, "can't change assignee");
  }],
  ["user can't manage users, send emails or search Jira people", async () => {
    const u = await login("bashar.b@aione.biz", "Bashar-pass-123", "5.5.5.5");
    assert.equal((await call("/users", { token: u.token })).status, 403);
    assert.equal((await call("/users", { method: "POST", token: u.token, body: { email: "me2@aione.biz", name: "x", role: "admin" } })).status, 403);
    assert.equal((await call("/mail", { method: "POST", token: u.token, body: { to: ["ellen@aione.biz"], subject: "x", html: "x" } })).status, 403);
    assert.equal((await call("/jira/users?q=ab", { token: u.token })).status, 403);
  }],
  ["admin still sees every ticket", async () => {
    const a = await login("ellen@aione.biz", "Team-password-1", "6.6.6.6");
    const s = await call("/jira/search", { method: "POST", token: a.token, body: { jql: "project = AION", fields: [] } });
    assert.deepEqual(s.data.issues.map((i) => i.key), ["AION-1", "AION-2"]);
  }],
  ["forgot password: same answer for unknown emails, email with link for real ones", async () => {
    mails.length = 0;
    assert.equal((await call("/forgot", { method: "POST", body: { email: "nobody@aione.biz" }, ip: "7.7.7.7" })).status, 200);
    assert.equal(mails.length, 0);
    const before = await login("bashar.b@aione.biz", "Bashar-pass-123", "7.7.7.8");
    assert.equal((await call("/forgot", { method: "POST", body: { email: "BASHAR.B@aione.biz" }, ip: "7.7.7.7" })).status, 200);
    assert.equal(mails.length, 1); assert.match(mails[0].subject, /Reset your AION Team Control password/);
    assert.match(mails[0].html, /https:\/\/youssef-sahlieh\.github\.io\/aione-team-control\/reset\.html#t=/);
    assert.equal((await call("/reset", { method: "POST", body: { token: linkToken(mails[0]), password: "Brand-new-pass-1" } })).status, 200);
    assert.equal((await call("/config", { token: before.token })).status, 401, "old sessions end after a reset");
    assert.equal((await login("bashar.b@aione.biz", "Bashar-pass-123", "7.7.7.9")).token, undefined, "old password stops working");
    assert.ok((await login("bashar.b@aione.biz", "Brand-new-pass-1", "7.7.7.9")).token);
  }],
  ["forgot password is rate limited per email", async () => {
    for (let n = 0; n < 3; n++) await call("/forgot", { method: "POST", body: { email: "ellen@aione.biz" }, ip: "8.8.8." + n });
    assert.equal((await call("/forgot", { method: "POST", body: { email: "ellen@aione.biz" }, ip: "8.8.8.9" })).status, 429);
  }],
  ["admin changes a user's developer and role; safety rules for admins", async () => {
    const a = await login("youssef@aione.biz", "Team-password-1", "9.9.9.1");
    const r = await call("/users/" + encodeURIComponent("bashar.b@aione.biz"), { method: "PUT", token: a.token, body: { dev: "bashar.k" } });
    assert.equal(r.data.user.dev, "bashar.k");
    assert.equal((await call("/users/youssef%40aione.biz", { method: "PUT", token: a.token, body: { role: "user", dev: "x" } })).status, 400, "can't demote yourself");
    assert.equal((await call("/users/youssef%40aione.biz", { method: "DELETE", token: a.token })).status, 400, "can't delete yourself");
    const list = await call("/users", { token: a.token });
    assert.deepEqual(list.data.users.map((u) => u.email), ["ellen@aione.biz", "youssef@aione.biz", "bashar.b@aione.biz"]);
    assert.ok(list.data.users.every((u) => !("pw" in u)), "no password hashes in the list");
  }],
  ["removing a user ends their session right away", async () => {
    const a = await login("youssef@aione.biz", "Team-password-1", "9.9.9.2");
    const u = await login("bashar.b@aione.biz", "Brand-new-pass-1", "9.9.9.3");
    assert.equal((await call("/users/bashar.b%40aione.biz", { method: "DELETE", token: a.token })).status, 200);
    assert.equal((await call("/config", { token: u.token })).status, 401);
  }],
  ["the team password can't recreate accounts once users exist", async () => {
    const a = await login("youssef@aione.biz", "Team-password-1", "9.9.9.4");
    await call("/users/ellen%40aione.biz", { method: "DELETE", token: a.token });
    assert.equal((await login("ellen@aione.biz", "Team-password-1", "9.9.9.5")).token, undefined);
  }],
  ["invitation link handed to the admin when email isn't set up", async () => {
    env = makeEnv(); delete env.MAILER;
    const a = await login("youssef@aione.biz", "Team-password-1");
    const r = await call("/users", { method: "POST", token: a.token, body: { email: "sondos@aione.biz", name: "Sondos", role: "user", dev: "sondos" } });
    assert.equal(r.data.invited, false); assert.match(r.data.link, /reset\.html#t=/);
  }],
  ["without the database: forgot password and users say so", async () => {
    env = makeEnv(); delete env.STORE;
    assert.equal((await call("/forgot", { method: "POST", body: { email: "youssef@aione.biz" } })).status, 501);
    const a = await login("youssef@aione.biz", "Team-password-1");
    assert.equal((await call("/users", { token: a.token })).data.code, "no_store");
    assert.equal((await call("/config", { token: a.token })).data.accounts, false);
  }]
];

let pass = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log("ok   -", name); }
  catch (e) { console.log("FAIL -", name, "\n      ", e.message); process.exitCode = 1; }
}
console.log(`\n${pass}/${tests.length} passed`);
