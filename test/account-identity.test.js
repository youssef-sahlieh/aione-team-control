// Run with: npm test. Account IDs for AI1 Monitor links: two requests at once get the same saved ID, a concurrent
// password or role change is kept, and a deleted account is not written back.
import test from "node:test";
import assert from "node:assert/strict";
import { deleteUser, ensureAccountId, getUser, memoryStore, saveUser, updateUser } from "../proxy/src/users.js";

const email = "synthetic.person@example.invalid";
const seed = (store, extra = {}) => saveUser(store, { email, name: "Synthetic Person", role: "user", dev: "builder", pw: { salt: "s", hash: "h", iterations: 1 }, v: 1, ...extra });

// Runs `interleave` once, just before the first compare-and-set, to simulate another request writing in between.
function interleaveOnce(store, interleave) {
  const original = store.compareAndSet;
  let ran = false;
  store.compareAndSet = async (key, expected, value) => {
    if (!ran) { ran = true; await interleave(); }
    return original(key, expected, value);
  };
}

test("two simultaneous requests get the same saved account ID", async () => {
  const store = memoryStore();
  await seed(store);
  const stored = await getUser(store, email);
  const [a, b] = await Promise.all([ensureAccountId(store, stored), ensureAccountId(store, stored)]);
  assert.ok(a.id, "first request has an ID");
  assert.equal(a.id, b.id);
  assert.equal((await getUser(store, email)).id, a.id);
});

test("an existing account ID is never replaced", async () => {
  const store = memoryStore();
  await seed(store, { id: "fixed-id-1" });
  const stored = await getUser(store, email);
  assert.equal((await ensureAccountId(store, stored)).id, "fixed-id-1");
});

test("a password change made while the ID is being saved is kept", async () => {
  const store = memoryStore();
  await seed(store);
  const newPassword = { salt: "new", hash: "new-hash", iterations: 2 };
  interleaveOnce(store, () => updateUser(store, email, (cur) => ({ ...cur, pw: newPassword, v: cur.v + 1 })));
  const account = await ensureAccountId(store, await getUser(store, email));
  const saved = await getUser(store, email);
  assert.deepEqual(saved.pw, newPassword);
  assert.equal(saved.v, 2);
  assert.equal(saved.id, account.id);
});

test("a role and name change made while the ID is being saved is kept", async () => {
  const store = memoryStore();
  await seed(store);
  interleaveOnce(store, () => updateUser(store, email, (cur) => ({ ...cur, role: "admin", name: "Renamed Person" })));
  const account = await ensureAccountId(store, await getUser(store, email));
  const saved = await getUser(store, email);
  assert.equal(saved.role, "admin");
  assert.equal(saved.name, "Renamed Person");
  assert.equal(saved.id, account.id);
});

test("an account deleted while the ID is being saved stays deleted", async () => {
  const store = memoryStore();
  await seed(store);
  interleaveOnce(store, () => deleteUser(store, email));
  assert.equal(await ensureAccountId(store, await getUser(store, email)), null);
  assert.equal(await getUser(store, email), null);
  assert.ok(!(await store.smembers("users")).includes(email));
});

test("updating a deleted account does not recreate it", async () => {
  const store = memoryStore();
  await seed(store);
  await deleteUser(store, email);
  assert.equal(await updateUser(store, email, (cur) => ({ ...cur, role: "admin" })), null);
  assert.equal(await getUser(store, email), null);
});

test("a deleted and recreated account gets a new ID, not the old one", async () => {
  const store = memoryStore();
  await seed(store);
  const first = await ensureAccountId(store, await getUser(store, email));
  await deleteUser(store, email);
  await seed(store);
  const second = await ensureAccountId(store, await getUser(store, email));
  assert.notEqual(second.id, first.id);
});
