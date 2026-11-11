// The work of a project in Odoo, for the Clients & projects workspace (administrators): the timesheet lines entered in
// Odoo rather than sent by the dashboard, grouped by the Odoo task they are on. A line the dashboard sent carries its
// entry id (the entry field of the time settings) and is left out, so each hour counts once. A task named "[KEY] …" is a
// ticket: its dashboard figures are the ticket row's, and only the lines entered in Odoo alone show here, with the key.
// Periods are whole days in Asia/Jerusalem, both ends included. Figures cover every matching line, not one page: a page
// of entries is only the list, its totals are the period's.
import { odoo } from './odoo.js';
import { BusinessError } from './ticket-metadata.js';
import { billingSnapshot, readBillingConfig, effectiveBilling, valueOfTask } from './billing.js';
import { readConfig as readTimeConfig, sourceOf, todayIn } from './time-entries.js';
import { companyContext } from './project-budget.js';

const problem=(message,status=400,code='project_work')=>{throw new BusinessError(message,status,code);};
const round=n=>Math.round(n*100)/100;
const m2o=v=>Array.isArray(v)?{id:v[0],name:String(v[1]||'')}:null;
const TICKET_TASK=/^\[([A-Z][A-Z0-9_]*-\d+)\]/;
// Every line of a period is read to total it; more than this is cut, and the response says so.
const LINE_LIMIT=20000,DEFAULT_LIMIT=50,MAX_LIMIT=200;
// "All dates" starts here: the dashboard keeps no work before it, and the months are read one by one.
export const ALL_FROM='2020-01-01';
export const PERIODS={month:'This month',last_month:'Last month',last_30:'Last 30 days',all:'All dates',custom:'Custom dates'};

export const addDays=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export const validDate=d=>{if(typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d))return false;const t=Date.parse(d+'T00:00:00Z');return !Number.isNaN(t)&&new Date(t).toISOString().slice(0,10)===d;};
const monthStart=d=>d.slice(0,8)+'01';
const monthEnd=d=>{const x=new Date(Date.parse(monthStart(d)+'T00:00:00Z'));x.setUTCMonth(x.getUTCMonth()+1,0);return x.toISOString().slice(0,10);};

// The period a request asks for: this month (the default), last month, the last 30 days, all dates, or custom dates
// (both ends needed, at most about a year apart, the start not after the end).
export function workPeriod(q,today){
  const key=String(q.period||'month');
  if(!Object.hasOwn(PERIODS,key))problem('Choose a work period.');
  const named=(from,to)=>({key,from,to,label:PERIODS[key]+' ('+from+' to '+to+')'});
  if(key==='month')return named(monthStart(today),monthEnd(today));
  if(key==='last_month'){const first=monthStart(addDays(monthStart(today),-1));return named(first,monthEnd(first));}
  if(key==='last_30')return named(addDays(today,-29),today);
  if(key==='all')return named(ALL_FROM,today);
  const {from,to}=q;
  if(!validDate(from)||!validDate(to))problem('Choose valid dates.');
  if(from>to)problem('The start date is after the end date.');
  if(Date.parse(to)-Date.parse(from)>400*86400000)problem('Choose at most about a year.');
  return named(from,to);
}

const recordLink=(env,model,id)=>String(env.ODOO_URL||'').replace(/\/+$/,'')+'/web#id='+id+'&model='+model+'&view_type=form';
const intParam=(v,d)=>v==null||v===''?d:/^\d+$/.test(String(v))?Number(v):problem('Invalid paging.');

// Every task of the project (archived ones too, their lines still count): its ticket key if it has one, and the value of
// its billing field when the project maps one.
async function projectTasks(env,id,context,billing){
  const field=billing.fields.task,rows=await odoo(env,'project.task','search_read',[[['project_id','=',id]]],{fields:['name',...(field?[field]:[])],context:{...context,active_test:false},limit:20000});
  return new Map(rows.map(t=>{const name=String(t.name||''),v=field?valueOfTask(billing,t):undefined;
    return [t.id,{id:t.id,name,key:TICKET_TASK.exec(name)?.[1]||null,override:v===undefined?null:v}];}));
}
// A task's billing: a ticket's is the dashboard's (its override, else the project's default); an Odoo task's is its own
// billing field, else the project's default.
function billingOf(env,snap,projectId,task){
  let override=task.override;
  if(task.key&&sourceOf(env,task.key)){
    const rec=sourceOf(env,task.key)==='odoo'?snap.d.tickets[task.key]:snap.d.metas.get(task.key);
    override=rec?.billing??null;
  }
  return effectiveBilling(snap.projectDefault(projectId),override);
}
// The line domain: this project's lines in the period, without the dashboard's (when its entry field is known), and
// on the given tasks when a filter names them.
function lineDomain(id,period,entryField,taskIds){
  const d=[['project_id','=',id],['date','>=',period.from],['date','<=',period.to]];
  if(entryField)d.push([entryField,'=',false]);
  if(taskIds)d.push(['task_id','in',taskIds]);
  return d;
}

