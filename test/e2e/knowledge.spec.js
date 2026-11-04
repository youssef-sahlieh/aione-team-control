import { test, expect } from "@playwright/test";

// The knowledge base page against a fake proxy that keeps a small Odoo Knowledge in memory. Every request is intercepted.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function mockKnowledge(page) {
  const calls = [], errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.addInitScript(() => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "dev@example.invalid", expiresAt: Date.now() + 3600000, role: "user" }));
  });
  const odoo = {
    articles: [
      { id: 1, name: "Our Customers", parentId: null, sequence: 1, icon: "🗂️", category: "workspace", updatedAt: "2026-11-01 10:00:00", body: "<p>All customers.</p>" },
      { id: 2, name: "Suzumi", parentId: 1, sequence: 1, icon: "🍣", category: "workspace", updatedAt: "2026-11-01 10:00:00",
        body: '<h1>Suzume workflow</h1><p>Bottle <b>products</b> <a href="/odoo/knowledge/1">parent</a></p><img src="/web/image/41?access_token=t1" class="img-fluid" onerror="window.__xss=1"><script>window.__xss=2</script><pre>DEPOSIT = 1</pre>' },
      { id: 3, name: "My notes", parentId: null, sequence: 1, icon: "", category: "private", updatedAt: "2026-11-01 10:00:00", body: "" }
    ],
    next: 10
  };
  const tree = () => odoo.articles.map(({ body, ...a }) => a);
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname, body = req.postDataJSON() || {};
    calls.push({ path, body });
    const json = (v, status = 200) => route.fulfill({ status, json: v });
    if (path === "/knowledge/status") return json({ configured: true, odoo: true, canSetPassword: false });
    if (body.password !== "right-password-1") return json({ code: "wrong_password", error: "That password is not right." }, 403);
    if (path === "/knowledge/unlock") return json({ url: "https://odoo.example.invalid/odoo/knowledge", articles: tree() });
    if (path === "/knowledge/article") {
      const a = odoo.articles.find((x) => x.id === body.id);
      return json({ article: a, pictures: a.id === 2 ? { 41: "data:image/png;base64," + PNG } : {}, later: [] });
    }
    if (path === "/knowledge/save") {
      if (body.id) { Object.assign(odoo.articles.find((x) => x.id === body.id), { name: body.name, body: body.body, icon: body.icon, updatedAt: "2026-11-04 09:00:00" }); return json({ id: body.id, updatedAt: "2026-11-04 09:00:00", articles: tree() }); }
      const parent = odoo.articles.find((x) => x.id === body.parentId);
      const a = { id: odoo.next++, name: body.name, parentId: body.parentId || null, sequence: 9, icon: "", category: parent ? parent.category : "workspace", updatedAt: "2026-11-04 08:00:00", body: body.body };
      odoo.articles.push(a);
      return json({ id: a.id, articles: tree() });
    }
    if (path === "/knowledge/picture") return json({ id: 50, src: "/web/image/50?access_token=tok50", picture: "data:" + body.type + ";base64," + body.data });
    if (path === "/knowledge/search") return json({ ids: odoo.articles.filter((a) => a.body.includes(body.query)).map((a) => a.id) });
    if (path === "/knowledge/move") { odoo.articles.find((x) => x.id === body.id).parentId = body.parentId; return json({ id: body.id, articles: tree() }); }
    if (path === "/knowledge/trash") { odoo.articles = odoo.articles.filter((x) => x.id !== body.id); return json({ id: body.id, articles: tree() }); }
    return json({ code: "forbidden", error: "Unconfigured test request" }, 403);
  });
  return { calls, errors, odoo };
}

async function unlock(page) {
  await page.goto("/knowledge.html");
  await page.locator("#unlock-password").fill("right-password-1");
  await page.locator("#unlock-submit").click();
  await expect(page.locator("#kb-app")).toBeVisible();
}

test("the articles show as Odoo's tree, and an article shows with its pictures, made safe", async ({ page }) => {
  const mock = await mockKnowledge(page);
  await unlock(page);
  await expect(page.locator(".kb-section")).toHaveText(["Workspace", "Private"]);
  await expect(page.locator("#kb-tree")).toContainText("Our Customers");
  await expect(page.locator("#kb-tree")).toContainText("Suzumi"); // top-level articles start open
  await page.getByRole("button", { name: "Close Our Customers" }).click();
  await expect(page.locator("#kb-tree")).not.toContainText("Suzumi");
  await page.getByRole("button", { name: "Open Our Customers" }).click();

  await page.locator(".kb-node-name", { hasText: "Suzumi" }).click();
  await expect(page.locator("#kb-view-title")).toHaveText("Suzumi");
  await expect(page.locator("#kb-crumbs")).toContainText("Our Customers");
  await expect(page.locator("#kb-body h1")).toHaveText("Suzume workflow");
  await expect(page.locator("#kb-body pre")).toHaveText("DEPOSIT = 1");
  const img = page.locator("#kb-body img");
  await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/);
  expect(await img.evaluate((i) => i.naturalWidth)).toBe(1);
  await expect(img).not.toHaveAttribute("onerror", /.*/);
  await expect(page.locator("#kb-body a")).toHaveAttribute("href", "https://odoo.example.invalid/odoo/knowledge/1");
  await expect(page.locator("#kb-odoo")).toHaveAttribute("href", "https://odoo.example.invalid/odoo/knowledge/2");
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await page.locator("#kb-body script").count()).toBe(0);
  await img.click();
  await expect(page.locator("#kb-zoom")).toBeVisible();
  await page.locator("#kb-zoom").click();
  await expect(page.locator("#kb-zoom")).toBeHidden();
  expect(mock.errors).toEqual([]);
});

