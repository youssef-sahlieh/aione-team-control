import {test} from "node:test";
import assert from "node:assert/strict";
import {monitorInstanceUrl, monitorOpenUrl, monitorOdooPath, rememberMonitorPage} from "../../public/assets/models/monitor-links.js";
test("Open links go to the instance's info page on AI1 Monitor",()=>{
  assert.equal(monitorInstanceUrl("000"),"https://monitor.ai1.host/dashboard#instance/000/info");
});
test("instance names are encoded so they cannot change the address",()=>{
  assert.equal(monitorInstanceUrl("a b/c?d#e"),"https://monitor.ai1.host/dashboard#instance/a%20b%2Fc%3Fd%23e/info");
});
test("Open goes through AI1 Monitor's one-click sign-in, with the instance page as next",()=>{
  const u=new URL(monitorOpenUrl("odoo503"));
  assert.equal(u.origin+u.pathname,"https://monitor.ai1.host/auth/aione/start");
  assert.equal(u.searchParams.get("next"),"/dashboard#instance/odoo503/info");
  assert.equal(new URL(monitorOpenUrl("a/b#c")).searchParams.get("next"),"/dashboard#instance/a%2Fb%23c/info");
});

test("an Open link remembers the instance page for the sign-in hand-off", () => {
  const saved = {};
  globalThis.localStorage = { setItem: (k, v) => { saved[k] = v; } };
  try {
    rememberMonitorPage("odoo503");
    const next = JSON.parse(saved["aione-monitor-next"]);
    assert.equal(next.page, "/dashboard#instance/odoo503/info");
    assert.ok(Date.now() - next.at < 1000);
  } finally { delete globalThis.localStorage; }
});

test("Open Odoo is Monitor's direct sign-in address, with the database only when given (encoded)",()=>{
  assert.equal(monitorOdooPath("odoo503"),"/api/monitor/instances/odoo503/open-odoo");
  assert.equal(monitorOdooPath("odoo503","503_shop"),"/api/monitor/instances/odoo503/open-odoo?database=503_shop");
  assert.equal(monitorOdooPath("a/b","x&y"),"/api/monitor/instances/a%2Fb/open-odoo?database=x%26y");
});
