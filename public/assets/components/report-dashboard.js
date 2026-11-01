import {agreementGroups,agreementSummary,GROUP_SORTS,paretoOverruns,aging,knownSum,overdueOpen,completedInPeriod,employeeClientMatrix,estimateAccuracy,workloadByStatus,weeklyFlow,weeklyEffort,formatHours,formatPercent,shortDay,hoursOf} from '../models/report-stats.js';

// The dashboard renders the rows it is given. Every chart, card and table reads the same rows, so they agree.
// ctx: {rows, snapshotDay, period, employee, selection, labels, tab, ui, effort, openIssue, select(kind, value), setTab(tab), loadEffort()}
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const button=(text,fn,cls='linkbtn')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const svg=(name,attrs={},text)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v));if(text!=null)n.textContent=text;return n;};
const TABS=[['overview','Overview'],['hours','Hours & Agreements'],['team','Team & Delivery']];
const PALETTE=['#2f5fd0','#8e6bbf','#2e8b6a','#b8741a','#4f8fb3','#a4506b','#6b7f2e','#5d6470'];
const pctOf=(part,whole)=>whole>0?part/whole:null;
const signedHours=v=>(v>0?'+':v<0?'−':'')+formatHours(Math.abs(v));

export function dashboard(ctx){
 const root=el('div','report-dashboard');
 root.append(selectionBar(ctx));
 root.append(tabBar(ctx));
 const body=el('div','dash-body');body.setAttribute('role','tabpanel');
 const views={overview:overview,hours:hoursTab,team:teamTab};
 body.append(views[ctx.tab]?.(ctx)||overview(ctx));
 root.append(body);
 return root;
}

// ---- Selection chips ----
function selectionBar(ctx){
 const sel=ctx.selection,chips=[];
 const t=ctx.rows;
 if(sel.client)chips.push(['client',`Client: ${ctx.labels.client(sel.client)}`]);
 if(sel.project)chips.push(['project',`Project: ${ctx.labels.project(sel.project)}`]);
 if(sel.aging)chips.push(['aging',`Age: ${sel.aging}`]);
 if(sel.cell)chips.push(['cell',`${sel.cell.employee} × ${ctx.labels.client(sel.cell.client)}`]);
 const bar=el('div','dash-chips');bar.tabIndex=-1;
 bar.append(el('span','msg',`${t.length} ${t.length===1?'ticket':'tickets'} in this view`));
 for(const [kind,label] of chips){const c=button('× '+label,()=>ctx.select(kind,null),'chip');c.setAttribute('aria-label','Remove filter '+label);bar.append(c);}
 if(chips.length)bar.append(button('Clear selection',()=>ctx.select('all',null),'btn'));
 return bar;
}

function tabBar(ctx){
 const tabs=el('div','dash-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Statistics views');
 const buttons=TABS.map(([id,label])=>{const b=button(label,()=>ctx.setTab(id),'dash-tab');b.id='dash-tab-'+id;b.setAttribute('role','tab');b.setAttribute('aria-selected',String(ctx.tab===id));b.tabIndex=ctx.tab===id?0:-1;return b;});
 buttons.forEach((b,i)=>{b.addEventListener('keydown',e=>{if(e.key!=='ArrowRight'&&e.key!=='ArrowLeft')return;e.preventDefault();const n=buttons[(i+(e.key==='ArrowRight'?1:buttons.length-1))%buttons.length];n.focus();n.click();});});
 tabs.append(...buttons);
 return tabs;
}

// ---- Shared pieces ----
function card(label,value,sub){const c=el('div','dash-card');c.append(el('span','dash-card-label',label),el('strong','dash-card-value',value));if(sub)c.append(el('span','dash-card-sub',sub));return c;}
function panel(title,note){const p=el('section','dash-panel');p.append(el('h3','',title));if(note)p.append(el('p','dash-note',note));return p;}
function table(headers,rows){const wrap=el('div','report-table-scroll'),t=el('table','workload-table dash-table'),head=t.createTHead().insertRow();for(const h of headers)head.append(el('th',h.num?'num':'',h.label??h));const body=t.createTBody();for(const r of rows){const tr=body.insertRow();for(const c of r)tr.append(c instanceof Node?wrapCell(c):el('td',typeof c==='object'&&c.num?'num':'',String(c?.text??c)));}wrap.append(t);return wrap;}
function wrapCell(node){const td=el('td','');td.append(node);return td;}
const ticketLink=(ctx,key)=>button(key,()=>ctx.openIssue(key));
function emptyNote(text){return el('p','msg dash-empty',text);}

