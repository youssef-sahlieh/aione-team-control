import {selectReport,unifiedCsv,groupByEmployee,parseAgreedCsv,flagLabel,insights} from '../models/report-view.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const button=(text,fn,cls='btn')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const field=(parent,label,node)=>{node.setAttribute('aria-label',label);const l=el('label','business-field');l.append(el('span','',label),node);parent.append(l);return node;};
const choices=(select,options,value)=>{if(value&&!options.some(([v])=>v===value))options=[...options,[value,'No longer in snapshot ('+value+')']];select.replaceChildren(...options.map(([v,label])=>new Option(label,v)));select.value=value||'';};
const dateInput=value=>{const n=el('input','inp');n.type='date';n.value=value;return n;};
const num=v=>typeof v==='number'&&Number.isFinite(v)?String(v):'—';
const total=(list,pick)=>Math.round(list.reduce((n,t)=>n+(typeof pick(t)==='number'?pick(t):0),0)*100)/100;
const FLAGS=[['','All flags'],['overage','Needs checkup'],['ok','Within agreed hours'],['none','No agreed hours']];
const TABLE_HEADERS=['Ticket','Title','Status','Client','Project','Billing','Developers','Estimated (h)','Agreed (h)','Logged (h)','Actual (h)','Over agreed (h)','Flag','Odoo'];
const PAGE=50,BARS_SHOWN=12;
const tile=(label,value)=>{const t=el('div','insight-tile');t.append(el('span','insight-label',label),el('strong','insight-value',String(value)));return t;};
// One bar per item, scaled to the largest value. The label and number are text, so colour is not the only cue.
function bars(title,items){const box=el('div','insight-bars'),max=Math.max(0,...items.map(i=>i.value));box.append(el('h3','',title));
 if(!items.length){box.append(el('p','msg','Nothing to show.'));return box;}
 for(const item of items.slice(0,BARS_SHOWN)){const row=el('div','bar-row'),track=el('span','bar-track'),fill=el('span','bar-fill');fill.style.width=(max>0?Math.round(item.value/max*1000)/10:0)+'%';track.append(fill);
  row.append(el('span','bar-label',item.label),track,el('span','bar-value',item.text??String(item.value)));box.append(row);}
 if(items.length>BARS_SHOWN)box.append(el('p','msg','and '+(items.length-BARS_SHOWN)+' more (use the table or CSV for the full list)'));
 return box;}
function monthTable(months){const table=el('table','workload-table'),head=table.createTHead().insertRow();for(const h of ['Month','Tickets created','Tickets completed'])head.append(el('th','',h));const body=table.createTBody();
 for(const m of months){const tr=body.insertRow();tr.append(el('td','',m.month),el('td','num',String(m.created)),el('td','num',String(m.completed)));}
 const wrap=el('div','report-table-scroll');wrap.append(table);return wrap;}
