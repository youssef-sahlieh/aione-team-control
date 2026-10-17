import test from 'node:test';
import assert from 'node:assert/strict';
import {compatibleProxy,waitForProxy} from '../scripts/wait-for-proxy.js';
import handler from '../proxy/src/handler.js';

test('health is public, uncached and exposes only the supported API contract',async()=>{
 const response=await handler.fetch(new Request('https://proxy.test/health'),{SESSION_SECRET:'private',JIRA_API_TOKEN:'private',TEAM_CONFIG:'private'});
 assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
 assert.deepEqual(await response.json(),{ok:true,apiVersion:1,capabilities:['date-requests-v1','ticket-notes-v1','odoo-helpdesk-v1','ticket-business-v1','db-report-v1','db-report-company-v1'],build:''});
});
test('old or incomplete backends cannot release the dashboard',()=>{
 for(const data of [null,{}, {ok:true}, {ok:true,apiVersion:1,capabilities:['date-requests-v1']}, {ok:true,apiVersion:2,capabilities:['date-requests-v1','ticket-notes-v1','ticket-business-v1']}])assert.equal(compatibleProxy(data),false);
});
test('wait retries old deployments and network failures, then accepts a compatible deployment',async()=>{
 let clock=0,calls=0;
 await waitForProxy({timeoutMs:50,intervalMs:10,now:()=>clock,sleep:async ms=>{clock+=ms;},log:()=>{},fetchImpl:async()=>{calls++;if(calls===1)throw Error('Offline');return calls===2?new Response('Not found',{status:404}):Response.json({ok:true,apiVersion:1,capabilities:['date-requests-v1','ticket-notes-v1','ticket-business-v1']});}});
 assert.equal(calls,3);
});
test('wait fails within its deadline and identifies Vercel Git configuration as the next step',async()=>{
 let clock=0;
 await assert.rejects(waitForProxy({timeoutMs:20,intervalMs:10,now:()=>clock,sleep:async ms=>{clock+=ms;},log:()=>{},fetchImpl:async()=>Response.json({ok:true})}),/Vercel Git deployment/);
 assert.equal(clock,20);
});
