// Starts Odoo's own Audit & Deploy screen (the log_monitor add-on's "Monitoring Dashboard") in this page.
// Odoo's front-end code is loaded from Odoo; its data calls are sent to the AION proxy, which runs them with
// the Odoo API key (add-on data only) and logs every change with the signed-in person's name.
import { api, getSession, signOut } from "./session.js";

const ODOO = window.AIONE_ODOO || "https://kadis.odoo.com";
const $ = (id) => document.getElementById(id);
const state = (text, isErr) => { const s = $("ad-state"); s.hidden = !text; s.className = "ad-state" + (isErr ? " err" : ""); s.textContent = text || ""; };

const load = (tag, attrs) => new Promise((resolve, reject) => {
  const e = document.createElement(tag);
  Object.assign(e, attrs);
  e.onload = resolve;
  e.onerror = () => reject(new Error("Couldn't load " + (attrs.src || attrs.href)));
  document.head.appendChild(e);
});

// Services that need a real Odoo browser session (live updates, chat, menus, tours): not started here.
const SKIP_SERVICES = /^(bus_service|bus\.|multi_tab|presence|im_status|mail\.|discuss|out_of_focus|web_tour|tour_service|menu|home_menu|commandService|command|profiling|debug|website|knowledge|spreadsheet|iot|voip|calendar|hr_|legacy_|pos|sms|snailmail|mail|bus|web_studio|studio|documents|account|sale|stock|crm|project|timesheet|planning|helpdesk|appointment|livechat|im_livechat|portal|onboarding|digest|barcode|pwa|webclient_|user_menus|company_switcher)/;

async function start() {
  const s = getSession();
  if (!s) return signOut(true);
  $("ad-me").textContent = s.email;

  // 1. Session information for Odoo's code: Odoo's settings, with the dashboard person's name.
  const info = await api("/monitor/odoo/session");
  info.translationURL = window.AIONE_API + "/monitor/odoo/translations";
  window.odoo = Object.assign(window.odoo || {}, { __session_info__: info, debug: "" });

  // 2. Odoo's styles and code (always the version currently installed in Odoo).
  state("Loading Odoo's Audit & Deploy code…");
  await Promise.all([
    load("link", { rel: "stylesheet", href: ODOO + "/web/assets/_/web.assets_backend.min.css" }),
    load("script", { src: ODOO + "/web/assets/_/web.assets_backend.min.js" })
  ]);
  const L = window.odoo.loader;
  if (L.checkErrorProm) await L.checkErrorProm;
  const mod = (name) => { const m = L.modules.get(name); if (!m) throw new Error("Odoo module missing: " + name); return m; };

  // 3. Every data call goes to the proxy instead of an Odoo browser session.
  const rpcMod = mod("@web/core/network/rpc");
  rpcMod.rpc._rpc = function (url, params = {}) {
    const run = async () => {
      let r;
      try {
        r = url.startsWith("/web/dataset/call_kw")
          ? await api("/monitor/odoo/rpc", { method: "POST", body: { model: params.model, method: params.method, args: params.args || [], kwargs: params.kwargs || {} } })
          : await api("/monitor/odoo/route", { method: "POST", body: { path: url, params } });
      } catch (err) {
        throw rpcMod.makeErrorFromResponse({ code: 200, message: err.message, data: { name: "odoo.exceptions.UserError", message: err.message, arguments: [err.message] } });
      }
      if (r.error) throw rpcMod.makeErrorFromResponse(r.error);
      return r.result;
    };
    const p = run();
    p.abort = () => {};
    return p;
  };

  // Links inside the screen that point to Odoo pages (/odoo/..., /web/...) open in Odoo itself.
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (/^\/(odoo|web)(\/|$|\?|#)/.test(href)) { e.preventDefault(); window.open(ODOO + href, "_blank", "noopener"); }
  }, true);
  // Odoo profile pictures need an Odoo sign-in: show initials instead.
  const initials = (name) => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
  const avatar = (name) => "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#714b67"/><text x="32" y="41" font-family="sans-serif" font-size="26" fill="#fff" text-anchor="middle">' + initials(name) + "</text></svg>");
  const fixImages = (root) => root.querySelectorAll?.('img[src^="/web/image"]').forEach((img) => { img.src = avatar(info.name); });
  new MutationObserver((list) => list.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) { if (n.matches?.('img[src^="/web/image"]')) n.src = avatar(info.name); fixImages(n); } }))).observe(document.body, { childList: true, subtree: true });
  const realOpen = window.open.bind(window);
  window.open = (u, ...rest) => realOpen(typeof u === "string" && /^\/(odoo|web)(\/|$|\?|#)/.test(u) ? ODOO + u : u, ...rest);

  // 4. Start the Odoo services the screen needs, then show the screen itself.
  state("Starting…");
  const { registry } = mod("@web/core/registry");
  const services = registry.category("services");
  for (const [name] of services.getEntries()) if (SKIP_SERVICES.test(name)) services.remove(name);
  // Also skip services that depend on a skipped one.
  for (let changed = true; changed;) {
    changed = false;
    const present = new Set(services.getEntries().map(([n]) => n));
    for (const [name, svc] of services.getEntries()) if ((svc.dependencies || []).some((d) => !present.has(d))) { services.remove(name); changed = true; }
  }
  const { makeEnv, startServices, mountComponent } = mod("@web/env");
  const env = makeEnv();
  await startServices(env);
  const { MainComponentsContainer } = mod("@web/core/main_components_container");
  await mountComponent(MainComponentsContainer, document.body, { env });
  const MonitorApp = registry.category("actions").get("log_monitor.monitor_app");
  const action = { id: 1463, type: "ir.actions.client", tag: "log_monitor.monitor_app", name: "Monitoring Dashboard", context: {}, params: {}, target: "current" };
  await mountComponent(MonitorApp, $("ad-app"), { env, props: { action, actionId: 1463, updateActionState: () => {}, className: "o_action" } });
  state("");
}

start().catch((err) => { console.error(err); state("Audit & Deploy couldn't start: " + (err.message || err), true); });
