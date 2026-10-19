import {BusinessError,requireStore} from './ticket-metadata.js';
import {buildReport} from './reports.js';
export const savedReportKey=env=>'reports:all:v1:'+encodeURIComponent(env.JIRA_SITE||'')+':'+env.JIRA_PROJECT;
const isComplete=report=>report?.coverage?.jiraComplete===true&&report.coverage.internalComplete===true;
export async function savedReport(env,me,deps,{refresh=false,now=new Date()}={}){
 if(me.role!=='admin')throw new BusinessError('Only administrators can read saved management reports.',403,'forbidden');
 const store=requireStore(env),key=savedReportKey(env),raw=await store.get(key);let previous;
 try{previous=raw?JSON.parse(raw):null;}catch{if(!refresh)throw new BusinessError('The saved report could not be read. Refresh the report to rebuild it.',503,'report_cache');previous=null;}
 const response=(report,cached,extra={})=>({report,cached,stale:now.getTime()-Date.parse(report.generatedAt)>3600000,...extra});
 if(previous&&!refresh)return response(previous,true);
 const owner=crypto.randomUUID(),lock=key+':lock';if(!await store.setIfAbsent(lock,owner,90)){if(previous)return response(previous,true,{refreshing:true});throw new BusinessError('The first report is being prepared. Try again shortly.',409,'report_building');}
 try{
  // A second cold reader may have filled the cache while this request waited.
  if(!refresh){const ready=await store.get(key);if(ready)return response(JSON.parse(ready),true);}
  const report=await buildReport(env,me,deps,{workflow:'all'},now);
  if(isComplete(previous)&&!isComplete(report))return response(previous,true,{refreshWarning:'The refresh returned incomplete source data. The previous complete saved report is still displayed.'});
  await store.set(key,JSON.stringify(report));return response(report,false);
 }finally{await store.deleteIfValue(lock,owner);}
}
export async function savedReportRoutes(request,env,me,deps,path){
 if(path==='/reports/latest'&&request.method==='GET'||path==='/reports/refresh'&&request.method==='POST')return Response.json(await savedReport(env,me,deps,{refresh:path==='/reports/refresh'}),{headers:{'Cache-Control':'no-store'}});
 throw new BusinessError('Use GET for the saved report or POST to refresh it.',405);
}
