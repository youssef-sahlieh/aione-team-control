import { test, expect } from "@playwright/test";

// Users page against a synthetic proxy. Every request is intercepted; nothing real is touched.
const people = [
  { name: "Ada Admin", email: "ada@example.invalid", role: "admin", dev: "", hasPassword: true, lastLoginAt: null },
  { name: "Ben Builder", email: "ben@example.invalid", role: "user", dev: "builder", hasPassword: true, lastLoginAt: null },
  { name: "Cy Newcomer", email: "cy@example.invalid", role: "user", dev: "bashar.k", hasPassword: false, lastLoginAt: null }
];

async function mockUsers(page, { invited = true } = {}) {
  const posts = [], puts = [], errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.addInitScript(() => {
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "ada@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" }));
  });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    if (url.pathname === "/config") return route.fulfill({ json: { role: "admin", email: "ada@example.invalid", name: "Ada Admin", accounts: true, devs: ["builder", "bashar.k"], devColors: {}, odoo: false } });
    if (url.pathname === "/users" && route.request().method() === "GET") return route.fulfill({ json: { users: people } });
    if (url.pathname === "/users" && route.request().method() === "POST") {
      posts.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: invited ? { invited: true, user: { name: "New Person" } } : { invited: false, link: "https://aione-team-proxy.vercel.app/set?t=synthetic", user: { name: "New Person", email: "new@example.invalid", role: "user", dev: "builder", hasPassword: false } } });
    }
    if (url.pathname.startsWith("/users/") && route.request().method() === "PUT") { puts.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ status: 403, json: { code: "forbidden", error: "x" } });
  });
  return { posts, puts, errors };
}

test("the list says in plain words what each person can see, and search narrows it", async ({ page }) => {
  const m = await mockUsers(page);
  await page.goto("/users.html");
  await expect(page.locator("#count")).toHaveText("3 people");
  await expect(page.locator("#rows")).toContainText("Administrator: sees and changes every ticket");
  await expect(page.locator("#rows")).toContainText("User: sees the tickets for builder");
  await expect(page.locator("#rows")).not.toContainText("ai1_");
  await page.locator("#search").fill("cy");
  await expect(page.locator("#count")).toHaveText("1 of 3");
  await page.locator("#search").fill("nobody");
  await expect(page.locator("#empty")).toBeVisible();
  await page.locator("#search").fill("");
  await page.locator("#filter").selectOption("pending");
  await expect(page.locator("#rows .urow")).toHaveCount(1);
  expect(m.errors).toEqual([]);
});

test("invite a user from the dialog: the role card and developer choice are sent", async ({ page }) => {
  const m = await mockUsers(page);
  await page.goto("/users.html");
  await page.getByRole("button", { name: "Invite someone" }).click();
  await expect(page.locator("#person")).toBeVisible();
  await page.locator("#p-name").fill("New Person");
  await page.locator("#p-email").fill("new@example.invalid");
  await page.locator("#p-dev").selectOption("builder");
  await page.locator("#p-save").click();
  await expect(page.locator("#person")).toBeHidden();
  expect(m.posts).toEqual([{ name: "New Person", email: "new@example.invalid", role: "user", dev: "builder" }]);
  expect(m.errors).toEqual([]);
});

test("without email, the invite shows the link to send and the dialog switches to managing them", async ({ page }) => {
  const m = await mockUsers(page, { invited: false });
  await page.goto("/users.html");
  await page.getByRole("button", { name: "Invite someone" }).click();
  await page.locator("#p-name").fill("New Person");
  await page.locator("#p-email").fill("new@example.invalid");
  await page.locator("#p-dev").selectOption("builder");
  await page.locator("#p-save").click();
  await expect(page.locator("#p-link")).toBeVisible();
  await expect(page.locator("#p-title")).toHaveText("Manage New Person");
  await expect(page.locator("#p-remove")).toBeVisible();
  expect(m.posts.length).toBe(1);
});

test("managing someone: changing the role sends the update", async ({ page }) => {
  const m = await mockUsers(page);
  await page.goto("/users.html");
  await page.getByRole("button", { name: "Manage Ben Builder" }).click();
  await expect(page.locator("#p-title")).toHaveText("Manage Ben Builder");
  await expect(page.locator("#p-email")).toHaveAttribute("readonly", "");
  await page.locator('#p-role [data-role="admin"]').click();
  await page.locator("#p-save").click();
  await expect(page.locator("#person")).toBeHidden();
  expect(m.puts).toEqual([{ name: "Ben Builder", role: "admin", dev: "builder" }]);
});
