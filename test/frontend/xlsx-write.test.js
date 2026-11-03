import {test} from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import {buildWorkbook} from "../../public/assets/models/xlsx-write.js";

const unesc=s=>s.replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&");
const crcRef=b=>{let c=0xFFFFFFFF;for(const x of b){c^=x;for(let k=0;k<8;k++)c=c&1?(c>>>1)^0xEDB88320:c>>>1;}return (c^0xFFFFFFFF)>>>0;};

function readZip(bytes){
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let end=bytes.length-22;
  while(end>=0&&v.getUint32(end,true)!==0x06054b50)end--;
  assert.ok(end>=0,"end record");
  const count=v.getUint16(end+10,true);let pos=v.getUint32(end+16,true);const files={};
  for(let i=0;i<count;i++){
    assert.equal(v.getUint32(pos,true),0x02014b50);
    const method=v.getUint16(pos+10,true),crc=v.getUint32(pos+16,true),csize=v.getUint32(pos+20,true),usize=v.getUint32(pos+24,true),nl=v.getUint16(pos+28,true),off=v.getUint32(pos+42,true);
    const name=new TextDecoder().decode(bytes.subarray(pos+46,pos+46+nl));
    const lnl=v.getUint16(off+26,true),lel=v.getUint16(off+28,true),start=off+30+lnl+lel;
    assert.equal(new TextDecoder().decode(bytes.subarray(off+30,off+30+lnl)),name);
    const raw=bytes.subarray(start,start+csize),data=method===0?raw:method===8?zlib.inflateRawSync(raw):null;
    assert.ok(data,"known method");
    assert.equal(data.length,usize,"size of "+name);
    assert.equal(crcRef(data),crc,"crc of "+name);
    if(zlib.crc32)assert.equal(zlib.crc32(data),crc,"zlib crc of "+name);
    files[name]={method,text:new TextDecoder().decode(data)};
    pos+=46+nl+v.getUint16(pos+30,true)+v.getUint16(pos+32,true);
  }
  return files;
}

function wellFormed(xml){
  const stack=[];
  for(const m of xml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)([^>]*?)(\/?)>/g)){
    if(m[4]==="/")continue;
    if(m[1])assert.equal(stack.pop(),m[2],"matching close tag");else stack.push(m[2]);
  }
  assert.equal(stack.length,0,"all tags closed");
}

const cellMap=xml=>Object.fromEntries([...xml.matchAll(/<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)].map(m=>[m[1],
  /t="inlineStr"/.test(m[2])?unesc(m[3].match(/<t[^>]*>([\s\S]*?)<\/t>/)[1]):Number(m[3].match(/<v>(.*?)<\/v>/)[1])]));
const styleOf=(xml,ref)=>xml.match(new RegExp(`<c r="${ref}"([^>]*)>`))?.[1].match(/s="(\d+)"/)?.[1]??null;
const sheetOf=(files,i=1)=>files[`xl/worksheets/sheet${i}.xml`].text;
const serialOf=iso=>(Date.UTC(...iso.split("-").map((n,i)=>i===1?n-1:+n))-Date.UTC(1899,11,30))/864e5;

test("writes a zip with the required parts and well formed XML",async()=>{
  const bytes=await buildWorkbook([{name:"Checks",columns:[{header:"Name"}],rows:[["a"]]}]);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(String.fromCharCode(...bytes.slice(0,4)),"PK\x03\x04");
  const files=readZip(bytes);
  for(const name of ["[Content_Types].xml","_rels/.rels","xl/workbook.xml","xl/_rels/workbook.xml.rels","xl/styles.xml","xl/worksheets/sheet1.xml"])assert.ok(files[name],name);
  for(const f of Object.values(files))wellFormed(f.text);
  assert.match(files["xl/workbook.xml"].text,/<sheet name="Checks" sheetId="1" r:id="rId1"\/>/);
});

test("numbers, hours, dates and text land in the right cells",async()=>{
  const files=readZip(await buildWorkbook([{name:"Data",columns:[{header:"Name"},{header:"Hours",type:"hours"},{header:"Due",type:"date"},{header:"Count",type:"number"}],
    rows:[["Ann",1.5,"2026-10-31",3],["Bob",null,"2026-02-30",NaN],["Cy",Infinity,"nope",0.25]]}]));
  const xml=sheetOf(files),cells=cellMap(xml);
  assert.equal(cells.A1,"Name");assert.equal(styleOf(xml,"A1"),"1");
  assert.equal(cells.A2,"Ann");assert.equal(cells.B2,1.5);assert.equal(styleOf(xml,"B2"),"2");
  assert.equal(cells.C2,serialOf("2026-10-31"));assert.equal(styleOf(xml,"C2"),"3");
  assert.equal(cells.D2,3);assert.equal(styleOf(xml,"D2"),null);
  assert.equal(cells.D4,0.25);
  for(const ref of ["B3","C3","D3","B4","C4"])assert.equal(cells[ref],undefined,ref+" is empty");
  assert.equal(cells.A4,"Cy");
  assert.match(files["xl/styles.xml"].text,/formatCode="yyyy-mm-dd"/);
  assert.match(files["xl/styles.xml"].text,/formatCode="0.00"/);
});

