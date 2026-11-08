import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{makeToken} from '../proxy/src/handler.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';
import {prepareImport,catalogKey,readCatalog,allocatedHoursInput,metadataKey} from '../proxy/src/ticket-metadata.js';
import {budgetStatus} from '../proxy/src/project-budget.js';
const admin={email:'admin@example.invalid',name:'Manager',role:'admin',dev:'builder',v:1};
const user={email:'user@example.invalid',name:'Developer',role:'user',dev:'builder',v:1};
// Odoo: company 1 is the main one ("All in One"), 9 another. Project 10 is linked to the dashboard, 11 is Odoo only,
// 12 belongs to the other company.
async function setup({readGroup=true}={}){
  const env={SESSION_SECRET:'synthetic-secret',JIRA_PROJECT:'AION',JIRA_SITE:'https://jira.invalid',JIRA_EMAIL:'bot',JIRA_API_TOKEN:'secret',STORE:memoryStore(),TEAM_CONFIG:JSON.stringify({people:{lead:{id:'lead',name:'Lead'}}}),
    ODOO_URL:'https://odoo.invalid',ODOO_DB:'db',ODOO_LOGIN:'bot@example.invalid',ODOO_API_KEY:'k'};
  for(const me of [admin,user])await saveUser(env.STORE,me);
  const tokens=Object.fromEntries(await Promise.all([admin,user].map(async me=>[me.role,(await makeToken(env,me.email,Date.now(),1)).token])));
  const imported=await prepareImport({revision:0,entries:[]},[{customer:'Acme',displayName:'Branch A',sourceRow:2},{customer:'Acme',displayName:'Branch B',sourceRow:3}]);
  const cat={...imported.next,revision:1},sub=cat.entries.find(e=>e.name==='Branch A'),other=cat.entries.find(e=>e.name==='Branch B');
  sub.sources.push({source:'odoo',row:10});
  await env.STORE.set(catalogKey(env),JSON.stringify(cat));
  await env.STORE.set('business:AION:epic-map',JSON.stringify({revision:1,map:{'AION-100':sub.id}}));
  // Work not in Odoo yet: 90 minutes going to project 11, 30 minutes on a ticket whose task is in project 10, and an
  // entry that already has its Odoo line (a correction waiting to sync), which must not be counted again.
  const P='tw:AION:';
  for(const [id,e] of Object.entries({a:{ticket:'AION-7',minutes:90,projectId:11},b:{ticket:'AION-5',minutes:30},c:{ticket:'AION-1',minutes:600,projectId:10,lineId:55}})){await env.STORE.set(P+'e:'+id,JSON.stringify(e));await env.STORE.sadd(P+'pending',id);}
  await env.STORE.set(P+'task:AION-5',JSON.stringify({taskId:3,projectId:10}));
  // 11 has no allocation (Odoo reads false); 13 is archived, so it is in no list.
  const projects=[{id:10,name:'Branch A',partner_id:[1,'Acme'],company_id:[1,'All in One'],allocated_hours:10,create_date:'2026-03-01 09:00:00'},{id:11,name:'Odoo only',partner_id:false,company_id:false,allocated_hours:false,create_date:'2026-05-01 09:00:00'},{id:12,name:'Holding job',partner_id:[2,'Holding'],company_id:[9,'Holding'],allocated_hours:5,create_date:'2026-04-01 09:00:00'},{id:13,name:'Archived job',partner_id:false,company_id:false,allocated_hours:3,active:false,create_date:'2026-06-01 09:00:00'}];
  const writes=[],realFetch=globalThis.fetch;
  globalThis.fetch=async(u,init)=>{const p=JSON.parse(init.body).params;if(p.service==='common')return Response.json({result:7});
    const [model,method,args,kw]=[p.args[3],p.args[4],p.args[5],p.args[6]];
    if(model==='res.users')return Response.json({result:[{id:6,company_ids:[9,1]}]});
    if(model==='res.company')return Response.json({result:[{id:1,name:'All in One'},{id:9,name:'Holding'}]});
    if(model==='project.project'&&method==='fields_get')return Response.json({result:{allocated_hours:{type:'float',readonly:false}}});
    if(model==='project.project'&&method==='search_read'){assert.deepEqual(kw.context.allowed_company_ids,[9,1]);const d=args[0];if(d.length&&d[0][0]==='active'){assert.deepEqual(d,[['active','=',true]]);return Response.json({result:projects.filter(x=>x.active!==false).map(({allocated_hours,active,...x})=>x)});}if(d.some(c=>c[0]==='type_ids'))return Response.json({result:[{id:10}]});return Response.json({result:d.length?projects.filter(x=>x.id===d[0][2]):projects.map(({allocated_hours,...x})=>x)});}
    if(model==='project.project'&&method==='read')return Response.json({result:projects.filter(x=>args[0].includes(x.id)).map(x=>({id:x.id,allocated_hours:x.allocated_hours}))});
    if(model==='project.project'&&method==='write'){writes.push(args);Object.assign(projects.find(x=>x.id===args[0][0]),args[1]);return Response.json({result:true});}
    if(model==='account.analytic.line'&&method==='read_group'){if(!readGroup)return Response.json({error:{message:'Odoo Server Error',data:{message:'read_group is removed'}}});return Response.json({result:[{project_id:[10,'Branch A'],unit_amount:12.5,date:'2026-10-20'},{project_id:[12,'Holding job'],unit_amount:4.5,date:'2026-09-02'}]});}
    if(model==='account.analytic.line'&&method==='formatted_read_group')return Response.json({result:[{project_id:[10,'Branch A'],'unit_amount:sum':12.5,'date:max':'2026-10-20'},{project_id:[12,'Holding job'],'unit_amount:sum':4.5,'date:max':'2026-09-02'}]});
    if(model==='account.analytic.line'&&method==='search_read'){return Response.json({result:args[0][0][2]!==10?[]:[{id:55,date:'2026-10-20',name:'Fixed the export',unit_amount:2.5,employee_id:[5,'Dana'],task_id:[3,'[AION-1] One']}]});}
    if(model==='account.analytic.line'&&method==='search_count')return Response.json({result:1});
    if(model==='project.task')return Response.json({result:[{name:'[AION-1] One',project_id:[10,'Branch A']},{name:'[AION-2] Two',project_id:[10,'Branch A']},{name:'[INT-3] Internal',project_id:[10,'Branch A']},{name:'Plain task',project_id:[11,'Odoo only']}]});
    return Response.json({result:[]});};
  const call=(path,method='GET',body,me=admin)=>worker.fetch(new Request('https://proxy.invalid'+path,{method,headers:{Authorization:'Bearer '+tokens[me.role],'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  return {env,call,sub,other,writes,projects,restore:()=>{globalThis.fetch=realFetch;}};
}
test('budget status: not set, on track, near the limit and over by the hours over',()=>{
  assert.deepEqual(budgetStatus(null,5),{status:'not_set',remainingHours:null,overHours:0,usedPercent:null});
  assert.deepEqual(budgetStatus(10,2),{status:'on_track',remainingHours:8,overHours:0,usedPercent:20});
  // Near limit from 80% of the allocation.
  assert.equal(budgetStatus(10,7.99).status,'on_track');
  assert.deepEqual(budgetStatus(10,8),{status:'near',remainingHours:2,overHours:0,usedPercent:80});
  assert.deepEqual(budgetStatus(10,10),{status:'near',remainingHours:0,overHours:0,usedPercent:100});
  assert.deepEqual(budgetStatus(10,12.5),{status:'over',remainingHours:-2.5,overHours:2.5,usedPercent:125});
  // An explicit zero is an allocation: nothing logged is on track, any logged time is over. It is never "near limit",
  // and has no used share (nothing to divide by).
  assert.deepEqual(budgetStatus(0,0),{status:'on_track',remainingHours:0,overHours:0,usedPercent:null});
  assert.deepEqual(budgetStatus(0,0.5),{status:'over',remainingHours:-0.5,overHours:0.5,usedPercent:null});
});
test('allocated hours: empty is not known, zero and decimals are kept',()=>{
  assert.equal(allocatedHoursInput(undefined),undefined);assert.equal(allocatedHoursInput(null),undefined);assert.equal(allocatedHoursInput(''),undefined);
  assert.equal(allocatedHoursInput(0),0);assert.equal(allocatedHoursInput('0'),0);assert.equal(allocatedHoursInput('12.5'),12.5);assert.equal(allocatedHoursInput(10),10);
  for(const bad of [-1,'-0.5','abc','1.234',NaN,'Infinity',2000000])assert.throws(()=>allocatedHoursInput(bad),err=>err.status===400,String(bad));
});
for(const readGroup of [true,false])test('every Odoo project is listed with its links and hours, each hour counted once'+(readGroup?'':' (Odoo 19 grouping)'),async()=>{
  const s=await setup({readGroup});
  try{
    assert.equal((await s.call('/clients/odoo-projects','GET',undefined,user)).status,403);
    const r=await s.call('/clients/odoo-projects');assert.equal(r.status,200);
    const data=await r.json(),by=Object.fromEntries(data.projects.map(p=>[p.odooId,p]));
    assert.deepEqual(data.projects.map(p=>p.odooId),[10,11,12]);assert.equal(data.allocation,true);
    // Archived in Odoo: not listed, and its record in Odoo is not touched.
    assert.equal(data.projects.some(p=>p.odooId===13),false);
    const a=by[10];
    assert.equal(a.allocatedHours,10);assert.equal(a.loggedHours,12.5);assert.equal(a.remainingHours,-2.5);assert.equal(a.status,'over');assert.equal(a.overHours,2.5);
    // Only the entry with no Odoo line yet is pending; the corrected one is already in the 12.5 hours.
    assert.equal(a.pendingHours,0.5);
    assert.equal(a.mapped,true);assert.deepEqual(a.links.projects.map(p=>p.name),['Acme / Branch A']);assert.deepEqual(a.links.epics,['AION-100']);
    assert.deepEqual(a.links.tickets,{count:3,byProject:{AION:2,INT:1},keys:['AION-1','AION-2','INT-3']});assert.equal(a.linkable,true);
    const b=by[11];
    assert.equal(b.allocatedHours,null);assert.equal(b.status,'not_set');assert.equal(b.remainingHours,null);assert.equal(b.loggedHours,0);assert.equal(b.pendingHours,1.5);
    assert.equal(b.createdAt,'2026-05-01T09:00:00.000Z');assert.equal(a.createdAt,'2026-03-01T09:00:00.000Z');
    assert.equal(b.mapped,false);assert.equal(b.linkable,true);
    const c=by[12];assert.equal(c.status,'near');assert.equal(c.company,'Holding');assert.equal(c.linkable,false);
  }finally{s.restore();}
});
// The dashboard shows the Odoo projects table only when /config lists the capability (a merge once left an older copy
// of the /config answer in front of it).
test('/config offers the Odoo projects table and project admin',async()=>{
  const s=await setup();
  try{const caps=(await (await s.call('/config')).json()).capabilities;for(const c of ['project-budget-v1','project-admin-v1'])assert.ok(caps.includes(c),c);}
  finally{s.restore();}
});

test('administrators set and clear the allocated hours on the Odoo project',async()=>{
  const s=await setup();
  try{
    assert.equal((await s.call('/clients/odoo-projects/allocation','PUT',{odooId:11,hours:40},user)).status,403);
    for(const hours of [-1,'abc',1.234])assert.equal((await s.call('/clients/odoo-projects/allocation','PUT',{odooId:11,hours})).status,400,String(hours));
    assert.equal((await s.call('/clients/odoo-projects/allocation','PUT',{odooId:99,hours:4})).status,404);
    const ok=await s.call('/clients/odoo-projects/allocation','PUT',{odooId:11,hours:40.5});assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{odooId:11,allocatedHours:40.5});
    assert.deepEqual(s.writes.at(-1),[[11],{allocated_hours:40.5}]);
    const list=await (await s.call('/clients/odoo-projects')).json();assert.equal(list.projects.find(p=>p.odooId===11).status,'on_track');
    // Clearing leaves the allocation unknown (null), which is not the same as zero.
    assert.equal((await s.call('/clients/odoo-projects/allocation','PUT',{odooId:11,hours:null})).status,200);assert.deepEqual(s.writes.at(-1),[[11],{allocated_hours:null}]);
    assert.equal((await (await s.call('/clients/odoo-projects')).json()).projects.find(p=>p.odooId===11).status,'not_set');
    // An explicit zero is saved as zero and shown as zero, not as not set.
    const zero=await s.call('/clients/odoo-projects/allocation','PUT',{odooId:11,hours:0});assert.equal(zero.status,200);assert.deepEqual(await zero.json(),{odooId:11,allocatedHours:0});
    assert.deepEqual(s.writes.at(-1),[[11],{allocated_hours:0}]);
    const zeroRow=(await (await s.call('/clients/odoo-projects')).json()).projects.find(p=>p.odooId===11);assert.equal(zeroRow.allocatedHours,0);assert.equal(zeroRow.status,'on_track');
  }finally{s.restore();}
});
test('linking a dashboard project to an Odoo project, unlinking it, and the sync not linking it back',async()=>{
  const s=await setup();
  try{
    const link=(body,me)=>s.call('/clients/odoo-projects/link','POST',body,me);
    assert.equal((await link({revision:1,odooId:11,entryId:s.other.id},user)).status,403);
    assert.equal((await link({revision:0,odooId:11,entryId:s.other.id})).status,409);
    const otherCompany=await link({revision:1,odooId:12,entryId:s.other.id});assert.equal(otherCompany.status,400);assert.equal((await otherCompany.json()).code,'other_company');
    // A project already linked to another Odoo project must be unlinked there first.
    assert.equal((await link({revision:1,odooId:11,entryId:s.sub.id})).status,409);
    const ok=await link({revision:1,odooId:11,entryId:s.other.id});assert.equal(ok.status,200);
    assert.deepEqual((await readCatalog(s.env)).entries.find(e=>e.id===s.other.id).sources.filter(x=>x.source==='odoo').map(x=>x.row),[11]);
    const listed=await (await s.call('/clients/odoo-projects')).json();assert.equal(listed.projects.find(p=>p.odooId===11).mapped,true);
    const un=await link({revision:2,odooId:10,entryId:s.sub.id,unlink:true});assert.equal(un.status,200);
    const after=(await readCatalog(s.env)).entries.find(e=>e.id===s.sub.id);assert.deepEqual(after.sources.filter(x=>x.source==='odoo'),[]);assert.deepEqual(after.odooUnlinked,[10]);
    const again=await prepareImport(await readCatalog(s.env),[{customer:'Acme',displayName:'Branch A',sourceRow:10}],'odoo');
    assert.deepEqual(again.next.entries.find(e=>e.id===s.sub.id).sources.filter(x=>x.source==='odoo'),[]);
  }finally{s.restore();}
});
test('a new Odoo project takes its allocated hours: decimal, zero, or none when not known yet',async()=>{
  const s=await setup();
  const created=[],prev=globalThis.fetch;
  // The create call and the lookups around it; everything else is empty, as the catalog sync reads only what it finds.
  globalThis.fetch=async(u,init)=>{const p=JSON.parse(init.body).params;if(p.service!=='object')return prev(u,init);
    const [model,method,args]=[p.args[3],p.args[4],p.args[5]];
    if(model==='project.project'&&method==='create'){created.push(args[0]);return Response.json({result:100+created.length});}
    if(model==='project.project'&&method==='fields_get')return Response.json({result:args.length?{allocated_hours:{type:'float',readonly:false}}:{type_ids:{type:'one2many'},allow_timesheets:{type:'boolean'},privacy_visibility:{type:'selection'},allow_billable:{type:'boolean'}}});
    if(model==='res.users')return Response.json({result:[{id:6,company_ids:[1,9]}]});
    if(model==='res.company')return Response.json({result:[{id:1,name:'All in One'},{id:9,name:'Holding'}]});
    if(model==='res.partner'&&method==='search_read')return Response.json({result:[{id:1,name:'Acme'}]});
    if(model==='project.project'&&method==='search_read'&&JSON.stringify(args[0]).includes('type_ids'))return Response.json({result:[{id:10}]});
    if(model==='project.project'&&method==='read'&&args[0]?.[0]===10)return Response.json({result:[{id:10,type_ids:[1]}]});
    return Response.json({result:[]});};
  try{
    const catalog=await readCatalog(s.env),acme=catalog.entries.find(e=>e.name==='Acme'&&!e.parentId);
    const make=(allocatedHours,me=admin)=>s.call('/clients/odoo/project','POST',{name:'Job '+created.length,clientId:acme.id,...(allocatedHours===undefined?{}:{allocatedHours})},me);
    assert.equal((await make('12.5',user)).status,403);
    assert.equal((await make('-3')).status,400);assert.equal((await make('abc')).status,400);assert.equal(created.length,0);
    const decimal=await make('12.5');assert.equal(decimal.status,201);assert.equal(created.at(-1).allocated_hours,12.5);
    const none=await make('');assert.equal(none.status,201);assert.equal('allocated_hours' in created.at(-1),false);
    const zero=await make('0');assert.equal(zero.status,201);assert.equal(created.at(-1).allocated_hours,0);
  }finally{globalThis.fetch=prev;s.restore();}
});

test('each row counts the dashboard tickets on the project, those needing a review, and the last work date; allocation changes are kept in its history',async()=>{
  const s=await setup();
  try{
    // AION-1 and AION-2 are on Odoo project 10 (AION-2 completed); AION-9 is a legacy ticket with no Odoo project.
    for(const [key,m] of Object.entries({'AION-1':{odooProjectId:10},'AION-2':{odooProjectId:10,completedAt:'2026-10-01T00:00:00Z'},'AION-9':{clientId:s.sub.parentId}}))await s.env.STORE.set(metadataKey(s.env,key),JSON.stringify({revision:1,history:[],...m}));
    // An open pull request on AION-1 waiting for review, one on AION-2 (closed ticket: not counted), an approved one on AION-1.
    Object.assign(s.env,{GITHUB_TOKEN:'gh',GITHUB_REPOS:'org/app'});
    const pr=(id,keys,status={})=>({id,number:id,title:'PR '+id,url:'https://github.invalid/'+id,state:'open',keys,status,created:'2026-10-01T00:00:00Z'});
    await s.env.STORE.set('github:prs:v4',JSON.stringify({prs:{1:pr(1,['AION-1']),2:pr(2,['AION-2']),3:pr(3,['AION-1'],{reviews:[{state:'APPROVED',at:'2026-10-02T00:00:00Z'}]})},cursors:{},syncedAt:Date.now()}));
    const data=await (await s.call('/clients/odoo-projects')).json(),a=data.projects.find(p=>p.odooId===10),b=data.projects.find(p=>p.odooId===11);
    assert.equal(a.ticketCount,2);assert.equal(a.openTickets,1);assert.equal(a.reviewTickets,1);assert.deepEqual(a.reviewKeys,['AION-1']);
    assert.equal(a.lastWorkDate,'2026-10-20');assert.equal(a.usedPercent,125);assert.equal(a.client,'Acme');assert.equal(a.missingClient,false);
    assert.equal(b.ticketCount,0);assert.equal(b.lastWorkDate,null);assert.equal(b.usedPercent,null);assert.equal(b.missingClient,true);
    assert.equal(data.nearLimit,0.8);assert.equal(data.sync.odoo,true);
    // Allocation: each change is recorded with the value it replaced; saving the same value adds nothing.
    await s.call('/clients/odoo-projects/allocation','PUT',{odooId:10,hours:20});await s.call('/clients/odoo-projects/allocation','PUT',{odooId:10,hours:20});
    await s.call('/clients/odoo-projects/allocation','PUT',{odooId:10,hours:''});
    assert.equal((await s.call('/clients/odoo-projects/details?id=10','GET',undefined,user)).status,403);
    const d=await (await s.call('/clients/odoo-projects/details?id=10')).json();
    assert.deepEqual(d.history.map(h=>[h.type,h.from,h.to,h.by.email]),[['allocation',10,20,admin.email],['allocation',20,null,admin.email]]);
    assert.equal(d.project.status,'not_set');assert.equal(d.project.loggedHours,12.5);
    assert.deepEqual(d.tickets.map(t=>[t.key,t.open,t.prs.length]),[['AION-1',true,1],['AION-2',false,1]]);
    assert.deepEqual(d.reviews.map(t=>t.key),['AION-1']);
    assert.equal(d.workLogs.total,1);assert.deepEqual(d.workLogs.lines[0],{id:55,date:'2026-10-20',description:'Fixed the export',hours:2.5,person:'Dana',task:'[AION-1] One'});
    // An archived project can still be opened from a ticket.
    const archived=await (await s.call('/clients/odoo-projects/details?id=13')).json();assert.equal(archived.project?.archived,true,JSON.stringify(archived));
    assert.equal((await s.call('/clients/odoo-projects/details?id=99')).status,404);
  }finally{s.restore();}
});
