// Private dashboard business data. Never include these fields in Jira mutations.
import { odoo, odooConfigured } from './odoo.js';
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
const empty=()=>({revision:0,clientId:null,subClientId:null,billing:null,estimatedHours:null,actualHours:null,workDone:'',completedAt:null,history:[]});
export const catalogKey=env=>prefix(env)+'catalog';
export const metadataKey=(env,key)=>prefix(env)+'ticket:'+key;
export async function readCatalog(env) { return JSON.parse(await requireStore(env).get(catalogKey(env)) || '{"revision":0,"entries":[]}'); }
export async function readMetadata(env,key) { return {...empty(),...JSON.parse(await requireStore(env).get(metadataKey(env,key)) || '{}')}; }
export function publicMetadata(record,me,catalog) {
  const {history,...m}=record;
  const visible=me.role==='admin'?m:Object.fromEntries(Object.entries(m).filter(([k])=>k!=='billing'));
  const client=catalog?.entries.find(e=>e.id===m.clientId),sub=catalog?.entries.find(e=>e.id===m.subClientId);
  return {...visible,clientName:client?.name||'',subClientName:sub?.name||''};
}
export function publicHistory(m,me) {
  return m.history.map(h=>me.role==='admin'?h:{...h,changes:Object.fromEntries(Object.entries(h.changes||{}).filter(([k])=>k!=='billing'))})
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
// sub-client that is chosen must be valid.
export function selectionErrors(catalog,m,{active=false}={}) {
  if(!m.clientId&&!m.subClientId)return [];
  const client=catalog.entries.find(e=>e.id===m.clientId&&!e.parentId),errors=[];
  if(!client || (active&&client.archived))return ['Choose a client'];
  const children=catalog.entries.filter(e=>e.parentId===client.id&&!e.archived);
  const sub=catalog.entries.find(e=>e.id===m.subClientId&&e.parentId===client.id);
  if(m.subClientId&&(!sub||(active&&sub.archived)))errors.push('Choose a valid sub-client');
  else if(!m.subClientId&&children.length)errors.push('Choose a sub-client');
  return errors;
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
export async function saveMetadata(env,key,patch,me,{closed=false,creating=false}={}) {
  const store=requireStore(env),raw=await store.get(metadataKey(env,key)),old={...empty(),...JSON.parse(raw||'{}')},m=structuredClone(old),catalog=await readCatalog(env);
  if(closed)problem('Reopen this ticket before editing its business fields.',409,'ticket_closed');
  if(!patch || typeof patch!=='object'||Array.isArray(patch))problem('Invalid ticket fields.');
  const allowed=['revision','clientId','subClientId','billing','estimatedHours','actualHours','workDone'];
  if(Object.keys(patch).some(k=>!allowed.includes(k)))problem('Unknown ticket business field.');
  if(!Number.isInteger(patch.revision)||patch.revision!==old.revision)problem('Ticket fields changed. Refresh and retry.',409,'conflict');
  if(me.role!=='admin'&&'billing' in patch)problem('Only administrators can access billing.',403,'forbidden');
  if(me.role!=='admin'&&!creating&&('clientId' in patch||'subClientId' in patch))problem('Only administrators can change the client selection.',403,'forbidden');
  // Once an estimate is set, only an administrator can change it.
  if(me.role!=='admin'&&'estimatedHours' in patch&&old.estimatedHours!=null&&Number(patch.estimatedHours)!==Number(old.estimatedHours))problem('The estimate is already set. Ask an administrator to change it.',403,'estimate_locked');
  for(const k of ['clientId','subClientId'])if(k in patch){if(patch[k]!==null&&(typeof patch[k]!=='string'||patch[k].length>80))problem('Invalid client selection.');m[k]=patch[k];}
  if('clientId' in patch && patch.clientId!==old.clientId && !('subClientId' in patch))m.subClientId=null;
  // A new internal ticket may be opened without a client (it's needed later, to close it).
  const noClient=creating&&!m.clientId&&!m.subClientId;
  if(('clientId' in patch||'subClientId' in patch)&&!noClient){const errors=selectionErrors(catalog,m,{active:m.clientId!==old.clientId||m.subClientId!==old.subClientId});if(errors.length)problem(errors.join('. '));}
  if('billing' in patch){if(![null,'billable','not_billable'].includes(patch.billing))problem('Choose Billable or Not billable.');m.billing=patch.billing;}
  for(const k of ['estimatedHours','actualHours'])if(k in patch){if(patch[k]!==null&&!validHours(patch[k]))problem(k+': enter a positive number with up to two decimal places (maximum 1,000,000).');m[k]=patch[k];}
  if('workDone' in patch){if(typeof patch.workDone!=='string'||patch.workDone.length>5000)problem('Work done must be text up to 5,000 characters.');m.workDone=patch.workDone.trim();}
  if(creating&&!noClient){const errors=selectionErrors(catalog,m,{active:true});if(errors.length)problem(errors.join('. '));}
  const changes={};for(const k of allowed.filter(k=>k!=='revision'))if(m[k]!==old[k])changes[k]={from:old[k],to:m[k]};
  m.revision++;m.updatedAt=new Date().toISOString();m.history.push({type:'edit',at:m.updatedAt,by:{email:me.email,name:me.name},changes});
  await persist(env,key,m,raw);return publicMetadata(m,me,catalog);
}
// Caller holds the same ticket lock used by metadata writes, and supplies an authoritative status read.
export async function guardedTransition(env,key,me,{closing,overrideReason},apply) {
  const store=requireStore(env),raw=await store.get(metadataKey(env,key)),m={...empty(),...JSON.parse(raw||'{}')};
  const missing=closing?closureErrors(await readCatalog(env),m):[];
  if(missing.length&&(me.role!=='admin'||typeof overrideReason!=='string'||!overrideReason.trim()||overrideReason.trim().length>1000))problem('Cannot close: '+missing.join('; ')+'.'+(me.role==='admin'?' Supply an override reason or complete the fields.':''),400,'closure_required',{missing,canOverride:me.role==='admin'});
  const result=await apply();
  if(result instanceof Response&&!result.ok)return result;
  const at=new Date().toISOString();m.completedAt=closing?at:null;m.revision++;
  m.history.push({type:closing?'completed':'reopened',at,by:{email:me.email,name:me.name},changes:{}});
  if(missing.length)m.history.push({type:'override',at,by:{email:me.email,name:me.name},reason:overrideReason.trim(),missing,changes:{}});
  await persist(env,key,m,raw);return result;
}
const nameKey=n=>n.trim().normalize('NFC').toLocaleLowerCase('en-US');
async function idFor(parent,name) { const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode((parent||'root')+'\0'+nameKey(name)));return 'c_'+Array.from(new Uint8Array(bytes).slice(0,16),x=>x.toString(16).padStart(2,'0')).join(''); }
function cleanName(n) {if(typeof n!=='string'||!n.trim()||n.trim().length>300)problem('Client names must contain 1–300 characters.');return n.trim();}
// Clients come straight from Odoo, the same way the project workbook did: each project's customer
// is a client and the project is its sub-client (a project without a customer is a client itself).
// Entries are only added (ids are stable by name), so tickets keep their client when Odoo changes.
const odooSyncKey=env=>prefix(env)+'catalog:odoo-sync';
async function odooRows(env){
  const projects=await odoo(env,'project.project','search_read',[[]],{fields:['display_name','partner_id'],order:'id',limit:5000});
  return projects.map(p=>({displayName:String(p.display_name||'').trim(),customer:Array.isArray(p.partner_id)?String(p.partner_id[1]||'').trim():'',sourceRow:p.id}))
    .filter(r=>r.displayName&&r.displayName.length<=300&&r.customer.length<=300);
}
export async function syncCatalogFromOdoo(env,{force=false}={}){
  if(!odooConfigured(env))return {odoo:false};
  const store=requireStore(env),last=Number(await store.get(odooSyncKey(env)))||0;
  if(!force&&Date.now()-last<10*60*1000)return {odoo:true,changed:false,syncedAt:last};
  const lock=odooSyncKey(env)+':lock',owner=crypto.randomUUID();
  if(!await store.setIfAbsent(lock,owner,120))return {odoo:true,changed:false,busy:true,syncedAt:last};
  try{
    const rows=await odooRows(env);let changed=false,added=0;
    if(rows.length)for(let attempt=0;;attempt++){
      const key=catalogKey(env),previous=await store.get(key),catalog=previous?JSON.parse(previous):{revision:0,entries:[]};
      const {next,preview}=await prepareImport(catalog,rows,'odoo');
      if(JSON.stringify(next.entries)===JSON.stringify(catalog.entries))break;
      next.revision=catalog.revision+1;
      if(previous===null?await store.setIfAbsent(key,JSON.stringify(next),315360000):await store.compareAndSet(key,previous,JSON.stringify(next))){changed=true;added=preview.added;break;}
      if(attempt>=2)problem('Catalog changed during the Odoo sync. Try again.',409,'conflict');
    }
    const at=Date.now();await store.set(odooSyncKey(env),String(at));
    return {odoo:true,changed,added,projects:rows.length,syncedAt:at};
  }finally{await store.deleteIfValue(lock,owner);}
}
export async function prepareImport(catalog,rows,source='project-workbook') {
  if(!Array.isArray(rows)||!rows.length||rows.length>5000)problem('Import 1–5,000 catalog rows.');
  const next=structuredClone(catalog),added=[];
  async function ensure(name,parentId,sourceRow){
    name=cleanName(name);let e=next.entries.find(e=>e.parentId===parentId&&nameKey(e.name)===nameKey(name));
    if(!e){const id=await idFor(parentId,name);e=next.entries.find(e=>e.id===id);if(!e){e={id,name,parentId,archived:false,sources:[]};next.entries.push(e);added.push(e.id);}}
    if(sourceRow&&!e.sources.some(s=>s.row===sourceRow&&s.source===source))e.sources.push({source,row:sourceRow});
    return e;
  }
  for(const [i,r] of rows.entries()){
    if(!r||typeof r!=='object')problem('Invalid import row '+(i+2));
    const display=cleanName(r.displayName),customer=typeof r.customer==='string'?r.customer.trim():'';
    const sourceRow=Number.isInteger(r.sourceRow)&&r.sourceRow>=2?r.sourceRow:i+2;
    if(customer){const parent=await ensure(customer,null,sourceRow);await ensure(display,parent.id,sourceRow);}else await ensure(display,null,sourceRow);
  }
  return {next,preview:{rows:rows.length,added:added.length,existing:next.entries.length-added.length,clients:next.entries.filter(e=>!e.parentId).length,subClients:next.entries.filter(e=>e.parentId).length,entries:next.entries.filter(e=>added.includes(e.id))}};
}
export async function catalogRoutes(request,env,url,me) {
  // Odoo sync: anyone signed in may refresh a stale catalog (it only copies Odoo's projects in);
  // forcing an immediate sync is for administrators.
  if(url.pathname==='/clients/odoo-sync'){
    if(request.method!=='POST')problem('Use POST.',405);
    const force=url.searchParams.get('force')==='1';if(force&&me.role!=='admin')problem('Only administrators manage the client catalog.',403,'forbidden');
    let result;try{result=await syncCatalogFromOdoo(env,{force});}catch(e){if(e instanceof BusinessError)throw e;problem("Couldn't read projects from Odoo: "+(e.message||'unknown error'),502,'odoo');}
    return Response.json({...result,...(result.changed?{catalog:await catalogRoutes(new Request(url,{method:'GET'}),env,new URL('/clients',url),me).then(r=>r.json())}:{})},{headers:{'Cache-Control':'no-store'}});
  }
  const store=requireStore(env),catalog=await readCatalog(env),admin=me.role==='admin';
  if(request.method==='GET')return Response.json({revision:catalog.revision,entries:catalog.entries.map(e=>admin?e:({id:e.id,name:e.name,parentId:e.parentId,archived:e.archived}))},{headers:{'Cache-Control':'no-store'}});
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
    if(b.id){const e=next.entries.find(e=>e.id===b.id);if(!e)problem('Client not found.',404);if('name'in b)e.name=cleanName(b.name);if('archived'in b){if(typeof b.archived!=='boolean')problem('Invalid archive value.');e.archived=b.archived;}}
    else {const parentId=b.parentId||null;if(parentId&&!next.entries.some(e=>e.id===parentId&&!e.parentId&&!e.archived))problem('Choose an active parent client.');const name=cleanName(b.name);next.entries.push({id:await idFor(parentId,name),name,parentId,archived:false,sources:[]});}
    const seen=new Set();for(const e of next.entries){const k=(e.parentId||'')+'|'+nameKey(e.name);if(seen.has(k))problem('This client or sub-client already exists.');seen.add(k);}
  }else problem('Not found.',404);
  next.revision=catalog.revision+1;
  const key=catalogKey(env),previous=await store.get(key);
  if(previous&&JSON.parse(previous).revision!==catalog.revision)problem('Catalog changed. Refresh.',409,'conflict');
  if(!(previous===null?await store.setIfAbsent(key,JSON.stringify(next),315360000):await store.compareAndSet(key,previous,JSON.stringify(next))))problem('Catalog changed. Refresh.',409,'conflict');
  return Response.json(next,{headers:{'Cache-Control':'no-store'}});
}
// readTickets(keys) (optional) checks many tickets at once and returns {key:true} for the ones this person may see.
export async function metadataRoutes(request,env,url,me,readTicket,readTickets) {
  requireStore(env);
  const raw=request.method==='GET'?'':await request.text();
  if(raw.length>64000)problem('Ticket fields request too large.',413);
  let b=null;if(raw){try{b=JSON.parse(raw);}catch{problem('Invalid ticket fields request.');}}
  const validKey=k=>typeof k==='string'&&k.length<=80&&/^[A-Z][A-Z0-9_]*-[0-9]+$/.test(k)&&['INT',env.JIRA_PROJECT].includes(k.split('-')[0]);
  const key=url.searchParams.get('key')||b?.key;
  if(url.pathname==='/ticket-metadata/batch'&&request.method==='POST'){
    if(!Array.isArray(b?.keys)||b.keys.length>100||b.keys.some(k=>!validKey(k)))problem('Supply up to 100 valid ticket keys.');
    const store=env.STORE,keys=[...new Set(b.keys)],records={};
    // The whole list in a few round trips: visibility in bulk, then every ticket's fields in one read.
    const [catalog,visible]=await Promise.all([readCatalog(env),readTickets?readTickets(keys):null]);
    let shown=keys;
    if(visible)shown=keys.filter(k=>visible[k]);
    else{const seen=[];for(let offset=0;offset<keys.length;offset+=8)await Promise.all(keys.slice(offset,offset+8).map(async k=>{if(await readTicket(k))seen.push(k);}));shown=seen;}
    const raws=!shown.length?[]:store.mget?await store.mget(shown.map(k=>metadataKey(env,k))):await Promise.all(shown.map(k=>store.get(metadataKey(env,k))));
    shown.forEach((k,n)=>{records[k]=publicMetadata({...empty(),...JSON.parse(raws[n]||'{}')},me,catalog);});
    return Response.json({records},{headers:{'Cache-Control':'no-store'}});
  }
  if(!validKey(key))problem('Choose a valid ticket.');
  return withTicketLock(env,key,async()=>{
    const t=await readTicket(key);if(!t)problem('Ticket unavailable.',404,'not_found');
    if(request.method==='GET'){const m=await readMetadata(env,key);return Response.json({metadata:publicMetadata(m,me,await readCatalog(env)),history:publicHistory(m,me),closed:t.closed},{headers:{'Cache-Control':'no-store'}});}
    if(request.method==='PUT')return Response.json({metadata:await saveMetadata(env,key,b.fields,me,{closed:t.closed})});
    problem('Use GET or PUT.',405);
  });
}
