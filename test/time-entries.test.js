// Log work → Odoo timesheets, against a fake Odoo JSON-RPC server and the in-memory database.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{makeToken} from '../proxy/src/handler.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';
import {prepareImport,catalogKey,readCatalog} from '../proxy/src/ticket-metadata.js';
import {todayIn,suggestFields,formatMinutes} from '../proxy/src/time-entries.js';

const admin={email:'admin@example.invalid',name:'Manager',role:'admin',dev:'builder',v:1};
const user={email:'user@example.invalid',name:'Dana Developer',role:'user',dev:'builder',v:1};
const other={email:'other@example.invalid',name:'Other Dev',role:'user',dev:'someone',v:1};
const FIELDS={users:'x_studio_users',entryUuid:'x_aione_entry_uuid',userUuid:'x_aione_user_uuid',lineRef:'x_aione_ticket_ref',taskRef:'x_aione_ticket_ref'};
const daysAgo=n=>new Date(Date.parse(todayIn()+'T12:00:00Z')-n*86400000).toISOString().slice(0,10);

function fakeOdoo(){
  const o={lines:new Map(),tasks:new Map(),projects:new Map([[10,{id:10,name:'Branch A',active:true,partner_id:false}],[11,{id:11,name:'Old',active:false,partner_id:false}],[12,{id:12,name:'Support',active:true,partner_id:false}]]),
    employees:[{id:5,name:'Bot employee'}],lockDate:false,nextId:100,calls:[],
    // 'lost': Odoo saves the line but the answer never arrives; 'down': no answer and nothing saved; 'refuse': Odoo refuses.
    createMode:null,taskMode:null,helpdesk:{302:{id:300,name:'Printer down',ticket_ref:'302',user_id:[12,'Dana'],stage_id:[2,'In Progress'],project_id:[12,'Support']}}};
  const match=(row,domain)=>domain.every(([f,op,v])=>op==='in'?v.includes(row[f]):row[f]===v);
  o.fetch=async(url,init)=>{
    const body=JSON.parse(init.body),{service,method,args}=body.params,reply=result=>Response.json({jsonrpc:'2.0',id:body.id,result});
    const refuse=(message,name='odoo.exceptions.ValidationError')=>Response.json({jsonrpc:'2.0',id:body.id,error:{message:'Odoo Server Error',data:{name,message}}});
    if(service==='common')return reply(7);
    const [, , , model,m,a=[],kw={}]=args;o.calls.push({model,method:m,args:a,kw});
    const pick=(row,fields)=>fields?Object.fromEntries([['id',row.id],...fields.map(f=>[f,row[f]??false])]):row;
    if(m==='fields_get'){
      if(model==='account.analytic.line')return reply({name:{type:'char',string:'Description'},date:{type:'date'},unit_amount:{type:'float'},x_studio_users:{type:'char',string:'Users'},x_aione_entry_uuid:{type:'char',string:'Work entry id'},x_aione_user_uuid:{type:'char',string:'Dashboard user id'},x_aione_ticket_ref:{type:'char',string:'Ticket'}});
      if(model==='project.task')return reply({name:{type:'char'},x_aione_ticket_ref:{type:'char',string:'Dashboard ticket'}});
      if(model==='res.company')return reply({fiscalyear_lock_date:{type:'date'},name:{type:'char'}});
      if(model==='helpdesk.ticket')return reply({project_id:{type:'many2one'}});
      return reply({});
    }
    if(model==='res.users'&&m==='read')return reply([{id:7,name:'Odoo Bot',company_id:[1,'AION']}]);
    if(model==='res.users')return reply([{id:12,name:'Dana',login:'builder@x',email:'builder@x'}]);
    if(model==='hr.employee')return reply(o.employees);
    if(model==='res.company')return reply([{id:1,fiscalyear_lock_date:o.lockDate}]);
    if(model==='helpdesk.stage')return reply([{id:1,name:'New',fold:false,sequence:1,team_ids:[]},{id:2,name:'In Progress',fold:false,sequence:2,team_ids:[]},{id:3,name:'Solved',fold:true,sequence:3,team_ids:[]}]);
    if(model==='helpdesk.ticket'&&m==='search_read'){const ref=a[0].find(t=>t[0]==='ticket_ref');return reply(Object.values(o.helpdesk).filter(t=>!ref||t.ticket_ref===ref[2]).map(t=>({...t,team_id:false,priority:'0',partner_id:false})));}
    if(model==='helpdesk.ticket'&&m==='write'){const t=Object.values(o.helpdesk).find(x=>x.id===a[0][0]);if(a[1].stage_id)t.stage_id=[a[1].stage_id,'x'];return reply(true);}
    if(model==='project.project')return reply([...o.projects.values()].filter(p=>match(p,a[0]||[])&&(kw.context?.active_test===false||p.active)).map(p=>pick(p,kw.fields)));
    if(model==='project.task'&&m==='search_read')return reply([...o.tasks.values()].filter(t=>match(t,a[0])).map(t=>pick(t,kw.fields)));
    if(model==='project.task'&&m==='create'){
      if(o.taskMode==='down')throw new TypeError('fetch failed');
      const id=o.nextId++;o.tasks.set(id,{id,...a[0],project_id:[a[0].project_id,'p']});return reply(id);
    }
    if(model==='account.analytic.line'&&m==='search_read')return reply([...o.lines.values()].filter(l=>match(l,a[0])).map(l=>pick(l,kw.fields)));
    if(model==='account.analytic.line'&&m==='create'){
      if(o.createMode==='refuse')return refuse('You cannot log time on a locked period.');
      if(o.createMode==='down')throw new TypeError('fetch failed');
      const id=o.nextId++;o.lines.set(id,{id,...a[0],task_id:[a[0].task_id,'t'],project_id:[a[0].project_id,'p']});
      if(o.createMode==='lost')throw new TypeError('fetch failed');
      return reply(id);
    }
    if(model==='account.analytic.line'&&m==='write'){for(const id of a[0]){const l=o.lines.get(id);if(!l)return refuse('Record does not exist','odoo.exceptions.MissingError');Object.assign(l,a[1]);}return reply(true);}
    return reply(false);
  };
  return o;
}

