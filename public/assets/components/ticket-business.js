import {createReportBrowser} from './report-browser.js';
import { createdDate, DASH_PRIORITIES } from '../models/ticket-business.js';
import { BUDGET_LABEL, DEFAULT_VIEW, budgetStatus, hours, signedHours, percent, budgetText, budgetRows, budgetCsvRows, budgetCounts, projectChoices, hiddenFilterCount, assignableProjects, MAPPING_KINDS, mappingSuggestion, mappingRows, mappingCounts } from '../models/odoo-projects.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const button=(text,fn,cls='btn')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const field=(parent,label,node)=>{const l=el('label','business-field');node.setAttribute('aria-label',label);l.append(el('span','',label),node);parent.append(l);return node;};
const option=(select,label,value)=>select.append(new Option(label,value));
const billingOptions=(select,value)=>{const prompt=new Option('Choose billing…','');prompt.disabled=true;prompt.hidden=true;select.append(prompt);option(select,'Billable','billable');option(select,'Not billable','not_billable');select.value=value||'';};
// A picker you can type into: the list narrows as you type; click, or use the arrow keys and Enter.
// The original <select> stays (hidden) as the value everything else reads and listens to.
export function combobox(select,{blank=false}={}){
  const wrap=el('div','combo'),input=el('input','inp combo-input'),list=el('ul','combo-list');
  const id='cb'+Math.random().toString(36).slice(2,9);list.id=id;list.setAttribute('role','listbox');list.hidden=true;
  input.type='text';input.autocomplete='off';input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls',id);input.setAttribute('aria-expanded','false');
  select.removeAttribute('aria-label');select.classList.add('combo-native');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
  select.before(wrap);wrap.append(input,list);
  let items=[],active=-1;
  const sync=()=>{const o=select.selectedOptions[0];input.value=o&&(o.value||blank)?o.text:'';input.placeholder=(select.options[0]&&select.options[0].text)||'Choose…';input.disabled=select.disabled;};
  const close=()=>{list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');};
  const mark=n=>{active=n;[...list.children].forEach((li,i)=>li.classList.toggle('active',i===n));const li=list.children[n];if(li){input.setAttribute('aria-activedescendant',li.id);li.scrollIntoView({block:'nearest'});}};
  const choose=o=>{if(select.value!==o.value){select.value=o.value;select.dispatchEvent(new Event('change',{bubbles:true}));}sync();close();};
  const open=q=>{q=String(q||'').trim().toLowerCase();items=[...select.options].filter(o=>(o.value||blank)&&!o.disabled&&(!q||o.text.toLowerCase().includes(q)));
    list.replaceChildren(...(items.length?items.map((o,i)=>{const li=el('li','combo-opt'+(o.value===select.value?' current':''),o.text);li.id=id+'-'+i;li.setAttribute('role','option');li.dir='auto';li.addEventListener('mousedown',e=>{e.preventDefault();choose(o);});return li;}):[el('li','combo-empty',q?'No match':'Nothing to choose')]));
    list.hidden=false;input.setAttribute('aria-expanded','true');mark(items.length?0:-1);};
  input.addEventListener('focus',()=>{input.select();open('');});
  input.addEventListener('click',()=>{if(list.hidden)open('');});
  input.addEventListener('input',()=>open(input.value));
  input.addEventListener('keydown',e=>{
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(list.hidden)open('');else if(items.length)mark((active+(e.key==='ArrowDown'?1:-1)+items.length)%items.length);}
    else if(e.key==='Enter'){e.preventDefault();if(!list.hidden&&items[active])choose(items[active]);}
    else if(e.key==='Escape'&&!list.hidden){e.preventDefault();e.stopPropagation();sync();close();}
  });
  // Leaving the field: an emptied field clears the choice; anything else goes back to the chosen name.
  input.addEventListener('blur',()=>{if(!input.value.trim()&&select.value&&select.options[0]&&!select.options[0].value)choose(select.options[0]);else sync();close();});
  select.addEventListener('change',sync);sync();
  return {refresh:sync,input};
}
const input=(type,value)=>{const n=el('input','inp');n.type=type;n.value=value??'';return n;};
const message=(target,e)=>{target.textContent=e.message||String(e);target.className='msg err';};
// The overage flag: more work logged than the agreed hours. Administrators also see the hours over.
export function checkupNote(m){const text=m.agreedHours!=null?'Needs checkup: '+(Math.round(m.loggedMinutes/60*100)/100)+' h logged, '+m.agreedHours+' h agreed'+(m.overHours>0?' ('+m.overHours+' h over)':'')+'.':'Needs checkup: more work is logged than agreed.';return el('p','msg err checkup',text);}
export function createTicketBusiness({api,context,onChange,openIssue}){
  let billingNeeded=false,enabled=false,epicMapping=false,projectAdmin=false,projectBudget=false,catalog={revision:0,entries:[]},records={},editor=null;
  const reportBrowser=createReportBrowser({api,openIssue,clientsPanel:reportAddPanel});
  const admin=()=>context().admin;
  let odooOn=false,odooProjects=[],syncState=null;
  const clients=()=>catalog.entries.filter(e=>!e.parentId&&!e.archived);
  const children=id=>catalog.entries.filter(e=>e.parentId===id&&!e.archived);
  async function loadCatalog(){catalog=await api('/clients');if(odooOn)await loadProjects().catch(()=>{});return catalog;}
  // The Odoo projects a ticket can be given (from the catalog sync's snapshot), and the sync's last result.
  async function loadProjects(){const [o,s]=await Promise.all([api('/clients/odoo-projects/options'),api('/clients/odoo-sync').catch(()=>null)]);odooProjects=o.projects;syncState=s;return odooProjects;}
  // A client's shown name: the AI name an administrator chose, else its Odoo name.
  const label=e=>e?(e.aiName||e.name):'';
  // With an Odoo project the ticket shows that project (marked when archived) and its client.
  function names(m){const client=label(catalog.entries.find(e=>e.id===m.clientId)),p=m.odooProject;
    return p?{...m,clientName:client||p.clientName||'',subClientName:p.name+(p.archived?' (archived)':'')}:{...m,clientName:client,subClientName:label(catalog.entries.find(e=>e.id===m.subClientId))};}
  // The Odoo project picker: one searchable list of "Client → Project", active projects with a client only. The client is
  // shown read-only, from the project. read() gives odooProjectId when it was chosen or changed (required: always).
  function projectPicker(parent,values={},{disabled=false,required=false}={}){
    const current=values.odooProjectId??null,{choices,noClient}=projectChoices(odooProjects,current);
    const select=field(parent,'Odoo project',el('select','fsel'));option(select,'Choose Odoo project…','');
    for(const c of choices){const o=new Option(c.label,String(c.id));o.disabled=c.disabled;select.append(o);}
    select.value=current!=null?String(current):'';select.disabled=disabled;if(required)select.setAttribute('aria-required','true');
    const info=el('p','business-client-readonly'),badge=el('div','business-project-flags');parent.append(info,badge);
    const show=()=>{const p=odooProjects.find(x=>String(x.id)===select.value)||(current!=null&&select.value===String(current)?values.odooProject:null);
      info.textContent='Client: '+(p?(p.clientName||'No client'):'—');badge.replaceChildren();
      if(p?.archived)badge.append(el('span','project-status archived','Archived in Odoo'));
      if(p&&p.known===false)badge.append(el('span','project-status conflict','Not in the synced Odoo projects'));};
    if(current==null&&values.clientId&&!required)parent.append(el('p','msg err','Saved before tickets had an Odoo project: choose one. Its work log needs it.'));
    if(noClient.length)parent.append(el('p','business-guidance','Not offered, no client in Odoo: '+noClient.map(p=>p.name).join(', ')+'. Set the customer on the project in Odoo, then sync.'));
    const box=combobox(select);select.addEventListener('change',show);show();
    return {select,first:box.input,read:()=>{
      if(!select.value){if(required)throw new Error('Choose the Odoo project for this ticket.');return {};}
      const id=Number(select.value);return required||id!==current?{odooProjectId:id}:{};}};
  }
  // Where the ticket's client comes from: the Odoo project when Odoo is connected, else the catalog client and project.
  const placement=(parent,values,{disabled=false,required=false,optional=true}={})=>odooOn?projectPicker(parent,values,{disabled,required}):(s=>({...s,first:s.client}))(selections(parent,values,disabled,optional));
  const placed=v=>v.odooProjectId!=null||!!(v.clientId||v.subClientId);
  // Moving a ticket that has work logs: those stay on the old project, so say so first.
  const confirmMove=(fields,r)=>!('odooProjectId' in fields)||r.metadata.odooProjectId==null||fields.odooProjectId===r.metadata.odooProjectId||!(r.workEntries>0)||confirm('This ticket has '+r.workEntries+' work log '+(r.workEntries===1?'entry':'entries')+'. They stay on '+(r.metadata.odooProject?.label||'the current project')+'; only new work goes to the new project. Change the project?');
  // One history line. A project change shows the project names, not the ids behind them.
  function historyText(h){
    if(h.type==='override')return 'Closure override: '+h.reason+' — '+h.missing.join('; ');
    if(h.type!=='edit')return h.type;
    const hide=h.project?['odooProjectId','clientId','subClientId']:[],parts=Object.entries(h.changes||{}).filter(([k])=>!hide.includes(k)).map(([k,v])=>k+': '+(v.from??'Not set')+' → '+(v.to??'Not set'));
    if(h.project)parts.unshift('Odoo project: '+(h.project.from||'Not set')+' → '+h.project.to+(h.note?' ('+h.note+')':''));
    return parts.join('; ');
  }
  function selections(parent,values={},disabled=false,optional=false){
    const client=field(parent,'Client',el('select','fsel')),sub=field(parent,'Project',el('select','fsel'));
    option(client,optional?'No client (optional)':'Choose client…','');for(const c of clients().sort((a,b)=>label(a).localeCompare(label(b))))option(client,label(c),c.id);
    if(values.clientId&&!clients().some(e=>e.id===values.clientId)){const old=catalog.entries.find(e=>e.id===values.clientId);if(old)option(client,old.name+' (archived)',old.id);}
    client.value=values.clientId||'';client.disabled=disabled;sub.disabled=disabled;
    // Every project can be chosen: the client's own projects first, then all the others (with their client).
    const fill=()=>{sub.replaceChildren();const own=children(client.value).sort((a,b)=>label(a).localeCompare(label(b)));
      option(sub,own.length?'Choose project…':'No project (optional)','');for(const c of own)option(sub,label(c),c.id);
      const parentName=id=>{const p=catalog.entries.find(e=>e.id===id);return p&&p.name!=='No contact'?' · '+label(p):'';};
      const others=catalog.entries.filter(e=>e.parentId&&!e.archived&&e.parentId!==client.value).sort((a,b)=>label(a).localeCompare(label(b)));
      if(others.length){const group=document.createElement('optgroup');group.label=own.length?'Other projects':'All projects';for(const c of others)group.append(new Option(label(c)+parentName(c.parentId),c.id));sub.append(group);}};fill();
    if(values.subClientId&&![...sub.options].some(o=>o.value===values.subClientId)){const old=catalog.entries.find(e=>e.id===values.subClientId);if(old)option(sub,old.name+' (archived)',old.id);}
    sub.value=values.subClientId||'';client.addEventListener('change',fill);
    combobox(client);const subBox=combobox(sub);client.addEventListener('change',subBox.refresh);
    return {client,sub,read:()=>({clientId:client.value||null,subClientId:sub.value||null})};
  }
  function createFields(parent,{values={},creating=false,closed=false}={}){
    const box=el('div','business-form');parent.append(box);
    const clientGroup=el('fieldset','business-section business-client-section');clientGroup.append(el('legend','',odooOn?'Odoo project & billing':'Client & billing'));box.append(clientGroup);
    // Once set, only administrators change it (the backend checks this too).
    const locked=!admin()&&!creating&&placed(values),selects=placement(clientGroup,values,{disabled:closed||locked,required:creating});
    if(locked&&odooOn)clientGroup.append(el('p','business-guidance','Ask an administrator to move this ticket to another Odoo project.'));
    let billing;if(admin()){billing=field(clientGroup,'Billing (administrators only)',el('select','fsel'));billingOptions(billing,values.billing);billing.disabled=closed;if(creating&&billingNeeded)billing.setAttribute('aria-required','true');}
    const workGroup=el('fieldset','business-section business-work-section');workGroup.append(el('legend','','Work summary'));box.append(workGroup);
    const logged=values.loggedMinutes>0;
    const estimated=field(workGroup,'Estimated hours',input('number',values.estimatedHours)),actual=field(workGroup,logged?'Actual hours before the work log':'Actual hours',input('number',values.actualHours));
    if(logged){const total=el('p','msg business-total','Actual hours with the work log: '+values.totalActualHours+' h ('+(Math.round(values.loggedMinutes/60*100)/100)+' h logged).');workGroup.append(total);}
    // Agreed hours: administrators only. They are the figure Odoo gets for the ticket; empty clears them.
    let agreed=null;if(admin()&&!creating){agreed=field(workGroup,'Agreed hours (administrators only)',input('number',values.agreedHours));agreed.min='0.01';agreed.max='1000000';agreed.step='0.01';agreed.disabled=closed;agreed.title='Odoo gets one line with these hours for the developer. Empty clears them.';}
    for(const n of [estimated,actual]){n.min='0.01';n.max='1000000';n.step='0.01';n.disabled=closed;}
    // Once set, the estimate is changed by administrators only.
    if(!admin()&&!creating&&values.estimatedHours!=null){estimated.disabled=true;estimated.title='The estimate is set. Ask an administrator to change it.';}
    const work=field(workGroup,'Work done',el('textarea','inp'));work.value=values.workDone||'';work.maxLength=5000;work.rows=4;work.dir='auto';work.disabled=closed;
    const read=()=>{if(creating&&admin()&&billingNeeded&&!billing.value)throw new Error('Choose Billable or Not billable before assigning this ticket.');for(const n of [estimated,actual])if(!n.checkValidity())throw new Error('Hours must be greater than zero, with up to two decimal places.');const out={estimatedHours:estimated.value===''?null:Number(estimated.value),actualHours:actual.value===''?null:Number(actual.value),workDone:work.value};if(admin()||creating||!placed(values))Object.assign(out,selects.read());if(billing)out.billing=billing.value||null;if(agreed){if(!agreed.checkValidity())throw new Error('Agreed hours must be greater than zero, with up to two decimal places.');const hours=agreed.value===''?null:Number(agreed.value);if(hours!==(values.agreedHours??null))out.agreedHours=hours;}return out;};
    return {read,box,selects};
  }
  async function load(keys){
    if(!enabled)return;const unique=[...new Set(keys)];
    const parts=[];for(let i=0;i<unique.length;i+=100)parts.push(unique.slice(i,i+100));
    await Promise.all(parts.map(async part=>{const r=await api('/ticket-metadata/batch',{method:'POST',body:{keys:part}});Object.assign(records,r.records);}));
  }
  function decorate(i){const r=records[i.key];return {...i,...(r?names(r):{}),...(r&&r.totalActualHours!=null?{actualHours:r.totalActualHours}:{})};}
  // One field (or the client pair) edited straight from the ticket list, with the same rules as the ticket panel
  // (client and billing for administrators; closed tickets locked). The server checks all of it again.
  const QUICK={client:'Client',billing:'Billing',estimatedHours:'Estimated hours',actualHours:'Actual hours',workDone:'Work done',dashPriority:'Priority'};
  const quickLabel=name=>name==='client'&&odooOn?'Odoo project':QUICK[name];
  function canQuickEdit(i,name){if(!enabled||!i||i.odoo||i.cat==='done'||!(name in QUICK))return false;if(name==='estimatedHours'&&!admin()&&i.estimatedHours!=null)return false;if(name==='dashPriority')return admin();if(name==='client')return admin()||!placed(i);return name==='billing'?admin():true;}
  async function quickEdit(box,key,name,done){
    const msg=el('p','msg','Loading…');box.replaceChildren(msg);
    let r;try{r=await api('/ticket-metadata?key='+encodeURIComponent(key));}catch(e){message(msg,e);return;}
    records[key]=r.metadata;box.replaceChildren();
    if(r.closed){box.append(el('p','msg','Closed ticket: reopen it to edit these fields.'));return;}
    const v=r.metadata,form=el('div','quick-edit');box.append(form);let read,first;
    if(name==='client'){const s=placement(form,v,{required:odooOn,optional:false});read=s.read;first=s.first;}
    else if(name==='billing'){const b=field(form,'Billing',el('select','fsel'));billingOptions(b,v.billing);read=()=>{if(!b.value)throw new Error('Choose Billable or Not billable.');return {billing:b.value};};first=b;}
    else if(name==='workDone'){const t=field(form,'Work done',el('textarea','inp'));t.value=v.workDone||'';t.maxLength=5000;t.rows=4;t.dir='auto';read=()=>({workDone:t.value});first=t;}
    else if(name==='dashPriority'){const p=field(form,'Priority',el('select','fsel'));option(p,'Not set','');DASH_PRIORITIES.forEach(x=>option(p,x,x));p.value=v.dashPriority||'';const o=field(form,'Order within priority',input('number',v.dashOrder));o.min='1';o.max='99';o.step='1';o.placeholder='Last';read=()=>{if(o.value!==''&&!o.checkValidity())throw new Error('The order must be a whole number from 1 to 99.');return {dashPriority:p.value||null,dashOrder:o.value===''?null:Number(o.value)};};first=p;}
    else{const n=field(form,QUICK[name],input('number',v[name]));n.min='0.01';n.max='1000000';n.step='0.01';read=()=>{if(!n.checkValidity())throw new Error('Hours must be greater than zero, with up to two decimal places.');return {[name]:n.value===''?null:Number(n.value)};};first=n;}
    const status=el('p','msg'),save=button('Save',async()=>{
      save.disabled=true;
      try{const fields=read();if(!confirmMove(fields,r)){save.disabled=false;return;}const data=await api('/ticket-metadata',{method:'PUT',body:{key,fields:{revision:v.revision,...fields}}});records[key]=data.metadata;done();}
      catch(err){message(status,err);save.disabled=false;}
    },'btn primary');
    form.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.target.tagName!=='TEXTAREA'||e.ctrlKey||e.metaKey)){e.preventDefault();save.click();}});
    box.append(save,status);first.focus();
  }
  async function renderEditor(key){
    const target=document.getElementById('business-fields');target.hidden=key.startsWith('HD-');if(target.hidden){editor=null;return;}target.replaceChildren(el('h3','','Ticket work & client'));
    if(!enabled){target.append(el('p','msg err','Deploy the updated backend to enable ticket business fields and validated closure.'));return;}
    if(editor?.key===key&&editor.dirty())return;
    editor=null;target.append(el('p','msg','Loading ticket fields…'));
    try{
      const r=await api('/ticket-metadata?key='+encodeURIComponent(key));if(context().key!==key)return;
      records[key]=r.metadata;target.replaceChildren(el('h3','','Ticket work & client'));
      target.append(el('p','business-guidance',r.closed?'Completed work is read-only. Reopen the ticket to make corrections.':odooOn?'Complete the hours and work summary before closing. The client comes from the Odoo project; new work logs go to that project.':'Complete the hours and work summary before closing. The client is optional.'));
      if(r.metadata.epicKey&&!odooOn)target.append(el('p','business-guidance','The client comes from epic '+r.metadata.epicKey+' and follows it. Choosing another client here stops that.'));
      if(r.metadata.overage==='overage')target.append(checkupNote(r.metadata));
      const controls=createFields(target,{values:r.metadata,closed:r.closed}),msg=el('p','msg');let initial=JSON.stringify(controls.read()),editorRevision=r.metadata.revision;
      const readiness=el('div','work-readiness');target.insertBefore(readiness,controls.box);
      const updateReadiness=()=>{let value;try{value={...r.metadata,...controls.read()};}catch{value={...r.metadata};}readiness.replaceChildren();for(const [label,ready]of [['Estimate',value.estimatedHours>0],['Actual hours',value.actualHours>0||r.metadata.loggedMinutes>0],['Work done',!!value.workDone?.trim()]]){const chip=el('span','readiness-chip'+(ready?' ready':''),(ready?'✓ ':'○ ')+label);readiness.append(chip);}};controls.box.addEventListener('input',updateReadiness);controls.box.addEventListener('change',updateReadiness);updateReadiness();
      editor={key,dirty:()=>{try{return JSON.stringify(controls.read())!==initial;}catch{return true;}}};
      if(r.closed)target.append(el('p','msg','Closed ticket. An administrator must reopen it before these fields can be edited.'));
      else target.append(button('Save ticket fields',async e=>{
        const save=e.currentTarget;save.disabled=true;
        try{const fields=controls.read();if(!confirmMove(fields,r))return;const data=await api('/ticket-metadata',{method:'PUT',body:{key,fields:{revision:editorRevision,...fields}}});records[key]=data.metadata;editorRevision=data.metadata.revision;msg.className='msg';msg.textContent='Ticket fields saved.'+(data.warning?' '+data.warning:'');await onChange();
          // A new project: redraw, so the picker, history and work log destination start from it.
          if('odooProjectId' in fields){editor=null;await renderEditor(key);return;}initial=JSON.stringify(controls.read());}
        catch(err){message(msg,err);}finally{save.disabled=false;}
      },'btn primary'));
      target.append(msg);
      const history=el('details','business-history');history.append(el('summary','','Business field history'));
      for(const h of [...r.history].reverse()){const line=el('div','business-history-entry');line.append(el('strong','',(h.by?.name||h.by?.email||'System')+' · '+new Date(h.at).toLocaleString('en-GB',{timeZone:'Asia/Jerusalem'})),el('div','',historyText(h)));history.append(line);}
      target.append(history);
    }catch(e){if(context().key===key){target.replaceChildren(el('h3','','Ticket work & client'));const msg=el('p','msg');message(msg,e);target.append(msg,button('Retry',()=>renderEditor(key)));}}
  }
  function dialog(title,onClose){const d=el('dialog','business-dialog'),head=el('div','business-dialog-head'),body=el('div'),msg=el('p','msg');head.append(el('h2','',title),button('Close',()=>onClose?onClose():d.close()));d.append(head,body,msg);document.body.append(d);d.addEventListener('close',()=>d.remove());d.showModal();return {d,body,msg};}
  async function bulk(keys){
    if(!enabled)throw new Error('Updated backend required.');const {d,body,msg}=dialog(odooOn?'Assign Odoo project to selected tickets':'Assign client to selected tickets');const selects=placement(body,{},{required:odooOn});
    if(odooOn)body.append(el('p','business-guidance','Work already logged on these tickets stays on its current project; only new work goes to the one chosen here.'));
    body.append(button('Apply to '+keys.length+' tickets',async e=>{const action=e.currentTarget;let fields;try{fields=selects.read();}catch(err){message(msg,err);return;}action.disabled=true;const failures=[];for(const key of keys){try{const r=await api('/ticket-metadata?key='+encodeURIComponent(key));await api('/ticket-metadata',{method:'PUT',body:{key,fields:{revision:r.metadata.revision,...fields}}});}catch(err){failures.push(key+': '+err.message);}}await onChange(keys);if(failures.length){msg.textContent=failures.join('\n');action.disabled=false;}else d.close();},'btn primary'));
  }
  async function ensureBilling(key){
    if(!admin()||!billingNeeded)return;
    if(editor?.key===key&&editor.dirty())throw new Error('Save the ticket work fields before changing assignments.');
    const current=await api('/ticket-metadata?key='+encodeURIComponent(key));
    if(['billable','not_billable'].includes(current.metadata.billing))return;
    if(current.closed)throw new Error('Reopen this ticket and choose billing before changing its assignment.');
    const choice=await new Promise(resolve=>{const {d,body,msg}=dialog('Billing required · '+key);let result=null;
      body.append(el('p','','Choose the billing classification before assigning this ticket. Only administrators can see it.'));
      const select=field(body,'Billing',el('select','fsel'));option(select,'Choose billing…','');option(select,'Billable','billable');option(select,'Not billable','not_billable');select.required=true;
      body.append(button('Save billing and continue',()=>{if(!select.value){msg.textContent='Choose Billable or Not billable.';select.focus();return;}result=select.value;d.close();},'btn primary'));
      d.addEventListener('close',()=>resolve(result));select.focus();});
    if(!choice)throw new Error('Assignment cancelled. Billing was not selected.');
    const saved=await api('/ticket-metadata',{method:'PUT',body:{key,fields:{revision:current.metadata.revision,billing:choice}}});records[key]=saved.metadata;
  }
  function overrideReason(error,key){
    if(!admin()||error.code!=='closure_required')return Promise.resolve(null);
    return new Promise(resolve=>{const {d,body,msg}=dialog('Administrator closure override · '+key);body.append(el('p','',error.message));const reason=field(body,'Reason (required)',el('textarea','inp'));reason.maxLength=1000;let result=null;body.append(button('Close with recorded override',()=>{if(!reason.value.trim()){msg.textContent='Enter an override reason.';return;}result=reason.value.trim();d.close();},'btn primary'));d.addEventListener('close',()=>resolve(result));reason.focus();});
  }
  function filters(parent,filter,onFilter){
    const client=el('select','fsel');client.setAttribute('aria-label','Filter by client');option(client,'All clients','');option(client,'Client not set','__none');for(const c of clients())option(client,c.name,c.id);client.value=filter.clientId||'';
    client.addEventListener('change',()=>{filter.clientId=client.value;filter.subClientId='';onFilter();});parent.append(client);
    // With Odoo: the Odoo project (archived ones included, so their tickets can be found); "not set" finds tickets to map.
    if(odooOn){const p=el('select','fsel');p.setAttribute('aria-label','Filter by Odoo project');option(p,'All Odoo projects','');option(p,'Odoo project not set','__none');
      for(const x of [...odooProjects].sort((a,b)=>a.label.localeCompare(b.label)))option(p,x.label+(x.archived?' (archived)':''),String(x.id));
      p.value=filter.odooProjectId||'';p.addEventListener('change',()=>{filter.odooProjectId=p.value;onFilter();});parent.append(p);}
    else{const sub=el('select','fsel');sub.setAttribute('aria-label','Filter by project');option(sub,'All projects','');for(const c of children(filter.clientId))option(sub,c.name,c.id);sub.value=filter.subClientId||'';sub.addEventListener('change',()=>{filter.subClientId=sub.value;onFilter();});parent.append(sub);}
    const missing=el('select','fsel');missing.setAttribute('aria-label','Missing business information');for(const [v,l]of [['','Any work information'],['estimatedHours','Missing estimate'],['actualHours','Missing actual hours'],['workDone','Missing work done']])option(missing,l,v);missing.value=filter.missing||'';missing.addEventListener('change',()=>{filter.missing=missing.value;onFilter();});parent.append(missing);
    if(admin()){const billing=el('select','fsel');billing.setAttribute('aria-label','Filter by billing');for(const [v,l]of [['','All billing'],['__none','Billing not set'],['billable','Billable'],['not_billable','Not billable']])option(billing,l,v);billing.value=filter.billing||'';billing.addEventListener('change',()=>{filter.billing=billing.value;onFilter();});parent.append(billing);}
  }
  function matches(i,f={}){return (!f.clientId||(f.clientId==='__none'?!i.clientId:i.clientId===f.clientId))&&(odooOn||!f.subClientId||i.subClientId===f.subClientId)&&(!odooOn||!f.odooProjectId||(f.odooProjectId==='__none'?i.odooProjectId==null:String(i.odooProjectId)===f.odooProjectId))&&(!f.missing||!i[f.missing])&&(!admin()||!f.billing||(f.billing==='__none'?!i.billing:i.billing===f.billing));}
  function renderReports(target){reportBrowser.render(target);}
  let catalogNote={text:'',at:0};
  // The Clients page. With Odoo and the projects table (administrators) it is the page below (renderClientsPage); without
  // them, the catalog page.
  function renderCatalog(target,note){
    if(enabled&&odooOn&&projectBudget&&admin())return renderClientsPage(target);
    const panel=el('section','panel business-panel');target.append(panel);panel.append(el('h2','','Clients & Projects'));
    if(!enabled){panel.append(el('p','msg err','The updated backend is required.'));return;}
    const msg=el('p','msg');
    if(odooOn){const sync=el('div','catalog-sync');sync.append(button('Sync from Odoo now',async e=>{const b=e.currentTarget;b.disabled=true;msg.className='msg';msg.textContent='Reading contacts and projects from Odoo…';try{const r=await api('/clients/odoo-sync?force=1',{method:'POST',body:{}});if(r.odoo===false){msg.textContent='Odoo is not connected.';return;}if(r.changed)await loadCatalog();else await loadProjects().catch(()=>{});const counts=(r.customers!=null?r.customers+' contacts, ':'')+r.projects+' projects',done=r.changed?r.added+' new from Odoo ('+counts+').':'Already up to date ('+counts+').';msg.textContent=done;if(r.changed){catalogNote={text:done,at:Date.now()};await onChange();await catalogChanged(target,done);}}catch(err){message(msg,err);}finally{b.disabled=false;}},'btn primary'));
      const create=(key,text,open)=>{const b=button(text,e=>open(e.currentTarget,target),'btn');b.dataset.create=key;return b;};sync.append(create('contact','+ Create contact',openContactDialog),create('project','+ Create project',openProjectDialog));panel.append(sync);}
    panel.append(msg);{const n=note||(Date.now()-catalogNote.at<15000?catalogNote.text:'');if(n)msg.textContent=n;}
    // Without Odoo a client or project is added here. With Odoo, contacts and projects are created in Odoo from their dialogs.
    if(!odooOn){
    const add=el('div','business-form'),name=field(add,'New client or project name',input('text','')),parent=field(add,'Parent (optional)',el('select','fsel'));option(parent,'Top-level client','');for(const c of clients())option(parent,c.name,c.id);add.append(button('Add',async()=>{try{catalog=await api('/clients',{method:'POST',body:{revision:catalog.revision,name:name.value,parentId:parent.value||null}});await onChange();target.replaceChildren();renderCatalog(target);}catch(err){message(msg,err);}}));panel.append(add);}
    if(projectAdmin&&admin())renderProjects(target);
    if(epicMapping&&admin())renderEpicMap(target);
  }
  // After a change made from the Clients page: the Odoo page refreshes its table and Map tickets count in place (parts picks
  // which); the page without Odoo is drawn again.
  async function catalogChanged(target,note,parts){
    if(clientsPage?.root.isConnected){if(note)clientsPage.say(note);await clientsPage.refresh(parts);return;}
    if(target?.isConnected&&!target.classList.contains('board-host')){target.replaceChildren();renderCatalog(target,note);}
  }
  // ---- Clients & Projects with Odoo (administrators) ----
  // A heading with the page's actions, a one-line sync status (the failure's details only when the last sync failed), and
  // the Odoo projects table. The page reads its data when it opens and again only after Sync from Odoo now or a change made
  // on it: nothing runs on a timer, and dashboard renders leave the page in place (data-keep, see workspace.js), so filters,
  // scroll position and open dialogs stay as they are. A change refreshes the table rows and the Map tickets count only.
  let clientsPage=null;
  const reads=new Map();
  // One request per path at a time. A caller while one runs waits for it, then shares one fresh request with everyone else
  // who asked meanwhile, so figures read after a change are never from before it. shared: the running answer will do.
  function readOnce(path,fresh=true){
    const cur=reads.get(path);
    if(cur){if(!fresh)return cur.p;return cur.next||=cur.p.catch(()=>{}).then(()=>{if(reads.get(path)===cur)reads.delete(path);return readOnce(path,false);});}
    const entry={p:api(path).finally(()=>{if(reads.get(path)===entry&&!entry.next)reads.delete(path);})};
    reads.set(path,entry);return entry.p;
  }
  const when=t=>t?new Date(t).toLocaleString('en-GB',{timeZone:'Asia/Jerusalem',dateStyle:'medium',timeStyle:'short'}):'never';
  function renderClientsPage(target){
    const root=el('section','panel business-panel clients-page');root.dataset.keep='clients';target.append(root);
    const head=el('div','clients-head'),actions=el('div','clients-actions'),sync=el('div','clients-sync'),msg=el('p','msg');msg.setAttribute('role','status');
    const say=(text,err)=>{msg.className=err?'msg err':'msg';msg.textContent=text||'';};
    const syncBtn=button('Sync from Odoo now',()=>syncNow(),'btn primary');
    const createBtn=button('+ Create project',e=>openProjectDialog(e.currentTarget,target),'btn');createBtn.dataset.create='project';
    const mapBtn=button('Map tickets',e=>openMapTickets({opener:e.currentTarget}),'btn');mapBtn.dataset.map='all';
    const more=moreMenu('More',[['Export CSV',()=>exportBudget(table.shown())],['Create contact',opener=>openContactDialog(opener,target)],
      ...(projectAdmin?[['Dashboard clients & projects',opener=>hostDialog('Dashboard clients & projects',opener,renderProjects)]]:[]),
      ...(epicMapping?[['Jira epics → Odoo projects',opener=>hostDialog('Jira epics → Odoo projects',opener,renderEpicMap)]]:[]),
      ['How figures are counted',opener=>figuresDialog(opener)]]);
    head.append(el('h2','','Clients & Projects'),actions);actions.append(syncBtn,createBtn,mapBtn,more);root.append(head,sync,msg);
    const table=projectsTable(root,{say,onMap:(p,opener)=>openMapTickets({opener,project:p})});
    let plan=null,syncing=false;
    function syncLine(){
      sync.replaceChildren();const s=syncState;if(!s)return;
      sync.append(el('span','clients-sync-ok','Synced from Odoo '+when(s.syncedAt)));
      if(s.error){const d=el('details','clients-sync-error');d.append(el('summary','','Last sync failed '+when(s.error.at)),el('p','',s.error.message),el('p','business-guidance','Check the Odoo connection in Settings, then press Sync from Odoo now.'));sync.append(d);}
    }
    const mapCount=()=>{mapBtn.textContent=plan?'Map tickets ('+plan.rows.length+')':'Map tickets';};
    async function refresh({projects=true,mapping=true}={}){
      await Promise.all([
        projects&&readOnce('/clients/odoo-projects').then(d=>{if(d.sync)syncState=d.sync;table.update(d);syncLine();}).catch(err=>table.failed(err)),
        mapping&&readOnce('/clients/needs-mapping').then(p=>{plan=p;mapCount();}).catch(()=>{})]);
    }
    // Sync from Odoo now: one at a time (the button waits, and the backend answers busy while another sync runs).
    async function syncNow(){
      if(syncing)return;syncing=true;syncBtn.disabled=true;syncBtn.textContent='Syncing…';say('Reading contacts and projects from Odoo…');
      try{
        const r=await api('/clients/odoo-sync?force=1',{method:'POST',body:{}});
        if(r.odoo===false){say('Odoo is not connected.',true);return;}
        if(r.busy){say('A sync from Odoo is already running. Try again in a minute.');return;}
        if(r.changed)await loadCatalog();else await loadProjects().catch(()=>{});
        await refresh();
        const counts=(r.customers!=null?r.customers+' contacts, ':'')+r.projects+' projects';
        say(r.changed?r.added+' new from Odoo ('+counts+').':'Up to date ('+counts+').');
        if(r.changed)await onChange();
      }catch(err){await loadProjects().catch(()=>{});syncLine();message(msg,err);}
      finally{syncing=false;syncBtn.disabled=false;syncBtn.textContent='Sync from Odoo now';}
    }
    clientsPage={root,refresh,say,table};
    syncLine();refresh();
  }
  // A small menu for secondary actions: a disclosure button and its list. A choice, Escape or a click elsewhere closes it;
  // each action gets the menu button back, so the dialog it opens can return focus there.
  function moreMenu(label,items){
    const box=el('details','clients-more'),sum=el('summary','btn',label),list=el('div','clients-more-list');box.append(sum,list);
    for(const [text,fn] of items)list.append(button(text,()=>{box.open=false;fn(sum);},'clients-more-item'));
    box.addEventListener('keydown',e=>{if(e.key==='Escape'&&box.open){e.preventDefault();e.stopPropagation();box.open=false;sum.focus();}});
    const outside=e=>{if(!box.isConnected){document.removeEventListener('click',outside);return;}if(box.open&&!box.contains(e.target))box.open=false;};
    document.addEventListener('click',outside);
    return box;
  }
  // A secondary panel (the clients board, the epic map) in a wide dialog; render(body) draws it there.
  function hostDialog(title,opener,render){
    const {d,body}=dialog(title);d.classList.add('business-dialog-wide');body.classList.add('board-host');
    d.addEventListener('close',()=>{if(opener?.isConnected)opener.focus();});render(body);
  }
  function figuresDialog(opener){
    const {d,body}=dialog('How figures are counted'),data=clientsPage?.table.data;d.addEventListener('close',()=>{if(opener?.isConnected)opener.focus();});
    for(const t of ['Every active project in Odoo is listed, including those with no tickets, newest first. Clients are Odoo’s Contacts › Companies with the All in One company selected; projects are each company’s Odoo projects.',
      'The page reads Odoo when it opens. Sync from Odoo now reads new contacts and projects; changes made here update their rows. Nothing refreshes on its own while the page is open.',
      'Logged hours are the Odoo timesheet hours on the project, counted once whether they came from the work log, agreed hours or Odoo itself. Work log time not in Odoo yet (waiting or failed) is shown in the project’s row details and not counted.',
      'Near limit: '+Math.round((data?.nearLimit??0.8)*100)+'% or more of the allocated hours logged. Allocated hours are saved on the Odoo project; empty means not set, which is not the same as 0.',
      ...(data?.unplacedPendingHours>0?[hours(data.unplacedPendingHours)+' of work log time is not in Odoo yet and has no Odoo project. See Work log setup.']:[]),
      'Map tickets gives an Odoo project to tickets saved before every ticket had one. The client comes from the project, Jira links stay as they are, and work already logged stays where it went.'])body.append(el('p','business-guidance',t));
  }
  // Create contact and Create project in Odoo, each in its own dialog. A failed save keeps what was typed and the dialog
  // stays open; Save is disabled while saving. Escape, Close and Cancel ask before unsaved values are discarded. A save that
  // works closes the dialog, refreshes the table and returns focus to the button that opened it.
  function createDialog({opener,target,key,title,noun,submitLabel,fields,save,done}){
    const {d,body,msg}=dialog(title,()=>requestClose());d.classList.add('catalog-dialog');
    d.setAttribute('aria-label',title);
    const form=el('form','business-form catalog-form'),actions=el('div','catalog-dialog-actions');form.noValidate=true;
    const submitBtn=el('button','btn primary',submitLabel);submitBtn.type='submit';
    const cancelBtn=button('Cancel',()=>requestClose());
    let saving=false,checked=false;
    const dirty=()=>fields.some(f=>f.dirty());
    // Checks every field and returns the first one with a problem, so that field can take focus.
    const check=()=>{let first=null;for(const f of fields){const t=f.check();f.control.setAttribute('aria-invalid',String(!!t));f.error.textContent=t;if(t&&!first)first=f;}return first;};
    const setBusy=on=>{submitBtn.disabled=on;cancelBtn.disabled=on;submitBtn.textContent=on?'Saving…':submitLabel;};
    function requestClose(){if(saving)return;if(dirty()&&!window.confirm('Discard this '+noun+'? Your changes will be lost.'))return;d.close();}
    d.addEventListener('cancel',e=>{e.preventDefault();requestClose();});
    d.addEventListener('close',()=>{if(opener.isConnected)opener.focus();});
    for(const f of fields){
      const l=el('label','business-field'),err=el('small','catalog-error');
      l.append(el('span','',f.label),f.node);f.node.setAttribute('aria-label',f.label);
      if(f.picker)f.focus=combobox(f.node).input;
      f.control=f.focus||f.node;f.error=err;err.id='catalog-err-'+Math.random().toString(36).slice(2,9);
      f.control.setAttribute('aria-describedby',err.id);if(f.required)f.control.setAttribute('aria-required','true');
      const wrap=el('div','catalog-field');wrap.append(l,err);form.append(wrap);
    }
    form.append(msg,actions);actions.append(submitBtn,cancelBtn);body.append(form);
    // Typing clears the last backend message; once Save has been pressed, a field's error follows its value.
    const clearError=()=>{if(saving)return;msg.className='msg';msg.textContent='';if(checked)check();};
    form.addEventListener('input',clearError);form.addEventListener('change',clearError);
    form.addEventListener('submit',async e=>{
      e.preventDefault();if(saving)return;
      checked=true;const first=check();
      if(first){first.control.focus();msg.className='msg err';msg.textContent='Fix the fields marked in red.';return;}
      saving=true;setBusy(true);msg.className='msg';msg.textContent='Saving to Odoo…';
      try{
        const r=await save();
        catalog=r.catalog;await loadProjects().catch(()=>{});
        const note=done();catalogNote={text:note,at:Date.now()};
        saving=false;d.close();
        await onChange();
        const kept=clientsPage?.root.isConnected;await catalogChanged(target,note);
        if(!kept)target.querySelector('[data-create="'+key+'"]')?.focus();
      }catch(err){message(msg,err);}
      finally{saving=false;setBusy(false);}
    });
    fields[0].control.focus();
  }
  function openContactDialog(opener,target){
    const name=input('text',''),email=input('email',''),phone=input('tel','');
    createDialog({opener,target,key:'contact',title:'Create contact',noun:'contact',submitLabel:'Create contact',
      fields:[
        {label:'Contact name',node:name,required:true,dirty:()=>name.value.trim()!=='',check:()=>name.value.trim()?'':'Enter the contact name.'},
        {label:'Email (optional)',node:email,dirty:()=>email.value.trim()!=='',check:()=>email.value.trim()&&!email.checkValidity()?'Enter an email address like name@example.com, or leave it empty.':''},
        {label:'Phone (optional)',node:phone,dirty:()=>phone.value.trim()!=='',check:()=>''}],
      save:()=>api('/clients/odoo/customer',{method:'POST',body:{name:name.value,email:email.value,phone:phone.value}}),
      done:()=>'Contact “'+name.value.trim()+'” created in Odoo.'});
  }
  // Allocated hours: zero or more, decimals allowed. An empty box means no allocation yet, which is not the same as zero.
  const DECIMAL_HOURS=/^(\d+\.?\d*|\.\d+)$/;
  function openProjectDialog(opener,target){
    const name=input('text',''),contact=el('select','fsel'),hours=input('number','');
    hours.min='0';hours.step='any';hours.inputMode='decimal';
    option(contact,'Choose contact…','');
    for(const c of clients().filter(c=>!NO_CLIENT.includes(c.name)).sort(byName))option(contact,c.name,c.id);
    createDialog({opener,target,key:'project',title:'Create project',noun:'project',submitLabel:'Create project',
      fields:[
        {label:'Project name',node:name,required:true,dirty:()=>name.value.trim()!=='',check:()=>name.value.trim()?'':'Enter the project name.'},
        {label:'Contact',node:contact,picker:true,required:true,dirty:()=>contact.value!=='',check:()=>contact.value?'':'Choose the contact this project belongs to.'},
        {label:'Allocated hours (optional)',node:hours,dirty:()=>hours.value.trim()!==''||hours.validity.badInput,check:()=>{const h=hours.value.trim();return hours.validity.badInput||(h!==''&&!DECIMAL_HOURS.test(h))?'Enter 0 or more hours, such as 40 or 12.5. Leave it empty if the hours are not known yet.':'';}}],
      save:()=>api('/clients/odoo/project',{method:'POST',body:{name:name.value,clientId:contact.value,allocatedHours:hours.value}}),
      done:()=>'Project “'+name.value.trim()+'” created in Odoo.'});
  }
  // Map tickets (administrators): tickets with no Odoo project get one from the table's own projects (active, with a
  // client), and the client follows the project. A ticket is suggested a project only when its catalog project links
  // exactly one of them (Ready); nothing is matched by name. Nothing is saved until Apply, and each ticket is sent with the
  // revision read when the dialog opened, so one changed since is skipped with the reason shown. A conflict (work already
  // logged in another Odoo project) is applied only on its own, after a confirm; Apply all ready never includes one.
  // Opened from a project's row, the project is fixed: tick the tickets to give it, then confirm. The page's refreshes never
  // touch the dialog's list or choices.
  const MAP_SHOWN=50,KIND_CLASS={ready:'mapped',missing:'unmapped',ambiguous:'unmapped',conflict:'conflict'};
  async function openMapTickets({opener,project=null}={}){
    if(document.querySelector('dialog.map-dialog'))return;
    const title=project?'Map tickets to '+project.name:'Map tickets';
    let busy=false,plan=null,choices=[],byId=new Map(),fixed=null,shownRows=[];
    const done=new Map(),why=new Map(),chosen=new Map(),picked=new Set(),view={kind:'',q:'',shown:MAP_SHOWN};
    const {d,body,msg}=dialog(title,()=>requestClose());d.classList.add('map-dialog','business-dialog-wide');d.setAttribute('aria-label',title);msg.setAttribute('role','status');
    d.addEventListener('cancel',e=>{e.preventDefault();requestClose();});
    d.addEventListener('close',()=>{if(opener?.isConnected)opener.focus();});
    const suggestionOf=r=>mappingSuggestion(r,choices).id;
    function requestClose(){
      if(busy)return;
      const unsaved=plan&&([...picked].some(k=>!done.has(k))||[...chosen].some(([k,v])=>!done.has(k)&&v&&v!==String(suggestionOf(plan.rows.find(r=>r.key===k))??'')));
      if(unsaved&&!window.confirm('Close Map tickets? The projects chosen and not applied will be lost.'))return;
      d.close();
    }
    msg.className='msg';msg.textContent='Checking tickets…';
    try{const [p,data]=await Promise.all([readOnce('/clients/needs-mapping',false),clientsPage?.table.data||readOnce('/clients/odoo-projects',false)]);plan=p;choices=assignableProjects(data.projects);}
    catch(err){message(msg,err);return;}
    if(!d.open)return;
    byId=new Map(choices.map(c=>[c.id,c]));fixed=project?byId.get(project.odooId)||null:null;
    if(project&&!fixed){msg.className='msg err';msg.textContent='Tickets cannot be given “'+project.name+'”: '+(project.blocked||'it is not in the last sync from Odoo.');return;}
    msg.textContent='';
    const tickets=context().tickets()||[],titles=Object.fromEntries(tickets.map(i=>[i.key,i.summary])),status=Object.fromEntries(tickets.map(i=>[i.key,i.status]));
    const intro=el('div','map-intro');
    if(fixed){const t=el('dl','map-target');t.append(el('dt','','Odoo project'),el('dd','',fixed.label),el('dt','','Client'),el('dd','',fixed.client||'—'));intro.append(t,el('p','business-guidance','Tick the tickets to give this project, then assign them. Tickets whose work went to another Odoo project are mapped on their own.'));}
    else intro.append(el('p','business-guidance','Choose each ticket’s Client → Project and press Apply. The client comes from the project; work already logged stays where it went.'));
    const bar=el('div','map-bar'),kinds=el('div','map-kinds'),search=input('search','');search.placeholder='Search key, title, client or project';search.setAttribute('aria-label','Search tickets to map');
    const kindBtn={};for(const [k,l] of [['','All'],...Object.entries(MAPPING_KINDS)]){const b=button(l,()=>{view.kind=k;view.shown=MAP_SHOWN;draw();},'board-chip map-kind'+(k?' '+k:''));b.dataset.kind=k||'all';kindBtn[k]=[b,l];kinds.append(b);}
    const bulkBtn=button('',()=>fixed?assignPicked():applyReady(),'btn primary');bulkBtn.dataset.bulk='1';
    const tools=el('div','map-tools');tools.append(search);
    if(fixed)tools.append(button('Select all shown',()=>{for(const r of shownRows)if(r.kind!=='conflict'&&!done.has(r.key))picked.add(r.key);draw();},'btn'));
    tools.append(bulkBtn);bar.append(kinds,tools);
    const list=el('div','map-list'),more=el('div','map-more');body.append(intro,bar,list,more);
    search.addEventListener('input',()=>{view.q=search.value;view.shown=MAP_SHOWN;draw();});
    function bulkLabel(){
      if(fixed){const n=[...picked].filter(k=>!done.has(k)).length;bulkBtn.textContent='Assign '+count2(n,'ticket')+' to '+fixed.label;bulkBtn.disabled=busy||!n;}
      else{const n=readyRows().length;bulkBtn.textContent='Apply all ready ('+n+')';bulkBtn.disabled=busy||!n;}
    }
    const readyRows=()=>plan.rows.filter(r=>r.kind==='ready'&&!done.has(r.key)&&byId.has(r.odooProjectId));
    function draw(){
      const c=mappingCounts(plan.rows,new Set(done.keys()));
      for(const [k,[b,l]] of Object.entries(kindBtn)){b.textContent=l+' '+c[k||'all'];b.setAttribute('aria-pressed',String(view.kind===k));}
      shownRows=mappingRows(plan.rows,{kind:view.kind,q:view.q,titles,project:fixed?.id??null});
      list.replaceChildren(...shownRows.slice(0,view.shown).map(row));
      if(!shownRows.length)list.append(el('p','business-guidance',plan.rows.length?'No tickets match.':'Every ticket has an Odoo project.'));
      more.replaceChildren();if(shownRows.length>view.shown)more.append(button('Show more ('+(shownRows.length-view.shown)+' more)',()=>{view.shown+=MAP_SHOWN;draw();},'btn'));
      bulkLabel();
    }
    function row(r){
      const item=el('div','map-row'+(done.has(r.key)?' done':'')),info=el('div','map-ticket'),pick=el('div','map-pick'),result=el('p','map-result');item.dataset.key=r.key;
      const line=el('div','map-key');line.append(el('strong','',r.key),el('span','project-status '+KIND_CLASS[r.kind],MAPPING_KINDS[r.kind]),el('span','map-status',status[r.key]||(r.closed?'Closed':'Open')));
      const t=el('span','map-title',titles[r.key]||'');t.dir='auto';
      info.append(line,t,el('span','map-why',([r.client,r.project].filter(Boolean).length?'Saved as '+[r.client,r.project].filter(Boolean).join(' / ')+'. ':'')+r.message));
      if(done.has(r.key)){result.className='map-result ok';result.textContent='✓ Linked to '+done.get(r.key)+'.';item.append(info,result);return item;}
      if(why.has(r.key)){result.className='map-result err';result.textContent='Skipped: '+why.get(r.key);}
      if(fixed){
        const ck=el('input');ck.type='checkbox';ck.checked=picked.has(r.key);ck.setAttribute('aria-label','Give '+r.key+' '+fixed.label);
        if(r.kind==='conflict'){ck.disabled=true;ck.title='Its work went to another Odoo project: map it on its own.';}
        else ck.addEventListener('change',()=>{if(ck.checked)picked.add(r.key);else picked.delete(r.key);bulkLabel();});
        item.classList.add('map-row-check');pick.append(ck);item.append(pick,info,result);return item;
      }
      const sug=mappingSuggestion(r,choices),first=[...(sug.id!=null?[sug.id]:[]),...sug.linked],sel=el('select','fsel');
      option(sel,'Choose Client → Project…','');
      for(const id of first)option(sel,byId.get(id).label+(id===sug.id?' · suggested':' · linked from its project'),String(id));
      for(const c of choices)if(!first.includes(c.id))option(sel,c.label,String(c.id));
      sel.value=chosen.has(r.key)?chosen.get(r.key):sug.id!=null?String(sug.id):'';
      pick.append(sel);combobox(sel).input.setAttribute('aria-label','Odoo project for '+r.key);
      const apply=button('Apply',()=>applyOne(r,sel.value),'btn primary');apply.disabled=!sel.value;apply.setAttribute('aria-label','Apply the project to '+r.key);
      sel.addEventListener('change',()=>{chosen.set(r.key,sel.value);apply.disabled=!sel.value;});
      pick.append(apply);item.append(info,pick,result);return item;
    }
    async function applyOne(r,value){
      if(!value||busy)return;const id=Number(value),p=byId.get(id);
      if(r.kind==='conflict'&&!window.confirm(r.key+': '+r.message+'\n\nGive it '+p.label+' (client: '+(p.client||'—')+')? Work already logged stays where it went; only new work goes to this project.'))return;
      const suggested=r.kind==='ready'&&r.odooProjectId===id;
      await send([{key:r.key,revision:r.revision,...(suggested?{}:{odooProjectId:id}),...(r.kind==='conflict'?{resolveConflict:true}:{})}]);
    }
    async function applyReady(){
      const ready=readyRows();if(!ready.length||busy)return;
      if(!window.confirm('Link '+count2(ready.length,'ready ticket')+' to the Odoo project their project already links? Tickets changed since this list opened are skipped.'))return;
      await send(ready.map(r=>({key:r.key,revision:r.revision})));
    }
    async function assignPicked(){
      const rev=new Map(plan.rows.map(r=>[r.key,r.revision])),keys=[...picked].filter(k=>!done.has(k));if(!keys.length||busy)return;
      if(!window.confirm('Give '+count2(keys.length,'ticket')+' the Odoo project '+fixed.label+' (client: '+(fixed.client||'—')+')?\n\nTickets that got a project or changed since this list opened are skipped. Work already logged stays where it went.'))return;
      await send(keys.map(key=>({key,revision:rev.get(key),odooProjectId:fixed.id})));
    }
    // One request at a time; the dialog stays open and shows what was linked and why anything was skipped.
    async function send(items){
      busy=true;bulkLabel();d.setAttribute('aria-busy','true');msg.className='msg';msg.textContent='Saving…';
      try{
        const r=await api('/clients/needs-mapping/apply',{method:'POST',body:{items}});
        for(const l of r.linked){done.set(l.key,l.label);why.delete(l.key);picked.delete(l.key);chosen.delete(l.key);}
        for(const s of r.skipped)why.set(s.key,s.message);
        msg.className=r.skipped.length?'msg err':'msg';
        msg.textContent=count2(r.applied,'ticket')+' linked.'+(r.skipped.length?' '+count2(r.skipped.length,'ticket')+' skipped: the reason is under each one.':'');
        busy=false;draw();
        const keys=r.linked.map(l=>l.key);
        if(keys.length){if(Object.keys(records).length)await load(keys).catch(()=>{});await onChange(keys);clientsPage?.refresh();}
      }catch(err){message(msg,err);}
      finally{busy=false;d.removeAttribute('aria-busy');bulkLabel();}
    }
    draw();search.focus();
  }
  // The Odoo projects table (administrators, project-budget-v1): every active Odoo project with its allocated and logged
  // hours. Logged hours are Odoo's timesheet lines on the project, so each hour counts once; work not in Odoo yet is shown
  // in the row details and not added. Search and the client filter stay in view; the other filters and the sort are behind
  // Filters. update(data) redraws the rows in place, keeping filters, open rows, focus and scroll; while an allocation is
  // being edited the redraw waits until it closes. Filters, sorting and the CSV rows are in models/odoo-projects.js.
  const BUDGET_PAGE=25;
  let budgetView={...DEFAULT_VIEW};
  const dateText=d=>d?new Date(d.length===10?d+'T00:00:00':d).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'—';
  const COLS=[['name','Project'],['client','Client'],['allocated','Allocated'],['logged','Logged'],['remaining','Remaining'],['status','Budget status'],['open','Open tickets'],[null,'Actions']];
  const SORT_LABEL={created:'Created',name:'Project',client:'Client',allocated:'Allocated',logged:'Logged',remaining:'Remaining',used:'Budget used',status:'Budget status',open:'Open tickets',review:'Needs PR review',lastWork:'Last work log'};
  const sortDir=(k,dir)=>k==='created'||k==='lastWork'?(dir<0?'newest first':'oldest first'):k==='name'||k==='client'?(dir>0?'A–Z':'Z–A'):(dir>0?'ascending':'descending');
  function projectsTable(root,{say,onMap}){
    const box=el('div','odoo-projects'),bar=el('div','budget-bar'),filters=el('div','budget-filters'),info=el('span','budget-scope'),warn=el('div'),msg=el('p','msg','Loading projects from Odoo…');
    filters.id='budget-filters';filters.hidden=true;
    const search=input('search',budgetView.q);search.placeholder='Search projects or clients';search.setAttribute('aria-label','Search Odoo projects by project or client');
    const pick=(label,options)=>{const s=el('select','fsel');s.setAttribute('aria-label',label);for(const [v,l] of options)option(s,l,v);return s;};
    const clientSel=pick('Filter by client',[]);
    const statusSel=pick('Filter by budget status',[['','All budget statuses'],...Object.entries(BUDGET_LABEL),['unmapped','Not linked']]);
    const missingSel=pick('Filter by missing client',[['','With or without a client'],['missing','Missing client'],['present','Has a client']]);
    const ticketSel=pick('Filter by linked tickets',[['','With or without tickets'],['with','With linked tickets'],['without','Without linked tickets']]);
    const sortSel=pick('Sort projects',Object.entries(SORT_LABEL).flatMap(([k,l])=>[-1,1].map(dir=>[k+':'+dir,l+', '+sortDir(k,dir)])));
    const filtersBtn=button('Filters',()=>{filters.hidden=!filters.hidden;filtersBtn.setAttribute('aria-expanded',String(!filters.hidden));},'btn');filtersBtn.setAttribute('aria-controls',filters.id);filtersBtn.setAttribute('aria-expanded','false');
    // A new search or filter starts again from the first page; the chosen sort stays.
    for(const [s,key] of [[clientSel,'client'],[statusSel,'status'],[missingSel,'missingClient'],[ticketSel,'tickets']])s.addEventListener('change',()=>{budgetView[key]=s.value;budgetView.page=0;draw();});
    sortSel.addEventListener('change',()=>{const [k,dir]=sortSel.value.split(':');budgetView.sort=k;budgetView.dir=Number(dir);budgetView.page=0;draw();});
    search.addEventListener('input',()=>{budgetView.q=search.value;budgetView.page=0;draw();});
    const labelled=(text,node)=>{const l=el('label','business-field');l.append(el('span','',text),node);return l;};
    filters.append(labelled('Budget status',statusSel),labelled('Client in Odoo',missingSel),labelled('Tickets',ticketSel),labelled('Sort',sortSel),
      button('Clear filters',()=>{Object.assign(budgetView,{status:'',missingClient:'',tickets:'',sort:DEFAULT_VIEW.sort,dir:DEFAULT_VIEW.dir,page:0});draw();},'linkbtn'));
    bar.append(search,clientSel,filtersBtn,info);
    const wrap=el('div','table-wrap'),table=el('table','budget-table'),head=el('thead'),body=el('tbody'),foot=el('tfoot'),pager=el('div','budget-pager');table.append(head,body,foot);wrap.append(table);
    box.append(bar,filters,warn,msg,wrap,pager);root.append(box);
    let data=null,pending=false;
    const rows=()=>data?data.projects:[],shown=()=>budgetRows(rows(),budgetView),count=(s,n)=>n+' '+s+(n===1?'':'s');
    const ctx={data:()=>data,say,onMap,closed:()=>{if(pending){pending=false;draw();}}};
    // The controls follow the view (after Clear filters, or a header click changing the sort).
    function controls(){statusSel.value=budgetView.status;missingSel.value=budgetView.missingClient;ticketSel.value=budgetView.tickets;sortSel.value=budgetView.sort+':'+budgetView.dir;clientSel.value=budgetView.client||'';
      const n=hiddenFilterCount(budgetView);filtersBtn.textContent=n?'Filters ('+n+')':'Filters';}
    function clientOptions(){const v=budgetView.client,names=[...new Set(rows().map(p=>p.client).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
      clientSel.replaceChildren(new Option('All clients',''),...names.map(c=>new Option(c,c)),new Option('No client','__none'));if(v&&v!=='__none'&&!names.includes(v))clientSel.append(new Option(v,v));}
    function draw(){
      controls();
      const tr=el('tr');for(const [k,l] of COLS){const th=el('th');th.scope='col';if(!k){th.textContent=l;tr.append(th);continue;}
        const b=button(l+(budgetView.sort===k?(budgetView.dir>0?' ▲':' ▼'):''),()=>{budgetView.dir=budgetView.sort===k?-budgetView.dir:1;budgetView.sort=k;budgetView.page=0;draw();},'th-sort');th.setAttribute('aria-sort',budgetView.sort===k?(budgetView.dir>0?'ascending':'descending'):'none');th.append(b);tr.append(th);}
      head.replaceChildren(tr);
      if(!data)return;
      // Paging works on the whole sorted list; the totals and the Export CSV cover every matching project, not one page.
      const all=rows(),list=shown(),pages=Math.max(1,Math.ceil(list.length/BUDGET_PAGE));budgetView.page=Math.min(budgetView.page,pages-1);
      const from=budgetView.page*BUDGET_PAGE,pageRows=list.slice(from,from+BUDGET_PAGE);
      body.replaceChildren(...pageRows.flatMap(p=>budgetRow(p,ctx)));
      if(!list.length){const r=el('tr'),td=el('td','business-guidance','No Odoo projects match.');td.colSpan=COLS.length;r.append(td);body.append(r);}
      const c=budgetCounts(list);
      info.textContent=(list.length===all.length?count('project',all.length):list.length+' of '+count('project',all.length))+(c.over?' · '+c.over+' over budget':'')+(c.near?' · '+c.near+' near limit':'');
      pager.replaceChildren();
      if(list.length>BUDGET_PAGE){
        const prev=button('← Previous',()=>{budgetView.page--;draw();},'btn'),next=button('Next →',()=>{budgetView.page++;draw();},'btn');
        prev.disabled=budgetView.page===0;next.disabled=budgetView.page>=pages-1;
        pager.append(el('span','',(from+1)+'–'+(from+pageRows.length)+' of '+count('project',list.length)),prev,next);
      }
      const sum=f=>list.reduce((s,p)=>s+(f(p)||0),0),total=el('tr');
      total.append(el('th','',list.length===all.length?'Total':'Total ('+count('project',list.length)+' shown)'),el('td'),el('td','num',hours(sum(p=>p.allocatedHours))),el('td','num',hours(sum(p=>p.loggedHours))),el('td','num',signedHours(sum(p=>p.remainingHours))),el('td','',c.over+' over'),el('td','num',String(sum(p=>p.openTickets))),el('td'));
      total.firstChild.scope='row';foot.replaceChildren(total);
    }
    function update(next){
      const open=new Set(rows().filter(p=>p._open).map(p=>p.odooId));for(const p of next.projects)if(open.has(p.odooId))p._open=true;
      data=next;msg.textContent='';
      warn.replaceChildren(...(data.allocation?[]:[el('p','msg err','This Odoo has no allocated hours on projects. Turn on Timesheets in Odoo to set them.')]));
      clientOptions();if(body.querySelector('.budget-edit'))pending=true;else draw();
    }
    function failed(err){if(!data)message(msg,err);else say('Couldn’t refresh the projects from Odoo: '+(err.message||err),true);}
    draw();
    return {update,failed,shown,get data(){return data;}};
  }
  // One project: its main row, and a second row (the ▸ button) with the rest: created, budget used, pull requests waiting
  // for review, the last work log, time not in Odoo yet, the company and Odoo id, and what links it to Jira.
  function budgetRow(p,ctx){
    const data=ctx.data(),tr=el('tr','budget-main budget-'+p.status),detail=el('tr','budget-detail'),detailId='budget-detail-'+p.odooId;tr.dataset.odooId=p.odooId;detail.id=detailId;detail.hidden=!p._open;
    const name=el('td','budget-name'),toggle=button(p._open?'▾':'▸',()=>{p._open=!p._open;detail.hidden=!p._open;toggle.textContent=p._open?'▾':'▸';toggle.setAttribute('aria-expanded',String(!!p._open));},'budget-toggle');
    toggle.setAttribute('aria-expanded',String(!!p._open));toggle.setAttribute('aria-controls',detailId);toggle.setAttribute('aria-label','More about '+p.name);
    const open=button(p.name,()=>openProjectDetails(p.odooId,open),'linkbtn');open.dir='auto';name.append(toggle,open);
    const client=el('td');if(p.client)client.textContent=p.client;else client.append(el('span','project-status unmapped','No client'));
    const alloc=el('td','num');allocationCell(alloc,p);
    const remaining=el('td','num'+(p.remainingHours<0?' over':''),p.remainingHours==null?'—':signedHours(p.remainingHours));
    const status=el('td');status.append(el('span','budget-status '+p.status,budgetText(p)));
    const actions=el('td','budget-actions');
    if(data.allocation){const edit=button(p.allocatedHours==null?'Set allocation':'Edit allocation',()=>editAllocation(alloc,p,ctx),'btn budget-edit-btn');edit.setAttribute('aria-label',edit.textContent+' for '+p.name);actions.append(edit);}
    const map=button('Map tickets',e=>ctx.onMap(p,e.currentTarget),'btn budget-map-btn');map.setAttribute('aria-label','Map tickets to '+p.name);
    if(!p.assignable){map.disabled=true;map.title=(p.blocked||'Not in the last sync from Odoo.')+' Tickets cannot be given this project.';}
    actions.append(map);
    tr.append(name,client,alloc,el('td','num',hours(p.loggedHours)),remaining,status,el('td','num',String(p.openTickets||0)),actions);
    const cell=el('td','budget-links');cell.colSpan=COLS.length;detail.append(cell);
    const facts=el('dl','budget-facts');
    for(const [k,v] of [['Created',dateText(p.createdAt)],['Budget used',percent(p.usedPercent)],['Needs PR review',String(p.reviewTickets||0)+(p.reviewKeys?.length?' ('+p.reviewKeys.join(', ')+')':'')],['Last work log',dateText(p.lastWorkDate)],
      ...(p.pendingHours>0?[['Not in Odoo yet',hours(p.pendingHours)]]:[]),...(p.company?[['Company',p.company]]:[]),['Odoo ID','#'+p.odooId],...(p.ticketCount?[['Dashboard tickets',String(p.ticketCount)]]:[])])facts.append(el('dt','',k),el('dd','',v));
    cell.append(facts);
    if(p.blocked)cell.append(el('p','budget-sub',p.blocked+' Tickets cannot be given this project until it is fixed in Odoo and synced.'));
    const links=el('div','budget-link-row');links.append(el('span','budget-sub','Linked to Jira:'));
    if(!p.mapped)links.append(el('span','project-status unmapped','Not linked'));
    for(const l of p.links.projects){const tag=el('span','budget-link',l.name);tag.dir='auto';tag.append(button('×',()=>linkProject(p,l.id,true,ctx),'budget-unlink'));tag.lastChild.setAttribute('aria-label','Unlink '+l.name+' from '+p.name);links.append(tag);}
    for(const k of p.links.epics)links.append(el('span','budget-link','Epic '+k));
    if(p.links.helpdesk)links.append(el('span','budget-link','Helpdesk'));
    if(p.linkable)links.append(linkControl(p,ctx));else links.append(el('span','budget-sub','Other Odoo company: link in Odoo'));
    cell.append(links);
    const t=p.links.tickets;if(t.count){const d=el('details','budget-tickets'),s=el('summary','','Odoo tasks: '+Object.entries(t.byProject).map(([k,n])=>k+': '+n).join(' · ')+(t.count===1?' ticket':' tickets'));d.append(s,el('p','budget-keys',t.keys.join(', ')+(t.count>t.keys.length?' …':'')));cell.append(d);}
    const more=el('div','budget-detail-actions'),odooLink=el('a','btn','Open in Odoo');odooLink.href=p.url;odooLink.target='_blank';odooLink.rel='noopener';odooLink.setAttribute('aria-label','Open '+p.name+' in Odoo');
    const hist=button('Tickets, work logs & history',()=>openProjectDetails(p.odooId,hist),'btn');more.append(odooLink,hist);cell.append(more);
    return [tr,detail];
  }
  const count2=(n,s)=>n+' '+s+(n===1?'':'s');
  function allocationCell(cell,p){cell.replaceChildren(p.allocatedHours==null?el('span','budget-unset','Not set'):document.createTextNode(hours(p.allocatedHours)));}
  // Edit allocation (from the row's Actions): saved on the Odoo project, kept in the project's history. Empty clears it.
  // Only this row is redrawn.
  function editAllocation(cell,p,ctx){
    if(cell.querySelector('.budget-edit')){cell.querySelector('input').focus();return;}
    const data=ctx.data(),box=el('div','budget-edit'),n=input('number',p.allocatedHours??'');n.min='0';n.step='any';n.setAttribute('aria-label','Allocated hours for '+p.name);
    const redraw=()=>{const tr=cell.closest('tr'),[a,b]=budgetRow(p,ctx);tr.nextElementSibling?.replaceWith(b);tr.replaceWith(a);a.querySelector('.budget-edit-btn')?.focus();};
    const cancel=()=>{allocationCell(cell,p);ctx.closed();};
    const save=async()=>{if(save.btn.disabled)return;if(n.value!==''&&!(Number(n.value)>=0)){ctx.say('Enter 0 or more hours, or leave it empty for not set.',true);return;}
      save.btn.disabled=true;ctx.say('Saving allocated hours to Odoo…');
      try{const r=await api('/clients/odoo-projects/allocation',{method:'PUT',body:{odooId:p.odooId,hours:n.value===''?null:Number(n.value)}});
        Object.assign(p,{allocatedHours:r.allocatedHours},budgetStatus(r.allocatedHours,p.loggedHours,data.nearLimit));ctx.say('Saved for “'+p.name+'”.');redraw();ctx.closed();}
      catch(err){ctx.say(err.message||String(err),true);save.btn.disabled=false;}};
    save.btn=button('Save',save,'btn primary');
    n.addEventListener('keydown',e=>{if(e.key==='Enter')save();else if(e.key==='Escape'){e.stopPropagation();cancel();}});
    box.append(n,save.btn,button('Cancel',cancel,'btn'));cell.append(box);n.focus();
  }
  // Project details: the budget, its tickets, pull requests waiting for review, the latest Odoo timesheet lines and history.
  const PROJECT_EVENT={created:h=>'Created from the dashboard'+(h.allocatedHours!=null?' with '+hours(h.allocatedHours)+' allocated':''),allocation:h=>'Allocated hours: '+(h.from==null?'Not set':hours(h.from))+' → '+(h.to==null?'Not set':hours(h.to))};
  async function openProjectDetails(id,opener){
    const {d,body,msg}=dialog('Odoo project');d.classList.add('project-details');d.addEventListener('close',()=>{if(opener?.isConnected)opener.focus();});
    msg.className='msg';msg.textContent='Loading from Odoo…';
    let r;try{r=await api('/clients/odoo-projects/details?id='+id);}catch(err){message(msg,err);return;}
    msg.textContent='';const p=r.project;d.querySelector('h2').textContent=p.name;
    const head=el('div','project-details-head');head.append(el('p','business-guidance',[p.client||'No client',p.company,'Odoo #'+p.odooId,'Created '+dateText(p.createdAt)].filter(Boolean).join(' · ')));
    if(p.archived)head.append(el('span','project-status archived','Archived in Odoo'));if(p.missingClient)head.append(el('span','project-status unmapped','No client'));
    const link=el('a','btn','Open in Odoo');link.href=p.url;link.target='_blank';link.rel='noopener';head.append(link);body.append(head);
    const facts=el('dl','project-budget-summary');
    for(const [k,v] of [['Allocated',p.allocatedHours==null?'Allocation not set':hours(p.allocatedHours)],['Logged in Odoo',hours(p.loggedHours)],['Remaining',p.remainingHours==null?'—':signedHours(p.remainingHours)],['Budget used',percent(p.usedPercent)],['Status',budgetText(p)],['Last work log',dateText(p.lastWorkDate)],...(p.pendingHours>0?[['Not in Odoo yet',hours(p.pendingHours)]]:[])])facts.append(el('dt','',k),el('dd','',v));
    body.append(el('h3','','Budget'),facts,el('p','business-guidance','Near limit from '+Math.round(r.nearLimit*100)+'% of the allocated hours. Time not in Odoo yet is shown apart and not counted.'));
    body.append(el('h3','','Tickets ('+r.tickets.length+')'));
    if(!r.tickets.length)body.append(el('p','business-guidance','No dashboard ticket has this Odoo project.'));
    else{const ul=el('ul','project-ticket-list');for(const t of r.tickets){const li=el('li');li.append(button(t.key,()=>{d.close();openIssue(t.key);},'linkbtn'),el('span','budget-sub',t.open?'Open':'Closed '+dateText(t.completedAt)));if(t.prs.length)li.append(el('span','project-status unmapped',count2(t.prs.length,'pull request')+' awaiting review'));ul.append(li);}body.append(ul);}
    body.append(el('h3','','Pull requests awaiting review'));
    if(!r.reviews.length)body.append(el('p','business-guidance','None. (Needs GitHub connected in Settings.)'));
    else{const ul=el('ul','project-ticket-list');for(const t of r.reviews)for(const pr of t.prs){const li=el('li'),a=el('a','','#'+pr.number+' '+pr.title);a.href=pr.url;a.target='_blank';a.rel='noopener';a.dir='auto';li.append(el('strong','',t.key+' '),a,el('span','budget-sub',pr.state==='changes_requested'?'Changes requested':'Waiting for review'));ul.append(li);}body.append(ul);}
    const w=r.workLogs;body.append(el('h3','','Work logs'+(w.total!=null?' ('+w.total+' in Odoo'+(w.total>w.lines.length?', latest '+w.lines.length+' shown':'')+')':'')));
    if(!w.lines.length)body.append(el('p','business-guidance','No timesheet lines in Odoo yet.'));
    else{const wrap=el('div','table-wrap'),table=el('table','budget-table'),tb=el('tbody'),hr=el('tr');for(const h of ['Date','Person','Task','Description','Hours']){const th=el('th','',h);th.scope='col';hr.append(th);}table.append(el('thead'),tb);table.tHead.append(hr);
      for(const l of w.lines){const tr=el('tr');tr.append(el('td','',l.date),el('td','',l.person),el('td','',l.task),el('td','',l.description),el('td','num',hours(l.hours)));tb.append(tr);}wrap.append(table);body.append(wrap);}
    body.append(el('h3','','History'));
    if(!r.history.length)body.append(el('p','business-guidance','No changes made from the dashboard.'));
    for(const h of [...r.history].reverse()){const line=el('div','business-history-entry');line.append(el('strong','',(h.by?.name||h.by?.email||'System')+' · '+new Date(h.at).toLocaleString('en-GB',{timeZone:'Asia/Jerusalem'})),el('div','',(PROJECT_EVENT[h.type]||(()=>h.type))(h)));body.append(line);}
  }
  // Link a dashboard project (the client and project on Jira tickets) to this Odoo project.
  function linkControl(p,ctx){
    return button('Link project',ev=>{
      const free=projects().filter(x=>!(catalog.entries.find(e=>e.id===x.id)?.sources||[]).some(s=>s.source==='odoo'));
      const box=el('div','budget-edit'),pick=el('select','fsel');pick.setAttribute('aria-label','Dashboard project to link to '+p.name);
      option(pick,free.length?'Choose project…':'No unlinked project','');for(const x of free)option(pick,x.name,x.id);
      box.append(pick,button('Link',()=>{if(pick.value)linkProject(p,pick.value,false,ctx);},'btn primary'),button('Cancel',()=>{box.replaceWith(linkControl(p,ctx));ctx.closed();},'btn'));
      ev.currentTarget.replaceWith(box);combobox(pick);box.querySelector('input')?.focus();
    },'btn budget-link-btn');
  }
  async function linkProject(p,entryId,unlink,ctx){
    const name=projects().find(x=>x.id===entryId)?.name||'the project';
    if(unlink&&!confirm('Unlink '+name+' from the Odoo project “'+p.name+'”? Work logged on its tickets will need another Odoo project.'))return;
    ctx.say(unlink?'Unlinking…':'Linking…');
    try{catalog=await api('/clients/odoo-projects/link',{method:'POST',body:{revision:catalog.revision,odooId:p.odooId,entryId,unlink}});
      const note=(unlink?'Unlinked ':'Linked ')+name+(unlink?' from ':' to ')+'“'+p.name+'”.';
      // The link's box is gone once saved, so the table may redraw.
      document.querySelectorAll('.budget-links .budget-edit').forEach(b=>b.remove());
      await onChange();await catalogChanged(null,note);}
    catch(err){if(err.code==='conflict')await loadCatalog();ctx.say(err.message||String(err),true);}
  }
  function exportBudget(list){
    // Text that a spreadsheet would run as a formula gets a leading quote; numbers (negative remaining hours) stay numbers.
    const cell=v=>{const s=String(v??''),formula=typeof v==='string'&&/^[=+\-@]/.test(s);return /[",\n\r]/.test(s)||formula?'"'+(formula?"'":'')+s.replace(/"/g,'""')+'"':s;};
    const lines=budgetCsvRows(list);
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['﻿'+lines.map(r=>r.map(cell).join(',')).join('\r\n')],{type:'text/csv'}));a.download='odoo-projects-'+new Date().toISOString().slice(0,10)+'.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }
  // Jira epics → Odoo projects (epic-map.js): tickets under a mapped epic take that project as their client.
  const projects=()=>catalog.entries.filter(e=>!e.archived&&(e.parentId||!catalog.entries.some(c=>c.parentId===e.id)))
    .map(e=>({id:e.id,name:e.parentId?(catalog.entries.find(c=>c.id===e.parentId)?.name||'')+' / '+e.name:e.name})).sort((a,b)=>a.name.localeCompare(b.name));
  // Clients & projects (administrators, project-admin-v1). Work starts from what is not in Odoo: each project there gets
  // an Odoo project (added here, or mapped to one that already exists), then every client lists its projects.
  const STATUS_LABEL={mapped:'In Odoo',unmapped:'Not in Odoo',conflict:'Conflict',archived:'Archived'};
  const NO_CLIENT=['No contact','No customer'];
  const inOdooContact=c=>(c.sources||[]).some(s=>s.source==='odoo-customer');
  const inOdooProject=p=>(p.sources||[]).some(s=>s.source==='odoo');
  const byName=(a,b)=>a.name.localeCompare(b.name);
  // Shared with the client report: add a client, or a project under a client that is already in Odoo.
  async function addContactToOdoo(name){const r=await api('/clients/odoo/customer',{method:'POST',body:{name,email:'',phone:''}});catalog=r.catalog;await onChange();return r;}
  async function addProjectToOdoo(name,clientId){const r=await api('/clients/odoo/project',{method:'POST',body:{name,clientId}});catalog=r.catalog;await onChange();return r;}
  async function renderProjects(target){
    const panel=el('section','panel business-panel clients-board');target.append(panel);panel.append(el('h2','','Clients & projects'));
    const msg=el('p','msg','Loading…');panel.append(msg);
    let data;try{data=await api('/clients/projects');}catch(err){message(msg,err);return;}
    msg.textContent='';
    const live=data.projects.filter(p=>!p.archived),queue=live.filter(p=>p.unmapped),conflicted=data.projects.filter(p=>p.conflicts.length).length;
    const summary=el('div','board-summary');
    summary.append(el('span','board-chip',live.length+(live.length===1?' project':' projects')),el('span','board-chip'+(queue.length?' needs':''),queue.length+' not in Odoo'),el('span','board-chip'+(conflicted?' conflict':''),conflicted+(conflicted===1?' conflict':' conflicts')));
    const queueBox=el('div','board-queue');
    queueBox.append(el('h3','',queue.length?'Not in Odoo yet':'Every project is in Odoo'));
    if(queue.length)queueBox.append(el('p','business-guidance','These projects have no Odoo project. Add one to Odoo under its client, or map it to an Odoo project that already exists with the same name. A client must be in Odoo before its projects can be added.'));
    for(const p of queue)queueBox.append(projectRow(p,target,msg));
    panel.append(summary,queueBox);
    // Every client with its projects; the filter narrows both the clients and the projects shown.
    const filter=el('select','fsel');filter.setAttribute('aria-label','Filter clients and projects');
    for(const [v,l] of [['','All clients and projects'],['unmapped','Not in Odoo'],['conflict','Conflicts'],['archived','Archived']])option(filter,l,v);
    const byClient=el('div','board-clients');
    const shown=p=>!filter.value||(filter.value==='unmapped'?p.unmapped&&!p.archived:filter.value==='conflict'?p.conflicts.length>0:p.archived);
    const card=(title,contactEntry,projects)=>{
      const box=el('details','board-client');box.open=true;
      const head=el('summary','board-client-head');head.append(el('strong','',title));
      if(contactEntry){const inOdoo=inOdooContact(contactEntry);head.append(el('span','project-status '+(inOdoo?'mapped':'unmapped'),inOdoo?'In Odoo':'Not in Odoo'));if(contactEntry.archived)head.append(el('span','project-status archived','Archived'));}
      head.append(el('span','msg',projects.length+(projects.length===1?' project':' projects')));
      box.append(head);
      for(const p of projects)box.append(projectRow(p,target,msg));
      if(!projects.length)box.append(el('p','business-guidance','No projects match this filter.'));
      return box;};
    const draw=()=>{byClient.replaceChildren();let any=false;
      for(const c of catalog.entries.filter(e=>!e.parentId&&!NO_CLIENT.includes(e.name)).sort(byName)){
        const projects=data.projects.filter(p=>p.contact.id===c.id&&shown(p)).sort(byName);
        if(filter.value&&!projects.length)continue;
        any=true;byClient.append(card(c.name,c,projects));
      }
      const loose=data.projects.filter(p=>NO_CLIENT.includes(p.contact.name)&&shown(p));
      if(loose.length){any=true;byClient.append(card('No client',null,loose));}
      if(!any)byClient.append(el('p','business-guidance','No clients or projects match this filter.'));};
    filter.addEventListener('change',draw);
    panel.append(filter,byClient);draw();
    renderConflicts(panel,data.projects);
  }
  // One project: its local ID, Odoo links, status, and the actions for a project that is not in Odoo yet.
  function projectRow(p,target,msg){
    const row=el('div','board-row'),client=catalog.entries.find(e=>e.id===p.contact.id&&!e.parentId),info=el('div','board-row-info'),actions=el('div','board-row-actions');
    info.append(el('strong','',p.name+(p.aiName?' ('+p.aiName+')':'')),el('span','project-id',p.id));
    for(const l of p.odooLinks){const a=el('a','','Odoo #'+l.odooId);a.href=l.url;a.target='_blank';a.rel='noopener';info.append(a);}
    row.append(info,el('span','project-status '+p.status,STATUS_LABEL[p.status]),actions);
    if(p.unmapped&&!p.archived&&odooOn&&client&&!NO_CLIENT.includes(client.name)){
      const inOdoo=inOdooContact(client);
      if(!inOdoo)actions.append(button('Add client to Odoo',async ev=>{const b=ev.currentTarget;b.disabled=true;msg.className='msg';msg.textContent='Adding “'+client.name+'” to Odoo…';
        try{await addContactToOdoo(client.name);await boardChanged(target,'“'+client.name+'” added to Odoo.');}catch(err){message(msg,err);b.disabled=false;}},'btn'));
      const add=button('Add to Odoo',async ev=>{const b=ev.currentTarget;b.disabled=true;msg.className='msg';msg.textContent='Adding “'+p.name+'” to Odoo…';
        try{await addProjectToOdoo(p.name,client.id);await boardChanged(target,'Project “'+p.name+'” added to Odoo.');}catch(err){message(msg,err);b.disabled=false;}},'btn primary');
      add.disabled=!inOdoo;if(!inOdoo)add.title='Add the client to Odoo first';
      actions.append(add);
      mapControl(p,actions,msg,target);
    }
    return row;
  }
  // After a change on the clients board: in its dialog (Odoo page) the board is drawn again and the page refreshes in place;
  // on the page without Odoo the page is drawn again.
  async function boardChanged(target,note){
    if(!target.classList.contains('board-host'))return catalogChanged(target,note);
    target.replaceChildren();renderProjects(target);if(clientsPage?.root.isConnected){if(note)clientsPage.say(note);await clientsPage.refresh();}
  }
  // The client report: the clients and projects its tickets use that are not in Odoo yet, each with an Add to Odoo action.
  function reportAddPanel({rows,refresh}){
    if(!odooOn||!projectAdmin||!admin())return null;
    const contactOf=id=>catalog.entries.find(e=>e.id===id&&!e.parentId),usable=c=>c&&!NO_CLIENT.includes(c.name);
    const reported=new Map(),contacts=new Map();
    for(const t of rows){
      if(t.subClientId&&t.subClientId!=='__none'){const p=catalog.entries.find(e=>e.id===t.subClientId&&e.parentId);if(p&&!p.archived)reported.set(p.id,p);}
      const c=t.clientId&&t.clientId!=='__none'?contactOf(t.clientId):null;if(usable(c))contacts.set(c.id,c);
    }
    const missingProjects=[...reported.values()].filter(p=>!inOdooProject(p)).map(p=>({p,c:contactOf(p.parentId)})).filter(x=>usable(x.c));
    for(const {c} of missingProjects)contacts.set(c.id,c);
    const missingContacts=[...contacts.values()].filter(c=>!inOdooContact(c)).sort(byName);
    missingProjects.sort((a,b)=>(a.c.name+' / '+a.p.name).localeCompare(b.c.name+' / '+b.p.name));
    const box=el('section','report-odoo-add'),msg=el('p','msg');
    if(!missingContacts.length&&!missingProjects.length){box.append(el('p','msg','Every client and project in this report is in Odoo.'));return box;}
    const run=async(b,label,work)=>{b.disabled=true;msg.className='msg';msg.textContent=label;try{await work();refresh();}catch(err){message(msg,err);b.disabled=false;}};
    const addRow=(kind,label,btn)=>{const row=el('div','report-add-row');row.append(el('span','board-kind',kind),el('span','report-add-name',label),btn);return row;};
    box.append(el('h3','','In this report but not in Odoo'),el('p','business-guidance','Add them to Odoo from here. A project goes under its client, so add the client first.'),msg);
    for(const c of missingContacts)box.append(addRow('Client',c.name,button('Add client to Odoo',ev=>run(ev.currentTarget,'Adding “'+c.name+'” to Odoo…',()=>addContactToOdoo(c.name)),'btn primary')));
    for(const {p,c} of missingProjects){const inOdoo=inOdooContact(c),btn=button('Add to Odoo',ev=>run(ev.currentTarget,'Adding “'+p.name+'” to Odoo…',()=>addProjectToOdoo(p.name,c.id)),'btn primary');
      btn.disabled=!inOdoo;if(!inOdoo)btn.title='Add the client to Odoo first';
      box.append(addRow('Project',c.name+' / '+p.name,btn));}
    return box;
  }
  // "Map to Odoo" for an unmapped project: lists the unlinked Odoo projects it matches, then links the one chosen.
  function mapControl(p,cell,msg,target){
    cell.append(button('Map to Odoo',async ev=>{const b=ev.currentTarget;b.disabled=true;msg.className='msg';msg.textContent='Looking for matching Odoo projects…';
      try{const {candidates}=await api('/clients/odoo/candidates?id='+encodeURIComponent(p.id));msg.textContent='';
        if(!candidates.length){b.remove();cell.append(el('span','business-guidance','No match: no unlinked Odoo project named “'+p.name+'” under “'+p.contact.name+'”. To create one, use Add to Odoo.'));return;}
        const pick=el('select','fsel');pick.setAttribute('aria-label','Odoo project for '+p.name);option(pick,'Choose Odoo project…','');for(const c of candidates)option(pick,'#'+c.odooId+' '+c.name,String(c.odooId));
        const link=button('Link',async e=>{if(!pick.value)return;link.disabled=true;msg.className='msg';msg.textContent='Linking “'+p.name+'” to Odoo…';
          try{catalog=await api('/clients/odoo/link',{method:'POST',body:{revision:catalog.revision,id:p.id,odooId:Number(pick.value)}});catalogNote={text:'Linked “'+p.name+'” to Odoo #'+pick.value+'.',at:Date.now()};await onChange();await boardChanged(target,catalogNote.text);}
          catch(err){message(msg,err);link.disabled=false;}},'btn primary');
        b.replaceWith(pick,link);
      }catch(err){message(msg,err);b.disabled=false;}},'btn'));
  }
  function renderConflicts(panel,rows){
    const box=el('div','project-conflicts'),conflicted=rows.filter(p=>p.conflicts.length);
    box.append(el('h3','','Conflicts'));
    if(!conflicted.length){box.append(el('p','business-guidance','No conflicts. Each Odoo project is linked to one project, and each project to at most one Odoo project.'));panel.append(box);return;}
    box.append(el('p','business-guidance','Fix these in Odoo before relying on tickets and reports for them. Links cannot be removed from this page yet.'));
    const name=id=>rows.find(r=>r.id===id)?.name||id;
    for(const p of conflicted){
      const item=el('div','project-conflict');item.append(el('strong','',(p.contact.name||'No contact')+' / '+p.name+' ('+p.id+')'));
      for(const c of p.conflicts)item.append(el('p','business-guidance',c.type==='several-odoo'?'Linked to '+c.odooIds.length+' Odoo projects: '+c.odooIds.map(i=>'#'+i).join(', ')+'.':'Odoo #'+c.odooId+' is also linked to '+c.with.map(id=>name(id)).join(', ')+'.'));
      box.append(item);
    }
    panel.append(box);
  }
  let epicCache=null,epicNote={text:'',at:0};
  async function renderEpicMap(target){
    const panel=el('section','panel business-panel');target.append(panel);panel.append(el('h2','','Jira epics → Odoo projects'));
    panel.append(el('p','business-guidance','Tickets under a mapped epic get that project as their client and project, and follow the epic if they move to another mapped one. A client someone chose by hand on a ticket is kept.'));
    const msg=el('p','msg','Loading epics from Jira…');panel.append(msg);
    // The page redraws a few times while it loads; reuse a recent epic list instead of asking Jira each time.
    let data;try{if(!epicCache||Date.now()-epicCache.at>60000)epicCache={at:Date.now(),data:api('/epic-map')};data=await epicCache.data;}catch(err){epicCache=null;message(msg,err);return;}
    msg.textContent=Date.now()-epicNote.at<15000?epicNote.text:'';if(!data.epics.length){msg.textContent='No epics in Jira.';return;}
    const list=el('div','epic-map');panel.append(list);const options=projects();
    for(const ep of data.epics){
      const row=el('div','epic-map-row'),label=el('span','epic-map-name',ep.name+' ('+ep.key+')'+(ep.done?' · done':''));label.dir='auto';
      const select=el('select','fsel');select.setAttribute('aria-label','Odoo project for '+ep.name);option(select,'Not mapped','');for(const p of options)option(select,p.name,p.id);
      const current=data.map[ep.key];if(current&&!options.some(p=>p.id===current))option(select,(catalog.entries.find(e=>e.id===current)?.name||'Unknown project')+' (archived)',current);
      select.value=current||'';
      select.addEventListener('change',async()=>{select.disabled=true;msg.className='msg';msg.textContent='Saving and updating tickets…';
        try{const r=await api('/epic-map',{method:'PUT',body:{revision:data.revision,epicKey:ep.key,entryId:select.value||null}});data.revision=r.revision;data.map=r.map;
          msg.textContent=r.sync?.error||(r.sync?.busy?'Saved. Tickets will be updated on the next sync.':'Saved. '+(r.sync?.changed||0)+' ticket'+(r.sync?.changed===1?'':'s')+' updated.');epicNote={text:msg.textContent,at:Date.now()};
          if(r.sync?.changed){await load(Object.keys(records));await onChange();}}
        catch(err){message(msg,err);select.value=data.map[ep.key]||'';}finally{select.disabled=false;}});
      row.append(label,select);list.append(row);
    }
  }
  return {configure:async cfg=>{reportBrowser.configure(cfg);odooOn=!!cfg.odoo;billingNeeded=cfg.billingRequired===true;enabled=cfg.capabilities?.includes('ticket-business-v1')===true;epicMapping=enabled&&cfg.capabilities?.includes('epic-map-v1')===true;projectAdmin=enabled&&cfg.capabilities?.includes('project-admin-v1')===true;projectBudget=enabled&&cfg.capabilities?.includes('project-budget-v1')===true;if(enabled){await loadCatalog();if(cfg.odoo)api('/clients/odoo-sync',{method:'POST',body:{}}).then(r=>r.changed?loadCatalog():loadProjects()).catch(()=>{});if(epicMapping)api('/epic-map/sync',{method:'POST',body:{}}).then(async r=>{if(r.changed&&Object.keys(records).length){await load(Object.keys(records));await onChange();}}).catch(()=>{});}},enabled:()=>enabled,load,decorate,canQuickEdit,quickEdit,quickLabel,createFields,renderEditor,dirty:key=>editor?.key===key&&editor.dirty(),reset:()=>{editor=null;},bulk,ensureBilling,overrideReason,filters,matches,renderReports,renderCatalog,loadCatalog};
}
