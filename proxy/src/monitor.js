// Audit & Deploy: the Odoo "Audit & Deployment System" add-on (log_monitor) inside the dashboard.
// Reads and actions call the same Odoo methods as the add-on's own Odoo screen, through the proxy's
// Odoo connection. Signed-in users and administrators have the same access.
//
// Every change is written to the dashboard's own log with the real person's name (store keys
// "mlog:seq" and "mlog:<n>"), and also to the add-on's audit log in Odoo ("via AION Team Control by <name>"),
// because Odoo itself records the action as the API account's user.

import { odoo, odooConfigured } from "./odoo.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const fail = (code, error, status) => json({ code, error }, status);
async function readJson(request) { try { return await request.json(); } catch { return null; } }

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/; // instance names like odoo503, dev-519t6, 519test9
const KEYED = /^[A-Za-z0-9._:/-]{1,200}$/;
const TEMPLATES = ["minimal", "standard", "performance"];
const ZONES = ["prod", "test", "development"];

// The dashboard's own log of Audit & Deploy actions.
export async function logAction(env, me, entry) {
  if (!env.STORE) return null;
  const id = await env.STORE.incr("mlog:seq");
  const row = { id, when: new Date().toISOString(), email: me.email, name: me.name || me.email, role: me.role, ...entry };
  await env.STORE.set("mlog:" + id, JSON.stringify(row));
  return row;
}
async function readLog(env, before, limit) {
  if (!env.STORE) return { entries: [], hasMore: false };
  const last = Number(await env.STORE.get("mlog:seq")) || 0;
  const start = Math.min(before ? Number(before) - 1 : last, last);
  const ids = [];
  for (let i = start; i > 0 && ids.length < limit; i--) ids.push(i);
  const rows = (await Promise.all(ids.map((i) => env.STORE.get("mlog:" + i)))).map((r) => { try { return r ? JSON.parse(r) : null; } catch { return null; } }).filter(Boolean);
  return { entries: rows, hasMore: ids.length === limit && ids[ids.length - 1] > 1 };
}

// Runs an action in Odoo and records it in both logs. A failure is recorded too.
async function act(env, me, { action, target, details, run }) {
  let result, error = "";
  try { result = await run(); }
  catch (err) { error = (err && err.message) || "Odoo error"; }
  const ok = !error && !(result && (result.error || result.error_message || result.success === false));
  if (!error && !ok) error = String(result.error || result.error_message || "The add-on refused the action.");
  await logAction(env, me, { action, target, details: details || "", result: ok ? "success" : "failure", error });
  try {
    await odoo(env, "monitor.audit.log", "log_from_frontend", [], {
      action_type: "other", target_name: String(target || ""), result: ok ? "success" : "failure", error_message: error,
      details: JSON.stringify({ via: "AION Team Control", by: me.name || me.email, email: me.email, action, details: details || "" })
    });
  } catch { /* The dashboard's own log already has the entry. */ }
  if (!ok) return fail("monitor", error, 502);
  return json({ ok: true, result: result ?? null });
}

const unwrap = (r) => r?.data || r?.result || r;

