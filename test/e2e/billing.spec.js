import { test, expect } from "@playwright/test";
import { jiraIssue } from "../fixtures/issues.js";

// Billing (billing-v1) against a synthetic proxy: the Clients page columns, filter and project default, Billing setup,
// Allowances & alerts, the billable export and the ticket's billing section. Every request is intercepted; nothing
// here reaches Odoo, Jira or mail.
const row = (o) => ({ client: "Acme", company: "All in One", url: "https://odoo.example.invalid/web#id=" + o.odooId, linkable: true, pendingHours: 0, mapped: true,
  links: { projects: [], epics: [], helpdesk: false, tickets: { count: 0, byProject: {}, keys: [] } }, overHours: 0, missingClient: false, archived: false,
  ticketCount: 0, openTickets: 0, reviewTickets: 0, reviewKeys: [], lastWorkDate: null, usedPercent: null, allocatedHours: null, loggedHours: 0, remainingHours: null, status: "not_set",
  label: "Acme → " + o.name, assignable: true, blocked: null, ...o });
const billing = (o) => ({ default: "billable", actualMinutes: 600, billableMinutes: 600, chargeableMinutes: 600, unclassifiedMinutes: 0, pendingSyncMinutes: 0, status: "available", allowance: null, email: null, ...o });
const PROJECTS = [
  row({ odooId: 10, name: "Support pack", createdAt: "2026-06-01T09:00:00Z", billing: billing({ status: "overage", allowance: { consumedMinutes: 720, capacityMinutes: 600, remainingMinutes: 0, overageMinutes: 120 }, email: { status: "backlog", label: "Backlog (not sent)" } }) }),
  row({ odooId: 11, name: "Internal tools", createdAt: "2026-05-01T09:00:00Z", billing: billing({ default: "not_billable", status: "not_billable", billableMinutes: 0, chargeableMinutes: 0 }) }),
  row({ odooId: 12, name: "New site", createdAt: "2026-04-01T09:00:00Z", billing: billing({ default: null, status: "needs_setup", unclassifiedMinutes: 90 }) }),
];
const SETUP = { config: { revision: 2, classification: true, emails: "dry", fields: { project: "", task: "" }, values: { project: {}, task: {} }, quotationUrl: "" },
  mail: { mode: "dry", reason: "Alert emails are a dry run.", recipients: ["ops@example.invalid"], recipientsOk: true, recipientsProblem: "", serverSwitch: false },
  quotationDefault: "https://odoo.example.invalid/odoo/action-sale.action_quotations_with_onboarding", odoo: true,
  candidates: { project: [{ name: "x_billable", label: "Billable", type: "boolean", custom: true, selection: [] }], task: [{ name: "x_billing", label: "Billing", type: "selection", custom: true, selection: [{ value: "inh", label: "Inherit" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }] }] } };
const ALLOWANCE = { id: "a1", label: "Support 10h", kind: "package", kindLabel: "Commercial package", enabled: true, projectIds: [10], projects: [{ id: 10, label: "Acme → Support pack", billing: "billable" }],
  startDate: "2026-10-01", endDate: null, minutes: 600, openingMinutes: 0, saleOrderLineId: null, customer: { id: 1, name: "Acme" }, topUps: [], history: [{ at: "2026-10-01T08:00:00Z", by: { name: "Manager" }, type: "created" }],
  consumedMinutes: 720, capacityMinutes: 600, remainingMinutes: 0, overageMinutes: 120, usedPercent: 120, exhausted: true, status: "overage", alerts: [] };
const ALERT = { id: "a1:1", allowanceId: "a1", cycle: 1, status: "uncertain", statusLabel: "Delivery uncertain", createdAt: "2026-11-02T08:00:00Z", sentAt: null, attempts: 1, errors: [{ message: "Mail timed out" }], to: ["ops@example.invalid"], snapshot: { consumedMinutes: 720, capacityMinutes: 600 }, subject: "[AION] Allocated hours exhausted — Acme / Support 10h" };
const exportRow = (o) => ({ chargeId: "e1", kind: "entry", ticket: "AION-101", source: "jira", title: "Synthetic Jira task", date: "2026-11-03", projectId: 10, taskId: 70, worker: "Dana", description: "=cmd()", actualMinutes: 90, chargeableMinutes: 90,
  billing: { value: "billable", source: "project" }, origin: "actual", originLabel: "Actual work", state: "synced", syncLabel: "Saved in Odoo", coverage: "covered", coverageLabel: "Covered", exportedMinutes: 0, deltaMinutes: 90, exportState: "new", customer: "Acme", customerId: 1, project: "Support pack", allowanceId: "a1", ...o });

