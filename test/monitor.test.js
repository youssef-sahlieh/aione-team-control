// Audit & Deploy (Odoo log_monitor add-on) through the proxy, against a fake Odoo.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../proxy/src/handler.js";
import { memoryStore } from "../proxy/src/users.js";

const calls = [];
let admissionDecision = "allow", createFails = false;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const { service, method, args } = body.params;
  const reply = (result) => Response.json({ jsonrpc: "2.0", id: body.id, result });
  if (service === "common") return reply(7);
  const [, , , model, m, a = [], kw = {}] = args;
  calls.push({ model, m, a, kw });
  if (model === "monitor.data.snapshot" && m === "get_instances") return reply({ payload: { services: [{ instance_name: "odoo503", health: "healthy" }], success: true } });
  if (model === "monitor.test.environment" && m === "get_portal_test_environments") return reply([{ id: 171, name: "519 Test", instance_name: "dev-519t6", status: "running" }]);
  if (model === "monitor.test.environment" && m === "get_dashboard_config") return reply({ max_active_envs: 10 });
  if (model === "monitor.test.environment" && m === "search_read") return reply(a[0][0][2] === 171 ? [{ name: "519 Test", instance_name: "dev-519t6" }] : []);
  if (model === "monitor.test.environment" && m === "reserve_test_env_target") return reply({ reservation_token: "tok-1", reservation: { id: 1 }, estimate: { ready: true, confirmation_allowed: true }, execution_enabled: true });
  if (model === "file.hosting.service" && a[0] === "/api/v2/operations/admission") return reply({ success: true, admission: { decision: admissionDecision } });
  if (model === "file.hosting.service" && a[0] === "/api/v2/operations/capacity") return reply({ targets: [{ id: "test_app_mnt", display_name: "Test volume", zone: "test", status: "available", enabled: true, allowed_operations: ["clone"], resources: { available_bytes: 73 * 1024 ** 3 } }, { id: "prod_x", zone: "prod", status: "available", enabled: true, allowed_operations: ["clone"] }] });
  if (model === "monitor.test.environment" && m === "get_instance_databases") return reply(["519_danceshop"]);
  if (model === "monitor.test.environment" && m === "create_test_env") return reply(createFails ? { error_message: "No capacity" } : { id: 200 });
  if (model === "monitor.audit.log" && m === "get_recent_actions") return reply({ actions: [{ id: 1, user_name: "Carmel" }], has_more: false });
  return reply(true);
};

