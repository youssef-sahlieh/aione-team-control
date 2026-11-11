import { DEFAULT_VIEW, DEFAULT_WORK, WORK_PERIODS, WORK_MODES, customPeriodError, workQuery, ORIGIN, PAGE_SIZES, SOURCE, OVERRIDE, EFFECTIVE, STATUS_FILTERS, PROBLEM_FILTERS, SORTS, ticketView, ticketTotals, ticketProblems, syncLabel, commercialHours, actualHours, developers, hiddenCount, minutesHours,
  PROJECT_COLUMNS, TICKET_COLUMNS, projectSheetRows, ticketSheetRows, sheetColumns, csvFile, fileSlug, importBody, reportRows, retryBody, changeLine, templateSheets, RESULT } from '../models/project-workspace.js';
import { hours, signedHours } from '../models/odoo-projects.js';
import { entryCsvRows } from '../models/billing.js';
import { buildWorkbook } from '../models/xlsx-write.js';
import { readTableFile } from '../models/table-import.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const button=(text,fn,cls='btn')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const option=(select,label,value)=>select.append(new Option(label,value));
const labelled=(text,node)=>{const l=el('label','business-field');l.append(el('span','',text),node);return l;};
const pick=(label,options,value='')=>{const s=el('select','fsel');s.setAttribute('aria-label',label);for(const [v,l] of options)option(s,l,v);s.value=value;return s;};
const h=n=>n==null||n===''?'—':hours(n);
const XLSX='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function download(name,data,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type}));a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
const today=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Jerusalem'});

