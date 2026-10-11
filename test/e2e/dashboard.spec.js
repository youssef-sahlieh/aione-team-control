import { test, expect } from "@playwright/test";
import { jiraIssue, internalTicket, people } from "../fixtures/issues.js";

async function mockDashboard(page, { role = "admin", failure = false, expired = false, many = false, mutationFailure = false, assigneeTeam = false, aiDisabled = false, aiFailure = false } = {}) {
  await page.clock.setFixedTime(new Date("2026-10-11T09:00:00Z"));
  const calls = [], unexpected = [], errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ role, expired }) => {
    if(sessionStorage.getItem("aion-test-initialized"))return;
    sessionStorage.setItem("aion-test-initialized","1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "test@example.invalid", expiresAt: expired ? 1 : Date.now() + 3600000, role }));
    localStorage.setItem("aion.notify", "0");
    // Exercise the existing downgrade of a saved administrator view for users.
    if (role === "user") localStorage.setItem("aion.view", "dev");
  }, { role, expired });
  // Every external request is intercepted, including unexpected endpoints.
  // An unmatched request can never fall through to production Jira or mail.
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname, method = req.method(), body = req.postDataJSON();
    calls.push({ path, method, body });
    const json = value => route.fulfill({ json: value });
    if (path === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people:assigneeTeam?{...people,...Object.fromEntries(["karim","youssef","rami","razan"].map(key=>[key,{id:`test-${key}`,name:key[0].toUpperCase()+key.slice(1),ini:key[0].toUpperCase()}]))}:people, devs: ["builder", "reviewer"], role, dev: "builder", email: "test@example.invalid", accounts: true, mail: false, ai:{enabled:!aiDisabled,readOnly:true} });
    if(path==="/ai/chat")return aiFailure?route.fulfill({status:503,json:{code:"ai_unavailable",error:"AI service unavailable. Try again."}}):json({answer:"Review AION-101 first. AION-9999 is unverified. <img src=x onerror=alert(1)>",references:[{key:"AION-101",title:"Synthetic Jira task"}],readOnly:true});
    if (path === "/login") return json({token:"synthetic-token",email:"test@example.invalid",expiresAt:Date.now()+3600000,role});
    if (path === "/internal" && method === "GET") return json({ tickets: [internalTicket] });
    if (path === "/jira/search") {
      if (failure) return route.fulfill({ status: 503, json: { code: "jira", error: "Synthetic outage" } });
      const issues=assigneeTeam?["karim","youssef","rami","razan","someone"].map((key,n)=>({...jiraIssue,key:`AION-${201+n}`,fields:{...jiraIssue.fields,summary:`Task for ${key}`,assignee:{accountId:`test-${key}`,displayName:key[0].toUpperCase()+key.slice(1)}}})):many?Array.from({length:30},(_,n)=>({...jiraIssue,key:`AION-${101+n}`,fields:{...jiraIssue.fields,summary:`Synthetic Jira task ${n+1}`}})):[jiraIssue];
      return json({ issues: body.jql.includes("statusCategory = Done") ? [] : issues, isLast: true });
    }
    if (path.endsWith("/changelog")) return json({ changelog: { histories: [] } });
    if (path.endsWith("/transitions") && method === "GET") return json({ transitions: [{ id: "7", name: "Start", to: { name: "In Development", statusCategory: { key: "indeterminate" } } }, { id: "8", name: "Unavailable", isAvailable: false, to: { name: "Closed" } }] });
    if(mutationFailure&&method==="PUT")return route.fulfill({status:503,json:{code:"jira",error:"Synthetic save failure"}});
    unexpected.push({ path, method });
    return route.fulfill({ status: 403, json: { code: "forbidden", error: "Unconfigured test request" } });
  });
  return { calls, unexpected, errors };
}

