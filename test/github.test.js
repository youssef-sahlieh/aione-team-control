// Pull requests linked to Jira tickets, against a fake GitHub API.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { makeToken } from "../proxy/src/handler.js";
import { memoryStore, saveUser } from "../proxy/src/users.js";
import { ticketKeys } from "../proxy/src/github.js";

const base = { JIRA_PROJECT: "AION", GITHUB_JIRA_ALIASES: "AIONE" };
const keys = (pr) => ticketKeys(base, pr).sort();

test("ticket numbers are read from titles, branches and the release note's Jira line", () => {
  assert.deepEqual(keys({ title: "feat: forecourt worker opening cash in POS (AION-71)" }), ["AION-71"]);
  assert.deepEqual(keys({ title: "feat: gated deposits API (Jira 72)" }), ["AION-72"]);
  assert.deepEqual(keys({ body: "## Release Note\nJira: AION-571 / AION-575 /AION- 5\nType: feature" }), ["AION-5", "AION-571", "AION-575"]);
  assert.deepEqual(keys({ body: "Release note required: yes\nJira: 572\n" }), ["AION-572"]);
  assert.deepEqual(keys({ body: "Jira ticket 72 calls for manual deposits" }), ["AION-72"]);
  assert.deepEqual(keys({ branch: "codex/aione-561-sms" }), ["AION-561"]);
  // Placeholders, "None", other projects and numbers that aren't Jira references are ignored.
  assert.deepEqual(keys({ title: "fix: cash rounding", body: "Jira: None\nJira: ticket number / text / None\nRefs NEXO-1234 and PR 55", branch: "codex/forecourt-opening-71" }), []);
});

function setup() {
  const STORE = memoryStore(), gh = [], jira = [];
  const pulls = {
    "KAD-org/flutter_pos": [
      { number: 553, title: "feat: forecourt opening (AION-71)", body: "Jira: AION-71", state: "closed", merged_at: "2026-10-12T10:00:00Z", draft: false, updated_at: "2026-10-12T10:00:00Z", html_url: "https://github.com/KAD-org/flutter_pos/pull/553", user: { login: "dev1" }, head: { ref: "codex/forecourt-opening-71" }, base: { ref: "main" } },
      { number: 550, title: "feat(vpay): prepaid card", body: "Jira: None", state: "open", draft: false, merged_at: null, updated_at: "2026-10-11T10:00:00Z", html_url: "https://github.com/KAD-org/flutter_pos/pull/550", user: { login: "dev2" }, head: { ref: "vpay" }, base: { ref: "main" } }
    ],
    "KAD-org/flutter_pos_api": [
      { number: 175, title: "feat: forecourt opening cash", body: "Jira: 71", state: "open", draft: false, merged_at: null, updated_at: "2026-10-12T09:00:00Z", html_url: "https://github.com/KAD-org/flutter_pos_api/pull/175", user: { login: "dev1" }, head: { ref: "codex/forecourt-opening-71" }, base: { ref: "main" } },
      { number: 170, title: "feat: deposits (Jira 72)", body: "", state: "closed", draft: false, merged_at: null, updated_at: "2026-10-10T09:00:00Z", html_url: "https://github.com/KAD-org/flutter_pos_api/pull/170", user: { login: "dev3" }, head: { ref: "deposits" }, base: { ref: "main" } }
    ]
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === "api.github.com") {
      gh.push(u.pathname + u.search); assert.equal(init.headers.Authorization, "Bearer gh-token");
      const repo = u.pathname.replace(/^\/repos\//, "").replace(/\/pulls$/, "");
      return Response.json(Number(u.searchParams.get("page")) > 1 ? [] : pulls[repo] || []);
    }
    jira.push(JSON.parse(init.body || "{}"));
    return Response.json({ issues: [{ key: "AION-71", fields: { labels: ["ai1_builder"] } }] });
  };
  const env = { JIRA_PROJECT: "AION", JIRA_SITE: "https://jira.test", JIRA_EMAIL: "bot", JIRA_API_TOKEN: "t", SESSION_SECRET: "s", STORE,
    TEAM_CONFIG: JSON.stringify({ people: {} }), GITHUB_TOKEN: "gh-token", GITHUB_REPOS: "KAD-org/flutter_pos,KAD-org/flutter_pos_api", GITHUB_JIRA_ALIASES: "AIONE" };
  const call = (path, token) => worker.fetch(new Request("https://p" + path, { headers: { Authorization: "Bearer " + token } }), env).then((r) => r.json());
  return { env, gh, jira, pulls, call };
}

test("each ticket gets its PRs from both repositories; later syncs read only what changed", async () => {
  const { env, gh, call, pulls } = setup();
  const admin = { email: "admin@aione.biz", name: "Admin", role: "admin", dev: "", v: 1 };
  await saveUser(env.STORE, admin);
  const { token } = await makeToken(env, admin.email, Date.now(), 1);
  const d = await call("/github/prs?keys=AION-71,AION-72,AION-9,SECRET-1", token);
  assert.deepEqual(d.prs["AION-71"].map((p) => p.repo + "#" + p.number + " " + p.state), ["flutter_pos#553 merged", "flutter_pos_api#175 open"]);
  assert.deepEqual(d.prs["AION-72"].map((p) => p.number + " " + p.state), ["170 closed"]);
  assert.equal(d.prs["AION-9"], undefined); assert.equal(d.prs["SECRET-1"], undefined);
  assert.equal(gh.length, 2);
  // Within two minutes nothing is read again; a forced refresh reads one page per repository.
  await call("/github/prs?keys=AION-71", token); assert.equal(gh.length, 2);
  pulls["KAD-org/flutter_pos_api"][0] = { ...pulls["KAD-org/flutter_pos_api"][0], state: "closed", merged_at: "2026-10-13T09:00:00Z", updated_at: "2026-10-13T09:00:00Z" };
  const after = await call("/github/prs?keys=AION-71&refresh=1", token);
  assert.equal(gh.length, 4);
  assert.deepEqual(after.prs["AION-71"].map((p) => p.number + " " + p.state), ["175 merged", "553 merged"]);
});

test("developers only see pull requests for their own tickets", async () => {
  const { env, jira, call } = setup();
  const user = { email: "dev@aione.biz", name: "Dev", role: "user", dev: "builder", v: 1 };
  await saveUser(env.STORE, user);
  const { token } = await makeToken(env, user.email, Date.now(), 1);
  const d = await call("/github/prs?keys=AION-71,AION-72&refresh=1", token);
  assert.deepEqual(Object.keys(d.prs), ["AION-71"]);
  assert.match(jira[0].jql, /^labels = "ai1_builder" AND key in \(AION-71,AION-72\)$/);
});

test("without a GitHub token nothing is requested", async () => {
  const { env, gh } = setup(); delete env.GITHUB_TOKEN;
  const admin = { email: "admin@aione.biz", name: "Admin", role: "admin", dev: "", v: 1 };
  await saveUser(env.STORE, admin);
  const { token } = await makeToken(env, admin.email, Date.now(), 1);
  const d = await worker.fetch(new Request("https://p/github/prs?keys=AION-71", { headers: { Authorization: "Bearer " + token } }), env).then((r) => r.json());
  assert.deepEqual(d, { configured: false, prs: {} }); assert.equal(gh.length, 0);
});
