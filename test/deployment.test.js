import test from 'node:test';
import assert from 'node:assert/strict';
import {compatibleProxy,waitForProxy} from '../scripts/wait-for-proxy.js';
import handler from '../proxy/src/handler.js';

test('health is public, uncached and exposes only the supported API contract',async()=>{
 const response=await handler.fetch(new Request('https://proxy.test/health'),{SESSION_SECRET:'private',JIRA_API_TOKEN:'private',TEAM_CONFIG:'private'});
 assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
 assert.deepEqual(await response.json(),{ok:true,apiVersion:1,capabilities:['date-requests-v1','ticket-notes-v1','odoo-helpdesk-v1','ticket-business-v1','reports-all-v1','reports-saved-v1','db-report-v1','db-report-company-v1','epic-map-v1'],build:''});
});
test('old or incomplete backends cannot release the dashboard',()=>{
 for(const data of [{ok:true,apiVersion:1,capabilities:['date-requests-v1','ticket-notes-v1','ticket-business-v1']},null,{}, {ok:true}, {ok:true,apiVersion:1,capabilities:['date-requests-v1']}, {ok:true,apiVersion:2,capabilities:['date-requests-v1','ticket-notes-v1','ticket-business-v1']}])assert.equal(compatibleProxy(data),false);
});
test('wait retries old deployments and network failures, then accepts a compatible deployment',async()=>{
 let clock=0,calls=0;
 await waitForProxy({timeoutMs:50,intervalMs:10,now:()=>clock,sleep:async ms=>{clock+=ms;},log:()=>{},fetchImpl:async()=>{calls++;if(calls===1)throw Error('Offline');return calls===2?new Response('Not found',{status:404}):Response.json({ok:true,apiVersion:1,capabilities:['date-requests-v1','ticket-notes-v1','ticket-business-v1','reports-all-v1','reports-saved-v1']});}});
 assert.equal(calls,3);
});
test('wait fails within its deadline and identifies Vercel Git configuration as the next step',async()=>{
 let clock=0;
 await assert.rejects(waitForProxy({timeoutMs:20,intervalMs:10,now:()=>clock,sleep:async ms=>{clock+=ms;},log:()=>{},fetchImpl:async()=>Response.json({ok:true})}),/Vercel Git deployment/);
 assert.equal(clock,20);
});
test('API key health: rejected, expired, expiring soon and working keys read plainly',async()=>{
 const {keyStatus}=await import('../proxy/src/integrations.js');const now=Date.parse('2026-10-18T00:00:00Z');
 assert.equal(keyStatus({works:false,problem:'Jira rejected the API token',now}).status,'error');
 assert.equal(keyStatus({works:true,expires:'2026-10-01',now}).status,'error');
 const soon=keyStatus({works:true,expires:'2026-10-25',now});assert.equal(soon.status,'warning');assert.equal(soon.days,7);
 const github=keyStatus({works:true,expires:'2027-01-01 10:00:00 UTC',now});assert.equal(github.status,'ok');assert.equal(github.expiresAt,'2027-01-01T10:00:00.000Z');
 assert.match(keyStatus({works:true,now,setting:'JIRA_TOKEN_EXPIRES'}).message,/JIRA_TOKEN_EXPIRES/);
});
test('the GitHub key check names repositories the token cannot read',async()=>{
 const {integrationRoutes}=await import('../proxy/src/integrations.js');const real=globalThis.fetch;
 globalThis.fetch=async url=>{const u=String(url);if(u.includes('/rest/api/3/myself'))return Response.json({});if(u.endsWith('/rate_limit'))return Response.json({},{headers:{'github-authentication-token-expiration':'2099-01-01 00:00:00 UTC'}});if(u.includes('/repos/KAD-org/open/pulls'))return Response.json([]);return new Response('{}',{status:404});};
 try{
  const env={JIRA_SITE:'https://jira.test',JIRA_EMAIL:'a',JIRA_API_TOKEN:'b',GITHUB_TOKEN:'t',GITHUB_REPOS:'KAD-org/open,KAD-org/hidden'};
  const gh=(await (await integrationRoutes(new Request('https://p/integrations'),env,{role:'admin'})).json()).keys.find(k=>k.id==='github');
  assert.equal(gh.status,'error');assert.match(gh.message,/KAD-org\/hidden/);assert.doesNotMatch(gh.message,/KAD-org\/open/);
 }finally{globalThis.fetch=real;}
});



test('Groq integration health is administrator-only, checks model access and never exposes its key',async()=>{
 const {integrationRoutes}=await import('../proxy/src/integrations.js');let requests=0;
 const env={AI_VENDOR:'groq',GROQ_API_KEY:'synthetic-groq-secret',JIRA_SITE:'https://jira.invalid',JIRA_EMAIL:'bot',JIRA_API_TOKEN:'synthetic-jira'};
 globalThis.fetch=async(url,init)=>{requests++;if(String(url).includes('api.groq.com')){assert.equal(url,'https://api.groq.com/openai/v1/models');assert.equal(init.headers.Authorization,'Bearer synthetic-groq-secret');return Response.json({data:[{id:'openai/gpt-oss-120b'}]});}return Response.json({});};
 assert.equal((await integrationRoutes(new Request('https://test/integrations'),env,{role:'user'})).status,403);assert.equal(requests,0);
 const r=await integrationRoutes(new Request('https://test/integrations'),env,{role:'admin'}),data=await r.json();assert.equal(data.keys.find(k=>k.id==='groq').status,'ok');assert.doesNotMatch(JSON.stringify(data),/synthetic/);
 env.AI_MODEL='unavailable';const missing=await (await integrationRoutes(new Request('https://test/integrations'),env,{role:'admin'})).json();assert.equal(missing.keys.find(k=>k.id==='groq').status,'error');
});
