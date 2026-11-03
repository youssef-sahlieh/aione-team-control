import {test} from "node:test";
import assert from "node:assert/strict";
import {deflateRawSync,inflateRawSync} from "node:zlib";
import {parseCsv,readWorkbookTables,readTableFile,norm,detectColumns,pickTable,rowsFromTable,importFieldsMapped,numberValue,AGREED_IMPORT_FIELDS,TICKET_IMPORT_FIELDS} from "../../public/assets/models/table-import.js";
import {TICKET_COLUMNS} from "../../public/assets/models/report-workbook.js";

const MB=1024*1024;
const ab=b=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);

function zip(entries){
  const locals=[],centrals=[];let offset=0;
  for(const e of entries){
    const name=Buffer.from(e.name),raw=Buffer.from(e.data??''),method=e.method??8;
    const data=method===0?raw:deflateRawSync(raw),size=e.size??raw.length;
    const lh=Buffer.alloc(30);lh.writeUInt32LE(0x04034b50,0);lh.writeUInt16LE(e.flags??0,6);lh.writeUInt16LE(method,8);lh.writeUInt32LE(data.length,18);lh.writeUInt32LE(size,22);lh.writeUInt16LE(name.length,26);
    const ch=Buffer.alloc(46);ch.writeUInt32LE(0x02014b50,0);ch.writeUInt16LE(e.flags??0,8);ch.writeUInt16LE(method,10);ch.writeUInt32LE(data.length,20);ch.writeUInt32LE(size,24);ch.writeUInt16LE(name.length,28);ch.writeUInt32LE(offset,42);
    locals.push(lh,name,data);centrals.push(ch,name);offset+=30+name.length+data.length;
  }
  const cd=Buffer.concat(centrals),eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(entries.length,8);eocd.writeUInt16LE(entries.length,10);eocd.writeUInt32LE(cd.length,12);eocd.writeUInt32LE(offset,16);
  return ab(Buffer.concat([...locals,cd,eocd]));
}

