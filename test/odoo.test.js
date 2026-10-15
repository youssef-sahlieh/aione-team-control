// Odoo Helpdesk tickets through the proxy, against a fake Odoo JSON-RPC server.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../proxy/src/handler.js";
import { customerOf } from "../proxy/src/odoo.js";

const calls = [];
const TICKETS = {
  300: { id: 300, name: "Ready development", stage_id: [2, "In Progress"], user_id: [12, "Shahd Ghayadah"], partner_email: '"Ariel Amiri" <ariel@kadouri.co.il>', partner_name: "", partner_id: [5, "ariel@kadouri.co.il"], priority: "1", team_id: [1, "ai1 | Support"], create_date: "2026-10-01 08:00:00", write_date: "2026-10-14 09:00:00", close_date: false, sla_deadline: "2026-10-20 10:00:00", ticket_ref: "300", description: "<p>Please deploy</p>" },
  293: { id: 293, name: "Cartons order", stage_id: [2, "In Progress"], user_id: [34, "Bashar Bannoura"], partner_email: "neor@suzume.co.il", partner_name: "Neor El Hai", partner_id: false, priority: "0", team_id: [1, "ai1 | Support"], create_date: "2026-10-02 08:00:00", write_date: "2026-10-13 09:00:00", close_date: false, sla_deadline: false, ticket_ref: "293", description: "" }
};
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const { service, method, args } = body.params;
  calls.push({ service, method, args });
  const reply = (result) => Response.json({ jsonrpc: "2.0", id: body.id, result });
  if (service === "common" && method === "authenticate") return reply(args[2] === "good-key" ? 7 : false);
  const [, , , model, m, a, kw = {}] = args;
  if (model === "res.users") return reply([{ id: 12, name: "Shahd Ghayadah", login: "shahd@aione.biz", email: "shahd@aione.biz" }, { id: 34, name: "Bashar Bannoura", login: "bashar.b@aione.biz", email: "bashar.b@aione.biz" }, { id: 6, name: "Ireen Khair", login: "ireen@aione.biz", email: "ireen@aione.biz" }]);
  if (model === "helpdesk.stage") return reply([{ id: 1, name: "New", fold: false, sequence: 1, team_ids: [1] }, { id: 2, name: "In Progress", fold: false, sequence: 2, team_ids: [1] }, { id: 3, name: "Solved", fold: true, sequence: 3, team_ids: [1] }, { id: 9, name: "Other team only", fold: false, sequence: 4, team_ids: [5] }]);
  if (model === "mail.message") return reply([{ body: "<p>Hello</p>", author_id: [5, "Ariel Amiri"], date: "2026-10-03 10:00:00", subtype_id: [1, "Discussions"], message_type: "email" }]);
  if (model === "helpdesk.ticket" && m === "search_read") {
    const idTerm = a[0].find((t) => Array.isArray(t) && t[0] === "id");
    const userTerm = a[0].find((t) => Array.isArray(t) && t[0] === "user_id");
    let rows = Object.values(TICKETS);
    if (idTerm) rows = rows.filter((t) => t.id === idTerm[2]);
    if (userTerm) rows = rows.filter((t) => t.user_id && t.user_id[0] === userTerm[2]);
    return reply(rows.map((t) => ({ ...t })));
  }
  if (model === "helpdesk.ticket" && m === "write") { const t = TICKETS[a[0][0]]; if (a[1].stage_id) t.stage_id = [a[1].stage_id, a[1].stage_id === 3 ? "Solved" : "x"]; if ("user_id" in a[1]) t.user_id = a[1].user_id ? [a[1].user_id, "someone"] : false; return reply(true); }
  if (model === "helpdesk.ticket" && m === "message_post") return reply(99);
  return reply(null);
};

