// The Work log overview: one row per work session across the dashboard and Odoo, against synthetic data and a mocked
// Odoo. Nothing here writes to a real Odoo or to production work entries.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{makeToken} from '../proxy/src/handler.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';
import {metadataKey,odooProjectsKey} from '../proxy/src/ticket-metadata.js';
import {todayIn} from '../proxy/src/time-entries.js';
import {resolvePeriod,applyFilters,totalsOf,groupsOf,sortRows,csvOf,formatHM,publicRow,buildRows} from '../proxy/src/work-overview.js';

const admin={email:'admin@example.invalid',name:'Manager',role:'admin',dev:'builder',v:1};
const user={email:'user@example.invalid',name:'Dana Developer',role:'user',dev:'builder',v:1};
const other={email:'other@example.invalid',name:'Other Dev',role:'user',dev:'someone',v:1};
const FIELDS={users:'x_studio_users',entryUuid:'x_aione_entry_uuid',userUuid:'x_aione_user_uuid',lineRef:'x_aione_ticket_ref'};
const daysAgo=n=>new Date(Date.parse(todayIn()+'T12:00:00Z')-n*86400000).toISOString().slice(0,10);
const P='tw:AION:';

// A mocked Odoo: timesheet lines with the domain operators the overview uses, and project tasks.
function fakeOdoo({lines=[],tasks=[],down=false,count=null}={}){
  const o={lines,tasks,calls:[],down,countOverride:count};
  const value=v=>Array.isArray(v)?v[0]:v;
  const ok=(row,domain)=>domain.every(([f,op,v])=>{
    const x=value(row[f]??false);
    if(op==='=')return x===v;if(op==='!=')return x!==v;if(op==='>=')return x>=v;if(op==='<=')return x<=v;if(op==='in')return v.includes(x);
    throw new Error('operator not in the fake: '+op);
  });
  const pick=(row,fields)=>fields?Object.fromEntries([['id',row.id],...fields.map(f=>[f,row[f]??false])]):row;
  o.fetch=async(url,init)=>{
    const body=JSON.parse(init.body),{service,args}=body.params;
    const reply=result=>Response.json({jsonrpc:'2.0',id:body.id,result});
    if(service==='common')return reply(7);
    const [,,,model,m,a=[],kw={}]=args;o.calls.push({model,method:m,args:a,kw});
    if(model==='account.analytic.line'){
      if(m==='fields_get')return reply({name:{type:'char'},date:{type:'date'},unit_amount:{type:'float'},project_id:{type:'many2one'},task_id:{type:'many2one'},employee_id:{type:'many2one'},x_studio_users:{type:'char'},x_aione_entry_uuid:{type:'char'},x_aione_user_uuid:{type:'char'},x_aione_ticket_ref:{type:'char'}});
      if(o.down)throw new TypeError('fetch failed');
      const rows=o.lines.filter(l=>ok(l,a[0]));
      if(m==='search_count')return reply(o.countOverride??rows.length);
      if(m==='search_read'){const off=kw.offset||0,lim=kw.limit||rows.length;return reply(rows.slice(off,off+lim).map(l=>pick(l,kw.fields)));}
    }
    if(model==='project.task'&&m==='search_read')return reply(o.tasks.filter(t=>ok(t,a[0])).map(t=>pick(t,kw.fields)));
    return reply(false);
  };
  return o;
}

const entry=over=>({id:'e-'+Math.random().toString(36).slice(2),ticket:'AION-1',source:'jira',ticketTitle:'Fix export',date:todayIn(),minutes:60,
  description:'Did work',author:{email:user.email,name:user.name,uuid:'u-dana'},createdAt:'2026-01-01T00:00:00.000Z',revision:1,syncedRevision:0,
  state:'syncing',lineId:null,taskId:null,projectId:null,hdProjectId:null,setup:'',error:'',review:null,revisions:[],...over});