async function open(page, { exceptions = [], hash = "", capabilities = ["ticket-business-v1", "project-budget-v1", "billing-v1"] } = {}) {
  const errors = [], sent = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "boss@example.invalid", expiresAt: Date.now() + 3600000, role: "admin" }));
  });
  const projects = structuredClone(PROJECTS), defaults = { revision: 4, items: { 10: { billing: "billable" }, 11: { billing: "not_billable" } } };
  let ticket = { key: "AION-101", classification: true, override: null, revision: 3, recordRevision: 0, effective: { value: "billable", source: "project" }, project: { id: 10, label: "Acme → Support pack", billing: "billable" },
    allowanceId: null, allowances: [{ id: "a1", label: "Support 10h", kind: "package", onProject: true }], odooSync: { state: "not_configured" }, agreedHours: null, ledger: { consumedMinutes: 90, events: [{ at: "2026-11-03T10:00:00Z", type: "add", reason: "Billable work logged", from: 0, to: 90, delta: 90 }] }, history: [] };
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname, method = req.method(), body = req.postData() ? JSON.parse(req.postData()) : null;
    if (method !== "GET") sent.push({ path, method, body });
    const json = (v, status = 200) => route.fulfill({ status, json: v });
    if (path === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people: {}, devs: [], role: "admin", email: "boss@example.invalid", accounts: true, odoo: true, mail: false, ai: { enabled: false }, capabilities });
    if (path === "/jira/search") return json({ issues: [jiraIssue], isLast: true });
    if (path === "/internal") return json({ tickets: [] });
    if (path === "/date-requests") return json({ requests: [] });
    if (path === "/clients") return json({ revision: 1, entries: [] });
    if (path === "/clients/odoo-sync") return json({ odoo: true, changed: false, syncedAt: Date.parse("2026-11-03T08:00:00Z"), error: null });
    if (path === "/clients/odoo-projects/options") return json({ syncedAt: 1, projects: projects.map((p) => ({ id: p.odooId, name: p.name, clientName: "Acme", label: p.label, archived: false, missingClient: false, known: true })) });
    if (path === "/clients/needs-mapping") return json({ rows: [] });
    if (path === "/clients/odoo-projects") return json({ allocation: true, nearLimit: 0.8, unplacedPendingHours: 0, projects, billing: { scan: null } });
    if (path === "/ticket-metadata/batch") return json({ records: {} });
    if (path === "/ticket-metadata") return json({ metadata: { revision: 3, odooProjectId: 10, clientId: null, billing: null, estimatedHours: 2, actualHours: null, workDone: "", loggedMinutes: 0 }, history: [], closed: false });
    if (path === "/billing/projects" && method === "GET") return json(defaults);
    if (path === "/billing/projects" && method === "PUT") { defaults.revision++; projects.find((p) => p.odooId === body.odooId).billing.default = body.billing; return json(defaults); }
    if (path === "/billing/setup") return json(method === "PUT" ? { ...SETUP, config: { ...SETUP.config, ...body, revision: 3 } } : SETUP);
    if (path === "/billing/scan" && method === "GET") return json({ scan: { at: "2026-11-03T07:00:00Z", complete: true, read: 12, total: 12 } });
    if (path === "/billing/migration") return json({ ticketOverrides: { billable: 2, not_billable: 1, inherit: 40 }, projects: { classified: 2, active: 3, unclassified: [{ id: 12, label: "Acme → New site" }] }, last90Days: { actualMinutes: 6000, billableMinutes: 4800, unclassifiedMinutes: 90 } });
    if (path === "/billing/allowances" && method === "GET") return json({ revision: 5, kinds: {}, items: [ALLOWANCE] });
    if (path === "/billing/allowances") return json({ revision: 6, kinds: {}, items: [ALLOWANCE] });
    if (path === "/billing/alerts") return json({ mail: { mode: "dry", reason: "" }, items: [ALERT] });
    if (path === "/billing/alerts/resolve") return json({ alert: { ...ALERT, status: "sent", statusLabel: "Sent" } });
    if (path === "/billing/export/preview") return json({ query: {}, timeZone: "Asia/Jerusalem", rows: [exportRow()], tasks: [{ ticket: "AION-101", title: "Synthetic Jira task", customer: "Acme", project: "Support pack", taskId: 70, actualMinutes: 90, chargeableMinutes: 90, deltaMinutes: 90, entries: 1, origins: "Actual work", coverage: "Covered" }],
      totals: { rows: 1, actualMinutes: 90, chargeableMinutes: 90, deltaMinutes: 90 }, exceptions, warnings: [], finalizable: 1, fingerprint: "fp1" });
    if (path === "/billing/export/finalize") return json({ batch: { id: "B20261109-abc", status: "final", createdAt: "2026-11-09T09:00:00Z", by: { name: "Manager" }, query: { from: body.from, to: body.to }, totals: { rows: 1, chargeableMinutes: 90, deltaMinutes: 90 }, rows: [exportRow({ batchId: "B20261109-abc" })] } });
    if (path === "/billing/export/batches") return json({ items: [] });
    if (path === "/billing/ticket" && method === "GET") return json(ticket);
    if (path === "/billing/ticket" && method === "PUT") { ticket = { ...ticket, override: body.billing === "inherit" ? null : body.billing ?? ticket.override, allowanceId: "allowanceId" in body ? body.allowanceId : ticket.allowanceId, revision: ticket.revision + 1, effective: { value: body.billing === "not_billable" ? "not_billable" : "billable", source: body.billing && body.billing !== "inherit" ? "ticket" : "project" } }; return json(ticket); }
    return json({ code: "forbidden", error: "Unconfigured test request" }, 403);
  });
  await page.goto("http://127.0.0.1:4173/dashboard.html" + (hash ? hash : "?page=clients"));
  // The Work entries view is the default; the billing columns live in the projects table.
  if (!hash) {
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await expect(page.locator(".budget-table").first()).toBeVisible();
  }
  return { errors, sent };
}
const table = (page) => page.locator(".budget-table").first();
const rowOf = (page, name) => table(page).locator("tbody tr.budget-main", { has: page.getByRole("button", { name, exact: true }) });
async function fromMore(page, item) { await page.locator(".clients-more > summary").click(); await page.getByRole("button", { name: item, exact: true }).click(); }

