import test from 'node:test';
import assert from 'node:assert/strict';
import {ticketInboxRoutes, ticketNoteRoutes} from '../proxy/src/ticket-notes.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';

async function fixture() {
  const builder={email:'dev@aione.biz',name:'Developer',role:'user',dev:'builder'};
  const teammate={email:'other@aione.biz',name:'Teammate',role:'user',dev:'builder'};
  const outsider={email:'outsider@aione.biz',name:'Outsider',role:'user',dev:'other'};
  const admin={email:'admin@aione.biz',name:'Admin',role:'admin'};
  const env={STORE:memoryStore(),JIRA_PROJECT:'AION'};
  for (const u of [builder,teammate,outsider,admin]) await saveUser(env.STORE,u);
  const deps={readTicket:async key=>['AION-1','INT-1'].includes(key)?{title:'Ticket',devs:['builder']}:null};
  const call=async(me=builder,body=null,key='AION-1')=>{
    const url=new URL('https://proxy.test/ticket-notes?key='+key);
    const res=await ticketNoteRoutes(new Request(url,{method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})}),env,url,me,deps);
    return {status:res.status,data:await res.json()};
  };
  const inbox=async(me,body=null)=>{
    const url=new URL('https://proxy.test/ticket-notes/inbox');
    const res=await ticketInboxRoutes(new Request(url,{method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})}),env,me);
    return {status:res.status,data:await res.json()};
  };
  const note=(text='Please review this blocker',key='AION-1',mentions=[])=>({id:crypto.randomUUID(),key,text,mentions});
  return {builder,teammate,outsider,admin,env,call,inbox,note};
}

test('everyone who can open a ticket reads its notes; people outside the ticket get 404',async()=>{
  const f=await fixture();
  const result=await f.call(f.builder,f.note());
  assert.equal(result.status,201);
  assert.equal(result.data.note.author.email,f.builder.email);
  assert.equal((await f.call()).data.notes.length,1);
  assert.equal((await f.call(f.teammate)).data.notes.length,1);
  assert.equal((await f.call(f.admin)).data.notes.length,1);
  assert.equal((await f.call(f.outsider)).status,404);
});

test('unknown tickets and invalid notes are rejected',async()=>{
  const f=await fixture();
  assert.equal((await f.call(f.builder,f.note('','AION-1'))).status,400);
  assert.equal((await f.call(f.builder,f.note('a'.repeat(5001)))).status,400);
  assert.equal((await f.call(f.builder,{...f.note(),id:'not-a-uuid'})).status,400);
  assert.equal((await f.call(f.builder,f.note('x','OTHER-1'))).status,400);
  assert.equal((await f.call(f.builder,f.note('x','AION-2'))).status,404);
  assert.equal((await f.call()).data.notes.length,0);
});

test('mentions must be people in the dashboard, exclude yourself, and only notify the people mentioned',async()=>{
  const f=await fixture();
  const list=(await f.call()).data.people;
  assert.deepEqual(list.map(p=>p.email).sort(),['admin@aione.biz','other@aione.biz','outsider@aione.biz']);
  assert.equal((await f.call(f.builder,{...f.note('Ping @Ghost'),mentions:['ghost@aione.biz']})).status,400);
  assert.equal((await f.call(f.builder,{...f.note('Ping @Developer'),mentions:[f.builder.email]})).status,400);
  const sent=await f.call(f.builder,f.note('Ping @Teammate',"AION-1",[f.teammate.email]));
  assert.equal(sent.status,201);
  assert.deepEqual(sent.data.note.mentions.map(m=>m.email),[f.teammate.email]);
  const teammateInbox=(await f.inbox(f.teammate)).data;
  assert.equal(teammateInbox.unread,1);
  assert.equal(teammateInbox.items[0].key,'AION-1');
  assert.equal(teammateInbox.items[0].by,'Developer');
  assert.equal((await f.inbox(f.admin)).data.items.length,0);
});

test('marking mentions read works one at a time or all at once',async()=>{
  const f=await fixture();
  const first=f.note('First @Teammate',"AION-1",[f.teammate.email]), second=f.note('Second @Teammate',"AION-1",[f.teammate.email]);
  await f.call(f.builder,first);
  await f.call(f.builder,second);
  assert.equal((await f.inbox(f.teammate)).data.unread,2);
  assert.equal((await f.inbox(f.teammate,{ids:[first.id]})).data.unread,1);
  const items=(await f.inbox(f.teammate)).data.items;
  assert.equal(items.find(i=>i.id===first.id).readAt!==null,true);
  assert.equal(items.find(i=>i.id===second.id).readAt,null);
  assert.equal((await f.inbox(f.teammate,{})).data.unread,0);
  assert.equal((await f.inbox(f.teammate,{ids:'nope'})).status,400);
});

test('a retried submission does not duplicate notes or notifications, and an id used by someone else is refused',async()=>{
  const f=await fixture(),body=f.note('Ping @Teammate','AION-1',[f.teammate.email]);
  await f.call(f.builder,body);
  assert.equal((await f.call(f.builder,body)).status,200);
  assert.equal((await f.call()).data.notes.length,1);
  assert.equal((await f.inbox(f.teammate)).data.items.length,1);
  assert.equal((await f.call(f.teammate,{...body,mentions:[]})).status,409);
});

test('authenticated handler checks Jira scope and never writes a Jira comment',async t=>{
  const {default:handler,makeToken}=await import('../proxy/src/handler.js');
  const f=await fixture();
  await saveUser(f.env.STORE,{...f.builder,v:1});
  const env={...f.env,SESSION_SECRET:'notes-test',JIRA_SITE:'https://jira.test',JIRA_EMAIL:'test@aione.biz',JIRA_API_TOKEN:'test'};
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  const calls=[];
  globalThis.fetch=async(url,options={})=>{calls.push({url:String(url),method:options.method});return Response.json({key:'AION-1',fields:{summary:'Task',project:{key:'AION'},labels:['ai1_builder']}});};
  const {token}=await makeToken(env,f.builder.email,Date.now(),1);
  const call=authorization=>handler.fetch(new Request('https://proxy.test/ticket-notes',{method:'POST',headers:{...(authorization?{Authorization:authorization}:{})},body:JSON.stringify(f.note())}),env);
  assert.equal((await call()).status,401);
  assert.equal(calls.length,0);
  assert.equal((await call('Bearer '+token)).status,201);
  assert.equal(calls.length,1);
  assert.equal(calls[0].method,'GET');
  assert.ok(!calls[0].url.includes('/comment'));
  globalThis.fetch=async()=>Response.json({key:'AION-1',fields:{summary:'Task',project:{key:'AION'},labels:['ai1_other']}});
  assert.equal((await call('Bearer '+token)).status,404);
});
