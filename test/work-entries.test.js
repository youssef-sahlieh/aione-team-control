// The work view of Clients & projects: flat Odoo timesheet rows, their period, filters, totals and export, on synthetic
// data with a fixed clock. The fake Odoo answers only what this view asks; nothing here reaches a real service.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{makeToken} from '../proxy/src/handler.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';
import {odooProjectsKey} from '../proxy/src/ticket-metadata.js';
import {listWorkEntries} from '../proxy/src/work-entries.js';

const admin={email:'admin@example.invalid',name:'Manager',role:'admin',dev:'builder',v:1};
const user={email:'user@example.invalid',name:'Dana Developer',role:'user',dev:'builder',v:1};
const realFetch=globalThis.fetch;
// The clock: 15 November 2026, mid-morning in Asia/Jerusalem.
const NOV=new Date('2026-11-15T10:00:00Z');

// One condition of an Odoo domain: =, in, ilike, >= and <= (a many2one compares its id; false matches an empty field).
function matches(rec,[field,op,v]){
  const x=rec[field],id=Array.isArray(x)?x[0]:x;
  if(op==='=')return v===false?(x===false||x==null):id===v;
  if(op==='in')return v.includes(id);
  if(op==='ilike')return String(x??'').toLowerCase().includes(String(v).toLowerCase());
  if(op==='>=')return x>=v;
  if(op==='<=')return x<=v;
  throw new Error('operator '+op);
}
// A domain in Odoo's prefix form: '|' takes the two conditions after it; the rest are ANDed.
function evalDomain(rec,dom){
  let i=0;
  const one=()=>{if(dom[i]==='|'){i++;const x=one(),y=one();return x||y;}return matches(rec,dom[i++]);};
  let ok=true;while(i<dom.length)ok=one()&&ok;
  return ok;
}
const pick=(rec,fields)=>{const out={id:rec.id};for(const f of fields?.length?fields:Object.keys(rec))if(f in rec)out[f]=rec[f];return out;};

function fakeOdoo(lines,tasks){
  return async(url,init)=>{
    if(String(url).startsWith('https://jira.invalid'))return Response.json({issues:[]});
    const b=JSON.parse(init.body),{service,args}=b.params,reply=result=>Response.json({jsonrpc:'2.0',id:b.id,result});
    if(service==='common')return reply(7);
    const [, , , model,method,a=[],kw={}]=args;
    if(model==='res.users'&&method==='search_read')return reply([{id:7,company_ids:[1]}]);
    if(model==='project.task'&&method==='search_read')return reply(tasks.filter(t=>a[0].every(c=>matches(t,c))).map(t=>pick(t,kw.fields)));
    if(model==='account.analytic.line'&&method==='search_read'){
      let rows=lines.filter(l=>evalDomain(l,a[0]));
      if(kw.order)rows=[...rows].sort((x,y)=>(y.date.localeCompare(x.date))||(y.id-x.id));
      if(kw.limit)rows=rows.slice(0,kw.limit);
      return reply(rows.map(l=>pick(l,kw.fields)));
    }
    return reply([]);
  };
}

