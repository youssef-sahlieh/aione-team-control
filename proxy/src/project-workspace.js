// The project billing workspace on the Clients page (administrators only): one Odoo project's tickets with their
// billing, hours and sync state, and the spreadsheet import that changes project defaults, allocations and ticket
// billing fields. Nothing here keeps numbers of its own: the allocation is Odoo's allocated hours (saveAllocation),
// billing defaults, overrides and consumption are billing.js's, agreed hours and a ticket's project are its business
// fields (saveMetadata). An import calls only those saves, so their rules, histories, ledgers and Odoo pushes all
// hold, and it never writes work, consumption, exports or sync ids. "Allocation exhausted" emails stay with the
// scheduled billing check, which sends each allowance's alert once (so an import never emails by itself).
//
// Tickets of a project: those whose business fields name it, those with work on it (entries and agreed hours, Helpdesk
// tickets included) and its Odoo tasks named "[KEY] …". A key is listed once however many of these find it, and an
// Odoo task is never a ticket of its own, so nothing counts twice. Figures cover the project's scope: from its active
// allowance's start, else the last 365 days (the Clients table's own), or a chosen period.
import { odoo } from './odoo.js';
import { BusinessError, requireStore, readMetadata, saveMetadata, withTicketLock, agreedDeveloperOf, developerList, ticketDevelopers, validHours, allocatedHoursInput, allocationField, readOdooProjects, projectIndex, readProjectLog } from './ticket-metadata.js';
import { billingSnapshot, readBillingConfig, workRows, saveProjectDefault, saveTicket, readMarkers, readLedgers, reconcileTicket, readProjectDefaults } from './billing.js';
import { companyContext, ticketsByProject, saveAllocation } from './project-budget.js';
import { todayIn, sourceOf, agreedLineSent } from './time-entries.js';

const problem=(message,status=400,code='workspace',details={})=>{throw new BusinessError(message,status,code,details);};
const json=d=>Response.json(d,{headers:{'Cache-Control':'no-store'}});
export const TICKET_LIMIT=500,ALL_LIMIT=5000,IMPORT_LIMIT=300,PREVIEW_CHARS=280;
const BODY_LIMIT=400000;
// The import's explicit "empty this" marker: a blank cell always means "leave as it is".
export const CLEAR='[clear]';
const addDays=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const validDate=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
const activeOn=(a,date)=>a.enabled&&date>=a.startDate&&(!a.endDate||date<=a.endDate);
const byKey=(a,b)=>a.localeCompare(b,undefined,{numeric:true});
const round=n=>Math.round(n*100)/100;
const m2o=v=>Array.isArray(v)?{id:v[0],name:String(v[1]||'')}:null;
const htmlText=s=>String(s||'').replace(/<(br|\/p|\/div|\/li)[^>]*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/\n{3,}/g,'\n\n').trim();
const norm=s=>String(s??'').trim().toLowerCase().replace(/\s+/g,' ');
const cell=v=>v==null?'':String(v).trim();
const isClear=v=>cell(v).toLowerCase()===CLEAR;
const pool=async(items,n,fn)=>{const out=new Array(items.length);let i=0;await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(i<items.length){const k=i++;out[k]=await fn(items[k],k);}}));return out;};

