// Run with: npm test. Checks the sign-in tokens for AI1 Monitor: the public key it checks with, who needs
// to be signed in to get a token, and that a token verifies only with the key that made it.
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import handler, { makeToken } from "../proxy/src/handler.js";
import { getUser, memoryStore, saveUser, deleteUser } from "../proxy/src/users.js";

const { subtle } = webcrypto;
const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const { privateKey } = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const privateJwk = await subtle.exportKey("jwk", privateKey);
const ACCOUNT_ID = "acct-youssef-0000000001";
const STORE = memoryStore();
await saveUser(STORE, { id: ACCOUNT_ID, email: "youssef@aione.biz", name: "Youssef", role: "admin", dev: "", pw: null, v: 0 });
const env = {
  ALLOWED_ORIGIN: "https://dashboard.ai1.host", TEAM_EMAILS: "youssef@aione.biz,ellen@aione.biz", JIRA_PROJECT: "AION",
  SESSION_SECRET: "test-session-secret", TEAM_CONFIG: "{}", MONITOR_SIGNING_KEY: JSON.stringify({ ...privateJwk, kid: "ai1-monitor-test" }),
  STORE
};
const get = (path, init, e = env) => handler.fetch(new Request("https://proxy.test" + path, init), e);
const signedIn = async (email = "youssef@aione.biz") => (await makeToken(env, email)).token;

test("the public key lets AI1 Monitor check tokens, without any private part", async () => {
  const r = await get("/sso/monitor/keys");
  assert.equal(r.status, 200);
  const { keys } = await r.json();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kid, "ai1-monitor-test");
  assert.equal(keys[0].alg, "EdDSA");
  assert.equal(keys[0].x, privateJwk.x);
  assert.equal(keys[0].d, undefined);
});

test("a token is issued only to a signed-in dashboard person", async () => {
  const r = await get("/sso/monitor", { method: "POST" });
  assert.equal(r.status, 401);
});

test("the token names the person, carries their role, and verifies with the published key only", async () => {
  const r = await get("/sso/monitor", { method: "POST", headers: { Authorization: "Bearer " + await signedIn() } });
  assert.equal(r.status, 200);
  const { token, expiresAt } = await r.json();
  const [head, body, sig] = token.split(".");
  const header = JSON.parse(b64urlDecode(head).toString());
  const claims = JSON.parse(b64urlDecode(body).toString());
  assert.equal(header.alg, "EdDSA");
  assert.equal(header.kid, "ai1-monitor-test");
  assert.equal(claims.iss, "aione-team-control");
  assert.equal(claims.aud, "ai1-monitor");
  assert.equal(claims.email, "youssef@aione.biz");
  // The subject is the immutable account ID. The email is only a display and audit claim.
  assert.equal(claims.sub, ACCOUNT_ID);
  assert.equal(claims.role, "admin");
  assert.equal(claims.exp - claims.iat, 60);
  assert.equal(expiresAt, claims.exp * 1000);

  const publicKey = await subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: privateJwk.x }, { name: "Ed25519" }, false, ["verify"]);
  const data = new TextEncoder().encode(head + "." + body);
  assert.equal(await subtle.verify("Ed25519", publicKey, b64urlDecode(sig), data), true);
  // Changing the claims breaks the signature.
  const forged = Buffer.from(JSON.stringify({ ...claims, role: "admin", email: "someone@aione.biz" })).toString("base64url");
  assert.equal(await subtle.verify("Ed25519", publicKey, b64urlDecode(sig), new TextEncoder().encode(head + "." + forged)), false);
});

test("a person with no stored account can't get a token, even with a valid session", async () => {
  // With a store, a session only counts while the account is saved, so ellen (not saved) gets nothing.
  const r = await get("/sso/monitor", { method: "POST", headers: { Authorization: "Bearer " + await signedIn("ellen@aione.biz") } });
  assert.equal(r.status, 401);
});

test("an account saved before IDs existed gets one, kept for later tokens", async () => {
  await saveUser(STORE, { email: "legacy@aione.biz", name: "Legacy", role: "user", dev: "web", pw: null, v: 0 });
  const first = await getUser(STORE, "legacy@aione.biz");
  assert.equal(first.id, undefined);
  const headers = { Authorization: "Bearer " + (await makeToken(env, "legacy@aione.biz")).token };
  const { token } = await (await get("/sso/monitor", { method: "POST", headers })).json();
  const again = await (await get("/sso/monitor", { method: "POST", headers })).json();
  const saved = await getUser(STORE, "legacy@aione.biz");
  assert.match(saved.id, /^[A-Za-z0-9_-]{16,128}$/);
  assert.equal(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub, saved.id);
  assert.equal(JSON.parse(Buffer.from(again.token.split(".")[1], "base64url").toString()).sub, saved.id);
});