// Odoo: project 10 (Acme, billable by default) and project 20 (Beta, no billing: its work is unclassified). Tasks of project
// 10: a ticket "[AION-7] …", tasks with the billing field values b (billable), n (not billable), i (inherit); a task created
// in 2025 for work logged now. Project 20 has one task.
async function setup(){
  const lines=[],tasks=[
    {id:1,name:'[AION-7] Checkout fails',project_id:[10,'Branch A'],x_billing:'n',create_date:'2026-01-05 09:00:00'},
    {id:2,name:'Fix login page',project_id:[10,'Branch A'],x_billing:'b',create_date:'2026-01-05 09:00:00'},
    {id:3,name:'Docs',project_id:[10,'Branch A'],x_billing:'i',create_date:'2026-01-05 09:00:00'},
    {id:4,name:'Support call',project_id:[10,'Branch A'],x_billing:'n',create_date:'2026-01-05 09:00:00'},
    {id:5,name:'Website copy',project_id:[20,'Website'],x_billing:false,create_date:'2026-01-05 09:00:00'},
    {id:6,name:'Late task',project_id:[10,'Branch A'],x_billing:'b',create_date:'2025-06-01 00:00:00'}];
  const env={SESSION_SECRET:'synthetic-secret',JIRA_PROJECT:'AION',JIRA_SITE:'https://jira.invalid',JIRA_EMAIL:'bot@example.invalid',JIRA_API_TOKEN:'t',STORE:memoryStore(),TIME_SYNC_SECRET:'s'.repeat(32),
    MAIL_DOMAIN:'example.invalid',NO_DEVELOPER_NOTIFY_TO:'sales@example.invalid',ODOO_URL:'https://odoo.invalid',ODOO_DB:'db',ODOO_LOGIN:'bot@example.invalid',ODOO_API_KEY:'k'};
  globalThis.fetch=fakeOdoo(lines,tasks);
  for(const me of [admin,user])await saveUser(env.STORE,me);
  await env.STORE.set(odooProjectsKey(env),JSON.stringify({syncedAt:Date.now(),projects:[
    {id:10,name:'Branch A',active:true,clientId:900,clientName:'Acme',label:'Acme → Branch A'},
    {id:20,name:'Website',active:true,clientId:901,clientName:'Beta & Co',label:'Beta & Co → Website'}]}));
  await env.STORE.set('business:AION:billing:config',JSON.stringify({revision:1,classification:true,emails:'dry',fields:{project:'',task:'x_billing'},values:{project:{},task:{b:'billable',n:'not_billable',i:'inherit'}},quotationUrl:''}));
  await env.STORE.set('business:AION:billing:projects',JSON.stringify({revision:1,items:{10:{billing:'billable'}}}));
  await env.STORE.set('tw:AION:config',JSON.stringify({fields:{users:'',entryUuid:'x_entry_uuid',userUuid:'',lineRef:''},mapping:{}}));
  // A line in Odoo. The dashboard's lines carry its entry id in x_entry_uuid.
  const line=(date,hours,task,extra={})=>{const l={id:lines.length+1,date,unit_amount:hours,name:'Work '+(lines.length+1),project_id:[10,'Branch A'],task_id:task?[task,'']:false,user_id:[7,'Builder'],x_entry_uuid:false,...extra};lines.push(l);return l;};
  // A dashboard entry (kept as the dashboard keeps it). Its Odoo line id is lineId, empty while it is not in Odoo yet.
  const entry=async(key,minutes,date,meta={})=>{
    const id=crypto.randomUUID(),e={id,ticket:key,source:key.startsWith('INT-')?'internal':'jira',ticketTitle:'Ticket '+key,date,minutes,description:'Dashboard work on '+key,
      author:{email:user.email,name:user.name},createdAt:new Date().toISOString(),revision:1,syncedRevision:1,state:'synced',lineId:null,projectId:10,...meta};
    await env.STORE.set('tw:AION:e:'+id,JSON.stringify(e));await env.STORE.sadd('tw:AION:t:'+key,id);await env.STORE.sadd('tw:AION:m:'+date.slice(0,7),id);return e;
  };
  const run=(q,now=NOV)=>listWorkEntries(env,q,{now});
  return {env,lines,line,entry,run};
}
test.afterEach(()=>{globalThis.fetch=realFetch;});

test('dates: the Oct 27 entry is in October and All dates, never in November; both month ends are included',async()=>{
  const s=await setup();
  s.line('2026-10-27',2,2);
  s.line('2026-10-31',3,2);
  s.line('2026-11-01',1,2);
  s.line('2026-11-30',1,2);
  s.line('2026-12-01',5,2);
  assert.equal((await s.run({})).totals.count,2,'this month: Nov 1 and Nov 30, not Oct 27, not Dec 1');
  assert.deepEqual((await s.run({})).totals.hours,2);
  const oct=await s.run({period:'last_month'});
  assert.deepEqual([oct.totals.count,oct.totals.hours],[2,5],'last month: Oct 27 and Oct 31');
  assert.equal(oct.period.from,'2026-10-01');assert.equal(oct.period.to,'2026-10-31');
  const day=await s.run({period:'custom',from:'2026-10-27',to:'2026-10-27'});
  assert.deepEqual([day.totals.count,day.entries[0].date],[1,'2026-10-27'],'a one-day custom range includes that day');
  const all=await s.run({period:'all'});
  assert.equal(all.totals.count,3,'All dates runs from 2020-01-01 to today (15 Nov): Oct 27, Oct 31 and Nov 1; Nov 30 and Dec 1 are after today');
  assert.ok(all.entries.some(e=>e.date==='2026-10-27'));
});

