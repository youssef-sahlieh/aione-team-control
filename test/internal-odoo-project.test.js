// Internal tickets go to the "Internal Tickets" Odoo project by default, on synthetic projects in the in-memory database.
// Nothing here reaches Odoo: the project list is seeded, and no request leaves the test.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{makeToken} from '../proxy/src/handler.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';
import {odooProjectsKey,internalOdooProject,INTERNAL_ODOO_PROJECT} from '../proxy/src/ticket-metadata.js';

const admin={email:'admin@example.invalid',name:'Manager',role:'admin',dev:'builder',v:1};

async function setup(projects){
  const env={SESSION_SECRET:'synthetic-secret',JIRA_PROJECT:'AION',JIRA_SITE:'https://jira.invalid',STORE:memoryStore(),TIME_SYNC_SECRET:'s'.repeat(32),
    MAIL_DOMAIN:'example.invalid',ODOO_URL:'https://odoo.invalid',ODOO_DB:'synthetic',ODOO_LOGIN:'synthetic',ODOO_API_KEY:'synthetic'};
  await saveUser(env.STORE,admin);
  const token=(await makeToken(env,admin.email,Date.now(),1)).token;
  await env.STORE.set(odooProjectsKey(env),JSON.stringify({syncedAt:Date.now(),projects}));
  const call=async(path,method='GET',body)=>{const r=await worker.fetch(new Request('https://proxy.invalid'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json().catch(()=>null)};};
  return {env,call};
}

const internal={id:371,name:'Internal Tickets',active:true,clientId:700,clientName:'Internal',label:'Internal / Internal Tickets'};
const other={id:12,name:'Support',active:true,clientId:900,clientName:'Acme',label:'Acme → Support'};

test('the default internal project is the active "Internal Tickets" under the "Internal" customer', async () => {
  const {env} = await setup([other, {...internal, id:50, active:false}, {...internal, id:51, clientId:null}, internal]);
  assert.equal((await internalOdooProject(env)).id, 371);
  const none = await setup([other]);
  assert.equal(await internalOdooProject(none.env), null);
  assert.equal(INTERNAL_ODOO_PROJECT, 'Internal Tickets');
});

test('an internal ticket with no project chosen lands on the Internal Tickets project', async () => {
  const {call} = await setup([other, internal]);
  const r = await call('/internal', 'POST', { summary: 'Default project check', devs: ['builder'], metadata: { billing: 'not_billable' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const m = (await call('/ticket-metadata?key=' + r.data.ticket.key)).data.metadata;
  assert.equal(m.odooProjectId, 371);
});

test('an internal ticket keeps the project chosen on the form', async () => {
  const {call} = await setup([other, internal]);
  const r = await call('/internal', 'POST', { summary: 'Chosen project', devs: ['builder'], metadata: { odooProjectId: 12 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await call('/ticket-metadata?key=' + r.data.ticket.key)).data.metadata.odooProjectId, 12);
});
