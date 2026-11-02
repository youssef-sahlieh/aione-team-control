// Odoo knowledge base password: only admins set it, it is stored hashed, wrong guesses are counted and paused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../proxy/src/users.js';
import { setKnowledgePassword, unlockKnowledge, knowledgeStatus } from '../proxy/src/knowledge-lock.js';

const admin = { email: 'admin@example.invalid', name: 'Admin', role: 'admin' };
const user = { email: 'user@example.invalid', name: 'Developer', role: 'user' };
const setup = () => ({ STORE: memoryStore(), ODOO_URL: 'https://odoo.example.invalid/', ODOO_DB: 'db', ODOO_LOGIN: 'bot', ODOO_API_KEY: 'key' });
const code = (status, errorCode) => e => e.status === status && e.code === errorCode;

test('only administrators set the knowledge base password, and it must be a usable length', async () => {
  const env = setup();
  await assert.rejects(setKnowledgePassword(env, user, 'long-enough-1'), code(403, 'forbidden'));
  await assert.rejects(setKnowledgePassword(env, admin, 'short'), code(400, 'weak_password'));
  assert.equal((await knowledgeStatus(env, user)).configured, false);
  await setKnowledgePassword(env, admin, 'long-enough-1');
  assert.equal((await knowledgeStatus(env, user)).configured, true);
  assert.equal((await knowledgeStatus(env, user)).canSetPassword, false);
});

test('the password is stored only as a hash and the Odoo link comes back only with the right one', async () => {
  const env = setup();
  await setKnowledgePassword(env, admin, 'long-enough-1');
  const raw = await env.STORE.get('knowledge:lock:v1');
  assert.ok(!raw.includes('long-enough-1'));
  await assert.rejects(unlockKnowledge(env, 'wrong-password'), code(403, 'wrong_password'));
  assert.deepEqual(await unlockKnowledge(env, 'long-enough-1'), { url: 'https://odoo.example.invalid/odoo/knowledge' });
});

test('unlocking before a password is set says so, and no link is returned', async () => {
  await assert.rejects(unlockKnowledge(setup(), 'anything-long'), code(409, 'not_configured'));
});

test('five wrong passwords pause attempts, even the right one; a right one before that clears the count', async () => {
  const env = setup();
  await setKnowledgePassword(env, admin, 'long-enough-1');
  for (let i = 0; i < 4; i++) await assert.rejects(unlockKnowledge(env, 'nope-nope-nope'), code(403, 'wrong_password'));
  assert.ok(await unlockKnowledge(env, 'long-enough-1'));
  for (let i = 0; i < 5; i++) await assert.rejects(unlockKnowledge(env, 'nope-nope-nope'), e => e.status === 403 || e.status === 429);
  await assert.rejects(unlockKnowledge(env, 'long-enough-1'), code(429, 'locked_out'));
});