for(const width of [320,1440])test(`AI panel retains session chat and links verified tickets at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});const mock=await mockDashboard(page);await page.goto("/dashboard.html?page=overview");
  await page.locator("#ai-launcher").click();await expect(page.locator("#ai-question")).toBeFocused();
  await page.getByRole("button",{name:"Review deadlines",exact:true}).click();await expect(page.locator("#ai-messages .ai-message-assistant")).toHaveCount(1);
  await expect(page.locator("#ai-messages img")).toHaveCount(0);await expect(page.locator("#ai-messages a")).toHaveCount(1);
  await page.keyboard.press("Escape");await expect(page.locator("#ai-panel")).toBeHidden();await expect(page.locator("#ai-launcher")).toBeFocused();
  await page.locator("#ai-launcher").click();await expect(page.locator("#ai-messages .ai-message-assistant")).toHaveCount(1);
  await page.locator("#ai-question").fill("Explain the comments");await page.locator("#ai-send").click();await expect(page.locator("#ai-messages .ai-message-assistant")).toHaveCount(2);
  const calls=mock.calls.filter(c=>c.path==="/ai/chat");expect(calls).toHaveLength(2);expect(calls[1].body.history).toHaveLength(2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`test-results/ai-chat-${width}.png`,fullPage:true});
  await page.locator("#ai-messages a").first().click();await expect(page.locator("#ai-panel")).toBeHidden();await expect(page.locator("#d-key")).toContainText("AION-101");await page.locator("#d-close").click();
  await page.locator("#ai-launcher").click();await page.locator("#ai-new").click();await expect(page.locator("#ai-messages .ai-message")).toHaveCount(0);await expect(page.locator("#ai-welcome")).toBeVisible();
  expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
test("developer AI suggestions omit team workload and failure preserves the question",async({page})=>{
  const mock=await mockDashboard(page,{role:"user",aiFailure:true});await page.goto("/dashboard.html");await page.locator("#ai-launcher").click();for(const button of await page.locator("[data-ai-admin]").all())await expect(button).toBeHidden();
  await expect(page.locator("#ai-scope")).toHaveText("Read-only help with your tickets");await expect(page.getByRole("button",{name:"Explain a ticket",exact:true})).toBeVisible();await expect(page.locator(".ai-prompts button:visible")).toHaveCount(3);
  await page.locator("#ai-question").fill("What should I work on?");await page.locator("#ai-send").click();await expect(page.locator("#ai-status")).toContainText("AI service unavailable");await expect(page.locator("#ai-question")).toHaveValue("What should I work on?");await expect(page.locator("#ai-send")).toBeEnabled();expect(mock.errors).toEqual([]);
});
test("manager AI exposes project and team options",async({page})=>{
  const mock=await mockDashboard(page);await page.goto("/dashboard.html");await page.locator("#ai-launcher").click();await expect(page.locator("#ai-scope")).toHaveText("Read-only tickets and team insights");
  for(const button of await page.locator("[data-ai-admin]").all())await expect(button).toBeVisible();await expect(page.locator("[data-ai-user]")).toBeHidden();
  await page.getByRole("button",{name:"Review project progress",exact:true}).click();await expect(page.locator("#ai-messages .ai-message-assistant")).toHaveCount(1);expect(mock.calls.find(c=>c.path==="/ai/chat").body.message).toContain("project progress");expect(mock.errors).toEqual([]);
});
test("unconfigured AI displays setup state without making chat requests",async({page})=>{
  const mock=await mockDashboard(page,{aiDisabled:true});await page.goto("/dashboard.html");await page.locator("#ai-launcher").click();await expect(page.locator("#ai-status")).toContainText("server configuration");await expect(page.locator("#ai-send")).toBeDisabled();await expect(page.locator("#ai-question")).toBeDisabled();
  await page.locator("#ai-close").focus();await page.keyboard.press("Tab");await expect(page.locator("#ai-new")).toBeFocused();expect(mock.calls.some(c=>c.path==="/ai/chat")).toBe(false);expect(mock.errors).toEqual([]);
});

for(const role of ["admin","user"])test(`${role} defaults to four assignees and includes Others only on selection`,async({page})=>{
  const mock=await mockDashboard(page,{role,assigneeTeam:true});await page.goto("/dashboard.html");
  await expect(page.locator("#view .item")).toHaveCount(4);
  await expect(page.locator("#view")).toContainText("Task for razan");
  await expect(page.locator("#view")).not.toContainText("Task for someone");
  const selector=page.getByRole("combobox",{name:"Assignee",exact:true});await expect(selector).toHaveValue("__team");
  await page.locator("#ftoggle").click();
  const others=page.locator("#fgrid .fsec.k4").getByRole("button",{name:/Others/});
  await expect(others).toHaveAttribute("aria-pressed","false");await others.click();await expect(page.locator("#view .item")).toHaveCount(6);
  await others.click();await expect(page.locator("#view .item")).toHaveCount(4);
  await selector.selectOption("other");await expect(page.locator("#view .item")).toHaveCount(2);await expect(page.locator("#view")).toContainText("Task for someone");
  page.once("dialog",d=>d.accept("Others only"));await page.getByRole("button",{name:"Save view",exact:true}).click();
  await page.locator("#fclear").click();await expect(page.locator("#view .item")).toHaveCount(4);
  await page.getByRole("combobox",{name:"Saved view",exact:true}).selectOption({label:"Others only"});await expect(page.locator("#view .item")).toHaveCount(2);
  expect(mock.calls.filter(c=>c.path==="/jira/search").every(c=>!c.body.jql.includes("assignee in"))).toBe(true);
  expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});

test("workspace pages navigate locally and browser Back restores page",async({page})=>{
  const mock=await mockDashboard(page);await page.goto("/dashboard.html?page=overview");await expect(page.locator(".summary-card")).toHaveCount(4);
  await expect(page.locator("#workspace-content")).toContainText("Needs attention");
  await page.locator('[data-page="workload"]').click();await expect(page.locator(".workload-table")).toContainText("builder");
  await page.getByRole("button",{name:"Jira assignees",exact:true}).click();await expect(page.locator(".workload-table")).toContainText("Test Lead");
  await page.locator('[data-page="calendar"]').click();await expect(page.locator(".calendar-day")).toHaveCount(42);await expect(page.locator(".calendar-unscheduled")).toContainText("Synthetic internal task");
  await page.getByRole("button",{name:"Week",exact:true}).click();await expect(page.locator(".calendar-day")).toHaveCount(7);
  await page.goBack();await expect(page.locator("#page-heading")).toHaveText("Workload");
  expect(mock.calls.filter(c=>c.method!=="GET"&&c.path!=="/jira/search")).toEqual([]);expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});

test("pagination preserves selections across pages",async({page})=>{
  const mock=await mockDashboard(page,{many:true});await page.goto("/dashboard.html");await expect(page.locator("#view .item")).toHaveCount(25);
  const first=page.locator("#view .item input[type=checkbox]").first();const label=await first.getAttribute("aria-label");await first.check();await page.getByRole("button",{name:"Next page",exact:true}).click();await expect(page.locator("#view .item")).toHaveCount(6);await expect(page.locator("#b-count")).toHaveText("1 selected");
  await page.getByRole("button",{name:"Previous page",exact:true}).click();await expect(page.getByRole("checkbox",{name:label,exact:true})).toBeChecked();expect(mock.errors).toEqual([]);
});

test("drawer tabs retain draft and closing respects discard confirmation and focus",async({page})=>{
  const mock=await mockDashboard(page);await page.goto("/dashboard.html");const opener=page.locator("#view .ttl").filter({hasText:"Synthetic Jira task"});await opener.click();
  await page.getByRole("tab",{name:"Comments",exact:true}).click();await page.locator("#d-reply").fill("Keep my draft");await page.getByRole("tab",{name:"Overview",exact:true}).click();await page.getByRole("tab",{name:"Comments",exact:true}).click();await expect(page.locator("#d-reply")).toHaveValue("Keep my draft");
  page.once("dialog",d=>d.dismiss());await page.locator("#d-close").click();await expect(page.locator("#drawer")).toBeVisible();
  page.once("dialog",d=>d.accept());await page.locator("#d-close").click();await expect(page.locator("#drawer")).toBeHidden();await expect(opener).toBeFocused();expect(mock.errors).toEqual([]);
});

test("personal saved view restores filters after a refresh",async({page})=>{
  await mockDashboard(page);await page.goto("/dashboard.html");await expect(page.locator("#view .item")).toHaveCount(2);await page.getByRole("combobox",{name:"Status",exact:true}).selectOption("Pending QA");await expect(page.locator("#view .item")).toHaveCount(1);
  page.once("dialog",d=>d.accept("QA work"));await page.getByRole("button",{name:"Save view",exact:true}).click();await page.locator("#fclear").click();
  await page.reload();await page.getByRole("combobox",{name:"Saved view",exact:true}).selectOption({label:"QA work"});await expect(page.locator("#view .item")).toHaveCount(1);await expect(page.locator("#active")).toContainText("Pending QA");
});

test("failed due-date save shows failure and preserves pending value",async({page})=>{
  const mock=await mockDashboard(page,{mutationFailure:true});await page.goto("/dashboard.html#AION-101");await expect(page.locator("#d-desc")).toContainText("Rendered description");await page.locator("#d-due").fill("2026-10-20");await page.locator("#d-savedue").click();await expect(page.locator("#d-duemsg")).toHaveText("Not saved.");expect(mock.calls.some(c=>c.path==="/jira/issue/AION-101"&&c.method==="PUT"&&c.body.fields.duedate==="2026-10-20")).toBe(true);expect(mock.errors).toEqual([]);
});

for(const width of [320,375,390,768,1024,1440])test(`workspace navigation and overview fit ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});const mock=await mockDashboard(page);await page.goto("/dashboard.html?page=overview");await expect(page.locator(".summary-card")).toHaveCount(4);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`test-results/overview-${width}.png`,fullPage:true});
  if(width<=820){await page.locator("#mobile-menu").click();await expect(page.locator("#mobile-menu")).toHaveAttribute("aria-expanded","true");await page.locator('[data-page="calendar"]').click();await expect(page.locator("#mobile-menu")).toHaveAttribute("aria-expanded","false");await page.locator("#mobile-menu").click();await page.keyboard.press("Escape");await expect(page.locator("#mobile-menu")).toBeFocused();}
  else await page.locator('[data-page="calendar"]').click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`test-results/workspace-${width}.png`,fullPage:true});expect(mock.errors).toEqual([]);
  if(width<=820)await page.locator("#mobile-menu").click();await page.locator('[data-page="workload"]').click();await expect(page.locator(".workload-table")).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`test-results/workload-${width}.png`,fullPage:true});
});

