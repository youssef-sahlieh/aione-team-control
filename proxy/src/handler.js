// AION Team Control proxy. Runs on Vercel (see api/proxy.js); the code itself only uses standard web APIs.
// The dashboard on GitHub Pages can't call Jira itself: Jira blocks browser calls from other sites,
// and the Jira token must stay secret. This Worker checks the team sign-in, then forwards a fixed
// set of Jira actions for the one project in JIRA_PROJECT.
//
// It also sends the dashboard's emails (internal notes, new-assignment emails) through Microsoft Graph,
// from the signed-in person's own mailbox, to @MAIL_DOMAIN addresses only.
//
// Secrets: TEAM_PASSWORD, SESSION_SECRET, TEAM_CONFIG (JSON), JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN,
//          and optionally MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET (without them, email is off).
// Settings: ALLOWED_ORIGIN, TEAM_EMAILS, JIRA_PROJECT, MAIL_DOMAIN (see settings.js).
// Optional: LOGIN_LIMIT, a rate limiter with limit({ key }) -> { success }; otherwise a simple in-memory one.

const enc = new TextEncoder();
const SESSION_MS = 12 * 3600 * 1000;
const EDITABLE = new Set(["labels", "duedate", "assignee"]);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const fail = (code, error, status) => json({ code, error }, status);

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin");
  const h = { Vary: "Origin" };
  if (origin && origin === env.ALLOWED_ORIGIN) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    h["Access-Control-Allow-Methods"] = "GET, POST, PUT, OPTIONS";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Compares two strings in constant time (by hashing both first, so the length doesn't leak either).
async function sameSecret(a, b) {
  const [ha, hb] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s))))));
  return sameBytes(ha, hb);
}

// At most 10 sign-in attempts per minute from one address. Kept in memory, so it applies per running
// instance of the proxy; it slows guessing down rather than stopping a determined attacker.
const attempts = new Map();
const memoryLimit = {
  async limit({ key }) {
    const now = Date.now();
    const a = attempts.get(key);
    if (!a || a.reset < now) { attempts.set(key, { count: 1, reset: now + 60000 }); if (attempts.size > 5000) attempts.clear(); return { success: true }; }
    a.count++;
    return { success: a.count <= 10 };
  }
};

