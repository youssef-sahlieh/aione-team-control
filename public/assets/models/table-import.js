// Read-only table import: XLSX (ZIP + XML, cached values only, formulas are never run) and CSV into plain string tables.
const MAX_FILE=10*1024*1024,MAX_ENTRIES=500,MAX_ENTRY=20*1024*1024,MAX_TOTAL=40*1024*1024,MAX_ROWS=20000,MAX_COLS=200,DAY=86400000;
const XLSX_MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const INVALID='Invalid XLSX file.',LIMIT_MSG='Workbook expands beyond the import limit.',BAD_MSG='Unsupported or invalid workbook compression.',TOO_LARGE='Table is too large (max 20,000 rows and 200 columns).';
const NEEDED=/^xl\/(?:workbook\.xml|sharedStrings\.xml|styles\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/;
const ESC={lt:'<',gt:'>',quot:'"',apos:"'",amp:'&'};
const unescapeXml=s=>s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi,(m,e)=>{
  if(e[0]!=='#')return ESC[e.toLowerCase()];
  const n=e[1]==='x'||e[1]==='X'?parseInt(e.slice(2),16):Number(e.slice(1));
  return n<=0x10ffff?String.fromCodePoint(n):'';
});
const attr=(s,n)=>{const m=s.match(new RegExp(`\\b${n}="([^"]*)"`));return m?unescapeXml(m[1]):''};
const MAX_SHEETS=50;
// indexOf scan of <tag ...>body</tag> or <tag .../>; an open tag with no close tag throws INVALID, so unclosed input stays linear.
function* elements(xml,tag){
  const open='<'+tag,close='</'+tag+'>';let i=0;
  for(;;){
    i=xml.indexOf(open,i);
    if(i<0)return;
    const after=xml[i+open.length];
    if(after!==undefined&&!/[\s/>]/.test(after)){i+=open.length;continue}
    const gt=xml.indexOf('>',i);
    if(gt<0)throw new Error(INVALID);
    if(xml[gt-1]==='/'){yield {attrs:xml.slice(i+open.length,gt-1),body:'',start:i,end:gt+1};i=gt+1;continue}
    const end=xml.indexOf(close,gt+1);
    if(end<0)throw new Error(INVALID);
    yield {attrs:xml.slice(i+open.length,gt),body:xml.slice(gt+1,end),start:i,end:end+close.length};
    i=end+close.length;
  }
}
const first=(xml,tag)=>elements(xml,tag).next().value??null;
const richText=x=>{let s='',pos=0;for(const e of elements(x,'rPh')){s+=x.slice(pos,e.start);pos=e.end}s+=x.slice(pos);return [...elements(s,'t')].map(e=>unescapeXml(e.body)).join('')};
const colIndex=s=>[...s.toUpperCase()].reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0)-1;
const isDateFmt=(id,fmts)=>{const n=/^\d+$/.test(id)?Number(id):NaN;if((n>=14&&n<=22)||(n>=45&&n<=47))return true;const code=fmts.get(n)??'';return !/\[(?:h|m|s)+\]/i.test(code)&&/[dmyh]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g,''))};
function serialDate(text,is1904){
  const d=Math.floor(text.trim()===''?NaN:Number(text));
  if(!(d>=(is1904?0:1))||d>2958465||(!is1904&&d===60))return null;
  const ms=is1904?Date.UTC(1904,0,1)+d*DAY:Date.UTC(1899,11,31)+(d<60?d:d-1)*DAY;
  return new Date(ms).toISOString().slice(0,10);
}
function cellValue(a,body,{strings,dates,is1904}){
  const t=attr(a,'t'),v=unescapeXml(first(body,'v')?.body??'');
  if(t==='s')return v.trim()?strings[Number(v)]??'':'';
  if(t==='inlineStr')return richText(first(body,'is')?.body??'');
  if(t==='b')return v.trim()==='1'?'TRUE':v.trim()==='0'?'FALSE':'';
  if(t==='e')return '';
  if(t==='str')return v;
  if(t==='d')return /^\d{4}-\d{2}-\d{2}/.exec(v)?.[0]??'';
  if(dates[Number(attr(a,'s')||0)])return serialDate(v,is1904)??v;
  return v;
}
function sheetRows(xml,ctx){
  const grid=[];let width=0;
  for(const r of elements(xml,'row')){
    const rs=attr(r.attrs,'r'),rn=/^\d+$/.test(rs)?Number(rs):0;
    if(rn<1)throw new Error(INVALID);
    if(rn>MAX_ROWS){if(/<(?:v|t)\b/.test(r.body))throw new Error(TOO_LARGE);continue}
    while(grid.length<rn)grid.push([]);
    for(const c of elements(r.body,'c')){
      const ref=attr(c.attrs,'r').match(/^([A-Z]+)\d*$/i),ci=ref?colIndex(ref[1]):grid[rn-1].length,value=cellValue(c.attrs,c.body,ctx);
      if(!value)continue;
      if(ci>=MAX_COLS)throw new Error(TOO_LARGE);
      grid[rn-1][ci]=value;width=Math.max(width,ci+1);
    }
  }
  let last=grid.length;while(last>0&&!grid[last-1].length)last--;
  return grid.slice(0,last).map(row=>Array.from({length:width},(_,i)=>row[i]??''));
}
async function inflateRaw(bytes,limit){
  const chunks=[];let n=0;
  try{
    const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    let r=await reader.read();
    while(!r.done){n+=r.value.length;if(n>limit){await reader.cancel();throw new Error(LIMIT_MSG)}chunks.push(r.value);r=await reader.read()}
  }catch(err){throw err.message===LIMIT_MSG?err:new Error(BAD_MSG)}
  const out=new Uint8Array(n);let o=0;for(const c of chunks){out.set(c,o);o+=c.length}
  return out;
}
export async function readWorkbookTables(buffer,inflate=(bytes,size)=>inflateRaw(bytes,size)){
  if(buffer.byteLength>MAX_FILE)throw new Error('Choose a workbook under 10 MB.');
  const bytes=new Uint8Array(buffer),view=new DataView(buffer);
  const need=(p,n)=>{if(p<0||p+n>bytes.length)throw new Error(INVALID);return p};
  const u16=p=>view.getUint16(need(p,2),true),u32=p=>view.getUint32(need(p,4),true);
  let end=bytes.length-22;
  while(end>=Math.max(0,bytes.length-65557)&&u32(end)!==0x06054b50)end--;
  if(end<0)throw new Error(INVALID);
  const count=u16(end+10);
  if(count>MAX_ENTRIES)throw new Error('Workbook has too many ZIP entries.');
  let p=u32(end+16),total=0;const wanted=[];
  for(let i=0;i<count;i++){
    if(u32(p)!==0x02014b50)throw new Error('Invalid XLSX directory.');
    const e={flags:u16(p+8),method:u16(p+10),csize:u32(p+20),size:u32(p+24),off:u32(p+42)},nl=u16(p+28);
    e.name=new TextDecoder().decode(bytes.subarray(need(p+46,nl),p+46+nl));
    total+=e.size;if(total>MAX_TOTAL||e.size>MAX_ENTRY)throw new Error(LIMIT_MSG);
    if(NEEDED.test(e.name))wanted.push(e);
    p+=46+nl+u16(p+30)+u16(p+32);
  }
  const files={};
  for(const e of wanted){
    const lh=need(e.off,30);
    if(u32(lh)!==0x04034b50)throw new Error('Invalid XLSX directory.');
    if(e.flags&1)throw new Error('Encrypted workbooks are not supported.');
    const start=need(lh+30+u16(lh+26)+u16(lh+28),e.csize),part=bytes.subarray(start,start+e.csize);
    const data=e.method===0?part:e.method===8?await inflate(part,e.size):null;
    if(!data||data.length!==e.size)throw new Error(BAD_MSG);
    files[e.name]=new TextDecoder().decode(data);
  }
  const target=t=>t?(t.startsWith('/')?t.slice(1):'xl/'+t):'';
  const wb=files['xl/workbook.xml']||'',sx=files['xl/styles.xml']||'';
  const rels=new Map([...(files['xl/_rels/workbook.xml.rels']||'').matchAll(/<Relationship\b([^>]*)>/g)].map(m=>[attr(m[1],'Id'),target(attr(m[1],'Target'))]));
  const fmts=new Map([...sx.matchAll(/<numFmt\b([^>]*)>/g)].map(m=>[attr(m[1],'numFmtId'),attr(m[1],'formatCode')]).filter(([id])=>/^\d+$/.test(id)).map(([id,code])=>[Number(id),code]));
  const ctx={
    strings:[...elements(files['xl/sharedStrings.xml']||'','si')].map(e=>richText(e.body)),
    dates:[...(first(sx,'cellXfs')?.body??'').matchAll(/<xf\b([^>]*)>/g)].map(m=>isDateFmt(attr(m[1],'numFmtId'),fmts)),
    is1904:/^(?:1|true)$/.test(attr(wb.match(/<workbookPr\b([^>]*)>/)?.[1]??'','date1904'))
  };
  let defs=[...wb.matchAll(/<sheet\b([^>]*)>/g)].map((m,i)=>({name:attr(m[1],'name')||`Sheet${i+1}`,path:rels.get(attr(m[1],'r:id'))??'',hidden:/state="(?:hidden|veryHidden)"/.test(m[1])}));
  if(!defs.length)defs=Object.keys(files).filter(n=>n.startsWith('xl/worksheets/')).sort((a,b)=>a.localeCompare(b,'en',{numeric:true})).map((path,i)=>({name:`Sheet${i+1}`,path,hidden:false}));
  if(defs.length>MAX_SHEETS)throw new Error('Workbook has too many sheets (max 50).');
  const parsed=new Map();
  return defs.filter(d=>files[d.path]!==undefined).map(d=>{if(!parsed.has(d.path))parsed.set(d.path,sheetRows(files[d.path],ctx));return {name:d.name,hidden:d.hidden,rows:parsed.get(d.path)}}).sort((a,b)=>a.hidden-b.hidden).map(({name,rows})=>({name,rows}));
}
export function parseCsv(text){
  const s=String(text).replace(/^﻿/,''),first=s.split(/\r\n|\n|\r/,1)[0];
  const d=!first.includes(',')&&first.includes(';')?';':!first.includes(',')&&first.includes('\t')?'\t':',';
  const rows=[];let row=[],cell='',quoted=false;
  const put=()=>{if(row.length>=MAX_COLS)throw new Error(TOO_LARGE);row.push(cell);cell=''};
  const end=()=>{put();if(rows.length>=MAX_ROWS)throw new Error(TOO_LARGE);rows.push(row);row=[]};
  for(let i=0;i<s.length;i++){
    const c=s[i];
    if(quoted){if(c!=='"')cell+=c;else if(s[i+1]==='"'){cell+='"';i++}else quoted=false}
    else if(c==='"'&&cell==='')quoted=true;
    else if(c===d)put();
    else if(c==='\n'||c==='\r'){if(c==='\r'&&s[i+1]==='\n')i++;end()}
    else cell+=c;
  }
  if(s&&!/[\r\n]$/.test(s))end();
  return rows;
}
export async function readTableFile(file){
  const dot=(file.name||'').toLowerCase().match(/\.[^.]+$/)?.[0]||'';
  const kind=dot?{'.xlsx':'xlsx','.csv':'csv','.txt':'csv'}[dot]:file.type===XLSX_MIME?'xlsx':file.type==='text/csv'?'csv':'';
  if(!kind)throw new Error('Choose an Excel (.xlsx) or CSV file.');
  if(file.size>MAX_FILE)throw new Error('Choose a file under 10 MB.');
  if(kind==='xlsx')return {sheets:await readWorkbookTables(await file.arrayBuffer())};
  return {sheets:[{name:'CSV',rows:parseCsv(await file.text())}]};
}
export const norm=s=>String(s??'').replace(/:\s*$/,'').toLowerCase().replace(/[\s\-_\/.,;()]+/g,' ').trim();
export function detectColumns(headers,fields){
  const hn=headers.map(norm),names={},map={},claimed=new Set();
  for(const k in fields)names[k]=[...new Set([fields[k].label,...(fields[k].aliases||[])].map(norm).filter(Boolean))];
  for(const k in fields){
    const i=hn.findIndex((h,j)=>!claimed.has(j)&&names[k].includes(h));
    map[k]=i;if(i>=0)claimed.add(i);
  }
  for(const k in fields){
    if(map[k]>=0)continue;
    const free=[...hn.keys()].filter(j=>!claimed.has(j)&&hn[j]);
    const hits=free.filter(j=>names[k].some(n=>hn[j].startsWith(n)));
    if(hits.length===1){map[k]=hits[0];claimed.add(hits[0])}
  }
  return {map,missing:Object.keys(fields).filter(k=>fields[k].required&&map[k]<0)};
}
export function pickTable(sheets,fields){
  let best=null;
  for(const sheet of sheets)for(let r=0;r<Math.min(15,sheet.rows.length);r++){
    const {map,missing}=detectColumns(sheet.rows[r],fields),score=Object.values(map).filter(i=>i>=0).length,rank=(missing.length?0:1000)+score;
    if(!best||rank>best.rank)best={rank,table:{sheet:sheet.name,headerRow:r,headers:sheet.rows[r],map,missing,rows:sheet.rows}};
  }
  return best?.table??null;
}
export function rowsFromTable(table,map,fields,{limit=1000}={}){
  const rows=[];let skippedBlank=0,truncated=false;
  for(let i=(table.headerRow??0)+1;i<table.rows.length;i++){
    const row=table.rows[i]||[];
    if(!row.some(v=>String(v??'').trim())){skippedBlank++;continue}
    if(rows.length>=limit){truncated=true;break}
    const values={};for(const k in fields)values[k]=map[k]>=0?String(row[map[k]]??'').trim():'';
    rows.push({line:i+1,values});
  }
  return {rows,skippedBlank,truncated};
}
const KEY={label:'Ticket',aliases:['ticket key','key','issue','issue key','ticket id'],required:true};
const AGREED={label:'Agreed hours',aliases:['agreed','agreed h','hours agreed']};
export const AGREED_IMPORT_FIELDS={key:KEY,agreedHours:{...AGREED,required:true}};
export const TICKET_IMPORT_FIELDS={key:KEY,agreedHours:AGREED,client:{label:'Client',aliases:['customer','contact']},project:{label:'Project',aliases:['sub client','subclient','sub-client']},billing:{label:'Billing',aliases:['billing type','billable']}};
export function importFieldsMapped(map){
  return Object.keys(TICKET_IMPORT_FIELDS).filter(k=>k!=='key'&&map[k]>=0);
}
export function numberValue(text){
  let s=String(text??'').trim().replace(/\s*(?:hours?|hrs?|h)$/i,'').replace(/(?<=\d)[   ](?=\d{3}(?!\d))/g,'');
  if(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s))s=s.replace(/,/g,'');
  else if(/^\d{1,3}(\.\d{3})+,\d+$/.test(s))s=s.replace(/\./g,'').replace(',','.');
  else if(/^\d+,\d+$/.test(s))s=s.replace(',','.');
  if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(s))return null;
  const n=Number(s);return Number.isFinite(n)?n:null;
}
