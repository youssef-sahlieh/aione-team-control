// AION Team Control proxy. Runs on Vercel (see api/proxy.js); the code itself only uses standard web APIs.
// The dashboard on GitHub Pages can't call Jira itself: Jira blocks browser calls from other sites,
// and the Jira token must stay secret. This proxy checks the team sign-in, then forwards a fixed
// set of Jira actions for the one project in JIRA_PROJECT.
//
// It also sends the dashboard's emails (internal notes, new-assignment emails), to @MAIL_DOMAIN
// addresses only, either through env.MAILER (a function the host provides, e.g. Gmail; replies go to
// the signed-in person) or through Microsoft Graph from the signed-in person's own mailbox.
//
// Secrets: TEAM_PASSWORD, SESSION_SECRET, TEAM_CONFIG (JSON), JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN,
//          and optionally MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET.
// Settings: ALLOWED_ORIGIN, TEAM_EMAILS, JIRA_PROJECT, MAIL_DOMAIN (see settings.js).
// Optional: LOGIN_LIMIT, a rate limiter with limit({ key }) -> { success }; otherwise a simple in-memory one.
// Optional: MAILER, async ({ fromName, replyTo, to, subject, html }) => void. Without it or MS_*, email is off.
// Optional: STORE, the user database (see users.js). With it, everyone has their own account and role
//   (admin: everything; user: only the tickets labelled with their developer name). Without it, the
//   emails in TEAM_EMAILS sign in with TEAM_PASSWORD as admins. The first sign-in with TEAM_PASSWORD
//   after the database is added creates admin accounts for everyone in TEAM_EMAILS.
import { ROLES, checkPassword, createLinkToken, deleteUser, getUser, hashPassword, listUsers, normDev, normEmail, passwordProblem, peekLinkToken, publicUser, saveUser, useLinkToken, validDev, validEmail } from "./users.js";

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
    h["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
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

// Sessions carry the account's version (v), so a password reset or removal ends them right away.
export async function makeToken(env, email, now = Date.now(), v = 0) {
  const body = b64url(enc.encode(JSON.stringify({ email, v, exp: now + SESSION_MS })));
  return { token: body + "." + b64url(await hmac(env.SESSION_SECRET, body)), expiresAt: now + SESSION_MS };
}

// Returns the signed-in account { email, name, role, dev }, or null when the token is missing, forged,
// expired, or the account was removed or its password reset since.
export async function readToken(env, header, now = Date.now()) {
  const m = /^Bearer ([\w-]+)\.([\w-]+)$/.exec(header || "");
  if (!m) return null;
  let claims;
  try {
    if (!sameBytes(fromB64url(m[2]), await hmac(env.SESSION_SECRET, m[1]))) return null;
    claims = JSON.parse(new TextDecoder().decode(fromB64url(m[1])));
  } catch {
    return null;
  }
  const { email, exp, v } = claims;
  if (typeof exp !== "number" || exp < now || typeof email !== "string") return null;
  if (env.STORE) {
    const u = await getUser(env.STORE, email);
    if (!u || u.v !== v) return null;
    return { email: u.email, name: u.name, role: u.role, dev: u.dev || "" };
  }
  if (!teamEmails(env).includes(email)) return null;
  return { email, name: firstName(email), role: "admin", dev: "" };
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

const microsoftMail = (env) => !!(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET);
const mailEnabled = (env) => typeof env.MAILER === "function" || microsoftMail(env);
// "youssef@aione.biz" -> "Youssef"
const firstName = (email) => email.split("@")[0].split(/[._-]/)[0].replace(/^./, (c) => c.toUpperCase());

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
  if (typeof env.MAILER === "function") {
    try {
      await env.MAILER({ fromName: firstName(from) + " via AION Team Control", replyTo: from, to, subject, html });
      return json({ ok: true, to });
    } catch (err) {
      console.log("mail error:", err && err.message);
      return fail("mail", /auth|login|credential|535|534/i.test(String(err && err.message)) ? "The email account didn't accept its app password. Check GMAIL_USER and GMAIL_APP_PASSWORD." : "The email didn't send: " + ((err && err.message) || "unknown error"), 502);
    }
  }
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

// Emails from the app itself (password links). Returns true when sent.
async function sendSystemMail(env, to, subject, html) {
  if (typeof env.MAILER !== "function") return false;
  try {
    await env.MAILER({ fromName: "AION Team Control", replyTo: undefined, to: [to], subject, html });
    return true;
  } catch (err) {
    console.log("system mail error:", err && err.message);
    return false;
  }
}

const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const linkFor = (env, token) => String(env.APP_URL || "").replace(/\/+$/, "") + "/reset.html#t=" + token;

// Emails a one-time password link. purpose "invite": a new account (3 days); "reset": forgotten password (1 hour).
// Returns { sent, link }; the link is only handed back to an admin when the email couldn't be sent.
async function sendPasswordLink(env, user, purpose, invitedBy) {
  const ttl = purpose === "invite" ? 3 * 86400 : 3600;
  const token = await createLinkToken(env.STORE, user.email, purpose, ttl);
  const link = linkFor(env, token);
  const roleText = user.role === "admin" ? "an administrator" : "a developer (ai1_" + user.dev + ")";
  const html = purpose === "invite"
    ? "<p>Hi " + escHtml(user.name) + ",</p><p>" + escHtml(invitedBy || "Your team") + " added you to <b>AION Team Control</b> as " + escHtml(roleText) + ". Your sign-in email is <b>" + escHtml(user.email) + "</b>.</p>"
      + "<p><a href=\"" + escHtml(link) + "\">Choose your password</a></p><p>This link works once and expires in 3 days.</p>"
    : "<p>Hi " + escHtml(user.name) + ",</p><p>Someone asked to reset the password for your AION Team Control account (<b>" + escHtml(user.email) + "</b>).</p>"
      + "<p><a href=\"" + escHtml(link) + "\">Choose a new password</a></p><p>This link works once and expires in 1 hour. If you didn't ask for this, you can ignore this email; your password stays the same.</p>";
  const subject = purpose === "invite" ? "You've been added to AION Team Control" : "Reset your AION Team Control password";
  const sent = await sendSystemMail(env, user.email, subject, html);
  return { sent, link };
}

const clientIp = (request) => request.headers.get("x-real-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";

// Counts attempts in the database (shared by every running copy of the proxy). True when over the limit.
async function overLimit(env, key, max, seconds) {
  return (await env.STORE.incr("rl:" + key, seconds)) > max;
}

// First sign-in after the database is added: creates admin accounts for TEAM_EMAILS with TEAM_PASSWORD.
async function bootstrapAdmins(env, email, password) {
  const store = env.STORE;
  if (!env.TEAM_PASSWORD || !teamEmails(env).includes(email)) return false;
  if (((await store.smembers("users")) || []).length) return false;
  if (!(await sameSecret(password, env.TEAM_PASSWORD))) return false;
  const pw = await hashPassword(password);
  for (const e of teamEmails(env)) await saveUser(store, { email: e, name: firstName(e), role: "admin", dev: "", pw, v: 1, createdAt: new Date().toISOString() });
  return true;
}

async function accountRoutes(request, env, url, me) {
  const path = url.pathname, method = request.method, store = env.STORE;
  if (!store) return fail("no_store", "User accounts need the database. See SETUP.md.", 501);
  if (me.role !== "admin") return fail("forbidden", "Only administrators can manage users.", 403);

  if (path === "/users" && method === "GET") return json({ users: (await listUsers(store)).map(publicUser), mail: typeof env.MAILER === "function" });

  if (path === "/users" && method === "POST") {
    const b = (await readJson(request)) || {};
    const email = normEmail(b.email), name = String(b.name || "").trim(), role = b.role, dev = normDev(b.dev);
    if (!validEmail(email)) return fail("bad_request", "Enter a valid email.", 400);
    if (!name || name.length > 80) return fail("bad_request", "Enter a name.", 400);
    if (!ROLES.includes(role)) return fail("bad_request", "Choose Administrator or User.", 400);
    if (role === "user" && !validDev(dev)) return fail("bad_request", "Choose the developer this user sees.", 400);
    if (dev && !validDev(dev)) return fail("bad_request", "Developer names use letters, numbers, dots and dashes.", 400);
    if (await getUser(store, email)) return fail("exists", "There's already an account for " + email + ".", 409);
    const user = { email, name, role, dev: dev || "", pw: null, v: 1, createdAt: new Date().toISOString(), createdBy: me.email };
    await saveUser(store, user);
    const { sent, link } = await sendPasswordLink(env, user, "invite", me.name);
    return json({ user: publicUser(user), invited: sent, ...(sent ? {} : { link }) }, 201);
  }

  const m = /^\/users\/([^/]+)(\/invite)?$/.exec(path);
  if (!m) return fail("not_found", "Not found.", 404);
  const target = await getUser(store, decodeURIComponent(m[1]));
  if (!target) return fail("not_found", "No such user.", 404);

  if (m[2] && method === "POST") {
    const { sent, link } = await sendPasswordLink(env, target, target.pw ? "reset" : "invite", me.name);
    return json({ invited: sent, ...(sent ? {} : { link }) });
  }

  const admins = (await listUsers(store)).filter((u) => u.role === "admin");
  if (!m[2] && method === "PUT") {
    const b = (await readJson(request)) || {};
    const next = { ...target };
    if (b.name !== undefined) { next.name = String(b.name).trim(); if (!next.name || next.name.length > 80) return fail("bad_request", "Enter a name.", 400); }
    if (b.role !== undefined) { if (!ROLES.includes(b.role)) return fail("bad_request", "Choose Administrator or User.", 400); next.role = b.role; }
    if (b.dev !== undefined) { next.dev = normDev(b.dev); if (next.dev && !validDev(next.dev)) return fail("bad_request", "Developer names use letters, numbers, dots and dashes.", 400); }
    if (next.role === "user" && !next.dev) return fail("bad_request", "Choose the developer this user sees.", 400);
    if (target.role === "admin" && next.role !== "admin") {
      if (target.email === me.email) return fail("bad_request", "You can't remove your own administrator role.", 400);
      if (admins.length <= 1) return fail("bad_request", "There must be at least one administrator.", 400);
    }
    await saveUser(store, next);
    return json({ user: publicUser(next) });
  }

  if (!m[2] && method === "DELETE") {
    if (target.email === me.email) return fail("bad_request", "You can't remove your own account.", 400);
    if (target.role === "admin" && admins.length <= 1) return fail("bad_request", "There must be at least one administrator.", 400);
    await deleteUser(store, target.email);
    return json({ ok: true });
  }

  return fail("not_found", "Not found.", 404);
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
    const ip = clientIp(request);
    const body = (await readJson(request)) || {};
    const email = normEmail(body.email), password = String(body.password || "");
    if (env.STORE) {
      if ((await overLimit(env, "login-ip:" + ip, 10, 60)) || (await overLimit(env, "login-email:" + email, 20, 900))) return fail("rate_limited", "Too many sign-in attempts. Wait a few minutes and try again.", 429);
      let u = await getUser(env.STORE, email);
      if (!u && (await bootstrapAdmins(env, email, password))) u = await getUser(env.STORE, email);
      if (!u || !(await checkPassword(password, u.pw))) return fail("login", "That email and password don't match.", 401);
      return json({ email: u.email, name: u.name, role: u.role, ...(await makeToken(env, u.email, Date.now(), u.v)) });
    }
    const { success } = await (env.LOGIN_LIMIT || memoryLimit).limit({ key: ip });
    if (!success) return fail("rate_limited", "Too many sign-in attempts. Wait a minute and try again.", 429);
    const passwordOk = await sameSecret(password, env.TEAM_PASSWORD || "");
    if (!env.TEAM_PASSWORD || !passwordOk || !teamEmails(env).includes(email)) return fail("login", "That email and password don't match.", 401);
    return json({ email, name: firstName(email), role: "admin", ...(await makeToken(env, email)) });
  }

  // Forgotten password: always answers the same way, so it can't be used to find out who has an account.
  if (path === "/forgot" && method === "POST") {
    if (!env.STORE) return fail("no_store", "Password resets need the user database. Ask Youssef for the password.", 501);
    const email = normEmail(((await readJson(request)) || {}).email);
    if (!validEmail(email)) return fail("bad_request", "Enter your email.", 400);
    if ((await overLimit(env, "forgot-ip:" + clientIp(request), 5, 900)) || (await overLimit(env, "forgot-email:" + email, 3, 3600))) return fail("rate_limited", "Too many reset requests. Wait a while and try again.", 429);
    const u = await getUser(env.STORE, email);
    if (u) await sendPasswordLink(env, u, "reset");
    return json({ ok: true });
  }

  // The password page checks its link first, then sets the new password.
  if (path === "/reset/check" && method === "POST") {
    if (!env.STORE) return fail("no_store", "Password resets aren't set up.", 501);
    const t = await peekLinkToken(env.STORE, ((await readJson(request)) || {}).token);
    const u = t && (await getUser(env.STORE, t.email));
    if (!u) return fail("bad_link", "This link has expired or was already used.", 400);
    return json({ email: u.email, name: u.name, purpose: t.purpose });
  }
  if (path === "/reset" && method === "POST") {
    if (!env.STORE) return fail("no_store", "Password resets aren't set up.", 501);
    const b = (await readJson(request)) || {};
    const problem = passwordProblem(b.password);
    if (problem) return fail("bad_request", problem, 400);
    if (await overLimit(env, "reset-ip:" + clientIp(request), 20, 900)) return fail("rate_limited", "Too many attempts. Wait a while and try again.", 429);
    const t = await useLinkToken(env.STORE, b.token);
    const u = t && (await getUser(env.STORE, t.email));
    if (!u) return fail("bad_link", "This link has expired or was already used. Ask for a new one.", 400);
    await saveUser(env.STORE, { ...u, pw: await hashPassword(b.password), v: (u.v || 0) + 1 });
    return json({ ok: true, email: u.email });
  }

  const me = await readToken(env, request.headers.get("Authorization"));
  if (!me) return fail("session", "Please sign in again.", 401);
  const email = me.email;
  const isAdmin = me.role === "admin";
  const devLabel = "ai1_" + me.dev;

  if (path === "/users" || path.startsWith("/users/")) return accountRoutes(request, env, url, me);

  const P = env.JIRA_PROJECT;
  const isOurKey = (k) => new RegExp("^" + P + "-\\d+$").test(k);
  // Users (not admins) only ever see and change tickets labelled with their developer name.
  const hasDevLabel = (labels) => (labels || []).some((l) => String(l).toLowerCase() === devLabel);

  if (path === "/config" && method === "GET") {
    let team = {};
    try { team = JSON.parse(env.TEAM_CONFIG || "{}"); } catch {}
    return json({ ...team, site: env.JIRA_SITE, project: P, email, name: me.name, role: me.role, dev: me.dev, accounts: !!env.STORE, mail: isAdmin && mailEnabled(env) });
  }

  if (!isAdmin && (path === "/mail" || path === "/jira/users")) return fail("forbidden", "Only administrators can do that.", 403);

  if (path === "/mail" && method === "POST") return sendMail(env, email, await readJson(request));

  if (path === "/jira/search" && method === "POST") {
    const b = await readJson(request);
    if (!b || typeof b.jql !== "string" || b.jql.length > 2000 || !Array.isArray(b.fields) || b.fields.length > 30 || !b.fields.every((f) => typeof f === "string")) return fail("bad_request", "Bad search.", 400);
    let jql = b.jql, fields = b.fields;
    if (!isAdmin) {
      const order = /\sORDER\s+BY\s[\s\S]*$/i.exec(jql);
      jql = 'labels = "' + devLabel + '" AND (' + (order ? jql.slice(0, order.index) : jql) + ")" + (order ? order[0] : "");
      fields = [...new Set([...fields, "labels"])];
    }
    const r = await jira(env, "/rest/api/3/search/jql", {
      method: "POST",
      body: { jql, fields, maxResults: Math.min(Number(b.maxResults) || 100, 100), expand: "renderedFields", ...(typeof b.nextPageToken === "string" ? { nextPageToken: b.nextPageToken } : {}) }
    });
    if (!r.ok) return r.res;
    // Only this project's tickets (and for users, only their own) ever leave the proxy, whatever the search asked for.
    return json({ ...r.data, issues: (r.data.issues || []).filter((i) => isOurKey(i.key) && (isAdmin || hasDevLabel(i.fields && i.fields.labels))) });
  }

  if (path === "/jira/users" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (q.length < 2 || q.length > 100) return fail("bad_request", "Type at least 2 letters.", 400);
    return pass(await jira(env, "/rest/api/3/user/search?maxResults=8&query=" + encodeURIComponent(q)));
  }

  const m = /^\/jira\/issue\/([A-Z][A-Z0-9_]*-\d+)(\/changelog|\/transitions|\/comment)?$/.exec(path);
  if (m && isOurKey(m[1])) {
    const key = m[1], sub = m[2] || "";
    if (!isAdmin) {
      const t = await jira(env, "/rest/api/3/issue/" + key + "?fields=labels");
      if (!t.ok) return t.res;
      if (!hasDevLabel(t.data.fields && t.data.fields.labels)) return fail("forbidden", "This ticket isn't assigned to you.", 403);
    }
    if (sub === "" && method === "PUT") {
      const b = await readJson(request);
      if (!b || !validFields(b.fields)) return fail("bad_request", "Only labels, due date and assignee can be changed.", 400);
      if (!isAdmin && Object.keys(b.fields).some((k) => k !== "duedate")) return fail("forbidden", "Only administrators can change developers and assignees.", 403);
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
