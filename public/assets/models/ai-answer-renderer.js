// Deliberately small Markdown subset. Model text never becomes HTML or arbitrary URLs.
export function renderAIAnswer(document,container,content,references,onTicket){
 const refs=new Map(references.filter(r=>r&&/^[A-Z][A-Z0-9_]*-\d+$/.test(r.key)).map(r=>[r.key,r]));
 function plain(parent,value){for(const part of value.split(/(\b[A-Z][A-Z0-9_]*-\d+\b)/)){if(refs.has(part)){const link=document.createElement('a');link.className='ai-ticket-link';link.textContent=part;link.href='dashboard.html#'+encodeURIComponent(part);link.title=refs.get(part).title||part;link.addEventListener('click',e=>{if(e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;e.preventDefault();onTicket(part);});parent.append(link);}else parent.append(document.createTextNode(part));}}
 function inline(parent,value){for(const part of value.split(/(\*\*[^*\n]+\*\*)/)){if(part.startsWith('**')&&part.endsWith('**')){const strong=document.createElement('strong');plain(strong,part.slice(2,-2));parent.append(strong);}else plain(parent,part);}}
 let paragraph=[],lists=[],summaryNext=false;
 function flush(){if(paragraph.length){const p=document.createElement('p');if(!container.childElementCount||summaryNext)p.className='ai-answer-summary';inline(p,paragraph.join('\n'));container.append(p);paragraph=[];summaryNext=false;}}
 for(const line of content.split('\n')){
  const heading=/^#{1,4}\s+(.+)$/.exec(line)||/^\*\*([^*]{1,70})\*\*\s*$/.exec(line),bullet=/^(\s*)([-*]|\d+[.)])\s+(.+)$/.exec(line);
  if(!line.trim()){flush();continue;}
  if(heading){flush();lists=[];const h=document.createElement('h3');inline(h,heading[1]);container.append(h);summaryNext=/^(summary|conclusion|overview)$/i.test(heading[1]);}
  else if(bullet){flush();const indent=bullet[1].replace(/\t/g,'  ').length,tag=/^\d/.test(bullet[2])?'ol':'ul';while(lists.length&&lists.at(-1).indent>indent)lists.pop();
   if(!lists.length||lists.at(-1).indent<indent||lists.at(-1).tag!==tag){if(lists.length&&lists.at(-1).indent===indent)lists.pop();const list=document.createElement(tag);if(tag==='ol')list.start=Number.parseInt(bullet[2],10);const parent=lists.at(-1)?.list.lastElementChild||container;parent.append(list);lists.push({indent,tag,list});}
   const li=document.createElement('li');inline(li,bullet[3]);lists.at(-1).list.append(li);
  }else if(lists.length&&/^\s+\S/.test(line)){const li=lists.at(-1).list.lastElementChild;li.append(document.createElement('br'));inline(li,line.trim());}
  else{lists=[];paragraph.push(line);}
 }
 flush();
}