// The project billing workspace in a Clients & projects row (administrators): the project's description, its tickets with
// their billing and hours, and Export / Import. It loads when the row is first opened. Its state (filters, page, selection,
// scroll, the tickets read) is kept per project here, so redrawing the table or opening a ticket's drawer keeps it.
// ctx: api, dialog, openIssue, createTicket(anchor,{odooProjectId,onCreated}), say, changed(keys) (the dashboard's ticket
// refresh), projectsChanged() (the Clients table's figures), projects() (the table's rows), editAllocation().
// The work period, the billable filter and the ticket mode are read by the server (work) with the page; a change reads again.
const ENTRY_PAGE=25;
const states=new Map();
const stateOf=id=>{if(!states.has(id))states.set(id,{view:{...DEFAULT_VIEW},data:null,loading:null,error:null,selected:new Set(),scroll:0,work:{...DEFAULT_WORK},odoo:{data:null,error:null,loading:null},filtersOpen:false,more:false,draw:null});return states.get(id);};
// After tickets changed elsewhere (the drawer, the work log, a new ticket): reload the workspaces that list them.
export function workspaceTicketsChanged(keys,{reload=true}={}){
  const hit=[];for(const [id,s] of states)if(s.data&&(s.expect?.size||keys.some(k=>s.data.tickets.some(t=>t.key===k))))hit.push(id);
  // A workspace already reading started after the change, so its answer is fresh.
  if(reload)for(const id of hit)if(!states.get(id).loading)load(id).catch(()=>{});
  return hit;
}
// After a project's billing default changed or Odoo was synced: the open workspaces re-read their tickets, so the
// effective billing shown is the saved one (a workspace that has never been opened has nothing to reload).
export function reloadProjectWorkspaces(ids=null){
  const hit=[...states].filter(([id,s])=>s.data&&(!ids||ids.includes(id))).map(([id])=>id);
  return Promise.all(hit.map(id=>load(id).catch(()=>{})));
}
let api=null;
async function load(id){
  const s=stateOf(id);if(s.work.period==='custom'&&customPeriodError(s.work.from,s.work.to))return;
  const q=workQuery(s.work);q.set('id',String(id));
  const p=s.loading=api('/clients/odoo-projects/tickets?'+q);s.error=null;s.draw?.();
  loadWork(id).catch(()=>{});
  try{const d=await p;if(s.loading!==p)return;s.data=d;s.expect?.clear();const keys=new Set(d.tickets.map(t=>t.key));for(const k of [...s.selected])if(!keys.has(k))s.selected.delete(k);}
  catch(err){if(s.loading===p)s.error=err;}
  finally{if(s.loading===p){s.loading=null;s.draw?.();}}
}
// The work logged in Odoo in the same period: one page of entries (more: the next page, added to the list).
async function loadWork(id,more=false){
  const s=stateOf(id),o=s.odoo;if(s.work.period==='custom'&&customPeriodError(s.work.from,s.work.to))return;
  const q=workQuery(s.work);q.set('id',String(id));q.set('limit',String(ENTRY_PAGE));
  if(more&&o.data?.nextOffset!=null)q.set('offset',String(o.data.nextOffset));
  const p=o.loading=api('/clients/odoo-projects/work?'+q);o.error=null;s.draw?.();
  try{const d=await p;if(o.loading!==p)return;o.data=more&&o.data?{...d,entries:[...o.data.entries,...d.entries]}:d;}
  catch(err){if(o.loading===p)o.error=err;}
  finally{if(o.loading===p){o.loading=null;s.draw?.();}}
}
export function mountProjectWorkspace(cell,p,ctx){
  api=ctx.api;
  const s=stateOf(p.odooId),box=el('section','ws');box.setAttribute('aria-label','Tickets and billing of '+p.name);cell.append(box);
  const desc=el('div','ws-desc'),bar=el('div','ws-bar'),filters=el('div','ws-filters'),note=el('div','ws-note'),totals=el('div','ws-totals'),wrap=el('div','table-wrap ws-wrap'),pager=el('div','budget-pager');
  filters.id='ws-filters-'+p.odooId;
  const scope=el('div','ws-scope-bar'),work=el('section','ws-work');work.setAttribute('aria-label','Work logged in Odoo on '+p.name);
  box.append(desc,bar,scope,filters,note,totals,wrap,pager,work);
  wrap.addEventListener('scroll',()=>{s.scroll=wrap.scrollLeft;},{passive:true});
  const v=s.view;
  // Search, Filters and the sort stay in view; a new search or filter starts again from the first page.
  const search=el('input','inp ws-search');search.type='search';search.value=v.q;search.placeholder='Search tickets, titles, people';search.setAttribute('aria-label','Search the tickets of '+p.name);
  search.addEventListener('input',()=>{v.q=search.value;v.page=0;draw();});
  const sortSel=pick('Sort tickets',Object.entries(SORTS).flatMap(([k,l])=>[[k+':1',l+(k==='key'||k==='title'||k==='status'?', A–Z':', low to high')],[k+':-1',l+(k==='key'||k==='title'||k==='status'?', Z–A':', high to low')]]),v.sort+':'+v.dir);
  sortSel.addEventListener('change',()=>{const [k,d]=sortSel.value.split(':');v.sort=k;v.dir=Number(d);v.page=0;draw();});
  const filtersBtn=button('Filters',()=>{s.filtersOpen=!s.filtersOpen;draw();},'btn');filtersBtn.setAttribute('aria-controls',filters.id);
  const actions=el('div','ws-actions');
  const create=button('+ Create ticket',e=>ctx.createTicket(e.currentTarget,{odooProjectId:p.odooId,onCreated:key=>{(s.expect||=new Set()).add(key);ctx.say(key+' created on “'+p.name+'”.');load(p.odooId).then(()=>ctx.projectsChanged());}}),'btn');
  create.disabled=!p.assignable;if(!p.assignable)create.title=(p.blocked||'Not in the last sync from Odoo.')+' Tickets cannot be given this project.';
  actions.append(create,button('Export…',e=>exportDialog(e.currentTarget,p,s,ctx),'btn'),button('Import…',e=>importDialog(e.currentTarget,p,ctx),'btn'),Object.assign(button('↻',()=>load(p.odooId),'btn'),{title:'Read the tickets again'}));
  actions.lastChild.setAttribute('aria-label','Refresh the tickets of '+p.name);
  bar.append(search,filtersBtn,sortSel,actions);
  // The work period (this month by default), the billable filter and which tickets to show. Dates are checked here first:
  // an incomplete or reversed custom period is said in words and not read.
  const w=s.work,per=pick('Work period',Object.entries(WORK_PERIODS),w.period),mode=pick('Tickets to show',Object.entries(WORK_MODES),w.mode);
  const fromIn=el('input','inp'),toIn=el('input','inp'),custom=el('span','ws-custom'),periodErr=el('p','msg err ws-period-err'),billable=el('input'),billLabel=el('label','ws-check');
  fromIn.type=toIn.type='date';fromIn.value=w.from;toIn.value=w.to;fromIn.setAttribute('aria-label','Work period from');toIn.setAttribute('aria-label','Work period to');
  billable.type='checkbox';billable.checked=w.billable;billLabel.append(billable,' Only billable tickets');
  custom.append(labelled('From',fromIn),labelled('To',toIn));
  const readWork=()=>{drawScope();if(w.period==='custom'&&customPeriodError(w.from,w.to))return;v.page=0;load(p.odooId);};
  per.addEventListener('change',()=>{w.period=per.value;readWork();});
  fromIn.addEventListener('change',()=>{w.from=fromIn.value;readWork();});
  toIn.addEventListener('change',()=>{w.to=toIn.value;readWork();});
  billable.addEventListener('change',()=>{w.billable=billable.checked;readWork();});
  mode.addEventListener('change',()=>{w.mode=mode.value;readWork();});
  scope.append(labelled('Work period',per),custom,billLabel,labelled('Tickets to show',mode),periodErr);
  function drawFilters(){
    const t=s.data?.tickets||[];filters.hidden=!s.filtersOpen;filtersBtn.setAttribute('aria-expanded',String(s.filtersOpen));const n=hiddenCount(v);filtersBtn.textContent=n?'Filters ('+n+')':'Filters';
    if(!s.filtersOpen)return;
    const sel=(label,key,options)=>{const x=pick(label,options,v[key]);x.addEventListener('change',()=>{v[key]=x.value;v.page=0;draw();});return labelled(label,x);};
    filters.replaceChildren(sel('Status','status',[['','Open and closed'],...Object.entries(STATUS_FILTERS)]),sel('Developer','dev',[['','Any developer'],...developers(t).map(d=>[d,d])]),sel('Source','source',[['','Any source'],...Object.entries(SOURCE)]),
      sel('Billing','billing',[['','Any billing'],...Object.entries(EFFECTIVE).map(([k,l])=>[k,'Effective: '+l]),['inherit','Override: inherits the project'],...Object.entries(OVERRIDE).map(([k,l])=>['override:'+k,'Override: '+l])]),
      sel('Sync & setup','problems',[['','Any'],...Object.entries(PROBLEM_FILTERS)]),
      button('Clear filters',()=>{Object.assign(v,{status:'',dev:'',source:'',billing:'',problems:'',page:0});draw();},'linkbtn'),
);
  }
  function drawDesc(){
    const text=s.data?.project.description||'';desc.replaceChildren();if(!text)return;
    const body=el('p','ws-desc-text'+(s.more?' open':''),s.more||text.length<=240?text:text.slice(0,240)+'…');body.dir='auto';desc.append(body);
    if(text.length>240){const b=button(s.more?'Show less':'Show more',()=>{s.more=!s.more;drawDesc();},'linkbtn');b.setAttribute('aria-expanded',String(s.more));desc.append(b);}
  }
  // The period's dates: a custom period says what is wrong with it, and the other choices say nothing.
  function drawScope(){custom.hidden=w.period!=='custom';const bad=w.period==='custom'?customPeriodError(w.from,w.to):'';periodErr.hidden=!bad;periodErr.textContent=bad;}
  const billingText=b=>(EFFECTIVE[b?.value]||'Not classified')+(b?.source?' · '+(ORIGIN[b.source]||''):'');
  const odooLink=(url,label)=>{const td=el('td'),a=el('a','linkbtn ws-odoo-link','Open in Odoo');a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.setAttribute('aria-label','Open '+label+' in Odoo (new tab)');td.append(a);return td;};
  // The work logged in Odoo: its totals, its tasks with their billing (read here: Odoo's billing field sets it), the work on no
  // task, and the entries page by page. Its hours are not added to the tickets above: the dashboard's work is there.
  function drawWork(){
    const o=s.odoo,d=o.data;work.replaceChildren(el('h3','ws-work-title','Work logged in Odoo'));
    if(!d){if(o.error){const m=el('p','msg err','Couldn’t read the Odoo work: '+(o.error.message||o.error)+' ');m.append(button('Retry',()=>loadWork(p.odooId),'btn'));work.append(m);}else work.append(el('p','msg','Loading the Odoo work…'));return;}
    const head=el('p','ws-scope');head.append(el('strong','',hours(d.totals.hours)+' in '+d.totals.count+(d.totals.count===1?' entry':' entries')),document.createTextNode(' · '+d.period.label+(d.billable?' · billable tasks only':'')));
    work.append(head,el('p','budget-sub','Entries logged directly in Odoo. Work the dashboard sent is in the ticket rows above, so no hours are counted twice.'));
    if(o.loading)work.append(el('p','msg','Refreshing…'));
    if(o.error)work.append(el('p','msg err','Couldn’t refresh the Odoo work: '+(o.error.message||o.error)));
    for(const x of d.warnings)work.append(el('p','business-guidance',x));
    if(!d.totals.count){work.append(el('p','business-guidance','No work logged in Odoo in this period'+(d.billable?' on billable tasks':'')+'.'));return;}
    const tw=el('div','table-wrap ws-work-wrap'),table=el('table','budget-table ws-table ws-work-table'),tb=el('tbody'),hr=el('tr');
    table.append(el('thead'),tb);table.tHead.append(hr);
    for(const c of ['Task','Hours','Entries','Billing','Odoo'])hr.append(Object.assign(el('th','',c),{scope:'col'}));
    for(const t of d.tasks){
      const name=el('td'),nm=el('span','',(t.key?t.key+' · ':'')+t.name);nm.dir='auto';name.append(nm);
      const tr=el('tr');tr.append(name,el('td','num',h(t.hours)),el('td','num',String(t.count)),el('td','',billingText(t.billing)),odooLink(t.url,'task '+t.name));tb.append(tr);
    }
    if(d.unassigned.count){const tr=el('tr','ws-unassigned');tr.append(el('td','','Unassigned work (no task)'),el('td','num',h(d.unassigned.hours)),el('td','num',String(d.unassigned.count)),el('td','','Not billable'),el('td','','—'));tb.append(tr);}
    tw.append(table);work.append(tw);
    work.append(el('h4','ws-work-sub','Entries'));
    const ew=el('div','table-wrap ws-work-wrap'),et=el('table','budget-table ws-table ws-work-table'),eb=el('tbody'),eh=el('tr');
    et.append(el('thead'),eb);et.tHead.append(eh);
    for(const c of ['Date','Hours','Task','Person','Description','Odoo'])eh.append(Object.assign(el('th','',c),{scope:'col'}));
    for(const e of d.entries){
      const desc=el('td','ws-desc-cell',e.description);desc.dir='auto';
      const task=e.task?(e.task.key?e.task.key+' · ':'')+e.task.name:'Unassigned';
      const tr=el('tr');tr.append(el('td','',e.date),el('td','num',h(e.hours)),el('td','',task),el('td','',e.person||'—'),desc,odooLink(e.url,'entry of '+e.date));eb.append(tr);
    }
    ew.append(et);work.append(ew,el('p','budget-sub','Showing '+d.entries.length+' of '+d.totals.count+' entries'));
    if(d.nextOffset!=null){const b=button(o.loading?'Loading…':'Load more entries',()=>loadWork(p.odooId,true),'btn');b.disabled=!!o.loading;work.append(b);}
  }
  function draw(){
    drawFilters();drawDesc();drawScope();drawWork();note.replaceChildren();totals.replaceChildren();pager.replaceChildren();
    if(!s.data){wrap.replaceChildren();
      if(s.error){const m=el('p','msg err','Couldn’t read the tickets: '+(s.error.message||s.error)+' ');m.append(button('Retry',()=>load(p.odooId),'btn'));note.append(m);}
      else note.append(el('p','msg','Loading tickets…'));return;}
    const d=s.data;
    if(s.loading)note.append(el('p','msg','Refreshing…'));
    if(s.error){const m=el('p','msg err','Couldn’t refresh: '+(s.error.message||s.error)+' ');m.append(button('Retry',()=>load(p.odooId),'btn'));note.append(m);}
    if(d.detailsError)note.append(el('p','msg err',d.detailsError+' Figures are still right.'));
    if(d.truncated)note.append(el('p','msg err','Showing the first '+d.limit+' of '+d.total+' tickets. Export all projects for the rest.'));
    if(!d.tickets.length){wrap.replaceChildren(el('p','business-guidance','No tickets on this project yet ('+d.scope.label.toLowerCase()+'). Create one, or give tickets this project with Map tickets.'));return;}
    const view=ticketView(d.tickets,v),all=ticketTotals(view.matching),sel=d.tickets.filter(t=>s.selected.has(t.key)),st=ticketTotals(sel);v.page=view.page;
    const line=el('p','ws-scope');line.append(el('strong','',(view.matching.length===d.tickets.length?d.tickets.length+' tickets':view.matching.length+' of '+d.tickets.length+' tickets')+' · '+all.open+' open'),
      document.createTextNode(' · Actual '+hours(all.actualHours)+' · Commercial '+hours(all.commercialHours)+' · Agreed '+hours(all.agreedHours)+' · Estimated '+hours(all.estimatedHours)));
    line.title='Every ticket matching the filters, on all pages. Commercial is what the work charges: agreed hours once, else billable work.';
    // Actual and commercial hours are for the period; consumed is lifetime, so it is named apart and not limited to the period.
    const lifetime=d.tickets.reduce((n,t)=>n+(t.consumedMinutes||0),0);
    totals.append(line,el('p','budget-sub','Hours for '+d.scope.label.toLowerCase()+'. Lifetime, not limited to the period: consumed '+hours(minutesHours(lifetime))+' h on these tickets.'));
    const unclassified=d.tickets.filter(t=>t.effective?.value==='unclassified').length;
    if(unclassified)note.append(el('p','business-guidance',unclassified+(unclassified===1?' ticket has':' tickets have')+' no billing: the project is not classified and the ticket has no override. Set the project’s billing default to fix them.'));
    if(sel.length){const b=el('p','ws-selected',sel.length+' selected · Actual '+hours(st.actualHours)+' · Commercial '+hours(st.commercialHours)+' · Agreed '+hours(st.agreedHours)+' ');b.append(button('Clear selection',()=>{s.selected.clear();draw();},'linkbtn'));totals.append(b);}
    if(!view.matching.length){const m=el('p','business-guidance','No tickets match. ');m.append(button('Clear search and filters',()=>{Object.assign(v,{q:'',status:'',dev:'',source:'',billing:'',problems:'',page:0});search.value='';draw();},'linkbtn'));wrap.replaceChildren(m);return;}
    const table=el('table','budget-table ws-table'),head=el('tr'),body=el('tbody');table.append(el('thead'),body);table.tHead.append(head);
    const all2=el('input');all2.type='checkbox';all2.setAttribute('aria-label','Select the tickets on this page');all2.checked=view.rows.every(t=>s.selected.has(t.key));
    all2.addEventListener('change',()=>{for(const t of view.rows)all2.checked?s.selected.add(t.key):s.selected.delete(t.key);draw();});
    const th0=el('th');th0.append(all2);head.append(th0);
    for(const c of ['Ticket','Title','Status','People','Billing','Est.','Agreed','Actual','Commercial','Odoo sync']){const th=el('th','',c);th.scope='col';head.append(th);}
    for(const t of view.rows)body.append(ticketRow(t,p,s,ctx,draw));
    wrap.replaceChildren(table);wrap.scrollLeft=s.scroll;
    if(view.matching.length>PAGE_SIZES[0]){
      const prev=button('← Previous',()=>{v.page--;draw();},'btn'),next=button('Next →',()=>{v.page++;draw();},'btn');prev.disabled=view.page===0;next.disabled=view.page>=view.pages-1;
      const size=pick('Tickets per page',PAGE_SIZES.map(n=>[String(n),n+' per page']),String(v.size));size.addEventListener('change',()=>{v.size=Number(size.value);v.page=0;draw();});
      pager.append(el('span','',(view.from+1)+'–'+(view.from+view.rows.length)+' of '+view.matching.length),prev,next,size);
    }
  }
  // Redraws after a read only while this copy is on the page; a redrawn table mounts a new one.
  const later=()=>{if(box.isConnected)draw();else if(s.draw===later)s.draw=null;};
  s.draw=later;draw();
  if(!s.data&&!s.loading)load(p.odooId);
}
function ticketRow(t,p,s,ctx,draw){
  const tr=el('tr','ws-row'+(t.closed?' closed':''));tr.dataset.key=t.key;
  const box=el('input');box.type='checkbox';box.checked=s.selected.has(t.key);box.setAttribute('aria-label','Select '+t.key);box.addEventListener('change',()=>{box.checked?s.selected.add(t.key):s.selected.delete(t.key);draw();});
  const c0=el('td');c0.append(box);
  const c1=el('td','ws-key');c1.append(button(t.key,()=>ctx.openIssue(t.key),'linkbtn'),el('span','ws-source ws-'+t.source,SOURCE[t.source]||t.source));
  if(!t.onProject)c1.append(el('span','budget-sub','Work here, ticket now on another project'));
  const c2=el('td','ws-title');const title=button(t.title||t.key,()=>ctx.openIssue(t.key),'linkbtn');title.dir='auto';c2.append(title);
  if(t.description){const dp=el('span','ws-preview',t.description);dp.dir='auto';dp.title=t.descriptionLength>t.description.length?'Open the ticket for the full description.':'';c2.append(dp);}
  const c3=el('td','',t.status||(t.closed?'Closed':'—'));
  const c4=el('td','ws-people');c4.append(el('span','',(t.devs||[]).length?'Developers: '+t.devs.join(', '):'—'));if(t.assignee)c4.append(el('span','budget-sub','Assignee: '+t.assignee));
  const c5=el('td','ws-billing'),bsel=pick('Billing of '+t.key,[['inherit','Inherits project: '+(EFFECTIVE[s.data?.project?.default]||'not classified')],...Object.entries(OVERRIDE)],t.override||'inherit');
  if(t.effective?.value==='unclassified')bsel.classList.add('ws-unclassified');
  bsel.addEventListener('change',async()=>{bsel.disabled=true;ctx.say('Saving the billing of '+t.key+'…');
    try{await ctx.api('/billing/ticket',{method:'PUT',body:{key:t.key,revision:t.revision,billing:bsel.value}});ctx.say('Billing saved for '+t.key+'. Its hours are recounted.');await refreshAfter([t.key],p,ctx);}
    catch(err){ctx.say(err.message||String(err),true);bsel.value=t.override||'inherit';bsel.disabled=false;}});
  c5.append(bsel);
  const c7=el('td','num ws-agreed');agreedCell(c7,t,p,ctx);
  const c9=el('td','num',hours(actualHours(t))+'');if(t.entries)c9.title=t.entries+' work '+(t.entries===1?'entry':'entries');
  const c10=el('td','num',hours(commercialHours(t)));c10.title='Consumed of the allocation, lifetime: '+hours(minutesHours(t.consumedMinutes));
  const probs=ticketProblems(t),c11=el('td','ws-sync'+(probs.length?' err':''),probs.length?syncLabel(t):'—');
  tr.append(c0,c1,c2,c3,c4,c5,el('td','num',h(t.estimatedHours)),c7,c9,c10,c11);
  return tr;
}
// Agreed hours, edited in place: they go to one of the ticket's developers (never its assignee), so with several the
// administrator picks one. The ticket's metadata is read first for its revision and developers.
function agreedCell(cell,t,p,ctx){
  cell.replaceChildren();
  const text=t.agreedHours==null?'—':hours(t.agreedHours)+(t.agreedDeveloper?' · '+t.agreedDeveloper:'');
  if(t.source==='odoo'||t.closed){cell.append(el('span','',text));if(t.source==='odoo')cell.title='Helpdesk tickets have no agreed hours.';return;}
  const b=button(text,()=>edit(),'linkbtn ws-agreed-btn');b.title='Edit the agreed hours';b.setAttribute('aria-label','Agreed hours of '+t.key+': '+text);cell.append(b);
  async function edit(){
    b.disabled=true;let r;try{r=await ctx.api('/ticket-metadata?key='+encodeURIComponent(t.key));}catch(err){ctx.say(err.message||String(err),true);b.disabled=false;return;}
    const box=el('div','budget-edit ws-edit'),n=el('input','inp');n.type='number';n.min='0.01';n.step='0.01';n.value=r.metadata.agreedHours??'';n.setAttribute('aria-label','Agreed hours for '+t.key);
    const devs=r.agreedDevelopers||[];let dev=null;
    box.append(n);
    if(devs.length>1){dev=pick('Agreed hours go to',[['','Choose developer…'],...devs.map(d=>[d.dev,d.name||d.dev])],r.metadata.agreedDev||'');box.append(dev);}
    else box.append(el('span','budget-sub',devs.length?'For '+(devs[0].name||devs[0].dev):'Add a developer to the ticket first'));
    const cancel=()=>{agreedCell(cell,t,p,ctx);ctx.closed?.();};
    const save=button('Save',async()=>{
      const value=n.value===''?null:Number(n.value);
      if(value!==null&&!(value>0)){ctx.say('Enter hours above 0, or leave it empty to clear.',true);return;}
      if(value!==null&&!devs.length){ctx.say('Add a developer to '+t.key+' first: Odoo gets the agreed hours as that developer’s work.',true);return;}
      if(value!==null&&dev&&!dev.value){ctx.say('Choose who the agreed hours go to.',true);dev.focus();return;}
      save.disabled=true;ctx.say('Saving the agreed hours of '+t.key+'…');
      try{const out=await ctx.api('/ticket-metadata',{method:'PUT',body:{key:t.key,fields:{revision:r.metadata.revision,agreedHours:value,...(dev&&dev.value?{agreedDev:dev.value}:{})}}});
        ctx.say(out.warning||'Agreed hours saved for '+t.key+'.',!!out.warning);box.remove();ctx.closed?.();await refreshAfter([t.key],p,ctx);}
      catch(err){ctx.say(err.message||String(err),true);save.disabled=false;}
    },'btn primary');
    n.addEventListener('keydown',e=>{if(e.key==='Enter')save.click();else if(e.key==='Escape'){e.stopPropagation();cancel();}});
    box.append(save,button('Cancel',cancel,'btn'));cell.replaceChildren(box);n.focus();
  }
}
// After a change made here: the dashboard re-reads the ticket (its list, the drawer), this workspace reloads, and the
// Clients table reads its figures again.
async function refreshAfter(keys,p,ctx){await Promise.all([load(p.odooId),Promise.resolve(ctx.changed(keys)).catch(()=>{})]);await ctx.projectsChanged();}