// A store with users, the Odoo project list, ticket metadata, the work log setup and the given entries.
async function setup({entries=[],lines=[],tasks=[],odooOpts={}}={}){
  const env={SESSION_SECRET:'synthetic-secret',JIRA_PROJECT:'AION',JIRA_SITE:'https://jira.invalid',JIRA_EMAIL:'bot',JIRA_API_TOKEN:'secret',STORE:memoryStore(),
    ODOO_URL:'https://odoo.invalid',ODOO_DB:'db',ODOO_LOGIN:'bot@x',ODOO_API_KEY:'k',TIME_SYNC_SECRET:'s'.repeat(32),TEAM_CONFIG:JSON.stringify({devEmails:{builder:'builder@x'}})};
  const store=env.STORE;
  for(const me of [admin,user,other])await saveUser(store,me);
  const tokens={};for(const me of [admin,user,other])tokens[me.email]=(await makeToken(env,me.email,Date.now(),1)).token;
  await store.set(P+'config',JSON.stringify({revision:1,mode:'on',pilot:[],fields:FIELDS,mapping:{},verified:{ok:true,employee:{id:5,name:'Bot employee'}},updatedAt:null,updatedBy:null}));
  await store.set(odooProjectsKey(env),JSON.stringify({syncedAt:Date.now(),projects:[
    {id:10,name:'Branch A',active:true,clientId:900,clientName:'Acme',label:'Acme → Branch A'},
    {id:12,name:'Support',active:true,clientId:900,clientName:'Acme',label:'Acme → Support'},
    {id:20,name:'Internal',active:true,clientId:901,clientName:'Acme',label:'Acme → Internal'}]}));
  await store.set(metadataKey(env,'AION-1'),JSON.stringify({odooProjectId:10,billing:'billable'}));
  await store.set(metadataKey(env,'AION-2'),JSON.stringify({odooProjectId:12,billing:'not_billable'}));
  for(const e of entries){await store.set(P+'e:'+e.id,JSON.stringify(e));await store.sadd(P+'m:'+e.date.slice(0,7),e.id);}
  const odoo=fakeOdoo({lines,tasks,...odooOpts});
  globalThis.fetch=async(url,init={})=>String(url).startsWith('https://odoo.invalid')?odoo.fetch(url,init):Response.json({errorMessages:['no jira here']},{status:404});
  const get=async(path,me=user)=>{const r=await worker.fetch(new Request('https://proxy.invalid'+path,{headers:{Authorization:'Bearer '+tokens[me.email]}}),env);
    const type=r.headers.get('content-type')||'';return {status:r.status,type,headers:r.headers,data:type.includes('json')?await r.json():await r.text()};};
  return {env,store,get,odoo};
}

// The shared base scenario: dashboard entries in each state, Odoo lines of each kind, and one agreed-hours line.
function baseScenario(){
  const entries=[
    entry({id:'e1',ticket:'AION-1',minutes:60,state:'synced',lineId:501,syncedRevision:1,description:'Investigated'}),
    entry({id:'e2',ticket:'AION-1',minutes:30,state:'syncing',description:'Follow-up'}),
    entry({id:'e3',ticket:'AION-2',minutes:45,state:'setup',setup:'Pick a project',author:{email:other.email,name:other.name,uuid:'u-other'},description:'Printer queue'}),
    entry({id:'e4',ticket:'AION-9',ticketTitle:'Unmapped',minutes:20,state:'review',review:{kind:'x',message:'Check the ticket'},author:{email:admin.email,name:admin.name,uuid:'u-admin'},description:'=SUM(A1)'}),
    entry({id:'e5',ticket:'AION-1',minutes:120,state:'agreed',description:'Covered by agreed hours'}),
    entry({id:'e6',ticket:'AION-1',minutes:10,state:'syncing',date:daysAgo(6),description:'Outside the custom range'})
  ];
  const lines=[
    {id:501,date:todayIn(),unit_amount:1,name:'Investigated',project_id:[10,'Branch A'],task_id:[900,'[AION-1] Fix export'],employee_id:[5,'Bot employee'],x_aione_entry_uuid:'e1',x_studio_users:false},
    {id:502,date:todayIn(),unit_amount:0.5,name:'Client call',project_id:[20,'Internal'],task_id:false,employee_id:[5,'Bot employee'],x_studio_users:'Dana Developer',x_aione_entry_uuid:false},
    {id:503,date:daysAgo(1),unit_amount:2,name:'Printer fix',project_id:[10,'Branch A'],task_id:[901,'[AION-2] Printer down'],employee_id:[5,'Bot employee'],x_studio_users:false,x_aione_entry_uuid:false},
    {id:504,date:todayIn(),unit_amount:8,name:'Agreed hours',project_id:[10,'Branch A'],task_id:[900,'[AION-1] Fix export'],employee_id:[5,'Bot employee'],x_studio_users:false,x_aione_entry_uuid:'agreed:AION-1'},
    {id:505,date:daysAgo(2),unit_amount:1.5,name:'Review with the team',project_id:[20,'Internal'],task_id:false,employee_id:[5,'Bot employee'],x_studio_users:'Other Dev',x_aione_entry_uuid:false}
  ];
  return {entries,lines,tasks:[{id:900,name:'[AION-1] Fix export',project_id:[10,'Branch A']},{id:901,name:'[AION-2] Printer down',project_id:[12,'Support']}]};
}

