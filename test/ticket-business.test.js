import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{makeToken} from '../proxy/src/handler.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';
import {readMetadata,readCatalog,prepareImport,catalogKey,metadataKey,publicHistory,publicMetadata,saveMetadata,withTicketLock,guardedTransition,closureErrors,INTERNAL_ASSIGNEE} from '../proxy/src/ticket-metadata.js';
import {buildReport,reportPeriod} from '../proxy/src/reports.js';
import {createReadTools} from '../proxy/src/ai.js';
const admin={email:'admin@example.invalid',name:'Manager',role:'admin',dev:'builder',v:1};
const user={email:'user@example.invalid',name:'Developer',role:'user',dev:'builder',v:1};
async function setup(){
 const env={SESSION_SECRET:'synthetic-secret',JIRA_PROJECT:'AION',JIRA_SITE:'https://jira.invalid',JIRA_EMAIL:'bot',JIRA_API_TOKEN:'secret',STORE:memoryStore(),TEAM_CONFIG:JSON.stringify({people:{lead:{id:'lead',name:'Lead'}}})};
 for(const me of [admin,user])await saveUser(env.STORE,me);
 const tokens=Object.fromEntries(await Promise.all([admin,user].map(async me=>[me.role,(await makeToken(env,me.email,Date.now(),1)).token])));
 const imported=await prepareImport({revision:0,entries:[]},[{customer:'Acme',displayName:'Branch A',sourceRow:2},{customer:'',displayName:'Standalone',sourceRow:3}]);
 await env.STORE.set(catalogKey(env),JSON.stringify({...imported.next,revision:1}));
 const cat=await readCatalog(env),client=cat.entries.find(e=>e.name==='Standalone'),parent=cat.entries.find(e=>e.name==='Acme'),sub=cat.entries.find(e=>e.name==='Branch A');
 const calls=[],state={closed:false,jiraFailure:false};
 globalThis.fetch=async(url,init={})=>{
  calls.push({url:String(url),method:init.method||'GET',body:typeof init.body==='string'?JSON.parse(init.body):init.body||null,headers:init.headers||{}});
  if((init.method||'GET')==='POST'){
   if(String(url).includes('/search/'))return Response.json({issues:[],isLast:true});
   if(state.jiraFailure)return Response.json({errorMessages:['Synthetic Jira failure']},{status:503});
   state.closed=true;return new Response(null,{status:204});
  }
  if(String(url).endsWith('/transitions'))return Response.json({transitions:[{id:'31',to:{name:'Resolved',statusCategory:{key:'done'}}},{id:'11',to:{name:'Open',statusCategory:{key:'new'}}}]});
  const key=new URL(url).pathname.split('/')[5];
  return Response.json({key,fields:{project:{key:'AION'},summary:'Synthetic task',labels:['ai1_builder'],status:{name:state.closed?'Closed':'Open',statusCategory:{key:state.closed?'done':'new'}},created:'2026-10-01T22:30:00Z',updated:'2026-10-15T10:00:00Z'}});
 };
 const call=(path,method='GET',body,me=user)=>worker.fetch(new Request('https://proxy.invalid'+path,{method,headers:{Authorization:'Bearer '+tokens[me.role],'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
 const create=async(me=user,extra={})=>{const r=await call('/internal','POST',{summary:'Task',devs:['builder'],metadata:{clientId:client.id,subClientId:null,...(me.role==='admin'?{billing:'billable'}:{})},...extra},me);assert.equal(r.status,201,JSON.stringify(await r.clone().json()));return (await r.json()).ticket;};
 const fields={revision:0,estimatedHours:1.25,actualHours:2.5,workDone:'Implemented and verified',clientId:client.id,subClientId:null};
 return {env,call,create,client,parent,sub,calls,state,fields,tokens};
}
test('catalog mapping preserves names, standalone clients, source rows and repeat imports',async()=>{
 const s=await setup(),cat=await readCatalog(s.env);assert.equal(cat.entries.length,3);assert.equal(s.sub.parentId,s.parent.id);assert.equal(s.client.parentId,null);
 const rows=[{customer:'Acme',displayName:'Branch A',sourceRow:2},{customer:'',displayName:'Standalone',sourceRow:3}];assert.equal((await prepareImport(cat,rows)).preview.added,0);
 await s.call('/clients','PUT',{revision:1,id:s.client.id,name:'Renamed'},admin);assert.equal((await prepareImport(await readCatalog(s.env),rows)).preview.added,0);
 const r=await s.call('/clients/import/preview','POST',{rows},admin);assert.equal(r.status,200);assert.equal((await readCatalog(s.env)).revision,2);
 assert.equal((await s.call('/clients','POST',{revision:2,name:'Forbidden'},user)).status,403);
});
test('invalid catalog import is all-or-nothing and revisions protect administrator changes',async()=>{
 const s=await setup();assert.equal((await s.call('/clients/import','POST',{revision:1,rows:[{displayName:'Okay'},{displayName:''}]},admin)).status,400);assert.equal((await readCatalog(s.env)).entries.length,3);
 assert.equal((await s.call('/clients','POST',{revision:0,name:'Stale'},admin)).status,409);
 await s.call('/clients','PUT',{revision:1,id:s.sub.id,archived:true},admin);assert.equal((await readCatalog(s.env)).entries.find(e=>e.id===s.sub.id).archived,true);
});
test('internal creation defaults to shared assignee, stores fields separately and scopes visibility',async()=>{
 const s=await setup(),ticket=await s.create();assert.equal(ticket.assignee,INTERNAL_ASSIGNEE);assert.deepEqual(ticket.devs,['builder']);assert.equal(ticket.clientId,undefined);
 const record=await readMetadata(s.env,ticket.key);assert.equal(record.clientId,s.client.id);
 await s.env.STORE.set('it:INT-99',JSON.stringify({...ticket,key:'INT-99',devs:['other']}));
 const list=await (await s.call('/internal')).json();assert.deepEqual(list.tickets.map(t=>t.key),[ticket.key]);assert.equal((await s.call('/ticket-metadata?key=INT-99')).status,404);
 const batch=await (await s.call('/ticket-metadata/batch','POST',{keys:[ticket.key,'INT-99']})).json();assert.deepEqual(Object.keys(batch.records),[ticket.key]);
 const noClient=await s.call('/internal','POST',{summary:'No client yet'},user);assert.equal(noClient.status,201);
 assert.equal((await readMetadata(s.env,(await noClient.json()).ticket.key)).clientId,null);
});
test('client selection requires an active client and locks administrator-only changes; any project can go with it',async()=>{
 const s=await setup();assert.equal((await s.call('/internal','POST',{summary:'Task',metadata:{clientId:s.parent.id}},user)).status,400);
 const t=await s.create(user,{metadata:{clientId:s.parent.id,subClientId:s.sub.id}});
 assert.equal((await s.call('/ticket-metadata','PUT',{key:t.key,fields:{revision:1,clientId:s.client.id,subClientId:null}},user)).status,403);
 assert.equal((await s.call('/ticket-metadata','PUT',{key:t.key,fields:{revision:1,clientId:s.client.id,subClientId:s.sub.id}},admin)).status,200);
});
test('billing never reaches user metadata, history or batch reads and forged writes fail',async()=>{
 const s=await setup(),t=await s.create(admin,{metadata:{clientId:s.client.id,billing:'billable'}});
 const r=await (await s.call('/ticket-metadata?key='+t.key)).json();assert.equal('billing'in r.metadata,false);assert.doesNotMatch(JSON.stringify(r.history),/billable|billing/);
 const batch=await (await s.call('/ticket-metadata/batch','POST',{keys:[t.key]})).json();assert.equal('billing'in batch.records[t.key],false);
 assert.equal((await s.call('/ticket-metadata','PUT',{key:t.key,fields:{revision:1,billing:'not_billable'}})).status,403);
 assert.equal((await s.call('/reports/run','POST',{workflow:'management'})).status,403);
});
test('positive decimal hours, text bounds and unknown fields are validated server-side',async()=>{
 const s=await setup(),t=await s.create();for(const invalid of [0,-1,1.001,1.0000000001,'2',Infinity]){const r=await s.call('/ticket-metadata','PUT',{key:t.key,fields:{revision:1,actualHours:invalid}});if(invalid===Infinity)assert.equal(r.status,200);else assert.equal(r.status,400);}
 // JSON represents Infinity as null; direct service calls reject non-finite numeric values.
 await assert.rejects(saveMetadata(s.env,t.key,{revision:2,actualHours:Infinity},user),/positive number/);
 for(const patch of [{workDone:'x'.repeat(5001)},{created:'2020-01-01'},{completedAt:'forged'}])assert.equal((await s.call('/ticket-metadata','PUT',{key:t.key,fields:{revision:2,...patch}})).status,400);
 assert.equal((await s.call('/ticket-metadata','PUT',{key:t.key,fields:{revision:2,actualHours:0.01,estimatedHours:1.25,workDone:'Done'}})).status,200);
});
test('users cannot close incomplete internal tickets; valid fields allow closing and lock both roles',async()=>{
 const s=await setup(),t=await s.create();assert.equal((await s.call('/internal/'+t.key,'PUT',{status:'Closed'})).status,400);
 assert.equal(JSON.parse(await s.env.STORE.get('it:'+t.key)).status,'Open');
 assert.equal((await s.call('/ticket-metadata','PUT',{key:t.key,fields:{revision:1,estimatedHours:1,actualHours:2,workDone:'Done'}})).status,200);
 assert.equal((await s.call('/internal/'+t.key,'PUT',{status:'Closed'})).status,200);
 const m=await readMetadata(s.env,t.key);assert.ok(m.completedAt);
 for(const me of [admin,user])assert.equal((await s.call('/ticket-metadata','PUT',{key:t.key,fields:{revision:m.revision,workDone:'Changed'}},me)).status,409);
 assert.equal((await s.call('/internal/'+t.key,'PUT',{status:'Open'},admin)).status,200);
 const fresh=await readMetadata(s.env,t.key);assert.equal(fresh.completedAt,null);assert.equal((await s.call('/ticket-metadata','PUT',{key:t.key,fields:{revision:fresh.revision,workDone:'Corrected'}})).status,200);
});
test('administrator override requires a reason and records successful closure requirements',async()=>{
 const s=await setup(),t=await s.create();assert.equal((await s.call('/internal/'+t.key,'PUT',{status:'Closed'},admin)).status,400);
 assert.equal((await s.call('/internal/'+t.key,'PUT',{status:'Closed',overrideReason:'Approved exception'},admin)).status,200);
 const m=await readMetadata(s.env,t.key),h=m.history.find(h=>h.type==='override');assert.equal(h.reason,'Approved exception');assert.equal(h.by.email,admin.email);assert.ok(h.missing.some(s=>s.includes('actual hours')));
 assert.equal(publicHistory(m,user).some(h=>h.type==='override'),false);
});
test('stale and concurrent metadata saves cannot overwrite successful edits',async()=>{
 const s=await setup(),t=await s.create(),body={key:t.key,fields:{revision:1,workDone:'One'}};
 const results=await Promise.all([s.call('/ticket-metadata','PUT',body),s.call('/ticket-metadata','PUT',body)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal((await s.call('/ticket-metadata','PUT',body)).status,409);
});
test('Jira closures inspect destination and never send business fields to Jira',async()=>{
 const s=await setup();assert.equal((await s.call('/jira/issue/AION-1/transitions','POST',{id:31})).status,400);assert.equal(s.calls.filter(c=>c.method==='POST').length,0);
 assert.equal((await s.call('/ticket-metadata','PUT',{key:'AION-1',fields:s.fields},admin)).status,200);
 assert.equal((await s.call('/jira/issue/AION-1/transitions','POST',{id:31})).status,200);
 const mutation=s.calls.find(c=>c.method==='POST');assert.deepEqual(mutation.body,{transition:{id:'31'}});
 assert.equal((await s.call('/ticket-metadata','PUT',{key:'AION-1',fields:{revision:2,workDone:'Changed'}},admin)).status,409);
 assert.equal((await s.call('/jira/issue/AION-1','PUT',{fields:{assignee:{accountId:INTERNAL_ASSIGNEE}}},admin)).status,400);
});
test('failed Jira transitions never record completion or successful overrides',async()=>{
 const s=await setup();s.state.jiraFailure=true;
 assert.equal((await s.call('/jira/issue/AION-1/transitions','POST',{id:31,overrideReason:'Exception'},admin)).status,502);
 const m=await readMetadata(s.env,'AION-1');assert.equal(m.completedAt,null);assert.equal(m.history.length,0);
});
test('externally closed Jira tickets lock fields and unavailable stores fail clearly',async()=>{
 const s=await setup();s.state.closed=true;assert.equal((await s.call('/ticket-metadata','PUT',{key:'AION-1',fields:s.fields},admin)).status,409);
 await assert.rejects(readMetadata({JIRA_PROJECT:'AION'},'AION-1'),/persistent database/);
 assert.equal((await s.call('/ticket-metadata?key=OTHER-1')).status,400);
});
test('reports reconcile ticket-total hours, partial coverage, missing dates and administrator access',async()=>{
 const s=await setup(),t=await s.create();await s.call('/ticket-metadata','PUT',{key:t.key,fields:{revision:1,estimatedHours:1,actualHours:2,workDone:'Done'}});
 const base=JSON.parse(await s.env.STORE.get('it:'+t.key)),deps={readSearch:async()=>({issues:[{key:'AION-1',fields:{summary:'Closed without date',status:{name:'Done',statusCategory:{key:'done'}},created:'2026-10-14T10:00:00Z',updated:'2026-10-15T10:00:00Z'}}],isLast:false}),readInternal:async()=>[{...base,title:base.summary,closed:false,cat:'new',created:'2026-10-14T10:00:00Z'}]};
 const r=await buildReport(s.env,admin,deps,{workflow:'management'},new Date('2026-10-15T10:00:00Z'));assert.equal(r.totals.open,1);assert.equal(r.totals.created,2);assert.equal(r.totals.completed,0);assert.equal(r.coverage.jiraComplete,false);assert.match(r.warnings.join(' '),/no verified completion date/);assert.equal(r.groups.reduce((n,g)=>n+(g.actualHours||0),0),2);assert.match(r.hoursLabel,/not hours worked/);
 assert.equal(r.tickets.find(x=>x.key===t.key).overEstimate.percent,100);await assert.rejects(buildReport(s.env,user,deps),/Only administrators/);
 assert.throws(()=>reportPeriod({start:'2026-02-30',end:'2026-10-15'}),/valid report period/);
});
test('AI internal reads filter unauthorized developers and omit user billing even from an unsafe adapter',async()=>{
 const internal=[{key:'INT-1',title:'Own',devs:['builder'],status:'Open'},{key:'INT-2',title:'Other',devs:['other'],status:'Open'}];
 const tools=createReadTools({me:user,project:'AION',readSearch:async()=>({issues:[],isLast:true}),readDashboard:async()=>internal,readBusiness:async key=>({...internal.find(t=>t.key===key),billing:'billable',workDone:'Done',actualHours:1})});
 const r=await tools.execute('search_internal_tickets',{text:'',status:'all'});assert.deepEqual(r.tickets.map(t=>t.key),['INT-1']);assert.doesNotMatch(JSON.stringify(r),/billable|billing|Other/);
 assert.equal((await tools.execute('read_issue',{key:'INT-2'})).error,'Ticket unavailable in your authorized scope.');await assert.rejects(tools.execute('run_dashboard_report',{workflow:'management',days:7}),/Only managers/);
 assert.ok(tools.references().some(r=>r.key==='INT-1'));
});

test('administrator AI reports retain computed totals, bounds, warnings and verified citations',async()=>{
 const tools=createReadTools({me:admin,project:'AION',readSearch:async()=>({issues:[],isLast:true}),runReport:async()=>({workflow:'hours',period:{start:'2026-10-09',end:'2026-10-15'},coverage:{jiraComplete:false},warnings:['Partial Jira coverage'],totals:{open:3},hoursLabel:'Current ticket totals',groups:[],tickets:[{key:'INT-1',title:'Task',actualHours:2,estimatedHours:1,billing:'billable',missing:[],risks:[],overEstimate:{hours:1,percent:100}}]})});
 const report=await tools.execute('run_dashboard_report',{workflow:'hours',days:7});assert.equal(report.totals.open,3);assert.equal(report.tickets[0].billing,'billable');assert.deepEqual(report.warnings,['Partial Jira coverage']);assert.equal(tools.references()[0].key,'INT-1');
});

test('with BILLING_REQUIRED on, administrator assignment requires explicit billing for Jira assignees, developer labels and internal tickets',async()=>{
 const s=await setup();s.env.BILLING_REQUIRED='true';const t=await s.create();
 for(const patch of [{assignee:'lead'},{devs:['builder','other']}]){const r=await s.call('/internal/'+t.key,'PUT',patch,admin);assert.equal(r.status,400);assert.equal((await r.json()).code,'billing_required');}
 for(const fields of [{assignee:{accountId:'lead'}},{labels:['ai1_builder','ai1_other']}]){const r=await s.call('/jira/issue/AION-1','PUT',{fields},admin);assert.equal(r.status,400);assert.equal((await r.json()).code,'billing_required');}
 assert.equal(s.calls.filter(c=>c.method==='PUT').length,0);
 assert.equal((await s.call('/internal','POST',{summary:'Missing billing',devs:['builder'],metadata:{clientId:s.client.id}},admin)).status,400);
 await s.call('/ticket-metadata','PUT',{key:t.key,fields:{revision:1,billing:'not_billable'}},admin);
 assert.equal((await s.call('/internal/'+t.key,'PUT',{assignee:'lead'},admin)).status,200);
 await s.call('/ticket-metadata','PUT',{key:'AION-1',fields:{revision:0,billing:'billable'}},admin);
 assert.equal((await s.call('/jira/issue/AION-1','PUT',{fields:{assignee:{accountId:'lead'}}},admin)).status,200);
});
test('user initial dates, submissions and revisions require a saved positive estimate',async()=>{
 const s=await setup(),t=await s.create(),body={key:t.key,proposedDate:'2026-11-01',reason:'Schedule the work'};
 const blocked=await s.call('/date-requests/initial','POST',body);assert.equal(blocked.status,400);assert.equal((await blocked.json()).code,'estimate_required');assert.equal(JSON.parse(await s.env.STORE.get('it:'+t.key)).due,null);
 await s.call('/ticket-metadata','PUT',{key:t.key,fields:{revision:1,estimatedHours:2}});
 assert.equal((await s.call('/date-requests/initial','POST',body)).status,200);
 const submitted=await s.call('/date-requests/submit','POST',{...body,proposedDate:'2026-11-02'});assert.equal(submitted.status,201);const request=(await submitted.json()).request;
 // Users can't change a set estimate; an administrator clears it.
 assert.equal((await s.call('/ticket-metadata','PUT',{key:t.key,fields:{revision:2,estimatedHours:null}})).status,403);
 await s.call('/ticket-metadata','PUT',{key:t.key,fields:{revision:2,estimatedHours:null}},admin);
 assert.equal((await s.call('/date-requests/revise','POST',{...body,id:request.id,version:request.version,proposedDate:'2026-11-03'})).status,400);
 assert.equal((await s.call('/date-requests/withdraw','POST',{key:t.key,id:request.id,version:request.version})).status,200);
 assert.equal((await s.call('/date-requests/submit','POST',{...body,proposedDate:'2026-11-04'})).status,400);
});

test('clients sync from Odoo: every contact is a client, each project a sub-client (Project) of its contact; only admins force it',async()=>{
 const {env,call:api}=await setup();
 // An earlier sync grouped contact-less projects under "No customer": renamed in place, keeping its projects.
 {const c=await readCatalog(env);c.entries.push({id:'nc',name:'No customer',parentId:null,archived:false,sources:[]},{id:'old',name:'Old tool',parentId:'nc',archived:false,sources:[]});await env.STORE.set(catalogKey(env),JSON.stringify(c));}const realFetch=globalThis.fetch;let odooCalls=0;
 Object.assign(env,{ODOO_URL:'https://odoo.invalid',ODOO_DB:'db',ODOO_LOGIN:'bot@example.invalid',ODOO_API_KEY:'k'});
 globalThis.fetch=async(u,init)=>{const p=JSON.parse(init.body).params;if(p.service==='common')return Response.json({result:7});odooCalls++;
  const [model,method]=[p.args[3],p.args[4]];
  if(model==='res.partner'&&method==='search_read'){assert.deepEqual(p.args[5],[[['parent_id','=',false],['user_ids','=',false]]]);return Response.json({result:[{id:1,display_name:'Acme'},{id:2,display_name:'Solo Customer'}]});}
  if(model==='res.partner'&&method==='read')return Response.json({result:[{id:5,commercial_partner_id:[1,'Acme']},{id:1,commercial_partner_id:[1,'Acme']}]});
  assert.equal(model,'project.project');assert.equal(method,'search_read');
  return Response.json({result:[{id:10,display_name:'Branch A',partner_id:[5,'Acme, John']},{id:11,display_name:'Branch B',partner_id:[1,'Acme']},{id:12,display_name:'In-house',partner_id:false}]});};
 try{
  const call=(me,q='')=>api('/clients/odoo-sync'+q,'POST',{},me);
  assert.equal((await call(user,'?force=1')).status,403);
  const r=await (await call(admin,'?force=1')).json();
  assert.equal(r.changed,true);assert.equal(r.customers,2);assert.equal(r.projects,3);
  const c=await readCatalog(env),top=n=>c.entries.find(e=>e.name===n&&!e.parentId),under=n=>c.entries.filter(e=>e.parentId===top(n).id).map(e=>e.name).sort();
  assert.deepEqual(under('Acme'),['Branch A','Branch B']); // a project of a person at Acme belongs to Acme
  assert.ok(top('Solo Customer'));assert.deepEqual(under('Solo Customer'),[]); // a customer without a project is still a client
  assert.deepEqual(under('No contact'),['In-house','Old tool']);assert.ok(!top('In-house'));assert.ok(!top('No customer'));assert.equal(top('No contact').id,'nc');
  assert.ok(top('Acme').sources.some(x=>x.source==='odoo-customer'&&x.row===1)); // the Odoo contact id is kept
  // A fresh catalog is not read from Odoo again on the automatic refresh, and nothing changes.
  const before=odooCalls,again=await (await call(user)).json();assert.equal(again.changed,false);assert.equal(odooCalls,before);
 }finally{globalThis.fetch=realFetch;}
});
test('administrators create a customer or a project in Odoo from the Clients page',async()=>{
 const {env,call:api}=await setup();const realFetch=globalThis.fetch;const created=[];
 Object.assign(env,{ODOO_URL:'https://odoo.invalid',ODOO_DB:'db',ODOO_LOGIN:'bot@example.invalid',ODOO_API_KEY:'k'});
 const customers=[{id:1,display_name:'Acme'}],projects=[];
 globalThis.fetch=async(u,init)=>{const p=JSON.parse(init.body).params;if(p.service==='common')return Response.json({result:7});
  const [model,method,args]=[p.args[3],p.args[4],p.args[5]];
  if(method==='create'){created.push({model,values:args[0]});const id=100+created.length;if(model==='res.partner')customers.push({id,display_name:args[0].name});else projects.push({id,display_name:args[0].name,partner_id:[args[0].partner_id,'x']});return Response.json({result:id});}
  if(model==='res.partner'&&method==='search_read')return Response.json({result:customers});
  if(model==='res.partner'&&method==='read')return Response.json({result:args[0].map(id=>({id,commercial_partner_id:[id,(customers.find(c=>c.id===id)||{}).display_name]}))});
  return Response.json({result:projects});};
 try{
  assert.equal((await api('/clients/odoo/customer','POST',{name:'New Shop'},user)).status,403);
  assert.equal((await api('/clients/odoo/customer','POST',{name:'New Shop',email:'not-an-email'},admin)).status,400);
  const c=await api('/clients/odoo/customer','POST',{name:'New Shop',email:'shop@example.invalid',phone:'050'},admin);assert.equal(c.status,201);
  assert.deepEqual(created[0],{model:'res.partner',values:{name:'New Shop',is_company:true,customer_rank:1,email:'shop@example.invalid',phone:'050'}});
  const shop=(await c.json()).catalog.entries.find(e=>e.name==='New Shop'&&!e.parentId);assert.ok(shop);
  const pr=await api('/clients/odoo/project','POST',{name:'Shop POS',clientId:shop.id},admin);assert.equal(pr.status,201);
  assert.deepEqual(created[1],{model:'project.project',values:{name:'Shop POS',partner_id:customers.find(x=>x.display_name==='New Shop').id}});
  assert.deepEqual((await pr.json()).catalog.entries.filter(e=>e.parentId===shop.id).map(e=>e.name),['Shop POS']);
  assert.equal((await api('/clients/odoo/project','POST',{name:'Orphan',clientId:'missing'},admin)).status,400);
 }finally{globalThis.fetch=realFetch;}
});
test('users set the estimate once; only administrators change it afterwards',async()=>{
 const {env}=await setup();const key='AION-77';
 let m=await saveMetadata(env,key,{revision:0,estimatedHours:3},user);assert.equal(m.estimatedHours,3);
 m=await saveMetadata(env,key,{revision:m.revision,estimatedHours:3,actualHours:1},user);assert.equal(m.actualHours,1);
 await assert.rejects(saveMetadata(env,key,{revision:m.revision,estimatedHours:5},user),e=>e.code==='estimate_locked'&&e.status===403);
 await assert.rejects(saveMetadata(env,key,{revision:m.revision,estimatedHours:null},user),e=>e.code==='estimate_locked');
 m=await saveMetadata(env,key,{revision:m.revision,estimatedHours:5},admin);assert.equal(m.estimatedHours,5);
});

test('billing is optional by default: administrators assign and create without it',async()=>{
 const s=await setup(),t=await s.create();
 assert.equal((await s.call('/internal/'+t.key,'PUT',{assignee:'lead'},admin)).status,200);
 assert.equal((await s.call('/internal','POST',{summary:'No billing yet',devs:['builder'],metadata:{clientId:s.client.id}},admin)).status,201);
 assert.equal((await s.call('/config','GET',undefined,admin).then(r=>r.json())).billingRequired,false);
});
test('local ticket history keeps the real person for each change (Jira only sees the proxy account)',async()=>{
 const s=await setup(),t=await s.create(admin);
 assert.equal((await s.call('/internal/'+t.key,'PUT',{status:'In Development'},user)).status,200);
 await s.call('/internal/'+t.key,'PUT',{assignee:'lead'},admin);
 const log=(await (await s.call('/ticket-log?key='+t.key)).json()).events;
 assert.deepEqual(log.map(e=>[e.action,e.by.name]),[['created','Manager'],['status','Developer'],['assignee','Manager']]);
 assert.deepEqual(log[1].changes.status,{from:'Open',to:'In Development'});
 // Jira status moves are logged with the signed-in person, not the Jira account.
 assert.equal((await s.call('/jira/issue/AION-5/transitions','POST',{id:'11'},admin)).status,200);
 const jiraLog=(await (await s.call('/ticket-log?key=AION-5','GET',undefined,admin)).json()).events;
 assert.equal(jiraLog.at(-1).by.name,'Manager');assert.equal(jiraLog.at(-1).changes.status.to,'Open');
 // Users can't read the history of tickets they're not on.
 await s.env.STORE.set('it:INT-77',JSON.stringify({key:'INT-77',summary:'Other',devs:['other'],status:'Open'}));
 assert.equal((await s.call('/ticket-log?key=INT-77')).status,404);
});
test('the client is optional for now: a ticket without one saves its fields and closes once hours and work are done',async()=>{
 const s=await setup(),r=await s.call('/internal','POST',{summary:'No client'},user);assert.equal(r.status,201);const key=(await r.json()).ticket.key;
 const save=await s.call('/ticket-metadata','PUT',{key,fields:{revision:1,estimatedHours:2,actualHours:1.5,workDone:'Done'}},user);assert.equal(save.status,200,await save.clone().text());
 assert.equal((await s.call('/internal/'+key,'PUT',{status:'Closed'},user)).status,200);
 assert.deepEqual(closureErrors(await readCatalog(s.env),{clientId:null,subClientId:null,estimatedHours:1,actualHours:1,workDone:'x'}),[]);
 // A chosen client must still be valid.
 assert.equal((await s.call('/ticket-metadata','PUT',{key:(await s.create(user)).key,fields:{revision:1,clientId:'missing-client'}},admin)).status,400);
});
test('administrators enter the Jira token expiry (Atlassian does not share it) and see it on the key check',async()=>{
 const s=await setup();
 assert.equal((await s.call('/integrations/expiry','POST',{id:'jira',date:'2099-01-31'},user)).status,403);
 assert.equal((await s.call('/integrations/expiry','POST',{id:'jira',date:'31/01/2099'},admin)).status,400);
 assert.equal((await s.call('/integrations/expiry','POST',{id:'jira',date:'2099-01-31'},admin)).status,200);
 const jira=(await (await s.call('/integrations','GET',undefined,admin)).json()).keys.find(k=>k.id==='jira');
 assert.equal(jira.status,'ok');assert.equal(jira.expiresAt.slice(0,10),'2099-01-31');assert.equal(jira.expirySource,'saved');
 assert.equal((await s.call('/integrations/expiry','POST',{id:'jira',date:''},admin)).status,200);
 assert.equal((await (await s.call('/integrations','GET',undefined,admin)).json()).keys.find(k=>k.id==='jira').expiresAt,null);
});
test('files added to a Jira ticket go to Jira as they are and the history names who added them',async()=>{
 const s=await setup();
 const upload=(bytes,me=user,name='report.pdf')=>worker.fetch(new Request('https://proxy.invalid/jira/issue/AION-5/attachments?name='+encodeURIComponent(name),{method:'POST',headers:{Authorization:'Bearer '+s.tokens[me.role],'Content-Type':'application/pdf'},body:bytes}),s.env);
 const pdf=new Uint8Array([37,80,68,70,45,49]);
 const r=await upload(pdf);assert.equal(r.status,201,await r.clone().text());
 const sent=s.calls.find(c=>c.method==='POST'&&c.url.endsWith('/rest/api/3/issue/AION-5/attachments'));
 assert.ok(sent.body instanceof FormData);assert.equal(sent.headers['X-Atlassian-Token'],'no-check');
 const file=sent.body.get('file');assert.equal(file.name,'report.pdf');assert.deepEqual(new Uint8Array(await file.arrayBuffer()),pdf); // the same bytes
 const log=(await (await s.call('/ticket-log?key=AION-5')).json()).events;assert.equal(log.at(-1).action,'attachment');assert.equal(log.at(-1).by.name,'Developer');
 assert.equal((await upload(new Uint8Array(0))).status,400);
 assert.equal((await upload(new Uint8Array(4*1024*1024+1))).status,413);
});

test('all report snapshot includes old closed tickets with one source scan and stays administrator-only',async()=>{
 const s=await setup();let searches=0,internalReads=0;const deps={readSearch:async()=>{searches++;return {issues:[{key:'AION-1',fields:{summary:'Old closed ticket',status:{name:'Done',statusCategory:{key:'done'}},created:'2025-01-01T12:00:00Z'}}],isLast:true};},readInternal:async()=>{internalReads++;return [];}};
 const all=await buildReport(s.env,admin,deps,{workflow:'all'},new Date('2026-10-15T12:00:00Z'));assert.equal(all.tickets.length,1);assert.equal(all.tickets[0].missing.length>0,true);assert.equal(searches,1);assert.equal(internalReads,1);assert.equal(all.totals.completed,0);await assert.rejects(buildReport(s.env,user,deps,{workflow:'all'}),/Only administrators/);assert.equal(searches,1);
 const viaRoute=await s.call('/reports/run','POST',{workflow:'all'},admin);assert.equal(viaRoute.status,200);assert.equal((await viaRoute.json()).workflow,'all');assert.equal((await s.call('/reports/run','POST',{workflow:'all'},user)).status,403);
});

test('saved report endpoints are authenticated and refuse ordinary users',async()=>{const s=await setup();assert.equal((await s.call('/reports/latest')).status,403);assert.equal((await s.call('/reports/refresh','POST',{},user)).status,403);const first=await s.call('/reports/latest','GET',undefined,admin);assert.equal(first.status,200);assert.equal((await first.json()).report.workflow,'all');const second=await s.call('/reports/latest','GET',undefined,admin);assert.equal((await second.json()).cached,true);assert.equal((await s.call('/reports/refresh','POST',{},admin)).status,200);});

test('Jira epics map to Odoo projects: tickets under a mapped epic take and follow its project, hand-picked clients stay',async()=>{
 const s=await setup(),realFetch=globalThis.fetch,parents={'AION-10':'AION-1','AION-11':'AION-1','AION-12':'AION-1'};
 globalThis.fetch=async(u,init={})=>{
  const body=typeof init.body==='string'?JSON.parse(init.body):null;
  if(String(u).includes('/search/jql')){
   if(/issuetype = Epic/.test(body.jql))return Response.json({issues:[{key:'AION-1',fields:{summary:'Website',status:{statusCategory:{key:'indeterminate'}}}},{key:'AION-2',fields:{summary:'Mobile',status:{statusCategory:{key:'new'}}}}],isLast:true});
   const epics=/parent in \(([^)]*)\)/.exec(body.jql)[1].split(',');
   return Response.json({issues:Object.entries(parents).filter(([,p])=>epics.includes(p)).map(([key,p])=>({key,fields:{parent:{key:p},status:{statusCategory:{key:key==='AION-12'?'done':'new'}}}})),isLast:true});
  }
  return realFetch(u,init);
 };
 try{
  await saveMetadata(s.env,'AION-11',{revision:0,clientId:s.client.id,subClientId:null},admin);
  assert.equal((await s.call('/epic-map','GET',undefined,user)).status,403);
  const listed=await (await s.call('/epic-map','GET',undefined,admin)).json();
  assert.deepEqual(listed.epics.map(e=>e.key),['AION-1','AION-2']);assert.deepEqual(listed.map,{});
  // A customer with projects under it isn't a project.
  assert.equal((await s.call('/epic-map','PUT',{revision:0,epicKey:'AION-1',entryId:s.parent.id},admin)).status,400);
  const saved=await (await s.call('/epic-map','PUT',{revision:0,epicKey:'AION-1',entryId:s.sub.id},admin)).json();
  assert.equal(saved.sync.changed,2);
  const m10=await readMetadata(s.env,'AION-10');assert.deepEqual([m10.clientId,m10.subClientId,m10.epicKey],[s.parent.id,s.sub.id,'AION-1']);
  assert.equal((await readMetadata(s.env,'AION-12')).subClientId,s.sub.id);
  assert.equal((await readMetadata(s.env,'AION-11')).clientId,s.client.id,'a hand-picked client is kept');
  assert.equal((await s.call('/epic-map','PUT',{revision:0,epicKey:'AION-2',entryId:s.client.id},admin)).status,409);
  // The ticket moves to another mapped epic and follows it.
  parents['AION-10']='AION-2';
  assert.equal((await s.call('/epic-map','PUT',{revision:1,epicKey:'AION-2',entryId:s.client.id},admin)).status,200);
  const moved=await readMetadata(s.env,'AION-10');assert.deepEqual([moved.clientId,moved.subClientId,moved.epicKey],[s.client.id,null,'AION-2']);
  // Choosing a client by hand stops following the epic.
  const manual=await saveMetadata(s.env,'AION-10',{revision:moved.revision,clientId:s.parent.id,subClientId:s.sub.id},admin);assert.equal(manual.epicKey,null);
  assert.equal((await (await s.call('/epic-map/sync?force=1','POST',{},admin)).json()).changed,0);
  assert.equal((await s.call('/epic-map/sync?force=1','POST',{},user)).status,403);
 }finally{globalThis.fetch=realFetch;}
});
test('client details come from Odoo (only fields it has); a name chosen in the dashboard is shown on tickets until cleared',async()=>{
 const s=await setup();const realFetch=globalThis.fetch;
 Object.assign(s.env,{ODOO_URL:'https://odoo.invalid',ODOO_DB:'db',ODOO_LOGIN:'bot@example.invalid',ODOO_API_KEY:'k',AI_PROVIDER:async()=>({output:[{type:'message',content:[{type:'output_text',text:'"Acme Retail."'}]}]})});
 const cat=await readCatalog(s.env),acme=cat.entries.find(e=>e.name==='Acme'&&!e.parentId),branch=cat.entries.find(e=>e.name==='Branch A');
 acme.sources=[{source:'odoo-customer',row:1}];branch.sources=[{source:'odoo',row:10}];await s.env.STORE.set(catalogKey(s.env),JSON.stringify(cat));
 globalThis.fetch=async(u,init)=>{const p=JSON.parse(init.body).params;if(p.service==='common')return Response.json({result:7});const [model,method,args]=[p.args[3],p.args[4],p.args[5]];
  if(method==='fields_get')return Response.json({result:model==='res.partner'?{name:{},email:{},phone:{},website:{},city:{},country_id:{},vat:{},category_id:{},child_ids:{},create_date:{}}:{name:{},user_id:{},write_date:{},task_count:{}}});
  if(model==='res.partner'&&method==='read'){assert.ok(!p.args[6].fields.includes('mobile'));return Response.json({result:[{id:1,name:'Acme Ltd',email:'info@acme.example',phone:'03-1',website:'acme.example',city:'Haifa',country_id:[1,'Israel'],vat:'51',category_id:[4],child_ids:[2,3],create_date:'2026-01-02 10:00:00'}]});}
  if(model==='res.partner.category')return Response.json({result:[{id:4,name:'VIP'}]});
  if(model==='project.project')return Response.json({result:[{id:10,name:'Branch A',user_id:[9,'Rami'],write_date:'2026-10-01 09:00:00',task_count:7}]});
  return Response.json({result:[]});};
 try{
  assert.equal((await s.call('/clients/details?id='+acme.id)).status,403); // users don't see the catalog details
  const d=await (await s.call('/clients/details?id='+acme.id,'GET',undefined,admin)).json();
  assert.equal(d.contact.email,'info@acme.example');assert.deepEqual(d.contact.tags,['VIP']);assert.equal(d.contact.people,2);assert.equal(d.contact.address,'Haifa, Israel');
  const p=d.projects.find(x=>x.name==='Branch A');assert.equal(p.odoo.manager,'Rami');assert.equal(p.odoo.tasks,7);
  // Chosen AI name: stored on the client and shown on tickets; clearing it shows the Odoo name again.
  const rev=(await readCatalog(s.env)).revision;
  assert.equal((await s.call('/clients','PUT',{revision:rev,id:acme.id,aiName:'Acme Retail'},admin)).status,200);
  const t=await s.create(admin,{metadata:{clientId:acme.id,subClientId:branch.id,billing:'billable'}});
  const meta=(await (await s.call('/ticket-metadata/batch','POST',{keys:[t.key]},admin)).json()).records[t.key];assert.equal(meta.clientName,'Acme Retail');
  assert.equal((await s.call('/clients','PUT',{revision:rev+1,id:acme.id,aiName:''},admin)).status,200);
  assert.equal((await readCatalog(s.env)).entries.find(e=>e.id===acme.id).aiName,undefined);
 }finally{globalThis.fetch=realFetch;}
});
test('AI suggests a ticket description from the ticket itself; replacing a Jira description is recorded with the real person',async()=>{
 const s=await setup();let seen=null;
 s.env.AI_PROVIDER=async body=>{seen=JSON.parse(body.input[0].content).data;return {output:[{type:'message',content:[{type:'output_text',text:'Goal:\n- Fix the labels'}]}]};};
 const t=await s.create(admin,{summary:'Fix card labels',description:'Labels are wrong',metadata:{clientId:null,subClientId:null,billing:'billable'}});
 const r=await (await s.call('/ai-describe','POST',{key:t.key})).json();assert.equal(r.suggestion,'Goal:\n- Fix the labels');
 assert.equal(seen.title,'Fix card labels');assert.equal(seen.description,'Labels are wrong');
 await s.env.STORE.set('it:INT-88',JSON.stringify({key:'INT-88',summary:'Other',devs:['other'],status:'Open'}));
 assert.equal((await s.call('/ai-describe','POST',{key:'INT-88'})).status,404); // not your ticket
 assert.equal((await s.call('/ai-describe','POST',{title:'  '})).status,400);
 assert.equal((await s.call('/ai-describe','POST',{title:'New report',description:'draft'})).status,200);assert.equal(seen.title,'New report');
 assert.equal((await s.call('/ai-describe','POST',{key:'AION-5'})).status,200);assert.equal(seen.title,'Synthetic task'); // a Jira ticket with your label
 const put=await s.call('/jira/issue/AION-5/description','PUT',{text:'Goal:\n- Fix the labels',source:'ai'});assert.equal(put.status,200);
 const sent=s.calls.find(c=>c.method==='PUT'&&c.url.endsWith('/rest/api/2/issue/AION-5'));assert.deepEqual(sent.body,{fields:{description:'Goal:\n- Fix the labels'}});
 const log=(await (await s.call('/ticket-log?key=AION-5')).json()).events;assert.equal(log.at(-1).by.name,'Developer');assert.equal(log.at(-1).text,'Description suggested by AI');
});
test('any project can be chosen for a ticket, also one listed under another client',async()=>{
 const s=await setup(),t=await s.create();
 const m=await (await s.call('/ticket-metadata?key='+t.key,'GET',undefined,{email:'admin@example.invalid',role:'admin'})).json();
 const r=await s.call('/ticket-metadata','PUT',{key:t.key,fields:{revision:m.metadata.revision,clientId:s.client.id,subClientId:s.sub.id}},{email:'admin@example.invalid',role:'admin'});
 assert.equal(r.status,200,JSON.stringify(await r.clone().json()));const saved=(await r.json()).metadata;
 assert.equal(saved.clientId,s.client.id);assert.equal(saved.subClientId,s.sub.id);assert.equal(saved.subClientName,'Branch A');
 const bad=await s.call('/ticket-metadata','PUT',{key:t.key,fields:{revision:saved.revision,subClientId:s.parent.id}},{email:'admin@example.invalid',role:'admin'});
 assert.equal(bad.status,400);
});