// ---- The ticket list ----
// The period a project's figures cover: from its active allowance's start, else the last 365 days.
function scopeOf(snap,id,today){
  const a=snap.d.allowances.items.find(x=>x.enabled&&x.projectIds.includes(id)&&activeOn(x,today));
  return a?{from:a.startDate,to:today,label:'Since the allocation started ('+a.startDate+')'}:{from:addDays(today,-365),to:today,label:'Last 365 days'};
}
function periodOf(q,today){
  if(!q.from&&!q.to)return null;
  const from=q.from||addDays(today,-365),to=q.to||today;
  if(!validDate(from)||!validDate(to))problem('Choose valid dates.');
  if(from>to)problem('The start date is after the end date.');
  if(Date.parse(to)-Date.parse(from)>400*86400000)problem('Choose at most about a year.');
  return {from,to,label:from+' to '+to,custom:true};
}
// What each ticket has on this project in the period: work, what it charges, and what isn't in Odoo yet.
function workByTicket(snap,scope,projectId){
  const out=new Map();
  for(const r of snap.rows){
    if(r.date<scope.from||r.date>scope.to||(projectId!=null&&r.projectId!==projectId))continue;
    const w=out.get(r.ticket)||{actualMinutes:0,chargeableMinutes:0,entries:0,pendingMinutes:0,review:0,projectId:r.projectId};
    w.actualMinutes+=r.actualMinutes;w.chargeableMinutes+=r.chargeableMinutes;
    if(r.kind==='entry'){w.entries++;if(['syncing','setup'].includes(r.state))w.pendingMinutes+=r.actualMinutes;if(r.state==='review')w.review++;}
    out.set(r.ticket,w);
  }
  return out;
}
function exportedByTicket(markers){
  const out=new Map();
  for(const m of markers.values()){if(!m.ticket)continue;const e=out.get(m.ticket)||{charges:0,minutes:0};e.charges++;e.minutes+=m.minutes||0;out.set(m.ticket,e);}
  return out;
}
const preview=s=>{const t=String(s||'').replace(/\s+/g,' ').trim();return t.length>PREVIEW_CHARS?t.slice(0,PREVIEW_CHARS-1)+'…':t;};
function ticketRow(env,key,{snap,work,ledger,exported,details,projectId}){
  const hd=sourceOf(env,key)==='odoo',m=hd?null:snap.d.metas.get(key)||null,rec=snap.d.tickets[key]||null,w=work.get(key);
  const pid=hd?(w?.projectId??projectId):m?.odooProjectId??null,override=hd?rec?.billing??null:m?.billing??null;
  const def=snap.projectDefault(pid),effective=override==='billable'||override==='not_billable'?{value:override,source:'ticket'}:def?{value:def,source:'project'}:{value:'unclassified',source:'none'};
  const t=details?.[key];
  return {key,source:sourceOf(env,key),projectId:pid,onProject:projectId==null||pid===projectId,revision:hd?rec?.revision||0:m?.revision||0,
    override,effective,estimatedHours:m?.estimatedHours??null,agreedHours:m?.agreedHours??null,agreedDeveloper:m?.agreedDeveloper||null,agreedDev:m?.agreedDev||null,agreedDate:m?.agreedDate||null,
    actualMinutes:w?.actualMinutes||0,chargeableMinutes:w?.chargeableMinutes||0,entries:w?.entries||0,consumedMinutes:ledger?.consumedMinutes||0,
    sync:{pendingMinutes:w?.pendingMinutes||0,review:w?.review||0,billingField:rec?.odoo?{state:rec.odoo.state,error:rec.odoo.error||null,at:rec.odoo.at||null}:null},
    exported:exported.get(key)||{charges:0,minutes:0},completedAt:m?.completedAt||null,
    ...(t?{title:t.title||'',description:preview(t.description),descriptionLength:String(t.description||'').length,status:t.status||'',closed:!!t.closed,devs:t.devs||[],assignee:t.assignee||''}:{})};
}
export async function projectTickets(env,id,q,{readDetails}){
  const today=todayIn(),custom=periodOf(q,today),context=await companyContext(env);
  const [snap,markers,cfg,tasks,[project]]=await Promise.all([billingSnapshot(env,custom?{from:custom.from,to:custom.to}:{from:addDays(today,-365)}),readMarkers(env),readBillingConfig(env),
    ticketsByProject(env,[id],context),odoo(env,'project.project','search_read',[[['id','=',id]]],{fields:['name','description'],limit:1,context:{...context,active_test:false}})]);
  if(!project)problem('That Odoo project was not found.',404,'not_found');
  const scope=custom||scopeOf(snap,id,today),work=workByTicket(snap,scope,id),keys=new Set(work.keys());
  for(const [k,m] of snap.d.metas)if(m.odooProjectId===id)keys.add(k);
  for(const k of tasks[id]||[])keys.add(k);
  const all=[...keys].filter(k=>sourceOf(env,k)).sort(byKey),shown=all.slice(0,TICKET_LIMIT);
  let details={},detailsError=null;
  try{details=await readDetails(shown);}catch(e){detailsError='Ticket titles and statuses could not be read: '+String(e.message||e).slice(0,160);}
  const ledgers=await readLedgers(env,shown),exported=exportedByTicket(markers);
  // The project's default is sent with the tickets, so an inheriting ticket follows it after a change without a reload of the page.
  return {project:{odooId:id,name:String(project.name||''),description:htmlText(project.description).slice(0,4000),default:snap.projectDefault(id)},scope,classification:!!cfg.classification,
    total:all.length,truncated:all.length>shown.length,limit:TICKET_LIMIT,detailsError,
    tickets:shown.map(key=>ticketRow(env,key,{snap,work,ledger:ledgers[key],exported,details,projectId:id}))};
}
// Every project's tickets at once, without titles (the page has them), for an export of all projects.
export async function allProjectTickets(env,q){
  const today=todayIn(),custom=periodOf(q,today);
  const [snap,markers]=await Promise.all([billingSnapshot(env,custom?{from:custom.from,to:custom.to}:{from:addDays(today,-365)}),readMarkers(env)]);
  const keys=new Set();for(const r of snap.rows)if(r.projectId!=null)keys.add(r.ticket);for(const [k,m] of snap.d.metas)if(m.odooProjectId!=null)keys.add(k);
  const all=[...keys].filter(k=>sourceOf(env,k)).sort(byKey),shown=all.slice(0,ALL_LIMIT),exported=exportedByTicket(markers),ledgers=await readLedgers(env,shown);
  // Each ticket's work in its own project's scope; a ticket with work on two projects is listed once per project.
  const out=[],scopes=new Map(),scopeFor=id=>{if(!scopes.has(id))scopes.set(id,custom||scopeOf(snap,id,today));return scopes.get(id);};
  const projectsOf=new Map();for(const r of snap.rows)if(r.projectId!=null&&keys.has(r.ticket))(projectsOf.get(r.ticket)||projectsOf.set(r.ticket,new Set()).get(r.ticket)).add(r.projectId);
  const perProject=new Map(),workFor=id=>{if(!perProject.has(id))perProject.set(id,workByTicket(snap,scopeFor(id),id));return perProject.get(id);};
  for(const key of shown){
    const m=snap.d.metas.get(key),ids=new Set([...(projectsOf.get(key)||[]),...(m?.odooProjectId!=null?[m.odooProjectId]:[])]);
    for(const id of ids)if(id!=null){const row=ticketRow(env,key,{snap,work:workFor(id),ledger:ledgers[key],exported,details:null,projectId:id});out.push({...row,projectId:id,scope:scopeFor(id)});}
  }
  return {classification:!!(await readBillingConfig(env)).classification,total:all.length,truncated:all.length>shown.length,limit:ALL_LIMIT,tickets:out};
}