const range=()=>'period=custom&from='+daysAgo(5)+'&to='+todayIn();

// ---- Pure rules ----
test('periods resolve in Israel calendar dates, inclusive, with the full calendar month',()=>{
  assert.deepEqual(resolvePeriod('this_month','2026-03-15','',''),{key:'this_month',from:'2026-03-01',to:'2026-03-31'});
  assert.deepEqual(resolvePeriod('last_month','2026-03-15','',''),{key:'last_month',from:'2026-02-01',to:'2026-02-28'});
  assert.deepEqual(resolvePeriod('last_month','2026-01-10','',''),{key:'last_month',from:'2025-12-01',to:'2025-12-31'});
  assert.deepEqual(resolvePeriod('last_30','2026-03-15','',''),{key:'last_30',from:'2026-02-14',to:'2026-03-15'});
  assert.deepEqual(resolvePeriod('this_month','2028-03-01','',''),{key:'this_month',from:'2028-03-01',to:'2028-03-31'});
  assert.deepEqual(resolvePeriod('last_month','2028-03-01','',''),{key:'last_month',from:'2028-02-01',to:'2028-02-29'});
  assert.deepEqual(resolvePeriod('custom','2026-03-15','2026-03-02','2026-03-04'),{key:'custom',from:'2026-03-02',to:'2026-03-04'});
  assert.deepEqual(resolvePeriod('all','2026-03-15','',''),{key:'all',from:null,to:null});
  assert.throws(()=>resolvePeriod('custom','2026-03-15','2026-03-05','2026-03-04'),/after the end date/);
  assert.throws(()=>resolvePeriod('custom','2026-03-15','2026-02-30','2026-03-04'),/valid from and to/);
  assert.equal(resolvePeriod('bogus','2026-03-15','','').key,'this_month');
});

test('durations are H:MM',()=>{
  assert.equal(formatHM(90),'1:30');assert.equal(formatHM(15),'0:15');assert.equal(formatHM(600),'10:00');
});

test('filters, totals and groups are computed over the same rows',()=>{
  const rows=[
    {id:'d:1',origin:'dashboard',date:'2026-03-10',person:'Ann',client:'Acme',project:'A',ticket:'AION-1',ticketTitle:'Export',task:'',description:'csv',minutes:60,billing:'billable',status:'syncing',lineId:null},
    {id:'d:2',origin:'dashboard',date:'2026-03-11',person:'Bob',client:'Acme',project:'B',ticket:'AION-2',ticketTitle:'Printer',task:'',description:'queue',minutes:30,billing:'not_billable',status:'setup',lineId:null},
    {id:'o:3',origin:'odoo',date:'2026-03-11',person:'Ann',client:'',project:'A',ticket:null,ticketTitle:'',task:'No task.',description:'call',minutes:90,billing:'unclassified',status:'odoo',lineId:3},
    {id:'d:4',origin:'dashboard',date:'2026-03-09',person:'Ann',client:'Acme',project:'A',ticket:'AION-1',ticketTitle:'Export',task:'',description:'held',minutes:120,billing:'billable',status:'held',lineId:null}
  ];
  assert.equal(applyFilters(rows,{q:'printer'}).length,1);
  assert.equal(applyFilters(rows,{q:'export csv'}).length,1);
  assert.equal(applyFilters(rows,{billable:true}).length,2);
  assert.equal(applyFilters(rows,{sync:'posted'}).length,1);
  assert.equal(applyFilters(rows,{sync:'unsynced'}).length,3);
  assert.equal(applyFilters(rows,{sync:'attention'}).length,1);
  assert.equal(applyFilters(rows,{person:'Ann',project:'A'}).length,3);
  const t=totalsOf(rows);
  assert.equal(t.count,4);assert.equal(t.minutes,300);assert.equal(t.billableMinutes,180);assert.equal(t.unclassifiedMinutes,90);assert.equal(t.heldCount,1);assert.equal(t.pendingCount,2);
  assert.equal(t.durationText,'5:00');
  const g=groupsOf(rows,'person');
  assert.deepEqual(g.map(x=>[x.label,x.minutes]),[['Ann',270],['Bob',30]]);
  assert.equal(g.reduce((n,x)=>n+x.minutes,0),t.minutes);
  assert.deepEqual(groupsOf(rows,'day').map(x=>x.key),['2026-03-11','2026-03-10','2026-03-09']);
  const sorted=sortRows(rows,'');
  assert.deepEqual(sorted.map(r=>r.date),['2026-03-11','2026-03-11','2026-03-10','2026-03-09']);
  assert.equal(sorted[0].id,'o:3');
});

