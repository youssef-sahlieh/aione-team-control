// Runs Odoo's own Audit & Deploy screen (log_monitor) inside the dashboard. The page loads the add-on's
// real front-end code from Odoo; its data calls come here instead of to Odoo's web session, and the proxy
// runs them with the Odoo API key. Only the add-on's own models are reachable, so nothing else in Odoo is.
//
// Every call that changes something is recorded in the dashboard's action log (see monitor.js) with the
// signed-in person's name, and the add-on's own audit entries get "by <name>" added.

import { odoo, odooConfigured } from "./odoo.js";
import { logAction } from "./monitor.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const fail = (code, error, status) => json({ code, error }, status);
async function readJson(request) { try { return await request.json(); } catch { return null; } }

// The add-on's models (log_monitor) and the two helpers its screen calls.
export const APP_MODELS = new Set([
  "file.hosting.service", "log.monitor.customer", "log.monitor.flush.service", "log.monitor.log.repository", "log.monitor.tenant.sync",
  "monitor.addon.unlock.request", "monitor.addon.version", "monitor.audit.log", "monitor.dashboard", "monitor.data.snapshot",
  "monitor.database.access", "monitor.github.identity", "monitor.github.oauth.attempt", "monitor.github.webhook.delivery",
  "monitor.instance", "monitor.instance.custom", "monitor.pipeline.run", "monitor.settings", "monitor.shared.addon",
  "monitor.test.environment", "odoo.docker.instance", "odoo.service", "pos.frontend.log.entry", "setup.preset",
  "deployment.wizard", "log.monitor.log.line", "log.monitor.log.wizard", "monitor.instance.logs"
]);
// Outside the add-on, only these read-only lookups (people's names in pickers).
const READ_ONLY_OTHER = { "res.users": ["search_read", "read", "name_search", "web_search_read", "search_count"], "res.partner": ["read", "name_search"] };
const SAFE_USER_FIELDS = ["id", "name", "display_name", "login", "email", "active", "share"];

// Calls that only read; everything else is logged as an action.
const READ_METHOD = /^(get_|search|read|web_read|web_search_read|name_search|fields_get|list_|dashboard_status|web_get_|preview_|check_|estimate|default_get|onchange|has_|is_|can_|count)/;
const isRead = (model, method, args) => {
  if (model === "file.hosting.service" && method === "call_api") return !args[1] || String(args[1]).toUpperCase() === "GET";
  // The screen's own audit entries (views and the like) go to Odoo's log with the real name, not the action log.
  if (model === "monitor.audit.log" && method === "log_from_frontend") return true;
  return READ_METHOD.test(method);
};
const describe = (model, method, args, kwargs) => {
  if (model === "file.hosting.service" && method === "call_api") return { action: String(args[1] || "GET").toUpperCase() + " " + String(args[0] || ""), details: JSON.stringify(args[2] || {}).slice(0, 500) };
  return { action: model + "." + method, details: JSON.stringify({ args, kwargs }).slice(0, 500) };
};

// The add-on writes its own audit entries as the API account. Right after a call, the entries it just
// wrote under that account get the real person's name ("Name (via AION)"); user_id stays the API account.
let apiUser = null;
async function nameAuditEntries(env, me, since) {
  try {
    if (!apiUser) apiUser = (await odoo(env, "res.users", "search_read", [[["login", "=", env.ODOO_LOGIN]]], { fields: ["id", "name"], limit: 1 }))[0];
    if (!apiUser) return;
    // Entries made through the API have no IP address or browser; the account owner's own Odoo use always has both.
    const ids = await odoo(env, "monitor.audit.log", "search", [[["create_date", ">=", since], ["user_id", "=", apiUser.id], ["user_name", "in", [apiUser.name, false, ""]], ["ip_address", "=", false]]], { limit: 20 });
    if (ids.length) await odoo(env, "monitor.audit.log", "write", [ids, { user_name: (me.name || me.email) + " (via AION)" }]);
  } catch (err) {
    console.log("audit name update skipped:", err && err.message);
  }
}

