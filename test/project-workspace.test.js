// The project billing workspace on synthetic data: the in-memory database and a fake Odoo and Jira. Nothing here
// reaches a real service, and no email is sent.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{makeToken} from '../proxy/src/handler.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';
import {metadataKey,odooProjectsKey,readProjectLog} from '../proxy/src/ticket-metadata.js';
import {todayIn} from '../proxy/src/time-entries.js';
import {readLedger,readProjectDefaults} from '../proxy/src/billing.js';

const admin={email:'admin@example.invalid',name:'Manager',role:'admin',dev:'builder',v:1};
const user={email:'user@example.invalid',name:'Dana Developer',role:'user',dev:'builder',v:1};
const today=todayIn(),daysAgo=n=>new Date(Date.parse(today+'T12:00:00Z')-n*86400000).toISOString().slice(0,10);
const realFetch=globalThis.fetch;

// A fake Odoo: two projects (10 with an allocation, 12 archived), one Helpdesk ticket, and the "[KEY]" task AION-7.
function fakeOdoo(log){
  const projects={10:{id:10,name:'Branch A',partner_id:[900,'Acme'],active:true,allocated_hours:40,description:'<p>Support for <b>Acme</b></p><p>Second line</p>'},
    12:{id:12,name:'Old',partner_id:[900,'Acme'],active:false,allocated_hours:false,description:false}};
  return async(url,init)=>{
    if(String(url).startsWith('https://jira.invalid')){
      const body=JSON.parse(init.body||'{}');log.push({jira:body.jql});
      const keys=/key in \(([^)]*)\)/.exec(body.jql||'')?.[1].split(',')||[];
      return Response.json({issues:keys.filter(k=>k==='AION-7').map(key=>({key,fields:{summary:'Checkout fails',status:{name:'In Progress',statusCategory:{key:'indeterminate'}},labels:['ai1_builder','ai1_tester'],assignee:{displayName:'Tess Tester'},
        description:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Steps: open the cart. שלום'}]}]}}}))});
    }
    const b=JSON.parse(init.body),{service,args}=b.params,reply=result=>Response.json({jsonrpc:'2.0',id:b.id,result});
    if(service==='common')return reply(7);
    const [, , , model,method,a=[],kw={}]=args;log.push({model,method,a});
    if(model==='res.users'&&method==='search_read')return reply(JSON.stringify(a[0]).includes('login')?[{id:7,company_ids:[1]}]:[{id:7,login:'builder@example.invalid',email:'builder@example.invalid',name:'Builder'}]);
    if(model==='project.task'&&method==='search_read')return reply([{id:1,name:'[AION-7] Checkout fails',project_id:[10,'Branch A']}]);
    if(model==='project.project'&&method==='fields_get')return reply({allocated_hours:{type:'float',readonly:false}});
    if(model==='project.project'&&method==='search_read'){const d=JSON.stringify(a[0]),ids=d.includes('"in"')?a[0][0][2]:[a[0][0][2]];return reply(ids.map(id=>projects[id]).filter(Boolean));}
    if(model==='project.project'&&method==='read')return reply(a[0].map(id=>({id,allocated_hours:projects[id].allocated_hours})));
    if(model==='project.project'&&method==='write'){for(const id of a[0])projects[id].allocated_hours=a[1].allocated_hours??false;return reply(true);}
    if(model==='helpdesk.stage')return reply([{id:1,name:'New',fold:false},{id:2,name:'Solved',fold:true}]);
    if(model==='helpdesk.ticket'&&method==='fields_get')return reply({project_id:{type:'many2one'}});
    if(model==='helpdesk.ticket'&&method==='search_read')return reply([{id:55,ticket_ref:'302',name:'Printer offline',user_id:[7,'Builder'],stage_id:[1,'New'],description:'<p>It &amp; the scanner</p>',project_id:[10,'Branch A']}]);
    return reply([]);
  };
}

async function setup(){
  const log=[];globalThis.fetch=fakeOdoo(log);
  const env={SESSION_SECRET:'synthetic-secret',JIRA_PROJECT:'AION',JIRA_SITE:'https://jira.invalid',JIRA_EMAIL:'bot@example.invalid',JIRA_API_TOKEN:'t',STORE:memoryStore(),TIME_SYNC_SECRET:'s'.repeat(32),
    MAIL_DOMAIN:'example.invalid',NO_DEVELOPER_NOTIFY_TO:'sales@example.invalid',ODOO_URL:'https://odoo.invalid',ODOO_DB:'db',ODOO_LOGIN:'bot@example.invalid',ODOO_API_KEY:'k'};
  for(const me of [admin,user])await saveUser(env.STORE,me);
  const tokens={};for(const me of [admin,user])tokens[me.email]=(await makeToken(env,me.email,Date.now(),1)).token;
  await env.STORE.set(odooProjectsKey(env),JSON.stringify({syncedAt:Date.now(),projects:[
    {id:10,name:'Branch A',active:true,clientId:900,clientName:'Acme',label:'Acme → Branch A'},
    {id:20,name:'Website',active:true,clientId:901,clientName:'Beta & Co',label:'Beta & Co → Website'}]}));
  const call=async(path,method='GET',body,me=admin)=>{const r=await worker.fetch(new Request('https://proxy.invalid'+path,{method,headers:{Authorization:'Bearer '+tokens[me.email],'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()};};
  const B='business:AION:billing:';
  return {env,log,call,
    config:()=>env.STORE.set(B+'config',JSON.stringify({revision:1,classification:true,emails:'dry',fields:{project:'',task:''},values:{project:{},task:{}},quotationUrl:''})),
    projects:items=>env.STORE.set(B+'projects',JSON.stringify({revision:1,items:Object.fromEntries(Object.entries(items).map(([id,billing])=>[id,{billing}]))})),
    allowance:a=>env.STORE.set(B+'allowances',JSON.stringify({revision:1,items:[{id:'a1',kind:'package',label:'Support hours',enabled:true,projectIds:[10],startDate:daysAgo(30),endDate:null,minutes:600,openingMinutes:0,topUps:[],cycle:0,customer:{id:900,name:'Acme'},...a}]})),
    ticket:async(key,meta={},it={})=>{
      if(key.startsWith('INT-'))await env.STORE.set('it:'+key,JSON.stringify({summary:'Ticket '+key,description:'Line one\nLine two',devs:['builder'],status:'Open',assignee:'Builder',...it}));
      await env.STORE.set(metadataKey(env,key),JSON.stringify({revision:1,odooProjectId:10,billing:null,agreedHours:null,agreedDate:null,history:[],...meta}));
    },
    entry:async(key,minutes,date=today,extra={})=>{
      const id=crypto.randomUUID(),e={id,ticket:key,source:key.startsWith('HD-')?'odoo':key.startsWith('INT-')?'internal':'jira',ticketTitle:'Ticket '+key,date,minutes,description:'Work on '+key,
        author:{email:user.email,name:user.name},createdAt:new Date().toISOString(),revision:1,syncedRevision:1,state:'synced',lineId:Math.floor(Math.random()*1e6),projectId:10,...extra};
      await env.STORE.set('tw:AION:e:'+id,JSON.stringify(e));await env.STORE.sadd('tw:AION:t:'+key,id);await env.STORE.sadd('tw:AION:m:'+date.slice(0,7),id);
      return e;
    }};
}
test.afterEach(()=>{globalThis.fetch=realFetch;});

test('a project\'s tickets: Jira, internal and Helpdesk, each once, with work kept apart from what is charged',async()=>{
  const s=await setup();await s.config();await s.projects({10:'billable'});await s.allowance({});
  await s.ticket('INT-1',{agreedHours:2,agreedDate:daysAgo(3),agreedDeveloper:'Builder',agreedDev:'builder'});await s.entry('INT-1',240,daysAgo(3));
  await s.ticket('INT-2',{billing:'not_billable'});await s.entry('INT-2',60,daysAgo(2),{state:'syncing',lineId:null,syncedRevision:0});
  await s.ticket('AION-7');await s.entry('AION-7',30,daysAgo(1),{source:'jira'});
  await s.entry('HD-302',45,daysAgo(1),{hdProjectId:10});
  await s.ticket('INT-9',{odooProjectId:20});await s.entry('INT-9',600,daysAgo(1),{projectId:20});
  const r=await s.call('/clients/odoo-projects/tickets?id=10');assert.equal(r.status,200,JSON.stringify(r.data));
  assert.deepEqual(r.data.tickets.map(t=>t.key),['AION-7','HD-302','INT-1','INT-2'],'each key once; the Odoo task AION-7 is the same ticket');
  assert.equal(r.data.project.description,'Support for Acme\nSecond line');
  assert.equal(r.data.scope.from,daysAgo(30),'the scope starts with the allocation');
  const by=Object.fromEntries(r.data.tickets.map(t=>[t.key,t]));
  assert.deepEqual([by['INT-1'].actualMinutes,by['INT-1'].chargeableMinutes],[240,120],'agreed hours charge once, the work itself is kept as actual');
  assert.deepEqual(by['INT-1'].effective,{value:'billable',source:'project'});assert.equal(by['INT-1'].agreedDeveloper,'Builder');
  assert.deepEqual([by['INT-2'].actualMinutes,by['INT-2'].chargeableMinutes,by['INT-2'].sync.pendingMinutes],[60,0,60],'non-billable consumes nothing; not in Odoo yet');
  assert.deepEqual(by['INT-2'].effective,{value:'not_billable',source:'ticket'});
  assert.equal(by['AION-7'].title,'Checkout fails');assert.equal(by['AION-7'].assignee,'Tess Tester');assert.deepEqual(by['AION-7'].devs,['builder','tester']);
  assert.match(by['AION-7'].description,/שלום/);
  assert.equal(by['HD-302'].source,'odoo');assert.equal(by['HD-302'].title,'Printer offline');assert.equal(by['HD-302'].chargeableMinutes,45);
  assert.equal(by['INT-1'].description,'Line one Line two','a one-line preview');
  const all=await s.call('/clients/odoo-projects/tickets?all=1');assert.equal(all.status,200);
  assert.ok(all.data.tickets.some(t=>t.key==='INT-9'&&t.projectId===20&&t.actualMinutes===600));
  assert.ok(!all.data.tickets.some(t=>t.title),'no titles in the all-projects list');
});

test('the workspace is for administrators only, in the API',async()=>{
  const s=await setup();
  for(const [path,method,body] of [['/clients/odoo-projects/tickets?id=10','GET'],['/clients/odoo-projects/tickets?all=1','GET'],['/clients/odoo-projects/import/preview','POST',{tickets:[{key:'INT-1',billing:'billable'}]}],['/clients/odoo-projects/import','POST',{tickets:[{key:'INT-1',billing:'billable'}]}]]){
    const r=await s.call(path,method,body,user);assert.equal(r.status,403,path);assert.equal(r.data.code,'forbidden');
  }
});

test('import preview: current and proposed values, blanks unchanged, [clear], and every validation',async()=>{
  const s=await setup();await s.config();await s.projects({10:'billable'});await s.allowance({});
  await s.ticket('INT-1');await s.entry('INT-1',120,daysAgo(2));
  await s.ticket('INT-2',{},{devs:['builder','tester']});
  await s.ticket('INT-3',{},{status:'Closed'});
  await s.ticket('INT-4',{agreedHours:3,agreedDate:daysAgo(5),agreedDev:'builder',agreedDeveloper:'Builder'});
  const r=await s.call('/clients/odoo-projects/import/preview','POST',{
    projects:[{odooId:'10',billing:'Not billable',allocatedHours:'',customer:'acme'},{odooId:'10',billing:'billable'},{odooId:'12',allocatedHours:'5'},{odooId:'99'},{odooId:'x'},{odooId:'10',customer:'Other Co'}],
    tickets:[{key:'INT-1',billing:'',agreedHours:'1,5'},{key:'INT-1',billing:'billable'},{key:'INT-2',agreedHours:'4'},{key:'INT-3',billing:'billable'},{key:'BAD-1'},{key:'INT-4',agreedHours:'[clear]'},{key:'INT-4',revision:'0'},{key:'INT-1',billing:'maybe'}]});
  assert.equal(r.status,200,JSON.stringify(r.data));
  const rows=r.data.rows,p=rows.filter(x=>x.sheet==='projects'),t=rows.filter(x=>x.sheet==='tickets');
  assert.equal(p[0].status,'ok');assert.deepEqual(p[0].changes,[{field:'billing',label:'Billing default',from:'Billable',to:'Not billable'}],'a blank allocation is unchanged');
  assert.equal(p[0].impact.deltaMinutes,-300,'INT-1 stops charging its 2 h of work, INT-4 its 3 agreed hours');
  assert.match(p[1].errors[0],/more than once/);
  assert.match(p[2].errors[0],/Archived/);assert.match(p[3].errors[0],/No Odoo project/);assert.match(p[4].errors[0],/whole number/);
  assert.match(p[5].errors.join(' '),/more than once/);
  assert.equal(t[0].status,'ok');assert.deepEqual(t[0].changes.map(c=>[c.field,c.to]),[['agreedHours',1.5],['agreedDev','Dana Developer']],'one developer: the agreed hours go to them');
  assert.equal(t[0].impact.deltaMinutes,90-120,'agreed hours replace the 2 h of work');
  assert.match(t[1].errors[0],/more than once/);
  assert.match(t[2].errors[0],/several developers/);
  assert.match(t[3].errors[0],/closed/);
  assert.match(t[4].errors[0],/Not a ticket key/);
  assert.equal(t[5].status,'ok');assert.deepEqual(t[5].changes.map(c=>[c.field,c.from,c.to]),[['agreedHours',3,null]]);
  assert.match(t[6].errors[0],/more than once/);
  assert.match(t[7].errors[0],/more than once/);
  assert.equal(r.data.counts.error,rows.filter(x=>x.status==='error').length);
  assert.ok(!('apply' in rows[0]),'the plan stays on the server');
  // Nothing was saved by a preview.
  assert.equal((await readProjectDefaults(s.env)).items[10].billing,'billable');
});

test('import preview: a project row with a wrong customer, a stale revision and an exported ticket',async()=>{
  const s=await setup();await s.config();await s.projects({10:'billable'});
  await s.ticket('INT-1');const e=await s.entry('INT-1',60,daysAgo(1));
  await s.env.STORE.set('business:AION:billing:exported:'+e.id,JSON.stringify({ticket:'INT-1',minutes:60,date:e.date,batchId:'b1'}));await s.env.STORE.sadd('business:AION:billing:exported',e.id);
  await s.ticket('INT-2');
  const r=await s.call('/clients/odoo-projects/import/preview','POST',{projects:[{odooId:10,customer:'Beta & Co',billing:'not billable'}],
    tickets:[{key:'INT-1',billing:'not billable',revision:'1'},{key:'INT-2',billing:'billable',revision:'4'}]});
  assert.equal(r.status,200,JSON.stringify(r.data));
  assert.match(r.data.rows[0].errors[0],/customer is "Acme"/);
  assert.equal(r.data.rows[1].status,'ok');assert.match(r.data.rows[1].warnings[0],/Already exported.*adjustment/);
  assert.match(r.data.rows[2].errors[0],/revision 4, now 1/);
});

test('import apply: through the existing saves, with history and ledger; a retry changes nothing; no email',async()=>{
  const s=await setup();await s.config();await s.projects({10:'not_billable'});await s.allowance({});
  await s.ticket('INT-1');await s.entry('INT-1',120,daysAgo(2));
  await s.ticket('INT-2',{},{devs:['builder','tester']});
  await saveUser(s.env.STORE,{email:'tester@example.invalid',name:'Tess Tester',role:'user',dev:'tester',v:1});
  const file={projects:[{odooId:10,billing:'Billable',allocatedHours:'55.5'}],
    tickets:[{key:'INT-1',billing:'Not billable'},{key:'INT-2',agreedHours:'4',agreedDeveloper:'Tess Tester'},{key:'INT-404',billing:'billable'}]};
  const r=await s.call('/clients/odoo-projects/import','POST',file);assert.equal(r.status,200,JSON.stringify(r.data));
  assert.deepEqual(r.data.rows.map(x=>[x.id,x.result]),[[10,'applied'],['INT-1','applied'],['INT-2','applied'],['INT-404','not_applied']]);
  assert.equal((await readProjectDefaults(s.env)).items[10].billing,'billable');
  const log=await readProjectLog(s.env,10);assert.deepEqual(log.map(e=>[e.type,e.from,e.to]),[['billing','not_billable','billable'],['allocation',40,55.5]]);
  assert.ok(s.log.some(x=>x.model==='project.project'&&x.method==='write'&&x.a[1].allocated_hours===55.5),'the allocation is Odoo\'s field');
  const m1=JSON.parse(await s.env.STORE.get(metadataKey(s.env,'INT-1')));assert.equal(m1.billing,'not_billable');
  const m2=JSON.parse(await s.env.STORE.get(metadataKey(s.env,'INT-2')));assert.equal(m2.agreedHours,4);assert.equal(m2.agreedDev,'tester');assert.equal(m2.agreedDeveloper,'Tess Tester');
  assert.ok(m2.history.at(-1).by.email===admin.email,'kept in the ticket\'s history');
  assert.equal((await readLedger(s.env,'INT-1')).consumedMinutes,0,'no longer billable');
  assert.equal((await readLedger(s.env,'INT-2')).consumedMinutes,240,'agreed hours consumed once');
  assert.equal(await s.env.STORE.get('business:AION:billing:mailq'),null,'an import never queues an email');
  const again=await s.call('/clients/odoo-projects/import','POST',file);
  assert.deepEqual(again.data.rows.map(x=>x.result),['unchanged','unchanged','unchanged','not_applied'],'a retry is safe');
});

test('import apply: a row from a stale file is not applied; a row of blanks is unchanged',async()=>{
  const s=await setup();await s.config();await s.projects({10:'billable'});
  await s.ticket('INT-1');await s.ticket('INT-2');
  const r=await s.call('/clients/odoo-projects/import','POST',{tickets:[{key:'INT-1',billing:'not billable',revision:'1'},{key:'INT-2',billing:'not billable',revision:'1'}]});
  assert.deepEqual(r.data.rows.map(x=>x.result),['applied','applied']);
  const again=await s.call('/clients/odoo-projects/import','POST',{tickets:[{key:'INT-1',billing:'billable',revision:'1'},{key:'INT-2',billing:'',agreedHours:'',revision:''}]});
  assert.equal(again.data.rows[0].result,'not_applied');assert.match(again.data.rows[0].message,/Export again/);
  assert.equal(again.data.rows[1].result,'unchanged');
});
