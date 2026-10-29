// Log work → Odoo timesheets. Each work entry (date, minutes, description) on a Jira, internal or Odoo
// Helpdesk ticket becomes one Odoo timesheet line (account.analytic.line) on the ticket's Odoo project, in one
// task per ticket ("[KEY] Title"). The proxy's database is the source of truth until Odoo confirms a line.
//
// Store keys (prefix "tw:<PROJECT>:"):
//   config            setup: mode (off | pilot | on), pilot emails, the Odoo field names, project mapping
//   e:<uuid>          one work entry (JSON); its id is the idempotency key the browser sends
//   t:<KEY>           set of the ticket's entry ids        m:<YYYY-MM>  set of entry ids by work month
//   pending           set of entries still to send          sum:<KEY>    the ticket's totals (for lists)
//   task:<KEY>        the ticket's Odoo task {taskId, projectId} (or a pending create / a problem); in Odoo the
//                     task is found by its name, "[KEY] Title", in the ticket's project
//   lock:e:<uuid>, lock:task:<KEY>   short locks: one sync per entry, one task create per ticket
// An entry and its set memberships are written in one atomic step (store.writeIndexed).
//
// Sending is safe to repeat: before each create a "dispatch" marker is saved; Odoo is always searched by the
// entry's id first. If a create's outcome is unclear (no answer), it is never blindly sent again: one exact
// match is linked, no match or a conflicting one goes to "Needs review" for an administrator.
import { odoo, odooConfigured, odooUid } from './odoo.js';
import { requireStore, readMetadata, readCatalog, metadataKey, shownName, withTicketLock, overageOf, BusinessError } from './ticket-metadata.js';
import { recordTicketEvent } from './ticket-log.js';
import { getUser, normEmail } from './users.js';

const problem=(message,status=400,code='time_entry',details={})=>{throw new BusinessError(message,status,code,details);};
const P=env=>'tw:'+env.JIRA_PROJECT+':';
const K={
  cfg:env=>P(env)+'config', entry:(env,id)=>P(env)+'e:'+id, ticket:(env,key)=>P(env)+'t:'+key, sum:(env,key)=>P(env)+'sum:'+key,
  task:(env,key)=>P(env)+'task:'+key, pending:env=>P(env)+'pending', month:(env,ym)=>P(env)+'m:'+ym, lock:(env,what)=>P(env)+'lock:'+what,
  lockDate:env=>P(env)+'lock-date'
};
export const TIME_ZONE='Asia/Jerusalem';
export const todayIn=(now=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
export const MAX_MINUTES=24*60;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const STATUS={syncing:'Syncing',synced:'Synced',setup:'Needs setup',review:'Needs review',agreed:'Agreed hours'};
export const sourceOf=(env,key)=>typeof key!=='string'?null:/^INT-\d+$/.test(key)?'internal':/^HD-\d+$/.test(key)?'odoo':new RegExp('^'+env.JIRA_PROJECT+'-\\d+$').test(key)?'jira':null;
export const formatMinutes=m=>[Math.floor(m/60)?Math.floor(m/60)+'h':'',m%60?m%60+'m':''].filter(Boolean).join(' ')||'0m';
export const totalHours=(baseline,minutes)=>Math.round(((Number(baseline)||0)+minutes/60)*100)/100;
const m2o=v=>Array.isArray(v)?v[0]:null;
const mget=(store,keys)=>!keys.length?[]:store.mget?store.mget(keys):Promise.all(keys.map(k=>store.get(k)));
const clean=(s,n)=>String(s||'').slice(0,n);
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});

// ---- Setup ----
export const FIELD_ROLES=['users','entryUuid','userUuid','lineRef'];
const blankConfig=()=>({revision:0,mode:'off',pilot:[],fields:{users:'',entryUuid:'',userUuid:'',lineRef:''},mapping:{},verified:null,updatedAt:null,updatedBy:null});
export async function readConfig(env){
  const raw=await requireStore(env).get(K.cfg(env)),c=raw?JSON.parse(raw):{},b=blankConfig();
  return {...b,...c,fields:{...b.fields,...(c.fields||{})},mapping:{...(c.mapping||{})},pilot:Array.isArray(c.pilot)?c.pilot:[]};
}
export const canLog=(cfg,me)=>cfg.mode==='on'||(cfg.mode==='pilot'&&cfg.pilot.includes(normEmail(me.email)));
const configReady=cfg=>cfg.mode!=='off'&&FIELD_ROLES.every(r=>cfg.fields[r])&&cfg.verified?.ok===true;

