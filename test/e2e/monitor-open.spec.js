import { test, expect } from "@playwright/test";

// A Databases "Open" link goes through AI1 Monitor's one-click sign-in, which passes through dashboard.html
// (?ai1-monitor=<state>). The Monitor's callback always lands on its home page, so the hand-off signs in in the
// background and then opens the instance page itself. Every request is intercepted; the Monitor is a fake.
const STATE = "s".repeat(32);

async function handOff(page, { next } = {}) {
  const monitor = [];
  await page.addInitScript(({ next }) => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "dev@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" }));
    if (next) localStorage.setItem("aione-monitor-next", JSON.stringify(next));
  }, { next: next && { ...next, at: next.at ?? Date.now() } });
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.origin === "https://monitor.ai1.host") {
      monitor.push({ path: url.pathname, hash: url.hash, navigation: req.isNavigationRequest() });
      return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>AI1 Monitor</title>Monitor" });
    }
    if (url.pathname === "/sso/monitor/code") return route.fulfill({ json: { code: "c".repeat(32), callback: "https://monitor.ai1.host/auth/aione/callback" } });
    return route.abort();
  });
  await page.goto("/dashboard.html?ai1-monitor=" + STATE);
  return monitor;
}

test("Open from Databases: signed in in the background, then the instance page opens", async ({ page }) => {
  const monitor = await handOff(page, { next: { page: "/dashboard#instance/odoo503/info" } });
  await page.waitForURL("https://monitor.ai1.host/dashboard#instance/odoo503/info");
  expect(monitor[0]).toMatchObject({ path: "/auth/aione/callback", navigation: false });
  expect(monitor.filter((m) => m.navigation).map((m) => m.path)).toEqual(["/dashboard"]);
});

test("the Monitor sign-in without an Open link (or with an old or odd one) goes to the callback as before", async ({ page }) => {
  for (const next of [null, { page: "/dashboard#instance/503/info", at: Date.now() - 5 * 60 * 1000 }, { page: "https://evil.example/dashboard#instance/1/info" }, { page: "/logout" }]) {
    const monitor = await handOff(page, { next });
    await page.waitForURL((u) => u.origin === "https://monitor.ai1.host");
    expect(monitor.map((m) => [m.path, m.navigation])).toEqual([["/auth/aione/callback", true]]);
    await page.goto("about:blank");
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
