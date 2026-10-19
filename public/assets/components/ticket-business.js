import {createReportBrowser} from './report-browser.js';
import { createdDate } from '../models/ticket-business.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const button=(text,fn,cls='btn')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const field=(parent,label,node)=>{const l=el('label','business-field');node.setAttribute('aria-label',label);l.append(el('span','',label),node);parent.append(l);return node;};
const option=(select,label,value)=>select.append(new Option(label,value));
const billingOptions=(select,value)=>{const prompt=new Option('Choose billing…','');prompt.disabled=true;prompt.hidden=true;select.append(prompt);option(select,'Billable','billable');option(select,'Not billable','not_billable');select.value=value||'';};
// A picker you can type into: the list narrows as you type; click, or use the arrow keys and Enter.
// The original <select> stays (hidden) as the value everything else reads and listens to.
function combobox(select){
  const wrap=el('div','combo'),input=el('input','inp combo-input'),list=el('ul','combo-list');
  const id='cb'+Math.random().toString(36).slice(2,9);list.id=id;list.setAttribute('role','listbox');list.hidden=true;
  input.type='text';input.autocomplete='off';input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls',id);input.setAttribute('aria-expanded','false');
  select.removeAttribute('aria-label');select.classList.add('combo-native');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
  select.before(wrap);wrap.append(input,list);
  let items=[],active=-1;
  const sync=()=>{const o=select.selectedOptions[0];input.value=o&&o.value?o.text:'';input.placeholder=(select.options[0]&&select.options[0].text)||'Choose…';input.disabled=select.disabled;};
  const close=()=>{list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');};
  const mark=n=>{active=n;[...list.children].forEach((li,i)=>li.classList.toggle('active',i===n));const li=list.children[n];if(li){input.setAttribute('aria-activedescendant',li.id);li.scrollIntoView({block:'nearest'});}};
  const choose=o=>{if(select.value!==o.value){select.value=o.value;select.dispatchEvent(new Event('change',{bubbles:true}));}sync();close();};
  const open=q=>{q=String(q||'').trim().toLowerCase();items=[...select.options].filter(o=>o.value&&!o.disabled&&(!q||o.text.toLowerCase().includes(q)));
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
  return {refresh:sync};
}
const input=(type,value)=>{const n=el('input','inp');n.type=type;n.value=value??'';return n;};
const message=(target,e)=>{target.textContent=e.message||String(e);target.className='msg err';};
export function createTicketBusiness({api,context,onChange,openIssue}){
  let billingNeeded=false,enabled=false,catalog={revision:0,entries:[]},records={},editor=null;
  const reportBrowser=createReportBrowser({api,openIssue});
  const admin=()=>context().admin;
  let odooOn=false;
  const clients=()=>catalog.entries.filter(e=>!e.parentId&&!e.archived);
  const children=id=>catalog.entries.filter(e=>e.parentId===id&&!e.archived);
  async function loadCatalog(){catalog=await api('/clients');return catalog;}
  function names(m){return {...m,clientName:catalog.entries.find(e=>e.id===m.clientId)?.name||'',subClientName:catalog.entries.find(e=>e.id===m.subClientId)?.name||''};}
  function selections(parent,values={},disabled=false,optional=false){
    const client=field(parent,'Client',el('select','fsel')),sub=field(parent,'Project',el('select','fsel'));
    option(client,optional?'No client (optional)':'Choose client…','');for(const c of clients().sort((a,b)=>a.name.localeCompare(b.name)))option(client,c.name,c.id);
    if(values.clientId&&!clients().some(e=>e.id===values.clientId)){const old=catalog.entries.find(e=>e.id===values.clientId);if(old)option(client,old.name+' (archived)',old.id);}
    client.value=values.clientId||'';client.disabled=disabled;sub.disabled=disabled;
    const fill=()=>{sub.replaceChildren();option(sub,children(client.value).length?'Choose project…':'No project','');for(const c of children(client.value).sort((a,b)=>a.name.localeCompare(b.name)))option(sub,c.name,c.id);};fill();
    if(values.subClientId&&![...sub.options].some(o=>o.value===values.subClientId)){const old=catalog.entries.find(e=>e.id===values.subClientId);if(old)option(sub,old.name+' (archived)',old.id);}
    sub.value=values.subClientId||'';client.addEventListener('change',fill);
    combobox(client);const subBox=combobox(sub);client.addEventListener('change',subBox.refresh);
    return {client,sub,read:()=>({clientId:client.value||null,subClientId:sub.value||null})};
  }
  function createFields(parent,{values={},creating=false,closed=false}={}){
    const box=el('div','business-form');parent.append(box);
    const clientGroup=el('fieldset','business-section business-client-section');clientGroup.append(el('legend','','Client & billing'));box.append(clientGroup);
    const selects=selections(clientGroup,values,closed||(!admin()&&!creating),true);
    let billing;if(admin()){billing=field(clientGroup,'Billing (administrators only)',el('select','fsel'));billingOptions(billing,values.billing);billing.disabled=closed;if(creating&&billingNeeded)billing.setAttribute('aria-required','true');}
    const workGroup=el('fieldset','business-section business-work-section');workGroup.append(el('legend','','Work summary'));box.append(workGroup);
    const estimated=field(workGroup,'Estimated hours',input('number',values.estimatedHours)),actual=field(workGroup,'Actual hours',input('number',values.actualHours));
    for(const n of [estimated,actual]){n.min='0.01';n.max='1000000';n.step='0.01';n.disabled=closed;}
    // Once set, the estimate is changed by administrators only.
    if(!admin()&&!creating&&values.estimatedHours!=null){estimated.disabled=true;estimated.title='The estimate is set. Ask an administrator to change it.';}
    const work=field(workGroup,'Work done',el('textarea','inp'));work.value=values.workDone||'';work.maxLength=5000;work.rows=4;work.dir='auto';work.disabled=closed;
    const read=()=>{if(creating&&admin()&&billingNeeded&&!billing.value)throw new Error('Choose Billable or Not billable before assigning this ticket.');for(const n of [estimated,actual])if(!n.checkValidity())throw new Error('Hours must be greater than zero, with up to two decimal places.');const out={estimatedHours:estimated.value===''?null:Number(estimated.value),actualHours:actual.value===''?null:Number(actual.value),workDone:work.value};if(admin()||creating)Object.assign(out,selects.read());if(billing)out.billing=billing.value||null;return out;};
    return {read,box,selects};
  }
  async function load(keys){
    if(!enabled)return;const unique=[...new Set(keys)];
    const parts=[];for(let i=0;i<unique.length;i+=100)parts.push(unique.slice(i,i+100));
    await Promise.all(parts.map(async part=>{const r=await api('/ticket-metadata/batch',{method:'POST',body:{keys:part}});Object.assign(records,r.records);}));
  }
  function decorate(i){return {...i,...(records[i.key]?names(records[i.key]):{})};}
  // One field (or the client pair) edited straight from the ticket list, with the same rules as the ticket panel
  // (client and billing for administrators; closed tickets locked). The server checks all of it again.
  const QUICK={client:'Client',billing:'Billing',estimatedHours:'Estimated hours',actualHours:'Actual hours',workDone:'Work done'};
  function canQuickEdit(i,name){if(!enabled||!i||i.odoo||i.cat==='done'||!(name in QUICK))return false;if(name==='estimatedHours'&&!admin()&&i.estimatedHours!=null)return false;return name==='client'||name==='billing'?admin():true;}
  async function quickEdit(box,key,name,done){
    const msg=el('p','msg','Loading…');box.replaceChildren(msg);
    let r;try{r=await api('/ticket-metadata?key='+encodeURIComponent(key));}catch(e){message(msg,e);return;}
    records[key]=r.metadata;box.replaceChildren();
    if(r.closed){box.append(el('p','msg','Closed ticket: reopen it to edit these fields.'));return;}
    const v=r.metadata,form=el('div','quick-edit');box.append(form);let read,first;
    if(name==='client'){const s=selections(form,v);read=s.read;first=s.client;}
    else if(name==='billing'){const b=field(form,'Billing',el('select','fsel'));billingOptions(b,v.billing);read=()=>{if(!b.value)throw new Error('Choose Billable or Not billable.');return {billing:b.value};};first=b;}
    else if(name==='workDone'){const t=field(form,'Work done',el('textarea','inp'));t.value=v.workDone||'';t.maxLength=5000;t.rows=4;t.dir='auto';read=()=>({workDone:t.value});first=t;}
    else{const n=field(form,QUICK[name],input('number',v[name]));n.min='0.01';n.max='1000000';n.step='0.01';read=()=>{if(!n.checkValidity())throw new Error('Hours must be greater than zero, with up to two decimal places.');return {[name]:n.value===''?null:Number(n.value)};};first=n;}
    const status=el('p','msg'),save=button('Save',async()=>{
      save.disabled=true;
      try{const data=await api('/ticket-metadata',{method:'PUT',body:{key,fields:{revision:v.revision,...read()}}});records[key]=data.metadata;done();}
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
      target.append(el('p','business-guidance',r.closed?'Completed work is read-only. Reopen the ticket to make corrections.':'Complete the hours and work summary before closing. The client is optional.'));
      const controls=createFields(target,{values:r.metadata,closed:r.closed}),msg=el('p','msg');let initial=JSON.stringify(controls.read()),editorRevision=r.metadata.revision;
      const readiness=el('div','work-readiness');target.insertBefore(readiness,controls.box);
      const updateReadiness=()=>{let value;try{value={...r.metadata,...controls.read()};}catch{value={...r.metadata};}readiness.replaceChildren();for(const [label,ready]of [['Estimate',value.estimatedHours>0],['Actual hours',value.actualHours>0],['Work done',!!value.workDone?.trim()]]){const chip=el('span','readiness-chip'+(ready?' ready':''),(ready?'✓ ':'○ ')+label);readiness.append(chip);}};controls.box.addEventListener('input',updateReadiness);controls.box.addEventListener('change',updateReadiness);updateReadiness();
      editor={key,dirty:()=>{try{return JSON.stringify(controls.read())!==initial;}catch{return true;}}};
      if(r.closed)target.append(el('p','msg','Closed ticket. An administrator must reopen it before these fields can be edited.'));
      else target.append(button('Save ticket fields',async e=>{
        const save=e.currentTarget;save.disabled=true;
        try{const data=await api('/ticket-metadata',{method:'PUT',body:{key,fields:{revision:editorRevision,...controls.read()}}});records[key]=data.metadata;editorRevision=data.metadata.revision;initial=JSON.stringify(controls.read());msg.className='msg';msg.textContent='Ticket fields saved.';await onChange();}
        catch(err){message(msg,err);}finally{save.disabled=false;}
      },'btn primary'));
      target.append(msg);
      const history=el('details','business-history');history.append(el('summary','','Business field history'));
      for(const h of [...r.history].reverse()){const line=el('div','business-history-entry');line.append(el('strong','',(h.by?.name||h.by?.email||'System')+' · '+new Date(h.at).toLocaleString('en-GB',{timeZone:'Asia/Jerusalem'})),el('div','',h.type==='override'?'Closure override: '+h.reason+' — '+h.missing.join('; '):h.type==='edit'?Object.entries(h.changes).map(([k,v])=>k+': '+(v.from??'Not set')+' → '+(v.to??'Not set')).join('; '):h.type));history.append(line);}
      target.append(history);
    }catch(e){if(context().key===key){target.replaceChildren(el('h3','','Ticket work & client'));const msg=el('p','msg');message(msg,e);target.append(msg,button('Retry',()=>renderEditor(key)));}}
  }
  function dialog(title){const d=el('dialog','business-dialog'),head=el('div','business-dialog-head'),body=el('div'),msg=el('p','msg');head.append(el('h2','',title),button('Close',()=>d.close()));d.append(head,body,msg);document.body.append(d);d.addEventListener('close',()=>d.remove());d.showModal();return {d,body,msg};}
  async function bulk(keys){
    if(!enabled)throw new Error('Updated backend required.');const {d,body,msg}=dialog('Assign client to selected tickets');const selects=selections(body);
    body.append(button('Apply to '+keys.length+' tickets',async e=>{const action=e.currentTarget;action.disabled=true;const failures=[];for(const key of keys){try{const r=await api('/ticket-metadata?key='+encodeURIComponent(key));await api('/ticket-metadata',{method:'PUT',body:{key,fields:{revision:r.metadata.revision,...selects.read()}}});}catch(err){failures.push(key+': '+err.message);}}await onChange(keys);if(failures.length){msg.textContent=failures.join('\n');action.disabled=false;}else d.close();},'btn primary'));
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
    const sub=el('select','fsel');sub.setAttribute('aria-label','Filter by project');option(sub,'All projects','');for(const c of children(filter.clientId))option(sub,c.name,c.id);sub.value=filter.subClientId||'';sub.addEventListener('change',()=>{filter.subClientId=sub.value;onFilter();});parent.append(sub);
    const missing=el('select','fsel');missing.setAttribute('aria-label','Missing business information');for(const [v,l]of [['','Any work information'],['estimatedHours','Missing estimate'],['actualHours','Missing actual hours'],['workDone','Missing work done']])option(missing,l,v);missing.value=filter.missing||'';missing.addEventListener('change',()=>{filter.missing=missing.value;onFilter();});parent.append(missing);
    if(admin()){const billing=el('select','fsel');billing.setAttribute('aria-label','Filter by billing');for(const [v,l]of [['','All billing'],['__none','Billing not set'],['billable','Billable'],['not_billable','Not billable']])option(billing,l,v);billing.value=filter.billing||'';billing.addEventListener('change',()=>{filter.billing=billing.value;onFilter();});parent.append(billing);}
  }
  function matches(i,f={}){return (!f.clientId||(f.clientId==='__none'?!i.clientId:i.clientId===f.clientId))&&(!f.subClientId||i.subClientId===f.subClientId)&&(!f.missing||!i[f.missing])&&(!admin()||!f.billing||(f.billing==='__none'?!i.billing:i.billing===f.billing));}
  function renderReports(target){reportBrowser.render(target);}
  let catalogNote={text:'',at:0};
  function renderCatalog(target,note){
    const panel=el('section','panel business-panel');target.append(panel);panel.append(el('h2','','Clients & Projects'));
    if(!enabled){panel.append(el('p','msg err','The updated backend is required.'));return;}
    // Clients are Odoo contacts and projects their Odoo projects, refreshed automatically; new ones are created in Odoo.
    const msg=el('p','msg'),sync=el('div','catalog-sync');sync.append(el('p','business-guidance','Clients are your Odoo contacts; projects are each contact’s Odoo projects. New contacts and projects in Odoo appear here automatically every few minutes.'),button('Sync from Odoo now',async e=>{const b=e.currentTarget;b.disabled=true;msg.className='msg';msg.textContent='Reading contacts and projects from Odoo…';try{const r=await api('/clients/odoo-sync?force=1',{method:'POST',body:{}});if(r.odoo===false){msg.textContent='Odoo is not connected.';return;}if(r.changed)await loadCatalog();const counts=(r.customers!=null?r.customers+' contacts, ':'')+r.projects+' projects',done=r.changed?r.added+' new from Odoo ('+counts+').':'Already up to date ('+counts+').';msg.textContent=done;if(r.changed){catalogNote={text:done,at:Date.now()};await onChange();if(target.isConnected){target.replaceChildren();renderCatalog(target,done);}}}catch(err){message(msg,err);}finally{b.disabled=false;}},'btn primary'));panel.append(sync,msg);{const n=note||(Date.now()-catalogNote.at<15000?catalogNote.text:'');if(n)msg.textContent=n;}
    // With Odoo connected, a new customer or project is created in Odoo itself (then synced here).
    if(odooOn){
      const forms=el('div','catalog-create');
      const customer=el('div','business-form'),cName=field(customer,'New contact name',input('text','')),cEmail=field(customer,'Email (optional)',input('email','')),cPhone=field(customer,'Phone (optional)',input('tel',''));
      customer.prepend(el('h3','','New contact in Odoo'));
      customer.append(button('Create contact',async e=>{const b=e.currentTarget;b.disabled=true;msg.className='msg';msg.textContent='Creating the contact in Odoo…';try{const r=await api('/clients/odoo/customer',{method:'POST',body:{name:cName.value,email:cEmail.value,phone:cPhone.value}});catalog=r.catalog;catalogNote={text:'Contact “'+cName.value.trim()+'” created in Odoo.',at:Date.now()};await onChange();target.replaceChildren();renderCatalog(target);}catch(err){message(msg,err);b.disabled=false;}},'btn primary'));
      const project=el('div','business-form'),pName=field(project,'New project name',input('text','')),pClient=field(project,'Contact',el('select','fsel'));
      option(pClient,'Choose contact…','');for(const c of clients().filter(c=>c.name!=='No contact'&&c.name!=='No customer').sort((a,b)=>a.name.localeCompare(b.name)))option(pClient,c.name,c.id);combobox(pClient);
      project.prepend(el('h3','','New project in Odoo'));
      project.append(button('Create project',async e=>{const b=e.currentTarget;b.disabled=true;msg.className='msg';msg.textContent='Creating the project in Odoo…';try{const r=await api('/clients/odoo/project',{method:'POST',body:{name:pName.value,clientId:pClient.value}});catalog=r.catalog;catalogNote={text:'Project “'+pName.value.trim()+'” created in Odoo.',at:Date.now()};await onChange();target.replaceChildren();renderCatalog(target);}catch(err){message(msg,err);b.disabled=false;}},'btn primary'));
      forms.append(customer,project);panel.append(forms);
    }else{
    const add=el('div','business-form'),name=field(add,'New client or project name',input('text','')),parent=field(add,'Parent (optional)',el('select','fsel'));option(parent,'Top-level client','');for(const c of clients())option(parent,c.name,c.id);add.append(button('Add',async()=>{try{catalog=await api('/clients',{method:'POST',body:{revision:catalog.revision,name:name.value,parentId:parent.value||null}});await onChange();target.replaceChildren();renderCatalog(target);}catch(err){message(msg,err);}}));panel.append(add);}
    for(const c of catalog.entries.filter(e=>!e.parentId).sort((a,b)=>a.name.localeCompare(b.name))){const group=el('details','catalog-group');group.append(el('summary','',c.name+(c.archived?' (archived)':'')));for(const e of [c,...catalog.entries.filter(e=>e.parentId===c.id)]){const row=el('div','catalog-entry'),nm=input('text',e.name);nm.setAttribute('aria-label','Name for '+e.name);row.append(nm,button('Rename',async()=>change(e,{name:nm.value})),button(e.archived?'Restore':'Archive',async()=>change(e,{archived:!e.archived})));group.append(row);}panel.append(group);}
    async function change(e,patch){try{catalog=await api('/clients',{method:'PUT',body:{revision:catalog.revision,id:e.id,...patch}});await onChange();target.replaceChildren();renderCatalog(target);}catch(err){message(msg,err);}}
  }
  return {configure:async cfg=>{reportBrowser.configure(cfg);odooOn=!!cfg.odoo;billingNeeded=cfg.billingRequired===true;enabled=cfg.capabilities?.includes('ticket-business-v1')===true;if(enabled){await loadCatalog();if(cfg.odoo)api('/clients/odoo-sync',{method:'POST',body:{}}).then(r=>{if(r.changed)return loadCatalog();}).catch(()=>{});}},enabled:()=>enabled,load,decorate,canQuickEdit,quickEdit,quickLabel:name=>QUICK[name],createFields,renderEditor,dirty:key=>editor?.key===key&&editor.dirty(),reset:()=>{editor=null;},bulk,ensureBilling,overrideReason,filters,matches,renderReports,renderCatalog,loadCatalog};
}
