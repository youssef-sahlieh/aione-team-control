import test from 'node:test';
import assert from 'node:assert/strict';
import {ticketNoteRoutes} from '../proxy/src/ticket-notes.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';
async function fixture() {
  const user={email:'dev@aione.biz',name:'Developer',role:'user',dev:'builder'}, other={...user,email:'other@aione.biz'}, admin={email:'admin@aione.biz',name:'Admin',role:'admin'};
  const env={STORE:memoryStore(),JIRA_PROJECT:'AION',APP_URL:'https://app.test'};
  await saveUser(env.STORE,admin);
  const mails=[];
  const deps={readTicket:async key=>['AION-1','INT-1'].includes(key)?{title:'Private <ticket>',devs:['builder']}:null,sendMail:async(from,body)=>{mails.push({from,...body});return Response.json({});}};
  const call=async(me=user,body=null,key='AION-1')=>{const url=new URL('https://proxy.test/ticket-notes?key='+key),res=await ticketNoteRoutes(new Request(url,{method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})}),env,url,me,deps);return {status:res.status,data:await res.json()};};
  const note=(text='Please review this blocker',key='AION-1')=>({id:crypto.randomUUID(),key,text});
  return {user,other,admin,env,deps,mails,call,note};
}
test('notes are durable and private to the author and admins, even on shared tickets',async()=>{
 const f=await fixture();const result=await f.call(f.user,f.note());assert.equal(result.status,201);assert.equal(result.data.note.author.email,f.user.email);assert.equal((await f.call()).data.notes.length,1);assert.deepEqual((await f.call(f.other)).data.notes,[]);assert.equal((await f.call(f.admin)).data.notes.length,1);assert.equal(f.mails.length,1);assert.deepEqual(f.mails[0].to,[f.admin.email]);
});
test('unauthorized and foreign tickets cannot be read or receive notes',async()=>{
 const f=await fixture();assert.equal((await f.call({...f.user,dev:'other'},f.note())).status,404);assert.equal((await f.call(f.user,null,'AION-2')).status,404);assert.equal((await f.call(f.admin,f.note('Secret','OTHER-1'))).status,400);assert.equal(f.mails.length,0);
});
test('internal ticket notes are separate, validate text and escape email HTML',async()=>{
 const f=await fixture();assert.equal((await f.call(f.user,f.note('','INT-1'))).status,400);assert.equal((await f.call(f.user,f.note('a'.repeat(5001)))).status,400);const r=await f.call(f.user,f.note('<script>secret</script>','INT-1'));assert.equal(r.status,201);assert.match(f.mails[0].html,/&lt;script&gt;/);assert.equal(await f.env.STORE.get('it:INT-1'),null);
});
test('retrying an identical submission does not duplicate notes or send more emails',async()=>{
 const f=await fixture(),body=f.note();await f.call(f.user,body);assert.equal((await f.call(f.user,body)).status,200);assert.equal((await f.call()).data.notes.length,1);assert.equal(f.mails.length,1);assert.equal((await f.call(f.other,body)).status,409);
});
test('email failures preserve saved notes and explicitly report delivery failure',async()=>{
 const f=await fixture();f.deps.sendMail=async()=>{throw Error('Mail offline');};const r=await f.call(f.user,f.note());assert.equal(r.status,201);assert.equal(r.data.note.notification,'failed');assert.equal((await f.call()).data.notes.length,1);
});
test('users select Ellen, Youssef or Karim; arbitrary recipients and empty selections are rejected',async()=>{
 const f=await fixture();f.env.MAIL_DOMAIN='aione.biz';f.env.INTERNAL_NOTE_RECIPIENTS=[{name:'Ellen',email:'ellen@aione.biz'},{name:'Youssef',email:'youssef@aione.biz'},{name:'Karim',email:'karim@aione.biz'}];
 const list=await f.call();assert.ok(list.data.recipients.some(r=>r.name==='Karim'));
 const result=await f.call(f.user,{...f.note(),recipients:['ellen@aione.biz','karim@aione.biz']});assert.equal(result.status,201);assert.deepEqual(f.mails[0].to,['ellen@aione.biz','karim@aione.biz']);assert.deepEqual(result.data.note.recipients.map(r=>r.name),['Ellen','Karim']);
 assert.equal((await f.call(f.user,{...f.note(),recipients:[]})).status,400);
 assert.equal((await f.call(f.user,{...f.note(),recipients:['outsider@aione.biz']})).status,400);
 assert.equal((await f.call(f.user,{...f.note(),recipients:['attacker@example.com']})).status,400);
 assert.equal(f.mails.length,1);assert.equal(await f.env.STORE.get('u:karim@aione.biz'),null);
});
test('composer subject and optional ticket link are honored without trusting submitted HTML',async()=>{
 const f=await fixture();const result=await f.call(f.user,{...f.note('<b>Private</b>'),subject:'Review this blocker',includeDetails:false});assert.equal(result.status,201);assert.equal(f.mails[0].subject,'Review this blocker');assert.match(f.mails[0].html,/&lt;b&gt;/);assert.ok(!f.mails[0].html.includes('href='));assert.equal((await f.call(f.user,{...f.note(),subject:'Injected\r\nHeader'})).status,400);assert.equal((await f.call(f.user,{...f.note(),includeDetails:'false'})).status,400);
});
test('authenticated handler checks Jira scope and never writes a Jira comment',async t=>{
 const {default:handler,makeToken}=await import('../proxy/src/handler.js');const f=await fixture();await saveUser(f.env.STORE,{...f.user,v:1});
 const env={...f.env,SESSION_SECRET:'notes-test',JIRA_SITE:'https://jira.test',JIRA_EMAIL:'test@aione.biz',JIRA_API_TOKEN:'test',MAIL_DOMAIN:'aione.biz',MAILER:async()=>{}};
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const calls=[];
 globalThis.fetch=async(url,options={})=>{calls.push({url:String(url),method:options.method});return Response.json({key:'AION-1',fields:{summary:'Task',project:{key:'AION'},labels:['ai1_builder']}});};
 const {token}=await makeToken(env,f.user.email,Date.now(),1);
 const call=authorization=>handler.fetch(new Request('https://proxy.test/ticket-notes',{method:'POST',headers:{...(authorization?{Authorization:authorization}:{})},body:JSON.stringify(f.note())}),env);
 assert.equal((await call()).status,401);assert.equal(calls.length,0);
 assert.equal((await call('Bearer '+token)).status,201);assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.ok(!calls[0].url.includes('/comment'));
 globalThis.fetch=async()=>Response.json({key:'AION-1',fields:{summary:'Task',project:{key:'AION'},labels:['ai1_other']}});
 assert.equal((await call('Bearer '+token)).status,404);
});
test('notes go between everyone in the dashboard, and the people a note was sent to can read it',async()=>{
 const f=await fixture();const dev2={email:'dev2@aione.biz',name:'Second Developer',role:'user',dev:'builder'};await saveUser(f.env.STORE,f.other);await saveUser(f.env.STORE,dev2);
 const list=(await f.call()).data.recipients;assert.deepEqual(list.map(r=>r.email).sort(),['admin@aione.biz','dev2@aione.biz','other@aione.biz']); // everyone but yourself
 const sent=await f.call(f.user,{...f.note('For you only'),recipients:['dev2@aione.biz']});assert.equal(sent.status,201);assert.deepEqual(f.mails.at(-1).to,['dev2@aione.biz']);
 assert.equal((await f.call(dev2)).data.notes.length,1); // the recipient sees it
 assert.equal((await f.call(f.other)).data.notes.length,0); // someone it wasn't sent to doesn't
});