// ---- Import ----
const PROJECT_BILLING=new Map([['billable','billable'],['not billable','not_billable'],['not_billable','not_billable'],['non billable','not_billable'],['non-billable','not_billable'],['not classified',null],['unclassified',null],[CLEAR,null]]);
const TICKET_BILLING=new Map([['billable','billable'],['not billable','not_billable'],['not_billable','not_billable'],['non billable','not_billable'],['non-billable','not_billable'],['inherit','inherit'],['inherit project','inherit'],['project default','inherit'],[CLEAR,'inherit']]);
const LABEL={billable:'Billable',not_billable:'Not billable',inherit:'Inherit project',null:'Not classified'};
// undefined: leave as it is; null: clear; else the number. Commas are decimal points (12,5).
function hoursCell(v){
  if(cell(v)==='')return undefined;if(isClear(v))return null;
  const s=cell(v).replace(',','.');if(!/^\d+(\.\d+)?$/.test(s))return NaN;return Number(s);
}
const intCell=v=>{const s=cell(v);return /^\d+$/.test(s)?Number(s):s===''?undefined:NaN;};
// The minutes a set of tickets charges in the snapshot's window, as they are and with the changes made.
function charged(env,d,keys,{projects={},metas={},tickets={}}={}){
  const items={...d.projects.items};for(const [id,v] of Object.entries(projects)){if(v===null)delete items[id];else items[id]={...items[id],billing:v};}
  const m2=new Map([...d.metas].filter(([k])=>keys.has(k)));for(const [k,p] of Object.entries(metas))if(keys.has(k))m2.set(k,{...(m2.get(k)||{revision:0,billing:null,agreedHours:null}),...p});
  const t2={...d.tickets};for(const [k,p] of Object.entries(tickets))t2[k]={...(t2[k]||{}),...p};
  return workRows(env,{...d,projects:{...d.projects,items},metas:m2,tickets:t2,entries:d.entries.filter(e=>keys.has(e.ticket))}).reduce((n,r)=>n+r.chargeableMinutes,0);
}
function impactOf(env,d,keys,changes){const before=charged(env,d,keys),after=charged(env,d,keys,changes);return {beforeMinutes:before,afterMinutes:after,deltaMinutes:after-before};}

