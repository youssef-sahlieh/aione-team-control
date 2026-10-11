const element=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;};

// The selection is staged inside the dialog. Only Apply changes ticket filters.
export function createAssigneeFilter({getSelection,getOptions,getDefaults,getCounts,onApply}) {
  const dialog=element("dialog","assignee-picker");dialog.id="assignee-filter-dialog";dialog.setAttribute("aria-labelledby","assignee-picker-title");
  const heading=element("header","assignee-picker-header");const title=element("h2",null,"Assignee");title.id="assignee-picker-title";
  const close=element("button","icon-btn","×");close.type="button";close.setAttribute("aria-label","Close assignee filter");heading.append(title,close);
  const search=element("input","inp assignee-search");search.type="search";search.placeholder="Search people…";search.setAttribute("aria-label","Search assignees");
  const list=element("div","assignee-picker-list");const hint=element("p","assignee-picker-hint","Select one or more people. Changes apply when you press Apply.");
  const status=element("p","assignee-picker-status");status.setAttribute("role","status");
  const footer=element("footer","assignee-picker-footer");const reset=element("button","btn","Reset to default"),cancel=element("button","btn","Cancel"),apply=element("button","btn primary","Apply");
  for(const button of [reset,cancel,apply])button.type="button";
  footer.append(reset,cancel,apply);dialog.append(heading,search,hint,list,status,footer);document.body.appendChild(dialog);
  let draft=new Set(),launcher=null,options=[],counts={},defaults=[];
  function paint(){
    list.replaceChildren();const query=search.value.trim().toLocaleLowerCase();let matches=0;
    for(const [label,keys] of [["Default people",defaults],["Optional people",options.map(([key])=>key).filter(key=>!defaults.includes(key))]]){
      const group=element("fieldset","assignee-picker-group");group.appendChild(element("legend",null,label));let added=0;
      for(const [key,name] of options){if(!keys.includes(key)||!name.toLocaleLowerCase().includes(query))continue;added++;matches++;
        const row=element("label","assignee-picker-option");const check=element("input","ck");check.type="checkbox";check.checked=draft.has(key);check.setAttribute("aria-label",name);
        const person=element("span","assignee-person");const avatar=element("span","assignee-avatar",key==="other"?"+":name.split(/\s+/).slice(0,2).map(s=>s[0]).join(""));avatar.setAttribute("aria-hidden","true");person.append(avatar,element("span",null,name));
        row.append(check,person,element("span","assignee-match-count",String(counts[key]||0)));row.classList.toggle("selected",check.checked);
        check.addEventListener("change",()=>{check.checked?draft.add(key):draft.delete(key);row.classList.toggle("selected",check.checked);status.textContent=draft.size?`${draft.size} selected`:"Select at least one assignee.";});group.appendChild(row);
      }
      if(added)list.appendChild(group);
    }
    if(!matches)list.appendChild(element("p","empty-copy","No people match your search. Try another name."));
    status.textContent=draft.size?`${draft.size} selected`:"Select at least one assignee.";
  }
  function open(button){
    launcher=button;draft=new Set(getSelection());options=[...getOptions(),["other","Others"]];defaults=getDefaults();counts=getCounts();search.value="";paint();
    const rect=button.getBoundingClientRect();dialog.style.setProperty("--picker-left",Math.max(12,Math.min(rect.left,innerWidth-372))+"px");dialog.style.setProperty("--picker-top",Math.max(12,Math.min(rect.bottom+8,innerHeight-540))+"px");
    button.setAttribute("aria-expanded","true");dialog.showModal();search.focus();
  }
  close.addEventListener("click",()=>dialog.close());cancel.addEventListener("click",()=>dialog.close());search.addEventListener("input",paint);
  dialog.addEventListener("keydown",e=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();dialog.close();}});
  reset.addEventListener("click",()=>{draft=new Set(defaults);paint();});
  apply.addEventListener("click",()=>{if(!draft.size){status.textContent="Select at least one assignee.";return;}const selected=new Set(draft);dialog.close();onApply(selected);document.getElementById("assignee-filter-trigger")?.focus();});
  dialog.addEventListener("close",()=>{launcher?.setAttribute("aria-expanded","false");if(launcher?.isConnected)launcher.focus();});
  dialog.addEventListener("click",e=>{if(e.target!==dialog)return;const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();});
  return {renderButton(){
    const field=element("div","quick-field assignee-filter-field");const button=element("button","assignee-filter-trigger");button.type="button";button.id="assignee-filter-trigger";button.setAttribute("aria-haspopup","dialog");button.setAttribute("aria-controls",dialog.id);button.setAttribute("aria-expanded","false");
    const selected=getSelection(),names=[...getOptions(),["other","Others"]].filter(([key])=>selected.has(key)).map(([,name])=>name);
    const isDefault=selected.size===getDefaults().length&&getDefaults().every(key=>selected.has(key));
    const label=names.length===1?names[0]:`${names.length} selected`;
    button.append(element("span","filter-button-label","Assignee"),element("span","filter-button-value",label),element("span","filter-button-caret","⌄"));button.title=names.join(", ")+(isDefault?" (default)":"");button.setAttribute("aria-label","Assignee: "+names.join(", ")+(isDefault?" (default)":""));
    field.appendChild(element("span",null,"Assignee"));field.appendChild(button);button.addEventListener("click",()=>open(button));return field;
  }};
}