// ---- Export ----
// Scope: this project, the selected tickets, every ticket matching the filters (all pages), or all projects (chosen
// explicitly). Content: A settings & allocations, B tickets & billing, C billing/work entries for a period.
function exportDialog(opener,p,s,ctx){
  const {d,body,msg}=ctx.dialog('Export “'+p.name+'”');d.classList.add('ws-dialog');d.addEventListener('close',()=>{if(opener.isConnected)opener.focus();});
  const say=(t,err)=>{msg.className=err?'msg err':'msg';msg.textContent=t||'';};
  const tickets=s.data?.tickets||[],matching=ticketView(tickets,{...s.view,page:0,size:1e9}).matching,selected=tickets.filter(t=>s.selected.has(t.key));
  const radios=(name,legend,items)=>{const f=el('fieldset','ws-choice');f.append(el('legend','',legend));for(const [v,l,dis,on] of items){const r=el('input');r.type='radio';r.name=name;r.value=v;r.disabled=!!dis;r.checked=!!on;const lab=el('label');lab.append(r,' '+l);f.append(lab);}body.append(f);return ()=>f.querySelector('input:checked')?.value;};
  const scope=radios('ws-scope','Which tickets',[['project','This project ('+tickets.length+' tickets)',0,1],['selected','Selected tickets ('+selected.length+')',!selected.length],['filtered','Tickets matching the filters, all pages ('+matching.length+')',matching.length===tickets.length],['all','All projects (every project on the Clients page)']]);
  const types=el('fieldset','ws-choice');types.append(el('legend','','What'));body.append(types);
  const check=(l,on)=>{const c=el('input');c.type='checkbox';c.checked=on;const lab=el('label');lab.append(c,' '+l);types.append(lab);return c;};
  const A=check('A. Project settings & allocations',true),B=check('B. Tickets & billing (hours in each project’s period)',true),C=check('C. Billing / work entries for a period',false);
  const cBox=el('div','ws-period'),from=el('input','inp'),to=el('input','inp'),t0=today();from.type=to.type='date';from.value=s.data?.scope.from||t0.slice(0,8)+'01';to.value=t0;
  const bill=pick('Billing of the entries',[['all','All work'],['billable','Billable'],['not_billable','Not billable'],['unclassified','Not classified']],'all'),src=pick('Source',[['','Any source'],...Object.entries(SOURCE)]),state=pick('Export state',[['all','Exported or not'],['pending','Not exported yet'],['exported','Already exported']],'all');
  const worker=el('input','inp');worker.placeholder='Any worker';worker.setAttribute('aria-label','Worker');
  cBox.append(labelled('From',from),labelled('To',to),labelled('Billing',bill),labelled('Source',src),labelled('Export state',state),labelled('Worker',worker));body.append(cBox);
  const fmt=radios('ws-format','Format',[['xlsx','Excel (.xlsx), one sheet each',0,1],['csv','CSV, one file each']]);
  body.append(el('p','business-guidance','IDs (Odoo project ID, ticket key, revision) stay in the file, so it can be imported back. Actual and commercial hours cover each project’s period; consumed hours are lifetime. A blank cell in an import leaves the value as it is.'));
  body.append(button('Download',()=>run(),'btn primary'));
  async function run(){
    const sc=scope(),kinds=[A.checked&&'A',B.checked&&'B',C.checked&&'C'].filter(Boolean),stamp=new Date().toISOString();
    if(!kinds.length){say('Choose what to export.',true);return;}
    if(C.checked&&(!from.value||!to.value||from.value>to.value)){say('Choose the period of the entries.',true);return;}
    say('Preparing the export…');
    try{
      const projects=ctx.projects(),byId=Object.fromEntries(projects.map(x=>[x.odooId,{name:x.name,client:x.client}]));
      const keys=sc==='selected'?new Set(selected.map(t=>t.key)):sc==='filtered'?new Set(matching.map(t=>t.key)):null;
      const sheets=[];
      if(kinds.includes('A'))sheets.push({name:'Projects',header:PROJECT_COLUMNS,rows:projectSheetRows(sc==='all'?projects:[projects.find(x=>x.odooId===p.odooId)||p],stamp)});
      if(kinds.includes('B')){
        let rows;if(sc==='all'){const r=await ctx.api('/clients/odoo-projects/tickets?all=1');rows=r.tickets;if(r.truncated)say('Only the first '+r.limit+' tickets are exported.',true);}
        else rows=(keys?tickets.filter(t=>keys.has(t.key)):tickets).map(t=>({...t,scope:s.data.scope}));
        sheets.push({name:'Tickets',header:TICKET_COLUMNS,rows:ticketSheetRows(rows,byId,stamp)});
      }
      if(kinds.includes('C')){
        const q=new URLSearchParams({from:from.value,to:to.value,billing:bill.value,exportState:state.value,...(src.value?{source:src.value}:{}),...(sc==='all'?{}:{project:String(p.odooId)})});
        const r=await ctx.api('/billing/export/preview?'+q),w=worker.value.trim().toLowerCase();
        const rows=r.rows.filter(x=>(!keys||keys.has(x.ticket))&&(!w||String(x.worker||'').toLowerCase().includes(w)));
        const [header,...data]=entryCsvRows(rows);sheets.push({name:'Work entries',header,rows:data});
      }
      const base=(sc==='all'?'all-projects':fileSlug(p.name))+'-'+stamp.slice(0,10);
      if(fmt()==='csv')for(const x of sheets)download(base+'-'+x.name.toLowerCase().replace(/\s+/g,'-')+'.csv',csvFile([x.header,...x.rows]),'text/csv;charset=utf-8');
      else download(base+'.xlsx',await buildWorkbook(sheets.map(x=>({name:x.name,columns:sheetColumns(x.header),rows:x.rows,freezeHeader:true}))),XLSX);
      say('Downloaded: '+sheets.map(x=>x.name+' ('+x.rows.length+' rows)').join(', ')+'.');
    }catch(err){say(err.message||String(err),true);}
  }
}

