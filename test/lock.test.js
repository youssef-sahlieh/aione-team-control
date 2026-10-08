// Run with: npm test  (Node 20+). Checks that the app content only unlocks with an approved email and password.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emailId, openContent, seal, unlockKey } from "../public/assets/lock.js";

const ITER = 1000; // fast for tests; the real build uses lock.js ITERATIONS
const html = "<h2>secret dashboard</h2>";
const locked = await seal(html, [
  { email: "youssef@aione.biz", password: "pw-one" },
  { email: "ellen@aione.biz", password: "pw-two" }
], ITER);
const open = async (email, pw) => { const k = await unlockKey(locked, email, pw); return k && openContent(locked, k); };

const tests = [
  ["youssef unlocks", async () => assert.equal(await open("youssef@aione.biz", "pw-one"), html)],
  ["ellen unlocks, mixed case and spaces", async () => assert.equal(await open("  Ellen@Aione.biz ", "pw-two"), html)],
  ["wrong password refused", async () => assert.equal(await open("youssef@aione.biz", "nope"), null)],
  ["someone else's password refused", async () => assert.equal(await open("youssef@aione.biz", "pw-two"), null)],
  ["unknown email refused", async () => assert.equal(await open("someone@aione.biz", "pw-one"), null)],
  ["empty password refused", async () => assert.equal(await open("youssef@aione.biz", ""), null)],
  ["content not readable in the locked file", async () => assert.doesNotMatch(JSON.stringify(locked), /secret|dashboard/)],
  ["emails not readable in the locked file", async () => {
    assert.doesNotMatch(JSON.stringify(locked), /aione\.biz/);
    assert.ok(locked.users[await emailId("youssef@aione.biz")]);
  }],
  ["a key from an old build doesn't open a new one", async () => {
    const k = await unlockKey(locked, "youssef@aione.biz", "pw-one");
    const rebuilt = await seal(html, [{ email: "youssef@aione.biz", password: "pw-one" }], ITER);
    assert.equal(await openContent(rebuilt, k), null);
  }],
  ["pages have no inline scripts or styles (blocked by the security policy)", () => {
    for (const f of ["../public/index.html", "../src/app.html"]) {
      const page = readFileSync(new URL(f, import.meta.url), "utf8");
      assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)[^>]*>/, f);
      assert.doesNotMatch(page, /\sstyle="/, f);
    }
  }]
];

let pass = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log("ok   -", name); }
  catch (e) { console.log("FAIL -", name, "\n      ", e.message); process.exitCode = 1; }
}
console.log(`\n${pass}/${tests.length} passed`);
