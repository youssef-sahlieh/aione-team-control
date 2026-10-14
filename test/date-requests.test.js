import test from 'node:test';
import assert from 'node:assert/strict';
import {dateRequestRoutes,validDate} from '../proxy/src/date-requests.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';
function fixture(){
 const store=memoryStore(),env={STORE:store,JIRA_PROJECT:'AION',MAIL_DOMAIN:'aione.biz',APP_URL:'https://example.test'};
 const user={email:'dev@aione.biz',name:'Developer',role:'user',dev:'builder'},admin={email:'admin@aione.biz',name:'Admin',role:'admin'};
 const tickets=new Map([['AION-1',{title:'Task',due:'2026-10-20',devs:['builder'],closed:false}],['INT-1',{title:'Internal',due:null,devs:['builder'],closed:false}],['AION-2',{title:'Private',due:null,devs:['other'],closed:false}]]);
 let writes=0,failWrite=false,failMail=false;
 const mails=[];
 const deps={readTicket:async key=>structuredClone(tickets.get(key)||null),applyDate:async(key,date)=>{writes++;if(failWrite)throw Error('Unavailable');tickets.get(key).due=date;},sendMail:async(from,body)=>{mails.push(body);return Response.json({}, {status:failMail?502:200});}};
 const call=async(action,body,me=user)=>{await saveUser(store,admin);await saveUser(store,user);const url=new URL('https://test/date-requests'+(action?'/'+action:''));const req=new Request(url,{method:action?'POST':'GET',...(action?{body:JSON.stringify(body)}:{})});const res=await dateRequestRoutes(req,env,url,me,deps);return {status:res.status,data:await res.json()};};
 const submit=(key='AION-1')=>call('submit',{key,proposedDate:'2026-10-24',reason:'Dependency is delayed'});
 return {store,user,admin,tickets,deps,call,submit,mails,get writes(){return writes;},set failWrite(v){failWrite=v;},set failMail(v){failMail=v;}};
}
test('calendar validation rejects impossible dates and malformed values',()=>{for(const v of ['2026-02-30','2026-13-01','soon',undefined,123])assert.equal(validDate(v),false);assert.equal(validDate('2028-02-29'),true);assert.equal(validDate(null),true);});
test('requests preserve the approved date; only admins can apply it',async()=>{const f=fixture();const r=(await f.submit()).data.request;assert.equal(f.tickets.get('AION-1').due,'2026-10-20');assert.equal(f.writes,0);assert.equal((await f.call('approve',{key:r.key,id:r.id,version:r.version})).status,403);const approved=await f.call('approve',{key:r.key,id:r.id,version:r.version},f.admin);assert.equal(approved.data.request.status,'approved');assert.equal(f.tickets.get(r.key).due,'2026-10-24');assert.equal(f.writes,1);assert.equal(f.mails.length,2);});
test('foreign ticket submissions and reads cannot leak ticket information',async()=>{const f=fixture();assert.equal((await f.submit('OTHER-1')).status,400);assert.equal((await f.submit('AION-2')).status,404);await f.call('submit',{key:'AION-2',proposedDate:'2026-10-24',reason:'Admin proposal'},f.admin);const list=await f.call();assert.equal(list.data.requests.length,0);});
test('one active request per ticket and revision versions prevent stale approvals',async()=>{const f=fixture();const r=(await f.submit()).data.request;assert.equal((await f.submit()).status,409);const revise=await f.call('revise',{key:r.key,id:r.id,version:r.version,proposedDate:'2026-10-25',reason:'Revised estimate'});assert.equal(revise.data.request.version,2);assert.equal((await f.call('approve',{key:r.key,id:r.id,version:r.version},f.admin)).status,409);assert.equal(f.writes,0);});
test('changed context requires a second explicit review; closed tickets cannot be approved',async()=>{const f=fixture();const r=(await f.submit()).data.request;f.tickets.get(r.key).due='2026-10-21';assert.equal((await f.call('approve',{key:r.key,id:r.id,version:1},f.admin)).status,409);const current=(await f.call()).data.requests[0];assert.equal(current.status,'needs_review');assert.equal((await f.call('approve',{key:r.key,id:r.id,version:current.version,confirmContext:true},f.admin)).status,200);const second=(await f.submit('INT-1')).data.request;f.tickets.get(second.key).closed=true;assert.equal((await f.call('approve',{key:second.key,id:second.id,version:1},f.admin)).status,409);});
test('reject and withdraw preserve dates and require requester or administrator',async()=>{const f=fixture();let r=(await f.submit()).data.request;assert.equal((await f.call('reject',{key:r.key,id:r.id,version:1,reason:''},f.admin)).status,400);r=(await f.call('reject',{key:r.key,id:r.id,version:1,reason:'Keep current deadline'},f.admin)).data.request;assert.equal(r.status,'rejected');assert.equal(f.writes,0);r=(await f.submit()).data.request;assert.equal((await f.call('withdraw',{key:r.key,id:r.id,version:1})).data.request.status,'withdrawn');assert.equal(f.writes,0);});
test('alternative dates and direct changes require reasons; removal is supported',async()=>{const f=fixture();const r=(await f.submit()).data.request;assert.equal((await f.call('approve',{key:r.key,id:r.id,version:1,approvedDate:null},f.admin)).status,400);assert.equal((await f.call('approve',{key:r.key,id:r.id,version:1,approvedDate:null,reason:'Date is no longer meaningful'},f.admin)).status,200);assert.equal(f.tickets.get(r.key).due,null);assert.equal((await f.call('direct',{key:'INT-1',proposedDate:'2026-10-25',reason:'Admin sets initial commitment'},f.admin)).data.request.status,'approved');});
test('simultaneous approvals perform one write',async()=>{const f=fixture();const r=(await f.submit()).data.request;const results=await Promise.all([f.call('approve',{key:r.key,id:r.id,version:1},f.admin),f.call('approve',{key:r.key,id:r.id,version:1},f.admin)]);assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(f.writes,1);});
test('email failures do not lose requests or decisions and can be retried',async()=>{const f=fixture();f.failMail=true;const r=(await f.submit()).data.request;assert.equal(r.deliveries[0].status,'failed');const approved=await f.call('approve',{key:r.key,id:r.id,version:1},f.admin);assert.equal(approved.data.request.status,'approved');f.failMail=false;const retry=await f.call('retry-email',{key:r.key,id:r.id},f.admin);assert.ok(retry.data.request.deliveries.every(d=>d.status==='sent'));assert.equal(f.writes,1);});
test('unconfirmed writes remain applying and retry reconciles success without a duplicate write',async()=>{const f=fixture();const r=(await f.submit()).data.request;f.deps.applyDate=async(key,date)=>{f.tickets.get(key).due=date;throw Error('Response lost');};assert.equal((await f.call('approve',{key:r.key,id:r.id,version:1},f.admin)).status,502);const doc=JSON.parse(await f.store.get('dates:AION:AION-1'));doc.requests[0].updatedAt=new Date(Date.now()-121000).toISOString();await f.store.set('dates:AION:AION-1',JSON.stringify(doc));const result=await f.call('approve',{key:r.key,id:r.id,version:1},f.admin);assert.equal(result.data.request.status,'approved');assert.equal(result.data.request.events.at(-1).reconciled,true);});

