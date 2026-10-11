const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls;if(text)n.textContent=text;return n;};

export function createTicketBriefs({api}) {
  let enabled=false,identity="",generation=0;
  const cache=new Map();
  function paint(cell,issue,entry) {
    cell.replaceChildren();cell.setAttribute("aria-busy",String(entry?.busy||false));
    if(issue.internal){cell.appendChild(node("span","brief-unavailable","—"));cell.title="AI briefs support Jira tickets.";return;}
    if(entry?.brief){const text=node("span","ticket-brief-text",entry.brief);text.dir="auto";cell.appendChild(text);cell.title="AI-generated brief. Open the ticket for full details.";return;}
    const button=node("button","brief-generate",entry?.busy?"Summarizing…":entry?.error?"Retry brief":"Generate brief");
    button.type="button";button.disabled=!!entry?.busy;button.setAttribute("aria-label",(entry?.error?"Retry brief for ":"Generate brief for ")+issue.key);
    button.addEventListener("click",event=>{event.stopPropagation();generate(issue);});cell.appendChild(button);
    if(entry?.error){const error=node("span","brief-error",entry.error);error.setAttribute("role","status");cell.appendChild(error);}
  }
  function refresh(issue,entry) {
    for(const cell of document.querySelectorAll(".c-brief[data-ticket-key]"))if(cell.dataset.ticketKey===issue.key&&cell.dataset.ticketUpdated===(issue.updated||""))paint(cell,issue,entry);
  }
  async function generate(issue) {
    const id=issue.key+":"+(issue.updated||"");if(!enabled||cache.get(id)?.busy)return;
    const entry={busy:true};cache.set(id,entry);refresh(issue,entry);const turn=generation;
    try {
      const result=await api("/ai/brief",{method:"POST",body:{key:issue.key}});
      if(turn!==generation)return;
      if(result.key!==issue.key||typeof result.brief!=="string"||!result.brief.trim())throw new Error("No brief returned. Try again.");
      // If Jira changed during generation, don't label the old row with a different version's brief.
      if(result.updated!==(issue.updated||""))throw new Error("Ticket changed. Refresh tickets to generate its brief.");
      entry.brief=result.brief.slice(0,320);
    } catch(err){if(turn!==generation)return;entry.error=err.code==="network"?"Could not connect. Try again.":err.message||"Could not generate a brief.";}
    finally {if(turn===generation){entry.busy=false;refresh(issue,entry);}}
    // Keep session memory bounded; no ticket text is written to browser storage.
    if(cache.size>200)for(const [key,value] of cache){if(!value.busy&&key!==id){cache.delete(key);if(cache.size<=200)break;}}
  }
  return {
    configure(cfg){const next=[cfg.email,cfg.role,cfg.dev].join(":");if(next!==identity||!cfg.ai?.enabled){generation++;cache.clear();}identity=next;enabled=!!cfg.ai?.enabled;},
    enabled:()=>enabled,
    renderCell(issue){const cell=node("div","c-brief ticket-brief");cell.dataset.ticketKey=issue.key;cell.dataset.ticketUpdated=issue.updated||"";paint(cell,issue,cache.get(issue.key+":"+(issue.updated||"")));return cell;}
  };
}