const NS='xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function book(sheets,{strings,styles,date1904,method=8}={}){
  const files={
    'xl/workbook.xml':`<workbook ${NS}><workbookPr${date1904?' date1904="1"':''}/><sheets>${sheets.map((s,i)=>`<sheet name="${s.name}" sheetId="${i+1}"${s.state?` state="${s.state}"`:''} r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}</Relationships>`
  };
  sheets.forEach((s,i)=>{files[`xl/worksheets/sheet${i+1}.xml`]=`<worksheet ${NS}><sheetData>${s.body}</sheetData></worksheet>`});
  if(strings)files['xl/sharedStrings.xml']=`<sst ${NS}>${strings}</sst>`;
  if(styles)files['xl/styles.xml']=`<styleSheet ${NS}>${styles}</styleSheet>`;
  return zip(Object.entries(files).map(([name,data])=>({name,data,method})));
}
const row=(n,cells)=>`<row r="${n}">${cells}</row>`;
const sst=(ref,i)=>`<c r="${ref}" t="s"><v>${i}</v></c>`;
const num=(ref,v,attrs='')=>`<c r="${ref}"${attrs}><v>${v}</v></c>`;
const inl=(ref,t)=>`<c r="${ref}" t="inlineStr"><is><t>${t}</t></is></c>`;

test("CSV: quoted cells, doubled quotes, embedded newlines, CRLF, CR and a BOM",()=>{
  assert.deepEqual(parseCsv('﻿Ticket,Note\r\nA-1,"hello, ""world"""\r\nA-2,"line\nbreak"\r'),[['Ticket','Note'],['A-1','hello, "world"'],['A-2','line\nbreak']]);
  assert.deepEqual(parseCsv('a,b\rc,d'),[['a','b'],['c','d']]);
  assert.deepEqual(parseCsv('a,b\n\n'),[['a','b'],['']]);
  assert.deepEqual(parseCsv(''),[]);
});

test("CSV: semicolon and tab delimiters are used only when the header line has no comma",()=>{
  assert.deepEqual(parseCsv('Ticket;Agreed\nA-1;3,5'),[['Ticket','Agreed'],['A-1','3,5']]);
  assert.deepEqual(parseCsv('Ticket\tAgreed\nA-1\t3'),[['Ticket','Agreed'],['A-1','3']]);
  assert.deepEqual(parseCsv('a,b;c\n1;2,3'),[['a','b;c'],['1;2','3']]);
});

test("CSV: 20,000 rows and 200 columns are allowed, one more throws",()=>{
  assert.equal(parseCsv('a\n'.repeat(20000)).length,20000);
  assert.throws(()=>parseCsv('a\n'.repeat(20001)),/too large/);
  assert.equal(parseCsv('a,'.repeat(199)+'a')[0].length,200);
  assert.throws(()=>parseCsv('a,'.repeat(200)+'a'),/too large/);
});

test("XLSX: shared strings with rich text and phonetic runs, inline strings, booleans and errors",async()=>{
  const strings='<si><t>Ticket</t></si><si><r><rPr><b/></rPr><t>Agreed </t></r><r><t>hours</t></r></si><si><t xml:space="preserve">A&amp;B</t><rPh sb="0" eb="1"><t>ignored</t></rPh></si>';
  const body=row(1,sst('A1',0)+sst('B1',1)+inl('C1','Note'))+row(2,sst('A2',2)+num('B2','12.5')+'<c r="C2" t="b"><v>1</v></c>')+row(3,'<c r="A3" t="e"><v>#N/A</v></c>'+inl('B3','  spaced  '));
  const tables=await readWorkbookTables(book([{name:'Tickets',body}],{strings}));
  assert.deepEqual(tables,[{name:'Tickets',rows:[['Ticket','Agreed hours','Note'],['A&B','12.5','TRUE'],['','  spaced  ','']]}]);
});

test("XLSX: real sheet names and order, hidden sheets last, gaps kept, trailing empty rows and columns trimmed",async()=>{
  const visible=row(1,inl('C1','x'))+row(2,inl('B2','y'))+row(3,'<c r="A3"/>')+'<row r="4"/>'+row(6,inl('A6','z'));
  const tables=await readWorkbookTables(book([
    {name:'Hidden',body:row(1,inl('A1','secret')),state:'hidden'},
    {name:'Tickets',body:visible+row(7,'<c r="E7" s="0"/>')},
    {name:'Other',body:row(1,inl('A1','o'))}
  ]));
  assert.deepEqual(tables.map(t=>t.name),['Tickets','Other','Hidden']);
  assert.deepEqual(tables[0].rows,[['','','x'],['','y',''],['','',''],['','',''],['','',''],['z','','']]);
  assert.deepEqual(tables[2].rows,[['secret']]);
});

test("XLSX: date-styled cells become YYYY-MM-DD, the 1900 leap-year bug is handled, other formats stay as numbers",async()=>{
  const styles='<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="&quot;date&quot; 0"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs>';
  const body=row(1,num('A1',45000,' s="1"')+num('B1',45000.75,' s="2"')+num('C1',45000,' s="3"')+num('D1',45000,' s="0"'))
    +row(2,num('A2',1,' s="1"')+num('B2',61,' s="1"')+num('C2',60,' s="1"'));
  const [t]=await readWorkbookTables(book([{name:'Dates',body}],{styles}));
  assert.deepEqual(t.rows,[['2023-03-15','2023-03-15','45000','45000'],['1900-01-01','1900-03-01','60','']]);
});

test("XLSX: the 1904 date system is honoured when workbook.xml says so",async()=>{
  const styles='<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>';
  const [t]=await readWorkbookTables(book([{name:'D',body:row(1,num('A1',0,' s="1"')+num('B1',1,' s="1"'))}],{styles,date1904:true}));
  assert.deepEqual(t.rows,[['1904-01-01','1904-01-02']]);
});

test("XLSX: formulas are never evaluated, only the cached value is used",async()=>{
  const body=row(1,'<c r="A1"><f>1/0</f><v>5</v></c><c r="B1" t="str"><f>"x"&amp;"y"</f><v>xy</v></c><c r="C1"><f>SUM(1,2)</f></c>');
  const [t]=await readWorkbookTables(book([{name:'F',body}]));
  assert.deepEqual(t.rows,[['5','xy']]);
});

test("XLSX: stored (uncompressed) entries are read and a custom inflate is used for deflated ones",async()=>{
  const body=row(1,inl('A1','stored'));
  const [t]=await readWorkbookTables(book([{name:'S',body}],{method:0}));
  assert.deepEqual(t.rows,[['stored']]);
  let calls=0;
  const [d]=await readWorkbookTables(book([{name:'D',body}]),async(bytes,size)=>{calls++;return inflateRawSync(bytes)});
  assert.equal(calls,3);
  assert.deepEqual(d.rows,[['stored']]);
});

test("XLSX: header detection on row 3 with the ticket fields and the mapped row values",async()=>{
  const body=row(1,inl('A1','Monthly report'))+row(2,inl('A2','Generated'))
    +row(3,inl('A3','Ticket')+inl('B3','Agreed hours')+inl('C3','Customer'))
    +row(4,inl('A4','ABC-1')+num('B4',3)+inl('C4','Acme'));
  const sheets=await readWorkbookTables(book([{name:'Export',body}]));
  const table=pickTable(sheets,TICKET_IMPORT_FIELDS);
  assert.equal(table.sheet,'Export');
  assert.equal(table.headerRow,2);
  assert.deepEqual(table.map,{key:0,agreedHours:1,client:2,project:-1,billing:-1});
  assert.deepEqual(table.missing,[]);
  assert.deepEqual(rowsFromTable(table,table.map,TICKET_IMPORT_FIELDS),{rows:[{line:4,values:{key:'ABC-1',agreedHours:'3',client:'Acme',project:'',billing:''}}],skippedBlank:0,truncated:false});
});

test("XLSX: a cell reference beyond 200 columns or row 20,000 with data is refused, the limits themselves are fine",async()=>{
  await assert.rejects(readWorkbookTables(book([{name:'C',body:row(1,num('GS1',1))}])),/too large/);
  await assert.rejects(readWorkbookTables(book([{name:'R',body:row(20001,num('A20001',1))}])),/too large/);
  const [ok]=await readWorkbookTables(book([{name:'OK',body:row(1,num('GR1',1))+row(20000,num('A20000',2))}]));
  assert.equal(ok.rows.length,20000);
  assert.equal(ok.rows[0].length,200);
});

test("ZIP limits: too many entries, declared size too big, total too big, real expansion too big",async()=>{
  const many=zip(Array.from({length:501},(_,i)=>({name:`x${i}.txt`,data:''})));
  await assert.rejects(readWorkbookTables(many),/too many ZIP entries/);
  await assert.rejects(readWorkbookTables(zip([{name:'xl/worksheets/sheet1.xml',data:'x',size:21*MB}])),/expands beyond/);
  await assert.rejects(readWorkbookTables(zip([0,1,2].map(i=>({name:`xl/worksheets/sheet${i+1}.xml`,data:'x',size:15*MB})))),/expands beyond/);
  await assert.rejects(readWorkbookTables(zip([{name:'xl/worksheets/sheet1.xml',data:'x'.repeat(5000),size:1000}])),/expands beyond/);
  await assert.rejects(readWorkbookTables(zip([{name:'xl/worksheets/sheet1.xml',data:'abcdef',method:0,size:3}])),/Unsupported or invalid/);
  await assert.rejects(readWorkbookTables(zip([{name:'xl/worksheets/sheet1.xml',data:'<worksheet/>',flags:1}])),/Encrypted/);
  await assert.rejects(readWorkbookTables(zip([{name:'xl/worksheets/sheet1.xml',data:'<worksheet/>',method:12}])),/Unsupported or invalid/);
});

test("ZIP limits: a fake central directory, a non-zip file and an oversized buffer are refused",async()=>{
  const good=new Uint8Array(book([{name:'T',body:row(1,inl('A1','x'))}]));
  const bad=good.slice();new DataView(bad.buffer).setUint32(bad.length-22+16,0xfff00000,true);
  await assert.rejects(readWorkbookTables(bad.buffer),/Invalid XLSX/);
  const badCount=good.slice();new DataView(badCount.buffer).setUint16(badCount.length-22+10,4,true);
  await assert.rejects(readWorkbookTables(badCount.buffer),/Invalid XLSX/);
  await assert.rejects(readWorkbookTables(new ArrayBuffer(100)),/Invalid XLSX file/);
  await assert.rejects(readWorkbookTables(new ArrayBuffer(0)),/Invalid XLSX file/);
  await assert.rejects(readWorkbookTables(new ArrayBuffer(10*MB+1)),/under 10 MB/);
});

test("pickTable: a sheet with every required field wins, incomplete results are still returned, no rows gives null",()=>{
  const sheets=[{name:'Notes',rows:[['Ticket','Something']]},{name:'Data',rows:[['Ticket','Agreed hours']]}];
  assert.equal(pickTable(sheets,AGREED_IMPORT_FIELDS).sheet,'Data');
  const partial=pickTable([{name:'X',rows:[['Foo','Ticket']]}],AGREED_IMPORT_FIELDS);
  assert.equal(partial.headerRow,0);
  assert.deepEqual(partial.missing,['agreedHours']);
  assert.equal(pickTable([],AGREED_IMPORT_FIELDS),null);
  assert.equal(pickTable([{name:'E',rows:[]}],AGREED_IMPORT_FIELDS),null);
});

test("detectColumns: exact and alias matches, unambiguous fuzzy matches, ambiguous fuzzy matches left unmapped",()=>{
  assert.deepEqual(detectColumns(['Issue key','Customer','Agreed h','Billable'],TICKET_IMPORT_FIELDS),{map:{key:0,agreedHours:2,client:1,project:-1,billing:3},missing:[]});
  assert.deepEqual(detectColumns(['Ticket Key (ID)','Agreed hours (h)'],AGREED_IMPORT_FIELDS),{map:{key:0,agreedHours:1},missing:[]});
  assert.deepEqual(detectColumns(['Customer A','Customer B','Ticket'],TICKET_IMPORT_FIELDS).map,{key:2,agreedHours:-1,client:-1,project:-1,billing:-1});
  assert.deepEqual(detectColumns(['Note'],AGREED_IMPORT_FIELDS),{map:{key:-1,agreedHours:-1},missing:['key','agreedHours']});
});

test("detectColumns: a header is claimed by only one field",()=>{
  const fields={a:{label:'Name',aliases:['title']},b:{label:'Title'}};
  assert.deepEqual(detectColumns(['Title'],fields).map,{a:0,b:-1});
});

test("norm: case, whitespace, punctuation and a trailing colon",()=>{
  assert.equal(norm('  Ticket Key: '),'ticket key');
  assert.equal(norm('Sub-Client'),'sub client');
  assert.equal(norm('Agreed_H/Hrs.'),'agreed h hrs');
});

test("rowsFromTable: 1-based line numbers, blank rows skipped, values trimmed, limit reported",()=>{
  const table={headerRow:1,rows:[['Title'],['Ticket','Agreed'],[' ',' '],['A-1',' 3 '],['',''],['A-2','4']]};
  const map={key:0,agreedHours:1};
  assert.deepEqual(rowsFromTable(table,map,AGREED_IMPORT_FIELDS),{rows:[{line:4,values:{key:'A-1',agreedHours:'3'}},{line:6,values:{key:'A-2',agreedHours:'4'}}],skippedBlank:2,truncated:false});
  const limited=rowsFromTable(table,map,AGREED_IMPORT_FIELDS,{limit:1});
  assert.equal(limited.rows.length,1);
  assert.equal(limited.truncated,true);
});

test("importFieldsMapped lists mapped non-key fields only",()=>{
  assert.deepEqual(importFieldsMapped({key:0,agreedHours:-1,client:2,project:-1,billing:-1}),['client']);
  assert.deepEqual(importFieldsMapped({key:0,agreedHours:-1,client:-1,project:-1,billing:-1}),[]);
});

test("numberValue accepts decimal comma or point, spaces as thousands, hour suffixes",()=>{
  const cases={'12.5':12.5,'12,5':12.5,' 1 200.50':1200.5,'12.5 h':12.5,'3 hrs':3,'2 hours':2,'12.5h':12.5,'1,200.5':1200.5,'1.200,5':1200.5,'1,200':1200,'12,50':12.5,'0':0};
  for(const [text,value] of Object.entries(cases))assert.equal(numberValue(text),value,text);
  for(const text of ['1e3','-1','NaN','','abc','12.5.1','h','Infinity','1 2','+1','1,2,3',null])assert.equal(numberValue(text),null,String(text));
});

test("readTableFile: CSV and XLSX by extension, other types refused, files over 10 MB refused",async()=>{
  const csv=await readTableFile(new File(['Ticket,Agreed\nA-1,2'],'tickets.csv',{type:'text/csv'}));
  assert.deepEqual(csv,{sheets:[{name:'CSV',rows:[['Ticket','Agreed'],['A-1','2']]}]});
  const xlsx=await readTableFile(new File([book([{name:'Sheet A',body:row(1,inl('A1','Ticket'))}])],'export.xlsx'));
  assert.deepEqual(xlsx,{sheets:[{name:'Sheet A',rows:[['Ticket']]}]});
  await assert.rejects(readTableFile(new File(['x'],'old.xls')),/Choose an Excel \(\.xlsx\) or CSV file\./);
  await assert.rejects(readTableFile(new File(['x'],'notes.pdf')),/Choose an Excel \(\.xlsx\) or CSV file\./);
  await assert.rejects(readTableFile(new File([new Uint8Array(10*MB+1)],'big.csv')),/under 10 MB/);
});

test("XLSX: more than 50 sheets is refused, 50 are fine, and a sheet path shared by several entries is parsed once",async()=>{
  const many=Array.from({length:51},(_,i)=>({name:`S${i}`,body:row(1,inl('A1','x'))}));
  await assert.rejects(readWorkbookTables(book(many)),/too many sheets/);
  const ok=await readWorkbookTables(book(many.slice(0,50)));
  assert.equal(ok.length,50);
  const shared=zip([
    {name:'xl/workbook.xml',data:`<workbook ${NS}><sheets><sheet name="A" r:id="rId1"/><sheet name="B" r:id="rId2"/></sheets></workbook>`},
    {name:'xl/_rels/workbook.xml.rels',data:`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet1.xml"/></Relationships>`},
    {name:'xl/worksheets/sheet1.xml',data:`<worksheet ${NS}><sheetData>${row(1,inl('A1','shared'))}</sheetData></worksheet>`}
  ]);
  const [a,b]=await readWorkbookTables(shared);
  assert.deepEqual([a.name,b.name],['A','B']);
  assert.deepEqual(a.rows,[['shared']]);
  assert.equal(a.rows,b.rows);
});

