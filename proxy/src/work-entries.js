// The work view of Clients & projects (administrators): every Odoo timesheet line in a period as one flat row, across
// projects. A line counts once, whether the dashboard or Odoo entered it. Work the dashboard has not sent to Odoo yet (an
// entry with no Odoo line id) is listed apart, so its hours never mix with the Odoo hours. The period and the client,
// project and search conditions go into the Odoo query, so limits and pages only see matching lines; totals and the export
// cover every matching line.
import { odoo } from './odoo.js';
import { BusinessError, readOdooProjects } from './ticket-metadata.js';
import { billingSnapshot, readBillingConfig, effectiveBilling, valueOfTask, workRows } from './billing.js';
import { todayIn } from './time-entries.js';
import { companyContext } from './project-budget.js';
import { workPeriod, recordLink, billingOf } from './project-work.js';

const problem=(message,status=400,code='work_entries')=>{throw new BusinessError(message,status,code);};
const round=n=>Math.round(n*100)/100;
const m2o=v=>Array.isArray(v)?{id:v[0],name:String(v[1]||'')}:null;
const TICKET_TASK=/^\[([A-Z][A-Z0-9_]*-\d+)\]/;
// Every matching line is read to total it; more than this is cut, and the response says so.
export const ENTRY_LIMIT=20000,DEFAULT_LIMIT=50,MAX_LIMIT=200;

const intParam=(v,d)=>v==null||v===''?d:/^\d+$/.test(String(v))?Number(v):problem('Invalid paging.');
const optId=(v,what)=>{if(v==null||v==='')return null;if(!/^\d+$/.test(String(v))||Number(v)<1)problem('Choose a '+what+'.');return Number(v);};
// Search text is matched as plain text: Odoo's wildcards are dropped.
const searchText=v=>String(v||'').replace(/[%_\\]/g,' ').trim().slice(0,200);

// The totals of a set of rows: the number of entries, their hours, and the hours and count that are billable.
export function totalsOf(rows){
  let hours=0,billableHours=0,billableCount=0;
  for(const r of rows){hours+=r.hours;if(r.billing.value==='billable'){billableHours+=r.hours;billableCount++;}}
  return {count:rows.length,hours:round(hours),billableCount,billableHours:round(billableHours)};
}

