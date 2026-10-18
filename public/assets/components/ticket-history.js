const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;};

// Jira records every dashboard change under the proxy's one account, so the proxy keeps its own history with
// the real person (GET /ticket-log). It is shown first, and Jira entries it explains show that person.
const ACTIONS={status:"Moved status",assignee:"Changed assignee",developers:"Changed developers",comment:"Commented",due:"Set the due date",edit:"Edited",created:"Created the ticket"};
const FIELDS={status:"Status",assignee:"Assignee",developers:"Developers",duedate:"Due date",title:"Title",priority:"Priority",description:"Description"};
const JIRA_FIELD={status:["status"],assignee:["assignee"],developers:["labels"],duedate:["duedate"]};
function changeLine(label,from,to){
  const line=node("div","ticket-history-change");line.appendChild(node("strong","",label));const values=node("div","ticket-history-values");
  for(const [l,value] of [["From",from],["To",to]]){const field=node("div","");field.appendChild(node("span","history-value-label",l));const text=node("div","history-value",value===null||value===undefined||value===""?"Not set":String(value));text.dir="auto";field.appendChild(text);values.appendChild(field);}
  line.appendChild(values);return line;
}

export function createTicketHistory({api,getIssue,allowed,formatTime,personName=k=>k}) {
  const box=document.getElementById("d-full-history"),cache=new Map();let generation=0,busy="",local=[];
  // The dashboard change behind a Jira entry: same field, within two minutes.
  function realAuthor(h){
    const at=Date.parse(h.created),fields=(h.items||[]).map(i=>String(i.field||i.fieldId||"").toLowerCase());
    const e=local.find(e=>Math.abs(Date.parse(e.at)-at)<=120000&&Object.keys(e.changes||{}).some(f=>(JIRA_FIELD[f]||[f]).some(x=>fields.includes(x))));
    return e?e.by.name:null;
  }
  function paintLocal(){
    if(!local.length)return;
    const section=node("section","ticket-history-local");section.appendChild(node("h4","","Changes made in AION Team Control ("+local.length+")"));
    for(const e of [...local].reverse()){
      const entry=node("article","ticket-history-entry");const header=node("div","ticket-history-meta");
      header.appendChild(node("strong","",e.by?.name||e.by?.email||"Someone"));header.appendChild(node("span","",ACTIONS[e.action]||"Changed"));
      const time=node("time","",formatTime(e.at));time.dateTime=e.at;header.appendChild(time);entry.appendChild(header);
      for(const [f,c] of Object.entries(e.changes||{}))entry.appendChild(changeLine(FIELDS[f]||f,f==="assignee"?personName(c.from):c.from,f==="assignee"?personName(c.to):c.to));
      if(e.text){const t=node("div","history-value",e.text);t.dir="auto";entry.appendChild(t);}
      section.appendChild(entry);
    }
    box.appendChild(section);
  }
  function paint(rows,status,error,key){
    box.replaceChildren();paintLocal();if(local.length&&rows.length)box.appendChild(node("h4","ticket-history-jira","Jira history"));
    const count=node("p","msg",status);count.setAttribute("role","status");box.appendChild(count);
    for(const history of [...rows].sort((a,b)=>Date.parse(b.created)-Date.parse(a.created))){
      const entry=node("article","ticket-history-entry");const header=node("div","ticket-history-meta");
      const real=realAuthor(history);
      header.appendChild(node("strong","",real?real+" (via AION Team Control)":history.author?.displayName||"Unknown author"));
      const time=node("time","",formatTime(history.created));if(history.created)time.dateTime=history.created;header.appendChild(time);entry.appendChild(header);
      for(const change of history.items||[])entry.appendChild(changeLine(change.field||change.fieldId||"Field",change.fromString??change.from,change.toString??change.to));
      box.appendChild(entry);
    }
    if(error){box.appendChild(node("p","msg err",error));const retry=node("button","btn","Retry history");retry.type="button";retry.addEventListener("click",()=>load(key,true));box.appendChild(retry);const href=document.getElementById('d-open')?.href;if(href&&/^https:\/\//.test(href)){const link=node('a','btn','Open ticket in Jira');link.href=href;link.target='_blank';link.rel='noopener';box.appendChild(link);}}
  }
  async function load(key,force=false){
    if(!allowed()||getIssue()?.key!==key)return;
    const version=getIssue().updated||"";const saved=cache.get(key);
    if(!force&&saved?.version===version&&saved.local){local=saved.local;paint(saved.rows,`${saved.rows.length} change events · Complete Jira field history`,null,key);return;}
    if(busy===key&&!force)return;
    const turn=++generation;busy=key;const rows=[],ids=new Set();let offset=0;
    const current=()=>turn===generation&&allowed()&&getIssue()?.key===key;
    local=[];paint(rows,"Loading ticket history…",null,key);box.setAttribute("aria-busy","true");
    try{
      try{local=(await api("/ticket-log?key="+encodeURIComponent(key))).events||[];}catch{local=[];}
      if(!current())return;
      if(/^INT-\d+$/.test(key)){paint([],local.length?"":"No changes recorded yet.",null,key);return;}
      while(current()){
        let page;
        try{page=await api(`/jira/issue/${encodeURIComponent(key)}/history?startAt=${offset}`);}
        catch(err){
          if(offset!==0||!(err.status===404||err.code==='not_found'))throw err;
          // Older deployed proxies expose expanded changelogs, but not the paginated route.
          const legacy=await api(`/jira/issue/${encodeURIComponent(key)}/changelog`);
          if(!current())return;
          const log=legacy.changelog;
          if(!log||!Array.isArray(log.histories))throw new Error('The server did not return Jira change history.');
          const unique=[...new Map(log.histories.map(h=>[String(h.id??JSON.stringify(h)),h])).values()];
          const complete=Number.isInteger(log.total)&&log.total>=0&&unique.length===log.total;
          if(complete){cache.set(key,{version,rows:unique,local});if(cache.size>5)cache.delete(cache.keys().next().value);paint(unique,`${unique.length} change events · Complete Jira field history`,null,key);}
          else{paint(unique,`${unique.length}${Number.isInteger(log.total)?' of '+log.total:''} change events · Older history may be missing`,'The deployed API needs the paginated history update to load every Jira change. Open the ticket in Jira for its full history.',key);}
          return;
        }
        if(!current())return;
        if(!Array.isArray(page.values)||page.startAt!==offset)throw new Error("Jira returned an invalid history page.");
        let added=0;for(const item of page.values){const id=String(item.id??JSON.stringify(item));if(!ids.has(id)){ids.add(id);rows.push(item);added++;}}
        const next=offset+page.values.length;
        const complete=page.isLast===true||(Number.isInteger(page.total)&&next>=page.total);
        if(complete){cache.set(key,{version,rows,local});if(cache.size>5)cache.delete(cache.keys().next().value);paint(rows,`${rows.length} change events · Complete Jira field history`,null,key);return;}
        if(!page.values.length||!added||next<=offset)throw new Error("History pagination stopped before all changes were returned.");
        paint(rows,`${rows.length}${Number.isInteger(page.total)?" of "+page.total:""} change events loaded…`,null,key);offset=next;
      }
    }catch(err){if(current())paint(rows,rows.length?`${rows.length} change events loaded · History incomplete`:'Could not load Jira history',err.message||"Could not load history.",key);}
    finally{if(turn===generation){busy="";box.setAttribute("aria-busy","false");}}
  }
  return {load,reset(){generation++;busy="";box.replaceChildren();box.setAttribute("aria-busy","false");}};
}
