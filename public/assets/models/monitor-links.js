// Addresses on AI1 Monitor (monitor.ai1.host) that the dashboard links to.
const MONITOR_ORIGIN = "https://monitor.ai1.host";

// The page for one instance on AI1 Monitor, e.g. https://monitor.ai1.host/dashboard#instance/000/info
export const monitorInstanceUrl = (instance) => MONITOR_ORIGIN + "/dashboard#instance/" + encodeURIComponent(instance) + "/info";

// Opening that page from the dashboard: through AI1 Monitor's one-click sign-in (/auth/aione/start), the same as the
// sidebar link, so there's no Monitor login screen. "next" is the instance page to land on afterwards.
export const monitorOpenUrl = (instance) => MONITOR_ORIGIN + "/auth/aione/start?" + new URLSearchParams({ next: "/dashboard#instance/" + encodeURIComponent(instance) + "/info" });