// Statistics for the tickets the report shows. Hours are all-time totals per ticket; months are when a ticket was created or completed.
function insightsPanel(rows){
 const data=insights(rows),k=data.kpis,box=el('details','report-insights');box.open=true;box.append(el('summary','','Insights for these tickets'));
 const pctText=v=>v==null?'—':v+'%';
 const tiles=el('div','insight-tiles');
 for(const [label,value] of [['Tickets',k.tickets],['Open',k.open],['Closed',k.closed],['With agreed hours',k.withAgreed],['No agreed hours',k.noAgreed],['Needs checkup',k.checkups],['Checkup rate',pctText(k.checkupRate)],['Agreed hours',k.agreedHours+' h'],['Logged on those tickets',k.loggedOnAgreed+' h'],['Burn rate',pctText(k.burnRate)],['Total logged',k.loggedHours+' h'],['Estimated',k.estimatedHours+' h'],['Actual',k.actualHours+' h']])tiles.append(tile(label,value));
 box.append(tiles,
  bars('Logged against agreed hours (tickets with agreed hours)',data.burn.map(b=>({label:b.label,value:b.tickets,text:b.tickets+' tickets'}))),
  bars('Flags',data.flags.map(f=>({label:f.label,value:f.tickets,text:f.tickets+' tickets'}))),
  bars('Logged hours by employee',data.byEmployee.map(e=>({label:e.label,value:e.loggedHours,text:e.loggedHours+' h · '+e.tickets+(e.tickets===1?' ticket':' tickets')}))),
  bars('Logged hours by client',data.byClient.map(c=>({label:c.label,value:c.loggedHours,text:c.loggedHours+' h · '+c.tickets+(c.tickets===1?' ticket':' tickets')+(c.checkups?' · '+c.checkups+' need checkup':'')}))),
  bars('Billing',data.byBilling.map(b=>({label:b.label,value:b.tickets,text:b.tickets+' tickets · '+b.loggedHours+' h logged'}))),
  bars('Odoo status',data.byOdoo.map(o=>({label:o.label,value:o.tickets,text:o.tickets+' tickets'}))));
 const months=el('div','insight-bars');months.append(el('h3','','Tickets created and completed by month'));months.append(data.byMonth.length?monthTable(data.byMonth):el('p','msg','Nothing to show.'));box.append(months);
 return box;}
