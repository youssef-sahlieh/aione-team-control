export const PAGES = new Set(["overview", "tickets", "workload", "calendar", "requests", "reports", "clients", "worklog", "errors", "analytics"]);
export function readRoute(url, admin) {
  const requested = url.searchParams.get("page")==="history"?"requests":url.searchParams.get("page");
  const allowed = !(url.searchParams.get("page")==="history"&&!admin)&&PAGES.has(requested) && (admin || !["workload", "reports", "clients", "analytics"].includes(requested));
  const page = allowed ? requested : "tickets";
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
