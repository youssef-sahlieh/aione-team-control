// Sign in with Microsoft (Microsoft Entra ID, OpenID Connect, authorization code with PKCE).
// The browser goes to Microsoft and comes back to the proxy with a code. The proxy checks the sign-in itself:
// the one-time state, the PKCE verifier, the nonce, and the token's signature, issuer, audience and tenant.
// It then matches the email to an existing dashboard account (nobody is created by signing in) and hands
// the dashboard a single-use code, which the dashboard trades for its normal session token.

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SignInError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Settings: MS_SIGNIN_TENANT (the directory's ID), MS_SIGNIN_CLIENT_ID, MS_SIGNIN_CLIENT_SECRET, and
// MS_SIGNIN_REDIRECT (the proxy's callback address, which must be listed in the app registration).
export const microsoftSignInConfigured = (env) =>
  !!(env.STORE && GUID.test(String(env.MS_SIGNIN_TENANT || "")) && env.MS_SIGNIN_CLIENT_ID && env.MS_SIGNIN_CLIENT_SECRET && env.MS_SIGNIN_REDIRECT);

const authority = (env) => "https://login.microsoftonline.com/" + env.MS_SIGNIN_TENANT;

// Where the dashboard may send the person afterwards: only the dashboard's own addresses (ALLOWED_ORIGIN).
export function dashboardReturn(env, value) {
  let u;
  try { u = new URL(String(value || "")); } catch { return null; }
  const allowed = String(env.ALLOWED_ORIGIN || "").split(",").map((o) => o.trim()).filter(Boolean);
  if (!allowed.includes(u.origin)) return null;
  return u.origin + u.pathname;
}

// Step 1: the address to send the browser to.
export async function startSignIn(env, returnUrl) {
  const state = random(), nonce = random(), verifier = random(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  await env.STORE.set("msso:" + state, JSON.stringify({ nonce, verifier, returnUrl }), 600);
  const query = new URLSearchParams({
    client_id: env.MS_SIGNIN_CLIENT_ID, response_type: "code", redirect_uri: env.MS_SIGNIN_REDIRECT, response_mode: "query",
    scope: "openid email profile", state, nonce, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account"
  });
  return authority(env) + "/oauth2/v2.0/authorize?" + query.toString();
}

// Checks the ID token: signed by Microsoft's key for this tenant, issued for this app, for this sign-in.
async function verifyIdToken(env, idToken, nonce) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new SignInError("token", "Microsoft sent a sign-in that could not be read.");
  const header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  if (header.alg !== "RS256" || !header.kid) throw new SignInError("token", "Microsoft sent a sign-in with an unexpected signature.");

  const keysRes = await fetch(authority(env) + "/discovery/v2.0/keys", { signal: AbortSignal.timeout(10000) });
  const jwk = keysRes.ok ? ((await keysRes.json()).keys || []).find((k) => k.kid === header.kid) : null;
  if (!jwk) throw new SignInError("token", "Microsoft's signing key was not found. Try again.");
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!valid) throw new SignInError("token", "Microsoft's signature didn't check out.");

  const now = Math.floor(Date.now() / 1000);
  const tenant = String(claims.tid || "").toLowerCase();
  if (tenant !== env.MS_SIGNIN_TENANT.toLowerCase() || claims.iss !== "https://login.microsoftonline.com/" + tenant + "/v2.0")
    throw new SignInError("tenant", "This Microsoft account isn't in the AION directory.");
  if (claims.aud !== env.MS_SIGNIN_CLIENT_ID) throw new SignInError("token", "Microsoft sent a sign-in for another app.");
  if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new SignInError("token", "The sign-in has expired. Try again.");
  if (claims.nbf && claims.nbf > now + 60) throw new SignInError("token", "The sign-in isn't valid yet. Try again.");
  if (claims.nonce !== nonce) throw new SignInError("token", "The sign-in didn't match this request. Try again.");
  return claims;
}

// Step 2: Microsoft sent the person back with ?code&state. Returns the email and where to send them.
export async function finishSignIn(env, code, state) {
  const saved = typeof state === "string" && /^[\w-]{20,100}$/.test(state) ? JSON.parse((await env.STORE.getdel("msso:" + state)) || "null") : null;
  if (!saved) throw new SignInError("state", "The sign-in expired or was already used. Try again.");
  if (typeof code !== "string" || !code) throw new SignInError("token", "Microsoft didn't return a code.");
  const res = await fetch(authority(env) + "/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.MS_SIGNIN_CLIENT_ID, client_secret: env.MS_SIGNIN_CLIENT_SECRET, grant_type: "authorization_code",
      code, redirect_uri: env.MS_SIGNIN_REDIRECT, code_verifier: saved.verifier
    }).toString(),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) throw new SignInError("token", "Microsoft didn't accept the sign-in. Try again.");
  const claims = await verifyIdToken(env, data.id_token, saved.nonce);
  const email = String(claims.preferred_username || claims.email || "").trim().toLowerCase();
  if (!email) throw new SignInError("token", "Microsoft didn't say which email signed in.");
  return { email, returnUrl: saved.returnUrl };
}