const TEXT=new Set(['char','text']);
const usable=f=>Object.entries(f||{}).filter(([n,d])=>TEXT.has(d.type)&&d.store!==false&&!d.readonly&&n!=='name').map(([n,d])=>({name:n,label:String(d.string||n),type:d.type,custom:n.startsWith('x_')}));
async function odooFields(env){
  const attrs={attributes:['string','type','store','readonly']};
  return {line:usable(await odoo(env,'account.analytic.line','fields_get',[],attrs))};
}
// The "Users" text field: labelled Users, or a custom field named after users (not one of the id fields).
export function suggestFields({line}){
  const one=list=>list.length===1?list[0].name:'';
  const users=line.filter(f=>/^users?$/i.test(f.label.trim())||(f.custom&&/user/i.test(f.name)&&!/uuid|_id$/i.test(f.name)));
  const custom=line.filter(f=>f.custom);
  return {
    users:one(users),usersCandidates:users.map(f=>f.name),
    entryUuid:one(custom.filter(f=>/entry|external|work/i.test(f.name)&&/uuid|_id|ref/i.test(f.name))),
    userUuid:one(custom.filter(f=>/user/i.test(f.name)&&/uuid/i.test(f.name))),
    lineRef:one(custom.filter(f=>/ticket/i.test(f.name)&&!/uuid/i.test(f.name)))
  };
}
// Odoo fills in the employee and company of a timesheet line from the user the proxy signs in as: that user
// needs exactly one active employee in its current company, otherwise logging can't be switched on.
export async function checkDefaults(env){
  const uid=await odooUid(env);
  const [u]=await odoo(env,'res.users','read',[[uid]],{fields:['name','company_id']});
  const company=u&&Array.isArray(u.company_id)?{id:u.company_id[0],name:String(u.company_id[1]||'')}:null,user={id:uid,name:u?String(u.name||''):''};
  if(!company)return {ok:false,user,problem:'The Odoo user the dashboard signs in as has no company.'};
  let employees;
  try{employees=await odoo(env,'hr.employee','search_read',[[['user_id','=',uid],['company_id','=',company.id]]],{fields:['name'],limit:5});}
  catch(e){return {ok:false,user,company,problem:"Couldn't read Odoo employees: "+clean(e.message,200)};}
  if(employees.length!==1)return {ok:false,user,company,problem:employees.length?'The Odoo user '+user.name+' has more than one employee in '+company.name+'. Keep one.':'The Odoo user '+user.name+' has no active employee in '+company.name+'. In Odoo Employees, set Related user = '+user.name+' on one employee.'};
  return {ok:true,user,company,employee:{id:employees[0].id,name:String(employees[0].name||'')}};
}
// Odoo's lock dates for the company (timesheet and fiscal locks): work on or before it can't be logged.
export async function odooLockDate(env,companyId){
  if(!companyId)return null;
  const f=await odoo(env,'res.company','fields_get',[],{attributes:['type']});
  const names=Object.keys(f).filter(n=>f[n].type==='date'&&/lock_date$/.test(n)&&(/timesheet/.test(n)||['fiscalyear_lock_date','hard_lock_date'].includes(n)));
  if(!names.length)return null;
  const [c]=await odoo(env,'res.company','read',[[companyId]],{fields:names});
  return names.map(n=>c&&c[n]).filter(v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}/.test(v)).map(v=>v.slice(0,10)).sort().at(-1)||null;
}
async function cachedLockDate(env,cfg){
  const store=requireStore(env),raw=await store.get(K.lockDate(env));
  if(raw)return JSON.parse(raw).date;
  const date=await odooLockDate(env,cfg.verified?.company?.id).catch(()=>undefined);
  if(date!==undefined)await store.set(K.lockDate(env),JSON.stringify({date}),600);
  return date||null;
}
async function setupView(env,cfg){
  const out={config:cfg,odoo:odooConfigured(env),statuses:STATUS};
  if(!out.odoo)return out;
  try{
    const fields=await odooFields(env);
    const [defaults,projects]=await Promise.all([checkDefaults(env).catch(e=>({ok:false,problem:clean(e.message,200)})),odoo(env,'project.project','search_read',[[]],{fields:['name','partner_id'],order:'name',limit:2000})]);
    Object.assign(out,{fields,suggested:suggestFields(fields),defaults,lockDate:defaults.company?await odooLockDate(env,defaults.company.id).catch(()=>null):null,
      projects:projects.map(p=>({id:p.id,name:String(p.name||''),partner:Array.isArray(p.partner_id)?String(p.partner_id[1]||''):''}))});
  }catch(e){out.error="Couldn't read Odoo: "+clean(e.message,200);}
  // Clients and projects the dashboard knows, with the Odoo project each one sends work to.
  const catalog=await readCatalog(env);
  out.catalog=catalog.entries.filter(e=>!e.archived).map(e=>({id:e.id,name:shownName(e),parentId:e.parentId||null,odooProject:(e.sources||[]).find(s=>s.source==='odoo')?.row||null}));
  out.users=await usersList(env);
  return out;
}
async function usersList(env){
  const store=requireStore(env),emails=await store.smembers('users')||[];
  return (await Promise.all(emails.map(e=>getUser(store,e)))).filter(Boolean).map(u=>({email:u.email,name:u.name})).sort((a,b)=>a.name.localeCompare(b.name));
}
async function saveSetup(env,me,b){
  const store=requireStore(env),raw=await store.get(K.cfg(env)),cfg=await readConfig(env);
  if(!b||typeof b!=='object')problem('Send the work log setup.');
  if(b.revision!==cfg.revision)problem('Work log setup changed. Refresh and retry.',409,'conflict');
  const next=structuredClone(cfg);
  if('mode' in b){if(!['off','pilot','on'].includes(b.mode))problem('Choose Off, Pilot group or Everyone.');next.mode=b.mode;}
  if('pilot' in b){
    if(!Array.isArray(b.pilot)||b.pilot.length>100)problem('Choose up to 100 pilot users.');
    const known=new Set((await usersList(env)).map(u=>u.email));next.pilot=[...new Set(b.pilot.map(normEmail))];
    if(next.pilot.some(e=>!known.has(e)))problem('Pilot users must be dashboard users.');
  }
  if('fields' in b){
    if(!b.fields||typeof b.fields!=='object')problem('Choose the Odoo fields.');
    for(const r of FIELD_ROLES)if(r in b.fields){const v=b.fields[r];if(v!==''&&(typeof v!=='string'||!/^[a-z_][a-z0-9_]{0,62}$/.test(v)))problem('Invalid Odoo field name.');next.fields[r]=v;}
  }
  if('mapping' in b){
    if(!b.mapping||typeof b.mapping!=='object'||Array.isArray(b.mapping)||Object.keys(b.mapping).length>2000)problem('Invalid project mapping.');
    const catalog=await readCatalog(env),ids=new Set(catalog.entries.map(e=>e.id));next.mapping={};
    for(const [k,v] of Object.entries(b.mapping)){
      if(k!=='helpdesk'&&!ids.has(k))problem('Unknown client or project in the mapping.');
      if(v===null||v==='')continue;
      if(!Number.isInteger(v)||v<1)problem('Map to an Odoo project.');next.mapping[k]=v;
    }
  }
  const lineFields=['users','entryUuid','userUuid','lineRef'].map(r=>next.fields[r]).filter(Boolean);
  if(new Set(lineFields).size!==lineFields.length)problem('Each timesheet field must be a different Odoo field.');
  // Everything is checked against Odoo before it can be switched on: fields, projects, employee and company.
  if(odooConfigured(env)&&(next.mode!=='off'||Object.keys(next.mapping).length)){
    const projectIds=[...new Set(Object.values(next.mapping))];
    if(projectIds.length){
      const found=await odoo(env,'project.project','search_read',[[['id','in',projectIds]]],{fields:['active'],context:{active_test:false}});
      const ok=new Set(found.filter(p=>p.active!==false).map(p=>p.id)),bad=projectIds.filter(id=>!ok.has(id));
      if(bad.length)problem('Odoo project '+bad.map(i=>'#'+i).join(', ')+' was not found or is archived.');
    }
  }
  next.verified=null;
  if(next.mode!=='off'){
    if(!odooConfigured(env))problem("Odoo isn't connected, so work logging can't be switched on.");
    const missing=FIELD_ROLES.filter(r=>!next.fields[r]);
    if(missing.length)problem('Choose every Odoo field before switching on: '+missing.join(', ')+'.',400,'setup_incomplete');
    const fields=await odooFields(env),has=(list,n)=>list.some(f=>f.name===n),isCustom=n=>n.startsWith('x_');
    for(const r of ['users','entryUuid','userUuid','lineRef'])if(!has(fields.line,next.fields[r]))problem('Odoo timesheet lines have no editable text field '+next.fields[r]+'.',400,'setup_incomplete');
    for(const r of ['entryUuid','userUuid','lineRef'])if(!isCustom(next.fields[r]))problem('Reference fields must be custom fields (x_…): '+next.fields[r]+'.',400,'setup_incomplete');
    const defaults=await checkDefaults(env);
    if(!defaults.ok)problem("Can't switch on: "+defaults.problem,400,'setup_defaults');
    next.verified={ok:true,at:new Date().toISOString(),user:defaults.user,company:defaults.company,employee:defaults.employee};
    if(next.mode==='pilot'&&!next.pilot.length)problem('Choose at least one pilot user.');
  }
  next.revision++;next.updatedAt=new Date().toISOString();next.updatedBy={email:me.email,name:me.name};
  const saved=raw===null?await store.setIfAbsent(K.cfg(env),JSON.stringify(next),315360000):await store.compareAndSet(K.cfg(env),raw,JSON.stringify(next));
  if(!saved)problem('Work log setup changed. Refresh and retry.',409,'conflict');
  await store.del(K.lockDate(env));
  return next;
}