// Agreed (grey) and logged (blue) bars per group. Hours above agreement are red and labelled in text.
function agreedBars(groups,ctx,{limit=Infinity,onPick}={}){
 const box=el('div','dash-bars');
 const shown=groups.slice(0,limit),scale=Math.max(1,...shown.map(g=>Math.max(g.agreedHours,g.loggedHours)));
 if(!shown.length){box.append(emptyNote('No tickets match these filters.'));return box;}
 for(const g of shown){
  const row=el('div','dash-bar-row'),ratio=g.ratio,over=g.excessHours>0,approaching=!over&&ratio!=null&&ratio>=0.8;
  const head=el('div','dash-bar-head');
  const name=button(g.label,()=>onPick?.(g),'linkbtn dash-bar-name');
  name.setAttribute('aria-label',`${g.label}: select to filter`);
  head.append(name,el('span','dash-bar-tag'+(over?' over':approaching?' approaching':''),over?`Over by ${formatHours(g.excessHours)}`:approaching?'Approaching agreement':ratio==null?'No matched tickets':'Within agreement'));
  const track=el('div','dash-bar-tracks');
  const agreed=el('div','dash-bar agreed');agreed.style.width=pctOf(g.agreedHours,scale)*100+'%';
  const logged=el('div','dash-bar logged');const loggedPart=Math.min(g.loggedHours,g.agreedHours||g.loggedHours);
  logged.style.width=pctOf(g.loggedHours,scale)*100+'%';
  const within=el('span','dash-bar-within');within.style.width=pctOf(loggedPart,g.loggedHours)*100+'%';logged.append(within);
  if(over){const extra=el('span','dash-bar-over');extra.style.width=pctOf(g.excessHours,g.loggedHours)*100+'%';logged.append(extra);}
  track.append(agreed,logged);
  const text=`Agreed ${formatHours(g.agreedHours)} · Logged ${formatHours(g.loggedHours)} · ${over?signedHours(g.excessHours)+' over':'within'} · ${formatPercent(ratio)} of agreed`;
  row.title=text;row.append(head,track,el('p','dash-bar-text',text),el('p','dash-note',`Matched ${g.matched} · no agreement ${g.noAgreement} · logged hours unknown ${g.loggedUnknown}`));
  box.append(row);
 }
 if(groups.length>shown.length)box.append(el('p','dash-note',`${groups.length-shown.length} more on the Hours & Agreements tab`));
 return box;
}