test("Clients: billing columns, the billing filter and the project default", async ({ page }) => {
  const seen = await open(page);
  await expect(table(page).locator("thead th")).toHaveText(["Project", "Client", "Allocated", "Logged", "Remaining", "Budget status", "Open tickets", "Billing", "Billable consumed", "Actions"].map((t) => new RegExp("^" + t)));
  const pack = rowOf(page, "Support pack");
  await expect(pack.locator("td").nth(7)).toContainText("Billable");
  await expect(pack.locator("td").nth(8)).toContainText("12 h of 10 h");
  await expect(pack.locator("td").nth(8)).toContainText("Over allocation");
  await expect(pack.locator("td").nth(8)).toContainText("Backlog (not sent)");
  await expect(rowOf(page, "New site").locator("td").nth(7)).toContainText("Not classified");
  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.locator(".clients-page").getByLabel("Filter by billing").selectOption("unclassified");
  await expect(table(page).locator("tbody tr.budget-main")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(table(page).locator("tbody tr.budget-main")).toHaveCount(3);
  // The default, in the row's details.
  await rowOf(page, "New site").getByRole("button", { name: "More about New site" }).click();
  await page.getByLabel("Billing default for New site").selectOption("billable");
  await expect(page.locator(".clients-page .msg").first()).toContainText("Billing default saved");
  expect(seen.sent.find((s) => s.path === "/billing/projects")).toEqual({ path: "/billing/projects", method: "PUT", body: { revision: 4, odooId: 12, billing: "billable" } });
  expect(seen.errors).toEqual([]);
});

test("Clients without billing-v1 keep the old columns and no billing menu", async ({ page }) => {
  const seen = await open(page, { capabilities: ["ticket-business-v1", "project-budget-v1"] });
  await page.locator(".clients-more > summary").click();
  await expect(page.getByRole("button", { name: "Billing setup", exact: true })).toHaveCount(0);
  expect(seen.errors).toEqual([]);
});

test("Billing setup: mail status from the server, Odoo fields from fields_get, migration preview", async ({ page }) => {
  const seen = await open(page);
  await fromMore(page, "Billing setup");
  const d = page.getByRole("dialog", { name: "Billing setup" });
  await expect(d).toContainText("ops@example.invalid");
  await expect(d).toContainText("BILLING_ALERT_MAIL: off");
  await d.getByLabel("Task override field").selectOption("x_billing");
  await d.getByLabel("Odoo value “Inherit” means").selectOption("inherit");
  await d.getByLabel("Odoo value “Yes” means").selectOption("billable");
  await d.getByLabel("Odoo value “No” means").selectOption("not_billable");
  await d.getByRole("button", { name: "Save billing setup" }).click();
  await expect(d).toContainText("Billing setup saved.");
  const put = seen.sent.find((s) => s.path === "/billing/setup");
  expect(put.body).toMatchObject({ revision: 2, classification: true, emails: "dry", fields: { project: "", task: "x_billing" }, values: { task: { inh: "inherit", yes: "billable", no: "not_billable" } } });
  await d.getByRole("button", { name: "Preview switching on" }).click();
  await expect(d).toContainText("2 of 3 active");
  await expect(d).toContainText("Acme → New site");
  expect(seen.errors).toEqual([]);
});

test("Allowances & alerts: usage, an uncertain delivery is settled, a top-up needs a confirmation", async ({ page }) => {
  const seen = await open(page);
  await fromMore(page, "Allowances & alerts");
  const d = page.getByRole("dialog", { name: "Allowances & alerts" });
  await expect(d).toContainText("12h of 10h · 2h over");
  await expect(d).toContainText("Delivery uncertain");
  await d.getByRole("button", { name: "It was sent" }).click();
  expect(seen.sent.find((s) => s.path === "/billing/alerts/resolve").body).toEqual({ id: "a1:1", outcome: "sent" });
  await d.getByRole("button", { name: "Top up" }).click();
  await d.getByLabel("Hours added").fill("5");
  await d.getByLabel("No order line: the customer confirmed these hours").check();
  await d.getByLabel("Reference of the confirmation").fill("Email 9 Nov");
  page.route("**/billing/allowances/top-up", (r) => r.fulfill({ json: { revision: 6, items: [ALLOWANCE], rearmed: true } }));
  await d.getByRole("button", { name: "Add hours" }).click();
  await expect(d).toContainText("re-armed");
  expect(seen.errors).toEqual([]);
});

test("Billable export: exceptions block finalizing; a clean preview finalizes with its fingerprint", async ({ page }) => {
  let seen = await open(page, { exceptions: [{ kind: "unclassified", ticket: "AION-9", message: "AION-9: 30 min on 2026-11-02 is not classified." }] });
  await fromMore(page, "Billable export");
  let d = page.getByRole("dialog", { name: "Billable export" });
  await d.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(d).toContainText("AION-9: 30 min on 2026-11-02 is not classified.");
  await expect(d.getByRole("button", { name: "Finalize batch" })).toBeDisabled();
  await d.getByRole("button", { name: "Entry detail" }).click();
  await expect(d.locator(".billing-table")).toContainText("=cmd()");
  // The CSV neutralises formula text.
  const download = page.waitForEvent("download");
  await d.getByRole("button", { name: "Download entries CSV" }).click();
  const file = await (await download).createReadStream();
  const text = await new Promise((res) => { let s = ""; file.on("data", (c) => (s += c)); file.on("end", () => res(s)); });
  expect(text).toContain("\"'=cmd()\"");
  expect(seen.errors).toEqual([]);
});

test("Billable export: finalize sends the previewed fingerprint", async ({ page }) => {
  const seen = await open(page);
  await fromMore(page, "Billable export");
  const d = page.getByRole("dialog", { name: "Billable export" });
  await d.getByRole("button", { name: "Preview", exact: true }).click();
  page.once("dialog", (x) => x.accept());
  const download = page.waitForEvent("download");
  await d.getByRole("button", { name: "Finalize batch" }).click();
  expect((await download).suggestedFilename()).toBe("billable-B20261109-abc.csv");
  await expect(d).toContainText("B20261109-abc");
  expect(seen.sent.find((s) => s.path === "/billing/export/finalize").body).toMatchObject({ fingerprint: "fp1", project: null });
  expect(seen.errors).toEqual([]);
});

test("Ticket drawer: Inherit / Billable / Not billable, the effective value and its source", async ({ page }) => {
  const seen = await open(page, { hash: "#AION-101" });
  const section = page.locator(".billing-ticket");
  await expect(section).toContainText("Billable — from the project default");
  await expect(section).toContainText("Billable work logged");
  await section.getByLabel("Billing", { exact: true }).selectOption("not_billable");
  await section.getByRole("button", { name: "Save billing" }).click();
  await expect(page.locator(".billing-ticket")).toContainText("Not billable — set on the ticket");
  expect(seen.sent.find((s) => s.path === "/billing/ticket").body).toEqual({ key: "AION-101", revision: 3, billing: "not_billable" });
  // The older billing select is not shown twice.
  await expect(page.locator("#business-fields").getByLabel("Billing (administrators only)")).toHaveCount(0);
  expect(seen.errors).toEqual([]);
});
