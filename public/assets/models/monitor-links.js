// Addresses on AI1 Monitor (monitor.ai1.host) that the dashboard links to.
const MONITOR_ORIGIN = "https://monitor.ai1.host";

// The page for one instance on AI1 Monitor, e.g. https://monitor.ai1.host/dashboard#instance/000/info
export const monitorInstanceUrl = (instance) => MONITOR_ORIGIN + "/dashboard#instance/" + encodeURIComponent(instance) + "/info";
