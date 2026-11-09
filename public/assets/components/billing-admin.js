// Billing for administrators (billing-v1): Billing setup, Allowances & alerts, the billable export, a project's default
// and the billing section of a ticket. Every figure here comes from the backend, which checks the administrator again;
// the page never chooses email recipients or sends mail itself.
import { KIND_LABEL, EFFECTIVE_LABEL, SOURCE_LABEL, SYNC_LABEL, minutesText, csvText, entryCsvRows, taskCsvRows, allowanceText } from '../models/billing.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const button=(text,fn,cls='btn')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const field=(parent,label,node)=>{const l=el('label','business-field');node.setAttribute('aria-label',label);l.append(el('span','',label),node);parent.append(l);return node;};
const option=(select,label,value)=>select.append(new Option(label,value));
const input=(type,value)=>{const n=el('input','inp');n.type=type;n.value=value??'';return n;};
const check=(parent,label,checked)=>{const l=el('label','business-field billing-check'),c=el('input');c.type='checkbox';c.checked=!!checked;l.append(c,el('span','',label));parent.append(l);return c;};
const when=t=>t?new Date(t).toLocaleString('en-GB',{timeZone:'Asia/Jerusalem',dateStyle:'medium',timeStyle:'short'}):'never';
const who=b=>b?.name||b?.email||'System';
const toMinutes=v=>v===''||v==null?null:Math.round(Number(v)*60);
const toHours=m=>m==null?'':String(Math.round(m/60*100)/100);
// A small table: headers, then rows of text or nodes.
function table(headers,rows){
  const wrap=el('div','table-wrap'),t=el('table','budget-table billing-table'),head=el('tr'),body=el('tbody');
  for(const h of headers){const th=el('th','',h);th.scope='col';head.append(th);}
  for(const r of rows){const tr=el('tr');for(const c of r){const td=el('td');if(c instanceof Node)td.append(c);else td.textContent=c??'';tr.append(td);}body.append(tr);}
  t.append(el('thead'),body);t.tHead.append(head);wrap.append(t);return wrap;
}
function download(name,rows){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csvText(rows)],{type:'text/csv'}));a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
const today=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Jerusalem'});
const STATUS_TEXT={available:'Available',near:'Near limit',exhausted:'Exhausted',overage:'Over allocation',unlimited:'Unlimited',no_allocation:'No allocation',disabled:'Disabled'};
const MAIL_MODE={off:'Off',dry:'Dry run: alerts are recorded, never sent',live:'On: alerts are sent'};

