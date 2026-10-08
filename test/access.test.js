// Run with: node test/access.test.js  (Node 20+). Uses a locally generated key instead of Cloudflare's.
import assert from "node:assert/strict";
import { verifyAccess } from "../src/access.js";
import worker from "../src/index.js";

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const other = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);

const env = { TEAM_DOMAIN: "aione.cloudflareaccess.com", POLICY_AUD: "aud123", ALLOWED_EMAILS: "youssef@aione.biz,ellen@aione.biz" };
const fakeFetch = async (url) => { assert.equal(url, "https://aione.cloudflareaccess.com/cdn-cgi/access/certs"); return Response.json({ keys: [jwk] }); };
globalThis.fetch = fakeFetch;

async function token(payload, { key = privateKey, kid = "k1" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = enc({ alg: "RS256", kid, typ: "JWT" });
  const p = enc({ aud: ["aud123"], iss: "https://aione.cloudflareaccess.com", iat: now, nbf: now, exp: now + 3600, ...payload });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(h + "." + p));
  return h + "." + p + "." + Buffer.from(sig).toString("base64url");
}
const req = (t, path = "/") => new Request("https://team.aione.host" + path, { headers: t ? { "Cf-Access-Jwt-Assertion": t } : {} });

const tests = [
  ["valid youssef", async () => assert.equal((await verifyAccess(req(await token({ email: "youssef@aione.biz" })), env, fakeFetch)).email, "youssef@aione.biz")],
  ["valid ellen, mixed case", async () => assert.equal((await verifyAccess(req(await token({ email: "Ellen@aione.biz" })), env, fakeFetch)).email, "ellen@aione.biz")],
  ["cookie token works", async () => { const t = await token({ email: "youssef@aione.biz" }); const r = new Request("https://team.aione.host/", { headers: { Cookie: "a=1; CF_Authorization=" + t } }); assert.equal((await verifyAccess(r, env, fakeFetch)).email, "youssef@aione.biz"); }],
  ["no token", async () => assert.rejects(verifyAccess(req(null), env, fakeFetch), /no_token/)],
  ["email not allowed", async () => assert.rejects(verifyAccess(req(await token({ email: "someone@aione.biz" })), env, fakeFetch), /not_allowed/)],
  ["wrong audience", async () => assert.rejects(verifyAccess(req(await token({ email: "youssef@aione.biz", aud: ["other"] })), env, fakeFetch), /wrong_audience/)],
  ["expired", async () => assert.rejects(verifyAccess(req(await token({ email: "youssef@aione.biz", exp: 1000 })), env, fakeFetch), /expired/)],
  ["forged signature", async () => assert.rejects(verifyAccess(req(await token({ email: "youssef@aione.biz" }, { key: other.privateKey })), env, fakeFetch), /bad_signature/)],
  ["unknown key id", async () => assert.rejects(verifyAccess(req(await token({ email: "youssef@aione.biz" }, { kid: "zzz" })), env, fakeFetch), /unknown_key/)],
  ["wrong issuer", async () => assert.rejects(verifyAccess(req(await token({ email: "youssef@aione.biz", iss: "https://evil.cloudflareaccess.com" })), env, fakeFetch), /wrong_issuer/)],
  ["tampered payload", async () => { const t = (await token({ email: "someone@x.com" })).split("."); t[1] = enc({ email: "youssef@aione.biz", aud: ["aud123"], exp: 9999999999 }); await assert.rejects(verifyAccess(req(t.join(".")), env, fakeFetch), /bad_signature/); }]
];

// Worker-level checks with a fake static-assets binding.
const assets = { fetch: async (r) => new Response("ASSET " + new URL(r.url).pathname, { headers: { "Content-Type": "text/html" } }) };
const wenv = { ...env, ASSETS: assets };
tests.push(
  ["worker: page blocked without sign-in", async () => { const r = await worker.fetch(req(null), wenv); assert.equal(r.status, 403); assert.match(await r.text(), /don't have access/); }],
  ["worker: api blocked without sign-in", async () => { const r = await worker.fetch(req(null, "/api/me"), wenv); assert.equal(r.status, 403); }],
  ["worker: page served when signed in", async () => { const r = await worker.fetch(req(await token({ email: "ellen@aione.biz" })), wenv); assert.equal(r.status, 200); assert.equal(await r.text(), "ASSET /"); assert.ok(r.headers.get("Content-Security-Policy")); }],
  ["worker: /api/me returns email", async () => { const r = await worker.fetch(req(await token({ email: "youssef@aione.biz" }), "/api/me"), wenv); assert.equal((await r.json()).email, "youssef@aione.biz"); }],
  ["worker: stylesheet open for the no-access page", async () => { const r = await worker.fetch(req(null, "/assets/style.css"), wenv); assert.equal(r.status, 200); }],
  ["worker: other assets blocked without sign-in", async () => { const r = await worker.fetch(req(null, "/assets/app.js"), wenv); assert.equal(r.status, 403); }]
);

let pass = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log("ok   -", name); }
  catch (e) { console.log("FAIL -", name, "\n      ", e.message); process.exitCode = 1; }
}
console.log(`\n${pass}/${tests.length} passed`);