test("a deleted and recreated account gets a new ID, so it never inherits the old one", async () => {
  await saveUser(STORE, { email: "rehired@aione.biz", name: "Rehired", role: "user", dev: "web", id: "acct-rehired-000000001", pw: null, v: 0 });
  await deleteUser(STORE, "rehired@aione.biz");
  await saveUser(STORE, { id: "acct-rehired-000000002", email: "rehired@aione.biz", name: "Rehired", role: "user", dev: "web", pw: null, v: 0 });
  const recreated = await getUser(STORE, "rehired@aione.biz");
  assert.notEqual(recreated.id, "acct-rehired-000000001");
});

test("without a valid signing key, sign-in for AI1 Monitor is switched off (no crash, no token)", async () => {
  const off = { ...env, MONITOR_SIGNING_KEY: "" };
  assert.equal((await get("/sso/monitor/keys", {}, off)).status, 503);
  const r = await get("/sso/monitor", { method: "POST", headers: { Authorization: "Bearer " + await signedIn() } }, off);
  assert.equal(r.status, 503);
});

const { createPublicKey, verify: nodeVerify } = await import("node:crypto");
const { checkMonitorToken, monitorToken } = await import("../proxy/src/monitor-sso.js");
const publicKeys = async () => (await get("/sso/monitor/keys")).json();
const person = { id: ACCOUNT_ID, email: "youssef@aione.biz", name: "Youssef", role: "admin", dev: "" };
// Signs claims the way AI1 Monitor's tests need: with the real private key, so only the claims differ.
async function signed(header, claims) {
  const head = Buffer.from(JSON.stringify(header)).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = await subtle.sign("Ed25519", privateKey, new TextEncoder().encode(head + "." + body));
  return head + "." + body + "." + Buffer.from(sig).toString("base64url");
}
const now = Math.floor(Date.now() / 1000);
const claimsFor = over => ({ iss: "aione-team-control", aud: "ai1-monitor", sub: person.id, email: person.email, role: "admin", iat: now, exp: now + 60, jti: "abc", ...over });
const header = { alg: "EdDSA", typ: "JWT", kid: "ai1-monitor-test" };

test("the PEM key is the same public key, readable by a standard loader", async () => {
  const { keys } = await publicKeys();
  const pub = createPublicKey(keys[0].pem);
  const token = (await monitorToken(env, person)).token;
  const [head, body, sig] = token.split(".");
  assert.equal(nodeVerify(null, Buffer.from(head + "." + body), pub, Buffer.from(sig, "base64url")), true);
});

test("the verifier accepts a fresh token and returns who it is for", async () => {
  const token = (await monitorToken(env, person)).token;
  const claims = await checkMonitorToken(token, await publicKeys());
  assert.equal(claims.email, "youssef@aione.biz");
  assert.equal(claims.role, "admin");
});

test("the verifier rejects tokens that are tampered with, expired, for another audience, or from another issuer", async () => {
  const keys = await publicKeys();
  const good = (await monitorToken(env, person)).token;
  const [head, body, sig] = good.split(".");
  const swapped = JSON.parse(Buffer.from(body, "base64url").toString());
  const tampered = head + "." + Buffer.from(JSON.stringify({ ...swapped, role: "admin", email: "other@aione.biz" })).toString("base64url") + "." + sig;
  await assert.rejects(checkMonitorToken(tampered, keys), /token_signature/);
  await assert.rejects(checkMonitorToken(await signed(header, claimsFor({ exp: now - 10, iat: now - 310 })), keys), /token_expired/);
  await assert.rejects(checkMonitorToken(await signed(header, claimsFor({ exp: now + 3600 })), keys), /token_expired/);
  await assert.rejects(checkMonitorToken(await signed(header, claimsFor({ exp: now + 120, iat: now })), keys), /token_expired/);
  await assert.rejects(checkMonitorToken(await signed(header, claimsFor({ aud: "filehostingservice" })), keys), /token_audience/);
  await assert.rejects(checkMonitorToken(await signed(header, claimsFor({ iss: "kad-odoo-monitor" })), keys), /token_audience/);
});

test("a token is never issued without an account ID, so no email subject can be produced", async () => {
  await assert.rejects(monitorToken(env, { email: person.email, name: "x", role: "admin", dev: "" }), /account ID/);
});

test("the verifier rejects unknown keys and the 'none' algorithm", async () => {
  const keys = await publicKeys();
  await assert.rejects(checkMonitorToken(await signed({ ...header, kid: "other" }, claimsFor({})), keys), /token_unknown_key/);
  const none = Buffer.from(JSON.stringify({ alg: "none", kid: "ai1-monitor-test" })).toString("base64url") + "." + Buffer.from(JSON.stringify(claimsFor({}))).toString("base64url") + ".";
  await assert.rejects(checkMonitorToken(none, keys), /token_alg/);
});

// Same-tab sign-in: the dashboard gets a one-time code for a state, and AI1 Monitor's server trades it for a token.
const STATE = "monitor-state-0000000000001";
const redeem = (body) => get("/sso/monitor/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function codeFor(state = STATE, email = "youssef@aione.biz") {
  return get("/sso/monitor/code", { method: "POST", headers: { Authorization: "Bearer " + await signedIn(email), "Content-Type": "application/json" }, body: JSON.stringify({ state }) });
}