async function plan(env,me,b,{readTicket}){
  if(!b||typeof b!=='object'||Array.isArray(b))problem('Invalid import request.');
  const projects=b.projects??[],tickets=b.tickets??[];
  if(!Array.isArray(projects)||!Array.isArray(tickets))problem('Invalid import request.');
  if(!projects.length&&!tickets.length)problem('The file has no project or ticket rows.');
  if(projects.length>IMPORT_LIMIT||tickets.length>IMPORT_LIMIT)problem('Import up to '+IMPORT_LIMIT+' projects and '+IMPORT_LIMIT+' tickets at a time.');
  const today=todayIn(),context=await companyContext(env);
  const [snap,markers,known,allocOn]=await Promise.all([billingSnapshot(env,{from:addDays(today,-365)}),readMarkers(env),readOdooProjects(env).then(projectIndex),allocationField(env)]);
  const d=snap.d,exported=exportedByTicket(markers),scope={from:d.from,to:d.to,label:'Chargeable hours from '+d.from+' to '+d.to};
  const ids=[...new Set(projects.map(r=>intCell(r?.odooId)).filter(Number.isInteger))];
  const odooRows=ids.length?await odoo(env,'project.project','search_read',[[['id','in',ids]]],{fields:['name','partner_id','active',...(allocOn?['allocated_hours']:[])],limit:ids.length,context:{...context,active_test:false}}):[];
  const byId=new Map(odooRows.map(p=>[p.id,p])),customerOf=id=>{const s=known.get(id);if(s)return s.clientName||'';return m2o(byId.get(id)?.partner_id)?.name||'';};
  const rows=[],seenP=new Map(),seenT=new Map();
  const ticketsOn=id=>{const keys=new Set();for(const r of snap.rows)if(r.projectId===id)keys.add(r.ticket);for(const [k,m] of d.metas)if(m.odooProjectId===id)keys.add(k);return keys;};
  for(const [i,r] of projects.entries()){
    const row={sheet:'projects',row:Number.isInteger(r?.row)?r.row:i+2,id:cell(r?.odooId),name:'',customer:'',errors:[],warnings:[],changes:[],apply:{}};rows.push(row);
    const id=intCell(r?.odooId);
    if(!Number.isInteger(id)||id<1){row.errors.push('Odoo project ID must be a whole number.');continue;}
    row.id=id;
    if(seenP.has(id)){row.errors.push('Listed more than once (row '+seenP.get(id)+').');continue;}seenP.set(id,row.row);
    const o=byId.get(id);if(!o){row.errors.push('No Odoo project with this ID.');continue;}
    row.name=String(o.name||'');row.customer=customerOf(id);
    if(o.active===false){row.errors.push('Archived in Odoo.');continue;}
    if(cell(r.customer)&&norm(r.customer)!==norm(row.customer))row.errors.push('This project\'s customer is "'+(row.customer||'none')+'", not "'+cell(r.customer)+'".');
    if(cell(r.billing)){
      const k=isClear(r.billing)?CLEAR:norm(r.billing);
      if(!PROJECT_BILLING.has(k))row.errors.push('Billing default: use Billable, Not billable, or '+CLEAR+' for not classified.');
      else{const to=PROJECT_BILLING.get(k),from=snap.projectDefault(id);if(to!==from){row.changes.push({field:'billing',label:'Billing default',from:LABEL[from],to:LABEL[to]});row.apply.billing=to;}}
    }
    const hours=hoursCell(r.allocatedHours);
    if(hours!==undefined){
      if(!allocOn)row.errors.push('This Odoo has no allocated hours on projects (Timesheets).');
      else if(Number.isNaN(hours))row.errors.push('Allocated hours: enter zero or a positive number, or '+CLEAR+'.');
      else{
        let ok=true;if(hours!==null){try{allocatedHoursInput(hours);}catch(e){row.errors.push(e.message);ok=false;}}
        const from=o.allocated_hours===false||o.allocated_hours==null?null:round(Number(o.allocated_hours));
        if(ok&&hours!==from){row.changes.push({field:'allocation',label:'Allocated hours',from,to:hours});row.apply.allocation=hours;}
      }
    }
    // A file exported before someone else changed the project is stale: its other values may undo that change.
    if(cell(r.exportedAt)&&row.changes.length){
      const at=Date.parse(cell(r.exportedAt));
      if(!Number.isFinite(at))row.errors.push('Exported at is not a date and time.');
      else{const later=(await readProjectLog(env,id)).filter(e=>['billing','allocation'].includes(e.type)&&Date.parse(e.at)>at);
        if(later.length){const e=later.at(-1);row.errors.push('Changed after this file was exported ('+e.type+', by '+(e.by?.name||e.by?.email||'someone')+' at '+e.at.slice(0,16).replace('T',' ')+'). Export again.');}}
    }
    if('billing' in row.apply&&!row.errors.length){
      const keys=ticketsOn(id);row.impact=impactOf(env,d,keys,{projects:{[id]:row.apply.billing}});
      const hit=[...keys].filter(k=>exported.has(k));
      if(hit.length&&row.impact.deltaMinutes)row.warnings.push(hit.length+' ticket'+(hit.length===1?' has':'s have')+' exported charges: the next billable export carries the difference as an adjustment.');
      if(keys.size>200)row.warnings.push('More than 200 tickets: the first 200 ledgers update now, the rest with the next billing check.');
    }
  }
  const validTickets=[];
  for(const [i,r] of tickets.entries()){
    const key=cell(r?.key).toUpperCase(),row={sheet:'tickets',row:Number.isInteger(r?.row)?r.row:i+2,id:key,title:'',customer:'',errors:[],warnings:[],changes:[],apply:{}};rows.push(row);
    if(!sourceOf(env,key)){row.errors.push('Not a ticket key of this dashboard (INT-…, '+env.JIRA_PROJECT+'-… or HD-…).');continue;}
    if(seenT.has(key)){row.errors.push('Listed more than once (row '+seenT.get(key)+').');continue;}seenT.set(key,row.row);
    validTickets.push([row,r]);
  }
  const reads=await pool(validTickets,6,async([row])=>{try{return await readTicket(row.id);}catch{return undefined;}});
  for(const [n,[row,r]] of validTickets.entries()){
    const key=row.id,t=reads[n],hd=sourceOf(env,key)==='odoo';
    if(t===undefined){row.errors.push('The ticket could not be read. Try again.');continue;}
    if(!t){row.errors.push('Ticket not found or not visible.');continue;}
    row.title=t.title||'';
    const m=hd?null:d.metas.get(key)||await readMetadata(env,key),rec=d.tickets[key]||{revision:0,billing:null},revision=hd?rec.revision||0:m.revision;
    row.revision=revision;
    if(cell(r.revision)!==''){const given=intCell(r.revision);if(!Number.isInteger(given))row.errors.push('Revision must be a whole number (from the export).');else if(given!==revision)row.errors.push('Changed after this file was exported (revision '+given+', now '+revision+'). Export again.');}
    const metaPatch={},impactMeta={},impactTicket={};
    if(cell(r.billing)){
      const k=isClear(r.billing)?CLEAR:norm(r.billing);
      if(!TICKET_BILLING.has(k))row.errors.push('Billing override: use Inherit project, Billable or Not billable ('+CLEAR+' means inherit).');
      else{const to=TICKET_BILLING.get(k),cur=(hd?rec.billing:m.billing)??null,value=to==='inherit'?null:to;
        if(value!==cur){row.changes.push({field:'billing',label:'Billing override',from:LABEL[cur??'inherit'],to:LABEL[to]});row.apply.billing=to;if(hd)impactTicket.billing=value;else impactMeta.billing=value;}}
    }
    const hours=hoursCell(r.agreedHours);
    if(hours!==undefined){
      if(hd)row.errors.push('Odoo Helpdesk tickets have no agreed hours.');
      else if(Number.isNaN(hours)||(hours!==null&&!validHours(hours)))row.errors.push('Agreed hours: enter a positive number with up to two decimal places, or '+CLEAR+'.');
      else if(hours!==m.agreedHours){
        if(hours===null&&await agreedLineSent(env,key))row.errors.push('The agreed hours are already in Odoo. Change them instead of clearing them.');
        else{row.changes.push({field:'agreedHours',label:'Agreed hours',from:m.agreedHours,to:hours});metaPatch.agreedHours=hours;impactMeta.agreedHours=hours;if(hours!==null)impactMeta.agreedDate=m.agreedDate||todayIn();}
      }
    }
    // The agreed hours go to one of the ticket's developers (the drawer's rule): a name or id from the file, else the
    // only developer, else the one they went to before.
    const devCell=cell(r.agreedDeveloper);
    if(!hd&&(devCell||'agreedHours' in metaPatch)){
      const devs=await developerList(env,ticketDevelopers(t)),names=devs.map(x=>x.name||x.dev).join(', ')||'none';
      let chosen=null;if(devCell){const hit=devs.find(x=>norm(x.dev)===norm(devCell)||norm(x.name)===norm(devCell));if(!hit)row.errors.push('Agreed developer "'+devCell+'" is not one of this ticket\'s developers ('+names+').');else chosen=hit.dev;}
      const finalHours='agreedHours' in metaPatch?metaPatch.agreedHours:m.agreedHours;
      if(finalHours==null){if(devCell&&chosen)row.warnings.push('Agreed developer ignored: the ticket has no agreed hours.');}
      else if(!(devCell&&!chosen)){
        const pick=agreedDeveloperOf(t,chosen,m.agreedDev);
        if(!pick.dev)row.errors.push(pick.code==='agreed_choose_developer'?'This ticket has several developers ('+names+'). Name one in Agreed developer.':pick.error);
        else if(pick.dev!==m.agreedDev||'agreedHours' in metaPatch){
          const name=devs.find(x=>x.dev===pick.dev)?.name||pick.dev;
          if(pick.dev!==m.agreedDev)row.changes.push({field:'agreedDev',label:'Agreed developer',from:m.agreedDeveloper||null,to:name});
          metaPatch.agreedDev=pick.dev;
        }
      }
    }
    const pid=intCell(r.odooProjectId);let target=hd?null:m.odooProjectId;
    if(isClear(r.odooProjectId))row.errors.push("A ticket's Odoo project can be changed but not removed.");
    else if(pid!==undefined){
      if(hd)row.errors.push('An Odoo Helpdesk ticket\'s project is set in Odoo.');
      else if(!Number.isInteger(pid))row.errors.push('Odoo project ID must be a whole number.');
      else if(pid!==m.odooProjectId){
        const p=known.get(pid);
        if(!p)row.errors.push('Odoo project #'+pid+' is not in the last sync from Odoo.');else if(!p.active)row.errors.push('Odoo project #'+pid+' is archived.');else if(!p.clientId)row.errors.push('Odoo project #'+pid+' has no client in Odoo.');
        else{row.changes.push({field:'odooProjectId',label:'Odoo project',from:m.odooProjectId!=null?known.get(m.odooProjectId)?.label||'#'+m.odooProjectId:null,to:p.label||'#'+pid});metaPatch.odooProjectId=pid;impactMeta.odooProjectId=pid;target=pid;}
      }
    }
    row.customer=target!=null?known.get(target)?.clientName||'':'';
    if(cell(r.customer)&&target!=null&&norm(r.customer)!==norm(row.customer))row.errors.push('The ticket\'s project belongs to "'+(row.customer||'no customer')+'", not "'+cell(r.customer)+'".');
    if(t.closed&&row.changes.length)row.errors.push('This ticket is closed. Reopen it before changing it.');
    if(Object.keys(metaPatch).length)row.apply.metadata=metaPatch;
    if(!row.errors.length&&(Object.keys(impactMeta).length||Object.keys(impactTicket).length)){
      row.impact=impactOf(env,d,new Set([key]),{metas:{[key]:impactMeta},tickets:{[key]:impactTicket}});
      const e=exported.get(key);if(e&&row.impact.deltaMinutes)row.warnings.push('Already exported ('+e.charges+' charge'+(e.charges===1?'':'s')+', '+round(e.minutes/60)+' h): the next billable export carries the difference as an adjustment.');
    }
  }
  for(const row of rows)row.status=row.errors.length?'error':!row.changes.length?'unchanged':'ok';
  // Everything that would change, together (a ticket row and its project's row can both move the same charge).
  const ok=rows.filter(r=>r.status==='ok'),all={projects:{},metas:{},tickets:{}},keys=new Set();
  for(const r of ok){
    if(r.sheet==='projects'&&'billing' in r.apply){all.projects[r.id]=r.apply.billing;for(const k of ticketsOn(r.id))keys.add(k);}
    if(r.sheet==='tickets'&&r.impact){keys.add(r.id);const hd=sourceOf(env,r.id)==='odoo',v=r.apply.billing===undefined?undefined:r.apply.billing==='inherit'?null:r.apply.billing,p=r.apply.metadata||{};
      if(hd){if(v!==undefined)all.tickets[r.id]={billing:v};}
      else all.metas[r.id]={...(v!==undefined?{billing:v}:{}),...('agreedHours' in p?{agreedHours:p.agreedHours,agreedDate:d.metas.get(r.id)?.agreedDate||todayIn()}:{}),...('odooProjectId' in p?{odooProjectId:p.odooProjectId}:{})};}
  }
  const allocation=ok.filter(r=>'allocation' in r.apply).map(r=>({odooId:r.id,from:r.changes.find(c=>c.field==='allocation').from,to:r.apply.allocation}));
  return {scope,rows,counts:{ok:ok.length,unchanged:rows.filter(r=>r.status==='unchanged').length,error:rows.filter(r=>r.status==='error').length,warning:rows.filter(r=>r.warnings.length).length},
    impact:{...impactOf(env,d,keys,all),tickets:keys.size,allocation}};
}
// One row's changes, each through the save the rest of the dashboard uses. A row whose ticket changed since the
// preview fails (its revision is checked again by those saves); the other rows still apply.
async function applyRow(env,me,row,{readTicket}){
  const done=[],by={email:me.email,name:me.name};
  try{
    if(row.sheet==='projects'){
      if('billing' in row.apply){await saveProjectDefault(env,me,{odooId:row.id,billing:row.apply.billing,revision:(await readProjectDefaults(env)).revision});done.push('billing');}
      if('allocation' in row.apply){await saveAllocation(env,me,row.id,row.apply.allocation);done.push('allocation');}
      return {done};
    }
    const key=row.id;
    if(row.apply.metadata){
      await withTicketLock(env,key,async()=>{
        const t=await readTicket(key);if(!t)problem('Ticket unavailable.',404,'not_found');
        const m=await readMetadata(env,key);if(m.revision!==row.revision)problem('The ticket changed after the preview. Preview again.',409,'conflict');
        await saveMetadata(env,key,{revision:m.revision,...row.apply.metadata},me,{closed:t.closed,ticket:{title:t.title,devs:t.devs}});
      });
      await reconcileTicket(env,key,{by});done.push(...Object.keys(row.apply.metadata));
    }
    if(row.apply.billing!==undefined){
      const hd=sourceOf(env,key)==='odoo',revision=hd?row.revision:(await readMetadata(env,key)).revision;
      await saveTicket(env,me,{key,billing:row.apply.billing,revision},readTicket);done.push('billing');
    }
    return {done};
  }catch(e){
    const message=e instanceof BusinessError?e.message:'Unexpected error: '+String(e?.message||e).slice(0,160);
    return {done,error:message};
  }
}
async function applyImport(env,me,b,deps){
  const p=await plan(env,me,b,deps),rows=[];
  for(const row of p.rows){
    const {apply,...shown}=row;
    if(row.status==='error'){rows.push({...shown,result:'not_applied',message:row.errors.join(' ')});continue;}
    if(row.status==='unchanged'){rows.push({...shown,result:'unchanged',message:'Nothing to change.'});continue;}
    const r=await applyRow(env,me,row,deps);
    rows.push({...shown,applied:r.done,result:r.error?(r.done.length?'partial':'failed'):'applied',message:r.error||'Saved.'});
  }
  const count=k=>rows.filter(r=>r.result===k).length;
  return {scope:p.scope,impact:p.impact,rows,counts:{applied:count('applied'),partial:count('partial'),failed:count('failed'),not_applied:count('not_applied'),unchanged:count('unchanged')}};
}
const strip=p=>({...p,rows:p.rows.map(({apply,...r})=>r)});