test("formulas are never written and stay inline text",async()=>{
  const files=readZip(await buildWorkbook([{name:"F",columns:[{header:"x"}],rows:[["=1+1"],["+2"],["-3"],["@SUM(A1)"]]}]));
  const xml=sheetOf(files),cells=cellMap(xml);
  assert.doesNotMatch(xml,/<f>|<f /);
  assert.deepEqual([cells.A2,cells.A3,cells.A4,cells.A5],["=1+1","+2","-3","@SUM(A1)"]);
});

test("XML special characters are escaped and control characters removed",async()=>{
  const files=readZip(await buildWorkbook([{name:"E",columns:[{header:"<h>&"}],rows:[['A & <B> "C" \'D\'\r'],["a\u0001b\u000Bc\tk\nl\u0000\uD800z"],["x".repeat(40000)]]}]));
  const xml=sheetOf(files),cells=cellMap(xml);
  assert.equal(cells.A1,"<h>&");
  assert.equal(cells.A2,'A & <B> "C" \'D\'\r');
  assert.equal(cells.A3,"abc\tk\nlz");
  assert.doesNotMatch(xml,/[\x00-\x08\x0B\x0C\x0E-\x1F\uD800-\uDFFF]/);
  assert.equal(cells.A4.length,32000);
});

test("sheet names are sanitized and made unique",async()=>{
  const names=["Data/Report: [Q1]*?","'Quoted'","data","DATA","x".repeat(40),"","   "];
  const files=readZip(await buildWorkbook(names.map((name,i)=>({name,columns:[{header:"a"}],rows:[[i]]}))));
  const got=[...files["xl/workbook.xml"].text.matchAll(/<sheet name="([^"]*)"/g)].map(m=>unesc(m[1]));
  assert.deepEqual(got,["DataReport Q1","Quoted","data","DATA 2","x".repeat(31),"Sheet","Sheet 2"]);
  assert.equal(Object.keys(files).filter(n=>/^xl\/worksheets\//.test(n)).length,7);
});

test("validations, frozen header and autofilter are written when asked",async()=>{
  const files=readZip(await buildWorkbook([{name:"V",columns:[{header:"Status"},{header:"Other"}],freezeHeader:true,autoFilter:true,
    validations:[{column:0,list:["Open","Done"]},{column:1,list:["a,b"]},{column:5,list:["x"]},{column:0,list:Array.from({length:60},(_,i)=>"item"+i)}],
    rows:[["Open","x"],["Done","y"]]}]));
  const xml=sheetOf(files),wb=files["xl/workbook.xml"].text;
  assert.match(xml,/<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(xml,/<autoFilter ref="A1:B3"\/>/);
  assert.match(xml,/<dataValidations count="1"><dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="A2:A3"><formula1>&quot;Open,Done&quot;<\/formula1>/);
  assert.match(wb,/<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">&apos;V&apos;!\$A\$1:\$B\$3<\/definedName>/);
  wellFormed(xml);wellFormed(wb);
  const plain=readZip(await buildWorkbook([{name:"P",columns:[{header:"a"}],rows:[]}]));
  assert.doesNotMatch(sheetOf(plain),/pane|autoFilter|dataValidation/);
});

test("store mode, injected deflate and the default all give valid archives",async()=>{
  const rows=Array.from({length:300},(_,i)=>[`row ${i} repeated text repeated text`,i]);
  const sheets=[{name:"S",columns:[{header:"t"},{header:"n",type:"number"}],rows}];
  for(const deflate of [null,false]){
    const files=readZip(await buildWorkbook(sheets,{deflate}));
    assert.ok(Object.values(files).every(f=>f.method===0));
  }
  let calls=0;
  const injected=readZip(await buildWorkbook(sheets,{deflate:async b=>{calls++;return new Uint8Array(zlib.deflateRawSync(b))}}));
  assert.ok(calls>0);assert.ok(Object.values(injected).some(f=>f.method===8));
  assert.equal(cellMap(sheetOf(injected)).A301,"row 299 repeated text repeated text");
  const def=readZip(await buildWorkbook(sheets));
  assert.ok(Object.values(def).some(f=>f.method===8));
  assert.equal(cellMap(sheetOf(def)).B301,299);
});

test("column widths come from the header and cap at 60",async()=>{
  const xml=sheetOf(readZip(await buildWorkbook([{name:"W",columns:[{header:"A".repeat(70)},{header:"Hi",width:12},{header:"Ok"}],rows:[]}])));
  assert.match(xml,/<col min="1" max="1" width="60" customWidth="1"\/>/);
  assert.match(xml,/<col min="2" max="2" width="12" customWidth="1"\/>/);
  assert.match(xml,/<col min="3" max="3" width="8" customWidth="1"\/>/);
});

test("invalid dates and invalid sheet lists are refused or emptied",async()=>{
  const files=readZip(await buildWorkbook([{name:"D",columns:[{header:"d",type:"date"}],rows:[["1899-12-31"],["2026-13-01"],["2024-02-29"]]}]));
  const cells=cellMap(sheetOf(files));
  assert.equal(cells.A2,undefined);assert.equal(cells.A3,undefined);assert.equal(cells.A4,serialOf("2024-02-29"));
  await assert.rejects(buildWorkbook([]),/at least one sheet/);
  await assert.rejects(buildWorkbook(Array.from({length:21},(_,i)=>({name:"S"+i,columns:[{header:"a"}],rows:[]}))),/at most 20 sheets/);
  await assert.rejects(buildWorkbook([{name:"Big",columns:[{header:"a"}],rows:Array.from({length:200001},()=>[])}]),/200,000 rows/);
});
