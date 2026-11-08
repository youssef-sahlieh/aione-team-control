// Private dashboard business data. Never include these fields in Jira mutations.
import { odoo, odooConfigured } from './odoo.js';
import { timeClosureErrors, ticketEntries, summarize, readSummaries, syncAgreedLine, agreedLineSent, syncedEntryCount, todayIn, readConfig, ticketTask } from './time-entries.js';
export const INTERNAL_ASSIGNEE = '__internal_tickets';
export class BusinessError extends Error {
  constructor(message, status=400, code='ticket_metadata', details={}) { super(message); Object.assign(this,{status,code,details}); }
}
const problem=(message,status=400,code='ticket_metadata',details={})=>{throw new BusinessError(message,status,code,details);};
export const businessResponse = e => Response.json({code:e.code,error:e.message,...e.details},{status:e.status,headers:{'Cache-Control':'no-store'}});
export function requireStore(env) {
  if (!env.STORE?.compareAndSet || !env.STORE?.setIfAbsent || !env.STORE?.deleteIfValue) problem('Ticket business fields require the persistent database.',503,'no_store');
  return env.STORE;
}
const prefix=env=>'business:'+env.JIRA_PROJECT+':';
const empty=()=>({revision:0,odooProjectId:null,clientId:null,subClientId:null,billing:null,agreedHours:null,agreedDate:null,agreedDeveloper:null,estimatedHours:null,actualHours:null,workDone:'',dashPriority:null,dashOrder:null,completedAt:null,epicKey:null,history:[]});
// The dashboard's own priority. It is stored only here, never sent to Jira (Jira's priority is a separate field).
export const DASH_PRIORITIES=['High','Medium','Low'];
// Priorities saved before the three levels existed, read as the nearest new value. Stored records are not rewritten
// until someone edits the ticket.
const LEGACY_DASH={Highest:['High',1],Critical:['High',1],Blocker:['High',1],High:['High',null],Medium:['Medium',null],Low:['Low',null],Lowest:['Low',null]};
export function migrateDash(m){
  if(m.dashPriority==null||DASH_PRIORITIES.includes(m.dashPriority))return m;
  const [level,order]=LEGACY_DASH[m.dashPriority]||[null,null];
  return {...m,dashPriority:level,dashOrder:m.dashOrder??order};
}
// Fields only administrators see: billing, and the agreed hours with the date and developer they went to Odoo with.
const ADMIN_ONLY=['billing','agreedHours','agreedDate','agreedDeveloper'];
export const catalogKey=env=>prefix(env)+'catalog';
export const metadataKey=(env,key)=>prefix(env)+'ticket:'+key;
export async function readCatalog(env) { return JSON.parse(await requireStore(env).get(catalogKey(env)) || '{"revision":0,"entries":[]}'); }
export async function readMetadata(env,key) { return migrateDash({...empty(),...JSON.parse(await requireStore(env).get(metadataKey(env,key)) || '{}')}); }
// The name shown for a client or project: the AI name an administrator chose, else its Odoo name.
export const shownName=e=>e?(e.aiName||e.name):'';
// projects: projectIndex(readOdooProjects) when the caller has it, for the Odoo project's name, client and archive flag.
export function publicMetadata(record,me,catalog,projects) {
  const {history,...m}=record;
  const visible=me.role==='admin'?m:Object.fromEntries(Object.entries(m).filter(([k])=>!ADMIN_ONLY.includes(k)));
  const sel=selectionOf(m,catalog,projects),client=catalog?.entries.find(e=>e.id===sel.clientId),sub=catalog?.entries.find(e=>e.id===sel.subClientId);
  const p=m.odooProjectId?projects?.get(m.odooProjectId):null;
  return {...visible,...sel,clientName:client?shownName(client):p?.clientName||'',subClientName:sub?shownName(sub):p?.name||'',odooProject:m.odooProjectId?projectView(m.odooProjectId,p):null};
}
// What a ticket shows of its Odoo project. known is false while the snapshot doesn't have it (not synced yet, or not in the main company).
export const projectView=(id,p)=>p?{id,name:p.name,clientName:p.clientName||'',label:p.label,archived:!p.active,missingClient:!p.clientId,known:true}:{id,name:'Odoo project #'+id,clientName:'',label:'Odoo project #'+id,archived:false,missingClient:false,known:false};
export function publicHistory(m,me) {
  return m.history.map(h=>me.role==='admin'?h:{...h,changes:Object.fromEntries(Object.entries(h.changes||{}).filter(([k])=>!ADMIN_ONLY.includes(k)))})
    .filter(h=>me.role==='admin'||h.type!=='override').filter(h=>h.type!=='edit'||Object.keys(h.changes).length);
}
// Billing before assignment is only enforced when BILLING_REQUIRED is on (settings.js).
export const billingRequired = env => String(env?.BILLING_REQUIRED ?? '').toLowerCase() === 'true';
export function requireBilling(record, env) {
  if(!billingRequired(env))return;
  if(!['billable','not_billable'].includes(record?.billing))problem('Choose Billable or Not billable before assigning this ticket.',400,'billing_required');
}
export function validHours(n) { return typeof n==='number' && Number.isFinite(n) && n>0 && n<=1000000 && Math.round(n*100)/100===n; }
// The client is optional for now: no client is fine anywhere (saving, moving status, closing); a client or
// project that is chosen must be valid. Any project can go with any client (not only the client's own ones).
export function selectionErrors(catalog,m,{active=false}={}) {
  if(!m.clientId&&!m.subClientId)return [];
  const client=catalog.entries.find(e=>e.id===m.clientId&&!e.parentId),errors=[];
  if(!client || (active&&client.archived))return ['Choose a client'];
  const children=catalog.entries.filter(e=>e.parentId===client.id&&!e.archived);
  const sub=catalog.entries.find(e=>e.id===m.subClientId&&e.parentId);
  if(m.subClientId&&(!sub||(active&&sub.archived)))errors.push('Choose a valid project');
  else if(!m.subClientId&&children.length)errors.push('Choose a project');
  return errors;
}
// With a work log, actual hours are the hours entered before it (the baseline) plus the logged work.
export function withLogged(m,summary){const minutes=summary?.loggedMinutes||0;return minutes?{...m,actualHours:Math.round(((Number(m.actualHours)||0)+minutes/60)*100)/100}:m;}
// Logged entries against the agreed hours: "overage" (Needs checkup) when the logged work is above them, "ok"
// when it is not, null when no agreed hours are set. Only the logged entries count. Computed on every read.
export function overageOf(agreedHours,loggedMinutes){
  if(agreedHours==null||loggedMinutes==null)return {overage:null,overHours:0};
  const over=(loggedMinutes||0)-agreedHours*60;
  return over>1e-9?{overage:'overage',overHours:Math.round(over/60*100)/100}:{overage:'ok',overHours:0};
}
export function closureErrors(catalog,m) {
  return [...selectionErrors(catalog,m),...(!validHours(m.estimatedHours)?['Enter estimated hours greater than zero']:[]),...(!validHours(m.actualHours)?['Enter actual hours greater than zero']:[]),...(!m.workDone?.trim()?['Describe the work done']:[])];
}
export async function withTicketLock(env,key,fn) {
  const store=requireStore(env),lock=metadataKey(env,key)+':lock',owner=crypto.randomUUID();
  if(!await store.setIfAbsent(lock,owner,120))problem('This ticket is being changed. Refresh and retry.',409,'conflict');
  try { return await fn(); } finally { await store.deleteIfValue(lock,owner); }
}
async function persist(env,key,m,previous) {
  const store=requireStore(env),k=metadataKey(env,key),next=JSON.stringify(m);
  const saved=previous===null?await store.setIfAbsent(k,next,315360000):await store.compareAndSet(k,previous,next);
  if(!saved)problem('Ticket fields changed. Refresh and retry.',409,'conflict');
}
// ticket: {title, assignee} from the ticket read, for the agreed hours' Odoo line.
export async function saveMetadata(env,key,patch,me,{closed=false,creating=false,ticket={}}={}) {
  const store=requireStore(env),raw=await store.get(metadataKey(env,key)),old=migrateDash({...empty(),...JSON.parse(raw||'{}')}),m=structuredClone(old),catalog=await readCatalog(env);
  if(closed)problem('Reopen this ticket before editing its business fields.',409,'ticket_closed');
  if(!patch || typeof patch!=='object'||Array.isArray(patch))problem('Invalid ticket fields.');
  const allowed=['revision','odooProjectId','clientId','subClientId','billing','agreedHours','estimatedHours','actualHours','workDone','dashPriority','dashOrder'];
  if(Object.keys(patch).some(k=>!allowed.includes(k)))problem('Unknown ticket business field.');
  if(!Number.isInteger(patch.revision)||patch.revision!==old.revision)problem('Ticket fields changed. Refresh and retry.',409,'conflict');
  if(me.role!=='admin'&&'billing' in patch)problem('Only administrators can access billing.',403,'forbidden');
  if(me.role!=='admin'&&'agreedHours' in patch)problem('Only administrators can set agreed hours.',403,'forbidden');
  if(me.role!=='admin'&&!creating&&('dashPriority' in patch||'dashOrder' in patch))problem('Only administrators can set the priority.',403,'forbidden');
  // Anyone may choose a client or project while it is empty; after that only administrators can change it.
  const placed=old.odooProjectId!=null||!!old.clientId||!!old.subClientId;
  if(me.role!=='admin'&&!creating&&placed&&['odooProjectId','clientId','subClientId'].some(k=>k in patch&&patch[k]!==old[k]))problem('Only administrators can change the client or project once it is set.',403,'forbidden');
  // With Odoo connected the client is never chosen: it is the Odoo project's (selection by catalog ids is for a dashboard without Odoo).
  const odooOn=odooConfigured(env);
  if(odooOn&&['clientId','subClientId'].some(k=>k in patch))problem('The client comes from the Odoo project. Choose an Odoo project instead.',400,'project_required');
  let moved=null;
  if('odooProjectId' in patch&&patch.odooProjectId!==old.odooProjectId){
    const id=patch.odooProjectId;
    if(id===null)problem("A ticket's Odoo project can be changed but not removed.",400,'project_required');
    const p=await chosenProject(env,id);
    const sub=catalogProjectFor(catalog,id,p);
    Object.assign(m,{odooProjectId:id,clientId:sub?sub.parentId:null,subClientId:sub?sub.id:null,epicKey:null});
    moved={from:old.odooProjectId,to:id,toLabel:p.label};
  }
  // Once an estimate is set, only an administrator can change it.
  if(me.role!=='admin'&&'estimatedHours' in patch&&old.estimatedHours!=null&&Number(patch.estimatedHours)!==Number(old.estimatedHours))problem('The estimate is already set. Ask an administrator to change it.',403,'estimate_locked');
  for(const k of ['clientId','subClientId'])if(k in patch){if(patch[k]!==null&&(typeof patch[k]!=='string'||patch[k].length>80))problem('Invalid client selection.');m[k]=patch[k];}
  if('clientId' in patch && patch.clientId!==old.clientId && !('subClientId' in patch))m.subClientId=null;
  // A client chosen by hand stops following the ticket's epic (see epic-map.js).
  if(m.clientId!==old.clientId||m.subClientId!==old.subClientId)m.epicKey=null;
  // A new internal ticket may be opened without a client (it's needed later, to close it). With Odoo, a new ticket needs its project.
  if(creating&&odooOn&&m.odooProjectId==null)problem('Choose the Odoo project for this ticket.',400,'project_required');
  const noClient=(creating&&!m.clientId&&!m.subClientId)||!!moved;
  if(('clientId' in patch||'subClientId' in patch)&&!noClient){const errors=selectionErrors(catalog,m,{active:m.clientId!==old.clientId||m.subClientId!==old.subClientId});if(errors.length)problem(errors.join('. '));}
  if('billing' in patch){if(![null,'billable','not_billable'].includes(patch.billing))problem('Choose Billable or Not billable.');m.billing=patch.billing;}
  for(const k of ['estimatedHours','actualHours'])if(k in patch){if(patch[k]!==null&&!validHours(patch[k]))problem(k+': enter a positive number with up to two decimal places (maximum 1,000,000).');m[k]=patch[k];}
  // Agreed hours (null clears them). Odoo gets one line for them, dated the day they were first set and given to
  // the ticket's developer, so setting them needs an assignee. Once that line is in Odoo they can't be cleared.
  if('agreedHours' in patch){
    if(patch.agreedHours!==null&&!validHours(patch.agreedHours))problem('Agreed hours: enter a positive number with up to two decimal places (maximum 1,000,000).');
    if(patch.agreedHours===null&&old.agreedHours!=null&&await agreedLineSent(env,key))problem('The agreed hours are already in Odoo. Change them instead of clearing them.',409,'agreed_sent');
    if(patch.agreedHours!==null){
      const developer=ticket.assignee&&ticket.assignee!==INTERNAL_ASSIGNEE?String(ticket.assignee):'';
      if(!developer)problem('Assign a developer first.',409,'agreed_needs_developer');
      m.agreedDeveloper=developer;if(!m.agreedDate)m.agreedDate=todayIn();
    }
    m.agreedHours=patch.agreedHours;
  }
  if('workDone' in patch){if(typeof patch.workDone!=='string'||patch.workDone.length>5000)problem('Work done must be text up to 5,000 characters.');m.workDone=patch.workDone.trim();}
  if('dashPriority' in patch){if(patch.dashPriority!==null&&!DASH_PRIORITIES.includes(patch.dashPriority))problem('Choose a priority from the list.');m.dashPriority=patch.dashPriority;}
  // The order only means something inside a priority, so it is cleared with the priority.
  if('dashOrder' in patch){if(patch.dashOrder!==null&&!(Number.isInteger(patch.dashOrder)&&patch.dashOrder>=1&&patch.dashOrder<=99))problem('The order must be a whole number from 1 to 99.');m.dashOrder=patch.dashOrder;}
  if(m.dashPriority===null)m.dashOrder=null;
  if(creating&&!noClient){const errors=selectionErrors(catalog,m,{active:true});if(errors.length)problem(errors.join('. '));}
  const changes={};for(const k of allowed.filter(k=>k!=='revision'))if(m[k]!==old[k])changes[k]={from:old[k],to:m[k]};
  m.revision++;m.updatedAt=new Date().toISOString();
  const entry={type:'edit',at:m.updatedAt,by:{email:me.email,name:me.name},changes};
  // A project change: the names as they were (Odoo ids alone don't say much later), and whether logged work stays behind.
  if(moved){
    const before=moved.from!=null?(await readOdooProjects(env)).projects.find(x=>x.id===moved.from):null;
    entry.project={from:moved.from==null?null:before?.label||'Odoo project #'+moved.from,to:moved.toLabel};
    if(moved.from!=null&&(await ticketEntries(env,key)).length)entry.note='Work already logged stays on the previous project; new work goes to the new one.';
  }
  m.history.push(entry);
  await persist(env,key,m,raw);
  if('agreedHours' in patch)await syncAgreedLine(env,key,m,{title:ticket.title||'',me});
  return publicMetadata(m,me,catalog,projectIndex(await readOdooProjects(env)));
}
// Caller holds the same ticket lock used by metadata writes, and supplies an authoritative status read.
export async function guardedTransition(env,key,me,{closing,overrideReason},apply) {
  const store=requireStore(env),raw=await store.get(metadataKey(env,key)),m={...empty(),...JSON.parse(raw||'{}')};
  // Work entries must all be in Odoo, confirmed there, before any close. An override can't skip this.
  if(closing){const notSynced=await timeClosureErrors(env,key);if(notSynced.length)problem('Cannot close: '+notSynced.join('; ')+'.',409,'time_not_synced',{missing:notSynced,canOverride:false});}
  const missing=closing?closureErrors(await readCatalog(env),withLogged(m,summarize(await ticketEntries(env,key)))):[];
  if(missing.length&&(me.role!=='admin'||typeof overrideReason!=='string'||!overrideReason.trim()||overrideReason.trim().length>1000))problem('Cannot close: '+missing.join('; ')+'.'+(me.role==='admin'?' Supply an override reason or complete the fields.':''),400,'closure_required',{missing,canOverride:me.role==='admin'});
  const result=await apply();
  if(result instanceof Response&&!result.ok)return result;
  const at=new Date().toISOString();m.completedAt=closing?at:null;m.revision++;
  m.history.push({type:closing?'completed':'reopened',at,by:{email:me.email,name:me.name},changes:{}});
  if(missing.length)m.history.push({type:'override',at,by:{email:me.email,name:me.name},reason:overrideReason.trim(),missing,changes:{}});
  await persist(env,key,m,raw);return result;
}
// The client and sub-client of a ticket under a mapped Jira epic (epic-map.js). Only fills an empty client or
// one that already came from an epic; a client chosen by hand is kept. Completed tickets only get an empty one filled.
// The Odoo project comes with it when the epic's project links exactly one; else the ticket keeps the one it had.
export async function applyEpicSelection(env,key,{epicKey,clientId,subClientId,closed=false}) {
  const linked=subClientId?((await readCatalog(env)).entries.find(e=>e.id===subClientId)?.sources||[]).filter(s=>s.source==='odoo').map(s=>s.row):[];
  return withTicketLock(env,key,async()=>{
    const store=requireStore(env),raw=await store.get(metadataKey(env,key)),m={...empty(),...JSON.parse(raw||'{}')};
    const odooProjectId=linked.length===1?linked[0]:m.epicKey?null:m.odooProjectId;
    if((m.clientId||m.subClientId||m.odooProjectId!=null)&&(closed||!m.epicKey))return false;
    if(m.clientId===clientId&&m.subClientId===subClientId&&m.epicKey===epicKey&&m.odooProjectId===odooProjectId)return false;
    const changes={};if(m.clientId!==clientId)changes.clientId={from:m.clientId,to:clientId};if(m.subClientId!==subClientId)changes.subClientId={from:m.subClientId,to:subClientId};
    if(m.odooProjectId!==odooProjectId)changes.odooProjectId={from:m.odooProjectId,to:odooProjectId};
    Object.assign(m,{clientId,subClientId,epicKey,odooProjectId});m.revision++;m.updatedAt=new Date().toISOString();
    m.history.push({type:'edit',at:m.updatedAt,by:{email:'',name:'Epic '+epicKey},changes});
    await persist(env,key,m,raw);return true;
  });
}
const nameKey=n=>n.trim().normalize('NFC').toLocaleLowerCase('en-US');
async function idFor(parent,name) { const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode((parent||'root')+'\0'+nameKey(name)));return 'c_'+Array.from(new Uint8Array(bytes).slice(0,16),x=>x.toString(16).padStart(2,'0')).join(''); }
function cleanName(n) {if(typeof n!=='string'||!n.trim()||n.trim().length>300)problem('Client names must contain 1–300 characters.');return n.trim();}
// Clients come straight from Odoo in two levels: every contact that is a company in the main company is a client
// (exactly Odoo's Contacts > Companies, grouped by Company), with or without a project, and each project is a
// sub-client - shown as "Project" - of its contact (the company, when the project's contact is a person
// inside one). Projects without a contact go under NO_CUSTOMER. Entries are only added (ids are stable by name), so tickets keep their client when Odoo changes.
const odooSyncKey=env=>prefix(env)+'catalog:odoo-sync';
export const NO_CUSTOMER='No contact';
// The main company is the Odoo company named "All in One" (ODOO_CLIENT_COMPANY to name another) among those the
// integration user is allowed in; without one, the second of its companies (company_ids, in Odoo's order).
// Clients and projects are what Odoo shows with that company selected: its own, and those of no company.
export async function mainCompanyId(env){
  const [u]=await odoo(env,'res.users','search_read',[[['login','=',env.ODOO_LOGIN]]],{fields:['company_ids'],limit:1});
  if(!u||!Array.isArray(u.company_ids)||!u.company_ids.length)throw new Error("the Odoo user has no company to take clients and projects from");
  const wanted=nameKey(String(env.ODOO_CLIENT_COMPANY||'All in One'));
  const named=(await odoo(env,'res.company','search_read',[[['id','in',u.company_ids]]],{fields:['name']})).find(c=>nameKey(String(c.name||''))===wanted);
  if(named)return named.id;
  if(u.company_ids.length<2)throw new Error("the Odoo user has no second company to take clients and projects from");
  return u.company_ids[1];
}
const inCompany=main=>['|',['company_id','=',main],['company_id','=',false]];
async function odooRows(env){
  const main=await mainCompanyId(env);
  const [customers,projects]=await Promise.all([
    odoo(env,'res.partner','search_read',[[['is_company','=',true],...inCompany(main)]],{fields:['display_name'],order:'id',limit:5000}),
    odoo(env,'project.project','search_read',[inCompany(main)],{fields:['display_name','partner_id'],order:'id',limit:1000})
  ]);
  // A project's contact can be a person inside a company: the project belongs to the company. Clients are Odoo companies only:
  // a project whose owner is not a company (a person with no company) goes under NO_CUSTOMER, not under a client named after the person.
  const ids=[...new Set(projects.map(p=>Array.isArray(p.partner_id)?p.partner_id[0]:null).filter(Boolean))];
  const company={};
  if(ids.length)for(const c of await odoo(env,'res.partner','read',[ids],{fields:['commercial_partner_id']}))company[c.id]=Array.isArray(c.commercial_partner_id)?{id:c.commercial_partner_id[0],name:String(c.commercial_partner_id[1]||'').trim()}:null;
  // The contacts the projects belong to that are archived in Odoo (reading by id also returns archived ones).
  const owners=new Map();for(const p of projects)if(Array.isArray(p.partner_id)){const o=company[p.partner_id[0]]||{id:p.partner_id[0],name:String(p.partner_id[1]||'').trim()};owners.set(o.id,o.name);}
  const archivedOwners=[],companies=new Set();
  if(owners.size)for(const c of await odoo(env,'res.partner','read',[[...owners.keys()]],{fields:['active','is_company','company_id']})){if(c.is_company&&(!c.company_id||c.company_id[0]===main))companies.add(c.id);if(c.active===false&&owners.get(c.id))archivedOwners.push(owners.get(c.id));}
  const fits=n=>n&&n.length<=300;
  return {archivedOwners,
    customers:customers.map(c=>({displayName:String(c.display_name||'').trim(),sourceRow:c.id})).filter(r=>fits(r.displayName)),
    projects:projects.map(p=>{const owner=Array.isArray(p.partner_id)?(company[p.partner_id[0]]||{id:p.partner_id[0],name:String(p.partner_id[1]||'').trim()}):null;
      return {displayName:String(p.display_name||'').trim(),customer:owner&&owner.name&&companies.has(owner.id)?owner.name:NO_CUSTOMER,sourceRow:p.id};}).filter(r=>fits(r.displayName)&&fits(r.customer))
  };
}
// ---- Odoo projects for tickets ----
// A ticket's project is an Odoo project (odooProjectId, Odoo's own id, which a rename doesn't change). Its client is the
// project's customer in Odoo (the company, when the customer is a person inside one) and is never chosen apart. The
// projects tickets can use are kept as a snapshot, refreshed with each catalog sync: every project of the main company
// and of no company, archived ones too, so a ticket on an archived project still shows it. A project whose customer is
// missing (or is a person with no company) has no client: it is listed, flagged, and can't be given to a ticket.
export const odooProjectsKey=env=>prefix(env)+'odoo-projects';
const syncErrorKey=env=>prefix(env)+'catalog:odoo-sync-error';
export async function readOdooProjects(env){const raw=await requireStore(env).get(odooProjectsKey(env));return raw?JSON.parse(raw):{syncedAt:null,projects:[]};}
export const projectIndex=snapshot=>new Map((snapshot?.projects||[]).map(p=>[p.id,p]));
async function snapshotOdooProjects(env,main){
  const rows=await odoo(env,'project.project','search_read',[inCompany(main)],{fields:['name','partner_id','active','create_date'],order:'id',limit:5000,context:{active_test:false}});
  const partners=[...new Set(rows.map(p=>Array.isArray(p.partner_id)?p.partner_id[0]:null).filter(Boolean))],commercial={},companies={};
  if(partners.length)for(const c of await odoo(env,'res.partner','read',[partners],{fields:['commercial_partner_id']}))commercial[c.id]=Array.isArray(c.commercial_partner_id)?c.commercial_partner_id[0]:c.id;
  const owners=[...new Set(Object.values(commercial))];
  if(owners.length)for(const c of await odoo(env,'res.partner','read',[owners],{fields:['name','is_company']}))if(c.is_company)companies[c.id]=String(c.name||'').trim();
  const projects=rows.map(p=>{const owner=Array.isArray(p.partner_id)?commercial[p.partner_id[0]]:null,clientName=owner&&companies[owner]||'';
    return {id:p.id,name:String(p.name||'').trim()||'Project #'+p.id,active:p.active!==false,clientId:clientName?owner:null,clientName,createdAt:p.create_date?String(p.create_date).replace(' ','T')+'Z':null};});
  // "Client → Project", with the Odoo id added where two projects would read the same.
  const label=p=>(p.clientName||'No client')+' → '+p.name,count={};
  for(const p of projects)count[nameKey(label(p))]=(count[nameKey(label(p))]||0)+1;
  for(const p of projects)p.label=label(p)+(count[nameKey(label(p))]>1?' (#'+p.id+')':'');
  const snapshot={syncedAt:Date.now(),projects};
  await requireStore(env).set(odooProjectsKey(env),JSON.stringify(snapshot));
  return snapshot;
}
// The Odoo project a ticket is being given: it must be in the snapshot, active, and have a client.
export async function chosenProject(env,id){
  if(!Number.isInteger(id)||id<1)problem('Choose the Odoo project for this ticket.',400,'project_required');
  const p=(await readOdooProjects(env)).projects.find(x=>x.id===id);
  if(!p)problem('That Odoo project is not available. Refresh the projects from Odoo and choose again.',400,'project_unknown');
  if(!p.active)problem('Odoo project “'+p.name+'” is archived. Choose an active project.',400,'project_archived');
  if(!p.clientId)problem('Odoo project “'+p.name+'” has no client. Set its customer in Odoo, refresh the projects, then choose it.',400,'project_no_client');
  return p;
}
// The catalog project (so the catalog client, which reports group by) an Odoo project is under: the catalog project linked
// to it, or among several, the one under the project's Odoo customer. Null when that can't be told (Needs mapping).
export function catalogProjectFor(catalog,odooId,project){
  const linked=(catalog?.entries||[]).filter(e=>e.parentId&&(e.sources||[]).some(s=>s.source==='odoo'&&s.row===odooId));
  if(linked.length<=1)return linked[0]||null;
  const parent=e=>catalog.entries.find(c=>c.id===e.parentId);
  const same=linked.filter(e=>{const c=parent(e);return c&&(project?.clientId&&(c.sources||[]).some(s=>s.source==='odoo-customer'&&s.row===project.clientId)||nameKey(c.name)===nameKey(project?.clientName||NO_CUSTOMER));});
  return same.length===1?same[0]:null;
}
// The client and project a ticket counts under: from its Odoo project when it has one, else what was saved before.
export function selectionOf(m,catalog,projects){
  const sub=m.odooProjectId&&catalog?catalogProjectFor(catalog,m.odooProjectId,projects?.get(m.odooProjectId)):null;
  return sub?{clientId:sub.parentId,subClientId:sub.id}:{clientId:m.clientId||null,subClientId:m.subClientId||null};
}
export async function syncStatus(env){
  const store=requireStore(env),[last,error,snapshot]=await Promise.all([store.get(odooSyncKey(env)),store.get(syncErrorKey(env)),readOdooProjects(env)]);
  return {odoo:odooConfigured(env),syncedAt:Number(last)||null,projectsSyncedAt:snapshot.syncedAt,error:error?JSON.parse(error):null};
}
export async function syncCatalogFromOdoo(env,{force=false}={}){
  try{return await syncCatalog(env,{force});}
  catch(e){
    // Kept so the Clients page can say what went wrong; cleared by the next sync that works.
    if(env.STORE&&!(e instanceof BusinessError&&e.code==='conflict'))await env.STORE.set(syncErrorKey(env),JSON.stringify({at:Date.now(),message:String(e.message||'unknown error').slice(0,300)})).catch(()=>{});
    throw e;
  }
}
async function syncCatalog(env,{force=false}={}){
  if(!odooConfigured(env))return {odoo:false};
  const store=requireStore(env),last=Number(await store.get(odooSyncKey(env)))||0;
  if(!force&&Date.now()-last<10*60*1000)return {odoo:true,changed:false,syncedAt:last};
  const lock=odooSyncKey(env)+':lock',owner=crypto.randomUUID();
  if(!await store.setIfAbsent(lock,owner,120))return {odoo:true,changed:false,busy:true,syncedAt:last};
  try{
    const {customers,projects,archivedOwners}=await odooRows(env);let changed=false,added=0;
    await snapshotOdooProjects(env,await mainCompanyId(env));
    // Odoo projects the catalog links to that were deleted in Odoo (archived ones still exist): their links are
    // dropped, so a project made again in Odoo under the same name is the one work is logged to.
    const linked=[...new Set((await readCatalog(env)).entries.flatMap(e=>(e.sources||[]).filter(s=>s.source==='odoo').map(s=>s.row)))];
    const existing=new Set(linked.length?(await odoo(env,'project.project','search_read',[[['id','in',linked]]],{fields:['id'],context:{active_test:false}})).map(p=>p.id):[]);
    const deleted=new Set(linked.filter(id=>!existing.has(id)));
    if(customers.length||projects.length)for(let attempt=0;;attempt++){
      const key=catalogKey(env),previous=await store.get(key),catalog=previous?JSON.parse(previous):{revision:0,entries:[]};
      // The group for projects without a contact was called "No customer": renamed in place (same id, same projects).
      const legacy=catalog.entries.find(e=>!e.parentId&&e.name==='No customer');
      if(legacy&&!catalog.entries.some(e=>!e.parentId&&e.name===NO_CUSTOMER))legacy.name=NO_CUSTOMER;
      // Contacts first (their Odoo contact id is kept as "odoo-customer" source), then projects under them.
      let next=catalog,count=0;
      if(customers.length){const r=await prepareImport(next,customers,'odoo-customer');next=r.next;count+=r.preview.added;}
      if(projects.length){const r=await prepareImport(next,projects,'odoo');next=r.next;count+=r.preview.added;}
      if(deleted.size){
        if(next===catalog)next=structuredClone(catalog);
        for(const e of next.entries)if(e.sources)e.sources=e.sources.filter(s=>!(s.source==='odoo'&&deleted.has(s.row)));
      }
      // Contacts archived (or deleted) in Odoo are archived here too, so they aren't offered as clients; they
      // come back when restored in Odoo. Tickets that use one keep it. Archives made in the dashboard stay.
      if(customers.length){
        if(next===catalog)next=structuredClone(catalog);
        const active=new Set(customers.map(c=>c.sourceRow)),gone=new Set((archivedOwners||[]).map(nameKey));
        for(const e of next.entries){
          if(e.parentId||e.name===NO_CUSTOMER)continue;
          const ids=(e.sources||[]).filter(s=>s.source==='odoo-customer').map(s=>s.row);
          if(!ids.length&&!gone.has(nameKey(e.name))&&e.archivedBy!=='odoo')continue;
          const inOdoo=ids.length?ids.some(id=>active.has(id)):!gone.has(nameKey(e.name));
          if(!inOdoo&&!e.archived){e.archived=true;e.archivedBy='odoo';}
          else if(inOdoo&&e.archived&&e.archivedBy==='odoo'){e.archived=false;delete e.archivedBy;}
        }
      }
      if(JSON.stringify(next.entries)===JSON.stringify(catalog.entries))break;
      next.revision=catalog.revision+1;
      if(previous===null?await store.setIfAbsent(key,JSON.stringify(next),315360000):await store.compareAndSet(key,previous,JSON.stringify(next))){changed=true;added=count;break;}
      if(attempt>=2)problem('Catalog changed during the Odoo sync. Try again.',409,'conflict');
    }
    const at=Date.now();await store.set(odooSyncKey(env),String(at));await store.del(syncErrorKey(env));
    return {odoo:true,changed,added,customers:customers.length,projects:projects.length,syncedAt:at};
  }finally{await store.deleteIfValue(lock,owner);}
}
export async function prepareImport(catalog,rows,source='project-workbook') {
  if(!Array.isArray(rows)||!rows.length||rows.length>5000)problem('Import 1–5,000 catalog rows.');
  const next=structuredClone(catalog),added=[];
  async function ensure(name,parentId,sourceRow){
    name=cleanName(name);let e=next.entries.find(e=>e.parentId===parentId&&nameKey(e.name)===nameKey(name));
    if(!e){const id=await idFor(parentId,name);e=next.entries.find(e=>e.id===id);if(!e){e={id,name,parentId,archived:false,sources:[]};next.entries.push(e);added.push(e.id);}}
    // An Odoo project an administrator unlinked from this project is not linked back by the sync.
    if(sourceRow&&!(source==='odoo'&&(e.odooUnlinked||[]).includes(sourceRow))&&!e.sources.some(s=>s.row===sourceRow&&s.source===source))e.sources.push({source,row:sourceRow});
    return e;
  }
  for(const [i,r] of rows.entries()){
    if(!r||typeof r!=='object')problem('Invalid import row '+(i+2));
    const display=cleanName(r.displayName),customer=typeof r.customer==='string'?r.customer.trim():'';
    // Workbook rows start at 2 (row 1 is the header); Odoo record ids start at 1.
    const sourceRow=Number.isInteger(r.sourceRow)&&r.sourceRow>=(String(source).startsWith('odoo')?1:2)?r.sourceRow:i+2;
    if(customer){const parent=await ensure(customer,null,sourceRow);await ensure(display,parent.id,sourceRow);}else await ensure(display,null,sourceRow);
  }
  return {next,preview:{rows:rows.length,added:added.length,existing:next.entries.length-added.length,clients:next.entries.filter(e=>!e.parentId).length,subClients:next.entries.filter(e=>e.parentId).length,entries:next.entries.filter(e=>added.includes(e.id))}};
}
// Reads only the fields this Odoo has (versions differ, e.g. "mobile"), so a missing one can't fail the read.
async function readFields(env,model,ids,wanted){
  const known=await odoo(env,model,'fields_get',[],{attributes:['type']}).catch(()=>({}));
  const fields=wanted.filter(f=>known[f]);
  return fields.length&&ids.length?odoo(env,model,'read',[ids],{fields}):[];
}
const many2one=v=>Array.isArray(v)?String(v[1]||''):'';
// A project made with only a name and a contact gets no task stages (and, for a contact of no company, no
// company): Odoo then doesn't offer it when adding a task in a stage of All Tasks, nor for timesheets. New
// projects take the setup of the latest project of the main company that has stages: the same stages,
// timesheets, visibility and billing, in the main company. Also used to repair projects made before.
const COPIED=['allow_timesheets','privacy_visibility','allow_billable'];
export async function projectSetup(env){
  const main=await mainCompanyId(env);
  const [ref]=await odoo(env,'project.project','search_read',[[...inCompany(main),['type_ids','!=',false]]],{fields:['id'],order:'id desc',limit:1});
  if(!ref)throw new Error('no project of the main company has task stages to copy');
  const [r]=await readFields(env,'project.project',[ref.id],['type_ids',...COPIED]);
  const values={company_id:main,type_ids:[[6,0,r.type_ids]]};
  for(const f of COPIED)if(f in r)values[f]=r[f];
  return {reference:ref.id,values};
}
// Allocated hours on an Odoo project (Timesheets). Odoo keeps nothing for a project with no value (it reads as false),
// so an empty allocation is told apart from an explicit zero, which is stored as 0.
export async function allocationField(env){
  const f=await odoo(env,'project.project','fields_get',[['allocated_hours']],{attributes:['type','readonly']}).catch(()=>({}));
  return f.allocated_hours?.type==='float';
}
// What was done to an Odoo project from the dashboard (created, allocation changed), oldest first, for its details view.
export const projectLogKey=(env,id)=>prefix(env)+'project-log:'+id;
export async function recordProjectEvent(env,id,me,event){
  const store=requireStore(env),k=projectLogKey(env,id);
  for(let attempt=0;attempt<3;attempt++){
    const raw=await store.get(k),next=JSON.stringify([...(raw?JSON.parse(raw):[]),{...event,at:new Date().toISOString(),by:{email:me.email,name:me.name}}].slice(-200));
    if(raw===null?await store.setIfAbsent(k,next,315360000):await store.compareAndSet(k,raw,next))return;
  }
}
export async function readProjectLog(env,id){const raw=await requireStore(env).get(projectLogKey(env,id));return raw?JSON.parse(raw):[];}
// The hours typed in a form: undefined when empty (not known yet), else zero or a positive number with at most 2 decimals.
export function allocatedHoursInput(value){
  if(value==null||value==='')return undefined;
  const n=typeof value==='number'?value:Number(String(value).trim());
  if(!(Number.isFinite(n)&&n>=0&&n<=1000000&&Math.round(n*100)/100===n))throw new BusinessError('Enter the allocated hours as zero or a positive number with at most 2 decimals, or leave it empty.',400,'project_budget');
  return n;
}
export async function clientDetails(env,clientId){
  const catalog=await readCatalog(env),client=catalog.entries.find(e=>e.id===clientId&&!e.parentId);
  if(!client)problem('Client not found.',404,'not_found');
  const projects=catalog.entries.filter(e=>e.parentId===client.id);
  const out={client:{id:client.id,name:client.name,aiName:client.aiName||'',archived:!!client.archived},contact:null,projects:projects.map(e=>({id:e.id,name:e.name,aiName:e.aiName||'',archived:!!e.archived,odoo:null}))};
  if(!odooConfigured(env)||client.name===NO_CUSTOMER)return out;
  let partner=(client.sources||[]).find(x=>x.source==='odoo-customer')?.row;
  if(!partner){const [found]=await odoo(env,'res.partner','search_read',[[['name','=',client.name],['parent_id','=',false]]],{fields:['id'],limit:1});partner=found&&found.id;}
  if(partner){
    const [c]=await readFields(env,'res.partner',[partner],['name','email','phone','mobile','website','street','street2','city','zip','country_id','vat','company_registry','category_id','child_ids','create_date','ref','industry_id','is_company']);
    if(c){
      const tags=Array.isArray(c.category_id)&&c.category_id.length?(await odoo(env,'res.partner.category','read',[c.category_id],{fields:['name']}).catch(()=>[])).map(t=>t.name):[];
      out.contact={id:c.id,name:c.name||'',email:c.email||'',phone:c.phone||'',mobile:c.mobile||'',website:c.website||'',
        address:[c.street,c.street2,[c.zip,c.city].filter(Boolean).join(' '),many2one(c.country_id)].filter(Boolean).join(', '),
        vat:c.vat||'',companyRegistry:c.company_registry||'',reference:c.ref||'',industry:many2one(c.industry_id),tags,
        people:Array.isArray(c.child_ids)?c.child_ids.length:0,created:c.create_date||'',isCompany:!!c.is_company,
        url:String(env.ODOO_URL||'').replace(/\/+$/,'')+'/web#id='+c.id+'&model=res.partner&view_type=form'};
    }
  }
  // Each project's Odoo details (manager, last update), matched by the Odoo id kept from the sync.
  const ids=projects.map(e=>(e.sources||[]).find(x=>x.source==='odoo')?.row).filter(Boolean);
  if(ids.length){
    const rows=await readFields(env,'project.project',ids,['name','user_id','write_date','create_date','last_update_status','date_start','date','task_count','active']).catch(()=>[]);
    for(const r of rows){const e=projects.find(p=>(p.sources||[]).some(x=>x.source==='odoo'&&x.row===r.id));const item=e&&out.projects.find(p=>p.id===e.id);
      if(item)item.odoo={id:r.id,manager:many2one(r.user_id),updated:r.write_date||'',created:r.create_date||'',status:typeof r.last_update_status==='string'?r.last_update_status:'',start:r.date_start||'',end:r.date||'',tasks:Number.isInteger(r.task_count)?r.task_count:null,
        url:String(env.ODOO_URL||'').replace(/\/+$/,'')+'/web#id='+r.id+'&model=project.project&view_type=form'};}
  }
  return out;
}
async function createInOdoo(env,url,me,b){
  if(me.role!=='admin')problem('Only administrators manage the client catalog.',403,'forbidden');
  if(!odooConfigured(env))problem('Odoo is not connected.',501,'odoo_off');
  const name=cleanName(b&&b.name),text=(v,n)=>typeof v==='string'&&v.trim()?v.trim().slice(0,n):undefined;
  let created;
  try{
    if(url.pathname==='/clients/odoo/customer'){
      const email=text(b.email,200),phone=text(b.phone,50);
      if(email&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))problem('Enter a valid email or leave it empty.');
      // A contact with this name already in Odoo is not created again (the next sync links it to the client).
      const [same]=await odoo(env,'res.partner','search_read',[[['name','=',name],['is_company','=',true]]],{fields:['id'],limit:1});
      if(same)problem('A contact named “'+name+'” is already in Odoo.',409,'exists');
      created=await odoo(env,'res.partner','create',[{name,is_company:true,customer_rank:1,...(email?{email}:{}),...(phone?{phone}:{})}]);
    }else{
      const catalog=await readCatalog(env),client=catalog.entries.find(e=>e.id===b.clientId&&!e.parentId);
      if(!client||client.name===NO_CUSTOMER)problem('Choose the contact this project belongs to.');
      // The customer's Odoo contact: kept from the sync, else found by its exact name.
      let partner=(client.sources||[]).find(x=>x.source==='odoo-customer')?.row;
      if(!partner){const [found]=await odoo(env,'res.partner','search_read',[[['name','=',client.name],['parent_id','=',false]]],{fields:['id'],limit:1});partner=found&&found.id;}
      if(!partner)problem('This contact is not in Odoo. Create it as a contact first.');
      // A project of this contact already here with this name is pushed to Odoo only when it has no Odoo project left.
      const same=catalog.entries.find(e=>e.parentId===client.id&&nameKey(e.name)===nameKey(name));
      const linked=(same?.sources||[]).filter(s=>s.source==='odoo').map(s=>s.row);
      if(linked.length){const [found]=await odoo(env,'project.project','search_read',[[['id','in',linked]]],{fields:['id'],context:{active_test:false},limit:1});if(found)problem('This project is already in Odoo (#'+found.id+').',409,'exists');}
      // The allocation is the same Odoo field the Allocated Hours column edits; left out when it is not known yet.
      const hours=allocatedHoursInput(b.allocatedHours);
      if(hours!==undefined&&!await allocationField(env))problem("This Odoo has no allocated hours on projects (Timesheets).",501,'no_allocation');
      created=await odoo(env,'project.project','create',[{name,partner_id:partner,...(await projectSetup(env)).values,...(hours!==undefined?{allocated_hours:hours}:{})}]);
      await recordProjectEvent(env,Number(created),me,{type:'created',allocatedHours:hours===undefined?null:hours}).catch(()=>{});
    }
  }catch(e){if(e instanceof BusinessError)throw e;problem("Odoo didn't create it: "+String(e.message||'unknown error').slice(0,200),502,'odoo');}
  await syncCatalogFromOdoo(env,{force:true});
  return Response.json({created,catalog:await readCatalog(env)},{status:201,headers:{'Cache-Control':'no-store'}});
}
// ---- Projects page (administrators): every project with its local ID, Odoo links, contact and status ----
// The local ID is the catalog entry's id, which tickets already use. Flags are what the page filters on: a project
// with no Odoo project is unmapped; one linked to several Odoo projects, or whose Odoo project another project also
// links to, has a conflict; an archived one is archived. Status shows the most serious of them.
const odooLink=(env,model,id)=>String(env.ODOO_URL||'').replace(/\/+$/,'')+'/web#id='+id+'&model='+model+'&view_type=form';
export function projectRows(catalog,env){
  const projects=catalog.entries.filter(e=>e.parentId),owners=new Map();
  for(const e of projects)for(const s of e.sources||[])if(s.source==='odoo'){if(!owners.has(s.row))owners.set(s.row,[]);owners.get(s.row).push(e.id);}
  return projects.map(e=>{
    const odooIds=(e.sources||[]).filter(s=>s.source==='odoo').map(s=>s.row),conflicts=[];
    if(odooIds.length>1)conflicts.push({type:'several-odoo',odooIds});
    for(const id of odooIds){const others=owners.get(id).filter(x=>x!==e.id);if(others.length)conflicts.push({type:'shared-odoo',odooId:id,with:others});}
    const contact=catalog.entries.find(c=>c.id===e.parentId),unmapped=!odooIds.length;
    return {id:e.id,name:e.name,aiName:e.aiName||'',contact:{id:e.parentId,name:shownName(contact)},odooLinks:odooIds.map(id=>({odooId:id,url:odooLink(env,'project.project',id)})),
      archived:!!e.archived,unmapped,conflicts,status:e.archived?'archived':conflicts.length?'conflict':unmapped?'unmapped':'mapped'};
  });
}
// Odoo projects a project with no Odoo project can be linked to: same name, under the same contact, and not linked yet.
async function mapCandidates(env,catalog,entry){
  const contact=catalog.entries.find(c=>c.id===entry.parentId),linked=new Set(catalog.entries.flatMap(e=>(e.sources||[]).filter(s=>s.source==='odoo').map(s=>s.row)));
  const {projects}=await odooRows(env);
  return projects.filter(p=>contact&&p.customer===contact.name&&nameKey(p.displayName)===nameKey(entry.name)&&!linked.has(p.sourceRow))
    .map(p=>({odooId:p.sourceRow,name:p.displayName,contact:p.customer,url:odooLink(env,'project.project',p.sourceRow)}));
}
// ---- Needs mapping (administrators): tickets without a usable Odoo project ----
// Tickets saved before the Odoo project rule have only a catalog client and project. Their Odoo project is what the catalog
// already links to that project (or Work log setup's mapping for it, as the work log used), never a match by name:
//   ready       exactly one Odoo project, active and with a client, consistent with where the ticket's work went
//   missing     no project chosen, a project with no Odoo project, or one whose Odoo project is archived or has no client
//   ambiguous   the project links several Odoo projects
//   conflict    the link and the ticket's work disagree (its Odoo task or posted lines are in another project),
//               or the Odoo project is not in the main company's projects
// Applying saves the Odoo project (its client follows) and nothing else, so Jira links and logged work stay as they are.
export async function ticketKeys(env){
  const store=requireStore(env),start=prefix(env)+'ticket:';
  if(!store.scanKeys)return [];
  return (await store.scanKeys(start)).filter(k=>!k.endsWith(':lock')).map(k=>k.slice(start.length)).filter(k=>/^[A-Z][A-Z0-9_]*-\d+$/.test(k)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
}
export async function readAllMetadata(env){
  const store=requireStore(env),keys=await ticketKeys(env),out=new Map();
  for(let i=0;i<keys.length;i+=200){const part=keys.slice(i,i+200),raws=store.mget?await store.mget(part.map(k=>metadataKey(env,k))):await Promise.all(part.map(k=>store.get(metadataKey(env,k))));part.forEach((k,n)=>{if(raws[n])out.set(k,migrateDash({...empty(),...JSON.parse(raws[n])}));});}
  return out;
}
export async function mappingPlan(env){
  const [all,catalog,snapshot,cfg]=await Promise.all([readAllMetadata(env),readCatalog(env),readOdooProjects(env),readConfig(env).catch(()=>({mapping:{}}))]);
  const projects=projectIndex(snapshot),find=id=>catalog.entries.find(e=>e.id===id),labelOf=id=>projects.get(id)?.label||'Odoo project #'+id,out=[];
  for(const [key,m] of all){
    const base={key,revision:m.revision,current:m.odooProjectId??null,client:shownName(find(m.clientId)),project:shownName(find(m.subClientId)),closed:!!m.completedAt};
    if(m.odooProjectId!=null){if(snapshot.syncedAt&&!projects.has(m.odooProjectId))out.push({...base,kind:'conflict',odooProjectId:m.odooProjectId,message:'Odoo project #'+m.odooProjectId+" is not among the main company's Odoo projects (deleted, or moved to another company)."});continue;}
    let ids;
    if(!m.clientId&&!m.subClientId){out.push({...base,kind:'missing',message:'No client or project chosen.'});continue;}
    if(m.subClientId){const sub=find(m.subClientId);if(!sub){out.push({...base,kind:'missing',message:'Its project is no longer in the catalog.'});continue;}
      ids=[...new Set([...(cfg.mapping?.[sub.id]?[Number(cfg.mapping[sub.id])]:[]),...(sub.sources||[]).filter(x=>x.source==='odoo').map(x=>x.row)])];}
    else ids=cfg.mapping?.[m.clientId]?[Number(cfg.mapping[m.clientId])]:[];
    if(!ids.length){out.push({...base,kind:'missing',message:m.subClientId?'Its project has no Odoo project.':'Only a client is chosen, with no project.'});continue;}
    if(ids.length>1){out.push({...base,kind:'ambiguous',candidates:ids.map(id=>({id,label:labelOf(id)})),message:'Its project links '+ids.length+' Odoo projects.'});continue;}
    const id=ids[0],task=await ticketTask(env,key),posted=[...new Set((await ticketEntries(env,key)).filter(e=>e.projectId&&e.lineId).map(e=>e.projectId))];
    const elsewhere=[...new Set([...(task.projectId&&task.projectId!==id?[task.projectId]:[]),...posted.filter(p=>p!==id)])];
    if(elsewhere.length){out.push({...base,kind:'conflict',candidates:[id,...elsewhere].map(x=>({id:x,label:labelOf(x)})),message:'Its project links Odoo project #'+id+', but its work went to '+elsewhere.map(x=>'#'+x).join(', ')+'.'});continue;}
    if(snapshot.syncedAt&&!projects.has(id)){out.push({...base,kind:'conflict',odooProjectId:id,message:'Its Odoo project #'+id+" is not among the main company's Odoo projects."});continue;}
    // Only a project a ticket can be given now is suggested: never an archived one, or one with no client.
    const p=projects.get(id);
    if(!p){out.push({...base,kind:'missing',message:'Odoo projects have not been read yet. Press Sync from Odoo now.'});continue;}
    if(!p.active||!p.clientId){out.push({...base,kind:'missing',linked:{id,label:p.label},message:'Its project links '+p.label+(p.active?', which has no client in Odoo':', which is archived in Odoo')+'. Choose another Odoo project.'});continue;}
    out.push({...base,kind:'ready',odooProjectId:id,label:p.label,message:'Its project links '+p.label+'.'});
  }
  const count=k=>out.filter(r=>r.kind===k).length;
  return {scanned:all.size,mapped:[...all.values()].filter(m=>m.odooProjectId!=null).length,ready:count('ready'),missing:count('missing'),ambiguous:count('ambiguous'),conflict:count('conflict'),projectsSyncedAt:snapshot.syncedAt,rows:out};
}
// Saves Odoo projects on tickets that need one. items: [{key, revision, odooProjectId?, resolveConflict?}]; a ticket without
// an odooProjectId gets its ready suggestion. keys (or nothing) applies the ready rows. Each project is checked as on a ticket
// (active, with a client) and the client follows it. Each ticket is re-checked under its lock and skipped, with the reason,
// when it changed since the list was read, got a project meanwhile, or is no longer ready. A conflict is resolved only when
// asked for, ticket by ticket. Work already logged stays where it went.
async function applyMapping(env,me,{keys=null,items=null}={}){
  const [plan,catalog,snapshot]=await Promise.all([mappingPlan(env),readCatalog(env),readOdooProjects(env)]);
  const byKey=new Map(plan.rows.map(r=>[r.key,r])),known=projectIndex(snapshot);
  const work=items||plan.rows.filter(r=>r.kind==='ready'&&(!keys||keys.includes(r.key))).map(r=>({key:r.key}));
  let applied=0;const skipped=[],linked=[];
  for(const item of work){
    const r=byKey.get(item.key);
    try{
      if(!r)problem('It already has an Odoo project.',409,'mapped');
      if(item.revision!=null&&item.revision!==r.revision)problem('Changed since the list was opened. Refresh the list to see it.',409,'conflict');
      const suggested=item.odooProjectId==null;
      if(suggested&&r.kind!=='ready')problem('Not ready: '+r.message,409,'not_ready');
      if(r.kind==='conflict'&&!item.resolveConflict)problem('Its work went to another Odoo project. Choose its project on its own.',409,'mapping_conflict');
      const id=suggested?r.odooProjectId:item.odooProjectId,p=await chosenProject(env,id),sub=catalogProjectFor(catalog,id,p);
      await withTicketLock(env,r.key,async()=>{
        const store=requireStore(env),raw=await store.get(metadataKey(env,r.key)),m={...empty(),...JSON.parse(raw||'{}')};
        if(m.revision!==r.revision||(m.odooProjectId??null)!==r.current)problem('Changed since the check. Refresh the list to see it.',409,'conflict');
        // A suggestion keeps the catalog client and project it came from when the catalog cannot name one for the Odoo project.
        const next={odooProjectId:id,...(sub?{clientId:sub.parentId,subClientId:sub.id}:suggested?{}:{clientId:null,subClientId:null})},changes={};
        for(const [k,v] of Object.entries(next))if((m[k]??null)!==v)changes[k]={from:m[k]??null,to:v};
        Object.assign(m,next,{epicKey:null});m.revision++;m.updatedAt=new Date().toISOString();
        m.history.push({type:'edit',at:m.updatedAt,by:{email:me.email,name:me.name},changes,project:{from:r.current==null?null:known.get(r.current)?.label||'Odoo project #'+r.current,to:p.label},
          note:(suggested?'Linked to the Odoo project its project already had.':'Chosen in Map tickets.')+(r.kind==='conflict'?' Work already logged stays where it went.':'')});
        await persist(env,r.key,m,raw);
      });
      applied++;linked.push({key:r.key,odooProjectId:id,label:p.label});
    }catch(e){if(!(e instanceof BusinessError))throw e;skipped.push({key:item.key,message:e.message});}
  }
  return {applied,skipped,linked};
}
export async function catalogRoutes(request,env,url,me) {
  // The Odoo projects a ticket can be given (anyone signed in): active ones are offered; archived ones are listed so a
  // ticket still on one can show it.
  if(url.pathname==='/clients/odoo-projects/options'&&request.method==='GET'){
    const snapshot=await readOdooProjects(env);
    return Response.json({syncedAt:snapshot.syncedAt,projects:snapshot.projects.map(p=>projectView(p.id,p))},{headers:{'Cache-Control':'no-store'}});
  }
  if(url.pathname==='/clients/odoo-sync'&&request.method==='GET')return Response.json(await syncStatus(env),{headers:{'Cache-Control':'no-store'}});
  if(url.pathname==='/clients/needs-mapping'||url.pathname==='/clients/needs-mapping/apply'){
    if(me.role!=='admin')problem('Only administrators manage the client catalog.',403,'forbidden');
    if(request.method==='GET'&&!url.pathname.endsWith('/apply'))return Response.json(await mappingPlan(env),{headers:{'Cache-Control':'no-store'}});
    if(request.method!=='POST'||!url.pathname.endsWith('/apply'))problem('Use GET, or POST to apply.',405);
    let b={};try{b=JSON.parse(await request.text()||'{}');}catch{problem('Invalid request.');}
    if(b.keys!=null&&(!Array.isArray(b.keys)||b.keys.length>1000||b.keys.some(k=>typeof k!=='string')))problem('Supply up to 1,000 ticket keys.');
    const int=v=>v==null||Number.isInteger(v);
    if(b.items!=null&&(!Array.isArray(b.items)||b.items.length>1000||b.items.some(i=>!i||typeof i.key!=='string'||!int(i.revision)||!int(i.odooProjectId)||(i.resolveConflict!=null&&typeof i.resolveConflict!=='boolean'))))problem('Supply up to 1,000 tickets, each with its key, revision and Odoo project.');
    return Response.json({...(await applyMapping(env,me,{keys:b.keys||null,items:b.items||null})),plan:await mappingPlan(env)},{headers:{'Cache-Control':'no-store'}});
  }
  if(url.pathname==='/clients/details'&&request.method==='GET'){
    if(me.role!=='admin')problem('Only administrators manage the client catalog.',403,'forbidden');
    let details;try{details=await clientDetails(env,url.searchParams.get('id')||'');}catch(e){if(e instanceof BusinessError)throw e;problem("Couldn't read the client from Odoo: "+String(e.message||'unknown error').slice(0,200),502,'odoo');}
    return Response.json(details,{headers:{'Cache-Control':'no-store'}});
  }
  if((url.pathname==='/clients/odoo/customer'||url.pathname==='/clients/odoo/project')&&request.method==='POST'){
    let b=null;try{b=JSON.parse(await request.text());}catch{problem('Invalid request.');}
    return createInOdoo(env,url,me,b);
  }
  // Odoo sync: anyone signed in may refresh a stale catalog (it only copies Odoo's projects in);
  // forcing an immediate sync is for administrators.
  if(url.pathname==='/clients/odoo-sync'){
    if(request.method!=='POST')problem('Use POST.',405);
    const force=url.searchParams.get('force')==='1';if(force&&me.role!=='admin')problem('Only administrators manage the client catalog.',403,'forbidden');
    let result;try{result=await syncCatalogFromOdoo(env,{force});}catch(e){if(e instanceof BusinessError)throw e;problem("Couldn't read projects from Odoo: "+(e.message||'unknown error'),502,'odoo');}
    return Response.json({...result,...(result.changed?{catalog:await catalogRoutes(new Request(url,{method:'GET'}),env,new URL('/clients',url),me).then(r=>r.json())}:{})},{headers:{'Cache-Control':'no-store'}});
  }
  if(url.pathname==='/clients/projects'&&request.method==='GET'){
    if(me.role!=='admin')problem('Only administrators manage the client catalog.',403,'forbidden');
    const catalog=await readCatalog(env);
    return Response.json({revision:catalog.revision,projects:projectRows(catalog,env)},{headers:{'Cache-Control':'no-store'}});
  }
  if((url.pathname==='/clients/odoo/candidates'&&request.method==='GET')||(url.pathname==='/clients/odoo/link'&&request.method==='POST')){
    if(me.role!=='admin')problem('Only administrators manage the client catalog.',403,'forbidden');
    if(!odooConfigured(env))problem('Odoo is not connected.',501,'odoo_off');
    const linking=url.pathname.endsWith('/link');
    let b=null;if(linking){try{b=JSON.parse(await request.text());}catch{problem('Invalid request.');}}
    const store=requireStore(env),key=catalogKey(env),raw=await store.get(key),catalog=raw?JSON.parse(raw):{revision:0,entries:[]};
    if(linking&&(!b||b.revision!==catalog.revision))problem('Catalog changed. Refresh.',409,'conflict');
    const entry=catalog.entries.find(e=>e.id===(linking?b.id:url.searchParams.get('id'))&&e.parentId);
    if(!entry)problem('Project not found.',404,'not_found');
    if((entry.sources||[]).some(s=>s.source==='odoo'))problem('This project is already linked to Odoo.',409,'exists');
    let candidates;try{candidates=await mapCandidates(env,catalog,entry);}catch(e){if(e instanceof BusinessError)throw e;problem("Couldn't read projects from Odoo: "+String(e.message||'unknown error').slice(0,200),502,'odoo');}
    if(!linking)return Response.json({candidates},{headers:{'Cache-Control':'no-store'}});
    const row=Number(b.odooId);
    if(!candidates.some(c=>c.odooId===row))problem('That Odoo project does not match this project. Only an unlinked Odoo project with the same name, under the same contact, can be mapped.',400,'not_candidate');
    const next=structuredClone(catalog);next.entries.find(e=>e.id===entry.id).sources=[...(entry.sources||[]),{source:'odoo',row}];next.revision=catalog.revision+1;
    if(!await store.compareAndSet(key,raw,JSON.stringify(next)))problem('Catalog changed. Refresh.',409,'conflict');
    return Response.json(next,{headers:{'Cache-Control':'no-store'}});
  }
  const store=requireStore(env),catalog=await readCatalog(env),admin=me.role==='admin';
  if(request.method==='GET')return Response.json({revision:catalog.revision,entries:catalog.entries.map(e=>admin?e:({id:e.id,name:e.name,...(e.aiName?{aiName:e.aiName}:{}),parentId:e.parentId,archived:e.archived}))},{headers:{'Cache-Control':'no-store'}});
  if(!admin)problem('Only administrators manage the client catalog.',403,'forbidden');
  const raw=await request.text();if(raw.length>2000000)problem('Catalog request too large.',413);
  let b;try{b=JSON.parse(raw);}catch{problem('Invalid catalog request.');}
  if(!b||typeof b!=='object'||Array.isArray(b))problem('Invalid catalog request.');
  if(request.method==='POST'&&url.pathname==='/clients/import/preview'){const {preview}=await prepareImport(catalog,b.rows);return Response.json({revision:catalog.revision,...preview});}
  if(!['POST','PUT'].includes(request.method))problem('Unsupported catalog method.',405);
  if(b.revision!==catalog.revision)problem('Catalog changed. Refresh the preview.',409,'conflict');
  let next;
  if(url.pathname==='/clients/import')next=(await prepareImport(catalog,b.rows)).next;
  else if(url.pathname==='/clients'){
    next=structuredClone(catalog);
    if(b.id){const e=next.entries.find(e=>e.id===b.id);if(!e)problem('Client not found.',404);if('name'in b)e.name=cleanName(b.name);if('archived'in b){if(typeof b.archived!=='boolean')problem('Invalid archive value.');e.archived=b.archived;}if('aiName'in b){if(b.aiName===''||b.aiName===null)delete e.aiName;else e.aiName=cleanName(b.aiName).slice(0,80);}}
    else {const parentId=b.parentId||null;if(parentId&&!next.entries.some(e=>e.id===parentId&&!e.parentId&&!e.archived))problem('Choose an active parent client.');const name=cleanName(b.name);next.entries.push({id:await idFor(parentId,name),name,parentId,archived:false,sources:[]});}
    const seen=new Set();for(const e of next.entries){const k=(e.parentId||'')+'|'+nameKey(e.name);if(seen.has(k))problem('This client or project already exists.');seen.add(k);}
  }else problem('Not found.',404);
  next.revision=catalog.revision+1;
  const key=catalogKey(env),previous=await store.get(key);
  if(previous&&JSON.parse(previous).revision!==catalog.revision)problem('Catalog changed. Refresh.',409,'conflict');
  if(!(previous===null?await store.setIfAbsent(key,JSON.stringify(next),315360000):await store.compareAndSet(key,previous,JSON.stringify(next))))problem('Catalog changed. Refresh.',409,'conflict');
  return Response.json(next,{headers:{'Cache-Control':'no-store'}});
}
// An internal ticket opened without a client goes under the "Internal" client and its "Internal" project. Both are
// created when missing, and restored when archived, so new internal tickets always have a place. Anyone can change them later.
export const INTERNAL_CLIENT='Internal';
export async function internalDefaults(env){
  const store=requireStore(env);
  for(let attempt=0;;attempt++){
    const key=catalogKey(env),previous=await store.get(key),catalog=previous?JSON.parse(previous):{revision:0,entries:[]};
    const next=structuredClone(catalog);
    const same=(e,parentId,name)=>(e.parentId||null)===parentId&&nameKey(e.name)===nameKey(name);
    let client=next.entries.find(e=>same(e,null,INTERNAL_CLIENT));
    if(!client){client={id:await idFor(null,INTERNAL_CLIENT),name:INTERNAL_CLIENT,parentId:null,archived:false,sources:[]};next.entries.push(client);}
    let project=next.entries.find(e=>same(e,client.id,INTERNAL_CLIENT));
    if(!project){project={id:await idFor(client.id,INTERNAL_CLIENT),name:INTERNAL_CLIENT,parentId:client.id,archived:false,sources:[]};next.entries.push(project);}
    for(const e of [client,project])if(e.archived){e.archived=false;delete e.archivedBy;}
    if(JSON.stringify(next.entries)===JSON.stringify(catalog.entries))return {clientId:client.id,subClientId:project.id};
    next.revision=catalog.revision+1;
    if(previous===null?await store.setIfAbsent(key,JSON.stringify(next),315360000):await store.compareAndSet(key,previous,JSON.stringify(next)))return {clientId:client.id,subClientId:project.id};
    if(attempt>=2)problem('Catalog changed. Try again.',409,'conflict');
  }
}
// readTickets(keys) (optional) checks many tickets at once and returns {key:true} for the ones this person may see.
// actualHours stays the baseline (what the editor changes); totalActualHours adds the logged work.
// agreed is the stored value (users never get it): the overage flag is added on every read, the number is not.
const logged=(record,summary,agreed,me)=>{const minutes=summary?.loggedMinutes||0;if(!minutes&&agreed==null)return record;
  const {overage,overHours}=overageOf(agreed,minutes);
  return {...record,loggedMinutes:minutes,totalActualHours:withLogged(record,{loggedMinutes:minutes}).actualHours,overage,...(me.role==='admin'?{overHours}:{})};};
export async function metadataRoutes(request,env,url,me,readTicket,readTickets) {
  requireStore(env);
  if(url.pathname==='/ticket-metadata/import'||url.pathname==='/ticket-metadata/import/preview')return bulkImportRoutes(request,env,url,me,readTicket);
  const raw=request.method==='GET'?'':await request.text();
  if(raw.length>64000)problem('Ticket fields request too large.',413);
  let b=null;if(raw){try{b=JSON.parse(raw);}catch{problem('Invalid ticket fields request.');}}
  const validKey=k=>typeof k==='string'&&k.length<=80&&/^[A-Z][A-Z0-9_]*-[0-9]+$/.test(k)&&['INT',env.JIRA_PROJECT].includes(k.split('-')[0]);
  const key=url.searchParams.get('key')||b?.key;
  if(url.pathname==='/ticket-metadata/batch'&&request.method==='POST'){
    if(!Array.isArray(b?.keys)||b.keys.length>100||b.keys.some(k=>!validKey(k)))problem('Supply up to 100 valid ticket keys.');
    const store=env.STORE,keys=[...new Set(b.keys)],records={};
    // The whole list in a few round trips: visibility in bulk, then every ticket's fields in one read.
    const [catalog,visible,snapshot]=await Promise.all([readCatalog(env),readTickets?readTickets(keys):null,readOdooProjects(env)]),projects=projectIndex(snapshot);
    let shown=keys;
    if(visible)shown=keys.filter(k=>visible[k]);
    else{const seen=[];for(let offset=0;offset<keys.length;offset+=8)await Promise.all(keys.slice(offset,offset+8).map(async k=>{if(await readTicket(k))seen.push(k);}));shown=seen;}
    const raws=!shown.length?[]:store.mget?await store.mget(shown.map(k=>metadataKey(env,k))):await Promise.all(shown.map(k=>store.get(metadataKey(env,k))));
    const sums=await readSummaries(env,shown);
    shown.forEach((k,n)=>{const rec=migrateDash({...empty(),...JSON.parse(raws[n]||'{}')});records[k]=logged(publicMetadata(rec,me,catalog,projects),sums[k],rec.agreedHours,me);});
    return Response.json({records},{headers:{'Cache-Control':'no-store'}});
  }
  if(!validKey(key))problem('Choose a valid ticket.');
  return withTicketLock(env,key,async()=>{
    const t=await readTicket(key);if(!t)problem('Ticket unavailable.',404,'not_found');
    if(request.method==='GET'){const m=await readMetadata(env,key),summary=summarize(await ticketEntries(env,key));return Response.json({metadata:logged(publicMetadata(m,me,await readCatalog(env),projectIndex(await readOdooProjects(env))),summary,m.agreedHours,me),workEntries:summary.entries,history:publicHistory(m,me),closed:t.closed},{headers:{'Cache-Control':'no-store'}});}
    if(request.method==='PUT'){
      const metadata=await saveMetadata(env,key,b.fields,me,{closed:t.closed,ticket:{title:t.title,assignee:t.assignee}});
      // Work already in Odoo as its own lines stays there: the administrator is told how many.
      const synced=b.fields&&b.fields.agreedHours!=null&&'agreedHours' in b.fields?await syncedEntryCount(env,key):0;
      return Response.json({metadata,...(synced?{warning:synced+' work '+(synced===1?'entry is':'entries are')+' already in Odoo as '+(synced===1?'its own line':'their own lines')+'. They stay there, so the agreed hours and these lines both count in Odoo. Remove the extra lines in Odoo by hand.'}:{})});
    }
    problem('Use GET or PUT.',405);
  });
}

// ---- Agreed hours from a CSV (administrators) ----
// Rows of ticket key and agreed hours. The preview checks each row; apply saves the valid rows through saveMetadata,
// so the drawer's rules hold (closed tickets, the developer for the Odoo line, the agreed line's history).
const IMPORT_LIMIT=100;
export async function agreedImportPreview(env,rows,readTicket){
  if(!Array.isArray(rows)||!rows.length)problem('Add at least one row with a ticket key and agreed hours.');
  if(rows.length>IMPORT_LIMIT)problem('Import up to '+IMPORT_LIMIT+' rows at a time.');
  const seen=new Set(),out=[];
  for(const [i,r] of rows.entries()){
    const row={row:i+1,key:typeof r?.key==='string'?r.key.trim().toUpperCase():'',agreedHours:null,status:'error',message:''};
    const fail=message=>{row.message=message;return row;};
    const raw=r?.agreedHours,hours=typeof raw==='number'?raw:typeof raw==='string'&&raw.trim()!==''?Number(raw.trim()):NaN;
    if(!/^(?:INT|[A-Z][A-Z0-9_]*)-[0-9]+$/.test(row.key)||!['INT',env.JIRA_PROJECT].includes(row.key.split('-')[0])){out.push(fail('Unknown ticket key.'));continue;}
    if(seen.has(row.key)){out.push(fail('Listed more than once.'));continue;}seen.add(row.key);
    if(!validHours(hours)){out.push(fail('Agreed hours must be a positive number with up to two decimal places, e.g. 12.5.'));continue;}
    row.agreedHours=hours;
    const t=await readTicket(row.key);
    if(!t){out.push(fail('Ticket not found or not visible.'));continue;}
    if(t.closed){out.push(fail('This ticket is closed. Reopen it before setting agreed hours.'));continue;}
    row.title=t.title||'';row.status='ok';row.message='Will set '+hours+' h.';out.push(row);
  }
  return {rows:out,ok:out.filter(r=>r.status==='ok').length,errors:out.filter(r=>r.status==='error').length};
}
export async function agreedImportApply(env,me,rows,readTicket){
  const preview=await agreedImportPreview(env,rows,readTicket);
  if(preview.errors)problem('Fix the rows marked as errors, then apply again.',400,'import_errors',{rows:preview.rows});
  let applied=0;const failed=[];
  for(const r of preview.rows){
    const t=await readTicket(r.key),current=await readMetadata(env,r.key);
    try{await saveMetadata(env,r.key,{revision:current.revision,agreedHours:r.agreedHours},me,{closed:t.closed,ticket:{title:t.title,assignee:t.assignee}});applied++;}
    catch(err){if(err instanceof BusinessError)failed.push({key:r.key,message:err.message});else throw err;}
  }
  return {applied,failed};
}
export async function agreedImportRoutes(request,env,url,me,readTicket){
  if(me.role!=='admin')problem('Only administrators can set agreed hours.',403,'forbidden');
  if(request.method!=='POST')problem('Use POST.',405);
  requireStore(env);
  const raw=await request.text();if(raw.length>200000)problem('Import request too large.',413);
  let b;try{b=JSON.parse(raw);}catch{problem('Invalid import request.');}
  if(!b||typeof b!=='object'||Array.isArray(b))problem('Invalid import request.');
  if(url.pathname==='/agreed-hours/import/preview')return Response.json(await agreedImportPreview(env,b.rows,readTicket),{headers:{'Cache-Control':'no-store'}});
  if(url.pathname==='/agreed-hours/import')return Response.json(await agreedImportApply(env,me,b.rows,readTicket),{headers:{'Cache-Control':'no-store'}});
  problem('Not found.',404);
}

// ---- Bulk import of ticket business fields from a spreadsheet (administrators) ----
// Agreed hours, client, project and billing, one row per ticket key. A blank cell leaves that field as it is, so an
// import never clears anything. The preview works out each row's changes from the stored ticket and catalog; apply
// runs that again, refuses the whole file while any row is an error, then saves each ok row through saveMetadata
// against the revision it was planned on (a concurrent edit is reported as failed, the other rows still save).
const BULK_LIMIT=300,BULK_BODY=400000;
const BILLING_SPELLINGS=new Map([['billable','billable'],['not billable','not_billable'],['not_billable','not_billable'],['non billable','not_billable'],['non-billable','not_billable']]);
const blankCell=v=>v==null||(typeof v==='string'&&!v.trim());
const cellText=v=>typeof v==='string'?v.trim():typeof v==='number'&&Number.isFinite(v)?String(v):v==null?'':null;
const matchKey=n=>nameKey(n).replace(/\s+/g,' ');
const named=(e,k)=>[e.name,e.aiName].some(n=>n&&matchKey(n)===k);
const billingLabel=b=>b==null?null:b==='billable'?'Billable':'Not billable';
const keyOf=r=>typeof r?.key==='string'?r.key.trim().toUpperCase():'';
const bulkKeyOk=(env,k)=>/^(?:INT|[A-Z][A-Z0-9_]*)-[0-9]+$/.test(k)&&['INT',env.JIRA_PROJECT].includes(k.split('-')[0]);
// The client and project a row names. A client must be active and top level; a project must be active and under an
// active client. Without a client, a project comes from the ticket's current client, else from the one active project
// with that name in the catalog.
function bulkSelection(catalog,current,clientName,projectName){
  const top=catalog.entries.filter(e=>!e.parentId&&!e.archived),subs=catalog.entries.filter(e=>e.parentId&&!e.archived&&top.some(c=>c.id===e.parentId));
  let clientId=current.clientId,subClientId=current.subClientId;
  if(clientName){
    const found=top.filter(e=>named(e,matchKey(clientName)));
    if(!found.length)return {error:'Unknown client.'};
    if(found.length>1)return {error:'Several clients have this name.'};
    if(found[0].id!==current.clientId)subClientId=null;
    clientId=found[0].id;
  }
  if(projectName){
    const k=matchKey(projectName);
    let found=clientId?subs.filter(e=>e.parentId===clientId&&named(e,k)):[];
    if(!found.length&&!clientName&&!clientId)found=subs.filter(e=>named(e,k));
    if(found.length>1)return {error:'Several projects have this name. Fill in the Client column too.'};
    if(!found.length)return {error:clientId?'Unknown project for this client.':'Unknown project.'};
    clientId=found[0].parentId;subClientId=found[0].id;
  }
  return {clientId,subClientId};
}
async function bulkPlan(env,rows,readTicket){
  if(!Array.isArray(rows)||!rows.length)problem('Add at least one row with a ticket key and a field to change.');
  if(rows.length>BULK_LIMIT)problem('Import up to '+BULK_LIMIT+' rows at a time.');
  const catalog=await readCatalog(env),keys=[...new Set(rows.map(keyOf).filter(k=>bulkKeyOk(env,k)))],tickets=new Map();
  // A few tickets at a time, so a long file does not wait on one read after another.
  for(let o=0;o<keys.length;o+=8)await Promise.all(keys.slice(o,o+8).map(async k=>tickets.set(k,await readTicket(k))));
  const seen=new Set(),out=[],work=new Map();
  for(const [i,r] of rows.entries()){
    const row={row:i+1,line:Number.isInteger(r?.line)?r.line:null,key:keyOf(r),title:'',status:'error',message:'',changes:[]};
    const fail=message=>{row.message=message;out.push(row);};
    if(!bulkKeyOk(env,row.key)){fail('Unknown ticket key.');continue;}
    if(seen.has(row.key)){fail('Listed more than once.');continue;}seen.add(row.key);
    const [clientName,projectName,billingName]=[r.client,r.project,r.billing].map(cellText);
    if([clientName,projectName,billingName].includes(null)){fail('Client, project and billing must be text.');continue;}
    const raw=r.agreedHours;let hours=null;
    if(!blankCell(raw)){hours=typeof raw==='number'?raw:typeof raw==='string'&&/^\d+(\.\d{1,2})?$/.test(raw.trim())?Number(raw.trim()):NaN;if(!validHours(hours)){fail('Agreed hours must be a positive number with up to two decimal places, e.g. 12.5.');continue;}}
    const billing=billingName?BILLING_SPELLINGS.get(billingName.toLowerCase().replace(/\s+/g,' ')):null;
    if(billingName&&!billing){fail('Billing must be Billable or Not billable.');continue;}
    const t=tickets.get(row.key);
    if(!t){fail('Ticket not found or not visible.');continue;}
    row.title=t.title||'';
    if(t.closed){fail('This ticket is closed. Reopen it before changing its business fields.');continue;}
    const current=await readMetadata(env,row.key);
    let target={clientId:current.clientId,subClientId:current.subClientId};
    if(clientName||projectName){const sel=bulkSelection(catalog,current,clientName,projectName);if(sel.error){fail(sel.error);continue;}target=sel;}
    const patch={};
    if(target.clientId!==current.clientId||target.subClientId!==current.subClientId){
      const errors=selectionErrors(catalog,target,{active:true});if(errors.length){fail(errors.join('. ')+'.');continue;}
      // With Odoo, the ticket gets the Odoo project its catalog project links to (the client follows from it).
      if(odooConfigured(env)){
        const linked=(catalog.entries.find(e=>e.id===target.subClientId)?.sources||[]).filter(s=>s.source==='odoo').map(s=>s.row);
        if(linked.length!==1){fail(!target.subClientId?'Name a project: the client comes from it.':linked.length?'This project links several Odoo projects. Choose one on the ticket.':'This project has no Odoo project.');continue;}
        patch.odooProjectId=linked[0];
      }else Object.assign(patch,{clientId:target.clientId,subClientId:target.subClientId});
    }
    if(billing&&billing!==current.billing)patch.billing=billing;
    if(hours!==null&&hours!==current.agreedHours){
      if(!(t.assignee&&t.assignee!==INTERNAL_ASSIGNEE)){fail('Assign a developer first.');continue;}
      patch.agreedHours=hours;
    }
    const nameOf=id=>{const e=catalog.entries.find(x=>x.id===id);return e?shownName(e):null;};
    const changes=[];
    if('agreedHours' in patch)changes.push({field:'agreedHours',from:current.agreedHours,to:patch.agreedHours});
    if('clientId' in patch&&patch.clientId!==current.clientId)changes.push({field:'client',from:nameOf(current.clientId),to:nameOf(patch.clientId)});
    if('subClientId' in patch&&patch.subClientId!==current.subClientId)changes.push({field:'project',from:nameOf(current.subClientId),to:nameOf(patch.subClientId)});
    if('odooProjectId' in patch&&patch.odooProjectId!==current.odooProjectId){if(target.clientId!==current.clientId)changes.push({field:'client',from:nameOf(current.clientId),to:nameOf(target.clientId)});changes.push({field:'project',from:nameOf(current.subClientId),to:nameOf(target.subClientId)});}
    if('billing' in patch)changes.push({field:'billing',from:billingLabel(current.billing),to:billingLabel(patch.billing)});
    if(!changes.length){row.status='unchanged';row.message='No change. Blank cells are left unchanged.';out.push(row);continue;}
    const cleared=changes.some(c=>c.field==='project'&&c.to===null);
    row.status='ok';row.changes=changes;
    row.message='Will change '+changes.length+(changes.length===1?' field':' fields')+'. Blank cells are left unchanged.'+(cleared?' Changing the client clears the project.':'');
    work.set(row.key,{revision:current.revision,patch});out.push(row);
  }
  const count=s=>out.filter(r=>r.status===s).length;
  return {rows:out,ok:count('ok'),unchanged:count('unchanged'),errors:count('error'),work};
}
export async function bulkImportPreview(env,rows,readTicket){const {work,...plan}=await bulkPlan(env,rows,readTicket);return plan;}
export async function bulkImportApply(env,me,rows,readTicket){
  const plan=await bulkPlan(env,rows,readTicket);
  if(plan.errors)problem('Fix the rows marked as errors, then apply again.',400,'import_errors',{rows:plan.rows});
  let applied=0;const failed=[];
  for(const r of plan.rows.filter(r=>r.status==='ok')){
    const {revision,patch}=plan.work.get(r.key);
    try{
      await withTicketLock(env,r.key,async()=>{
        const t=await readTicket(r.key);if(!t)problem('Ticket not found or not visible.',404,'not_found');
        await saveMetadata(env,r.key,{revision,...patch},me,{closed:t.closed,ticket:{title:t.title,assignee:t.assignee}});
      });
      applied++;
    }catch(err){
      // saveMetadata throws 'busy' only from the agreed line, after the fields were saved.
      if(err instanceof BusinessError&&err.code==='busy'&&'agreedHours' in patch)failed.push({key:r.key,message:'Saved, but the Odoo line was busy. Ask an administrator to re-send the agreed hours for this ticket.'});
      else failed.push({key:r.key,message:err instanceof BusinessError?err.message:'Could not save this ticket.'});
    }
  }
  return {applied,unchanged:plan.unchanged,failed};
}
export async function bulkImportRoutes(request,env,url,me,readTicket){
  if(me.role!=='admin')problem('Only administrators can import ticket fields.',403,'forbidden');
  if(request.method!=='POST')problem('Use POST.',405);
  requireStore(env);
  const raw=await request.text();if(raw.length>BULK_BODY)problem('Import request too large.',413);
  let b;try{b=JSON.parse(raw);}catch{problem('Invalid import request.');}
  if(!b||typeof b!=='object'||Array.isArray(b))problem('Invalid import request.');
  if(url.pathname.endsWith('/preview'))return Response.json(await bulkImportPreview(env,b.rows,readTicket),{headers:{'Cache-Control':'no-store'}});
  return Response.json(await bulkImportApply(env,me,b.rows,readTicket),{headers:{'Cache-Control':'no-store'}});
}