// ---- Entries ----
const isSynced=e=>e.state==='synced'&&!!e.lineId&&e.syncedRevision===e.revision;
const monthOf=d=>d.slice(0,7);
const pendingState=s=>s==='syncing'||s==='setup';
async function saveEntry(env,prevRaw,e){
  const prev=prevRaw?JSON.parse(prevRaw):null,add=[],rem=[];
  // The agreed-hours line is not one of the ticket's entries: it is in no list but the send queue.
  if(!e.agreed)add.push([K.ticket(env,e.ticket),e.id],[K.month(env,monthOf(e.date)),e.id]);
  (pendingState(e.state)?add:rem).push([K.pending(env),e.id]);
  if(prev&&!e.agreed&&monthOf(prev.date)!==monthOf(e.date))rem.push([K.month(env,monthOf(prev.date)),e.id]);
  const next=JSON.stringify(e);
  return await requireStore(env).writeIndexed(K.entry(env,e.id),prevRaw,next,add,rem)?next:null;
}
async function readEntry(env,id){const raw=await requireStore(env).get(K.entry(env,id));return raw?JSON.parse(raw):null;}
export async function ticketEntries(env,key){
  const store=requireStore(env),ids=await store.smembers(K.ticket(env,key))||[];
  return (await mget(store,ids.map(id=>K.entry(env,id)))).filter(Boolean).map(r=>JSON.parse(r)).sort((a,b)=>a.date.localeCompare(b.date)||a.createdAt.localeCompare(b.createdAt));
}
export function summarize(entries){
  const s={entries:entries.length,loggedMinutes:0,confirmedMinutes:0,pendingMinutes:0,unsynced:0};
  // Entries held for agreed hours are not waiting for Odoo: the agreed line is what goes there.
  for(const e of entries){s.loggedMinutes+=e.minutes;if(isSynced(e))s.confirmedMinutes+=e.minutes;else if(e.state!=='agreed'){s.pendingMinutes+=e.minutes;s.unsynced++;}}
  return s;
}
async function refreshSummary(env,key){const s=summarize(await ticketEntries(env,key));await requireStore(env).set(K.sum(env,key),JSON.stringify(s));return s;}
// The ticket list's totals: one database read for many tickets.
export async function readSummaries(env,keys){
  const out={};if(!env.STORE||!keys.length)return out;
  const raws=await mget(env.STORE,keys.map(k=>K.sum(env,k)));
  keys.forEach((k,n)=>{if(raws[n])out[k]=JSON.parse(raws[n]);});
  return out;
}
export function publicEntry(e,me){
  const admin=me.role==='admin',own=normEmail(me.email)===e.author.email;
  return {id:e.id,ticket:e.ticket,source:e.source,ticketTitle:e.ticketTitle,date:e.date,minutes:e.minutes,description:e.description,
    author:{name:e.author.name,...(admin||own?{email:e.author.email}:{})},createdAt:e.createdAt,revision:e.revision,
    status:e.state,statusLabel:STATUS[e.state],synced:isSynced(e),
    reason:e.state==='setup'?e.setup:e.state==='review'?e.review?.message:e.state==='syncing'?e.error||'':e.state==='agreed'?'Odoo gets the ticket\'s agreed hours instead of this entry.':'',reviewKind:e.state==='review'?e.review?.kind:'',
    ...(admin?{lineId:e.lineId,taskId:e.taskId,projectId:e.projectId,revisions:e.revisions,attempts:e.attempts||0}:{corrections:e.revisions.length})};
}
function checkInput(b,today,{partial=false}={}){
  const out={};
  if(!partial||'date' in b){
    const d=b.date,t=typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)?Date.parse(d+'T00:00:00Z'):NaN;
    if(!Number.isFinite(t)||new Date(t).toISOString().slice(0,10)!==d)problem('Choose a valid work date.');
    if(d>today)problem("The work date can't be in the future.",400,'future_date');
    const yearAgo=new Date(Date.parse(today+'T00:00:00Z')-366*86400000).toISOString().slice(0,10);
    if(d<yearAgo)problem('The work date can be at most a year ago.');
    out.date=d;
  }
  if(!partial||'minutes' in b){if(!Number.isInteger(b.minutes)||b.minutes<1||b.minutes>MAX_MINUTES)problem('Duration must be between 1 minute and 24 hours, in whole minutes.');out.minutes=b.minutes;}
  if(!partial||'description' in b){const t=typeof b.description==='string'?b.description.trim():'';if(!t)problem('Describe the work.');if(t.length>2000)problem('Keep the description under 2,000 characters.');out.description=t;}
  return out;
}
async function checkLock(env,cfg,dates){
  const lock=await cachedLockDate(env,cfg).catch(()=>null);
  if(lock&&dates.some(d=>d<=lock))problem('Odoo is locked up to '+lock+'. Choose a later date.',400,'date_locked',{lockDate:lock});
}
// A stable id for each dashboard user, kept in their account record (sent to Odoo instead of a person mapping).
export async function userUuid(env,email){
  const store=requireStore(env),k='u:'+normEmail(email);
  for(let attempt=0;attempt<4;attempt++){
    const raw=await store.get(k);if(!raw)problem('Your account was not found.',403,'forbidden');
    const u=JSON.parse(raw);if(u.uuid)return u.uuid;
    if(await store.compareAndSet(k,raw,JSON.stringify({...u,uuid:crypto.randomUUID()})))continue;
  }
  problem('Could not prepare your account for the work log. Try again.',409,'conflict');
}
async function withLock(env,what,fn,busy){
  const store=requireStore(env),k=K.lock(env,what),owner=crypto.randomUUID();
  if(!await store.setIfAbsent(k,owner,90))return busy();
  try{return await fn();}finally{await store.deleteIfValue(k,owner);}
}

