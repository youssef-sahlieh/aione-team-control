// Single sign-on for AI1 Monitor. A signed-in dashboard person gets a short-lived token (a JSON Web Token
// signed with Ed25519) that says who they are, their role and their developer label. AI1 Monitor checks the
// token with the public key from /sso/monitor/keys. The private key (MONITOR_SIGNING_KEY, a JSON Web Key)
// stays in Vercel, so AI1 Monitor can check tokens but never make them.

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jsonPart = (value) => b64url(enc.encode(JSON.stringify(value)));
const b64urlBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const b64urlJson = (s) => JSON.parse(dec.decode(b64urlBytes(s)));

export const MONITOR_ISSUER = "aione-team-control";
export const MONITOR_AUDIENCE = "ai1-monitor";
export const MONITOR_TOKEN_SECONDS = 60;
// Tokens are allowed to be a little ahead of this server's clock (AI1 Monitor's clock may differ slightly).
const CLOCK_SKEW_SECONDS = 60;

// The key pair as stored in Vercel. Throws when the setting is missing or isn't an Ed25519 private key.
function signingKey(env) {
  const jwk = JSON.parse(env.MONITOR_SIGNING_KEY || "null");
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d) throw new Error("MONITOR_SIGNING_KEY must be an Ed25519 private key (JWK).");
  return jwk;
}

// The DER prefix that wraps a raw Ed25519 public key (32 bytes) as a SubjectPublicKeyInfo.
const ED25519_SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

// The same public key as a PEM block, so AI1 Monitor's existing PEM key loader can use it as is.
function publicPem(x) {
  const der = new Uint8Array(ED25519_SPKI_PREFIX.length + 32);
  der.set(ED25519_SPKI_PREFIX);
  der.set(b64urlBytes(x), ED25519_SPKI_PREFIX.length);
  const base64 = btoa(String.fromCharCode(...der)).match(/.{1,64}/g).join("\n");
  return "-----BEGIN PUBLIC KEY-----\n" + base64 + "\n-----END PUBLIC KEY-----\n";
}

// The public half only, for AI1 Monitor to check tokens with.
export function monitorPublicKeys(env) {
  const jwk = signingKey(env);
  return { keys: [{ kty: jwk.kty, crv: jwk.crv, x: jwk.x, use: "sig", alg: "EdDSA", kid: jwk.kid || "ai1-monitor-1", pem: publicPem(jwk.x) }] };
}

// A token for the signed-in person (me comes from readToken in handler.js).
export async function monitorToken(env, me, now = Date.now()) {
  const jwk = signingKey(env);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  const iat = Math.floor(now / 1000), exp = iat + MONITOR_TOKEN_SECONDS;
  const head = jsonPart({ alg: "EdDSA", typ: "JWT", kid: jwk.kid || "ai1-monitor-1" });
  const body = jsonPart({
    iss: MONITOR_ISSUER, aud: MONITOR_AUDIENCE, sub: me.email, email: me.email, name: me.name || me.email,
    role: me.role, dev: me.dev || "", iat, exp, jti: b64url(crypto.getRandomValues(new Uint8Array(12)))
  });
  const sig = await crypto.subtle.sign("Ed25519", key, enc.encode(head + "." + body));
  return { token: head + "." + body + "." + b64url(sig), expiresAt: exp * 1000 };
}

// The check AI1 Monitor has to make on every token (this is the contract its side implements). Returns the claims
// when the token is valid, throws otherwise. jti replay protection is not here: AI1 Monitor must remember jti values.
export async function checkMonitorToken(token, publicKeys, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("token_malformed");
  const [head, body, sig] = parts;
  const header = b64urlJson(head);
  if (header.alg !== "EdDSA") throw new Error("token_alg");
  const jwk = (publicKeys?.keys || []).find(k => k.kid === header.kid && k.alg === "EdDSA" && k.crv === "Ed25519");
  if (!jwk) throw new Error("token_unknown_key");
  const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("Ed25519", key, b64urlBytes(sig), enc.encode(head + "." + body)))) throw new Error("token_signature");
  const claims = b64urlJson(body);
  if (claims.iss !== MONITOR_ISSUER || claims.aud !== MONITOR_AUDIENCE) throw new Error("token_audience");
  const t = Math.floor(now / 1000);
  if (!(claims.exp > t) || claims.exp - claims.iat > MONITOR_TOKEN_SECONDS || claims.iat > t + CLOCK_SKEW_SECONDS) throw new Error("token_expired");
  if (!claims.email || !claims.jti) throw new Error("token_claims");
  return claims;
}
