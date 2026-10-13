// Keep readable names in the composer and serialize selected Jira account IDs on send.
export function createCommentMentions({textarea,search,enabled}) {
  const box=document.createElement('div');box.className='mention-picker';box.id='comment-mention-picker';box.setAttribute('role','listbox');box.setAttribute('aria-label','Mention a Jira user');box.hidden=true;textarea.after(box);
  const hint=document.createElement('p');hint.className='mention-hint';hint.textContent='Type @ and at least two letters to mention someone.';box.after(hint);
  textarea.setAttribute('aria-controls',box.id);textarea.setAttribute('aria-expanded','false');
  let previous=textarea.value,mentions=[],timer,turn=0,choices=[],active=0,query=null;
  function close(){clearTimeout(timer);turn++;box.hidden=true;textarea.setAttribute('aria-expanded','false');textarea.removeAttribute('aria-activedescendant');choices=[];query=null;}
  function sync(){
    const next=textarea.value;if(next===previous)return;
    let start=0;while(start<previous.length&&start<next.length&&previous[start]===next[start])start++;
    let end=previous.length,tail=next.length;while(end>start&&tail>start&&previous[end-1]===next[tail-1]){end--;tail--;}
    const delta=tail-end;
    mentions=mentions.filter(m=>{if(end<=m.start){m.start+=delta;m.end+=delta;return true;}return start>=m.end;});previous=next;
  }
  function mark(){[...box.querySelectorAll('[role=option]')].forEach((b,i)=>{b.setAttribute('aria-selected',String(i===active));if(i===active)textarea.setAttribute('aria-activedescendant',b.id);});}
  function choose(index){
    const person=choices[index],match=query;if(!person||!match)return;
    const label='@'+person.displayName;
    textarea.setRangeText(label+' ',match.start,match.end,'end');sync();
    mentions.push({start:match.start,end:match.start+label.length,label,id:person.accountId});close();textarea.focus();
  }
  function message(text){box.replaceChildren();const n=document.createElement('div');n.className='mention-message';n.setAttribute('role','status');n.textContent=text;box.append(n);}
  function update(){
    sync();close();hint.hidden=!enabled();if(!enabled())return;
    const end=textarea.selectionStart;if(end!==textarea.selectionEnd||mentions.some(m=>end>m.start&&end<=m.end))return;
    const match=textarea.value.slice(0,end).match(/(?:^|\s)@([^@\n]{0,60})$/);if(!match)return;
    const term=match[1].trim();if(term.length<2)return;
    query={start:end-match[1].length-1,end};box.hidden=false;textarea.setAttribute('aria-expanded','true');message('Searching people…');const version=turn;
    timer=setTimeout(async()=>{
      try{
        const people=await search(term);if(version!==turn||!enabled())return;
        choices=(Array.isArray(people)?people:[]).filter(p=>p.active!==false&&p.accountType!=='app'&&typeof p.displayName==='string'&&/^[\w:-]{1,128}$/.test(p.accountId));active=0;
        if(!choices.length){message('No matching people. Try another name.');return;}
        box.replaceChildren();choices.forEach((p,i)=>{const b=document.createElement('button');b.type='button';b.className='mention-option';b.id='mention-person-'+i;b.setAttribute('role','option');b.tabIndex=-1;b.textContent=p.displayName;b.addEventListener('mousedown',e=>e.preventDefault());b.addEventListener('click',()=>choose(i));box.append(b);});mark();
      }catch{if(version===turn)message('People search unavailable. Try typing the name again.');}
    },200);
  }
  textarea.addEventListener('input',update);textarea.addEventListener('click',update);
  textarea.addEventListener('keydown',e=>{
    if(box.hidden)return;
    if(e.key==='Escape'){e.preventDefault();close();}
    else if(choices.length&&['ArrowDown','ArrowUp','Enter'].includes(e.key)){e.preventDefault();if(e.key==='Enter')choose(active);else{active=(active+(e.key==='ArrowDown'?1:-1)+choices.length)%choices.length;mark();}}
  });
  textarea.addEventListener('blur',()=>setTimeout(()=>{if(!box.contains(document.activeElement))close();},0));
  return {
    reset(){close();mentions=[];previous=textarea.value;hint.hidden=!enabled();},
    text(){sync();let result=textarea.value;for(const m of [...mentions].sort((a,b)=>b.start-a.start))if(result.slice(m.start,m.end)===m.label)result=result.slice(0,m.start)+'[~accountid:'+m.id+']'+result.slice(m.end);return result.trim();}
  };
}