// ---- Odoo sync ----
const taskName=e=>('['+e.ticket+'] '+(e.ticketTitle||'')).trim().slice(0,250);
async function destination(env,cfg,e){
  if(e.source==='odoo'){const pid=e.hdProjectId||cfg.mapping.helpdesk||null;return pid?{projectId:Number(pid)}:{setup:'This Odoo Helpdesk ticket has no project, and Work log setup has no default project for Helpdesk tickets.'};}
  const m=await readMetadata(env,e.ticket);
  if(!m.clientId)return {setup:'Choose a client and project for this ticket, so the work goes to the right Odoo project.'};
  const catalog=await readCatalog(env),client=catalog.entries.find(x=>x.id===m.clientId),sub=m.subClientId&&catalog.entries.find(x=>x.id===m.subClientId);
  if(sub){const pid=cfg.mapping[sub.id]||(sub.sources||[]).find(s=>s.source==='odoo')?.row;return pid?{projectId:Number(pid)}:{setup:'Project "'+shownName(sub)+'" has no Odoo project. Map it in Work log setup.'};}
  const pid=cfg.mapping[m.clientId];
  return pid?{projectId:Number(pid)}:{setup:'Choose a project for this ticket, or map client "'+shownName(client)+'" to an Odoo project in Work log setup.'};
}
async function verifyProject(env,pid){
  const [p]=await odoo(env,'project.project','search_read',[[['id','=',pid]]],{fields:['name','active'],context:{active_test:false},limit:1});
  return p&&p.active!==false?p:null;
}
async function ensureTask(env,cfg,e,projectId){
  const store=requireStore(env),k=K.task(env,e.ticket),raw=await store.get(k),t=raw?JSON.parse(raw):{};
  const put=v=>store.set(k,JSON.stringify(v));
  if(t.review)return {review:t.review};
  if(t.taskId){
    if(t.projectId!==projectId)return {review:"The ticket's Odoo project changed after its task #"+t.taskId+' was created in another project. Move the task in Odoo, then send again.'};
    return {taskId:t.taskId};
  }
  // The ticket's task in this project: named "[KEY] …" (an existing one is reused).
  const found=await odoo(env,'project.task','search_read',[[['project_id','=',projectId],['name','=like','['+e.ticket+'] %']]],{fields:['name'],context:{active_test:false},limit:5});
  if(found.length>1){const review='More than one Odoo task in the project is named ['+e.ticket+'] (tasks '+found.map(f=>'#'+f.id).join(', ')+'). Rename or merge the extra ones, then send again.';await put({review});return {review};}
  if(found.length===1){await put({taskId:found[0].id,projectId});return {taskId:found[0].id};}
  if(t.dispatch){const review='Creating the Odoo task for '+e.ticket+' had an unclear result and no task was found. Check Odoo, then send again.';await put({review});return {review};}
  await put({dispatch:{at:new Date().toISOString(),projectId}});
  let id;
  try{id=await odoo(env,'project.task','create',[{name:taskName(e),project_id:projectId}]);}
  catch(err){if(err.definite)await put({});throw err;}
  await put({taskId:Number(id),projectId});return {taskId:Number(id)};
}
function lineValues(cfg,e,{projectId,taskId}){
  const f=cfg.fields;
  return {name:e.description,date:e.date,unit_amount:e.minutes/60,project_id:projectId,task_id:taskId,[f.users]:e.author.name,[f.entryUuid]:e.id,[f.userUuid]:e.author.uuid,[f.lineRef]:e.source+':'+e.ticket};
}
const lineMatches=(l,e,taskId)=>l.date===e.date&&Math.round(Number(l.unit_amount)*60)===e.minutes&&(!taskId||m2o(l.task_id)===taskId);
const REFUSED=/ValidationError|UserError|AccessError|MissingError|AccessDenied/;
const backoff=n=>Math.min(60,2**n)*60000;

// Sends one entry (or its correction) to Odoo. Serialized per entry; returns the entry as saved.
export async function syncEntry(env,id,{force=false}={}){
  const result=await withLock(env,'e:'+id,async()=>{
    const store=requireStore(env);let raw=await store.get(K.entry(env,id));if(!raw)return null;let e=JSON.parse(raw);
    const save=async next=>{const r=await saveEntry(env,raw,next);if(!r)problem('The work entry changed. Refresh and retry.',409,'conflict');raw=r;e=next;return next;};
    if(isSynced(e)||e.state==='review')return e;
    // The agreed line was cleared before it reached Odoo: nothing to send.
    if(e.agreed&&e.state==='agreed')return e;
    if(!force&&e.nextTryAt&&e.nextTryAt>Date.now())return e;
    // While the ticket has agreed hours, its users' entries stay in the dashboard: Odoo gets the agreed line instead.
    if(!e.agreed&&!e.lineId&&(await readMetadata(env,e.ticket)).agreedHours!=null)return save({...e,state:'agreed',setup:'',error:'',nextTryAt:0});
    const cfg=await readConfig(env);
    if(!odooConfigured(env)||!configReady(cfg))return save({...e,state:'setup',setup:!odooConfigured(env)?"Odoo isn't connected.":"Work log setup isn't finished or is switched off. An administrator must complete it in Work log setup."});
    try{
      // A correction of a line Odoo already has: writing the same values again is harmless.
      if(e.lineId){
        await odoo(env,'account.analytic.line','write',[[e.lineId],{name:e.description,date:e.date,unit_amount:e.minutes/60,...(e.agreed?{[cfg.fields.users]:e.author.name}:{})}]);
        return save({...e,state:'synced',syncedRevision:e.revision,error:'',setup:'',attempts:0,nextTryAt:0});
      }
      const dest=await destination(env,cfg,e);
      if(dest.setup)return save({...e,state:'setup',setup:dest.setup});
      if(!await verifyProject(env,dest.projectId))return save({...e,state:'setup',setup:'Odoo project #'+dest.projectId+' was not found or is archived. Fix the mapping in Work log setup.'});
      const task=await withLock(env,'task:'+e.ticket,()=>ensureTask(env,cfg,e,dest.projectId),()=>({busy:true}));
      if(task.busy)return save({...e,state:'syncing',error:"Waiting for the ticket's Odoo task.",nextTryAt:Date.now()+60000});
      if(task.review)return save({...e,state:'review',review:{kind:'task',message:task.review}});
      // Always look for this entry's line first: it settles an earlier attempt whose result was unclear.
      const found=await odoo(env,'account.analytic.line','search_read',[[[cfg.fields.entryUuid,'=',e.id]]],{fields:['date','unit_amount','task_id'],limit:5});
      if(found.length>1)return save({...e,state:'review',review:{kind:'conflict',message:'Odoo has '+found.length+' timesheet lines for this entry (lines '+found.map(l=>'#'+l.id).join(', ')+'). Delete the extra ones in Odoo, then check again.',lines:found.map(l=>l.id)}});
      if(found.length===1){
        if(lineMatches(found[0],e,task.taskId))return save({...e,state:'synced',lineId:found[0].id,projectId:dest.projectId,taskId:task.taskId,syncedRevision:e.revision,dispatch:null,error:'',setup:'',attempts:0,nextTryAt:0});
        return save({...e,state:'review',review:{kind:'conflict',message:'Odoo line #'+found[0].id+' has this entry\'s id but a different date, duration or task. Fix it in Odoo or link it.',lines:[found[0].id]}});
      }
      if(e.dispatch)return save({...e,state:'review',review:{kind:'nomatch',message:'Sending to Odoo had an unclear result and no timesheet line was found. Check Odoo, then send it again or link the right line.'}});
      // Saved before the create is sent, so an unclear result is never sent blindly a second time.
      await save({...e,dispatch:{at:new Date().toISOString(),projectId:dest.projectId,taskId:task.taskId},projectId:dest.projectId,taskId:task.taskId});
      let lineId;
      try{lineId=await odoo(env,'account.analytic.line','create',[lineValues(cfg,e,{projectId:dest.projectId,taskId:task.taskId})]);}
      catch(err){if(err.definite)await save({...e,dispatch:null});throw err;}
      return save({...e,state:'synced',lineId:Number(lineId),syncedRevision:e.revision,dispatch:null,error:'',setup:'',attempts:0,nextTryAt:0});
    }catch(err){
      if(err instanceof BusinessError)throw err;
      const attempts=(e.attempts||0)+1,msg=clean(err&&err.message||'Odoo error',300);
      if(err&&err.definite&&REFUSED.test(err.kind||''))return save({...e,state:'review',review:{kind:'error',message:'Odoo refused it: '+msg},error:msg,attempts});
      if(attempts>=10&&!e.dispatch)return save({...e,state:'review',review:{kind:'error',message:'Odoo kept failing: '+msg},error:msg,attempts});
      return save({...e,state:'syncing',error:msg,attempts,nextTryAt:Date.now()+(e.dispatch?120000:backoff(attempts))});
    }
  },()=>readEntry(env,id));
  if(result)await refreshSummary(env,result.ticket);
  return result;
}

