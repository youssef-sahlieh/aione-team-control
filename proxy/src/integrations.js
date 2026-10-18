// API key health for administrators (GET /integrations): is each key accepted right now, and when does it
// expire? GitHub reports a token's expiry itself; Odoo (17+) keeps an expiry date on its API keys, read from
// the proxy's own Odoo user. Atlassian offers no way to read a token's expiry, so for Jira an administrator
// enters it on the Sync errors page (POST /integrations/expiry, kept as "keyexp:<id>"); the JIRA_TOKEN_EXPIRES
// and ODOO_KEY_EXPIRES settings (YYYY-MM-DD) also work.
import { githubConfigured } from "./github.js";
import { odoo, odooConfigured, odooUid } from "./odoo.js";

const WARN_DAYS = 14;
const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

// "ok" | "warning" | "error" and a sentence, from whether the key works and how long it has left.
export function keyStatus({ works, problem = "", expires = null, now = Date.now(), setting = "" }) {
  const when = expires ? Date.parse(String(expires).replace(" UTC", "Z").replace(" ", "T")) : NaN;
  const days = Number.isFinite(when) ? Math.ceil((when - now) / 86400000) : null;
  const expiresAt = Number.isFinite(when) ? new Date(when).toISOString() : null;
  if (!works) return { status: "error", message: problem || "The key was rejected.", expiresAt, days };
  if (days !== null && days <= 0) return { status: "error", message: "The key's expiry date has passed. Create a new key.", expiresAt, days };
  if (days !== null && days <= WARN_DAYS) return { status: "warning", message: "Expires in " + days + " day" + (days === 1 ? "" : "s") + ". Create a new key before then.", expiresAt, days };
  return { status: "ok", message: days !== null ? "Working · expires in " + days + " days." : "Working." + (setting ? " Set " + setting + " (YYYY-MM-DD) to be warned before it expires." : ""), expiresAt, days };
}

const saved = async (env, id) => { try { return (await env.STORE?.get("keyexp:" + id)) || ""; } catch { return ""; } };

async function checkJira(env) {
  const stored = await saved(env, "jira"), expires = stored || env.JIRA_TOKEN_EXPIRES || null;
  try {
    const res = await fetch(env.JIRA_SITE + "/rest/api/3/myself", { headers: { Authorization: "Basic " + btoa(env.JIRA_EMAIL + ":" + env.JIRA_API_TOKEN), Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    const problem = res.status === 401 ? "Jira rejected the API token: it has expired or was revoked. Create a new token and update JIRA_API_TOKEN." : res.status === 403 ? "The Jira account has no access." : !res.ok ? "Jira answered " + res.status + "." : "";
    return { ...keyStatus({ works: res.ok, problem, expires, setting: "" }), expirySource: stored ? "saved" : expires ? "setting" : null, canSetExpiry: true, ...(expires ? {} : { hint: "Atlassian doesn't share token expiry dates. See it at id.atlassian.com → Security → API tokens (signed in as " + env.JIRA_EMAIL + ") and enter it here." }) };
  } catch { return { ...keyStatus({ works: false, problem: "Jira can't be reached." }), canSetExpiry: true }; }
}

async function checkGithub(env) {
  try {
    const res = await fetch("https://api.github.com/rate_limit", { headers: { Authorization: "Bearer " + env.GITHUB_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "aion-team-control" }, signal: AbortSignal.timeout(8000) });
    const problem = res.status === 401 ? "GitHub rejected the token: it has expired or was revoked. Create a new token and update GITHUB_TOKEN." : !res.ok ? "GitHub answered " + res.status + "." : "";
    const expires = res.headers.get("github-authentication-token-expiration");
    return { ...keyStatus({ works: res.ok, problem, expires }), expirySource: expires ? "github" : null, ...(res.ok && !expires ? { hint: "This token has no expiry date." } : {}) };
  } catch { return keyStatus({ works: false, problem: "GitHub can't be reached." }); }
}

// The earliest expiry among the proxy user's Odoo API keys (one of them is the proxy's). Null when Odoo
// doesn't keep expiry dates (before Odoo 17) or none is set.
async function odooKeyExpiry(env) {
  try {
    const keys = await odoo(env, "res.users.apikeys", "search_read", [[["user_id", "=", await odooUid(env)]]], { fields: ["name", "expiration_date"] });
    const dates = (keys || []).map((k) => k.expiration_date).filter(Boolean).sort();
    return { count: (keys || []).length, earliest: dates[0] || null, withoutExpiry: (keys || []).filter((k) => !k.expiration_date).length };
  } catch { return null; }
}

async function checkOdoo(env) {
  try {
    await odoo(env, "res.users", "search_count", [[]]);
    const stored = await saved(env, "odoo"), auto = stored ? null : await odooKeyExpiry(env);
    const expires = stored || (auto && auto.earliest) || env.ODOO_KEY_EXPIRES || null;
    const hint = stored ? "" : auto && auto.earliest && auto.count > 1 ? "Earliest expiry among " + auto.count + " API keys of " + env.ODOO_LOGIN + " in Odoo." : auto && auto.count && !auto.earliest ? "Odoo keeps no expiry date for this key (it doesn't expire, or was made before Odoo 17)." : "";
    return { ...keyStatus({ works: true, expires }), expirySource: stored ? "saved" : auto && auto.earliest ? "odoo" : expires ? "setting" : null, canSetExpiry: !(auto && auto.earliest), ...(hint ? { hint } : {}) };
  } catch (e) {
    const text = String((e && e.message) || "");
    return keyStatus({ works: false, problem: /access|denied|auth|credential|login/i.test(text) ? "Odoo rejected the API key: it has expired or was revoked. Create a new key and update ODOO_API_KEY." : "Odoo can't be reached." });
  }
}

export async function integrationRoutes(request, env, me, path = "/integrations") {
  if (me.role !== "admin") return json({ code: "forbidden", error: "Only administrators can see the API keys' state." }, 403);
  // An administrator enters a key's expiry date (Jira's can't be read from Atlassian); empty clears it.
  if (path === "/integrations/expiry" && request.method === "POST") {
    let b = null; try { b = await request.json(); } catch {}
    if (!b || !["jira", "odoo"].includes(b.id) || !(b.date === "" || b.date === null || /^\d{4}-\d{2}-\d{2}$/.test(String(b.date)))) return json({ code: "bad_request", error: "Choose a key and a date (YYYY-MM-DD)." }, 400);
    if (!env.STORE) return json({ code: "no_store", error: "Saving needs the database." }, 501);
    if (b.date) await env.STORE.set("keyexp:" + b.id, String(b.date)); else await env.STORE.del("keyexp:" + b.id);
    return json({ ok: true });
  }
  const checks = [["jira", "Jira API token", checkJira, true], ["github", "GitHub token", checkGithub, githubConfigured(env)], ["odoo", "Odoo API key", checkOdoo, odooConfigured(env)]];
  const keys = await Promise.all(checks.filter((c) => c[3]).map(async ([id, name, check]) => ({ id, name, ...(await check(env)) })));
  return json({ checkedAt: new Date().toISOString(), keys });
}
