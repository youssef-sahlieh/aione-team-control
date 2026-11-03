import {readTableFile,pickTable,rowsFromTable,importFieldsMapped,numberValue,TICKET_IMPORT_FIELDS} from '../models/table-import.js';
import {buildTemplate,errorsCsv} from '../models/report-workbook.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const button=(text,fn,cls='btn')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const CHUNK=300,MAX_ROWS=1500;
const XLSX='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export function download(name,parts,type){const url=URL.createObjectURL(new Blob(parts,{type})),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
const FIELD_KEYS=Object.keys(TICKET_IMPORT_FIELDS);
const show=v=>v==null||v===''?'—':String(v);
const listRows=lines=>lines.length<2?lines.join(''):lines.slice(0,-1).join(', ')+' and '+lines.at(-1);

// Import for the business fields (agreed hours, client, project, billing) from an Excel or CSV file, including the exported Tickets sheet.
// Nothing is saved until every row passes the preview; the server checks the rows again when applying.
export function importPanel({api,onApplied}){
 const box=el('details','report-import'),file=el('input'),out=el('div','report-import-out'),result=el('div','report-import-result');
 // Preview, apply and read messages all land in one persistent live region, so they are announced and survive mapping changes.
 result.setAttribute('role','status');result.setAttribute('aria-live','polite');
 let table=null,map=null,payload=null,verdict=null,generation=0;
 const tplErr=el('span','msg err');
 file.type='file';file.accept='.xlsx,.csv,text/csv,'+XLSX;file.setAttribute('aria-label','Spreadsheet to import');
 const apply=button('Apply changes',()=>runApply(),'btn primary');apply.disabled=true;
 const preview=button('Preview',()=>runPreview());
 const actions=el('div','report-import-actions');
 actions.append(button('Download template',async()=>{tplErr.textContent='';try{download('aion-ticket-import-template.xlsx',[await buildTemplate()],XLSX);}catch(err){tplErr.textContent=err.message||'Could not build the template.';}},'btn'),tplErr);
 box.append(el('summary','','Import from Excel or CSV'),
  el('p','msg','Update agreed hours, client, project and billing for many tickets at once. Use the Excel file from Export Excel (edit it and import it back), or a sheet with a Ticket column plus any of Agreed hours, Client, Project and Billing. Blank cells change nothing. Preview first: the file is applied only when every row is valid.'),
  file,actions,out,result);
 file.addEventListener('change',()=>{reset();if(file.files?.[0])void read();});
 function reset(){generation++;table=map=payload=verdict=null;apply.disabled=true;out.replaceChildren();result.replaceChildren();}
 async function read(){
  const g=generation;result.replaceChildren(el('p','msg','Reading the file…'));
  try{
   const {sheets}=await readTableFile(file.files[0]);
   if(g!==generation)return;
   table=pickTable(sheets,TICKET_IMPORT_FIELDS);
   if(!table)throw new Error('The file has no rows.');
   map={...table.map};mapping();
  }catch(err){if(g===generation)result.replaceChildren(el('p','msg err',err.message||'Could not read the file.'));}
 }
 // Two fields on one column would import the same values twice, so Preview stays off until each column is used once.
 function clash(){
  const seen=new Map();
  for(const key of FIELD_KEYS){const i=map[key];if(i<0)continue;if(seen.has(i))return {i,a:seen.get(i),b:key};seen.set(i,key);}
  return null;
 }
 function mapping(){
  out.replaceChildren();result.replaceChildren();
  out.append(el('p','msg','Using sheet “'+table.sheet+'”, header on row '+(table.headerRow+1)+'. Check that each column is matched to the right field.'));
  const grid=el('div','report-import-map'),conflict=el('p','msg err');conflict.id='report-import-clash';
  const check=()=>{const c=clash();conflict.textContent=c?'“'+show(table.headers[c.i]||'Column '+(c.i+1))+'” is chosen for both '+TICKET_IMPORT_FIELDS[c.a].label+' and '+TICKET_IMPORT_FIELDS[c.b].label+'. Choose a different column for one of them.':'';preview.disabled=!!c;};
  for(const key of FIELD_KEYS){
   const f=TICKET_IMPORT_FIELDS[key],label=el('label','business-field'),sel=el('select','fsel');
   sel.setAttribute('aria-label','Column for '+f.label);sel.append(new Option('(not in file)','-1'));
   table.headers.forEach((h,i)=>sel.append(new Option(h||'Column '+(i+1),String(i))));
   sel.value=String(map[key]??-1);
   sel.addEventListener('change',()=>{map[key]=Number(sel.value);generation++;verdict=payload=null;apply.disabled=true;result.replaceChildren();check();});
   label.append(el('span','',f.label+(f.required?' *':'')),sel);grid.append(label);
  }
  out.append(grid,conflict,preview,' ',apply);
  check();
 }
 function build(){
  if(map.key<0||map.key==null)throw new Error('Choose the column that holds the ticket key.');
  if(clash())throw new Error('Two fields use the same column. Choose a different column for one of them.');
  if(!importFieldsMapped(map).length)throw new Error('Match at least one of Agreed hours, Client, Project or Billing.');
  const {rows,truncated}=rowsFromTable(table,map,TICKET_IMPORT_FIELDS,{limit:MAX_ROWS});
  if(truncated)throw new Error('The file has more than '+MAX_ROWS+' rows. Split it and import it in parts.');
  if(!rows.length)throw new Error('No rows with data under the header.');
  const built=rows.map(({line,values:v})=>{const r={line,key:v.key};
   if(map.agreedHours>=0&&v.agreedHours!=='')r.agreedHours=numberValue(v.agreedHours)??v.agreedHours;
   for(const k of ['client','project','billing'])if(map[k]>=0&&v[k]!=='')r[k]=v[k];return r;});
  // Checked on the whole file, before chunking: a ticket on two chunks would otherwise be sent twice.
  const where=new Map();
  for(const r of built){const k=String(r.key).trim().toUpperCase();if(!k)continue;if(!where.has(k))where.set(k,{key:String(r.key).trim(),lines:[]});where.get(k).lines.push(r.line);}
  const dups=[...where.values()].filter(d=>d.lines.length>1);
  if(dups.length)throw new Error(dups.slice(0,5).map(d=>d.key+' is on rows '+listRows(d.lines)+'.').join(' ')+(dups.length>5?' Showing 5 of '+dups.length+' repeated tickets.':'')+' Each ticket may appear once.');
  return built;
 }
 async function runPreview(){
  const g=++generation;
  result.replaceChildren();apply.disabled=true;verdict=null;payload=null;
  try{payload=build();}catch(err){result.append(el('p','msg err',err.message));return;}
  const rows=payload;
  result.append(el('p','msg','Checking '+rows.length+' rows…'));
  try{
   const all=[];
   for(let i=0;i<rows.length;i+=CHUNK){const r=await api('/ticket-metadata/import/preview',{method:'POST',body:{rows:rows.slice(i,i+CHUNK)}});if(g!==generation)return;all.push(...r.rows);}
   if(g!==generation)return;
   verdict={rows:all,ok:all.filter(r=>r.status==='ok').length,unchanged:all.filter(r=>r.status==='unchanged').length,errors:all.filter(r=>r.status==='error').length};
   renderVerdict(g);
  }catch(err){if(g===generation)result.replaceChildren(el('p','msg err',err.message||'Could not preview the import.'));}
 }
 function renderVerdict(g){
  const v=verdict;result.replaceChildren(el('p','msg'+(v.errors?' err':''),v.ok+' rows will change · '+v.unchanged+' already match · '+v.errors+' with errors'+(v.errors?'. Fix the rows below and import the file again; nothing was saved.':'')));
  const shown=[...v.rows.filter(r=>r.status==='error'),...v.rows.filter(r=>r.status==='ok'),...v.rows.filter(r=>r.status==='unchanged')];
  const wrap=el('div','report-table-scroll'),t=el('table','workload-table'),head=t.createTHead().insertRow();
  t.createCaption().textContent='Import preview, errors first';
  for(const h of ['Row','Ticket','Result','Changes'])head.append(Object.assign(el('th','',h),{scope:'col'}));
  const body=t.createTBody();
  for(const r of shown.slice(0,200)){const tr=body.insertRow();
   tr.append(el('td','num',String(r.line??r.row)),el('td','',r.key||''),el('td',r.status==='error'?'msg err':'',r.status==='error'?r.message:r.status==='unchanged'?'No change':r.message||'Will change'),
    el('td','',(r.changes||[]).map(c=>({agreedHours:'Agreed hours',client:'Client',project:'Project',billing:'Billing'})[c.field]+': '+show(c.from)+' → '+show(c.to)).join('; ')));}
  wrap.append(t);result.append(wrap);
  if(shown.length>200)result.append(el('p','msg','Showing the first 200 of '+shown.length+' rows (errors first).'));
  if(v.errors)result.append(button('Download the rows with errors',()=>download('aion-import-errors.csv',[errorsCsv(v.rows.filter(r=>r.status==='error'))],'text/csv;charset=utf-8')));
  apply.disabled=!(payload&&g===generation&&v.ok>0&&v.errors===0);
 }
 async function runApply(){
  const rows=payload;if(!rows)return;
  apply.disabled=true;result.replaceChildren(el('p','msg','Applying…'));
  let applied=0,unchanged=0;const failed=[];
  try{
   for(let i=0;i<rows.length;i+=CHUNK){const r=await api('/ticket-metadata/import',{method:'POST',body:{rows:rows.slice(i,i+CHUNK)}});applied+=r.applied;unchanged+=r.unchanged;failed.push(...r.failed);}
   const p=el('p','msg'+(failed.length?' err':''),'Updated '+applied+' tickets'+(unchanged?'; '+unchanged+' already matched':'')+'.'+(failed.length?' Not saved: '+failed.map(f=>f.key+' ('+f.message+')').join('; ')+'.':''));
   file.value='';generation++;table=map=payload=verdict=null;out.replaceChildren();result.replaceChildren(p);onApplied?.(p.textContent);
  }catch(err){
   // An earlier chunk may already be saved; say what was saved so far rather than suggest nothing happened.
   const done=applied||unchanged||failed.length;
   result.replaceChildren(el('p','msg err',(done?'Before this stopped: '+applied+' tickets updated'+(unchanged?', '+unchanged+' already matched':'')+(failed.length?', '+failed.length+' not saved':'')+'. ':'')+(err.message||'Could not apply the import.')+(applied?' Preview the file again to see what is left.':'')));
   verdict=null;
  }
 }
 return box;
}
