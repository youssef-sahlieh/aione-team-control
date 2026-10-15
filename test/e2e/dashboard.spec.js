import {catalogWorkbook} from "../fixtures/catalog.js";
import { test, expect } from "@playwright/test";
import { jiraIssue, internalTicket, people } from "../fixtures/issues.js";

// A synthetic Odoo Helpdesk ticket as the proxy returns it (developer "builder" from the Odoo assignee).
const odooTicket = { key: "HD-300", id: 300, ref: "300", odoo: true, summary: "Synthetic Odoo request", status: "In Progress", statusCat: "indeterminate", devs: ["builder"], developerName: "Builder", customer: { name: "Ariel Amiri", email: "ariel@example.invalid" }, team: "ai1 | Support", priority: "Medium", created: "2026-10-09T08:00:00Z", updated: "2026-10-10T08:00:00Z", closed: "", due: null, url: "https://odoo.example.invalid/web#id=300&model=helpdesk.ticket&view_type=form" };

async function mockDashboard(page, { role = "admin", failure = false, expired = false, many = false, mutationFailure = false, assigneeTeam = false, aiDisabled = false, aiFailure = false, briefFailure = false, historyFailure = false, legacyHistory = false, legacyTotal = 1, odoo = false, github = false, missingEstimate = false } = {}) {
  await page.clock.setFixedTime(new Date("2026-10-11T09:00:00Z"));
  const calls = [], unexpected = [], errors = [];
  const internalTickets=[structuredClone(internalTicket)];
  const catalog={revision:1,entries:[{id:"client",name:"Synthetic Client",parentId:null,archived:false,sources:[]}]},metadata={};
  const record=key=>metadata[key]||{revision:0,clientId:"client",subClientId:null,clientName:"Synthetic Client",subClientName:"",estimatedHours:missingEstimate?null:2,actualHours:null,workDone:"",...(role==="admin"?{billing:null}:{})};
  let historyFailures=historyFailure?1:0;
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ role, expired }) => {
    if(sessionStorage.getItem("aion-test-initialized"))return;
    sessionStorage.setItem("aion-test-initialized","1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "test@example.invalid", expiresAt: expired ? 1 : Date.now() + 3600000, role }));
    localStorage.setItem("aion.notify", "0");
    localStorage.setItem("aion.columns."+encodeURIComponent("test@example.invalid"),"all");
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
    calls.push({ path, method, body, ...(url.search?{query:url.search}:{}) });
    const json = value => route.fulfill({ json: value });
    if (path === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people:assigneeTeam?{...people,...Object.fromEntries(["karim","youssef","rami","razan"].map(key=>[key,{id:`test-${key}`,name:key[0].toUpperCase()+key.slice(1),ini:key[0].toUpperCase()}]))}:people, devs: ["builder", "reviewer"], role, dev: "builder", email: "test@example.invalid", accounts: true, odoo, github, mail: false, capabilities:["ticket-business-v1"], ai:{enabled:!aiDisabled,readOnly:true} });
    if(path==='/clients'&&method==='GET')return json(catalog);
    if(path==='/clients/odoo-sync'&&method==='POST'){if(url.searchParams.get('force')!=='1')return json({odoo:true,changed:false,syncedAt:1});catalog.entries.push({id:'odoo-client',name:'Odoo Customer',parentId:null,archived:false});catalog.revision++;return json({odoo:true,changed:true,added:1,projects:3,syncedAt:2});}
    if(path==='/clients/import/preview')return json({revision:1,rows:body.rows.length,added:1,clients:2,subClients:0,entries:[{id:'new-client',name:body.rows[0].displayName,parentId:null}]});
    if(path==='/clients/import'){catalog.entries.push({id:'new-client',name:body.rows[0].displayName,parentId:null,archived:false});catalog.revision++;return json(catalog);}
    if(path==='/ticket-metadata/batch')return json({records:Object.fromEntries(body.keys.map(key=>[key,record(key)]))});
    if(path==='/ticket-metadata'&&method==='GET')return json({metadata:record(url.searchParams.get('key')),history:[],closed:false});
    if(path==='/ticket-metadata'&&method==='PUT'){if(mutationFailure)return route.fulfill({status:503,json:{code:'ticket_metadata',error:'Synthetic save failure'}});metadata[body.key]={...record(body.key),...body.fields,revision:body.fields.revision+1};return json({metadata:metadata[body.key]});}
    if(path==='/reports/run')return json({workflow:body.workflow,generatedAt:'2026-10-11T09:00:00Z',period:{start:body.start,end:body.end},coverage:{examined:2},warnings:[],hoursLabel:'Current hours on tickets in the selected cohort; these are ticket totals, not hours worked during the period.',totals:{open:2,created:1,completed:0,atRisk:1,overrides:0},groups:[],tickets:[]});
    if(path==="/ai/chat")return aiFailure?route.fulfill({status:503,json:{code:"ai_unavailable",error:"AI service unavailable. Try again."}}):json({answer:"Review AION-101 first. AION-9999 is unverified. <img src=x onerror=alert(1)>",references:[{key:"AION-101",title:"Synthetic Jira task"}],readOnly:true});
    if(path==="/ai/brief")return briefFailure?route.fulfill({status:503,json:{code:"ai_unavailable",error:"Brief service unavailable. Try again."}}):json({key:body.key,brief:"Fix the reported issue so the workflow works correctly. <img src=x onerror=alert(1)>",updated:jiraIssue.fields.updated,readOnly:true});
    if(path==="/date-requests")return json({requests:[]});
    if(path.startsWith("/date-requests/"))return mutationFailure?route.fulfill({status:503,json:{code:"date_request",error:"Synthetic save failure"}}):json({request:{status:"approved"}});
    if (path === "/login") return json({token:"synthetic-token",email:"test@example.invalid",expiresAt:Date.now()+3600000,role});
    if(path==='/internal'&&method==='POST'){const t={...internalTicket,...body,key:'INT-102',status:'Open',statusCat:'new',created:'2026-10-11T09:00:00Z',updated:'2026-10-11T09:00:00Z'};delete t.metadata;internalTickets.push(t);metadata[t.key]={revision:1,...body.metadata};return json({ticket:t});}
    if (path === "/internal" && method === "GET") return json({ tickets: internalTickets });
    if (odoo && path === "/odoo/tickets" && method === "GET") return json({ tickets: [odooTicket] });
    if (odoo && path === "/odoo/tickets/HD-300" && method === "GET") return json({ ticket: odooTicket, description: "<p>Customer description</p>", messages: [{ author: "Ariel Amiri", when: "2026-10-10T10:00:00Z", body: "<p>Any update?</p>", note: false, email: true }], stages: [{ id: 1, name: "New", cat: "new" }, { id: 2, name: "In Progress", cat: "indeterminate" }, { id: 3, name: "Solved", cat: "done" }] });
    if (odoo && path === "/odoo/tickets/HD-300" && method === "PUT") return json({ ticket: { ...odooTicket, status: "Solved", statusCat: "done" }, added: [] });
    if (odoo && path === "/odoo/tickets/HD-300/note" && method === "POST") return route.fulfill({ status: 201, json: { ok: true } });
    if (path === "/jira/search") {
      if (failure) return route.fulfill({ status: 503, json: { code: "jira", error: "Synthetic outage" } });
      const issues=assigneeTeam?["karim","youssef","rami","razan","someone"].map((key,n)=>({...jiraIssue,key:`AION-${201+n}`,fields:{...jiraIssue.fields,summary:`Task for ${key}`,assignee:{accountId:`test-${key}`,displayName:key[0].toUpperCase()+key.slice(1)}}})):many?Array.from({length:30},(_,n)=>({...jiraIssue,key:`AION-${101+n}`,fields:{...jiraIssue.fields,summary:`Synthetic Jira task ${n+1}`}})):[jiraIssue];
      return json({ issues: body.jql.includes("statusCategory = Done") ? [] : issues, isLast: true });
    }
    if(path==="/jira/users")return json([{accountId:"synthetic-karim",displayName:"Karim Example",active:true},{accountId:"synthetic-youssef",displayName:"Youssef Example",active:true},{accountId:"synthetic-app",displayName:"App",accountType:"app"}]);
    if(path.endsWith("/comment")&&method==="POST")return json({id:"synthetic-comment"});
    if (path.endsWith("/changelog")) return json({ changelog: legacyHistory?{total:legacyTotal,histories:[{id:'legacy-1',created:'2026-10-09T10:00:00Z',author:{displayName:'Jira Manager'},items:[{field:'status',fromString:'Open',toString:'In Development'}]}]}:{ histories: [] } });
    if(path.endsWith("/history")){
      if(legacyHistory)return route.fulfill({status:404,json:{code:'not_found',error:'Not found.'}});
      const start=Number(url.searchParams.get("startAt")||0);
      if(start===1&&historyFailures-->0)return route.fulfill({status:503,json:{code:"jira",error:"History unavailable"}});
      return json({startAt:start,total:2,isLast:start===1,values:[start===0?{id:"h1",created:"2026-10-09T10:00:00Z",author:{displayName:"Test Manager"},items:[{field:"status",fromString:"Open",toString:"In Development"}]}:{id:"h2",created:"2026-10-10T10:00:00Z",author:{displayName:"Test Lead"},items:[{field:"assignee",fromString:"Unassigned",toString:"Test Lead"},{field:"description",fromString:null,toString:"<img src=x onerror=alert(1)>"}]}]});
    }
    if (path.endsWith("/transitions") && method === "GET") return json({ transitions: [{ id: "7", name: "Start", to: { name: "In Development", statusCategory: { key: "indeterminate" } } }, { id: "8", name: "Unavailable", isAvailable: false, to: { name: "Closed" } }] });
    if(mutationFailure&&method==="PUT")return route.fulfill({status:503,json:{code:"jira",error:"Synthetic save failure"}});
    unexpected.push({ path, method });
    return route.fulfill({ status: 403, json: { code: "forbidden", error: "Unconfigured test request" } });
  });
  return { calls, unexpected, errors };
}