// Odoo's web code expects the session information Odoo normally puts in its pages.
let companyCache = { at: 0, data: null };
async function sessionInfo(env, me) {
  if (!companyCache.data || Date.now() - companyCache.at > 3600000) {
    const users = await odoo(env, "res.users", "search_read", [[["login", "=", env.ODOO_LOGIN]]], { fields: ["id", "partner_id", "company_id", "company_ids", "tz", "lang"], limit: 1 });
    const u = users[0];
    const companies = await odoo(env, "res.company", "search_read", [[["id", "in", u.company_ids]]], { fields: ["id", "name", "sequence", "currency_id", "parent_id", "child_ids"] }).catch(() => []);
    const currencyIds = [...new Set(companies.map((c) => c.currency_id && c.currency_id[0]).filter(Boolean))];
    const currencies = currencyIds.length ? await odoo(env, "res.currency", "read", [currencyIds], { fields: ["id", "symbol", "position", "decimal_places"] }).catch(() => []) : [];
    companyCache = { at: Date.now(), data: { u, companies, currencies } };
  }
  const { u, companies, currencies } = companyCache.data;
  const allowed = Object.fromEntries(companies.map((c) => [c.id, { id: c.id, name: c.name, sequence: c.sequence, child_ids: c.child_ids || [], parent_id: c.parent_id ? c.parent_id[0] : false, currency_id: c.currency_id ? c.currency_id[0] : false }]));
  const current = Array.isArray(u.company_id) ? u.company_id[0] : companies[0]?.id;
  const lang = "en_US";
  const version = await odoo(env, "ir.module.module", "search_read", [[["name", "=", "base"]]], { fields: ["latest_version"], limit: 1 }).then((r) => r[0]?.latest_version || "18.0").catch(() => "18.0");
  return {
    uid: u.id, is_system: true, is_admin: true, is_internal_user: true, is_public: false,
    // The person signed in to the dashboard, shown by the add-on's screen.
    name: me.name || me.email, username: me.email, partner_display_name: me.name || me.email, partner_id: Array.isArray(u.partner_id) ? u.partner_id[0] : false,
    user_context: { lang, tz: u.tz || "UTC", uid: u.id, allowed_company_ids: [current] },
    user_companies: { current_company: current, allowed_companies: allowed, disallowed_ancestor_companies: {} },
    currencies: Object.fromEntries(currencies.map((c) => [c.id, { symbol: c.symbol, position: c.position, digits: [69, c.decimal_places] }])),
    server_version: version, server_version_info: [18, 0, 0, "final", 0, "e"], db: env.ODOO_DB,
    home_action_id: false, show_effect: false, test_mode: false, profile_session: null, profile_collectors: null, profile_params: null,
    bundle_params: { lang, debug: "" }, cache_hashes: { translations: "aion", load_menus: "aion" }, max_file_upload_size: 4 * 1024 * 1024,
    groups: { "base.group_allow_export": true }, view_info: {}, web_tours: [], tour_enabled: false, storeData: {},
    translationURL: env.PUBLIC_PROXY_URL ? env.PUBLIC_PROXY_URL + "/monitor/odoo/translations" : "/monitor/odoo/translations"
  };
}

// Odoo's public translation data for the screen's texts. Odoo serves it without signing in, and the
// screen fetches it without our sign-in header, so this route is public too.
export async function odooTranslations(env, url) {
  if (!odooConfigured(env)) return fail("odoo_off", "Odoo isn't connected.", 501);
  const lang = /^[a-z]{2}(_[A-Z]{2})?$/.test(url.searchParams.get("lang") || "") ? url.searchParams.get("lang") : "en_US";
  const res = await fetch(String(env.ODOO_URL).replace(/\/+$/, "") + "/web/webclient/translations/aion?lang=" + lang, { signal: AbortSignal.timeout(20000) });
  return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}

