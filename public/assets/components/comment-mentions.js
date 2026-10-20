// Keep readable names in the composer and serialize selected Jira account IDs on send.
// When local() is true (internal tickets, internal notes) the people come from the dashboard instead:
// names stay as typed, and mentioned() gives the emails of the people still mentioned in the text.
let pickers=0;
export function createCommentMentions({textarea,search,enabled,local=()=>false,people,onChoose}) {
  const n=pickers++,box=document.createElement('div');box.className='mention-picker';box.id='comment-mention-picker'+(n?'-'+n:'');box.setAttribute('role','listbox');box.hidden=true;textarea.after(box);
  const hint=document.createElement('p');hint.className='mention-hint';box.after(hint);
  textarea.setAttribute('aria-controls',box.id);textarea.setAttribute('aria-expanded','false');
  let previous=textarea.value,mentions=[],timer,turn=0,choices=[],active=0,query=null;
  function label(){const own=local();box.setAttribute('aria-label',own?'Mention someone':'Mention a Jira user');hint.textContent=own?'Type @ to mention someone. They get a notification and an email.':'Type @ and at least two letters to mention someone.';hint.hidden=!enabled();}
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
    mentions.push({start:match.start,end:match.start+label.length,label,id:person.accountId});close();textarea.focus();onChoose?.(person);
  }
  function message(text){box.replaceChildren();const n=document.createElement('div');n.className='mention-message';n.setAttribute('role','status');n.textContent=text;box.append(n);}
  // Dashboard people ({name,email}) match on the start of any word of their name or their email.
  async function findPeople(term){
    const t=term.toLowerCase(),list=await people();
    return (Array.isArray(list)?list:[]).filter(p=>!t||p.name.toLowerCase().startsWith(t)||p.name.toLowerCase().split(/\s+/).some(w=>w.startsWith(t))||p.email.toLowerCase().startsWith(t)).slice(0,8).map(p=>({displayName:p.name,accountId:p.email}));
  }
  function update(){
    sync();close();label();if(!enabled())return;
    const end=textarea.selectionStart;if(end!==textarea.selectionEnd||mentions.some(m=>end>m.start&&end<=m.end))return;
    const match=textarea.value.slice(0,end).match(/(?:^|\s)@([^@\n]{0,60})$/);if(!match)return;
    const own=local(),term=match[1].trim();if(term.length<(own?0:2))return;
    query={start:end-match[1].length-1,end};box.hidden=false;textarea.setAttribute('aria-expanded','true');message('Searching people…');const version=turn;
    timer=setTimeout(async()=>{
      try{
        const found=own?await findPeople(term):await search(term);if(version!==turn||!enabled())return;
        choices=(Array.isArray(found)?found:[]).filter(p=>p.active!==false&&p.accountType!=='app'&&typeof p.displayName==='string'&&(own?/^[^@\s]+@[^@\s]+$/:/^[\w:-]{1,128}$/).test(p.accountId));active=0;
        if(!choices.length){message('No matching people. Try another name.');return;}
        box.replaceChildren();choices.forEach((p,i)=>{const b=document.createElement('button');b.type='button';b.className='mention-option';b.id=box.id+'-person-'+i;b.setAttribute('role','option');b.tabIndex=-1;b.textContent=p.displayName;b.addEventListener('mousedown',e=>e.preventDefault());b.addEventListener('click',()=>choose(i));box.append(b);});mark();
      }catch{if(version===turn)message('People search unavailable. Try typing the name again.');}
    },own?0:200);
  }
  textarea.addEventListener('input',update);textarea.addEventListener('click',update);
  textarea.addEventListener('keydown',e=>{
    if(box.hidden)return;
    if(e.key==='Escape'){e.preventDefault();close();}
    else if(choices.length&&['ArrowDown','ArrowUp','Enter'].includes(e.key)){e.preventDefault();if(e.key==='Enter')choose(active);else{active=(active+(e.key==='ArrowDown'?1:-1)+choices.length)%choices.length;mark();}}
  });
  textarea.addEventListener('blur',()=>setTimeout(()=>{if(!box.contains(document.activeElement))close();},0));
  label();
  return {
    reset(){close();mentions=[];previous=textarea.value;label();},
    mentioned(){sync();return [...new Set(mentions.filter(m=>textarea.value.slice(m.start,m.end)===m.label).map(m=>m.id))];},
    text(){sync();let result=textarea.value;if(local())return result.trim();for(const m of [...mentions].sort((a,b)=>b.start-a.start))if(result.slice(m.start,m.end)===m.label)result=result.slice(0,m.start)+'[~accountid:'+m.id+']'+result.slice(m.end);return result.trim();}
  };
}