for(const role of ['admin','user'])test(`${role} Jira mentions pick people and send account IDs`,async({page})=>{
  const mock=await mockDashboard(page,{role});await page.goto('/dashboard.html#AION-101');await page.getByRole('tab',{name:'Comments',exact:true}).click();
  const input=page.locator('#d-reply');await input.fill('Please check @ka');await expect(page.getByRole('option',{name:'Karim Example',exact:true})).toBeVisible();await input.press('Enter');await expect(input).toHaveValue('Please check @Karim Example ');
  await input.press('Home');await input.press('Home');await input.press('Control+Home');await input.press('ArrowRight');await input.press('Control+Home');await input.press('Q');
  await input.press('Control+End');await input.press('End');await input.press('Space');await input.press('@');await input.press('y');await input.press('o');await expect(page.getByRole('option',{name:'Youssef Example',exact:true})).toBeVisible();await input.press('ArrowDown');await input.press('Enter');
  await page.locator('#d-send').click();await expect(page.locator('#d-cmsg')).toHaveText('Sent.');
  const sent=mock.calls.find(c=>c.path==='/jira/issue/AION-101/comment');expect(sent.body.text).toBe('QPlease check [~accountid:synthetic-karim]  [~accountid:synthetic-youssef]');expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
test('editing a selected mention makes it plain text and internal tickets have no picker',async({page})=>{
  const mock=await mockDashboard(page);await page.goto('/dashboard.html#AION-101');await page.getByRole('tab',{name:'Comments',exact:true}).click();const input=page.locator('#d-reply');await input.fill('@ka');await expect(page.getByRole('option',{name:'Karim Example',exact:true})).toBeVisible();await input.press('Enter');await input.fill('@Karim Edited');await input.press('Escape');await page.locator('#d-send').click();await expect(page.locator('#d-cmsg')).toHaveText('Sent.');expect(mock.calls.find(c=>c.path.endsWith('/comment')).body.text).toBe('@Karim Edited');
  await page.locator('#d-close').click();await page.goto('/dashboard.html#INT-101');await page.getByRole('tab',{name:'Comments',exact:true}).click();await input.fill('@ka');await expect(page.locator('.mention-hint')).toBeHidden();await expect(page.locator('#comment-mention-picker')).toBeHidden();expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});

test('legacy Jira history route displays real field changes when all events are returned',async({page})=>{
  const mock=await mockDashboard(page,{legacyHistory:true});await page.goto('/dashboard.html#AION-101');await page.getByRole('tab',{name:'History',exact:true}).click();await expect(page.locator('#d-full-history')).toContainText('1 change events · Complete Jira field history');await expect(page.locator('#d-full-history')).toContainText('Jira Manager');await expect(page.locator('#d-full-history')).toContainText('In Development');await expect(page.locator('.ticket-history-entry')).toHaveCount(1);expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
test('legacy Jira history cannot claim completeness when its expanded events are capped',async({page})=>{
  const mock=await mockDashboard(page,{legacyHistory:true,legacyTotal:150});await page.goto('/dashboard.html#AION-101');await page.getByRole('tab',{name:'History',exact:true}).click();await expect(page.locator('#d-full-history')).toContainText('1 of 150 change events · Older history may be missing');await expect(page.locator('#d-full-history')).not.toContainText('Complete Jira field history');await expect(page.getByRole('link',{name:'Open ticket in Jira',exact:true})).toHaveAttribute('href',/jira\.example\.invalid\/browse\/AION-101/);expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});

for(const width of [320,1440])test(`internal note buttons open the email composer at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});const mock=await mockDashboard(page);await page.goto('/dashboard.html#AION-101');await expect(page.locator('#d-note')).toBeInViewport();await page.locator('#d-note').click();await expect(page.locator('#pop')).toContainText('Internal note · AION-101');await expect(page.locator('#pop textarea')).toBeFocused();await page.keyboard.press('Escape');await page.getByRole('tab',{name:'Comments',exact:true}).click();await expect(page.locator('#d-comment-note')).toBeVisible();await page.locator('#d-comment-note').click();await expect(page.locator('#pop textarea')).toBeFocused();expect(mock.calls.some(c=>c.path==='/mail')).toBe(false);expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
test('internal note buttons are available to users',async({page})=>{
  const mock=await mockDashboard(page,{role:'user'});await page.goto('/dashboard.html#AION-101');await expect(page.locator('#d-note')).toBeVisible();await page.getByRole('tab',{name:'Comments',exact:true}).click();await expect(page.locator('#d-comment-note')).toBeVisible();expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});

for(const width of [320,1024,1440])test(`manager Internal note column opens a ticket composer at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});const mock=await mockDashboard(page);await page.goto('/dashboard.html');await expect(page.locator('#view .item')).toHaveCount(2);
  if(width===1440)await expect(page.locator('#view .gr.head .c-note')).toHaveText('Internal note');
  for(const key of ['AION-101','INT-101']){const button=page.getByRole('button',{name:'Internal note for '+key,exact:true});await expect(button).toBeVisible();await expect(button).toHaveText('Internal note');await button.click();await expect(page.locator('#drawer')).toBeHidden();await expect(page.locator('#pop')).toContainText('Internal note · '+key);await expect(page.locator('#pop textarea')).toBeFocused();await page.keyboard.press('Escape');}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`test-results/email-column-${width}.png`,fullPage:true});expect(mock.calls.some(c=>c.path==='/mail')).toBe(false);expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
test('regular users have the same Internal note column',async({page})=>{
  const mock=await mockDashboard(page,{role:'user'});await page.goto('/dashboard.html');await expect(page.locator('#view .item')).toHaveCount(2);await expect(page.locator('#view .email-button')).toHaveCount(2);await expect(page.locator('.listwrap.with-email')).toHaveCount(1);expect(mock.errors).toEqual([]);
});

async function selectAssignees(page,names){
  await page.locator("#assignee-filter-trigger").click();const picker=page.locator("#assignee-filter-dialog");
  for(const check of await picker.getByRole("checkbox").all())await check.setChecked(names.includes(await check.getAttribute("aria-label")));
  await picker.getByRole("button",{name:"Apply",exact:true}).click();await expect(picker).not.toBeVisible();
}
for(const width of [320,1440])test(`assignee picker searches, stages selection and restores focus at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});const mock=await mockDashboard(page,{assigneeTeam:true});await page.goto("/dashboard.html");await expect(page.locator("#view .item")).toHaveCount(3);
  const trigger=page.locator("#assignee-filter-trigger"),picker=page.locator("#assignee-filter-dialog");await trigger.click();await expect(picker.getByRole("searchbox",{name:"Search assignees"})).toBeFocused();await expect(picker.getByRole("checkbox",{name:"Karim",exact:true})).toBeChecked();
  await picker.getByRole("searchbox").fill("raza");await expect(picker.getByRole("checkbox")).toHaveCount(1);await picker.getByRole("checkbox",{name:"Razan",exact:true}).check();await expect(page.locator("#view .item")).toHaveCount(3);
  await picker.getByRole("button",{name:"Cancel",exact:true}).click();await expect(trigger).toBeFocused();await expect(page.locator("#view .item")).toHaveCount(3);
  await trigger.click();await picker.getByRole("searchbox").fill("nobody matches this");await expect(picker).toContainText("No people match your search");await page.keyboard.press("Escape");await expect(picker).not.toBeVisible();await expect(trigger).toBeFocused();
  await trigger.click();for(const check of await picker.getByRole("checkbox").all())await check.uncheck();await picker.getByRole("button",{name:"Apply",exact:true}).click();await expect(picker).toBeVisible();await expect(picker.getByRole("status")).toHaveText("Select at least one assignee.");
  await picker.getByRole("button",{name:"Reset to default",exact:true}).click();await picker.getByRole("checkbox",{name:"Razan",exact:true}).check();await picker.screenshot({path:`test-results/assignee-picker-${width}.png`});
  await picker.getByRole("button",{name:"Apply",exact:true}).click();await expect(page.locator("#view .item")).toHaveCount(4);await expect(page.locator("#assignee-filter-trigger")).toBeFocused();await expect(page.locator("#active")).toContainText("Razan");
  await page.getByRole("button",{name:"Remove Razan",exact:true}).click();await expect(page.locator("#view .item")).toHaveCount(3);expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
for(const role of ["admin","user"])for(const width of [320,1440])test(`${role} AI brief column generates on demand and survives local filters at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});const mock=await mockDashboard(page,{role});await page.goto("/dashboard.html");await expect(page.locator("#view .item")).toHaveCount(2);
  expect(mock.calls.some(c=>c.path==="/ai/brief")).toBe(false);
  await page.getByRole("button",{name:"Generate brief for AION-101",exact:true}).click();await expect(page.locator(".ticket-brief-text")).toContainText("Fix the reported issue");await expect(page.locator(".ticket-brief img")).toHaveCount(0);
  await page.getByRole("combobox",{name:"Status",exact:true}).selectOption("Open");await expect(page.locator("#view .item")).toHaveCount(1);await page.getByRole("combobox",{name:"Status",exact:true}).selectOption("");await expect(page.locator(".ticket-brief-text")).toBeVisible();
  expect(mock.calls.filter(c=>c.path==="/ai/brief")).toHaveLength(1);await expect(page.getByRole("button",{name:"Generate brief for INT-101",exact:true})).toHaveCount(0);
  expect(await page.locator("#view .ttl .s").first().evaluate(el=>getComputedStyle(el).fontWeight)).toBe("600");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.locator("#view").screenshot({path:`test-results/ticket-briefs-${role}-${width}.png`});expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
