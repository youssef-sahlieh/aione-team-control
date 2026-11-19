// Signing in to a customer database the way AI1 Monitor's "Open Odoo" does: no username or password.
//
// 1. The proxy signs in to AI1 Monitor as a dashboard administrator's account (the same same-tab sign-in a browser
//    does: /auth/aione/start gives a state, this proxy issues the one-time code for it, /auth/aione/callback trades it).
// 2. GET /api/monitor/instances/<instance>/open-odoo answers with a one-use link https://<site>/__ai1_sso#token=…
// 3. POST https://<site>/__ai1_sso {token} makes a fresh Odoo administrator session and sets its session_id cookie.
// 4. The report reads through Odoo's JSON-RPC with that session, then signs it out (/web/session/destroy).
//
// Nothing here is stored: the Monitor and Odoo session cookies live in memory for this run only and never reach a
// browser or a log.
import { createLinkToken, ensureAccountId, getUser, listUsers } from "./users.js";

const ACCOUNT_KEY = "dbreport:monitor-account";   // the administrator whose account signs in (the last one who refreshed)
const SITE = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ai1\.host$/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const monitorOrigin = (env) => String(env.MONITOR_PUBLIC_ORIGIN || "https://monitor.ai1.host").replace(/\/+$/, "");

// "name=value" pairs from a response's Set-Cookie headers.
function cookiesOf(res) {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : String(res.headers.get("set-cookie") || "").split(/,(?=\s*[\w-]+=)/);
  const out = {};
  for (const c of all) { const m = /^\s*([^=;\s]+)=([^;]*)/.exec(c); if (m) out[m[1]] = m[2]; }
  return out;
}
const cookieHeader = (jar) => Object.entries(jar).filter(([, v]) => v !== "").map(([k, v]) => k + "=" + v).join("; ");

// Remembers the administrator whose dashboard account signs in to AI1 Monitor for the report (and the daily runs).
export async function rememberMonitorAccount(env, me) {
  if (env.STORE && me && me.role === "admin" && me.email) await env.STORE.set(ACCOUNT_KEY, String(me.email).toLowerCase()).catch(() => {});
}

// The account: MONITOR_REPORT_ACCOUNT (an administrator's email) when set, else the last administrator who refreshed
// the report, else the first administrator. Null when there is none.
async function reportAccount(env) {
  if (!env.STORE) return null;
  const wanted = [env.MONITOR_REPORT_ACCOUNT, await env.STORE.get(ACCOUNT_KEY).catch(() => null)].map((e) => String(e || "").trim().toLowerCase()).filter(Boolean);
  for (const email of wanted) { const u = await getUser(env.STORE, email); if (u && u.role === "admin") return ensureAccountId(env.STORE, u); }
  const admin = (await listUsers(env.STORE).catch(() => [])).find((u) => u.role === "admin");
  return admin ? ensureAccountId(env.STORE, await getUser(env.STORE, admin.email)) : null;
}

let signedIn = null; // { at, cookie, email } for this run (a few minutes at most)

// Signs in to AI1 Monitor and returns its session cookie header. Throws a readable error.
export async function monitorSignIn(env, { fetchImpl = fetch } = {}) {
  if (signedIn && Date.now() - signedIn.at < 5 * 60 * 1000) return signedIn;
  const account = await reportAccount(env);
  if (!account) throw new Error("No administrator account to sign in to AI1 Monitor with.");
  const origin = monitorOrigin(env), signal = () => AbortSignal.timeout(15000);
  const start = await fetchImpl(origin + "/auth/aione/start", { redirect: "manual", signal: signal() });
  const state = new URL(start.headers.get("location") || "", origin).searchParams.get("ai1-monitor") || "";
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(state)) throw new Error("AI1 Monitor sign-in didn't start (HTTP " + start.status + ").");
  const jar = cookiesOf(start);
  const code = await createLinkToken(env.STORE, account.email, "monitor-sso:" + state, 60, { accountId: account.id });
  const back = await fetchImpl(origin + "/auth/aione/callback?" + new URLSearchParams({ code, state }), { redirect: "manual", headers: { Cookie: cookieHeader(jar) }, signal: signal() });
  Object.assign(jar, cookiesOf(back));
  const to = new URL(back.headers.get("location") || "/", origin).pathname;
  if (back.status >= 400) throw new Error("AI1 Monitor refused the sign-in for " + account.email + " (HTTP " + back.status + ").");
  if (to.startsWith("/auth/aione/connect")) throw new Error(account.email + " isn't linked to an AI1 Monitor account yet: open AI1 Monitor once from the dashboard with it.");
  signedIn = { at: Date.now(), cookie: cookieHeader(jar), email: account.email };
  return signedIn;
}
export function forgetMonitorSignIn() { signedIn = null; }

// Opens one database as its Odoo administrator. Returns { base, db, kw, close } like a password login, or throws.
// database: the database to open on an instance that hosts several (Monitor picks the only one otherwise).
export async function openOdoo(env, instance, database, { timeout = 20000, fetchImpl = fetch } = {}) {
  if (!NAME.test(String(instance || ""))) throw new Error("invalid instance");
  const monitor = await monitorSignIn(env, { fetchImpl });
  const q = database ? "?" + new URLSearchParams({ database }) : "";
  const res = await fetchImpl(monitorOrigin(env) + "/api/monitor/instances/" + encodeURIComponent(instance) + "/open-odoo" + q, { redirect: "manual", headers: { Cookie: monitor.cookie, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  const location = res.headers.get("location") || "";
  if (res.status === 401 || (res.status >= 300 && res.status < 400 && /\/login|\/auth\//.test(location))) { forgetMonitorSignIn(); throw new Error("AI1 Monitor signed the dashboard out."); }
  if (res.status !== 303 && res.status !== 302) {
    const why = await res.json().then((d) => d && d.error).catch(() => "");
    throw new Error("Open Odoo didn't work" + (why ? ": " + String(why).slice(0, 120) : " (HTTP " + res.status + ")."));
  }
  const link = new URL(location);
  const base = link.origin, token = new URLSearchParams(link.hash.slice(1)).get("token") || "";
  if (!SITE.test(base) || link.pathname !== "/__ai1_sso" || !token) throw new Error("Open Odoo gave an unexpected address.");
  const made = await fetchImpl(base + "/__ai1_sso", { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(timeout) });
  const sid = cookiesOf(made).session_id || "";
  if (!made.ok || !/^[A-Za-z0-9_-]{20,200}$/.test(sid)) {
    const why = await made.json().then((d) => d && d.error).catch(() => "");
    throw new Error("Odoo didn't open" + (why ? ": " + String(why).slice(0, 120) : " (HTTP " + made.status + ")."));
  }
  const cookie = "session_id=" + sid;
  const rpc = async (path, params) => {
    const r = await fetchImpl(base + path, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ jsonrpc: "2.0", method: "call", params }), signal: AbortSignal.timeout(10000) });
    const d = await r.json().catch(() => null);
    if (!d) throw new Error("Odoo answered HTTP " + r.status);
    if (d.error) throw new Error(String((d.error.data && d.error.data.message) || d.error.message || "Odoo error").slice(0, 200));
    return d.result;
  };
  const info = await rpc("/web/session/get_session_info", {});
  const kw = (model, method, args, kwargs = {}) => rpc("/web/dataset/call_kw/" + model + "/" + method, { model, method, args, kwargs });
  const close = () => rpc("/web/session/destroy", {}).catch(() => {});
  return { loginOk: true, loginFound: true, via: "monitor", base, db: String((info && info.db) || database || ""), kw, close };
}
