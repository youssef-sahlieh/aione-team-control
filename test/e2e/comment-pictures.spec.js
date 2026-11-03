// Pictures in comments (Jira, internal, Odoo) and files in the Odoo chatter. The fake proxy below is the one
// test/e2e/dashboard.spec.js used (removed in a6a649a); every request is intercepted.
import {catalogWorkbook} from "../fixtures/catalog.js";
import { test, expect } from "@playwright/test";
import { jiraIssue, internalTicket, people } from "../fixtures/issues.js";

// A synthetic Odoo Helpdesk ticket as the proxy returns it (developer "builder" from the Odoo assignee).
const odooTicket = { key: "HD-300", id: 300, ref: "300", odoo: true, summary: "Synthetic Odoo request", status: "In Progress", statusCat: "indeterminate", devs: ["builder"], developerName: "Builder", customer: { name: "Ariel Amiri", email: "ariel@example.invalid" }, team: "ai1 | Support", priority: "Medium", created: "2026-10-09T08:00:00Z", updated: "2026-10-10T08:00:00Z", closed: "", due: null, url: "https://odoo.example.invalid/web#id=300&model=helpdesk.ticket&view_type=form" };

async function mockDashboard(page, { inbox = [], role = "admin", ticketLog = [], failure = false, expired = false, many = false, mutationFailure = false, assigneeTeam = false, aiDisabled = false, aiFailure = false, briefFailure = false, historyFailure = false, legacyHistory = false, legacyTotal = 1, odoo = false, github = false, billingRequired = false, missingEstimate = false, filtersVisible = true, workLog = false } = {}) {
  await page.clock.setFixedTime(new Date("2026-10-11T09:00:00Z"));
  const calls = [], unexpected = [], errors = [];
  const internalTickets=[structuredClone(internalTicket)], inboxTickets=[];
  const catalog={revision:1,entries:[{id:"client",name:"Synthetic Client",parentId:null,archived:false,sources:[]}]},metadata={};
  const record=key=>metadata[key]||{revision:0,clientId:"client",subClientId:null,clientName:"Synthetic Client",subClientName:"",estimatedHours:missingEstimate?null:2,actualHours:null,workDone:"",...(role==="admin"?{billing:null}:{})};
  let historyFailures=historyFailure?1:0;
  // Work log (Odoo timesheets): off unless a test switches it on.
  const timeEntries=[],STATUSES={syncing:'Syncing',synced:'Synced',setup:'Needs setup',review:'Needs review'};
  let timeSetup={revision:3,mode:workLog?'pilot':'off',pilot:['test@example.invalid'],fields:{users:'x_studio_users',entryUuid:'x_aione_entry_uuid',userUuid:'x_aione_user_uuid',lineRef:'x_aione_ticket_ref'},mapping:{},verified:null};
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ role, expired, filtersVisible }) => {
    if(sessionStorage.getItem("aion-test-initialized"))return;
    sessionStorage.setItem("aion-test-initialized","1");
    localStorage.clear();
    localStorage.setItem("aione-session", JSON.stringify({ token: "synthetic-token", email: "test@example.invalid", expiresAt: expired ? 1 : Date.now() + 3600000, role }));
    localStorage.setItem("aion.notify", "0");
    if(filtersVisible)localStorage.setItem("aion.ticket-filters.open."+encodeURIComponent("test@example.invalid"),"1");
    localStorage.setItem("aion.columns."+encodeURIComponent("test@example.invalid"),"all");
    // Exercise the existing downgrade of a saved administrator view for users.
    if (role === "user") localStorage.setItem("aion.view", "dev");
  }, { role, expired, filtersVisible });
  // Every external request is intercepted, including unexpected endpoints.
  // An unmatched request can never fall through to production Jira or mail.
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (url.hostname !== "aione-team-proxy.vercel.app") return route.abort();
    const path = url.pathname, method = req.method(), body = req.postDataJSON();
    calls.push({ path, method, body, ...(url.search?{query:url.search}:{}) });
    const json = value => route.fulfill({ json: value });
    if (path === "/config") return json({ site: "https://jira.example.invalid", project: "AION", people:assigneeTeam?{...people,...Object.fromEntries(["karim","youssef","rami","razan"].map(key=>[key,{id:`test-${key}`,name:key[0].toUpperCase()+key.slice(1),ini:key[0].toUpperCase()}]))}:people, devs: ["builder", "reviewer"], role, dev: "builder", email: "test@example.invalid", accounts: true, odoo, github, billingRequired, mail: false, capabilities:["ticket-business-v1","reports-all-v1","reports-saved-v1"], ai:{enabled:!aiDisabled,readOnly:true} });
    if(path==='/clients'&&method==='GET')return json(catalog);
    if(path==='/clients/odoo-sync'&&method==='POST'){if(url.searchParams.get('force')!=='1')return json({odoo:true,changed:false,syncedAt:1});catalog.entries.push({id:'odoo-client',name:'Odoo Customer',parentId:null,archived:false});catalog.revision++;return json({odoo:true,changed:true,added:1,projects:3,syncedAt:2});}
    if(path==='/clients/import/preview')return json({revision:1,rows:body.rows.length,added:1,clients:2,subClients:0,entries:[{id:'new-client',name:body.rows[0].displayName,parentId:null}]});
    if(path==='/clients/import'){catalog.entries.push({id:'new-client',name:body.rows[0].displayName,parentId:null,archived:false});catalog.revision++;return json(catalog);}
    if(path==='/ticket-log')return json({events:ticketLog});
    if(path==='/logout'&&method==='POST')return json({ok:true});
    if(path==='/time-entries'&&method==='GET'){const key=url.searchParams.get('ticket'),list=timeEntries.filter(e=>e.ticket===key),mins=list.reduce((n,e)=>n+e.minutes,0),hd=key.startsWith('HD-');
      return json({ticket:key,source:key.startsWith('INT-')?'internal':hd?'odoo':'jira',closed:false,logging:!!workLog,canLog:!!workLog,today:'2026-10-11',maxMinutes:1440,lockDate:workLog?'2026-09-30':null,entries:list,
        summary:{entries:list.length,loggedMinutes:mins,confirmedMinutes:mins,pendingMinutes:0,unsynced:0},baselineHours:hd?null:1,totalHours:Math.round((1+mins/60)*100)/100,
        destination:workLog?{projectId:10,projectName:'Synthetic Project',taskId:null,taskName:'['+key+'] Synthetic (created with the first entry)'}:null});}
    if(path==='/time-entries'&&method==='POST'){const e={id:body.id,ticket:body.ticket,source:'jira',date:body.date,minutes:body.minutes,description:body.description,author:{name:'Test User',email:'test@example.invalid'},createdAt:'2026-10-11T09:00:00Z',revision:0,status:'synced',statusLabel:'Synced',synced:true,reason:'',revisions:[],...(role==='admin'?{lineId:500+timeEntries.length}:{})};timeEntries.push(e);return route.fulfill({status:201,json:{entry:e,summary:{}}});}
    if(/^\/time-entries\/[0-9a-f-]{36}$/.test(path)&&method==='PATCH'){const e=timeEntries.find(x=>path.endsWith(x.id)),{reason,revision,...patch}=body,from={date:e.date,minutes:e.minutes,description:e.description};Object.assign(e,patch);e.revision++;e.revisions=[...e.revisions,{n:e.revision,at:'2026-10-11T09:00:00Z',by:{name:'Test User'},reason,from,to:{date:e.date,minutes:e.minutes,description:e.description}}];return json({entry:e,summary:{}});}
    if(path==='/time-entries/report')return json({from:url.searchParams.get('from'),to:url.searchParams.get('to'),timeZone:'Asia/Jerusalem',statuses:STATUSES,rows:timeEntries.map(e=>({...e,user:e.author.name,clientName:'Synthetic Client',subClientName:''})),baselines:timeEntries.length?[{ticket:'AION-101',hours:1}]:[]});
    if(path==='/time-entries/setup'){if(method==='PUT')timeSetup={...timeSetup,...body,revision:timeSetup.revision+1,verified:body.mode==='off'?null:{ok:true}};
      return json({config:timeSetup,odoo:true,statuses:STATUSES,fields:{line:[{name:'x_studio_users',label:'Users',type:'char',custom:true},{name:'x_aione_entry_uuid',label:'Work entry id',type:'char',custom:true},{name:'x_aione_user_uuid',label:'Dashboard user id',type:'char',custom:true},{name:'x_aione_ticket_ref',label:'Ticket',type:'char',custom:true}]},
        suggested:{users:'x_studio_users',usersCandidates:['x_studio_users']},defaults:{ok:true,user:{id:7,name:'Odoo Bot'},company:{id:1,name:'AION'},employee:{id:5,name:'Bot employee'}},lockDate:'2026-09-30',
        projects:[{id:10,name:'Synthetic Project',partner:'Synthetic Client'}],catalog:[{id:'client',name:'Synthetic Client',parentId:null,odooProject:null}],users:[{email:'test@example.invalid',name:'Test User'}]});}
    if(path==='/inbox')return json({items:inbox,seenAt:'2026-10-11T08:00:00.000Z',readTickets:inboxTickets});
    if(path==='/inbox/read'){inbox=inbox.map(x=>body.all||x.id===body.id?{...x,read:true}:x);inboxTickets.push(...(body.tickets||[]));return json({items:inbox,seenAt:'2026-10-11T08:00:00.000Z',readTickets:inboxTickets});}
    if(path==='/ticket-notes'&&method==='GET')return json({notes:[],people:[{email:'karim@example.invalid',name:'Karim Example',role:'admin'},{email:'dev2@example.invalid',name:'Second Developer',role:'user'}]});
    if(path==='/integrations')return json({checkedAt:'2026-10-11T09:00:00Z',keys:[{id:'jira',name:'Jira API token',status:'warning',message:'Expires in 5 days. Create a new key before then.',expiresAt:'2026-10-16T00:00:00.000Z',days:5}]});
    if(path==='/ticket-metadata/batch')return json({records:Object.fromEntries(body.keys.map(key=>[key,record(key)]))});
    if(path==='/ticket-metadata'&&method==='GET')return json({metadata:record(url.searchParams.get('key')),history:[],closed:false});
    if(path==='/ticket-metadata'&&method==='PUT'){if(mutationFailure)return route.fulfill({status:503,json:{code:'ticket_metadata',error:'Synthetic save failure'}});metadata[body.key]={...record(body.key),...body.fields,revision:body.fields.revision+1};return json({metadata:metadata[body.key]});}
    if(['/reports/run','/reports/latest','/reports/refresh'].includes(path)){const report={workflow:body?.workflow||'all',generatedAt:'2026-10-11T09:00:00Z',period:{start:body?.start||'2026-10-05',end:body?.end||'2026-10-11'},coverage:{examined:2},warnings:[],hoursLabel:'Current hours on tickets in the selected cohort; these are ticket totals, not hours worked during the period.',totals:{open:2,created:1,completed:0,atRisk:1,overrides:0},groups:[],tickets:[{key:'AION-101',title:'Synthetic Jira task',clientId:'client',clientName:'Synthetic Client',status:'Open',closed:false,devs:['builder'],created:'2026-10-10T09:00:00Z',billing:'billable',estimatedHours:2,actualHours:3,missing:[],risks:['Overdue'],overEstimate:{hours:1,percent:50},overrides:[]},{key:'INT-101',title:'Synthetic internal task',internal:true,clientId:'client',clientName:'Synthetic Client',status:'Open',closed:false,devs:['reviewer'],created:'2026-09-01T09:00:00Z',billing:'not_billable',estimatedHours:2,actualHours:null,missing:[],risks:[],overrides:[]}]};return json(path==='/reports/run'?report:{report,cached:path==='/reports/latest',stale:false});}
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
    if(/^\/internal\/INT-\d+\/comment$/.test(path)&&method==="POST"){const t=internalTickets.find(x=>path.includes(x.key+"/"));t.comments=[...(t.comments||[]),{author:{name:"Test User",email:"test@example.invalid"},created:"2026-10-11T09:00:0"+t.comments.length+".000Z",body:body.text}];return json({ticket:t});}
    if(/^\/internal\/INT-\d+\/comment\/\d+$/.test(path)&&method==="PUT"){const t=internalTickets.find(x=>path.includes(x.key+"/")),c=t.comments[Number(path.split("/").pop())];c.body=body.text;c.edited="2026-10-11T09:01:00.000Z";return json({ticket:t});}
    if(/^\/jira\/issue\/AION-\d+\/comment\/\w+$/.test(path)&&method==="PUT")return json({id:path.split("/").pop(),body:body.text});
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


