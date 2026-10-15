import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sortTickets,createdDate,csvCell,reportCsv} from '../../public/assets/models/ticket-business.js';
import {readCatalogWorkbook} from '../../public/assets/models/catalog-import.js';
import {serializeView,restoreView} from '../../public/assets/models/saved-views.js';
import {createFilters} from '../../public/assets/models/filters.js';
import {normalizeJiraIssue,normalizeInternalIssue} from '../../public/assets/models/issue.js';
import {deflateRawSync,inflateRawSync} from 'node:zlib';
function workbookFile(files){const parts=[],directory=[];let offset=0;for(const [name,content]of Object.entries(files)){const data=Buffer.from(content),compressed=deflateRawSync(data),nm=Buffer.from(name),local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(8,8);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(nm.length,26);parts.push(local,nm,compressed);const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(8,10);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(nm.length,28);central.writeUInt32LE(offset,42);directory.push(central,nm);offset+=local.length+nm.length+compressed.length;}const dir=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);const b=Buffer.concat([...parts,dir,end]);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);}
test('natural, numeric and date sorting keep blanks last in both directions with stable keys',()=>{
 const items=[{key:'AION-10',actualHours:null,summary:'Task 10'},{key:'AION-2',actualHours:10,summary:'Task 2'},{key:'AION-3',actualHours:2,summary:'Task 3'}];
 assert.deepEqual(sortTickets(items,{field:'actualHours',direction:'asc'}).map(i=>i.key),['AION-3','AION-2','AION-10']);
 assert.deepEqual(sortTickets(items,{field:'actualHours',direction:'desc'}).map(i=>i.key),['AION-2','AION-3','AION-10']);
 assert.deepEqual(sortTickets(items,{field:'summary',direction:'asc'}).map(i=>i.key),['AION-2','AION-3','AION-10']);
 const dates=[{key:'INT-1',created:'2026-10-15T23:00:00+03:00'},{key:'INT-2',created:'2026-10-15T19:00:00Z'}];assert.equal(sortTickets(dates,{field:'created',direction:'asc'})[0].key,'INT-2');
 assert.deepEqual(sortTickets(items,{field:'billing',direction:'desc'},false),items);
});
test('creation timestamps stay intact and display Jerusalem calendar dates',()=>{
 const stamp='2026-10-14T22:30:00Z';assert.match(createdDate(stamp),/15 Oct 2026/);
 assert.equal(normalizeJiraIssue({key:'AION-1',fields:{created:stamp}}, {},x=>x).created,stamp);
 assert.equal(normalizeInternalIssue({key:'INT-1',created:stamp},{}).created,stamp);
});
test('saved views round trip sorting and business filters and remove user billing controls',()=>{
 const state={f:createFilters(),focus:'open',view:'list',group:'',q:'',sort:{field:'actualHours',direction:'desc'},businessFilter:{clientId:'c_1',billing:'billable'}};
 const view=serializeView(state,'Work');assert.equal(restoreView(view,true,{}).businessFilter.billing,'billable');assert.equal(restoreView(view,false,{}).businessFilter.billing,undefined);assert.deepEqual(restoreView(view,false,{}).sort,state.sort);
});
test('CSV export quotes text and neutralizes spreadsheet formulas',()=>{
 assert.ok(csvCell('=bad').startsWith(String.fromCharCode(34,39)));assert.ok(csvCell('  +SUM(1)').includes(String.fromCharCode(39)));assert.equal(csvCell(2),String.fromCharCode(34)+'2'+String.fromCharCode(34));
 const report={tickets:[{key:'INT-1',title:'=bad',missing:[],risks:[],overrides:[]}]};assert.ok(reportCsv(report).includes("'=bad"));
});
test('XLSX import handles shared strings, empty cells and multilingual standalone clients',async()=>{
 const buffer=workbookFile({'xl/sharedStrings.xml':'<sst><si><t>Customer</t></si><si><t>Display Name</t></si><si><t>Acme</t></si><si><t>Branch &amp; One</t></si><si><t>לקוח</t></si></sst>','xl/worksheets/sheet1.xml':'<worksheet><sheetData><row r="1"><c r="C1" t="s"><v>0</v></c><c r="D1" t="s"><v>1</v></c></row><row r="2"><c r="C2" t="s"><v>2</v></c><c r="D2" t="s"><v>3</v></c></row><row r="3"><c r="C3"/><c r="D3" t="s"><v>4</v></c></row></sheetData></worksheet>'});
 const rows=await readCatalogWorkbook(buffer,async b=>new Uint8Array(inflateRawSync(b)));assert.deepEqual(rows,[{customer:'Acme',displayName:'Branch & One',sourceRow:2},{customer:'',displayName:'לקוח',sourceRow:3}]);
 await assert.rejects(readCatalogWorkbook(new ArrayBuffer(0)),/Invalid XLSX/);
});
