// GitHub issues become internal tickets. Everything runs on the in-memory database; GitHub is never reached (the
// import test replaces fetch for its own requests only). Webhook deliveries are signed here with a test secret.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{makeToken} from '../proxy/src/handler.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';

const SECRET='s'.repeat(40);
const REPO='KAD-org/flutter_pos';
const admin={email:'admin@example.invalid',name:'Manager',role:'admin',dev:'builder',v:1,id:'acct-admin'};
const bashar={email:'bashar.k@example.invalid',name:'Bashar K',role:'user',dev:'bashar.k',v:1,id:'acct-bashar'};
const bannoura={email:'bashar.b@example.invalid',name:'Bashar Bannoura',role:'user',dev:'bashar',v:1,id:'acct-bannoura'};

async function setup({users=[admin,bashar,bannoura],secret=SECRET}={}){
  const env={SESSION_SECRET:'synthetic-secret',JIRA_PROJECT:'AION',JIRA_SITE:'https://jira.invalid',STORE:memoryStore(),MAIL_DOMAIN:'example.invalid',
    GITHUB_TOKEN:'synthetic-token',GITHUB_WEBHOOK_SECRET:secret,GITHUB_ISSUE_SOURCES:{[REPO]:{developer:'bashar.k'}}};
  for(const u of users)await saveUser(env.STORE,u);
  const session=async u=>(await makeToken(env,u.email,Date.now(),1)).token;
  const adminToken=await session(admin);
  const call=async(path,{method='GET',body,token=adminToken}={})=>{const r=await worker.fetch(new Request('https://proxy.invalid'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json().catch(()=>null)};};
  return {env,call,session};
}

async function sign(text,secret=SECRET){
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const mac=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(text)));
  return 'sha256='+[...mac].map(b=>b.toString(16).padStart(2,'0')).join('');
}

// A GitHub "issues" event body as GitHub sends it (the fields the proxy reads, plus a few it ignores).
const issue=(o)=>({id:o.id,number:o.number,title:o.title,body:o.body===undefined?'':o.body,html_url:'https://github.com/'+REPO+'/issues/'+o.number,
  user:{login:o.author||'reporter'},labels:(o.labels||[]).map(name=>({name})),created_at:'2026-11-16T09:00:00Z',state:'open',...(o.pr?{pull_request:{url:'x'}}:{})});
const event=(action,iss,repo=REPO)=>({action,issue:iss,repository:{full_name:repo,id:99}});

async function deliver(env,payload,{event:name='issues',signature,secret=SECRET}={}){
  const text=typeof payload==='string'?payload:JSON.stringify(payload);
  const headers={'X-GitHub-Event':name,'Content-Type':'application/json','X-Hub-Signature-256':signature===undefined?await sign(text,secret):signature};
  const r=await worker.fetch(new Request('https://proxy.invalid/github/webhook',{method:'POST',headers,body:text}),env);
  return {status:r.status,data:await r.json().catch(()=>null)};
}

const internalTickets=async(call,token)=>(await call('/internal',token?{token}:{})).data.tickets;

test('a new issue creates exactly one internal ticket with the issue copied as written', async()=>{
  const {env,call}=await setup();
  const body='The POS application crashes when processing a card payment.\n\n- step 1\n- step 2 “quoted” ✓\n\n```\nstack trace\n```';
  const r=await deliver(env,event('opened',issue({id:5001,number:123,title:'POS application crashes during payment',body,labels:['bug','payments'],author:'alice'})));
  assert.equal(r.status,201,JSON.stringify(r.data));
  assert.equal(r.data.status,'created');
  const tickets=await internalTickets(call);
  assert.equal(tickets.length,1);
  const t=tickets[0];
  assert.equal(t.key,r.data.key);
  assert.equal(t.summary,'POS application crashes during payment');
  assert.equal(t.description,body,'the description is kept exactly');
  assert.equal(t.source,'github');
  assert.equal(t.external.repo,REPO);
  assert.equal(t.external.number,123);
  assert.equal(t.external.issueId,5001);
  assert.equal(t.external.url,'https://github.com/'+REPO+'/issues/123');
  assert.equal(t.external.author,'alice');
  assert.deepEqual(t.external.labels,['bug','payments']);
  assert.equal(t.status,'Open');
});

