// Each ticket selects an Odoo project and its client comes from that project: the project snapshot taken by the catalog
// sync, the rules for choosing a project, its history, and the Needs mapping view for tickets saved before the rule.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{makeToken} from '../proxy/src/handler.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';
import {readCatalog,metadataKey,readMetadata} from '../proxy/src/ticket-metadata.js';

const admin={email:'admin@example.invalid',name:'Manager',role:'admin',dev:'builder',v:1};
const user={email:'user@example.invalid',name:'Dana Developer',role:'user',dev:'builder',v:1};
// Odoo: Acme and Beta are companies; Bob is a person at Acme, Jane a person with no company. Two projects named
// "Website" are both Acme's (one through Bob), Shop is archived, and Personal and Internal tools have no client.
function fakeOdoo(){
  const o={down:false,projects:[
    {id:20,name:'Website',partner_id:[1,'Acme'],active:true,create_date:'2026-01-05 10:00:00'},
    {id:21,name:'Website',partner_id:[2,'Acme, Bob'],active:true,create_date:'2026-02-05 10:00:00'},
    {id:22,name:'Shop',partner_id:[4,'Beta'],active:false,create_date:'2026-03-05 10:00:00'},
    {id:23,name:'Personal',partner_id:[3,'Jane'],active:true,create_date:'2026-04-05 10:00:00'},
    {id:24,name:'Internal tools',partner_id:false,active:true,create_date:'2026-05-05 10:00:00'}]};
  const partners={1:{name:'Acme',is_company:true,commercial:1},2:{name:'Bob',is_company:false,commercial:1},3:{name:'Jane',is_company:false,commercial:3},4:{name:'Beta',is_company:true,commercial:4}};
  o.fetch=async(u,init)=>{const p=JSON.parse(init.body).params;if(p.service==='common')return Response.json({result:7});
    if(o.down)return Response.json({error:{message:'Odoo Server Error',data:{message:'Access denied'}}});
    const [model,method,args,kw={}]=[p.args[3],p.args[4],p.args[5],p.args[6]];
    if(model==='res.users')return Response.json({result:[{id:6,company_ids:[1]}]});
    if(model==='res.company')return Response.json({result:[{id:1,name:'All in One'}]});
    if(model==='res.partner'&&method==='search_read')return Response.json({result:[{id:1,display_name:'Acme'},{id:4,display_name:'Beta'}]});
    if(model==='res.partner'&&method==='read')return Response.json({result:args[0].map(id=>{const x=partners[id];
      if(kw.fields.includes('commercial_partner_id'))return {id,commercial_partner_id:[x.commercial,partners[x.commercial].name]};
      return {id,name:x.name,is_company:x.is_company,active:true,company_id:false};})});
    if(model==='project.project'&&method==='search_read')return Response.json({result:o.projects.filter(x=>kw.context?.active_test===false||x.active).map(x=>({...x,display_name:x.name}))});
    return Response.json({result:[]});};
  return o;
}
async function setup(){
  const env={SESSION_SECRET:'synthetic-secret',JIRA_PROJECT:'AION',JIRA_SITE:'https://jira.invalid',JIRA_EMAIL:'bot',JIRA_API_TOKEN:'secret',STORE:memoryStore(),
    ODOO_URL:'https://odoo.invalid',ODOO_DB:'db',ODOO_LOGIN:'bot@x',ODOO_API_KEY:'k',TEAM_CONFIG:JSON.stringify({devEmails:{builder:'builder@x'}})};
  for(const me of [admin,user])await saveUser(env.STORE,me);
  const tokens={};for(const me of [admin,user])tokens[me.email]=(await makeToken(env,me.email,Date.now(),1)).token;
  const odoo=fakeOdoo();
  globalThis.fetch=async(url,init={})=>String(url).startsWith('https://odoo.invalid')?odoo.fetch(url,init):Response.json({errorMessages:['no jira here']},{status:404});
  const call=async(path,method='GET',body,me=admin)=>{const r=await worker.fetch(new Request('https://proxy.invalid'+path,{method,headers:{Authorization:'Bearer '+tokens[me.email],'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()};};
  const sync=()=>call('/clients/odoo-sync?force=1','POST',{});
  const create=(metadata,me=admin)=>call('/internal','POST',{summary:'Fix the report',devs:['builder'],metadata:{...metadata,...(me.role==='admin'?{billing:'billable'}:{})}},me);
  const edit=async(key,fields,me=admin)=>{const m=await call('/ticket-metadata?key='+key,'GET',undefined,admin);return call('/ticket-metadata','PUT',{key,fields:{revision:m.data.metadata.revision,...fields}},me);};
  assert.equal((await sync()).status,200);
  return {env,call,sync,create,edit,odoo};
}

test('the sync keeps every Odoo project as "Client → Project": the client is the company, duplicates show their id, archived and client-less ones are flagged',async()=>{
  const s=await setup();
  const r=await s.call('/clients/odoo-projects/options','GET',undefined,user);assert.equal(r.status,200);
  const by=Object.fromEntries(r.data.projects.map(p=>[p.id,p]));
  assert.deepEqual(Object.keys(by).map(Number).sort(),[20,21,22,23,24]);
  // Same client and name: told apart by the Odoo id. A person at a company counts as that company.
  assert.equal(by[20].label,'Acme → Website (#20)');assert.equal(by[21].label,'Acme → Website (#21)');assert.equal(by[21].clientName,'Acme');
  assert.equal(by[22].archived,true);assert.equal(by[22].label,'Beta → Shop');
  // A person with no company, or no customer at all: no client.
  assert.equal(by[23].missingClient,true);assert.equal(by[23].label,'No client → Personal');assert.equal(by[24].missingClient,true);
  assert.equal(by[20].missingClient,false);assert.equal(by[20].archived,false);
});

test('a new ticket needs an active Odoo project with a client; the client comes from the project and is never chosen apart',async()=>{
  const s=await setup();
  const code=async m=>(await s.create(m)).data.code;
  assert.equal(await code({}),'project_required');
  assert.equal(await code({odooProjectId:23}),'project_no_client');
  assert.equal(await code({odooProjectId:22}),'project_archived');
  assert.equal(await code({odooProjectId:999}),'project_unknown');
  const cat=await readCatalog(s.env),acme=cat.entries.find(e=>e.name==='Acme'&&!e.parentId);
  assert.equal(await code({clientId:acme.id,odooProjectId:21}),'project_required');
  const r=await s.create({odooProjectId:21});assert.equal(r.status,201,JSON.stringify(r.data));
  const key=r.data.ticket.key,m=(await s.call('/ticket-metadata?key='+key)).data.metadata;
  assert.equal(m.odooProjectId,21);assert.equal(m.clientId,acme.id);assert.equal(m.clientName,'Acme');
  assert.deepEqual(m.odooProject,{id:21,name:'Website',clientName:'Acme',label:'Acme → Website (#21)',archived:false,missingClient:false,known:true});
  // Users create tickets the same way.
  assert.equal((await s.create({odooProjectId:20},user)).status,201);
});

test('changing the project is recorded in history; it cannot be cleared, and archived projects stay shown on their tickets',async()=>{
  const s=await setup();
  const key=(await s.create({odooProjectId:21})).data.ticket.key;
  const moved=await s.edit(key,{odooProjectId:20});assert.equal(moved.status,200,JSON.stringify(moved.data));
  const view=(await s.call('/ticket-metadata?key='+key)).data,last=view.history.at(-1);
  assert.deepEqual(last.project,{from:'Acme → Website (#21)',to:'Acme → Website (#20)'});assert.equal(last.note,undefined);assert.equal(view.workEntries,0);
  assert.equal((await s.edit(key,{odooProjectId:null})).data.code,'project_required');
  assert.equal((await s.edit(key,{odooProjectId:22})).data.code,'project_archived');
  // Archived in Odoo after the ticket got it: the ticket keeps it and shows it as archived.
  s.odoo.projects.find(p=>p.id===20).active=false;await s.sync();
  const after=(await s.call('/ticket-metadata?key='+key)).data.metadata;
  assert.equal(after.odooProjectId,20);assert.equal(after.odooProject.archived,true);assert.equal(after.clientName,'Acme');
  // Other fields can still be saved on it.
  assert.equal((await s.edit(key,{estimatedHours:3})).status,200);
});

// Legacy tickets: AION-501 on Website (linked to #20 and #21), AION-502 on Shop (#22), AION-503 with nothing, AION-504 on
// Shop with its work already in Internal tools (#24).
async function legacy(s){
  const cat=await readCatalog(s.env),find=(n,parent)=>cat.entries.find(e=>e.name===n&&(parent?e.parentId:!e.parentId));
  const acme=find('Acme'),beta=find('Beta'),website=find('Website',true),shop=find('Shop',true);
  const rows={'AION-501':{clientId:acme.id,subClientId:website.id},'AION-502':{clientId:beta.id,subClientId:shop.id,jiraLinks:['AION-9']},'AION-503':{},'AION-504':{clientId:beta.id,subClientId:shop.id}};
  for(const [key,m] of Object.entries(rows))await s.env.STORE.set(metadataKey(s.env,key),JSON.stringify({revision:3,history:[],...m}));
  await s.env.STORE.set('tw:AION:task:AION-504',JSON.stringify({taskId:8,projectId:24}));
  return {acme,beta,website,shop};
}
test('Needs mapping: only what the catalog already links is suggested, never an archived project; the rest is shown and left alone',async()=>{
  const s=await setup(),shopProject=s.odoo.projects.find(p=>p.id===22);
  shopProject.active=true;await s.sync();
  const {beta,website}=await legacy(s);
  // The two "Website" projects are one catalog project linked to both Odoo projects.
  assert.deepEqual(website.sources.filter(x=>x.source==='odoo').map(x=>x.row).sort(),[20,21]);
  assert.equal((await s.call('/clients/needs-mapping','GET',undefined,user)).status,403);
  assert.equal((await s.call('/clients/needs-mapping/apply','POST',{},user)).status,403);
  const plan=(await s.call('/clients/needs-mapping')).data,row=k=>plan.rows.find(r=>r.key===k);
  assert.equal(row('AION-501').kind,'ambiguous');assert.deepEqual(row('AION-501').candidates.map(c=>c.id).sort(),[20,21]);
  assert.equal(row('AION-502').kind,'ready');assert.equal(row('AION-502').odooProjectId,22);assert.equal(row('AION-502').revision,3);
  assert.equal(row('AION-503').kind,'missing');
  assert.equal(row('AION-504').kind,'conflict');assert.match(row('AION-504').message,/#24/);
  assert.deepEqual([plan.ready,plan.missing,plan.ambiguous,plan.conflict],[1,1,1,1]);
  // Archived in Odoo: no longer suggested.
  shopProject.active=false;await s.sync();
  const archived=(await s.call('/clients/needs-mapping')).data.rows.find(r=>r.key==='AION-502');
  assert.equal(archived.kind,'missing');assert.match(archived.message,/archived/);
  assert.equal((await s.call('/clients/needs-mapping/apply','POST',{})).data.applied,0);
  shopProject.active=true;await s.sync();
  // Applying to one ticket that isn't ready changes nothing; applying all saves only the ready one.
  assert.equal((await s.call('/clients/needs-mapping/apply','POST',{keys:['AION-503']})).data.applied,0);
  const applied=(await s.call('/clients/needs-mapping/apply','POST',{})).data;assert.equal(applied.applied,1);
  assert.deepEqual(applied.linked,[{key:'AION-502',odooProjectId:22,label:'Beta → Shop'}]);
  const m=await readMetadata(s.env,'AION-502');
  assert.equal(m.odooProjectId,22);assert.equal(m.clientId,beta.id);assert.deepEqual(m.jiraLinks,['AION-9']);
  assert.equal(m.history.at(-1).project.to,'Beta → Shop');assert.equal(m.history.at(-1).note,'Linked to the Odoo project its project already had.');
  for(const k of ['AION-501','AION-503','AION-504'])assert.equal((await readMetadata(s.env,k)).odooProjectId,null,k);
  assert.equal(applied.plan.rows.some(r=>r.key==='AION-502'),false);assert.equal(applied.plan.mapped,1);
});

test('Map tickets: a chosen project gives the client; stale, archived, client-less and conflicting tickets are skipped with the reason',async()=>{
  // Shop was active when the legacy tickets got it, and has been archived in Odoo since.
  const s=await setup(),shopProject=s.odoo.projects.find(p=>p.id===22);shopProject.active=true;await s.sync();shopProject.active=false;await s.sync();
  const {acme}=await legacy(s);
  const apply=items=>s.call('/clients/needs-mapping/apply','POST',{items});
  assert.equal((await s.call('/clients/needs-mapping/apply','POST',{items:[{key:'AION-501',odooProjectId:20}]},user)).status,403);
  assert.equal((await apply([{key:'AION-501',revision:'3'}])).status,400);
  const r=(await apply([
    {key:'AION-501',revision:3,odooProjectId:20},   // ambiguous: the admin chose one
    {key:'AION-503',revision:2,odooProjectId:20},   // changed since the list was read
    {key:'AION-502',revision:3,odooProjectId:22},   // archived
    {key:'AION-503',revision:3,odooProjectId:23},   // no client
    {key:'AION-504',revision:3,odooProjectId:20},   // its work went elsewhere: not without resolving
    {key:'AION-502',revision:3}])).data;            // no suggestion (Shop is archived)
  assert.equal(r.applied,1);assert.deepEqual(r.linked.map(x=>x.key),['AION-501']);
  const why=Object.fromEntries(r.skipped.map(x=>[x.key+':'+r.skipped.filter(y=>y.key===x.key).indexOf(x),x.message]));
  assert.match(why['AION-503:0'],/Changed since the list was opened/);assert.match(why['AION-502:0'],/archived/);
  assert.match(why['AION-503:1'],/no client/);assert.match(why['AION-504:0'],/work went to another Odoo project/);assert.match(why['AION-502:1'],/Not ready/);
  const m=await readMetadata(s.env,'AION-501');
  assert.equal(m.odooProjectId,20);assert.equal(m.clientId,acme.id);assert.equal(m.revision,4);
  assert.equal(m.history.at(-1).note,'Chosen in Map tickets.');assert.equal(m.history.at(-1).by.email,admin.email);assert.deepEqual(m.history.at(-1).changes.odooProjectId,{from:null,to:20});
  // A conflict is resolved ticket by ticket, on request; its work stays where it went.
  const done=(await apply([{key:'AION-504',revision:3,odooProjectId:20,resolveConflict:true}])).data;assert.equal(done.applied,1);
  const c=await readMetadata(s.env,'AION-504');assert.equal(c.odooProjectId,20);assert.match(c.history.at(-1).note,/Work already logged stays where it went/);
  assert.deepEqual(JSON.parse(await s.env.STORE.get('tw:AION:task:AION-504')),{taskId:8,projectId:24});
  // Already mapped: skipped, not replaced.
  const again=(await apply([{key:'AION-501',revision:4,odooProjectId:21}])).data;
  assert.equal(again.applied,0);assert.match(again.skipped[0].message,/already has an Odoo project/);assert.equal((await readMetadata(s.env,'AION-501')).odooProjectId,20);
});

test('a failing sync is kept with its reason for the Clients page until a sync works',async()=>{
  const s=await setup();
  const ok=(await s.call('/clients/odoo-sync','GET',undefined,user)).data;assert.equal(ok.error,null);assert.ok(ok.syncedAt);assert.ok(ok.projectsSyncedAt);
  s.odoo.down=true;assert.notEqual((await s.sync()).status,200);
  const failed=(await s.call('/clients/odoo-sync')).data;assert.match(failed.error.message,/Access denied/);assert.equal(failed.syncedAt,ok.syncedAt);
  s.odoo.down=false;assert.equal((await s.sync()).status,200);assert.equal((await s.call('/clients/odoo-sync')).data.error,null);
});