test("a nested article is added, written with a picture, and saved to Odoo as Odoo HTML", async ({ page }) => {
  const mock = await mockKnowledge(page);
  await unlock(page);
  await page.locator(".kb-node", { hasText: "Suzumi" }).hover();
  await page.getByRole("button", { name: "Add a nested article under Suzumi" }).click();
  await expect(page.locator("#kb-editor")).toBeVisible();
  expect(mock.calls.find((c) => c.path === "/knowledge/save").body).toMatchObject({ name: "Untitled", parentId: 2 });
  await expect(page.locator("#kb-edit-crumbs")).toContainText("Suzumi");
  await page.locator("#kb-edit-title").fill("Bottle deposits");
  await page.locator("#kb-edit-icon").fill("🍶");
  await page.locator("#kb-edit-body").click();
  await page.keyboard.type("Deposit rules");
  await page.locator('#kb-tools [data-arg="h2"]').click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Step one");
  await page.locator("#kb-file").setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
  await expect(page.locator("#kb-edit-msg")).toContainText("Picture added");
  expect(mock.calls.find((c) => c.path === "/knowledge/picture").body).toMatchObject({ articleId: 10, type: "image/png", data: PNG });
  await page.locator("#kb-save").click();
  await expect(page.locator("#kb-note")).toHaveText("Saved to Odoo.");

  const saved = mock.calls.filter((c) => c.path === "/knowledge/save").at(-1).body;
  expect(saved).toMatchObject({ id: 10, name: "Bottle deposits", icon: "🍶", updatedAt: "2026-11-04 08:00:00" });
  expect(saved.body).toContain("<h2>Deposit rules</h2>");
  expect(saved.body).toContain("Step one");
  expect(saved.body).toContain('src="/web/image/50?access_token=tok50"');
  expect(saved.body).not.toContain("data:image");
  expect(saved.body).not.toContain("data-aione");
  await expect(page.locator("#kb-view-title")).toHaveText("Bottle deposits");
  await expect(page.locator("#kb-body img")).toHaveAttribute("src", /^data:image\/png/);
  await expect(page.locator(".kb-node.on")).toContainText("Bottle deposits");

  // Editing an existing article keeps what this page can't show (styles, Odoo links) when it's saved.
  await page.locator(".kb-node-name", { hasText: "Suzumi" }).click();
  await page.locator("#kb-edit").click();
  await page.locator("#kb-edit-body h1").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" v2");
  await page.locator("#kb-save").click();
  await expect(page.locator("#kb-note")).toHaveText("Saved to Odoo.");
  const again = mock.calls.filter((c) => c.path === "/knowledge/save").at(-1).body;
  expect(again.body).toContain("<h1>Suzume workflow v2</h1>");
  expect(again.body).toContain('href="/odoo/knowledge/1"');
  expect(again.body).toContain('src="/web/image/41?access_token=t1"');
  expect(again.body).not.toContain("onerror");
  expect(again.body).not.toContain("<script");
  expect(mock.errors).toEqual([]);
});

test("search finds articles by their text; an article can be moved and sent to the trash", async ({ page }) => {
  const mock = await mockKnowledge(page);
  await unlock(page);
  await page.locator("#kb-search").fill("DEPOSIT");
  await expect(page.locator(".kb-node.hit")).toHaveText(/Suzumi/);
  await expect(page.locator("#kb-count")).toHaveText("1 found");
  await page.locator("#kb-search").fill("");

  await page.locator(".kb-node-name", { hasText: "Suzumi" }).click();
  await page.locator("#kb-move").click();
  await page.locator("#kb-move-to").selectOption("");
  await page.locator("#kb-move-ok").click();
  await expect(page.locator("#kb-note")).toHaveText("Moved in Odoo.");
  expect(mock.calls.find((c) => c.path === "/knowledge/move").body).toMatchObject({ id: 2, parentId: null });
  await expect(page.locator("#kb-tree > .kb-branch").first().locator(":scope > li")).toHaveCount(2);

  await page.locator("#kb-trash").click();
  await expect(page.locator("#kb-note")).toHaveText("Sent to Odoo's trash.");
  await expect(page.locator("#kb-tree")).not.toContainText("Suzumi");
  expect(mock.errors).toEqual([]);
});