test('dates: the Jerusalem calendar decides the day, where the UTC date is one day behind',async()=>{
  const s=await setup();
  s.line('2026-03-31',1,2);
  s.line('2026-04-01',2,2);
  // 22:30 UTC on 31 March is 01:30 on 1 April in Jerusalem (summer time): the month is April.
  const apr=await s.run({},new Date('2026-03-31T22:30:00Z'));
  assert.equal(apr.period.from,'2026-04-01');assert.deepEqual([apr.totals.count,apr.totals.hours],[1,2]);
  // 20:30 UTC on 31 March is 23:30 on 31 March in Jerusalem: still March.
  const mar=await s.run({},new Date('2026-03-31T20:30:00Z'));
  assert.equal(mar.period.to,'2026-03-31');assert.deepEqual([mar.totals.count,mar.totals.hours],[1,1]);
  const last30=await s.run({period:'last_30'},new Date('2026-03-31T22:30:00Z'));
  assert.deepEqual([last30.period.from,last30.period.to],['2026-03-03','2026-04-01']);
  assert.equal(last30.totals.count,2);
});

test('dates: daylight saving changes do not move an Odoo date; the boundary days are included',async()=>{
  const s=await setup();
  s.line('2026-03-27',1,2); // the day summer time starts
  s.line('2026-03-29',2,2);
  s.line('2026-10-25',4,2); // the day summer time ends
  const spring=await s.run({period:'custom',from:'2026-03-27',to:'2026-03-29'});
  assert.deepEqual(spring.entries.map(e=>[e.date,e.hours]).sort(),[['2026-03-27',1],['2026-03-29',2]].sort());
  const autumn=await s.run({period:'custom',from:'2026-10-25',to:'2026-10-25'});
  assert.deepEqual([autumn.entries[0].date,autumn.totals.hours],['2026-10-25',4]);
});

test('dates: New Year and leap years: the month and the last month roll over; February has 28 or 29 days',async()=>{
  const s=await setup();
  s.line('2026-12-31',1,2);s.line('2027-01-01',2,2);s.line('2027-01-31',3,2);s.line('2027-02-01',4,2);
  const jan=await s.run({},new Date('2027-01-03T09:00:00Z'));
  assert.deepEqual([jan.period.from,jan.period.to],['2027-01-01','2027-01-31']);assert.deepEqual([jan.totals.count,jan.totals.hours],[2,5]);
  const dec=await s.run({period:'last_month'},new Date('2027-01-03T09:00:00Z'));
  assert.deepEqual([dec.period.from,dec.period.to],['2026-12-01','2026-12-31']);assert.equal(dec.totals.count,1);
  // Leap year 2028: February 29 is a day; 2027: it is not.
  const leap=await s.run({},new Date('2028-02-10T09:00:00Z'));
  assert.equal(leap.period.to,'2028-02-29');
  const leapDay=await s.run({period:'custom',from:'2028-02-29',to:'2028-02-29'});assert.equal(leapDay.period.from,'2028-02-29');
  await assert.rejects(s.run({period:'custom',from:'2027-02-29',to:'2027-02-29'}),/valid dates/);
  const plain=await s.run({},new Date('2027-02-10T09:00:00Z'));
  assert.equal(plain.period.to,'2027-02-28');
  const last=await s.run({period:'last_month'},new Date('2027-03-02T09:00:00Z'));
  assert.deepEqual([last.period.from,last.period.to],['2027-02-01','2027-02-28']);
  assert.equal(last.totals.count,1,'Feb 1 only: a line on Feb 1 in 2027 is in February; the Jan 31 line is not');
});