// ---- Agreed hours (administrators) ----
// Agreed hours put one Odoo line on the ticket instead of the users' entries. The line is a record of its own,
// id "agreed:<KEY>": dated the day the hours were first set (agreedDate), given to the ticket's developer, lasting
// the agreed hours (rounded to the minute). It goes through syncEntry like any entry. While the hours are set,
// the ticket's entries are held in the dashboard (state "agreed"); clearing them releases the entries.
export const agreedId=key=>'agreed:'+key;
export async function agreedLineSent(env,key){const r=await readEntry(env,agreedId(key));return !!(r&&r.lineId);}
export async function syncedEntryCount(env,key){return (await ticketEntries(env,key)).filter(isSynced).length;}
async function holdEntries(env,key,hold){
  for(const e of await ticketEntries(env,key)){
    const raw=JSON.stringify(e);
    if(hold&&!e.lineId&&e.state!=='review'&&e.state!=='agreed')await saveEntry(env,raw,{...e,state:'agreed',setup:'',error:'',nextTryAt:0});
    else if(!hold&&e.state==='agreed')await saveEntry(env,raw,{...e,state:'syncing',error:'',nextTryAt:0});
  }
}
// Called by saveMetadata after the agreed hours are saved: m.agreedHours (null clears them), m.agreedDate, m.agreedDeveloper.
export async function syncAgreedLine(env,key,m,{title='',me}){
  const id=agreedId(key),busy=()=>problem('The agreed hours are being sent to Odoo right now. Try again in a moment.',409,'busy');
  if(m.agreedHours==null){
    await withLock(env,'e:'+id,async()=>{const e=await readEntry(env,id);if(e&&!e.lineId&&e.state!=='agreed')await saveEntry(env,JSON.stringify(e),{...e,state:'agreed',setup:'',error:'',nextTryAt:0});},busy);
    return holdEntries(env,key,false);
  }
  await withLock(env,'e:'+id,async()=>{
    const prev=await readEntry(env,id),now=new Date().toISOString(),minutes=Math.round(m.agreedHours*60);
    const author={email:'',name:m.agreedDeveloper,uuid:'dev:'+m.agreedDeveloper};
    const e={...(prev||{id,ticket:key,source:sourceOf(env,key),createdAt:now,revision:0,syncedRevision:-1,lineId:null,taskId:null,projectId:null,dispatch:null,review:null,setup:'',error:'',attempts:0,nextTryAt:0,revisions:[]}),
      agreed:true,ticketTitle:clean(title,250)||prev?.ticketTitle||'',date:m.agreedDate,minutes,description:'Agreed hours for '+key,author};
    // A change to the hours, date or developer updates the same line; its date stays as it was first set.
    if(!prev||prev.minutes!==minutes||prev.date!==m.agreedDate||prev.author.name!==author.name){
      if(prev)e.revisions=[...prev.revisions,{n:prev.revision+1,at:now,by:{email:normEmail(me.email),name:me.name||me.email},reason:'Agreed hours changed',from:{date:prev.date,minutes:prev.minutes},to:{date:e.date,minutes}}];
      e.revision=prev?prev.revision+1:0;
      Object.assign(e,{state:'syncing',error:'',setup:'',attempts:0,nextTryAt:0,review:null});
    }
    if(!await saveEntry(env,prev?JSON.stringify(prev):null,e))problem('The agreed hours changed while saving. Refresh and retry.',409,'conflict');
  },busy);
  await holdEntries(env,key,true);
  // Sent now; if Odoo is unreachable the line stays queued and the scheduled sync retries it.
  try{await syncEntry(env,id,{force:true});}catch{}
}

// The overage flag is shown to everyone; the hours over are shown to administrators only (they reveal the agreed hours).
export const overageView=(me,agreed,loggedMinutes)=>{const {overage,overHours}=overageOf(agreed,loggedMinutes);return me.role==='admin'?{overage,overHours}:{overage};};

// Per ticket, for the business report: the hours each person logged and where Odoo stands with them.
export async function reportWork(env,rows){
  const out={};
  for(let i=0;i<rows.length;i+=12)await Promise.all(rows.slice(i,i+12).map(async({key,agreedHours})=>{
    const entries=await ticketEntries(env,key),byName=new Map();
    for(const e of entries)byName.set(e.author.name,(byName.get(e.author.name)||0)+e.minutes);
    let odoo;
    if(agreedHours!=null){const line=await readEntry(env,agreedId(key));odoo=!line?'Not sent':isSynced(line)?'Synced':'Waiting to sync';}
    else odoo=!entries.length?'No work logged':entries.some(e=>!isSynced(e))?'Waiting to sync':'Synced';
    out[key]={odoo,employees:[...byName].map(([name,minutes])=>({name,hours:Math.round(minutes/60*100)/100}))};
  }));
  return out;
}

