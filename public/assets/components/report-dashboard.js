import {agreementGroups,GROUP_SORTS,paretoOverruns,estimateAccuracy,formatHours,formatPercent} from '../models/report-stats.js';

// The dashboard renders the rows it is given. Every chart, card and table reads the same rows, so they agree.
// ctx: {rows, selection, labels, ui, openIssue, select(kind, value), rerender(key)}
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const button=(text,fn,cls='linkbtn')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const svg=(name,attrs={},text)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v));if(text!=null)n.textContent=text;return n;};
const pctOf=(part,whole)=>whole>0?part/whole:null;
const signedHours=v=>(v>0?'+':v<0?'−':'')+formatHours(Math.abs(v));

// Chart selections (client, project) shown as removable chips: always visible, even while the charts are closed.
export function selectionChips(ctx){return selectionBar(ctx);}
// The agreed-vs-logged charts: Checks & Reports shows them on demand. Team workload and created/completed trends are
// not here: Workload and Analytics own them (docs/admin-pages-redesign.md).
export function agreementCharts(ctx){
 const root=el('div','report-dashboard');
 root.append(hoursTab(ctx));
 return root;
}

// ---- Selection chips ----
function selectionBar(ctx){
 const sel=ctx.selection,chips=[];
 const t=ctx.rows;
 if(sel.client)chips.push(['client',`Client: ${ctx.labels.client(sel.client)}`]);
 if(sel.project)chips.push(['project',`Project: ${ctx.labels.project(sel.project)}`]);
 const bar=el('div','dash-chips');bar.tabIndex=-1;
 bar.append(el('span','msg',`${t.length} ${t.length===1?'ticket':'tickets'} in this view`));
 for(const [kind,label] of chips){const c=button('× '+label,()=>ctx.select(kind,null),'chip');c.setAttribute('aria-label','Remove filter '+label);bar.append(c);}
 if(chips.length)bar.append(button('Clear selection',()=>ctx.select('all',null),'btn'));
 return bar;
}

// ---- Shared pieces ----
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

// A readable axis: four equal steps of 1, 2, 2.5 or 5 times a power of ten, so the top gridline is a round number.
// Integer axes (counts) never use a fractional step.
function axisScale(value,integer=false){
 const raw=Math.max(value,1)/4,exp=10**Math.floor(Math.log10(raw)),f=raw/exp;
 let step=(f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*exp;
 if(integer)step=Math.max(1,Math.ceil(step));
 return {max:step*4,step};
}