export function createBillingAdmin({api,dialog,openIssue}){
  const closeTo=(d,opener)=>{d.classList.add('business-dialog-wide');d.addEventListener('close',()=>{if(opener?.isConnected)opener.focus();});};
  const sayer=msg=>(text,err)=>{msg.className=err?'msg err':'msg';msg.textContent=text||'';};

  // ---- Billing setup: the switches, the Odoo fields (chosen from what Odoo reports), the quotation link, the rollout ----
  function setupDialog(opener){
    const {d,body,msg}=dialog('Billing setup');closeTo(d,opener);const say=sayer(msg);
    async function draw(){
      say('Loading…');let s;try{s=await api('/billing/setup');}catch(e){say(e.message,true);return;}
      say('');body.replaceChildren();const c=s.config;
      const sw=el('fieldset','business-section');sw.append(el('legend','','Switches'));body.append(sw);
      const cls=check(sw,'Billing classification: Inherit / Billable / Not billable on tickets, allowances and the billable export',c.classification);
      const emails=field(sw,'Allocation-exhausted emails',el('select','fsel'));for(const [v,l] of [['off','Off'],['dry','Dry run (recorded, never sent)'],['on','On (sent)']])option(emails,l,v);emails.value=c.emails;
      const m=s.mail,mail=el('div','billing-mail');sw.append(mail);
      mail.append(el('p','business-guidance','Now: '+MAIL_MODE[m.mode]+(m.reason?' — '+m.reason:'')+'.'),
        el('p','business-guidance','Recipients (server setting NO_DEVELOPER_NOTIFY_TO): '+(m.recipients.length?m.recipients.join(', '):'none')+(m.recipientsOk?'':' — '+m.recipientsProblem)),
        el('p','business-guidance','Server switch BILLING_ALERT_MAIL: '+(m.serverSwitch?'on':'off — emails stay a dry run until it is on in the deployment.')));
      const fs=el('fieldset','business-section');fs.append(el('legend','','Odoo fields'));body.append(fs);
      const picks={};
      if(!s.odoo)fs.append(el('p','business-guidance','Odoo is not connected. Billing works in the dashboard; nothing is saved on Odoo projects or tasks.'));
      else if(s.error)fs.append(el('p','msg err',s.error));
      else for(const [role,title,allowed] of [['project','Project default field',['billable','not_billable']],['task','Task override field',['inherit','billable','not_billable']]]){
        const list=s.candidates?.[role]||[],sel=field(fs,title,el('select','fsel')),map=el('div','billing-map');fs.append(map);
        option(sel,'Not saved in Odoo','');for(const f of list)option(sel,f.label+' ('+f.name+', '+f.type+')',f.name);
        if(c.fields[role]&&!list.some(f=>f.name===c.fields[role]))option(sel,c.fields[role]+' (not found in Odoo)',c.fields[role]);
        sel.value=c.fields[role]||'';const values={};
        const drawMap=()=>{map.replaceChildren();for(const k in values)delete values[k];const f=list.find(x=>x.name===sel.value);if(!f)return;
          if(f.type==='boolean'){map.append(el('p','business-guidance','Checked = Billable, unchecked = Not billable.'));return;}
          for(const o of f.selection){const v=field(map,'Odoo value “'+o.label+'” means',el('select','fsel'));option(v,'Not used','');for(const a of allowed)option(v,a==='inherit'?'Inherit':EFFECTIVE_LABEL[a],a);
            v.value=sel.value===c.fields[role]?c.values[role]?.[o.value]||'':'';const set=()=>{if(v.value)values[o.value]=v.value;else delete values[o.value];};v.addEventListener('change',set);set();}};
        sel.addEventListener('change',drawMap);drawMap();picks[role]={sel,values};
      }
      if(s.odoo&&!s.error)fs.append(el('p','business-guidance','Only editable boolean or selection fields that look like billing fields (custom x_ fields, or “bill” in the name) are offered. Nothing is created in Odoo.'));
      const qs=el('fieldset','business-section');qs.append(el('legend','','Quotation link'));body.append(qs);
      const q=field(qs,'Prepare quotation link',input('url',c.quotationUrl));q.placeholder=s.quotationDefault;
      qs.append(el('p','business-guidance','Empty uses the Odoo quotations list. A custom link must start with the Odoo address and contain {partner_id}. The link only opens Odoo; it creates nothing.'));
      const save=button('Save billing setup',async()=>{
        const next={revision:c.revision,classification:cls.checked,emails:emails.value,quotationUrl:q.value.trim()};
        if(picks.project||picks.task){const fields={project:picks.project?.sel.value??c.fields.project,task:picks.task?.sel.value??c.fields.task},values={project:{...(picks.project?.values||c.values.project)},task:{...(picks.task?.values||c.values.task)}};
          if(JSON.stringify(fields)!==JSON.stringify(c.fields)||JSON.stringify(values)!==JSON.stringify(c.values)){next.fields=fields;next.values=values;}}
        if(next.emails==='on'&&c.emails!=='on'&&!confirm('Exhausted-allocation emails will go to '+(m.recipients.join(', ')||'the configured recipients')+' when the server switch is on. Allocations already exhausted stay backlog and are not emailed. Continue?'))return;
        save.disabled=true;say('Saving…');
        try{await api('/billing/setup',{method:'PUT',body:next});await draw();say('Billing setup saved.');}catch(e){say(e.message,true);save.disabled=false;}
      },'btn primary');
      body.append(save);
      const ro=el('section','billing-rollout');ro.append(el('h3','','Rollout'));body.append(ro);
      const out=el('div');
      ro.append(el('p','business-guidance','Preview what classification would show from the data as it is now, then switch it on. Emails start as a dry run; allocations already exhausted when first seen are kept as backlog.'),
        button('Preview switching on',async e=>{const b=e.currentTarget;b.disabled=true;try{showMigration(out,await api('/billing/migration'));}catch(err){out.replaceChildren(el('p','msg err',err.message));}b.disabled=false;}),
        button('Check Odoo now',async e=>{const b=e.currentTarget;b.disabled=true;out.replaceChildren(el('p','msg','Checking Odoo and allowances…'));try{showScan(out,await api('/billing/scan',{method:'POST',body:{}}));}catch(err){out.replaceChildren(el('p','msg err',err.message));}b.disabled=false;}),out);
      api('/billing/scan').then(r=>{if(r.scan&&!out.childNodes.length)out.append(lastScan(r.scan));}).catch(()=>{});
    }
    draw();
  }
  function showMigration(out,m){
    out.replaceChildren(el('h4','','If classification were on'));
    const facts=el('dl','budget-facts');
    for(const [k,v] of [['Projects with a default',m.projects.classified+' of '+m.projects.active+' active'],['Tickets set Billable',String(m.ticketOverrides.billable)],['Tickets set Not billable',String(m.ticketOverrides.not_billable)],['Tickets inheriting',String(m.ticketOverrides.inherit)],
      ['Work, last 90 days',minutesText(m.last90Days.actualMinutes)],['Of it billable',minutesText(m.last90Days.billableMinutes)],['Of it not classified',minutesText(m.last90Days.unclassifiedMinutes)]])facts.append(el('dt','',k),el('dd','',v));
    out.append(facts);
    if(m.projects.unclassified.length){const d=el('details');d.append(el('summary','','Active projects without a default ('+m.projects.unclassified.length+')'),el('p','budget-keys',m.projects.unclassified.map(p=>p.label).join(', ')));out.append(d);}
  }
  const lastScan=s=>el('p','business-guidance','Last Odoo check '+when(s.at)+(s.complete===false?' — incomplete ('+s.read+' of '+s.total+' lines)':'')+(s.error?' — failed: '+s.error.message:''));
  function showScan(out,r){
    out.replaceChildren();
    if(r.skipped){out.append(el('p','msg',r.skipped));return;}
    const a=r.alerts||{},parts=['Odoo: '+(r.odoo?r.odoo.error?'failed — '+r.odoo.error:(r.odoo.complete?'complete':'incomplete')+' ('+r.odoo.read+' of '+r.odoo.total+' lines)':'not connected'),
      'Ledgers: '+(r.ledgers?r.ledgers.reconciled+' of '+r.ledgers.tickets+' tickets brought up to date':'—'),'Emails: '+(MAIL_MODE[r.mail]||r.mail),
      'Alerts: '+([['created','new'],['queued','queued'],['dryRun','dry run'],['backlog','backlog']].filter(([k])=>a[k]).map(([k,l])=>a[k]+' '+l).join(', ')||'none new'),'Sent '+(r.sent||0)+', failed '+(r.failed||0)+', uncertain '+((r.uncertainNow||0)+(r.uncertain||0))];
    for(const p of parts)out.append(el('p','business-guidance',p));
  }

  // ---- Allowances & alerts ----
  function allowancesDialog(opener,projectList){
    const {d,body,msg}=dialog('Allowances & alerts');closeTo(d,opener);const say=sayer(msg);let doc=null;
    async function draw(note){
      say('Loading…');let alerts;
      try{[doc,alerts]=await Promise.all([api('/billing/allowances'),api('/billing/alerts')]);}catch(e){say(e.message,true);return;}
      say(note||'');body.replaceChildren();
      const head=el('div','billing-head');head.append(el('p','business-guidance','Emails: '+MAIL_MODE[alerts.mail.mode]+(alerts.mail.reason?' — '+alerts.mail.reason:'')+'.'),button('+ New allowance',()=>form(null),'btn primary'));body.append(head);
      const editor=el('div','billing-editor');body.append(editor);
      const names=Object.fromEntries(doc.items.map(a=>[a.id,a.label||a.projects.map(p=>p.label).join(', ')]));
      if(!doc.items.length)body.append(el('p','business-guidance','No allowances yet. Without one, billable work is exported as time & materials with no allocation.'));
      else body.append(table(['Allowance','Customer','Projects','Kind','Period','Used','Status',''],doc.items.map(a=>{
        const acts=el('div','budget-actions');acts.append(button('Edit',()=>form(a)));if(a.capacityMinutes!=null)acts.append(button('Top up',()=>topUp(a)));
        const hist=el('details');hist.append(el('summary','','History'));for(const h of [...(a.history||[])].reverse())hist.append(el('div','business-history-entry',when(h.at)+' · '+who(h.by)+' · '+h.type+(h.minutes?' '+minutesText(h.minutes):'')+(h.reference?' ('+h.reference+')':'')+(h.changes?' · '+Object.keys(h.changes).join(', '):'')));acts.append(hist);
        return [names[a.id],a.customer?.name||'—',a.projects.map(p=>p.label).join(', '),a.kindLabel,a.startDate+' → '+(a.endDate||'open'),allowanceText(a),STATUS_TEXT[a.status]||a.status,acts];})));
      body.append(el('h3','','Alerts'));
      if(!alerts.items.length)body.append(el('p','business-guidance','No exhausted-allocation alerts yet.'));
      else body.append(table(['Created','Allowance','Cycle','Status','Recipients','Delivery',''],alerts.items.map(e=>{
        const acts=el('div','budget-actions');
        if(['queued','backlog','dry_run','failed','uncertain'].includes(e.status))acts.append(button('Send',async ev=>{
          if(!confirm(e.status==='uncertain'?'This alert may already have been delivered. Send it again to '+e.to.join(', ')+'?':'Send this alert to '+(e.to||[]).join(', ')+' now?'))return;
          ev.currentTarget.disabled=true;try{const r=await api('/billing/alerts/send',{method:'POST',body:{id:e.id}});await draw('Alert '+r.alert.statusLabel.toLowerCase()+'.');}catch(err){await draw();say(err.message,true);}}));
        if(e.status==='uncertain')for(const [label,outcome] of [['It was sent','sent'],['It was not sent','not_sent']])acts.append(button(label,async()=>{try{await api('/billing/alerts/resolve',{method:'POST',body:{id:e.id,outcome}});await draw('Alert settled.');}catch(err){say(err.message,true);}}));
        const s=e.snapshot||{};
        return [when(e.createdAt),names[e.allowanceId]||e.allowanceId,String(e.cycle),e.statusLabel,(e.to||[]).join(', '),(e.sentAt?'Sent '+when(e.sentAt):'')+(e.attempts?' · '+e.attempts+' attempt'+(e.attempts===1?'':'s'):'')+(e.errors?.length?' · '+e.errors[e.errors.length-1].message:'')+(s.consumedMinutes!=null?' · '+minutesText(s.consumedMinutes)+' of '+minutesText(s.capacityMinutes):'')+(e.resolvedBy?' · settled by '+who(e.resolvedBy):''),acts];})));
      // New or edited allowance.
      function form(a){
        editor.replaceChildren();const box=el('fieldset','business-section');box.append(el('legend','',a?'Edit allowance':'New allowance'));editor.append(box);
        const label=field(box,'Name',input('text',a?.label));label.maxLength=120;
        const kind=field(box,'Kind',el('select','fsel'));for(const [k,l] of Object.entries(KIND_LABEL))option(kind,l,k);kind.value=a?.kind||'package';
        const projects=field(box,'Odoo projects (one, or several for a shared pool of one customer)',el('select','fsel'));projects.multiple=true;projects.size=8;
        const list=[...projectList()];for(const p of a?.projects||[])if(!list.some(x=>x.id===p.id))list.push({id:p.id,label:p.label});
        for(const p of list){const o=new Option(p.label,p.id);o.selected=!!a?.projectIds.includes(p.id);projects.append(o);}
        const start=field(box,'Start date (consumption counts from it)',input('date',a?.startDate||today())),end=field(box,'End date (optional)',input('date',a?.endDate||''));
        const hours=field(box,'Allocated hours',input('number',toHours(a?.minutes)));hours.min='0';hours.step='0.25';
        const opening=field(box,'Already used before the start date (hours)',input('number',toHours(a?.openingMinutes||0)));opening.min='0';opening.step='0.25';
        const line=field(box,'Odoo sales order line ID (optional)',input('number',a?.saleOrderLineId??''));line.min='1';line.step='1';
        const enabled=check(box,'Enabled',a?a.enabled:true);
        const capped=()=>{const on=['package','estimate','fixed_fee'].includes(kind.value);hours.closest('label').hidden=!on;opening.closest('label').hidden=!on;};kind.addEventListener('change',capped);capped();
        const save=button(a?'Save allowance':'Create allowance',async()=>{
          const capped=['package','estimate','fixed_fee'].includes(kind.value);
          const b={revision:doc.revision,label:label.value.trim(),kind:kind.value,projectIds:[...projects.selectedOptions].map(o=>Number(o.value)),startDate:start.value,endDate:end.value||null,enabled:enabled.checked,saleOrderLineId:line.value?Number(line.value):null};
          if(capped){b.minutes=toMinutes(hours.value);b.openingMinutes=toMinutes(opening.value)||0;}
          if(a)b.id=a.id;
          save.disabled=true;try{await api('/billing/allowances',{method:a?'PUT':'POST',body:b});await draw(a?'Allowance saved.':'Allowance created.');}catch(e){say(e.message,true);save.disabled=false;}
        },'btn primary');
        editor.append(save,button('Cancel',()=>editor.replaceChildren()));label.focus();
      }
      // A top-up counts only once the customer confirmed it: a confirmed Odoo sales order line, or a confirmation recorded here.
      function topUp(a){
        editor.replaceChildren();const box=el('fieldset','business-section');box.append(el('legend','','Top up “'+names[a.id]+'”'));editor.append(box);
        const hours=field(box,'Hours added',input('number',''));hours.min='0.25';hours.step='0.25';
        const line=field(box,'Confirmed Odoo sales order line ID',input('number',''));line.min='1';line.step='1';
        const confirmed=check(box,'No order line: the customer confirmed these hours',false),ref=field(box,'Reference of the confirmation',input('text',''));ref.maxLength=200;
        box.append(el('p','business-guidance','Draft or sent quotations add nothing. Hours over the allocation carry into the top-up; an exhausted package gets a new alert cycle once hours are available again.'));
        const save=button('Add hours',async()=>{
          const b={id:a.id,revision:doc.revision,minutes:toMinutes(hours.value)};if(line.value)b.saleOrderLineId=Number(line.value);else{b.confirmed=confirmed.checked;b.reference=ref.value.trim();}
          save.disabled=true;try{const r=await api('/billing/allowances/top-up',{method:'POST',body:b});await draw('Hours added.'+(r.rearmed?' The exhausted alert is re-armed.':''));}catch(e){say(e.message,true);save.disabled=false;}
        },'btn primary');
        editor.append(save,button('Cancel',()=>editor.replaceChildren()));hours.focus();
      }
    }
    draw();
  }

  // ---- Billable export: preview with its exceptions, task summary and entry detail, CSV, finalize, batches ----
  function exportDialog(opener,projectList){
    const {d,body,msg}=dialog('Billable export');closeTo(d,opener);const say=sayer(msg);
    const t=today(),first=t.slice(0,8)+'01';
    const bar=el('div','business-section billing-filters');body.append(bar);
    const from=field(bar,'From',input('date',first)),to=field(bar,'To',input('date',t));
    const billing=field(bar,'Billing',el('select','fsel'));for(const [v,l] of [['billable','Billable'],['not_billable','Not billable'],['unclassified','Not classified'],['all','All work']])option(billing,l,v);
    const state=field(bar,'Export state',el('select','fsel'));for(const [v,l] of [['pending','Not exported yet (new and adjustments)'],['exported','Exported'],['all','All']])option(state,l,v);
    const customer=field(bar,'Customer',input('text',''));customer.placeholder='All customers';
    const project=field(bar,'Project',el('select','fsel'));option(project,'All projects','');for(const p of projectList())option(project,p.label,p.id);
    const source=field(bar,'Source',el('select','fsel'));for(const [v,l] of [['','All tickets'],['jira','Jira'],['internal','Internal'],['odoo','Helpdesk']])option(source,l,v);
    const coverage=field(bar,'Coverage',el('select','fsel'));for(const [v,l] of [['','Any coverage'],['covered','Covered'],['partial','Partly covered'],['overage','Over allocation'],['t_and_m','Time & materials'],['no_allowance','No allocation'],['ambiguous','Several allowances']])option(coverage,l,v);
    const out=el('div','billing-export'),batchBox=el('div','billing-batches');
    body.append(button('Preview',()=>preview(),'btn primary'),el('p','business-guidance','Dates are in Asia/Jerusalem time. Amounts are whole minutes. Finalizing records every charge so a later export never charges it again; corrections come out as adjustments.'),out,el('h3','','Finalized batches'),batchBox);
    const filters=()=>({from:from.value,to:to.value,customer:customer.value.trim(),project:project.value,source:source.value});
    let last=null,view='tasks';
    async function preview(){
      say('Reading billable work…');out.replaceChildren();
      const f=filters(),qs=new URLSearchParams({...f,billing:billing.value,exportState:state.value,coverage:coverage.value});
      try{last={filters:f,data:await api('/billing/export/preview?'+qs)};}catch(e){say(e.message,true);return;}
      say('');drawPreview();
    }
    function drawPreview(){
      const r=last.data;out.replaceChildren();
      const facts=el('dl','budget-facts');for(const [k,v] of [['Rows',String(r.totals.rows)],['Actual',minutesText(r.totals.actualMinutes)],['Chargeable',minutesText(r.totals.chargeableMinutes)],['Change since last export',minutesText(r.totals.deltaMinutes)],['Ready to finalize',String(r.finalizable)]])facts.append(el('dt','',k),el('dd','',v));out.append(facts);
      if(r.exceptions.length){
        out.append(el('h4','','Exceptions to settle before finalizing ('+r.exceptions.length+')'));const ul=el('ul','billing-exceptions');
        for(const x of r.exceptions){const li=el('li','msg err',x.message||x.kind);
          if(x.ticket)li.append(' ',button('Open '+x.ticket,()=>{d.close();openIssue(x.ticket);},'linkbtn'));
          if(x.kind==='odoo_direct'&&x.lineId)li.append(' ',button('Acknowledge',async()=>{const reason=prompt('Why is Odoo line #'+x.lineId+' fine as it is?');if(!reason)return;try{await api('/billing/scan/acknowledge',{method:'POST',body:{lineIds:[x.lineId],reason}});await preview();}catch(e){say(e.message,true);}},'linkbtn'));
          ul.append(li);}
        out.append(ul);
      }
      for(const w of r.warnings)out.append(el('p','business-guidance',w.message));
      const tabs=el('div','billing-tabs');for(const [v,l] of [['tasks','Task summary'],['entries','Entry detail']]){const b=button(l,()=>{view=v;drawPreview();},'btn'+(view===v?' primary':''));b.setAttribute('aria-pressed',String(view===v));tabs.append(b);}
      tabs.append(button('Download entries CSV',()=>download('billable-entries-'+last.filters.from+'-'+last.filters.to+'.csv',entryCsvRows(r.rows))),button('Download task summary CSV',()=>download('billable-tasks-'+last.filters.from+'-'+last.filters.to+'.csv',taskCsvRows(r.tasks))));
      const fin=button('Finalize batch',()=>finalize(),'btn primary');fin.disabled=!!r.exceptions.length||!r.finalizable;fin.title=r.exceptions.length?'Settle the exceptions first.':!r.finalizable?'Nothing new to finalize.':'';tabs.append(fin);
      out.append(tabs);
      out.append(view==='tasks'?table(['Ticket','Title','Customer','Project','Odoo task','Rows','Actual','Chargeable','Change','Origin','Coverage'],r.tasks.map(x=>[x.ticket,x.title,x.customer,x.project,x.taskId?'#'+x.taskId:'—',String(x.entries),minutesText(x.actualMinutes),minutesText(x.chargeableMinutes),minutesText(x.deltaMinutes),x.origins,x.coverage])):
        table(['Date','Ticket','Worker','Description','Actual','Chargeable','Exported','Change','Billing','Origin','Coverage','State'],r.rows.map(x=>[x.date,x.ticket,x.worker,x.description,minutesText(x.actualMinutes),minutesText(x.chargeableMinutes),minutesText(x.exportedMinutes),minutesText(x.deltaMinutes),(EFFECTIVE_LABEL[x.billing.value]||'')+' ('+(SOURCE_LABEL[x.billing.source]||x.billing.source)+')',x.originLabel,x.coverageLabel,x.syncLabel+' · '+x.exportState])));
    }
    // Finalize the billable charges of the previewed filters; the backend refuses if anything changed since the preview.
    async function finalize(){
      const r=last.data;if(!confirm('Finalize '+r.finalizable+' charges ('+last.filters.from+' to '+last.filters.to+')? They will not be charged again by later exports.'))return;
      say('Finalizing…');
      try{const {batch}=await api('/billing/export/finalize',{method:'POST',body:{...last.filters,project:last.filters.project?Number(last.filters.project):null,fingerprint:r.fingerprint}});
        say('Batch '+batch.id+' finalized: '+batch.totals.rows+' rows, '+minutesText(batch.totals.deltaMinutes)+'.');download('billable-'+batch.id+'.csv',entryCsvRows(batch.rows,{batchId:batch.id}));await batches();await preview();say('Batch '+batch.id+' finalized and downloaded.');}
      catch(e){say(e.message,true);}
    }
    async function batches(){
      let r;try{r=await api('/billing/export/batches');}catch(e){batchBox.replaceChildren(el('p','msg err',e.message));return;}
      if(!r.items.length){batchBox.replaceChildren(el('p','business-guidance','None yet.'));return;}
      batchBox.replaceChildren(table(['Batch','Finalized','By','Period','Rows','Change',''],r.items.map(b=>[b.id,when(b.createdAt),who(b.by),b.query.from+' → '+b.query.to,String(b.totals.rows),minutesText(b.totals.deltaMinutes)+(b.status!=='final'?' (incomplete)':''),
        button('CSV',async()=>{try{const {batch}=await api('/billing/export/batch?id='+encodeURIComponent(b.id));download('billable-'+batch.id+'.csv',entryCsvRows(batch.rows,{batchId:batch.id}));}catch(e){say(e.message,true);}})])));
    }
    batches();
  }

  // ---- A project's billing default (from the Clients row) ----
  async function setProjectDefault(odooId,value){
    const cur=await api('/billing/projects');
    return api('/billing/projects',{method:'PUT',body:{revision:cur.revision,odooId,billing:value||null}});
  }

  // ---- The ticket's billing: the override, its effective value and source, the allowance and the Odoo sync ----
  async function ticketSection(target,key,{closed=false}={}){
    const box=el('fieldset','business-section billing-ticket');box.append(el('legend','','Billing (administrators only)'));target.append(box);
    const msg=el('p','msg','Loading billing…');box.append(msg);const say=sayer(msg);
    let v;try{v=await api('/billing/ticket?key='+encodeURIComponent(key));}catch(e){say(e.message,true);return;}
    box.replaceChildren(box.firstChild);
    if(!v.classification)box.append(el('p','business-guidance','Billing classification is off (Clients & Projects → More → Billing setup). The choice is kept and used once it is on.'));
    const choice=field(box,'Billing',el('select','fsel'));for(const [val,l] of [['inherit','Inherit from the project'],['billable','Billable'],['not_billable','Not billable']])option(choice,l,val);choice.value=v.override||'inherit';choice.disabled=closed;
    const allowance=field(box,'Allowance',el('select','fsel'));option(allowance,'Automatic (by project and date)','');
    for(const a of v.allowances)option(allowance,(a.label||a.id)+' · '+KIND_LABEL[a.kind]+(a.onProject?'':' (other project)'),a.id);allowance.value=v.allowanceId||'';allowance.disabled=closed;
    const e=v.effective,facts=el('dl','budget-facts');
    for(const [k,val] of [['Effective',EFFECTIVE_LABEL[e.value]+' — '+(SOURCE_LABEL[e.source]||e.source)],['Project',v.project?v.project.label+' (default: '+(v.project.billing?EFFECTIVE_LABEL[v.project.billing]:'not set')+')':'No Odoo project'],
      ['Agreed hours',v.agreedHours==null?'None: actual billable work counts':v.agreedHours+' h (consumed once, whatever the actual time)'],['Consumes',minutesText(v.ledger.consumedMinutes)],
      ['Odoo',(SYNC_LABEL[v.odooSync.state]||v.odooSync.state)+(v.odooSync.at?' · '+when(v.odooSync.at):'')+(v.odooSync.error?' — '+v.odooSync.error:'')]])facts.append(el('dt','',k),el('dd','',val));
    box.append(facts);
    if(v.ledger.events.length||v.history.length){const h=el('details','billing-ledger');h.append(el('summary','','Consumption & billing history'));
      for(const x of [...v.ledger.events].reverse())h.append(el('div','business-history-entry',when(x.at)+' · '+(x.reason||x.type)+': '+minutesText(x.from)+' → '+minutesText(x.to)+' ('+(x.delta>0?'+':'')+minutesText(x.delta)+')'));
      for(const x of [...v.history].reverse())h.append(el('div','business-history-entry',when(x.at)+' · '+who(x.by)+' · '+Object.entries(x.changes).map(([k,c])=>k+': '+(c.from??'inherit')+' → '+(c.to??'inherit')).join(', ')));
      box.append(h);}
    if(closed)return;
    const status=el('p','msg'),save=button('Save billing',async()=>{
      const b={key,revision:v.revision};if(choice.value!==(v.override||'inherit'))b.billing=choice.value;if((allowance.value||null)!==(v.allowanceId||null))b.allowanceId=allowance.value||null;
      if(!('billing' in b)&&!('allowanceId' in b)){status.className='msg';status.textContent='Nothing changed.';return;}
      save.disabled=true;try{await api('/billing/ticket',{method:'PUT',body:b});target.replaceChildren();await ticketSection(target,key,{closed});}catch(err){status.className='msg err';status.textContent=err.message;save.disabled=false;}
    },'btn');
    box.append(save,status);
  }
  return {setupDialog,allowancesDialog,exportDialog,setProjectDefault,ticketSection};
}