test("AI brief failures offer a retry without losing the ticket list",async({page})=>{
  const mock=await mockDashboard(page,{briefFailure:true});await page.goto("/dashboard.html");await page.getByRole("button",{name:"Generate brief for AION-101",exact:true}).click();await expect(page.locator(".brief-error")).toContainText("Brief service unavailable");await expect(page.getByRole("button",{name:"Retry brief for AION-101",exact:true})).toBeEnabled();await expect(page.locator("#view .item")).toHaveCount(2);expect(mock.errors).toEqual([]);
});
for(const width of [320,1440])test(`manager has a separate INT ticket page at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});const mock=await mockDashboard(page);await page.goto("/dashboard.html");await expect(page.locator("#view .item")).toHaveCount(2);
  await page.getByRole("combobox",{name:"Ticket source",exact:true}).selectOption("jira");await expect(page.locator("#view .item")).toHaveCount(1);
  if(width<=820)await page.locator("#mobile-menu").click();await page.locator('[data-page="internal"]').click();
  await expect(page.locator("#page-heading")).toHaveText("Internal tickets");await expect(page.locator("#nav-internal-count")).toHaveText("1");await expect(page.locator("#view .item")).toHaveCount(1);await expect(page.locator("#view")).toContainText("INT-101");await expect(page.locator("#view")).not.toContainText("AION-101");
  await expect(page.getByRole("combobox",{name:"Ticket source",exact:true})).toHaveCount(0);await expect(page.locator("#view .c-brief")).toHaveCount(0);
  await page.getByRole("combobox",{name:"Status",exact:true}).selectOption("Pending QA");await expect(page.locator("#view .item")).toHaveCount(0);await page.locator("#fclear").click();await expect(page.locator("#view .item")).toHaveCount(1);
  await page.locator("#ftoggle").click();page.once("dialog",d=>d.accept("Internal page"));await page.getByRole("button",{name:"Save view",exact:true}).click();
  if(width<=820)await page.locator("#mobile-menu").click();await page.locator('[data-page="tickets"]').click();await expect(page.locator("#view .item")).toHaveCount(2);await page.getByRole("combobox",{name:"Saved view",exact:true}).selectOption({label:"Internal page"});await expect(page.locator("#view .item")).toHaveCount(1);await expect(page.locator("#view")).toContainText("INT-101");
  if(width<=820)await page.locator("#mobile-menu").click();await page.locator('[data-page="internal"]').click();await page.locator("#view .ttl").first().click();await expect(page.locator("#d-key")).toContainText("INT-101");await expect(page.locator("#d-open")).toBeHidden();await page.locator("#d-close").click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`test-results/internal-page-${width}.png`,fullPage:true});expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
for(const role of ["admin","user"])test(`${role} can show internal tickets only and reset source filtering`,async({page})=>{
  const mock=await mockDashboard(page,{role});await page.goto("/dashboard.html");await expect(page.locator("#view .item")).toHaveCount(2);
  const source=page.getByRole("combobox",{name:"Ticket source",exact:true});await source.selectOption("internal");await expect(page.locator("#view .item")).toHaveCount(1);await expect(page.locator("#view")).toContainText("INT-101");await expect(page.locator("#view")).not.toContainText("AION-101");
  await page.getByRole("combobox",{name:"Status",exact:true}).selectOption("Pending QA");await expect(page.locator("#view .item")).toHaveCount(0);await page.getByRole("combobox",{name:"Status",exact:true}).selectOption("");
  if(role==="admin"){
    await page.locator("#ftoggle").click();page.once("dialog",d=>d.accept("Internal only"));await page.getByRole("button",{name:"Save view",exact:true}).click();await page.locator("#fclear").click();await page.reload();await page.getByRole("combobox",{name:"Saved view",exact:true}).selectOption({label:"Internal only"});await expect(source).toHaveValue("internal");await expect(page.locator("#view .item")).toHaveCount(1);
  }
  await page.getByRole("button",{name:"Remove Internal tickets only",exact:true}).click();await expect(source).toHaveValue("all");await expect(page.locator("#view .item")).toHaveCount(2);
  await source.selectOption("jira");await expect(page.locator("#view .item")).toHaveCount(1);await expect(page.locator("#view")).toContainText("AION-101");await page.locator("#fclear").click();await expect(source).toHaveValue("all");await expect(page.locator("#view .item")).toHaveCount(2);
  if(role==="user"){await expect(page.locator('[data-page="internal"]')).toBeHidden();await page.goto("/dashboard.html?page=internal#INT-101");await expect(page.locator("#page-heading")).toHaveText("All tickets");await expect(page.locator("#d-key")).toContainText("INT-101");await page.locator("#d-close").click();await source.selectOption("internal");await expect(page.locator("#view .item")).toHaveCount(1);}
  expect(mock.calls.filter(c=>["PUT","DELETE"].includes(c.method))).toHaveLength(0);expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
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
for(const role of ["admin","user"])test(`${role} sees no AI setup controls when chat is unavailable`,async({page})=>{
  const mock=await mockDashboard(page,{role,aiDisabled:true});await page.goto("/dashboard.html");await expect(page.locator("#view .item")).toHaveCount(2);await expect(page.locator("#ai-launcher")).toBeHidden();await expect(page.locator("#ai-panel")).toBeHidden();await expect(page.locator("#ai-send")).toBeDisabled();
  await expect(page.locator("#main-content")).not.toContainText("server configuration");expect(mock.calls.some(c=>c.path==="/ai/chat")).toBe(false);expect(mock.errors).toEqual([]);
  await expect(page.locator(".c-brief")).toHaveCount(0);expect(mock.calls.some(c=>c.path==="/ai/brief")).toBe(false);
});

for(const role of ["admin","user"])test(`${role} defaults to three assignees and includes Razan and Others only on selection`,async({page})=>{
  const mock=await mockDashboard(page,{role,assigneeTeam:true});await page.goto("/dashboard.html");
  await expect(page.locator("#view .item")).toHaveCount(3);
  await expect(page.locator("#view")).not.toContainText("Task for razan");
  await expect(page.locator("#view")).not.toContainText("Task for someone");
  await expect(page.locator("#assignee-filter-trigger")).toHaveAttribute("title","Karim, Youssef, Rami, Internal Tickets (default)");
  if(role==="user"){
    await expect(page.locator("#ftoggle")).toBeHidden();await expect(page.locator("#active")).toHaveText("Default team");
    await selectAssignees(page,["Karim","Youssef","Rami","Razan"]);await expect(page.locator("#view .item")).toHaveCount(4);await page.locator("#fclear").click();
    await selectAssignees(page,["Others"]);await expect(page.locator("#view .item")).toHaveCount(2);await expect(page.locator("#view")).toContainText("Task for someone");
    await page.locator("#fclear").click();await expect(page.locator("#view .item")).toHaveCount(3);expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);return;
  }
  await page.locator("#ftoggle").click();
  const razan=page.locator("#fgrid .fsec.k4").getByRole("button",{name:/Razan/});await expect(razan).toHaveAttribute("aria-pressed","false");await razan.click();await expect(page.locator("#view .item")).toHaveCount(4);await expect(page.locator("#view")).toContainText("Task for razan");await page.locator("#fclear").click();
  const others=page.locator("#fgrid .fsec.k4").getByRole("button",{name:/Others/});
  await expect(others).toHaveAttribute("aria-pressed","false");await others.click();await expect(page.locator("#view .item")).toHaveCount(5);await expect(page.locator("#view")).not.toContainText("Task for razan");
  await others.click();await expect(page.locator("#view .item")).toHaveCount(3);
  await selectAssignees(page,["Others"]);await expect(page.locator("#view .item")).toHaveCount(2);await expect(page.locator("#view")).toContainText("Task for someone");
  page.once("dialog",d=>d.accept("Others only"));await page.getByRole("button",{name:"Save view",exact:true}).click();
  await page.locator("#fclear").click();await expect(page.locator("#view .item")).toHaveCount(3);
  await page.getByRole("combobox",{name:"Saved view",exact:true}).selectOption({label:"Others only"});await expect(page.locator("#view .item")).toHaveCount(2);
  expect(mock.calls.filter(c=>c.path==="/jira/search").every(c=>!c.body.jql.includes("assignee in"))).toBe(true);
  expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
for(const width of [320,1440])test(`filter labels and selections remain clear at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});const mock=await mockDashboard(page,{role:"user",assigneeTeam:true});await page.goto("/dashboard.html");
  await expect(page.locator("#filter-summary")).toHaveText("3 tickets match · 4 selected");await expect(page.locator(".quick-field > span").filter({hasText:"Assignee"})).toBeVisible();
  await expect(page.locator("#ftoggle")).toBeHidden();await expect(page.locator("#fgrid")).toBeHidden();
  for(const label of ["Reporter","Priority","Developer","Saved view"])await expect(page.getByRole("combobox",{name:label,exact:true})).toHaveCount(0);
  await expect(page.locator("#quick-filters select:visible")).toHaveCount(6);
  await selectAssignees(page,["Razan"]);await expect(page.locator("#view .item")).toHaveCount(1);await expect(page.locator("#filter-summary")).toHaveText("1 ticket match · 1 selected");
  await page.getByRole("button",{name:"Reset filters",exact:true}).click();await expect(page.locator("#view .item")).toHaveCount(3);await expect(page.locator("#filter-summary")).toHaveText("3 tickets match · 4 selected");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.locator(".fpanel").screenshot({path:`test-results/filters-${width}.png`});expect(mock.errors).toEqual([]);
});
for(const role of ["admin"])for(const width of [320,1440])test(`${role} reporter, status and priority stay visible and filter together at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});const mock=await mockDashboard(page,{role});await page.goto("/dashboard.html");await expect(page.locator("#view .item")).toHaveCount(2);
  await expect(page.locator("#fgrid")).toBeHidden();
  for(const name of ["Reporter","Status","Priority"]){await expect(page.getByRole("combobox",{name,exact:true})).toBeVisible();await expect(page.locator("#quick-filters .quick-field > span").filter({hasText:new RegExp(`^${name}$`)})).toBeVisible();}
  await page.locator(".fpanel").screenshot({path:`test-results/primary-filters-${role}-${width}.png`});
  await page.getByRole("combobox",{name:"Reporter",exact:true}).selectOption("Test Reporter");await expect(page.locator("#view .item")).toHaveCount(1);
  await page.getByRole("combobox",{name:"Status",exact:true}).selectOption("Pending QA");await page.getByRole("combobox",{name:"Priority",exact:true}).selectOption("High");await expect(page.locator("#view")).toContainText("AION-101");
  await page.getByRole("combobox",{name:"Reporter",exact:true}).selectOption("Test Builder");await expect(page.locator("#view .item")).toHaveCount(0);
  await expect(page.getByRole("combobox",{name:"Priority",exact:true}).locator("option")).toContainText(["All priorities","High","Medium"]);
  await page.getByRole("button",{name:"Remove Reporter: Test Builder",exact:true}).click();await expect(page.getByRole("combobox",{name:"Reporter",exact:true})).toHaveValue("");await expect(page.locator("#view .item")).toHaveCount(1);
  await page.getByRole("button",{name:"Reset filters",exact:true}).click();await expect(page.locator("#view .item")).toHaveCount(2);
  await page.getByRole("combobox",{name:"Priority",exact:true}).selectOption("Medium");await expect(page.locator("#view .item")).toHaveCount(1);await expect(page.locator("#view")).toContainText("INT-101");
  await page.getByRole("combobox",{name:"Reporter",exact:true}).selectOption("Test Builder");await page.getByRole("combobox",{name:"Priority",exact:true}).selectOption("");await expect(page.locator("#view .item")).toHaveCount(1);await page.locator("#ftoggle").click();
  await page.locator("#fgrid .fsec").filter({has:page.locator("h4",{hasText:"Reporter"})}).getByRole("button",{name:/Test Reporter/}).click();await expect(page.getByRole("combobox",{name:"Reporter",exact:true})).toHaveValue("__multiple");
  await expect(page.locator("#view .item")).toHaveCount(2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
for(const width of [320,1024,1440])test(`manager workspace keeps secondary tools accessible at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});const mock=await mockDashboard(page);await page.goto("/dashboard.html");
  if(width<=820)await page.locator("#mobile-menu").click();
  await expect(page.locator('#main-nav > a:not([hidden])')).toHaveCount(9);await expect(page.locator('[data-page="history"]')).toHaveCount(0);
  await expect(page.locator('[data-page="requests"]')).toBeVisible();await page.locator('[data-page="requests"]').click();await expect(page.locator("#page-heading")).toHaveText("Date requests");
  if(width<=820)await page.locator("#mobile-menu").click();await page.locator('[data-page="tickets"]').click();
  await expect(page.locator("#quick-filters select")).toHaveCount(10);await expect(page.getByRole("combobox",{name:"Saved view",exact:true})).toBeHidden();await expect(page.locator("#bulk")).toBeHidden();
  await expect(page.locator("#tiles > .tile")).toHaveCount(10);await expect(page.locator("#manager-more-focus")).toHaveCount(0);
  const row=page.locator("#view .gr.item").first();await expect(row.locator(".c-who")).toBeVisible();await expect(row.locator(".c-dev")).toBeVisible();await expect(row.locator(".c-rep")).toBeVisible();
  await row.locator("input.ck").check();await expect(page.locator("#bulk")).toBeVisible();await page.locator("#b-clear").click();await expect(page.locator("#bulk")).toBeHidden();
  await page.getByRole("button",{name:"Actions for AION-101",exact:true}).click();await expect(page.locator("#pop")).toContainText("Internal notes");await page.locator("#pop").getByRole("button",{name:"Open details",exact:true}).click();await expect(page.locator("#d-facts")).toContainText("Reporter");await page.locator("#d-close").click();
  await page.locator("#ftoggle").click();await expect(page.locator("#fgrid h4").filter({hasText:"Developer (ai1_)"})).toBeVisible();await expect(page.getByRole("combobox",{name:"Saved view",exact:true})).toBeVisible();await page.locator("#ftoggle").click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`test-results/manager-clean-${width}.png`,fullPage:true});expect(mock.unexpected).toEqual([]);expect(mock.errors).toEqual([]);
});