test('CSV: the whole row set with a byte-order mark, and spreadsheet formulas neutralised',()=>{
  const csv=csvOf([{date:'2026-03-10',person:'Ann, Jr',client:'Acme',project:'A',ticket:'AION-1',ticketTitle:'T',task:'',description:'=SUM(A1)',minutes:90,billing:'billable',billingSource:'ticket',origin:'dashboard',statusLabel:'Posted',lineId:null,entryId:'e1'}].map(publicRow));
  assert.equal(csv[0],'﻿');
  const lines=csv.slice(1).split('\r\n').filter(Boolean);
  assert.equal(lines.length,2);
  assert.match(lines[1],/"Ann, Jr"/);
  assert.match(lines[1],/'=SUM\(A1\)/);
  assert.match(lines[1],/,1:30,90,Billable,/);
});

test('buildRows: a dashboard entry already in Odoo is one row, matched by entry id; agreed lines stay apart',()=>{
  const {entries,lines}=baseScenario();
  const cfg={fields:FIELDS,verified:{employee:{id:5}}};
  const built=buildRows({entries:entries.map(e=>({...e,author:e.author})),lines,cfg,catalog:{entries:[]},metas:new Map([['AION-1',{odooProjectId:10,billing:'billable'}],['AION-2',{odooProjectId:12,billing:'not_billable'}]]),
    billingCfg:{fields:{task:''}},projects:{items:{}},hd:{},known:new Map([[10,{name:'Branch A',clientName:'Acme'}]]),odooBase:'https://odoo.invalid',
    me:admin,integrationEmployeeId:5,taskBilling:new Map(),env:{JIRA_PROJECT:'AION'}});
  const ids=built.rows.map(r=>r.id);
  assert.equal(ids.includes('o:501'),false,'the Odoo copy of e1 is not a second row');
  const e1=built.rows.find(r=>r.id==='d:e1');
  assert.equal(e1.status,'synced');assert.equal(e1.lineId,501);
  assert.equal(built.rows.filter(r=>r.origin==='odoo').length,3,'502, 503 and 505 are native rows');
  assert.equal(built.agreed.length,1);
  assert.equal(built.rows.find(r=>r.id==='o:503').person,'Not recorded','the integration employee is never the worker');
  assert.equal(built.rows.find(r=>r.id==='o:503').billing,'not_billable');
  assert.equal(built.rows.find(r=>r.id==='o:502').task,'No task.');
  assert.equal(built.rows.find(r=>r.id==='o:502').billing,'unclassified');
  assert.equal(built.rows.find(r=>r.id==='d:e5').status,'held');
});

// ---- The route, with a mocked Odoo ----
test('the overview lists dashboard and Odoo work once each, newest first, with totals that match the rows',async()=>{
  const s=baseScenario();
  const {get}=await setup({entries:s.entries,lines:s.lines,tasks:s.tasks});
  const r=await get('/time-entries/overview?'+range(),admin);
  assert.equal(r.status,200,JSON.stringify(r.data));
  const rows=r.data.rows;
  assert.equal(r.data.paging.total,rows.length);
  // admin sees: e1 (posted), e2, e3, e4, e5 (held), e6 is outside the range; 502, 503, 505 native; 501 and 504 are not rows
  assert.equal(r.data.paging.total,8);
  assert.equal(r.data.totals.minutes,rows.reduce((n,x)=>n+x.minutes,0));
  assert.equal(r.data.totals.count,8);
  assert.equal(r.data.totals.pendingCount,3);
  assert.equal(r.data.totals.heldCount,1);
  const dates=rows.map(x=>x.date);assert.deepEqual([...dates].sort().reverse(),dates);
  assert.equal(rows.filter(x=>x.lineId===501).length,1);
  assert.equal(r.data.agreed.count,1);assert.equal(r.data.agreed.minutes,480);
  assert.equal(r.data.isAdmin,true);
  assert.equal(r.data.period.from,daysAgo(5));
  assert.ok(rows.every(x=>typeof x.duration==='string'));
});

test('filters run before paging: a page is cut from the matching rows, and the total counts all of them',async()=>{
  const entries=[];
  for(let i=0;i<120;i++)entries.push(entry({id:'b'+i,ticket:'AION-1',minutes:15,state:'syncing',date:daysAgo(i%10),description:'Bulk '+i}));
  const {get}=await setup({entries});
  const wide='period=custom&from='+daysAgo(9)+'&to='+todayIn();
  const first=await get('/time-entries/overview?'+wide+'&limit=50&offset=0');
  const last=await get('/time-entries/overview?'+wide+'&limit=50&offset=100');
  assert.equal(first.data.rows.length,50);assert.equal(last.data.rows.length,20);
  assert.equal(last.data.paging.total,120);
  assert.equal(first.data.totals.minutes,120*15);
  // Only "Bulk 90" contains "90": the filter is applied to all 120 rows before the page is cut.
  const bulk=await get('/time-entries/overview?'+wide+'&q=bulk%2090&limit=50');
  assert.equal(bulk.data.paging.total,1);
  assert.equal(bulk.data.rows.length,1);
  // "bulk" alone matches all 120; the page size is still respected.
  const every=await get('/time-entries/overview?'+wide+'&q=bulk&limit=50');
  assert.equal(every.data.paging.total,120);
  assert.equal(every.data.rows.length,50);
  // every row on each page is newest first across pages
  const all=[...first.data.rows,...(await get('/time-entries/overview?'+wide+'&limit=50&offset=50')).data.rows,...last.data.rows];
  assert.equal(all.length,120);
  assert.deepEqual([...all.map(x=>x.date)].sort().reverse(),all.map(x=>x.date));
});

test('custom dates are inclusive on both ends, and the Odoo read is limited to the same dates',async()=>{
  const s=baseScenario();
  const {get,odoo}=await setup({entries:s.entries,lines:s.lines,tasks:s.tasks});
  const r=await get('/time-entries/overview?period=custom&from='+daysAgo(1)+'&to='+daysAgo(1),admin);
  assert.equal(r.status,200,JSON.stringify(r.data));
  assert.deepEqual(r.data.rows.map(x=>x.id),['o:503']);
  assert.equal(r.data.totals.minutes,120);
  const dateCalls=odoo.calls.filter(c=>c.model==='account.analytic.line'&&c.method==='search_count')[0].args[0];
  assert.deepEqual(dateCalls.filter(d=>d[0]==='date'),[['date','>=',daysAgo(1)],['date','<=',daysAgo(1)]]);
  const bad=await get('/time-entries/overview?period=custom&from=2026-03-05&to=2026-03-04',admin);
  assert.equal(bad.status,400);
});

test('"all dates" reads every stored entry and every Odoo line without bounds',async()=>{
  const s=baseScenario();
  const {get,odoo}=await setup({entries:s.entries,lines:s.lines,tasks:s.tasks});
  const r=await get('/time-entries/overview?period=all',admin);
  assert.equal(r.data.period.from,null);
  assert.equal(r.data.rows.length,9,'six dashboard entries (e6 included), three native lines; the Odoo copy of e1 and the agreed-hours line are not rows');
  const search=odoo.calls.find(c=>c.model==='account.analytic.line'&&c.method==='search_count');
  assert.deepEqual(search.args[0],[['project_id','!=',false]]);
});

test('combined filters: billable only, posted only, one person, one project',async()=>{
  const s=baseScenario();
  const {get}=await setup({entries:s.entries,lines:s.lines,tasks:s.tasks});
  const billable=await get('/time-entries/overview?'+range()+'&billable=1',admin);
  assert.deepEqual(billable.data.rows.map(x=>x.id).sort(),['d:e1','d:e2','d:e5'].sort());
  assert.equal(billable.data.totals.billableMinutes,billable.data.totals.minutes);
  const posted=await get('/time-entries/overview?'+range()+'&sync=posted',admin);
  assert.deepEqual(posted.data.rows.map(x=>x.id).sort(),['d:e1','o:502','o:503','o:505'].sort());
  const person=await get('/time-entries/overview?'+range()+'&person=Other%20Dev',admin);
  assert.deepEqual(person.data.rows.map(x=>x.id).sort(),['d:e3','o:505'].sort());
  // AION-2 is on the Support project, so its dashboard entry (e3) is the only row there.
  const project=await get('/time-entries/overview?'+range()+'&project=Support',admin);
  assert.deepEqual(project.data.rows.map(x=>x.id),['d:e3']);
});

test('groups add up to the totals, and the export has every matching row',async()=>{
  const s=baseScenario();
  const {get}=await setup({entries:s.entries,lines:s.lines,tasks:s.tasks});
  const grouped=await get('/time-entries/overview?'+range()+'&groupBy=person',admin);
  assert.equal(grouped.data.groups.reduce((n,g)=>n+g.minutes,0),grouped.data.totals.minutes);
  assert.equal(grouped.data.groups.reduce((n,g)=>n+g.count,0),grouped.data.paging.total);
  const exp=await get('/time-entries/overview/export?'+range()+'&sync=posted',admin);
  assert.equal(exp.status,200);
  assert.match(exp.type,/text\/csv/);
  const lines=exp.data.split('\r\n').filter(Boolean);
  assert.equal(lines.length-1,4,'the header, then the four posted rows');
  assert.match(exp.headers.get('content-disposition')||'',/^attachment; filename="work-log-/);
});

test('permissions: a person sees only their own dashboard entries and the Odoo lines naming them, in the page and the export',async()=>{
  const s=baseScenario();
  const {get}=await setup({entries:s.entries,lines:s.lines,tasks:s.tasks});
  const r=await get('/time-entries/overview?'+range(),user);
  assert.equal(r.status,200);
  assert.deepEqual(r.data.rows.map(x=>x.id).sort(),['d:e1','d:e2','d:e5','o:502'].sort());
  assert.equal(r.data.agreed,null,'agreed-hours accounting is administrator-only');
  assert.equal(r.data.isAdmin,false);
  assert.equal(r.data.totals.minutes,60+30+120+30);
  const exp=await get('/time-entries/overview/export?'+range(),user);
  assert.equal(exp.data.split('\r\n').filter(Boolean).length-1,4);
  assert.ok(!exp.data.includes('Other Dev'));
  assert.ok(!exp.data.includes('Not recorded'));
});

test('billing is for administrators: a person never receives billing fields, totals, groups, filter or export column',async()=>{
  const s=baseScenario();
  const {get}=await setup({entries:s.entries,lines:s.lines,tasks:s.tasks});
  const q='/time-entries/overview?'+range()+'&billable=1&groupBy=day';
  const r=await get(q,user);
  assert.equal(r.status,200);
  assert.ok(r.data.rows.length>0);
  for(const x of r.data.rows){assert.equal('billing' in x,false);assert.equal('billingSource' in x,false);}
  for(const k of ['billableMinutes','notBillableMinutes','unclassifiedMinutes','billableText'])assert.equal(k in r.data.totals,false,k);
  for(const g of r.data.groups){assert.equal('billableMinutes' in g,false);assert.equal('billableText' in g,false);}
  assert.equal(r.data.filters.billable,false,'the billable filter does not apply to a person');
  assert.equal(r.data.totals.count,4,'the billable filter is ignored, so every visible row counts');
  const exp=await get('/time-entries/overview/export?'+range(),user);
  const head=exp.data.split('\r\n')[0];
  assert.ok(!/Billing/.test(head),head);
  // The administrator's view keeps the billing fields.
  const a=await get(q,admin);
  assert.ok(a.data.rows.every(x=>'billing' in x&&'billingSource' in x));
  assert.ok('billableMinutes' in a.data.totals);
  const ae=await get('/time-entries/overview/export?'+range(),admin);
  assert.match(ae.data.split('\r\n')[0],/Billing/);
});

test('an Odoo read failure is an error, not a partial total',async()=>{
  const s=baseScenario();
  const {get}=await setup({entries:s.entries,lines:s.lines,tasks:s.tasks,odooOpts:{down:true}});
  const r=await get('/time-entries/overview?'+range(),admin);
  assert.equal(r.status,503);
  assert.equal(r.data.rows,undefined);
  assert.equal(r.data.code,'odoo');
});

test('a period with too many Odoo lines asks for a shorter period',async()=>{
  const s=baseScenario();
  const {get}=await setup({entries:s.entries,lines:s.lines,tasks:s.tasks,odooOpts:{count:25000}});
  const r=await get('/time-entries/overview?'+range(),admin);
  assert.equal(r.status,400);
  assert.equal(r.data.code,'too_many_lines');
});

test('reading the overview never changes the saved work log setup',async()=>{
  const s=baseScenario();
  const {get,store,env}=await setup({entries:s.entries,lines:s.lines,tasks:s.tasks});
  const before=await store.get('tw:AION:config');
  await get('/time-entries/overview?period=all',admin);
  await get('/time-entries/overview/export?period=all',admin);
  assert.equal(await store.get('tw:AION:config'),before);
  void env;
});