const teamEmails = (env) => String(env.TEAM_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

export async function makeToken(env, email, now = Date.now()) {
  const body = b64url(enc.encode(JSON.stringify({ email, exp: now + SESSION_MS })));
  return { token: body + "." + b64url(await hmac(env.SESSION_SECRET, body)), expiresAt: now + SESSION_MS };
}

// Returns the signed-in email, or null when the token is missing, forged, expired or no longer allowed.
export async function readToken(env, header, now = Date.now()) {
  const m = /^Bearer ([\w-]+)\.([\w-]+)$/.exec(header || "");
  if (!m) return null;
  try {
    if (!sameBytes(fromB64url(m[2]), await hmac(env.SESSION_SECRET, m[1]))) return null;
    const { email, exp } = JSON.parse(new TextDecoder().decode(fromB64url(m[1])));
    if (typeof exp !== "number" || exp < now || !teamEmails(env).includes(email)) return null;
    return email;
  } catch {
    return null;
  }
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

// Calls Jira with the proxy's own credentials and passes the answer (or a readable error) back.
async function jira(env, path, init = {}) {
  const res = await fetch(env.JIRA_SITE + path, {
    method: init.method || "GET",
    headers: {
      Authorization: "Basic " + btoa(env.JIRA_EMAIL + ":" + env.JIRA_API_TOKEN),
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {})
    },
    body: init.body ? JSON.stringify(init.body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (res.ok) return { ok: true, data: data ?? { ok: true } };
  const detail = data && ([].concat(data.errorMessages || [], Object.values(data.errors || {})).join(" ") || data.message);
  if (res.status === 429) return { ok: false, res: fail("rate_limited", "Jira is busy.", 429) };
  if (res.status === 401) return { ok: false, res: fail("jira", "Jira didn't accept the proxy's API token. Check JIRA_EMAIL and JIRA_API_TOKEN.", 502) };
  return { ok: false, res: fail("jira", detail || "Jira answered " + res.status + ".", res.status >= 500 ? 502 : res.status) };
}
const pass = (r) => (r.ok ? json(r.data) : r.res);

const mailEnabled = (env) => !!(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET);

// Microsoft Graph app token (client credentials), reused until shortly before it expires.
let graphToken = { value: "", until: 0, tenant: "" };
async function getGraphToken(env) {
  if (graphToken.value && graphToken.tenant === env.MS_TENANT_ID && Date.now() < graphToken.until) return graphToken.value;
  const res = await fetch("https://login.microsoftonline.com/" + encodeURIComponent(env.MS_TENANT_ID) + "/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, scope: "https://graph.microsoft.com/.default" }).toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) return null;
  graphToken = { value: data.access_token, until: Date.now() + (Number(data.expires_in || 3600) - 300) * 1000, tenant: env.MS_TENANT_ID };
  return graphToken.value;
}

async function sendMail(env, from, b) {
  if (!mailEnabled(env)) return fail("mail_off", "Email sending isn't set up.", 501);
  const domain = "@" + String(env.MAIL_DOMAIN || "").toLowerCase();
  const to = Array.isArray(b && b.to) ? [...new Set(b.to.map((x) => String(x).trim()))] : [];
  if (!to.length || to.length > 20 || !to.every((x) => /^[^@\s]+@[^@\s]+$/.test(x) && x.toLowerCase().endsWith(domain))) return fail("bad_request", "Emails can only go to " + domain + " addresses.", 400);
  const subject = typeof b.subject === "string" ? b.subject.trim().slice(0, 250) : "";
  const html = typeof b.html === "string" ? b.html : "";
  if (!subject || !html || html.length > 100000) return fail("bad_request", "The email needs a subject and text.", 400);
  const token = await getGraphToken(env);
  if (!token) return fail("mail", "Microsoft didn't accept the proxy's app details. Check MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET.", 502);
  const res = await fetch("https://graph.microsoft.com/v1.0/users/" + encodeURIComponent(from) + "/sendMail", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { subject, body: { contentType: "HTML", content: html }, toRecipients: to.map((address) => ({ emailAddress: { address } })) }, saveToSentItems: true })
  });
  if (res.ok) return json({ ok: true, to });
  const data = await res.json().catch(() => ({}));
  const detail = data && data.error && data.error.message;
  return fail("mail", res.status === 403 ? "Microsoft refused to send from " + from + ". Check the app's Mail.Send permission and admin consent." : detail || "Outlook answered " + res.status + ".", 502);
}

function validFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return false;
  const keys = Object.keys(fields);
  if (!keys.length || !keys.every((k) => EDITABLE.has(k))) return false;
  if ("labels" in fields && !(Array.isArray(fields.labels) && fields.labels.length <= 50 && fields.labels.every((l) => typeof l === "string" && /^\S{1,255}$/.test(l)))) return false;
  if ("duedate" in fields && !(fields.duedate === null || /^\d{4}-\d{2}-\d{2}$/.test(fields.duedate))) return false;
  if ("assignee" in fields && !(fields.assignee === null || (fields.assignee && typeof fields.assignee.accountId === "string" && Object.keys(fields.assignee).length === 1))) return false;
  return true;
}

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/login" && method === "POST") {
    const ip = request.headers.get("x-real-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    const { success } = await (env.LOGIN_LIMIT || memoryLimit).limit({ key: ip });
    if (!success) return fail("rate_limited", "Too many sign-in attempts. Wait a minute and try again.", 429);
    const body = await readJson(request);
    const email = String((body && body.email) || "").trim().toLowerCase();
    const passwordOk = await sameSecret((body && body.password) || "", env.TEAM_PASSWORD || "");
    if (!env.TEAM_PASSWORD || !passwordOk || !teamEmails(env).includes(email)) return fail("login", "That email and password don't match.", 401);
    return json({ email, ...(await makeToken(env, email)) });
  }

  const email = await readToken(env, request.headers.get("Authorization"));
  if (!email) return fail("session", "Please sign in again.", 401);

  const P = env.JIRA_PROJECT;
  const isOurKey = (k) => new RegExp("^" + P + "-\\d+$").test(k);

  if (path === "/config" && method === "GET") {
    let team = {};
    try { team = JSON.parse(env.TEAM_CONFIG || "{}"); } catch {}
    return json({ ...team, site: env.JIRA_SITE, project: P, email, mail: mailEnabled(env) });
  }

  if (path === "/mail" && method === "POST") return sendMail(env, email, await readJson(request));

  if (path === "/jira/search" && method === "POST") {
    const b = await readJson(request);
    if (!b || typeof b.jql !== "string" || b.jql.length > 2000 || !Array.isArray(b.fields) || b.fields.length > 30 || !b.fields.every((f) => typeof f === "string")) return fail("bad_request", "Bad search.", 400);
    const r = await jira(env, "/rest/api/3/search/jql", {
      method: "POST",
      body: { jql: b.jql, fields: b.fields, maxResults: Math.min(Number(b.maxResults) || 100, 100), expand: "renderedFields", ...(typeof b.nextPageToken === "string" ? { nextPageToken: b.nextPageToken } : {}) }
    });
    if (!r.ok) return r.res;
    // Only this project's tickets ever leave the proxy, whatever the search asked for.
    return json({ ...r.data, issues: (r.data.issues || []).filter((i) => isOurKey(i.key)) });
  }

  if (path === "/jira/users" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (q.length < 2 || q.length > 100) return fail("bad_request", "Type at least 2 letters.", 400);
    return pass(await jira(env, "/rest/api/3/user/search?maxResults=8&query=" + encodeURIComponent(q)));
  }

  const m = /^\/jira\/issue\/([A-Z][A-Z0-9_]*-\d+)(\/changelog|\/transitions|\/comment)?$/.exec(path);
  if (m && isOurKey(m[1])) {
    const key = m[1], sub = m[2] || "";
    if (sub === "" && method === "PUT") {
      const b = await readJson(request);
      if (!b || !validFields(b.fields)) return fail("bad_request", "Only labels, due date and assignee can be changed.", 400);
      return pass(await jira(env, "/rest/api/3/issue/" + key, { method: "PUT", body: { fields: b.fields } }));
    }
    if (sub === "/changelog" && method === "GET") return pass(await jira(env, "/rest/api/3/issue/" + key + "?fields=duedate&expand=changelog"));
    if (sub === "/transitions" && method === "GET") return pass(await jira(env, "/rest/api/3/issue/" + key + "/transitions"));
    if (sub === "/transitions" && method === "POST") {
      const b = await readJson(request);
      if (!b || !/^\d+$/.test(String(b.id))) return fail("bad_request", "Bad status move.", 400);
      return pass(await jira(env, "/rest/api/3/issue/" + key + "/transitions", { method: "POST", body: { transition: { id: String(b.id) } } }));
    }
    if (sub === "/comment" && method === "POST") {
      const b = await readJson(request);
      const text = b && typeof b.text === "string" ? b.text.trim() : "";
      if (!text || text.length > 30000) return fail("bad_request", "Write a comment first.", 400);
      return pass(await jira(env, "/rest/api/2/issue/" + key + "/comment", { method: "POST", body: { body: text } }));
    }
  }

  return fail("not_found", "Not found.", 404);
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await route(request, env, new URL(request.url));
    } catch (err) {
      console.log("proxy error:", err && err.message);
      res = fail("server", "The proxy hit an error.", 500);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }
};