// ---- Closure gate ----
// Every route that closes a ticket calls this under the ticket lock. All the ticket's work entries and their
// corrections must be in Odoo, confirmed by one batched read. No override.
export async function timeClosureErrors(env,key){
  if(!env.STORE?.writeIndexed)return [];
  // With agreed hours, the ticket's entries are held in the dashboard: the agreed line must be in Odoo instead.
  const agreed=(await readMetadata(env,key)).agreedHours??null;
  const entries=await ticketEntries(env,key),agreedLine=agreed!=null?await readEntry(env,agreedId(key)):null;
  if(!entries.length&&agreed==null)return [];
  const held=e=>agreed!=null&&e.state==='agreed';
  const waiting=entries.filter(e=>!isSynced(e)&&!held(e));
  if(waiting.length)return [waiting.length+' work '+(waiting.length===1?'entry is':'entries are')+' not in Odoo yet ('+[...new Set(waiting.map(e=>STATUS[e.state]))].join(', ')+')'];
  if(agreed!=null&&!(agreedLine&&isSynced(agreedLine)))return ['The agreed hours ('+agreed+' h) are not in Odoo yet'+(agreedLine?' ('+STATUS[agreedLine.state]+')':'')];
  const checked=[...entries.filter(isSynced),...(agreed!=null?[agreedLine]:[])];
  const cfg=await readConfig(env);let lines;
  try{lines=await odoo(env,'account.analytic.line','search_read',[[['id','in',checked.map(e=>e.lineId)]]],{fields:['date','unit_amount',...(cfg.fields.entryUuid?[cfg.fields.entryUuid]:[])]});}
  catch(err){return ["Couldn't confirm the work log with Odoo: "+clean(err.message,200)];}
  const byId=new Map(lines.map(l=>[l.id,l]));
  const bad=checked.filter(e=>{const l=byId.get(e.lineId);return !l||!lineMatches(l,e)||(cfg.fields.entryUuid&&l[cfg.fields.entryUuid]!==e.id);});
  if(!bad.length)return [];
  // Changed or deleted in Odoo: these go to an administrator.
  for(const e of bad){const raw=JSON.stringify(e);await saveEntry(env,raw,{...e,state:'review',review:{kind:'conflict',message:byId.get(e.lineId)?'Odoo line #'+e.lineId+' was changed in Odoo and no longer matches this entry.':'Odoo line #'+e.lineId+' was deleted in Odoo.',lines:[e.lineId]}}).catch(()=>null);}
  await refreshSummary(env,key);
  return [bad.length+' work '+(bad.length===1?'entry no longer matches':'entries no longer match')+' Odoo (changed or deleted there). An administrator must review them'];
}

// ---- HTTP ----
async function body(request){const raw=await request.text();if(raw.length>20000)problem('Request too large.',413);try{return raw?JSON.parse(raw):{};}catch{problem('Invalid request.');}}
async function ticketView(env,me,key,t){
  const cfg=await readConfig(env),source=sourceOf(env,key),entries=await ticketEntries(env,key),summary=summarize(entries);
  await requireStore(env).set(K.sum(env,key),JSON.stringify(summary));
  const meta=source==='odoo'?{}:await readMetadata(env,key),baselineHours=source==='odoo'?null:meta.actualHours;
  const allowed=canLog(cfg,me);
  let destination=null;
  if(allowed&&odooConfigured(env)){
    try{
      const d=await destinationFor(env,cfg,{ticket:key,source,hdProjectId:t.projectId||null});
      if(d.setup)destination={setup:d.setup};
      else{
        const p=await verifyProject(env,d.projectId),raw=await requireStore(env).get(K.task(env,key)),task=raw?JSON.parse(raw):{};
        destination=!p?{setup:'Odoo project #'+d.projectId+' was not found or is archived.'}:{projectId:d.projectId,projectName:String(p.name||''),taskId:task.taskId||null,taskName:task.taskId&&task.projectId===d.projectId?'Task #'+task.taskId:'['+key+'] '+(t.title||'')+' (created with the first entry)'};
      }
    }catch(e){destination={error:"Couldn't read the destination from Odoo: "+clean(e.message,200)};}
  }
  return {ticket:key,source,closed:!!t.closed,logging:cfg.mode!=='off',canLog:allowed&&!t.closed,today:todayIn(),maxMinutes:MAX_MINUTES,
    lockDate:allowed?await cachedLockDate(env,cfg).catch(()=>null):null,entries:entries.map(e=>publicEntry(e,me)),summary,
    baselineHours,totalHours:totalHours(baselineHours,summary.loggedMinutes),...overageView(me,meta.agreedHours??null,summary.loggedMinutes),destination};
}
const destinationFor=(env,cfg,e)=>destination(env,cfg,e);

async function createEntry(env,me,b,readTicket){
  const store=requireStore(env),key=b.ticket,source=sourceOf(env,key);
  if(typeof b.id!=='string'||!UUID.test(b.id))problem('Missing entry id. Refresh and retry.');
  if(!source)problem('Choose a ticket.');
  const cfg=await readConfig(env);
  if(!canLog(cfg,me))problem("Work logging isn't switched on for you yet.",403,'time_off');
  const input=checkInput(b,todayIn());
  const uuid=await userUuid(env,me.email);
  const replay=existing=>{if(existing.author.email!==normEmail(me.email)||existing.ticket!==key)problem('This entry id is already used.',409,'conflict');return {entry:existing,replay:true};};
  const out=await withTicketLock(env,key,async()=>{
    // Read inside the lock: a ticket being closed at the same moment can't get new work.
    const t=await readTicket(key);if(!t)problem('Ticket unavailable.',404,'not_found');
    if(t.closed)problem('This ticket is closed. Reopen it before logging work.',409,'ticket_closed');
    const existing=await readEntry(env,b.id);if(existing)return replay(existing);
    await checkLock(env,cfg,[input.date]);
    const at=new Date().toISOString();
    const e={id:b.id,ticket:key,source,ticketTitle:clean(t.title,250),...input,author:{email:normEmail(me.email),name:me.name||me.email,uuid},createdAt:at,
      revision:0,syncedRevision:-1,state:'syncing',lineId:null,taskId:null,projectId:null,dispatch:null,review:null,setup:'',error:'',attempts:0,nextTryAt:0,revisions:[],
      ...(source==='odoo'&&t.projectId?{hdProjectId:t.projectId}:{})};
    if(!await saveEntry(env,null,e))return replay(await readEntry(env,b.id));
    await recordTicketEvent(env,key,me,{action:'work',text:'Logged '+formatMinutes(e.minutes)+' on '+e.date+': '+e.description});
    return {entry:e};
  });
  let entry=out.entry;
  if(!out.replay){try{entry=await syncEntry(env,entry.id,{force:true})||entry;}catch{entry=await readEntry(env,entry.id)||entry;}}
  return {entry,created:!out.replay,summary:await refreshSummary(env,key)};
}

