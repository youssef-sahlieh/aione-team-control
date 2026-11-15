import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import {
  _test,
  beginMfaLogin,
  beginMfaSetup,
  completeMfaLogin,
  completeMfaSetup,
  disableMfa,
  publicMfaStatus,
  mfaSessionAssured,
} from "../proxy/src/mfa.js";
import { getUser, memoryStore, saveUser } from "../proxy/src/users.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const env = {
  MFA_ENCRYPTION_KEY: "mfa-test-key-that-is-longer-than-thirty-two-characters",
  TEAM_MFA_POLICY: "enroll",
};
const now = Date.parse("2026-11-15T12:00:00Z");

async function fixture() {
  const store = memoryStore();
  const user = {
    id: "account-1",
    email: "admin@aione.biz",
    name: "Admin",
    role: "admin",
    status: "active",
    v: 1,
  };
  await saveUser(store, user);
  return { store, user };
}

async function enroll(store, user) {
  const setup = await beginMfaSetup(env, store, user);
  const counter = Math.floor(now / 30_000);
  const code = await _test.hotp(setup.secret, counter);
  const completed = await completeMfaSetup(env, store, user, setup.token, code, now);
  return { setup, completed, user: await getUser(store, user.email) };
}

test("privileged Team Control accounts can enroll without replacing their account", async () => {
  const { store, user } = await fixture();
  const result = await enroll(store, user);
  assert.equal(result.completed.recoveryCodes.length, 10);
  assert.equal(publicMfaStatus(env, result.user).enabled, true);
  assert.equal(publicMfaStatus(env, result.user).required, true);
  assert.equal(result.user.id, user.id);
});

test("login challenges are one-time and TOTP values cannot be replayed", async () => {
  const { store, user } = await fixture();
  const enrolled = await enroll(store, user);
  const challenge = await beginMfaLogin(store, enrolled.user);
  const next = now + 30_000;
  const code = await _test.hotp(enrolled.setup.secret, Math.floor(next / 30_000));
  const accepted = await completeMfaLogin(env, store, challenge, code, next);
  assert.equal(accepted.method, "otp");
  assert.equal(await completeMfaLogin(env, store, challenge, code, next), null);
  const replayChallenge = await beginMfaLogin(store, accepted.user);
  assert.equal(await completeMfaLogin(env, store, replayChallenge, code, next), null);
});

test("recovery codes are single-use and can disable MFA", async () => {
  const { store, user } = await fixture();
  const enrolled = await enroll(store, user);
  const recoveryCode = enrolled.completed.recoveryCodes[0];
  assert.equal(await disableMfa(env, store, enrolled.user, recoveryCode, now + 1), true);
  const saved = await getUser(store, user.email);
  assert.equal(publicMfaStatus(env, saved).enabled, false);
  assert.equal(await disableMfa(env, store, saved, recoveryCode, now + 2), false);
});

test("MFA assurance expires at the configured session age", () => {
  const identity = { amr: ["pwd", "otp"], auth_time: Math.floor(now / 1000) };
  assert.equal(mfaSessionAssured({ ...env, TEAM_MFA_MAX_AGE_SECONDS: "300" }, identity, now + 299_000), true);
  assert.equal(mfaSessionAssured({ ...env, TEAM_MFA_MAX_AGE_SECONDS: "300" }, identity, now + 301_000), false);
  assert.equal(mfaSessionAssured(env, { amr: ["pwd"], auth_time: Math.floor(now / 1000) }, now), false);
});