export async function odooAppRoutes(request, env, url, me) {
  const path = url.pathname, method = request.method;
  if (!odooConfigured(env)) return fail("odoo_off", "Odoo isn't connected.", 501);

  if (path === "/monitor/odoo/session" && method === "GET") return json(await sessionInfo(env, me));

  if (path === "/monitor/odoo/rpc" && method === "POST") {
    const b = (await readJson(request)) || {};
    const model = String(b.model || ""), m = String(b.method || "");
    const args = Array.isArray(b.args) ? b.args : [], kwargs = b.kwargs && typeof b.kwargs === "object" ? { ...b.kwargs } : {};
    if (!/^[a-z0-9_.]+$/.test(model) || !/^[a-zA-Z0-9_]+$/.test(m) || m.startsWith("_")) return fail("bad_request", "Bad call.", 400);
    const allowedOther = READ_ONLY_OTHER[model];
    if (!APP_MODELS.has(model) && !(allowedOther && allowedOther.includes(m))) return fail("forbidden", "Only Audit & Deploy data is available here (" + model + "." + m + ").", 403);
    if (allowedOther) {
      // Never hand out more than names and logins of other Odoo users.
      if (Array.isArray(kwargs.fields)) kwargs.fields = kwargs.fields.filter((f) => SAFE_USER_FIELDS.includes(f));
      else if (kwargs.specification && typeof kwargs.specification === "object") kwargs.specification = Object.fromEntries(Object.entries(kwargs.specification).filter(([f]) => SAFE_USER_FIELDS.includes(f)));
      else kwargs.fields = SAFE_USER_FIELDS.filter((f) => f !== "share");
      if (m === "read" && !kwargs.fields?.length) kwargs.fields = ["id", "name", "display_name"];
    }
    // The add-on's own audit entries from the screen get the real person's name.
    if (model === "monitor.audit.log" && m === "log_from_frontend") {
      let d = kwargs.details; try { d = typeof d === "string" ? JSON.parse(d) : d; } catch {}
      kwargs.details = JSON.stringify({ ...(d && typeof d === "object" ? d : { details: d }), via: "AION Team Control", by: me.name || me.email, email: me.email });
    }
    delete kwargs.context?.allowed_company_ids;
    const read = isRead(model, m, args);
    const startedAt = new Date(Date.now() - 2000).toISOString().slice(0, 19).replace("T", " ");
    try {
      let result = await odoo(env, model, m, args, kwargs);
      // The screen shows "who am I" from this call: show the dashboard person, not the API account.
      if (model === "monitor.audit.log" && m === "get_current_user_info" && result && typeof result === "object") result = { ...result, name: me.name || me.email, login: me.email };
      if (!read || (model === "monitor.audit.log" && m === "log_from_frontend")) await nameAuditEntries(env, me, startedAt);
      if (!read) {
        const failed = result && typeof result === "object" && (result.success === false || result.error || result.error_message);
        await logAction(env, me, { ...describe(model, m, args, kwargs), target: String((model === "file.hosting.service" ? (args[2] && (args[2].instance_name || (args[2].instances || [])[0])) : args[0]) || ""), result: failed ? "failure" : "success", error: failed ? String(result.error || result.error_message || "") : "" });
      }
      return json({ result: result === undefined ? null : result });
    } catch (err) {
      if (!read) await logAction(env, me, { ...describe(model, m, args, kwargs), target: String(args[0] ?? ""), result: "failure", error: (err && err.message) || "Odoo error" });
      return json({ error: { code: 200, message: "Odoo Server Error", data: { name: "odoo.exceptions.UserError", message: (err && err.message) || "Odoo error", arguments: [(err && err.message) || ""] } } });
    }
  }

  // The add-on's GitHub sign-in needs a personal Odoo session, which the dashboard doesn't have.
  if (path === "/monitor/odoo/route" && method === "POST") {
    const b = (await readJson(request)) || {};
    if (/^\/monitor\/github\/connection/.test(b.path || "")) return json({ result: { available: false, connected: false, status: "unavailable" } });
    return json({ error: { code: 200, message: "Not available", data: { name: "odoo.exceptions.UserError", message: "This needs Odoo itself: " + (b.path || ""), arguments: [] } } });
  }

  return fail("not_found", "Not found.", 404);
}
