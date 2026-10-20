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
