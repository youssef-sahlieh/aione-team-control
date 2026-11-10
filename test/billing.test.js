// Billable work, allowances, the exhaustion alert and the billable export, on synthetic data: the in-memory database,
// a fake Odoo and a fake mail service. Nothing here reaches a real service.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{makeToken} from '../proxy/src/handler.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';
import {metadataKey,odooProjectsKey} from '../proxy/src/ticket-metadata.js';
import {todayIn} from '../proxy/src/time-entries.js';
import {effectiveBilling,allowanceStatus,billingSnapshot,reconcileTicket,readLedger,evaluateAlerts,deliverAlert,readBillingConfig,mailMode,recipients,alertMail,scanOdoo,runScan,quotationLink,syncBillingFromOdoo,readProjectDefaults} from '../proxy/src/billing.js';

const admin={email:'admin@example.invalid',name:'Manager',role:'admin',dev:'builder',v:1};
const user={email:'user@example.invalid',name:'Dana Developer',role:'user',dev:'builder',v:1};
const today=todayIn(),daysAgo=n=>new Date(Date.parse(today+'T12:00:00Z')-n*86400000).toISOString().slice(0,10);
const start=daysAgo(20);

async function setup(extra={}){
  const env={SESSION_SECRET:'synthetic-secret',JIRA_PROJECT:'AION',JIRA_SITE:'https://jira.invalid',STORE:memoryStore(),TIME_SYNC_SECRET:'s'.repeat(32),
    MAIL_DOMAIN:'example.invalid',NO_DEVELOPER_NOTIFY_TO:'sales@example.invalid, Ops@example.invalid',...extra};
  for(const me of [admin,user])await saveUser(env.STORE,me);
  const tokens={};for(const me of [admin,user])tokens[me.email]=(await makeToken(env,me.email,Date.now(),1)).token;
  await env.STORE.set(odooProjectsKey(env),JSON.stringify({syncedAt:Date.now(),projects:[
    {id:10,name:'Branch A',active:true,clientId:900,clientName:'Acme',label:'Acme → Branch A'},
    {id:12,name:'Support',active:true,clientId:900,clientName:'Acme',label:'Acme → Support'},
    {id:20,name:'Website',active:true,clientId:901,clientName:'Beta & Co',label:'Beta & Co → Website'}]}));
  const call=async(path,method='GET',body,me=admin,headers={})=>{const r=await worker.fetch(new Request('https://proxy.invalid'+path,{method,headers:{Authorization:'Bearer '+tokens[me.email],'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()};};
  const B='business:AION:billing:';
  const s={env,call,
    config:c=>env.STORE.set(B+'config',JSON.stringify({revision:1,classification:true,emails:'dry',fields:{project:'',task:''},values:{project:{},task:{}},quotationUrl:'',...c})),
    projects:items=>env.STORE.set(B+'projects',JSON.stringify({revision:1,items:Object.fromEntries(Object.entries(items).map(([id,billing])=>[id,{billing}]))})),
    allowances:items=>env.STORE.set(B+'allowances',JSON.stringify({revision:1,items:items.map(a=>({id:'a1',kind:'package',label:'Support hours',enabled:true,projectIds:[10],startDate:start,endDate:null,minutes:600,openingMinutes:0,topUps:[],cycle:0,customer:{id:900,name:'Acme'},...a}))})),
    // An internal ticket and its business fields (billing null: inherit the project).
    ticket:async(key,meta={})=>{
      await env.STORE.set('it:'+key,JSON.stringify({summary:'Ticket '+key,devs:['builder'],status:'Open'}));
      await env.STORE.set(metadataKey(env,key),JSON.stringify({revision:1,odooProjectId:10,billing:null,agreedHours:null,agreedDate:null,...meta}));
    },
    meta:async(key,patch)=>{const k=metadataKey(env,key),m=JSON.parse(await env.STORE.get(k));await env.STORE.set(k,JSON.stringify({...m,...patch,revision:m.revision+1}));},
    // A work entry as the work log keeps it (synced to Odoo unless said otherwise).
    entry:async(key,minutes,date=today,extra={})=>{
      const id=crypto.randomUUID(),e={id,ticket:key,source:key.startsWith('HD-')?'odoo':'internal',ticketTitle:'Ticket '+key,date,minutes,description:'Work on '+key,
        author:{email:user.email,name:user.name},createdAt:new Date().toISOString(),revision:1,syncedRevision:1,state:'synced',lineId:Math.floor(Math.random()*1e6),projectId:10,...extra};
      await env.STORE.set('tw:AION:e:'+id,JSON.stringify(e));await env.STORE.sadd('tw:AION:t:'+key,id);await env.STORE.sadd('tw:AION:m:'+date.slice(0,7),id);
      return e;
    },
    setMinutes:async(e,minutes)=>{const n={...e,minutes,revision:e.revision+1,syncedRevision:e.revision+1};await env.STORE.set('tw:AION:e:'+e.id,JSON.stringify(n));return n;},
    cron:(secret=env.TIME_SYNC_SECRET)=>worker.fetch(new Request('https://proxy.invalid/cron/billing-scan',{method:'POST',headers:{Authorization:'Bearer '+secret}}),env)
  };
  return s;
}
const live={BILLING_ALERT_MAIL:'on'};
const mailer=(fn=()=>Response.json({ok:true}))=>{const sent=[];const send=async(from,body)=>{sent.push({from,...body});return fn(sent.length);};send.sent=sent;return send;};

test('classification: an explicit ticket override wins over the project default, in all six cases',()=>{
  const cases=[['billable',null,'billable','project'],['billable','not_billable','not_billable','ticket'],['not_billable',null,'not_billable','project'],
    ['not_billable','billable','billable','ticket'],[null,null,'unclassified','none'],[null,'billable','billable','ticket'],[null,'not_billable','not_billable','ticket']];
  for(const [def,override,value,source] of cases)assert.deepEqual(effectiveBilling(def,override),{value,source},def+'/'+override);
});

test('consumption: agreed hours once, otherwise billable work; non-billable work consumes nothing',async()=>{
  const s=await setup();await s.config({});await s.projects({10:'billable'});await s.allowances([{}]);
  await s.ticket('INT-1',{agreedHours:5,agreedDate:daysAgo(3)});await s.entry('INT-1',240,daysAgo(3));await s.entry('INT-1',180,daysAgo(2));
  let snap=await billingSnapshot(s.env);
  assert.equal(snap.usage.a1,300,'5 h agreed with 7 h worked consumes 5 h');
  assert.equal(snap.rows.filter(r=>r.ticket==='INT-1').reduce((n,r)=>n+r.actualMinutes,0),420,'the 7 h of work are kept');
  await s.ticket('INT-2');await s.entry('INT-2',120,daysAgo(1));
  snap=await billingSnapshot(s.env);assert.equal(snap.usage.a1,420,'plus 2 h billable work without agreed hours: 7 h');
  await s.ticket('INT-3',{billing:'not_billable'});await s.entry('INT-3',600,daysAgo(1));
  snap=await billingSnapshot(s.env);assert.equal(snap.usage.a1,420,'non-billable work consumes nothing');
  const st=snap.statuses.a1;assert.equal(st.consumedMinutes,420);assert.equal(st.remainingMinutes,180);assert.equal(st.status,'available');
  // A project with no default: its work is unclassified, never billable and never in an allowance.
  await s.ticket('INT-4',{odooProjectId:12});await s.entry('INT-4',60,today,{projectId:12});
  snap=await billingSnapshot(s.env);const r=snap.rows.find(x=>x.ticket==='INT-4');
  assert.equal(r.billing.value,'unclassified');assert.equal(r.chargeableMinutes,0);assert.equal(r.coverage,null);
});

test('a billable ticket in a non-billable project uses an allowance only when assigned to it',async()=>{
  const s=await setup();await s.config({});await s.projects({10:'not_billable'});await s.allowances([{}]);
  await s.ticket('INT-1',{billing:'billable'});await s.entry('INT-1',90);
  let snap=await billingSnapshot(s.env);const r=snap.rows[0];
  assert.equal(r.billing.value,'billable');assert.equal(r.chargeableMinutes,90);assert.equal(r.coverage,'no_allowance');assert.equal(snap.usage.a1,undefined);
  await s.env.STORE.set('business:AION:billing:ticket:INT-1',JSON.stringify({revision:1,billing:null,allowanceId:'a1',history:[]}));
  snap=await billingSnapshot(s.env);assert.equal(snap.usage.a1,90);assert.equal(snap.rows[0].coverage,'covered');
});

test('ledger: agreed hours set later, changed and cleared reconcile without duplicates',async()=>{
  const s=await setup();await s.config({});await s.projects({10:'billable'});
  await s.ticket('INT-7');const e=await s.entry('INT-7',120,daysAgo(2));
  const sum=l=>l.events.reduce((n,x)=>n+x.delta,0);
  let l=await reconcileTicket(s.env,'INT-7');assert.equal(l.consumedMinutes,120);assert.deepEqual(l.events.map(x=>x.type),['add']);
  assert.equal((await reconcileTicket(s.env,'INT-7')).events.length,1,'reconciling again changes nothing');
  await s.meta('INT-7',{agreedHours:3,agreedDate:daysAgo(1)});
  l=await reconcileTicket(s.env,'INT-7');assert.equal(l.consumedMinutes,180);assert.equal(sum(l),180);
  assert.deepEqual(l.events.slice(1).map(x=>[x.type,x.delta]).sort(),[['add',180],['remove',-120]]);
  await s.meta('INT-7',{agreedHours:4});
  l=await reconcileTicket(s.env,'INT-7');assert.deepEqual(l.events.at(-1),{...l.events.at(-1),type:'change',delta:60});assert.equal(sum(l),240);
  await s.meta('INT-7',{agreedHours:null,agreedDate:null});
  l=await reconcileTicket(s.env,'INT-7');assert.equal(l.consumedMinutes,120);assert.equal(sum(l),120);
  assert.deepEqual(Object.keys(l.charges),[e.id],'back to the work entry, once');
});

test('allowance status: zero vs none, overage, and overage carried into a top-up',()=>{
  const a={id:'a',kind:'package',enabled:true,minutes:600,openingMinutes:0,topUps:[]};
  assert.equal(allowanceStatus({...a,minutes:0},0).exhausted,false,'zero hours and nothing used is not exhausted');
  assert.equal(allowanceStatus({...a,minutes:0},30).status,'overage');
  assert.equal(allowanceStatus(a,480).status,'near');assert.equal(allowanceStatus(a,600).status,'exhausted');
  const over=allowanceStatus(a,720);assert.equal(over.overageMinutes,120);assert.equal(over.status,'overage');
  const topped=allowanceStatus({...a,topUps:[{minutes:600}]},720);assert.equal(topped.remainingMinutes,480,'2 h over plus a 10 h top-up leaves 8 h');assert.equal(topped.exhausted,false);
  assert.equal(allowanceStatus({...a,kind:'none'},999).status,'no_allocation');assert.equal(allowanceStatus({...a,kind:'t_and_m'},999).status,'unlimited');
  assert.equal(allowanceStatus({...a,openingMinutes:600},0).exhausted,true,'the opening balance counts');
});

test('email mode: dry unless the setting and the server switch are both on, with valid recipients',async()=>{
  const cfg={classification:true,emails:'on'};
  assert.equal(mailMode({},{...cfg,classification:false}).mode,'off');
  assert.equal(mailMode({},{...cfg,emails:'dry'}).mode,'dry');
  assert.equal(mailMode({MAIL_DOMAIN:'example.invalid',NO_DEVELOPER_NOTIFY_TO:'a@example.invalid'},cfg).mode,'dry','no server switch');
  assert.equal(mailMode({BILLING_ALERT_MAIL:'on',MAIL_DOMAIN:'example.invalid',NO_DEVELOPER_NOTIFY_TO:'a@elsewhere.invalid'},cfg).mode,'dry','recipient outside the domain');
  assert.deepEqual(mailMode({BILLING_ALERT_MAIL:'on',MAIL_DOMAIN:'example.invalid',NO_DEVELOPER_NOTIFY_TO:'A@example.invalid, a@example.invalid'},cfg),{mode:'live',to:['a@example.invalid']});
  assert.equal(recipients({MAIL_DOMAIN:'example.invalid'}).ok,false);
});

test('alert email: subject, wording, figures, escaping and a quotation link that creates nothing',()=>{
  const env={ODOO_URL:'https://odoo.invalid/'},a={kind:'package',label:'<Support>',projectIds:[10],startDate:'2026-10-01',openingMinutes:0,customer:{id:900,name:'Beta & Co'}};
  const m=alertMail(env,{quotationUrl:''},a,{capacityMinutes:600,consumedMinutes:720,remainingMinutes:0,overageMinutes:120},{calculatedAt:'2026-11-09T10:00:00Z',projectNames:['Website']});
  assert.equal(m.subject,'[AION] Allocated hours exhausted — Beta & Co / <Support>');
  assert.match(m.html,/All allocated hours have been consumed\. Please prepare a new sales quotation for this customer\./);
  assert.match(m.html,/Allocated: 10 h/);assert.match(m.html,/Consumed: 12 h/);assert.match(m.html,/Overage: 2 h/);
  assert.match(m.html,/Beta &amp; Co \/ &lt;Support&gt;/);assert.doesNotMatch(m.html,/<Support>/);
  assert.match(m.html,/href="https:\/\/odoo\.invalid\/odoo\/action-sale\.action_quotations_with_onboarding">Prepare quotation/);
  assert.match(m.html,/id=10&amp;model=project\.project/);
  assert.equal(quotationLink(env,{quotationUrl:'https://odoo.invalid/odoo/sales/new?partner={partner_id}'},900),'https://odoo.invalid/odoo/sales/new?partner=900');
});

test('alerts: backlog on first sight, one queued email on a real change, never repeated, re-armed by a confirmed top-up',async()=>{
  const s=await setup(live);await s.config({emails:'on'});await s.projects({10:'billable'});await s.allowances([{minutes:120}]);
  await s.ticket('INT-1');await s.entry('INT-1',150,daysAgo(5));
  const cfg=await readBillingConfig(s.env),send=mailer();
  // Already exhausted the first time it is seen: backlog, never emailed by itself.
  let out=await evaluateAlerts(s.env,cfg,await billingSnapshot(s.env));assert.deepEqual([out.created,out.backlog,out.queued],[1,1,0]);
  let r=await runScan(s.env,{sendMail:send});assert.equal(r.alerts.created,0);assert.equal(send.sent.length,0);
  // The administrator can send the backlog alert on purpose (through the mail service the server has: none here).
  let a=await s.call('/billing/alerts');assert.equal(a.data.items[0].status,'backlog');assert.equal(a.data.items.length,1);
  const viaServer=await s.call('/billing/alerts/send','POST',{id:'a1:0'});assert.equal(viaServer.status,200,JSON.stringify(viaServer.data));
  assert.equal(viaServer.data.alert.status,'failed','mail is not configured in this test, a definite failure');
  assert.equal((await deliverAlert(s.env,'a1:0',send,{explicit:true,me:admin})).status,'sent');assert.equal(send.sent.length,1);
  assert.equal((await s.call('/billing/alerts/send','POST',{id:'a1:0'})).status,409,'a sent alert is not sent again');
  // A confirmed top-up of 2 h restores capacity (150 of 240): the next cycle starts.
  const allow=await s.call('/billing/allowances');
  assert.equal((await s.call('/billing/allowances/top-up','POST',{revision:allow.data.revision,id:'a1',minutes:120})).status,400,'a top-up without confirmation adds nothing');
  const top=await s.call('/billing/allowances/top-up','POST',{revision:allow.data.revision,id:'a1',minutes:120,confirmed:true,reference:'S00042'});
  assert.equal(top.status,200,JSON.stringify(top.data));assert.equal(top.data.rearmed,true);assert.equal(top.data.items[0].remainingMinutes,90,'the 30 min over carry into the top-up');
  r=await runScan(s.env,{sendMail:mailer()});assert.equal(r.alerts.created,0);
  // More work exhausts it again: one email for cycle 1, sent by the scan, and only once.
  await s.entry('INT-1',100,daysAgo(1));
  const send2=mailer();r=await runScan(s.env,{sendMail:send2});
  assert.equal(r.alerts.queued,1);assert.equal(r.sent,1);assert.equal(send2.sent.length,1);
  assert.deepEqual(send2.sent[0].to,['sales@example.invalid','ops@example.invalid']);assert.equal(send2.sent[0].from,'sales@example.invalid');
  assert.match(send2.sent[0].subject,/^\[AION\] Allocated hours exhausted — Acme \/ Support hours$/);
  r=await runScan(s.env,{sendMail:send2});assert.equal(r.alerts.created,0);assert.equal(send2.sent.length,1,'no repeat within the cycle');
});

test('alerts in dry run are recorded, never sent; turning emails off evaluates nothing',async()=>{
  const s=await setup(live);await s.config({emails:'dry'});await s.projects({10:'billable'});await s.allowances([{minutes:120}]);
  await s.ticket('INT-1');await s.entry('INT-1',60,daysAgo(5));
  const send=mailer();await runScan(s.env,{sendMail:send});
  await s.entry('INT-1',60,daysAgo(4));let r=await runScan(s.env,{sendMail:send});
  assert.equal(r.mail,'dry');assert.equal(r.alerts.dryRun,1);assert.equal(send.sent.length,0);
  assert.equal((await s.call('/billing/alerts/send','POST',{id:'a1:0'})).data.code,'mail_not_live');
  await s.config({emails:'off'});r=await runScan(s.env,{sendMail:send});assert.equal(r.alerts.mode,'off');
});

test('delivery: no answer or an ambiguous mailer failure is uncertain and never retried automatically',async()=>{
  for(const [fn,expect] of [[()=>{throw new TypeError('fetch failed');},'uncertain'],[()=>Response.json({error:'Email could not be sent.'},{status:502}),'uncertain'],
    [()=>Response.json({error:'Mail is not configured.'},{status:501}),'failed'],[()=>Response.json({error:'Graph refused: 401'},{status:502}),'queued']]){
    const s=await setup(live);await s.config({emails:'on'});await s.projects({10:'billable'});await s.allowances([{minutes:60}]);
    await s.ticket('INT-1');await runScan(s.env,{sendMail:mailer()});
    await s.entry('INT-1',90,daysAgo(1));
    const send=mailer(fn);await runScan(s.env,{sendMail:send});
    const ev=(await s.call('/billing/alerts')).data.items[0];assert.equal(ev.status,expect,String(fn));assert.equal(ev.attempts,1);assert.equal(ev.errors.length,1);
    await runScan(s.env,{sendMail:send});assert.equal(send.sent.length,1,'not sent again by the next scan');
    if(expect==='uncertain'){
      assert.equal((await s.call('/billing/alerts/resolve','POST',{id:ev.id,outcome:'sent'})).data.alert.status,'sent');
    }
  }
});

test('a send that stopped midway becomes uncertain',async()=>{
  const s=await setup(live);await s.config({emails:'on'});
  const ev={id:'a1:0',allowanceId:'a1',cycle:0,status:'sending',sendingAt:Date.now()-20*60000,createdAt:new Date().toISOString(),attempts:1,errors:[],to:[],snapshot:{},mail:{subject:'x',html:'x'}};
  await s.env.STORE.set('business:AION:billing:alert:a1:0',JSON.stringify(ev));await s.env.STORE.sadd('business:AION:billing:alerts','a1:0');
  const r=await runScan(s.env,{sendMail:mailer()});assert.equal(r.uncertain,1);
  assert.equal((await s.call('/billing/alerts')).data.items[0].status,'uncertain');
});

test('the Odoo check pages through all lines, and says when it could not read them all',async()=>{
  const lines=Array.from({length:25},(_,i)=>({id:i+1,date:daysAgo(1),unit_amount:1,project_id:[10,'Branch A'],task_id:false,x_uuid:false}));
  globalThis.fetch=async(url,init)=>{const b=JSON.parse(init.body),{service,args}=b.params,reply=result=>Response.json({jsonrpc:'2.0',id:b.id,result});
    if(service==='common')return reply(7);const [, , , model,m,,kw={}]=args;
    if(model==='account.analytic.line'&&m==='search_count')return reply(lines.length);
    if(model==='account.analytic.line'&&m==='search_read')return reply(lines.slice(kw.offset,kw.offset+kw.limit));
    return reply([]);};
  const s=await setup({ODOO_URL:'https://odoo.invalid',ODOO_DB:'db',ODOO_LOGIN:'bot@x',ODOO_API_KEY:'k'});
  await s.config({});await s.projects({10:'billable'});
  await s.env.STORE.set('tw:AION:config',JSON.stringify({fields:{entryUuid:'x_uuid'}}));
  let r=await scanOdoo(s.env,{pageSize:10,maxPages:5});assert.equal(r.complete,true);assert.equal(r.read,25);assert.equal(r.projects[10].direct.length,25,'lines entered in Odoo directly');
  r=await scanOdoo(s.env,{pageSize:10,maxPages:2});assert.equal(r.complete,false);assert.equal(r.read,20);assert.equal(r.total,25);
});

test('export: finalized work is never charged again; later corrections are adjustments',async()=>{
  const s=await setup();await s.config({});await s.projects({10:'billable'});await s.allowances([{}]);
  await s.ticket('INT-1');const e=await s.entry('INT-1',90,daysAgo(2));
  await s.ticket('INT-2',{billing:'not_billable'});await s.entry('INT-2',60,daysAgo(2));
  const range='from='+daysAgo(10)+'&to='+today;
  let p=await s.call('/billing/export/preview?'+range);assert.equal(p.status,200,JSON.stringify(p.data));
  assert.equal(p.data.rows.length,1,'billable only by default');assert.equal(p.data.rows[0].exportState,'new');assert.equal(p.data.exceptions.length,0);
  assert.equal(p.data.rows[0].coverage,'covered');assert.equal(p.data.rows[0].customer,'Acme');
  const all=await s.call('/billing/export/preview?billing=all&exportState=all&'+range);assert.equal(all.data.rows.length,2);
  // A preview finalizes nothing.
  assert.equal((await s.call('/billing/export/preview?'+range)).data.rows[0].exportState,'new');
  assert.equal((await s.call('/billing/export/finalize','POST',{from:daysAgo(10),to:today,fingerprint:'stale'})).status,409);
  const f=await s.call('/billing/export/finalize','POST',{from:daysAgo(10),to:today,fingerprint:p.data.fingerprint});assert.equal(f.status,200,JSON.stringify(f.data));
  assert.match(f.data.batch.id,/^B\d{8}-[0-9a-f]{8}$/);assert.equal(f.data.batch.totals.chargeableMinutes,90);
  p=await s.call('/billing/export/preview?'+range);assert.equal(p.data.rows.length,0,'nothing pending after finalizing');
  // A correction after the export comes out as the difference.
  await s.setMinutes(e,120);p=await s.call('/billing/export/preview?'+range);
  assert.equal(p.data.rows.length,1);assert.equal(p.data.rows[0].exportState,'adjustment');assert.equal(p.data.rows[0].deltaMinutes,30);
  await s.call('/billing/export/finalize','POST',{from:daysAgo(10),to:today,fingerprint:p.data.fingerprint});
  // Agreed hours added later take back the exported work and charge the agreed hours.
  await s.meta('INT-1',{agreedHours:1,agreedDate:daysAgo(1)});p=await s.call('/billing/export/preview?'+range);
  const byOrigin=Object.fromEntries(p.data.rows.map(r=>[r.origin,r]));
  assert.equal(byOrigin.agreed_ticket.deltaMinutes,-120);assert.equal(byOrigin.agreed.deltaMinutes,60);assert.equal(byOrigin.agreed.exportState,'new');
  assert.equal(p.data.totals.deltaMinutes,-60);
  assert.equal((await s.call('/billing/export/batches')).data.items.length,2);
});

test('export: unclassified or unreviewed work blocks finalizing, and the exceptions are listed',async()=>{
  const s=await setup();await s.config({});await s.projects({10:'billable'});
  await s.ticket('INT-1',{odooProjectId:12});await s.entry('INT-1',60,daysAgo(1),{projectId:12});
  await s.ticket('INT-2');await s.entry('INT-2',60,daysAgo(1),{state:'review'});
  const p=await s.call('/billing/export/preview?from='+daysAgo(10)+'&to='+today);
  assert.deepEqual(p.data.exceptions.map(x=>x.kind).sort(),['unclassified','unreconciled']);
  const f=await s.call('/billing/export/finalize','POST',{from:daysAgo(10),to:today,fingerprint:p.data.fingerprint});
  assert.equal(f.status,409);assert.equal(f.data.code,'exceptions');
});

test('ticket override through the API: Inherit, Billable, Not billable, with the ledger updated',async()=>{
  const s=await setup();await s.config({});await s.projects({10:'not_billable'});
  await s.ticket('INT-1',{billing:'billable'});await s.entry('INT-1',90);
  let v=await s.call('/billing/ticket?key=INT-1');assert.equal(v.status,200,JSON.stringify(v.data));
  assert.equal(v.data.override,'billable');assert.deepEqual(v.data.effective,{value:'billable',source:'ticket'});
  const r=await s.call('/billing/ticket','PUT',{key:'INT-1',revision:v.data.revision,billing:'inherit'});assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal(r.data.override,null);assert.deepEqual(r.data.effective,{value:'not_billable',source:'project'});
  assert.equal((await readLedger(s.env,'INT-1')).consumedMinutes,0);
  assert.equal(JSON.parse(await s.env.STORE.get(metadataKey(s.env,'INT-1'))).billing,null,'stored as the ticket\'s billing field');
});

test('billing is for administrators only, and the background check needs the secret',async()=>{
  const s=await setup();
  for(const p of ['/billing/setup','/billing/allowances','/billing/export/preview','/billing/alerts','/billing/ticket?key=INT-1'])assert.equal((await s.call(p,'GET',undefined,user)).status,403,p);
  assert.equal((await s.cron('x'.repeat(32))).status,403);
  const ok=await s.cron();assert.equal(ok.status,200);assert.match((await ok.json()).skipped,/classification is off/);
  // Emails can't be switched on before classification, nor with invalid recipients.
  const st=await s.call('/billing/setup');assert.equal(st.data.mail.mode,'off');
  assert.equal((await s.call('/billing/setup','PUT',{revision:st.data.config.revision,emails:'dry'})).data.code,'classification_off');
  const on=await s.call('/billing/setup','PUT',{revision:st.data.config.revision,classification:true,emails:'on'});assert.equal(on.status,200,JSON.stringify(on.data));
  assert.equal(on.data.mail.mode,'dry','the server switch is off, so still a dry run');
});

test('allowances: one customer per pool, no overlapping allowances on a project, and edits are kept',async()=>{
  const s=await setup();await s.config({});
  const base={kind:'package',label:'Pool',enabled:true,startDate:start,minutes:600};
  assert.equal((await s.call('/billing/allowances','POST',{...base,revision:0,projectIds:[10,20]})).status,400,'two customers');
  const c=await s.call('/billing/allowances','POST',{...base,revision:0,projectIds:[10,12]});assert.equal(c.status,200,JSON.stringify(c.data));
  assert.deepEqual(c.data.items[0].customer,{id:900,name:'Acme'});
  assert.equal((await s.call('/billing/allowances','POST',{...base,revision:c.data.revision,projectIds:[12]})).data.code,'overlap');
  const e=await s.call('/billing/allowances','PUT',{revision:c.data.revision,id:c.data.items[0].id,minutes:900});assert.equal(e.status,200,JSON.stringify(e.data));
  assert.deepEqual(e.data.items[0].history.at(-1).changes,{minutes:{from:600,to:900}});
  assert.equal((await s.call('/billing/allowances','POST',{...base,kind:'none',revision:e.data.revision,projectIds:[20]})).data.items.find(a=>a.kind==='none').status,'no_allocation');
});

test('Clients rows: needs setup, no allocation and allowance status per project',async()=>{
  const s=await setup();await s.config({});await s.projects({10:'billable',20:'billable'});await s.allowances([{minutes:60}]);
  await s.ticket('INT-1');await s.entry('INT-1',90,daysAgo(1));
  await s.ticket('INT-2',{odooProjectId:12});await s.entry('INT-2',30,daysAgo(1),{projectId:12});
  const r=(await s.call('/billing/projects')).data.rows;
  assert.equal(r[10].status,'overage');assert.equal(r[10].allowance.overageMinutes,30);assert.equal(r[10].chargeableMinutes,90);
  assert.equal(r[12].status,'needs_setup');assert.equal(r[12].unclassifiedMinutes,30);
  assert.equal(r[20].status,'no_allocation');
});

test('preview of the rollout counts existing ticket billing as overrides',async()=>{
  const s=await setup();await s.ticket('INT-1',{billing:'billable'});await s.ticket('INT-2');
  const m=await s.call('/billing/migration');assert.equal(m.status,200,JSON.stringify(m.data));
  assert.deepEqual(m.data.ticketOverrides,{billable:1,not_billable:0,inherit:1});assert.equal(m.data.projects.unclassified.length,3);
});



test('mapped Odoo billing imports all projects, updates changed values and ticket inheritance without writing back',async()=>{
 const s=await setup({ODOO_URL:'https://odoo.invalid',ODOO_DB:'db',ODOO_LOGIN:'billing-import',ODOO_API_KEY:'key'});
 await s.config({fields:{project:'x_billing',task:'x_billing_mode'},fieldTypes:{project:'boolean',task:'selection'},values:{project:{},task:{yes:'billable',no:'not_billable',project:'inherit'}}});
 await s.ticket('INT-501');await s.ticket('INT-502',{billing:'billable'});
 let checked=true,mode='project',writes=0;const original=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{const rpc=JSON.parse(init.body).params;if(rpc.service==='common')return Response.json({result:7});
  const [model,method,args,kw]=rpc.args.slice(3);
  if(method==='write'){writes++;throw Error('Pull must not write to Odoo');}
  if(model==='res.users')return Response.json({result:[{company_ids:[1,2]}]});
  assert.deepEqual(kw.context.allowed_company_ids,[1,2]);
  if(model==='project.project'){assert.deepEqual(args[0],[10,12,20]);return Response.json({result:[{id:10,x_billing:checked},{id:12,x_billing:false},{id:20,x_billing:true}]});}
  if(model==='project.task')return Response.json({result:[{id:501,name:'[INT-501] Test',project_id:[10,'Branch A'],x_billing_mode:mode},{id:502,name:'[INT-502] Test',project_id:[10,'Branch A'],x_billing_mode:'project'}]});
  throw Error(model+'/'+method);
 };
 try{
  const first=await syncBillingFromOdoo(s.env);assert.ok(first.changed>0);
  // INT-502 already has a dashboard override that Odoo's task does not share, and there is no baseline yet: kept and reported.
  assert.deepEqual(first.conflicts.map(c=>c.id),['INT-502']);
  let doc=await readProjectDefaults(s.env);assert.equal(doc.items[10].billing,'billable');assert.equal(doc.items[12].billing,'not_billable');assert.equal(doc.items[20].billing,'billable');
  let view=(await s.call('/billing/ticket?key=INT-502')).data;assert.equal(view.override,'billable');assert.equal(view.effective.source,'ticket');
  const revision=doc.revision;assert.equal((await syncBillingFromOdoo(s.env)).changed,0);assert.equal((await readProjectDefaults(s.env)).revision,revision);
  checked=false;mode='yes';await syncBillingFromOdoo(s.env);
  assert.equal((await readProjectDefaults(s.env)).items[10].billing,'not_billable');
  view=(await s.call('/billing/ticket?key=INT-502')).data;assert.equal(view.override,'billable');assert.equal(view.effective.value,'billable');
  view=(await s.call('/billing/ticket?key=INT-501')).data;assert.equal(view.override,'billable');assert.equal(view.effective.source,'ticket');
  assert.equal(writes,0);
 }finally{globalThis.fetch=original;}
});


test('billing import preserves a concurrent dashboard edit and a failed outgoing change',async()=>{
 const s=await setup({ODOO_URL:'https://odoo.invalid',ODOO_DB:'db',ODOO_LOGIN:'billing-race',ODOO_API_KEY:'key'});
 await s.config({fields:{project:'x_billing',task:''},fieldTypes:{project:'boolean'},values:{project:{},task:{}}});
 await s.projects({10:'billable'});const original=globalThis.fetch;let race=true;
 globalThis.fetch=async(url,init)=>{const rpc=JSON.parse(init.body).params;if(rpc.service==='common')return Response.json({result:7});
  const [model]=rpc.args.slice(3);if(model==='res.users')return Response.json({result:[{company_ids:[1]}]});
  if(race){race=false;await s.env.STORE.set('business:AION:billing:projects',JSON.stringify({revision:2,items:{10:{billing:'billable',odoo:{state:'failed',error:'Odoo unavailable'}}}}));}
  return Response.json({result:[{id:10,x_billing:false}]});
 };
 try{
  assert.equal((await syncBillingFromOdoo(s.env)).changed,0);
  assert.equal((await readProjectDefaults(s.env)).items[10].billing,'billable');
  await syncBillingFromOdoo(s.env);
  assert.equal((await readProjectDefaults(s.env)).items[10].odoo.state,'failed');
  assert.equal((await readProjectDefaults(s.env)).items[10].billing,'billable');
 }finally{globalThis.fetch=original;}
});

test('a cleared project default stays cleared while Odoo is unchanged; an Odoo change against it is kept for review',async()=>{
  const s=await setup({ODOO_URL:'https://odoo.invalid',ODOO_DB:'db',ODOO_LOGIN:'billing-clear',ODOO_API_KEY:'key'});
  await s.config({fields:{project:'x_billing',task:''},fieldTypes:{project:'boolean'},values:{project:{},task:{}}});
  // Odoo last confirmed billable (the baseline); the dashboard was then cleared to Not classified and never pushed.
  await s.env.STORE.set('business:AION:billing:projects',JSON.stringify({revision:3,items:{10:{billing:null,odoo:{state:'synced',at:'2026-11-01T00:00:00.000Z',id:10,value:'billable'}}}}));
  let odooValue=true;const original=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{const rpc=JSON.parse(init.body).params;if(rpc.service==='common')return Response.json({result:7});
    const [model,method]=rpc.args.slice(3);if(method==='write')throw Error('Pull must not write to Odoo');
    if(model==='res.users')return Response.json({result:[{company_ids:[1]}]});
    return Response.json({result:[{id:10,name:'Alpha',x_billing:odooValue}]});
  };
  try{
    assert.equal((await syncBillingFromOdoo(s.env)).changed,0);
    assert.equal((await readProjectDefaults(s.env)).items[10].billing,null);
    odooValue=false;
    const r=await syncBillingFromOdoo(s.env);
    assert.equal(r.changed,0);assert.equal(r.conflicts.length,1);assert.equal(r.conflicts[0].local,null);assert.equal(r.conflicts[0].odoo,'not_billable');
    assert.equal((await readProjectDefaults(s.env)).items[10].billing,null);
  }finally{globalThis.fetch=original;}
});
