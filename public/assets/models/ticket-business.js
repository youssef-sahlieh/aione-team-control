export const INTERNAL_ASSIGNEE='__internal_tickets';
export const SORT_FIELDS=new Set(['key','summary','assigneeName','reporter','developers','status','due','created','updated','clientName','subClientName','estimatedHours','actualHours','workDone','billing','prs']);
export function validSort(sort,admin=false){return !!sort&&SORT_FIELDS.has(sort.field)&&['asc','desc'].includes(sort.direction)&&(admin||sort.field!=='billing');}
export function sortTickets(items,sort,admin=false){
  if(!validSort(sort,admin))return items.slice();
  const value=t=>sort.field==='developers'?t.devs?.join(', '):sort.field==='prs'?t.prRank:t[sort.field];
  return items.slice().sort((a,b)=>{let x=value(a),y=value(b);const missing=v=>v===null||v===undefined||v==='';if(missing(x)||missing(y))return missing(x)===missing(y)?a.key.localeCompare(b.key,undefined,{numeric:true}):missing(x)?1:-1;
    let n;if(['estimatedHours','actualHours','prs'].includes(sort.field))n=x-y;else if(['created','updated','due'].includes(sort.field))n=Date.parse(x)-Date.parse(y);else n=String(x).localeCompare(String(y),undefined,{numeric:true,sensitivity:'base'});
    return (sort.direction==='desc'?-n:n)||a.key.localeCompare(b.key,undefined,{numeric:true});});
}
export function csvCell(value){let s=String(value??'');if(/^[\s]*[=+@-]/.test(s)||/^[\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
export function reportCsv(report){const headers=['Ticket','Title','Client','Sub-client','Billing','Estimated hours','Actual hours','Work done','Status','Created','Completed','Missing fields','Risks','Hours over estimate','Percent over estimate','Override reasons'];return [headers,...report.tickets.map(t=>[t.key,t.title,t.clientName,t.subClientName,t.billing,t.estimatedHours,t.actualHours,t.workDone,t.status,t.created,t.completedAt,t.missing.join('; '),t.risks.join('; '),t.overEstimate?.hours,t.overEstimate?.percent,t.overrides.map(o=>o.reason).join('; ')])].map(r=>r.map(csvCell).join(',')).join('\r\n');}
export const createdDate=value=>value?new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Jerusalem',day:'2-digit',month:'short',year:'numeric'}).format(new Date(value)):'';
