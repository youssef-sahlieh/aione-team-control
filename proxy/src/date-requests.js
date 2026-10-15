import { readMetadata, validHours, withTicketLock, BusinessError, businessResponse } from './ticket-metadata.js';
import { listUsers, validEmail } from './users.js';
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const fail=(error,status=400)=>json({code:status===403?'forbidden':status===409?'conflict':'date_request',error},status);
const active=r=>['pending','needs_review','applying'].includes(r.status);
const actor=me=>({email:me.email,name:me.name||me.email,dev:me.dev||null});
const stamp=()=>new Date().toISOString();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const validDate=v=>v===null||(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!isNaN(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v);
const reason=v=>typeof v==='string'&&v.trim().length>=3&&v.trim().length<=2000;
const snapshot=t=>({due:t.due||null,developers:[...t.devs].sort(),closed:!!t.closed});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function dateRequestRoutes(request,env,url,me,{readTicket,applyDate,sendMail}){
 const store=env.STORE;if(!store?.compareAndSet||!store?.setIfAbsent)return fail('Date requests need the account database.',503);
 const prefix='dates:'+env.JIRA_PROJECT+':',index=prefix+'tickets';
 const validKey=key=>typeof key==='string'&&new RegExp('^(INT|'+env.JIRA_PROJECT+')-\\d+$').test(key)&&key.length<80;
 const load=async key=>JSON.parse(await store.get(prefix+key)||'{"requests":[]}');
 const accessible=async (key,checkInitial=false)=>{const t=await readTicket(key,{checkInitial});if(!t)return null;if(me.role!=='admin'&&!t.devs.includes(me.dev))return null;return t;};
 if(request.method==='GET'&&url.pathname==='/date-requests'){
  const key=url.searchParams.get('key');if(key&&!validKey(key))return fail('Invalid ticket.');
  const cursor=url.searchParams.get('cursor')||'0';if(!/^\d{1,8}$/.test(cursor))return fail('Invalid request page.');
  const allKeys=key?[key]:(await store.smembers(index)).sort(),start=key?0:Number(cursor),keys=allKeys.slice(start,start+20),requests=[];
  for(let offset=0;offset<keys.length;offset+=5){const rows=await Promise.all(keys.slice(offset,offset+5).map(async k=>{const t=await accessible(k);if(!t)return null;const doc=await load(k);return doc.requests.filter(r=>me.role==='admin'||r.requester.email===me.email).map(r=>({...r,ticket:{key:k,title:t.title,due:t.due,developers:t.devs,closed:t.closed}}));}));for(const row of rows){if(row)requests.push(...row);else if(key)return fail('This ticket is unavailable.',404);}}
  const isLast=start+keys.length>=allKeys.length;
  return json({requests:requests.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),isLast,...(!isLast?{nextCursor:String(start+keys.length)}:{})});
 }
 if(request.method!=='POST')return fail('Use POST for date request actions.',405);
 let b;try{if(Number(request.headers.get('Content-Length'))>30000)return fail('Request is too large.',413);const text=await request.text();if(text.length>30000)return fail('Request is too large.',413);b=JSON.parse(text);}catch{return fail('Invalid request.');}
 if(!b||!validKey(b.key))return fail('Choose a valid ticket.');
 const action=url.pathname.slice('/date-requests/'.length);
 if(!['submit','revise','withdraw','approve','reject','direct','initial','retry-email'].includes(action))return fail('Unknown date request action.',404);
 if(['approve','reject','direct'].includes(action)&&me.role!=='admin')return fail('Only admins can decide or change approved dates.',403);
 if(['submit','revise','direct'].includes(action)&&(!validDate(b.proposedDate)||!reason(b.reason)))return fail('Choose a valid date (or removal) and explain why (3–2000 characters).');
 if(action==='reject'&&!reason(b.reason))return fail('Explain why the request is rejected.');
 if(action==='initial'&&(b.proposedDate===null||!validDate(b.proposedDate)))return fail('Choose a valid initial due date.');
 if(action==='initial')b.reason=reason(b.reason)?b.reason.trim():'Initial due date set';
 return withTicketLock(env,b.key,async()=>{
 const lock=prefix+b.key+':lock',owner=crypto.randomUUID();
 if(!await store.setIfAbsent(lock,owner,120))return fail('This ticket is being reviewed. Retry shortly.',409);
 try{
  const t=await accessible(b.key,action==='initial');if(!t)return fail('This ticket is unavailable.',404);
  if(me.role!=='admin'&&['initial','submit','revise'].includes(action)&&!validHours((await readMetadata(env,b.key)).estimatedHours))throw new BusinessError('Enter and save estimated hours greater than zero before setting or requesting a due date.',400,'estimate_required');
  let raw=await store.get(prefix+b.key);if(!raw){await store.sadd(index,b.key);await store.setIfAbsent(prefix+b.key,JSON.stringify({requests:[]}),315360000);raw=await store.get(prefix+b.key);}
  const doc=JSON.parse(raw);
  const save=async()=>{const next=JSON.stringify(doc);if(!await store.compareAndSet(prefix+b.key,raw,next))throw new Error('Date request changed concurrently');raw=next;};
  let r=doc.requests.find(r=>r.id===b.id);
  const admins=async()=>{const users=await listUsers(store);return users.filter(u=>u.role==='admin').map(u=>u.email);};
  const recipients=async kind=>kind==='submitted'?await admins():kind==='direct'? (await listUsers(store)).filter(u=>t.devs.includes(u.dev)).map(u=>u.email):[r.requester.email];
  const notify=async kind=>{const to=[...new Set(await recipients(kind))];r.deliveries||=[];const delivery={id:crypto.randomUUID(),kind,status:'pending',createdAt:stamp()};r.deliveries.push(delivery);await save();await deliver(delivery,to);};
  const deliver=async(d,to)=>{try{if(!to.length||!to.every(e=>validEmail(e)&&e.toLowerCase().endsWith('@'+env.MAIL_DOMAIN)))throw new Error('No valid recipients');const response=await sendMail(me.email,{to,subject:'[AION] Date request '+r.status+': '+b.key,html:'<p><b>'+esc(b.key)+' — '+esc(t.title)+'</b></p><p>Status: '+esc(r.status)+'<br>Previous date: '+esc(r.original.due||'Not set')+'<br>Proposed date: '+esc(r.proposedDate||'Remove date')+'<br>Approved date: '+esc((['approved','set'].includes(r.status)?r.appliedDate:t.due)||'Not set')+'</p><p>'+esc(r.reason)+'</p><p>'+esc(r.decision?.reason||'')+'</p><p><a href="'+esc(String(env.APP_URL).replace(/\/$/,'')+'/dashboard.html?page=requests#'+b.key)+'">Review in AION Team Control</a></p>'});d.status=response.ok?'sent':'failed';}catch{d.status='failed';}d.attemptedAt=stamp();await save();};
  if(action==='submit'||action==='direct'||action==='initial'){
   if(action==='initial'&&(t.due||t.hasHadDue||doc.requests.some(previous=>previous.appliedDate||previous.original?.due)))return fail('A due date has already been set for this ticket. Request approval to change it.',409);
   if(t.closed)return fail('Closed tickets cannot receive a new date request.',409);
   if((t.due||null)===b.proposedDate)return fail('The proposed date is already the approved date.');
   const pending=doc.requests.find(active);if(pending)return fail('This ticket already has an active date request. Review or withdraw it first.',409);
   r={id:crypto.randomUUID(),kind:action==='initial'?'initial':action==='direct'?'direct':'request',key:b.key,requester:actor(me),original:snapshot(t),proposedDate:b.proposedDate,reason:b.reason.trim(),blocker:String(b.blocker||'').slice(0,2000),status:'pending',version:1,createdAt:stamp(),updatedAt:stamp(),events:[{type:'submitted',at:stamp(),by:actor(me)}],deliveries:[]};
   doc.requests.push(r);await save();
   if(action==='submit'){await notify('submitted');return json({request:r},201);}
  }else{
   if(!r||(me.role!=='admin'&&r.requester.email!==me.email))return fail('No such request.',404);
   if(['revise','withdraw'].includes(action)&&me.role!=='admin'&&r.requester.email!==me.email)return fail('Only the requester can revise or withdraw this request.',403);
   if(action==='retry-email'){
    if(me.role!=='admin'&&r.requester.email!==me.email)return fail('Only admins or the requester can retry notifications.',403);
    for(const d of r.deliveries||[])if(d.status!=='sent')await deliver(d,await recipients(d.kind));return json({request:r});
   }
   if(!Number.isInteger(b.version)||b.version!==r.version)return fail('This request changed. Refresh and review its latest version.',409);
   if(!active(r))return json({request:r});
   if(r.status==='applying'&&action!=='approve')return fail('An unconfirmed date update must be reconciled before changing this request.',409);
   if(r.status==='applying'&&Date.now()-Date.parse(r.updatedAt)<120000)return fail('Approval is being applied. Refresh shortly.',409);
   if(action==='revise'){
    if(r.requester.email!==me.email)return fail('Only the requester can revise this request.',403);
    if(t.closed)return fail('This ticket has closed.',409);
    if((t.due||null)===b.proposedDate)return fail('The proposed date is already approved.');
    r.events.push({type:'revised',at:stamp(),by:actor(me),previous:{proposedDate:r.proposedDate,reason:r.reason,original:r.original}});
    Object.assign(r,{proposedDate:b.proposedDate,reason:b.reason.trim(),blocker:String(b.blocker||'').slice(0,2000),original:snapshot(t),status:'pending',version:r.version+1,updatedAt:stamp()});await save();await notify('submitted');return json({request:r});
   }
   if(action==='withdraw'||action==='reject'){
    r.status=action==='withdraw'?'withdrawn':'rejected';r.version++;r.updatedAt=stamp();r.decision={by:actor(me),reason:action==='reject'?b.reason.trim():'Withdrawn',at:stamp()};r.events.push({type:r.status,...r.decision});await save();if(action==='reject')await notify('decision');return json({request:r});
   }
  }
  // Persist the intended write before Jira: an interrupted approval can be reconciled safely.
  if(r.status==='applying'&&same({...snapshot(t),due:r.original.due},r.original)&&(t.due||null)===r.targetDate){
   r.status=r.kind==='initial'?'set':'approved';r.appliedDate=r.targetDate;r.updatedAt=stamp();r.version++;r.events.push({type:'approved',at:stamp(),by:r.decision.by,reconciled:true});await save();await notify(['direct','initial'].includes(r.kind)?'direct':'decision');return json({request:r});
  }
  if(t.closed)return fail("Closed tickets cannot have their due date changed.",409);
  if(!same(snapshot(t),r.original)&&!(r.status==='needs_review'&&b.confirmContext===true)){
   r.status='needs_review';r.version++;r.updatedAt=stamp();r.reviewContext=snapshot(t);r.events.push({type:'context_changed',at:stamp(),by:actor(me)});await save();return fail('The ticket date, developer assignment or status changed. Review the current ticket and confirm again.',409);
  }
  if(r.status==='needs_review'&&b.confirmContext!==true)return fail('Confirm the updated ticket context before approving.',409);
  if(r.status==='needs_review'&&b.confirmContext===true){r.events.push({type:'context_confirmed',at:stamp(),by:actor(me),previous:r.original});r.original=snapshot(t);}
  const target=r.status==='applying'?r.targetDate:('approvedDate' in b?b.approvedDate:r.proposedDate);
  if(!validDate(target))return fail('Choose a valid approved date.');
  if(target!==r.proposedDate&&!reason(b.reason))return fail('Explain the alternative approved date.');
  r.status='applying';r.targetDate=target;r.decision={by:actor(me),reason:reason(b.reason)?b.reason.trim():r.reason,at:stamp()};r.updatedAt=stamp();await save();
  try{await applyDate(b.key,target,t,r);}catch{r.updatedAt=stamp();r.error='The date update was not confirmed. Retry approval after checking the ticket.';await save();return fail(r.error,502);}
  r.status=r.kind==='initial'?'set':'approved';r.appliedDate=target;r.updatedAt=stamp();r.version++;delete r.error;r.events.push({type:r.kind==='initial'?'initial_date_set':'approved',at:stamp(),by:actor(me),from:r.original.due,to:target});await save();await notify(['direct','initial'].includes(r.kind)?'direct':'decision');return json({request:r});
 }finally{await store.deleteIfValue(lock,owner);}
 }).catch(error=>{if(error instanceof BusinessError)return businessResponse(error);throw error;});
}
