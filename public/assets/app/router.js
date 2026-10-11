export const PAGES = new Set(["overview", "tickets", "boards", "workload", "calendar", "history"]);
export function readRoute(url, admin) {
  const requested = url.searchParams.get("page");
  const allowed = PAGES.has(requested) && (admin || !["history", "workload"].includes(requested));
  const page = allowed ? requested : "tickets";
  const requestedMode = url.searchParams.get("mode");
  const modes = admin ? ["status", "dev", "assignee"] : ["status"];
  return { page, mode: modes.includes(requestedMode) ? requestedMode : "status" };
}
export function routeUrl(page, mode, current) {
  const url = new URL(current);
  url.searchParams.set("page", PAGES.has(page) ? page : "tickets");
  if (page === "boards" && mode) url.searchParams.set("mode", mode);
  else url.searchParams.delete("mode");
  return url;
}