// A tiny valid PNG, served as the picture's file.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// A picture pasted into a Jira comment comes back from Jira as its thumbnail: /rest/api/3/attachment/thumbnail/<id>,
// with the file name in data-attachment-name. It shows as the picture inside that comment.
test("a picture in a Jira comment shows inside the comment (Jira's thumbnail address)", async ({ page }) => {
  const mock = await mockDashboard(page);
  const comment = '<p>See below<br/><span class="image-wrap"><a id="550693_thumb" href="/rest/api/3/attachment/content/550693" file-preview-type="image" file-preview-id="550693" file-preview-title="picture-20261102120246.png"><jira-attachment-thumbnail><img src="https://jira.invalid/rest/api/3/attachment/thumbnail/550693" data-attachment-name="picture-20261102120246.png" data-attachment-type="thumbnail"/></jira-attachment-thumbnail></a></span></p>';
  const issue = { ...jiraIssue, fields: { ...jiraIssue.fields, attachment: [{ id: "550693", filename: "picture-20261102120246.png", mimeType: "image/png", size: 68, created: "2026-11-02T12:03:04Z", author: { displayName: "Test Lead" } }],
    comment: { comments: [{ id: "c9", author: { accountId: "test-lead", displayName: "Test Lead" }, created: "2026-11-02T12:03:09Z", body: "See below" }] } },
    renderedFields: { ...jiraIssue.renderedFields, comment: { comments: [{ body: comment }] } } };
  await page.route("**/jira/search", (r) => r.fulfill({ json: { issues: [issue], isLast: true } }));
  await page.route("**/jira/issue/AION-101/attachments/550693", (r) => r.fulfill({ contentType: "image/png", body: PNG }));
  await page.goto("/dashboard.html#AION-101");
  const pic = page.locator("#d-comments .cmt").last().locator(".cimg img");
  await expect(pic).toHaveAttribute("alt", "picture-20261102120246.png");
  await expect(pic).toHaveAttribute("src", /^blob:/);
  await expect(page.locator("#d-comments .cmt").last()).not.toContainText(/^image$/);
  expect(mock.errors).toEqual([]);
});