test('the ticket goes to Bashar K by his account, and his account sees it', async()=>{
  const {env,call,session}=await setup();
  const r=await deliver(env,event('opened',issue({id:5002,number:124,title:'Login fails'})));
  assert.equal(r.status,201);
  const t=(await internalTickets(call)).find(x=>x.key===r.data.key);
  assert.deepEqual(t.devs,['bashar.k']);
  assert.equal(t.external.developer,'bashar.k');
  assert.equal(t.external.assignedAccountId,'acct-bashar');
  assert.equal(t.external.assignmentError,null);
  const basharSees=(await internalTickets(call,await session(bashar))).map(x=>x.key);
  assert.ok(basharSees.includes(r.data.key),'Bashar K sees the ticket');
  const bannouraSees=(await internalTickets(call,await session(bannoura))).map(x=>x.key);
  assert.ok(!bannouraSees.includes(r.data.key),'a person with a similar name does not');
});

test('a repeated delivery of the same issue creates no second ticket', async()=>{
  const {env,call}=await setup();
  const payload=event('opened',issue({id:5003,number:125,title:'Printer offline'}));
  const first=await deliver(env,payload);
  const again=await deliver(env,payload);
  assert.equal(first.status,201);
  assert.equal(again.status,200);
  assert.equal(again.data.status,'duplicate');
  assert.equal(again.data.key,first.data.key);
  assert.equal((await internalTickets(call)).filter(t=>t.external&&t.external.issueId===5003).length,1);
});

test('two simultaneous deliveries for one issue create one ticket', async()=>{
  const {env,call}=await setup();
  const payload=event('opened',issue({id:5004,number:126,title:'Race'}));
  const [a,b]=await Promise.all([deliver(env,payload),deliver(env,payload)]);
  const statuses=[a.data.status,b.data.status].sort();
  assert.ok(statuses[0]==='created'&&['duplicate','in_progress'].includes(statuses[1]),JSON.stringify(statuses));
  assert.equal((await internalTickets(call)).filter(t=>t.external&&t.external.issueId===5004).length,1);
  assert.equal([a.status,b.status].filter(s=>s===201).length,1);
});

test('pull requests never create tickets', async()=>{
  const {env,call}=await setup();
  const asIssueEvent=await deliver(env,event('opened',issue({id:5005,number:127,title:'A pull request',pr:true})));
  assert.equal(asIssueEvent.data.ignored,'pull_request');
  const prEvent=await deliver(env,{action:'opened',number:9,pull_request:{id:1,title:'PR'},repository:{full_name:REPO}},{event:'pull_request'});
  assert.equal(prEvent.data.ignored,'event');
  assert.equal((await internalTickets(call)).filter(t=>t.source==='github').length,0);
});

test('invalid, missing or unchecked signatures are rejected and create nothing', async()=>{
  const {env,call}=await setup();
  const payload=event('opened',issue({id:5006,number:128,title:'Forged'}));
  assert.equal((await deliver(env,payload,{secret:'x'.repeat(40)})).status,401,'signed with the wrong secret');
  assert.equal((await deliver(env,payload,{signature:''})).status,401,'no signature');
  assert.equal((await deliver(env,payload,{signature:'sha1=abc'})).status,401,'wrong scheme');
  const tampered=JSON.stringify(payload), sig=await sign(tampered);
  assert.equal((await deliver(env,tampered.replace('Forged','Changed'),{signature:sig})).status,401,'body changed after signing');
  assert.equal((await internalTickets(call)).filter(t=>t.source==='github').length,0);
  const off=await setup({secret:''});
  assert.equal((await deliver(off.env,payload,{signature:'sha256='+'0'.repeat(64)})).status,503,'no secret configured');
});

test('only opened issues from configured repositories are imported', async()=>{
  const {env,call}=await setup();
  assert.equal((await deliver(env,event('edited',issue({id:5007,number:129,title:'Edited'})))).data.ignored,'action');
  assert.equal((await deliver(env,event('opened',issue({id:5008,number:130,title:'Elsewhere'}),'someone/else'))).data.ignored,'repository');
  assert.equal((await internalTickets(call)).filter(t=>t.source==='github').length,0);
});