export function createReportBrowser({api,openIssue}){
 let supported=false,agreedSupported=false,snapshot=null,pending=false,page=0,generation=0,refreshCurrent=null,attempted=false,snapshotInfo={},view='employee';
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),startDate=new Date(today+'T12:00:00Z');startDate.setUTCDate(startDate.getUTCDate()-6);
 const filters={source:'all',start:startDate.toISOString().slice(0,10),end:today,period:'all',flag:'',employee:'',clientId:'',subClientId:'',status:'',text:''};
 const resetFilters=()=>Object.assign(filters,{source:'all',start:startDate.toISOString().slice(0,10),end:today,period:'all',flag:'',employee:'',clientId:'',subClientId:'',status:'',text:''});
 return {configure:cfg=>{const caps=cfg.capabilities||[];supported=caps.includes('reports-saved-v1')===true;agreedSupported=caps.includes('agreed-hours-v1')===true;},render(target){
 const turn=++generation,panel=el('section','panel business-panel');target.append(panel);
 panel.append(el('h2','','Checks & Reports'),el('p','msg','The business report: one row per ticket, with agreed hours, logged hours and whether the ticket needs a checkup. Your latest saved report opens automatically; use Refresh report for current source data.'));
 if(!supported){panel.append(el('p','msg err','Saved reports require the updated backend (reports-saved-v1). Deploy the compatible backend first.'));return;}
 const form=el('div','business-form report-filter-form'),msg=el('p','msg'),output=el('div','report-results');panel.append(form,msg,output);
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
 form.append(run,button('Export CSV',exportCsv),button('Clear report filters',()=>{resetFilters();start.value=filters.start;end.value=filters.end;search.value='';for(const [node,key] of controls)node.value=filters[key]||'';page=0;populateSub();show();}));
 async function load(refresh=false){if(pending)return;pending=true;attempted=true;run.disabled=true;msg.textContent=refresh?'Refreshing the saved report…':'Opening your saved report…';try{
 const result=await api(refresh?'/reports/refresh':'/reports/latest',refresh?{method:'POST',body:{}}:undefined);
 if(result.report?.workflow!=='all'||!Array.isArray(result.report.tickets))throw new Error('The backend did not return a valid saved report.');
 snapshot=result.report;snapshotInfo=result;page=0;if(turn===generation&&target.isConnected){populate();show();msg.textContent='';}
 }catch(e){if(turn===generation)msg.textContent=e.message||'Could not open the saved report.';}finally{pending=false;run.disabled=false;refreshCurrent?.();}}
 function validPeriod(){const valid=!!filters.start&&!!filters.end&&filters.start<=filters.end&&start.checkValidity()&&end.checkValidity();if(!valid)msg.textContent='Choose a valid From / Through period.';else if(msg.textContent==='Choose a valid From / Through period.')msg.textContent='';return valid;}
 function populateSub(){const pairs=new Map((snapshot?.tickets||[]).filter(t=>!filters.clientId||t.clientId===filters.clientId).filter(t=>t.subClientId).map(t=>[t.subClientId,t.subClientName||t.subClientId]));choices(sub,[['','All projects'],...pairs],filters.subClientId);}
 function populate(){if(!snapshot)return;const rows=snapshot.tickets;choices(client,[['','All clients'],['__none','Client not set'],...new Map(rows.filter(t=>t.clientId).map(t=>[t.clientId,t.clientName||t.clientId]))],filters.clientId);populateSub();choices(employee,[['','All employees'],...[...new Set(rows.flatMap(t=>(t.employees||[]).map(e=>e.name)))].sort().map(n=>[n,n])],filters.employee);}
 function pager(count,current,set){const nav=el('div','report-pagination');const prev=button('Previous',()=>set(current-1)),next=button('Next',()=>set(current+1));prev.disabled=current===0;next.disabled=(current+1)*PAGE>=count;nav.append(prev,el('span','msg',count?((current*PAGE+1)+'–'+Math.min((current+1)*PAGE,count)+' of '+count):'0 results'),next);return nav;}
 // The tickets the page shows: the filters, then the period option (tickets created or completed in the period).
 function visibleRows(){const report=selectReport(snapshot,filters);return filters.period==='period'?report.tickets.filter(t=>t.createdInPeriod||t.completedInPeriod):report.tickets;}
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
 function exportCsv(){if(!snapshot||!validPeriod())return;const url=URL.createObjectURL(new Blob(['﻿'+unifiedCsv(visibleRows())],{type:'text/csv;charset=utf-8'})),a=el('a');a.href=url;a.download='aion-business-report-'+filters.end+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
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
 function show(){output.replaceChildren();if(!snapshot){output.append(el('p','msg','The saved report will appear here automatically. Use Refresh report to retry if loading fails.'));return;}if(!validPeriod())return;
  const rows=visibleRows();
  output.append(el('p','msg','Saved report generated '+new Date(snapshot.generatedAt).toLocaleString('en-GB',{timeZone:'Asia/Jerusalem'})+' · '+snapshot.coverage.examined+' tickets examined · '+rows.length+' match your filters'),
   el('p','msg','Logged and agreed hours are totals for each ticket. Period: '+filters.start+' to '+filters.end+' (Asia/Jerusalem), used when “Created or completed in period” is chosen.'));
  if(snapshotInfo.stale)output.append(el('p','msg err','This saved report is more than an hour old. Filters still work; use Refresh report when you need current source data.'));
  if(snapshotInfo.refreshing)output.append(el('p','msg','Another report refresh is already in progress.'));
  if(snapshotInfo.refreshWarning)output.append(el('p','msg err',snapshotInfo.refreshWarning));
  for(const w of snapshot.warnings||[])output.append(el('p','msg err',w));
  const cards=el('div','report-totals');cards.append(el('span','','Tickets: '+rows.length),el('span','','Logged: '+total(rows,t=>t.loggedHours)+' h'),el('span','','Agreed: '+total(rows.filter(t=>t.agreedHours!=null),t=>t.agreedHours)+' h'),el('span','','Needs checkup: '+rows.filter(t=>t.overage==='overage').length));output.append(cards,insightsPanel(rows));
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
  if(agreedSupported)output.append(importPanel());
 }
 refreshCurrent=()=>{if(turn===generation&&target.isConnected){run.disabled=pending;populate();show();}};
 populate();show();if(!snapshot&&!pending&&!attempted)void load();
 }};
}
