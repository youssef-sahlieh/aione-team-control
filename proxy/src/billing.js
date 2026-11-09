// Billable work, customer hour allowances and the "allocated hours exhausted" alert (administrators only).
//
// Classification: an Odoo project has a billing default (billable, not billable, or none yet: unclassified); a ticket
// may override it. A Jira or internal ticket's override is its existing "billing" business field (null: inherit the
// project), an Odoo Helpdesk ticket's is kept here. effectiveBilling decides: an explicit override wins.
//
// Consumption (whole minutes): a billable ticket with agreed hours consumes the agreed hours once, on the day they
// were first set; a billable ticket without them consumes its billable work entries, each on its work date.
// Non-billable and unclassified work consumes nothing. Every change to what a ticket consumes is kept in its ledger
// as an add / change / remove event, so the events always add up to what it consumes now.
//
// Allowances: hours a customer has for one project or a shared pool of projects, from a start date (the cutover),
// with an opening balance for what was used before it and confirmed top-ups. Overage carries forward. A billable
// ticket in a project that is not billable consumes an allowance only when the ticket is assigned to it.
//
// Alerts: one event per allowance and cycle (created with setIfAbsent, so never twice), with its email in a durable
// queue. Emails go only when Billing setup has emails On and the server has BILLING_ALERT_MAIL=on; otherwise alerts
// are recorded as a dry run. A project already exhausted the first time it is seen is "backlog": never emailed
// unless an administrator sends it. A confirmed top-up that restores capacity starts the next cycle.
//
// Store keys (prefix "business:<PROJECT>:billing:"):
//   config  projects  allowances  ticket:<KEY>  ledger:<KEY>  state:<allowanceId>  alert:<allowanceId>:<cycle>
//   alerts (set)  mailq (set)  exported:<chargeId>  exported (set)  batch:<id>  batches (set)  scan  ack (set)  cursor
//   lock:<what>
import { odoo, odooConfigured } from './odoo.js';
import { BusinessError, requireStore, readMetadata, readAllMetadata, saveMetadata, withTicketLock, readOdooProjects, projectIndex, recordProjectEvent } from './ticket-metadata.js';
import { ticketEntries, ticketTask, entriesBetween, readConfig as readTimeConfig, todayIn, TIME_ZONE, sourceOf, agreedId, isSynced, sameSecret, STATUS } from './time-entries.js';
import { validEmail } from './users.js';

const problem=(message,status=400,code='billing',details={})=>{throw new BusinessError(message,status,code,details);};
const P=env=>'business:'+env.JIRA_PROJECT+':billing:';
const K={
  cfg:env=>P(env)+'config', projects:env=>P(env)+'projects', allowances:env=>P(env)+'allowances', ticket:(env,key)=>P(env)+'ticket:'+key,
  ledger:(env,key)=>P(env)+'ledger:'+key, state:(env,id)=>P(env)+'state:'+id, alert:(env,id)=>P(env)+'alert:'+id, alerts:env=>P(env)+'alerts',
  mailq:env=>P(env)+'mailq', exported:(env,id)=>P(env)+'exported:'+id, exportedSet:env=>P(env)+'exported', batch:(env,id)=>P(env)+'batch:'+id,
  batches:env=>P(env)+'batches', scan:env=>P(env)+'scan', ack:env=>P(env)+'ack', cursor:env=>P(env)+'cursor', lock:(env,what)=>P(env)+'lock:'+what
};
const FOREVER=315360000;
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const clean=(s,n=200)=>String(s??'').slice(0,n);
const m2o=v=>Array.isArray(v)?v[0]:null;
const hours=m=>Math.round(m/60*100)/100;
const addDays=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const validDate=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
const mget=(store,keys)=>!keys.length?[]:store.mget?store.mget(keys):Promise.all(keys.map(k=>store.get(k)));
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

export const BILLING=['billable','not_billable'];
export const KINDS={package:'Commercial package',estimate:'Internal estimate',fixed_fee:'Fixed-fee budget',t_and_m:'Unlimited time & materials',none:'No allocation'};
const CAPPED=new Set(['package','estimate','fixed_fee']);
export const NEAR=0.8;
export const MAIL_STATUS={queued:'Queued',sending:'Sending',sent:'Sent',failed:'Failed',uncertain:'Delivery uncertain',dry_run:'Dry run (not sent)',backlog:'Backlog (not sent)'};

// ---- Stored documents ----
async function readDoc(env,key,blank){const raw=await requireStore(env).get(key);return raw?{...blank(),...JSON.parse(raw)}:blank();}
// Read-modify-write with compare-and-set. fn returns the next value, or undefined to leave it as it is.
async function update(env,key,blank,fn){
  const store=requireStore(env);
  for(let attempt=0;attempt<4;attempt++){
    const raw=await store.get(key),cur=raw?{...blank(),...JSON.parse(raw)}:blank(),next=await fn(cur);
    if(next===undefined)return cur;
    const s=JSON.stringify(next);
    if(raw===null?await store.setIfAbsent(key,s,FOREVER):await store.compareAndSet(key,raw,s))return next;
  }
  problem('Billing data changed while saving. Refresh and retry.',409,'conflict');
}
async function withLock(env,what,fn,ttl=120){
  const store=requireStore(env),k=K.lock(env,what),owner=crypto.randomUUID();
  if(!await store.setIfAbsent(k,owner,ttl))problem('Billing is being updated right now. Try again in a moment.',409,'busy');
  try{return await fn();}finally{await store.deleteIfValue(k,owner);}
}
const blankConfig=()=>({revision:0,classification:false,emails:'off',fields:{project:'',task:''},values:{project:{},task:{}},quotationUrl:'',updatedAt:null,updatedBy:null});
export async function readBillingConfig(env){const c=await readDoc(env,K.cfg(env),blankConfig),b=blankConfig();return {...c,fields:{...b.fields,...c.fields},values:{project:{...(c.values?.project||{})},task:{...(c.values?.task||{})}}};}
const blankProjects=()=>({revision:0,items:{}});
export const readProjectDefaults=env=>readDoc(env,K.projects(env),blankProjects);
const blankAllowances=()=>({revision:0,items:[]});
export const readAllowances=env=>readDoc(env,K.allowances(env),blankAllowances);
const blankTicket=()=>({revision:0,billing:null,allowanceId:null,odoo:null,history:[]});
const readTicketRecord=(env,key)=>readDoc(env,K.ticket(env,key),blankTicket);
async function readTicketRecords(env){
  const store=requireStore(env),start=K.ticket(env,''),keys=store.scanKeys?await store.scanKeys(start):[],out={};
  const raws=await mget(store,keys);keys.forEach((k,n)=>{if(raws[n])out[k.slice(start.length)]={...blankTicket(),...JSON.parse(raws[n])};});
  return out;
}
const readScan=async env=>{const raw=await requireStore(env).get(K.scan(env));return raw?JSON.parse(raw):null;};

// ---- Recipients and email mode ----
// The alert goes to NO_DEVELOPER_NOTIFY_TO (the server setting new-ticket alerts use), checked the same way.
export function recipients(env){
  const to=[...new Set(String(env.NO_DEVELOPER_NOTIFY_TO||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean))],domain='@'+String(env.MAIL_DOMAIN||'').toLowerCase();
  if(!to.length)return {ok:false,to,problem:'NO_DEVELOPER_NOTIFY_TO has no recipients.'};
  if(to.length>20)return {ok:false,to,problem:'NO_DEVELOPER_NOTIFY_TO has more than 20 recipients.'};
  if(domain==='@'||!to.every(e=>validEmail(e)&&e.endsWith(domain)))return {ok:false,to,problem:'Every recipient in NO_DEVELOPER_NOTIFY_TO must be a valid '+domain+' address.'};
  return {ok:true,to};
}
// off: nothing is evaluated. dry: alerts are recorded, never sent. live: queued alerts are emailed.
export function mailMode(env,cfg){
  if(!cfg.classification||cfg.emails==='off')return {mode:'off'};
  if(cfg.emails==='dry')return {mode:'dry'};
  if(String(env.BILLING_ALERT_MAIL||'').toLowerCase()!=='on')return {mode:'dry',reason:'The server setting BILLING_ALERT_MAIL is not "on", so alerts are recorded without sending.'};
  const r=recipients(env);if(!r.ok)return {mode:'dry',reason:r.problem};
  return {mode:'live',to:r.to};
}

