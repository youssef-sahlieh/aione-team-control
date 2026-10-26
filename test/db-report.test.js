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
  assert.ok(e.candidates.some((x) => x.user === "boss" && x.password === "Olivia@2024"), "also tries the email local part as the Odoo login");
  assert.deepEqual(e.candidates[0], { user: "boss@olivia.co", password: "Olivia@2024" }, "the adjacent pair is tried first");
  // URL in the title, body is username then password; the next line after the username is the password.
  const f = parseCreds("<p>https://111.ai1.host</p>\n<div>reefadmin<br>1234567890</div>");
  assert.ok(f.candidates.some((x) => x.user === "reefadmin" && x.password === "1234567890"), "username/password from url-in-title layout");
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
  // Audit & Deploy data: two prod (Main), one test (Tests), one development (Dev).
  const instances = {
    services: [
      { instance_name: "odoo503", domain: "503.ai1.host", server_zone: "prod", created: "2026-01-15T18:33:19Z" },
      { instance_name: "odoo100", domain: "100.ai1.host", server_zone: "prod", created: "2026-02-01T00:00:00Z" },
      { instance_name: "odoo999", domain: "999.ai1.host", server_zone: "test", created: "2026-03-01T00:00:00Z" },
      { instance_name: "odoo777", domain: "777.ai1.host", server_zone: "development", created: "2026-04-01T00:00:00Z" },
      // Listed as production, but named like a test and a dev instance: kept apart from Main.
      { instance_name: "odoo888_test", domain: "888.ai1.host", server_zone: "prod", created: "2026-04-02T00:00:00Z" },
      { instance_name: "odoo555_dev", domain: "555.ai1.host", server_zone: "prod", created: "2026-04-03T00:00:00Z" }
    ]
  };
  const config = {
    odoo503: { databases: ["RonitYamProd"] },
    odoo100: { databases: ["100_hcc"], database_inventory_error: "" },
    odoo999: { databases: ["test_db"] },
    odoo777: { databases: ["dev_db"] }
  };
  const addons = {
    odoo503: { addons: [{ name: "PosDashboardOdooFlutter_Addon" }, { name: "flutter_pos_api", module_version: "19.0.3.97.2" }, { name: "sale" }] },
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

  const actions = []; // Odoo calls the report's instance actions made
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
      if (model === "file.hosting.service" && method === "call_api") { actions.push({ path: args[0], method: args[1], body: args[2] }); return Response.json({ result: { success: true } }); }
      if (model === "knowledge.article" && method === "search_read") {
        const dom = args[0];
        if (JSON.stringify(dom).includes("Our Customers")) return Response.json({ result: [{ id: 10 }] });
        return Response.json({ result: articles.filter((a) => a.id !== 10).map((a) => ({ name: a.name, body: a.body })) });
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
      if (model === "res.company") return Response.json({ result: [{ id: 1, name: "Ronit Yam Ltd" }, { id: 2, name: "Ronit Yam Branch" }].slice(0, customer.companies) });
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
  const call = (path, { method = "GET", token, body } = {}) => worker.fetch(new Request("https://p" + path, { method, headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
  return { env, call, customer, actions };
}

test("findPosModule finds flutter_pos_api's module_version in any shape", async () => {
  const { findPosModule } = await import("../proxy/src/db-report.js");
  assert.deepEqual(findPosModule({ addons: [{ name: "sale" }, { name: "flutter_pos_api", module_version: "19.0.3.97.2" }] }), { version: "19.0.3.97.2", date: "" });
  assert.deepEqual(findPosModule({ pos_configurations: { flutter_pos_api: { module_version: "19.0.4.1.0", write_date: "2026-10-01" } } }), { version: "19.0.4.1.0", date: "2026-10-01" });
  assert.deepEqual(findPosModule({ settings: { pos: [{ module: "flutter_pos_api", module_version: "18.0.1" }] } }), { version: "18.0.1", date: "" });
  assert.equal(findPosModule({ addons: [{ name: "PosDashboardOdooFlutter_Addon" }] }), null, "a different Flutter add-on is not the POS version");
});

test("report covers main, test and development instances, each in its section, with inside numbers where a login is found", async () => {
  const { env, call, customer } = setup();
  const admin = { email: "admin@aione.biz", name: "Admin", role: "admin", dev: "", v: 1 };
  await saveUser(env.STORE, admin);
  const { token } = await makeToken(env, admin.email, Date.now(), 1);
  // Build to completion (one slice is enough here), then read.
  let r; for (let i = 0; i < 5; i++) { r = await (await call("/db-report/refresh", { method: "POST", token })).json(); if (r.done) break; }
  assert.equal(r.done, true);
  const rows = r.report.rows;
  assert.equal(rows.length, 6);
  assert.equal(rows.find((x) => x.instance === "odoo999").section, "tests");
  assert.equal(rows.find((x) => x.instance === "odoo777").section, "dev");
  assert.equal(rows.find((x) => x.instance === "odoo888_test").section, "tests", "test-named production-zone instance goes to Tests");
  assert.equal(rows.find((x) => x.instance === "odoo555_dev").section, "dev", "dev-named production-zone instance goes to Dev");
  const ronit = rows.find((x) => x.database === "RonitYamProd");
  assert.equal(ronit.section, "main");
  assert.equal(ronit.url, "https://503.ai1.host");
  assert.equal(ronit.flutter, true);
  assert.deepEqual(ronit.addons, ["PosDashboardOdooFlutter_Addon", "flutter_pos_api", "sale"]);
  assert.equal(ronit.posVersion, "19.0.3.97.2"); assert.equal(ronit.posVersionDate, "");
  assert.equal(ronit.loginFound, true); assert.equal(ronit.loginOk, true);
  assert.equal(ronit.users, customer.users); assert.equal(ronit.pos, customer.pos);
  assert.equal(ronit.branches, 1); // companies 2 -> 1 extra branch (no res.branch model)
  assert.equal(ronit.company, "Ronit Yam Ltd"); assert.equal(ronit.companySource, "database"); assert.deepEqual(ronit.companyNames, ["Ronit Yam Ltd", "Ronit Yam Branch"]);
  // Last login is the most recent sign of a logged-in user (web login, POS session, presence, or order).
  assert.equal(ronit.lastLogin, customer.lastOrder, "last login reflects the latest activity");
  assert.equal(ronit.lastOrder, customer.lastOrder);
  assert.equal(ronit.expired, false); assert.equal(ronit.expires, customer.expires);
  const hcc = rows.find((x) => x.database === "100_hcc");
  assert.equal(hcc.loginFound, false); assert.equal(hcc.flutter, false); assert.equal(hcc.users, undefined);
  assert.equal(hcc.company, ""); assert.equal(hcc.companySource, ""); // no login: no company name (Knowledge text is never used)
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
  assert.equal((await call("/cron/db-report", { token: "wrong" })).status, 403);
  // The secret in the address (it ends up in logs) is not accepted.
  assert.equal((await call("/cron/db-report?token=cron-secret-123")).status, 403);
  assert.equal((await call("/cron/db-report", { token: "cron-secret-123" })).status, 200);
  // Admin view returns the (now cached) report.
  const view = await (await call("/db-report", { token: adminTok })).json();
  assert.ok(view.report && Array.isArray(view.report.rows));
});
test('one row per web address: the instance with a working login and newer activity is kept, the other is named on it', async () => {
  const { oneRowPerSite } = await import("../proxy/src/db-report.js");
  const rows = oneRowPerSite([
    { instance: "odoo526", url: "https://526.ai1.host", database: "526_old", loginOk: false, lastOrder: null },
    { instance: "odoo600", url: "https://600.ai1.host", database: "600_x", loginOk: true },
    { instance: "odoo526b", url: "https://526.ai1.host/", database: "526_new", loginOk: true, lastOrder: "2026-10-10 10:00:00" }
  ]);
  assert.equal(rows.length, 2);
  const site = rows.find((r) => r.url.includes("526"));
  assert.equal(site.instance, "odoo526b");
  assert.deepEqual(site.duplicates, [{ instance: "odoo526", database: "526_old" }]);
});

test("POST /db-report/action restarts a reported instance for admins only, and logs it", async () => {
  const { env, call, actions } = setup();
  const user = { email: "dev@aione.biz", name: "Dev", role: "user", dev: "builder", v: 1 };
  const admin = { email: "boss@aione.biz", name: "Boss", role: "admin", dev: "", v: 1 };
  await saveUser(env.STORE, user); await saveUser(env.STORE, admin);
  const userTok = (await makeToken(env, user.email, Date.now(), 1)).token;
  const adminTok = (await makeToken(env, admin.email, Date.now(), 1)).token;
  // Build the report first so the action can check the instance against it.
  for (let i = 0; i < 5; i++) { const r = await (await call("/db-report/refresh", { method: "POST", token: adminTok })).json(); if (r.done) break; }
  const body = { instance: "odoo503", action: "restart" };
  assert.equal((await call("/db-report/action", { method: "POST", token: userTok, body })).status, 403, "users can't act");
  assert.equal((await call("/db-report/action", { method: "POST", token: adminTok, body: { instance: "odoo404", action: "restart" } })).status, 404, "instances outside the report are refused");
  assert.equal((await call("/db-report/action", { method: "POST", token: adminTok, body: { instance: "odoo503", action: "stop" } })).status, 400, "only restart for now");
  assert.equal(actions.length, 0, "refused calls never reach Odoo");
  const ok = await call("/db-report/action", { method: "POST", token: adminTok, body });
  assert.equal(ok.status, 200);
  assert.deepEqual(actions, [{ path: "/api/docker/odoo/restart", method: "POST", body: { instances: ["odoo503"] } }]);
  const logged = JSON.parse(await env.STORE.get("mlog:1"));
  assert.equal(logged.name, "Boss"); assert.equal(logged.action, "Restart instance"); assert.equal(logged.target, "odoo503"); assert.equal(logged.result, "success");
});

test("a report saved before the POS version existed is rebuilt when viewed", async () => {
  const { env, call } = setup();
  const admin = { email: "boss@aione.biz", name: "Boss", role: "admin", dev: "", v: 1 };
  await saveUser(env.STORE, admin);
  const adminTok = (await makeToken(env, admin.email, Date.now(), 1)).token;
  // An old report: fresh, but its rows have no posVersion.
  await env.STORE.set("dbreport:v1", JSON.stringify({ builtAt: Date.now(), count: 1, rows: [{ instance: "odoo503", database: "RonitYamProd" }] }), 3600);
  let rows = [];
  for (let i = 0; i < 5 && !rows.some((r) => "posVersion" in r); i++) {
    const r = await (await call("/db-report", { token: adminTok })).json();
    rows = (r.report && r.report.rows) || [];
    if (!rows.some((x) => "posVersion" in x)) await call("/db-report/refresh", { method: "POST", token: adminTok });
  }
  const ronit = rows.find((x) => x.instance === "odoo503");
  assert.equal(ronit.posVersion, "19.0.3.97.2");
});

test("the page gets the saved report at once; an out-of-date one is updated in the background", async () => {
  const { env, call } = setup();
  const admin = { email: "boss@aione.biz", name: "Boss", role: "admin", dev: "", v: 1 };
  await saveUser(env.STORE, admin);
  const token = (await makeToken(env, admin.email, Date.now(), 1)).token;
  const old = { builtAt: Date.now() - 3 * 3600 * 1000, count: 1, format: 2, rows: [{ instance: "odoo503", database: "RonitYamProd", posVersion: "", section: "main", online: true }] };
  await env.STORE.set("dbreport:v1", JSON.stringify(old), 3600);
  const seen = []; const inner = globalThis.fetch;
  globalThis.fetch = (url, init) => { seen.push(String(url)); return inner(url, init); };
  try {
    const r = await (await call("/db-report", { token })).json();
    assert.equal(r.building, true); assert.equal(r.report.builtAt, old.builtAt);
    assert.equal(seen.length, 0, "no Odoo or customer calls before answering");
    // A fresh report needs no update.
    await env.STORE.set("dbreport:v1", JSON.stringify({ ...old, builtAt: Date.now() }), 3600);
    assert.equal((await (await call("/db-report", { token })).json()).building, false);
  } finally { globalThis.fetch = inner; }
});

test("test and dev instances sign in with their production instance's login; offline servers are skipped", async () => {
  const { env, call } = setup();
  const admin = { email: "boss@aione.biz", name: "Boss", role: "admin", dev: "", v: 1 };
  await saveUser(env.STORE, admin);
  const token = (await makeToken(env, admin.email, Date.now(), 1)).token;
  const inner = globalThis.fetch, logins = [];
  // Audit & Deploy lists 503's test copies and a dev copy, and a test server that is switched off.
  const extra = [
    { instance_name: "odoo503test", domain: "503test.ai1.host", server_zone: "test" },
    { instance_name: "odoo503dev1", domain: "503dev1.ai1.host", server_zone: "development" },
    { instance_name: "odoo503t", domain: "503.test.ai1.host", server_zone: "test" },
    { instance_name: "odoo503d", domain: "503.dev.ai1.host", server_zone: "prod" },
    { instance_name: "odoo600test", domain: "600test.ai1.host", server_zone: "test" }
  ];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), p = (JSON.parse(init.body || "{}").params) || {};
    if (u.includes("kadis.odoo.test") && p.args && p.args[3] === "monitor.data.snapshot" && p.args[4] === "get_instances") {
      const r = await (await inner(url, init)).json(); r.result.payload.services.push(...extra); return Response.json(r.result ? { result: r.result } : r);
    }
    if (u.includes("kadis.odoo.test") && p.args && p.args[3] === "knowledge.article") {
      return Response.json({ result: [{ name: "Ronit Yam", body: "URL: https://503.ai1.host/web User: admin Password: pw123" }, { name: "Six hundred", body: "URL: https://600.ai1.host User: boss Password: six" }] });
    }
    if (u.includes("600test.ai1.host")) { logins.push(u); throw new TypeError("fetch failed"); }
    // The test and dev servers: no database list; the production login works on <prod db>_test / _dev.
    const m = /\/\/(503test|503dev1|503\.test|503\.dev)\.ai1\.host/.exec(u);
    if (m) {
      if (p.service === "db") return Response.json({ error: { message: "Access denied" } });
      if (p.service === "common" && p.method === "version") return Response.json({ result: { server_serie: "18.0" } });
      if (p.service === "common" && p.method === "authenticate") { logins.push(m[1] + " " + p.args.slice(0, 3).join(" ")); const ok = p.args[1] === "admin" && p.args[2] === "pw123" && (p.args[0] === "RonitYamProd_test" || p.args[0] === "RonitYamProd_dev"); return Response.json({ result: ok ? 9 : false }); }
      return Response.json({ result: p.args && p.args[4] === "search_count" ? 4 : [] });
    }
    return inner(url, init);
  };
  try {
    let r; for (let i = 0; i < 5; i++) { r = await (await call("/db-report/refresh", { method: "POST", token })).json(); if (r.done) break; }
    const row = (n) => r.report.rows.find((x) => x.instance === n);

    assert.equal(row("odoo503d").section, "dev"); assert.equal(row("odoo503d").db, "RonitYamProd_dev");
    for (const n of ["odoo503test", "odoo503dev1", "odoo503t", "odoo503d"]) { assert.equal(row(n).loginOk, true, n); assert.equal(row(n).users, 4, n); }
    assert.equal(row("odoo503test").db, "RonitYamProd_test"); assert.equal(row("odoo503dev1").db, "RonitYamProd_dev");
    assert.equal(row("odoo503test").section, "tests"); assert.equal(row("odoo503dev1").section, "dev");
    // Switched off: shown as offline, after one failed connection (no login attempts).
    assert.equal(row("odoo600test").offline, true); assert.equal(row("odoo600test").loginOk, false);
    assert.equal(logins.filter((l) => l.includes("600test")).length, 1);
  } finally { globalThis.fetch = inner; }
});

test("the section follows the instance name and the web address: 503.dev, 503dev1, 503.test, 503test, 503t", async () => {
  const { sectionOf } = await import("../proxy/src/db-report.js");
  const cases = [["odoo503", "503.ai1.host", "main"], ["odoo503b", "503.dev.ai1.host", "dev"], ["odoo503b", "503dev.ai1.host", "dev"], ["odoo503c", "503dev1.ai1.host", "dev"],
    ["odoo503x", "503dev3.ai1.host", "dev"], ["odoo503b", "503.test.ai1.host", "tests"], ["odoo503b", "503test.ai1.host", "tests"], ["odoo503b", "503t.ai1.host", "tests"],
    ["odoo503t", "503x.ai1.host", "tests"], ["odoo503_dev", "503.ai1.host", "dev"], ["paytag", "paytag.ai1.host", "main"], ["odoo540", "540.ai1.host", "main"]];
  for (const [name, domain, want] of cases) assert.equal(sectionOf("prod", name, domain), want, name + " " + domain);
  // Audit & Deploy's own test and development zones still decide first.
  assert.equal(sectionOf("test", "odoo503", "503.ai1.host"), "tests"); assert.equal(sectionOf("development", "odoo503", "503.ai1.host"), "dev");
});

test("a password with @ under the email is read as the password (554 layout); a capitalised email is also tried in lower case", () => {
  const c = parseCreds('<h1>554.ai1.host</h1><p><a href="https://554.ai1.host">554.ai1.host</a></p><p><a href="mailto:Shopowner42@example.invalid">Shopowner42@example.invalid</a></p><p>Shop@2026</p>');
  assert.equal(c.num, "554");
  assert.deepEqual(c.candidates[0], { user: "Shopowner42@example.invalid", password: "Shop@2026" });
  assert.deepEqual(c.candidates[1], { user: "shopowner42@example.invalid", password: "Shop@2026" });
  // Still: two emails on two lines are two users, not a user and a password.
  const two = parseCreds("<p>https://560.ai1.host</p><p>first@shop.co</p><p>second@shop.co</p><p>Pw12345!</p>");
  assert.deepEqual(two.candidates[0], { user: "second@shop.co", password: "Pw12345!" });
  // Any capitalised login (labelled, or anywhere in the article) is also tried in lower case.
  const labelled = parseCreds("<p>https://561.ai1.host</p><p>User: Manager</p><p>Password: Shop2026</p>");
  assert.ok(labelled.candidates.some((x) => x.user === "Manager" && x.password === "Shop2026"));
  assert.ok(labelled.candidates.some((x) => x.user === "manager" && x.password === "Shop2026"));
});

test("the POS version comes from Audit & Deploy's AI1 Settings (flutter_pos_api module_version)", async () => {
  const { env, call } = setup();
  const admin = { email: "boss@aione.biz", name: "Boss", role: "admin", dev: "", v: 1 };
  await saveUser(env.STORE, admin);
  const token = (await makeToken(env, admin.email, Date.now(), 1)).token;
  const inner = globalThis.fetch, asked = [];
  globalThis.fetch = async (url, init = {}) => {
    const p = (JSON.parse(init.body || "{}").params) || {};
    if (String(url).includes("kadis.odoo.test") && p.args && p.args[4] === "get_ai1_overview") {
      asked.push(p.args[5]);
      return Response.json({ result: { payload: p.args[5][0] === "odoo100" ? { installed: true, module_version: "19.0.4.2.0", databases: [] } : {} } });
    }
    return inner(url, init);
  };
  try {
    let r; for (let i = 0; i < 5; i++) { r = await (await call("/db-report/refresh", { method: "POST", token })).json(); if (r.done) break; }
    const row = (n) => r.report.rows.find((x) => x.instance === n);
    assert.equal(row("odoo100").posVersion, "19.0.4.2.0", "from AI1 Settings");
    assert.equal(row("odoo503").posVersion, "19.0.3.97.2", "falls back to the add-on list");
    assert.deepEqual(asked.find((a) => a[0] === "odoo100"), ["odoo100", false], "the saved snapshot, not a forced refresh");
    assert.equal(r.report.format, 2);
  } finally { globalThis.fetch = inner; }
});
