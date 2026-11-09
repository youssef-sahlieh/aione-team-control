import {test} from 'node:test';import assert from 'node:assert/strict';
import {memoryStore} from '../proxy/src/users.js';
import {analyticsSnapshot,analyticsRoutes,buildSnapshot,snapshotKey,windowStart,normalize} from '../proxy/src/analytics.js';
import {metadataKey} from '../proxy/src/ticket-metadata.js';

const admin={role:'admin',email:'boss@example.test'},user={role:'user',email:'dev@example.test',dev:'dana'};
const NOW=new Date('2026-10-25T10:00:00Z');
const jiraIssue=(n,over={})=>({key:'AION-'+n,fields:{summary:'Sample '+n,labels:['ai1_dana'],status:{name:'Open',statusCategory:{key:'new'}},created:'2026-10-10T21:30:00Z',duedate:'2026-10-20',...over}});
async function setup({issues=[jiraIssue(1)],internal=[],timeDown=false}={}){
  const env={STORE:memoryStore(),JIRA_PROJECT:'AION',JIRA_SITE:'https://jira.invalid'};let searches=0,jqls=[];
  const store=env.STORE;
  // Catalog, one ticket's business record (with admin-only fields), and two work entries (one with an email and a description).
  await store.set('business:AION:catalog',JSON.stringify({revision:1,entries:[{id:'c1',name:'Acme',aiName:'Acme Ltd'},{id:'p1',name:'Site',parentId:'c1'}]}));
  await store.set(metadataKey(env,'AION-1'),JSON.stringify({clientId:'c1',subClientId:'p1',billing:'Fixed',agreedHours:10,estimatedHours:8,history:[{secret:true}]}));
  const entry=(id,over)=>({id,ticket:'AION-1',source:'jira',date:'2026-10-12',minutes:90,description:'private note',author:{name:'Dana',email:'dana@example.test'},createdAt:'2026-10-12T10:00:00Z',state:'synced',...over});
  for(const e of [entry('11111111-1111-4111-8111-111111111111',{}),entry('22222222-2222-4222-8222-222222222222',{ticket:'HD-5',source:'odoo',minutes:30})]){await store.set('tw:AION:e:'+e.id,JSON.stringify(e));await store.sadd('tw:AION:m:2026-10',e.id);}
  await store.set('tw:AION:sum:AION-1',JSON.stringify({loggedMinutes:90}));
  if(timeDown)store.smembers=async()=>{throw new Error('down');};
  const deps={readSearch:async body=>{searches++;jqls.push(body.jql);return {issues,isLast:true};},readInternal:async()=>internal,readHistory:async()=>null};
  return {env,deps,searches:()=>searches,jqls};
}

test('the snapshot joins client names, agreed hours and logged time, and uses Jerusalem days',async()=>{
  const s=await setup(),snap=await buildSnapshot(s.env,admin,s.deps,NOW),t=snap.tickets[0];
  assert.equal(t.createdDay,'2026-10-11'); // 21:30 UTC is already the next day in Jerusalem
  assert.equal(t.clientName,'Acme Ltd');assert.equal(t.subClientName,'Site');assert.equal(t.agreedHours,10);assert.equal(t.loggedMinutes,90);
  assert.deepEqual(t.devs,['dana']);assert.equal(t.dueDay,'2026-10-20');
  assert.equal(snap.entries.length,2);assert.deepEqual(snap.entries[0].slice(0,2),['AION-1','2026-10-12']);assert.equal(snap.entries[1][4],2);
  // 'synced' without an Odoo line is not confirmed: the sixth element is the work log's own rule (isSynced).
  assert.equal(snap.entries[0][5],0);
  assert.deepEqual(snap.complete,{jira:true,internal:true,time:true});
});

test('the JQL is bounded to the window instead of capping at the newest tickets',async()=>{
  const s=await setup();await buildSnapshot(s.env,admin,s.deps,NOW);
  assert.equal(windowStart(NOW),'2024-10-01');
  assert.match(s.jqls[0],/statusCategory != Done OR created >= "2024-10-01" OR resolutiondate >= "2024-10-01"/);
});

test('nothing private leaves the proxy: no billing, history, emails or descriptions',async()=>{
  const s=await setup(),text=JSON.stringify(await buildSnapshot(s.env,admin,s.deps,NOW));
  for(const secret of ['Fixed','secret','dana@example.test','boss@example.test','private note','billing','description'])assert.ok(!text.includes(secret),secret+' leaked');
  assert.deepEqual(normalize({key:'AION-1',status:'Open',created:'2026-10-10T10:00:00Z',devs:[]},{agreedHours:5},{entries:[]},0,user).agreedHours,null);
});