// The Odoo lines of the period, with the filters the request names, as flat rows. q: period, from, to, client, project,
// search, billable ('1' for billable only), offset, limit, export ('1' for every matching row, no page). now: the clock.
export async function listWorkEntries(env,q,{now=new Date()}={}){
  const today=todayIn(now),period=workPeriod(q,today);
  const exporting=q.export==='1',billable=q.billable==='1';
  const offset=intParam(q.offset,0),limit=Math.min(intParam(q.limit,DEFAULT_LIMIT),MAX_LIMIT);
  if(limit<1)problem('Choose how many entries to show.');
  const clientId=optId(q.client,'client'),projectId=optId(q.project,'project'),search=searchText(q.search);

  const [context,billing,snap,projects]=await Promise.all([companyContext(env),readBillingConfig(env),billingSnapshot(env,{from:period.from,to:period.to}),readOdooProjects(env)]);
  const known=new Map((projects.projects||[]).map(p=>[p.id,p]));
  // The projects in scope: the client's (or every mapped project), narrowed to the chosen project.
  let scope=[...known.values()].filter(p=>clientId==null||p.clientId===clientId).map(p=>p.id);
  if(projectId!=null)scope=scope.filter(id=>id===projectId);
  const clientOf=pid=>{const p=known.get(pid);return {id:p?.clientId??null,name:p?.clientName||''};};
  const projectName=(pid,fallback='')=>known.get(pid)?.name||fallback;

  let entries=[],truncated=false,allRows=[];
  if(scope.length){
    const conds=[['date','>=',period.from],['date','<=',period.to],['project_id','in',scope]];
    if(search){
      // A line matches its own text, or a task whose name matches.
      const hits=await odoo(env,'project.task','search_read',[[['project_id','in',scope],['name','ilike',search]]],{fields:['id'],context:{...context,active_test:false},limit:ENTRY_LIMIT});
      conds.unshift('|',['name','ilike',search],['task_id','in',hits.map(t=>t.id)]);
    }
    const lines=await odoo(env,'account.analytic.line','search_read',[conds],{fields:['date','unit_amount','name','task_id','user_id','project_id'],order:'date desc, id desc',limit:ENTRY_LIMIT+1,context});
    truncated=lines.length>ENTRY_LIMIT;if(truncated)lines.length=ENTRY_LIMIT;
    // The tasks of these lines: a ticket's key and the value of its billing field.
    const taskIds=[...new Set(lines.map(l=>m2o(l.task_id)?.id).filter(Boolean))];
    const fields=['name',...(billing.fields.task?[billing.fields.task]:[])];
    const tasks=taskIds.length?await odoo(env,'project.task','search_read',[[['id','in',taskIds]]],{fields,context:{...context,active_test:false},limit:taskIds.length}):[];
    const info=new Map(tasks.map(t=>{const name=String(t.name||''),v=billing.fields.task?valueOfTask(billing,t):undefined;
      return [t.id,{id:t.id,name,key:TICKET_TASK.exec(name)?.[1]||null,override:v===undefined?null:v}];}));
    // A line's billing: its task's (a ticket's is the dashboard's), else the project's default; a line with no task uses the
    // project's default and says so.
    const billOf=(pid,tid)=>{
      if(tid==null)return effectiveBilling(snap.projectDefault(pid),null);
      return billingOf(env,snap,pid,info.get(tid)||{key:null,override:null});
    };
    allRows=lines.map(l=>{const p=m2o(l.project_id),t=m2o(l.task_id),pid=p?.id??null,ti=t&&info.get(t.id);
      return {id:l.id,date:l.date,hours:round(Number(l.unit_amount)||0),description:String(l.name||''),person:m2o(l.user_id)?.name||'',
        client:clientOf(pid),project:{id:pid,name:projectName(pid,p?.name||'')},
        task:t?{id:t.id,name:ti?.name||t.name,key:ti?.key||null,url:recordLink(env,'project.task',t.id)}:null,
        billing:billOf(pid,t?.id??null),url:recordLink(env,'account.analytic.line',l.id),source:'odoo'};});
    if(billable)allRows=allRows.filter(r=>r.billing.value==='billable');
  }
  const totals=totalsOf(allRows);
  entries=exporting?allRows:allRows.slice(offset,offset+limit);

  // The dashboard's work not in Odoo yet: an entry with no Odoo line. Entries that have a line are the Odoo lines above.
  const needle=search.toLowerCase();
  const pendingRows=workRows(env,snap.d).filter(r=>r.kind==='entry'&&!r.lineId).filter(r=>{
    const pid=r.projectId??null;
    if(clientId!=null||projectId!=null){if(pid==null||!scope.includes(pid))return false;}
    if(billable&&r.billing.value!=='billable')return false;
    if(needle&&![r.description,r.title,r.ticket].some(s=>String(s||'').toLowerCase().includes(needle)))return false;
    return true;
  }).map(r=>({id:r.chargeId,date:r.date,hours:round(r.actualMinutes/60),description:r.description,person:r.worker,
    client:clientOf(r.projectId??null),project:{id:r.projectId??null,name:projectName(r.projectId??null)},
    task:{id:null,name:r.title,key:r.ticket,url:null},billing:r.billing,source:'dashboard'}));
  const pending={totals:totalsOf(pendingRows),entries:pendingRows};

  const warnings=[];
  if(truncated)warnings.push('Only the first '+ENTRY_LIMIT+' entries of this period are totalled. Choose a shorter period or a narrower filter.');
  return {period,filters:{client:clientId,project:projectId,search,billable},totals,entries,
    offset:exporting?0:offset,limit:exporting?allRows.length:limit,nextOffset:!exporting&&offset+limit<allRows.length?offset+limit:null,
    pending,truncated,warnings};
}