async function correctEntry(env,me,id,b,readTicket){
  if(me.role!=='admin')problem('Only administrators can correct work entries.',403,'forbidden');
  const reason=typeof b.reason==='string'?b.reason.trim():'';
  if(!reason)problem('Give a reason for the correction.',400,'reason_required');
  if(reason.length>1000)problem('Keep the reason under 1,000 characters.');
  const first=await readEntry(env,id);if(!first)problem('Work entry not found.',404,'not_found');
  const patch=checkInput(b,todayIn(),{partial:true});
  if(!Object.keys(patch).length)problem('Change the date, duration or description.');
  const cfg=await readConfig(env);
  await withTicketLock(env,first.ticket,async()=>{
    const t=await readTicket(first.ticket);if(!t)problem('Ticket unavailable.',404,'not_found');
    if(t.closed)problem('This ticket is closed. Reopen it before correcting its work log.',409,'ticket_closed');
    return withLock(env,'e:'+id,async()=>{
      const raw=await requireStore(env).get(K.entry(env,id)),e=JSON.parse(raw);
      if(b.revision!==e.revision)problem('This entry changed. Refresh and retry.',409,'conflict');
      if(e.dispatch&&!e.lineId)problem('This entry is being sent to Odoo. Wait until it is synced or needs review.',409,'busy');
      const from={date:e.date,minutes:e.minutes,description:e.description},to={...from,...patch};
      if(JSON.stringify(from)===JSON.stringify(to))problem('Nothing changed.');
      await checkLock(env,cfg,e.lineId?[from.date,to.date]:[to.date]);
      const at=new Date().toISOString(),n=e.revision+1;
      const next={...e,...to,revision:n,revisions:[...e.revisions,{n,at,by:{email:normEmail(me.email),name:me.name||me.email},reason,from,to}],
        state:e.state==='review'||e.state==='setup'?e.state:'syncing',nextTryAt:0,attempts:0,error:''};
      if(!await saveEntry(env,raw,next))problem('This entry changed. Refresh and retry.',409,'conflict');
      await recordTicketEvent(env,first.ticket,me,{action:'work',text:'Corrected work entry of '+e.date+' ('+formatMinutes(from.minutes)+' → '+formatMinutes(to.minutes)+(to.date!==from.date?', date '+to.date:'')+'): '+reason});
    },()=>problem('This entry is being sent to Odoo right now. Try again in a moment.',409,'busy'));
  });
  let entry;try{entry=await syncEntry(env,id,{force:true});}catch{entry=await readEntry(env,id);}
  return {entry,summary:await refreshSummary(env,first.ticket)};
}

// retry: anyone who can see it (Syncing / Needs setup). Administrators, for Needs review:
// check (search Odoo again), resend (clear the unclear attempt and send), link (to an existing Odoo line).
async function syncAction(env,me,id,b,readTicket){
  const e=await readEntry(env,id);if(!e)problem('Work entry not found.',404,'not_found');
  if(!await readTicket(e.ticket))problem('Work entry not found.',404,'not_found');
  const action=b.action||'retry',admin=me.role==='admin';
  if(action==='retry'){
    if(!admin&&e.author.email!==normEmail(me.email))problem('Only the author or an administrator can retry.',403,'forbidden');
    if(e.state==='review')problem('An administrator must review this entry.',409,'needs_review');
  }else{
    if(!admin)problem('Only administrators can reconcile work entries.',403,'forbidden');
    if(e.state!=='review')problem('This entry does not need review.',409,'conflict');
    const store=requireStore(env);
    const reopened=await withLock(env,'e:'+id,async()=>{
      const raw=await store.get(K.entry(env,id)),cur=JSON.parse(raw);
      let next={...cur,state:'syncing',review:null,error:'',attempts:0,nextTryAt:0};
      if(action==='resend'){
        next.dispatch=null;
        if(cur.review?.kind==='task')await store.del(K.task(env,cur.ticket));
      }else if(action==='link'){
        const lineId=Number(b.lineId),cfg=await readConfig(env);
        if(!Number.isInteger(lineId)||lineId<1)problem('Enter the Odoo timesheet line number.');
        const [l]=await odoo(env,'account.analytic.line','search_read',[[['id','=',lineId]]],{fields:['date','unit_amount','task_id','project_id',cfg.fields.entryUuid].filter(Boolean),limit:1});
        if(!l)problem('Odoo line #'+lineId+' was not found.',404,'not_found');
        if(cfg.fields.entryUuid&&l[cfg.fields.entryUuid]&&l[cfg.fields.entryUuid]!==cur.id)problem('Odoo line #'+lineId+' belongs to another work entry.',409,'conflict');
        if(!lineMatches(l,cur))problem('Odoo line #'+lineId+' has a different date or duration ('+l.date+', '+formatMinutes(Math.round(Number(l.unit_amount)*60))+').',409,'conflict');
        const refs={[cfg.fields.users]:cur.author.name,[cfg.fields.entryUuid]:cur.id,[cfg.fields.userUuid]:cur.author.uuid,[cfg.fields.lineRef]:cur.source+':'+cur.ticket,name:cur.description};
        await odoo(env,'account.analytic.line','write',[[lineId],refs]);
        next={...next,state:'synced',lineId,taskId:m2o(l.task_id),projectId:m2o(l.project_id),syncedRevision:cur.revision,dispatch:null};
      }else if(action!=='check')problem('Unknown action.');
      if(!await saveEntry(env,raw,next))problem('This entry changed. Refresh and retry.',409,'conflict');
      return true;
    },()=>problem('This entry is being sent to Odoo right now. Try again in a moment.',409,'busy'));
    if(reopened)await recordTicketEvent(env,e.ticket,me,{action:'work',text:'Work entry of '+e.date+': '+(action==='link'?'linked to Odoo line #'+b.lineId:action==='resend'?'sent to Odoo again':'checked in Odoo again')});
  }
  const entry=await syncEntry(env,id,{force:true});
  return {entry,summary:await refreshSummary(env,e.ticket)};
}