export async function monitorRoutes(request, env, url, me) {
  const path = url.pathname, method = request.method;
  if (!odooConfigured(env)) return fail("odoo_off", "Odoo isn't connected. See SETUP.md.", 501);
  if (method !== "GET" && !env.STORE) return fail("no_store", "Actions need the user database for the action log.", 501);
  const refresh = url.searchParams.get("refresh") === "1";
  const call = (model, m, args = [], kw = {}) => odoo(env, model, m, args, kw);

  try {
    // ---------- Reading ----------
    if (method === "GET") {
      if (path === "/monitor/instances") return json(await call("monitor.data.snapshot", "get_instances", [refresh]));
      let m = /^\/monitor\/instances\/([^/]+)\/(config|resources|addons|activity|pos-logs)$/.exec(path);
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (!NAME.test(name)) return fail("bad_request", "Unknown instance.", 400);
        if (m[2] === "config") return json(await call("monitor.data.snapshot", "get_instance_config", [name, refresh]));
        if (m[2] === "resources") return json(await call("monitor.data.snapshot", "get_instance_resources", [name, refresh]));
        if (m[2] === "addons") return json(await call("monitor.data.snapshot", "get_instance_addons", [name, null, refresh]));
        if (m[2] === "activity") return json(await call("monitor.data.snapshot", "get_recent_activity", [name, refresh]));
        return json(await call("pos.frontend.log.entry", "web_get_cached_pos_logs", [name, 200, null]));
      }
      if (path === "/monitor/test-envs") {
        const [envs, config] = await Promise.all([call("monitor.test.environment", "get_portal_test_environments"), call("monitor.test.environment", "get_dashboard_config").catch(() => ({}))]);
        return json({ envs: envs || [], maxActive: Number(config?.max_active_envs) || 10 });
      }
      if (path === "/monitor/test-envs/options") {
        const source = url.searchParams.get("source") || "", zone = url.searchParams.get("zone") || "test";
        if (!NAME.test(source) || !ZONES.includes(zone)) return fail("bad_request", "Choose a source instance and zone.", 400);
        const [dbs, capacity] = await Promise.all([call("monitor.test.environment", "get_instance_databases", [source]), call("file.hosting.service", "call_api", ["/api/v2/operations/capacity"]).then(unwrap)]);
        const targets = (capacity?.targets || []).filter((t) => t.enabled && t.status === "available" && (t.allowed_operations || []).includes("clone") && t.zone === zone)
          .map((t) => ({ id: t.id || t.key || t.name || t.path, label: t.display_name || t.path, zone: t.zone, freeGiB: Math.round(Number(t.resources?.effective_available_bytes ?? t.resources?.available_bytes ?? 0) / 1024 ** 3) }))
          .sort((a, b) => b.freeGiB - a.freeGiB);
        return json({ databases: dbs || [], targets, templates: TEMPLATES, zones: ZONES });
      }
      if (path === "/monitor/pipeline-runs") return json({ runs: await call("monitor.pipeline.run", "search_read", [[]], { order: "create_date desc", limit: 50 }) });
      if (path === "/monitor/approvals") {
        const [access, unlock, expiry] = await Promise.all([call("monitor.database.access", "get_notifications"), call("monitor.addon.unlock.request", "get_notifications"), call("monitor.test.environment", "get_expiry_notifications")]);
        return json({ access, unlock, expiry });
      }
      if (path === "/monitor/odoo-audit") {
        const before = Number(url.searchParams.get("before")) || null;
        return json(await call("monitor.audit.log", "get_recent_actions", [], { before_id: before, limit: 50 }));
      }
      if (path === "/monitor/log") return json(await readLog(env, url.searchParams.get("before"), 50));
      return fail("not_found", "Not found.", 404);
    }

    // ---------- Changing (recorded with the real person's name) ----------
    const b = (await readJson(request)) || {};

    if (path === "/monitor/test-envs/reserve" && method === "POST") {
      if (!NAME.test(b.source || "") || !KEYED.test(b.target || "") || !ZONES.includes(b.zone)) return fail("bad_request", "Choose a source instance, zone and storage target.", 400);
      if (b.db && !KEYED.test(b.db)) return fail("bad_request", "Unknown database.", 400);
      const r = await call("monitor.test.environment", "reserve_test_env_target", [b.source, b.target, b.db || null, "aion-reserve-" + crypto.randomUUID().replace(/-/g, ""), b.zone]);
      return json({ token: r?.reservation_token || "", reservation: r?.reservation || null, estimate: r?.estimate || null, executionEnabled: Boolean(r?.execution_enabled) });
    }
    if (path === "/monitor/test-envs/release" && method === "POST") {
      if (KEYED.test(b.token || "")) { try { await call("monitor.test.environment", "release_test_env_target", [b.token]); } catch {} }
      return json({ ok: true });
    }

    if (path === "/monitor/test-envs" && method === "POST") {
      if (!NAME.test(b.source || "") || !KEYED.test(b.target || "") || !ZONES.includes(b.zone) || !KEYED.test(b.token || "")) return fail("bad_request", "Reserve a storage target first.", 400);
      if (!TEMPLATES.includes(b.template)) return fail("bad_request", "Choose a size.", 400);
      if (b.name && !/^[\w .-]{1,80}$/.test(b.name)) return fail("bad_request", "Use letters, numbers, spaces, dots and dashes in the name.", 400);
      const persistent = !!b.persistent, ttl = persistent ? 0 : Math.min(Math.max(Number(b.ttl) || 72, 1), 720);
      return act(env, me, {
        action: "Create test environment", target: b.source,
        details: [b.name || "", b.template, persistent ? "persistent" : ttl + "h", b.db || "", b.target, b.zone].filter(Boolean).join(" · "),
        run: async () => {
          const admission = await call("file.hosting.service", "call_api", ["/api/v2/operations/admission", "POST", { operation: "clone", target: b.target, required_gib: 10 }]);
          if (!admission || admission.error || admission.success === false) throw new Error(admission?.error || "Resource admission check failed.");
          const decision = admission?.admission?.decision;
          if (decision === "deny" || decision === "defer") throw new Error("Test clone " + (decision === "deny" ? "denied" : "deferred") + " by resource policy." + (admission.admission.reason ? " " + admission.admission.reason : ""));
          return call("monitor.test.environment", "create_test_env", [b.source, b.name || null, ttl, b.template, b.db || null, persistent, b.target, b.token, b.zone]);
        }
      });
    }

    let m = /^\/monitor\/test-envs\/(\d+)\/(refresh|extend|persistent|temporary|destroy)$/.exec(path);
    if (m && method === "POST") {
      const id = Number(m[1]);
      const [env0] = await call("monitor.test.environment", "search_read", [[["id", "=", id]]], { fields: ["name", "instance_name"], limit: 1 });
      if (!env0) return fail("not_found", "No such test environment.", 404);
      const target = env0.instance_name || env0.name;
      if (m[2] === "refresh") return act(env, me, { action: "Refresh test environment status", target, run: () => call("monitor.test.environment", "action_refresh_status", [[id]]) });
      if (m[2] === "extend") return act(env, me, { action: "Extend test environment by 24h", target, run: () => call("monitor.test.environment", "action_extend_ttl", [[id], 24]) });
      if (m[2] === "persistent") return act(env, me, { action: "Make test environment persistent", target, run: () => call("monitor.test.environment", "action_make_persistent", [[id]]) });
      if (m[2] === "temporary") {
        const hours = Math.min(Math.max(Number(b.hours) || 24, 1), 720);
        return act(env, me, { action: "Make test environment temporary", target, details: hours + "h", run: () => call("monitor.test.environment", "action_make_temporary", [[id], hours]) });
      }
      return act(env, me, { action: "Destroy test environment", target, run: () => call("monitor.test.environment", "action_destroy", [[id], "aion-destroy-" + crypto.randomUUID().replace(/-/g, "")]) });
    }

    m = /^\/monitor\/pipeline-runs\/(\d+)\/(approve|reject)$/.exec(path);
    if (m && method === "POST") {
      const id = Number(m[1]);
      return act(env, me, { action: (m[2] === "approve" ? "Approve" : "Reject") + " staging", target: "pipeline run " + id,
        run: () => call("monitor.pipeline.run", m[2] === "approve" ? "action_approve_staging" : "action_reject_staging", [id]) });
    }

    m = /^\/monitor\/approvals\/(access|unlock)\/(\d+)$/.exec(path);
    if (m && method === "POST") {
      if (!["approve", "deny"].includes(b.decision)) return fail("bad_request", "Choose approve or deny.", 400);
      const note = String(b.note || "").slice(0, 1000);
      const what = m[1] === "access" ? "database access" : "add-on unlock";
      return act(env, me, { action: (b.decision === "approve" ? "Approve " : "Deny ") + what, target: "request " + m[2], details: note,
        run: () => call(m[1] === "access" ? "monitor.database.access" : "monitor.addon.unlock.request", m[1] === "access" ? "decide_access" : "decide_unlock", [Number(m[2]), b.decision, note]) });
    }

    return fail("not_found", "Not found.", 404);
  } catch (err) {
    console.log("monitor error:", err && err.message);
    return fail("monitor", "Odoo: " + ((err && err.message) || "unknown error"), 502);
  }
}
