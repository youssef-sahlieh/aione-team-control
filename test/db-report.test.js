// Production database report, against a fake Odoo (Audit & Deploy + knowledge base) and fake customer DBs.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { makeToken } from "../proxy/src/handler.js";
import { memoryStore, saveUser } from "../proxy/src/users.js";
import { parseCreds, isProductionName } from "../proxy/src/db-report.js";

test("parseCreds gathers candidate logins, labeled or not", () => {
  const a = parseCreds('<p><strong>URL:</strong> <a href="https://540.ai1.host/web">link</a></p><p>User: admin@acme.co</p><p>Password: s3cr3t1</p>');
  assert.equal(a.num, "540");
  assert.ok(a.candidates.some((c) => c.user === "admin@acme.co" && c.password === "s3cr3t1"));
  // Unlabeled layout (like 503): url, then email line, then password line.
  const b = parseCreds("<p>https://503.ai1.host/web/login</p><p>owner@ronit.co.il</p><p>kadis2024</p>");
  assert.equal(b.num, "503");
  assert.ok(b.candidates.some((c) => c.user === "owner@ronit.co.il" && c.password === "kadis2024"), "pairs email with next line");
  assert.equal(b.complete, true);
  const c = parseCreds("https://222.ai1.host only, no login here");
  assert.equal(c.num, "222"); assert.equal(c.complete, false);
  // url / email / password on three lines, where the password itself contains an "@".
  const e = parseCreds("<div>https://522.ai1.host<br>boss@olivia.co<br>Olivia@2024</div>");
  assert.ok(e.candidates.some((x) => x.user === "boss@olivia.co" && x.password === "Olivia@2024"), "password with @ after email line");
  // Table / label-on-its-own-line layout.
  const d = parseCreds("<table><tr><td>Email</td><td>boss@olivia.co</td></tr><tr><td>Password</td><td>olivia99</td></tr></table><p>https://522.ai1.host</p>");
  assert.equal(d.num, "522");
  assert.ok(d.candidates.some((x) => x.user === "boss@olivia.co" && x.password === "olivia99"), "table layout");
});

test("isProductionName excludes test, dev, demo and similar", () => {
  for (const n of ["RonitYamProd", "100_hcc", "acme_live"]) assert.equal(isProductionName(n), true, n);
  for (const n of ["530_Odoo_Experience_Demo", "acme_test", "dev_db", "staging1", "backup_copy", "qa_main"]) assert.equal(isProductionName(n), false, n);
});

function setup() {
  const STORE = memoryStore();
  // Audit & Deploy data for three instances: two prod, one test (excluded).
  const instances = {
    services: [
      { instance_name: "odoo503", domain: "503.ai1.host", server_zone: "prod", created: "2026-01-15T18:33:19Z" },
      { instance_name: "odoo100", domain: "100.ai1.host", server_zone: "prod", created: "2026-02-01T00:00:00Z" },
      { instance_name: "odoo999", domain: "999.ai1.host", server_zone: "test", created: "2026-03-01T00:00:00Z" }
    ]
  };
  const config = {
    odoo503: { databases: ["RonitYamProd"] },
    odoo100: { databases: ["100_hcc"], database_inventory_error: "" },
    odoo999: { databases: ["test_db"] }
  };
  const addons = {
    odoo503: { addons: [{ name: "flutter_pos_api" }, { name: "sale" }] },
    odoo100: { addons: [{ name: "stock" }] }
  };
  // Knowledge base: full credentials for 503 only.
  const articles = [
    { id: 10, name: "Our Customers", body: "" },
    { id: 11, name: "Ronit Yam", body: 'URL: https://503.ai1.host/web User: admin Password: pw123' },
    { id: 12, name: "HCC", body: "https://100.ai1.host (no login stored)" }
  ];
  // Fake customer DB at 503.ai1.host.
  const customer = { users: 7, pos: 3, companies: 2, lastLogin: "2026-10-14 08:12:00", lastSession: "2026-10-15 09:00:00", lastOrder: "2026-10-15 10:49:22", expires: "2027-01-01 00:00:00" };

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = JSON.parse(init.body || "{}");
    const p = body.params || {};
    // Central kadis Odoo (the odoo() helper): service object/common.
    if (u.includes("kadis.odoo.test")) {
      if (p.service === "common") return Response.json({ result: 7 });
      const [, , , model, method, args, kw] = p.args;
      if (model === "monitor.data.snapshot" && method === "get_instances") return Response.json({ result: { payload: instances } });
      if (model === "monitor.data.snapshot" && method === "get_instance_config") return Response.json({ result: { payload: config[args[0]] || {} } });
      if (model === "monitor.data.snapshot" && method === "get_instance_addons") return Response.json({ result: { payload: addons[args[0]] || { addons: [] } } });
      if (model === "knowledge.article" && method === "search_read") {
        const dom = args[0];
        if (JSON.stringify(dom).includes("Our Customers")) return Response.json({ result: [{ id: 10 }] });
        return Response.json({ result: articles.filter((a) => a.id !== 10).map((a) => ({ body: a.body })) });
      }
      return Response.json({ result: [] });
    }
    // Customer database at 503.ai1.host.
    if (u.includes("503.ai1.host")) {
      if (p.service === "db") return Response.json({ result: ["RonitYamProd"] });
      if (p.service === "common") return Response.json({ result: 42 });
      const [, , , model, method, args, kw] = p.args;
      if (model === "res.users" && method === "search_count") return Response.json({ result: customer.users });
      if (model === "pos.config") return Response.json({ result: customer.pos });
      if (model === "res.company") return Response.json({ result: customer.companies });
      if (model === "res.branch") return Response.json({ error: { message: "no such model" } });
      if (model === "res.users" && method === "search_read") return Response.json({ result: [{ login_date: customer.lastLogin }] });
      if (model === "pos.session") return Response.json({ result: [{ start_at: customer.lastSession }] });
      if (model === "pos.order") return Response.json({ result: [{ date_order: customer.lastOrder }] });
      if (model === "ir.config_parameter") return Response.json({ result: [{ value: customer.expires }] });
      return Response.json({ result: [] });
    }
    return Response.json({ result: [] });
  };

  const env = {
    JIRA_PROJECT: "AION", SESSION_SECRET: "s", STORE,
    ODOO_URL: "https://kadis.odoo.test", ODOO_DB: "db", ODOO_LOGIN: "bot@aione.biz", ODOO_API_KEY: "key",
    CRON_SECRET: "cron-secret-123"
  };
  const call = (path, { method = "GET", token } = {}) => worker.fetch(new Request("https://p" + path, { method, headers: token ? { Authorization: "Bearer " + token } : {} }), env);
  return { env, call, customer };
}