async function setup({mode='on',pilot=[]}={}){
  const env={SESSION_SECRET:'synthetic-secret',JIRA_PROJECT:'AION',JIRA_SITE:'https://jira.invalid',JIRA_EMAIL:'bot',JIRA_API_TOKEN:'secret',STORE:memoryStore(),
    ODOO_URL:'https://odoo.invalid',ODOO_DB:'db',ODOO_LOGIN:'bot@x',ODOO_API_KEY:'k',TIME_SYNC_SECRET:'s'.repeat(32),TEAM_CONFIG:JSON.stringify({devEmails:{builder:'builder@x'}})};
  for(const me of [admin,user,other])await saveUser(env.STORE,me);
  const tokens={};for(const me of [admin,user,other])tokens[me.email]=(await makeToken(env,me.email,Date.now(),1)).token;
  const imported=await prepareImport({revision:0,entries:[]},[{customer:'Acme',displayName:'Branch A',sourceRow:10}],'odoo');
  await env.STORE.set(catalogKey(env),JSON.stringify({...imported.next,revision:1}));
  const cat=await readCatalog(env),client=cat.entries.find(e=>e.name==='Acme'),sub=cat.entries.find(e=>e.name==='Branch A');
  const odoo=fakeOdoo();
  globalThis.fetch=async(url,init={})=>String(url).startsWith('https://odoo.invalid')?odoo.fetch(url,init):Response.json({errorMessages:['no jira here']},{status:404});
  const call=async(path,method='GET',body,me=user,headers={})=>{const r=await worker.fetch(new Request('https://proxy.invalid'+path,{method,headers:{Authorization:'Bearer '+tokens[me.email],'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()};};
  const ticket=async(metadata={clientId:client.id,subClientId:sub.id})=>{const r=await call('/internal','POST',{summary:'Fix the report',devs:['builder'],metadata:{...metadata,billing:'billable'}},admin);assert.equal(r.status,201,JSON.stringify(r.data));return r.data.ticket.key;};
  if(mode!=='off'){const s=await call('/time-entries/setup','GET',undefined,admin);const r=await call('/time-entries/setup','PUT',{revision:s.data.config.revision,mode,pilot,fields:FIELDS},admin);assert.equal(r.status,200,JSON.stringify(r.data));}
  const log=(key,extra={},me=user)=>call('/time-entries','POST',{id:crypto.randomUUID(),ticket:key,date:todayIn(),minutes:90,description:'Investigated the export',...extra},me);
  const cron=(secret=env.TIME_SYNC_SECRET)=>worker.fetch(new Request('https://proxy.invalid/cron/time-sync',{method:'POST',headers:{Authorization:'Bearer '+secret}}),env);
  return {env,call,ticket,log,cron,odoo,client,sub,tokens};
}

test('field discovery suggests the Users field and the custom reference fields',()=>{
  const line=[{name:'x_studio_users',label:'Users',custom:true},{name:'x_aione_entry_uuid',label:'Work entry id',custom:true},{name:'x_aione_user_uuid',label:'User id',custom:true},{name:'x_aione_ticket_ref',label:'Ticket',custom:true}];
  const s=suggestFields({line,task:[{name:'x_aione_ticket_ref',label:'Ticket',custom:true}]});
  assert.equal(s.users,'x_studio_users');assert.equal(s.entryUuid,'x_aione_entry_uuid');assert.equal(s.userUuid,'x_aione_user_uuid');assert.equal(s.lineRef,'x_aione_ticket_ref');assert.equal(s.taskRef,'x_aione_ticket_ref');
  // Two fields labelled Users: the administrator must choose.
  assert.equal(suggestFields({line:[...line,{name:'x_users2',label:'Users',custom:true}],task:[]}).users,'');
  assert.equal(formatMinutes(90),'1h 30m');assert.equal(formatMinutes(15),'15m');
});

test('setup: administrators only; switching on needs every field and a valid Odoo employee and company',async()=>{
  const s=await setup({mode:'off'});
  assert.equal((await s.call('/time-entries/setup','GET',undefined,user)).status,403);
  const view=await s.call('/time-entries/setup','GET',undefined,admin);
  assert.equal(view.data.suggested.users,'x_studio_users');assert.equal(view.data.defaults.ok,true);assert.equal(view.data.defaults.employee.name,'Bot employee');
  assert.equal((await s.call('/time-entries/setup','PUT',{revision:0,mode:'on',fields:{...FIELDS,taskRef:''}},admin)).data.code,'setup_incomplete');
  assert.equal((await s.call('/time-entries/setup','PUT',{revision:0,mode:'on',fields:{...FIELDS,entryUuid:'name'}},admin)).status,400);
  s.odoo.employees=[];
  const blocked=await s.call('/time-entries/setup','PUT',{revision:0,mode:'on',fields:FIELDS},admin);
  assert.equal(blocked.data.code,'setup_defaults');assert.match(blocked.data.error,/no active employee/);
  s.odoo.employees=[{id:5,name:'Bot employee'}];
  assert.match((await s.call('/time-entries/setup','PUT',{revision:0,mode:'on',fields:FIELDS,mapping:{[s.client.id]:11}},admin)).data.error,/#11 was not found or is archived/);
  assert.match((await s.call('/time-entries/setup','PUT',{revision:0,mode:'pilot',pilot:[],fields:FIELDS},admin)).data.error,/pilot user/);
  const on=await s.call('/time-entries/setup','PUT',{revision:0,mode:'pilot',pilot:[user.email],fields:FIELDS},admin);
  assert.equal(on.status,200);assert.equal(on.data.config.verified.employee.id,5);
  assert.equal((await s.call('/time-entries/setup','PUT',{revision:0,mode:'off'},admin)).status,409);
});

test('pilot group: only pilot users can log work',async()=>{
  const s=await setup({mode:'pilot',pilot:[user.email]}),key=await s.ticket();
  assert.equal((await s.log(key,{},admin)).data.code,'time_off');
  assert.equal((await s.log(key)).status,201);
});

test('logging work creates one Odoo task per ticket and one timesheet line per entry',async()=>{
  const s=await setup(),key=await s.ticket();
  const first=await s.log(key);
  assert.equal(first.status,201,JSON.stringify(first.data));assert.equal(first.data.entry.status,'synced');assert.equal(first.data.entry.statusLabel,'Synced');
  const second=await s.log(key,{minutes:15,description:'Wrote tests',date:daysAgo(3)});assert.equal(second.data.entry.status,'synced');
  assert.equal(s.odoo.tasks.size,1);const task=[...s.odoo.tasks.values()][0];
  assert.equal(task.name,'['+key+'] Fix the report');assert.equal(task.x_aione_ticket_ref,'aione:internal:'+key);assert.equal(task.project_id[0],10);
  assert.equal(s.odoo.lines.size,2);const line=[...s.odoo.lines.values()][0];
  assert.equal(line.x_studio_users,'Dana Developer');assert.equal(line.x_aione_entry_uuid,first.data.entry.id);assert.equal(line.unit_amount,1.5);assert.equal(line.name,'Investigated the export');
  assert.equal(line.x_aione_ticket_ref,'internal:'+key);assert.match(line.x_aione_user_uuid,/^[0-9a-f-]{36}$/);assert.equal(line.task_id[0],task.id);assert.equal(line.employee_id,undefined);
  // The user id is stable across entries.
  assert.equal([...s.odoo.lines.values()][1].x_aione_user_uuid,line.x_aione_user_uuid);
  const view=await s.call('/time-entries?ticket='+key);
  assert.equal(view.data.entries.length,2);assert.equal(view.data.entries[0].date,daysAgo(3));
  assert.equal(view.data.summary.loggedMinutes,105);assert.equal(view.data.summary.confirmedMinutes,105);
  assert.equal(view.data.destination.projectName,'Branch A');assert.equal(view.data.canLog,true);
  // Actual hours = the hours entered before the work log + the logged work (2 decimals), shown in lists.
  const batch=await s.call('/ticket-metadata/batch','POST',{keys:[key]});assert.equal(batch.data.records[key].loggedMinutes,105);assert.equal(batch.data.records[key].totalActualHours,1.75);
});

test('input rules: required description, 1 minute to 24 hours, no future dates, Odoo lock date',async()=>{
  const s=await setup(),key=await s.ticket();
  assert.equal((await s.log(key,{description:'  '})).status,400);
  assert.equal((await s.log(key,{minutes:0})).status,400);
  assert.equal((await s.log(key,{minutes:1441})).status,400);
  assert.equal((await s.log(key,{minutes:1.5})).status,400);
  assert.equal((await s.log(key,{date:'2026-02-30'})).status,400);
  const tomorrow=new Date(Date.parse(todayIn()+'T12:00:00Z')+86400000).toISOString().slice(0,10);
  assert.equal((await s.log(key,{date:tomorrow})).data.code,'future_date');
  assert.equal((await s.log(key,{minutes:1440})).status,201);
  s.odoo.lockDate=daysAgo(5);await s.env.STORE.del('tw:AION:lock-date');
  const locked=await s.log(key,{date:daysAgo(6)});assert.equal(locked.data.code,'date_locked');assert.equal(locked.data.lockDate,daysAgo(5));
  assert.equal((await s.log(key,{date:daysAgo(4)})).status,201);
});

test('saving twice with the same id is harmless; someone else cannot reuse the id',async()=>{
  const s=await setup(),key=await s.ticket(),id=crypto.randomUUID();
  const body={id,ticket:key,date:todayIn(),minutes:30,description:'Call with client'};
  assert.equal((await s.call('/time-entries','POST',body)).status,201);
  const again=await s.call('/time-entries','POST',body);assert.equal(again.status,200);assert.equal(again.data.entry.id,id);
  assert.equal(s.odoo.lines.size,1);
  assert.equal((await s.call('/time-entries','POST',body,admin)).status,409);
});

test('an unclear create is never sent again blindly: one exact match is linked',async()=>{
  const s=await setup(),key=await s.ticket();
  s.odoo.createMode='lost';
  const r=await s.log(key);assert.equal(r.status,201);assert.equal(r.data.entry.status,'syncing');assert.equal(s.odoo.lines.size,1);
  s.odoo.createMode=null;
  const retry=await s.call('/time-entries/'+r.data.entry.id+'/sync','POST',{});
  assert.equal(retry.data.entry.status,'synced');assert.equal(s.odoo.lines.size,1);
  assert.equal(s.odoo.calls.filter(c=>c.model==='account.analytic.line'&&c.method==='create').length,1);
});

test('an unclear create with no line in Odoo goes to Needs review; an administrator sends it again',async()=>{
  const s=await setup(),key=await s.ticket();
  s.odoo.createMode='down';
  const r=await s.log(key);assert.equal(r.data.entry.status,'syncing');assert.equal(s.odoo.lines.size,0);
  s.odoo.createMode=null;
  const check=await s.call('/time-entries/'+r.data.entry.id+'/sync','POST',{});
  assert.equal(check.data.entry.status,'review');assert.equal(check.data.entry.reviewKind,'nomatch');assert.equal(check.data.entry.statusLabel,'Needs review');
  assert.equal(s.odoo.calls.filter(c=>c.model==='account.analytic.line'&&c.method==='create').length,1);
  assert.equal((await s.call('/time-entries/'+r.data.entry.id+'/sync','POST',{})).data.code,'needs_review');
  assert.equal((await s.call('/time-entries/'+r.data.entry.id+'/sync','POST',{action:'resend'})).status,403);
  const resent=await s.call('/time-entries/'+r.data.entry.id+'/sync','POST',{action:'resend'},admin);
  assert.equal(resent.data.entry.status,'synced');assert.equal(s.odoo.lines.size,1);
});

test('more than one Odoo line with the entry id goes to review; an administrator can link the right line',async()=>{
  const s=await setup(),key=await s.ticket();
  s.odoo.createMode='down';const r=await s.log(key);s.odoo.createMode=null;const id=r.data.entry.id;
  for(const n of [1,2])s.odoo.lines.set(500+n,{id:500+n,date:todayIn(),unit_amount:1.5,task_id:[100,'t'],project_id:[10,'p'],x_aione_entry_uuid:id});
  const check=await s.call('/time-entries/'+id+'/sync','POST',{});assert.equal(check.data.entry.reviewKind,'conflict');
  s.odoo.lines.delete(502);
  assert.equal((await s.call('/time-entries/'+id+'/sync','POST',{action:'check'},admin)).data.entry.status,'synced');
  // Linking: the line must have the same date and duration and must not belong to another entry.
  s.odoo.createMode='down';const other=await s.log(key,{minutes:20});s.odoo.createMode=null;
  await s.call('/time-entries/'+other.data.entry.id+'/sync','POST',{});
  s.odoo.lines.set(600,{id:600,date:todayIn(),unit_amount:1,task_id:[100,'t'],project_id:[10,'p']});
  assert.equal((await s.call('/time-entries/'+other.data.entry.id+'/sync','POST',{action:'link',lineId:600},admin)).status,409);
  s.odoo.lines.get(600).unit_amount=20/60;
  const linked=await s.call('/time-entries/'+other.data.entry.id+'/sync','POST',{action:'link',lineId:600},admin);
  assert.equal(linked.data.entry.status,'synced');assert.equal(s.odoo.lines.get(600).x_aione_entry_uuid,other.data.entry.id);
});

test('Odoo refusing the line sends it to Needs review with the reason',async()=>{
  const s=await setup(),key=await s.ticket();s.odoo.createMode='refuse';
  const r=await s.log(key);assert.equal(r.data.entry.status,'review');assert.match(r.data.entry.reason,/locked period/);
});

test('no client, or no Odoo project: Needs setup, then the worker sends it once the ticket is set',async()=>{
  const s=await setup(),key=await s.ticket({clientId:null,subClientId:null});
  const r=await s.log(key);assert.equal(r.data.entry.status,'setup');assert.match(r.data.entry.reason,/Choose a client/);
  const m=await s.call('/ticket-metadata?key='+key,'GET',undefined,admin);
  assert.equal((await s.call('/ticket-metadata','PUT',{key,fields:{revision:m.data.metadata.revision,clientId:s.client.id,subClientId:s.sub.id}},admin)).status,200);
  const res=await s.cron();const out=await res.json();assert.equal(res.status,200);assert.equal(out.synced,1);
  assert.equal((await s.call('/time-entries?ticket='+key)).data.entries[0].status,'synced');
});

test('the worker needs its secret in the Authorization header',async()=>{
  const s=await setup();
  assert.equal((await s.cron('wrong')).status,403);
  assert.equal((await worker.fetch(new Request('https://proxy.invalid/cron/time-sync?token='+s.env.TIME_SYNC_SECRET,{method:'POST'}),s.env)).status,403);
  delete s.env.TIME_SYNC_SECRET;assert.equal((await s.cron('')).status,503);
});

test('corrections: administrators only, with a reason; Odoo line updated and the revision kept',async()=>{
  const s=await setup(),key=await s.ticket(),r=await s.log(key),id=r.data.entry.id;
  assert.equal((await s.call('/time-entries/'+id,'PATCH',{revision:0,minutes:60,reason:'Typo'})).status,403);
  assert.equal((await s.call('/time-entries/'+id,'PATCH',{revision:0,minutes:60},admin)).data.code,'reason_required');
  const fixed=await s.call('/time-entries/'+id,'PATCH',{revision:0,minutes:60,date:daysAgo(1),reason:'Entered 90 instead of 60'},admin);
  assert.equal(fixed.status,200,JSON.stringify(fixed.data));assert.equal(fixed.data.entry.status,'synced');assert.equal(fixed.data.entry.revision,1);
  assert.equal(fixed.data.entry.revisions[0].reason,'Entered 90 instead of 60');assert.equal(fixed.data.entry.revisions[0].from.minutes,90);
  const line=s.odoo.lines.get(fixed.data.entry.lineId);assert.equal(line.unit_amount,1);assert.equal(line.date,daysAgo(1));
  assert.equal((await s.call('/time-entries/'+id,'PATCH',{revision:0,minutes:30,reason:'x'},admin)).status,409);
  // There is no delete or reassign in this release.
  assert.equal((await s.call('/time-entries/'+id,'DELETE',undefined,admin)).status,404);
  assert.equal((await s.call('/time-entries/'+id,'PATCH',{revision:1,ticket:'INT-9',reason:'x'},admin)).status,400);
});

test('closing requires every entry in Odoo; the administrator override cannot skip it',async()=>{
  const s=await setup(),key=await s.ticket();
  s.odoo.createMode='down';await s.log(key);s.odoo.createMode=null;
  const close=await s.call('/internal/'+key,'PUT',{status:'Closed',overrideReason:'Client asked'},admin);
  assert.equal(close.status,409);assert.equal(close.data.code,'time_not_synced');assert.equal(close.data.canOverride,false);
  // Closed tickets don't take new work; reopen first.
  const other=await s.ticket();await s.log(other);
  const m=await s.call('/ticket-metadata?key='+other,'GET',undefined,admin);
  await s.call('/ticket-metadata','PUT',{key:other,fields:{revision:m.data.metadata.revision,estimatedHours:2,workDone:'Done'}},admin);
  const ok=await s.call('/internal/'+other,'PUT',{status:'Closed'},admin);assert.equal(ok.status,200,JSON.stringify(ok.data));
  assert.equal((await s.log(other)).data.code,'ticket_closed');
  const closedView=await s.call('/time-entries?ticket='+other);assert.equal(closedView.data.canLog,false);assert.equal(closedView.data.closed,true);
});

test('closing checks Odoo in one read: a line deleted in Odoo blocks it and goes to review',async()=>{
  const s=await setup(),key=await s.ticket(),r=await s.log(key);
  assert.equal(r.data.entry.lineId,undefined);s.odoo.lines.clear();
  const m=await s.call('/ticket-metadata?key='+key,'GET',undefined,admin);
  await s.call('/ticket-metadata','PUT',{key,fields:{revision:m.data.metadata.revision,estimatedHours:2,workDone:'Done'}},admin);
  const before=s.odoo.calls.length,close=await s.call('/internal/'+key,'PUT',{status:'Closed'},admin);
  assert.equal(close.data.code,'time_not_synced');assert.match(close.data.error,/deleted/);
  assert.equal(s.odoo.calls.slice(before).filter(c=>c.model==='account.analytic.line').length,1);
  assert.equal((await s.call('/time-entries?ticket='+key)).data.entries[0].status,'review');
});

test('Odoo Helpdesk tickets: work goes to the ticket\'s project; closing is blocked until synced',async()=>{
  const s=await setup();
  const r=await s.log('HD-302');assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(r.data.entry.status,'synced');
  assert.equal([...s.odoo.lines.values()][0].project_id[0],12);assert.equal([...s.odoo.lines.values()][0].x_aione_ticket_ref,'odoo:HD-302');
  assert.equal((await s.log('HD-302',{},other)).status,404);
  s.odoo.createMode='down';await s.log('HD-302');s.odoo.createMode=null;
  const close=await s.call('/odoo/tickets/HD-302','PUT',{stage:3},admin);assert.equal(close.status,409);assert.equal(close.data.code,'time_not_synced');
  assert.equal(s.odoo.helpdesk[302].stage_id[0],2);
});

test('report: dated entries with client, project and status; users see only their own; baseline kept apart',async()=>{
  const s=await setup(),key=await s.ticket();
  const m=await s.call('/ticket-metadata?key='+key,'GET',undefined,admin);
  await s.call('/ticket-metadata','PUT',{key,fields:{revision:m.data.metadata.revision,actualHours:3}},admin);
  await s.log(key);await s.log(key,{minutes:45},admin);await s.log(key,{date:daysAgo(40)});
  const all=await s.call('/time-entries/report?from='+daysAgo(10)+'&to='+todayIn(),'GET',undefined,admin);
  assert.equal(all.data.rows.length,2);assert.equal(all.data.rows[0].clientName,'Acme');assert.equal(all.data.rows[0].subClientName,'Branch A');assert.equal(all.data.rows[0].source,'internal');
  assert.deepEqual(all.data.baselines,[{ticket:key,hours:3}]);
  const mine=await s.call('/time-entries/report?from='+daysAgo(60)+'&to='+todayIn());
  assert.equal(mine.data.rows.length,2);assert.ok(mine.data.rows.every(r=>r.user==='Dana Developer'));
  assert.equal((await s.call('/time-entries/report?from='+todayIn()+'&to='+daysAgo(1))).status,400);
});

test('the entry and its "waiting to sync" place are saved together',async()=>{
  const store=memoryStore();
  assert.equal(await store.writeIndexed('e:1',null,'a',[['pending','1'],['t:X','1']]),true);
  assert.equal(await store.writeIndexed('e:1',null,'b',[['pending','2']]),false);
  assert.deepEqual(await store.smembers('pending'),['1']);
  assert.equal(await store.writeIndexed('e:1','stale','c',[],[['pending','1']]),false);
  assert.equal(await store.writeIndexed('e:1','a','c',[],[['pending','1']]),true);
  assert.deepEqual(await store.smembers('pending'),[]);assert.equal(await store.get('e:1'),'c');
});
