import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{makeToken} from '../proxy/src/handler.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';
import {prepareImport,catalogKey,readCatalog} from '../proxy/src/ticket-metadata.js';
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
  const projects=[{id:10,name:'Branch A',partner_id:[1,'Acme'],company_id:[1,'All in One'],allocated_hours:10},{id:11,name:'Odoo only',partner_id:false,company_id:false,allocated_hours:0},{id:12,name:'Holding job',partner_id:[2,'Holding'],company_id:[9,'Holding'],allocated_hours:5}];
  const writes=[],realFetch=globalThis.fetch;
  globalThis.fetch=async(u,init)=>{const p=JSON.parse(init.body).params;if(p.service==='common')return Response.json({result:7});
    const [model,method,args,kw]=[p.args[3],p.args[4],p.args[5],p.args[6]];
    if(model==='res.users')return Response.json({result:[{id:6,company_ids:[9,1]}]});
    if(model==='res.company')return Response.json({result:[{id:1,name:'All in One'},{id:9,name:'Holding'}]});
    if(model==='project.project'&&method==='fields_get')return Response.json({result:{allocated_hours:{type:'float',readonly:false}}});
    if(model==='project.project'&&method==='search_read'){assert.deepEqual(kw.context.allowed_company_ids,[9,1]);const d=args[0];return Response.json({result:d.length?projects.filter(x=>x.id===d[0][2]):projects.map(({allocated_hours,...x})=>x)});}
    if(model==='project.project'&&method==='read')return Response.json({result:projects.filter(x=>args[0].includes(x.id)).map(x=>({id:x.id,allocated_hours:x.allocated_hours}))});
    if(model==='project.project'&&method==='write'){writes.push(args);Object.assign(projects.find(x=>x.id===args[0][0]),args[1]);return Response.json({result:true});}
    if(model==='account.analytic.line'&&method==='read_group'){if(!readGroup)return Response.json({error:{message:'Odoo Server Error',data:{message:'read_group is removed'}}});return Response.json({result:[{project_id:[10,'Branch A'],unit_amount:12.5},{project_id:[12,'Holding job'],unit_amount:4.5}]});}
    if(model==='account.analytic.line'&&method==='formatted_read_group')return Response.json({result:[{project_id:[10,'Branch A'],'unit_amount:sum':12.5},{project_id:[12,'Holding job'],'unit_amount:sum':4.5}]});
    if(model==='project.task')return Response.json({result:[{name:'[AION-1] One',project_id:[10,'Branch A']},{name:'[AION-2] Two',project_id:[10,'Branch A']},{name:'[INT-3] Internal',project_id:[10,'Branch A']},{name:'Plain task',project_id:[11,'Odoo only']}]});
    return Response.json({result:[]});};
  const call=(path,method='GET',body,me=admin)=>worker.fetch(new Request('https://proxy.invalid'+path,{method,headers:{Authorization:'Bearer '+tokens[me.role],'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  return {env,call,sub,other,writes,projects,restore:()=>{globalThis.fetch=realFetch;}};
}
test('budget status: not set, on track, near the limit and over by the hours over',()=>{
  assert.deepEqual(budgetStatus(null,5),{status:'not_set',remainingHours:null,overHours:0});
  assert.deepEqual(budgetStatus(10,2),{status:'on_track',remainingHours:8,overHours:0});
  assert.deepEqual(budgetStatus(10,8),{status:'near',remainingHours:2,overHours:0});
  assert.deepEqual(budgetStatus(10,12.5),{status:'over',remainingHours:-2.5,overHours:2.5});
});
for(const readGroup of [true,false])test('every Odoo project is listed with its links and hours, each hour counted once'+(readGroup?'':' (Odoo 19 grouping)'),async()=>{
  const s=await setup({readGroup});
  try{
    assert.equal((await s.call('/clients/odoo-projects','GET',undefined,user)).status,403);
    const r=await s.call('/clients/odoo-projects');assert.equal(r.status,200);
    const data=await r.json(),by=Object.fromEntries(data.projects.map(p=>[p.odooId,p]));
    assert.deepEqual(data.projects.map(p=>p.odooId),[10,11,12]);assert.equal(data.allocation,true);
    const a=by[10];
    assert.equal(a.allocatedHours,10);assert.equal(a.loggedHours,12.5);assert.equal(a.remainingHours,-2.5);assert.equal(a.status,'over');assert.equal(a.overHours,2.5);
    // Only the entry with no Odoo line yet is pending; the corrected one is already in the 12.5 hours.
    assert.equal(a.pendingHours,0.5);
    assert.equal(a.mapped,true);assert.deepEqual(a.links.projects.map(p=>p.name),['Acme / Branch A']);assert.deepEqual(a.links.epics,['AION-100']);
    assert.deepEqual(a.links.tickets,{count:3,byProject:{AION:2,INT:1},keys:['AION-1','AION-2','INT-3']});assert.equal(a.linkable,true);
    const b=by[11];
    assert.equal(b.allocatedHours,null);assert.equal(b.status,'not_set');assert.equal(b.remainingHours,null);assert.equal(b.loggedHours,0);assert.equal(b.pendingHours,1.5);
    assert.equal(b.mapped,false);assert.equal(b.linkable,true);
    const c=by[12];assert.equal(c.status,'near');assert.equal(c.company,'Holding');assert.equal(c.linkable,false);
  }finally{s.restore();}
});
test('administrators set and clear the allocated hours on the Odoo project',async()=>{
  const s=await setup();
  try{
    assert.equal((await s.call('/clients/odoo-projects/allocation','PUT',{odooId:11,hours:40},user)).status,403);
    for(const hours of [-1,0,'abc',1.234])assert.equal((await s.call('/clients/odoo-projects/allocation','PUT',{odooId:11,hours})).status,400,String(hours));
    assert.equal((await s.call('/clients/odoo-projects/allocation','PUT',{odooId:99,hours:4})).status,404);
    const ok=await s.call('/clients/odoo-projects/allocation','PUT',{odooId:11,hours:40.5});assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{odooId:11,allocatedHours:40.5});
    assert.deepEqual(s.writes.at(-1),[[11],{allocated_hours:40.5}]);
    const list=await (await s.call('/clients/odoo-projects')).json();assert.equal(list.projects.find(p=>p.odooId===11).status,'on_track');
    assert.equal((await s.call('/clients/odoo-projects/allocation','PUT',{odooId:11,hours:null})).status,200);assert.deepEqual(s.writes.at(-1),[[11],{allocated_hours:0}]);
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