// ---- Overview ----
function overview(ctx){
 const rows=ctx.rows,snapDay=ctx.snapshotDay,wrap=el('div','dash-overview');
 const logged=knownSum(rows,'loggedHours'),summary=agreementSummary(rows),openNow=rows.filter(t=>!t.closed).length,done=completedInPeriod(rows,ctx.period.start,ctx.period.end).length,overdue=overdueOpen(rows,snapDay).length;
 const cards=el('div','dash-cards');
 cards.append(
  card('Open tickets now',String(openNow),`of ${rows.length} in this view`),
  card('Completed in period',String(done),`${ctx.period.start} to ${ctx.period.end}, by completion date`),
  card('Overdue now',String(overdue),`open, due before ${snapDay}`),
  loggedCard(ctx,logged),
  card('Excess above agreement',formatHours(summary.excessHours),`${summary.over} of ${summary.matched} matched tickets over agreement`+(summary.noAgreement||summary.loggedUnknown?` · ${summary.noAgreement} without agreement · ${summary.loggedUnknown} logged unknown`:'')));
 wrap.append(cards);
 const grid=el('div','dash-grid');
 const clientGroups=agreementGroups(rows,t=>({key:t.clientId||'__none',label:t.clientName||'Client not set'})).sort(GROUP_SORTS.excess);
 const left=panel('Agreed vs logged, by client','Blue is logged work; grey is agreed. Red marks hours above agreement. Only tickets with both values are compared.');
 left.append(agreedBars(clientGroups,ctx,{limit:8,onPick:g=>ctx.select('client',g.key)}));
 const right=panel('Open tickets by age','Current age: calendar days from creation to the snapshot day (Asia/Jerusalem). This is not time in a workflow stage.');
 right.append(agingList(ctx,aging(rows,snapDay)));
 grid.append(left,right);wrap.append(grid);
 const pareto=paretoOverruns(rows,5);
 const grid2=el('div','dash-grid');
 const top=panel('Largest overrun contributors',pareto.total?`${pareto.count} matched tickets are over agreement, with ${formatHours(pareto.total)} of excess in total.`:'No matched ticket is over agreement in this view.');
 if(pareto.bars.length)top.append(table(['Ticket','Client',{label:'Excess (h)',num:true},{label:'Share',num:true}],pareto.bars.map(b=>[ticketLink(ctx,b.key),b.client,{text:signedHours(b.excess),num:true},{text:formatPercent(b.share),num:true}])));
 const exceptions=panel('Overrun exceptions','The largest overruns in this view. Each ticket opens in its drawer.');
 if(pareto.bars.length)exceptions.append(table(['Ticket','Title','Agreed (h)','Logged (h)','Over (h)'],pareto.bars.map(b=>[ticketLink(ctx,b.key),b.title||'',{text:formatHours(b.agreed),num:true},{text:formatHours(b.logged),num:true},{text:signedHours(b.excess),num:true}])));
 else exceptions.append(emptyNote('No exceptions.'));
 grid2.append(top,exceptions);wrap.append(grid2);
 return wrap;
}
function loggedCard(ctx,logged){
 const c=card('Logged hours on these tickets',formatHours(logged.sum),`${logged.known}/${logged.total} tickets have a recorded value · all-time totals per ticket`);
 if(ctx.employee){const own=ctx.rows.reduce((n,t)=>n+(t.employees||[]).filter(e=>e.name===ctx.employee).reduce((m,e)=>m+(hoursOf(e.hours)||0),0),0);c.append(el('span','dash-card-sub',`${ctx.employee} logged ${formatHours(own)} on these tickets`));}
 return c;
}
function agingList(ctx,a){
 const list=el('div','dash-aging');
 for(const b of a.buckets){const row=el('div','dash-aging-row');const btn=button(b.label,()=>ctx.select('aging',b.label),'linkbtn dash-aging-name');btn.setAttribute('aria-pressed',String(ctx.selection.aging===b.label));
  const track=el('span','dash-bar-track');const fill=el('span','dash-bar-fill');fill.style.width=pctOf(b.count,Math.max(1,...a.buckets.map(x=>x.count)))*100+'%';track.append(fill);
  row.append(btn,track,el('span','dash-aging-count',String(b.count)));list.append(row);}
 for(const [key,label] of [['unknown','Creation date unknown'],['invalid','Created after the snapshot day']]){const n=a[key];if(n.count)list.append(el('p','dash-note',`${label}: ${n.count} (not in the age buckets)`));}
 if(!a.open)list.append(emptyNote('No open tickets in this view.'));
 return list;
}

// ---- Hours & Agreements ----
function hoursTab(ctx){
 const rows=ctx.rows,ui=ctx.ui,wrap=el('div','dash-hours');
 const comparison=panel('Agreed vs logged','Only tickets with agreed and logged hours are compared. Excluded counts are shown for each group.');
 const controls=el('div','dash-controls');
 controls.append(segmented('Group by',[['client','Client'],['project','Project']],ui.group,(v,k)=>{ui.group=v;ctx.rerender(k);}));
 controls.append(segmented('Sort by',[['excess','Excess hours'],['logged','Logged hours'],['name','Name']],ui.sort,(v,k)=>{ui.sort=v;ctx.rerender(k);}));
 comparison.append(controls);
 const keyOf=ui.group==='project'?(t=>({key:t.subClientId||'__none',label:t.subClientName||'Project not set'})):(t=>({key:t.clientId||'__none',label:t.clientName||'Client not set'}));
 const groups=agreementGroups(rows,keyOf).sort(GROUP_SORTS[ui.sort]);
 comparison.append(agreedBars(groups,ctx,{onPick:g=>ctx.select(ui.group==='project'?'project':'client',g.key)}));
 wrap.append(comparison);
 wrap.append(scatterPanel(ctx));
 wrap.append(paretoPanel(ctx));
 const cmp=panel('Client and project comparison','Matched counts and totals use only tickets with agreed and logged hours. Select a row to filter.');
 const byClient=agreementGroups(rows,t=>({key:t.clientId||'__none',label:t.clientName||'Client not set'})).sort(GROUP_SORTS.excess);
 const byProject=agreementGroups(rows,t=>({key:t.subClientId||'__none',label:t.subClientName||'Project not set'})).sort(GROUP_SORTS.excess);
 for(const [title,list,kind] of [['By client',byClient,'client'],['By project',byProject,'project']]){
  cmp.append(el('h4','',title));
  cmp.append(table(['Group','Tickets',{label:'Matched',num:true},{label:'No agreement',num:true},{label:'Logged unknown',num:true},{label:'Agreed (h)',num:true},{label:'Logged (h)',num:true},{label:'Excess (h)',num:true},{label:'Net (h)',num:true},{label:'Logged ÷ agreed',num:true}],
   list.map(g=>[button(g.label,()=>ctx.select(kind,g.key),'linkbtn'),{text:String(g.tickets),num:true},{text:String(g.matched),num:true},{text:String(g.noAgreement),num:true},{text:String(g.loggedUnknown),num:true},{text:formatHours(g.agreedHours),num:true},{text:formatHours(g.loggedHours),num:true},{text:formatHours(g.excessHours),num:true},{text:signedHours(g.netVariance),num:true},{text:formatPercent(g.ratio),num:true}])));
 }
 wrap.append(cmp);
 return wrap;
}
function segmented(label,options,value,onChange){
 const group=el('div','dash-segmented');group.setAttribute('role','group');group.setAttribute('aria-label',label);group.append(el('span','dash-control-label',label));
 for(const [v,text] of options){const b=button(text,()=>onChange(v,label+'|'+v),'dash-seg');b.dataset.key=label+'|'+v;b.setAttribute('aria-pressed',String(value===v));group.append(b);}
 return group;
}

