// Locks the app's content with each person's email and password, and unlocks it in the browser.
// The site is public, so the content is published only in encrypted form (AES-256-GCM). A key made
// from the password (PBKDF2-SHA-256) is needed to read it. The password itself is never published.
// Used by scripts/build.js (to lock) and assets/app.js (to unlock). Works in Node 20+ and browsers.

export const ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const random = (n) => crypto.getRandomValues(new Uint8Array(n));

export const normalizeEmail = (e) => String(e || "").trim().toLowerCase();

// The locked file lists people by a hash of their email, not the email itself.
export async function emailId(email) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("aione-team-control:" + normalizeEmail(email))));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function passwordKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const aes = (raw, use) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, [use]);

// users: [{ email, password }]. Returns the JSON-ready locked file.
export async function seal(html, users, iterations = ITERATIONS) {
  const contentKey = random(32);
  const iv = random(12);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aes(contentKey, "encrypt"), enc.encode(html)));
  const locked = { v: 1, iterations, iv: toB64(iv), data: toB64(data), users: {} };
  for (const u of users) {
    const salt = random(16);
    const wiv = random(12);
    const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: wiv }, await passwordKey(u.password, salt, iterations), contentKey));
    locked.users[await emailId(u.email)] = { salt: toB64(salt), iv: toB64(wiv), key: toB64(wrapped) };
  }
  return locked;
}

// Returns the content key when the email and password are right, otherwise null.
export async function unlockKey(locked, email, password) {
  const entry = locked.users[await emailId(email)];
  if (!entry || !password) return null;
  try {
    const pk = await passwordKey(password, fromB64(entry.salt), locked.iterations);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(entry.iv) }, pk, fromB64(entry.key)));
  } catch {
    return null;
  }
}

// Returns the app's HTML, or null when the key doesn't fit (for example after the content was rebuilt).
export async function openContent(locked, contentKey) {
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(locked.iv) }, await aes(contentKey, "decrypt"), fromB64(locked.data));
    return dec.decode(plain);
  } catch {
    return null;
  }
}
