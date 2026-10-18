// API key health for administrators (GET /integrations): is each key accepted right now, and when does it
// expire? GitHub reports a token's expiry itself. Atlassian and Odoo don't, so their expiry dates come from
// the JIRA_TOKEN_EXPIRES and ODOO_KEY_EXPIRES settings (YYYY-MM-DD) when they are set.
import { githubConfigured } from "./github.js";
import { odoo, odooConfigured } from "./odoo.js";

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

async function checkJira(env) {
  try {
    const res = await fetch(env.JIRA_SITE + "/rest/api/3/myself", { headers: { Authorization: "Basic " + btoa(env.JIRA_EMAIL + ":" + env.JIRA_API_TOKEN), Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    const problem = res.status === 401 ? "Jira rejected the API token: it has expired or was revoked. Create a new token and update JIRA_API_TOKEN." : res.status === 403 ? "The Jira account has no access." : !res.ok ? "Jira answered " + res.status + "." : "";
    return keyStatus({ works: res.ok, problem, expires: env.JIRA_TOKEN_EXPIRES || null, setting: "JIRA_TOKEN_EXPIRES" });
  } catch { return keyStatus({ works: false, problem: "Jira can't be reached." }); }
}

async function checkGithub(env) {
  try {
    const res = await fetch("https://api.github.com/rate_limit", { headers: { Authorization: "Bearer " + env.GITHUB_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "aion-team-control" }, signal: AbortSignal.timeout(8000) });
    const problem = res.status === 401 ? "GitHub rejected the token: it has expired or was revoked. Create a new token and update GITHUB_TOKEN." : !res.ok ? "GitHub answered " + res.status + "." : "";
    return keyStatus({ works: res.ok, problem, expires: res.headers.get("github-authentication-token-expiration") });
  } catch { return keyStatus({ works: false, problem: "GitHub can't be reached." }); }
}

async function checkOdoo(env) {
  try {
    await odoo(env, "res.users", "search_count", [[]]);
    return keyStatus({ works: true, expires: env.ODOO_KEY_EXPIRES || null, setting: "ODOO_KEY_EXPIRES" });
  } catch (e) {
    const text = String((e && e.message) || "");
    return keyStatus({ works: false, problem: /access|denied|auth|credential|login/i.test(text) ? "Odoo rejected the API key: it has expired or was revoked. Create a new key and update ODOO_API_KEY." : "Odoo can't be reached." });
  }
}

export async function integrationRoutes(request, env, me) {
  if (me.role !== "admin") return json({ code: "forbidden", error: "Only administrators can see the API keys' state." }, 403);
  const checks = [["jira", "Jira API token", checkJira, true], ["github", "GitHub token", checkGithub, githubConfigured(env)], ["odoo", "Odoo API key", checkOdoo, odooConfigured(env)]];
  const keys = await Promise.all(checks.filter((c) => c[3]).map(async ([id, name, check]) => ({ id, name, ...(await check(env)) })));
  return json({ checkedAt: new Date().toISOString(), keys });
}