// Estimate accuracy: X is the estimate, Y is logged hours, with the Y = X reference line.
function scatterPanel(ctx){
 const est=estimateAccuracy(ctx.rows),ui=ctx.ui,p=panel('Estimate accuracy','Completed tickets with a positive estimate and recorded logged hours. Logged hours come from work entries and can differ from the legacy actual-hours field.');
 const ex=est.excluded;
 p.append(el('p','dash-note',`Sample: ${est.sample} of ${est.completed} completed tickets · excluded: ${ex.noEstimate} without a positive estimate, ${ex.loggedUnknown} with unknown logged hours`));
 if(est.sample<3){p.append(emptyNote(`Not enough points to plot (${est.sample}). At least 3 completed tickets with a positive estimate and logged hours are needed.`));return p;}
 const controls=el('div','dash-controls');
 controls.append(segmented('Axis',[['all','Show all'],['p90','Zoom to 90% of points']],ui.zoom,(v,k)=>{ui.zoom=v;ctx.rerender(k);}));
 p.append(controls);
 const values=est.points.flatMap(q=>[q.estimate,q.logged]).sort((a,b)=>a-b);
 const p90=values[Math.min(values.length-1,Math.floor(values.length*0.9))];
 const {max,step}=axisScale(ui.zoom==='p90'?p90*1.1:values[values.length-1]*1.05);
 const W=640,H=340,M={l:56,r:16,t:16,b:44},iw=W-M.l-M.r,ih=H-M.t-M.b;
 const X=v=>M.l+Math.min(v,max)/max*iw,Y=v=>M.t+ih-Math.min(v,max)/max*ih;
 const chart=svg('svg',{viewBox:`0 0 ${W} ${H}`,class:'dash-chart',role:'img',preserveAspectRatio:'xMidYMid meet'});
 chart.setAttribute('aria-label',`Scatter of estimated against logged hours for ${est.sample} completed tickets`);
 chart.append(svg('title',{},'Estimated hours against logged hours, with the line where they are equal'));
 for(let i=0;i<=4;i++){const v=step*i;chart.append(svg('line',{x1:M.l,x2:M.l+iw,y1:Y(v),y2:Y(v),class:'dash-grid-line'}),svg('text',{x:M.l-8,y:Y(v)+4,'text-anchor':'end',class:'dash-axis'},formatNumber(v)));
  chart.append(svg('text',{x:X(v),y:M.t+ih+16,'text-anchor':'middle',class:'dash-axis'},formatNumber(v)));}
 chart.append(svg('line',{x1:X(0),y1:Y(0),x2:X(max),y2:Y(max),class:'dash-reference'}));
 chart.append(svg('text',{x:M.l+iw/2,y:H-6,'text-anchor':'middle',class:'dash-axis-title'},'Estimated hours'));
 chart.append(svg('text',{x:14,y:M.t+ih/2,'text-anchor':'middle',transform:`rotate(-90 14 ${M.t+ih/2})`,class:'dash-axis-title'},'Logged hours'));
 let beyond=0;
 for(const q of est.points){
  const outside=q.estimate>max||q.logged>max;if(outside)beyond++;
  const c=svg('circle',{cx:X(q.estimate),cy:Y(q.logged),r:5,tabindex:0,role:'button',class:'dash-point'+(outside?' outside':'')+(q.variance>0?' over':'')});
  c.setAttribute('aria-label',`${q.key}, ${q.client}: estimate ${formatHours(q.estimate)}, logged ${formatHours(q.logged)}`);
  c.append(svg('title',{},`${q.key} · ${q.client}\nEstimate ${formatHours(q.estimate)} · Logged ${formatHours(q.logged)}\nVariance ${signedHours(q.variance)} (${q.variancePct>0?'+':''}${q.variancePct}%)`));
  c.addEventListener('click',()=>ctx.openIssue(q.key));
  c.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();ctx.openIssue(q.key);}});
  chart.append(c);
 }
 p.append(chart);
 if(beyond)p.append(el('p','dash-note',`${beyond} ${beyond===1?'point is':'points are'} beyond the axis and drawn on its edge (outlined). Choose "Show all" to see them at full scale.`));
 p.append(el('p','dash-note','Points above the dashed line used more hours than estimated. Select a point to open its ticket.'));
 p.append(table(['Ticket','Client',{label:'Estimate (h)',num:true},{label:'Logged (h)',num:true},{label:'Variance (h)',num:true},{label:'Variance',num:true}],
  [...est.points].sort((a,b)=>b.variance-a.variance).map(q=>[ticketLink(ctx,q.key),q.client,{text:formatHours(q.estimate),num:true},{text:formatHours(q.logged),num:true},{text:signedHours(q.variance),num:true},{text:(q.variancePct>0?'+':'')+q.variancePct+'%',num:true}])));
 return p;
}

