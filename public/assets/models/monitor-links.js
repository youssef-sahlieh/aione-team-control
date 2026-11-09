// Addresses on AI1 Monitor (monitor.ai1.host) that the dashboard links to.
const MONITOR_ORIGIN = "https://monitor.ai1.host";

// The page for one instance on AI1 Monitor, e.g. https://monitor.ai1.host/dashboard#instance/000/info
export const monitorInstanceUrl = (instance) => MONITOR_ORIGIN + "/dashboard#instance/" + encodeURIComponent(instance) + "/info";

// Opening that page from the dashboard: through AI1 Monitor's one-click sign-in (/auth/aione/start), the same as the
// sidebar link, so there's no Monitor login screen. "next" is the instance page to land on afterwards.
export const monitorPagePath = (instance) => "/dashboard#instance/" + encodeURIComponent(instance) + "/info";
// AI1 Monitor's Open Odoo: signs into the instance's Odoo as its administrator with a one-use token, no password.
// The database is needed only when the instance has several (Monitor picks the only one by itself).
export const monitorOdooPath = (instance, database) => "/api/monitor/instances/" + encodeURIComponent(instance) + "/open-odoo" + (database ? "?" + new URLSearchParams({ database }) : "");
// Kept for the sign-in hand-off page (early.js), which opens it once signed in (within 2 minutes).
export function rememberMonitorPage(instance, page = monitorPagePath(instance)) {
  try { localStorage.setItem("aione-monitor-next", JSON.stringify({ page, at: Date.now() })); } catch { /* no storage: Monitor's home page */ }
}
export const monitorOpenUrl =(instance) => MONITOR_ORIGIN + "/auth/aione/start?" + new URLSearchParams({ next: "/dashboard#instance/" + encodeURIComponent(instance) + "/info" });
