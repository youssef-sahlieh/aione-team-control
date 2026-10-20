import test from 'node:test';
import assert from 'node:assert/strict';
import {inboxRoutes, addToInbox, notifyMentions, jiraMentionEmails} from '../proxy/src/inbox.js';
import {internalRoutes} from '../proxy/src/internal.js';
import {ticketNoteRoutes} from '../proxy/src/ticket-notes.js';
import {memoryStore, saveUser} from '../proxy/src/users.js';

async function fixture() {
  const dev={email:'dev@aione.biz',name:'Rami Dev',role:'user',dev:'rami'}, other={email:'other@aione.biz',name:'Razan Other',role:'user',dev:'razan'}, admin={email:'admin@aione.biz',name:'Admin',role:'admin'};
  const env={STORE:memoryStore(),JIRA_PROJECT:'AION',APP_URL:'https://app.test',MAIL_DOMAIN:'aione.biz',TEAM_CONFIG:JSON.stringify({people:{rami:{id:'acc-rami',name:'Rami Dev'}}})};
  for (const u of [dev,other,admin]) await saveUser(env.STORE,u);
  const mails=[], sendMail=async(from,body)=>{mails.push({from,...body});return Response.json({ok:true});};
  const inbox=async me=>{const url=new URL('https://proxy.test/inbox');return (await inboxRoutes(new Request(url),env,url,me)).json();};
  return {dev,other,admin,env,mails,sendMail,inbox};
}

test('first look starts now; items arrive newest first, never for the person who caused them',async()=>{
  const f=await fixture();
  const first=await f.inbox(f.dev);assert.deepEqual(first.items,[]);assert.ok(first.seenAt);
  await addToInbox(f.env.STORE,['DEV@aione.biz','admin@aione.biz'],{type:'note',key:'AION-1',title:'T',by:'Admin',text:'one'},'admin@aione.biz');
  await addToInbox(f.env.STORE,['dev@aione.biz'],{type:'mention',key:'AION-2',title:'T',by:'Admin',text:'two'},'admin@aione.biz');
  assert.deepEqual((await f.inbox(f.dev)).items.map(x=>x.text),['two','one']);
  assert.deepEqual((await f.inbox(f.admin)).items,[]);
});

test('an @mention on an internal comment notifies and emails anyone in the dashboard, not outsiders',async()=>{
  const f=await fixture();
  const create=new URL('https://proxy.test/internal');
  const made=await (await internalRoutes(new Request(create,{method:'POST',body:JSON.stringify({summary:'Fix login',devs:['rami']})}),f.env,create,f.admin,{sendMail:f.sendMail})).json();
  const key=made.ticket.key, url=new URL('https://proxy.test/internal/'+key+'/comment');
  const res=await internalRoutes(new Request(url,{method:'POST',body:JSON.stringify({text:'@Razan Other can you check?',mentions:['other@aione.biz','outsider@example.com']})}),f.env,url,f.dev,{sendMail:f.sendMail});
  const body=await res.json();
  assert.equal(res.status,201);assert.deepEqual(body.notified,['Razan Other']);
  assert.equal(f.mails.length,1);assert.deepEqual(f.mails[0].to,['other@aione.biz']);assert.match(f.mails[0].subject,/mentioned you/);
  const items=(await f.inbox(f.other)).items;assert.equal(items.length,1);assert.equal(items[0].type,'mention');assert.equal(items[0].key,key);assert.equal(items[0].by,'Rami Dev');
});

test('internal notes reach any developer selected, in their notifications',async()=>{
  const f=await fixture();
  const url=new URL('https://proxy.test/ticket-notes');
  const res=await ticketNoteRoutes(new Request(url,{method:'POST',body:JSON.stringify({key:'AION-1',id:crypto.randomUUID(),text:'Please look',recipients:['other@aione.biz']})}),f.env,url,f.dev,{readTicket:async()=>({title:'Task',devs:['rami']}),sendMail:f.sendMail});
  assert.equal(res.status,201);
  const items=(await f.inbox(f.other)).items;assert.equal(items.length,1);assert.equal(items[0].type,'note');assert.equal(items[0].title,'Task');
});

test('Jira account mentions map to dashboard people through the team settings',async()=>{
  const f=await fixture();
  assert.deepEqual(await jiraMentionEmails(f.env,'hi [~accountid:acc-rami] and [~accountid:unknown]'),['dev@aione.biz']);
  assert.deepEqual(await notifyMentions(f.env,f.dev,{emails:['dev@aione.biz'],key:'AION-1',title:'T',text:'self'}),[]);
});

test('notifications stay unread until each one is read; new tickets are remembered as read',async()=>{
  const f=await fixture();await f.inbox(f.dev);
  await addToInbox(f.env.STORE,['dev@aione.biz'],{type:'note',key:'AION-1',title:'T',by:'Admin',text:'one'},'admin@aione.biz');
  await addToInbox(f.env.STORE,['dev@aione.biz'],{type:'mention',key:'AION-2',title:'T',by:'Admin',text:'two'},'admin@aione.biz');
  const read=async body=>{const url=new URL('https://proxy.test/inbox/read');return (await inboxRoutes(new Request(url,{method:'POST',body:JSON.stringify(body)}),f.env,url,f.dev)).json();};
  const seen=new URL('https://proxy.test/inbox/seen');await inboxRoutes(new Request(seen,{method:'POST'}),f.env,seen,f.dev);
  let r=await f.inbox(f.dev);assert.deepEqual(r.items.map(x=>x.read),[false,false]);
  r=await read({id:r.items[0].id});assert.deepEqual(r.items.map(x=>x.read),[true,false]);
  r=await read({tickets:['AION-9','bad key']});assert.deepEqual(r.readTickets,['AION-9']);
  r=await read({all:true});assert.ok(r.items.every(x=>x.read));
});

test('internal comments can be edited by their writer or an administrator only',async()=>{
  const f=await fixture();
  const create=new URL('https://proxy.test/internal');
  const {ticket}=await (await internalRoutes(new Request(create,{method:'POST',body:JSON.stringify({summary:'Fix login',devs:['rami','razan']})}),f.env,create,f.admin,{})).json();
  const post=new URL('https://proxy.test/internal/'+ticket.key+'/comment');
  const added=await (await internalRoutes(new Request(post,{method:'POST',body:JSON.stringify({text:'first'})}),f.env,post,f.dev,{})).json();
  const created=added.ticket.comments[0].created, url=new URL('https://proxy.test/internal/'+ticket.key+'/comment/0');
  const edit=(me,body)=>internalRoutes(new Request(url,{method:'PUT',body:JSON.stringify(body)}),f.env,url,me,{});
  assert.equal((await edit(f.other,{text:'hijack',created})).status,403);
  assert.equal((await edit(f.dev,{text:'stale',created:'2000-01-01T00:00:00.000Z'})).status,409);
  const mine=await (await edit(f.dev,{text:'fixed',created})).json();assert.equal(mine.ticket.comments[0].body,'fixed');assert.ok(mine.ticket.comments[0].edited);
  assert.equal((await edit(f.admin,{text:'by admin',created})).status,200);
  assert.equal(mine.ticket.comments.length,1);
});
