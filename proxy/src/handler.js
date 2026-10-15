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
import { BusinessError, businessResponse, catalogRoutes, metadataRoutes, readMetadata, readCatalog, publicMetadata, requireBilling, withTicketLock, guardedTransition } from "./ticket-metadata.js";
import { reportRoutes, buildReport } from "./reports.js";
import { dateRequestRoutes } from "./date-requests.js";
import { ticketNoteRoutes } from "./ticket-notes.js";
import { internalRoutes } from "./internal.js";
import { odooConfigured, odooRoutes, odooTicketInfo } from "./odoo.js";
import { monitorRoutes } from "./monitor.js";
import { odooAppRoutes, odooTranslations } from "./odoo-app.js";
import { cookieSessionRequest } from "./sessions.js";
import { SESSION_MS } from "./session-policy.js";
import { aiChat, aiBrief, aiConfigured } from "./ai.js";
import { newTicketNotification, notifyTicketsFromSearch } from "./notifications.js";
import { ROLES, checkPassword, createLinkToken, deleteUser, getUser, hashPassword, listUsers, normDev, normEmail, passwordProblem, peekLinkToken, publicUser, saveUser, useLinkToken, validDev, validEmail } from "./users.js";

const enc = new TextEncoder();
// Saved sign-ins last up to one year; account version changes still revoke tokens.
const EDITABLE = new Set(["labels", "duedate", "assignee"]);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const fail = (code, error, status) => json({ code, error }, status);

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin");
  const h = { Vary: "Origin" };
  // ALLOWED_ORIGIN may list several addresses, comma separated (e.g. while moving to a new domain).
  if (origin && String(env.ALLOWED_ORIGIN || "").split(",").map((o) => o.trim()).filter(Boolean).includes(origin)) {
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
export async function makeToken(env, email, now = Date.now(), v = 0, sid = undefined) {
  const body = b64url(enc.encode(JSON.stringify({ email, v, exp: now + SESSION_MS, ...(sid?{sid}:{}) })));
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
  if(claims.sid&&(!env.STORE||!await env.STORE.get("sess:"+claims.sid)))return null;
  if(env.COOKIE_SESSIONS&&!claims.sid)return null;
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
    ...(init.signal?{signal:init.signal}:{}),
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
      console.warn("mail_failed");
      return fail("mail", /auth|login|credential|535|534/i.test(String(err && err.message)) ? "The email account didn't accept its app password. Check GMAIL_USER and GMAIL_APP_PASSWORD." : "The email could not be sent. Please try again or contact an administrator.", 502);
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
  return fail("mail", res.status === 403 ? "Microsoft refused to send from " + from + ". Check the app's Mail.Send permission and admin consent." : "The email provider could not send the message. Please try again.", 502);
}

// Emails from the app itself (password links). Returns true when sent.
async function sendSystemMail(env, to, subject, html) {
  if (typeof env.MAILER !== "function") return false;
  try {
    await env.MAILER({ fromName: "AION Team Control", replyTo: undefined, to: [to], subject, html });
    return true;
  } catch (err) {
    console.warn("system_mail_failed");
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
  if ("assignee" in fields && fields.assignee?.accountId === "__internal_tickets") return false;
  if ("assignee" in fields && !(fields.assignee === null || (fields.assignee && typeof fields.assignee.accountId === "string" && Object.keys(fields.assignee).length === 1))) return false;
  return true;
}

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // Public compatibility check for Pages publishing; exposes no runtime credentials or ticket data.
  if (path.startsWith("/monitor/odoo/translations") && method === "GET") return odooTranslations(env, url);
  if (path === "/health" && method === "GET") return json({ok:true, apiVersion:1, capabilities:["date-requests-v1", "ticket-notes-v1", "odoo-helpdesk-v1", "ticket-business-v1"]});

  // Jira Automation uses its own secret, never a team password or a user's browser session.
  if (path === "/notifications/jira-created") {
    if (method !== "POST") return fail("method", "Use POST for Jira events.", 405);
    if (!env.JIRA_NOTIFICATION_SECRET || env.JIRA_NOTIFICATION_SECRET.length < 32) return fail("notification_off", "Ticket notifications aren't configured.", 503);
    if (!(await sameSecret(request.headers.get("X-AION-Webhook-Secret") || "", env.JIRA_NOTIFICATION_SECRET))) return fail("forbidden", "Invalid webhook secret.", 401);
    return newTicketNotification(request, env, {
      readIssue: key => jira(env, "/rest/api/3/issue/" + key + "?fields=summary,labels,status,assignee,priority,duedate,project"),
      sendMail: (from, body) => sendMail(env, from, body)
    });
  }

  if (path === "/login" && method === "POST") {
    const ip = clientIp(request);
    const body = (await readJson(request)) || {};
    const email = normEmail(body.email), password = String(body.password || "");
    if (env.STORE) {
      if ((await overLimit(env, "login-ip:" + ip, 10, 60)) || (await overLimit(env, "login-email:" + email, 20, 900))) return fail("rate_limited", "Too many sign-in attempts. Wait a few minutes and try again.", 429);
      let u = await getUser(env.STORE, email);
      if (!u && (await bootstrapAdmins(env, email, password))) u = await getUser(env.STORE, email);
      if (!u || !(await checkPassword(password, u.pw))) return fail("login", "That email and password don't match.", 401);
      if(u.pw.iterations<600000){
        const upgraded={...u,pw:await hashPassword(password)};
        if(await env.STORE.compareAndSet("u:"+u.email,JSON.stringify(u),JSON.stringify(upgraded)))u=upgraded;
        else{u=await getUser(env.STORE,email);if(!u||!await checkPassword(password,u.pw))return fail("login","That email and password don't match.",401);}
      }
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
  const readBusinessTicket = async key => {
    if(typeof key!=="string" || !new RegExp("^(?:INT|"+env.JIRA_PROJECT+")-\\d+$").test(key))return null;
    if(/^INT-/.test(key)){const raw=await env.STORE?.get("it:"+key);if(!raw)return null;const t=JSON.parse(raw);if(me.role!=="admin"&&(!me.dev||!t.devs?.includes(me.dev)))return null;return {key,title:t.summary,description:t.description,comments:t.comments||[],devs:t.devs||[],closed:t.status==="Closed",status:t.status,cat:t.status==="Closed"?"done":"new",created:t.created,updated:t.updated,completedAt:t.closedAt||null,due:t.due,assignee:t.assignee,internal:true};}
    const result=await jira(env,"/rest/api/3/issue/"+key+"?fields=summary,description,labels,status,created,updated,duedate,project,assignee,resolutiondate",{signal:AbortSignal.timeout(15000)});
    if(!result.ok){if([403,404].includes(result.res.status))return null;throw new Error("Ticket read failed");}
    const t=result.data,f=t.fields;if(t.key!==key||f?.project?.key!==env.JIRA_PROJECT||!Array.isArray(f.labels)||!f.status?.statusCategory?.key)throw new Error("Incomplete ticket authorization data");
    const devs=f.labels.filter(l=>/^ai1_/i.test(l)).map(l=>l.slice(4).toLowerCase());if(me.role!=="admin"&&(!me.dev||!devs.includes(me.dev)))return null;
    return {key,title:f.summary,description:f.description,devs,closed:f.status.statusCategory.key==="done",status:f.status.name,cat:f.status.statusCategory.key,created:f.created,updated:f.updated,due:f.duedate,completedAt:f.resolutiondate||null,assignee:f.assignee?.displayName,internal:false};
  };
  if(path==="/clients"||path.startsWith("/clients/"))return catalogRoutes(request,env,url,me);
  if(path==="/ticket-metadata"||path.startsWith("/ticket-metadata/"))return metadataRoutes(request,env,url,me,readBusinessTicket);
  const readBusinessSearch=async body=>{const searchUrl=new URL("/jira/search",url);const r=await route(new Request(searchUrl,{method:"POST",headers:{Authorization:request.headers.get("Authorization"),"Content-Type":"application/json","X-AION-Read-Only":"1"},body:JSON.stringify(body)}),env,searchUrl);if(!r.ok)throw new Error("Authorized search failed");return r.json();};
  const dashboardRead=async()=>{const keys=await env.STORE?.smembers("itickets")||[];const rows=[];for(const key of keys){const t=await readBusinessTicket(key);if(t)rows.push(t);}return rows;};
  const reportDeps={readSearch:readBusinessSearch,readInternal:dashboardRead,readHistory:async(key,status)=>{
    if(!key.startsWith(env.JIRA_PROJECT+"-"))return null;let latest=null;
    for(let page=0;page<3;page++){const r=await jira(env,"/rest/api/3/issue/"+key+"/changelog?startAt="+(page*100)+"&maxResults=100",{signal:AbortSignal.timeout(3000)});if(!r.ok||!Array.isArray(r.data.values))return null;
      for(const h of r.data.values)if((h.items||[]).some(i=>(i.field==="status"||i.fieldId==="status")&&i.toString===status)&&Number.isFinite(Date.parse(h.created))&&(!latest||h.created>latest))latest=h.created;
      if(r.data.isLast===true||r.data.values.length<100||r.data.total<=(page+1)*100)return latest;
    }return null;
  }};
  if(path==="/reports/run")return reportRoutes(request,env,me,reportDeps);
  const email = me.email;
  const isAdmin = me.role === "admin";
  const devLabel = "ai1_" + me.dev;
  if(path.startsWith("/ai/")){
    if(!["/ai/chat","/ai/brief"].includes(path))return fail("ai_read_only","Ticket actions are disabled in AION AI v1.",403);
    return (path==="/ai/brief"?aiBrief:aiChat)(request,env,{me,project:env.JIRA_PROJECT,readDashboard:dashboardRead,readBusiness:async key=>{const t=await readBusinessTicket(key);if(!t)return null;return {...t,...publicMetadata(await readMetadata(env,key),me,await readCatalog(env))};},runReport:options=>buildReport(env,me,reportDeps,options),readSearch:async body=>{
      const result=await route(new Request(new URL("/jira/search",url),{method:"POST",headers:{Authorization:request.headers.get("Authorization"),"Content-Type":"application/json","X-AION-Read-Only":"1"},body:JSON.stringify(body)}),env,new URL("/jira/search",url));
      if(!result.ok)throw new Error("Authorized Jira read failed");return result.json();
    }});
  }

  if (path === "/users" || path.startsWith("/users/")) return accountRoutes(request, env, url, me);
  if (path === "/ticket-notes") return ticketNoteRoutes(request, env, url, me, {
    readTicket:async key => {
      if (key.startsWith("HD-")) return odooTicketInfo(env, key);
      if (/^INT-\d+$/.test(key)) {
        const raw = await env.STORE?.get("it:" + key);
        if (!raw) return null;
        const t = JSON.parse(raw);
        return {title:t.summary, devs:t.devs || []};
      }
      const result = await jira(env, "/rest/api/3/issue/" + key + "?fields=summary,labels,project", {signal:AbortSignal.timeout(15000)});
      if (!result.ok) { if ([403,404].includes(result.res.status)) return null; throw new Error("Ticket read failed"); }
      const f = result.data.fields;
      if (result.data.key !== key || f?.project?.key !== env.JIRA_PROJECT || !Array.isArray(f.labels)) return null;
      return {title:f.summary, devs:f.labels.filter(l => /^ai1_/i.test(l)).map(l => l.slice(4).toLowerCase())};
    },
    sendMail:(from,body) => sendMail(env,from,body)
  });
  if(path==="/date-requests"||path.startsWith("/date-requests/"))return dateRequestRoutes(request,env,url,me,{
    readTicket:async (key,{checkInitial=false}={})=>{
      if(/^INT-\d+$/.test(key)){const raw=await env.STORE?.get("it:"+key);if(!raw)return null;const t=JSON.parse(raw);return {title:t.summary,due:t.due||null,devs:t.devs||[],closed:t.status==="Closed",hasHadDue:!!t.due||(t.dueHistory||[]).some(h=>h.from||h.to),raw};}
      const result=await jira(env,"/rest/api/3/issue/"+key+"?fields=summary,labels,duedate,status,project",{signal:AbortSignal.timeout(15000)});if(!result.ok){if(result.res.status===404||result.res.status===403)return null;throw new Error("Ticket read failed");}const f=result.data.fields;
      if(result.data.key!==key||f.project?.key!==env.JIRA_PROJECT||!Array.isArray(f.labels)||!f.status?.statusCategory?.key)throw new Error("Incomplete ticket details");
      let hasHadDue=!!f.duedate;
      if(checkInitial&&!hasHadDue){
        const historyStarted=Date.now();
        for(let page=0;page<20;page++){
          if(Date.now()-historyStarted>15000)throw new Error("Initial date verification timed out");
          const history=await jira(env,"/rest/api/3/issue/"+key+"/changelog?startAt="+(page*100)+"&maxResults=100",{signal:AbortSignal.timeout(5000)});
          if(!history.ok||!Array.isArray(history.data.values))throw new Error("Could not verify initial due date history");
          if(history.data.values.some(h=>(h.items||[]).some(it=>(it.field==="duedate"||it.fieldId==="duedate")&&(it.from||it.to||it.fromString||it.toString)))){hasHadDue=true;break;}
          if(history.data.isLast===true||history.data.values.length<100||((page+1)*100>=history.data.total))break;
          if(page===19)throw new Error("Initial due date history is incomplete");
        }
      }
      return {title:f.summary,due:f.duedate||null,hasHadDue,devs:[...new Set(f.labels.filter(l=>/^ai1_/i.test(l)).map(l=>l.slice(4).toLowerCase()))],closed:f.status.statusCategory.key==="done"};
    },
    applyDate:async(key,date,t,r)=>{
      if(/^INT-\d+$/.test(key)){const ticket=JSON.parse(t.raw);ticket.due=date;ticket.updated=new Date().toISOString();ticket.dueHistory=[{when:ticket.updated,by:me.name||me.email,from:t.due,to:date,requestId:r.id,reason:r.decision.reason},...(ticket.dueHistory||[])];if(!await env.STORE.compareAndSet("it:"+key,t.raw,JSON.stringify(ticket)))throw new Error("Ticket changed");return;}
      const result=await jira(env,"/rest/api/3/issue/"+key,{method:"PUT",body:{fields:{duedate:date}},signal:AbortSignal.timeout(20000)});if(!result.ok)throw new Error("Date update failed");
    },
    sendMail:(from,body)=>sendMail(env,from,body)
  });
  if (path === "/internal" || path.startsWith("/internal/")) return internalRoutes(request, env, url, me);
  if (path === "/odoo/tickets" || path.startsWith("/odoo/tickets/")) return odooRoutes(request, env, url, me);
  if (path.startsWith("/monitor/odoo/")) return odooAppRoutes(request, env, url, me);
  if (path.startsWith("/monitor/")) return monitorRoutes(request, env, url, me);

  const P = env.JIRA_PROJECT;
  const isOurKey = (k) => new RegExp("^" + P + "-\\d+$").test(k);
  // Users (not admins) only ever see and change tickets labelled with their developer name.
  const hasDevLabel = (labels) => (labels || []).some((l) => String(l).toLowerCase() === devLabel);

  if (path === "/config" && method === "GET") {
    let team = {};
    try { team = JSON.parse(env.TEAM_CONFIG || "{}"); } catch {}
    return json({ ...team, site: env.JIRA_SITE, project: P, email, name: me.name, role: me.role, dev: me.dev, accounts: !!env.STORE, odoo: odooConfigured(env), mail: isAdmin && mailEnabled(env), ai:{enabled:aiConfigured(env),readOnly:true}, capabilities:["ticket-business-v1"] });
  }

  if (!isAdmin && (path === "/mail" || path === "/jira/users")) return fail("forbidden", "Only administrators can do that.", 403);

  if (path === "/mail" && method === "POST") return sendMail(env, email, await readJson(request));

  // Ticket lists only show each ticket's latest comment: slim results drop the rest (and the
  // description), which makes list loads several times smaller. One ticket's details are never slim.
  const slimIssue = (i) => {
    const lastOnly = (c) => (c && Array.isArray(c.comments) ? { ...c, comments: c.comments.slice(-1) } : c);
    const fields = { ...(i.fields || {}) }, rendered = { ...(i.renderedFields || {}) };
    delete fields.description; delete rendered.description;
    if (fields.comment) fields.comment = lastOnly(fields.comment);
    if (rendered.comment) rendered.comment = lastOnly(rendered.comment);
    for (const k of Object.keys(rendered)) if (k !== "comment") delete rendered[k];
    return { ...i, fields, renderedFields: rendered };
  };
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
    if(isAdmin&&mailEnabled(env)&&env.STORE&&request.headers.get("X-AION-Read-Only")!=="1"){
      try{await notifyTicketsFromSearch(env,r.data.issues||[],{
        readIssue:key=>jira(env,"/rest/api/3/issue/"+key+"?fields=summary,labels,status,assignee,priority,duedate,project"),
        sendMail:(from,body)=>sendMail(env,from,body)
      });}catch{console.warn("Ticket notification check failed; Jira results remain available.");}
    }
    // Only this project's tickets (and for users, only their own) ever leave the proxy, whatever the search asked for.
    const issues = (r.data.issues || []).filter((i) => isOurKey(i.key) && (isAdmin || hasDevLabel(i.fields && i.fields.labels)));
    return json({ ...r.data, issues: b.slim === true ? issues.map(slimIssue) : issues });
  }

  if (path === "/jira/users" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (q.length < 2 || q.length > 100) return fail("bad_request", "Type at least 2 letters.", 400);
    return pass(await jira(env, "/rest/api/3/user/search?maxResults=8&query=" + encodeURIComponent(q)));
  }

  // A Jira attachment, fetched with the proxy's Jira login so it opens in the dashboard without Jira.
  // Only for someone who can see the ticket, and only an attachment that belongs to that ticket.
  const att = /^\/jira\/issue\/([A-Z][A-Z0-9_]*-\d+)\/attachments\/(\d{1,20})$/.exec(path);
  if (att && isOurKey(att[1]) && method === "GET") {
    const t = await jira(env, "/rest/api/3/issue/" + att[1] + "?fields=labels,attachment");
    if (!t.ok) return t.res;
    if (!isAdmin && !hasDevLabel(t.data.fields && t.data.fields.labels)) return fail("forbidden", "This ticket isn't assigned to you.", 403);
    const meta = ((t.data.fields && t.data.fields.attachment) || []).find((a) => String(a.id) === att[2]);
    if (!meta) return fail("not_found", "No such attachment on this ticket.", 404);
    const file = await fetch(env.JIRA_SITE + "/rest/api/3/attachment/content/" + att[2], { headers: { Authorization: "Basic " + btoa(env.JIRA_EMAIL + ":" + env.JIRA_API_TOKEN) } });
    if (!file.ok || !file.body) return fail("jira", "Jira didn't return the attachment (" + file.status + ").", 502);
    const type = String(meta.mimeType || file.headers.get("Content-Type") || "application/octet-stream").split(";")[0].trim();
    return new Response(file.body, { status: 200, headers: {
      "Content-Type": /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "application/octet-stream",
      ...(file.headers.get("Content-Length") ? { "Content-Length": file.headers.get("Content-Length") } : {}),
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(meta.filename || "attachment")
    } });
  }

  const m = /^\/jira\/issue\/([A-Z][A-Z0-9_]*-\d+)(\/changelog|\/history|\/transitions|\/comment)?$/.exec(path);
  if (m && isOurKey(m[1])) {
    const key = m[1], sub = m[2] || "";
    if(sub==="/history"){
      if(!isAdmin)return fail("forbidden","Only managers can view full ticket history.",403);
      if(method!=="GET")return fail("method","Ticket history is read-only.",405);
      const start=url.searchParams.get("startAt")||"0";
      if(!/^\d{1,9}$/.test(start))return fail("bad_request","Invalid history page.",400);
      const result=await jira(env,"/rest/api/3/issue/"+key+"/changelog?startAt="+Number(start)+"&maxResults=100");
      if(!result.ok)return result.res;
      // Never forward Jira's nextPage URL; callers paginate through this fixed authorized route.
      const data=result.data;
      if(!Array.isArray(data.values))return fail("jira","Jira returned invalid ticket history.",502);
      return json({values:data.values,startAt:data.startAt??Number(start),total:data.total,isLast:data.isLast});
    }
    if (!isAdmin) {
      const t = await jira(env, "/rest/api/3/issue/" + key + "?fields=labels");
      if (!t.ok) return t.res;
      if (!hasDevLabel(t.data.fields && t.data.fields.labels)) return fail("forbidden", "This ticket isn't assigned to you.", 403);
    }
    if (sub === "" && method === "PUT") {
      const b = await readJson(request);
      if (!b || !validFields(b.fields)) return fail("bad_request", "Only labels, due date and assignee can be changed.", 400);
      if (!isAdmin) return fail("forbidden", "Users must request due date changes; only admins can edit ticket fields.", 403);
      if("duedate" in b.fields)return fail("date_request", "Use the date approval process and provide a reason.",400);
      return withTicketLock(env,key,async()=>{
        const ticket=await readBusinessTicket(key);if(!ticket)return fail('not_found','Ticket unavailable.',404);
        const wantedDevs=Array.isArray(b.fields.labels)?[...new Set(b.fields.labels.filter(l=>/^ai1_/i.test(l)).map(l=>l.slice(4).toLowerCase()))].sort():null;
        if('assignee' in b.fields || wantedDevs&&JSON.stringify(wantedDevs)!==JSON.stringify([...ticket.devs].sort()))requireBilling(await readMetadata(env,key));
        return pass(await jira(env, '/rest/api/3/issue/'+key,{method:'PUT',body:{fields:b.fields},signal:AbortSignal.timeout(20000)}));
      });
    }
    if (sub === "/changelog" && method === "GET") return pass(await jira(env, "/rest/api/3/issue/" + key + "?fields=duedate&expand=changelog"));
    if (sub === "/transitions" && method === "GET") return pass(await jira(env, "/rest/api/3/issue/" + key + "/transitions"));
    if (sub === "/transitions" && method === "POST") {
      const b = await readJson(request);
      if (!b || !/^\d+$/.test(String(b.id))) return fail("bad_request", "Bad status move.", 400);
      return withTicketLock(env,key,async()=>{
        const ticket=await readBusinessTicket(key);if(!ticket)return fail("not_found","Ticket unavailable.",404);
        const transitions=await jira(env,"/rest/api/3/issue/"+key+"/transitions",{signal:AbortSignal.timeout(15000)});if(!transitions.ok)return transitions.res;
        const target=transitions.data.transitions?.find(t=>String(t.id)===String(b.id)&&t.isAvailable!==false);if(!target?.to?.statusCategory?.key)return fail("bad_request","This transition is unavailable or has incomplete destination details.",400);
        const closing=target.to.statusCategory.key==="done";
        const apply=async()=>pass(await jira(env,"/rest/api/3/issue/"+key+"/transitions",{method:"POST",body:{transition:{id:String(b.id)}},signal:AbortSignal.timeout(20000)}));
        return closing||ticket.closed?guardedTransition(env,key,me,{closing,overrideReason:b.overrideReason},apply):apply();
      });
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
      res = env.COOKIE_SESSIONS?await cookieSessionRequest(request,env,req=>route(req,env,new URL(req.url)),{readToken,makeToken}):await route(request, env, new URL(request.url));
    } catch (err) {
      if(err instanceof BusinessError)res=businessResponse(err);
      else console.warn("proxy_failed");
      if(!res)res = fail("server", "The proxy hit an error.", 500);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    res.headers.set("X-Content-Type-Options","nosniff");res.headers.set("X-Frame-Options","DENY");
    return res;
  }
};