// ---- Classification and consumption ----
export function effectiveBilling(projectDefault,override){
  if(BILLING.includes(override))return {value:override,source:'ticket'};
  if(BILLING.includes(projectDefault))return {value:projectDefault,source:'project'};
  return {value:'unclassified',source:'none'};
}
// Every work entry, and every agreed-hours charge dated from..to, with its classification and the minutes it charges.
// d: {from,to,entries,metas (Map),projects,tickets,helpdesk}. Entries of a ticket with agreed hours charge nothing:
// its agreed hours do, once.
export function workRows(env,d){
  const def=id=>id==null?null:d.projects.items[id]?.billing??null;
  const odooTicket=key=>sourceOf(env,key)==='odoo';
  const overrideOf=key=>odooTicket(key)?d.tickets[key]?.billing??null:d.metas.get(key)?.billing??null;
  const rows=[];
  for(const e of d.entries){
    if(e.date<d.from||e.date>d.to)continue;
    const m=odooTicket(e.ticket)?null:d.metas.get(e.ticket);
    const projectId=e.projectId||(odooTicket(e.ticket)?e.hdProjectId||d.helpdesk:m?.odooProjectId)||null;
    const billing=effectiveBilling(def(projectId),overrideOf(e.ticket)),agreed=m?.agreedHours!=null,charged=billing.value==='billable'&&!agreed;
    rows.push({chargeId:e.id,kind:'entry',ticket:e.ticket,source:e.source,title:e.ticketTitle||'',date:e.date,projectId,taskId:e.taskId||null,worker:e.author?.name||'',description:e.description,
      actualMinutes:e.minutes,chargeableMinutes:charged?e.minutes:0,billing,origin:agreed&&billing.value==='billable'?'agreed_ticket':charged?'actual':'none',state:e.state,revision:e.revision,lineId:e.lineId||null});
  }
  for(const [key,m] of d.metas){
    if(m.agreedHours==null||!m.agreedDate||m.agreedDate<d.from||m.agreedDate>d.to)continue;
    const projectId=m.odooProjectId??null,billing=effectiveBilling(def(projectId),m.billing);
    rows.push({chargeId:agreedId(key),kind:'agreed',ticket:key,source:sourceOf(env,key),title:'',date:m.agreedDate,projectId,taskId:null,worker:m.agreedDeveloper||'',description:'Agreed hours for '+key,
      actualMinutes:0,chargeableMinutes:billing.value==='billable'?Math.round(m.agreedHours*60):0,billing,origin:'agreed',state:'agreed',revision:m.revision});
  }
  return rows.sort((a,b)=>a.date.localeCompare(b.date)||a.chargeId.localeCompare(b.chargeId));
}
export const capacityOf=a=>CAPPED.has(a.kind)?(a.minutes||0)+(a.topUps||[]).reduce((n,t)=>n+t.minutes,0):null;
const activeOn=(a,date)=>a.enabled&&date>=a.startDate&&(!a.endDate||date<=a.endDate);
// Which allowance each charge uses, and how much of it the allowance still covers, filling each allowance in date
// order from its start (after its opening balance). Returns the minutes each allowance consumed.
export function applyCoverage(rows,allowances,{projectDefault,ticketAllowance}){
  const byId=new Map(allowances.map(a=>[a.id,a])),left=new Map(),usage={};
  for(const r of rows){
    r.allowanceId=null;r.coverage=r.chargeableMinutes>0?'no_allowance':null;r.coveredMinutes=0;
    if(!(r.chargeableMinutes>0))continue;
    const explicit=ticketAllowance(r.ticket);let list;
    if(explicit){const a=byId.get(explicit);list=a&&activeOn(a,r.date)?[a]:[];}
    // A billable ticket in a project that is not billable uses an allowance only when it is assigned to one.
    else list=projectDefault(r.projectId)==='billable'?allowances.filter(a=>activeOn(a,r.date)&&a.projectIds.includes(r.projectId)):[];
    if(list.length>1){r.coverage='ambiguous';continue;}
    const a=list[0];if(!a||a.kind==='none')continue;
    r.allowanceId=a.id;r.saleOrderLineId=a.saleOrderLineId||null;usage[a.id]=(usage[a.id]||0)+r.chargeableMinutes;
    if(a.kind==='t_and_m'){r.coverage='t_and_m';r.coveredMinutes=r.chargeableMinutes;continue;}
    if(!left.has(a.id))left.set(a.id,capacityOf(a)-(a.openingMinutes||0));
    const room=left.get(a.id),covered=Math.max(0,Math.min(room,r.chargeableMinutes));left.set(a.id,room-r.chargeableMinutes);
    r.coveredMinutes=covered;r.coverage=covered===r.chargeableMinutes?'covered':covered>0?'partial':'overage';
  }
  return usage;
}
// An allowance against what it consumed since its start. Zero hours with nothing used is not exhausted; zero hours with
// any use is. Overage carries forward: 2 h over plus a 10 h top-up leaves 8 h.
export function allowanceStatus(a,consumed=0){
  const used=(a.openingMinutes||0)+consumed,base={consumedMinutes:used,capacityMinutes:capacityOf(a),remainingMinutes:null,overageMinutes:0,usedPercent:null,exhausted:false};
  if(!a.enabled)return {...base,status:'disabled'};
  if(a.kind==='none')return {...base,status:'no_allocation'};
  if(a.kind==='t_and_m')return {...base,status:'unlimited'};
  const capacity=base.capacityMinutes,rest=capacity-used,exhausted=capacity>0?used>=capacity:used>0;
  return {...base,remainingMinutes:Math.max(rest,0),overageMinutes:Math.max(-rest,0),usedPercent:capacity>0?Math.round(used/capacity*1000)/10:null,exhausted,
    status:rest<0?'overage':exhausted?'exhausted':capacity>0&&used>=capacity*NEAR?'near':'available'};
}
// Everything consumption needs, read once. from..to widens to the earliest enabled allowance start and today.
async function gather(env,{from,to}){
  const [projects,allowances,tickets,timeCfg,metas]=await Promise.all([readProjectDefaults(env),readAllowances(env),readTicketRecords(env),readTimeConfig(env).catch(()=>({mapping:{}})),readAllMetadata(env)]);
  const today=todayIn(),lo=[from||today,...allowances.items.filter(a=>a.enabled).map(a=>a.startDate)].sort()[0],hi=[to||today,today].sort().at(-1);
  const entries=await entriesBetween(env,lo,hi);
  return {from:lo,to:hi,entries,metas,projects,allowances,tickets,helpdesk:Number(timeCfg.mapping?.helpdesk)||null};
}
export async function billingSnapshot(env,{from,to}={}){
  const d=await gather(env,{from,to}),rows=workRows(env,d),def=id=>id==null?null:d.projects.items[id]?.billing??null;
  const usage=applyCoverage(rows,d.allowances.items,{projectDefault:def,ticketAllowance:key=>d.tickets[key]?.allowanceId||null});
  const statuses=Object.fromEntries(d.allowances.items.map(a=>[a.id,allowanceStatus(a,usage[a.id]||0)]));
  return {d,rows,usage,statuses,projectDefault:def};
}

// ---- Ledger: what each ticket consumes, with every change kept ----
export async function ticketCharges(env,key){
  const odooTicket=sourceOf(env,key)==='odoo';
  const [entries,meta,projects,rec,timeCfg]=await Promise.all([ticketEntries(env,key),odooTicket?null:readMetadata(env,key),readProjectDefaults(env),readTicketRecord(env,key),readTimeConfig(env).catch(()=>({mapping:{}}))]);
  const rows=workRows(env,{from:'0000-01-01',to:'9999-12-31',entries,metas:new Map(meta?[[key,meta]]:[]),projects,tickets:{[key]:rec},helpdesk:Number(timeCfg.mapping?.helpdesk)||null});
  return rows.filter(r=>r.chargeableMinutes>0).map(r=>({id:r.chargeId,date:r.date,minutes:r.chargeableMinutes,basis:r.kind==='agreed'?'agreed':'actual',projectId:r.projectId}));
}
const blankLedger=()=>({revision:0,charges:{},consumedMinutes:0,events:[]});
const eventReason=e=>e.basis==='agreed'?{add:'Agreed hours charged',change:'Agreed hours changed',remove:'Agreed hours cleared, or the ticket is no longer billable'}[e.type]
  :{add:'Billable work',change:'Work entry corrected',remove:'Replaced by agreed hours, or no longer billable'}[e.type];
// Brings the ticket's ledger to what it consumes now: one event per charge added, changed (by the difference) or removed.
export async function reconcileTicket(env,key,{by=null}={}){
  const charges=await ticketCharges(env,key),next=Object.fromEntries(charges.map(c=>[c.id,c]));
  return update(env,K.ledger(env,key),blankLedger,cur=>{
    const events=[],at=new Date().toISOString();
    for(const [id,c] of Object.entries(next)){const p=cur.charges[id];if(!p)events.push({type:'add',chargeId:id,from:0,to:c.minutes,delta:c.minutes,date:c.date,basis:c.basis});else if(p.minutes!==c.minutes||p.date!==c.date)events.push({type:'change',chargeId:id,from:p.minutes,to:c.minutes,delta:c.minutes-p.minutes,date:c.date,basis:c.basis});}
    for(const [id,p] of Object.entries(cur.charges))if(!next[id])events.push({type:'remove',chargeId:id,from:p.minutes,to:0,delta:-p.minutes,date:p.date,basis:p.basis});
    if(!events.length)return undefined;
    return {revision:cur.revision+1,charges:next,consumedMinutes:charges.reduce((n,c)=>n+c.minutes,0),events:[...cur.events,...events.map(e=>({...e,at,by,reason:eventReason(e)}))].slice(-500)};
  });
}
export const readLedger=(env,key)=>readDoc(env,K.ledger(env,key),blankLedger);

// ---- Odoo fields (discovered, never assumed) ----
async function fieldCandidates(env){
  const attrs={attributes:['string','type','selection','store','readonly']};
  const pick=f=>Object.entries(f||{}).filter(([n,d])=>['boolean','selection'].includes(d.type)&&d.store!==false&&!d.readonly&&(n.startsWith('x_')||/bill/i.test(n+' '+(d.string||''))))
    .map(([n,d])=>({name:n,label:String(d.string||n),type:d.type,custom:n.startsWith('x_'),selection:Array.isArray(d.selection)?d.selection.map(([v,l])=>({value:String(v),label:String(l)})):[]}));
  const [project,task]=await Promise.all([odoo(env,'project.project','fields_get',[],attrs),odoo(env,'project.task','fields_get',[],attrs)]);
  return {project:pick(project),task:pick(task).filter(f=>f.type==='selection')};
}
// The Odoo value for a classification: a boolean field is true for billable; a selection field uses the mapping.
const toOdoo=(cfg,role,value)=>{const f=cfg.fieldTypes?.[role];if(f==='boolean')return value==='billable'?true:value==='not_billable'?false:undefined;const hit=Object.entries(cfg.values[role]).find(([,v])=>v===value);return hit?hit[0]:undefined;};
const fromOdoo=(cfg,role,raw)=>{const f=cfg.fieldTypes?.[role];if(f==='boolean')return raw===true?'billable':'not_billable';return raw===false||raw==null?null:cfg.values[role][String(raw)]??null;};
async function pushField(env,cfg,role,model,id,value){
  const field=cfg.fields[role];if(!field||!odooConfigured(env))return {state:'not_configured'};
  const v=toOdoo(cfg,role,value);if(v===undefined)return {state:'failed',at:new Date().toISOString(),error:'Billing setup maps no Odoo value to '+value+'.'};
  try{
    await odoo(env,model,'write',[[id],{[field]:v}]);
    const [r]=await odoo(env,model,'read',[[id]],{fields:[field]});
    return r&&r[field]===v?{state:'synced',at:new Date().toISOString(),id}:{state:'failed',at:new Date().toISOString(),error:'Odoo did not keep the value.'};
  }catch(e){return {state:'failed',at:new Date().toISOString(),error:clean(e.message)};}
}

