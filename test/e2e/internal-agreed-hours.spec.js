import { test, expect } from "@playwright/test";

// Agreed hours on the New internal ticket form. Synthetic developers and tickets only: every request is intercepted,
// so nothing reaches Odoo, Jira or mail, and no work entry is created.
async function open(page, { role = "admin" } = {}) {
  const errors = [], posts = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((role) => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "boss@example.invalid", expiresAt: Date.now() + 3600000, role }));
  }, role);
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname, method = req.method();
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    if (method === "POST" && path === "/internal") posts.push(body);
    const json = (v, status = 200) => route.fulfill({ status, json: v });
    if (path === "/config") return json({
      site: "https://jira.example.invalid", project: "AION", people: {}, devs: ["rami", "sondos"],
      devNames: { rami: "Rami Ahmad", sondos: "Sondos Ali" }, role, dev: role === "admin" ? "" : "sondos",
      email: "boss@example.invalid", name: "Synthetic Admin", accounts: true, odoo: false, mail: false,
      ai: { enabled: false }, capabilities: ["ticket-business-v1", "agreed-hours-v1"],
    });
    if (path === "/jira/search") return json({ issues: [], isLast: true });
    if (path === "/internal" && method === "GET") return json({ tickets: [] });
    if (path === "/internal" && method === "POST") return json({ ticket: { key: "INT-900", summary: body.summary, devs: body.devs, status: "To Do", priority: "Medium", internal: true, assigneeName: "Youssef", metadata: body.metadata } }, 201);
    if (path === "/date-requests") return json({ requests: [] });
    if (path === "/clients") return json({ revision: 1, entries: [] });
    if (path === "/ticket-metadata/batch") return json({ records: {} });
    if (method === "GET") return json({ issues: [], tickets: [], isLast: true, records: {}, entries: [], requests: [], revision: 1 });
    return json({ code: "forbidden", error: "Unconfigured test request" }, 403);
  });
  await page.goto("http://127.0.0.1:4173/dashboard.html?page=tickets");
  return { errors, posts };
}

test("New internal ticket, administrator: agreed hours are optional and asked for after the developers are chosen", async ({ page }) => {
  const s = await open(page);
  await page.locator("#create-ticket").click();
  const pop = page.locator("#pop");
  const agreed = pop.getByLabel("Agreed hours (administrators only)");
  await expect(agreed).toBeVisible();
  await expect(pop.locator(".agreed-developer")).toHaveText(/Add a developer to this ticket/);
  // No developer yet: the form asks for one first, and keeps the typed values.
  await pop.locator(".fld").filter({ hasText: "Title" }).locator("input").fill("Agreed hours check");
  await agreed.fill("5");
  await pop.getByRole("button", { name: "Create ticket" }).click();
  await expect(pop.locator(".foot .msg")).toContainText("Pick at least one developer.");
  await expect(agreed).toHaveValue("5");
  await expect(pop.locator(".fld").filter({ hasText: "Title" }).locator("input")).toHaveValue("Agreed hours check");
  expect(s.posts).toEqual([]);
  expect(s.errors).toEqual([]);
});

test("New internal ticket, one developer: the hours go to that developer, and blank creates none", async ({ page }) => {
  const s = await open(page);
  await page.locator("#create-ticket").click();
  const pop = page.locator("#pop");
  await pop.locator(".fld").filter({ hasText: "Title" }).locator("input").fill("One developer");
  await pop.getByRole("button", { name: "ai1_rami" }).click();
  await expect(pop.locator(".agreed-developer")).toHaveText("Odoo gets these hours as Rami Ahmad’s work.");
  await expect(pop.getByLabel("Agreed hours go to")).toHaveCount(0);
  await pop.getByLabel("Agreed hours (administrators only)").fill("12.5");
  await pop.getByRole("button", { name: "Create ticket" }).click();
  await expect.poll(() => s.posts.length).toBe(1);
  expect(s.posts[0].devs).toEqual(["rami"]);
  expect(s.posts[0].metadata.agreedHours).toBe(12.5);
  expect("agreedDev" in s.posts[0].metadata).toBe(false);
  expect(s.errors).toEqual([]);
});

test("New internal ticket, several developers: a choice is required, options follow the developers, and a blank adds nothing", async ({ page }) => {
  const s = await open(page);
  await page.locator("#create-ticket").click();
  const pop = page.locator("#pop");
  await pop.locator(".fld").filter({ hasText: "Title" }).locator("input").fill("Two developers");
  await pop.getByRole("button", { name: "ai1_rami" }).click();
  await pop.getByRole("button", { name: "ai1_sondos" }).click();
  const to = pop.getByLabel("Agreed hours go to");
  await expect(to.locator("option")).toHaveText(["Choose developer…", "Rami Ahmad (rami)", "Sondos Ali (sondos)"]);
  // Blank agreed hours: nothing is sent for them, even with no recipient chosen.
  await pop.getByRole("button", { name: "Create ticket" }).click();
  await expect.poll(() => s.posts.length).toBe(1);
  expect(s.posts[0].devs).toEqual(["rami", "sondos"]);
  expect("agreedHours" in s.posts[0].metadata).toBe(false);
  expect(s.errors).toEqual([]);
});

test("New internal ticket, several developers: hours without a chosen recipient are refused and kept", async ({ page }) => {
  const s = await open(page);
  await page.locator("#create-ticket").click();
  const pop = page.locator("#pop");
  await pop.locator(".fld").filter({ hasText: "Title" }).locator("input").fill("Needs a recipient");
  await pop.getByRole("button", { name: "ai1_rami" }).click();
  await pop.getByRole("button", { name: "ai1_sondos" }).click();
  await pop.getByLabel("Agreed hours (administrators only)").fill("4");
  await pop.getByRole("button", { name: "Create ticket" }).click();
  await expect(pop.locator(".foot .msg")).toContainText("Choose who the agreed hours go to.");
  await expect(pop.getByLabel("Agreed hours (administrators only)")).toHaveValue("4");
  expect(s.posts).toEqual([]);
  // Choosing a recipient, then dropping to one developer: the note names that developer and no choice is sent.
  await pop.getByLabel("Agreed hours go to").selectOption("sondos");
  await pop.getByRole("button", { name: "ai1_rami" }).click();
  await expect(pop.locator(".agreed-developer")).toHaveText("Odoo gets these hours as Sondos Ali’s work.");
  await expect(pop.getByLabel("Agreed hours go to")).toHaveCount(0);
  // Back to two developers: the list is offered again, with nothing chosen, and the hours need a choice.
  await pop.getByRole("button", { name: "ai1_rami" }).click();
  await expect(pop.getByLabel("Agreed hours go to")).toHaveValue("");
  await pop.getByLabel("Agreed hours go to").selectOption("rami");
  await pop.getByRole("button", { name: "Create ticket" }).click();
  await expect.poll(() => s.posts.length).toBe(1);
  expect(s.posts[0].metadata).toMatchObject({ agreedHours: 4, agreedDev: "rami" });
  expect(s.errors).toEqual([]);
});