test("a one-time code needs a signed-in person and a valid state", async () => {
  const anon = await get("/sso/monitor/code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: STATE }) });
  assert.equal(anon.status, 401);
  const bad = await get("/sso/monitor/code", { method: "POST", headers: { Authorization: "Bearer " + await signedIn(), "Content-Type": "application/json" }, body: JSON.stringify({ state: "short" }) });
  assert.equal(bad.status, 400);
});

test("the code response points at the AI1 Monitor callback", async () => {
  const r = await codeFor();
  assert.equal(r.status, 200);
  const { code, callback } = await r.json();
  assert.match(code, /^[\w-]{20,100}$/);
  assert.equal(callback, "https://monitor.ai1.host/auth/aione/callback");
});

test("redeeming the code with its state gives a token that verifies, once", async () => {
  const { code } = await (await codeFor()).json();
  const r = await redeem({ code, state: STATE });
  assert.equal(r.status, 200);
  const { token } = await r.json();
  const claims = await checkMonitorToken(token, await publicKeys());
  assert.equal(claims.sub, ACCOUNT_ID);
  assert.equal(claims.email, "youssef@aione.biz");
  assert.equal((await redeem({ code, state: STATE })).status, 400);
});

test("a code redeemed with the wrong state is refused and burned", async () => {
  const { code } = await (await codeFor()).json();
  assert.equal((await redeem({ code, state: "some-other-state-0000000001" })).status, 400);
  assert.equal((await redeem({ code, state: STATE })).status, 400);
});

test("a missing or unknown code is refused", async () => {
  assert.equal((await redeem({ state: STATE })).status, 400);
  assert.equal((await redeem({ code: "x".repeat(30), state: STATE })).status, 400);
});

test("a code for an account deleted in the meantime gives no token", async () => {
  await saveUser(STORE, { id: "acct-gone-0000000000001", email: "gone@aione.biz", name: "Gone", role: "admin", dev: "", pw: null, v: 0 });
  const { code } = await (await codeFor(STATE, "gone@aione.biz")).json();
  await deleteUser(STORE, "gone@aione.biz");
  const r = await redeem({ code, state: STATE });
  assert.equal(r.status, 403);
  assert.equal((await getUser(STORE, "gone@aione.biz")), null);
});

test("a code issued before an account was deleted doesn't sign in a recreated account with the same email", async () => {
  await saveUser(STORE, { id: "acct-old-0000000000000001", email: "recreated@aione.biz", name: "Old", role: "admin", dev: "", pw: null, v: 0 });
  const { code } = await (await codeFor(STATE, "recreated@aione.biz")).json();
  await deleteUser(STORE, "recreated@aione.biz");
  await saveUser(STORE, { id: "acct-new-0000000000000002", email: "recreated@aione.biz", name: "New", role: "admin", dev: "", pw: null, v: 0 });
  assert.equal((await redeem({ code, state: STATE })).status, 403);
});

test("a Monitor sign-in code can't be used to reset a password", async () => {
  await saveUser(STORE, { id: "acct-reset-0000000000000001", email: "resetme@aione.biz", name: "Reset", role: "admin", dev: "", pw: null, v: 0 });
  const { code } = await (await codeFor(STATE, "resetme@aione.biz")).json();
  const r = await get("/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: code, password: "Strong-pass-1234" }) });
  assert.equal(r.status, 400);
  assert.equal((await getUser(STORE, "resetme@aione.biz")).pw, null, "password unchanged");
});

test("a second person in the same browser gets their own token, never the first person's", async () => {
  const BOB_STATE = "bob-state-0000000000000001";
  await saveUser(STORE, { id: "acct-bob-0000000000000001", email: "bob@aione.biz", name: "Bob", role: "admin", dev: "", pw: null, v: 0 });
  // A code is bound to its state: the other person's state is refused (and burns the code).
  const bobForAlice = (await (await codeFor(BOB_STATE, "bob@aione.biz")).json()).code;
  assert.equal((await redeem({ code: bobForAlice, state: STATE })).status, 400);
  const aliceForBob = (await (await codeFor(STATE)).json()).code;
  assert.equal((await redeem({ code: aliceForBob, state: BOB_STATE })).status, 400);
  // Each person's own code names that person's account.
  const bobCode = (await (await codeFor(BOB_STATE, "bob@aione.biz")).json()).code;
  const bobClaims = await checkMonitorToken((await (await redeem({ code: bobCode, state: BOB_STATE })).json()).token, await publicKeys());
  assert.equal(bobClaims.sub, "acct-bob-0000000000000001");
  assert.equal(bobClaims.email, "bob@aione.biz");
  const aliceCode = (await (await codeFor(STATE)).json()).code;
  const aliceClaims = await checkMonitorToken((await (await redeem({ code: aliceCode, state: STATE })).json()).token, await publicKeys());
  assert.equal(aliceClaims.sub, ACCOUNT_ID);
});