// Odoo: the Attachments box shows, each chatter message shows its files, and pictures load through the proxy.
test("Odoo tickets show their attachments and each chatter message's files", async ({ page }) => {
  const mock = await mockDashboard(page, { odoo: true });
  const files = [{ id: 503, filename: "screenshot.png", mimeType: "image/png", size: 68, created: "2026-10-10T09:00:00Z", author: { displayName: "Ariel Amiri" } },
    { id: 501, filename: "invoice.pdf", mimeType: "application/pdf", size: 5, created: "2026-10-09T09:00:00Z", author: { displayName: "Test Lead" } }];
  await page.route("**/odoo/tickets/HD-300", (r) => r.request().method() !== "GET" ? r.fallback() : r.fulfill({ json: { ticket: odooTicket, description: "<p>Customer description</p>", attachments: files,
    messages: [{ author: "Ariel Amiri", when: "2026-10-10T09:00:00Z", body: "", note: false, email: true, attachments: [files[0]] },
      { author: "Test Lead", when: "2026-10-10T10:00:00Z", body: "<p>Invoice attached</p>", note: true, email: false, attachments: [files[1]] }],
    stages: [{ id: 2, name: "In Progress", cat: "indeterminate" }] } }));
  await page.route("**/odoo/tickets/HD-300/attachments/503", (r) => r.fulfill({ contentType: "image/png", body: PNG }));
  await page.goto("/dashboard.html#HD-300");
  const msgs = page.locator("#d-comments .cmt");
  await expect(msgs).toHaveCount(2);
  await expect(msgs.first().locator(".cimg img")).toHaveAttribute("src", /^blob:/);
  await expect(msgs.last()).toContainText("invoice.pdf"); await expect(msgs.last().getByRole("button", { name: "Download" })).toBeVisible();
  await expect(page.locator("#d-att")).toBeVisible(); await expect(page.locator("#d-acount")).toHaveText("(2)");
  for (const upload of await page.locator('label[for="j-file"]').all()) await expect(upload).toBeHidden();
  expect(mock.errors).toEqual([]);
});