export const WORKSPACE_PATHS=['/clients/odoo-projects/tickets','/clients/odoo-projects/import/preview','/clients/odoo-projects/import'];
// deps: readTicket (a ticket any source, for checks), readDetails (titles, statuses, people of many tickets).
export async function workspaceRoutes(request,env,url,me,deps){
  if(me.role!=='admin')problem('Only administrators see project billing.',403,'forbidden');
  requireStore(env);
  const path=url.pathname,q=Object.fromEntries(url.searchParams);
  if(path==='/clients/odoo-projects/tickets'&&request.method==='GET'){
    if(q.all==='1')return json(await allProjectTickets(env,q));
    const id=Number(q.id);if(!Number.isInteger(id)||id<1)problem('Choose an Odoo project.');
    return json(await projectTickets(env,id,q,deps));
  }
  if((path==='/clients/odoo-projects/import/preview'||path==='/clients/odoo-projects/import')&&request.method==='POST'){
    const raw=await request.text();if(raw.length>BODY_LIMIT)problem('Import request too large.',413);
    let b;try{b=JSON.parse(raw);}catch{problem('Invalid import request.');}
    return json(path.endsWith('/preview')?strip(await plan(env,me,b,deps)):await applyImport(env,me,b,deps));
  }
  problem('Not found.',404,'not_found');
}
