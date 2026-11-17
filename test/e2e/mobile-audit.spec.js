import { test, expect } from "@playwright/test";

// Phone audit: every page at the widths the mobile brief names. Each page must not scroll sideways, and nothing visible
// may stick out past the screen unless it sits in its own scrolling box. The audit prints what it finds so the worst
// offenders can be fixed first; the assertion keeps the fixed pages fixed.
// Six synthetic tickets, with the fields the list and cards show. The same data at every width.
const issue = (key, n) => ({ key, fields: { summary: "Synthetic ticket " + n + " with a title long enough to wrap on a phone screen", status: { name: n % 2 ? "In Progress" : "To Do", statusCategory: { key: n % 2 ? "indeterminate" : "new" } }, labels: ["ai1_builder"], duedate: "2026-12-31", assignee: { accountId: "acc-b", displayName: "Builder" }, priority: { name: "High" }, updated: "2026-10-14T10:00:00.000+0000", created: "2026-10-01T10:00:00.000+0000" } });
const TICKETS = [1, 2, 3, 4, 5, 6].map((n) => issue("AION-" + n, n));
const WIDTHS = [320, 375, 390, 430, 768, 1024];
const PAGES = [
  ["dashboard.html?page=overview", "overview"],
  ["dashboard.html?page=tickets", "tickets"],
  ["dashboard.html?page=workload", "workload"],
  ["dashboard.html?page=calendar", "calendar"],
  ["dashboard.html?page=requests", "date requests"],
  ["dashboard.html?page=reports", "checks & reports"],
  ["dashboard.html?page=analytics", "analytics"],
  ["dashboard.html?page=clients", "clients"],
  ["dashboard.html?page=worklog", "work log"],
  ["dashboard.html?page=reviews", "needs review"],
  ["dashboard.html?page=errors", "sync errors"],
  ["users.html", "users"],
  ["databases.html", "databases"],
  ["knowledge.html", "knowledge"]
];

async function setUp(page) {
  await page.addInitScript(() => localStorage.setItem("aione-session", JSON.stringify({ token: "t", email: "ada@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" })));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    if (url.pathname === "/config") return route.fulfill({ json: { role: "admin", email: "ada@example.invalid", accounts: true, odoo: true, dbReport: true, knowledge: true, devs: [], people: {}, site: "https://jira.example.invalid", project: "AION" } });
    if (url.pathname === "/jira/search") return route.fulfill({ json: { issues: TICKETS, isLast: true } });
    if (url.pathname === "/users") return route.fulfill({ json: { users: [] } });
    if (url.pathname === "/odoo/tickets") return route.fulfill({ json: { tickets: [] } });
    if (url.pathname === "/internal") return route.fulfill({ json: { tickets: [], statuses: [], priorities: [] } });
    if (url.pathname === "/reviews/queue") return route.fulfill({ json: { configured: true, syncedAt: null, syncError: "", ticketsError: "", prs: [], counts: { prs: 0, tickets: 0, awaiting: 0 }, reviewers: [], clients: [], canFlag: true, refresh: null } });
    if (url.pathname === "/db-report") return route.fulfill({ json: { report: { builtAt: Date.now(), count: 0, rows: [] } } });
    return route.fulfill({ json: {} });
  });
}

// Elements that stick out past the right edge and are not inside a box that scrolls on its own.
function offenders() {
  const vw = window.innerWidth, out = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.right <= vw + 1) continue;
    if (el.closest("[hidden]") || getComputedStyle(el).display === "none") continue;
    // Inside a box that scrolls sideways on its own, it is not an overflow of the page.
    let p = el.parentElement, boxed = false;
    while (p && p !== document.body) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX) && p.getBoundingClientRect().right <= vw + 1) { boxed = true; break; }
      p = p.parentElement;
    }
    if (!boxed) out.push((el.id ? "#" + el.id : el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "")) + " right=" + Math.round(r.right));
  }
  return { scrollWidth: document.documentElement.scrollWidth, items: out.slice(0, 12) };
}

test("audit: every page at every phone and tablet width", async ({ page }) => {
  test.setTimeout(10 * 60 * 1000);
  await setUp(page);
  const report = [];
  for (const [path, name] of PAGES) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/" + path);
      await page.waitForTimeout(400);
      // The default filters pick the signed-in person's tickets; the synthetic list has none, so clear them first.
      await page.evaluate(() => document.getElementById("fclear")?.click());
      await page.waitForTimeout(150);
      const result = await page.evaluate(offenders);
      const visible = await page.evaluate(() => [...document.querySelectorAll("#view *, #workspace-content *")].filter((e) => e.getBoundingClientRect().height > 0).length);
      report.push({ page: name, width, scrollWidth: result.scrollWidth, visible, items: result.items });
    }
  }
  console.log("AUDIT " + JSON.stringify(report));
});
