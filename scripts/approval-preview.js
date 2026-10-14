// Isolated review server: all tickets, identities and email deliveries are local sample data.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import handler,{makeToken} from '../proxy/src/handler.js';
import settings from '../proxy/settings.js';
import {memoryStore,saveUser} from '../proxy/src/users.js';
import {jiraIssue,internalTicket,people} from '../test/fixtures/issues.js';
const port=Number(process.env.PREVIEW_PORT||3100),base='http://localhost:'+port,root=resolve('public');
const store=memoryStore(),emails=[];
const admin={email:'admin@aione.biz',name:'Preview Admin',role:'admin',v:1};
const user={email:'builder@aione.biz',name:'Preview Developer',role:'user',dev:'builder',v:1};
const reviewer={email:'reviewer@aione.biz',name:'Preview Reviewer',role:'user',dev:'reviewer',v:1};
for(const u of [admin,user,reviewer])await saveUser(store,u);
const offset=n=>{const d=new Date();d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const issues=new Map(),dateHistories=new Map();
for(const [index,title,due,dev,status] of [[101,'Add creation-date filters to the API',-2,'builder','In Development'],[102,'Improve retry handling for file uploads',2,'builder','Open'],[103,'Verify the checkout regression fixes',0,'reviewer','Pending QA'],[104,'Prepare deployment notes',5,'builder','Open'],[105,'Investigate intermittent export failures',null,'builder','Open'],[106,'Review integration error messages',7,'reviewer','Open']]){
 const i=structuredClone(jiraIssue);i.id=String(10000+index);i.key='AION-'+index;i.fields.summary=title;i.fields.project={key:'AION'};i.fields.labels=['ai1_'+dev];i.fields.duedate=due===null?null:offset(due);i.fields.status={name:status,statusCategory:{key:'indeterminate'}};i.fields.created=new Date(Date.now()-3*86400000).toISOString();i.fields.updated=new Date().toISOString();i.fields.parent=null;i.fields.description='Local sample ticket for reviewing the date request and approval workflow.';i.renderedFields.description='<p>Local sample ticket for reviewing the date request and approval workflow.</p>';issues.set(i.key,i);dateHistories.set(i.key,i.fields.duedate?[{id:"initial-"+index,created:i.fields.created,author:{displayName:"Preview Developer"},items:[{field:"duedate",from:null,to:i.fields.duedate}]}]:[]);
}
const internal={...structuredClone(internalTicket),summary:'Review the internal release checklist',created:new Date().toISOString(),updated:new Date().toISOString(),due:offset(3),dueHistory:[{when:new Date().toISOString(),by:'Preview Admin',from:null,to:offset(3)}]};
await store.set('it:'+internal.key,JSON.stringify(internal));await store.sadd('itickets',internal.key);
globalThis.fetch=async(url,options={})=>{
 const u=new URL(url);if(u.hostname!=='jira.preview.invalid')throw new Error('External services are disabled in this preview.');
 const body=options.body?JSON.parse(options.body):{},match=/\/issue\/(AION-\d+)/.exec(u.pathname),i=match&&issues.get(match[1]);
 if(u.pathname.endsWith('/search/jql')){const key=/key = (AION-\d+)/.exec(body.jql||'');let list=key?[issues.get(key[1])].filter(Boolean):[...issues.values()];if((body.jql||'').includes('statusCategory = Done'))list=[];const label=/labels = "([^"]+)"/.exec(body.jql||'');if(label)list=list.filter(i=>i.fields.labels.includes(label[1]));return Response.json({issues:list,isLast:true});}
 if(u.pathname.endsWith('/user/search'))return Response.json([]);
 if(!i)return Response.json({errorMessages:['No sample ticket']},{status:404});
 if(u.pathname.endsWith('/transitions')){if(options.method==='POST'){i.fields.status.name='In Development';return new Response(null,{status:204});}return Response.json({transitions:[{id:'1',name:'Start development',to:{name:'In Development',statusCategory:{key:'indeterminate'}}}]});}
 if(u.pathname.endsWith('/changelog'))return Response.json({values:dateHistories.get(i.key)||[],isLast:true,total:(dateHistories.get(i.key)||[]).length});
 if(options.method==='PUT'){if('duedate' in body.fields&&(i.fields.duedate||null)!==body.fields.duedate)dateHistories.get(i.key).push({id:crypto.randomUUID(),created:new Date().toISOString(),author:{displayName:'Preview Jira account'},items:[{field:'duedate',from:i.fields.duedate||null,to:body.fields.duedate}]});Object.assign(i.fields,body.fields);i.fields.updated=new Date().toISOString();return new Response(null,{status:204});}
 if(u.pathname.endsWith('/comment')&&options.method==='POST')return Response.json({id:'preview-comment'});
 return Response.json(i);
};
const env={INTERNAL_NOTE_RECIPIENTS:settings.INTERNAL_NOTE_RECIPIENTS,ALLOWED_ORIGIN:base,SESSION_SECRET:crypto.randomUUID(),JIRA_PROJECT:'AION',JIRA_SITE:'https://jira.preview.invalid',JIRA_EMAIL:'preview@aione.biz',JIRA_API_TOKEN:'local-only',STORE:store,MAIL_DOMAIN:'aione.biz',APP_URL:base,TEAM_EMAILS:admin.email,TEAM_CONFIG:JSON.stringify({people,devs:['builder','reviewer'],devEmails:{builder:user.email,reviewer:reviewer.email},devColors:{builder:'k1',reviewer:'k3'}}),MAILER:async mail=>{emails.push({...mail,at:new Date().toISOString()});}};
const tokens={admin:(await makeToken(env,admin.email,Date.now(),1)).token,user:(await makeToken(env,user.email,Date.now(),1)).token,reviewer:(await makeToken(env,reviewer.email,Date.now(),1)).token};
const call=async(action,body,role='user')=>{const response=await handler.fetch(new Request(base+'/date-requests/'+action,{method:'POST',headers:{Authorization:'Bearer '+tokens[role],'Content-Type':'application/json'},body:JSON.stringify(body)}),env);if(!response.ok)throw new Error(await response.text());return (await response.json()).request;};
await call('submit',{key:'AION-101',proposedDate:offset(3),reason:'API contract clarification is still pending. I need time for implementation and regression tests.',blocker:'Waiting for the integration team to confirm the filter format.'});
await call('submit',{key:'AION-103',proposedDate:offset(2),reason:'The checkout regression needs another verification pass.'},'reviewer');
await call('submit',{key:'INT-101',proposedDate:offset(5),reason:'The release checklist depends on the final QA sign-off.'});
const rejected=await call('submit',{key:'AION-104',proposedDate:offset(10),reason:'Additional time requested for release documentation.'});await call('reject',{key:rejected.key,id:rejected.id,version:rejected.version,reason:'Keep the release date. Reduce the documentation scope and finish the essential notes first.'},'admin');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,base);if(!['localhost:'+port,'127.0.0.1:'+port].includes(req.headers.host)){res.writeHead(403).end();return;}
  if(url.pathname==='/preview/admin'||url.pathname==='/preview/user'){const role=url.pathname.endsWith('/user')?'user':'admin';res.writeHead(302,{'Set-Cookie':'preview-role='+role+'; HttpOnly; SameSite=Strict; Path=/','Location':'/dashboard.html?page='+(role==='admin'?'requests':'overview')}).end();return;}
  const role=/preview-role=user/.test(req.headers.cookie||'')?'user':'admin';
  if(url.pathname==='/preview/emails'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(emails,null,2));return;}
  if(url.pathname.startsWith('/api/')){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>5*1024*1024){res.writeHead(413).end();return;}chunks.push(chunk);}const request=new Request(base+url.pathname.slice(4)+url.search,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});const response=await handler.fetch(request,env);res.writeHead(response.status,Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));return;}
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
  if(url.pathname==='/assets/config.js'){
   const me=role==='user'?user:admin;const session={token:tokens[role],email:me.email,role:me.role,expiresAt:Date.now()+3600000};
   const code='window.AIONE_API=location.origin+"/api";localStorage.setItem("aione-session",'+JSON.stringify(JSON.stringify(session))+');window.addEventListener("DOMContentLoaded",()=>{const b=document.createElement("div");b.className="preview-banner";b.append(document.createTextNode("Local preview · Sample data · '+(role==='user'?'Developer':'Admin')+'"));for(const [name,url] of [["Admin","/preview/admin"],["Developer","/preview/user"],["Emails","/preview/emails"]]){const a=document.createElement("a");a.textContent=name;a.href=url;b.append(a);}document.body.prepend(b);});';
   res.writeHead(200,{'Content-Type':types['.js'],'Cache-Control':'no-store'}).end(code);return;
  }
  const p=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/dashboard.html':url.pathname));if(!p.startsWith(root+sep)){res.writeHead(403).end();return;}
  let body;try{body=await readFile(p);}catch{res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':types[extname(p)]||'application/octet-stream','Cache-Control':'no-store'}).end(req.method==='HEAD'?undefined:body);
 }catch{res.writeHead(500,{'Content-Type':'application/json'}).end(JSON.stringify({error:'The local preview could not complete this request.'}));}
}).listen(port,'127.0.0.1',()=>console.log('Local approval preview: '+base+'/preview/admin\nDeveloper view: '+base+'/preview/user\nSample data resets on restart. No live tickets or emails are changed.'));