test('a user sets an initial date immediately, but changing or clearing it requires approval',async()=>{
 const f=fixture();const result=await f.call('initial',{key:'INT-1',proposedDate:'2026-10-22'});assert.equal(result.status,200);assert.equal(result.data.request.status,'set');assert.equal(f.tickets.get('INT-1').due,'2026-10-22');assert.equal(f.writes,1);assert.equal(result.data.request.events.at(-1).type,'initial_date_set');
 assert.equal((await f.call('initial',{key:'INT-1',proposedDate:'2026-10-23'})).status,409);
 assert.equal((await f.call('initial',{key:'INT-1',proposedDate:null})).status,400);
 const change=await f.submit('INT-1');assert.equal(change.data.request.status,'pending');assert.equal(f.tickets.get('INT-1').due,'2026-10-22');
});
test('cleared dates and historical dates cannot bypass approval using initial setting',async()=>{
 const f=fixture();await f.call('initial',{key:'INT-1',proposedDate:'2026-10-22'});f.tickets.get('INT-1').due=null;assert.equal((await f.call('initial',{key:'INT-1',proposedDate:'2026-10-23'})).status,409);
 f.tickets.get('AION-1').due=null;f.tickets.get('AION-1').hasHadDue=true;assert.equal((await f.call('initial',{key:'AION-1',proposedDate:'2026-10-23'})).status,409);
});
test('simultaneous initial settings cannot overwrite one another; scope is still enforced',async()=>{
 const f=fixture();const responses=await Promise.all([f.call('initial',{key:'INT-1',proposedDate:'2026-10-22'}),f.call('initial',{key:'INT-1',proposedDate:'2026-10-23'})]);assert.equal(responses.filter(r=>r.status===200).length,1);assert.equal(f.writes,1);assert.equal((await f.call('initial',{key:'AION-2',proposedDate:'2026-10-22'})).status,404);
});

