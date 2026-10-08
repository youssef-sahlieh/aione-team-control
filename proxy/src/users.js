// User accounts: password hashing, the user records in the store, and one-time links
// (password reset and "set your password" invitations).
//
// The store is a small key-value database (Upstash Redis on Vercel; an in-memory one in tests) with:
//   get(key) -> string|null, set(key, value, ttlSeconds?), del(key), incr(key, ttlSeconds) -> number,
//   smembers(key) -> string[], sadd(key, member), srem(key, member).
// Keys: "u:<email>" user record (JSON), "users" set of emails, "rt:<sha256 of link token>" one-time link.

const enc = new TextEncoder();
export const ITERATIONS = 210000;
export const ROLES = ["admin", "user"];

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const normEmail = (e) => String(e || "").trim().toLowerCase();
export const validEmail = (e) => /^[^@\s"'<>]+@[^@\s"'<>]+\.[^@\s"'<>]+$/.test(e) && e.length <= 200;
// Developer names are the part after "ai1_" in Jira labels, e.g. "bashar.k".
export const normDev = (d) => String(d || "").trim().replace(/^ai1_/i, "").toLowerCase();
export const validDev = (d) => /^[a-z0-9._-]{1,40}$/.test(d);

export function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "Use at most 200 characters.";
  return "";
}

export async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return { salt: b64(salt), hash: b64(bits), iterations };
}

export async function checkPassword(password, pw) {
  if (!pw || !pw.salt || !pw.hash) return false;
  const h = await hashPassword(String(password || ""), fromB64(pw.salt), pw.iterations);
  const a = fromB64(h.hash), b = fromB64(pw.hash);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function getUser(store, email) {
  const raw = await store.get("u:" + normEmail(email));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export async function saveUser(store, user) {
  await store.set("u:" + user.email, JSON.stringify(user));
  await store.sadd("users", user.email);
}

export async function deleteUser(store, email) {
  await store.del("u:" + normEmail(email));
  await store.srem("users", normEmail(email));
}

export async function listUsers(store) {
  const emails = (await store.smembers("users")) || [];
  const users = await Promise.all(emails.map((e) => getUser(store, e)));
  return users.filter(Boolean).sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "admin" ? -1 : 1));
}

// What the dashboard may see about a user (never the password hash).
export const publicUser = (u) => ({ email: u.email, name: u.name, role: u.role, dev: u.dev || "", hasPassword: !!u.pw, createdAt: u.createdAt });

async function sha256hex(s) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(h, (x) => x.toString(16).padStart(2, "0")).join("");
}

// One-time link token. Only its hash is stored, so a copy of the database can't be used to reset passwords.
export async function createLinkToken(store, email, purpose, ttlSeconds) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await store.set("rt:" + (await sha256hex(token)), JSON.stringify({ email: normEmail(email), purpose }), ttlSeconds);
  return token;
}

// Returns { email, purpose } and deletes the token, or null when it's unknown, used or expired.
export async function useLinkToken(store, token) {
  if (typeof token !== "string" || !/^[\w-]{20,100}$/.test(token)) return null;
  const key = "rt:" + (await sha256hex(token));
  const raw = await store.get(key);
  if (!raw) return null;
  await store.del(key);
  try { return JSON.parse(raw); } catch { return null; }
}

export async function peekLinkToken(store, token) {
  if (typeof token !== "string" || !/^[\w-]{20,100}$/.test(token)) return null;
  const raw = await store.get("rt:" + (await sha256hex(token)));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

// In-memory store with the same interface, for tests and local runs.
export function memoryStore() {
  const data = new Map(), sets = new Map(), expires = new Map();
  const alive = (k) => { const t = expires.get(k); if (t && t < Date.now()) { data.delete(k); expires.delete(k); } return data.has(k); };
  return {
    async get(k) { return alive(k) ? data.get(k) : null; },
    async set(k, v, ttl) { data.set(k, String(v)); if (ttl) expires.set(k, Date.now() + ttl * 1000); else expires.delete(k); },
    async del(k) { data.delete(k); expires.delete(k); },
    async incr(k, ttl) { const n = (alive(k) ? Number(data.get(k)) : 0) + 1; data.set(k, String(n)); if (n === 1 && ttl) expires.set(k, Date.now() + ttl * 1000); return n; },
    async smembers(k) { return [...(sets.get(k) || [])]; },
    async sadd(k, m) { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k).add(m); },
    async srem(k, m) { if (sets.has(k)) sets.get(k).delete(m); },
    _data: data
  };
}

// Upstash Redis over its REST API (what Vercel's "Upstash for Redis" storage provides).
export function redisStore(url, token) {
  const cmd = async (...args) => {
    const res = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error("database error: " + (data.error || res.status));
    return data.result;
  };
  return {
    get: (k) => cmd("GET", k),
    set: (k, v, ttl) => (ttl ? cmd("SET", k, String(v), "EX", String(ttl)) : cmd("SET", k, String(v))),
    del: (k) => cmd("DEL", k),
    async incr(k, ttl) { const n = await cmd("INCR", k); if (n === 1 && ttl) await cmd("EXPIRE", k, String(ttl)); return n; },
    smembers: (k) => cmd("SMEMBERS", k),
    sadd: (k, m) => cmd("SADD", k, m),
    srem: (k, m) => cmd("SREM", k, m)
  };
}
