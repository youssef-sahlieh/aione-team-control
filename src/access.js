// Verifies the Cloudflare Access token on every request.
// Cloudflare Access already blocks anyone who isn't signed in, but checking the token here too
// means the app stays closed even if a route is ever exposed without Access by mistake.

const certCache = { keys: null, fetchedAt: 0, team: "" };

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

export function teamOrigin(teamDomain) {
  let t = String(teamDomain || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(t)) t = "https://" + t;
  return t;
}

async function getKeys(teamDomain, fetchImpl, force) {
  const origin = teamOrigin(teamDomain);
  const fresh = Date.now() - certCache.fetchedAt < 3600 * 1000;
  if (!force && certCache.keys && fresh && certCache.team === origin) return certCache.keys;
  const res = await fetchImpl(origin + "/cdn-cgi/access/certs");
  if (!res.ok) throw new Error("Could not load Cloudflare Access keys (" + res.status + ")");
  const data = await res.json();
  certCache.keys = data.keys || [];
  certCache.fetchedAt = Date.now();
  certCache.team = origin;
  return certCache.keys;
}

export function getToken(request) {
  const h = request.headers.get("Cf-Access-Jwt-Assertion");
  if (h) return h;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Returns { email } when the token is valid and the email is allowed; otherwise throws with a reason.
export async function verifyAccess(request, env, fetchImpl = fetch) {
  const token = getToken(request);
  if (!token) throw new Error("no_token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("bad_token");
  const header = b64urlToJson(parts[0]);
  const payload = b64urlToJson(parts[1]);
  if (header.alg !== "RS256") throw new Error("bad_alg");

  let keys = await getKeys(env.TEAM_DOMAIN, fetchImpl, false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await getKeys(env.TEAM_DOMAIN, fetchImpl, true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error("unknown_key");

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new Error("bad_signature");

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now - 30) throw new Error("expired");
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) throw new Error("not_yet_valid");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!env.POLICY_AUD || !aud.includes(env.POLICY_AUD)) throw new Error("wrong_audience");
  if (payload.iss && teamOrigin(payload.iss) !== teamOrigin(env.TEAM_DOMAIN)) throw new Error("wrong_issuer");

  const email = String(payload.email || "").toLowerCase();
  const allowed = String(env.ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!email || !allowed.includes(email)) throw new Error("not_allowed");
  return { email, expires: payload.exp };
}
