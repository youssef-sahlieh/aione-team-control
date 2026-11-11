// The work logged in Odoo on a project, and the work period the Clients & projects workspace filters by, on synthetic data:
// the in-memory database and a fake Odoo. Nothing here reaches a real service, and no email is sent.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{makeToken} from '../proxy/src/handler.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';
import {metadataKey,odooProjectsKey} from '../proxy/src/ticket-metadata.js';
import {todayIn} from '../proxy/src/time-entries.js';
import {workPeriod,addDays} from '../proxy/src/project-work.js';

const admin={email:'admin@example.invalid',name:'Manager',role:'admin',dev:'builder',v:1};
const user={email:'user@example.invalid',name:'Dana Developer',role:'user',dev:'builder',v:1};
const today=todayIn(),thisMonth=today.slice(0,8)+'01',lastMonthDay=addDays(thisMonth,-1);
const realFetch=globalThis.fetch;

// The domain operators the work reads use: =, in, >=, <= (a many2one compares its id; false matches an empty field).
function matches(rec,[field,op,v]){
  const x=rec[field],id=Array.isArray(x)?x[0]:x;
  if(op==='=')return v===false?(x===false||x==null):id===v;
  if(op==='in')return v.includes(id);
  if(op==='>=')return x>=v;
  if(op==='<=')return x<=v;
  throw new Error('operator '+op);
}
const project=(rec,fields)=>Object.fromEntries((fields?.length?fields:Object.keys(rec)).filter(f=>f in rec).map(f=>[f,rec[f]]).concat(['id'].map(f=>[f,rec.id])));

// Fake Odoo: project 10 (Branch A, billable by default) and 20 (Website, another project); tasks of project 10: the ticket
// task "[AION-7] …", two Odoo tasks with a billing field (billable, not billable), one with "inherit", and project 20's task.
// Timesheet lines are kept in `lines`; the test sets the dashboard's entry field on the ones the dashboard sent.
function fakeOdoo(lines,tasks){
  const projects={10:{id:10,name:'Branch A',partner_id:[900,'Acme'],active:true,allocated_hours:40,description:false},
    20:{id:20,name:'Website',partner_id:[901,'Beta'],active:true,allocated_hours:false,description:false}};
  return async(url,init)=>{
    if(String(url).startsWith('https://jira.invalid'))return Response.json({issues:[]});
    const b=JSON.parse(init.body),{service,args}=b.params,reply=result=>Response.json({jsonrpc:'2.0',id:b.id,result});
    if(service==='common')return reply(7);
    const [, , , model,method,a=[],kw={}]=args;
    if(model==='res.users'&&method==='search_read')return reply([{id:7,company_ids:[1]}]);
    if(model==='project.project'&&method==='search_read'){const ids=a[0][0][2];return reply([].concat(ids).map(id=>projects[id]).filter(Boolean).map(p=>project(p,kw.fields)));}
    if(model==='project.task'&&method==='search_read'){
      const cond=a[0].find(c=>c[0]==='project_id'),ids=cond[1]==='='?[cond[2]]:cond[2];
      let rows=tasks.filter(t=>ids.includes(t.project_id[0]));
      if(a[0].some(c=>c[0]==='name'))rows=rows.filter(t=>t.name.startsWith('['));
      return reply(rows.map(t=>project(t,kw.fields)));
    }
    if(model==='account.analytic.line'&&method==='search_read'){
      let rows=lines.filter(l=>a[0].every(c=>matches(l,c)));
      if(kw.order)rows=[...rows].sort((x,y)=>(y.date.localeCompare(x.date))||(y.id-x.id));
      const off=kw.offset||0;rows=rows.slice(off,kw.limit?off+kw.limit:undefined);
      return reply(rows.map(l=>project(l,kw.fields)));
    }
    return reply([]);
  };
}