test("admin renders both sources, filters locally, groups and changes board without mutations", async ({ page }) => {
  const mock = await mockDashboard(page);
  await page.goto("/dashboard.html");
  await expect(page.locator("#view .item")).toHaveCount(2);
  await expect(page.locator("#users-link")).toBeVisible();
  await expect(page.locator('[data-page="tickets"]')).toBeVisible();
  await expect(page.locator('[data-page="mytasks"]')).toBeVisible();
  await expect(page.locator("#tiles .tile").filter({hasText:"No developer"})).toBeVisible();
  await expect(page.getByRole("combobox",{name:"Developer",exact:true}).locator('option[value="__none"]')).toHaveCount(1);
  await page.locator("#ftoggle").click();
  await expect(page.locator("#fgrid").getByRole("button",{name:/No developer/})).toBeVisible();
  await page.locator("#q").fill("internal");
  await expect(page.locator("#view .item")).toHaveCount(1);
  await expect(page.locator("#view")).toContainText("INT-101");
  await page.locator("#fclear").click();
  await expect(page.locator("#view .item")).toHaveCount(2);
  await page.locator("#grp").selectOption("dev");
  await expect(page.locator("#view .ghead")).toHaveCount(2);
  await page.locator('[data-v="status"]').click();
  await expect(page.locator("#view .board")).toBeVisible();
  expect(mock.calls.filter(c => c.method !== "GET" && c.path !== "/jira/search")).toEqual([]);
  expect(mock.unexpected).toEqual([]);
  expect(mock.errors).toEqual([]);
});

