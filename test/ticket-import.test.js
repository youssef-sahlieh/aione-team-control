import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{makeToken} from '../proxy/src/handler.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';
import {bulkImportPreview,bulkImportApply,agreedImportPreview,agreedImportApply,readMetadata,catalogKey,metadataKey,saveMetadata,INTERNAL_ASSIGNEE} from '../proxy/src/ticket-metadata.js';
const admin={email:'admin@example.invalid',name:'Manager',role:'admin',dev:'builder',v:1};
const user={email:'user@example.invalid',name:'Developer',role:'user',dev:'builder',v:1};
const baseEnv=()=>({SESSION_SECRET:'synthetic-secret',JIRA_PROJECT:'AION',JIRA_SITE:'https://jira.invalid',JIRA_EMAIL:'bot',JIRA_API_TOKEN:'secret',STORE:memoryStore(),TEAM_CONFIG:JSON.stringify({people:{lead:{id:'lead',name:'Lead'}}})});
const entry=(id,name,parentId=null,extra={})=>({id,name,parentId,archived:false,sources:[],...extra});
async function fixture(){
 const env=baseEnv();
 await env.STORE.set(catalogKey(env),JSON.stringify({revision:1,entries:[
  entry('c_acme','Acme'),entry('c_beta','Beta'),entry('c_gamma','Gamma'),entry('c_old','Old',null,{archived:true}),
  entry('p_acme_web','Website','c_acme'),entry('p_acme_shop','Shop','c_acme',{aiName:'Webshop'}),entry('p_acme_app','App','c_acme'),
  entry('p_acme_retired','Retired','c_acme',{archived:true}),entry('p_beta_web','Website','c_beta'),entry('p_old_app','App','c_old')
 ]}));
 const dev=['builder'],tickets={'INT-1':{title:'One',closed:false,assignee:'lead',devs:dev},'INT-2':{title:'Two',closed:true,assignee:'lead',devs:dev},'INT-3':{title:'Three',closed:false,assignee:INTERNAL_ASSIGNEE,devs:[]},'INT-4':{title:'Four',closed:false,assignee:'lead',devs:dev},'INT-5':{title:'Five',closed:false,assignee:'lead',devs:dev},'INT-6':{title:'Six',closed:false,assignee:'lead',devs:['builder','other']},'INT-7':{title:'Seven',closed:false,assignee:'lead',devs:[]}};
 const readTicket=async key=>tickets[key]?{key,...tickets[key]}:null;
 await saveMetadata(env,'INT-1',{revision:0,clientId:'c_acme',subClientId:'p_acme_web',billing:'billable',agreedHours:10},admin,{ticket:tickets['INT-1']});
 return {env,readTicket};
}
async function routes(){
 const env=baseEnv();
 for(const me of [admin,user])await saveUser(env.STORE,me);
 const tokens=Object.fromEntries(await Promise.all([admin,user].map(async me=>[me.role,(await makeToken(env,me.email,Date.now(),1)).token])));
 await env.STORE.set('it:INT-1',JSON.stringify({summary:'One',status:'Open',devs:['builder'],assignee:'lead'}));
 const call=(path,method='GET',body,me=admin)=>worker.fetch(new Request('https://proxy.invalid'+path,{method,headers:{Authorization:'Bearer '+tokens[me.role],'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
 return {env,call};
}
test('bulk import routes: administrators only, POST only, size and row limits; old agreed-hours route unchanged',async()=>{
 const s=await routes(),body={rows:[{key:'INT-1',agreedHours:5}]};
 assert.equal((await s.call('/ticket-metadata/import/preview','POST',body,user)).status,403);
 assert.equal((await s.call('/ticket-metadata/import','POST',body,user)).status,403);
 assert.equal((await s.call('/ticket-metadata/import/preview','GET',undefined,admin)).status,405);
 assert.equal((await s.call('/ticket-metadata/import','GET',undefined,admin)).status,405);
 assert.equal((await s.call('/ticket-metadata/import','POST',{rows:[{key:'INT-1',client:'x'.repeat(400000)}]},admin)).status,413);
 assert.equal((await s.call('/ticket-metadata/import/preview','POST',{rows:Array.from({length:301},()=>({key:'INT-1'}))},admin)).status,400);
 assert.equal((await s.call('/ticket-metadata/import/preview','POST',{rows:[]},admin)).status,400);
 const many=await s.call('/ticket-metadata/import/preview','POST',{rows:Array.from({length:300},()=>({key:'INT-1'}))},admin);
 assert.equal(many.status,200);assert.equal((await many.json()).errors,299);
 // A preview writes nothing; the apply route saves through the same rules.
 const preview=await s.call('/ticket-metadata/import/preview','POST',body,admin);assert.equal((await preview.json()).ok,1);
 assert.equal((await readMetadata(s.env,'INT-1')).agreedHours,null);
 const applied=await s.call('/ticket-metadata/import','POST',body,admin);assert.equal(applied.status,200);assert.deepEqual(await applied.json(),{applied:1,unchanged:0,failed:[]});
 assert.equal((await readMetadata(s.env,'INT-1')).agreedHours,5);
 const old=await s.call('/agreed-hours/import/preview','POST',{rows:[{key:'INT-1',agreedHours:6}]},admin);assert.equal(old.status,200);assert.equal((await old.json()).ok,1);
});
test('bulk import rows: keys, duplicates, closed and unknown tickets are row errors and a preview writes nothing',async()=>{
 const f=await fixture(),before=await f.env.STORE.get(metadataKey(f.env,'INT-1'));
 const p=await bulkImportPreview(f.env,[
  {line:2,key:' int-1 ',agreedHours:'12.5'},
  {key:'bogus',agreedHours:2},
  {key:'INT-9',agreedHours:2},
  {key:'INT-1',agreedHours:3},
  {key:'INT-2',agreedHours:1},
  {key:'AION-1',agreedHours:1}
 ],f.readTicket);
 assert.deepEqual(p.rows.map(r=>r.status),['ok','error','error','error','error','error']);
 assert.deepEqual(Object.keys(p.rows[0]).sort(),['changes','key','line','message','row','status','title']);
 assert.equal(p.rows[0].line,2);assert.equal(p.rows[0].key,'INT-1');assert.equal(p.rows[0].row,1);
 assert.equal(p.rows[1].message,'Unknown ticket key.');
 assert.equal(p.rows[2].message,'Ticket not found or not visible.');
 assert.equal(p.rows[3].message,'Listed more than once.');
 assert.match(p.rows[4].message,/closed/);
 assert.equal(p.rows[5].message,'Ticket not found or not visible.');
 assert.deepEqual([p.ok,p.unchanged,p.errors],[1,0,5]);
 assert.equal(await f.env.STORE.get(metadataKey(f.env,'INT-1')),before);
});
test('bulk import fields: agreed hours, billing, developer rule; blank cells never clear anything',async()=>{
 const f=await fixture(),one=async row=>(await bulkImportPreview(f.env,[row],f.readTicket)).rows[0];
 assert.equal((await one({key:'INT-1',agreedHours:'',billing:' ',client:'',project:''})).status,'unchanged');
 assert.equal((await one({key:'INT-1',agreedHours:'10'})).status,'unchanged');
 assert.equal((await one({key:'INT-1',agreedHours:10})).message,'No change. Blank cells are left unchanged.');
 assert.match((await one({key:'INT-3',agreedHours:4})).message,/^Add a developer to this ticket first/);
 for(const agreedHours of ['abc',0,-1,1.234,true])assert.match((await one({key:'INT-4',agreedHours})).message,/positive number/);
 assert.match((await one({key:'INT-4',billing:'yes'})).message,/Billing must be Billable or Not billable/);
 assert.match((await one({key:'INT-4',billing:'Free'})).message,/Billing must be Billable or Not billable/);
 assert.match((await one({key:'INT-4',client:{}})).message,/must be text/);
 for(const billing of ['Not billable',' not_billable ','non billable','NON-BILLABLE']){const r=await one({key:'INT-1',billing});assert.equal(r.status,'ok');assert.deepEqual(r.changes,[{field:'billing',from:'Billable',to:'Not billable'}]);}
 assert.deepEqual(await one({key:'INT-4',billing:'BILLABLE',agreedHours:12.5}),{row:1,line:null,key:'INT-4',title:'Four',status:'ok',message:'Will change 2 fields. Blank cells are left unchanged.',changes:[{field:'agreedHours',from:null,to:12.5},{field:'billing',from:null,to:'Billable'}]});
 assert.equal((await one({key:'INT-1',agreedHours:12.5})).changes[0].to,12.5);
});
test('bulk import client and project: names, archived entries, ambiguity and the project cleared with the client',async()=>{
 const f=await fixture(),one=async row=>(await bulkImportPreview(f.env,[row],f.readTicket)).rows[0];
 assert.deepEqual((await one({key:'INT-1',client:' acme ',project:'webshop'})).changes,[{field:'project',from:'Website',to:'Webshop'}]);
 assert.equal((await one({key:'INT-1',client:'Acme'})).status,'unchanged');
 const gamma=await one({key:'INT-1',client:'gamma'});
 assert.equal(gamma.status,'ok');assert.deepEqual(gamma.changes,[{field:'client',from:'Acme',to:'Gamma'},{field:'project',from:'Website',to:null}]);
 assert.match(gamma.message,/Changing the client clears the project/);
 assert.equal((await one({key:'INT-1',client:'Beta'})).message,'Choose a project.');
 assert.equal((await one({key:'INT-1',client:'Old'})).message,'Unknown client.');
 assert.equal((await one({key:'INT-1',client:'Acme',project:'Retired'})).message,'Unknown project for this client.');
 assert.equal((await one({key:'INT-1',client:'Beta',project:'App'})).message,'Unknown project for this client.');
 assert.equal((await one({key:'INT-1',project:'Website'})).status,'unchanged');
 assert.equal((await one({key:'INT-1',project:'Nope'})).message,'Unknown project for this client.');
 const app=await one({key:'INT-4',project:'App'});
 assert.equal(app.status,'ok');assert.deepEqual(app.changes,[{field:'client',from:null,to:'Acme'},{field:'project',from:null,to:'App'}]);
 assert.equal((await one({key:'INT-4',project:'Website'})).message,'Several projects have this name. Fill in the Client column too.');
 assert.equal((await one({key:'INT-4',project:'Nope'})).message,'Unknown project.');
 assert.equal((await one({key:'INT-4',client:'Beta',project:'Website'})).status,'ok');
});
test('bulk import apply refuses the whole file while a row is an error and rewrites nothing',async()=>{
 const f=await fixture(),before=await f.env.STORE.get(metadataKey(f.env,'INT-1'));
 await assert.rejects(bulkImportApply(f.env,admin,[{key:'INT-1',agreedHours:12},{key:'INT-2',agreedHours:1}],f.readTicket),e=>e.code==='import_errors'&&e.details.rows.length===2);
 assert.equal(await f.env.STORE.get(metadataKey(f.env,'INT-1')),before);
 assert.deepEqual(await bulkImportApply(f.env,admin,[{key:'INT-1',agreedHours:10,billing:'Billable'}],f.readTicket),{applied:0,unchanged:1,failed:[]});
 assert.equal(await f.env.STORE.get(metadataKey(f.env,'INT-1')),before);
});
test('bulk import apply saves mixed changes, reports a concurrent edit as failed and records the history',async()=>{
 const f=await fixture();
 // INT-5 is read once for the plan and again inside its save lock; the second read is preceded by an edit elsewhere.
 let reads=0;
 const readTicket=async key=>{if(key==='INT-5'&&++reads===2)await saveMetadata(f.env,'INT-5',{revision:0,workDone:'Edited elsewhere'},admin,{ticket:{title:'Five',assignee:'lead'}});return f.readTicket(key);};
 const result=await bulkImportApply(f.env,admin,[
  {key:'INT-1',agreedHours:12.5,billing:'Not billable'},
  {key:'INT-4',client:'Beta',project:'Website'},
  {key:'INT-5',agreedHours:7}
 ],readTicket);
 assert.deepEqual(result,{applied:2,unchanged:0,failed:[{key:'INT-5',message:'Ticket fields changed. Refresh and retry.'}]});
 const one=await readMetadata(f.env,'INT-1');assert.equal(one.agreedHours,12.5);assert.equal(one.billing,'not_billable');assert.equal(one.revision,2);
 const four=await readMetadata(f.env,'INT-4');assert.equal(four.clientId,'c_beta');assert.equal(four.subClientId,'p_beta_web');
 const five=await readMetadata(f.env,'INT-5');assert.equal(five.agreedHours,null);assert.equal(five.workDone,'Edited elsewhere');
 const h=one.history.at(-1);assert.equal(h.type,'edit');assert.equal(h.by.email,admin.email);
 assert.deepEqual(h.changes.agreedHours,{from:10,to:12.5});assert.deepEqual(h.changes.billing,{from:'billable',to:'not_billable'});
});
test('bulk import and the agreed-hours import keep their own rules side by side',async()=>{
 const f=await fixture();
 const agreed=await agreedImportPreview(f.env,[{key:'INT-4',agreedHours:'3'}],f.readTicket);assert.equal(agreed.ok,1);
 const bulk=await bulkImportPreview(f.env,[{key:'INT-4',agreedHours:''}],f.readTicket);assert.equal(bulk.rows[0].status,'unchanged');
});
test('bulk import agreed hours: text must be a plain decimal with up to two places',async()=>{
 const f=await fixture(),one=async row=>(await bulkImportPreview(f.env,[row],f.readTicket)).rows[0];
 for(const agreedHours of ['1e3','0x10','+5','.5','1,5','12.345','-3','0','Infinity'])assert.match((await one({key:'INT-4',agreedHours})).message,/positive number/,agreedHours);
 assert.equal((await one({key:'INT-4',agreedHours:' 12.5 '})).changes[0].to,12.5);
 assert.equal((await one({key:'INT-4',agreedHours:'7'})).changes[0].to,7);
});
test('bulk import project only: a ticket with a client takes projects of that client only',async()=>{
 const f=await fixture(),catalog=JSON.parse(await f.env.STORE.get(catalogKey(f.env)));
 catalog.entries.push(entry('p_beta_solo','Solo','c_beta'));await f.env.STORE.set(catalogKey(f.env),JSON.stringify(catalog));
 const one=async row=>(await bulkImportPreview(f.env,[row],f.readTicket)).rows[0];
 assert.equal((await one({key:'INT-1',project:'Solo'})).message,'Unknown project for this client.');
 assert.equal((await one({key:'INT-4',project:'Solo'})).status,'ok');
});
test('bulk import apply: an unexpected error on one row is reported as failed and the other rows still save',async()=>{
 const f=await fixture();let reads=0;
 // INT-4 is read once for the plan and again inside its save lock; the second read fails.
 const readTicket=async key=>{if(key==='INT-4'&&++reads===2)throw new Error('store unavailable: internal detail');return f.readTicket(key);};
 const result=await bulkImportApply(f.env,admin,[{key:'INT-1',agreedHours:12.5},{key:'INT-4',agreedHours:3}],readTicket);
 assert.deepEqual(result,{applied:1,unchanged:0,failed:[{key:'INT-4',message:'Could not save this ticket.'}]});
 assert.equal((await readMetadata(f.env,'INT-1')).agreedHours,12.5);assert.equal((await readMetadata(f.env,'INT-4')).agreedHours,null);
});
test('bulk import apply: a busy Odoo agreed line is reported as failed with the note that the fields were saved',async()=>{
 const f=await fixture(),store=f.env.STORE,setIfAbsent=store.setIfAbsent.bind(store);
 // Another request holds the agreed line's lock, so the line cannot be sent right now.
 store.setIfAbsent=async(k,v,ttl)=>k.includes('lock:e:agreed:INT-4')?false:setIfAbsent(k,v,ttl);
 const result=await bulkImportApply(f.env,admin,[{key:'INT-1',agreedHours:12.5},{key:'INT-4',agreedHours:3}],f.readTicket);
 assert.deepEqual(result,{applied:1,unchanged:0,failed:[{key:'INT-4',message:'Saved, but the Odoo line was busy. Ask an administrator to re-send the agreed hours for this ticket.'}]});
 assert.equal((await readMetadata(f.env,'INT-4')).agreedHours,3);
});
test('agreed hours from either import: the same developer rule as the ticket drawer; unchanged hours need no developer',async()=>{
 const f=await fixture(),bulk=async row=>(await bulkImportPreview(f.env,[row],f.readTicket)).rows[0],agreed=async row=>(await agreedImportPreview(f.env,[row],f.readTicket)).rows[0];
 // Several developers and no choice yet: refused in both imports, never given to one of them by chance.
 for(const row of [await bulk({key:'INT-6',agreedHours:3}),await agreed({key:'INT-6',agreedHours:3})]){assert.equal(row.status,'error');assert.equal(row.message,'This ticket has several developers. Choose who the agreed hours go to on the ticket.');}
 // No developer: refused in both, whoever the assignee is.
 for(const row of [await bulk({key:'INT-7',agreedHours:3}),await agreed({key:'INT-7',agreedHours:3})])assert.match(row.message,/^Add a developer to this ticket first/);
 // A choice made on the ticket is kept when the hours change from a file.
 await saveMetadata(f.env,'INT-6',{revision:0,agreedHours:2,agreedDev:'other'},admin,{ticket:{title:'Six',devs:['builder','other']}});
 assert.equal((await bulk({key:'INT-6',agreedHours:3})).status,'ok');assert.equal((await agreed({key:'INT-6',agreedHours:3})).status,'ok');
 assert.deepEqual(await bulkImportApply(f.env,admin,[{key:'INT-6',agreedHours:3}],f.readTicket),{applied:1,unchanged:0,failed:[]});
 const six=await readMetadata(f.env,'INT-6');assert.equal(six.agreedHours,3);assert.equal(six.agreedDev,'other');
 // Unchanged hours on a ticket whose developers were removed since: no change, no developer needed.
 await saveMetadata(f.env,'INT-7',{revision:0,agreedHours:4},admin,{ticket:{title:'Seven',devs:['builder']}});
 assert.equal((await bulk({key:'INT-7',agreedHours:4,billing:'Billable'})).status,'ok');
 assert.deepEqual((await bulk({key:'INT-7',agreedHours:4,billing:'Billable'})).changes.map(c=>c.field),['billing']);
 assert.equal((await agreed({key:'INT-7',agreedHours:4})).status,'ok');
 assert.deepEqual(await bulkImportApply(f.env,admin,[{key:'INT-7',agreedHours:4,billing:'Billable'}],f.readTicket),{applied:1,unchanged:0,failed:[]});
 assert.deepEqual(await agreedImportApply(f.env,admin,[{key:'INT-7',agreedHours:4}],f.readTicket),{applied:1,failed:[]});
 const seven=await readMetadata(f.env,'INT-7');assert.equal(seven.agreedHours,4);assert.equal(seven.billing,'billable');assert.equal(seven.agreedDev,'builder');
});