test("report covers production databases only, with inside numbers where a login is found", async () => {
  const { env, call, customer } = setup();
  const admin = { email: "admin@aione.biz", name: "Admin", role: "admin", dev: "", v: 1 };
  await saveUser(env.STORE, admin);
  const { token } = await makeToken(env, admin.email, Date.now(), 1);
  // Build to completion (one slice is enough here), then read.
  let r; for (let i = 0; i < 5; i++) { r = await (await call("/db-report/refresh", { method: "POST", token })).json(); if (r.done) break; }
  assert.equal(r.done, true);
  const rows = r.report.rows;
  assert.equal(rows.length, 2, "test instance excluded");
  const ronit = rows.find((x) => x.database === "RonitYamProd");
  assert.equal(ronit.url, "https://503.ai1.host");
  assert.equal(ronit.flutter, true);
  assert.deepEqual(ronit.addons, ["flutter_pos_api", "sale"]);
  assert.equal(ronit.loginFound, true); assert.equal(ronit.loginOk, true);
  assert.equal(ronit.users, customer.users); assert.equal(ronit.pos, customer.pos);
  assert.equal(ronit.branches, 1); // companies 2 -> 1 extra branch (no res.branch model)
  assert.equal(ronit.lastLogin, customer.lastSession, "last login is the most recent of web login and POS session");
  assert.equal(ronit.lastOrder, customer.lastOrder);
  assert.equal(ronit.expired, false); assert.equal(ronit.expires, customer.expires);
  const hcc = rows.find((x) => x.database === "100_hcc");
  assert.equal(hcc.loginFound, false); assert.equal(hcc.flutter, false); assert.equal(hcc.users, undefined);
});

test("GET /db-report is admin only and caches; cron needs the secret", async () => {
  const { env, call } = setup();
  const user = { email: "dev@aione.biz", name: "Dev", role: "user", dev: "builder", v: 1 };
  const admin = { email: "boss@aione.biz", name: "Boss", role: "admin", dev: "", v: 1 };
  await saveUser(env.STORE, user); await saveUser(env.STORE, admin);
  const userTok = (await makeToken(env, user.email, Date.now(), 1)).token;
  const adminTok = (await makeToken(env, admin.email, Date.now(), 1)).token;
  assert.equal((await call("/db-report", { token: userTok })).status, 403);
  // Cron: wrong token rejected, right token builds.
  assert.equal((await call("/cron/db-report?token=wrong")).status, 403);
  assert.equal((await call("/cron/db-report?token=cron-secret-123")).status, 200);
  // Admin view returns the (now cached) report.
  const view = await (await call("/db-report", { token: adminTok })).json();
  assert.ok(view.report && Array.isArray(view.report.rows));
});