test('dates: custom ranges are inclusive and invalid ranges are refused',async()=>{
  const s=await setup();
  s.line('2026-11-05',1,2);s.line('2026-11-10',2,2);s.line('2026-11-12',3,2);
  const r=await s.run({period:'custom',from:'2026-11-05',to:'2026-11-10'});
  assert.deepEqual([r.totals.count,r.totals.hours],[2,3],'both ends included');
  await assert.rejects(s.run({period:'custom',from:'2026-11-10',to:'2026-11-05'}),/start date is after the end date/);
  await assert.rejects(s.run({period:'custom',from:'2026-02-30',to:'2026-03-01'}),/valid dates/);
  await assert.rejects(s.run({period:'custom',from:'2026-11-01'}),/valid dates/);
  await assert.rejects(s.run({period:'custom',from:'2026-11-1',to:'2026-11-05'}),/valid dates/);
  await assert.rejects(s.run({period:'custom',from:'2025-01-01',to:'2026-11-05'}),/at most about a year/);
});

test('a task created in another month: the work counts in the month it was logged',async()=>{
  const s=await setup();
  s.line('2026-11-02',2,6);  // task 6 was created in June 2025
  s.line('2026-10-02',3,1);  // logged in October, on a task created in January 2026
  const r=await s.run({});
  assert.deepEqual([r.totals.count,r.totals.hours],[1,2]);
  assert.equal(r.entries[0].task.name,'Late task');
});

test('rows: a line counts once; a dashboard entry already in Odoo is not listed again; unsent work is listed apart',async()=>{
  const s=await setup();
  const odooLine=s.line('2026-11-03',1.5,2,{x_entry_uuid:'uuid-1'});  // sent by the dashboard, in Odoo
  s.line('2026-11-04',0.5,2);                                        // entered in Odoo only
  await s.entry('AION-7',90,'2026-11-03',{projectId:10,lineId:odooLine.id,syncedRevision:1,revision:1,state:'synced'});
  await s.entry('AION-7',60,'2026-11-05',{projectId:10,lineId:null,state:'setup'}); // not in Odoo yet
  const r=await s.run({});
  assert.deepEqual([r.totals.count,r.totals.hours],[2,2],'the Odoo lines: 1.5 once, 0.5');
  assert.equal(r.entries.filter(e=>e.id===odooLine.id).length,1);
  assert.deepEqual([r.pending.totals.count,r.pending.totals.hours],[1,1],'the unsent hour is listed apart, not in the Odoo total');
  assert.equal(r.pending.entries[0].source,'dashboard');
});

test('billing: a task\'s own value, the project default when it inherits, not billable, unclassified; no task uses the project',async()=>{
  const s=await setup();
  s.line('2026-11-02',1,2);   // billable task
  s.line('2026-11-02',2,3);   // inherits: the project is billable
  s.line('2026-11-02',3,4);   // not billable
  s.line('2026-11-02',4,false);      // no task: the project's default
  s.line('2026-11-02',5,5,{project_id:[20,'Website']}); // a project with no billing: unclassified
  const r=await s.run({});
  const by=Object.fromEntries(r.entries.map(e=>[e.hours,e.billing]));
  assert.deepEqual(by[1],{value:'billable',source:'ticket'},'an explicit task value is the override');
  assert.equal(by[2].value,'billable');
  assert.equal(by[3].value,'not_billable');
  assert.deepEqual(by[4],{value:'billable',source:'project'},'no task: the project classification, and it says so');
  assert.equal(by[5].value,'unclassified');
  const noTask=r.entries.find(e=>e.hours===4);assert.equal(noTask.task,null,'shown as No task');
  const b=await s.run({billable:'1'});
  assert.deepEqual([b.totals.count,b.totals.hours,b.totals.billableCount],[3,7,3],'billable only: 1 + 2 + 4; unclassified and not billable left out');
  assert.equal(b.totals.billableHours,7);
});

test('filters: client and project narrow the rows; a search matches the line text or the task name',async()=>{
  const s=await setup();
  s.line('2026-11-02',1,1);                       // Checkout task, Acme
  s.line('2026-11-03',2,false,{name:'Ops meeting'});
  s.line('2026-11-04',3,5,{project_id:[20,'Website']});
  const acme=await s.run({client:'900'});assert.deepEqual([acme.totals.count,acme.totals.hours],[2,3]);
  const beta=await s.run({client:'901'});assert.deepEqual([beta.totals.count,beta.totals.hours],[1,3]);
  const p10=await s.run({project:'10'});assert.equal(p10.totals.count,2);
  const none=await s.run({client:'900',project:'20'});assert.equal(none.totals.count,0,'a project of another client');
  const byTask=await s.run({search:'Checkout'});assert.equal(byTask.totals.count,1,'matched by the ticket task name');
  const byText=await s.run({search:'meeting'});assert.equal(byText.totals.count,1,'matched by the line text');
  await assert.rejects(s.run({client:'abc'}),/Choose a client/);
});