test('an unreadable work log makes hours unknown, not zero',async()=>{
  const s=await setup({timeDown:true}),snap=await buildSnapshot(s.env,admin,s.deps,NOW);
  assert.equal(snap.entries,null);assert.equal(snap.tickets[0].loggedMinutes,null);assert.equal(snap.complete.time,false);
  assert.ok(snap.warnings.some(w=>/work log/.test(w)));
});

test('a failed internal read is reported and marks the snapshot incomplete',async()=>{
  const s=await setup();s.deps.readInternal=async()=>{throw new Error('down');};
  const snap=await buildSnapshot(s.env,admin,s.deps,NOW);
  assert.equal(snap.complete.internal,false);assert.equal(snap.tickets.length,1);
});

test('closed tickets with no completion date are counted in a warning, not given a made-up day',async()=>{
  const s=await setup({issues:[jiraIssue(1,{status:{name:'Done',statusCategory:{key:'done'}}})]});
  const snap=await buildSnapshot(s.env,admin,s.deps,NOW);
  assert.equal(snap.tickets[0].completedDay,null);assert.ok(snap.warnings.some(w=>/no verified completion date/.test(w)));
});

test('analytics are administrator-only, cached, refreshed explicitly and method constrained',async()=>{
  const s=await setup();
  await assert.rejects(analyticsSnapshot(s.env,user,s.deps),e=>e.status===403);assert.equal(s.searches(),0);
  const first=await analyticsSnapshot(s.env,admin,s.deps,{now:NOW});assert.equal(first.cached,false);
  const second=await analyticsSnapshot(s.env,admin,s.deps,{now:new Date('2026-10-25T13:00:00Z')});assert.equal(second.cached,true);assert.equal(second.stale,true);assert.equal(s.searches(),1);
  assert.equal((await analyticsSnapshot(s.env,admin,s.deps,{refresh:true})).cached,false);assert.equal(s.searches(),2);
  const r=await analyticsRoutes(new Request('https://p/analytics/snapshot'),s.env,admin,s.deps,'/analytics/snapshot');assert.equal(r.headers.get('Cache-Control'),'no-store');
  await assert.rejects(analyticsRoutes(new Request('https://p/analytics/snapshot',{method:'POST'}),s.env,admin,s.deps,'/analytics/snapshot'),e=>e.status===405);
  assert.notEqual(snapshotKey(s.env),snapshotKey({...s.env,JIRA_PROJECT:'OTHER'}));
});

test('a partial refresh cannot replace a complete snapshot',async()=>{
  const s=await setup();const first=await analyticsSnapshot(s.env,admin,s.deps,{now:NOW});
  s.deps.readSearch=async()=>({issues:[],isLast:false});
  const result=await analyticsSnapshot(s.env,admin,s.deps,{refresh:true});
  assert.equal(result.snapshot.builtAt,first.snapshot.builtAt);assert.match(result.refreshWarning,/incomplete/);
});

test('each entry carries its Odoo state, and an entry listed under two months counts once',async()=>{
  const s=await setup(),store=s.env.STORE;
  const add=async(id,over,months)=>{await store.set('tw:AION:e:'+id,JSON.stringify({id,ticket:'AION-1',source:'jira',date:'2026-10-01',minutes:60,author:{name:'Lee'},createdAt:'2026-10-01T10:00:00Z',...over}));for(const m of months)await store.sadd('tw:AION:m:'+m,id);};
  await add('33333333-3333-4333-8333-333333333333',{state:'synced',lineId:7,revision:2,syncedRevision:2},['2026-09','2026-10']);
  await add('44444444-4444-4444-8444-444444444444',{state:'agreed'},['2026-10']);
  await add('55555555-5555-4555-8555-555555555555',{state:'synced',lineId:8,revision:3,syncedRevision:2},['2026-10']);
  const lee=(await buildSnapshot(s.env,admin,s.deps,NOW)).entries.filter(e=>e[1]==='2026-10-01');
  assert.equal(lee.length,3); // the entry in both month lists is read once
  assert.deepEqual(lee.map(e=>e[5]).sort(),[0,1,2]); // confirmed, held under agreed hours, and edited after its sync (pending)
});