test('when Bashar K cannot be found the ticket is still made, with no developer, and only administrators see it', async()=>{
  const {env,call,session}=await setup({users:[admin,bannoura]});
  const r=await deliver(env,event('opened',issue({id:5009,number:131,title:'No Bashar K account'})));
  assert.equal(r.status,201);
  const t=(await internalTickets(call)).find(x=>x.key===r.data.key);
  assert.deepEqual(t.devs,[]);
  assert.match(t.external.assignmentError,/no account has the developer name bashar\.k/);
  assert.equal(t.external.assignedAccountId,null);
  assert.ok(!(await internalTickets(call,await session(bannoura))).some(x=>x.key===r.data.key),'the other Bashar does not get it');
});

test('two accounts with the developer name is treated as unresolved, not guessed', async()=>{
  const twin={email:'bashar.k2@example.invalid',name:'Bashar K',role:'user',dev:'bashar.k',v:1,id:'acct-twin'};
  const {env,call}=await setup({users:[admin,bashar,twin]});
  const r=await deliver(env,event('opened',issue({id:5010,number:132,title:'Two accounts'})));
  const t=(await internalTickets(call)).find(x=>x.key===r.data.key);
  assert.deepEqual(t.devs,[]);
  assert.match(t.external.assignmentError,/2 accounts/);
});

test('administrators can still change a GitHub ticket, and the description stays as GitHub had it', async()=>{
  const {env,call}=await setup();
  const r=await deliver(env,event('opened',issue({id:5011,number:133,title:'Editable',body:'original text'})));
  const put=await call('/internal/'+r.data.key,{method:'PUT',body:{status:'In Development',priority:'High'}});
  assert.equal(put.status,200,JSON.stringify(put.data));
  assert.equal(put.data.ticket.status,'In Development');
  assert.equal(put.data.ticket.priority,'High');
  assert.equal(put.data.ticket.description,'original text');
  assert.equal(put.data.ticket.source,'github');
});

test('manually created internal tickets are unchanged by the GitHub integration', async()=>{
  const {env,call}=await setup();
  const r=await call('/internal',{method:'POST',body:{summary:'Made by hand',description:'typed here',devs:['bashar.k']}});
  assert.equal(r.status,201,JSON.stringify(r.data));
  assert.equal(r.data.ticket.source,undefined);
  assert.equal(r.data.ticket.external,undefined);
  assert.deepEqual(r.data.ticket.devs,['bashar.k']);
});

test('the import brings in existing issues once, skips pull requests, and agrees with the webhook', async()=>{
  const {env,call}=await setup();
  const already=await deliver(env,event('opened',issue({id:6001,number:1,title:'Already here'})));
  const page=[
    issue({id:6001,number:1,title:'Already here'}),
    issue({id:6002,number:2,title:'Older, closed',body:'x'}),
    issue({id:6003,number:3,title:'A pull request in the list',pr:true})
  ];
  const realFetch=globalThis.fetch;
  const seen=[];
  globalThis.fetch=async(url,init)=>{ seen.push(String(url)); return new Response(JSON.stringify(page),{status:200,headers:{'Content-Type':'application/json'}}); };
  try{
    const first=await call('/github/issues/import',{method:'POST',body:{}});
    assert.equal(first.status,200,JSON.stringify(first.data));
    assert.equal(first.data.repo,REPO);
    assert.equal(first.data.created,1);
    assert.equal(first.data.duplicate,1);
    assert.equal(first.data.pullRequests,1);
    assert.equal(first.data.done,true);
    assert.match(seen[0],/\/repos\/KAD-org\/flutter_pos\/issues\?state=all/);
    const second=await call('/github/issues/import',{method:'POST',body:{}});
    assert.equal(second.data.created,0);
    assert.equal(second.data.duplicate,2);
  } finally { globalThis.fetch=realFetch; }
  const github=(await internalTickets(call)).filter(t=>t.source==='github');
  assert.equal(github.length,2,'the first webhook ticket and the imported one, no copies');
  assert.equal(github.find(t=>t.key===already.data.key).external.number,1);
});

test('only administrators can start an import', async()=>{
  const {env,call,session}=await setup();
  const r=await call('/github/issues/import',{method:'POST',body:{},token:await session(bashar)});
  assert.equal(r.status,403);
});
