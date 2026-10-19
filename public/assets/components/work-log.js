// Log work → Odoo timesheets: the "Log work" form, the ticket's Work log, administrator corrections and
// reconciliation, the Work log page (report for everyone, setup for administrators).
// Durations are whole minutes; dates are work dates in Asia/Jerusalem. The server checks everything again.
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const button=(text,fn,cls='btn')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const field=(parent,label,node,hint)=>{const l=el('label','wl-field');l.append(el('span','',label),node);if(hint)l.append(el('small','msg',hint));parent.append(l);return node;};
const input=(type,value)=>{const n=el('input','inp');n.type=type;if(value!=null)n.value=value;return n;};
export const formatMinutes=m=>[Math.floor(m/60)?Math.floor(m/60)+'h':'',m%60?m%60+'m':''].filter(Boolean).join(' ')||'0m';
const hours=m=>(Math.round(m/60*100)/100).toLocaleString('en-US',{maximumFractionDigits:2});
const niceDate=d=>{try{return new Date(d+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});}catch{return d;}};
const STATUS_CLASS={synced:'ok',syncing:'busy',setup:'warn',review:'crit'};
// "90", "1:30", "1h 30m", "1.5h", "45m" -> minutes (null when it can't be read).
export function parseDuration(text){
  const s=String(text||'').trim().toLowerCase();if(!s)return null;
  let m=/^(\d{1,2}):([0-5]\d)$/.exec(s);if(m)return Number(m[1])*60+Number(m[2]);
  if(/^\d+$/.test(s))return Number(s);
  m=/^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?$/.exec(s);
  if(m&&(m[1]||m[2])){const total=Math.round(Number(m[1]||0)*60)+Number(m[2]||0);return Number.isInteger(total)?total:null;}
  return null;
}
function badge(e){const b=el('span','wl-status wl-'+(STATUS_CLASS[e.status]||'busy'),e.statusLabel);if(e.reason)b.title=e.reason;return b;}