// Overrun Pareto: excess hours, largest first, with cumulative share of the full total.
function paretoPanel(ctx){
 const pareto=paretoOverruns(ctx.rows,10),p=panel('Overrun Pareto','Excess hours above agreement for matched tickets over agreement, largest first. The line is the cumulative share of all excess hours.');
 if(!pareto.bars.length){p.append(emptyNote('No matched ticket is over agreement in this view.'));return p;}
 const items=[...pareto.bars.map(b=>({label:b.key,value:b.excess,share:b.share,cum:b.cumulativeShare,key:b.key,text:`${b.key} · ${b.client}: ${signedHours(b.excess)} (${formatPercent(b.share)}; cumulative ${formatPercent(b.cumulativeShare)})`})),...(pareto.other?[{label:`Other (${pareto.other.count})`,value:pareto.other.excess,share:pareto.other.share,cum:1,text:`Other ${pareto.other.count} tickets: ${signedHours(pareto.other.excess)} (${formatPercent(pareto.other.share)}; cumulative 100%)`}]:[])];
 const W=640,H=340,M={l:56,r:52,t:20,b:76},iw=W-M.l-M.r,ih=H-M.t-M.b,max=Math.max(...items.map(i=>i.value));
 const chart=svg('svg',{viewBox:`0 0 ${W} ${H}`,class:'dash-chart',role:'img'});
 chart.setAttribute('aria-label',`Pareto of overrun hours: ${pareto.count} tickets, ${formatHours(pareto.total)} in total`);
 chart.append(svg('title',{},'Excess hours by ticket with the cumulative share of all excess hours'));
 const band=iw/items.length,barW=band*0.62;
 for(let i=0;i<=4;i++){const v=max*i/4,y=M.t+ih-v/max*ih;chart.append(svg('line',{x1:M.l,x2:M.l+iw,y1:y,y2:y,class:'dash-grid-line'}),svg('text',{x:M.l-8,y:y+4,'text-anchor':'end',class:'dash-axis'},formatNumber(v)));}
 for(let i=0;i<=4;i++){const y=M.t+ih-i/4*ih;chart.append(svg('text',{x:M.l+iw+8,y:y+4,class:'dash-axis'},(i*25)+'%'));}
 const points=[];
 items.forEach((it,i)=>{
  const x=M.l+i*band+(band-barW)/2,h=it.value/max*ih,y=M.t+ih-h;
  const bar=svg('rect',{x,y,width:barW,height:h,class:'dash-pareto-bar'+(it.key?'':' other'),tabindex:it.key?0:-1,role:it.key?'button':'img'});
  bar.setAttribute('aria-label',it.text);bar.append(svg('title',{},it.text));
  if(it.key){bar.addEventListener('click',()=>ctx.openIssue(it.key));bar.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();ctx.openIssue(it.key);}});}
  chart.append(bar);
  chart.append(svg('text',{x:x+barW/2,y:M.t+ih+14,'text-anchor':'end',transform:`rotate(-40 ${x+barW/2} ${M.t+ih+14})`,class:'dash-axis'},it.label));
  points.push([x+barW/2,M.t+ih-it.cum*ih]);
 });
 chart.append(svg('polyline',{points:points.map(q=>q.join(',')).join(' '),class:'dash-cumulative'}));
 points.forEach(([x,y])=>chart.append(svg('circle',{cx:x,cy:y,r:3.5,class:'dash-cumulative-dot'})));
 p.append(chart);
 p.append(el('p','dash-note',`Total excess ${formatHours(pareto.total)} across ${pareto.count} tickets. Shares use this full total${pareto.other?', and "Other" closes the series at 100%':''}.`));
 p.append(table(['Rank','Ticket','Client',{label:'Excess (h)',num:true},{label:'Share',num:true},{label:'Cumulative',num:true}],
  [...pareto.bars.map((b,i)=>[{text:String(i+1),num:true},ticketLink(ctx,b.key),b.client,{text:signedHours(b.excess),num:true},{text:formatPercent(b.share),num:true},{text:formatPercent(b.cumulativeShare),num:true}]),
   ...(pareto.other?[[{text:'—',num:true},`Other (${pareto.other.count})`,'',{text:signedHours(pareto.other.excess),num:true},{text:formatPercent(pareto.other.share),num:true},{text:'100%',num:true}]]:[])]));
 return p;
}
function formatNumber(v){return (Math.round(v*10)/10).toLocaleString('en-GB');}

