// Opening a customer database through AI1 Monitor's Open Odoo (no password), against a fake Monitor and Odoo.
import test from "node:test";
import assert from "node:assert/strict";
import { memoryStore, saveUser, useLinkToken } from "../proxy/src/users.js";
import { openOdoo, forgetMonitorSignIn, rememberMonitorAccount } from "../proxy/src/monitor-odoo.js";

const STATE = "s".repeat(43), SID = "o".repeat(70);

// A fake Monitor + Odoo site. Records every call; the code given to Monitor must be redeemable for the state.
function fakeWorld(store, { linked = true, openStatus = 303 } = {}) {
  const calls = [];
  const res = (status, { location, cookies = [], body } = {}) => {
    const h = new Headers(); if (location) h.set("location", location);
    for (const c of cookies) h.append("set-cookie", c);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: h });
  };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), headers = new Headers(init.headers || {});
    calls.push({ url: u.origin + u.pathname + u.search, method: init.method || "GET", cookie: headers.get("cookie") || "", origin: headers.get("origin") || "", body: init.body ? JSON.parse(init.body) : null });
    if (u.pathname === "/auth/aione/start") return res(302, { location: "https://dashboard.example.invalid/dashboard.html?ai1-monitor=" + STATE, cookies: ["aione_state=" + STATE + "; Path=/auth/aione/callback; HttpOnly"] });
    if (u.pathname === "/auth/aione/callback") {
      assert.match(headers.get("cookie"), new RegExp("aione_state=" + STATE));
      const grant = await useLinkToken(store, u.searchParams.get("code"));
      assert.equal(grant.purpose, "monitor-sso:" + STATE);
      return linked ? res(302, { location: "/dashboard", cookies: ["session=monitor-session; Path=/; HttpOnly"] }) : res(302, { location: "/auth/aione/connect" });
    }
    if (u.pathname.endsWith("/open-odoo")) {
      assert.match(headers.get("cookie"), /session=monitor-session/);
      if (openStatus !== 303) return res(openStatus, { body: { success: false, error: "Infrastructure Operator access is required" } });
      return res(303, { location: "https://519.dev6.ai1.host/__ai1_sso#token=one-use-token" });
    }
    if (u.pathname === "/__ai1_sso") { assert.equal(headers.get("origin"), "https://519.dev6.ai1.host"); return res(200, { body: { success: true }, cookies: ["session_id=" + SID + "; Path=/; HttpOnly"] }); }
    assert.equal(headers.get("cookie"), "session_id=" + SID);
    if (u.pathname === "/web/session/get_session_info") return res(200, { body: { jsonrpc: "2.0", result: { db: "dev-519t6_main", uid: 2 } } });
    if (u.pathname === "/web/dataset/call_kw/res.users/search_count") return res(200, { body: { jsonrpc: "2.0", result: 7 } });
    if (u.pathname === "/web/session/destroy") return res(200, { body: { jsonrpc: "2.0", result: null } });
    return res(404, { body: { error: "unexpected " + u.pathname } });
  };
  return { calls, fetchImpl };
}

async function world(opts) {
  forgetMonitorSignIn();
  const store = memoryStore();
  await saveUser(store, { email: "admin@example.invalid", name: "Admin Example", role: "admin", id: "acct-admin-1" });
  const env = { STORE: store, MONITOR_SIGNING_KEY: "{}", MONITOR_PUBLIC_ORIGIN: "https://monitor.example.invalid" };
  return { env, store, ...fakeWorld(store, opts) };
}

test("a database opens through Monitor's Open Odoo and is read with the administrator session, then signed out", async () => {
  const { env, calls, fetchImpl } = await world();
  await rememberMonitorAccount(env, { email: "admin@example.invalid", role: "admin" });
  const login = await openOdoo(env, "dev-519t6", "", { fetchImpl });
  assert.equal(login.loginOk, true);
  assert.equal(login.via, "monitor");
  assert.equal(login.db, "dev-519t6_main");
  assert.equal(await login.kw("res.users", "search_count", [[["share", "=", false]]]), 7);
  await login.close();
  const paths = calls.map((c) => c.method + " " + c.url.replace(/\?.*/, ""));
  assert.deepEqual(paths, [
    "GET https://monitor.example.invalid/auth/aione/start",
    "GET https://monitor.example.invalid/auth/aione/callback",
    "GET https://monitor.example.invalid/api/monitor/instances/dev-519t6/open-odoo",
    "POST https://519.dev6.ai1.host/__ai1_sso",
    "POST https://519.dev6.ai1.host/web/session/get_session_info",
    "POST https://519.dev6.ai1.host/web/dataset/call_kw/res.users/search_count",
    "POST https://519.dev6.ai1.host/web/session/destroy",
  ]);
  assert.deepEqual(calls[3].body, { token: "one-use-token" });
  assert.equal(calls[5].body.params.model, "res.users");
  // No password anywhere in what was sent.
  assert.ok(!JSON.stringify(calls).match(/password/i));
});

test("a second database reuses the Monitor sign-in, and the database name is passed when given", async () => {
  const { env, calls, fetchImpl } = await world();
  await openOdoo(env, "dev-519t6", "", { fetchImpl });
  await openOdoo(env, "odoo515", "nativity", { fetchImpl });
  assert.equal(calls.filter((c) => c.url.includes("/auth/aione/start")).length, 1);
  assert.ok(calls.some((c) => c.url.endsWith("/api/monitor/instances/odoo515/open-odoo?database=nativity")));
});

test("Monitor's refusals come back as readable errors", async () => {
  let w = await world({ linked: false });
  await assert.rejects(openOdoo(w.env, "dev-519t6", "", { fetchImpl: w.fetchImpl }), /isn't linked to an AI1 Monitor account/);
  w = await world({ openStatus: 403 });
  await assert.rejects(openOdoo(w.env, "dev-519t6", "", { fetchImpl: w.fetchImpl }), /Infrastructure Operator access is required/);
  await assert.rejects(openOdoo(w.env, "../x", "", { fetchImpl: w.fetchImpl }), /invalid instance/);
});

test("without an administrator account nothing is tried", async () => {
  forgetMonitorSignIn();
  const env = { STORE: memoryStore(), MONITOR_SIGNING_KEY: "{}" };
  await assert.rejects(openOdoo(env, "dev-519t6", "", { fetchImpl: () => { throw new Error("no call expected"); } }), /No administrator account/);
});