test('Jira initial setting checks existing history before allowing a first date',async t=>{
 const {default:handler,makeToken}=await import('../proxy/src/handler.js');const store=memoryStore();const user={email:'builder@aione.biz',name:'Builder',role:'user',dev:'builder',v:1};await saveUser(store,user);
 const env={STORE:store,SESSION_SECRET:'test-session',JIRA_PROJECT:'AION',JIRA_SITE:'https://jira.test',JIRA_EMAIL:'test@aione.biz',JIRA_API_TOKEN:'test',MAIL_DOMAIN:'aione.biz'};
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let writes=0;
 globalThis.fetch=async(url,options={})=>{if(options.method==='PUT'){writes++;return new Response(null,{status:204});}if(String(url).includes('/changelog'))return Response.json({values:[{items:[{field:'duedate',from:'2026-10-20',to:null}]}],isLast:true});return Response.json({key:'AION-1',fields:{project:{key:'AION'},summary:'Task',duedate:null,labels:['ai1_builder'],status:{statusCategory:{key:'new'}}}});};
 const {token}=await makeToken(env,user.email,Date.now(),1);const res=await handler.fetch(new Request('https://proxy.test/date-requests/initial',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({key:'AION-1',proposedDate:'2026-10-22'})}),env);assert.equal(res.status,409);assert.equal(writes,0);
});

test('the request records its developer identity separately from current ticket assignments',async()=>{
 const f=fixture();const r=(await f.submit()).data.request;assert.equal(r.requester.dev,'builder');f.tickets.get(r.key).devs=['other'];const list=(await f.call('',undefined,f.admin)).data.requests;assert.equal(list[0].requester.dev,'builder');assert.deepEqual(list[0].ticket.developers,['other']);
});

test('developers see only their own requests even when they share a ticket developer label',async()=>{
 const f=fixture();const other={email:'other@aione.biz',name:'Other Developer',role:'user',dev:'builder'};const own=(await f.submit()).data.request;
 await f.call('submit',{key:'INT-1',proposedDate:'2026-10-25',reason:'Another developer estimate'},other);
 const mine=(await f.call()).data.requests;assert.deepEqual(mine.map(r=>r.key),['AION-1']);
 const theirs=(await f.call('',undefined,other)).data.requests;assert.deepEqual(theirs.map(r=>r.key),['INT-1']);
 assert.equal((await f.call('',undefined,f.admin)).data.requests.length,2);
 assert.equal((await f.call('revise',{key:own.key,id:own.id,version:own.version,proposedDate:'2026-10-26',reason:'Cannot edit someone else'},other)).status,404);
 const url=new URL('https://test/date-requests?key=AION-1');const response=await dateRequestRoutes(new Request(url),{STORE:f.store,JIRA_PROJECT:'AION'},url,other,f.deps);assert.deepEqual((await response.json()).requests,[]);
});
