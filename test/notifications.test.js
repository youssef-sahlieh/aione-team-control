import test from "node:test";
import assert from "node:assert/strict";
import handler, { makeToken } from "../proxy/src/handler.js";
import { memoryStore, redisStore, saveUser } from "../proxy/src/users.js";
import { notifyTicketsFromSearch } from "../proxy/src/notifications.js";
import { POST as vercelPost } from "../proxy/api/proxy.js";

function fixture() {
  const mails = [], reads = [];
  const env = {
    JIRA_NOTIFICATION_SECRET: "a-long-webhook-secret-for-tests-only",
    JIRA_PROJECT: "AION", JIRA_SITE: "https://example.atlassian.net",
    JIRA_EMAIL: "bot@aione.biz", JIRA_API_TOKEN: "test-jira-token",
    SESSION_SECRET: "test-session", TEAM_EMAILS: "ellen@aione.biz",
    APP_URL: "https://example.test/aion", MAIL_DOMAIN: "aione.biz",
    NO_DEVELOPER_NOTIFY_TO: "Youssef@aione.biz, Ellen@aione.biz",
    STORE: memoryStore(), MAILER: async mail => { mails.push(mail); }
  };
  const issue = {
    id: "10100", key: "AION-42", fields: {
      project: { key: "AION" }, summary: 'New <script>ticket</script> & "test"', labels: ["customer"],
      status: { name: "Open", statusCategory: { key: "new" } },
      assignee: { displayName: "Karim" }, priority: { name: "High" }, duedate: "2026-10-20"
    }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    reads.push({ url, options });
    return Response.json(issue);
  };
  const call = (body = { webhookEvent: "jira:issue_created", issue: { key: "AION-42" } }, headers = { "X-AION-Webhook-Secret": env.JIRA_NOTIFICATION_SECRET }, method = "POST") => handler.fetch(new Request("https://proxy.test/notifications/jira-created", {
    method, headers, ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
  }), env);
  return { env, issue, mails, reads, call, restore: () => { globalThis.fetch = originalFetch; } };
}