test("XLSX: unclosed <row>, <c>, <si> and <rPh> tags are refused in linear time",async()=>{
  const cases=[
    book([{name:'R',body:'<row>'.repeat(Math.floor(MB/6))}]),
    book([{name:'C',body:row(1,'<c>'.repeat(Math.floor(MB/4)))}]),
    book([{name:'S',body:row(1,'')}],{strings:'<si>'.repeat(Math.floor(MB/4))}),
    book([{name:'P',body:row(1,'')}],{strings:'<si>'+'<rPh>'.repeat(Math.floor(MB/6))+'</si>'}),
  ];
  for(const buf of cases){
    const t0=performance.now();
    await assert.rejects(readWorkbookTables(buf),/Invalid XLSX file/);
    assert.ok(performance.now()-t0<1000);
  }
});

test("XLSX: number format ids are numeric only, so 'constructor' or 'toString' cannot crash the date check",async()=>{
  const styles='<numFmts count="1"><numFmt numFmtId="constructor" formatCode="dd/mm"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="constructor"/><xf numFmtId="toString"/></cellXfs>';
  const [t]=await readWorkbookTables(book([{name:'N',body:row(1,num('A1',45000,' s="1"')+num('B1',45000,' s="2"'))}],{styles}));
  assert.deepEqual(t.rows,[['45000','45000']]);
});

test("XLSX: a row without a positive whole-number r is refused",async()=>{
  const cell='<c r="A1" t="inlineStr"><is><t>x</t></is></c>';
  for(const open of ['<row>','<row r="">','<row r="0">','<row r="-1">','<row r="1.5">','<row r="abc">']){
    await assert.rejects(readWorkbookTables(book([{name:'R',body:`${open}${cell}</row>`}])),/Invalid XLSX file/,open);
  }
});

test("detectColumns: a header containing 'over' is never matched to Agreed hours, the full ticket export without Agreed hours leaves it unmapped",()=>{
  const headers=TICKET_COLUMNS.map(c=>c.header).filter(h=>h!=='Agreed hours');
  assert.ok(headers.includes('Hours over agreed'));
  assert.deepEqual(detectColumns(headers,TICKET_IMPORT_FIELDS).map,{key:0,agreedHours:-1,client:3,project:4,billing:5});
  assert.deepEqual(detectColumns(['Ticket','Hours over agreed'],AGREED_IMPORT_FIELDS),{map:{key:0,agreedHours:-1},missing:['agreedHours']});
});
