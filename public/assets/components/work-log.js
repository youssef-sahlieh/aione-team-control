// Log work → Odoo timesheets: the "Log work" form, the ticket's timer, the completion form for a stopped timer,
// the ticket's Work log, administrator corrections and reconciliation, the Work log page (report for everyone;
// administrators get setup, reports are in Checks & Reports).
// Durations are whole minutes shown as H:MM; dates are work dates in Asia/Jerusalem. The server checks everything again.
// The timer is the server's: this page only shows it and sends its actions. Nothing here is sent to Odoo by the AI.
import {parseDurationInput,formatDuration,normalizeDuration,durationFieldError,SHORTCUT_MINUTES} from '../models/work-duration.js';
import {TIMER_STATES,clockText,liveElapsedMs,timerActions,isOpenSession} from '../models/work-timer.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const button=(text,fn,cls='btn')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const field=(parent,label,node,hint)=>{const l=el('label','wl-field');l.append(el('span','',label),node);if(hint)l.append(el('small','msg',hint));parent.append(l);return node;};
const input=(type,value)=>{const n=el('input','inp');n.type=type;if(value!=null)n.value=value;return n;};
// A labelled control with its note and its field error underneath. The label holds only the name and the control,
// so the accessible name is the label alone. note may be a function, read again on refresh().
let fieldSeq=0;
function withNotes(parent,label,node,note){
  const id='wl-field-'+(++fieldSeq),wrap=el('div','wl-field-wrap'),l=el('label','wl-field'),noteEl=el('small','wl-note'),err=el('small','wl-error');
  noteEl.id=id+'-note';err.id=id+'-error';
  l.append(el('span','',label),node);
  node.setAttribute('aria-describedby',noteEl.id+' '+err.id);
  const refresh=()=>{noteEl.textContent=typeof note==='function'?note():note||'';};
  refresh();
  wrap.append(l,noteEl,err);parent.append(wrap);
  return {refresh,setError(text){err.textContent=text||'';node.setAttribute('aria-invalid',text?'true':'false');}};
}
// Whole minutes as H:MM (1:30). Non-numbers count as 0.
export const formatMinutes=m=>formatDuration(Math.max(0,Math.round(Number(m)||0)));
const hours=m=>(Math.round(m/60*100)/100).toLocaleString('en-US',{maximumFractionDigits:2});
const niceDate=d=>{try{return new Date(d+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});}catch{return d;}};
const whenText=iso=>{if(!iso)return '—';try{return new Date(iso).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Jerusalem'});}catch{return iso;}};
const todayIsrael=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem'}).format(new Date());
const STATUS_CLASS={synced:'ok',syncing:'busy',setup:'warn',review:'crit'};
const TIMER_LABELS={pause:'Pause',resume:'Resume',stop:'Stop',finish:'Log time…',discard:'Discard'};
function badge(e){const b=el('span','wl-status wl-'+(STATUS_CLASS[e.status]||'busy'),e.statusLabel);if(e.reason)b.title=e.reason;return b;}

// The tickets matching a search: every word must appear in the key or the title. At most 50 are shown.
export function ticketMatches(tickets,query){
  const words=String(query||'').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return tickets.filter(t=>{const text=(t.key+' '+(t.title||'')).toLowerCase();return words.every(w=>text.includes(w));}).slice(0,50);
}

// One duration field for every Log work form: H:MM (or decimal hours), 0:01 to 24:00, with the shortcuts.
// The text becomes H:MM when the field loses focus. Errors appear under the field once it has been checked.
function durationControl(parent,{hint='Hours and minutes, like 1:30. From 0:01 to 24:00. Decimal hours, like 1.5, also work.'}={}){
  const box=input('text','');box.inputMode='text';box.autocomplete='off';box.spellcheck=false;box.placeholder='1:30';
  const f=withNotes(parent,'Duration',box,hint);
  let checked=false;
  const total=el('p','wl-total-line');total.setAttribute('aria-live','polite');
  const minutes=()=>{const r=parseDurationInput(box.value);return r.error?null:r.minutes;};
  function update(){
    const m=minutes();total.textContent=m!=null?'Total: '+formatDuration(m):'';
    for(const c of chips){const on=m!=null&&Number(c.dataset.minutes)===m;c.setAttribute('aria-pressed',String(on));c.classList.toggle('is-selected',on);}
  }
  const set=m=>{box.value=formatDuration(m);checked=false;f.setError('');update();};
  const chips=SHORTCUT_MINUTES.map(m=>{const b=button(formatDuration(m),()=>{set(m);box.focus();},'btn wl-chip');b.dataset.minutes=String(m);return b;});
  const shortcuts=el('div','wl-shortcuts');shortcuts.setAttribute('role','group');shortcuts.setAttribute('aria-label','Duration shortcuts: sets the total');shortcuts.append(...chips);
  parent.append(shortcuts,total);
  const check=()=>{checked=true;const err=durationFieldError(box.value);f.setError(err);update();return err;};
  box.addEventListener('input',()=>{if(checked)check();else update();});
  box.addEventListener('blur',()=>{
    const n=normalizeDuration(box.value);
    if(n===null){checked=true;f.setError(durationFieldError(box.value));}
    else if(n){box.value=n;f.setError('');}
    update();
  });
  update();
  return {box,minutes,check,update,set,reset(){box.value='';checked=false;f.setError('');update();}};
}

export function createWorkLog({api,isAdmin,me,errorText,toast,openIssue,myTickets=()=>[],onLogged=()=>{}}){
  const views={};
  // The timer last read from the server, and when it was read (the clock is shown from that moment on).
  let lastTimer=null,tickHandle=null,pendingStart=null;
  const stopTick=()=>{if(tickHandle){clearInterval(tickHandle);tickHandle=null;}};
  function dialog(title,onClose){
    const d=el('dialog','business-dialog wl-dialog'),head=el('div','business-dialog-head'),body=el('div','wl-form'),msg=el('p','msg');msg.setAttribute('role','status');d.setAttribute('aria-label',title);
    head.append(el('h2','',title),button('Close',()=>(onClose?onClose():d.close())));d.append(head,body,msg);document.body.append(d);d.addEventListener('close',()=>d.remove());d.showModal();return {d,body,msg};
  }
  const fail=(msg,err)=>{msg.className='msg err';msg.textContent=errorText?errorText(err):err.message||String(err);};

  // "Improve writing" and "Suggest work description" beside a description. A proposal appears below with Apply and
  // Cancel; the text stays as it was until Apply. Nothing is saved or submitted here, and a failure never blocks saving.
  function aiHelp({textarea,ticket,timerId=()=>null,afterApply=()=>{}}){
    const node=el('div','wl-ai'),bar=el('div','wl-ai-bar'),status=el('p','msg'),preview=el('div','wl-ai-preview');
    status.setAttribute('role','status');preview.hidden=true;
    const improve=button('Improve writing',()=>run('improve'),'btn wl-ai-btn');
    const suggest=button('Suggest work description',()=>run('suggest'),'btn wl-ai-btn');
    bar.append(improve,suggest);node.append(bar,status,preview);
    let busy=false;
    const setBusy=on=>{busy=on;improve.disabled=on;suggest.disabled=on;};
    const hide=()=>{preview.hidden=true;preview.replaceChildren();};
    const showProposal=(kind,text,evidence)=>{
      preview.replaceChildren();preview.hidden=false;
      preview.append(el('p','wl-ai-title',kind==='improve'?'Improved wording':'Suggested description'));
      const p=el('p','wl-ai-text',text);p.dir='auto';preview.append(p);
      if(evidence==='limited')preview.append(el('p','wl-note','The ticket has little detail, so check the wording against what you did.'));
      const apply=button('Apply',()=>{textarea.value=text.slice(0,2000);hide();status.textContent='';afterApply();textarea.focus();},'btn primary');
      const cancel=button('Cancel',()=>{hide();textarea.focus();},'btn');
      const acts=el('div','wl-actions');acts.append(apply,cancel);preview.append(acts);
      apply.focus();
    };
    async function run(kind){
      if(busy)return;
      const text=textarea.value.trim();
      if(kind==='improve'&&!text){status.className='msg err';status.textContent='Write the description first, then improve it.';return;}
      hide();setBusy(true);status.className='msg';status.textContent=kind==='improve'?'Improving the writing…':'Reading the ticket…';
      try{
        const r=kind==='improve'
          ?await api('/ai-improve',{method:'POST',body:{text,purpose:'work'}})
          :await api('/time-entries/suggest',{method:'POST',body:{ticket,draft:text,...(timerId()?{timerId:timerId()}:{})}});
        const proposal=String((kind==='improve'?r.text:r.description)||'').trim();
        if(!proposal){status.textContent='No suggestion came back. Your text is unchanged.';return;}
        status.textContent='';showProposal(kind,proposal,kind==='suggest'?r.evidence:null);
      }catch(err){status.className='msg err';status.textContent=(errorText?errorText(err):err.message)+' Your text is unchanged, and you can still save.';}
      finally{setBusy(false);}
    }
    return node;
  }

  // ---- Log work ----
  // afterSave (optional) runs after each saved entry; the Work log page uses it to reload its report.
  // opener is the element to focus again when the form closes (the button that opened it).
  function openForm(key,title,view,afterSave,opener=document.activeElement){
    const {d,body,msg}=dialog('Log work · '+key,()=>requestClose());
    const facts=el('dl','wl-facts');
    const fact=(k,v)=>{facts.append(el('dt','',k));const dd=el('dd');if(v instanceof Node)dd.append(v);else dd.textContent=v;facts.append(dd);};
    fact('Ticket',key+(title?' · '+title:''));fact('User',me().name||me().email);
    const dest=view.destination;
    fact('Goes to Odoo',!dest?'Odoo project shown after setup':dest.setup?el('span','msg err',dest.setup):dest.error?el('span','msg err',dest.error):(dest.label||dest.projectName)+' › '+dest.taskName);
    if(dest?.clientName)fact('Client',dest.clientName);
    // After a project change, earlier entries stay where they were posted; only this and later entries use the new project.
    if(dest?.earlierProjects?.length)fact('Earlier entries',el('span','wl-note','Stay on '+dest.earlierProjects.join(', ')+'. Only new entries go to the project above.'));
    body.append(facts);
    // Work date on its own row; the note spells the day out so day and month can't be confused.
    const minDate=view.lockDate?new Date(Date.parse(view.lockDate+'T12:00:00Z')+86400000).toISOString().slice(0,10):'';
    const lockNote=view.lockDate?'Odoo is locked up to '+view.lockDate+'.':'Today or earlier (Israel time).';
    const date=input('date',view.today);date.max=view.today;if(minDate)date.min=minDate;date.required=true;
    const dateField=withNotes(body,'Work date',date,()=>(date.value?niceDate(date.value)+' · ':'')+lockNote);
    date.addEventListener('input',dateField.refresh);
    const dur=durationControl(body);
    const desc=el('textarea','inp');desc.rows=3;desc.maxLength=2000;desc.dir='auto';desc.required=true;desc.placeholder='e.g. Fixed the login redirect and tested it in Safari';
    const descField=withNotes(body,'Description',desc,'Required. Saved to the Odoo timesheet line.');
    body.append(aiHelp({textarea:desc,ticket:key}));
    const dirty=()=>!!(dur.box.value.trim()||desc.value.trim());
    // Escape, Close and Cancel all come here: unsaved values are confirmed before they are discarded.
    function requestClose(){if(dirty()&&!window.confirm('Discard this work entry? Your changes will be lost.'))return;d.close();}
    d.addEventListener('cancel',e=>{if(dirty()){e.preventDefault();requestClose();}});
    d.addEventListener('close',()=>{if(opener&&opener.isConnected)opener.focus();});
    const validate=()=>{
      const dateError=!date.value||date.value>view.today?'Choose a work date that is not in the future.':minDate&&date.value<minDate?'Odoo is locked up to '+view.lockDate+'. Choose a later date.':'';
      const durError=dur.check();
      const descError=desc.value.trim()?'':'Describe the work.';
      dateField.setError(dateError);descField.setError(descError);
      const first=[[dateError,date],[durError,dur.box],[descError,desc]].find(([t])=>t);
      if(first){first[1].focus();msg.className='msg err';msg.textContent='Fix the fields marked in red.';return null;}
      return dur.minutes();
    };
    // The id makes saving safe to repeat: a retry after a lost answer can't log the work twice.
    let id=crypto.randomUUID(),saving=false;
    const save=async again=>{
      if(saving)return;
      const minutes=validate();if(minutes==null)return;
      const description=desc.value.trim();
      saving=true;setBusy(true);msg.className='msg';msg.textContent='Saving…';
      try{
        const r=await api('/time-entries',{method:'POST',body:{id,ticket:key,date:date.value,minutes,description}});
        id=crypto.randomUUID();
        const note=formatMinutes(minutes)+' logged on '+key+(r.entry.status==='synced'?' and saved in Odoo.':' · '+r.entry.statusLabel+(r.entry.reason?': '+r.entry.reason:''));
        onLogged(key);render(key);if(afterSave)afterSave();
        if(again){
          // Ticket, user, destination and work date stay; the duration and description are for the next entry.
          dur.reset();desc.value='';
          for(const f of [dateField,descField])f.setError('');
          msg.className='msg ok';msg.textContent=note+' Add the next one.';dur.box.focus();
        }else{d.close();if(toast)toast(note);}
      }catch(err){fail(msg,err);}
      finally{saving=false;setBusy(false);}
    };
    const saveBtn=button('Save work',()=>save(false),'btn primary');
    const againBtn=button('Save & add another',()=>save(true),'btn');
    const cancelBtn=button('Cancel',()=>requestClose(),'btn');
    const setBusy=on=>{for(const b of [saveBtn,againBtn,cancelBtn])b.disabled=on;saveBtn.textContent=on?'Saving…':'Save work';};
    const actions=el('div','wl-actions');actions.append(saveBtn,againBtn,cancelBtn);body.append(actions);
    body.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();save(false);}});
    dur.box.focus();
  }

  // ---- Timer (on a ticket) ----
  // The server keeps the timer; the clock shown here only adds the seconds since the answer arrived. Starting sends the
  // same id again if the first answer was lost, so one press never opens two timers.
  async function timerAct(action,key,session){
    const body={action,...(session?{revision:session.revision}:{})};
    if(action==='start'){
      if(!pendingStart||pendingStart.key!==key)pendingStart={key,id:crypto.randomUUID()};
      body.id=pendingStart.id;body.ticket=key;
    }
    try{
      const r=await api('/time-entries/timer',{method:'POST',body});
      if(action==='start')pendingStart=null;
      lastTimer={at:Date.now(),timer:r.timer};
    }catch(err){
      // A lost answer keeps the same start id for the next press; any other refusal ends it.
      if(action==='start'&&err.code!=='network')pendingStart=null;
      if(toast)toast(errorText?errorText(err):err.message,[],true);
    }
    // Whatever the server now holds is what is shown (a refused action shows the current timer).
    await render(key);
  }
  function timerButton(action,key,session){
    if(action==='finish')return openCompletion(key,session);
    if(action==='discard'){if(!window.confirm('Discard this timer? The time on it is not logged.'))return;return timerAct('discard',key,session);}
    return timerAct(action,key,session);
  }
  function timerBar(key,view){
    const open=lastTimer&&isOpenSession(lastTimer.timer)?lastTimer.timer:null;
    const box=el('section','wl-timer');box.setAttribute('aria-label','Timer');
    if(open&&open.ticket!==key){
      box.append(el('p','msg','A timer is '+(open.state==='stopped'?'waiting to be logged':open.state)+' on '+open.ticket+'. Finish or discard it before starting another.'),button('Go to '+open.ticket,()=>openIssue&&openIssue(open.ticket),'btn'));
      return box;
    }
    if(!open){
      if(!view.canLog)return null;
      box.append(el('p','wl-note','Start a timer, and it keeps running on the server if you close this page. Only one timer at a time.'),button('Start timer',()=>timerAct('start',key,null),'btn'));
      return box;
    }
    const clock=el('span','wl-clock',clockText(liveElapsedMs(open,lastTimer.at,Date.now())));
    box.append(el('span','wl-timer-state',TIMER_STATES[open.state]||open.state),clock);
    if(open.state==='stopped')box.append(el('p','wl-note','Log it or discard it. A stopped timer blocks a new one until then.'));
    for(const a of timerActions(open.state))box.append(button(TIMER_LABELS[a],()=>timerButton(a,key,open),a==='stop'||a==='finish'?'btn primary':'btn'));
    // Only the text of the clock changes while it runs; nothing is re-fetched until the next action.
    if(open.state==='running'){const at=lastTimer.at;tickHandle=setInterval(()=>{clock.textContent=clockText(liveElapsedMs(open,at,Date.now()));},1000);}
    return box;
  }

  // The completion form for a stopped timer: the server's elapsed time becomes the suggested duration. The timer stays
  // stopped until this is saved (it is logged with the same id) or discarded, so closing the form loses nothing.
  function openCompletion(key,session){
    let current={...session};
    const {d,body,msg}=dialog('Log timer · '+key,()=>{d.close();});
    const facts=el('dl','wl-facts');
    const fact=(k,v)=>{facts.append(el('dt','',k),el('dd','',v));};
    fact('Ticket',key+(current.ticketTitle?' · '+current.ticketTitle:''));
    fact('Started',whenText(current.startedAt));fact('Stopped',whenText(current.stoppedAt));
    fact('Time on the timer',clockText(current.elapsedMs)+(current.suggestedMinutes!=null?' · suggested '+formatDuration(current.suggestedMinutes):''));
    body.append(facts);
    if(current.crossesMidnight)body.append(el('p','msg err','This timer started on '+niceDate(current.workDate)+' and was stopped on a later day. Check the work date and time before you save.'));
    const date=input('date',current.workDate);date.max=todayIsrael();date.required=true;
    const dateField=withNotes(body,'Work date',date,()=>(date.value?niceDate(date.value)+' · ':'')+'Today or earlier (Israel time).');
    date.addEventListener('input',dateField.refresh);
    const dur=durationControl(body);
    if(current.suggestedMinutes>=1)dur.set(current.suggestedMinutes);
    else body.append(el('p','msg','The timer ran for under a minute. Enter the time you worked.'));
    const desc=el('textarea','inp');desc.rows=3;desc.maxLength=2000;desc.dir='auto';desc.required=true;desc.value=current.description||'';desc.placeholder='e.g. Fixed the login redirect and tested it in Safari';
    const descField=withNotes(body,'Description',desc,'Required. Saved to the Odoo timesheet line. Kept as a draft when you leave this box.');
    // Drafts are saved one after another, each with the revision the last one returned.
    let savedDraft=desc.value,chain=Promise.resolve();
    const doDraft=async()=>{
      const text=desc.value.slice(0,2000);if(text===savedDraft)return;
      try{const r=await api('/time-entries/timer',{method:'POST',body:{action:'draft',revision:current.revision,description:text}});current={...current,...r.timer};savedDraft=text;}
      catch(err){fail(msg,err);}
    };
    const saveDraft=()=>{chain=chain.then(doDraft);return chain;};
    desc.addEventListener('blur',saveDraft);
    body.append(aiHelp({textarea:desc,ticket:key,timerId:()=>current.id,afterApply:saveDraft}));
    let saving=false;
    const save=async()=>{
      if(saving)return;
      const dateError=!date.value||date.value>todayIsrael()?'Choose a work date that is not in the future.':'';
      const durError=dur.check();
      const descError=desc.value.trim()?'':'Describe the work.';
      dateField.setError(dateError);descField.setError(descError);
      const first=[[dateError,date],[durError,dur.box],[descError,desc]].find(([t])=>t);
      if(first){first[1].focus();msg.className='msg err';msg.textContent='Fix the fields marked in red.';return;}
      saving=true;setBusy(true);msg.className='msg';msg.textContent='Saving…';
      await chain;
      const minutes=dur.minutes();
      try{
        // The timer's id is the entry id: a repeated save returns the same entry, and the server marks the timer logged.
        const r=await api('/time-entries',{method:'POST',body:{id:current.id,ticket:key,date:date.value,minutes,description:desc.value.trim()}});
        d.close();
        const note=formatMinutes(minutes)+' logged on '+key+(r.entry.status==='synced'?' and saved in Odoo.':' · '+r.entry.statusLabel+(r.entry.reason?': '+r.entry.reason:''));
        onLogged(key);if(toast)toast(note);
      }catch(err){fail(msg,err);}
      finally{saving=false;setBusy(false);}
    };
    const discardBtn=button('Discard timer',()=>{if(!window.confirm('Discard this timer? The time on it is not logged.'))return;d.close();timerAct('discard',key,current);},'btn danger');
    const saveBtn=button('Log time',save,'btn primary');
    const keepBtn=button('Keep stopped',()=>{d.close();},'btn');
    const setBusy=on=>{for(const b of [saveBtn,discardBtn,keepBtn])b.disabled=on;saveBtn.textContent=on?'Saving…':'Log time';};
    const actions=el('div','wl-actions');actions.append(saveBtn,discardBtn,keepBtn);body.append(actions);
    // Closing the form in any way keeps the timer stopped and shows it again.
    d.addEventListener('close',()=>{render(key);});
    date.focus();
  }

  // ---- Correction (administrators) ----
  function openCorrection(e,view){
    const {d,body,msg}=dialog('Correct work entry · '+e.ticket);
    body.append(el('p','msg','By '+e.author.name+'. The Odoo timesheet line is updated, and the change is kept in the entry\'s history.'));
    const row=el('div','wl-row');body.append(row);
    const date=field(row,'Work date',input('date',e.date));date.max=view?.today||'';
    const durBox=el('div');body.append(durBox);
    const dur=durationControl(durBox,{hint:'Hours and minutes, like 1:30. Same rules as a new entry: 0:01 to 24:00.'});
    dur.set(e.minutes);
    const desc=field(body,'Description',el('textarea','inp'));desc.value=e.description;desc.rows=3;desc.maxLength=2000;desc.dir='auto';
    const reason=field(body,'Reason for the correction (required)',el('textarea','inp'));reason.rows=2;reason.maxLength=1000;reason.dir='auto';
    const actions=el('div','wl-actions');body.append(actions);
    actions.append(button('Save correction',async ev=>{
      const durError=dur.check(),minutes=dur.minutes(),patch={revision:e.revision,reason:reason.value.trim()};
      if(!patch.reason){fail(msg,new Error('Give a reason for the correction.'));reason.focus();return;}
      if(durError){fail(msg,new Error(durError));dur.box.focus();return;}
      if(date.value!==e.date)patch.date=date.value;if(minutes!==e.minutes)patch.minutes=minutes;if(desc.value.trim()!==e.description)patch.description=desc.value.trim();
      if(Object.keys(patch).length===2){fail(msg,new Error('Change the date, duration or description.'));return;}
      ev.currentTarget.disabled=true;msg.className='msg';msg.textContent='Saving…';
      try{const r=await api('/time-entries/'+e.id,{method:'PATCH',body:patch});d.close();onLogged(e.ticket);render(e.ticket);if(toast)toast('Work entry corrected · '+r.entry.statusLabel);}
      catch(err){fail(msg,err);ev.currentTarget.disabled=false;}
    },'btn primary'),button('Cancel',()=>d.close()));
  }

  async function act(e,body,label){
    try{const r=await api('/time-entries/'+e.id+'/sync',{method:'POST',body});onLogged(e.ticket);render(e.ticket);if(toast)toast(label+' · '+r.entry.statusLabel);}
    catch(err){if(toast)toast(errorText?errorText(err):err.message,[],true);}
  }

  // ---- Ticket section ----
  function entryRow(e,view){
    const row=el('li','wl-entry');
    const top=el('div','wl-entry-top');
    top.append(el('b','wl-date',niceDate(e.date)),el('span','wl-who',e.author.name),el('span','wl-dur',formatMinutes(e.minutes)),badge(e));
    row.append(top,el('p','wl-desc',e.description));row.lastChild.dir='auto';
    if(e.reason&&e.status!=='synced')row.append(el('p','msg'+(e.status==='review'?' err':''),e.reason));
    const acts=el('div','wl-entry-actions');
    if((e.status==='syncing'||e.status==='setup')&&(isAdmin()||e.author.email))acts.append(button('Try again',()=>act(e,{},'Sent again'),'linkbtn'));
    if(isAdmin()){
      if(!view.closed)acts.append(button('Correct',()=>openCorrection(e,view),'linkbtn'));
      if(e.status==='review'){
        acts.append(button('Check Odoo again',()=>act(e,{action:'check'},'Checked'),'linkbtn'));
        acts.append(button('Send again',()=>{if(confirm('Send this entry to Odoo again? Do this only after checking that Odoo has no line for it.'))act(e,{action:'resend'},'Sent again');},'linkbtn'));
        acts.append(button('Link to Odoo line…',()=>{const n=prompt('Odoo timesheet line number (ID) for this entry:');if(n&&/^\d+$/.test(n.trim()))act(e,{action:'link',lineId:Number(n.trim())},'Linked');},'linkbtn'));
      }
      if(e.lineId)acts.append(el('span','msg','Odoo line #'+e.lineId));
    }
    if(acts.childNodes.length)row.append(acts);
    const revisions=e.revisions||[];
    if(revisions.length){
      const h=el('details','wl-revisions');h.append(el('summary','','Corrected '+revisions.length+(revisions.length===1?' time':' times')));
      for(const r of [...revisions].reverse()){const what=[r.from.date!==r.to.date?r.from.date+' → '+r.to.date:'',r.from.minutes!==r.to.minutes?formatMinutes(r.from.minutes)+' → '+formatMinutes(r.to.minutes):'',r.from.description!==r.to.description?'description changed':''].filter(Boolean).join(' · ');
        h.append(el('p','msg',new Date(r.at).toLocaleString('en-GB',{timeZone:'Asia/Jerusalem'})+' · '+r.by.name+': '+what+' — '+r.reason));}
      row.append(h);
    }else if(e.corrections)row.append(el('p','msg','Corrected by an administrator'));
    return row;
  }
  async function render(key){
    const target=document.getElementById('work-log');if(!target)return;
    stopTick();
    const headerButton=document.getElementById('d-logwork');
    if(target.dataset.key!==key){target.dataset.key=key;target.replaceChildren(el('h3','','Work log'),el('p','msg','Loading…'));if(headerButton)headerButton.hidden=true;}
    let view,timer=null;
    try{[view,timer]=await Promise.all([api('/time-entries?ticket='+encodeURIComponent(key)),api('/time-entries/timer').catch(()=>null)]);}
    catch(err){if(target.dataset.key!==key)return;if(err.code==='not_found'||err.status===404&&err.code==='server'){target.hidden=true;return;}target.hidden=false;target.replaceChildren(el('h3','','Work log'),el('p','msg err',errorText?errorText(err):err.message));return;}
    if(target.dataset.key!==key)return;views[key]=view;if(timer)lastTimer={at:Date.now(),timer:timer.timer};else lastTimer=null;if(headerButton)headerButton.hidden=!view.canLog;
    // Nothing to show while work logging is off and the ticket has no entries.
    target.hidden=!view.logging&&!view.entries.length&&!(lastTimer&&isOpenSession(lastTimer.timer)&&lastTimer.timer.ticket===key);
    const head=el('div','wl-head');head.append(el('h3','','Work log'));
    if(view.canLog)head.append(button('+ Log work',()=>openForm(key,(document.getElementById('d-title')||{}).textContent||'',view),'btn primary'));
    target.replaceChildren(head);
    const s=view.summary,total=el('p','wl-total');
    if(view.baselineHours!=null&&s.loggedMinutes)total.append('Actual hours: ',el('b','',String(view.totalHours)),' = '+view.baselineHours+' h before the work log + '+formatMinutes(s.loggedMinutes)+' logged');
    else if(s.loggedMinutes)total.append('Logged: ',el('b','',formatMinutes(s.loggedMinutes)),' ('+hours(s.loggedMinutes)+' h)');
    else total.append(view.baselineHours!=null?'Actual hours: '+view.baselineHours+' h (entered before the work log). No work logged yet.':'No work logged yet.');
    if(s.pendingMinutes)total.append(el('span','wl-pending',' · '+formatMinutes(s.pendingMinutes)+' not in Odoo yet'));
    target.append(total);
    if(view.closed&&view.logging)target.append(el('p','msg','Closed ticket: reopen it to log work.'));
    else if(view.logging&&!view.canLog&&!view.closed)target.append(el('p','msg','Work logging isn\'t switched on for you yet.'));
    if(view.canLog&&view.destination&&(view.destination.setup||view.destination.error))target.append(el('p','msg err',view.destination.setup||view.destination.error));
    else if(view.canLog&&view.destination?.projectId)target.append(el('p','wl-note','New work goes to '+(view.destination.label||view.destination.projectName)+'.'+(view.destination.earlierProjects?.length?' Earlier entries stay on '+view.destination.earlierProjects.join(', ')+'.':'')));
    if(timer&&!view.closed){const tb=timerBar(key,view);if(tb)target.append(tb);}
    if(view.entries.length){const list=el('ol','wl-list');for(const e of view.entries)list.append(entryRow(e,view));target.append(list);}
  }
  function openFor(key,title){const view=views[key];if(view&&view.canLog)openForm(key,title,view);}

  // ---- Work log page ----
  let report=null,filters={user:'',client:'',project:'',ticket:'',source:'',status:''},groupBy='user';
  const SOURCES={jira:'Jira',internal:'Internal',odoo:'Odoo Helpdesk'};
  // The dashboard redraws its pages whenever data refreshes: the page shown is kept as it is (no reload, no
  // flashing). It is rebuilt only for a tab change or after saving (fresh).
  let pageNode=null,pageTarget=null;
  function renderPage(target,fresh=false){
    if(pageNode&&!fresh){if(pageNode.parentNode!==target)target.replaceChildren(pageNode);return;}
    const wrap=el('div','wl-page');pageNode=wrap;pageTarget=target;target.replaceChildren(wrap);
    // Reports moved to Checks & Reports (the unified business report); administrators get setup only here.
    if(isAdmin())return renderSetup(wrap);
    renderReport(wrap);
  }
  function renderReport(wrap){
    const today=todayIsrael();
    const bar=el('div','wl-report-bar'),from=input('date',report?.from||today.slice(0,8)+'01'),to=input('date',report?.to||today),msg=el('span','msg');
    from.setAttribute('aria-label','From');to.setAttribute('aria-label','To');
    const out=el('div','wl-report');
    // Shown once the report says this person may log work. Saving reloads the report (the new entry is in it).
    const logButton=button('+ Log work',()=>openTicketPicker(()=>{report=null;if(pageTarget)renderPage(pageTarget,true);}),'btn primary wl-log-btn');logButton.hidden=true;
    const load=async()=>{msg.className='msg';msg.textContent='Loading…';try{report=await api('/time-entries/report?from='+from.value+'&to='+to.value);msg.textContent='';draw();}catch(err){fail(msg,err);}};
    bar.append(el('span','','From'),from,el('span','','to'),to,button('Show',load,'btn primary'),msg,logButton);
    wrap.append(el('p','msg',isAdmin()?'Everyone\'s logged work by work date (Israel time). Filters apply on this page.':'Your logged work by work date (Israel time).'),bar,out);
    const draw=()=>{
      logButton.hidden=!report?.canLog;
      out.replaceChildren();if(!report)return;
      const rows=report.rows;
      const options=(key,label,name=r=>r[key])=>{const s=el('select','fsel');s.setAttribute('aria-label',label);s.append(new Option('All '+label.toLowerCase(),''));for(const v of key==='status'?Object.keys(report.statuses):key==='source'?Object.keys(SOURCES):[...new Set(rows.map(name).filter(Boolean))].sort())s.append(new Option(key==='source'?SOURCES[v]||v:key==='status'?report.statuses[v]||v:v,v));s.value=filters[key]&&[...s.options].some(o=>o.value===filters[key])?filters[key]:'';s.addEventListener('change',()=>{filters[key]=s.value;draw();});return s;};
      const fbar=el('div','wl-filters');
      fbar.append(options('user','Users'),options('client','Clients',r=>r.clientName),options('project','Projects',r=>r.subClientName),options('ticket','Tickets'),options('source','Sources'),options('status','Statuses'));
      const by=el('select','fsel');by.setAttribute('aria-label','Group by');for(const [v,l] of [['user','By user'],['client','By client'],['project','By project'],['ticket','By ticket'],['source','By source'],['status','By status'],['date','By date']])by.append(new Option(l,v));by.value=groupBy;by.addEventListener('change',()=>{groupBy=by.value;draw();});
      fbar.append(by);out.append(fbar);
      const pick={user:r=>r.user,client:r=>r.clientName,project:r=>r.subClientName,ticket:r=>r.ticket,source:r=>r.source,status:r=>r.status,date:r=>r.date};
      const shown=rows.filter(r=>Object.entries(filters).every(([k,v])=>!v||pick[k](r)===v));
      const sum=list=>({logged:list.reduce((n,r)=>n+r.minutes,0),confirmed:list.filter(r=>r.synced).reduce((n,r)=>n+r.minutes,0)});
      const t=sum(shown),cards=el('div','wl-cards');
      for(const [label,m,cls] of [['Logged',t.logged,''],['Confirmed in Odoo',t.confirmed,'ok'],['Not in Odoo yet',t.logged-t.confirmed,t.logged-t.confirmed?'warn':'']]){const c=el('div','wl-card '+cls);c.append(el('span','',label),el('b','',formatMinutes(m)),el('small','',hours(m)+' h'));cards.append(c);}
      out.append(cards);
      if(!shown.length){out.append(el('p','msg','No work logged in this period'+(Object.values(filters).some(Boolean)?' with these filters.':'.')));}
      else{
        const groups=new Map();for(const r of shown){const k=pick[groupBy](r)||'(none)';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
        const g=el('table','wl-table');const gh=g.createTHead().insertRow();for(const h of [by.selectedOptions[0].text.replace('By ',''),'Entries','Logged (h)','Confirmed (h)','Pending (h)'])gh.append(el('th','',h[0].toUpperCase()+h.slice(1)));
        const gb=g.createTBody();for(const [k,list] of [...groups].sort((a,b)=>sum(b[1]).logged-sum(a[1]).logged)){const s=sum(list),tr=gb.insertRow();tr.append(el('td','',groupBy==='source'?SOURCES[k]||k:groupBy==='status'?report.statuses[k]||k:k),el('td','num',String(list.length)),el('td','num',hours(s.logged)),el('td','num',hours(s.confirmed)),el('td','num',hours(s.logged-s.confirmed)));}
        const scroll=el('div','wl-scroll');scroll.append(g);out.append(scroll);
        const d=el('details','wl-detail');d.append(el('summary','','All '+shown.length+' entries'));
        const tbl=el('table','wl-table');const th=tbl.createTHead().insertRow();for(const h of ['Date','User','Ticket','Client','Project','Source','Duration','Description','Status'])th.append(el('th','',h));
        const tb=tbl.createTBody();for(const r of shown){const tr=tb.insertRow();const k=el('td');k.append(button(r.ticket,()=>openIssue&&openIssue(r.ticket),'linkbtn'));tr.append(el('td','',r.date),el('td','',r.user),k,el('td','',r.clientName||''),el('td','',r.subClientName||''),el('td','',SOURCES[r.source]||r.source),el('td','num',formatMinutes(r.minutes)),el('td','wl-desc-cell',r.description),el('td'));tr.lastChild.append(badge(r));}
        const sc=el('div','wl-scroll');sc.append(tbl);d.append(sc);out.append(d);
      }
      // Hours entered before the work log are not part of the totals above.
      const tickets=new Set(shown.map(r=>r.ticket)),base=(report.baselines||[]).filter(b=>tickets.has(b.ticket));
      if(base.length){const d=el('details','wl-baseline');d.append(el('summary','','Hours entered before the work log: '+(Math.round(base.reduce((n,b)=>n+b.hours,0)*100)/100)+' h on '+base.length+' tickets (not included above)'));
        const ul=el('ul');for(const b of base)ul.append(el('li','',b.ticket+': '+b.hours+' h'));d.append(ul);out.append(d);}
    };
    if(report)draw();else load();
  }

  async function renderSetup(wrap){
    const box=el('div','wl-setup');wrap.append(box);box.append(el('p','msg','Loading the setup from Odoo…'));
    let s;try{s=await api('/time-entries/setup');}catch(err){box.replaceChildren();const m=el('p','msg');fail(m,err);box.append(m);return;}
    box.replaceChildren();
    const cfg=s.config,section=title=>{const sec=el('section','wl-section');sec.append(el('h3','',title));box.append(sec);return sec;};
    const msg=el('p','msg');msg.setAttribute('role','status');
    if(!s.odoo){box.append(el('p','msg err','Odoo isn\'t connected to the dashboard.'));return;}
    if(s.error)box.append(el('p','msg err',s.error));
    // Who logs work.
    const who=section('Who can log work');
    const mode=el('div','wl-modes');let modeValue=cfg.mode;
    for(const [v,l,h] of [['off','Off','Nobody logs work; existing entries stay visible.'],['pilot','Pilot group','Only the people chosen below.'],['on','Everyone','Every dashboard user.']]){
      const lab=el('label','wl-mode'),r=input('radio');r.name='wl-mode';r.value=v;r.checked=cfg.mode===v;r.addEventListener('change',()=>{modeValue=v;pilotBox.hidden=v!=='pilot';});lab.append(r,el('b','',l),el('small','msg',h));mode.append(lab);}
    who.append(mode);
    const pilotBox=el('div','wl-pilot');pilotBox.hidden=cfg.mode!=='pilot';const pilot=new Set(cfg.pilot);
    for(const u of s.users){const lab=el('label','tgl'),c=input('checkbox');c.checked=pilot.has(u.email);c.addEventListener('change',()=>{if(c.checked)pilot.add(u.email);else pilot.delete(u.email);});lab.append(c,' '+u.name+' ('+u.email+')');pilotBox.append(lab);}
    who.append(pilotBox);
    // Odoo fields.
    const fs=section('Odoo fields');
    fs.append(el('p','msg','Fields on the Odoo timesheet line; each must be a text field. Each ticket gets one task in its project, named "[KEY] Ticket title".'));
    const fields={...cfg.fields},sug=s.suggested||{},grid=el('div','wl-grid');fs.append(grid);
    const pickField=(role,label,list,hint)=>{const sel=el('select','fsel');sel.append(new Option('Choose a field…',''));for(const f of list)sel.append(new Option(f.label+' ('+f.name+')',f.name));sel.value=fields[role]||sug[role]||'';fields[role]=sel.value;sel.addEventListener('change',()=>{fields[role]=sel.value;});field(grid,label,sel,hint);};
    const line=s.fields?.line||[],custom=line.filter(f=>f.custom);
    pickField('users','"Users" on the timesheet line (the person\'s name)',line,sug.usersCandidates&&sug.usersCandidates.length>1?'More than one field looks like "Users": choose the right one.':(!sug.users&&!cfg.fields.users?'No field labelled "Users" was found: choose it.':''));
    pickField('entryUuid','Work entry id (custom)',custom,'Each line\'s unique id, used to find it again.');
    pickField('userUuid','Dashboard user id (custom)',custom,'The person\'s stable dashboard id.');
    pickField('lineRef','Ticket on the line (custom)',custom,'Source and ticket, like jira:AION-12.');
    // Defaults.
    const def=section('Employee and company');
    if(s.defaults?.ok)def.append(el('p','msg ok','Timesheet lines are created as employee '+s.defaults.employee.name+' in '+s.defaults.company.name+' (Odoo\'s default for the user '+s.defaults.user.name+'). The person who did the work is written in "Users".'));
    else def.append(el('p','msg err',(s.defaults?.problem||'The employee and company could not be checked.')+' Work logging can\'t be switched on until this is fixed.'));
    if(s.lockDate)def.append(el('p','msg','Odoo is locked up to '+s.lockDate+': work on or before that date can\'t be logged.'));
    // Projects.
    const map=section('Odoo projects');
    map.append(el('p','msg','Projects synced from Odoo already know their Odoo project. Map a client to send work on tickets that have a client but no project, or override a project.'));
    const label=p=>p.name+(p.partner?' · '+p.partner:'')+' (#'+p.id+')';
    const byId=new Map((s.projects||[]).map(p=>[p.id,p])),mapping={...cfg.mapping};
    // An Odoo project picker: type to search, pick from the list. The choice stays until × is clicked.
    const projectPicker=(name,value,onChange,placeholder)=>{
      const wrap=el('div','wl-pick'),inp=el('input','inp'),list=el('ul','wl-pick-list'),id='wlp'+Math.random().toString(36).slice(2,9);
      const clear=button('×',()=>{set(null);inp.focus();},'btn wl-pick-clear');clear.setAttribute('aria-label','Remove the Odoo project for '+name);clear.title='Remove';
      inp.type='text';inp.autocomplete='off';inp.setAttribute('role','combobox');inp.setAttribute('aria-label','Odoo project for '+name);inp.setAttribute('aria-autocomplete','list');inp.setAttribute('aria-expanded','false');inp.setAttribute('aria-controls',id);
      list.id=id;list.setAttribute('role','listbox');list.hidden=true;
      let current=value||null,items=[],active=-1;
      const show=()=>{inp.value=current?(byId.get(current)?label(byId.get(current)):'Project #'+current):'';inp.placeholder=placeholder||'Search Odoo projects…';clear.hidden=!current;};
      const close=()=>{list.hidden=true;inp.setAttribute('aria-expanded','false');inp.removeAttribute('aria-activedescendant');};
      const set=v=>{current=v;onChange(v);show();close();};
      const mark=n=>{active=n;[...list.children].forEach((li,i)=>li.classList.toggle('active',i===n));const li=list.children[n];if(li&&li.id){inp.setAttribute('aria-activedescendant',li.id);li.scrollIntoView({block:'nearest'});}};
      const open=q=>{
        const words=String(q||'').trim().toLowerCase().split(/\s+/).filter(Boolean);
        items=(s.projects||[]).filter(p=>{const t=label(p).toLowerCase();return words.every(w=>t.includes(w));}).slice(0,50);
        list.replaceChildren(...(items.length?items.map((p,i)=>{const li=el('li','wl-pick-opt'+(p.id===current?' current':''),label(p));li.id=id+'-'+i;li.setAttribute('role','option');li.dir='auto';li.addEventListener('mousedown',e=>{e.preventDefault();set(p.id);});return li;}):[el('li','wl-pick-empty','No Odoo project matches')]));
        list.hidden=false;inp.setAttribute('aria-expanded','true');mark(items.length?0:-1);
      };
      inp.addEventListener('focus',()=>{inp.select();open('');});
      inp.addEventListener('click',()=>{if(list.hidden)open('');});
      inp.addEventListener('input',()=>open(inp.value));
      inp.addEventListener('keydown',e=>{
        if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(list.hidden)open('');else if(items.length)mark((active+(e.key==='ArrowDown'?1:-1)+items.length)%items.length);}
        else if(e.key==='Enter'){e.preventDefault();if(!list.hidden&&items[active])set(items[active].id);}
        else if(e.key==='Escape'&&!list.hidden){e.preventDefault();e.stopPropagation();show();close();}
      });
      // Leaving the box without picking keeps the project chosen before.
      inp.addEventListener('blur',()=>{show();close();});
      wrap.append(inp,clear,list);show();return wrap;
    };
    const hdBox=el('div','wl-field');hdBox.append(el('span','','Odoo Helpdesk tickets without a project go to'),projectPicker('Odoo Helpdesk tickets',mapping.helpdesk,v=>{mapping.helpdesk=v;}),el('small','msg','Leave empty to require a project on the Helpdesk ticket.'));map.append(hdBox);
    const search=input('search','');search.className='inp catalog-search';search.placeholder='Search clients and projects…';search.setAttribute('aria-label','Search clients and projects');
    const list=el('div','wl-map');map.append(search,list);
    const parentName=id=>s.catalog.find(c=>c.id===id)?.name||'';
    const drawMap=()=>{
      list.replaceChildren();const q=search.value.trim().toLowerCase();
      const rows=s.catalog.filter(c=>mapping[c.id]||(q&&(c.name+' '+parentName(c.parentId)).toLowerCase().includes(q))||(!q&&c.parentId&&!c.odooProject));
      for(const c of rows.slice(0,60)){
        const row=el('div','wl-map-row');
        const picker=projectPicker(c.name,mapping[c.id],v=>{if(v)mapping[c.id]=v;else delete mapping[c.id];},c.odooProject?'From Odoo: '+(byId.get(c.odooProject)?label(byId.get(c.odooProject)):'#'+c.odooProject):'Search Odoo projects…');
        row.append(el('span','',c.parentId?parentName(c.parentId)+' › '+c.name:c.name+' (client)'),picker);list.append(row);
      }
      if(!rows.length)list.append(el('p','msg',q?'No client or project matches.':'Every project knows its Odoo project. Search to map a client or override one.'));
      else if(rows.length>60)list.append(el('p','msg','Showing 60 of '+rows.length+'. Search to narrow.'));
    };
    search.addEventListener('input',drawMap);drawMap();
    // Background sync.
    const bg=section('Background sync');
    bg.append(el('p','msg','Entries are sent to Odoo as soon as they are saved. Anything left (Odoo down, setup missing) is retried every 5 minutes by the scheduled job, which calls the proxy\'s /cron/time-sync with the TIME_SYNC_SECRET in its Authorization header.'));
    const actions=el('div','wl-actions');box.append(actions,msg);
    actions.append(button('Save setup',async ev=>{
      ev.currentTarget.disabled=true;msg.className='msg';msg.textContent='Checking with Odoo…';
      try{const body={revision:cfg.revision,mode:modeValue,pilot:[...pilot],fields,mapping:Object.fromEntries(Object.entries(mapping).filter(([,v])=>v))};
        await api('/time-entries/setup',{method:'PUT',body});if(toast)toast('Work log setup saved.');const parent=wrap.parentNode;renderPage(parent,true);}
      catch(err){fail(msg,err);ev.currentTarget.disabled=false;}
    },'btn primary'));
    if(cfg.updatedBy)box.append(el('p','msg','Last saved by '+cfg.updatedBy.name+', '+new Date(cfg.updatedAt).toLocaleString('en-GB',{timeZone:'Asia/Jerusalem'})+(cfg.mode!=='off'&&cfg.verified?' · checked with Odoo':'')+'.'));
  }

  // ---- Log work from the Work log page: choose the ticket first, then the time ----
  // Only open tickets the dashboard has loaded for this person. The server checks visibility and status again.
  function openTicketPicker(afterSave){
    const pickerOpener=document.activeElement;
    const tickets=myTickets().filter(t=>!t.closed);
    const {d,body,msg}=dialog('Log work');
    body.append(el('p','msg','Choose one of your open tickets, then enter the time you spent on it.'));
    const search=input('search','');search.placeholder='Search by key or title…';search.autocomplete='off';search.setAttribute('aria-label','Ticket');
    field(body,'Ticket',search);
    const list=el('div','wl-ticket-list');body.append(list);
    const enable=on=>{for(const b of list.querySelectorAll('button'))b.disabled=!on;};
    const choose=async t=>{
      enable(false);msg.className='msg';msg.textContent='Opening '+t.key+'…';
      let view;
      try{view=await api('/time-entries?ticket='+encodeURIComponent(t.key));}
      catch(err){fail(msg,err);enable(true);return;}
      if(!view.canLog){fail(msg,new Error(view.closed?'This ticket is closed. Reopen it before logging work.':"Work logging isn't switched on for you yet."));enable(true);return;}
      views[t.key]=view;d.close();openForm(t.key,t.title,view,afterSave,pickerOpener);
    };
    const draw=()=>{
      const shown=ticketMatches(tickets,search.value);
      list.replaceChildren(...(shown.length?shown.map(t=>{const b=button('',()=>choose(t),'wl-ticket-opt');b.dir='auto';b.append(el('b','wl-ticket-key',t.key),el('span','wl-ticket-title',t.title||''));return b;})
        :[el('p','msg',tickets.length?'No open ticket matches.':'No open tickets are loaded for you. Open the Tickets page, then try again.')]));
    };
    search.addEventListener('input',draw);
    search.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();const [first]=ticketMatches(tickets,search.value);if(first)choose(first);}});
    draw();search.focus();
  }

  return {render,openFor,renderPage,reset:()=>{stopTick();lastTimer=null;const t=document.getElementById('work-log'),b=document.getElementById('d-logwork');if(b)b.hidden=true;if(t){t.dataset.key='';t.replaceChildren();t.hidden=true;}}};
}