// Odoo: a pasted picture is uploaded to the ticket and attached to the reply to the customer.
test("a picture pasted on an Odoo ticket is uploaded and attached to the reply", async ({ page }) => {
  const mock = await mockDashboard(page, { odoo: true });
  const uploads = [], notes = [];
  await page.route("**/odoo/tickets/HD-300/attachments?name=*", async (r) => { uploads.push(new URL(r.request().url()).searchParams.get("name")); return r.fulfill({ status: 201, json: { attachment: { id: 777, filename: uploads.at(-1), mimeType: "image/png", size: 68 } } }); });
  await page.route("**/odoo/tickets/HD-300/note", (r) => { notes.push(r.request().postDataJSON()); return r.fulfill({ status: 201, json: { ok: true } }); });
  await page.goto("/dashboard.html#HD-300");
  await expect(page.locator('label[for="c-img"]')).toBeVisible();
  await page.locator("#c-img").setInputFiles({ name: "image.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator("#d-cfiles .cfile-chip")).toHaveCount(1);
  await expect(page.locator("#d-cmsg")).toContainText("goes into the reply when you send it");
  await expect(page.locator("#d-cfiles .cfile-chip img")).toHaveAttribute("src", /^blob:/);
  expect(uploads[0]).toMatch(/^picture-\d+\.png$/);
  await page.locator("#d-reply").fill("Here is the screen");
  page.once("dialog", (d) => d.accept());
  await page.locator("#d-reply-customer").click();
  await expect.poll(() => notes.length).toBe(1);
  expect(notes[0]).toEqual({ text: "Here is the screen", attachmentIds: [777], toCustomer: true });
  await expect(page.locator("#d-cfiles .cfile-chip")).toHaveCount(0);
  expect(mock.errors).toEqual([]);
});

// Odoo: Reply to customer asks first and is sent to the customer by Odoo; there is no separate "Add internal
// note" (the Internal note button writes the team note, in the dashboard and in Odoo's chatter).
test("Odoo tickets have Reply to customer (which asks first) and Internal note, not Add internal note", async ({ page }) => {
  const mock = await mockDashboard(page, { odoo: true });
  const notes = [];
  await page.route("**/odoo/tickets/HD-300/note", (r) => { notes.push(r.request().postDataJSON()); return r.fulfill({ status: 201, json: { ok: true } }); });
  await page.goto("/dashboard.html#HD-300");
  await expect(page.locator("#d-reply-customer")).toBeVisible();
  await expect(page.locator("#d-send")).toBeHidden();
  await expect(page.locator("#d-comment-note")).toBeVisible();
  await page.locator("#d-reply").fill("We fixed it, please check");
  page.once("dialog", (d) => d.dismiss());
  await page.locator("#d-reply-customer").click();
  expect(notes).toEqual([]);
  page.once("dialog", (d) => { expect(d.message()).toContain("Send this reply to the customer by email?"); d.accept(); });
  await page.locator("#d-reply-customer").click();
  await expect.poll(() => notes.length).toBe(1);
  expect(notes[0]).toEqual({ text: "We fixed it, please check", toCustomer: true });
  await expect(page.locator("#d-cmsg")).toContainText("Sent to the customer");
  expect(mock.errors).toEqual([]);
});

test("Jira tickets keep Add comment and have no Reply to customer", async ({ page }) => {
  const mock = await mockDashboard(page);
  await page.goto("/dashboard.html#AION-101");
  await expect(page.locator("#d-send")).toHaveText("Add comment");
  await expect(page.locator("#d-reply-customer")).toBeHidden();
  expect(mock.errors).toEqual([]);
});

// Jira: a pasted picture shows as a preview above the box (the text stays clean) and goes into the comment when sent.
test("a picture pasted into a Jira comment shows as a preview and goes into the comment when sent", async ({ page }) => {
  const mock = await mockDashboard(page);
  let uploaded = "";
  await page.route("**/jira/issue/AION-101/attachments?name=*", (r) => { uploaded = new URL(r.request().url()).searchParams.get("name"); return r.fulfill({ json: { attachments: [{ id: "900", filename: uploaded }] } }); });
  await page.goto("/dashboard.html#AION-101");
  await page.locator("#d-reply").fill("See the screen");
  await page.locator("#c-img").setInputFiles({ name: "image.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator("#d-cfiles .cfile-chip img")).toHaveAttribute("src", /^blob:/);
  await expect(page.locator("#d-cfiles .cfile-chip")).toContainText(uploaded);
  await expect(page.locator("#d-reply")).toHaveValue("See the screen");
  await page.locator("#d-send").click();
  await expect.poll(() => mock.calls.find((c) => c.path === "/jira/issue/AION-101/comment")?.body?.text).toBe("See the screen\n!" + uploaded + "|thumbnail!");
  await expect(page.locator("#d-cfiles .cfile-chip")).toHaveCount(0);
  expect(mock.errors).toEqual([]);
});

// The × leaves a picture out of the comment; a comment can be only a picture.
test("a picture can be left out with ×, and a comment can be only a picture", async ({ page }) => {
  const mock = await mockDashboard(page);
  let n = 0;
  await page.route("**/jira/issue/AION-101/attachments?name=*", (r) => r.fulfill({ json: { attachments: [{ id: String(900 + n), filename: "picture-" + (++n) + ".png" }] } }));
  await page.goto("/dashboard.html#AION-101");
  await page.locator("#c-img").setInputFiles([{ name: "a.png", mimeType: "image/png", buffer: PNG }]);
  await page.locator("#c-img").setInputFiles([{ name: "b.png", mimeType: "image/png", buffer: PNG }]);
  await expect(page.locator("#d-cfiles .cfile-chip")).toHaveCount(2);
  await page.getByRole("button", { name: "Don't add picture-1.png to the comment" }).click();
  await expect(page.locator("#d-cfiles .cfile-chip")).toHaveCount(1);
  await page.locator("#d-send").click();
  await expect.poll(() => mock.calls.find((c) => c.path === "/jira/issue/AION-101/comment")?.body?.text).toBe("!picture-2.png|thumbnail!");
  expect(mock.errors).toEqual([]);
});

// Opened again, a comment's picture shows at full size (up to the comment's width), not as a small thumbnail.
test("a comment's picture shows at full size when the ticket is opened again", async ({ page }) => {
  const mock = await mockDashboard(page);
  // A 1×600 tall picture: full height, not cut down to a thumbnail.
  const tall = Buffer.from(await page.evaluate(async () => { const c = document.createElement("canvas"); c.width = 300; c.height = 600; const b = await new Promise((r) => c.toBlob(r, "image/png")); return [...new Uint8Array(await b.arrayBuffer())]; }));
  const comment = '<p><span class="image-wrap"><img src="https://jira.invalid/rest/api/3/attachment/thumbnail/551" data-attachment-name="picture-1.png"/></span></p>';
  const issue = { ...jiraIssue, fields: { ...jiraIssue.fields, attachment: [{ id: "551", filename: "picture-1.png", mimeType: "image/png", size: tall.length, created: "2026-11-03T08:00:00Z", author: { displayName: "Test Lead" } }],
    comment: { comments: [{ id: "c9", author: { accountId: "test-lead", displayName: "Test Lead" }, created: "2026-11-03T08:00:00Z", body: "" }] } },
    renderedFields: { ...jiraIssue.renderedFields, comment: { comments: [{ body: comment }] } } };
  await page.route("**/jira/search", (r) => r.fulfill({ json: { issues: [issue], isLast: true } }));
  await page.route("**/jira/issue/AION-101/attachments/551", (r) => r.fulfill({ contentType: "image/png", body: tall }));
  await page.goto("/dashboard.html#AION-101");
  const img = page.locator("#d-comments .cimg img");
  await expect(img).toHaveAttribute("src", /^blob:/);
  await expect.poll(async () => (await img.boundingBox())?.height).toBeGreaterThan(590);
  expect(mock.errors).toEqual([]);
});

// Internal tickets work the same way: preview above the box, then the picture goes into the comment as !name!.
test("a picture pasted into an internal ticket comment shows as a preview and goes into the comment when sent", async ({ page }) => {
  const mock = await mockDashboard(page);
  let uploaded = "";
  await page.route("**/internal/INT-101/attachments?name=*", (r) => { uploaded = new URL(r.request().url()).searchParams.get("name");
    return r.fulfill({ json: { ticket: { ...internalTicket, attachments: [{ id: "a1", filename: uploaded, mimeType: "image/png", size: PNG.length, created: "2026-11-03T08:00:00Z" }] } } }); });
  await page.goto("/dashboard.html#INT-101");
  await page.locator("#d-reply").fill("Here it is");
  await page.locator("#c-img").setInputFiles({ name: "image.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator("#d-cfiles .cfile-chip img")).toHaveAttribute("src", /^blob:/);
  await expect(page.locator("#d-reply")).toHaveValue("Here it is");
  await page.locator("#d-send").click();
  await expect.poll(() => mock.calls.find((c) => c.path === "/internal/INT-101/comment")?.body?.text).toBe("Here it is\n!" + uploaded + "!");
  await expect(page.locator("#d-cfiles .cfile-chip")).toHaveCount(0);
  expect(mock.errors).toEqual([]);
});

// ---- Before anything is drawn (assets/early.js) ----
// Not signed in (a private window): straight to the sign-in page, keeping the ticket link; the dashboard never loads.
test("not signed in, the dashboard goes straight to the sign-in page without showing itself", async ({ page }) => {
  const mock = await mockDashboard(page, { expired: true });
  await page.goto("/dashboard.html?page=tickets#AION-101");
  await expect(page).toHaveURL(/\/index\.html\?page=tickets#AION-101$/);
  expect(mock.calls.some((c) => c.path === "/config" || c.path === "/jira/search")).toBe(false);
  expect(mock.errors).toEqual([]);
});

// AI1 Monitor's sign-in: nothing of the dashboard is drawn; the code is fetched once and the browser goes on.
test("AI1 Monitor's sign-in goes straight on to the Monitor without drawing the dashboard", async ({ page }) => {
  const mock = await mockDashboard(page);
  const state = "synthetic-state-0000000009", seen = [];
  await page.route("**/sso/monitor/code", (r) => { seen.push(r.request().postDataJSON()); return r.fulfill({ json: { code: "synthetic-code-000000000009", callback: "https://monitor.ai1.host/auth/aione/callback" } }); });
  await page.route("https://monitor.ai1.host/**", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>AI1 Monitor</title><p>Monitor</p>" }));
  await page.goto("/dashboard.html?ai1-monitor=" + state);
  await expect(page).toHaveURL("https://monitor.ai1.host/auth/aione/callback?code=synthetic-code-000000000009&state=" + state);
  expect(seen).toEqual([{ state }]);
  expect(mock.calls.some((c) => c.path === "/jira/search")).toBe(false);
});

test("a Monitor sign-in that Team Control refuses shows the dashboard and says why", async ({ page }) => {
  const mock = await mockDashboard(page);
  await page.route("**/sso/monitor/code", (r) => r.fulfill({ status: 403, json: { code: "forbidden", error: "This account can't use AI1 Monitor." } }));
  await page.goto("/dashboard.html?ai1-monitor=synthetic-state-0000000010");
  await expect(page.locator("#updated")).toHaveText("not connected");
  await expect(page.locator("body")).toContainText("This account can't use AI1 Monitor.");
  expect(await page.evaluate(() => document.documentElement.style.visibility)).toBe("");
  expect(page.url()).toContain("/dashboard.html?ai1-monitor=");
});
