import { createLinkToken, getUser, peekLinkToken, updateUser, useLinkToken } from "./users.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const SETUP_SECONDS = 10 * 60;
const LOGIN_SECONDS = 5 * 60;

const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = value => Uint8Array.from(atob(String(value || "")), character => character.charCodeAt(0));
const hex = bytes => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");

function base32(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function fromBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, accumulator = 0;
  const output = [];
  for (const character of String(value || "").replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("mfa_secret_invalid");
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(output);
}

async function encryptionKey(env) {
  const material = String(env.MFA_ENCRYPTION_KEY || "");
  if (material.length < 32) throw new Error("mfa_encryption_not_configured");
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(material));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptSecret(env, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), enc.encode(secret));
  return `v1.${b64(iv)}.${b64(ciphertext)}`;
}

async function decryptSecret(env, value) {
  const [version, iv, ciphertext] = String(value || "").split(".");
  if (version !== "v1" || !iv || !ciphertext) throw new Error("mfa_secret_invalid");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(iv) },
    await encryptionKey(env),
    fromB64(ciphertext),
  );
  return dec.decode(plaintext);
}

async function sha256(value) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(String(value))));
}

async function hotp(secret, counter) {
  const message = new Uint8Array(8);
  let remaining = BigInt(counter);
  for (let index = 7; index >= 0; index--) {
    message[index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  const key = await crypto.subtle.importKey("raw", fromBase32(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = digest[digest.length - 1] & 15;
  const number = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(number % 1_000_000).padStart(6, "0");
}

async function matchingCounter(secret, code, lastCounter = -1, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30_000);
  for (let counter = current - 1; counter <= current + 1; counter++) {
    if (counter > Number(lastCounter ?? -1) && await hotp(secret, counter) === code) return counter;
  }
  return null;
}

export function mfaEnabled(user) {
  return Boolean(user?.mfa?.secret && user.mfa.verifiedAt);
}

export function mfaPolicy(env) {
  const value = String(env.TEAM_MFA_POLICY || "optional").trim().toLowerCase();
  return ["optional", "enroll", "enforce"].includes(value) ? value : "optional";
}

export function mfaSessionAssured(env, identity, now = Date.now()) {
  const methods = Array.isArray(identity?.amr) ? identity.amr : [];
  if (!methods.some(value => ["otp", "recovery", "webauthn", "passkey", "hwk"].includes(value))) return false;
  const authenticatedAt = Number(identity?.auth_time || 0) * 1000;
  const configured = Number.parseInt(String(env.TEAM_MFA_MAX_AGE_SECONDS || "43200"), 10);
  const maxAge = Math.min(Math.max(Number.isFinite(configured) ? configured : 43200, 300), 86400) * 1000;
  return authenticatedAt > 0 && authenticatedAt <= now + 60_000 && now - authenticatedAt <= maxAge;
}

export function mfaRequired(user) {
  return user?.role === "admin";
}

export function publicMfaStatus(env, user) {
  const enabled = mfaEnabled(user);
  const required = mfaRequired(user);
  return {
    enabled,
    required,
    policy: mfaPolicy(env),
    compliant: !required || enabled,
    verifiedAt: enabled ? user.mfa.verifiedAt : null,
    recoveryCodesRemaining: enabled ? (user.mfa.recoveryHashes || []).length : 0,
  };
}

export async function beginMfaSetup(env, store, user) {
  await encryptionKey(env);
  const secret = base32(crypto.getRandomValues(new Uint8Array(20)));
  const encrypted = await encryptSecret(env, secret);
  const token = await createLinkToken(store, user.email, "mfa-setup", SETUP_SECONDS, {
    accountId: user.id,
    encrypted,
  });
  const label = encodeURIComponent(`AIONE Team Control:${user.email}`);
  const query = new URLSearchParams({ secret, issuer: "AIONE Team Control", digits: "6", period: "30" });
  return { token, secret, otpauthUri: `otpauth://totp/${label}?${query}`, expiresIn: SETUP_SECONDS };
}

export async function completeMfaSetup(env, store, user, token, code, now = Date.now()) {
  const pending = await peekLinkToken(store, token);
  if (!pending || pending.purpose !== "mfa-setup" || pending.email !== user.email || pending.accountId !== user.id) return null;
  const normalized = String(code || "").replace(/[\s-]+/g, "");
  const secret = await decryptSecret(env, pending.encrypted);
  const counter = await matchingCounter(secret, normalized, -1, now);
  if (counter === null) return null;
  const consumed = await useLinkToken(store, token);
  if (!consumed || consumed.purpose !== "mfa-setup" || consumed.accountId !== user.id) return null;
  const recoveryCodes = Array.from({ length: 10 }, () => hex(crypto.getRandomValues(new Uint8Array(5))).toUpperCase());
  const recoveryHashes = await Promise.all(recoveryCodes.map(sha256));
  const verifiedAt = new Date(now).toISOString();
  const saved = await updateUser(store, user.email, current => ({
    ...current,
    mfa: {
      secret: pending.encrypted,
      verifiedAt,
      lastCounter: counter,
      recoveryHashes,
    },
  }));
  return saved ? { recoveryCodes, verifiedAt } : null;
}

export async function beginMfaLogin(store, user) {
  return createLinkToken(store, user.email, "mfa-login", LOGIN_SECONDS, { accountId: user.id });
}

class InvalidMfaCode extends Error {}

export async function verifyMfaCode(env, store, user, code, now = Date.now()) {
  if (!mfaEnabled(user)) return null;
  const normalized = String(code || "").replace(/[\s-]+/g, "").toUpperCase();
  const secret = await decryptSecret(env, user.mfa.secret);
  const counter = await matchingCounter(secret, normalized, user.mfa.lastCounter, now);
  const recoveryHash = await sha256(normalized);
  let acceptedMethod = null;
  try {
    const saved = await updateUser(store, user.email, current => {
      if (!mfaEnabled(current)) throw new InvalidMfaCode();
      const currentMfa = current.mfa;
      let recoveryHashes = [...(currentMfa.recoveryHashes || [])];
      let lastCounter = Number(currentMfa.lastCounter ?? -1);
      if (counter !== null && counter > lastCounter) {
        lastCounter = counter;
        acceptedMethod = "otp";
      } else {
        const index = recoveryHashes.indexOf(recoveryHash);
        if (index < 0) throw new InvalidMfaCode();
        recoveryHashes.splice(index, 1);
        acceptedMethod = "recovery";
      }
      return { ...current, mfa: { ...currentMfa, lastCounter, recoveryHashes, lastUsedAt: new Date(now).toISOString() } };
    });
    return saved ? acceptedMethod : null;
  } catch (error) {
    if (error instanceof InvalidMfaCode) return null;
    throw error;
  }
}

export async function completeMfaLogin(env, store, token, code, now = Date.now()) {
  const pending = await peekLinkToken(store, token);
  const user = pending?.purpose === "mfa-login" ? await getUser(store, pending.email) : null;
  if (!user || pending.accountId !== user.id) return null;
  const method = await verifyMfaCode(env, store, user, code, now);
  if (!method) return null;
  const consumed = await useLinkToken(store, token);
  const saved = consumed?.purpose === "mfa-login" && consumed.accountId === user.id ? await getUser(store, user.email) : null;
  return saved ? { user: saved, method } : null;
}

export async function disableMfa(env, store, user, code, now = Date.now()) {
  if (!await verifyMfaCode(env, store, user, code, now)) return false;
  return Boolean(await updateUser(store, user.email, current => {
    const { mfa, ...rest } = current;
    return { ...rest, v: (current.v || 0) + 1 };
  }));
}

export const _test = { hotp, matchingCounter, encryptSecret, decryptSecret };
