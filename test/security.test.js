import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {performance} from "node:perf_hooks";
import handler,{makeToken,readToken} from "../proxy/src/handler.js";
import {memoryStore,redisStore,saveUser,getUser,hashPassword,checkPassword,createLinkToken,useLinkToken,ITERATIONS} from "../proxy/src/users.js";

async function fixture(oldHash=false){
  const env={COOKIE_SESSIONS:true,STORE:memoryStore(),SESSION_SECRET:"synthetic-signing-secret",TEAM_EMAILS:"",ALLOWED_ORIGIN:"https://app.example.invalid",JIRA_PROJECT:"AION",JIRA_SITE:"https://jira.example.invalid",JIRA_EMAIL:"synthetic@invalid",JIRA_API_TOKEN:"synthetic-token",MAIL_DOMAIN:"example.invalid"};
  const password="synthetic-strong-password",email="manager@example.invalid";
  await saveUser(env.STORE,{email,name:"Manager",role:"admin",dev:"",v:1,pw:await hashPassword(password,undefined,oldHash?210000:ITERATIONS)});
  const request=(path,{method="GET",cookie,csrf,origin="https://app.example.invalid",body,authorization}={})=>handler.fetch(new Request("https://app.example.invalid"+path,{method,headers:{...(origin?{Origin:origin}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{"X-AION-CSRF":csrf}:{}),...(authorization?{Authorization:authorization}:{}),...(body!==undefined?{"Content-Type":"application/json"}:{})},body:body!==undefined?JSON.stringify(body):undefined}),env);
  const login=async()=>{const response=await request("/login",{method:"POST",body:{email,password}});assert.equal(response.status,200);return {response,data:await response.json(),cookie:response.headers.get("Set-Cookie").split(";")[0]};};
  return {env,password,email,request,login};
}

test("reset token is consumed atomically and Redis uses GETDEL",async t=>{
  const store=memoryStore(),token=await createLinkToken(store,"synthetic@example.invalid","reset",60);
  const results=await Promise.all(Array.from({length:10},()=>useLinkToken(store,token)));assert.equal(results.filter(Boolean).length,1);
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let command;
  globalThis.fetch=async(url,options)=>{command=JSON.parse(options.body);return Response.json({result:null});};
  await useLinkToken(redisStore("https://redis.invalid","synthetic"),token);assert.equal(command[0],"GETDEL");assert.ok(command[1].startsWith("rt:"));assert.ok(!command.includes(token));
});

test("cookie login returns no bearer token and bootstrap exposes only session metadata",async()=>{
  const f=await fixture(),{response,data,cookie}=await f.login();
  assert.equal(data.token,undefined);assert.equal(data.password,undefined);assert.ok(data.csrf);assert.match(response.headers.get("Set-Cookie"),/^__Host-aion-session=.*; Path=\/; HttpOnly; SameSite=Strict; Max-Age=86400; Secure$/);
  const session=await f.request("/session",{cookie});assert.equal(session.status,200);assert.equal((await session.json()).token,undefined);
  assert.equal((await f.request("/config",{cookie})).status,200);
  const legacy=await makeToken(f.env,f.email,Date.now(),1);assert.equal(await readToken(f.env,"Bearer "+legacy.token),null);
  assert.equal((await f.request("/config",{authorization:"Bearer "+legacy.token})).status,401);
});

test("mutations require both same origin and session-bound CSRF token",async()=>{
  const f=await fixture(),{data,cookie}=await f.login();
  for(const options of [{cookie},{cookie,csrf:"wrong"},{cookie,csrf:data.csrf,origin:"https://attacker.invalid"},{cookie,csrf:data.csrf,origin:null}])assert.equal((await f.request("/logout",{method:"POST",...options})).status,403);
  assert.equal((await f.request("/login",{method:"POST",origin:"https://attacker.invalid",body:{email:f.email,password:f.password}})).status,403);
  assert.equal((await f.request("/session",{cookie})).status,200);
});