// ---- Team & Delivery ----
function teamTab(ctx){
 const wrap=el('div','dash-team');
 wrap.append(heatmapPanel(ctx),workloadPanel(ctx),createdCompletedPanel(ctx),effortPanel(ctx));
 return wrap;
}
function heatmapPanel(ctx){
 const ui=ctx.ui,p=panel('Logged hours: employee × client','Each person’s own hours on the selected tickets, not whole-ticket totals. Totals are all-time per ticket. Select a cell to filter to its tickets.');
 const m=employeeClientMatrix(ctx.rows);
 if(!m.cells.length){p.append(emptyNote('No attributable logged hours in this view.'));return p;}
 const controls=el('div','dash-controls');
 controls.append(segmented('People',[[10,'Top 10'],[20,'Top 20'],[9999,'All']],ui.people,(v,k)=>{ui.people=v;ctx.rerender(k);}));
 controls.append(segmented('Clients',[[8,'Top 8'],[15,'Top 15'],[9999,'All']],ui.clients,(v,k)=>{ui.clients=v;ctx.rerender(k);}));
 p.append(controls);
 const people=m.employees.slice(0,ui.people),clients=m.clients.slice(0,ui.clients);
 const cellOf=new Map(m.cells.map(c=>[c.employee+'\u0001'+c.client,c]));
 const wrap=el('div','dash-heat-scroll');const t=el('table','dash-heat');
 const head=t.createTHead().insertRow();head.append(el('th','','Person'));for(const c of clients)head.append(el('th','num',c.label));head.append(el('th','num','Total'));
 const body=t.createTBody();
 for(const person of people){const tr=body.insertRow();tr.append(el('th','',person.name));
  for(const c of clients){const td=tr.insertCell(),cell=cellOf.get(person.name+'\u0001'+c.key);
   if(!cell){td.textContent='';td.className='num';continue;}
   const a=m.max?0.08+0.62*(cell.hours/m.max):0;td.style.background=`color-mix(in srgb, var(--dash-logged) ${Math.round(a*100)}%, var(--surface,#ffffff))`;td.className='num heat-cell';
   const b=button(formatHours(cell.hours),()=>ctx.select('cell',{employee:person.name,client:c.key}),'heat-btn');
   b.setAttribute('aria-label',`${person.name}, ${c.label}: ${formatHours(cell.hours)} on ${new Set(cell.keys).size} tickets`);b.title=b.getAttribute('aria-label');
   td.append(b);}
  tr.append(el('td','num',formatHours(person.hours)));}
 const foot=t.createTFoot().insertRow();foot.append(el('th','','Total'));for(const c of clients)foot.append(el('td','num',formatHours(c.hours)));foot.append(el('td','num',formatHours(m.clients.reduce((n,c)=>n+c.hours,0))));
 wrap.append(t);p.append(wrap);
 const hidden=m.employees.length-people.length,hiddenClients=m.clients.length-clients.length;
 if(hidden||hiddenClients)p.append(el('p','dash-note',`Not shown: ${hidden} more ${hidden===1?'person':'people'} and ${hiddenClients} more ${hiddenClients===1?'client':'clients'}. Use “All” or the table view for the full list.`));
 p.append(legend(m.max));
 p.append(el('p','dash-note',`Cells on ${people.length} people and ${clients.length} clients. Each ticket’s hours are split between the people who logged them.`));
 return p;
}
function legend(max){const l=el('div','dash-legend');l.append(el('span','dash-control-label','Hours per cell'),el('span','dash-legend-scale'),el('span','msg','0 h to '+formatHours(max)));return l;}

