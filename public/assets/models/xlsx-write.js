// Dependency-free XLSX writer. Cells are inline strings and formulas are never written.
const enc=new TextEncoder();
const MAX_SHEETS=20,MAX_ROWS=200000,MAX_CELL=32000,MAX_COLS=16384,MAX_BYTES=200*1024*1024;
const ILLEGAL=/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const ESC={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;','\r':'&#13;'};
const esc=s=>s.replace(/[&<>"'\r]/g,c=>ESC[c]);
const text=v=>{let s=String(v).replace(ILLEGAL,'');if(s.length>MAX_CELL){s=s.slice(0,MAX_CELL);if(/[\uD800-\uDBFF]$/.test(s))s=s.slice(0,-1);}return s;};
const letters=i=>{let s='';for(i++;i>0;i=Math.floor((i-1)/26))s=String.fromCharCode(65+(i-1)%26)+s;return s;};
const serial=s=>{
  const m=typeof s==='string'&&/^(\d{4})-(\d{2})-(\d{2})$/.exec(s);if(!m)return null;
  const y=+m[1],mo=+m[2],d=+m[3],t=Date.UTC(y,mo-1,d),dt=new Date(t);
  if(y<1900||dt.getUTCFullYear()!==y||dt.getUTCMonth()!==mo-1||dt.getUTCDate()!==d)return null;
  return (t-Date.UTC(1899,11,30))/864e5;
};
const sheetName=(raw,used)=>{
  const base=String(raw??'').replace(/[\x00-\x1F[\]:*?\/\\]/g,'').trim().slice(0,31).replace(/^['\s]+|['\s]+$/g,'')||'Sheet';
  let name=base,n=2;
  while(used.has(name.toLowerCase())){const suffix=' '+n++;name=base.slice(0,31-suffix.length)+suffix;}
  used.add(name.toLowerCase());return name;
};
const cellXml=(ref,v,type,head)=>{
  if(type==='date'){const n=serial(v);return n==null?'':`<c r="${ref}" s="3"><v>${n}</v></c>`;}
  if(typeof v==='number')return Number.isFinite(v)?`<c r="${ref}"${type==='hours'?' s="2"':''}><v>${v}</v></c>`:'';
  if(typeof v==='string'){const s=text(v);return s?`<c r="${ref}"${head?' s="1"':''} t="inlineStr"><is><t xml:space="preserve">${esc(s)}</t></is></c>`:'';}
  return '';
};
const sheetXml=(s,index)=>{
  const cols=s.columns;
  if(!Array.isArray(cols)||!cols.length||cols.length>MAX_COLS)throw new Error('Each sheet needs between 1 and 16,384 columns.');
  const rows=s.rows||[],last=`${letters(cols.length-1)}${rows.length+1}`,types=cols.map(c=>c.type);
  const colXml=cols.map((c,i)=>{const w=Number.isFinite(c.width)?Math.min(60,Math.max(3,c.width)):Math.min(60,Math.max(8,text(c.header??'').length+2));return `<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`}).join('');
  const head=`<row r="1">${cols.map((c,i)=>cellXml(`${letters(i)}1`,String(c.header??''),'text',true)).join('')}</row>`;
  const body=rows.map((r,ri)=>{const n=ri+2;return `<row r="${n}">${(r||[]).map((v,ci)=>ci<MAX_COLS?cellXml(`${letters(ci)}${n}`,v,types[ci]):'').join('')}</row>`}).join('');
  const pane=s.freezeHeader?'<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>':'';
  const view=`<sheetViews><sheetView workbookViewId="0"${index===0?' tabSelected="1"':''}>${pane}</sheetView></sheetViews>`;
  const rules=(s.validations||[]).map(v=>{
    if(!Number.isInteger(v.column)||v.column<0||v.column>=cols.length||!Array.isArray(v.list))return null;
    const list=v.list.map(x=>text(x)),f=list.join(',');
    if(!list.length||f.length>255||list.some(x=>/[",]/.test(x)))return null;
    const col=letters(v.column);
    return `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${col}2:${col}${Math.max(2,rows.length+1)}"><formula1>${esc(`"${f}"`)}</formula1></dataValidation>`;
  }).filter(Boolean);
  const dv=rules.length?`<dataValidations count="${rules.length}">${rules.join('')}</dataValidations>`:'';
  const ref=`A1:${last}`;
  const filter=s.autoFilter?`<autoFilter ref="${ref}"/>`:'';
  const xml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="${ref}"/>${view}<sheetFormatPr defaultRowHeight="15"/><cols>${colXml}</cols><sheetData>${head}${body}</sheetData>${filter}${dv}</worksheet>`;
  return {xml,filter:s.autoFilter?ref:null};
};
const CRC_TABLE=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c;}return t;})();
const crc32=b=>{let c=-1;for(const x of b)c=CRC_TABLE[(c^x)&255]^(c>>>8);return (c^-1)>>>0;};
const defaultDeflate=bytes=>new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer().then(b=>new Uint8Array(b));
const STYLES='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F1"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
const REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const zip=async(files,compress)=>{
  const entries=[];let total=22;
  for(const [name,data] of files){
    let method=0,body=data;
    if(compress){const c=await compress(data);if(c.length<data.length){method=8;body=c;}}
    const nb=enc.encode(name);entries.push({nb,data,body,method,crc:crc32(data)});total+=76+2*nb.length+body.length;
  }
  const out=new Uint8Array(total),v=new DataView(out.buffer),off=[],now=new Date();
  const time=(now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1),date=((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
  let p=0;
  for(const e of entries){
    off.push(p);
    v.setUint32(p,0x04034b50,true);v.setUint16(p+4,20,true);v.setUint16(p+6,0x0800,true);v.setUint16(p+8,e.method,true);v.setUint16(p+10,time,true);v.setUint16(p+12,date,true);v.setUint32(p+14,e.crc,true);v.setUint32(p+18,e.body.length,true);v.setUint32(p+22,e.data.length,true);v.setUint16(p+26,e.nb.length,true);
    out.set(e.nb,p+30);p+=30+e.nb.length;out.set(e.body,p);p+=e.body.length;
  }
  const cd=p;
  entries.forEach((e,i)=>{
    v.setUint32(p,0x02014b50,true);v.setUint16(p+4,20,true);v.setUint16(p+6,20,true);v.setUint16(p+8,0x0800,true);v.setUint16(p+10,e.method,true);v.setUint16(p+12,time,true);v.setUint16(p+14,date,true);v.setUint32(p+16,e.crc,true);v.setUint32(p+20,e.body.length,true);v.setUint32(p+24,e.data.length,true);v.setUint16(p+28,e.nb.length,true);v.setUint32(p+42,off[i],true);
    out.set(e.nb,p+46);p+=46+e.nb.length;
  });
  v.setUint32(p,0x06054b50,true);v.setUint16(p+8,entries.length,true);v.setUint16(p+10,entries.length,true);v.setUint32(p+12,p-cd,true);v.setUint32(p+16,cd,true);
  return out;
};
export async function buildWorkbook(sheets,{deflate}={}){
  if(!Array.isArray(sheets)||!sheets.length)throw new Error('Workbook needs at least one sheet.');
  if(sheets.length>MAX_SHEETS)throw new Error('Workbook can have at most 20 sheets.');
  if(sheets.reduce((n,s)=>n+(s.rows?.length||0),0)>MAX_ROWS)throw new Error('Workbook can have at most 200,000 rows.');
  const compress=typeof deflate==='function'?deflate:deflate===undefined&&typeof CompressionStream==='function'?defaultDeflate:null;
  const used=new Set(),names=sheets.map(s=>sheetName(s.name,used)),built=sheets.map((s,i)=>sheetXml(s,i));
  const filters=built.map((b,i)=>b.filter?`<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(`'${names[i].replace(/'/g,"''")}'!${built[i].filter.replace(/([A-Z]+)(\d+)/g,(_,c,r)=>`$${c}$${r}`)}`)}</definedName>`:'').join('');
  const workbook=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><bookViews><workbookView/></bookViews><sheets>${names.map((n,i)=>`<sheet name="${esc(n)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets>${filters?`<definedNames>${filters}</definedNames>`:''}</workbook>`;
  const sheetRels=names.map((_,i)=>`<Relationship Id="rId${i+1}" Type="${REL}/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('');
  const overrides=names.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const files=[
    ['[Content_Types].xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml',workbook],
    ['xl/_rels/workbook.xml.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}<Relationship Id="rId${names.length+1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml',STYLES],
    ...built.map((b,i)=>[`xl/worksheets/sheet${i+1}.xml`,b.xml])
  ].map(([n,x])=>[n,enc.encode(x)]);
  if(files.reduce((n,[,d])=>n+d.length,0)>MAX_BYTES)throw new Error('Workbook is too large.');
  return zip(files,compress);
}
