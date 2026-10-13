const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;};

export function createTicketHistory({api,getIssue,allowed,formatTime}) {
  const box=document.getElementById("d-full-history"),cache=new Map();let generation=0,busy="";
  function paint(rows,status,error,key){
    box.replaceChildren();const count=node("p","msg",status);count.setAttribute("role","status");box.appendChild(count);
    for(const history of [...rows].sort((a,b)=>Date.parse(b.created)-Date.parse(a.created))){
      const entry=node("article","ticket-history-entry");const header=node("div","ticket-history-meta");
      header.appendChild(node("strong","",history.author?.displayName||"Unknown author"));
      const time=node("time","",formatTime(history.created));if(history.created)time.dateTime=history.created;header.appendChild(time);entry.appendChild(header);
      for(const change of history.items||[]){
        const line=node("div","ticket-history-change");line.appendChild(node("strong","",change.field||change.fieldId||"Field"));
        const values=node("div","ticket-history-values");
        for(const [label,value] of [["From",change.fromString??change.from],["To",change.toString??change.to]]){
          const field=node("div","");field.appendChild(node("span","history-value-label",label));const text=node("div","history-value",value===null||value===undefined||value===""?"Not set":String(value));text.dir="auto";field.appendChild(text);values.appendChild(field);
        }
        line.appendChild(values);entry.appendChild(line);
      }
      box.appendChild(entry);
    }
    if(error){box.appendChild(node("p","msg err",error));const retry=node("button","btn","Retry history");retry.type="button";retry.addEventListener("click",()=>load(key,true));box.appendChild(retry);const href=document.getElementById('d-open')?.href;if(href&&/^https:\/\//.test(href)){const link=node('a','btn','Open ticket in Jira');link.href=href;link.target='_blank';link.rel='noopener';box.appendChild(link);}}
  }
  async function load(key,force=false){
    if(!allowed()||getIssue()?.key!==key)return;
    const version=getIssue().updated||"";const saved=cache.get(key);
    if(!force&&saved?.version===version){paint(saved.rows,`${saved.rows.length} change events · Complete Jira field history`,null,key);return;}
    if(busy===key&&!force)return;
    const turn=++generation;busy=key;const rows=[],ids=new Set();let offset=0;
    const current=()=>turn===generation&&allowed()&&getIssue()?.key===key;
    paint(rows,"Loading ticket history…",null,key);box.setAttribute("aria-busy","true");
    try{
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
          if(complete){cache.set(key,{version,rows:unique});if(cache.size>5)cache.delete(cache.keys().next().value);paint(unique,`${unique.length} change events · Complete Jira field history`,null,key);}
          else{paint(unique,`${unique.length}${Number.isInteger(log.total)?' of '+log.total:''} change events · Older history may be missing`,'The deployed API needs the paginated history update to load every Jira change. Open the ticket in Jira for its full history.',key);}
          return;
        }
        if(!current())return;
        if(!Array.isArray(page.values)||page.startAt!==offset)throw new Error("Jira returned an invalid history page.");
        let added=0;for(const item of page.values){const id=String(item.id??JSON.stringify(item));if(!ids.has(id)){ids.add(id);rows.push(item);added++;}}
        const next=offset+page.values.length;
        const complete=page.isLast===true||(Number.isInteger(page.total)&&next>=page.total);
        if(complete){cache.set(key,{version,rows});if(cache.size>5)cache.delete(cache.keys().next().value);paint(rows,`${rows.length} change events · Complete Jira field history`,null,key);return;}
        if(!page.values.length||!added||next<=offset)throw new Error("History pagination stopped before all changes were returned.");
        paint(rows,`${rows.length}${Number.isInteger(page.total)?" of "+page.total:""} change events loaded…`,null,key);offset=next;
      }
    }catch(err){if(current())paint(rows,rows.length?`${rows.length} change events loaded · History incomplete`:'Could not load Jira history',err.message||"Could not load history.",key);}
    finally{if(turn===generation){busy="";box.setAttribute("aria-busy","false");}}
  }
  return {load,reset(){generation++;busy="";box.replaceChildren();box.setAttribute("aria-busy","false");}};
}
