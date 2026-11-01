import test from 'node:test';
import assert from 'node:assert/strict';
import {compatibleProxy,waitForProxy} from '../scripts/wait-for-proxy.js';
import handler from '../proxy/src/handler.js';

test('health is public, uncached and exposes only the supported API contract',async()=>{
 const response=await handler.fetch(new Request('https://proxy.test/health'),{SESSION_SECRET:'private',JIRA_API_TOKEN:'private',TEAM_CONFIG:'private'});
 assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
 assert.deepEqual(await response.json(),{ok:true,apiVersion:1,capabilities:['date-requests-v1','ticket-notes-v1','odoo-helpdesk-v1','ticket-business-v1','agreed-hours-v1','reports-all-v1','reports-saved-v1','db-report-v1','db-report-company-v1','db-report-pos-version-v1','time-entries-v1','epic-map-v1'],build:''});
});
test('old or incomplete backends cannot release the dashboard',()=>{
 for(const data of [{ok:true,apiVersion:1,capabilities:['date-requests-v1','ticket-notes-v1','ticket-business-v1']},null,{}, {ok:true}, {ok:true,apiVersion:1,capabilities:['date-requests-v1']}, {ok:true,apiVersion:2,capabilities:['date-requests-v1','ticket-notes-v1','ticket-business-v1']}])assert.equal(compatibleProxy(data),false);
});
test('wait retries old deployments and network failures, then accepts a compatible deployment',async()=>{
 let clock=0,calls=0;
 await waitForProxy({timeoutMs:50,intervalMs:10,now:()=>clock,sleep:async ms=>{clock+=ms;},log:()=>{},fetchImpl:async()=>{calls++;if(calls===1)throw Error('Offline');return calls===2?new Response('Not found',{status:404}):Response.json({ok:true,apiVersion:1,capabilities:['date-requests-v1','ticket-notes-v1','ticket-business-v1','reports-all-v1','reports-saved-v1','time-entries-v1']});}});
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
test('deploy stamps every script, style and import with the version, and publishes version.json',async()=>{
 const {stampHtml,stampJs,stampDir}=await import('../scripts/stamp-assets.js');
 const html=stampHtml('<html><head>\n<link rel="stylesheet" href="assets/dashboard.css">\n<link rel="stylesheet" href="https://fonts.googleapis.com/x.css">\n<script src="assets/config.js"></script><script type="module" src="assets/dashboard.js"></script></head></html>','abcdef1234567890');
 assert.match(html,/<head>\n<meta name="aione-build" content="abcdef123456">/);
 assert.match(html,/href="assets\/dashboard\.css\?v=abcdef123456"/);assert.match(html,/src="assets\/config\.js\?v=abcdef123456"/);assert.match(html,/src="assets\/dashboard\.js\?v=abcdef123456"/);
 assert.match(html,/href="https:\/\/fonts\.googleapis\.com\/x\.css"/);
 assert.equal(stampHtml(html,'abcdef1234567890').match(/aione-build/g).length,1);
 const js=stampJs(`import { a } from "./session.js";\nimport {b} from '../models/x.js';\nimport "./side.js";\nconst m=await import("./lazy.js");\nexport { c } from "./c.js";\nconst s="from "+x;\nimport y from "https://cdn.example/y.js";`,'v1');
 assert.equal(js,`import { a } from "./session.js?v=v1";\nimport {b} from '../models/x.js?v=v1';\nimport "./side.js?v=v1";\nconst m=await import("./lazy.js?v=v1");\nexport { c } from "./c.js?v=v1";\nconst s="from "+x;\nimport y from "https://cdn.example/y.js";`);
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stamp-'));fs.mkdirSync(path.join(dir,'assets'));
 fs.writeFileSync(path.join(dir,'index.html'),'<head><script type="module" src="assets/a.js"></script></head>');fs.writeFileSync(path.join(dir,'assets','a.js'),'import "./b.js";');
 assert.equal(stampDir(dir,'build9'),2);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'version.json'),'utf8')),{build:'build9'});
 assert.equal(fs.readFileSync(path.join(dir,'assets','a.js'),'utf8'),'import "./b.js?v=build9";');
 fs.rmSync(dir,{recursive:true,force:true});
});
test('the live proxy only trusts dashboard.ai1.host (not the shared github.io address)',async()=>{
 const {default:settings}=await import('../proxy/settings.js');
 assert.equal(settings.ALLOWED_ORIGIN,'https://dashboard.ai1.host');
 const env={...settings,SESSION_SECRET:'s'};
 for(const [origin,allowed] of [['https://dashboard.ai1.host',true],['https://youssef-sahlieh.github.io',false]]){
  const r=await handler.fetch(new Request('https://p/health',{method:'OPTIONS',headers:{Origin:origin}}),env);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'),allowed?origin:null,origin);
 }
});
