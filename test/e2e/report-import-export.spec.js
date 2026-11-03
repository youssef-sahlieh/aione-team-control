import { test, expect } from "@playwright/test";
import { buildWorkbook } from "../../public/assets/models/xlsx-write.js";

// Checks & Reports export and import against a synthetic proxy. Every request is intercepted; nothing here is real data.
const REPORT = {
  workflow: "all", generatedAt: new Date().toISOString(), coverage: { examined: 2 }, warnings: [],
  tickets: [
    { key: "AION-1", source: "jira", title: "First", status: "Open", clientId: "c1", clientName: "Acme", subClientId: null, subClientName: null, billing: "billable", devs: ["dana"], employees: [{ name: "Dana", hours: 2 }], estimatedHours: null, agreedHours: 4, loggedHours: 2, actualHours: 2, overage: "ok", created: "2026-10-01", createdInPeriod: true },
    { key: "AION-2", source: "jira", title: "Second", status: "Open", clientId: "c2", clientName: "Beta", subClientId: null, subClientName: null, billing: "", devs: [], employees: [], estimatedHours: null, agreedHours: null, loggedHours: 0, actualHours: 0, overage: "none", created: "2026-10-02" },
  ],
};

// ctl: previewDelay (ms) holds preview responses; importFailAt fails apply requests from that chunk index on.
async function open(page, role = "admin") {
  const errors = [], violations = [], posted = [], previewed = [], ctl = { previewDelay: 0, importFailAt: null };
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  await page.addInitScript((r) => {
    if (sessionStorage.getItem("aion-test-initialized")) return;
    sessionStorage.setItem("aion-test-initialized", "1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "boss@example.invalid", expiresAt: Date.now() + 3600000, role: r }));
  }, role);
  await page.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const json = (v, status = 200) => route.fulfill({ status, json: v });
    if (url.pathname === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people: {}, devs: [], role, email: "boss@example.invalid", accounts: true, odoo: false, mail: false, ai: { enabled: false }, capabilities: ["reports-saved-v1", "agreed-hours-v1", "ticket-bulk-import-v1"] });
    if (url.pathname === "/jira/search") return json({ issues: [] });
    if (url.pathname === "/internal") return json({ tickets: [] });
    if (url.pathname === "/date-requests") return json({ requests: [] });
    if (url.pathname === "/reports/latest" || url.pathname === "/reports/refresh") return json({ report: REPORT, stale: false });
    if (url.pathname === "/time-entries/report") return json({ rows: [], statuses: {} });
    if (url.pathname === "/ticket-metadata/import/preview") {
      previewed.push(JSON.parse(req.postData()).rows.length);
      if (ctl.previewDelay) await new Promise((resolve) => setTimeout(resolve, ctl.previewDelay));
      const rows = JSON.parse(req.postData()).rows.map((r, i) => r.key === "AION-9"
        ? { row: i + 1, line: r.line, key: r.key, title: "", status: "error", message: "Ticket not found or not visible.", changes: [] }
        : { row: i + 1, line: r.line, key: r.key, title: "T", status: "ok", message: "", changes: [{ field: "agreedHours", from: null, to: r.agreedHours }] });
      return json({ rows, ok: rows.filter((r) => r.status === "ok").length, unchanged: 0, errors: rows.filter((r) => r.status === "error").length });
    }
    if (url.pathname === "/ticket-metadata/import") {
      if (ctl.importFailAt !== null && posted.length >= ctl.importFailAt) return json({ code: "unavailable", error: "Synthetic failure" }, 500);
      posted.push(JSON.parse(req.postData()).rows); return json({ applied: posted.at(-1).length, unchanged: 0, failed: [] });
    }
    return json({ code: "forbidden", error: "Unconfigured test request" }, 403);
  });
  await page.goto("http://127.0.0.1:4173/dashboard.html?page=reports");
  return { errors, violations, posted, previewed, ctl };
}
const xlsx = async (rows) => Buffer.from(await buildWorkbook([{ name: "Tickets", columns: [{ header: "Ticket" }, { header: "Agreed hours", type: "hours" }], rows }]));
const openImport = async (page) => page.locator("summary", { hasText: "Import from Excel or CSV" }).click();
const input = (page) => page.locator('input[type="file"][aria-label="Spreadsheet to import"]');
const choose = async (page, rows, name = "good.xlsx") => input(page).setInputFiles({ name, mimeType: "application/octet-stream", buffer: await xlsx(rows) });
const previewButton = (page) => page.getByRole("button", { name: "Preview", exact: true });

