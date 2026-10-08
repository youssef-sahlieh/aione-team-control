// Run with: npm test  (Node 20+). Checks the sign-in rules in public/assets/auth.js.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allowedEmail, configProblem, redirectUri } from "../public/assets/auth.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const cfg = { clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", tenantId: TENANT, allowedEmails: ["youssef@aione.biz", "ellen@aione.biz"] };
const acct = (username, tid = TENANT) => ({ username, tenantId: tid, idTokenClaims: { tid } });

const tests = [
  ["youssef allowed", () => assert.equal(allowedEmail(acct("youssef@aione.biz"), cfg), "youssef@aione.biz")],
  ["ellen allowed, mixed case", () => assert.equal(allowedEmail(acct("Ellen@Aione.biz"), cfg), "ellen@aione.biz")],
  ["other aione user refused", () => assert.equal(allowedEmail(acct("someone@aione.biz"), cfg), "")],
  ["allowed email from another tenant refused", () => assert.equal(allowedEmail(acct("youssef@aione.biz", "99999999-2222-3333-4444-555555555555"), cfg), "")],
  ["account without tenant refused", () => assert.equal(allowedEmail({ username: "youssef@aione.biz" }, cfg), "")],
  ["no account refused", () => assert.equal(allowedEmail(null, cfg), "")],
  ["config ready", () => assert.equal(configProblem(cfg), "")],
  ["placeholder client id reported", () => assert.match(configProblem({ ...cfg, clientId: "REPLACE_WITH_CLIENT_ID" }), /clientId/)],
  ["placeholder tenant id reported", () => assert.match(configProblem({ ...cfg, tenantId: "REPLACE_WITH_TENANT_ID" }), /tenantId/)],
  ["empty allow-list reported", () => assert.match(configProblem({ ...cfg, allowedEmails: [] }), /allowedEmails/)],
  ["redirect drops index.html", () => assert.equal(redirectUri({ origin: "https://x.github.io", pathname: "/aione-team-control/index.html" }), "https://x.github.io/aione-team-control/")],
  ["redirect keeps folder path", () => assert.equal(redirectUri({ origin: "https://x.github.io", pathname: "/aione-team-control/" }), "https://x.github.io/aione-team-control/")],
  ["page has no inline scripts (blocked by its security policy)", () => {
    const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /\sstyle="/);
  }]
];

let pass = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log("ok   -", name); }
  catch (e) { console.log("FAIL -", name, "\n      ", e.message); process.exitCode = 1; }
}
console.log(`\n${pass}/${tests.length} passed`);
