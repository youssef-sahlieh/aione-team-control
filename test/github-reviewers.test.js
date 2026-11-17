// Manage reviewers on one pull request: GitHub review requests added and removed through the admin route only.
// GitHub is faked here; the store is in memory.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { makeToken } from "../proxy/src/handler.js";
import { memoryStore, saveUser } from "../proxy/src/users.js";

const PR_ID = "KAD-org/flutter_pos#553";
const URL_PATH = "/reviews/github-reviewers?id=" + encodeURIComponent(PR_ID);
const now = new Date().toISOString();

function setup({ author = "dev1", state = "open", requested = [], assignees = ["bashar-gh", "sam-gh", "dev1"], writeStatus = 201, syncedAt = Date.now() } = {}) {
  const STORE = memoryStore(), github = [];
  const gh = { requested: requested.map((login) => ({ login, avatar_url: "" })) };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname !== "api.github.com") return new Response("not mocked: " + url, { status: 599 });
    if (u.pathname === "/repos/KAD-org/flutter_pos/pulls/553/requested_reviewers" && (!init.method || init.method === "GET")) return Response.json({ users: gh.requested });
    if (u.pathname === "/repos/KAD-org/flutter_pos/pulls/553/requested_reviewers") {
      const body = JSON.parse(init.body || "{}");
      github.push({ method: init.method, reviewers: body.reviewers, auth: init.headers.Authorization });
      if (writeStatus !== 201 && writeStatus !== 200) return Response.json({ message: writeStatus === 422 ? "Review cannot be requested from pull request author." : "refused" }, { status: writeStatus });
      if (init.method === "POST") for (const r of body.reviewers) gh.requested.push({ login: r, avatar_url: "" });
      if (init.method === "DELETE") gh.requested = gh.requested.filter((x) => !body.reviewers.includes(x.login));
      return Response.json({}, { status: 200 });
    }
    if (u.pathname === "/repos/KAD-org/flutter_pos/pulls") return Response.json([], { status: 200 });
    if (u.pathname === "/repos/KAD-org/flutter_pos/assignees") return Response.json(assignees.map((login) => ({ login, avatar_url: "" })));
    return new Response("not mocked: " + url, { status: 599 });
  };
  const prs = { [PR_ID]: { id: PR_ID, repo: "flutter_pos", number: 553, title: "feat: forecourt", state, url: "https://github.com/KAD-org/flutter_pos/pull/553", author, branch: "x", base: "main", updated: now, merged: null, keys: ["AION-71"], status: { reviews: [], requested: [], decision: null, comments: 0, unresolved: 0 } } };
  STORE.set("github:prs:v4", JSON.stringify({ prs, cursors: {}, syncedAt }));
  const env = { JIRA_PROJECT: "AION", JIRA_SITE: "https://jira.test", JIRA_EMAIL: "bot", JIRA_API_TOKEN: "t", SESSION_SECRET: "s", STORE, GITHUB_TOKEN: "gh-token", GITHUB_REPOS: "KAD-org/flutter_pos", GITHUB_JIRA_ALIASES: "AIONE" };
  const seed = async (id, email, name, role) => {
    await saveUser(STORE, { id, email, name, role, dev: email.split("@")[0], pw: null, v: 1, createdAt: now });
    return (await makeToken(env, email, Date.now(), 1)).token;
  };
  const call = (method, path, token, body) => worker.fetch(new Request("https://p" + path, {
    method, headers: { Authorization: token ? "Bearer " + token : "", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: "manual"
  }), env);
  return { STORE, github, gh, seed, call };
}

test("only administrators read or change the GitHub reviewers of a pull request", async () => {
  const t = setup();
  const dev = await t.seed("u-dev", "bashar@aione.test", "Bashar", "user");
  assert.equal((await t.call("GET", URL_PATH, dev)).status, 403);
  assert.equal((await t.call("POST", URL_PATH, dev, { confirmed: true, add: ["sam-gh"] })).status, 403);
  assert.deepEqual(t.github, []);
});

test("the admin sees who is requested and who GitHub allows, without the pull request's author", async () => {
  const t = setup({ requested: ["sam-gh"] });
  const admin = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const res = await t.call("GET", URL_PATH, admin);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.requested.map((u) => u.login), ["sam-gh"]);
  assert.deepEqual(body.eligible.map((u) => u.login), ["bashar-gh", "sam-gh"]);
  assert.equal(body.author, "dev1");
  assert.equal(body.canManage, true);
});

test("a change without confirmation is refused before GitHub is called", async () => {
  const t = setup();
  const admin = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const res = await t.call("POST", URL_PATH, admin, { add: ["bashar-gh"] });
  assert.equal(res.status, 400);
  assert.deepEqual(t.github, []);
});

test("confirmed requests go to GitHub with the login as GitHub spells it, and already requested people are skipped", async () => {
  const t = setup({ requested: ["sam-gh"] });
  const admin = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const res = await t.call("POST", URL_PATH, admin, { confirmed: true, add: ["Bashar-GH", "sam-gh"] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(t.github, [{ method: "POST", reviewers: ["bashar-gh"], auth: "Bearer gh-token" }]);
  assert.deepEqual(body.added, ["bashar-gh"]);
  assert.deepEqual(body.skipped.alreadyRequested, ["sam-gh"]);
  assert.deepEqual(body.requested.map((u) => u.login).sort(), ["bashar-gh", "sam-gh"]);
});

test("removing a requested reviewer sends a DELETE for that login only", async () => {
  const t = setup({ requested: ["sam-gh", "bashar-gh"] });
  const admin = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const res = await t.call("POST", URL_PATH, admin, { confirmed: true, remove: ["sam-gh"] });
  assert.equal(res.status, 200);
  assert.deepEqual(t.github, [{ method: "DELETE", reviewers: ["sam-gh"], auth: "Bearer gh-token" }]);
  assert.deepEqual((await res.json()).requested.map((u) => u.login), ["bashar-gh"]);
});

test("logins GitHub does not list, the author, and malformed logins are refused without a GitHub write", async () => {
  const t = setup();
  const admin = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  let res = await t.call("POST", URL_PATH, admin, { confirmed: true, add: ["stranger"] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "not_eligible");
  res = await t.call("POST", URL_PATH, admin, { confirmed: true, add: ["dev1"] });
  assert.equal(res.status, 400);
  res = await t.call("POST", URL_PATH, admin, { confirmed: true, add: ["bad login!"] });
  assert.equal(res.status, 400);
  res = await t.call("POST", URL_PATH, admin, { confirmed: true, add: ["sam-gh"], remove: ["sam-gh"] });
  assert.equal(res.status, 400);
  assert.deepEqual(t.github, []);
});

test("a closed pull request cannot change reviewers", async () => {
  const t = setup({ state: "closed" });
  const admin = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const res = await t.call("POST", URL_PATH, admin, { confirmed: true, add: ["sam-gh"] });
  assert.equal(res.status, 409);
  assert.deepEqual(t.github, []);
});

test("GitHub's refusal is reported as it is, and no change is claimed", async () => {
  const t = setup({ writeStatus: 422 });
  const admin = await t.seed("admin-1", "admin@aione.test", "Ellen", "admin");
  const res = await t.call("POST", URL_PATH, admin, { confirmed: true, add: ["sam-gh"] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "not_eligible");
  assert.deepEqual(t.gh.requested, []);
});