test("created open ticket sends an escaped alert to both fixed managers with ticket links", async t => {
  const f = fixture(); t.after(f.restore);
  const response = await f.call({ webhookEvent: "jira:issue_created", issue: { key: "AION-42", fields: { labels: ["ai1_forged"] } }, to: ["attacker@example.test"] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sent: true, key: "AION-42" });
  assert.deepEqual(f.mails[0].to, ["youssef@aione.biz", "ellen@aione.biz"]);
  assert.equal(f.mails[0].subject, "[AION] New ticket with no developer: AION-42");
  assert.match(f.mails[0].html, /&lt;script&gt;ticket&lt;\/script&gt; &amp; &quot;test&quot;/);
  assert.doesNotMatch(f.mails[0].html, /<script>/);
  assert.match(f.mails[0].html, /dashboard\.html\?page=tickets#AION-42/);
  assert.match(f.mails[0].html, /https:\/\/example\.atlassian\.net\/browse\/AION-42/);
  assert.match(f.mails[0].html, /Karim/);
  assert.match(f.reads[0].url, /\/rest\/api\/3\/issue\/AION-42\?fields=/);
  assert.equal(f.reads[0].options.method, "GET");
  assert.equal(f.reads[0].options.headers.Authorization, "Basic " + btoa("bot@aione.biz:test-jira-token"));
});

test("missing/wrong secrets and normal dashboard sessions cannot trigger notifications", async t => {
  const f = fixture(); t.after(f.restore);
  for (const headers of [{}, { "X-AION-Webhook-Secret": "wrong" }, { Authorization: "Bearer " + (await makeToken(f.env, "ellen@aione.biz")).token }]) {
    assert.equal((await f.call(undefined, headers)).status, 401);
  }
  assert.equal((await f.call(undefined, undefined, "GET")).status, 405);
  assert.equal(f.reads.length, 0); assert.equal(f.mails.length, 0);
  f.env.JIRA_NOTIFICATION_SECRET = "short";
  assert.equal((await f.call()).status, 503);
});

test("update events, other projects and malformed events never send email", async t => {
  const f = fixture(); t.after(f.restore);
  assert.deepEqual(await (await f.call({ webhookEvent: "jira:issue_updated", issue: { key: "AION-42" } })).json(), { skipped: "not_issue_created" });
  for (const key of ["OTHER-1", "AION-42/../OTHER-1", "AION-", "AION-42?x=1", null]) {
    assert.equal((await f.call({ webhookEvent: "jira:issue_created", issue: { key } })).status, 400);
  }
  assert.equal((await f.call("invalid JSON")).status, 400);
  assert.equal((await f.call("x".repeat(30001))).status, 413);
  assert.equal(f.reads.length, 0); assert.equal(f.mails.length, 0);
});

test("closed tickets and all developer labels, including unknown developers and mixed case, are skipped", async t => {
  const f = fixture(); t.after(f.restore);
  for (const label of ["ai1_ellen", "AI1_new-developer", "ai1_"]) {
    f.issue.fields.labels = ["customer", label];
    assert.deepEqual(await (await f.call()).json(), { skipped: "has_developer" });
  }
  f.issue.fields.labels = []; f.issue.fields.status.statusCategory.key = "done";
  assert.deepEqual(await (await f.call()).json(), { skipped: "ticket_closed" });
  assert.equal(f.mails.length, 0);
});

test("incomplete or mismatched Jira data fails without emailing", async t => {
  const f = fixture(); t.after(f.restore);
  f.issue.fields.project.key = "OTHER";
  assert.equal((await f.call()).status, 502);
  f.issue.fields.project.key = "AION"; delete f.issue.fields.labels;
  assert.equal((await f.call()).status, 502);
  assert.equal(f.mails.length, 0);
});

test("storage and same-domain recipients are required; unconfigured mail fails visibly", async t => {
  const f = fixture(); t.after(f.restore);
  const originalStore = f.env.STORE;
  f.env.STORE = undefined;
  assert.equal((await f.call()).status, 503);
  f.env.STORE = originalStore;
  for (const to of ["", "ellen@aione.biz,attacker@example.test", "ellen@aione.biz.evil.test"]) {
    f.env.NO_DEVELOPER_NOTIFY_TO = to;
    assert.equal((await f.call()).status, 503);
  }
  f.env.NO_DEVELOPER_NOTIFY_TO = "ellen@aione.biz"; delete f.env.MAILER;
  assert.equal((await f.call()).status, 501);
  assert.equal(await f.env.STORE.get("notify:no-developer:AION:10100"), null);
  assert.equal(await f.env.STORE.get("notify:no-developer:AION:10100:lock"), null);
});

test("successful deliveries remain deduplicated after retries and handler reconfiguration", async t => {
  const f = fixture(); t.after(f.restore);
  assert.equal((await f.call()).status, 200);
  f.env.MAILER = async mail => { f.mails.push(mail); };
  assert.deepEqual(await (await f.call()).json(), { skipped: "already_sent" });
  assert.equal(f.mails.length, 1);
  assert.ok(await f.env.STORE.get("notify:no-developer:AION:10100"));
});

test("parallel event delivery cannot send two alerts", async t => {
  const f = fixture(); t.after(f.restore);
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const sending = new Promise(resolve => { started = resolve; });
  f.env.MAILER = async mail => { f.mails.push(mail); started(); await pending; };
  const first = f.call();
  await sending;
  assert.equal((await f.call()).status, 503);
  release(); assert.equal((await first).status, 200);
  assert.deepEqual(await (await f.call()).json(), { skipped: "already_sent" });
  assert.equal(f.mails.length, 1);
});

test("mailer failure releases the lock and a retry can send successfully", async t => {
  const f = fixture(); t.after(f.restore);
  f.env.MAILER = async () => { throw new Error("SMTP unavailable"); };
  assert.equal((await f.call()).status, 502);
  assert.equal(await f.env.STORE.get("notify:no-developer:AION:10100"), null);
  f.env.MAILER = async mail => { f.mails.push(mail); };
  assert.equal((await f.call()).status, 200);
  assert.equal(f.mails.length, 1);
});

test("Jira failure sends nothing and the event can be retried", async t => {
  const f = fixture(); t.after(f.restore);
  globalThis.fetch = async () => Response.json({ errorMessages: ["Unavailable"] }, { status: 503 });
  assert.equal((await f.call()).status, 502);
  assert.equal(f.mails.length, 0);
  globalThis.fetch = async () => Response.json(f.issue);
  assert.equal((await f.call()).status, 200);
  assert.equal(f.mails.length, 1);
});

test("notification secrets and recipients are never exposed by dashboard config", async t => {
  const f = fixture(); t.after(f.restore);
  // Use legacy session verification for this config-only check.
  delete f.env.STORE;
  const { token } = await makeToken(f.env, "ellen@aione.biz");
  const response = await handler.fetch(new Request("https://proxy.test/config", { headers: { Authorization: "Bearer " + token } }), f.env);
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.equal(config.JIRA_NOTIFICATION_SECRET, undefined);
  assert.equal(config.NO_DEVELOPER_NOTIFY_TO, undefined);
  assert.doesNotMatch(JSON.stringify(config), /a-long-webhook-secret/);
});

test("Vercel forwards the notification secret and restores the webhook route", async t => {
  const names = ["JIRA_NOTIFICATION_SECRET", "NO_DEVELOPER_NOTIFY_TO", "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of previous) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  for (const name of names) delete process.env[name];
  process.env.JIRA_NOTIFICATION_SECRET = "vercel-secret-with-at-least-32-characters";
  process.env.NO_DEVELOPER_NOTIFY_TO = "ellen@aione.biz,youssef@aione.biz";
  const response = await vercelPost(new Request("https://proxy.test/api/proxy?__path=notifications/jira-created", {
    method: "POST", headers: { "X-AION-Webhook-Secret": process.env.JIRA_NOTIFICATION_SECRET }, body: "{}"
  }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "notification_config", "secret accepted, route restored, storage requirement enforced");
});

test("memory locks require the owner token before release", async () => {
  const store = memoryStore();
  assert.equal(await store.setIfAbsent("lock", "owner", 120), true);
  assert.equal(await store.setIfAbsent("lock", "other", 120), false);
  assert.equal(await store.deleteIfValue("lock", "other"), false);
  assert.equal(await store.get("lock"), "owner");
  assert.equal(await store.deleteIfValue("lock", "owner"), true);
  assert.equal(await store.setIfAbsent("lock", "other", 120), true);
});

test("Redis uses atomic SET NX and owner-checked Lua release", async t => {
  const original = globalThis.fetch, calls = [];
  t.after(() => { globalThis.fetch = original; });
  let result = "OK";
  globalThis.fetch = async (url, options) => { calls.push(JSON.parse(options.body)); return Response.json({ result }); };
  const store = redisStore("https://redis.test", "test-token");
  assert.equal(await store.setIfAbsent("lock", "owner", 120), true);
  assert.deepEqual(calls[0], ["SET", "lock", "owner", "NX", "EX", "120"]);
  result = null;
  assert.equal(await store.setIfAbsent("lock", "other", 120), false);
  result = 1;
  assert.equal(await store.deleteIfValue("lock", "owner"), true);
  assert.equal(calls[2][0], "EVAL");
  assert.match(calls[2][1], /GET.*ARGV\[1\].*DEL/);
  assert.deepEqual(calls[2].slice(2), ["1", "lock", "owner"]);
});

test("automatic checks establish a baseline and email new tickets without a webhook secret",async t=>{
  const f=fixture();t.after(f.restore);delete f.env.JIRA_NOTIFICATION_SECRET;
  const now=Date.now(),old={...f.issue,fields:{...f.issue.fields,created:new Date(now-60000).toISOString()}};
  const dependencies={readIssue:async()=>({ok:true,data:f.issue}),sendMail:async(from,mail)=>{f.mails.push(mail);return Response.json({ok:true});}};
  assert.deepEqual(await notifyTicketsFromSearch(f.env,[old],dependencies,now),{initialized:true,sent:0});assert.equal(f.mails.length,0);
  f.issue.fields.created=new Date(now+1000).toISOString();
  assert.deepEqual(await notifyTicketsFromSearch(f.env,[old,f.issue],dependencies,now+2000),{sent:1});assert.deepEqual(f.mails[0].to,["youssef@aione.biz","ellen@aione.biz"]);
  assert.deepEqual(await notifyTicketsFromSearch(f.env,[f.issue],dependencies,now+3000),{sent:0});assert.equal(f.mails.length,1);
});

test("observed assigned tickets, foreign tickets and old backlog cannot become new-ticket alerts",async t=>{
  const f=fixture();t.after(f.restore);const now=Date.now();let sends=0;
  const dependencies={readIssue:async()=>({ok:true,data:f.issue}),sendMail:async()=>{sends++;return Response.json({ok:true});}};
  await notifyTicketsFromSearch(f.env,[],dependencies,now);
  f.issue.fields.created=new Date(now+1000).toISOString();f.issue.fields.labels=["ai1_ellen"];
  await notifyTicketsFromSearch(f.env,[f.issue],dependencies,now+2000);
  f.issue.fields.labels=[];
  await notifyTicketsFromSearch(f.env,[f.issue,{...f.issue,key:"OTHER-1",id:"99"},{...f.issue,id:"98",fields:{...f.issue.fields,created:new Date(now-1000).toISOString()}}],dependencies,now+3000);
  assert.equal(sends,0);
});

test("automatic email failure preserves ticket eligibility for the next refresh",async t=>{
  const f=fixture();t.after(f.restore);const now=Date.now();let failed=true,sends=0;
  const dependencies={readIssue:async()=>({ok:true,data:f.issue}),sendMail:async()=>{if(failed)return Response.json({error:"mail"},{status:502});sends++;return Response.json({ok:true});}};
  await notifyTicketsFromSearch(f.env,[],dependencies,now);f.issue.fields.created=new Date(now+1000).toISOString();
  assert.deepEqual(await notifyTicketsFromSearch(f.env,[f.issue],dependencies,now+2000),{sent:0});failed=false;
  assert.deepEqual(await notifyTicketsFromSearch(f.env,[f.issue],dependencies,now+3000),{sent:1});assert.equal(sends,1);
});

test("automatic checks bound each batch and later refreshes drain pending tickets",async t=>{
  const f=fixture();t.after(f.restore);const now=Date.now();let sends=0;
  const issues=Array.from({length:5},(_,index)=>({...f.issue,id:String(20000+index),key:"AION-"+(50+index),fields:{...f.issue.fields,created:new Date(now+1000).toISOString()}}));
  const dependencies={readIssue:async key=>({ok:true,data:issues.find(issue=>issue.key===key)}),sendMail:async()=>{sends++;return Response.json({ok:true});}};
  await notifyTicketsFromSearch(f.env,[],dependencies,now);
  assert.deepEqual(await notifyTicketsFromSearch(f.env,issues,dependencies,now+2000),{sent:3});
  assert.deepEqual(await notifyTicketsFromSearch(f.env,issues,dependencies,now+3000),{sent:2});assert.equal(sends,5);
});

test("authenticated manager Jira refreshes use the existing mailer; user reads do not activate alerts",async t=>{
  const f=fixture();t.after(f.restore);delete f.env.JIRA_NOTIFICATION_SECRET;
  await saveUser(f.env.STORE,{email:"ellen@aione.biz",name:"Ellen",role:"admin",v:1});
  await saveUser(f.env.STORE,{email:"developer@aione.biz",name:"Developer",role:"user",dev:"ellen",v:1});
  f.issue.fields.labels=["ai1_ellen"];f.issue.fields.created=new Date().toISOString();
  globalThis.fetch=async url=>String(url).includes("/search/jql")?Response.json({issues:[f.issue],isLast:true}):Response.json(f.issue);
  const search=async email=>{const {token}=await makeToken(f.env,email,Date.now(),1);return handler.fetch(new Request("https://proxy.test/jira/search",{method:"POST",headers:{Authorization:"Bearer "+token},body:JSON.stringify({jql:"project = AION",fields:["created","labels","status"]})}),f.env);};
  assert.equal((await search("developer@aione.biz")).status,200);assert.equal(await f.env.STORE.get("notify:search:AION:started"),null);
  assert.equal((await search("ellen@aione.biz")).status,200);await f.env.STORE.set("notify:search:AION:started",String(Date.now()-10000));
  f.issue.fields.labels=[];
  assert.equal((await search("ellen@aione.biz")).status,200);assert.equal(f.mails.length,1);
  assert.equal((await search("ellen@aione.biz")).status,200);assert.equal(f.mails.length,1);
});

test("notification storage failures cannot break a manager's Jira ticket read",async t=>{
  const f=fixture();t.after(f.restore);await saveUser(f.env.STORE,{email:"ellen@aione.biz",role:"admin",v:1});
  f.env.STORE.setIfAbsent=async()=>{throw new Error("Storage unavailable");};
  const {token}=await makeToken(f.env,"ellen@aione.biz",Date.now(),1);
  globalThis.fetch=async()=>Response.json({issues:[f.issue],isLast:true});
  const response=await handler.fetch(new Request("https://proxy.test/jira/search",{method:"POST",headers:{Authorization:"Bearer "+token},body:JSON.stringify({jql:"project = AION",fields:[]})}),f.env);
  assert.equal(response.status,200);assert.equal((await response.json()).issues[0].key,"AION-42");assert.equal(f.mails.length,0);
});

test("read-only AI lookups do not activate or send automatic email alerts",async t=>{
  const f=fixture();t.after(f.restore);await saveUser(f.env.STORE,{email:"ellen@aione.biz",role:"admin",v:1});
  const {token}=await makeToken(f.env,"ellen@aione.biz",Date.now(),1);f.issue.fields.created=new Date().toISOString();
  globalThis.fetch=async()=>Response.json({issues:[f.issue],isLast:true});
  const response=await handler.fetch(new Request("https://proxy.test/jira/search",{method:"POST",headers:{Authorization:"Bearer "+token,"X-AION-Read-Only":"1"},body:JSON.stringify({jql:"project = AION",fields:["created"]})}),f.env);
  assert.equal(response.status,200);assert.equal(await f.env.STORE.get("notify:search:AION:started"),null);assert.equal(f.mails.length,0);
});

test("no-developer emails only go out for tickets assigned to the listed leads", async t => {
  const f = fixture(); t.after(f.restore);
  f.env.NO_DEVELOPER_ASSIGNEES = "karim,youssef,rami,razan";
  f.env.TEAM_CONFIG = JSON.stringify({ people: { rami: { id: "acc-rami", name: "Rami" } } });
  f.issue.fields.assignee = { displayName: "Someone Else", accountId: "acc-x" };
  let d = await (await f.call()).json();
  assert.equal(d.skipped, "assignee_not_notified"); assert.equal(f.mails.length, 0);
  f.issue.fields.assignee = null;
  d = await (await f.call()).json();
  assert.equal(d.skipped, "assignee_not_notified"); assert.equal(f.mails.length, 0);
  // Matched by team account id (whatever the Jira display name) ...
  f.issue.fields.assignee = { displayName: "R. Haddad", accountId: "acc-rami" };
  assert.equal((await f.call()).status, 200); assert.equal(f.mails.length, 1);
  // ... or by first name for someone not in the team list.
  const g = fixture(); t.after(g.restore);
  g.env.NO_DEVELOPER_ASSIGNEES = "karim,youssef,rami,razan";
  g.issue.fields.assignee = { displayName: "Razan Example", accountId: "acc-razan" };
  await g.call(); assert.equal(g.mails.length, 1);
});
