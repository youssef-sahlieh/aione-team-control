// Checks & Reports: due dates changed directly in Jira (administrators). Shows every due date change in the
// period with the Jira account that made it and the ticket's developers; changes the dashboard applied through
// its date approvals can be shown too. The section is kept across the dashboard's redraws (no reload).
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const button=(text,fn,cls='btn')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const when=v=>new Date(v).toLocaleString('en-GB',{timeZone:'Asia/Jerusalem',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
const date=v=>v?new Date(v+'T12:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}):'No date';

export function createDueChanges({api,openIssue,errorText=e=>e.message||String(e)}){
  let node=null,report=null,days=30,showDashboard=false,loading=false;
  const box=el('div','dc-body');
  async function load(refresh=false){
    if(loading)return;loading=true;box.replaceChildren(el('p','msg','Reading the ticket history from Jira…'));
    try{report=await api('/reports/due-changes?days='+days+(refresh?'&refresh=1':''));draw();}
    catch(err){box.replaceChildren(el('p','msg err',errorText(err)));}
    finally{loading=false;}
  }
  function draw(){
    box.replaceChildren();if(!report)return;
    const direct=report.rows.filter(r=>r.via==='jira'),rows=showDashboard?report.rows:direct;
    const meta=el('p','msg','Checked '+report.ticketsChecked+' tickets changed in the last '+report.days+' days · '+direct.length+' due date '+(direct.length===1?'change':'changes')+' made directly in Jira, '+(report.rows.length-direct.length)+' through the dashboard · as of '+when(report.generatedAt));
    box.append(meta);
    for(const w of report.warnings||[])box.append(el('p','msg err',w));
    // Who changed dates directly in Jira, by Jira account.
    if(direct.length){
      const counts=new Map();for(const r of direct)counts.set(r.by.name,(counts.get(r.by.name)||0)+1);
      const chips=el('div','dc-chips');for(const [name,n] of [...counts].sort((a,b)=>b[1]-a[1]))chips.append(el('span','dc-chip',name+': '+n));
      box.append(chips);
    }
    if(!rows.length){box.append(el('p','msg',showDashboard?'No due date changes in this period.':'No due dates were changed directly in Jira in this period.'));return;}
    const wrap=el('div','dc-scroll'),t=el('table','dc-table'),head=t.createTHead().insertRow();
    for(const h of ['When','Ticket','Due date','Changed by (Jira account)','Ticket developers','How'])head.append(el('th','',h));
    const body=t.createTBody();
    for(const r of rows){
      const tr=body.insertRow(),ticket=el('td'),change=el('td','dc-change');
      ticket.append(button(r.key,()=>openIssue&&openIssue(r.key),'linkbtn'),el('div','dc-title',r.title));ticket.lastChild.dir='auto';
      change.append(el('span','dc-from',date(r.from)),' → ',el('b','',date(r.to)));
      const how=el('td');how.append(el('span','dc-via '+(r.via==='jira'?'jira':'dash'),r.via==='jira'?'Directly in Jira':'Dashboard approval'+(r.dashboardBy?' ('+r.dashboardBy+')':'')));if(r.note)how.append(el('div','msg',r.note));
      tr.append(el('td','dc-when',when(r.at)),ticket,change,el('td','',r.by.name),el('td','',r.developers.length?r.developers.map(d=>'ai1_'+d).join(', '):'—'),how);
    }
    wrap.append(t);box.append(wrap);
  }
  function render(target){
    if(!node){
      node=el('section','dc-section');
      node.append(el('h2','','Due dates changed directly in Jira'),el('p','msg','Every due date change in the period, from Jira\'s own ticket history. Changes made in Jira (not through the dashboard\'s date approvals) are listed with the Jira account that made them. When developers sign in to Jira with a shared account (like Karim\'s or Rami\'s), the ticket\'s developers are shown beside it.'));
      const bar=el('div','dc-bar'),period=el('select','fsel');period.setAttribute('aria-label','Period');
      for(const [v,l] of [[7,'Last 7 days'],[30,'Last 30 days'],[90,'Last 90 days']])period.append(new Option(l,String(v)));
      period.value=String(days);period.addEventListener('change',()=>{days=Number(period.value);load();});
      const all=document.createElement('input');all.type='checkbox';all.addEventListener('change',()=>{showDashboard=all.checked;draw();});
      const lab=el('label','tgl');lab.append(all,' Also show changes made through the dashboard');
      bar.append(period,lab,button('Refresh',()=>load(true)));
      node.append(bar,box);load();
    }
    target.append(node);
  }
  return {render};
}
