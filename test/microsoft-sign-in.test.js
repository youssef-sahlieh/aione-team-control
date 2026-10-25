// Run with: npm test. Checks sign-in with Microsoft: the redirect to Microsoft, the checks on Microsoft's
// answer (signature, tenant, app, nonce, expiry), that only existing accounts get in, and one-time handoffs.
// Microsoft's token and key endpoints are replaced by a fake that signs with a test key.
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import handler, { readToken } from "../proxy/src/handler.js";
import { createLinkToken, memoryStore, saveUser } from "../proxy/src/users.js";

const { subtle } = webcrypto;
const enc = new TextEncoder();
const TENANT = "11111111-2222-3333-4444-555555555555", CLIENT = "app-client-id";
const DASHBOARD = "https://dashboard.ai1.host/index.html";
const realFetch = globalThis.fetch;

const pair = await subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const otherPair = await subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const publicJwk = { ...(await subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
async function idToken(claims, key = pair.privateKey) {
  const head = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const body = b64u(JSON.stringify(claims));
  const sig = await subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(head + "." + body));
  return head + "." + body + "." + b64u(sig);
}

let store, tokenHandler;
const env = () => ({
  STORE: store, ALLOWED_ORIGIN: "https://dashboard.ai1.host", APP_URL: "https://dashboard.ai1.host", SESSION_SECRET: "test-session-secret",
  TEAM_EMAILS: "youssef@aione.biz", JIRA_PROJECT: "AION", TEAM_CONFIG: "{}",
  MS_SIGNIN_TENANT: TENANT, MS_SIGNIN_CLIENT_ID: CLIENT, MS_SIGNIN_CLIENT_SECRET: "client-secret", MS_SIGNIN_REDIRECT: "https://proxy.test/auth/microsoft/callback"
});

test.beforeEach(async () => {
  store = memoryStore();
  await saveUser(store, { email: "ellen@aione.biz", name: "Ellen", role: "user", dev: "ellen", v: 0 });
  tokenHandler = async () => Response.json({ id_token: await idToken(claims()) });
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/oauth2/v2.0/token")) return tokenHandler(init);
    if (u.includes("/discovery/v2.0/keys")) return Response.json({ keys: [publicJwk] });
    return new Response("", { status: 404 });
  };
});
test.after(() => { globalThis.fetch = realFetch; });

let nonce = "";
function claims(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: "https://login.microsoftonline.com/" + TENANT + "/v2.0", tid: TENANT, aud: CLIENT, iat: now, nbf: now, exp: now + 600, nonce, preferred_username: "ellen@aione.biz", ...over };
}

// Starts a sign-in as the browser would, returns Microsoft's address and the state.
async function start(e = env()) {
  const r = await handler.fetch(new Request("https://proxy.test/auth/microsoft/start?return=" + encodeURIComponent(DASHBOARD)), e);
  const to = new URL(r.headers.get("Location"));
  nonce = to.searchParams.get("nonce");
  return { status: r.status, to, state: to.searchParams.get("state") };
}
// Microsoft sends the person back to the proxy; the proxy answers with a redirect to the dashboard.
async function callback(state, e = env()) {
  const r = await handler.fetch(new Request("https://proxy.test/auth/microsoft/callback?code=auth-code&state=" + state), e);
  return new URL(r.headers.get("Location"));
}

test("start sends the browser to Microsoft with a one-time state, a nonce and PKCE", async () => {
  const s = await start();
  assert.equal(s.status, 302);
  assert.equal(s.to.origin + s.to.pathname, "https://login.microsoftonline.com/" + TENANT + "/oauth2/v2.0/authorize");
  assert.equal(s.to.searchParams.get("client_id"), CLIENT);
  assert.equal(s.to.searchParams.get("code_challenge_method"), "S256");
  assert.ok(s.state && nonce);
});

test("start only returns people to the dashboard's own addresses", async () => {
  const r = await handler.fetch(new Request("https://proxy.test/auth/microsoft/start?return=" + encodeURIComponent("https://evil.example/index.html")), env());
  assert.equal(r.status, 400);
});

test("a good sign-in for an existing account gets a one-time handoff, then the dashboard's session", async () => {
  const s = await start();
  const back = await callback(s.state);
  assert.equal(back.origin + back.pathname, DASHBOARD);
  const handoff = new URLSearchParams(back.hash.slice(1)).get("ms");
  assert.ok(handoff);

  const e = env();
  const ok = await handler.fetch(new Request("https://proxy.test/auth/microsoft/exchange", { method: "POST", body: JSON.stringify({ code: handoff }) }), e);
  assert.equal(ok.status, 200);
  const session = await ok.json();
  assert.equal(session.email, "ellen@aione.biz");
  assert.equal(session.role, "user");
  const me = await readToken(e, "Bearer " + session.token);
  assert.equal(me.email, "ellen@aione.biz");

  // The handoff works once only.
  const again = await handler.fetch(new Request("https://proxy.test/auth/microsoft/exchange", { method: "POST", body: JSON.stringify({ code: handoff }) }), e);
  assert.equal(again.status, 400);
});

test("signing in never creates an account: an unknown Microsoft user is turned away", async () => {
  const s = await start();
  tokenHandler = async () => Response.json({ id_token: await idToken(claims({ preferred_username: "stranger@aione.biz" })) });
  const back = await callback(s.state);
  assert.equal(new URLSearchParams(back.hash.slice(1)).get("ms_error"), "no_account");
});

test("Microsoft's answer must match this request: nonce, app, tenant, expiry and signature are all checked", async () => {
  const other = "99999999-2222-3333-4444-555555555555";
  const cases = [
    [() => claims({ nonce: "someone-else" }), () => pair.privateKey, "token"],
    [() => claims({ aud: "another-app" }), () => pair.privateKey, "token"],
    [() => claims({ tid: other, iss: "https://login.microsoftonline.com/" + other + "/v2.0" }), () => pair.privateKey, "tenant"],
    [() => claims({ exp: Math.floor(Date.now() / 1000) - 3600 }), () => pair.privateKey, "token"],
    [() => claims(), () => otherPair.privateKey, "token"]
  ];
  for (const [makeClaims, makeKey, expected] of cases) {
    const s = await start();
    tokenHandler = async () => Response.json({ id_token: await idToken(makeClaims(), makeKey()) });
    const back = await callback(s.state);
    assert.equal(new URLSearchParams(back.hash.slice(1)).get("ms_error"), expected);
  }
});

test("a sign-in state works once: replaying the callback is refused", async () => {
  const s = await start();
  await callback(s.state);
  const replay = await callback(s.state);
  assert.equal(new URLSearchParams(replay.hash.slice(1)).get("ms_error"), "state");
});

test("a password-reset link can't be used to sign in with Microsoft", async () => {
  const reset = await createLinkToken(store, "ellen@aione.biz", "reset", 900);
  const e = env();
  const r = await handler.fetch(new Request("https://proxy.test/auth/microsoft/exchange", { method: "POST", body: JSON.stringify({ code: reset }) }), e);
  assert.equal(r.status, 400);
  // ...and the reset link is still good for resetting the password.
  const { peekLinkToken } = await import("../proxy/src/users.js");
  assert.equal((await peekLinkToken(store, reset)).purpose, "reset");
});

test("without the Microsoft settings, sign-in with Microsoft is switched off", async () => {
  const off = { ...env(), MS_SIGNIN_CLIENT_SECRET: "" };
  const r = await handler.fetch(new Request("https://proxy.test/auth/microsoft/start?return=" + encodeURIComponent(DASHBOARD)), off);
  assert.equal(r.status, 501);
});