test("developer restores team defaults and downgrades saved admin board", async ({ page }) => {
  const mock = await mockDashboard(page, { role: "user" });
  await page.goto("/dashboard.html");
  await expect(page.locator("#view .item")).toHaveCount(2);
  await expect(page.locator("#users-link")).toBeHidden();
  await expect(page.locator('[data-page="tickets"]')).toBeHidden();
  await expect(page.locator('[data-page="mytasks"]')).toBeVisible();
  await expect(page.locator("#page-heading")).toHaveText("My tasks");
  await expect(page.locator("#tiles .tile").filter({hasText:"No developer"})).toHaveCount(0);
  await expect(page.getByRole("combobox",{name:"Developer",exact:true})).toHaveCount(0);
  await page.locator("#ftoggle").click();
  await expect(page.locator("#fgrid").getByRole("button",{name:/No developer/})).toHaveCount(0);
  await expect(page.locator("#fgrid h4").filter({hasText:"Developer (ai1_)"})).toHaveCount(0);
  await expect(page.locator('[data-v="dev"]')).toBeHidden();
  await expect(page.locator('[data-v="assignee"]')).toBeHidden();
  await expect(page.locator('[data-v="list"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator("#fclear").click();
  await expect(page.locator("#active")).toContainText("Test Lead");
  expect(mock.unexpected).toEqual([]);
  expect(mock.errors).toEqual([]);
});

for (const key of ["AION-101", "INT-101"]) {
  test(`${key} deep link opens correct drawer and source-specific controls`, async ({ page }) => {
    const mock = await mockDashboard(page);
    await page.goto(`/dashboard.html#${key}`);
    await expect(page.locator("#drawer")).toBeVisible();
    await expect(page.locator("#d-key")).toContainText(key);
    await expect(page.locator("#d-desc")).toContainText(key.startsWith("INT") ? "Internal description" : "Rendered description");
    await expect(page.locator("#d-trans")).toContainText("In Development");
    if (key.startsWith("INT")) {
      await page.getByRole("tab", { name: "Files", exact: true }).click();
      await expect(page.locator("#i-att")).toBeVisible();
      await expect(page.locator("#d-open")).toBeHidden();
      expect(mock.calls.some(c => c.path.includes(key))).toBe(false);
    } else {
      await expect(page.locator("#d-open")).toBeVisible();
      await expect(page.locator("#d-trans")).not.toContainText("Closed");
      await page.getByRole("tab", { name: "Comments", exact: true }).click();
      await expect(page.locator("#d-comments")).toContainText("Please check");
    }
    await page.locator("#d-close").click();
    await expect(page.locator("#drawer")).toBeHidden();
    expect(mock.unexpected).toEqual([]);
    expect(mock.errors).toEqual([]);
  });
}

test("expired session redirects to sign-in with ticket hash before API access", async ({ page }) => {
  const mock = await mockDashboard(page, { expired: true });
  await page.goto("/dashboard.html#INT-101");
  await expect(page).toHaveURL(/index\.html#INT-101$/);
  expect(mock.calls).toEqual([]);
});

test("sign-in preserves both page route and ticket deep link",async({page})=>{
  const mock=await mockDashboard(page,{expired:true});await page.goto("/dashboard.html?page=overview#AION-101");await expect(page).toHaveURL(/index\.html\?page=overview#AION-101$/);await page.locator("#email").fill("test@example.invalid");await page.locator("#password").fill("synthetic-password");await page.locator("#signin-btn").click();await expect(page).toHaveURL(/dashboard\.html\?page=overview#AION-101$/);await expect(page.locator("#drawer")).toBeVisible();await expect(page.locator("#d-key")).toContainText("AION-101");expect(mock.errors).toEqual([]);
});

test("developer workload links fall back to tickets and row menus retain role restrictions",async({page})=>{
  const mock=await mockDashboard(page,{role:"user"});await page.goto("/dashboard.html?page=workload#INT-101");await expect(page.locator("#page-heading")).toHaveText("My tasks");await expect(page.locator('[data-page="workload"]')).toBeHidden();await expect(page.locator(".workload-table")).toHaveCount(0);await expect(page.locator("#d-key")).toContainText("INT-101");await page.locator("#d-close").click();
  await page.goto("/dashboard.html?page=tickets#AION-101");await expect(page).toHaveURL(/page=mytasks#AION-101/);await expect(page.locator("#d-key")).toContainText("AION-101");await page.locator("#d-close").click();
  await page.locator('[data-page="mytasks"]').click();await page.getByRole("button",{name:"Actions for AION-101",exact:true}).click();await expect(page.locator("#pop")).toContainText("Set due date");await expect(page.locator("#pop")).not.toContainText("Assign developers");await expect(page.locator("#pop")).not.toContainText("Change assignee");expect(mock.unexpected).toEqual([]);expect(mock.errors).toEqual([]);
});

for(const role of ["admin","user"])test(`${role} due-date history visibility follows manager role`,async({page})=>{
  const mock=await mockDashboard(page,{role});
  await page.addInitScript(()=>localStorage.setItem("aion.view","history"));
  await page.goto("/dashboard.html?page=history#AION-101");
  await expect(page.locator("#drawer")).toBeVisible();
  if(role==="admin"){
    await expect(page.locator("#page-heading")).toHaveText("Due date history");
    await expect(page.getByRole("tab",{name:"Activity",exact:true})).toBeVisible();
    await page.getByRole("tab",{name:"Activity",exact:true}).click();
    await expect(page.locator("#d-hist")).toBeVisible();
  }else{
    await expect(page.locator("#page-heading")).toHaveText("My tasks");
    await expect(page.getByRole("tab",{name:"Activity",exact:true})).toHaveCount(0);
    await expect(page.locator("#d-hist")).toBeHidden();
    await expect(page.locator("#d-due")).toBeVisible();
    await page.getByRole("tab",{name:"Overview",exact:true}).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab",{name:"Comments",exact:true})).toBeFocused();
    expect(mock.calls.some(c=>c.path.endsWith("/changelog"))).toBe(false);
  }
  await page.locator("#d-close").click();
  const nav=page.locator('[data-page="history"]'), switcher=page.locator('[data-v="history"]'), tile=page.locator("#tiles .tile").filter({hasText:"Due date moved"});
  if(role==="admin"){await expect(nav).toBeVisible();await expect(switcher).toBeVisible();await expect(tile).toBeVisible();}
  else{
    await expect(nav).toBeHidden();await expect(switcher).toBeHidden();await expect(tile).toHaveCount(0);
    await page.goto("/dashboard.html");
    await expect(page.locator('#view .listwrap')).toBeVisible();
  }
  expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});

test("load failure displays error without a false successful update", async ({ page }) => {
  const mock = await mockDashboard(page, { failure: true });
  await page.goto("/dashboard.html");
  await expect(page.locator("#pagestate")).toHaveClass(/err/);
  await expect(page.locator("#updated")).not.toContainText("updated ");
  expect(mock.errors).toEqual([]);
});

for (const width of [320, 768, 1440]) {
  test(`baseline ticket rendering and close control at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const mock = await mockDashboard(page);
    await page.goto("/dashboard.html#INT-101");
    await expect(page.locator("#d-title")).toHaveText("Synthetic internal task");
    await expect(page.locator("#d-close")).toBeInViewport();
    await page.screenshot({ path: `test-results/baseline-${width}.png`, fullPage: true });
    await page.locator("#d-close").click();
    await expect(page.locator("#q")).toBeVisible();
    await page.screenshot({ path: `test-results/baseline-list-${width}.png`, fullPage: true });
    expect(mock.errors).toEqual([]);
  });
}