test("workspace pages navigate locally and browser Back restores page",async({page})=>{
  const mock=await mockDashboard(page);await page.goto("/dashboard.html?page=overview");await expect(page.locator(".summary-card")).toHaveCount(4);
  await expect(page.locator("#workspace-content")).toContainText("Needs attention");
  await page.locator('[data-page="workload"]').click();await expect(page.locator(".workload-table")).toContainText("builder");
  await page.getByRole("button",{name:"Jira assignees",exact:true}).click();await expect(page.locator(".workload-table")).toContainText("Test Lead");
  await page.locator('[data-page="calendar"]').click();await expect(page.locator(".calendar-day")).toHaveCount(42);await expect(page.locator(".calendar-unscheduled")).toContainText("Synthetic internal task");
  await page.getByRole("button",{name:"Week",exact:true}).click();await expect(page.locator(".calendar-day")).toHaveCount(7);
  await page.goBack();await expect(page.locator("#page-heading")).toHaveText("Workload");
  expect(mock.calls.filter(c=>c.method!=="GET"&&c.path!=="/jira/search"&&c.path!=="/ticket-metadata/batch")).toEqual([]);expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});

test("pagination preserves selections across pages",async({page})=>{
  const mock=await mockDashboard(page,{many:true});await page.goto("/dashboard.html");await expect(page.locator("#view .item")).toHaveCount(25);
  const first=page.locator("#view .item input[type=checkbox]").first();const label=await first.getAttribute("aria-label");await first.check();await page.getByRole("button",{name:"Next page",exact:true}).click();await expect(page.locator("#view .item")).toHaveCount(6);await expect(page.locator("#b-count")).toHaveText("1 selected");
  await page.getByRole("button",{name:"Previous page",exact:true}).click();await expect(page.getByRole("checkbox",{name:label,exact:true})).toBeChecked();expect(mock.errors).toEqual([]);
});

