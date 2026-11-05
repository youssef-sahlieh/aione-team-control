import {selectReport,unifiedCsv,groupByEmployee,parseAgreedCsv,flagLabel} from '../models/report-view.js';
import {EMPTY_SELECTION,applySelection,jerusalemDay,knownSum,formatHours} from '../models/report-stats.js';
import {dashboard} from './report-dashboard.js';
import {importPanel as bulkImportPanel,download} from './report-import.js';
import {buildReportWorkbook} from '../models/report-workbook.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const button=(text,fn,cls='btn')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const field=(parent,label,node)=>{node.setAttribute('aria-label',label);const l=el('label','business-field');l.append(el('span','',label),node);parent.append(l);return node;};
const choices=(select,options,value)=>{if(value&&!options.some(([v])=>v===value))options=[...options,[value,'No longer in snapshot ('+value+')']];select.replaceChildren(...options.map(([v,label])=>new Option(label,v)));select.value=value||'';};
const dateInput=value=>{const n=el('input','inp');n.type='date';n.value=value;return n;};
const num=v=>typeof v==='number'&&Number.isFinite(v)?String(v):'—';
const FLAGS=[['','All flags'],['overage','Needs checkup'],['ok','Within agreed hours'],['none','No agreed hours']];
const TABLE_HEADERS=['Ticket','Title','Status','Client','Project','Billing','Developers','Estimated (h)','Agreed (h)','Logged (h)','Actual (h)','Over agreed (h)','Flag','Odoo'];
const PAGE=50;
const sameSelection=(a,b)=>a===b||(!!a&&!!b&&typeof a==='object'&&a.employee===b.employee&&a.client===b.client);
export function createReportBrowser({api,openIssue,clientsPanel}){
 let supported=false,agreedSupported=false,bulkSupported=false,isAdmin=false,snapshot=null,pending=false,page=0,generation=0,refreshCurrent=null,attempted=false,snapshotInfo={},view='employee';
 // Chart selection and dashboard state live here so they survive re-renders.
 const selection={...EMPTY_SELECTION};
 const dash={tab:'overview',effort:{state:'idle'},ui:{group:'client',sort:'excess',zoom:'all',people:10,clients:8,effortGroup:'employee'}};
 let effortGeneration=0,restoreFocus=null;
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),startDate=new Date(today+'T12:00:00Z');startDate.setUTCDate(startDate.getUTCDate()-6);
 const filters={source:'all',start:startDate.toISOString().slice(0,10),end:today,period:'all',flag:'',employee:'',clientId:'',subClientId:'',status:'',text:''};
 const resetFilters=()=>Object.assign(filters,{source:'all',start:startDate.toISOString().slice(0,10),end:today,period:'all',flag:'',employee:'',clientId:'',subClientId:'',status:'',text:''});
 return {configure:cfg=>{const caps=cfg.capabilities||[];supported=caps.includes('reports-saved-v1')===true;agreedSupported=caps.includes('agreed-hours-v1')===true;bulkSupported=caps.includes('ticket-bulk-import-v1')===true;isAdmin=cfg.role==='admin';},render(target){
 const turn=++generation,panel=el('section','panel business-panel');target.append(panel);
 panel.append(el('h2','','Checks & Reports'),el('p','msg','The business report: one row per ticket, with agreed hours, logged hours and whether the ticket needs a checkup. Your latest saved report opens automatically; use Refresh report for current source data.'));
 if(!supported){panel.append(el('p','msg err','Saved reports require the updated backend (reports-saved-v1). Deploy the compatible backend first.'));return;}
 const form=el('div','business-form report-filter-form'),msg=el('p','msg'),output=el('div','report-results');panel.append(form,msg,output);
 // The import panel is built once per render, outside output, so filters, search, paging and tabs keep its file and preview.
 const importNode=bulkSupported&&isAdmin?bulkImportPanel({api,onApplied:async text=>{await load(true);if(turn===generation)msg.textContent=text+' The report was refreshed.';}}):agreedSupported&&isAdmin?importPanel():null;
 if(importNode)panel.append(importNode);
 const controls=[];
 function select(label,options,key){const n=field(form,label,el('select','fsel'));choices(n,options,filters[key]);controls.push([n,key]);n.addEventListener('change',()=>{filters[key]=n.value;if(key==='clientId'){filters.subClientId='';populateSub();}page=0;show();});return n;}
 const start=field(form,'From',dateInput(filters.start)),end=field(form,'Through',dateInput(filters.end));
 for(const [node,key] of [[start,'start'],[end,'end']])node.addEventListener('change',()=>{filters[key]=node.value;page=0;show();});
 const client=select('Client',[['','All clients'],['__none','Client not set']],'clientId'),sub=select('Project',[['','All projects']],'subClientId'),employee=select('Employee',[['','All employees']],'employee');
 select('Flag',FLAGS,'flag');select('Status',[['','All statuses'],['__open','Open tickets'],['__closed','Closed tickets']],'status');
 select('Source',[['all','All tickets'],['jira','Jira'],['internal','Internal']],'source');
 select('Period',[['all','All tickets'],['period','Created or completed in period']],'period');
 const search=field(form,'Search report tickets',el('input','inp'));search.type='search';search.placeholder='Ticket, title, developer or employee';search.value=filters.text;let searchTimer;search.addEventListener('input',()=>{clearTimeout(searchTimer);filters.text=search.value;page=0;searchTimer=setTimeout(()=>{if(turn===generation&&target.isConnected)show();},150);});
 const run=button('Refresh report',()=>load(true));
 form.append(run,button('Export Excel',exportExcel),button('Export CSV',exportCsv),button('Clear report filters',()=>{resetFilters();Object.assign(selection,EMPTY_SELECTION);start.value=filters.start;end.value=filters.end;search.value='';for(const [node,key] of controls)node.value=filters[key]||'';page=0;populateSub();show();}));
 async function load(refresh=false){if(pending)return;pending=true;attempted=true;run.disabled=true;msg.textContent=refresh?'Refreshing the saved report…':'Opening your saved report…';try{
 const result=await api(refresh?'/reports/refresh':'/reports/latest',refresh?{method:'POST',body:{}}:undefined);
 if(result.report?.workflow!=='all'||!Array.isArray(result.report.tickets))throw new Error('The backend did not return a valid saved report.');
 snapshot=result.report;snapshotInfo=result;page=0;if(turn===generation&&target.isConnected){populate();show();msg.textContent='';}
 }catch(e){if(turn===generation)msg.textContent=e.message||'Could not open the saved report.';}finally{pending=false;run.disabled=false;refreshCurrent?.();}}
 function validPeriod(){const valid=!!filters.start&&!!filters.end&&filters.start<=filters.end&&start.checkValidity()&&end.checkValidity();if(!valid)msg.textContent='Choose a valid From / Through period.';else if(msg.textContent==='Choose a valid From / Through period.')msg.textContent='';return valid;}
 function populateSub(){const pairs=new Map((snapshot?.tickets||[]).filter(t=>!filters.clientId||t.clientId===filters.clientId).filter(t=>t.subClientId).map(t=>[t.subClientId,t.subClientName||t.subClientId]));choices(sub,[['','All projects'],...pairs],filters.subClientId);}
 function populate(){if(!snapshot)return;const rows=snapshot.tickets;choices(client,[['','All clients'],['__none','Client not set'],...new Map(rows.filter(t=>t.clientId).map(t=>[t.clientId,t.clientName||t.clientId]))],filters.clientId);populateSub();choices(employee,[['','All employees'],...[...new Set(rows.flatMap(t=>(t.employees||[]).map(e=>e.name)))].sort().map(n=>[n,n])],filters.employee);}
 function pager(count,current,set){const nav=el('div','report-pagination');const prev=button('Previous',()=>set(current-1)),next=button('Next',()=>set(current+1));prev.disabled=current===0;next.disabled=(current+1)*PAGE>=count;nav.append(prev,el('span','msg',count?((current*PAGE+1)+'–'+Math.min((current+1)*PAGE,count)+' of '+count):'0 results'),next);return nav;}
 // The tickets the filters select: the filters, then the period option (tickets created or completed in the period).
 function visibleRows(){const report=selectReport(snapshot,filters);return filters.period==='period'?report.tickets.filter(t=>t.createdInPeriod||t.completedInPeriod):report.tickets;}
 function snapshotDay(){return snapshot?jerusalemDay(snapshot.generatedAt):null;}
 // The rows every view uses: the filters, then the chart selection. The table, employee grouping, dashboard and CSV share this scope.
 function shownRows(){return applySelection(visibleRows(),selection,snapshotDay());}
 function clientName(id){if(id==='__none')return 'Client not set';return snapshot?.tickets.find(t=>t.clientId===id)?.clientName||id;}
 function projectName(id){if(id==='__none')return 'Project not set';return snapshot?.tickets.find(t=>t.subClientId===id)?.subClientName||id;}
 // Chart selections toggle: choosing the same value again clears it. Each kind holds one value.
 function chartSelect(kind,value){
  if(kind==='all')Object.assign(selection,EMPTY_SELECTION);
  else if(value==null)selection[kind]=null;
  else selection[kind]=sameSelection(selection[kind],value)?null:value;
  page=0;restoreFocus='.dash-chips';show();
 }
 function ticketRow(t){const row=el('div','report-ticket'+(t.overage==='overage'?' report-flag':''));
  row.append(button(t.key+' · '+t.title,()=>openIssue(t.key),'linkbtn'),el('p','',[t.status,t.clientName||'Client not set',t.subClientName,(t.devs||[]).join(', ')||'No developer'].filter(Boolean).join(' · ')),
  el('p','msg',['Agreed '+num(t.agreedHours)+' h','Logged '+num(t.loggedHours)+' h',...(t.employeeHours!=null?['This person '+t.employeeHours+' h']:[]),flagLabel(t),'Odoo: '+(t.odooStatus||'—')].join(' · ')));return row;}
 function ticketTable(rows){const table=el('table','workload-table'),head=table.createTHead().insertRow();for(const h of TABLE_HEADERS)head.append(el('th','',h));const body=table.createTBody();
  for(const t of rows.slice(page*PAGE,page*PAGE+PAGE)){const tr=body.insertRow(),k=el('td');k.append(button(t.key,()=>openIssue(t.key),'linkbtn'));
   tr.append(k,el('td','',t.title),el('td','',t.status),el('td','',t.clientName||''),el('td','',t.subClientName||''),el('td','',t.billing||''),el('td','',(t.devs||[]).join(', ')),el('td','num',num(t.estimatedHours)),el('td','num',num(t.agreedHours)),el('td','num',num(t.loggedHours)),el('td','num',num(t.actualHours)),el('td','num',t.overage==='overage'?num(t.overHours):'—'),el('td','',flagLabel(t)),el('td','',t.odooStatus||''));}
  const wrap=el('div','report-table-scroll');wrap.append(table);return wrap;}
 function entriesTable(report){const table=el('table','workload-table'),head=table.createTHead().insertRow();for(const h of ['Date','Person','Ticket','Client','Project','Hours','Status'])head.append(el('th','',h));const body=table.createTBody();
  for(const r of report.rows||[]){const tr=body.insertRow();tr.append(el('td','',r.date),el('td','',r.user),el('td','',r.ticket),el('td','',r.clientName||''),el('td','',r.subClientName||''),el('td','num',num(Math.round(r.minutes/60*100)/100)),el('td','',report.statuses?.[r.status]||r.status));}
  return table;}
 function exportCsv(){if(!snapshot||!validPeriod())return;const url=URL.createObjectURL(new Blob(['﻿'+unifiedCsv(shownRows())],{type:'text/csv;charset=utf-8'})),a=el('a');a.href=url;a.download='aion-business-report-'+filters.end+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 async function exportExcel(){if(!snapshot||!validPeriod())return;msg.textContent='Preparing the Excel file…';try{
  const rows=shownRows(),pick=(label,id,name)=>[label,id?name(id):''];
  const bytes=await buildReportWorkbook(rows,{generatedAt:new Date(snapshot.generatedAt).toLocaleString('en-GB',{timeZone:'Asia/Jerusalem'})+' (Asia/Jerusalem)',period:{start:filters.start,end:filters.end},warnings:snapshot.warnings,
   filters:[pick('Client',filters.clientId,clientName),pick('Project',filters.subClientId,projectName),['Employee',filters.employee],['Flag',FLAGS.find(([v])=>v===filters.flag)?.[1]&&filters.flag?FLAGS.find(([v])=>v===filters.flag)[1]:''],['Source',filters.source==='all'?'':filters.source],['Search',filters.text],['Created or completed in period only',filters.period==='period'?'Yes':'']]});
  download('aion-business-report-'+filters.end+'.xlsx',[bytes],'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');msg.textContent=rows.length+' tickets exported.';
 }catch(err){msg.textContent=err.message||'Could not build the Excel file.';}}
 function importPanel(){
  const box=el('details','report-import'),file=el('input'),previewOut=el('div'),preview=button('Preview',()=>runPreview()),apply=button('Apply agreed hours',()=>runApply(),'btn primary');
  let rowsIn=null;apply.disabled=true;file.type='file';file.accept='.csv,text/csv';file.setAttribute('aria-label','Agreed hours CSV file');
  box.append(el('summary','','Import agreed hours from CSV'),el('p','msg','A CSV with a header row “Ticket,Agreed hours”. Each row sets one ticket\'s agreed hours, and Odoo gets one line for them. Preview first; the file is applied only when every row is valid.'),file,preview,apply,previewOut);
  async function runPreview(){previewOut.replaceChildren();apply.disabled=true;rowsIn=null;
   if(!file.files?.[0]){previewOut.append(el('p','msg err','Choose a CSV file first.'));return;}
   try{rowsIn=parseAgreedCsv(await file.files[0].text());}catch(err){previewOut.append(el('p','msg err',err.message));return;}
   try{const result=await api('/agreed-hours/import/preview',{method:'POST',body:{rows:rowsIn}});
    previewOut.append(el('p','msg',result.ok+' rows ready · '+result.errors+' with errors'));
    const table=el('table','workload-table'),head=table.createTHead().insertRow();for(const h of ['Row','Ticket','Agreed (h)','Result'])head.append(el('th','',h));const body=table.createTBody();
    for(const r of result.rows){const tr=body.insertRow();tr.append(el('td','num',String(r.row)),el('td','',r.key),el('td','num',num(r.agreedHours)),el('td',r.status==='error'?'msg err':'',r.message));}
    previewOut.append(table);apply.disabled=!(result.ok>0&&result.errors===0);
   }catch(err){previewOut.append(el('p','msg err',err.message||'Could not preview the import.'));}}
  async function runApply(){apply.disabled=true;previewOut.append(el('p','msg','Applying…'));
   try{const r=await api('/agreed-hours/import',{method:'POST',body:{rows:rowsIn}});
    previewOut.replaceChildren(el('p','msg','Agreed hours set on '+r.applied+' tickets.'+(r.failed.length?' Not set: '+r.failed.map(f=>f.key+' ('+f.message+')').join('; '):'')+' Refresh report to see the new figures.'));
   }catch(err){previewOut.replaceChildren(el('p','msg err',err.message||'Could not apply the import.'));}}
  return box;}
 // Dated effort for the period, fetched only when the Team & Delivery tab asks for it. A response for an old period is dropped.
 function loadEffort(){
  const key=filters.start+'|'+filters.end,mine=++effortGeneration;
  dash.effort={state:'loading',key};
  api('/time-entries/report?from='+filters.start+'&to='+filters.end).then(r=>{
   if(mine!==effortGeneration)return;
   dash.effort={state:'ready',key,entries:r.rows||[]};
   if(turn===generation&&target.isConnected)show();
  },err=>{
   if(mine!==effortGeneration)return;
   dash.effort={state:'error',key,message:err.message||'Dated work entries could not be loaded.'};
   if(turn===generation&&target.isConnected)show();
  });
 }
 function dashboardContext(rows){
  const day=snapshotDay();
  return {rows,snapshotDay:day,period:{start:filters.start,end:filters.end},employee:filters.employee,selection,
   labels:{client:clientName,project:projectName},
   tab:dash.tab,ui:dash.ui,effort:dash.effort,
   select:chartSelect,
   setTab:tab=>{dash.tab=tab;restoreFocus='#dash-tab-'+tab;show();},
   rerender:key=>{if(key)restoreFocus='[data-key="'+key+'"]';show();},
   openIssue,loadEffort};
 }
 function show(){output.replaceChildren();if(!snapshot){output.append(el('p','msg','The saved report will appear here automatically. Use Refresh report to retry if loading fails.'));return;}if(!validPeriod())return;
  const base=visibleRows(),rows=applySelection(base,selection,snapshotDay());
  // Dated effort is tied to the period; a changed period starts a fresh request when that tab is opened.
  if(dash.effort.key!==filters.start+'|'+filters.end)dash.effort={state:'idle',key:filters.start+'|'+filters.end};
  output.append(el('p','msg','Saved report generated '+new Date(snapshot.generatedAt).toLocaleString('en-GB',{timeZone:'Asia/Jerusalem'})+' · '+snapshot.coverage.examined+' tickets examined · '+base.length+' match your filters'+(rows.length!==base.length?' · '+rows.length+' after the chart selection':'')),
   el('p','msg','Logged and agreed hours are totals for each ticket. Period: '+filters.start+' to '+filters.end+' (Asia/Jerusalem), used when “Created or completed in period” is chosen.'));
  if(snapshotInfo.stale)output.append(el('p','msg err','This saved report is more than an hour old. Filters still work; use Refresh report when you need current source data.'));
  if(snapshotInfo.refreshing)output.append(el('p','msg','Another report refresh is already in progress.'));
  if(snapshotInfo.refreshWarning)output.append(el('p','msg err',snapshotInfo.refreshWarning));
  for(const w of snapshot.warnings||[])output.append(el('p','msg err',w));
  // Unknown values are counted apart: a total covers only the tickets that have a recorded value.
  const logged=knownSum(rows,'loggedHours'),agreed=knownSum(rows,'agreedHours');
  const cards=el('div','report-totals');cards.append(el('span','','Tickets: '+rows.length),el('span','','Logged: '+formatHours(logged.sum)+' ('+logged.known+' of '+logged.total+' recorded)'),el('span','','Agreed: '+formatHours(agreed.sum)+' ('+agreed.known+' of '+agreed.total+' set)'),el('span','','Needs checkup: '+rows.filter(t=>t.overage==='overage').length));
  output.append(cards);
  // Administrators can add the report's clients and projects to Odoo from here (ticket-business supplies the panel).
  const addPanel=clientsPanel?.({rows:base,refresh:()=>show()});if(addPanel)output.append(addPanel);
  output.append(dashboard(dashboardContext(rows)));
  const switcher=el('select','fsel');switcher.setAttribute('aria-label','Report view');switcher.append(new Option('By employee, then customer','employee'),new Option('All tickets (table)','tickets'));switcher.value=view;switcher.addEventListener('change',()=>{view=switcher.value;page=0;show();});output.append(switcher);
  if(view==='employee'){
   const people=groupByEmployee(rows);if(!people.length)output.append(el('p','msg','No tickets match these report filters.'));
   for(const person of people){const count=person.customers.reduce((n,c)=>n+c.tickets.length,0),d=el('details','report-group');d.append(el('summary','',person.name+' · '+person.hours+' h logged · '+count+(count===1?' ticket':' tickets')));
    for(const c of person.customers){const cd=el('details','report-subgroup');cd.append(el('summary','',c.name+' · '+c.hours+' h · '+c.tickets.length+(c.tickets.length===1?' ticket':' tickets')));for(const t of c.tickets)cd.append(ticketRow(t));d.append(cd);}
    output.append(d);}
  }else{
   page=Math.min(page,Math.max(0,Math.ceil(rows.length/PAGE)-1));output.append(pager(rows.length,page,n=>{page=n;show();}));
   if(rows.length)output.append(ticketTable(rows));else output.append(el('p','msg','No tickets match these report filters.'));
   if(rows.length>PAGE)output.append(pager(rows.length,page,n=>{page=n;show();}));
  }
  const entries=el('details','report-entries');entries.append(el('summary','','Work entries in this period'));let loaded=false;
  entries.addEventListener('toggle',async()=>{if(!entries.open||loaded)return;loaded=true;const wait=el('p','msg','Loading…');entries.append(wait);try{const r=await api('/time-entries/report?from='+filters.start+'&to='+filters.end);wait.replaceWith(entriesTable(r));}catch(err){wait.textContent=err.message||'Could not load the work entries.';}});
  output.append(entries);
  if(restoreFocus){output.querySelector(restoreFocus)?.focus({preventScroll:true});restoreFocus=null;}
 }
 refreshCurrent=()=>{if(turn===generation&&target.isConnected){run.disabled=pending;populate();show();}};
 populate();show();if(!snapshot&&!pending&&!attempted)void load();
 }};
}