// ---- Setup ----
async function setupView(env){
  const cfg=await readBillingConfig(env),mode=mailMode(env,cfg),r=recipients(env),out={config:cfg,kinds:KINDS,mailStatus:MAIL_STATUS,
    mail:{mode:mode.mode,reason:mode.reason||'',recipients:r.to,recipientsOk:r.ok,recipientsProblem:r.problem||'',serverSwitch:String(env.BILLING_ALERT_MAIL||'').toLowerCase()==='on'},
    quotationDefault:defaultQuotationUrl(env),odoo:odooConfigured(env)};
  if(out.odoo){try{out.candidates=await fieldCandidates(env);}catch(e){out.error="Couldn't read Odoo fields: "+clean(e.message);}}
  return out;
}
const defaultQuotationUrl=env=>String(env.ODOO_URL||'').replace(/\/+$/,'')+'/odoo/action-sale.action_quotations_with_onboarding';
export function quotationLink(env,cfg,partnerId){
  if(cfg.quotationUrl&&partnerId)return cfg.quotationUrl.replace('{partner_id}',encodeURIComponent(String(partnerId)));
  return defaultQuotationUrl(env);
}
async function saveSetup(env,me,b){
  if(!b||typeof b!=='object')problem('Send the billing setup.');
  return withLock(env,'setup',async()=>{
    const cfg=await readBillingConfig(env);if(b.revision!==cfg.revision)problem('Billing setup changed. Refresh and retry.',409,'conflict');
    const next=structuredClone(cfg);
    if('classification' in b){if(typeof b.classification!=='boolean')problem('Classification is on or off.');next.classification=b.classification;}
    if('emails' in b){if(!['off','dry','on'].includes(b.emails))problem('Choose Off, Dry run or On for alert emails.');next.emails=b.emails;}
    if(next.emails!=='off'&&!next.classification)problem('Switch on billing classification before alert emails.',400,'classification_off');
    if(next.emails==='on'){const r=recipients(env);if(!r.ok)problem(r.problem,400,'recipients');}
    if('quotationUrl' in b){
      const u=typeof b.quotationUrl==='string'?b.quotationUrl.trim():'',base=String(env.ODOO_URL||'').replace(/\/+$/,'');
      if(u&&(!base||!u.startsWith(base+'/')||u.length>500||!u.includes('{partner_id}')||/[\s"'<>]/.test(u)))problem('The quotation link must start with '+(base||'the Odoo address')+'/ and contain {partner_id}.');
      next.quotationUrl=u;
    }
    if('fields' in b||'values' in b){
      const fields={...next.fields,...(b.fields||{})},values={project:{...next.values.project},task:{...next.values.task},...(b.values||{})};
      for(const r of ['project','task'])if(fields[r]!==''&&(typeof fields[r]!=='string'||!/^[a-z_][a-z0-9_]{0,62}$/.test(fields[r])))problem('Invalid Odoo field name.');
      next.fieldTypes={};
      if(fields.project||fields.task){
        if(!odooConfigured(env))problem("Odoo isn't connected, so its fields can't be checked.");
        const found=await fieldCandidates(env);
        for(const [role,allowed] of [['project',['billable','not_billable']],['task',['inherit','billable','not_billable']]]){
          if(!fields[role]){values[role]={};continue;}
          const f=found[role].find(x=>x.name===fields[role]);
          if(!f)problem('Odoo '+(role==='project'?'projects':'tasks')+' have no editable '+(role==='task'?'selection ':'')+'field '+fields[role]+'.',400,'setup_incomplete');
          next.fieldTypes[role]=f.type;
          if(f.type==='selection'){
            const map=values[role]||{},keys=new Set(f.selection.map(s=>s.value));
            if(typeof map!=='object'||Object.entries(map).some(([k,v])=>!keys.has(k)||!allowed.includes(v)))problem('Map each Odoo value of '+f.name+' to '+allowed.join(', ')+'.');
            for(const v of ['billable','not_billable'])if(Object.values(map).filter(x=>x===v).length!==1)problem('Map exactly one Odoo value of '+f.name+' to '+v+'.');
            values[role]=map;
          }else values[role]={};
        }
      }else values.project=values.task={};
      next.fields=fields;next.values=values;
    }
    next.revision++;next.updatedAt=new Date().toISOString();next.updatedBy={email:me.email,name:me.name};
    await requireStore(env).set(K.cfg(env),JSON.stringify(next));
    return next;
  });
}

// ---- Project defaults ----
async function saveProjectDefault(env,me,b){
  const id=Number(b?.odooId);if(!Number.isInteger(id)||id<1)problem('Choose an Odoo project.');
  if(![null,...BILLING].includes(b.billing))problem('Choose Billable, Not billable or Not classified.');
  let from=null;
  const doc=await update(env,K.projects(env),blankProjects,cur=>{
    if(b.revision!==cur.revision)problem('Project billing changed. Refresh and retry.',409,'conflict');
    from=cur.items[id]?.billing??null;if(from===b.billing)return undefined;
    const items={...cur.items};if(b.billing===null)delete items[id];else items[id]={billing:b.billing,updatedAt:new Date().toISOString(),by:{email:me.email,name:me.name}};
    return {revision:cur.revision+1,items};
  });
  if(from!==b.billing){
    await recordProjectEvent(env,id,me,{type:'billing',from,to:b.billing});
    const cfg=await readBillingConfig(env);
    if(b.billing&&cfg.fields.project){const sync=await pushField(env,cfg,'project','project.project',id,b.billing);await update(env,K.projects(env),blankProjects,cur=>cur.items[id]?{...cur,items:{...cur.items,[id]:{...cur.items[id],odoo:sync}}}:undefined);}
    // The tickets on this project consume differently now.
    const all=await readAllMetadata(env);let n=0;
    for(const [key,m] of all)if(m.odooProjectId===id&&n++<200)await reconcileTicket(env,key,{by:{email:me.email,name:me.name}});
  }
  return (await readProjectDefaults(env));
}

// ---- Ticket override and allowance assignment ----
async function ticketView(env,key){
  const odooTicket=sourceOf(env,key)==='odoo',[cfg,meta,rec,projects,allow,ledger,timeCfg]=await Promise.all([readBillingConfig(env),odooTicket?null:readMetadata(env,key),readTicketRecord(env,key),readProjectDefaults(env),readAllowances(env),readLedger(env,key),readTimeConfig(env).catch(()=>({mapping:{}}))]);
  let projectId=meta?.odooProjectId??null;
  if(odooTicket){const e=(await ticketEntries(env,key)).find(x=>x.projectId||x.hdProjectId);projectId=e?.projectId||e?.hdProjectId||Number(timeCfg.mapping?.helpdesk)||null;}
  const override=odooTicket?rec.billing:meta.billing,projectDefault=projectId!=null?projects.items[projectId]?.billing??null:null;
  const label=projectId!=null?projectIndex(await readOdooProjects(env)).get(projectId)?.label||'Odoo project #'+projectId:null;
  return {key,classification:cfg.classification,override:override??null,revision:odooTicket?rec.revision:meta.revision,recordRevision:rec.revision,
    effective:effectiveBilling(projectDefault,override),project:projectId!=null?{id:projectId,label,billing:projectDefault}:null,
    allowanceId:rec.allowanceId,allowances:allow.items.filter(a=>a.enabled&&a.kind!=='none').map(a=>({id:a.id,label:a.label,kind:a.kind,onProject:projectId!=null&&a.projectIds.includes(projectId)})),
    odooSync:rec.odoo||{state:cfg.fields.task?'not_sent':'not_configured'},agreedHours:meta?.agreedHours??null,
    ledger:{consumedMinutes:ledger.consumedMinutes,events:ledger.events.slice(-30)},history:rec.history.slice(-30)};
}
async function saveTicket(env,me,b,readTicket){
  const key=b?.key;if(!sourceOf(env,key))problem('Choose a ticket.');
  const choice=b.billing;if(choice!==undefined&&!['inherit',...BILLING].includes(choice))problem('Choose Inherit, Billable or Not billable.');
  if('allowanceId' in b&&b.allowanceId!==null){const a=(await readAllowances(env)).items.find(x=>x.id===b.allowanceId);if(!a||!a.enabled||a.kind==='none')problem('Choose an enabled allowance.');}
  const by={email:me.email,name:me.name},odooTicket=sourceOf(env,key)==='odoo';
  await withTicketLock(env,key,async()=>{
    const t=await readTicket(key);if(!t)problem('Ticket unavailable.',404,'not_found');
    const value=choice===undefined?undefined:choice==='inherit'?null:choice;
    // A Jira or internal ticket's override is its billing business field, saved with that field's rules and history.
    if(value!==undefined&&!odooTicket){const m=await readMetadata(env,key);if(m.billing!==value)await saveMetadata(env,key,{revision:b.revision,billing:value},me,{closed:t.closed,ticket:{title:t.title,devs:t.devs}});}
    await update(env,K.ticket(env,key),blankTicket,cur=>{
      const next={...cur},changes={};
      if(value!==undefined&&odooTicket&&cur.billing!==value){if(b.revision!==cur.revision)problem('Ticket billing changed. Refresh and retry.',409,'conflict');changes.billing={from:cur.billing,to:value};next.billing=value;}
      if('allowanceId' in b&&cur.allowanceId!==b.allowanceId){changes.allowanceId={from:cur.allowanceId,to:b.allowanceId};next.allowanceId=b.allowanceId;}
      if(!Object.keys(changes).length)return undefined;
      return {...next,revision:cur.revision+1,history:[...cur.history,{at:new Date().toISOString(),by,changes}].slice(-100)};
    });
  });
  await reconcileTicket(env,key,{by});
  // The override goes to the ticket's Odoo task when Billing setup maps a task field.
  const cfg=await readBillingConfig(env);
  if(choice!==undefined&&cfg.fields.task){
    const task=await ticketTask(env,key),sync=task.taskId?await pushField(env,cfg,'task','project.task',task.taskId,choice):{state:'waiting',at:new Date().toISOString(),error:'The Odoo task is created with the first work entry; the value is sent then.'};
    await update(env,K.ticket(env,key),blankTicket,cur=>({...cur,odoo:{...sync,value:choice}}));
  }
  return ticketView(env,key);
}

// ---- Allowances ----
function allowanceInput(b,prev,known){
  const a={...(prev||{})};
  if(!prev||'kind' in b){if(!(b.kind in KINDS))problem('Choose the kind of allowance.');a.kind=b.kind;}
  if(!prev||'label' in b){const l=typeof b.label==='string'?b.label.trim():'';if(l.length>120)problem('Keep the name under 120 characters.');a.label=l;}
  if(!prev||'enabled' in b){if(typeof b.enabled!=='boolean')problem('Enabled is yes or no.');a.enabled=b.enabled;}
  if(!prev||'projectIds' in b){const ids=b.projectIds;if(!Array.isArray(ids)||!ids.length||ids.length>50||ids.some(i=>!Number.isInteger(i)||i<1)||new Set(ids).size!==ids.length)problem('Choose one project, or up to 50 for a shared pool.');a.projectIds=ids;}
  if(!prev||'startDate' in b){if(!validDate(b.startDate))problem('Choose the start date (consumption counts from it).');a.startDate=b.startDate;}
  if(!prev||'endDate' in b){if(b.endDate!=null&&!validDate(b.endDate))problem('Choose a valid end date.');a.endDate=b.endDate||null;}
  if(a.endDate&&a.endDate<a.startDate)problem('The end date is before the start date.');
  if(CAPPED.has(a.kind)){
    if(!prev||'minutes' in b||prev.minutes==null){if(!Number.isInteger(b.minutes)||b.minutes<0||b.minutes>60000000)problem('Enter the allocated hours (zero or more).');a.minutes=b.minutes;}
    if(!prev||'openingMinutes' in b){const o=b.openingMinutes??0;if(!Number.isInteger(o)||o<0||o>60000000)problem('The opening balance is zero or more hours.');a.openingMinutes=o;}
  }else{a.minutes=null;a.openingMinutes=0;}
  if(!prev||'saleOrderLineId' in b){if(b.saleOrderLineId!=null&&(!Number.isInteger(b.saleOrderLineId)||b.saleOrderLineId<1))problem('Invalid sales order line.');a.saleOrderLineId=b.saleOrderLineId??null;}
  if(!prev||'companyId' in b){if(b.companyId!=null&&(!Number.isInteger(b.companyId)||b.companyId<1))problem('Invalid company.');a.companyId=b.companyId??null;}
  // The customer is the projects' client in Odoo; a pool must be one customer's.
  const clients=[...new Set(a.projectIds.map(id=>known.get(id)).filter(Boolean).map(p=>p.clientId||null))];
  if(clients.length>1)problem('A shared pool must belong to one customer.');
  const p=a.projectIds.map(id=>known.get(id)).find(x=>x?.clientId);
  a.customer=p?{id:p.clientId,name:p.clientName||''}:b.customer&&typeof b.customer.name==='string'?{id:Number.isInteger(b.customer.id)?b.customer.id:null,name:clean(b.customer.name,200)}:(prev?.customer||{id:null,name:''});
  return a;
}
function overlapCheck(items,a){
  if(!a.enabled)return;
  const clash=items.find(o=>o.id!==a.id&&o.enabled&&o.projectIds.some(id=>a.projectIds.includes(id))&&o.startDate<=(a.endDate||'9999-12-31')&&a.startDate<=(o.endDate||'9999-12-31'));
  if(clash)problem('Project already in allowance "'+(clash.label||clash.id)+'" for overlapping dates. End or disable that one first.',409,'overlap');
}
// A change that brings an exhausted package back to available hours starts the next alert cycle.
async function rearm(env,before,after,a){
  if(a.kind!=='package'||!before?.exhausted||after.exhausted)return a;
  const cycle=(a.cycle||0)+1;
  await requireStore(env).set(K.state(env,a.id),JSON.stringify({lastSeen:'available',cycle,at:new Date().toISOString()}));
  return {...a,cycle};
}
async function saveAllowance(env,me,b,{create}){
  if(!b||typeof b!=='object')problem('Send the allowance.');
  const known=projectIndex(await readOdooProjects(env)),by={email:me.email,name:me.name},now=new Date().toISOString();
  return withLock(env,'allowances',async()=>{
    const doc=await readAllowances(env);if(b.revision!==doc.revision)problem('Allowances changed. Refresh and retry.',409,'conflict');
    const prev=create?null:doc.items.find(x=>x.id===b.id);if(!create&&!prev)problem('Allowance not found.',404,'not_found');
    let a=allowanceInput(b,prev,known);overlapCheck(doc.items,a);
    if(create)Object.assign(a,{id:crypto.randomUUID(),cycle:0,topUps:[],createdAt:now,createdBy:by,history:[{at:now,by,type:'created'}]});
    else{const changes=Object.fromEntries(['kind','label','enabled','projectIds','startDate','endDate','minutes','openingMinutes','saleOrderLineId'].filter(k=>JSON.stringify(prev[k])!==JSON.stringify(a[k])).map(k=>[k,{from:prev[k],to:a[k]}]));
      if(!Object.keys(changes).length)return {doc,allowance:prev};
      a.history=[...(prev.history||[]),{at:now,by,type:'edit',changes}].slice(-200);
      const snap=await billingSnapshot(env),before=snap.statuses[a.id],after=allowanceStatus(a,applyCoverage(snap.rows.map(r=>({...r})),doc.items.map(x=>x.id===a.id?a:x),{projectDefault:snap.projectDefault,ticketAllowance:k=>snap.d.tickets[k]?.allowanceId||null})[a.id]||0);
      a=await rearm(env,before,after,a);}
    a.updatedAt=now;
    const next={revision:doc.revision+1,items:create?[...doc.items,a]:doc.items.map(x=>x.id===a.id?a:x)};
    await requireStore(env).set(K.allowances(env),JSON.stringify(next));
    return {doc:next,allowance:a};
  });
}
// A top-up adds hours only once it is confirmed: a sales order line must be on a confirmed order in Odoo; without one,
// an administrator records the confirmation and its reference. Draft or sent quotations add nothing.
async function addTopUp(env,me,b){
  const minutes=b?.minutes;if(!Number.isInteger(minutes)||minutes<1||minutes>60000000)problem('Enter the hours added (more than zero).');
  const reference=typeof b.reference==='string'?b.reference.trim().slice(0,200):'';
  let saleOrderLineId=null,order=null;
  if(b.saleOrderLineId!=null){
    saleOrderLineId=b.saleOrderLineId;if(!Number.isInteger(saleOrderLineId)||saleOrderLineId<1)problem('Invalid sales order line.');
    if(!odooConfigured(env))problem("Odoo isn't connected, so the sales order can't be checked.");
    let line;try{[line]=await odoo(env,'sale.order.line','read',[[saleOrderLineId]],{fields:['order_id','state','product_uom_qty']});}catch(e){problem("Couldn't read the sales order line from Odoo: "+clean(e.message),502,'odoo');}
    if(!line)problem('Sales order line #'+saleOrderLineId+' was not found.',404,'not_found');
    if(!['sale','done'].includes(line.state))problem('That sales order is not confirmed in Odoo (it is '+(line.state||'unknown')+'). Only confirmed orders add hours.',409,'not_confirmed');
    order={id:m2o(line.order_id),name:Array.isArray(line.order_id)?String(line.order_id[1]||''):''};
  }else{
    if(b.confirmed!==true)problem('Confirm that the customer accepted these hours (a confirmed order), or choose its sales order line.',400,'not_confirmed');
    if(!reference)problem('Give the reference of the confirmed order.');
  }
  const now=new Date().toISOString(),by={email:me.email,name:me.name};
  return withLock(env,'allowances',async()=>{
    const doc=await readAllowances(env);if(b.revision!==doc.revision)problem('Allowances changed. Refresh and retry.',409,'conflict');
    const prev=doc.items.find(x=>x.id===b.id);if(!prev)problem('Allowance not found.',404,'not_found');
    if(!CAPPED.has(prev.kind))problem('Only allowances with hours can be topped up.');
    const top={id:crypto.randomUUID(),minutes,confirmedAt:now,by,reference,saleOrderLineId,order};
    let a={...prev,topUps:[...(prev.topUps||[]),top],history:[...(prev.history||[]),{at:now,by,type:'top-up',minutes,reference:reference||order?.name||''}].slice(-200),updatedAt:now};
    const snap=await billingSnapshot(env),before=snap.statuses[a.id],after=allowanceStatus(a,snap.usage[a.id]||0);
    a=await rearm(env,before,after,a);
    const next={revision:doc.revision+1,items:doc.items.map(x=>x.id===a.id?a:x)};
    await requireStore(env).set(K.allowances(env),JSON.stringify(next));
    return {doc:next,allowance:a,rearmed:a.cycle!==prev.cycle};
  });
}
async function allowancesView(env){
  const [snap,known]=await Promise.all([billingSnapshot(env),readOdooProjects(env).then(projectIndex)]);
  const alerts=await readAlerts(env);
  return {revision:snap.d.allowances.revision,kinds:KINDS,items:snap.d.allowances.items.map(a=>({...a,history:(a.history||[]).slice(-30),kindLabel:KINDS[a.kind],
    projects:a.projectIds.map(id=>({id,label:known.get(id)?.label||'Odoo project #'+id,billing:snap.projectDefault(id)})),...snap.statuses[a.id],
    alerts:alerts.filter(e=>e.allowanceId===a.id).map(alertSummary)}))};
}

// ---- Alerts ----
const alertSummary=e=>({id:e.id,allowanceId:e.allowanceId,cycle:e.cycle,status:e.status,statusLabel:MAIL_STATUS[e.status],createdAt:e.createdAt,sentAt:e.sentAt||null,attempts:e.attempts,errors:e.errors,to:e.to,snapshot:e.snapshot,subject:e.mail.subject,resolvedBy:e.resolvedBy||null});
async function readAlerts(env){
  const store=requireStore(env),ids=await store.smembers(K.alerts(env))||[],raws=await mget(store,ids.map(id=>K.alert(env,id)));
  return raws.filter(Boolean).map(r=>JSON.parse(r)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
export function alertMail(env,cfg,a,s,{calculatedAt,projectNames}){
  const customer=a.customer?.name||'Customer',project=a.label||projectNames.join(', ')||'Project',when=new Date(calculatedAt).toLocaleString('en-GB',{timeZone:TIME_ZONE,dateStyle:'medium',timeStyle:'short'});
  const base=String(env.ODOO_URL||'').replace(/\/+$/,''),projectLink=a.projectIds.length===1?base+'/web#id='+a.projectIds[0]+'&model=project.project&view_type=form':base+'/odoo/project';
  const h=m=>hours(m).toLocaleString('en-US',{maximumFractionDigits:2})+' h';
  const html='<p>All allocated hours have been consumed. Please prepare a new sales quotation for this customer.</p>'
    +'<p><b>'+escape(customer)+' / '+escape(project)+'</b></p>'
    +'<p>Allocated: '+h(s.capacityMinutes)+'<br>Consumed: '+h(s.consumedMinutes)+'<br>'+(s.overageMinutes?'Overage: '+h(s.overageMinutes):'Remaining: '+h(s.remainingMinutes))+'</p>'
    +'<p>Basis: billable work from '+escape(a.startDate)+(a.openingMinutes?' plus an opening balance of '+h(a.openingMinutes):'')+'. A ticket with agreed hours counts its agreed hours once; other billable tickets count the work logged. Non-billable work is not counted.</p>'
    +'<p>Calculated: '+escape(when)+' (Israel time)</p>'
    +'<p><a href="'+escape(quotationLink(env,cfg,a.customer?.id))+'">Prepare quotation</a> · <a href="'+escape(projectLink)+'">Open the project in Odoo</a></p>'
    +'<p>The quotation link only opens Odoo Sales. Nothing is created, confirmed or sent automatically.</p>';
  return {subject:'[AION] Allocated hours exhausted — '+customer+' / '+project,html};
}
// One look at every package: an exhausted one gets its cycle's event, once. Emailed only when it was seen available
// before (a real change while alerts are on); otherwise it is backlog, for an administrator to send if wanted.
export async function evaluateAlerts(env,cfg,snap){
  const mode=mailMode(env,cfg),store=requireStore(env),out={mode:mode.mode,created:0,queued:0,backlog:0,dryRun:0};
  if(mode.mode==='off')return out;
  const known=projectIndex(await readOdooProjects(env)),now=new Date().toISOString();
  for(const a of snap.d.allowances.items){
    if(a.kind!=='package'||!a.enabled)continue;
    const s=snap.statuses[a.id],sk=K.state(env,a.id),raw=await store.get(sk),state=raw?JSON.parse(raw):null,cycle=a.cycle||0;
    if(!s.exhausted){if(state?.lastSeen!=='available'||state.cycle!==cycle)await store.set(sk,JSON.stringify({lastSeen:'available',cycle,at:now}));continue;}
    const id=a.id+':'+cycle;
    if(!await store.get(K.alert(env,id))){
      const transition=state?.lastSeen==='available'&&state.cycle===cycle,status=transition?(mode.mode==='live'?'queued':'dry_run'):'backlog';
      const projectNames=a.projectIds.map(pid=>known.get(pid)?.name||'Odoo project #'+pid);
      const ev={id,allowanceId:a.id,cycle,status,createdAt:now,attempts:0,errors:[],to:mode.to||[],
        snapshot:{customer:a.customer?.name||'',project:a.label||projectNames.join(', '),capacityMinutes:s.capacityMinutes,consumedMinutes:s.consumedMinutes,remainingMinutes:s.remainingMinutes,overageMinutes:s.overageMinutes,calculatedAt:now},
        mail:alertMail(env,cfg,a,s,{calculatedAt:now,projectNames})};
      if(await store.setIfAbsent(K.alert(env,id),JSON.stringify(ev),FOREVER)){
        await store.sadd(K.alerts(env),id);out.created++;
        if(status==='queued'){await store.sadd(K.mailq(env),id);out.queued++;}else if(status==='backlog')out.backlog++;else out.dryRun++;
      }
    }
    if(state?.lastSeen!=='exhausted'||state.cycle!==cycle)await store.set(sk,JSON.stringify({lastSeen:'exhausted',cycle,at:now}));
  }
  return out;
}
// Sends one alert. Only queued alerts are sent automatically; explicit (an administrator) also sends backlog, dry-run,
// failed and uncertain ones. The status is saved as "sending" first: a run that stops midway leaves it there, and it
// becomes "uncertain" (never sent again automatically).
export async function deliverAlert(env,id,sendMail,{explicit=false,me=null}={}){
  const store=requireStore(env),key=K.alert(env,id),raw=await store.get(key);if(!raw)problem('Alert not found.',404,'not_found');
  const ev=JSON.parse(raw),allowed=explicit?['queued','backlog','dry_run','failed','uncertain']:['queued'];
  if(!allowed.includes(ev.status)){if(explicit)problem('This alert is '+MAIL_STATUS[ev.status].toLowerCase()+'.',409,'conflict');return ev;}
  if(!explicit&&ev.nextTryAt&&ev.nextTryAt>Date.now())return ev;
  const mode=mailMode(env,await readBillingConfig(env));
  if(mode.mode!=='live'){if(explicit)problem('Alert emails are not live. '+(mode.reason||'Set alert emails to On in Billing setup.'),409,'mail_not_live');return ev;}
  const now=()=>new Date().toISOString();
  const sending={...ev,status:'sending',to:mode.to,attempts:ev.attempts+1,sendingAt:Date.now(),...(explicit?{requestedBy:{email:me.email,name:me.name},requestedAt:now()}:{})};
  const sraw=JSON.stringify(sending);
  if(!await store.compareAndSet(key,raw,sraw))return JSON.parse(await store.get(key));
  let outcome;
  try{
    const res=await sendMail(mode.to[0],{to:mode.to,subject:ev.mail.subject,html:ev.mail.html});
    if(res.ok)outcome={status:'sent',sentAt:now()};
    else{
      const data=await res.json().catch(()=>({})),msg=clean(data.error||'HTTP '+res.status);
      // 501/400: mail is off or refused the recipients (a setup problem). 502 from the mailer may or may not have
      // gone out; other 502s are a definite refusal and are tried again a few times.
      if(res.status===502&&/could not be sent/i.test(msg))outcome={status:'uncertain',error:msg};
      else if(res.status===502&&sending.attempts<5)outcome={status:'queued',error:msg,nextTryAt:Date.now()+Math.min(60,2**sending.attempts)*60000};
      else outcome={status:'failed',error:msg};
    }
  }catch(err){outcome={status:'uncertain',error:'No answer from the mail service: '+clean(err?.message)};}
  const done={...sending,...outcome,errors:[...ev.errors,...(outcome.error?[{at:now(),message:outcome.error}]:[])].slice(-20),updatedAt:now()};
  await store.compareAndSet(key,sraw,JSON.stringify(done));
  if(done.status==='queued')await store.sadd(K.mailq(env),id);else await store.srem(K.mailq(env),id);
  return done;
}
async function expireSending(env,ms=600000){
  const store=requireStore(env);let n=0;
  for(const ev of await readAlerts(env))if(ev.status==='sending'&&Date.now()-(ev.sendingAt||0)>ms){
    const next={...ev,status:'uncertain',errors:[...ev.errors,{at:new Date().toISOString(),message:'Sending stopped without an answer.'}].slice(-20)};
    if(await store.compareAndSet(K.alert(env,ev.id),JSON.stringify(ev),JSON.stringify(next))){await store.srem(K.mailq(env),ev.id);n++;}
  }
  return n;
}
// An administrator settles an uncertain delivery after checking the mailbox: sent, or not sent (then it can be sent).
async function resolveAlert(env,me,b){
  const store=requireStore(env),key=K.alert(env,b?.id||''),raw=await store.get(key);if(!raw)problem('Alert not found.',404,'not_found');
  const ev=JSON.parse(raw);if(ev.status!=='uncertain')problem('Only an uncertain delivery can be settled.',409,'conflict');
  if(!['sent','not_sent'].includes(b.outcome))problem('Choose Sent or Not sent.');
  const next={...ev,status:b.outcome==='sent'?'sent':'failed',resolvedBy:{email:me.email,name:me.name,at:new Date().toISOString(),outcome:b.outcome}};
  if(!await store.compareAndSet(key,raw,JSON.stringify(next)))problem('The alert changed. Refresh and retry.',409,'conflict');
  return next;
}

// ---- Odoo check: lines entered or changed in Odoo directly ----
const PAGE=500,MAX_PAGES=20;
export async function scanOdoo(env,{pageSize=PAGE,maxPages=MAX_PAGES}={}){
  const [cfg,allow,projects,timeCfg]=await Promise.all([readBillingConfig(env),readAllowances(env),readProjectDefaults(env),readTimeConfig(env)]);
  const enabled=allow.items.filter(a=>a.enabled),ids=[...new Set([...enabled.flatMap(a=>a.projectIds),...Object.keys(projects.items).map(Number)])].slice(0,200);
  const today=todayIn(),since=[addDays(today,-400),[addDays(today,-62),...enabled.map(a=>a.startDate)].sort()[0]].sort().at(-1);
  const out={at:new Date().toISOString(),since,complete:true,total:0,read:0,projects:{},duplicates:[],classification:[]};
  if(!ids.length)return out;
  const uuidField=timeCfg.fields.entryUuid,domain=[['project_id','in',ids],['date','>=',since]],fields=['date','unit_amount','project_id','task_id',...(uuidField?[uuidField]:[])];
  out.total=await odoo(env,'account.analytic.line','search_count',[domain]);
  const lines=[];
  for(let page=0;lines.length<out.total;page++){
    if(page>=maxPages){out.complete=false;break;}
    const batch=await odoo(env,'account.analytic.line','search_read',[domain],{fields,order:'id',limit:pageSize,offset:page*pageSize});
    lines.push(...batch);if(batch.length<pageSize)break;
  }
  out.read=lines.length;if(lines.length<out.total)out.complete=false;
  const [entries,metas,ack]=await Promise.all([entriesBetween(env,since,today),readAllMetadata(env),requireStore(env).smembers(K.ack(env)).then(a=>new Set((a||[]).map(Number)))]);
  const byId=new Map(entries.map(e=>[e.id,e])),seen=new Map();
  const proj=id=>out.projects[id]||=({lines:0,minutes:0,direct:[],unreconciled:[]});
  for(const l of lines){
    const pid=m2o(l.project_id),minutes=Math.round(Number(l.unit_amount)*60),uuid=uuidField?l[uuidField]:false,p=proj(pid);p.lines++;p.minutes+=minutes;
    if(!uuid){if(!ack.has(l.id))p.direct.push({lineId:l.id,date:l.date,minutes,task:Array.isArray(l.task_id)?String(l.task_id[1]||''):''});continue;}
    seen.set(uuid,[...(seen.get(uuid)||[]),l.id]);
    if(String(uuid).startsWith('agreed:')){const key=String(uuid).slice(7),m=metas.get(key),expected=m?.agreedHours!=null?Math.round(m.agreedHours*60):null;
      if(expected!==minutes)p.unreconciled.push({lineId:l.id,date:l.date,ticket:key,minutes,expected,message:expected==null?'Odoo has an agreed-hours line for '+key+', but the ticket has no agreed hours.':'Odoo line #'+l.id+' has '+minutes+' min; the agreed hours are '+expected+' min.'});continue;}
    const e=byId.get(uuid);
    if(!e){p.unreconciled.push({lineId:l.id,date:l.date,minutes,message:'Odoo line #'+l.id+' has a dashboard entry id the dashboard does not have.'});continue;}
    if(isSynced(e)&&(e.minutes!==minutes||e.date!==l.date))p.unreconciled.push({lineId:l.id,date:l.date,ticket:e.ticket,chargeId:e.id,minutes,expected:e.minutes,message:'Odoo line #'+l.id+' was changed in Odoo ('+l.date+', '+minutes+' min; the dashboard has '+e.date+', '+e.minutes+' min).'});
    // Work of a ticket with agreed hours that is also in Odoo as its own line counts twice there.
    else if(metas.get(e.ticket)?.agreedHours!=null)out.duplicates.push({lineId:l.id,date:l.date,ticket:e.ticket,chargeId:e.id,projectId:pid,message:e.ticket+' has agreed hours, and Odoo line #'+l.id+' also has its own work. Remove the extra line in Odoo.'});
  }
  for(const [uuid,list] of seen)if(list.length>1)out.duplicates.push({lineIds:list,chargeId:uuid,message:'Odoo has '+list.length+' lines for the same dashboard entry (lines '+list.map(i=>'#'+i).join(', ')+').'});
  // Classification changed in Odoo directly: reported, never copied over the dashboard's value.
  if(cfg.fields.project){
    const rows=await odoo(env,'project.project','read',[ids],{fields:[cfg.fields.project]});
    for(const r of rows){const odooValue=fromOdoo(cfg,'project',r[cfg.fields.project]),mine=projects.items[r.id]?.billing??null;if(odooValue!==mine&&!(mine===null&&odooValue==='not_billable'&&cfg.fieldTypes?.project==='boolean'))out.classification.push({projectId:r.id,dashboard:mine,odoo:odooValue,message:'Odoo project #'+r.id+' is '+(odooValue||'not set')+' in Odoo but '+(mine||'not classified')+' in the dashboard.'});}
  }
  if(cfg.fields.task){
    const tasks=await odoo(env,'project.task','search_read',[[['project_id','in',ids],['name','=like','[%]%']]],{fields:['name',cfg.fields.task],context:{active_test:false},limit:20000});
    const hd=await readTicketRecords(env);
    for(const t of tasks){const key=/^\[([A-Z][A-Z0-9_]*-\d+)\]/.exec(String(t.name||''))?.[1];if(!key)continue;
      const odooValue=cfg.values.task[String(t[cfg.fields.task])]??(t[cfg.fields.task]===false?'inherit':null),mine=(sourceOf(env,key)==='odoo'?hd[key]?.billing:metas.get(key)?.billing)??'inherit';
      if(odooValue!==null&&odooValue!==mine)out.classification.push({ticket:key,taskId:t.id,dashboard:mine,odoo:odooValue,message:key+' is '+odooValue+' on Odoo task #'+t.id+' but '+mine+' in the dashboard.'});}
  }
  return out;
}
async function acknowledgeLines(env,me,b){
  const ids=b?.lineIds;if(!Array.isArray(ids)||!ids.length||ids.length>500||ids.some(i=>!Number.isInteger(i)||i<1))problem('Choose the Odoo lines.');
  const reason=typeof b.reason==='string'?b.reason.trim():'';if(!reason||reason.length>500)problem('Give a reason (up to 500 characters).');
  const store=requireStore(env);for(const id of ids)await store.sadd(K.ack(env),String(id));
  await update(env,K.scan(env),()=>({}),cur=>({...cur,acknowledged:[...(cur.acknowledged||[]),{at:new Date().toISOString(),by:{email:me.email,name:me.name},lineIds:ids,reason}].slice(-200),
    projects:Object.fromEntries(Object.entries(cur.projects||{}).map(([k,p])=>[k,{...p,direct:p.direct.filter(l=>!ids.includes(l.lineId))}]))}));
  return {acknowledged:ids.length};
}

// ---- The background check ----
// Settles stuck sends, checks Odoo, brings a share of ticket ledgers up to date, evaluates alerts and sends queued
// ones, stopping well inside the function time limit.
export async function runScan(env,{sendMail,budgetMs=40000,ledgers=150}={}){
  const started=Date.now(),cfg=await readBillingConfig(env),out={classification:cfg.classification,mail:mailMode(env,cfg).mode};
  out.uncertain=await expireSending(env);
  if(!cfg.classification)return {...out,skipped:'Billing classification is off.'};
  if(odooConfigured(env)){
    try{const scan=await scanOdoo(env),prev=await readScan(env);scan.acknowledged=prev?.acknowledged||[];await requireStore(env).set(K.scan(env),JSON.stringify(scan));out.odoo={complete:scan.complete,read:scan.read,total:scan.total};}
    catch(e){out.odoo={error:clean(e.message)};await update(env,K.scan(env),()=>({}),cur=>({...cur,error:{at:new Date().toISOString(),message:clean(e.message)}})).catch(()=>{});}
  }
  // Ledgers in turns: tickets with agreed hours, an override or an allowance, and tickets with work in the last two months.
  const today=todayIn(),[metas,recent,records]=await Promise.all([readAllMetadata(env),entriesBetween(env,addDays(today,-62),today),readTicketRecords(env)]);
  const keys=[...new Set([...[...metas].filter(([,m])=>m.agreedHours!=null||m.billing).map(([k])=>k),...recent.map(e=>e.ticket),...Object.keys(records)])].sort();
  const store=requireStore(env),offset=Number(await store.get(K.cursor(env)))||0;let done=0;
  for(let i=0;i<Math.min(ledgers,keys.length);i++){if(Date.now()-started>budgetMs/2)break;await reconcileTicket(env,keys[(offset+i)%keys.length]);done++;}
  await store.set(K.cursor(env),String(keys.length?(offset+done)%keys.length:0));out.ledgers={tickets:keys.length,reconciled:done};
  out.alerts=await evaluateAlerts(env,cfg,await billingSnapshot(env));
  const queue=await store.smembers(K.mailq(env))||[];out.sent=0;out.failed=0;out.uncertainNow=0;
  for(const id of queue){if(Date.now()-started>budgetMs||!sendMail)break;const r=await deliverAlert(env,id,sendMail).catch(()=>null);if(r?.status==='sent')out.sent++;else if(r?.status==='failed')out.failed++;else if(r?.status==='uncertain')out.uncertainNow++;}
  out.ms=Date.now()-started;
  return out;
}
export async function billingScanCron(request,env,{sendMail}){
  const secret=env.TIME_SYNC_SECRET||'';
  if(secret.length<24)return json({code:'sync_off',error:'The sync secret is not configured.'},503);
  if(!await sameSecret(request.headers.get('Authorization')||'','Bearer '+secret))return json({code:'forbidden',error:'Invalid sync secret.'},403);
  if(request.method!=='POST')return json({code:'method',error:'Use POST.'},405);
  if(!env.STORE?.writeIndexed)return json({skipped:'no database'});
  // One run at a time; a run that stops midway frees the lock when it expires.
  const store=env.STORE,lock=K.lock(env,'scan'),owner=crypto.randomUUID();
  if(!await store.setIfAbsent(lock,owner,120))return json({skipped:'A billing check is already running.'});
  try{return json(await runScan(env,{sendMail}));}finally{await store.deleteIfValue(lock,owner);}
}

// ---- Clients page ----
// Per Odoo project: its billing default, the work and consumption since its allowance started (else the last 12
// months), and the latest alert. null while classification is off.
export async function projectBillingRows(env){
  const cfg=await readBillingConfig(env);if(!cfg.classification)return null;
  const today=todayIn(),from=addDays(today,-365),[snap,alerts,scan]=await Promise.all([billingSnapshot(env,{from}),readAlerts(env),readScan(env)]);
  const byProject={},row=id=>byProject[id]||=({actualMinutes:0,billableMinutes:0,chargeableMinutes:0,unclassifiedMinutes:0,pendingSyncMinutes:0});
  const allowanceOf=id=>snap.d.allowances.items.find(a=>a.enabled&&a.projectIds.includes(id)&&activeOn(a,today))||null;
  for(const r of snap.rows){
    if(r.projectId==null)continue;const a=allowanceOf(r.projectId);if(r.date<(a?a.startDate:from))continue;
    const p=row(r.projectId);p.actualMinutes+=r.actualMinutes;
    if(r.billing.value==='billable')p.billableMinutes+=r.actualMinutes;else if(r.billing.value==='unclassified')p.unclassifiedMinutes+=r.actualMinutes;
    p.chargeableMinutes+=r.chargeableMinutes;if(r.kind==='entry'&&!isSynced(r)&&!['synced','agreed'].includes(r.state))p.pendingSyncMinutes+=r.actualMinutes;
  }
  const out={};
  for(const id of new Set([...Object.keys(byProject).map(Number),...Object.keys(snap.d.projects.items).map(Number),...snap.d.allowances.items.flatMap(a=>a.projectIds)])){
    const def=snap.projectDefault(id),a=allowanceOf(id),s=a?snap.statuses[a.id]:null,last=a?alerts.find(e=>e.allowanceId===a.id):null,p=byProject[id]||row(id);
    const status=!def?'needs_setup':!a?(def==='billable'?'no_allocation':'not_billable'):s.status;
    out[id]={default:def,odooSync:snap.d.projects.items[id]?.odoo||null,...p,status,
      allowance:a?{id:a.id,label:a.label,kind:a.kind,pool:a.projectIds.length>1,startDate:a.startDate,...s}:null,
      email:last?{status:last.status,label:MAIL_STATUS[last.status],at:last.sentAt||last.createdAt}:null,
      odooDirectMinutes:(scan?.projects?.[id]?.direct||[]).reduce((n,l)=>n+l.minutes,0)};
  }
  return {rows:out,scan:scan?{at:scan.at,complete:scan.complete,error:scan.error||null}:null};
}

// ---- Billable export ----
async function readMarkers(env){
  const store=requireStore(env),ids=await store.smembers(K.exportedSet(env))||[],out=new Map();
  for(let i=0;i<ids.length;i+=200){const part=ids.slice(i,i+200),raws=await mget(store,part.map(id=>K.exported(env,id)));part.forEach((id,n)=>{if(raws[n])out.set(id,JSON.parse(raws[n]));});}
  return out;
}
const COVERAGE={covered:'Covered',partial:'Partly covered',overage:'Over allocation',t_and_m:'Time & materials',no_allowance:'No allocation',ambiguous:'Several allowances'};
export const ORIGIN={actual:'Actual work',agreed:'Agreed hours',agreed_ticket:'Covered by agreed hours',none:'Not charged',removed:'Removed since export'};
function exportQuery(q){
  const today=todayIn(),from=q.from||today.slice(0,8)+'01',to=q.to||today;
  if(!validDate(from)||!validDate(to))problem('Choose valid dates.');
  if(from>to)problem('The start date is after the end date.');
  if(Date.parse(to)-Date.parse(from)>400*86400000)problem('Choose at most about a year.');
  const pick=(v,list,dflt)=>v==null||v===''?dflt:list.includes(v)?v:problem('Invalid filter: '+v+'.');
  return {from,to,billing:pick(q.billing,['billable','not_billable','unclassified','all'],'billable'),customer:q.customer?String(q.customer):'',project:q.project?Number(q.project)||problem('Invalid project.'):null,
    source:pick(q.source,['jira','internal','odoo'],''),coverage:pick(q.coverage,Object.keys(COVERAGE),''),exportState:pick(q.exportState,['pending','exported','all'],'pending')};
}
async function fingerprint(value){const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,32);}
export async function exportPreview(env,query){
  const q=exportQuery(query),[snap,markers,known,scan]=await Promise.all([billingSnapshot(env,{from:q.from,to:q.to}),readMarkers(env),readOdooProjects(env).then(projectIndex),readScan(env)]);
  let rows=snap.rows.filter(r=>r.date>=q.from&&r.date<=q.to).map(r=>({...r}));
  // Charges exported before and gone since (the ticket got agreed hours, or is no longer billable) are taken back.
  const have=new Set(rows.map(r=>r.chargeId));
  for(const [id,m] of markers)if(!have.has(id)&&m.date>=q.from&&m.date<=q.to&&m.minutes)rows.push({chargeId:id,kind:m.kind,ticket:m.ticket,source:m.source,title:m.title||'',date:m.date,projectId:m.projectId,taskId:m.taskId||null,worker:m.worker||'',description:m.description||'',
    actualMinutes:0,chargeableMinutes:0,billing:{value:'billable',source:'export'},origin:'removed',state:'removed',revision:null,coverage:null,coveredMinutes:0,allowanceId:m.allowanceId||null});
  for(const r of rows){const m=markers.get(r.chargeId);r.exportedMinutes=m?.minutes||0;r.deltaMinutes=r.chargeableMinutes-r.exportedMinutes;r.exportState=r.deltaMinutes!==0?(m?'adjustment':'new'):m?'exported':'none';r.batchId=m?.batchId||null;
    const p=r.projectId!=null?known.get(r.projectId):null;r.customer=p?.clientName||'';r.customerId=p?.clientId||null;r.project=p?.name||(r.projectId?'Odoo project #'+r.projectId:'');r.coverageLabel=r.coverage?COVERAGE[r.coverage]:'';r.originLabel=ORIGIN[r.origin];r.syncLabel=STATUS[r.state]||r.state;}
  // Odoo task ids for agreed charges (their entries carry their own).
  const needTask=[...new Set(rows.filter(r=>!r.taskId).map(r=>r.ticket))],tasks=Object.fromEntries(await Promise.all(needTask.map(async k=>[k,await ticketTask(env,k)])));
  for(const r of rows)if(!r.taskId){const t=tasks[r.ticket]||{};r.taskId=(t.tasks||{})[r.projectId]||(t.projectId===r.projectId?t.taskId:null)||null;}
  const scope=rows.filter(r=>(!q.customer||String(r.customerId)===q.customer||r.customer===q.customer)&&(!q.project||r.projectId===q.project)&&(!q.source||r.source===q.source));
  // Exceptions: what must be settled before a batch can be finalized.
  const exceptions=[],warnings=[];
  for(const r of scope){
    if(r.billing.value==='unclassified'&&r.actualMinutes>0)exceptions.push({kind:'unclassified',ticket:r.ticket,chargeId:r.chargeId,date:r.date,projectId:r.projectId,message:r.ticket+': '+r.actualMinutes+' min on '+r.date+' is not classified. Set the project default or the ticket\'s billing.'});
    if(r.coverage==='ambiguous')exceptions.push({kind:'ambiguous',ticket:r.ticket,chargeId:r.chargeId,message:r.ticket+': more than one allowance covers this work. Assign the ticket to one.'});
    if(r.kind==='entry'&&r.state==='review')exceptions.push({kind:'unreconciled',ticket:r.ticket,chargeId:r.chargeId,message:r.ticket+': the entry of '+r.date+' needs review in the work log.'});
    else if(r.kind==='entry'&&['syncing','setup'].includes(r.state)&&r.billing.value==='billable')warnings.push({kind:'not_in_odoo',ticket:r.ticket,chargeId:r.chargeId,message:r.ticket+': the entry of '+r.date+' is not in Odoo yet.'});
  }
  const projectsInScope=new Set(scope.map(r=>r.projectId).filter(x=>x!=null));if(q.project)projectsInScope.add(q.project);
  if(odooConfigured(env)){
    if(!scan||!scan.at||Date.now()-Date.parse(scan.at)>36*3600000)exceptions.push({kind:'scan',message:'Run the Odoo check first (Billing → Check Odoo now); the last one is '+(scan?.at?'older than 36 hours':'missing')+'.'});
    else{
      if(!scan.complete)exceptions.push({kind:'scan',message:'The last Odoo check read only '+scan.read+' of '+scan.total+' timesheet lines. Narrow the allowances or run it again.'});
      if(scan.since>q.from)warnings.push({kind:'scan',message:'The Odoo check covers work from '+scan.since+' only.'});
      for(const [pid,p] of Object.entries(scan.projects||{})){if(!projectsInScope.has(Number(pid)))continue;
        for(const l of p.direct)if(l.date>=q.from&&l.date<=q.to)exceptions.push({kind:'odoo_direct',projectId:Number(pid),lineId:l.lineId,message:'Odoo line #'+l.lineId+' ('+l.date+', '+l.minutes+' min'+(l.task?', '+l.task:'')+') was entered in Odoo directly. Log it in the dashboard or acknowledge it.'});
        for(const l of p.unreconciled)if(l.date>=q.from&&l.date<=q.to)exceptions.push({kind:'unreconciled',projectId:Number(pid),lineId:l.lineId,message:l.message});}
      for(const d of scan.duplicates||[])if((d.projectId==null||projectsInScope.has(d.projectId))&&(!d.date||(d.date>=q.from&&d.date<=q.to))&&(!d.ticket||scope.some(r=>r.ticket===d.ticket)))exceptions.push({kind:'duplicate',...d});
      for(const c of scan.classification||[])if((c.projectId&&projectsInScope.has(c.projectId))||(c.ticket&&scope.some(r=>r.ticket===c.ticket)))exceptions.push({kind:'classification',...c});
    }
  }
  const shown=scope.filter(r=>(q.billing==='all'||r.billing.value===q.billing||r.exportState==='adjustment')&&(!q.coverage||r.coverage===q.coverage)&&(q.exportState==='all'||(q.exportState==='pending'?['new','adjustment'].includes(r.exportState):r.exportState==='exported')));
  const tickets=new Map();
  for(const r of shown){const t=tickets.get(r.ticket)||{ticket:r.ticket,title:r.title,customer:r.customer,project:r.project,projectId:r.projectId,taskId:r.taskId,actualMinutes:0,chargeableMinutes:0,deltaMinutes:0,entries:0,origins:new Set(),coverage:new Set()};
    if(!t.title&&r.title)t.title=r.title;t.actualMinutes+=r.actualMinutes;t.chargeableMinutes+=r.chargeableMinutes;t.deltaMinutes+=r.deltaMinutes;t.entries++;t.origins.add(r.originLabel);if(r.coverageLabel)t.coverage.add(r.coverageLabel);tickets.set(r.ticket,t);}
  const totals={rows:shown.length,actualMinutes:shown.reduce((n,r)=>n+r.actualMinutes,0),chargeableMinutes:shown.reduce((n,r)=>n+r.chargeableMinutes,0),deltaMinutes:shown.reduce((n,r)=>n+r.deltaMinutes,0)};
  const finalizable=scope.filter(r=>['new','adjustment'].includes(r.exportState)&&(r.billing.value==='billable'||r.exportState==='adjustment'));
  return {query:q,timeZone:TIME_ZONE,rows:shown,tasks:[...tickets.values()].map(t=>({...t,origins:[...t.origins].join(', '),coverage:[...t.coverage].join(', ')})),totals,exceptions,warnings,
    finalizable:finalizable.length,fingerprint:await fingerprint({from:q.from,to:q.to,customer:q.customer,project:q.project,source:q.source,rows:finalizable.map(r=>[r.chargeId,r.chargeableMinutes,r.exportedMinutes,r.date,r.coverage,r.coveredMinutes])})};
}
// Finalizing records every charge it exports (with the entry's revision) so the next export never charges it again;
// a later correction comes out as an adjustment of the difference.
async function finalizeExport(env,me,b){
  const filters={from:b?.from,to:b?.to,customer:b?.customer||'',project:b?.project||null,source:b?.source||''};
  return withLock(env,'export',async()=>{
    const preview=await exportPreview(env,{...filters,billing:'billable',exportState:'pending'});
    if(preview.fingerprint!==b.fingerprint)problem('The billable work changed since the preview. Preview again before finalizing.',409,'stale_preview');
    if(preview.exceptions.length)problem('Settle the exceptions before finalizing.',409,'exceptions',{exceptions:preview.exceptions});
    const rows=preview.rows.filter(r=>['new','adjustment'].includes(r.exportState));
    if(!rows.length)problem('Nothing new to finalize for this period.',409,'empty');
    const store=requireStore(env),at=new Date().toISOString(),by={email:me.email,name:me.name},id='B'+todayIn().replace(/-/g,'')+'-'+crypto.randomUUID().slice(0,8);
    const batch={id,status:'finalizing',createdAt:at,by,query:preview.query,fingerprint:preview.fingerprint,timeZone:TIME_ZONE,
      totals:{rows:rows.length,chargeableMinutes:rows.reduce((n,r)=>n+r.chargeableMinutes,0),deltaMinutes:rows.reduce((n,r)=>n+r.deltaMinutes,0)},rows:rows.map(r=>({...r,batchId:id}))};
    if(!await store.setIfAbsent(K.batch(env,id),JSON.stringify(batch),FOREVER))problem('Try again.',409,'conflict');
    await store.sadd(K.batches(env),id);
    for(const r of rows){
      const k=K.exported(env,r.chargeId),raw=await store.get(k),prev=raw?JSON.parse(raw):null;
      const next={chargeId:r.chargeId,kind:r.kind,ticket:r.ticket,source:r.source,title:r.title,date:r.date,projectId:r.projectId,taskId:r.taskId,worker:r.worker,description:r.description,allowanceId:r.allowanceId,
        minutes:r.chargeableMinutes,batchId:id,revision:r.revision,at,history:[...(prev?.history||[]),{batchId:id,at,minutes:r.chargeableMinutes,delta:r.deltaMinutes,revision:r.revision}]};
      if(!(raw===null?await store.setIfAbsent(k,JSON.stringify(next),FOREVER):await store.compareAndSet(k,raw,JSON.stringify(next))))problem('An exported charge changed while finalizing batch '+id+'. Preview again; the batch stays incomplete.',409,'conflict');
      await store.sadd(K.exportedSet(env),r.chargeId);
    }
    const final={...batch,status:'final'};await store.set(K.batch(env,id),JSON.stringify(final));
    return final;
  });
}
async function batches(env){
  const store=requireStore(env),ids=await store.smembers(K.batches(env))||[],raws=await mget(store,ids.map(id=>K.batch(env,id)));
  return raws.filter(Boolean).map(r=>{const {rows,...b}=JSON.parse(r);return b;}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}

// ---- Rollout preview: what switching classification on would show, from the data as it is ----
async function migrationView(env){
  const [metas,projects,snapshot]=await Promise.all([readAllMetadata(env),readProjectDefaults(env),readOdooProjects(env)]);
  const counts={billable:0,not_billable:0,inherit:0};for(const [,m] of metas)counts[m.billing||'inherit']++;
  const active=(snapshot.projects||[]).filter(p=>p.active),today=todayIn(),snap=await billingSnapshot(env,{from:addDays(today,-90)});
  const recent=snap.rows.filter(r=>r.date>=addDays(today,-90));
  return {ticketOverrides:counts,projects:{classified:Object.keys(projects.items).length,active:active.length,unclassified:active.filter(p=>!projects.items[p.id]).map(p=>({id:p.id,label:p.label}))},
    last90Days:{actualMinutes:recent.reduce((n,r)=>n+r.actualMinutes,0),billableMinutes:recent.filter(r=>r.billing.value==='billable').reduce((n,r)=>n+r.actualMinutes,0),unclassifiedMinutes:recent.filter(r=>r.billing.value==='unclassified').reduce((n,r)=>n+r.actualMinutes,0)}};
}

// ---- HTTP (administrators) ----
async function body(request){const raw=await request.text();if(raw.length>64000)problem('Request too large.',413);try{return raw?JSON.parse(raw):{};}catch{problem('Invalid request.');}}
export async function billingRoutes(request,env,url,me,{readTicket,sendMail}){
  if(me.role!=='admin')problem('Only administrators can see billing.',403,'forbidden');
  requireStore(env);
  const path=url.pathname,method=request.method,q=Object.fromEntries(url.searchParams);
  if(path==='/billing/setup'){if(method==='GET')return json(await setupView(env));if(method==='PUT'){await saveSetup(env,me,await body(request));return json(await setupView(env));}problem('Use GET or PUT.',405,'method');}
  if(path==='/billing/migration'&&method==='GET')return json(await migrationView(env));
  if(path==='/billing/projects'){if(method==='GET')return json({...(await readProjectDefaults(env)),...(await projectBillingRows(env)||{rows:{}})});if(method==='PUT')return json(await saveProjectDefault(env,me,await body(request)));problem('Use GET or PUT.',405,'method');}
  if(path==='/billing/ticket'){
    if(method==='GET'){const key=q.key;if(!sourceOf(env,key))problem('Choose a ticket.');if(!await readTicket(key))problem('Ticket unavailable.',404,'not_found');return json(await ticketView(env,key));}
    if(method==='PUT')return json(await saveTicket(env,me,await body(request),readTicket));
    problem('Use GET or PUT.',405,'method');
  }
  if(path==='/billing/allowances'){
    if(method==='GET')return json(await allowancesView(env));
    if(method==='POST'||method==='PUT'){await saveAllowance(env,me,await body(request),{create:method==='POST'});return json(await allowancesView(env));}
    problem('Use GET, POST or PUT.',405,'method');
  }
  if(path==='/billing/allowances/top-up'&&method==='POST'){const r=await addTopUp(env,me,await body(request));return json({...(await allowancesView(env)),rearmed:r.rearmed});}
  if(path==='/billing/alerts'&&method==='GET')return json({mail:mailMode(env,await readBillingConfig(env)),items:(await readAlerts(env)).map(alertSummary)});
  if(path==='/billing/alerts/send'&&method==='POST'){const b=await body(request);return json({alert:alertSummary(await deliverAlert(env,String(b.id||''),sendMail,{explicit:true,me}))});}
  if(path==='/billing/alerts/resolve'&&method==='POST')return json({alert:alertSummary(await resolveAlert(env,me,await body(request)))});
  if(path==='/billing/scan'){
    if(method==='GET')return json({scan:await readScan(env)});
    if(method==='POST')return withLock(env,'scan',async()=>json(await runScan(env,{sendMail})));
    problem('Use GET or POST.',405,'method');
  }
  if(path==='/billing/scan/acknowledge'&&method==='POST')return json(await acknowledgeLines(env,me,await body(request)));
  if(path==='/billing/export/preview'&&method==='GET')return json(await exportPreview(env,q));
  if(path==='/billing/export/finalize'&&method==='POST')return json({batch:await finalizeExport(env,me,await body(request))});
  if(path==='/billing/export/batches'&&method==='GET')return json({items:await batches(env)});
  if(path==='/billing/export/batch'&&method==='GET'){const raw=await requireStore(env).get(K.batch(env,String(q.id||'')));if(!raw)problem('Batch not found.',404,'not_found');return json({batch:JSON.parse(raw)});}
  problem('Not found.',404,'not_found');
}
