import {sortTickets} from './ticket-business.js';
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'});
const dateCache=new WeakMap();
const localDate=value=>{if(!value||!Number.isFinite(Date.parse(value)))return '';return formatter.format(new Date(value));};
const hours=v=>typeof v==='number'&&Number.isFinite(v)&&v>0;
const sum=(a,b)=>Math.round((a+b)*100)/100;
export function selectReport(snapshot,filters={}){
 const period={...snapshot.period,start:filters.start||snapshot.period.start,end:filters.end||snapshot.period.end};
 const inPeriod=date=>!!date&&date>=period.start&&date<=period.end;
 const dates=t=>{let cached=dateCache.get(t);if(!cached||cached.createdValue!==t.created||cached.completedValue!==t.completedAt){cached={createdValue:t.created,completedValue:t.completedAt,created:localDate(t.created),completed:localDate(t.completedAt)};dateCache.set(t,cached);}return cached;};
 const query=(filters.text||'').trim().toLowerCase();
 let tickets=snapshot.tickets.filter(t=>(!filters.source||filters.source==='all'||(filters.source==='internal')===!!t.internal)&&(!filters.clientId||(filters.clientId==='__none'?!t.clientId:t.clientId===filters.clientId))&&(!filters.subClientId||t.subClientId===filters.subClientId)&&(!filters.developer||(filters.developer==='__none'?!t.devs?.length:t.devs?.includes(filters.developer)))&&(!filters.status||(filters.status==='__open'?!t.closed:filters.status==='__closed'?t.closed:t.status===filters.status))&&(!filters.billing||(filters.billing==='__none'?!t.billing:t.billing===filters.billing))&&(!query||[t.key,t.title,t.clientName,t.subClientName,t.workDone,...(t.devs||[])].join(' ').toLowerCase().includes(query))).map(t=>({...t,createdInPeriod:inPeriod(dates(t).created),completedInPeriod:inPeriod(dates(t).completed)}));
 const workflow=filters.workflow||'all';tickets=tickets.filter(t=>workflow==='completeness'?t.missing?.length||t.overrides?.length:workflow==='delivery'?t.risks?.length:workflow==='hours'?!!t.overEstimate:workflow==='management'?!t.closed||t.createdInPeriod||t.completedInPeriod||t.overrides?.length:true);
 // No comparison or sorting runs until the user explicitly chooses one.
 if(filters.sort){const [field,direction]=filters.sort.split(':');tickets=sortTickets(tickets,{field,direction},true);}
 const totals={open:0,created:0,completed:0,atRisk:0,overrides:0},groups=new Map();
 for(const t of tickets){totals.open+=!t.closed?1:0;totals.created+=t.createdInPeriod?1:0;totals.completed+=t.completedInPeriod?1:0;totals.atRisk+=t.risks?.length?1:0;totals.overrides+=t.overrides?.length||0;
  if(!t.createdInPeriod&&!t.completedInPeriod)continue;
  const key=JSON.stringify([t.clientId||null,t.subClientId||null,t.billing||null]),g=groups.get(key)||{client:t.clientName||'Not set',subClient:t.subClientName||'',billing:t.billing||'Not set',tickets:0,estimatedHours:null,actualHours:null,missingEstimated:0,missingActual:0};g.tickets++;for(const [field,missing] of [['estimatedHours','missingEstimated'],['actualHours','missingActual']]){if(hours(t[field]))g[field]=sum(g[field]||0,t[field]);else g[missing]++;}groups.set(key,g);
 }
 return {...snapshot,workflow,period,totals,groups:[...groups.values()],tickets,coverage:{...snapshot.coverage,filtered:tickets.length}};
}