function workloadPanel(ctx){
 const w=workloadByStatus(ctx.rows),p=panel('Open work by developer and status','Assignments, not time. Developers come from the ai1 developer labels. A shared ticket counts once in the team totals.');
 if(!w.rows.length){p.append(emptyNote('No open tickets in this view.'));return p;}
 const statuses=w.team.statuses.map(s=>s.status);
 const colorOf=s=>PALETTE[statuses.indexOf(s)%PALETTE.length];
 const legendBox=el('div','dash-status-legend');
 for(const s of w.team.statuses){const item=el('span','dash-status');const sw=el('span','dash-swatch');sw.style.background=colorOf(s.status);item.append(sw,el('span','',`${s.status} ${s.count}`));legendBox.append(item);}
 p.append(legendBox);
 const max=Math.max(1,...w.rows.map(r=>r.tickets));
 const box=el('div','dash-bars');
 for(const r of w.rows){const row=el('div','dash-bar-row'),name=r.name==='__none'?'Unassigned':r.name;
  const head=el('div','dash-bar-head');head.append(el('span','dash-bar-name',name),el('span','dash-bar-tag',`${r.tickets} open${r.shared?` · ${r.shared} shared`:''}`));
  const track=el('div','dash-stack');track.style.width='100%';
  for(const s of r.statuses){const seg=el('span','dash-stack-seg');seg.style.width=(s.count/max*100)+'%';seg.style.background=colorOf(s.status);seg.title=`${name} · ${s.status}: ${s.count}`;seg.setAttribute('aria-label',seg.title);track.append(seg);}
  row.append(head,track);box.append(row);}
 p.append(box);
 p.append(el('p','dash-note',`Team: ${w.team.tickets} open tickets, ${w.team.shared} shared across developers, ${w.team.unassigned} without a developer.`));
 p.append(table(['Developer','Open tickets',{label:'Shared',num:true},'By status'],w.rows.map(r=>[r.name==='__none'?'Unassigned':r.name,{text:String(r.tickets),num:true},{text:String(r.shared),num:true},r.statuses.map(s=>`${s.status} ${s.count}`).join(', ')])));
 return p;
}