const env = {
  ALLOWED_ORIGIN: "x", TEAM_EMAILS: "youssef@aione.biz,ellen@aione.biz", JIRA_PROJECT: "AION", TEAM_PASSWORD: "pw-12345678", SESSION_SECRET: "s", TEAM_CONFIG: "{}",
  LOGIN_LIMIT: { limit: async () => ({ success: true }) }, STORE: memoryStore(), MAILER: async () => {},
  ODOO_URL: "https://kadis.odoo.test", ODOO_DB: "db", ODOO_LOGIN: "api@aione.biz", ODOO_API_KEY: "k"
};
const req = async (path, { method = "GET", body, token } = {}) => {
  const r = await worker.fetch(new Request("https://p" + path, { method, headers: token ? { Authorization: "Bearer " + token } : {}, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json() };
};
const login = async (email) => (await req("/login", { method: "POST", body: { email, password: "pw-12345678" } })).data.token;
let userToken;

test("setup: an administrator and a developer User", async () => {
  const admin = await login("youssef@aione.biz");
  let link;
  env.MAILER = async (m) => { link = /#t=([\w-]+)/.exec(m.html)[1]; };
  await req("/users", { method: "POST", token: admin, body: { email: "carmel@aione.biz", name: "Carmel", role: "user", dev: "carmel" } });
  await req("/reset", { method: "POST", body: { token: link, password: "carmel-pass-123" } });
  userToken = (await req("/login", { method: "POST", body: { email: "carmel@aione.biz", password: "carmel-pass-123" } })).data.token;
  assert.ok(userToken);
});

test("users and administrators can read the monitor", async () => {
  for (const t of [userToken, await login("youssef@aione.biz")]) {
    assert.equal((await req("/monitor/instances", { token: t })).data.payload.services[0].instance_name, "odoo503");
    assert.equal((await req("/monitor/test-envs", { token: t })).data.envs.length, 1);
    assert.equal((await req("/monitor/odoo-audit", { token: t })).data.actions[0].user_name, "Carmel");
  }
  assert.equal((await req("/monitor/instances")).status, 401, "sign-in required");
});

test("create options list only clone targets in the chosen zone", async () => {
  const r = await req("/monitor/test-envs/options?source=519&zone=test", { token: userToken });
  assert.deepEqual(r.data.databases, ["519_danceshop"]);
  assert.deepEqual(r.data.targets.map((t) => t.id), ["test_app_mnt"]);
  assert.equal(r.data.targets[0].freeGiB, 73);
});

test("a User extends a test environment: done in Odoo and logged with their name in both logs", async () => {
  calls.length = 0;
  const r = await req("/monitor/test-envs/171/extend", { method: "POST", token: userToken });
  assert.equal(r.status, 200);
  assert.ok(calls.some((c) => c.m === "action_extend_ttl" && c.a[0][0] === 171 && c.a[1] === 24));
  const odooLog = calls.find((c) => c.m === "log_from_frontend");
  assert.equal(JSON.parse(odooLog.kw.details).by, "Carmel"); assert.equal(odooLog.kw.target_name, "dev-519t6");
  const log = (await req("/monitor/log", { token: userToken })).data.entries;
  assert.equal(log[0].name, "Carmel"); assert.equal(log[0].email, "carmel@aione.biz"); assert.equal(log[0].action, "Extend test environment by 24h"); assert.equal(log[0].result, "success");
});

test("create: reserve, admission check, then create with the reservation", async () => {
  const t = await login("ellen@aione.biz");
  const res = await req("/monitor/test-envs/reserve", { method: "POST", token: t, body: { source: "519", target: "test_app_mnt", db: "519_danceshop", zone: "test" } });
  assert.equal(res.data.token, "tok-1"); assert.equal(res.data.executionEnabled, true);
  calls.length = 0;
  const r = await req("/monitor/test-envs", { method: "POST", token: t, body: { source: "519", name: "Ellen QA", template: "standard", ttl: 48, db: "519_danceshop", target: "test_app_mnt", token: "tok-1", zone: "test" } });
  assert.equal(r.status, 200);
  const order = calls.map((c) => c.m === "call_api" ? c.a[0] : c.m);
  assert.ok(order.indexOf("/api/v2/operations/admission") < order.indexOf("create_test_env"), "admission checked first");
  assert.deepEqual(calls.find((c) => c.m === "create_test_env").a, ["519", "Ellen QA", 48, "standard", "519_danceshop", false, "test_app_mnt", "tok-1", "test"]);
  assert.equal((await req("/monitor/log", { token: t })).data.entries[0].name, "Ellen");
});

test("a refused create is not run, and the failure is logged", async () => {
  admissionDecision = "deny"; calls.length = 0;
  const r = await req("/monitor/test-envs", { method: "POST", token: userToken, body: { source: "519", template: "minimal", target: "test_app_mnt", token: "tok-2", zone: "test" } });
  admissionDecision = "allow";
  assert.equal(r.status, 502); assert.match(r.data.error, /denied by resource policy/);
  assert.ok(!calls.some((c) => c.m === "create_test_env"));
  const e = (await req("/monitor/log", { token: userToken })).data.entries[0];
  assert.equal(e.result, "failure"); assert.equal(e.name, "Carmel");
  createFails = true;
  const r2 = await req("/monitor/test-envs", { method: "POST", token: userToken, body: { source: "519", template: "minimal", target: "test_app_mnt", token: "tok-3", zone: "test" } });
  createFails = false;
  assert.equal(r2.status, 502); assert.match(r2.data.error, /No capacity/);
});

test("Users can also destroy, approve and decide (no administrator-only actions)", async () => {
  calls.length = 0;
  assert.equal((await req("/monitor/test-envs/171/destroy", { method: "POST", token: userToken })).status, 200);
  assert.equal((await req("/monitor/pipeline-runs/5/approve", { method: "POST", token: userToken })).status, 200);
  assert.equal((await req("/monitor/approvals/access/9", { method: "POST", token: userToken, body: { decision: "approve", note: "ok" } })).status, 200);
  assert.deepEqual(calls.find((c) => c.m === "decide_access").a, [9, "approve", "ok"]);
  assert.ok(calls.some((c) => c.m === "action_destroy" && /^aion-destroy-/.test(c.a[1])));
  assert.equal((await req("/monitor/approvals/unlock/3", { method: "POST", token: userToken, body: { decision: "maybe" } })).status, 400);
});

test("bad input is refused before reaching Odoo", async () => {
  calls.length = 0;
  assert.equal((await req("/monitor/instances/" + encodeURIComponent("x;drop") + "/config", { token: userToken })).status, 400);
  assert.equal((await req("/monitor/test-envs/999/extend", { method: "POST", token: userToken })).status, 404);
  assert.equal((await req("/monitor/test-envs", { method: "POST", token: userToken, body: { source: "519", template: "huge", target: "t", token: "x", zone: "test" } })).status, 400);
  assert.ok(!calls.some((c) => ["create_test_env", "action_extend_ttl"].includes(c.m)));
});

test("without the user database, actions are refused (nothing could be logged)", async () => {
  const saved = env.STORE;
  env.STORE = undefined; const t = await login("youssef@aione.biz");
  const r = await req("/monitor/test-envs/171/extend", { method: "POST", token: t });
  env.STORE = saved;
  assert.equal(r.status, 501); assert.equal(r.data.code, "no_store");
});
