// Odoo projects with their hours, for administrators on the Clients page. Odoo is the list: every active project the
// dashboard's Odoo user can see, in any of its companies, whether or not a ticket, epic or work entry points to it.
// Logged hours are Odoo's own timesheet lines summed per project, so each hour counts once: a work log entry is one
// Odoo line, a ticket with agreed hours sends one line instead of its entries, time entered in Odoo directly counts
// the same way, and a project linked from two places is still one Odoo project. Work not in Odoo yet (still sending, or
// needing setup) is shown apart (pendingHours) and never added. Allocated hours are Odoo's own field on the project:
// Odoo keeps nothing when it is empty (not set), and an explicit 0 is an allocation.
// Tickets are linked by their Odoo project (odooProjectId in the ticket's business fields); open means not completed in
// the dashboard. Tickets needing review have an open pull request in the review queue (reviews.js).
import { odoo, odooConfigured } from './odoo.js';
import { BusinessError, readCatalog, requireStore, catalogKey, shownName, mainCompanyId, allocationField, allocatedHoursInput, readAllMetadata, readOdooProjects, projectIndex, recordProjectEvent, readProjectLog, syncStatus } from './ticket-metadata.js';
import { readEpicMap, isProject } from './epic-map.js';
import { projectBillingRows } from './billing.js';
import { readConfig, pendingByProject } from './time-entries.js';
import { ticketsAwaitingReview } from './reviews.js';
const problem=(message,status=400,code='project_budget')=>{throw new BusinessError(message,status,code);};
const round=n=>Math.round(n*100)/100;
const m2o=v=>Array.isArray(v)?{id:v[0],name:String(v[1]||'')}:null;
const odooLink=(env,id)=>String(env.ODOO_URL||'').replace(/\/+$/,'')+'/web#id='+id+'&model=project.project&view_type=form';
// At this share of the allocation a project is "near limit" (80%: logged hours at or above 0.8 × allocated).
export const NEAR_LIMIT=0.8;
// An explicit zero is an allocation: any logged time is over it. "Near limit" needs an allocation above zero.
export function budgetStatus(allocated,logged){
  if(allocated==null)return {status:'not_set',remainingHours:null,overHours:0,usedPercent:null};
  const remaining=round(allocated-logged);
  // Used share of the allocation; none for a zero allocation (nothing to divide by).
  const usedPercent=allocated>0?Math.round(logged/allocated*1000)/10:null;
  return {status:remaining<0?'over':allocated>0&&logged>=allocated*NEAR_LIMIT?'near':'on_track',remainingHours:remaining,overHours:remaining<0?-remaining:0,usedPercent};
}
// Odoo's UTC "YYYY-MM-DD HH:MM:SS" as an ISO time; null when Odoo has none.
const odooTime=v=>{if(!v)return null;const d=new Date(String(v).replace(' ','T')+'Z');return Number.isNaN(d.getTime())?null:d.toISOString();};
// Every company of the Odoo user, so projects of all of them are read (Odoo otherwise shows only the default one).
async function companyContext(env){
  const [u]=await odoo(env,'res.users','search_read',[[['login','=',env.ODOO_LOGIN]]],{fields:['company_ids'],limit:1});
  return Array.isArray(u?.company_ids)&&u.company_ids.length?{allowed_company_ids:u.company_ids}:{};
}
// Timesheet hours and the latest timesheet date per project in one grouped read (Odoo 19 renamed read_group to formatted_read_group).
async function hoursByProject(env,ids,context){
  if(!ids.length)return {hours:{},last:{}};
  const domain=[['project_id','in',ids]];let groups;
  try{groups=await odoo(env,'account.analytic.line','read_group',[domain,['unit_amount:sum','date:max'],['project_id']],{lazy:false,context});}
  catch{groups=(await odoo(env,'account.analytic.line','formatted_read_group',[domain,['project_id'],['unit_amount:sum','date:max']],{context})).map(g=>({project_id:g.project_id,unit_amount:g['unit_amount:sum'],date:g['date:max']}));}
  const hours={},last={};
  for(const g of groups){const id=Array.isArray(g.project_id)?g.project_id[0]:g.project_id;if(!id)continue;hours[id]=(hours[id]||0)+(Number(g.unit_amount)||0);const d=typeof g.date==='string'?g.date.slice(0,10):null;if(d&&(!last[id]||d>last[id]))last[id]=d;}
  return {hours,last};
}
// The tickets with work in a project: its tasks named "[KEY] Title", the name the work log gives them.
async function ticketsByProject(env,ids,context){
  const out={};if(!ids.length)return out;
  const tasks=await odoo(env,'project.task','search_read',[[['project_id','in',ids],['name','=like','[%]%']]],{fields:['name','project_id'],context:{...context,active_test:false},limit:20000});
  for(const t of tasks){const key=/^\[([A-Z][A-Z0-9_]*-\d+)\]/.exec(String(t.name||''))?.[1],p=m2o(t.project_id);if(key&&p)(out[p.id]||=new Set()).add(key);}
  return out;
}
// The dashboard tickets on each Odoo project, by their Odoo project: {all, open} keys.
function linkedTickets(all){
  const out={};
  for(const [key,m] of all)if(m.odooProjectId!=null){const l=(out[m.odooProjectId]||={all:[],open:[]});l.all.push(key);if(!m.completedAt)l.open.push(key);}
  return out;
}
const byKey=(a,b)=>a.localeCompare(b,undefined,{numeric:true});
// only: one project's id (any state, for its details view); without it, every active project.
export async function projectBudgets(env,{only=null}={}){
  const context=await companyContext(env);
  const [projects,allocation,main]=await Promise.all([
    // Archived projects are left out: Odoo's active flag is what it means to be in Odoo's project list.
    odoo(env,'project.project','search_read',[only?[['id','=',only]]:[['active','=',true]]],{fields:['name','partner_id','company_id','create_date','active'],order:'create_date desc,id desc',limit:5000,context:only?{...context,active_test:false}:context}),
    allocationField(env),mainCompanyId(env).catch(()=>null)]);
  if(allocation&&projects.length){const rows=await odoo(env,'project.project','read',[projects.map(p=>p.id)],{fields:['allocated_hours'],context:{...context,active_test:false}});const by=Object.fromEntries(rows.map(r=>[r.id,r.allocated_hours]));for(const p of projects)p.allocated_hours=by[p.id];}
  const ids=projects.map(p=>p.id);
  const [{hours,last},tickets,pending,catalog,epicMap,timeCfg,all,snapshot,reviews,sync]=await Promise.all([hoursByProject(env,ids,context),ticketsByProject(env,ids,context),pendingByProject(env),readCatalog(env),readEpicMap(env),readConfig(env).catch(()=>({mapping:{}})),
    readAllMetadata(env),readOdooProjects(env),ticketsAwaitingReview(env).catch(()=>new Map()),syncStatus(env)]);
  const known=projectIndex(snapshot),onProject=linkedTickets(all);
  // The dashboard projects linked to each Odoo project: from the catalog, and from Work log setup's mapping.
  const linked={},add=(odooId,entry)=>{if(!entry||entry.archived)return;const l=(linked[odooId]||=[]);if(!l.some(e=>e.id===entry.id))l.push(entry);};
  for(const e of catalog.entries)for(const s of e.sources||[])if(s.source==='odoo')add(s.row,e);
  for(const [id,odooId] of Object.entries(timeCfg.mapping||{}))if(id!=='helpdesk')add(Number(odooId),catalog.entries.find(e=>e.id===id));
  const helpdesk=Number(timeCfg.mapping?.helpdesk)||null;
  const label=e=>{const parent=e.parentId&&catalog.entries.find(c=>c.id===e.parentId);return (parent&&parent.name!=='No contact'?shownName(parent)+' / ':'')+shownName(e);};
  const rows=projects.map(p=>{
    const entries=linked[p.id]||[],epics=Object.entries(epicMap.map||{}).filter(([,entryId])=>entries.some(e=>e.id===entryId)).map(([key])=>key).sort();
    const keys=[...(tickets[p.id]||[])].sort(byKey),byPrefix={};
    for(const k of keys){const prefix=k.slice(0,k.lastIndexOf('-'));byPrefix[prefix]=(byPrefix[prefix]||0)+1;}
    const own=onProject[p.id]||{all:[],open:[]},review=own.open.filter(k=>reviews.has(k)).sort(byKey);
    // The client is the project's customer in Odoo; the snapshot has it as the company (for the main company's projects).
    const company=m2o(p.company_id),partner=m2o(p.partner_id),snap=known.get(p.id);
    const client=snap?(snap.clientId?{id:snap.clientId,name:snap.clientName}:null):partner;
    const allocated=allocation&&p.allocated_hours!==false&&p.allocated_hours!=null?round(Number(p.allocated_hours)):null,logged=round(hours[p.id]||0);
    return {odooId:p.id,name:String(p.name||''),client:client?.name||'',clientId:client?.id||null,missingClient:!client,archived:p.active===false,company:company?.name||'',url:odooLink(env,p.id),
      // Work is logged in the main company, so only its projects (and those of no company) can be linked here.
      linkable:!company||main==null||company.id===main,
      // Map tickets offers the same projects a ticket can be given: in the last sync, active, with a client.
      label:snap?.label||null,assignable:!!(snap&&snap.active&&snap.clientId),
      blocked:!snap?'Not in the last sync from Odoo.':!snap.active?'Archived in Odoo.':!snap.clientId?'No client in Odoo.':null,
      links:{projects:entries.map(e=>({id:e.id,name:label(e)})),epics,helpdesk:helpdesk===p.id,tickets:{count:keys.length,byProject:byPrefix,keys:keys.slice(0,200)}},
      mapped:!!(entries.length||epics.length||keys.length||own.all.length||helpdesk===p.id),
      ticketCount:own.all.length,openTickets:own.open.length,reviewTickets:review.length,reviewKeys:review.slice(0,50),lastWorkDate:last[p.id]||null,
      createdAt:odooTime(p.create_date),allocatedHours:allocated,loggedHours:logged,pendingHours:round((pending[p.id]||0)/60),...budgetStatus(allocated,logged)};
  });
  const shown=new Set(ids),unplaced=Object.entries(pending).filter(([id])=>!shown.has(Number(id))).reduce((n,[,m])=>n+m,0);
  return {allocation,nearLimit:NEAR_LIMIT,unplacedPendingHours:round(unplaced/60),sync,projects:rows,_tickets:only?{own:onProject[only]||{all:[],open:[]},all,reviews}:undefined};
}
// One project for its details view: the row, its tickets (with pull requests waiting for review), recent timesheet lines,
// and what was done to it from the dashboard.
async function projectDetails(env,id){
  const data=await projectBudgets(env,{only:id}),row=data.projects[0];
  if(!row)problem('That Odoo project was not found.',404,'not_found');
  const {own,all,reviews}=data._tickets,context=await companyContext(env);
  const tickets=own.all.sort(byKey).map(key=>{const m=all.get(key);return {key,open:!m.completedAt,completedAt:m.completedAt||null,prs:reviews.get(key)||[]};});
  const [lines,count]=await Promise.all([
    odoo(env,'account.analytic.line','search_read',[[['project_id','=',id]]],{fields:['date','name','unit_amount','employee_id','user_id','task_id'],order:'date desc,id desc',limit:50,context}),
    odoo(env,'account.analytic.line','search_count',[[['project_id','=',id]]],{context}).catch(()=>null)]);
  return {project:row,allocation:data.allocation,nearLimit:NEAR_LIMIT,sync:data.sync,tickets,reviews:tickets.filter(t=>t.open&&t.prs.length),
    workLogs:{total:count,lines:lines.map(l=>({id:l.id,date:l.date,description:String(l.name||''),hours:round(Number(l.unit_amount)||0),person:m2o(l.employee_id)?.name||m2o(l.user_id)?.name||'',task:m2o(l.task_id)?.name||''}))},
    history:await readProjectLog(env,id)};
}
// Each row's billing (default, work, consumption, allowance status, last alert) while billing classification is on
// (billing.js); a billing failure leaves the table as it is, with the reason.
async function withBilling(env,data){
  let b;try{b=await projectBillingRows(env);}catch(e){return {...data,billing:{error:String(e.message||e).slice(0,200)}};}
  if(!b)return {...data,billing:null};
  const blank={default:null,status:'needs_setup',actualMinutes:0,billableMinutes:0,chargeableMinutes:0,unclassifiedMinutes:0,pendingSyncMinutes:0,allowance:null,email:null,odooDirectMinutes:0};
  return {...data,projects:data.projects.map(p=>({...p,billing:b.rows[p.odooId]||blank})),billing:{scan:b.scan,error:null}};
}
export async function projectBudgetRoutes(request,env,url,me){
  if(me.role!=='admin')problem('Only administrators see project hours.',403,'forbidden');
  if(!odooConfigured(env))problem('Odoo is not connected.',501,'odoo_off');
  const json=d=>Response.json(d,{headers:{'Cache-Control':'no-store'}}),odooFail=e=>{if(e instanceof BusinessError)throw e;problem("Couldn't read projects from Odoo: "+String(e.message||'unknown error').slice(0,200),502,'odoo');};
  if(url.pathname==='/clients/odoo-projects'&&request.method==='GET'){try{const {_tickets,...data}=await projectBudgets(env);return json(await withBilling(env,data));}catch(e){odooFail(e);}}
  if(url.pathname==='/clients/odoo-projects/details'&&request.method==='GET'){
    const id=Number(url.searchParams.get('id'));if(!Number.isInteger(id)||id<1)problem('Choose an Odoo project.');
    try{return json(await projectDetails(env,id));}catch(e){odooFail(e);}
  }
  let b;try{b=JSON.parse(await request.text());}catch{problem('Invalid request.');}
  if(!b||typeof b!=='object')problem('Invalid request.');
  const odooId=Number(b.odooId);if(!Number.isInteger(odooId)||odooId<1)problem('Choose an Odoo project.');
  const context=await companyContext(env).catch(odooFail);
  const [project]=await odoo(env,'project.project','search_read',[[['id','=',odooId]]],{fields:['company_id'],limit:1,context}).catch(odooFail);
  if(!project)problem('That Odoo project was not found or is archived.',404,'not_found');
  // Allocated hours: written to the Odoo project. Empty clears it (Odoo stores nothing, so it reads as not set); 0 is kept.
  // Each change is kept in the project's history with the value it replaced.
  if(url.pathname==='/clients/odoo-projects/allocation'&&request.method==='PUT'){
    if(!await allocationField(env))problem("This Odoo has no allocated hours on projects (Timesheets).",501,'no_allocation');
    const input=allocatedHoursInput(b.hours),hours=input===undefined?null:input;
    let before=null;
    try{
      const [r]=await odoo(env,'project.project','read',[[odooId]],{fields:['allocated_hours'],context});before=r&&r.allocated_hours!==false&&r.allocated_hours!=null?round(Number(r.allocated_hours)):null;
      await odoo(env,'project.project','write',[[odooId],{allocated_hours:hours}],{context});
    }catch(e){odooFail(e);}
    if(before!==hours)await recordProjectEvent(env,odooId,me,{type:'allocation',from:before,to:hours});
    return json({odooId,allocatedHours:hours});
  }
  // Linking a dashboard project to this Odoo project (or unlinking it). The work of tickets on that project then goes
  // here. An unlink is remembered, so the Odoo sync doesn't link the same names back.
  if(url.pathname==='/clients/odoo-projects/link'&&request.method==='POST'){
    const main=await mainCompanyId(env).catch(()=>null),company=m2o(project.company_id);
    if(company&&main!=null&&company.id!==main)problem('Only projects of the main Odoo company (or of no company) can be linked: work is logged there.',400,'other_company');
    const store=requireStore(env),key=catalogKey(env),raw=await store.get(key),catalog=raw?JSON.parse(raw):{revision:0,entries:[]};
    if(b.revision!==catalog.revision)problem('Catalog changed. Refresh.',409,'conflict');
    const next=structuredClone(catalog),entry=next.entries.find(e=>e.id===b.entryId);
    if(!entry||!isProject(catalog,entry))problem('Choose a dashboard project.',404,'not_found');
    const odooOf=e=>(e.sources||[]).filter(s=>s.source==='odoo').map(s=>s.row);
    if(b.unlink===true){
      if(!odooOf(entry).includes(odooId))problem('This project is not linked to that Odoo project.',409,'not_linked');
      entry.sources=entry.sources.filter(s=>!(s.source==='odoo'&&s.row===odooId));entry.odooUnlinked=[...new Set([...(entry.odooUnlinked||[]),odooId])];
    }else{
      if(entry.archived)problem('Choose an active dashboard project.');
      const other=odooOf(entry).find(id=>id!==odooId);if(other)problem('This project is already linked to Odoo #'+other+'. Unlink it there first.',409,'exists');
      if(odooOf(entry).includes(odooId))problem('Already linked.',409,'exists');
      (entry.sources||=[]).push({source:'odoo',row:odooId});entry.odooUnlinked=(entry.odooUnlinked||[]).filter(id=>id!==odooId);if(!entry.odooUnlinked.length)delete entry.odooUnlinked;
    }
    next.revision=catalog.revision+1;
    if(!await store.compareAndSet(key,raw,JSON.stringify(next)))problem('Catalog changed. Refresh.',409,'conflict');
    return json(next);
  }
  problem('Not found.',404);
}
