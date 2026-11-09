import { test, expect } from "@playwright/test";
import { jiraIssue } from "../fixtures/issues.js";

// The agreed hours in the ticket drawer: who Odoo gets them for, shown beside the field and checked before saving.
// Every request is intercepted; nothing here reaches Odoo, Jira or mail.
async function open(page, { developers, metadata = {}, reply } = {}) {
  const errors = [], sent = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "boss@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" }));
  });
  const values = { revision: 3, odooProjectId: null, clientId: null, billing: null, estimatedHours: 2, actualHours: null, workDone: "", loggedMinutes: 0, agreedHours: null, agreedDev: null, ...metadata };
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname, method = req.method(), body = req.postData() ? JSON.parse(req.postData()) : null;
    if (method !== "GET") sent.push({ path, method, body });
    const json = (v, status = 200) => route.fulfill({ status, json: v });
    if (path === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people: {}, devs: [], role: "admin", email: "boss@example.invalid", accounts: true, odoo: false, mail: false, ai: { enabled: false }, capabilities: ["ticket-business-v1", "agreed-hours-v1"] });
    if (path === "/jira/search") return json({ issues: [jiraIssue], isLast: true });
    if (path === "/internal") return json({ tickets: [] });
    if (path === "/date-requests") return json({ requests: [] });
    if (path === "/clients") return json({ revision: 1, entries: [] });
    if (path === "/ticket-metadata/batch") return json({ records: {} });
    if (path === "/ticket-metadata" && method === "GET") return json({ metadata: values, history: [], closed: false, ...(developers ? { agreedDevelopers: developers } : {}) });
    if (path === "/ticket-metadata" && method === "PUT") return reply ? json(...reply(body)) : json({ metadata: { ...values, ...body.fields, revision: values.revision + 1 } });
    return json({ code: "forbidden", error: "Unconfigured test request" }, 403);
  });
  await page.goto("http://127.0.0.1:4173/dashboard.html#AION-101");
  const fields = page.locator("#business-fields");
  await expect(fields.getByLabel("Agreed hours (administrators only)")).toBeVisible();
  return { errors, sent, fields, puts: () => sent.filter((s) => s.path === "/ticket-metadata") };
}
const save = (fields) => fields.getByRole("button", { name: "Save ticket fields" }).click();

test("Agreed hours, no developer: explained beside the field, refused before sending, the form keeps its values", async ({ page }) => {
  const s = await open(page, { developers: [] });
  const agreed = s.fields.getByLabel("Agreed hours (administrators only)");
  const note = s.fields.locator(".agreed-developer");
  await expect(note).toHaveText(/Add a developer to this ticket before setting agreed hours/);
  await expect(agreed).toHaveAttribute("aria-describedby", await note.getAttribute("id"));
  await agreed.fill("5");await s.fields.getByLabel("Work done").fill("Built the export");
  await save(s.fields);
  await expect(s.fields.locator("p.msg").last()).toContainText("Add a developer to this ticket before setting agreed hours");
  expect(s.puts()).toEqual([]);
  await expect(agreed).toHaveValue("5");await expect(s.fields.getByLabel("Work done")).toHaveValue("Built the export");
  // Other fields still save while the agreed hours stay as they were.
  await agreed.fill("");await save(s.fields);
  await expect(s.fields.locator("p.msg").last()).toContainText("Ticket fields saved.");
  expect(s.puts()[0].body.fields).toMatchObject({ revision: 3, workDone: "Built the export" });
  expect(Object.keys(s.puts()[0].body.fields).filter((k) => k.startsWith("agreed"))).toEqual([]);
  expect(s.errors).toEqual([]);
});

test("Agreed hours, one developer: says who Odoo gets them for; a refused save keeps the values", async ({ page }) => {
  const s = await open(page, { developers: [{ dev: "dana", name: "Dana Developer" }], reply: () => [{ code: "agreed_needs_developer", error: "Add a developer to this ticket first: the agreed hours go to Odoo as that developer’s work." }, 409] });
  await expect(s.fields.locator(".agreed-developer")).toHaveText("Odoo gets these hours as Dana Developer’s work.");
  await expect(s.fields.getByLabel("Agreed hours go to")).toHaveCount(0);
  await s.fields.getByLabel("Agreed hours (administrators only)").fill("5");
  await save(s.fields);
  await expect(s.fields.locator("p.msg").last()).toContainText("Add a developer to this ticket first");
  expect(s.puts()[0].body.fields.agreedHours).toBe(5);expect("agreedDev" in s.puts()[0].body.fields).toBe(false);
  await expect(s.fields.getByLabel("Agreed hours (administrators only)")).toHaveValue("5");
  expect(s.errors).toEqual([]);
});

test("Agreed hours, several developers: an explicit choice is required and sent", async ({ page }) => {
  const s = await open(page, { developers: [{ dev: "dana", name: "Dana Developer" }, { dev: "sam", name: "sam" }] });
  const to = s.fields.getByLabel("Agreed hours go to");
  await expect(to).toHaveValue("");
  await expect(to.locator("option")).toHaveText(["Choose developer…", "Dana Developer (dana)", "sam"]);
  await s.fields.getByLabel("Agreed hours (administrators only)").fill("5");
  await save(s.fields);
  await expect(s.fields.locator("p.msg").last()).toContainText("Choose who the agreed hours go to.");
  expect(s.puts()).toEqual([]);
  await to.selectOption("sam");await save(s.fields);
  await expect(s.fields.locator("p.msg").last()).toContainText("Ticket fields saved.");
  expect(s.puts()[0].body.fields).toMatchObject({ agreedHours: 5, agreedDev: "sam" });
  expect(s.errors).toEqual([]);
});

test("Agreed hours, several developers with an earlier choice: preselected, and changing only the developer sends it", async ({ page }) => {
  const s = await open(page, { developers: [{ dev: "dana", name: "Dana Developer" }, { dev: "sam", name: "sam" }], metadata: { agreedHours: 4, agreedDev: "dana" } });
  const to = s.fields.getByLabel("Agreed hours go to");
  await expect(to).toHaveValue("dana");
  await to.selectOption("sam");await save(s.fields);
  await expect(s.fields.locator("p.msg").last()).toContainText("Ticket fields saved.");
  expect(s.puts()[0].body.fields).toMatchObject({ agreedHours: 4, agreedDev: "sam" });
  expect(s.errors).toEqual([]);
});
