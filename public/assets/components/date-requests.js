const node=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls||'';if(text!=null)e.textContent=text;return e;};
const button=(text,action,cls='btn')=>{const b=node('button',cls,text);b.type='button';b.addEventListener('click',action);return b;};
const pending=r=>['pending','needs_review','applying'].includes(r.status);
const date=v=>v?new Date(v+'T00:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}):'Not set';
const status=r=>({pending:'Awaiting approval',needs_review:'Needs another review',applying:'Applying date',set:'Initial date set',approved:'Approved',rejected:'Rejected',withdrawn:'Withdrawn'}[r.status]||r.status);
export function createDateRequests({api,context,openIssue,onChange,onApplied,renderHistory}){
 let requests=[],error='',filter='pending',developer='',selectedKey=null;
 const dialog=node('dialog','date-dialog');document.body.appendChild(dialog);
 async function load(){try{const all=[];let cursor=null;const seen=new Set();do{const page=await api('/date-requests'+(cursor?'?cursor='+encodeURIComponent(cursor):''));all.push(...(page.requests||[]));cursor=page.isLast===false?page.nextCursor:null;if(cursor&&seen.has(cursor))throw new Error('Request pagination stalled. Refresh to retry.');if(cursor)seen.add(cursor);}while(cursor);requests=context().admin?all:all.filter(r=>r.requester.email===context().email);error='';}catch(e){error=e.message||'Date requests could not be loaded.';}return requests;}
 const activeFor=key=>requests.find(r=>r.key===key&&pending(r));
 function fields(form,label,type,value=''){const wrap=node('label','date-field');wrap.append(node('span','',label));const input=node(type==='textarea'?'textarea':'input','inp');if(type!=='textarea')input.type=type;input.value=value??'';wrap.append(input);form.append(wrap);return input;}
 function show(title){dialog.replaceChildren();const heading=node('h2','',title);heading.id='date-dialog-title';dialog.setAttribute('aria-labelledby',heading.id);dialog.append(heading);const form=node('form','date-form');form.method='dialog';dialog.append(form);const msg=node('p','msg');msg.setAttribute('role','alert');form.append(msg);dialog.showModal();return {form,msg};}
 async function commit(action,body,msg,save){save.disabled=true;msg.textContent='Saving…';try{await api('/date-requests/'+action,{method:'POST',body});dialog.close();
  // A date that applies right away (first date, direct change, approval) shows on the page before the lists reload.
  if(onApplied&&body&&body.key){if(action==='initial'||action==='direct')onApplied(body.key,body.proposedDate);else if(action==='approve')onApplied(body.key,body.approvedDate);}
  await load();await onChange(body&&body.key);}catch(e){msg.textContent=e.message+(e.status===409?' Close this form and reopen the latest request.':'');msg.className='msg err';await load();await onChange(body&&body.key);}finally{save.disabled=false;}}
 function formRequest(key,{direct=context().admin,revision=null}={}){
  const ticket=context().ticket(key)||(()=>{const r=requests.find(r=>r.key===key);return r?{key,summary:r.ticket?.title,due:r.ticket?.due}:null;})();if(!ticket)return;const current=activeFor(key);
  if(!context().admin&&!(typeof ticket.estimatedHours==='number'&&ticket.estimatedHours>0)){
    const {form,msg}=show('Estimated hours required');form.prepend(node('p','date-context','Add an estimate before choosing a due date for '+key+'. This helps keep deadlines aligned with the work.'));
    const estimate=fields(form,'Estimated hours','number');estimate.min='0.01';estimate.max='1000000';estimate.step='0.01';estimate.required=true;
    const actions=node('div','date-actions'),save=button('Save estimate and continue',()=>{},'btn primary');save.type='submit';actions.append(button('Cancel',()=>dialog.close()),save);form.append(actions);
    form.addEventListener('submit',async e=>{e.preventDefault();if(!form.reportValidity())return;save.disabled=true;try{const current=await api('/ticket-metadata?key='+encodeURIComponent(key));await api('/ticket-metadata',{method:'PUT',body:{key,fields:{revision:current.metadata.revision,estimatedHours:Number(estimate.value)}}});dialog.close();await onChange(key);formRequest(key,{direct,revision});}catch(err){msg.className='msg err';msg.textContent=err.message;}finally{save.disabled=false;}});return;
  }
  if(current&&!revision){showTicket(key);return;}
  const initial=!revision&&!ticket.due&&!requests.some(r=>r.key===key&&(r.appliedDate||r.original?.due));
  const {form,msg}=show(initial?'Set initial due date':revision?'Revise date request':direct?'Change approved date':'Request date change');
  form.prepend(node('p','date-context',key+' · '+ticket.summary+' · Approved: '+date(ticket.due)));
  const input=fields(form,'Requested date','date',revision?revision.proposedDate:ticket.due);input.required=true;
  const clear=fields(form,'Remove the due date','checkbox');clear.checked=!!revision&&revision.proposedDate===null;
  const toggle=()=>{input.disabled=clear.checked;input.required=!clear.checked;};clear.addEventListener('change',toggle);toggle();if(initial)clear.closest('label').hidden=true;
  const why=fields(form,initial?'Note (optional)':'Reason (required)','textarea',revision?.reason);why.required=!initial;why.minLength=3;why.maxLength=2000;
  const optional=node('details','date-optional');optional.append(node('summary','','Add a blocker or dependency'));form.append(optional);const blocker=direct||initial?null:fields(optional,'Blocker or dependency (optional)','textarea',revision?.blocker);if(blocker){blocker.maxLength=2000;optional.open=!!revision?.blocker;}else optional.remove();
  form.append(node('p','date-context',initial?'The first due date is saved immediately. Later changes require admin approval.':direct?'This changes the approved date and records your reason.':'The approved date stays unchanged until an admin accepts this request.'));
  const actions=node('div','date-actions'),save=button(initial?'Set due date':direct?'Apply date':revision?'Save revised request':'Submit request',()=>{},'btn primary');save.type='submit';actions.append(button('Cancel',()=>dialog.close()),save);form.append(actions);
  form.addEventListener('submit',e=>{e.preventDefault();if(!form.reportValidity())return;commit(initial?'initial':revision?'revise':direct?'direct':'submit',{key,id:revision?.id,version:revision?.version,proposedDate:clear.checked?null:input.value,reason:why.value,blocker:blocker?.value||''},msg,save);});
 }
 function decision(r,action){
  const {form,msg}=show(action==='approve'?'Review date request':'Reject date request');
  form.prepend(node('p','date-context',r.key+' · '+(r.ticket?.title||'')+' · Current: '+date(r.ticket?.due)+' → Requested: '+date(r.proposedDate)),node('p','date-reason',r.reason));
  let input,clear,confirm;
  if(action==='approve'){
   input=fields(form,'Approved date','date',r.proposedDate);clear=fields(form,'Remove the due date','checkbox');clear.checked=r.proposedDate===null;const toggle=()=>{input.disabled=clear.checked;input.required=!clear.checked;};clear.addEventListener('change',toggle);toggle();
   if(r.status==='needs_review'){form.append(node('p','date-warning','The ticket changed since this request. Review its current date and developer assignment before confirming.'));confirm=fields(form,'I reviewed the updated ticket context','checkbox');confirm.required=true;}
  }
  const why=fields(form,action==='reject'?'Rejection reason (required)':'Decision explanation (required for a different date)','textarea');why.required=action==='reject';why.minLength=3;why.maxLength=2000;
  const actions=node('div','date-actions'),save=button(action==='approve'?'Approve and apply date':'Reject request',()=>{},'btn '+(action==='approve'?'primary':'danger'));save.type='submit';actions.append(button('Cancel',()=>dialog.close()),save);form.append(actions);
  form.addEventListener('submit',e=>{e.preventDefault();const target=clear?.checked?null:input?.value;if(action==='approve'&&target!==r.proposedDate&&why.value.trim().length<3){msg.textContent='Explain the alternative date.';why.focus();return;}if(!form.reportValidity())return;commit(action,{key:r.key,id:r.id,version:r.version,approvedDate:target,reason:why.value,confirmContext:confirm?.checked||false},msg,save);});
 }
 async function withdraw(r,b){b.disabled=true;try{await api('/date-requests/withdraw',{method:'POST',body:{key:r.key,id:r.id,version:r.version}});await load();await onChange(r.key);}catch(e){b.closest('.date-request-card').append(node('p','msg err',e.message));}finally{b.disabled=false;}}
 function card(r,{compact=false}={}){
  const box=node('article','date-request-card'+(compact?' compact':''));const top=node('div','date-request-top');top.append(button(r.key+' · '+(r.ticket?.title||''),()=>openIssue(r.key),'date-ticket-link'),node('span','date-status '+r.status,status(r)));box.append(top);
  const change=node('div','date-comparison');change.append(node('div','', 'Approved: '+date(r.ticket?.due)),node('strong','', 'Requested: '+(r.proposedDate===null?'Remove date':date(r.proposedDate))));box.append(change);
  if(r.original.due&&r.proposedDate){const days=Math.round((Date.parse(r.proposedDate)-Date.parse(r.original.due))/86400000);box.append(node('p','date-impact',(days>0?'Extension: '+days: 'Earlier by '+Math.abs(days))+' days'));}
  box.append(node('p','date-reason',r.reason));
  box.append(node('p','date-context','Requested by '+(r.requester.name||r.requester.email)+(r.requester.dev?' ('+r.requester.dev+')':'')+' · '+new Date(r.createdAt).toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'Asia/Jerusalem'})));
  if(['approved','set'].includes(r.status))box.append(node('p','date-decision','Date applied: '+date(r.appliedDate)));
  if(r.decision)box.append(node('p','date-decision',(r.decision.by.name||r.decision.by.email)+': '+r.decision.reason));
  if(r.error)box.append(node('p','date-warning',r.error));
  const actions=node('div','date-actions'),secondary=node('div','date-actions');
  if(pending(r)&&r.status!=='applying'){
   if(context().admin)actions.append(button('Approve',()=>decision(r,'approve'),'btn primary'),button('Reject',()=>decision(r,'reject')));
   if(r.requester.email===context().email)actions.append(button('Revise request',()=>formRequest(r.key,{direct:false,revision:r})));
   if(context().admin||r.requester.email===context().email){const b=button('Withdraw',()=>withdraw(r,b));(context().admin?secondary:actions).append(b);}
  }
  if(r.status==='applying'&&context().admin)actions.append(button('Check and retry approval',()=>decision(r,'approve')));
  const failed=(r.deliveries||[]).filter(d=>d.status!=='sent');
  if(failed.length){actions.append(node('span','date-warning','Email delivery needs retry'));if(context().admin||r.requester.email===context().email){const b=button('Retry email',async()=>{b.disabled=true;try{await api('/date-requests/retry-email',{method:'POST',body:{key:r.key,id:r.id}});await load();await onChange(r.key);}catch(e){box.append(node('p','msg err',e.message));}finally{b.disabled=false;}});actions.append(b);}}
  box.append(actions);
  if(!compact){const details=node('details','date-timeline');details.append(node('summary','','Details & history'));if(r.blocker)details.append(node('p','date-context','Dependency: '+r.blocker));details.append(node('p','date-context','Developers: '+(r.ticket?.developers||[]).join(', ')));for(const e of r.events||[])details.append(node('p','date-context',e.type.replaceAll('_',' ')+' · '+(e.by?.name||e.by?.email||'')+' · '+new Date(e.at).toLocaleString('en-GB',{timeZone:'Asia/Jerusalem'})));if(secondary.childNodes.length)details.append(secondary);box.append(details);}
  return box;
 }
 function render(target,{key=null,summary=false}={}){
  target.replaceChildren();if(error){target.append(node('p','msg err',error),button('Retry loading requests',async()=>{await load();await onChange();}));return;}
  let list=key?requests.filter(r=>r.key===key):requests;
  if(!key&&!summary){
   if(filter==='mine')filter='pending';
   const tabs=node('div','date-filter-tabs');
   const views=context().admin?[['pending','Pending'],['decisions','Decisions'],['all','All'],['history','Due date history']]:[['pending','Pending'],['decisions','Decisions'],['all','All']];
   for(const [id,label]of views){const b=button(label,()=>{filter=id;render(target);});b.setAttribute('aria-pressed',String(filter===id));tabs.append(b);}
   if(context().admin&&filter!=='history'){
    const people=new Map();for(const r of requests)people.set(r.requester.email,r.requester);
    if(developer&&!people.has(developer))developer='';
    const field=node('label','date-developer-filter');field.append(node('span','','Developer'));
    const select=node('select','fsel');select.setAttribute('aria-label','Requesting developer');select.append(new Option('All developers',''));
    for(const person of [...people.values()].sort((a,b)=>(a.name||a.email).localeCompare(b.name||b.email)))select.append(new Option((person.name||person.email)+(person.dev?' ('+person.dev+')':''),person.email));
    select.value=developer;select.addEventListener('change',()=>{developer=select.value;render(target);});field.append(select);tabs.append(field);
   }
   target.append(tabs);if(context().admin&&filter==='history'){const history=node('section','date-history');target.append(history);renderHistory(history);return;}list=list.filter(r=>(!context().admin||!developer||r.requester.email===developer)&&(filter==='all'||filter==='pending'&&pending(r)||filter==='decisions'&&!pending(r)));
  }
  if(summary&&context().admin)list=list.filter(pending);
  list=list.slice().sort((a,b)=>pending(a)&&pending(b)?a.createdAt.localeCompare(b.createdAt):Number(pending(b))-Number(pending(a))||b.updatedAt.localeCompare(a.updatedAt));
  if(summary)list=list.slice(0,4);
  if(!list.length)target.append(node('p','date-empty',key?'No date requests for this ticket.':'No requests in this view.'));
  for(const r of list)target.append(card(r,{compact:summary}));
 }
 function showTicket(key){selectedKey=key;const target=document.getElementById('d-date-requests');if(target)render(target,{key});openIssue(key);}
 function renderDrawer(key){selectedKey=key;const target=document.getElementById('d-date-requests');if(target)render(target,{key});const button=document.getElementById('d-requestdate');if(button){button.textContent=activeFor(key)?'Review pending date request':!context().ticket(key)?.due&&!requests.some(r=>r.key===key&&(r.appliedDate||r.original?.due))?'Set due date':context().admin?'Change approved date':'Request date change';button.onclick=()=>activeFor(key)?render(target,{key}):formRequest(key);}}
 return {load,formRequest,render,renderDrawer,activeFor,all:()=>requests,pendingCount:()=>requests.filter(pending).length,isDirty:()=>dialog.open,close:()=>dialog.close()};
}
