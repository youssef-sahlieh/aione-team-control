export const PAGES = new Set(["overview", "tickets", "workload", "calendar", "requests", "reports", "clients", "worklog", "errors", "analytics", "reviews"]);
// Pages paused for now: no sidebar link, badge or shortcut, and a direct link opens HIDDEN_FALLBACK instead. Their code,
// data and services stay in place. To bring a page back, remove its id here.
export const HIDDEN_PAGES = new Set(["workload", "reports", "analytics"]);
export const HIDDEN_FALLBACK = "clients";
export function readRoute(url, admin) {
  const asked = url.searchParams.get("page");
  const requested = asked==="history"?"requests":asked;
  const target = HIDDEN_PAGES.has(requested) ? HIDDEN_FALLBACK : requested;
  // Clients is administrator-only, so a developer who follows a hidden page's link still gets All tickets.
  const allowed = !(asked==="history"&&!admin)&&PAGES.has(target) && (admin || !["workload", "reports", "clients", "analytics"].includes(target));
  const page = allowed ? target : "tickets";
  const requestedMode = url.searchParams.get("mode");
  const modes = admin ? ["status", "dev", "assignee"] : ["status"];
  return { page, mode: modes.includes(requestedMode) ? requestedMode : "status" };
}
export function routeUrl(page, mode, current) {
  const url = new URL(current);
  url.searchParams.set("page", PAGES.has(page) ? page : "tickets");
  url.searchParams.delete("mode");
  if (page !== "analytics") for (const k of ["from", "to", "client", "dev", "source"]) url.searchParams.delete(k);
  return url;
}