for(const width of [320,1440])test(`manager History beside Comments loads every Jira page safely at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});const mock=await mockDashboard(page);await page.goto("/dashboard.html#AION-101");
  await expect(page.getByRole("tab",{name:"History",exact:true})).toBeVisible();expect(mock.calls.some(c=>c.path.endsWith("/history"))).toBe(false);
  await page.getByRole("tab",{name:"History",exact:true}).click();await expect(page.locator("#d-full-history")).toContainText("2 change events · Complete Jira field history");await expect(page.locator(".ticket-history-entry")).toHaveCount(2);
  await expect(page.locator(".ticket-history-entry").first()).toContainText("Test Lead");await expect(page.locator("#d-full-history")).toContainText("In Development");await expect(page.locator("#d-full-history img")).toHaveCount(0);
  await page.getByRole("tab",{name:"Comments",exact:true}).click();await page.locator("#d-reply").fill("Keep this draft");await page.getByRole("tab",{name:"History",exact:true}).click();await page.getByRole("tab",{name:"Comments",exact:true}).click();await expect(page.locator("#d-reply")).toHaveValue("Keep this draft");await page.locator("#d-reply").fill("");
  expect(mock.calls.filter(c=>c.path.endsWith("/history"))).toHaveLength(2);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.getByRole("tab",{name:"History",exact:true}).click();await page.screenshot({path:`test-results/full-history-${width}.png`,fullPage:true});expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
test("partial history failure is disclosed and retry loads all pages",async({page})=>{
  const mock=await mockDashboard(page,{historyFailure:true});await page.goto("/dashboard.html#AION-101");await page.getByRole("tab",{name:"History",exact:true}).click();await expect(page.locator("#d-full-history")).toContainText("History incomplete");await expect(page.locator(".ticket-history-entry")).toHaveCount(1);
  await page.getByRole("button",{name:"Retry history",exact:true}).click();await expect(page.locator("#d-full-history")).toContainText("Complete Jira field history");await expect(page.locator(".ticket-history-entry")).toHaveCount(2);expect(mock.errors).toEqual([]);
});
test("drawer tabs retain draft and closing respects discard confirmation and focus",async({page})=>{
  const mock=await mockDashboard(page);await page.goto("/dashboard.html");const opener=page.locator("#view .ttl").filter({hasText:"Synthetic Jira task"});await opener.click();
  await page.getByRole("tab",{name:"Comments",exact:true}).click();await page.locator("#d-reply").fill("Keep my draft");await page.getByRole("tab",{name:"Overview",exact:true}).click();await page.getByRole("tab",{name:"Comments",exact:true}).click();await expect(page.locator("#d-reply")).toHaveValue("Keep my draft");
  page.once("dialog",d=>d.dismiss());await page.locator("#d-close").click();await expect(page.locator("#drawer")).toBeVisible();
  page.once("dialog",d=>d.accept());await page.locator("#d-close").click();await expect(page.locator("#drawer")).toBeHidden();await expect(opener).toBeFocused();expect(mock.errors).toEqual([]);
});

test("personal saved view restores filters after a refresh",async({page})=>{
  await mockDashboard(page);await page.goto("/dashboard.html");await expect(page.locator("#view .item")).toHaveCount(2);await page.getByRole("combobox",{name:"Status",exact:true}).selectOption("Pending QA");await expect(page.locator("#view .item")).toHaveCount(1);
  await page.locator("#ftoggle").click();page.once("dialog",d=>d.accept("QA work"));await page.getByRole("button",{name:"Save view",exact:true}).click();await page.locator("#fclear").click();
  await page.reload();await page.getByRole("combobox",{name:"Saved view",exact:true}).selectOption({label:"QA work"});await expect(page.locator("#view .item")).toHaveCount(1);await expect(page.locator("#active")).toContainText("Pending QA");
});

test("failed due-date save shows failure and preserves pending value",async({page})=>{
  const mock=await mockDashboard(page,{mutationFailure:true});await page.goto("/dashboard.html#AION-101");await expect(page.locator("#d-desc")).toContainText("Rendered description");await page.locator("#d-requestdate").click();const dialog=page.locator("dialog.date-dialog");await dialog.getByLabel("Requested date",{exact:true}).fill("2026-10-20");await dialog.getByLabel("Reason (required)",{exact:true}).fill("Updated delivery commitment");await dialog.getByRole("button",{name:"Apply date",exact:true}).click();await expect(dialog).toContainText("Synthetic save failure");expect(mock.calls.some(c=>c.path==="/date-requests/direct"&&c.method==="POST"&&c.body.proposedDate==="2026-10-20")).toBe(true);expect(mock.errors).toEqual([]);
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
  await expect(page.locator('[data-page="mytasks"]')).toHaveCount(0);await expect(page.locator("#manager-more-nav")).toHaveCount(0);await expect(page.locator('[data-page="boards"]')).toBeVisible();
  await expect(page.locator("#tiles .tile").filter({hasText:"No developer"})).toBeVisible();
  await expect(page.getByRole("combobox",{name:"Developer",exact:true})).toBeVisible();
  await page.getByRole("combobox",{name:"Developer",exact:true}).selectOption("reviewer");await expect(page.locator("#view .item")).toHaveCount(1);await expect(page.locator("#active")).toContainText("ai1_reviewer");
  await page.getByRole("combobox",{name:"Developer",exact:true}).selectOption("__none");await expect(page.locator("#view .item")).toHaveCount(0);
  await page.getByRole("combobox",{name:"Developer",exact:true}).selectOption("");await expect(page.locator("#view .item")).toHaveCount(2);
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
  expect(mock.calls.filter(c => c.method !== "GET" && c.path !== "/jira/search" && c.path !== "/ticket-metadata/batch")).toEqual([]);
  expect(mock.unexpected).toEqual([]);
  expect(mock.errors).toEqual([]);
});

test("developer restores team defaults and downgrades saved admin board", async ({ page }) => {
  const mock = await mockDashboard(page, { role: "user" });
  await page.goto("/dashboard.html");
  await expect(page.locator("#view .item")).toHaveCount(2);
  await expect(page.locator("#users-link")).toBeHidden();
  await expect(page.locator('[data-page="tickets"]')).toBeVisible();
  await expect(page.locator('[data-page="mytasks"]')).toHaveCount(0);
  await expect(page.locator("#page-heading")).toHaveText("All tickets");
  await expect(page.locator("#tiles .tile").filter({hasText:"No developer"})).toHaveCount(0);
  await expect(page.getByRole("combobox",{name:"Developer",exact:true})).toHaveCount(0);
  await expect(page.locator("#ftoggle")).toBeHidden();
  await expect(page.locator("#fgrid").getByRole("button",{name:/No developer/})).toHaveCount(0);
  await expect(page.locator("#fgrid h4").filter({hasText:"Developer (ai1_)"})).toHaveCount(0);
  await expect(page.locator('[data-v="dev"]')).toBeHidden();
  await expect(page.locator('[data-v="assignee"]')).toBeHidden();
  await expect(page.locator('[data-v="list"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator("#fclear").click();
  await expect(page.locator("#active")).toContainText("Default team");
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
  const mock=await mockDashboard(page,{role:"user"});await page.goto("/dashboard.html?page=workload#INT-101");await expect(page.locator("#page-heading")).toHaveText("All tickets");await expect(page.locator('[data-page="workload"]')).toBeHidden();await expect(page.locator(".workload-table")).toHaveCount(0);await expect(page.locator("#d-key")).toContainText("INT-101");await page.locator("#d-close").click();
  await page.goto("/dashboard.html?page=mytasks#AION-101");await expect(page).toHaveURL(/page=tickets#AION-101/);await expect(page.locator("#d-key")).toContainText("AION-101");await page.locator("#d-close").click();
  await page.locator('[data-page="tickets"]').click();await page.getByRole("button",{name:"Actions for AION-101",exact:true}).click();await expect(page.locator("#pop")).toContainText("Request date change");await expect(page.locator("#pop")).not.toContainText("Assign developers");await expect(page.locator("#pop")).not.toContainText("Change assignee");expect(mock.unexpected).toEqual([]);expect(mock.errors).toEqual([]);
});

for(const role of ["admin","user"])test(`${role} due-date history visibility follows manager role`,async({page})=>{
  const mock=await mockDashboard(page,{role});
  await page.addInitScript(()=>localStorage.setItem("aion.view","history"));
  await page.goto("/dashboard.html?page=history#AION-101");
  await expect(page.locator("#drawer")).toBeVisible();
  if(role==="admin"){
    await expect(page.locator("#page-heading")).toHaveText("Date requests");
    await expect(page.getByRole("tab",{name:"Activity",exact:true})).toBeVisible();
    await page.getByRole("tab",{name:"Activity",exact:true}).click();
    await expect(page.locator("#d-hist")).toBeVisible();
  }else{
    await expect(page.locator("#page-heading")).toHaveText("All tickets");
    await expect(page.getByRole("tab",{name:"Activity",exact:true})).toHaveCount(0);
    await expect(page.getByRole("tab",{name:"History",exact:true})).toHaveCount(0);expect(mock.calls.some(c=>c.path.endsWith("/history"))).toBe(false);
    await expect(page.locator("#d-hist")).toBeHidden();
    await expect(page.locator("#d-due")).toBeVisible();
    await page.getByRole("tab",{name:"Overview",exact:true}).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab",{name:"Comments",exact:true})).toBeFocused();
    expect(mock.calls.some(c=>c.path.endsWith("/changelog"))).toBe(false);
  }
  await page.locator("#d-close").click();
  const nav=page.locator('[data-page="history"]'), switcher=page.locator('[data-v="history"]'), tile=page.locator("#tiles .tile").filter({hasText:"Due date moved"});
  await expect(nav).toHaveCount(0);await expect(switcher).toHaveCount(0);await expect(tile).toHaveCount(0);
  if(role!=="admin"){
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

test("admin sees Odoo Helpdesk tickets, filters them, opens one and writes back to Odoo", async ({ page }) => {
  const mock = await mockDashboard(page, { odoo: true });
  await page.goto("/dashboard.html");
  await expect(page.locator("#view")).toContainText("HD-300");
  await expect(page.locator("#view")).toContainText("Ariel Amiri <ariel@example.invalid>");
  await expect(page.locator("#view .flag.odoo")).toHaveCount(1);
  await page.getByRole("combobox", { name: "Ticket source", exact: true }).selectOption("odoo");
  await expect(page.locator("#view .item")).toHaveCount(1);
  await expect(page.locator("#view")).toContainText("HD-300");
  await page.locator("#fclear").click();
  await page.goto("/dashboard.html#HD-300");
  await expect(page.locator("#d-key")).toContainText("HD-300");
  await expect(page.locator("#d-facts")).toContainText("ariel@example.invalid");
  await expect(page.locator("#d-odoo")).toBeVisible();
  await expect(page.locator("#d-open")).toBeHidden();
  await expect(page.locator("#d-desc")).toContainText("Customer description");
  await page.getByRole("tab", { name: "Comments", exact: true }).click();
  await expect(page.locator("#d-comments")).toContainText("Any update?");
  await page.locator("#d-reply").fill("Looking into it");
  await page.locator("#d-send").click();
  await expect.poll(() => mock.calls.find(c => c.path === "/odoo/tickets/HD-300/note")?.body?.text).toBe("Looking into it");
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await page.locator("#d-trans .stbtn", { hasText: "Solved" }).click();
  await expect.poll(() => mock.calls.find(c => c.path === "/odoo/tickets/HD-300" && c.method === "PUT")?.body).toEqual({ stage: 3 });
  expect(mock.calls.some(c => c.path.startsWith("/jira/issue/HD-"))).toBe(false);
  expect(mock.unexpected).toEqual([]); expect(mock.errors).toEqual([]);
});

test("developer sees their Odoo tickets even with the team assignee filter", async ({ page }) => {
  const mock = await mockDashboard(page, { role: "user", odoo: true });
  await page.goto("/dashboard.html");
  await expect(page.locator("#view")).toContainText("HD-300");
  await page.getByRole("button", { name: "Actions for HD-300", exact: true }).click();
  await expect(page.locator("#pop")).not.toContainText("Request date change");
  await expect(page.locator("#pop")).toContainText("Open in Odoo");
  expect(mock.unexpected).toEqual([]); expect(mock.errors).toEqual([]);
});

for(const role of ['admin','user'])test('business fields save and billing visibility for '+role,async({page})=>{
 const mock=await mockDashboard(page,{role});await page.goto('/dashboard.html#INT-101');const panel=page.locator('#business-fields');await expect(panel.getByLabel('Estimated hours')).toBeVisible();
 await expect(panel.getByLabel('Billing (administrators only)')).toHaveCount(role==='admin'?1:0);
 // A set estimate is locked for users; administrators can still change it.
 if(role==='admin')await panel.getByLabel('Estimated hours').fill('1.25');else await expect(panel.getByLabel('Estimated hours')).toBeDisabled();await panel.getByLabel('Actual hours').fill('2.5');await panel.getByLabel('Work done').fill('Implemented and verified the task.');
 await panel.getByRole('button',{name:'Save ticket fields',exact:true}).click();await expect(panel).toContainText('Ticket fields saved.');const sent=mock.calls.find(c=>c.path==='/ticket-metadata'&&c.method==='PUT');expect(sent.body.fields.actualHours).toBe(2.5);expect('billing'in sent.body.fields).toBe(role==='admin');
 expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
for(const width of [320,1440])test('business list sorting and original created date at '+width,async({page})=>{
 await page.setViewportSize({width,height:1000});const mock=await mockDashboard(page,{many:true});await page.goto('/dashboard.html');await expect(page.locator('#view .item')).toHaveCount(25);
 await expect(page.locator('#view .head .c-cre')).toBeVisible();await page.locator('#view .head .c-key').click({button:'right'});await page.getByRole('menuitem',{name:'Sort descending',exact:true}).click();
 await expect(page.locator('#view .item .c-key').first()).toContainText('INT-101');await page.getByRole('button',{name:'Next page',exact:true}).click();await expect(page.locator('#view .item .c-key').first()).toContainText('AION-106');
 await page.reload();await expect(page.locator('#view .item .c-key').first()).toContainText('INT-101');await expect(page.locator('#view .head .c-key')).toContainText('↓');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/business-list-'+width+'.png',fullPage:true});expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
test('business internal creation defaults to Internal Tickets and includes client selection',async({page})=>{
 const mock=await mockDashboard(page,{role:'user'});await page.goto('/dashboard.html');await page.locator('#create-ticket').click();await page.locator('#pop input.inp').first().fill('New internal work');await expect(page.locator('#pop select:has(option[value="__internal_tickets"])')).toHaveValue('__internal_tickets');
 await page.locator('#pop').getByRole('combobox',{name:'Client',exact:true}).fill('Synth');await page.locator('#pop').getByRole('option',{name:'Synthetic Client'}).click();await page.locator('#pop').getByRole('button',{name:'Create ticket',exact:true}).click();await expect(page.locator('#d-key')).toContainText('INT-102');
 const sent=mock.calls.find(c=>c.path==='/internal'&&c.method==='POST');expect(sent.body.assignee).toBe('__internal_tickets');expect(sent.body.metadata.clientId).toBe('client');expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
test('business report workflow runs without AI and exports findings',async({page})=>{
 const mock=await mockDashboard(page,{aiDisabled:true});await page.goto('/dashboard.html?page=reports');await page.getByRole('button',{name:'Run now',exact:true}).click();await expect(page.locator('.report-results')).toContainText('not hours worked during the period');await expect(page.locator('.report-totals')).toContainText('Open: 2');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export ticket findings CSV'}).click();expect((await download).suggestedFilename()).toContain('aion-management');await page.screenshot({path:'test-results/business-reports.png',fullPage:true});expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
test('clients are read from Odoo: background refresh on load and a sync button, no file upload',async({page})=>{
 const mock=await mockDashboard(page,{odoo:true});await page.goto('/dashboard.html?page=clients');
 await expect.poll(()=>mock.calls.some(c=>c.path==='/clients/odoo-sync'&&c.method==='POST'&&!c.query)).toBe(true);
 await expect(page.getByLabel('Import project workbook (.xlsx)')).toHaveCount(0);
 await page.getByRole('button',{name:'Sync from Odoo now',exact:true}).click();
 await expect(page.locator('.catalog-group')).toContainText(['Odoo Customer']);await expect(page.locator('.business-panel .msg')).toContainText('1 new from Odoo');
 expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
test('business fields lock on closed tickets and unsaved edits trigger discard confirmation',async({page})=>{
 const mock=await mockDashboard(page);await page.goto('/dashboard.html#INT-101');await page.locator('#business-fields').getByLabel('Work done').fill('Draft work');page.once('dialog',d=>d.dismiss());await page.locator('#d-close').click();await expect(page.locator('#drawer')).toBeVisible();page.once('dialog',d=>d.accept());await page.locator('#d-close').click();
 await page.route('**/ticket-metadata?key=INT-101',r=>r.fulfill({json:{metadata:{revision:1,clientId:'client',estimatedHours:1,actualHours:1,workDone:'Completed'},history:[],closed:true}}));await page.reload();await expect(page.locator('#business-fields').getByLabel('Work done')).toBeDisabled();await expect(page.locator('#business-fields')).toContainText('reopen');expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});

for(const role of ['admin','user'])test('business closure failure '+role+' handles override permissions',async({page})=>{
 const mock=await mockDashboard(page,{role});let moves=[];await page.route('**/internal/INT-101',route=>{const b=route.request().postDataJSON();moves.push(b);return b.overrideReason?route.fulfill({json:{ticket:{...internalTicket,status:'Closed'}}}):route.fulfill({status:400,json:{code:'closure_required',error:'Cannot close: Enter actual hours greater than zero; Describe the work done.'}});});await page.goto('/dashboard.html#INT-101');await page.locator('#d-trans').getByRole('button',{name:'→ Closed',exact:true}).click();
 if(role==='admin'){await expect(page.getByRole('dialog').filter({hasText:'Administrator closure override'})).toBeVisible();await page.getByLabel('Reason (required)').fill('Reviewed exception');await page.getByRole('button',{name:'Close with recorded override'}).click();await expect.poll(()=>moves.length).toBe(2);expect(moves[1].overrideReason).toBe('Reviewed exception');}
 else{await expect(page.locator('#toast')).toContainText('Cannot close');expect(moves).toHaveLength(1);await expect(page.getByLabel('Reason (required)')).toHaveCount(0);}
 expect(mock.errors).toEqual([]);
});

test('users must save an estimate before the due-date form is available',async({page})=>{
 const mock=await mockDashboard(page,{role:'user',missingEstimate:true});await page.goto('/dashboard.html');await page.locator('#view .item').filter({hasText:'INT-101'}).locator('.c-due button').click();
 await expect(page.getByRole('dialog')).toContainText('Estimated hours required');expect(mock.calls.some(c=>c.path==='/date-requests/initial')).toBe(false);
 await page.getByRole('dialog').getByLabel('Estimated hours').fill('1.5');await page.getByRole('button',{name:'Save estimate and continue'}).click();await expect(page.getByRole('dialog')).toContainText('Set initial due date');
 expect(mock.calls.find(c=>c.path==='/ticket-metadata'&&c.method==='PUT').body.fields.estimatedHours).toBe(1.5);expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
test('administrator assignment asks for private billing before sending the assignment',async({page})=>{
 const mock=await mockDashboard(page);let assignments=[];await page.route('**/jira/issue/AION-101',route=>{const b=route.request().postDataJSON();assignments.push(b);return route.fulfill({json:{ok:true}});});
 await page.goto('/dashboard.html');await page.locator('#view .item').filter({hasText:'AION-101'}).locator('.c-who').click();await page.locator('#pop .opt').filter({hasText:'Test Reporter'}).click();await expect(page.getByRole('dialog')).toContainText('Billing required');await page.getByRole('dialog').getByLabel('Billing',{exact:true}).selectOption('not_billable');await page.getByRole('button',{name:'Save billing and continue'}).click();
 await expect.poll(()=>assignments.length).toBe(1);expect(mock.calls.find(c=>c.path==='/ticket-metadata'&&c.method==='PUT').body.fields.billing).toBe('not_billable');expect(mock.errors).toEqual([]);
});
for(const width of [375,1440])test('work view reduces clutter and all columns remain available at '+width,async({page})=>{
 await page.setViewportSize({width,height:1000});const mock=await mockDashboard(page);await page.goto('/dashboard.html');await page.getByRole('button',{name:'Work view',exact:true}).click();await expect(page.locator('#view .head .c-rep')).toBeHidden();await expect(page.locator('#view .head .c-actualHours')).toBeVisible();await expect(page.locator('#view .head .c-clientName')).toBeVisible();await expect(page.locator('#view .head .c-cre')).toBeHidden();await expect(page.locator('#view .item .business-key-date').first()).toBeVisible();
 await page.screenshot({path:'test-results/work-view-'+width+'.png',fullPage:true});await page.getByRole('button',{name:'All columns',exact:true}).click();await expect(page.locator('#view .head .c-rep')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});

test('unsaved work uses its original revision after a background refresh',async({page})=>{
 const mock=await mockDashboard(page);await page.goto('/dashboard.html#INT-101');const panel=page.locator('#business-fields');let submittedRevision;await panel.getByLabel('Work done').fill('My unsaved draft');
 await page.route('**/ticket-metadata/batch',r=>r.fulfill({json:{records:Object.fromEntries(r.request().postDataJSON().keys.map(key=>[key,{revision:5,clientId:'client',billing:'billable',estimatedHours:2,actualHours:3,workDone:'Another person updated this ticket'}]))}}));
 await page.route('**/ticket-metadata',r=>{submittedRevision=r.request().postDataJSON().fields.revision;return r.fulfill({status:409,json:{code:'conflict',error:'Ticket fields changed. Refresh and retry.'}});});
 const refreshed=page.waitForResponse(r=>r.url().endsWith('/ticket-metadata/batch'));await page.evaluate(()=>document.getElementById('refresh').click());await refreshed;await page.evaluate(()=>new Promise(requestAnimationFrame));
 await panel.getByRole('button',{name:'Save ticket fields'}).click();await expect(panel).toContainText('Ticket fields changed');expect(submittedRevision).toBe(0);expect(mock.errors).toEqual([]);await expect(panel.getByLabel('Work done')).toHaveValue('My unsaved draft');
});

test('ticket fields are edited from the list, with client and billing for administrators only',async({page})=>{
 const mock=await mockDashboard(page);await page.goto('/dashboard.html');
 const row=page.locator('#view .item').filter({hasText:'INT-101'});
 await row.getByRole('button',{name:'Edit Actual hours for INT-101'}).click();
 await page.locator('#pop').getByLabel('Actual hours').fill('3.5');await page.locator('#pop').getByRole('button',{name:'Save',exact:true}).click();
 await expect(page.locator('#pop')).toBeHidden();
 const put=mock.calls.find(c=>c.path==='/ticket-metadata'&&c.method==='PUT');expect(put.body).toEqual({key:'INT-101',fields:{revision:0,actualHours:3.5}});
 await expect(row.locator('.c-actualHours')).toHaveText('3.5');
 await row.getByRole('button',{name:'Edit Billing for INT-101'}).click();await page.locator('#pop').getByLabel('Billing').selectOption('billable');await page.locator('#pop').getByRole('button',{name:'Save',exact:true}).click();
 await expect(row.locator('.c-billing')).toHaveText('Billable');
 await page.getByRole('button',{name:'Work view',exact:true}).click();
 await page.setViewportSize({width:1920,height:1000});expect(await page.locator('.business-list').evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true);await page.locator('.business-list').screenshot({path:'test-results/list-edit-work-view.png'});
 const head=await page.locator('#view .head .c-estimatedHours').boundingBox(),cell=await row.locator('.c-estimatedHours').boundingBox();expect(Math.abs(head.x-cell.x)).toBeLessThan(8);
 expect(mock.errors).toEqual([]);expect(mock.unexpected).toEqual([]);
});
test('users edit hours and work done from the list but not client or billing',async({page})=>{
 const mock=await mockDashboard(page,{role:'user'});await page.goto('/dashboard.html');
 const row=page.locator('#view .item').filter({hasText:'INT-101'});
 await expect(row.getByRole('button',{name:'Edit Work done for INT-101'})).toBeVisible();
 await expect(row.getByRole('button',{name:/Edit Client/})).toHaveCount(0);await expect(row.locator('.c-billing')).toHaveCount(0);
 expect(mock.errors).toEqual([]);
});

test('an administrator assigning a not-started ticket moves it: Jira to Dev Approved, internal to In Development',async({page})=>{
 const mock=await mockDashboard(page);const internalPuts=[],jiraMoves=[];
 const fresh=structuredClone(jiraIssue);fresh.fields.status={name:'Pending Approval',statusCategory:{key:'new'}};fresh.fields.labels=['keep-label'];
 await page.route('**/jira/search',r=>r.fulfill({json:{issues:[fresh],isLast:true}}));
 await page.route('**/jira/issue/AION-101',r=>r.fulfill({json:{ok:true}}));
 await page.route('**/jira/issue/AION-101/transitions',r=>{if(r.request().method()==='GET')return r.fulfill({json:{transitions:[{id:'21',name:'Approve',to:{name:'Dev Approved',statusCategory:{key:'indeterminate'}}},{id:'22',name:'Start',to:{name:'In Progress',statusCategory:{key:'indeterminate'}}}]}});jiraMoves.push(r.request().postDataJSON());return r.fulfill({json:{ok:true}});});
 await page.route('**/internal/INT-101',r=>{internalPuts.push(r.request().postDataJSON());return r.fulfill({json:{ticket:{...internalTicket,devs:['builder','reviewer']}}});});
 await page.goto('/dashboard.html');
 for(const key of ['AION-101','INT-101']){
  await page.locator('#view .item').filter({hasText:key}).locator('.c-dev').click();
  await page.locator('#pop input[data-dev="reviewer"]').check();await page.locator('#pop').getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Billing',{exact:true}).selectOption('not_billable');await page.getByRole('button',{name:'Save billing and continue'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 }
 await expect.poll(()=>jiraMoves).toEqual([{id:'21'}]);
 await expect.poll(()=>internalPuts.map(b=>b.status||null)).toEqual([null,'In Development']);
 expect(mock.errors).toEqual([]);
});
test('assigning a ticket that is already in progress keeps its status',async({page})=>{
 const mock=await mockDashboard(page);const moves=[];
 await page.route('**/jira/issue/AION-101',r=>r.fulfill({json:{ok:true}}));
 await page.route('**/jira/issue/AION-101/transitions',r=>{moves.push(r.request().method());return r.fulfill({json:{transitions:[]}});});
 await page.goto('/dashboard.html');
 await page.locator('#view .item').filter({hasText:'AION-101'}).locator('.c-dev').click();
 await page.locator('#pop input[data-dev="builder"]').uncheck();await page.locator('#pop input[data-dev="reviewer"]').uncheck();
 await page.locator('#pop').getByPlaceholder('Other name').fill('tester');await page.locator('#pop').getByRole('button',{name:'Add',exact:true}).click();
 await page.locator('#pop').getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('dialog').getByLabel('Billing',{exact:true}).selectOption('not_billable');await page.getByRole('button',{name:'Save billing and continue'}).click();await expect(page.locator('#toast')).toContainText('Developers saved');
 expect(moves).toEqual([]);expect(mock.errors).toEqual([]);
});

test('billing offers only Billable or Not billable, and client pickers can be searched',async({page})=>{
 const mock=await mockDashboard(page);
 await page.route('**/clients',r=>r.request().method()==='GET'?r.fulfill({json:{revision:1,entries:[{id:'client',name:'Synthetic Client',parentId:null,archived:false},{id:'acme',name:'Acme Retail',parentId:null,archived:false},{id:'acme-tlv',name:'Tel Aviv Branch',parentId:'acme',archived:false},{id:'acme-hfa',name:'Haifa Branch',parentId:'acme',archived:false}]}}):r.fallback());
 await page.goto('/dashboard.html#INT-101');const panel=page.locator('#business-fields');
 const billing=panel.getByLabel('Billing (administrators only)');await expect(billing).toBeVisible();
 expect(await billing.locator('option:not([hidden])').allTextContents()).toEqual(['Billable','Not billable']);
 const clientBox=panel.getByRole('combobox',{name:'Client',exact:true}),subBox=panel.getByRole('combobox',{name:'Sub-client',exact:true});
 await clientBox.fill('acm');await expect(panel.locator('.combo-list:not([hidden]) [role=option]')).toHaveText(['Acme Retail']);await clientBox.press('Enter');await expect(clientBox).toHaveValue('Acme Retail');
 await subBox.click();await expect(panel.locator('.combo-list:not([hidden]) [role=option]')).toHaveText(['Haifa Branch','Tel Aviv Branch']);await subBox.fill('haif');await panel.getByRole('option',{name:'Haifa Branch'}).click();await expect(subBox).toHaveValue('Haifa Branch');
 await expect(panel.locator('select.combo-native').first()).toHaveValue('acme');await panel.locator('.business-client-section').screenshot({path:'test-results/client-search.png'});
 const row=page.locator('#view .item').filter({hasText:'AION-101'});page.once('dialog',d=>d.accept());await page.locator('#d-close').click();await expect(page.locator('#drawer')).toBeHidden();
 await row.getByRole('button',{name:'Edit Billing for AION-101'}).click();await expect(page.locator('#pop').getByLabel('Billing')).toBeVisible();
 expect(await page.locator('#pop').getByLabel('Billing').locator('option:not([hidden])').allTextContents()).toEqual(['Billable','Not billable']);
 await page.locator('#pop').getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#pop')).toContainText('Choose Billable or Not billable');
 expect(mock.calls.some(c=>c.path==='/ticket-metadata'&&c.method==='PUT')).toBe(false);expect(mock.errors).toEqual([]);
});

test('ticket details open full screen and attachments preview inside the dashboard',async({page})=>{
 const mock=await mockDashboard(page);
 const withFile=structuredClone(jiraIssue);withFile.fields.attachment=[{id:'900',filename:'screen.png',mimeType:'image/png',size:68,created:'2026-10-11T08:00:00Z',author:{displayName:'Test Reporter'}},{id:'901',filename:'setup.zip',mimeType:'application/zip',size:10,created:'2026-10-10T08:00:00Z',author:{displayName:'Test Reporter'}}];
 await page.route('**/jira/search',r=>r.fulfill({json:{issues:[withFile],isLast:true}}));
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
 await page.route('**/jira/issue/AION-101/attachments/900',r=>r.fulfill({status:200,contentType:'image/png',body:png}));
 await page.goto('/dashboard.html#AION-101');
 const drawer=page.locator('#drawer');await expect(drawer).toBeVisible();await expect(drawer).toHaveClass(/full/);
 await page.screenshot({path:'test-results/fullscreen.png'});const box=await drawer.boundingBox();expect(box.width).toBeGreaterThan(1200);
 await page.getByRole('tab',{name:'Files'}).click();const att=page.locator('#d-att .att').filter({hasText:'screen.png'});
 await expect(att.getByRole('link')).toHaveCount(0);
 await att.getByRole('button',{name:'Preview',exact:true}).click();
 const viewer=page.locator('dialog.file-preview');await expect(viewer).toBeVisible();await expect(viewer.locator('img.fp-img')).toBeVisible();await page.screenshot({path:'test-results/preview.png'});
 expect(await viewer.locator('img.fp-img').evaluate(i=>i.naturalWidth)).toBe(1);
 await viewer.getByRole('button',{name:'Close',exact:true}).click();await expect(viewer).toHaveCount(0);
 await expect(page.locator('#d-att .att').filter({hasText:'setup.zip'}).getByRole('button',{name:'Preview'})).toHaveCount(0);
 await page.locator('#d-size').click();await expect(drawer).not.toHaveClass(/full/);await expect(page.locator('#d-size')).toHaveText('Full screen');
 expect(mock.errors).toEqual([]);
});

test('pull requests that mention a ticket show in the list and in the ticket',async({page})=>{
 const mock=await mockDashboard(page,{github:true});
 const prs={'AION-101':[{repo:'flutter_pos',number:553,title:'feat: forecourt opening (AION-101)',state:'merged',url:'https://github.com/KAD-org/flutter_pos/pull/553',author:'dev1',branch:'codex/x',base:'main',updated:'2026-10-12T10:00:00Z',merged:'2026-10-12T10:00:00Z'},{repo:'flutter_pos_api',number:175,title:'feat: forecourt opening cash',state:'open',url:'https://github.com/KAD-org/flutter_pos_api/pull/175',author:'dev1',updated:'2026-10-12T09:00:00Z',merged:null}]};
 await page.route('**/github/prs?*',r=>{const keys=new URL(r.request().url()).searchParams.get('keys').split(',');return r.fulfill({json:{configured:true,prs:Object.fromEntries(keys.filter(k=>prs[k]).map(k=>[k,prs[k]]))}});});
 await page.goto('/dashboard.html');
 const chip=page.locator('#view .item').filter({hasText:'AION-101'}).locator('.flag.pr');await expect(chip).toHaveText('2 PRs');await expect(chip).toHaveClass(/pr-open/);
 await page.locator('#view .item').filter({hasText:'AION-101'}).locator('.c-ttl').click();
 const section=page.locator('#d-prs-blk');await expect(section).toBeVisible();await expect(page.locator('#d-prs-count')).toHaveText('(2)');
 await expect(section.getByRole('link',{name:'flutter_pos #553'})).toHaveAttribute('href','https://github.com/KAD-org/flutter_pos/pull/553');
 await expect(section.locator('.pr-row').first()).toContainText('merged');
 expect(mock.errors).toEqual([]);
});