// ---- Import ----
// The file is read here; the server checks every row against the current data and shows what would change (preview),
// then saves the rows that are ready through the same saves the rest of the dashboard uses.
function importDialog(opener,p,ctx){
  const {d,body,msg}=ctx.dialog('Import project & ticket settings');d.classList.add('ws-dialog','business-dialog-wide');d.addEventListener('close',()=>{if(opener.isConnected)opener.focus();});
  const say=(t,err)=>{msg.className=err?'msg err':'msg';msg.textContent=t||'';};
  const file=el('input');file.type='file';file.accept='.xlsx,.csv';file.setAttribute('aria-label','File to import');
  const out=el('div','ws-import');
  body.append(el('p','business-guidance','Import a file exported here (Projects and Tickets sheets), or the template. You see every change before anything is saved. A blank cell leaves the value as it is; write [clear] to empty it. Customers are checked, never changed.'),
    labelled('File (.xlsx or .csv)',file),button('Download template',async()=>download('project-billing-template.xlsx',await buildWorkbook(templateSheets()),XLSX),'linkbtn'),out);
  let last=null;
  file.addEventListener('change',async()=>{
    out.replaceChildren();if(!file.files[0])return;say('Reading the file…');
    try{const {sheets}=await readTableFile(file.files[0]),{body:b,notes}=importBody(sheets);
      if(!b.projects.length&&!b.tickets.length){say(notes[0]||'No rows to import.',true);return;}
      await preview(b,notes);}
    catch(err){say(err.message||String(err),true);}
  });
  async function preview(b,notes=[]){
    say('Checking '+(b.projects.length+b.tickets.length)+' rows…');
    const r=await ctx.api('/clients/odoo-projects/import/preview',{method:'POST',body:b});last={body:b,preview:r};say('');
    out.replaceChildren();for(const n of notes)out.append(el('p','business-guidance',n));
    const c=r.counts,i=r.impact;
    out.append(el('p','ws-scope',c.ok+' ready · '+c.unchanged+' unchanged · '+c.error+' with errors · '+c.warning+' with warnings'),
      el('p','business-guidance','Financial impact on '+i.tickets+' tickets ('+r.scope.label+'): chargeable '+signedHours(minutesHours(i.beforeMinutes))+' → '+signedHours(minutesHours(i.afterMinutes))+' ('+(i.deltaMinutes>0?'+':'')+signedHours(minutesHours(i.deltaMinutes))+').'+
        (i.allocation.length?' Allocations: '+i.allocation.map(a=>'#'+a.odooId+' '+(a.from??'not set')+' → '+(a.to??'not set')+' h').join(', ')+'.':'')));
    out.append(rowsTable(r.rows,true));
    const apply=button('Apply '+c.ok+' ready row'+(c.ok===1?'':'s'),()=>applyNow(),'btn primary');apply.disabled=!c.ok;
    out.append(el('div','ws-actions'));out.lastChild.append(apply,button('Download check report',()=>download('import-check-'+today()+'.csv',csvFile(reportRows(r)),'text/csv;charset=utf-8'),'btn'));
  }
  async function applyNow(){
    if(!confirm('Save '+last.preview.counts.ok+' rows? Rows with errors are left out.'))return;
    say('Saving…');out.querySelectorAll('button').forEach(x=>{x.disabled=true;});
    let r;try{r=await ctx.api('/clients/odoo-projects/import',{method:'POST',body:last.body});}catch(err){say(err.message||String(err),true);out.querySelectorAll('button').forEach(x=>{x.disabled=false;});return;}
    const c=r.counts,again=retryBody(last.body,r);
    say(c.applied+' applied'+(c.partial?', '+c.partial+' partly':'')+(c.failed?', '+c.failed+' failed':'')+(c.not_applied?', '+c.not_applied+' not applied':'')+(c.unchanged?', '+c.unchanged+' unchanged':'')+'.',!!(c.failed||c.partial||c.not_applied));
    out.replaceChildren(rowsTable(r.rows,false));
    const bar=el('div','ws-actions');bar.append(button('Download report',()=>download('import-report-'+today()+'.csv',csvFile(reportRows(r)),'text/csv;charset=utf-8'),'btn'));
    // Trying again checks the rows that did not apply against the data as it is now: nothing is saved twice.
    if(again.projects.length||again.tickets.length)bar.append(button('Check the '+(again.projects.length+again.tickets.length)+' rows again',()=>preview(again).catch(err=>say(err.message||String(err),true)),'btn'));
    out.append(bar);
    const keys=r.rows.filter(x=>x.sheet==='tickets'&&x.applied?.length).map(x=>x.id);
    for(const id of new Set([p.odooId,...r.rows.filter(x=>x.sheet==='projects').map(x=>Number(x.id))]))if(states.get(id)?.data)load(id).catch(()=>{});
    if(keys.length)Promise.resolve(ctx.changed(keys)).catch(()=>{});
    ctx.projectsChanged();
  }
}
function rowsTable(rows,isPreview){
  const wrap=el('div','table-wrap'),table=el('table','budget-table ws-import-table'),tb=el('tbody'),hr=el('tr');
  for(const c of ['Sheet','Row','ID','Name','Customer',isPreview?'Status':'Result','Current → proposed','Errors & warnings','Impact']){const th=el('th','',c);th.scope='col';hr.append(th);}
  table.append(el('thead'),tb);table.tHead.append(hr);
  for(const r of rows){const st=r.result||r.status,tr=el('tr','ws-imp-'+st),name=el('td','',r.name||r.title||'');name.dir='auto';
    const ch=el('td');for(const c of r.changes||[])ch.append(el('div','',changeLine(c)));
    const ew=el('td');for(const e of r.errors||[])ew.append(el('div','msg err',e));for(const w of r.warnings||[])ew.append(el('div','budget-sub',w));if(!isPreview&&r.message&&!(r.errors||[]).length)ew.append(el('div','budget-sub',r.message));
    tr.append(el('td','',r.sheet==='projects'?'Projects':'Tickets'),el('td','num',String(r.row)),el('td','',r.id),name,el('td','',r.customer||''),el('td','ws-imp-status',RESULT[st]||st),ch,ew,el('td','num',r.impact?.deltaMinutes?(r.impact.deltaMinutes>0?'+':'')+signedHours(minutesHours(r.impact.deltaMinutes)):''));
    tb.append(tr);}
  wrap.append(table);return wrap;
}