// Work entries in a date range, for the report (users: their own; administrators: everyone's).
async function report(env,me,url){
  const today=todayIn(),from=url.searchParams.get('from')||today.slice(0,8)+'01',to=url.searchParams.get('to')||today;
  for(const d of [from,to])if(!/^\d{4}-\d{2}-\d{2}$/.test(d))problem('Choose valid dates.');
  if(from>to)problem('The start date is after the end date.');
  if(Date.parse(to)-Date.parse(from)>400*86400000)problem('Choose at most about a year.');
  const months=[];for(let d=new Date(from.slice(0,7)+'-01T00:00:00Z');d.toISOString().slice(0,7)<=to.slice(0,7);d.setUTCMonth(d.getUTCMonth()+1))months.push(d.toISOString().slice(0,7));
  const store=requireStore(env),ids=[...new Set((await Promise.all(months.map(m=>store.smembers(K.month(env,m))))).flat())];
  let entries=[];for(let i=0;i<ids.length;i+=200)entries.push(...(await mget(store,ids.slice(i,i+200).map(id=>K.entry(env,id)))).filter(Boolean).map(r=>JSON.parse(r)));
  entries=entries.filter(e=>e.date>=from&&e.date<=to&&(me.role==='admin'||e.author.email===normEmail(me.email))).sort((a,b)=>a.date.localeCompare(b.date)||a.createdAt.localeCompare(b.createdAt));
  const tickets=[...new Set(entries.filter(e=>e.source!=='odoo').map(e=>e.ticket))],catalog=await readCatalog(env);
  const metas=await mget(store,tickets.map(k=>metadataKey(env,k))),meta={};tickets.forEach((k,n)=>{meta[k]=JSON.parse(metas[n]||'{}');});
  const name=id=>shownName(catalog.entries.find(e=>e.id===id));
  return {from,to,timeZone:TIME_ZONE,statuses:STATUS,
    rows:entries.map(e=>{const m=meta[e.ticket]||{};return {...publicEntry(e,me),user:e.author.name,clientId:m.clientId||null,clientName:name(m.clientId),subClientId:m.subClientId||null,subClientName:name(m.subClientId)};}),
    // The hours entered before the work log (per ticket), kept apart from the logged entries.
    baselines:tickets.map(k=>({ticket:k,hours:meta[k].actualHours??null})).filter(b=>b.hours!=null)};
}

export async function timeRoutes(request,env,url,me,{readTicket}){
  requireStore(env);
  if(!env.STORE.writeIndexed)problem('The work log needs the updated database.',503,'no_store');
  const path=url.pathname,method=request.method;
  if(path==='/time-entries/setup'){
    if(me.role!=='admin')problem('Only administrators manage the work log setup.',403,'forbidden');
    if(method==='GET')return json(await setupView(env,await readConfig(env)));
    if(method==='PUT'){const cfg=await saveSetup(env,me,await body(request));return json(await setupView(env,cfg));}
    problem('Use GET or PUT.',405,'method');
  }
  if(path==='/time-entries/report'&&method==='GET')return json(await report(env,me,url));
  if(path==='/time-entries'){
    if(method==='GET'){
      const key=url.searchParams.get('ticket');if(!sourceOf(env,key))problem('Choose a ticket.');
      // Logging off and nothing logged on this ticket: nothing to show, so no ticket read is needed.
      if((await readConfig(env)).mode==='off'&&!(await env.STORE.smembers(K.ticket(env,key))||[]).length)return json({ticket:key,logging:false,canLog:false,entries:[],summary:summarize([])});
      const t=await readTicket(key);if(!t)problem('Ticket unavailable.',404,'not_found');
      return json(await ticketView(env,me,key,t));
    }
    if(method==='POST'){const r=await createEntry(env,me,await body(request),readTicket);return json({entry:publicEntry(r.entry,me),summary:r.summary},r.created?201:200);}
    problem('Use GET or POST.',405,'method');
  }
  // A ticket's agreed-hours line ("agreed:<KEY>") can be checked and resent like an entry; only an administrator can, since no user wrote it.
  const m=/^\/time-entries\/((?:[0-9a-f-]{36})|agreed(?::|%3A)[A-Z][A-Z0-9_]*-[0-9]+)(\/sync)?$/.exec(path);
  const id=m&&decodeURIComponent(m[1]);
  if(m&&!m[2]&&method==='PATCH'&&id.startsWith('agreed:'))problem('Change the agreed hours on the ticket instead.',409,'agreed_line');
  if(m&&!m[2]&&method==='PATCH'){const r=await correctEntry(env,me,id,await body(request),readTicket);return json({entry:publicEntry(r.entry,me),summary:r.summary});}
  if(m&&m[2]&&method==='POST'){const r=await syncAction(env,me,id,await body(request),readTicket);return json({entry:publicEntry(r.entry,me),summary:r.summary});}
  problem('Not found.',404,'not_found');
}

// The background sync (every 5 minutes, from a scheduler holding TIME_SYNC_SECRET in the Authorization
// header): due entries in small batches, stopping well inside the 60-second function limit.
async function sameSecret(a,b){
  const h=async s=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
  const [x,y]=await Promise.all([h(a),h(b)]);let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0;
}
export async function timeSyncCron(request,env,{batch=25,budgetMs=40000}={}){
  const secret=env.TIME_SYNC_SECRET||'';
  if(secret.length<24)return json({code:'sync_off',error:'The work log sync secret is not configured.'},503);
  if(!await sameSecret(request.headers.get('Authorization')||'','Bearer '+secret))return json({code:'forbidden',error:'Invalid sync secret.'},403);
  if(request.method!=='POST')return json({code:'method',error:'Use POST.'},405);
  if(!env.STORE?.writeIndexed)return json({skipped:'no database'});
  const started=Date.now(),store=env.STORE,ids=(await store.smembers(K.pending(env))||[]).slice(0,1000);
  const entries=[];for(let i=0;i<ids.length;i+=200)entries.push(...(await mget(store,ids.slice(i,i+200).map(id=>K.entry(env,id)))).filter(Boolean).map(r=>JSON.parse(r)));
  const due=entries.filter(e=>pendingState(e.state)&&(!e.nextTryAt||e.nextTryAt<=Date.now())).sort((a,b)=>(a.nextTryAt||0)-(b.nextTryAt||0)||a.createdAt.localeCompare(b.createdAt)).slice(0,batch);
  const counts={synced:0,syncing:0,setup:0,review:0,failed:0};let processed=0;
  for(const e of due){
    if(Date.now()-started>budgetMs)break;
    try{const r=await syncEntry(env,e.id);counts[r?.state||'failed']++;}catch{counts.failed++;}
    processed++;
  }
  return json({pending:ids.length,due:due.length,processed,...counts,ms:Date.now()-started});
}
