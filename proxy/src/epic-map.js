// Jira epics mapped to Odoo projects (the client catalog's projects, see ticket-metadata.js). Every ticket under a
// mapped epic takes that project as its client and sub-client, and keeps following the epic when it moves to
// another mapped one. A client someone chose by hand is never overwritten (applyEpicSelection).
import { BusinessError, readCatalog, requireStore, metadataKey, applyEpicSelection } from './ticket-metadata.js';
const problem=(message,status=400,code='epic_map')=>{throw new BusinessError(message,status,code);};
const mapKey=env=>'business:'+env.JIRA_PROJECT+':epic-map';
const syncKey=env=>mapKey(env)+':sync';
export async function readEpicMap(env){ return JSON.parse(await requireStore(env).get(mapKey(env))||'{"revision":0,"map":{}}'); }
// An Odoo project in the catalog: a sub-client (customer / project), or a top-level entry with no sub-clients
// (a project without a customer).
export const isProject=(catalog,e)=>!!e&&(!!e.parentId||!catalog.entries.some(c=>c.parentId===e.id));
export const selectionFor=e=>e.parentId?{clientId:e.parentId,subClientId:e.id}:{clientId:e.id,subClientId:null};
async function searchAll(jira,jql,fields,pages=20){
  const out=[];let token;
  for(let page=0;page<pages;page++){
    const r=await jira('/rest/api/3/search/jql',{method:'POST',body:{jql,fields,maxResults:100,...(token?{nextPageToken:token}:{})},signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw new Error('Jira search failed');
    out.push(...(r.data.issues||[]));token=r.data.nextPageToken;
    if(r.data.isLast!==false||!token)break;
  }
  return out;
}
// Brings every ticket under a mapped epic in line with its epic. Runs at most every 10 minutes unless forced.
export async function syncEpicClients(env,jira,{force=false}={}){
  const store=requireStore(env),last=Number(await store.get(syncKey(env)))||0;
  if(!force&&Date.now()-last<10*60*1000)return {changed:0,syncedAt:last};
  const lock=syncKey(env)+':lock',owner=crypto.randomUUID();
  if(!await store.setIfAbsent(lock,owner,120))return {changed:0,busy:true,syncedAt:last};
  try{
    const {map}=await readEpicMap(env),catalog=await readCatalog(env),epics=Object.keys(map);let changed=0,tickets=0;
    if(epics.length){
      const issues=await searchAll(jira,'project = "'+env.JIRA_PROJECT+'" AND parent in ('+epics.join(',')+') ORDER BY key',['parent','status']);
      const work=issues.map(i=>{const epicKey=i.fields?.parent?.key,e=catalog.entries.find(c=>c.id===map[epicKey]);return e&&isProject(catalog,e)?{key:i.key,epicKey,closed:i.fields?.status?.statusCategory?.key==='done',...selectionFor(e)}:null;}).filter(Boolean);
      tickets=work.length;
      // One read for all of them; only tickets that may need a change take the ticket lock.
      const raws=!work.length?[]:store.mget?await store.mget(work.map(w=>metadataKey(env,w.key))):await Promise.all(work.map(w=>store.get(metadataKey(env,w.key))));
      const todo=work.filter((w,n)=>{const m=JSON.parse(raws[n]||'{}');return !(m.clientId||m.subClientId)||(!w.closed&&m.epicKey&&(m.clientId!==w.clientId||(m.subClientId||null)!==w.subClientId||m.epicKey!==w.epicKey));});
      for(let i=0;i<todo.length;i+=8)await Promise.all(todo.slice(i,i+8).map(async w=>{try{if(await applyEpicSelection(env,w.key,w))changed++;}catch{}}));
    }
    const at=Date.now();await store.set(syncKey(env),String(at));
    return {changed,tickets,syncedAt:at};
  }finally{await store.deleteIfValue(lock,owner);}
}
export async function epicMapRoutes(request,env,url,me,jira){
  const admin=me.role==='admin',json=d=>Response.json(d,{headers:{'Cache-Control':'no-store'}});
  if(url.pathname==='/epic-map/sync'){
    if(request.method!=='POST')problem('Use POST.',405);
    const force=url.searchParams.get('force')==='1';if(force&&!admin)problem('Only administrators manage epic mapping.',403,'forbidden');
    try{return json(await syncEpicClients(env,jira,{force}));}catch(e){if(e instanceof BusinessError)throw e;problem("Couldn't read epics from Jira.",502,'jira');}
  }
  if(url.pathname!=='/epic-map')problem('Not found.',404);
  if(!admin)problem('Only administrators manage epic mapping.',403,'forbidden');
  if(request.method==='GET'){
    let epics;try{epics=await searchAll(jira,'project = "'+env.JIRA_PROJECT+'" AND issuetype = Epic ORDER BY key',['summary','status'],5);}catch{problem("Couldn't read epics from Jira.",502,'jira');}
    return json({...await readEpicMap(env),epics:epics.map(i=>({key:i.key,name:i.fields?.summary||i.key,done:i.fields?.status?.statusCategory?.key==='done'}))});
  }
  if(request.method!=='PUT')problem('Use GET or PUT.',405);
  let b;try{b=await request.json();}catch{problem('Invalid epic mapping.');}
  if(!b||typeof b.epicKey!=='string'||!new RegExp('^'+env.JIRA_PROJECT+'-\\d+$').test(b.epicKey))problem('Choose a valid epic.');
  const store=requireStore(env),previous=await store.get(mapKey(env)),current=previous?JSON.parse(previous):{revision:0,map:{}};
  if(b.revision!==current.revision)problem('Epic mapping changed. Refresh and retry.',409,'conflict');
  const next={revision:current.revision+1,map:{...current.map}};
  if(b.entryId==null)delete next.map[b.epicKey];
  else{const catalog=await readCatalog(env),e=catalog.entries.find(c=>c.id===b.entryId);if(!isProject(catalog,e)||e.archived)problem('Choose an active Odoo project.');next.map[b.epicKey]=e.id;}
  if(!(previous===null?await store.setIfAbsent(mapKey(env),JSON.stringify(next),315360000):await store.compareAndSet(mapKey(env),previous,JSON.stringify(next))))problem('Epic mapping changed. Refresh and retry.',409,'conflict');
  let sync;try{sync=await syncEpicClients(env,jira,{force:true});}catch{sync={error:"Saved, but tickets couldn't be updated from Jira yet. They will be on the next sync."};}
  return json({...next,sync});
}