const env = {
  ALLOWED_ORIGIN: "x", TEAM_EMAILS: "youssef@aione.biz", JIRA_PROJECT: "AION", TEAM_PASSWORD: "pw-12345678", SESSION_SECRET: "s",
  TEAM_CONFIG: JSON.stringify({ devEmails: { bashar: "bashar.b@aione.biz", shahd: "Shahd@aione.biz" } }),
  LOGIN_LIMIT: { limit: async () => ({ success: true }) },
  ODOO_URL: "https://kadis.odoo.test", ODOO_DB: "db", ODOO_LOGIN: "youssef@aione.biz", ODOO_API_KEY: "good-key"
};
const req = async (path, { method = "GET", body, token } = {}) => {
  const r = await worker.fetch(new Request("https://p" + path, { method, headers: token ? { Authorization: "Bearer " + token } : {}, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json() };
};
const adminToken = async () => (await req("/login", { method: "POST", body: { email: "youssef@aione.biz", password: "pw-12345678" } })).data.token;

test("customer name and email from Odoo's fields", () => {
  assert.deepEqual(customerOf({ partner_email: '"Ariel Amiri" <ariel@kadouri.co.il>' }), { name: "Ariel Amiri", email: "ariel@kadouri.co.il" });
  assert.deepEqual(customerOf({ partner_email: "neor@suzume.co.il", partner_name: "Neor El Hai" }), { name: "Neor El Hai", email: "neor@suzume.co.il" });
  assert.deepEqual(customerOf({ partner_email: "", partner_name: "", partner_id: [1, "Acme"] }), { name: "Acme", email: "" });
});

test("config says Odoo is connected", async () => {
  const t = await adminToken();
  assert.equal((await req("/config", { token: t })).data.odoo, true);
});

test("list maps Odoo tickets: developer from the Odoo assignee, customer, stage, SLA", async () => {
  const { data } = await req("/odoo/tickets", { token: await adminToken() });
  const t300 = data.tickets.find((t) => t.key === "HD-300");
  assert.deepEqual(t300.devs, ["shahd"]);
  assert.deepEqual(t300.customer, { name: "Ariel Amiri", email: "ariel@kadouri.co.il" });
  assert.equal(t300.status, "In Progress"); assert.equal(t300.statusCat, "indeterminate");
  assert.equal(t300.due, "2026-10-20"); assert.equal(t300.priority, "Medium"); assert.equal(t300.team, "ai1 | Support");
  assert.match(t300.url, /^https:\/\/kadis\.odoo\.test\/web#id=300&model=helpdesk\.ticket/);
  assert.deepEqual(data.tickets.find((t) => t.key === "HD-293").devs, ["bashar"]);
});

test("detail: description, chatter and only this team's stages", async () => {
  const { data } = await req("/odoo/tickets/HD-300", { token: await adminToken() });
  assert.equal(data.description, "<p>Please deploy</p>");
  assert.equal(data.messages[0].author, "Ariel Amiri"); assert.equal(data.messages[0].email, true);
  assert.deepEqual(data.stages.map((s) => s.name), ["New", "In Progress", "Solved"]);
});

test("admin moves the stage and changes the developer in Odoo", async () => {
  const t = await adminToken();
  calls.length = 0;
  let r = await req("/odoo/tickets/HD-300", { method: "PUT", token: t, body: { stage: 3 } });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.find((c) => c.args[4] === "write").args[5], [[300], { stage_id: 3 }]);
  assert.equal((await req("/odoo/tickets/HD-300", { method: "PUT", token: t, body: { stage: 9 } })).status, 400, "other team's stage refused");
  calls.length = 0;
  r = await req("/odoo/tickets/HD-293", { method: "PUT", token: t, body: { devs: ["ireen"] } });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.find((c) => c.args[4] === "write").args[5], [[293], { user_id: 6 }]);
  assert.equal((await req("/odoo/tickets/HD-293", { method: "PUT", token: t, body: { devs: ["a", "b"] } })).status, 400, "one developer only");
  TICKETS[293].user_id = [34, "Bashar Bannoura"];
});

test("notes go to the chatter as internal notes, signed by the dashboard user", async () => {
  calls.length = 0;
  const r = await req("/odoo/tickets/HD-300/note", { method: "POST", token: await adminToken(), body: { text: "Checking <now>" } });
  assert.equal(r.status, 201);
  const post = calls.find((c) => c.args[4] === "message_post");
  assert.equal(post.args[6].subtype_xmlid, "mail.mt_note"); assert.equal(post.args[6].message_type, "comment");
  assert.match(post.args[6].body, /Checking &lt;now&gt;/); assert.match(post.args[6].body, /via AION Team Control/);
});

test("a wrong API key is reported clearly", async () => {
  const saved = env.ODOO_API_KEY; env.ODOO_API_KEY = "bad"; env.ODOO_LOGIN = "other@aione.biz";
  const r = await req("/odoo/tickets", { token: await adminToken() });
  env.ODOO_API_KEY = saved; env.ODOO_LOGIN = "youssef@aione.biz";
  assert.equal(r.status, 502); assert.match(r.data.error, /ODOO_API_KEY/);
});

test("without Odoo settings the routes say so", async () => {
  const saved = env.ODOO_URL; env.ODOO_URL = "";
  const r = await req("/odoo/tickets", { token: await adminToken() });
  env.ODOO_URL = saved;
  assert.equal(r.status, 501); assert.equal(r.data.code, "odoo_off");
});
