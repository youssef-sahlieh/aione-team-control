import { BusinessError, requireStore, readCatalog, readMetadata, publicMetadata, closureErrors, validHours, withLogged, overageOf } from './ticket-metadata.js';
import { readSummaries, reportWork } from './time-entries.js';
export const localDate=(date=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
export function reportPeriod(options={},now=new Date()) {
  const end=options.end||localDate(now),d=new Date(end+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-6);const start=options.start||d.toISOString().slice(0,10);
  if(![start,end].every(x=>/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x+'T12:00:00Z').toISOString().slice(0,10)===x)||start>end)throw new BusinessError('Choose a valid report period.');
  return {start,end,timeZone:'Asia/Jerusalem'};
}
export async function buildReport(env,me,{readSearch,readInternal,readHistory},options={},now=new Date()) {
  requireStore(env);if(me.role!=='admin')throw new BusinessError('Only administrators can run management reports.',403,'forbidden');
  const workflow=options.workflow||'management';if(!['all','completeness','delivery','hours','management'].includes(workflow))throw new BusinessError('Choose a supported workflow.');
  const period=reportPeriod(options,now),catalog=await readCatalog(env),rows=[],warnings=[],seen=new Set(),started=Date.now();let token,complete=false;
  try{
    for(let page=0;page<20;page++){
      if(Date.now()-started>18000){warnings.push('Jira search reached the report time limit.');break;}
      const r=await readSearch({jql:'project = "'+env.JIRA_PROJECT+'" AND issuetype != Epic ORDER BY updated DESC',fields:['summary','status','labels','created','updated','duedate','resolutiondate','assignee'],maxResults:100,...(token?{nextPageToken:token}:{})});
      for(const issue of r.issues||[]){if(!issue.key?.startsWith(env.JIRA_PROJECT+'-')||!/^\d+$/.test(issue.key.slice(env.JIRA_PROJECT.length+1)))continue;const f=issue.fields||{};if(!f.status?.statusCategory?.key){warnings.push('A Jira ticket lacked status details.');continue;}rows.push({key:issue.key,title:f.summary,status:f.status.name,cat:f.status.statusCategory.key,closed:f.status.statusCategory.key==='done',devs:(f.labels||[]).filter(l=>/^ai1_/i.test(l)).map(l=>l.slice(4).toLowerCase()),created:f.created,updated:f.updated,due:f.duedate,completedAt:f.resolutiondate||null,internal:false});}
      if(r.isLast===true||(r.isLast!==false&&!r.nextPageToken)){complete=true;break;}
      if(!r.nextPageToken||seen.has(r.nextPageToken)){warnings.push('Jira pagination was incomplete or repeated.');break;}seen.add(r.nextPageToken);token=r.nextPageToken;
    }
  }catch{warnings.push('Jira data could not be fully retrieved.');}
  if(!complete)warnings.push('Jira results are partial; totals cover only retrieved tickets.');
  let internalComplete=true;try{rows.push(...await readInternal());}catch{internalComplete=false;warnings.push('Internal tickets could not be fully retrieved.');}
  const unique=[...new Map(rows.map(t=>[t.key,t])).values()],all=[],unknownCompletion=[];let historyReads=0;
  // Actual hours include the logged work entries.
  const sums=await readSummaries(env,unique.map(t=>t.key)).catch(()=>({}));
  const metadata=new Map();for(let i=0;i<unique.length;i+=12)await Promise.all(unique.slice(i,i+12).map(async t=>metadata.set(t.key,withLogged(await readMetadata(env,t.key),sums[t.key]))));
  for(const t of unique){
    const m=metadata.get(t.key);let completedAt=t.closed?(t.completedAt||m.completedAt):null;
    if(t.closed&&!completedAt&&!t.internal&&readHistory&&historyReads<20&&Date.now()-started<25000){historyReads++;try{completedAt=await readHistory(t.key,t.status);}catch{} }
    if(t.closed&&!completedAt)unknownCompletion.push(t.key);
    if(options.clientId&&options.clientId!==m.clientId)continue;if(options.subClientId&&options.subClientId!==m.subClientId)continue;
    if(options.source==='internal'&&!t.internal||options.source==='jira'&&t.internal)continue;
    const lastActivityAt=[t.updated,m.updatedAt].filter(v=>Number.isFinite(Date.parse(v))).sort((a,b)=>Date.parse(b)-Date.parse(a))[0]||null;
    // Agreed hours against the work the users logged: "Needs checkup" when logged is more than agreed (computed here, not stored).
    const loggedMinutes=sums[t.key]?.loggedMinutes||0,agreedHours=m.agreedHours??null;
    const data={...t,...publicMetadata(m,me,catalog),completedAt,lastActivityAt,agreedHours,loggedMinutes,loggedHours:Math.round(loggedMinutes/60*100)/100,...overageOf(agreedHours,loggedMinutes)};
    data.missing=t.closed?closureErrors(catalog,m):[...closureErrors(catalog,m).filter(x=>!x.includes('actual hours')&&!x.includes('work done')), ...(!t.devs.length?['Assign a developer']:[])];
    data.overrides=m.history.filter(h=>h.type==='override');
    data.risks=[];if(!t.closed){if(t.due&&t.due<localDate(now))data.risks.push('Overdue');if(!t.due)data.risks.push('No approved due date');if(lastActivityAt&&localDate(new Date(lastActivityAt))<=localDate(new Date(now.getTime()-7*86400000)))data.risks.push('No activity for at least seven calendar days');}
    data.overEstimate=validHours(m.actualHours)&&validHours(m.estimatedHours)&&m.actualHours>m.estimatedHours?{hours:Math.round((m.actualHours-m.estimatedHours)*100)/100,percent:Math.round((m.actualHours/m.estimatedHours-1)*10000)/100}:null;
    const inPeriod=value=>value&&localDate(new Date(value))>=period.start&&localDate(new Date(value))<=period.end;
    data.createdInPeriod=!!inPeriod(t.created);data.completedInPeriod=!!inPeriod(completedAt);all.push(data);
  }
  // Who logged the time on each ticket, and whether Odoo has it (only tickets with work or agreed hours need a read).
  const work=await reportWork(env,all.filter(t=>t.loggedMinutes||t.agreedHours!=null).map(t=>({key:t.key,agreedHours:t.agreedHours}))).catch(()=>({}));
  for(const t of all){const w=work[t.key]||{odoo:'No work logged',employees:[]};t.odooStatus=w.odoo;t.employees=w.employees;}
  if(unknownCompletion.length)warnings.push(unknownCompletion.length+' retrieved completed tickets have no verified completion date. They are excluded from period completion counts.');
  const cohort=all.filter(t=>t.createdInPeriod||t.completedInPeriod),groups=new Map();
  for(const t of cohort){const key=[t.clientId,t.subClientId,t.billing].join('|'),g=groups.get(key)||{client:t.clientName||'Not set',subClient:t.subClientName||'',billing:t.billing||'Not set',tickets:0,estimatedHours:null,actualHours:null,missingEstimated:0,missingActual:0};g.tickets++;for(const [k,missing]of [['estimatedHours','missingEstimated'],['actualHours','missingActual']]){if(validHours(t[k]))g[k]=Math.round(((g[k]||0)+t[k])*100)/100;else g[missing]++;}groups.set(key,g);}
  const findings=all.filter(t=>workflow==='all'?true:workflow==='completeness'?t.missing.length||t.overrides.length:workflow==='delivery'?t.risks.length:workflow==='hours'?t.overEstimate:!t.closed||t.createdInPeriod||t.completedInPeriod||t.overrides.length);
  return {workflow,generatedAt:now.toISOString(),period,coverage:{jiraComplete:complete,internalComplete,examined:unique.length,filtered:all.length},warnings:[...new Set(warnings)],hoursLabel:'Current hours on tickets created or completed in the selected cohort; these are ticket totals, not hours worked during the period.',totals:{open:all.filter(t=>!t.closed).length,created:all.filter(t=>t.createdInPeriod).length,completed:all.filter(t=>t.completedInPeriod).length,atRisk:all.filter(t=>t.risks.length).length,overrides:all.reduce((n,t)=>n+t.overrides.length,0)},groups:[...groups.values()],tickets:findings};
}
export async function reportRoutes(request,env,me,deps) {
  if(request.method!=='POST')throw new BusinessError('Use POST to run reports.',405);
  if(me.role!=='admin')throw new BusinessError('Only administrators can run management reports.',403,'forbidden');
  const raw=await request.text();if(raw.length>5000)throw new BusinessError('Report request too large.',413);
  let options;try{options=JSON.parse(raw);}catch{throw new BusinessError('Invalid report options.');}
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['workflow','start','end','clientId','subClientId','source'].includes(k)))throw new BusinessError('Invalid report options.');
  if(options.source&&!['all','jira','internal'].includes(options.source))throw new BusinessError('Choose a valid ticket source.');
  return Response.json(await buildReport(env,me,deps,options),{headers:{'Cache-Control':'no-store'}});
}
