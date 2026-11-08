import {createReportBrowser} from './report-browser.js';
import { createdDate, DASH_PRIORITIES } from '../models/ticket-business.js';
import { BUDGET_LABEL, DEFAULT_VIEW, budgetStatus, hours, signedHours, percent, budgetText, budgetRows, budgetCsvRows, budgetCounts, projectChoices } from '../models/odoo-projects.js';
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
  function renderCatalog(target,note){
    const panel=el('section','panel business-panel');target.append(panel);panel.append(el('h2','','Clients & Projects'));
    if(!enabled){panel.append(el('p','msg err','The updated backend is required.'));return;}
    // Clients are Odoo contacts and projects their Odoo projects, refreshed automatically; new ones are created in Odoo.
    const msg=el('p','msg'),sync=el('div','catalog-sync');sync.append(el('p','business-guidance','Clients are Odoo’s Contacts › Companies with the All in One company selected; projects are each company’s Odoo projects. New contacts and projects in Odoo appear here automatically every few minutes.'),button('Sync from Odoo now',async e=>{const b=e.currentTarget;b.disabled=true;msg.className='msg';msg.textContent='Reading contacts and projects from Odoo…';try{const r=await api('/clients/odoo-sync?force=1',{method:'POST',body:{}});if(r.odoo===false){msg.textContent='Odoo is not connected.';return;}if(r.changed)await loadCatalog();else await loadProjects().catch(()=>{});syncLine();const counts=(r.customers!=null?r.customers+' contacts, ':'')+r.projects+' projects',done=r.changed?r.added+' new from Odoo ('+counts+').':'Already up to date ('+counts+').';msg.textContent=done;if(r.changed){catalogNote={text:done,at:Date.now()};await onChange();if(target.isConnected){target.replaceChildren();renderCatalog(target,done);}}}catch(err){await loadProjects().catch(()=>{});syncLine();message(msg,err);}finally{b.disabled=false;}},'btn primary'));
    // The last sync that worked, and the last failure with Odoo's reason while no sync has worked since.
    const status=el('p','catalog-sync-status');sync.append(status);
    const when=t=>t?new Date(t).toLocaleString('en-GB',{timeZone:'Asia/Jerusalem',dateStyle:'medium',timeStyle:'short'}):'never';
    function syncLine(){status.replaceChildren();if(!odooOn||!syncState)return;
      status.append(el('span','','Last successful sync: '+when(syncState.syncedAt)+(syncState.projectsSyncedAt?' · Odoo projects read '+when(syncState.projectsSyncedAt):'')+'.'));
      if(syncState.error)status.append(el('span','msg err',' Last sync failed '+when(syncState.error.at)+': '+syncState.error.message+' Check the Odoo connection in Settings, then press Sync from Odoo now.'));}
    syncLine();
    if(odooOn){const create=(key,text,open)=>{const b=button(text,e=>open(e.currentTarget,target),'btn');b.dataset.create=key;return b;};sync.append(create('contact','+ Create contact',openContactDialog),create('project','+ Create project',openProjectDialog));}panel.append(sync,msg);{const n=note||(Date.now()-catalogNote.at<15000?catalogNote.text:'');if(n)msg.textContent=n;}
    // Without Odoo a client or project is added here. With Odoo, contacts and projects are created in Odoo from their dialogs.
    if(!odooOn){
    const add=el('div','business-form'),name=field(add,'New client or project name',input('text','')),parent=field(add,'Parent (optional)',el('select','fsel'));option(parent,'Top-level client','');for(const c of clients())option(parent,c.name,c.id);add.append(button('Add',async()=>{try{catalog=await api('/clients',{method:'POST',body:{revision:catalog.revision,name:name.value,parentId:parent.value||null}});await onChange();target.replaceChildren();renderCatalog(target);}catch(err){message(msg,err);}}));panel.append(add);}
    if(odooOn&&admin())renderNeedsMapping(target);
    if(projectBudget&&odooOn&&admin())renderOdooProjects(target);
    if(projectAdmin&&admin())renderProjects(target);
    if(epicMapping&&admin())renderEpicMap(target);
  }
  // Create contact and Create project in Odoo, each in its own dialog. A failed save keeps what was typed. Escape, Close and
  // Cancel ask before unsaved values are discarded. A save that works closes the dialog, reloads the panel and returns focus to
  // the button that opened it.
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
        d.close();
        await onChange();
        if(target.isConnected){target.replaceChildren();renderCatalog(target,note);target.querySelector('[data-create="'+key+'"]')?.focus();}
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
  // Needs mapping (administrators): tickets saved before each ticket had an Odoo project. Only the Odoo project a ticket's
  // project is already linked to is applied; missing, ambiguous and conflicting tickets are listed to be fixed by hand.
  // Nothing is matched by name, and an Odoo project already on a ticket is never replaced.
  const MAPPING_LABEL={ready:'Ready',missing:'Missing',ambiguous:'Ambiguous',conflict:'Conflict'};
  const MAPPING_SHOWN=200;
  async function renderNeedsMapping(target){
    const panel=el('section','panel business-panel needs-mapping');target.append(panel);panel.append(el('h2','','Needs mapping'));
    const loading=el('p','msg','Checking tickets…');panel.append(loading);
    let plan;try{plan=await api('/clients/needs-mapping');}catch(err){message(loading,err);return;}
    const draw=note=>{
      panel.replaceChildren(el('h2','','Needs mapping'),el('p','business-guidance','Tickets with no Odoo project yet. Ready tickets get the Odoo project their project is already linked to. Open the others and choose their Odoo project. Work logs and Jira links stay as they are.'));
      const summary=el('div','board-summary');
      summary.append(el('span','board-chip','All tickets: '+plan.mapped+' of '+plan.scanned+' have an Odoo project'),...Object.entries(MAPPING_LABEL).map(([k,l])=>el('span','board-chip'+(plan[k]&&k!=='ready'?(k==='conflict'?' conflict':' needs'):''),plan[k]+' '+l.toLowerCase())));
      const msg=el('p','msg',note||'');panel.append(summary,msg);
      if(!plan.rows.length){panel.append(el('p','business-guidance','Every ticket has an Odoo project.'));return;}
      const bar=el('div','budget-bar'),filter=el('select','fsel');filter.setAttribute('aria-label','Show tickets that need mapping');option(filter,'All ('+plan.rows.length+')','');
      for(const [k,l] of Object.entries(MAPPING_LABEL))if(plan[k])option(filter,l+' ('+plan[k]+')',k);
      bar.append(filter);if(plan.ready)bar.append(button('Apply all ready ('+plan.ready+')',ev=>apply(ev.currentTarget,null,msg),'btn primary'));
      const list=el('div','mapping-list'),more=el('p','business-guidance');
      const fill=()=>{const rows=plan.rows.filter(r=>!filter.value||r.kind===filter.value);list.replaceChildren(...rows.slice(0,MAPPING_SHOWN).map(r=>mappingRow(r,msg)));more.textContent=rows.length>MAPPING_SHOWN?'Showing the first '+MAPPING_SHOWN+' of '+rows.length+'.':'';};
      filter.addEventListener('change',fill);panel.append(bar,list,more);fill();
    };
    const mappingRow=(r,msg)=>{
      const row=el('div','board-row'),info=el('div','board-row-info'),actions=el('div','board-row-actions');
      info.append(el('strong','',r.key),el('span','',[r.client,r.project].filter(Boolean).join(' / ')||'No client or project'),el('span','business-guidance',r.message));
      if(r.closed)info.append(el('span','project-status archived','Closed ticket'));
      if(r.archived)info.append(el('span','project-status archived','Archived in Odoo'));
      row.append(info,el('span','project-status '+(r.kind==='ready'?'mapped':r.kind==='conflict'?'conflict':'unmapped'),MAPPING_LABEL[r.kind]),actions);
      if(r.kind==='ready')actions.append(button('Apply',ev=>apply(ev.currentTarget,[r.key],msg),'btn primary'));
      actions.append(button('Open ticket',()=>openIssue(r.key),'btn'));
      return row;};
    async function apply(b,keys,msg){
      b.disabled=true;msg.className='msg';msg.textContent='Linking tickets to their Odoo projects…';
      try{const r=await api('/clients/needs-mapping/apply',{method:'POST',body:keys?{keys}:{}});plan=r.plan;
        const note=r.applied+(r.applied===1?' ticket':' tickets')+' linked.'+(r.skipped.length?' Skipped (changed since the check, refresh to see them): '+r.skipped.map(s=>s.key).join(', ')+'.':'');catalogNote={text:note,at:Date.now()};draw(note);
        if(Object.keys(records).length)await load(Object.keys(records));await onChange();}
      catch(err){message(msg,err);b.disabled=false;}
    }
    draw();
  }
  // Every active Odoo project with its allocated and logged hours (administrators, project-budget-v1). Logged hours are
  // Odoo's timesheet lines on the project, so each hour counts once; work not in Odoo yet is shown apart and not added.
  // Filters, sorting and the CSV rows are in models/odoo-projects.js.
  const BUDGET_PAGE=25;
  let budgetView={...DEFAULT_VIEW};
  // Odoo's hours are re-read this often while the page is open, so the table follows the 5-minute work log sync.
  const ODOO_REFRESH_MS=2*60*1000;
  const dateText=d=>d?new Date(d.length===10?d+'T00:00:00':d).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'—';
  const COLS=[['name','Odoo Project'],['client','Client'],['created','Created'],['allocated','Allocated'],['logged','Logged'],['remaining','Remaining'],['used','Used'],['status','Budget Status'],['open','Open Tickets'],['review','Needs PR Review'],['lastWork','Last Work Log'],[null,'Actions']];
  async function renderOdooProjects(target,prefetched,before){
    const panel=el('section','panel business-panel odoo-projects');target.insertBefore(panel,before??null);panel.append(el('h2','','Odoo projects'));
    const msg=el('p','msg',prefetched?'':'Loading projects from Odoo…');panel.append(msg);
    let data=prefetched;if(!data){try{data=await api('/clients/odoo-projects');}catch(err){message(msg,err);return;}}
    msg.textContent='';
    panel.insertBefore(el('p','business-guidance','Every active project in Odoo. Logged hours are the Odoo timesheet hours on the project, counted once whether they came from the work log, agreed hours or Odoo itself; work log time not in Odoo yet (waiting or failed) is shown apart and not counted. Near limit: '+Math.round((data.nearLimit??0.8)*100)+'% or more of the allocated hours logged. Allocated hours are saved on the Odoo project; empty means not set, which is not the same as 0.'),msg);
    // Re-reads the figures and redraws the panel in place. Skipped while the tab is hidden, a row is being edited, or the
    // panel has focus (search or an open editor), so nothing typed is lost. Stops once the panel leaves the page.
    let refreshing=false;
    const busy=()=>panel.querySelector('.budget-edit')||panel.contains(document.activeElement)||document.querySelector('dialog.project-details');
    const timer=setInterval(async()=>{
      if(!panel.isConnected){clearInterval(timer);return;}
      if(refreshing||document.hidden||busy())return;
      refreshing=true;
      try{const fresh=await api('/clients/odoo-projects');if(panel.isConnected&&!busy()){const next=panel.nextSibling;panel.remove();renderOdooProjects(target,fresh,next);clearInterval(timer);}}
      catch{}finally{refreshing=false;}
    },ODOO_REFRESH_MS);
    const rows=data.projects,count=(s,n)=>n+' '+s+(n===1?'':'s');
    // Summary chips: always all active projects (each one a filter); a second line counts the rows the filters leave.
    const summary=el('div','board-summary'),scoped=el('p','business-guidance budget-scope');
    const chip=(text,cls,status)=>button(text,()=>{budgetView.status=budgetView.status===status?'':status;statusSel.value=budgetView.status;budgetView.page=0;draw();},'board-chip'+(cls?' '+cls:''));
    const all=budgetCounts(rows);
    summary.append(el('span','board-chip','All active projects: '+all.projects),chip(all.over+' over budget',all.over?'conflict':'','over'),chip(all.near+' near limit',all.near?'needs':'','near'),chip(all.notSet+' allocation not set','','not_set'),chip(all.unmapped+' not linked','','unmapped'));
    if(all.missingClient)summary.append(button(all.missingClient+' without a client',()=>{budgetView.missingClient=budgetView.missingClient==='missing'?'':'missing';missingSel.value=budgetView.missingClient;budgetView.page=0;draw();},'board-chip needs'));
    panel.append(summary,scoped);
    if(!data.allocation)panel.append(el('p','msg err','This Odoo has no allocated hours on projects. Turn on Timesheets in Odoo to set them.'));
    if(data.unplacedPendingHours>0)panel.append(el('p','business-guidance',hours(data.unplacedPendingHours)+' of work log time is not in Odoo yet and has no Odoo project. See Work log setup.'));
    const bar=el('div','budget-bar'),search=input('search',budgetView.q);search.placeholder='Search projects or clients';search.setAttribute('aria-label','Search Odoo projects by project or client');
    const select=(label,options,key)=>{const s=el('select','fsel');s.setAttribute('aria-label',label);for(const [v,l] of options)option(s,l,v);s.value=budgetView[key]||'';s.addEventListener('change',()=>{budgetView[key]=s.value;budgetView.page=0;draw();});return s;};
    const statusSel=select('Filter by budget status',[['','All budget statuses'],...Object.entries(BUDGET_LABEL),['unmapped','Not linked']],'status');
    const clientSel=select('Filter by client',[['','All clients'],...[...new Set(rows.map(p=>p.client).filter(Boolean))].sort().map(c=>[c,c]),['__none','No client']],'client');
    const missingSel=select('Filter by missing client',[['','With or without a client'],['missing','Missing client'],['present','Has a client']],'missingClient');
    const ticketSel=select('Filter by linked tickets',[['','With or without tickets'],['with','With linked tickets'],['without','Without linked tickets']],'tickets');
    // A new search or filter starts again from the first page; the chosen sort stays.
    search.addEventListener('input',()=>{budgetView.q=search.value;budgetView.page=0;draw();});
    bar.append(search,statusSel,clientSel,missingSel,ticketSel,button('Export CSV',()=>exportBudget(shown()),'btn'));panel.append(bar);
    const wrap=el('div','table-wrap'),table=el('table','budget-table'),head=el('thead'),body=el('tbody'),foot=el('tfoot');table.append(head,body,foot);wrap.append(table);panel.append(wrap);
    const pager=el('div','budget-pager');panel.append(pager);
    const shown=()=>budgetRows(rows,budgetView);
    const draw=()=>{
      const tr=el('tr');for(const [k,l] of COLS){const th=el('th');th.scope='col';if(!k){th.textContent=l;tr.append(th);continue;}
        const b=button(l+(budgetView.sort===k?(budgetView.dir>0?' ▲':' ▼'):''),()=>{budgetView.dir=budgetView.sort===k?-budgetView.dir:(k==='created'||k==='lastWork'?-1:1);budgetView.sort=k;budgetView.page=0;draw();},'th-sort');th.setAttribute('aria-sort',budgetView.sort===k?(budgetView.dir>0?'ascending':'descending'):'none');th.append(b);tr.append(th);}
      head.replaceChildren(tr);
      // Paging works on the whole sorted list; the totals and the Export CSV cover every matching project, not one page.
      const list=shown(),pages=Math.max(1,Math.ceil(list.length/BUDGET_PAGE));budgetView.page=Math.min(budgetView.page,pages-1);
      const from=budgetView.page*BUDGET_PAGE,pageRows=list.slice(from,from+BUDGET_PAGE);
      body.replaceChildren(...pageRows.flatMap(p=>budgetRow(p,data,msg,target)));
      if(!list.length){const r=el('tr'),td=el('td','business-guidance','No Odoo projects match.');td.colSpan=COLS.length;r.append(td);body.append(r);}
      const c=budgetCounts(list);
      scoped.textContent=list.length===rows.length?'Showing all '+count('project',list.length)+'.':'Matching the filters: '+count('project',c.projects)+', '+c.over+' over budget, '+c.near+' near limit, '+c.notSet+' allocation not set.';
      pager.replaceChildren();
      if(list.length>BUDGET_PAGE){
        const prev=button('← Previous',()=>{budgetView.page--;draw();},'btn'),next=button('Next →',()=>{budgetView.page++;draw();},'btn');
        prev.disabled=budgetView.page===0;next.disabled=budgetView.page>=pages-1;
        pager.append(el('span','',(from+1)+'–'+(from+pageRows.length)+' of '+count('project',list.length)),prev,next);
      }
      const sum=f=>list.reduce((s,p)=>s+(f(p)||0),0),total=el('tr');
      total.append(el('th','',list.length===rows.length?'Total (all projects)':'Total ('+count('project',list.length)+' shown)'),el('td'),el('td'),el('td','num',hours(sum(p=>p.allocatedHours))),el('td','num',hours(sum(p=>p.loggedHours))),el('td','num',signedHours(sum(p=>p.remainingHours))),el('td'),el('td','',c.over+' over'),el('td','num',String(sum(p=>p.openTickets))),el('td','num',String(sum(p=>p.reviewTickets))),el('td'),el('td'));
      total.firstChild.scope='row';foot.replaceChildren(total);
    };
    draw();
  }
  // One project: its main row, and a second row (shown with the ▸ button) with the company, links and time not in Odoo yet.
  function budgetRow(p,data,msg,target){
    const tr=el('tr','budget-main budget-'+p.status),detail=el('tr','budget-detail'),detailId='budget-detail-'+p.odooId;detail.id=detailId;detail.hidden=!p._open;
    const name=el('td','budget-name'),toggle=button(p._open?'▾':'▸',()=>{p._open=!p._open;detail.hidden=!p._open;toggle.textContent=p._open?'▾':'▸';toggle.setAttribute('aria-expanded',String(!!p._open));},'budget-toggle');
    toggle.setAttribute('aria-expanded',String(!!p._open));toggle.setAttribute('aria-controls',detailId);toggle.setAttribute('aria-label','More about '+p.name);
    const open=button(p.name,()=>openProjectDetails(p.odooId,toggle),'linkbtn');open.dir='auto';name.append(toggle,open);
    const client=el('td');if(p.client)client.textContent=p.client;else client.append(el('span','project-status unmapped','No client'));
    const alloc=el('td','num');allocationCell(alloc,p);
    const logged=el('td','num',hours(p.loggedHours));if(p.pendingHours>0)logged.append(el('div','budget-sub','+'+hours(p.pendingHours)+' not in Odoo yet'));
    const remaining=el('td','num'+(p.remainingHours<0?' over':''),p.remainingHours==null?'—':signedHours(p.remainingHours));
    const status=el('td');status.append(el('span','budget-status '+p.status,budgetText(p)));
    const review=el('td','num',String(p.reviewTickets||0));if(p.reviewKeys?.length)review.title=p.reviewKeys.join(', ');
    const actions=el('td','budget-actions'),odooLink=el('a','btn','Open in Odoo');odooLink.href=p.url;odooLink.target='_blank';odooLink.rel='noopener';odooLink.setAttribute('aria-label','Open '+p.name+' in Odoo');actions.append(odooLink);
    if(data.allocation){const edit=button(p.allocatedHours==null?'Set allocation':'Edit allocation',()=>editAllocation(alloc,p,data,msg,target),'btn budget-edit-btn');edit.setAttribute('aria-label',edit.textContent+' for '+p.name);actions.append(edit);}
    tr.append(name,client,el('td','',dateText(p.createdAt)),alloc,logged,remaining,el('td','num',percent(p.usedPercent)),status,el('td','num',String(p.openTickets||0)),review,el('td','',dateText(p.lastWorkDate)),actions);
    // The secondary row: what links the project to Jira, its company and Odoo id, and the tickets waiting for review.
    const cell=el('td','budget-links');cell.colSpan=COLS.length;detail.append(cell);
    cell.append(el('div','budget-sub',[p.company&&'Company: '+p.company,'Odoo #'+p.odooId,p.ticketCount?count2(p.ticketCount,'dashboard ticket'):'',p.missingClient?'No client in Odoo: tickets cannot be given this project until it has one.':''].filter(Boolean).join(' · ')));
    if(!p.mapped)cell.append(el('span','project-status unmapped','Not linked'));
    for(const l of p.links.projects){const tag=el('span','budget-link',l.name);tag.dir='auto';tag.append(button('×',()=>linkProject(p,l.id,true,msg,target),'budget-unlink'));tag.lastChild.setAttribute('aria-label','Unlink '+l.name+' from '+p.name);cell.append(tag);}
    for(const k of p.links.epics)cell.append(el('span','budget-link','Epic '+k));
    if(p.links.helpdesk)cell.append(el('span','budget-link','Helpdesk'));
    const t=p.links.tickets;if(t.count){const d=el('details','budget-tickets'),s=el('summary','','Odoo tasks: '+Object.entries(t.byProject).map(([k,n])=>k+': '+n).join(' · ')+(t.count===1?' ticket':' tickets'));d.append(s,el('p','budget-keys',t.keys.join(', ')+(t.count>t.keys.length?' …':'')));cell.append(d);}
    if(p.reviewKeys?.length)cell.append(el('p','budget-sub','Needs PR review: '+p.reviewKeys.join(', ')));
    if(p.linkable)cell.append(linkControl(p,msg,target));else cell.append(el('span','budget-sub','Other Odoo company: link in Odoo'));
    return [tr,detail];
  }
  const count2=(n,s)=>n+' '+s+(n===1?'':'s');
  function allocationCell(cell,p){cell.replaceChildren(p.allocatedHours==null?el('span','budget-unset','Not set'):document.createTextNode(hours(p.allocatedHours)));}
  // Edit allocation (from the row's Actions): saved on the Odoo project, kept in the project's history. Empty clears it.
  function editAllocation(cell,p,data,msg,target){
    if(cell.querySelector('.budget-edit')){cell.querySelector('input').focus();return;}
    const box=el('div','budget-edit'),n=input('number',p.allocatedHours??'');n.min='0';n.step='any';n.setAttribute('aria-label','Allocated hours for '+p.name);
    const redraw=()=>{const tr=cell.closest('tr'),[a,b]=budgetRow(p,data,msg,target);tr.nextElementSibling?.replaceWith(b);tr.replaceWith(a);};
    const save=async()=>{if(n.value!==''&&!(Number(n.value)>=0)){msg.className='msg err';msg.textContent='Enter 0 or more hours, or leave it empty for not set.';return;}
      save.btn.disabled=true;msg.className='msg';msg.textContent='Saving allocated hours to Odoo…';
      try{const r=await api('/clients/odoo-projects/allocation',{method:'PUT',body:{odooId:p.odooId,hours:n.value===''?null:Number(n.value)}});
        Object.assign(p,{allocatedHours:r.allocatedHours},budgetStatus(r.allocatedHours,p.loggedHours,data.nearLimit));msg.textContent='Saved for “'+p.name+'”.';redraw();}
      catch(err){message(msg,err);save.btn.disabled=false;}};
    save.btn=button('Save',save,'btn primary');
    n.addEventListener('keydown',e=>{if(e.key==='Enter')save();else if(e.key==='Escape')allocationCell(cell,p);});
    box.append(n,save.btn,button('Cancel',()=>allocationCell(cell,p),'btn'));cell.append(box);n.focus();
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
  function linkControl(p,msg,target){
    return button('Link project',ev=>{
      const free=projects().filter(x=>!(catalog.entries.find(e=>e.id===x.id)?.sources||[]).some(s=>s.source==='odoo'));
      const box=el('div','budget-edit'),pick=el('select','fsel');pick.setAttribute('aria-label','Dashboard project to link to '+p.name);
      option(pick,free.length?'Choose project…':'No unlinked project','');for(const x of free)option(pick,x.name,x.id);
      box.append(pick,button('Link',()=>{if(pick.value)linkProject(p,pick.value,false,msg,target);},'btn primary'),button('Cancel',()=>box.replaceWith(linkControl(p,msg,target)),'btn'));
      ev.currentTarget.replaceWith(box);combobox(pick);box.querySelector('input')?.focus();
    },'btn budget-link-btn');
  }
  async function linkProject(p,entryId,unlink,msg,target){
    const name=projects().find(x=>x.id===entryId)?.name||'the project';
    if(unlink&&!confirm('Unlink '+name+' from the Odoo project “'+p.name+'”? Work logged on its tickets will need another Odoo project.'))return;
    msg.className='msg';msg.textContent=unlink?'Unlinking…':'Linking…';
    try{catalog=await api('/clients/odoo-projects/link',{method:'POST',body:{revision:catalog.revision,odooId:p.odooId,entryId,unlink}});
      catalogNote={text:(unlink?'Unlinked ':'Linked ')+name+(unlink?' from ':' to ')+'“'+p.name+'”.',at:Date.now()};await onChange();target.replaceChildren();renderCatalog(target);}
    catch(err){if(err.code==='conflict')await loadCatalog();message(msg,err);}
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
        try{await addContactToOdoo(client.name);target.replaceChildren();renderCatalog(target,'“'+client.name+'” added to Odoo.');}catch(err){message(msg,err);b.disabled=false;}},'btn'));
      const add=button('Add to Odoo',async ev=>{const b=ev.currentTarget;b.disabled=true;msg.className='msg';msg.textContent='Adding “'+p.name+'” to Odoo…';
        try{await addProjectToOdoo(p.name,client.id);target.replaceChildren();renderCatalog(target,'Project “'+p.name+'” added to Odoo.');}catch(err){message(msg,err);b.disabled=false;}},'btn primary');
      add.disabled=!inOdoo;if(!inOdoo)add.title='Add the client to Odoo first';
      actions.append(add);
      mapControl(p,actions,msg,target);
    }
    return row;
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
          try{catalog=await api('/clients/odoo/link',{method:'POST',body:{revision:catalog.revision,id:p.id,odooId:Number(pick.value)}});catalogNote={text:'Linked “'+p.name+'” to Odoo #'+pick.value+'.',at:Date.now()};await onChange();target.replaceChildren();renderCatalog(target,catalogNote.text);}
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