test('paging: more than 50 entries across pages; the totals do not change with the page',async()=>{
  const s=await setup();
  for(let i=0;i<60;i++)s.line('2026-11-'+String(1+(i%15)).padStart(2,'0'),1,2);
  const p1=await s.run({limit:'50'});
  assert.deepEqual([p1.entries.length,p1.nextOffset,p1.totals.count,p1.totals.hours],[50,50,60,60]);
  const p2=await s.run({limit:'50',offset:'50'});
  assert.deepEqual([p2.entries.length,p2.nextOffset,p2.totals.count],[10,null,60]);
  const ids=[...p1.entries,...p2.entries].map(e=>e.id);assert.equal(new Set(ids).size,60,'every entry once across the pages');
});

test('export: the same filters, every matching row, with the same totals as the list',async()=>{
  const s=await setup();
  for(let i=0;i<55;i++)s.line('2026-11-'+String(1+(i%10)).padStart(2,'0'),1,i%2?2:3);
  s.line('2026-11-02',2,false);            // no task: project 10, billable
  s.line('2026-11-02',9,5,{project_id:[20,'Website']}); // another client
  const q={client:'900',billable:'1',search:'Work'};
  const list=await s.run({...q,limit:'10'});
  const all=await s.run({...q,export:'1'});
  assert.equal(all.entries.length,list.totals.count,'the export has every matching row');
  assert.deepEqual(all.totals,list.totals,'the same totals');
  assert.equal(all.nextOffset,null);
  assert.equal(all.entries.reduce((n,e)=>n+e.hours,0).toFixed(2),list.totals.hours.toFixed(2));
});

test('combined filters: client, project, search, billable and the period agree between rows, totals and export',async()=>{
  const s=await setup();
  s.line('2026-11-02',1,1);s.line('2026-11-03',2,2);s.line('2026-11-04',3,4);s.line('2026-10-04',4,2);
  s.line('2026-11-05',5,5,{project_id:[20,'Website']});
  const q={period:'this_month',client:'900',project:'10',billable:'1',search:'Work'};
  const r=await s.run({...q,period:'month'});
  const x=await s.run({...q,period:'month',export:'1'});
  assert.deepEqual(r.totals,x.totals);
  assert.equal(x.entries.length,r.totals.count);
  assert.ok(x.entries.every(e=>e.billing.value==='billable'&&e.client.id===900&&e.project.id===10));
  assert.equal(r.filters.billable,true);
});

test('out-of-order and rapid changes: the server answers each request on its own, with no shared state',async()=>{
  const s=await setup();
  s.line('2026-11-02',1,2);s.line('2026-11-03',2,2,{project_id:[20,'Website']});
  const [a,b]=await Promise.all([s.run({client:'900'}),s.run({client:'901'})]);
  assert.equal(a.totals.count,1);assert.equal(b.totals.count,1);
  assert.equal(a.filters.client,900);assert.equal(b.filters.client,901);
});

test('the route: administrators only; the response carries the resolved period and the totals',async()=>{
  const s=await setup();
  s.line(new Date().toISOString().slice(0,10),1,2);
  const tokens={};for(const me of [admin,user])tokens[me.email]=(await makeToken(s.env,me.email,Date.now(),1)).token;
  const call=async(path,me)=>{const r=await worker.fetch(new Request('https://proxy.invalid'+path,{headers:{Authorization:'Bearer '+tokens[me.email]}}),s.env);return {status:r.status,data:await r.json()};};
  const ok=await call('/clients/odoo-projects/work-entries',admin);
  assert.equal(ok.status,200,JSON.stringify(ok.data));
  assert.equal(ok.data.period.key,'month');assert.equal(ok.data.totals.count,1);
  assert.equal((await call('/clients/odoo-projects/work-entries',user)).status,403);
});
