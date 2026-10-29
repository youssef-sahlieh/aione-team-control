import {sortTickets,csvCell} from './ticket-business.js';
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
 let tickets=snapshot.tickets.filter(t=>(!filters.source||filters.source==='all'||(filters.source==='internal')===!!t.internal)&&(!filters.clientId||(filters.clientId==='__none'?!t.clientId:t.clientId===filters.clientId))&&(!filters.subClientId||t.subClientId===filters.subClientId)&&(!filters.developer||(filters.developer==='__none'?!t.devs?.length:t.devs?.includes(filters.developer)))&&(!filters.status||(filters.status==='__open'?!t.closed:filters.status==='__closed'?t.closed:t.status===filters.status))&&(!filters.billing||(filters.billing==='__none'?!t.billing:t.billing===filters.billing))&&(!filters.flag||(filters.flag==='none'?t.overage==null:t.overage===filters.flag))&&(!filters.employee||(t.employees||[]).some(e=>e.name===filters.employee))&&(!query||[t.key,t.title,t.clientName,t.subClientName,t.workDone,...(t.devs||[])].join(' ').toLowerCase().includes(query))).map(t=>({...t,createdInPeriod:inPeriod(dates(t).created),completedInPeriod:inPeriod(dates(t).completed)}));
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

// ---- Unified business report: one row per ticket ----
export const FLAG_LABEL={overage:'Needs checkup',ok:'Within agreed hours'};
export const flagLabel=t=>t.overage==null?'No agreed hours':FLAG_LABEL[t.overage]||t.overage;
export const UNIFIED_HEADERS=['Ticket','Title','Status','Client','Project','Billing','Developers','Employees (logged h)','Estimated hours','Agreed hours','Logged hours','Actual hours','Hours over agreed','Flag','Odoo status','Created','Completed'];
// The CSV for the report: quoted cells, formulas neutralized (csvCell).
export function unifiedCsv(tickets){
 const rows=tickets.map(t=>[t.key,t.title,t.status,t.clientName,t.subClientName,t.billing,(t.devs||[]).join('; '),(t.employees||[]).map(e=>e.name+' ('+e.hours+' h)').join('; '),t.estimatedHours,t.agreedHours,t.loggedHours,t.actualHours,t.overHours,flagLabel(t),t.odooStatus,t.created,t.completedAt]);
 return [UNIFIED_HEADERS,...rows].map(r=>r.map(csvCell).join(',')).join('\r\n');
}
// Employee → customer → tickets. A ticket appears under each person who logged time on it, with that person's hours.
export function groupByEmployee(tickets){
 const bucket=(map,key,make)=>{if(!map.has(key))map.set(key,make());return map.get(key);};
 const employees=new Map();
 for(const t of tickets){
  const customer=t.clientName||'Client not set';
  for(const person of t.employees?.length?t.employees:[{name:'No work logged',hours:0}]){
   const emp=bucket(employees,person.name,()=>({name:person.name,hours:0,customers:new Map()}));
   const cust=bucket(emp.customers,customer,()=>({name:customer,hours:0,tickets:[]}));
   emp.hours=sum(emp.hours,person.hours);cust.hours=sum(cust.hours,person.hours);cust.tickets.push({...t,employeeHours:person.hours});
  }
 }
 return [...employees.values()].map(e=>({...e,customers:[...e.customers.values()]})).sort((a,b)=>b.hours-a.hours||a.name.localeCompare(b.name));
}
// Reads a CSV with a header row containing "Ticket" and "Agreed hours" (quoted cells and CRLF allowed).
export function parseAgreedCsv(text){
 const rows=[];let row=[],cell='',quoted=false;const src=String(text||'').replace(/^\uFEFF/,'');
 for(let i=0;i<src.length;i++){const c=src[i];
  if(quoted){if(c==='"'){if(src[i+1]==='"'){cell+='"';i++;}else quoted=false;}else cell+=c;}
  else if(c==='"')quoted=true;
  else if(c===','){row.push(cell);cell='';}
  else if(c==='\n'||c==='\r'){if(c==='\r'&&src[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}
  else cell+=c;
 }
 if(cell||row.length){row.push(cell);rows.push(row);}
 const header=(rows[0]||[]).map(h=>h.trim().toLowerCase());
 const keyCol=header.findIndex(h=>h==='ticket'||h==='ticket key'||h==='key'),hoursCol=header.findIndex(h=>h==='agreed hours'||h==='agreed');
 if(keyCol<0||hoursCol<0)throw new Error('The CSV needs a header row with "Ticket" and "Agreed hours" columns.');
 return rows.slice(1).filter(r=>r.some(c=>c.trim())).map(r=>({key:(r[keyCol]||'').trim(),agreedHours:(r[hoursCol]||'').trim()}));
}

// ---- Insights: statistics for the rows the report shows (after its filters) ----
const pct=(part,whole)=>whole>0?Math.round(part/whole*1000)/10:null;
const numberOf=v=>typeof v==='number'&&Number.isFinite(v)?v:0;
const BURN_BUCKETS=[['Under 50%',0,50],['50–79%',50,80],['80–100%',80,100.0001],['Over 100%',100.0001,Infinity]];
// Counts and sums for one breakdown, sorted by logged hours, then by name.
function breakdown(tickets,labelOf){
 const groups=new Map();
 for(const t of tickets){const label=labelOf(t);const g=groups.get(label)||{label,tickets:0,agreedHours:0,loggedHours:0,checkups:0};g.tickets++;g.agreedHours=sum(g.agreedHours,numberOf(t.agreedHours));g.loggedHours=sum(g.loggedHours,numberOf(t.loggedHours));g.checkups+=t.overage==='overage'?1:0;groups.set(label,g);}
 return [...groups.values()].sort((a,b)=>b.loggedHours-a.loggedHours||a.label.localeCompare(b.label));
}
// Everything the Insights panel shows. Logged hours are all-time totals per ticket; agreed and estimated hours are summed only where set.
export function insights(tickets){
 const withAgreed=tickets.filter(t=>hours(t.agreedHours));
 const loggedOnAgreed=sum(0,withAgreed.reduce((n,t)=>n+numberOf(t.loggedHours),0));
 const agreedTotal=sum(0,withAgreed.reduce((n,t)=>n+t.agreedHours,0));
 const checkups=tickets.filter(t=>t.overage==='overage').length;
 const burn=withAgreed.map(t=>pct(numberOf(t.loggedHours),t.agreedHours));
 const monthOf=value=>{const d=localDate(value);return d?d.slice(0,7):'';};
 const months=new Map();
 for(const t of tickets){const created=monthOf(t.created);if(created){const m=months.get(created)||{month:created,created:0,completed:0};m.created++;months.set(created,m);}
  const done=monthOf(t.completedAt);if(done){const m=months.get(done)||{month:done,created:0,completed:0};m.completed++;months.set(done,m);}}
 const people=new Map();
 for(const t of tickets)for(const e of t.employees||[]){const p=people.get(e.name)||{label:e.name,tickets:0,loggedHours:0};p.tickets++;p.loggedHours=sum(p.loggedHours,numberOf(e.hours));people.set(e.name,p);}
 return {
  kpis:{
   tickets:tickets.length,
   open:tickets.filter(t=>!t.closed).length,
   closed:tickets.filter(t=>t.closed).length,
   withAgreed:withAgreed.length,
   checkups,
   checkupRate:pct(checkups,withAgreed.length),
   agreedHours:agreedTotal,
   loggedOnAgreed,
   burnRate:pct(loggedOnAgreed,agreedTotal),
   loggedHours:sum(0,tickets.reduce((n,t)=>n+numberOf(t.loggedHours),0)),
   estimatedHours:sum(0,tickets.reduce((n,t)=>n+numberOf(t.estimatedHours),0)),
   actualHours:sum(0,tickets.reduce((n,t)=>n+numberOf(t.actualHours),0)),
   noAgreed:tickets.length-withAgreed.length
  },
  burn:BURN_BUCKETS.map(([label,from,to])=>({label,tickets:burn.filter(p=>p>=from&&p<to).length})),
  flags:[['overage','Needs checkup'],['ok','Within agreed hours'],[null,'No agreed hours']].map(([value,label])=>({label,tickets:tickets.filter(t=>(t.overage??null)===value).length})),
  byClient:breakdown(tickets,t=>t.clientName||'Client not set'),
  byBilling:breakdown(tickets,t=>t.billing||'Not set'),
  byOdoo:breakdown(tickets,t=>t.odooStatus||'Not set'),
  byEmployee:[...people.values()].sort((a,b)=>b.loggedHours-a.loggedHours||a.label.localeCompare(b.label)),
  byMonth:[...months.values()].sort((a,b)=>a.month.localeCompare(b.month))
 };
}