// The Odoo work of a project in a period: its tasks with their hours and billing, the unassigned hours, and one page of
// entries (newest first). With billable, only the tasks that are billable count (unassigned work is not billable).
export async function projectWork(env,id,q){
  const today=todayIn(),period=workPeriod(q,today),billable=q.billable==='1';
  const offset=intParam(q.offset,0),limit=Math.min(intParam(q.limit,DEFAULT_LIMIT),MAX_LIMIT);
  if(limit<1)problem('Choose how many entries to show.');
  const [context,billing,time,snap]=await Promise.all([companyContext(env),readBillingConfig(env),readTimeConfig(env).catch(()=>({fields:{}})),billingSnapshot(env,{from:period.from,to:period.to})]);
  const [project]=await odoo(env,'project.project','search_read',[[['id','=',id]]],{fields:['name'],limit:1,context:{...context,active_test:false}});
  if(!project)problem('That Odoo project was not found.',404,'not_found');
  const tasks=await projectTasks(env,id,context,billing),info=new Map();
  for(const t of tasks.values())info.set(t.id,{...t,billing:billingOf(env,snap,id,t)});
  const taskIds=billable?[...info.values()].filter(t=>t.billing.value==='billable').map(t=>t.id):null;
  const entryField=time.fields?.entryUuid||'';
  const domain=lineDomain(id,period,entryField,taskIds);
  // Totals: every matching line, read once with only what they need.
  const lines=await odoo(env,'account.analytic.line','search_read',[domain],{fields:['unit_amount','task_id'],context,limit:LINE_LIMIT+1});
  const truncated=lines.length>LINE_LIMIT;if(truncated)lines.length=LINE_LIMIT;
  const perTask=new Map();let hours=0,unassigned={hours:0,count:0};
  for(const l of lines){
    const h=Number(l.unit_amount)||0,t=m2o(l.task_id);hours+=h;
    if(!t){unassigned.hours+=h;unassigned.count++;continue;}
    const e=perTask.get(t.id)||{hours:0,count:0};e.hours+=h;e.count++;perTask.set(t.id,e);
  }
  const taskRows=[...perTask].map(([tid,e])=>{const t=info.get(tid)||{id:tid,name:'',key:null,billing:effectiveBilling(snap.projectDefault(id),null)};
    return {id:tid,name:t.name||'Task #'+tid,key:t.key,url:recordLink(env,'project.task',tid),hours:round(e.hours),count:e.count,billing:t.billing};})
    .sort((a,b)=>b.hours-a.hours||a.name.localeCompare(b.name));
  // One page of entries, newest first; one extra line tells whether there is a next page.
  const page=await odoo(env,'account.analytic.line','search_read',[domain],{fields:['date','unit_amount','name','task_id','user_id'],order:'date desc, id desc',offset,limit:limit+1,context});
  const more=page.length>limit;
  const entries=page.slice(0,limit).map(l=>{const t=m2o(l.task_id),known=t&&info.get(t.id);
    return {id:l.id,date:l.date,hours:round(Number(l.unit_amount)||0),description:String(l.name||''),person:m2o(l.user_id)?.name||'',url:recordLink(env,'account.analytic.line',l.id),
      task:t?{id:t.id,name:known?.name||t.name,key:known?.key||null,url:recordLink(env,'project.task',t.id)}:null};});
  const warnings=[];
  if(!entryField)warnings.push('The dashboard’s entry field is not set in the time settings, so work the dashboard sent may be counted here too.');
  if(truncated)warnings.push('Only the first '+LINE_LIMIT+' entries of this period are totalled. Choose a shorter period.');
  return {project:{odooId:id,name:String(project.name||'')},period,billable,
    totals:{hours:round(hours),count:lines.length},unassigned:{hours:round(unassigned.hours),count:unassigned.count},
    tasks:taskRows,entries,offset,limit,nextOffset:more?offset+limit:null,warnings};
}