test("logout revokes copied cookies and old CSRF values cannot authorize a new session",async()=>{
  const f=await fixture(),first=await f.login();
  const response=await f.request("/logout",{method:"POST",cookie:first.cookie,csrf:first.data.csrf});assert.equal(response.status,200);assert.match(response.headers.get("Set-Cookie"),/Max-Age=0/);
  assert.equal((await f.request("/session",{cookie:first.cookie})).status,401);assert.equal((await f.request("/config",{cookie:first.cookie})).status,401);
  const second=await f.login();assert.notEqual(second.cookie,first.cookie);assert.equal((await f.request("/logout",{method:"POST",cookie:second.cookie,csrf:first.data.csrf})).status,403);
});

test("legacy password hashes upgrade on successful login without changing account version",async()=>{
  const f=await fixture(true);assert.equal((await getUser(f.env.STORE,f.email)).pw.iterations,210000);
  await f.login();const user=await getUser(f.env.STORE,f.email);assert.equal(user.pw.iterations,600000);assert.equal(user.v,1);assert.equal(await checkPassword(f.password,user.pw),true);
  assert.equal((await f.request("/login",{method:"POST",body:{email:f.email,password:"wrong-password"}})).status,401);
});

test("600000-iteration hashes validate and provide a local timing benchmark",async t=>{
  const started=performance.now(),pw=await hashPassword("synthetic-benchmark-password");t.diagnostic(`PBKDF2 600000 iterations: ${Math.round(performance.now()-started)}ms on this machine`);
  assert.equal(pw.iterations,600000);assert.equal(await checkPassword("synthetic-benchmark-password",pw),true);assert.equal(await checkPassword("wrong",pw),false);
});

test("password migration cannot overwrite a concurrent administrator role edit",async()=>{
  const f=await fixture(true),original=f.env.STORE.compareAndSet;
  f.env.STORE.compareAndSet=async(key,expected,value)=>{const user=await getUser(f.env.STORE,f.email);await saveUser(f.env.STORE,{...user,role:"user",dev:"builder",name:"Changed name"});return original(key,expected,value);};
  const result=await f.login();assert.equal(result.data.role,"user");const user=await getUser(f.env.STORE,f.email);assert.equal(user.role,"user");assert.equal(user.name,"Changed name");
});

test("mailer and proxy errors redact synthetic sensitive details from responses and logs",async t=>{
  const f=await fixture(),session=await f.login(),marker="synthetic-sensitive-audit-marker",logs=[];const oldWarn=console.warn,oldFetch=globalThis.fetch;t.after(()=>{console.warn=oldWarn;globalThis.fetch=oldFetch;});console.warn=(...parts)=>logs.push(parts.join(" "));
  f.env.MAILER=async()=>{throw new Error(marker);};
  const response=await f.request("/mail",{method:"POST",cookie:session.cookie,csrf:session.data.csrf,body:{to:["recipient@example.invalid"],subject:"Test",html:"<p>Test</p>"}});assert.equal(response.status,502);assert.ok(!(await response.text()).includes(marker));
  globalThis.fetch=async()=>{throw new Error(marker);};
  const failure=await f.request("/jira/search",{method:"POST",cookie:session.cookie,csrf:session.data.csrf,body:{jql:"project = AION",fields:[]}});assert.equal(failure.status,500);assert.ok(!(await failure.text()).includes(marker));assert.ok(!logs.join(" ").includes(marker));
});

test("GitHub Pages stays on its host and uses the existing bearer proxy",()=>{
  const configScript=readFileSync(new URL("../public/assets/config.js",import.meta.url),"utf8");assert.match(configScript,/https:\/\/aione-team-proxy\.vercel\.app/);assert.doesNotMatch(configScript,/location\.replace|removeItem/);
  const session=readFileSync(new URL("../public/assets/session.js",import.meta.url),"utf8");assert.match(session,/headers\.Authorization/);
  const entry=readFileSync(new URL("../proxy/api/proxy.js",import.meta.url),"utf8");assert.doesNotMatch(entry,/COOKIE_SESSIONS\s*:\s*true/);
});