// A readable axis: four equal steps of 1, 2, 2.5 or 5 times a power of ten, so the top gridline is a round number.
// Integer axes (counts) never use a fractional step.
function axisScale(value,integer=false){
 const raw=Math.max(value,1)/4,exp=10**Math.floor(Math.log10(raw)),f=raw/exp;
 let step=(f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*exp;
 if(integer)step=Math.max(1,Math.ceil(step));
 return {max:step*4,step};
}

function createdCompletedPanel(ctx){
 const f=weeklyFlow(ctx.rows,ctx.period.start,ctx.period.end),p=panel('Created and completed per week','Weeks run Sunday to Saturday in Asia/Jerusalem. Created uses the original creation date. Completed uses the recorded completion date, the latest completion only.');
 if(!f.weeks.length){p.append(emptyNote('Choose a valid period to see weekly counts.'));return p;}
 const {max,step}=axisScale(Math.max(1,...f.weeks.flatMap(w=>[w.created,w.completed])),true);
 const W=Math.max(640,f.weeks.length*64),H=300,M={l:40,r:12,t:16,b:52},iw=W-M.l-M.r,ih=H-M.t-M.b;
 const chart=svg('svg',{viewBox:`0 0 ${W} ${H}`,class:'dash-chart',role:'img'});
 chart.setAttribute('aria-label',`Tickets created and completed per week, ${f.totals.created} created and ${f.totals.completed} completed`);
 chart.append(svg('title',{},'Tickets created and completed per week'));
 for(let i=0;i<=4;i++){const v=step*i,y=M.t+ih-v/max*ih;chart.append(svg('line',{x1:M.l,x2:M.l+iw,y1:y,y2:y,class:'dash-grid-line'}),svg('text',{x:M.l-6,y:y+4,'text-anchor':'end',class:'dash-axis'},String(v)));}
 const band=iw/f.weeks.length,bw=band*0.34;
 f.weeks.forEach((w,i)=>{const x0=M.l+i*band+band*0.15;
  for(const [k,cls,dx] of [['created','created',0],['completed','completed',bw+2]]){const v=w[k],h=v/max*ih;
   chart.append(svg('rect',{x:x0+dx,y:M.t+ih-h,width:bw,height:h,class:'dash-col '+cls}),svg('title',{},`Week of ${w.start}${w.partial?' (partial)':''} · ${k}: ${v}`));
   if(v)chart.append(svg('text',{x:x0+dx+bw/2,y:M.t+ih-h-4,'text-anchor':'middle',class:'dash-axis'},String(v)));}
  chart.append(svg('text',{x:M.l+i*band+band/2,y:M.t+ih+16,'text-anchor':'middle',class:'dash-axis'},shortDay(w.start)+(w.partial?'*':'')));});
 p.append(legendPair());
 p.append(chart);
 p.append(el('p','dash-note',`Totals in period: ${f.totals.created} created, ${f.totals.completed} completed.${f.unknownCompletion?` ${f.unknownCompletion} closed ${f.unknownCompletion===1?'ticket has':'tickets have'} no completion date and ${f.unknownCompletion===1?'is':'are'} not counted.`:''}${f.unknownCreated?` ${f.unknownCreated} without a creation date are not counted.`:''} * partial week at the edge of the period. Created minus completed is not a backlog history.`));
 p.append(table(['Week starting','Created',{label:'Completed',num:true}],f.weeks.map(w=>[w.start+(w.partial?' (partial)':''),{text:String(w.created),num:true},{text:String(w.completed),num:true}])));
 return p;
}
function legendPair(){const l=el('div','dash-status-legend');for(const [text,cls] of [['Created','created'],['Completed','completed']]){const item=el('span','dash-status');const sw=el('span','dash-swatch '+cls);item.append(sw,el('span','',text));l.append(item);}return l;}

function effortPanel(ctx){
 const p=panel('Dated logged effort, by week','Work entries dated in the period, on the selected tickets. Agreed billing lines are not effort and are left out.');
 const ui=ctx.ui,eff=ctx.effort||{state:'idle'};
 const controls=el('div','dash-controls');controls.append(segmented('Group by',[['employee','Person'],['client','Client']],ui.effortGroup,(v,k)=>{ui.effortGroup=v;ctx.rerender(k);}));p.append(controls);
 if(eff.state==='idle'||eff.state==='loading'){p.append(emptyNote('Loading dated work entries…'));if(eff.state==='idle')ctx.loadEffort();return p;}
 if(eff.state==='error'){p.append(emptyNote(eff.message||'Dated work entries could not be loaded, so this chart is unavailable.'));return p;}
 const e=weeklyEffort(eff.entries,ctx.rows,ctx.period.start,ctx.period.end,ui.effortGroup);
 if(!e.weeks.length){p.append(emptyNote('No dated effort on these tickets in this period.'));}
 else{
  const labels=e.groups.map(g=>g.label),colorOf=l=>PALETTE[labels.indexOf(l)%PALETTE.length];
  const {max,step}=axisScale(Math.max(1,...e.weeks.map(w=>w.total)));
  const W=Math.max(640,e.weeks.length*64),H=300,M={l:40,r:12,t:16,b:52},iw=W-M.l-M.r,ih=H-M.t-M.b;
  const chart=svg('svg',{viewBox:`0 0 ${W} ${H}`,class:'dash-chart',role:'img'});
  chart.setAttribute('aria-label',`Logged hours per week by ${ui.effortGroup==='client'?'client':'person'}`);
  for(let i=0;i<=4;i++){const v=step*i,y=M.t+ih-v/max*ih;chart.append(svg('line',{x1:M.l,x2:M.l+iw,y1:y,y2:y,class:'dash-grid-line'}),svg('text',{x:M.l-6,y:y+4,'text-anchor':'end',class:'dash-axis'},formatNumber(v)));}
  const band=iw/e.weeks.length,bw=band*0.6;
  e.weeks.forEach((w,i)=>{let base=M.t+ih;const x=M.l+i*band+(band-bw)/2;
   for(const g of w.groups){const h=g.hours/max*ih;base-=h;chart.append(svg('rect',{x,y:base,width:bw,height:h,fill:colorOf(g.label),class:'dash-seg-rect'},`${g.label}: ${formatHours(g.hours)}`));}
   chart.append(svg('text',{x:x+bw/2,y:M.t+ih+16,'text-anchor':'middle',class:'dash-axis'},shortDay(w.start)));});
  p.append(el('p','dash-note','Stacked hours per week (h). Legend lists each group’s total for the period.'));
  p.append(chart);
  const legendBox=el('div','dash-status-legend');for(const g of e.groups){const item=el('span','dash-status');const sw=el('span','dash-swatch');sw.style.background=colorOf(g.label);item.append(sw,el('span','',`${g.label} ${formatHours(g.hours)}`));legendBox.append(item);}p.append(legendBox);
 }
 p.append(el('p','dash-note',`Counted ${e.counted} work entries. Not counted: ${e.unattributed} entries without a readable date, person or minutes, or outside the period.`));
 return p;
}
