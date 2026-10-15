// The real Audit & Deploy screen's data calls through the proxy, against a fake Odoo.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../proxy/src/handler.js";
import { memoryStore } from "../proxy/src/users.js";

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes("/web/webclient/translations/")) return new Response(JSON.stringify({ lang: "en_US", modules: {} }), { status: 200 });
  const body = JSON.parse(init.body);
  const { service, args } = body.params;
  const reply = (result) => Response.json({ jsonrpc: "2.0", id: body.id, result });
  if (service === "common") return reply(7);
  const [, , , model, m, a = [], kw = {}] = args;
  calls.push({ model, m, a, kw });
  if (model === "res.users" && m === "search_read" && JSON.stringify(a).includes("login")) return reply([{ id: 7, name: "Api Owner", partner_id: [3, "Api Owner"], company_id: [1, "Aione"], company_ids: [1], tz: "Asia/Jerusalem" }]);
  if (model === "res.company") return reply([{ id: 1, name: "Aione", sequence: 1, currency_id: [2, "ILS"], parent_id: false, child_ids: [] }]);
  if (model === "res.currency") return reply([{ id: 2, symbol: "₪", position: "before", decimal_places: 2 }]);
  if (model === "ir.module.module") return reply([{ latest_version: "18.0.1.3" }]);
  if (model === "monitor.audit.log" && m === "get_current_user_info") return reply({ uid: 7, name: "Api Owner", login: "api@aione.biz", is_infrastructure_operator: true });
  if (model === "monitor.audit.log" && m === "search") return reply([901, 902]);
  if (model === "file.hosting.service" && m === "call_api") return reply({ success: true, data: { restarted: a[2] } });
  if (model === "monitor.test.environment" && m === "action_destroy") throw new Error("never in this test");
  return reply([{ id: 1 }]);
};

const env = {
  ALLOWED_ORIGIN: "x", TEAM_EMAILS: "youssef@aione.biz", JIRA_PROJECT: "AION", TEAM_PASSWORD: "pw-12345678", SESSION_SECRET: "s", TEAM_CONFIG: "{}",
  LOGIN_LIMIT: { limit: async () => ({ success: true }) }, STORE: memoryStore(), MAILER: async () => {},
  ODOO_URL: "https://kadis.odoo.test", ODOO_DB: "db", ODOO_LOGIN: "api@aione.biz", ODOO_API_KEY: "k"
};
const req = async (path, { method = "GET", body, token } = {}) => {
  const r = await worker.fetch(new Request("https://p" + path, { method, headers: token ? { Authorization: "Bearer " + token } : {}, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json() };
};
const rpc = (token, model, method, args = [], kwargs = {}) => req("/monitor/odoo/rpc", { method: "POST", token, body: { model, method, args, kwargs } });
const login = async () => (await req("/login", { method: "POST", body: { email: "youssef@aione.biz", password: "pw-12345678" } })).data.token;

test("session info carries the dashboard person's name for Odoo's screen", async () => {
  const s = (await req("/monitor/odoo/session", { token: await login() })).data;
  assert.equal(s.name, "Youssef"); assert.equal(s.username, "youssef@aione.biz");
  assert.equal(s.uid, 7); assert.equal(s.user_companies.current_company, 1); assert.equal(s.currencies[2].symbol, "₪");
  assert.equal((await req("/monitor/odoo/session")).status, 401, "sign-in required");
});

test("translations are public (Odoo's screen fetches them without our sign-in)", async () => {
  const r = await req("/monitor/odoo/translations/aion?lang=en_US");
  assert.equal(r.status, 200); assert.equal(r.data.lang, "en_US");
});

test("add-on calls pass through; 'who am I' shows the dashboard person", async () => {
  const t = await login();
  const r = await rpc(t, "monitor.audit.log", "get_current_user_info");
  assert.equal(r.data.result.name, "Youssef"); assert.equal(r.data.result.login, "youssef@aione.biz");
  assert.equal(r.data.result.is_infrastructure_operator, true);
});

test("only Audit & Deploy data is reachable", async () => {
  const t = await login();
  calls.length = 0;
  assert.equal((await rpc(t, "account.move", "search_read", [[]])).status, 403);
  assert.equal((await rpc(t, "res.users", "write", [[7], { password: "x" }])).status, 403, "no changes to users");
  assert.equal((await rpc(t, "monitor.instance", "_private_method")).status, 400, "no private methods");
  assert.equal(calls.length, 0, "nothing reached Odoo");
  await rpc(t, "res.users", "search_read", [[]], { fields: ["name", "login", "password", "api_key_ids"] });
  assert.deepEqual(calls.at(-1).kw.fields, ["name", "login"], "only names and logins of other users");
});

test("a change (restart) runs in Odoo, is logged with the real name, and Odoo's entries get the name", async () => {
  const t = await login();
  calls.length = 0;
  const r = await rpc(t, "file.hosting.service", "call_api", ["/api/docker/odoo/restart", "POST", { instances: ["odoo503"] }]);
  assert.equal(r.status, 200); assert.deepEqual(r.data.result.data.restarted, { instances: ["odoo503"] });
  const search = calls.find((c) => c.model === "monitor.audit.log" && c.m === "search");
  assert.ok(search.a[0].some((term) => term[0] === "ip_address" && term[2] === false), "only entries made through the API");
  assert.deepEqual(calls.find((c) => c.model === "monitor.audit.log" && c.m === "write").a, [[901, 902], { user_name: "Youssef (via AION)" }]);
  const log = (await req("/monitor/log", { token: t })).data.entries[0];
  assert.equal(log.name, "Youssef"); assert.equal(log.action, "POST /api/docker/odoo/restart"); assert.equal(log.target, "odoo503"); assert.equal(log.result, "success");
});

test("reads are not logged as actions; the screen's own audit entries get the real name", async () => {
  const t = await login();
  const before = (await req("/monitor/log", { token: t })).data.entries.length;
  await rpc(t, "file.hosting.service", "call_api", ["/api/docker/odoo/deployment-info/odoo503"]);
  await rpc(t, "monitor.data.snapshot", "get_instances", [false]);
  calls.length = 0;
  await rpc(t, "monitor.audit.log", "log_from_frontend", [], { action_type: "instance_view", target_name: "odoo503", details: '{"tab":"addons"}' });
  assert.deepEqual(JSON.parse(calls.find((c) => c.m === "log_from_frontend").kw.details), { tab: "addons", via: "AION Team Control", by: "Youssef", email: "youssef@aione.biz" });
  assert.equal((await req("/monitor/log", { token: t })).data.entries.length, before, "no action-log entries for reads and views");
});

test("Odoo errors come back in Odoo's format so the screen shows them", async () => {
  const t = await login();
  const r = await rpc(t, "monitor.test.environment", "action_destroy", [[1]]);
  assert.equal(r.status, 200); assert.match(r.data.error.data.message, /never in this test/);
  assert.equal((await req("/monitor/log", { token: t })).data.entries[0].result, "failure");
});