export function createWorkLog({api,isAdmin,me,errorText,toast,openIssue,onLogged=()=>{}}){
  const views={};
  function dialog(title){
    const d=el('dialog','business-dialog wl-dialog'),head=el('div','business-dialog-head'),body=el('div','wl-form'),msg=el('p','msg');msg.setAttribute('role','status');
    head.append(el('h2','',title),button('Close',()=>d.close()));d.append(head,body,msg);document.body.append(d);d.addEventListener('close',()=>d.remove());d.showModal();return {d,body,msg};
  }
  const fail=(msg,err)=>{msg.className='msg err';msg.textContent=errorText?errorText(err):err.message||String(err);};

  // ---- Log work ----
  function openForm(key,title,view){
    const {d,body,msg}=dialog('Log work · '+key);
    const facts=el('dl','wl-facts');
    const fact=(k,v)=>{facts.append(el('dt','',k));const dd=el('dd');if(v instanceof Node)dd.append(v);else dd.textContent=v;facts.append(dd);};
    fact('Ticket',key+(title?' · '+title:''));fact('User',me().name||me().email);
    const dest=view.destination;
    fact('Goes to Odoo',!dest?'Odoo project shown after setup':dest.setup?el('span','msg err',dest.setup):dest.error?el('span','msg err',dest.error):dest.projectName+' › '+dest.taskName);
    body.append(facts);
    const row=el('div','wl-row');body.append(row);
    const minDate=view.lockDate?new Date(Date.parse(view.lockDate+'T12:00:00Z')+86400000).toISOString().slice(0,10):'';
    const date=field(row,'Work date',input('date',view.today),view.lockDate?'Odoo is locked up to '+view.lockDate+'.':'Today or earlier (Israel time).');
    date.max=view.today;if(minDate)date.min=minDate;date.required=true;
    const duration=field(row,'Duration',input('text',''),'Minutes, or like 1h 30m or 1:30. Up to 24 hours.');
    duration.placeholder='e.g. 45 or 1h 30m';duration.inputMode='text';duration.autocomplete='off';
    const shown=el('span','wl-duration-shown');duration.closest('label').append(shown);
    const shortcuts=el('div','wl-shortcuts');for(const [label,m] of [['15m',15],['30m',30],['1h',60],['2h',120]])shortcuts.append(button(label,()=>{duration.value=String(m);update();duration.focus();},'btn wl-chip'));
    duration.closest('label').after(shortcuts);
    const desc=field(body,'Description',el('textarea','inp'),'What you did. Required; it is written on the Odoo timesheet line.');desc.rows=4;desc.maxLength=2000;desc.dir='auto';desc.required=true;
    const update=()=>{const m=parseDuration(duration.value);shown.textContent=duration.value.trim()?(m&&m>=1&&m<=1440?'= '+formatMinutes(m):'Not a valid duration'):'';shown.className='wl-duration-shown'+(duration.value.trim()&&!(m&&m>=1&&m<=1440)?' err':'');};
    duration.addEventListener('input',update);
    // The id makes saving safe to repeat: a retry after a lost answer can't log the work twice.
    let id=crypto.randomUUID();
    const save=async again=>{
      const minutes=parseDuration(duration.value),description=desc.value.trim();
      if(!date.value||date.value>view.today){fail(msg,new Error('Choose a work date that is not in the future.'));date.focus();return;}
      if(minDate&&date.value<minDate){fail(msg,new Error('Odoo is locked up to '+view.lockDate+'. Choose a later date.'));date.focus();return;}
      if(!minutes||minutes<1||minutes>1440){fail(msg,new Error('Enter a duration between 1 minute and 24 hours.'));duration.focus();return;}
      if(!description){fail(msg,new Error('Describe the work.'));desc.focus();return;}
      for(const b of actions.querySelectorAll('button'))b.disabled=true;msg.className='msg';msg.textContent='Saving…';
      try{
        const r=await api('/time-entries',{method:'POST',body:{id,ticket:key,date:date.value,minutes,description}});
        id=crypto.randomUUID();
        const note=formatMinutes(minutes)+' logged on '+key+(r.entry.status==='synced'?' and saved in Odoo.':' · '+r.entry.statusLabel+(r.entry.reason?': '+r.entry.reason:''));
        onLogged(key);render(key);
        if(again){duration.value='';desc.value='';update();msg.className='msg ok';msg.textContent=note+' Add the next one.';duration.focus();}
        else{d.close();if(toast)toast(note);}
      }catch(err){fail(msg,err);}
      finally{for(const b of actions.querySelectorAll('button'))b.disabled=false;}
    };
    const actions=el('div','wl-actions');actions.append(button('Save',()=>save(false),'btn primary'),button('Save and add another',()=>save(true)),button('Cancel',()=>d.close()));body.append(actions);
    body.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();save(false);}});
    duration.focus();
  }

  // ---- Correction (administrators) ----
  function openCorrection(e,view){
    const {d,body,msg}=dialog('Correct work entry · '+e.ticket);
    body.append(el('p','msg','By '+e.author.name+'. The Odoo timesheet line is updated, and the change is kept in the entry\'s history.'));
    const row=el('div','wl-row');body.append(row);
    const date=field(row,'Work date',input('date',e.date));date.max=view?.today||'';
    const duration=field(row,'Duration',input('text',String(e.minutes)),'Minutes, or like 1h 30m.');
    const desc=field(body,'Description',el('textarea','inp'));desc.value=e.description;desc.rows=3;desc.maxLength=2000;desc.dir='auto';
    const reason=field(body,'Reason for the correction (required)',el('textarea','inp'));reason.rows=2;reason.maxLength=1000;reason.dir='auto';
    const actions=el('div','wl-actions');body.append(actions);
    actions.append(button('Save correction',async ev=>{
      const minutes=parseDuration(duration.value),patch={revision:e.revision,reason:reason.value.trim()};
      if(!patch.reason){fail(msg,new Error('Give a reason for the correction.'));reason.focus();return;}
      if(!minutes||minutes<1||minutes>1440){fail(msg,new Error('Enter a duration between 1 minute and 24 hours.'));return;}
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
    const headerButton=document.getElementById('d-logwork');
    if(target.dataset.key!==key){target.dataset.key=key;target.replaceChildren(el('h3','','Work log'),el('p','msg','Loading…'));if(headerButton)headerButton.hidden=true;}
    let view;
    try{view=await api('/time-entries?ticket='+encodeURIComponent(key));}
    catch(err){if(target.dataset.key!==key)return;if(err.code==='not_found'||err.status===404&&err.code==='server'){target.hidden=true;return;}target.hidden=false;target.replaceChildren(el('h3','','Work log'),el('p','msg err',errorText?errorText(err):err.message));return;}
    if(target.dataset.key!==key)return;views[key]=view;if(headerButton)headerButton.hidden=!view.canLog;
    // Nothing to show while work logging is off and the ticket has no entries.
    target.hidden=!view.logging&&!view.entries.length;
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
    if(view.entries.length){const list=el('ol','wl-list');for(const e of view.entries)list.append(entryRow(e,view));target.append(list);}
  }
  function openFor(key,title){const view=views[key];if(view&&view.canLog)openForm(key,title,view);}

  // ---- Work log page ----
  let report=null,filters={user:'',client:'',project:'',ticket:'',source:'',status:''},groupBy='user',tab='report';
  const SOURCES={jira:'Jira',internal:'Internal',odoo:'Odoo Helpdesk'};
  function renderPage(target){
    target.replaceChildren();
    const wrap=el('div','wl-page');target.append(wrap);
    if(isAdmin()){const tabs=el('div','wl-tabs');tabs.setAttribute('role','tablist');
      for(const [id,label] of [['report','Report'],['setup','Setup']]){const b=button(label,()=>{tab=id;renderPage(target);},'btn'+(tab===id?' primary':''));b.setAttribute('role','tab');b.setAttribute('aria-selected',String(tab===id));tabs.append(b);}
      wrap.append(tabs);}
    if(tab==='setup'&&isAdmin())return renderSetup(wrap);
    renderReport(wrap);
  }
  function renderReport(wrap){
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem'}).format(new Date());
    const bar=el('div','wl-report-bar'),from=input('date',report?.from||today.slice(0,8)+'01'),to=input('date',report?.to||today),msg=el('span','msg');
    from.setAttribute('aria-label','From');to.setAttribute('aria-label','To');
    const out=el('div','wl-report');
    const load=async()=>{msg.className='msg';msg.textContent='Loading…';try{report=await api('/time-entries/report?from='+from.value+'&to='+to.value);msg.textContent='';draw();}catch(err){fail(msg,err);}};
    bar.append(el('span','','From'),from,el('span','','to'),to,button('Show',load,'btn primary'),msg);
    wrap.append(el('p','msg',isAdmin()?'Everyone\'s logged work by work date (Israel time). Filters apply on this page.':'Your logged work by work date (Israel time).'),bar,out);
    const draw=()=>{
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
      for(const [label,m,cls] of [['Logged',t.logged,''],['Confirmed in Odoo',t.confirmed,'ok'],['Not in Odoo yet',t.logged-t.confirmed,t.logged-t.confirmed?'warn':'']]){const c=el('div','wl-card '+cls);c.append(el('span','',label),el('b','',hours(m)+' h'),el('small','',formatMinutes(m)));cards.append(c);}
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
    fs.append(el('p','msg','Create these as custom fields in Odoo (Settings → Technical → Fields, or Studio) if they don\'t exist yet: no module is installed. Every field must be a text field.'));
    const fields={...cfg.fields},sug=s.suggested||{},grid=el('div','wl-grid');fs.append(grid);
    const pickField=(role,label,list,hint)=>{const sel=el('select','fsel');sel.append(new Option('Choose a field…',''));for(const f of list)sel.append(new Option(f.label+' ('+f.name+')',f.name));sel.value=fields[role]||sug[role]||'';fields[role]=sel.value;sel.addEventListener('change',()=>{fields[role]=sel.value;});field(grid,label,sel,hint);};
    const line=s.fields?.line||[],task=s.fields?.task||[],custom=line.filter(f=>f.custom);
    pickField('users','"Users" on the timesheet line (the person\'s name)',line,sug.usersCandidates&&sug.usersCandidates.length>1?'More than one field looks like "Users": choose the right one.':(!sug.users&&!cfg.fields.users?'No field labelled "Users" was found: choose it.':''));
    pickField('entryUuid','Work entry id (custom)',custom,'Each line\'s unique id, used to find it again.');
    pickField('userUuid','Dashboard user id (custom)',custom,'The person\'s stable dashboard id.');
    pickField('lineRef','Ticket on the line (custom)',custom,'Source and ticket, like jira:AION-12.');
    pickField('taskRef','Ticket on the task (custom, on Tasks)',task.filter(f=>f.custom),'Links the ticket\'s one task, like aione:jira:AION-12.');
    // Defaults.
    const def=section('Employee and company');
    if(s.defaults?.ok)def.append(el('p','msg ok','Timesheet lines are created as employee '+s.defaults.employee.name+' in '+s.defaults.company.name+' (Odoo\'s default for the user '+s.defaults.user.name+'). The person who did the work is written in "Users".'));
    else def.append(el('p','msg err',(s.defaults?.problem||'The employee and company could not be checked.')+' Work logging can\'t be switched on until this is fixed.'));
    if(s.lockDate)def.append(el('p','msg','Odoo is locked up to '+s.lockDate+': work on or before that date can\'t be logged.'));
    // Projects.
    const map=section('Odoo projects');
    map.append(el('p','msg','Projects synced from Odoo already know their Odoo project. Map a client to send work on tickets that have a client but no project, or override a project.'));
    const dl=el('datalist');dl.id='wl-projects';const label=p=>p.name+(p.partner?' · '+p.partner:'')+' (#'+p.id+')';
    for(const p of s.projects||[])dl.append(new Option(label(p)));map.append(dl);
    const byId=new Map((s.projects||[]).map(p=>[p.id,p])),mapping={...cfg.mapping};
    const hd=el('input','inp');hd.setAttribute('list','wl-projects');hd.value=mapping.helpdesk&&byId.get(mapping.helpdesk)?label(byId.get(mapping.helpdesk)):'';
    const readId=v=>{const m=/\(#(\d+)\)\s*$/.exec(v||'');return m?Number(m[1]):null;};
    hd.addEventListener('change',()=>{mapping.helpdesk=readId(hd.value);});field(map,'Odoo Helpdesk tickets without a project go to',hd,'Leave empty to require a project on the Helpdesk ticket.');
    const search=input('search','');search.className='inp catalog-search';search.placeholder='Search clients and projects…';search.setAttribute('aria-label','Search clients and projects');
    const list=el('div','wl-map');map.append(search,list);
    const parentName=id=>s.catalog.find(c=>c.id===id)?.name||'';
    const drawMap=()=>{
      list.replaceChildren();const q=search.value.trim().toLowerCase();
      const rows=s.catalog.filter(c=>mapping[c.id]||(q&&(c.name+' '+parentName(c.parentId)).toLowerCase().includes(q))||(!q&&c.parentId&&!c.odooProject));
      for(const c of rows.slice(0,60)){
        const row=el('div','wl-map-row'),inp=el('input','inp');inp.setAttribute('list','wl-projects');inp.setAttribute('aria-label','Odoo project for '+c.name);
        inp.value=mapping[c.id]&&byId.get(mapping[c.id])?label(byId.get(mapping[c.id])):'';inp.placeholder=c.odooProject?'From Odoo: '+(byId.get(c.odooProject)?label(byId.get(c.odooProject)):'#'+c.odooProject):'No Odoo project';
        inp.addEventListener('change',()=>{const id=readId(inp.value);if(id)mapping[c.id]=id;else delete mapping[c.id];});
        row.append(el('span','',c.parentId?parentName(c.parentId)+' › '+c.name:c.name+' (client)'),inp);list.append(row);
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
        await api('/time-entries/setup',{method:'PUT',body});if(toast)toast('Work log setup saved.');const parent=wrap.parentNode;renderPage(parent);}
      catch(err){fail(msg,err);ev.currentTarget.disabled=false;}
    },'btn primary'));
    if(cfg.updatedBy)box.append(el('p','msg','Last saved by '+cfg.updatedBy.name+', '+new Date(cfg.updatedAt).toLocaleString('en-GB',{timeZone:'Asia/Jerusalem'})+(cfg.mode!=='off'&&cfg.verified?' · checked with Odoo':'')+'.'));
  }

  return {render,openFor,renderPage,reset:()=>{const t=document.getElementById('work-log'),b=document.getElementById('d-logwork');if(b)b.hidden=true;if(t){t.dataset.key='';t.replaceChildren();t.hidden=true;}}};
}
