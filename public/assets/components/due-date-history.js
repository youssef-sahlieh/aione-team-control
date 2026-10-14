const node=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls||'';if(text!=null)e.textContent=text;return e;};
const date=v=>v?new Date(v+'T00:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}):'Not set';
const cleanDate=v=>{if(!v)return null;const d=new Date(v);return isNaN(d)?null:d.toISOString().slice(0,10);};
export function createDueDateHistory({api,tickets,internal,openIssue}){
 const cache=new Map();let period='7',developer='',generation=0;
 async function history(ticket){
  if(ticket.internal||/^INT-/.test(ticket.key))return (internal(ticket.key)?.dueHistory||[]).map(h=>({key:ticket.key,title:ticket.summary,when:h.when,by:h.by||'Unknown',from:h.from||null,to:h.to||null}));
  const previous=cache.get(ticket.key);if(previous?.updated===ticket.updated)return previous.rows;
  let start=0,rows=[];
  for(let page=0;page<100;page++){
   const result=await api('/jira/issue/'+ticket.key+'/history?startAt='+start);
   if(!Array.isArray(result.values))throw Error('Jira returned incomplete history.');
   for(const event of result.values)for(const item of event.items||[])if(item.field==='duedate'||item.fieldId==='duedate')rows.push({key:ticket.key,title:ticket.summary,when:event.created,by:event.author?.displayName||'Unknown',from:cleanDate(item.from),to:cleanDate(item.to)});
   start+=result.values.length;
   if(result.isLast===true||(Number.isFinite(result.total)&&start>=result.total)){cache.set(ticket.key,{updated:ticket.updated,rows});return rows;}
   if(!result.values.length)throw Error('Jira history pagination stopped before completion.');
  }
  throw Error('Ticket history is too large to load completely.');
 }
 function render(target){
  const run=++generation;const issues=tickets();
  const controls=node('div','date-history-controls');
  const range=node('label','date-developer-filter');range.append(node('span','','Period'));const select=node('select','fsel');select.setAttribute('aria-label','Due date history period');for(const [id,name]of [['1','Today'],['7','Last 7 days'],['30','Last 30 days'],['all','All history']])select.append(new Option(name,id));select.value=period;select.onchange=()=>{period=select.value;renderBody();};range.append(select);controls.append(range);
  const filter=node('label','date-developer-filter');filter.append(node('span','','Ticket developer'));const picker=node('select','fsel');picker.setAttribute('aria-label','History ticket developer');picker.append(new Option('All developers',''));for(const dev of [...new Set(issues.flatMap(i=>i.devs||[]))].sort())picker.append(new Option(dev,dev));if(developer&&!issues.some(i=>i.devs?.includes(developer)))developer='';picker.value=developer;picker.onchange=()=>{developer=picker.value;renderBody();};filter.append(picker);controls.append(filter);
  const refresh=node('button','btn','Reload history');refresh.type='button';refresh.onclick=()=>{cache.clear();render(target);};controls.append(refresh);
  const info=node('p','date-context','History covers '+issues.length+' currently loaded Jira and internal tickets, including changes made before date requests were introduced.');
  const progress=node('p','date-context'),errors=node('div'),body=node('div','date-history-list');target.append(controls,info,progress,errors,body);
  let rows=[],failed=[],finished=0;
  function renderBody(){
   if(run!==generation||!target.isConnected)return;
   body.replaceChildren();errors.replaceChildren();
   if(failed.length){const warning=node('p','date-warning','History is incomplete for '+failed.join(', ')+'. Reload history to retry.');warning.setAttribute('role','alert');errors.append(warning);}
   const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
   const cutoff=period==='all'?0:period==='1'?0:Date.now()-Number(period)*86400000;
   const selected=rows.filter(r=>{const t=issues.find(i=>i.key===r.key);if(developer&&!t?.devs.includes(developer))return false;if(period==='1')return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem'}).format(new Date(r.when))===today;return Date.parse(r.when)>=cutoff;}).sort((a,b)=>Date.parse(b.when)-Date.parse(a.when));
   if(!selected.length)body.append(node('p','date-empty',finished<issues.length?'Loading due-date changes…':failed.length?'No changes loaded for this view. Some history could not be read.':'No due-date changes in this period.'));
   for(const r of selected){const row=node('article','date-history-row');const ticket=node('button','date-ticket-link',r.key+' · '+r.title);ticket.type='button';ticket.onclick=()=>openIssue(r.key);const dates=node('div','date-comparison');dates.append(node('span','',date(r.from)),node('span','date-context','→'),node('strong','',date(r.to)));let shift=!r.from?'First set':!r.to?'Date cleared':Math.round((Date.parse(r.to)-Date.parse(r.from))/86400000);if(typeof shift==='number')shift=shift>0?'+'+shift+' days later':shift<0?Math.abs(shift)+' days earlier':'Same date';row.append(ticket,dates,node('span','date-impact',shift),node('p','date-context',r.by+' · '+new Date(r.when).toLocaleString('en-GB',{timeZone:'Asia/Jerusalem'})));body.append(row);}
  }
  target.replaceChildren(controls,info,progress,errors,body);renderBody();
  const queue=issues.slice();const work=async()=>{while(queue.length&&run===generation&&target.isConnected){const ticket=queue.shift();try{rows.push(...await history(ticket));}catch{failed.push(ticket.key);}finished++;if(run===generation&&target.isConnected){progress.textContent=finished<issues.length?'Loading '+finished+' of '+issues.length+' ticket histories…':selectedCount();renderBody();}}};
  const selectedCount=()=>rows.length+' recorded date change'+(rows.length===1?'':'s')+(failed.length?' · Partial history':'');
  Promise.all(Array.from({length:Math.min(4,issues.length)},work)).then(()=>{if(run===generation&&target.isConnected)progress.textContent=selectedCount();});
 }
 return {render};
}