test("Checks & Reports: Export Excel downloads a real .xlsx of the filtered tickets", async ({ page }) => {
  const seen = await open(page);
  await expect(page.getByRole("button", { name: "Export Excel" })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export Excel" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^aion-business-report-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const bytes = await (await import("node:fs/promises")).readFile(await download.path());
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  expect(seen.errors).toEqual([]);
  expect(seen.violations).toEqual([]);
});

test("Checks & Reports: import previews, blocks on errors, and applies a clean file", async ({ page }) => {
  const seen = await open(page);
  await openImport(page);
  await input(page).setInputFiles({ name: "bad.xlsx", mimeType: "application/octet-stream", buffer: await xlsx([["AION-1", 5], ["AION-9", 2]]) });
  await expect(page.getByLabel("Column for Ticket")).toHaveValue("0");
  await previewButton(page).click();
  await expect(page.getByText("1 rows will change · 0 already match · 1 with errors")).toBeVisible();
  await expect(page.getByText("Ticket not found or not visible.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Import preview, errors first" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply changes" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Download the rows with errors" })).toBeVisible();

  await choose(page, [["AION-1", 5], ["AION-2", 1.5]]);
  await previewButton(page).click();
  await expect(page.getByText("2 rows will change")).toBeVisible();
  await page.getByRole("button", { name: "Apply changes" }).click();
  await expect(page.getByText("Updated 2 tickets.", { exact: true })).toBeVisible();
  expect(seen.posted).toHaveLength(1);
  expect(seen.posted[0].map((r) => [r.key, r.agreedHours])).toEqual([["AION-1", 5], ["AION-2", 1.5]]);
  expect(seen.errors).toEqual([]);
  expect(seen.violations).toEqual([]);
});

test("Checks & Reports: a developer account does not get the bulk import", async ({ page }) => {
  await open(page, "user");
  await expect(page.locator("summary", { hasText: "Import from Excel or CSV" })).toHaveCount(0);
});

test("Checks & Reports: typing in the report search keeps the import file and preview", async ({ page }) => {
  const seen = await open(page);
  await openImport(page);
  await choose(page, [["AION-1", 5], ["AION-2", 1.5]]);
  await previewButton(page).click();
  await expect(page.getByText("2 rows will change")).toBeVisible();
  await page.getByLabel("Search report tickets").pressSequentially("First");
  await expect(page.getByText("Tickets: 1", { exact: true })).toBeVisible();
  await expect(page.getByText("2 rows will change")).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply changes" })).toBeEnabled();
  expect(seen.previewed).toEqual([2]);
  expect(seen.errors).toEqual([]);
});

test("Checks & Reports: a ticket repeated across preview chunks is rejected before any request", async ({ page }) => {
  const seen = await open(page);
  await openImport(page);
  // Row 2 and row 302 hold the same ticket (case differs): the second is in the second chunk of 300.
  const rows = [["AION-1", 1], ...Array.from({ length: 299 }, (_, i) => ["AION-" + (i + 10), 1]), ["aion-1", 2]];
  await choose(page, rows, "long.xlsx");
  await previewButton(page).click();
  await expect(page.getByText("AION-1 is on rows 2 and 302. Each ticket may appear once.")).toBeVisible();
  await expect(page.locator(".report-import-result")).toContainText("AION-1 is on rows 2 and 302");
  await expect(page.getByRole("button", { name: "Apply changes" })).toBeDisabled();
  expect(seen.previewed).toEqual([]);
  expect(seen.posted).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("Checks & Reports: two fields on one column disable Preview until fixed", async ({ page }) => {
  await open(page);
  await openImport(page);
  await choose(page, [["AION-1", 5]]);
  await expect(page.getByLabel("Column for Ticket")).toHaveValue("0");
  await page.getByLabel("Column for Agreed hours").selectOption("0");
  await expect(page.getByText(/is chosen for both Ticket and Agreed hours/)).toBeVisible();
  await expect(previewButton(page)).toBeDisabled();
  await page.getByLabel("Column for Agreed hours").selectOption("1");
  await expect(page.getByText(/is chosen for both/)).toHaveCount(0);
  await expect(previewButton(page)).toBeEnabled();
});

test("Checks & Reports: a preview that finishes after the mapping changed cannot enable Apply", async ({ page }) => {
  const seen = await open(page);
  await openImport(page);
  await choose(page, [["AION-1", 5], ["AION-2", 1.5]]);
  seen.ctl.previewDelay = 800;
  await previewButton(page).click();
  await page.getByLabel("Column for Agreed hours").selectOption("-1");
  await page.waitForTimeout(1200);
  await expect(page.getByText(/rows will change/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Apply changes" })).toBeDisabled();
  expect(seen.posted).toEqual([]);
});

test("Checks & Reports: a failed apply reports the rows saved before it stopped", async ({ page }) => {
  const seen = await open(page);
  await openImport(page);
  await choose(page, Array.from({ length: 301 }, (_, i) => ["AION-" + (i + 1000), 1]), "many.xlsx");
  await previewButton(page).click();
  await expect(page.getByText("301 rows will change")).toBeVisible();
  seen.ctl.importFailAt = 1;
  await page.getByRole("button", { name: "Apply changes" }).click();
  await expect(page.locator(".report-import-result")).toContainText("Before this stopped: 300 tickets updated.");
  expect(seen.posted).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Apply changes" })).toBeDisabled();
  expect(seen.errors).toEqual([]);
});