async function setup({time=true}={}){
  const lines=[],tasks=[
    {id:1,name:'[AION-7] Checkout fails',project_id:[10,'Branch A'],x_billing:'n'},
    {id:2,name:'Fix login page',project_id:[10,'Branch A'],x_billing:'b'},
    {id:3,name:'Docs',project_id:[10,'Branch A'],x_billing:'i'},
    {id:4,name:'Support call',project_id:[10,'Branch A'],x_billing:'n'},
    {id:5,name:'Website copy',project_id:[20,'Website'],x_billing:false}];
  globalThis.fetch=fakeOdoo(lines,tasks);
  const env={SESSION_SECRET:'synthetic-secret',JIRA_PROJECT:'AION',JIRA_SITE:'https://jira.invalid',JIRA_EMAIL:'bot@example.invalid',JIRA_API_TOKEN:'t',STORE:memoryStore(),TIME_SYNC_SECRET:'s'.repeat(32),
    MAIL_DOMAIN:'example.invalid',NO_DEVELOPER_NOTIFY_TO:'sales@example.invalid',ODOO_URL:'https://odoo.invalid',ODOO_DB:'db',ODOO_LOGIN:'bot@example.invalid',ODOO_API_KEY:'k'};
  for(const me of [admin,user])await saveUser(env.STORE,me);
  const tokens={};for(const me of [admin,user])tokens[me.email]=(await makeToken(env,me.email,Date.now(),1)).token;
  await env.STORE.set(odooProjectsKey(env),JSON.stringify({syncedAt:Date.now(),projects:[
    {id:10,name:'Branch A',active:true,clientId:900,clientName:'Acme',label:'Acme → Branch A'},
    {id:20,name:'Website',active:true,clientId:901,clientName:'Beta & Co',label:'Beta & Co → Website'}]}));
  // The billing settings: the task billing field maps b, n and i; projects default to billable.
  await env.STORE.set('business:AION:billing:config',JSON.stringify({revision:1,classification:true,emails:'dry',fields:{project:'',task:'x_billing'},values:{project:{},task:{b:'billable',n:'not_billable',i:'inherit'}},quotationUrl:''}));
  await env.STORE.set('business:AION:billing:projects',JSON.stringify({revision:1,items:{10:{billing:'billable'}}}));
  if(time)await env.STORE.set('tw:AION:config',JSON.stringify({fields:{users:'',entryUuid:'x_entry_uuid',userUuid:'',lineRef:''},mapping:{}}));
  const call=async(path,method='GET',body,me=admin)=>{const r=await worker.fetch(new Request('https://proxy.invalid'+path,{method,headers:{Authorization:'Bearer '+tokens[me.email],'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()};};
  // A line in Odoo; the dashboard's lines carry its entry id (x_entry_uuid).
  const line=(date,hours,task,extra={})=>{const l={id:lines.length+1,date,unit_amount:hours,name:'Work '+(lines.length+1),project_id:[10,'Branch A'],task_id:task?[task,''].slice(0,2):false,user_id:[7,'Builder'],x_entry_uuid:false,...extra};lines.push(l);return l;};
  const entry=async(key,minutes,date,meta={})=>{
    const id=crypto.randomUUID(),e={id,ticket:key,source:key.startsWith('HD-')?'odoo':key.startsWith('INT-')?'internal':'jira',ticketTitle:'Ticket '+key,date,minutes,description:'Work on '+key,
      author:{email:user.email,name:user.name},createdAt:new Date().toISOString(),revision:1,syncedRevision:1,state:'synced',lineId:Math.floor(Math.random()*1e6),projectId:10,...meta};
    await env.STORE.set('tw:AION:e:'+id,JSON.stringify(e));await env.STORE.sadd('tw:AION:t:'+key,id);await env.STORE.sadd('tw:AION:m:'+date.slice(0,7),id);return e;
  };
  const ticket=(key,meta={})=>env.STORE.set(metadataKey(env,key),JSON.stringify({revision:1,odooProjectId:10,billing:null,agreedHours:null,agreedDate:null,history:[],...meta}));
  return {env,lines,line,call,entry,ticket};
}
test.afterEach(()=>{globalThis.fetch=realFetch;});

test('the work period: this month by default, both ends inclusive, and bad choices are refused',()=>{
  const d='2026-03-15';
  assert.deepEqual(workPeriod({},d),{key:'month',from:'2026-03-01',to:'2026-03-31',label:'This month (2026-03-01 to 2026-03-31)'});
  assert.deepEqual([workPeriod({period:'last_month'},d).from,workPeriod({period:'last_month'},d).to],['2026-02-01','2026-02-28']);
  assert.deepEqual([workPeriod({period:'last_month'},'2026-01-10').from,workPeriod({period:'last_month'},'2026-01-10').to],['2025-12-01','2025-12-31']);
  assert.deepEqual([workPeriod({period:'last_30'},d).from,workPeriod({period:'last_30'},d).to],['2026-02-14','2026-03-15'],'30 days, today included');
  assert.equal(workPeriod({period:'all'},d).from,'2020-01-01');
  assert.deepEqual([workPeriod({period:'custom',from:'2026-03-05',to:'2026-03-05'},d).from,workPeriod({period:'custom',from:'2026-03-05',to:'2026-03-05'},d).to],['2026-03-05','2026-03-05'],'one day is a period');
  assert.throws(()=>workPeriod({period:'custom',from:'2026-03-10',to:'2026-03-01'},d),/start date is after the end date/);
  assert.throws(()=>workPeriod({period:'custom',from:'2026-02-30',to:'2026-03-01'},d),/valid dates/);
  assert.throws(()=>workPeriod({period:'custom',from:'2026-03-01'},d),/valid dates/);
  assert.throws(()=>workPeriod({period:'year'},d),/Choose a work period/);
});

test('Odoo work in the period: Odoo-only lines count once, dashboard lines never; totals cover every match, not the page',async()=>{
  const s=await setup();
  s.line(today,1.5,2);                       // Odoo-only, on a billable task
  s.line(today,0.5,false);                   // Odoo-only, not on a task
  s.line(today,2,3,{x_entry_uuid:'dash-1'}); // sent by the dashboard: counted once there, not here
  s.line(today,1,1);                         // Odoo-only, on the ticket task [AION-7]
  s.line(today,3,4);                         // Odoo-only, not billable
  s.line(lastMonthDay,4,2);                  // last month: not in this month
  s.line(today,5,5,{project_id:[20,'Website']}); // Website: another project
  const r=await s.call('/clients/odoo-projects/work?id=10&limit=2');assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal(r.data.period.key,'month');
  assert.deepEqual(r.data.totals,{hours:6,count:4},'every matching line, not the page of 2');
  assert.deepEqual(r.data.unassigned,{hours:0.5,count:1});
  assert.equal(r.data.entries.length,2,'the page is limited');assert.equal(r.data.nextOffset,2);
  assert.ok(r.data.entries.every(e=>e.url.startsWith('https://odoo.invalid/web#id=')),'each entry links to Odoo');
  const by=Object.fromEntries(r.data.tasks.map(t=>[t.id,t]));
  assert.deepEqual([by[2].hours,by[2].billing],[1.5,{value:'billable',source:'ticket'}]);
  assert.equal(by[1].key,'AION-7','the ticket task keeps its key, its own row');
  assert.deepEqual(by[1].billing,{value:'billable',source:'project'},'a ticket\'s billing is the dashboard\'s: no override, so the project default');
  assert.deepEqual([by[4].hours,by[4].billing.value],[3,'not_billable']);
  assert.deepEqual(r.data.warnings,[]);
  // The next page: the rest, newest first, with no further page.
  const p2=await s.call('/clients/odoo-projects/work?id=10&limit=2&offset=2');assert.equal(p2.data.entries.length,2);assert.equal(p2.data.nextOffset,null);
  assert.deepEqual(p2.data.totals,{hours:6,count:4},'totals do not change with the page');
  assert.ok(!r.data.entries.some(e=>e.hours===2),'a dashboard line is not listed');
});

test('Odoo work: only billable tasks with the billable filter; unassigned work is not billable; the period is inclusive',async()=>{
  const s=await setup();
  s.line(today,1.5,2);s.line(today,0.5,false);s.line(today,3,4);s.line(lastMonthDay,4,2);
  const b=await s.call('/clients/odoo-projects/work?id=10&billable=1');
  assert.equal(b.status,200);assert.equal(b.data.billable,true);
  assert.deepEqual(b.data.totals,{hours:1.5,count:1},'the billable task only; unassigned and not billable left out');
  assert.equal(b.data.unassigned.count,0);
  const last=await s.call('/clients/odoo-projects/work?id=10&period=last_month');
  assert.deepEqual(last.data.totals,{hours:4,count:1});
  const day=await s.call(`/clients/odoo-projects/work?id=10&period=custom&from=${lastMonthDay}&to=${lastMonthDay}`);
  assert.deepEqual(day.data.totals,{hours:4,count:1},'a one-day custom period includes that day');
  const none=await s.call(`/clients/odoo-projects/work?id=10&period=custom&from=${addDays(lastMonthDay,-10)}&to=${addDays(lastMonthDay,-1)}`);
  assert.deepEqual(none.data.totals,{hours:0,count:0},'a period before the work has no entries, and says so');
  assert.deepEqual(none.data.entries,[]);
});

test('Odoo work warns when the dashboard entry field is not set, so its work could be counted twice',async()=>{
  const s=await setup({time:false});s.line(today,1,2,{x_entry_uuid:undefined});
  const r=await s.call('/clients/odoo-projects/work?id=10');assert.equal(r.status,200);
  assert.equal(r.data.warnings.length,1);assert.match(r.data.warnings[0],/entry field is not set/);
});

test('the tickets of a project follow the work period, keep only the work in it, and keep only billable ones on request',async()=>{
  const s=await setup();
  await s.ticket('INT-1');await s.entry('INT-1',240,today);
  await s.ticket('INT-2',{billing:'not_billable'});await s.entry('INT-2',60,lastMonthDay);
  await s.ticket('INT-3');
  // Default: this month, with work in the period (INT-2 has work only last month, INT-3 none).
  const def=await s.call('/clients/odoo-projects/tickets?id=10');assert.equal(def.status,200,JSON.stringify(def.data));
  assert.equal(def.data.scope.key,'month');assert.equal(def.data.mode,'work');
  assert.deepEqual(def.data.tickets.map(t=>t.key),['INT-1']);
  assert.equal(def.data.total,1);
  // All tickets of the project: INT-2 and INT-3 are on it too, and AION-7 is its "[AION-7]" Odoo task.
  const all=await s.call('/clients/odoo-projects/tickets?id=10&mode=all');
  assert.deepEqual(all.data.tickets.map(t=>t.key),['AION-7','INT-1','INT-2','INT-3']);
  // Last month: INT-2's work is in the period.
  const last=await s.call('/clients/odoo-projects/tickets?id=10&period=last_month');
  assert.deepEqual(last.data.tickets.map(t=>t.key),['INT-2']);
  // Billable only: INT-2 is not billable on its own ticket, so it is left out of a billable list; INT-1 inherits the project default.
  const billable=await s.call('/clients/odoo-projects/tickets?id=10&mode=all&billable=1');
  assert.deepEqual(billable.data.tickets.map(t=>t.key),['AION-7','INT-1','INT-3'],'the project default is billable, so the inheriting tickets are; INT-2 is not billable');
  assert.equal(billable.data.billable,true);
});

test('the work period and the work route are checked: a bad period is refused, only administrators see the work',async()=>{
  const s=await setup();
  assert.equal((await s.call('/clients/odoo-projects/work?id=10&period=nope')).status,400);
  const bad=await s.call('/clients/odoo-projects/work?id=10&period=custom&from=2026-05-10&to=2026-05-01');
  assert.equal(bad.status,400);assert.match(bad.data.message||bad.data.error||JSON.stringify(bad.data),/start date is after the end date/);
  assert.equal((await s.call('/clients/odoo-projects/tickets?id=10&period=custom&from=2026-05-01')).status,400);
  assert.equal((await s.call('/clients/odoo-projects/work?id=10',undefined,undefined,user)).status,403);
  assert.equal((await s.call('/clients/odoo-projects/work?id=abc')).status,400);
  assert.equal((await s.call('/clients/odoo-projects/work?id=99')).status,404);
});
