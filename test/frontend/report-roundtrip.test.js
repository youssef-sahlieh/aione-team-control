import {test} from 'node:test';import assert from 'node:assert/strict';
import {buildReportWorkbook,buildTemplate,errorsCsv} from '../../public/assets/models/report-workbook.js';
import {readTableFile,pickTable,rowsFromTable,TICKET_IMPORT_FIELDS,importFieldsMapped} from '../../public/assets/models/table-import.js';
const file=bytes=>({name:'r.xlsx',size:bytes.length,type:'',arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});
const tickets=[{key:'AION-1',title:'=HYPERLINK("x")',status:'Open',clientName:'Acme',subClientName:'Web',billing:'not_billable',devs:['dana'],agreedHours:4.5,loggedHours:2,employees:[{name:'Dana',hours:2}],created:'2026-10-01',overage:'ok'},
 {key:'INT-2',title:'Plain',status:'Open',clientName:'',subClientName:'',billing:'',devs:[],agreedHours:null,employees:[]}];
test('the exported Tickets sheet reads back as an import with the same values',async()=>{
 const {sheets}=await readTableFile(file(await buildReportWorkbook(tickets,{period:{start:'2026-10-01',end:'2026-10-31'}})));
 assert.deepEqual(sheets.map(s=>s.name),['Summary','Tickets','By employee']);
 const table=pickTable(sheets,TICKET_IMPORT_FIELDS);assert.equal(table.sheet,'Tickets');
 assert.deepEqual(importFieldsMapped(table.map).sort(),['agreedHours','billing','client','project']);
 const {rows}=rowsFromTable(table,table.map,TICKET_IMPORT_FIELDS);
 assert.deepEqual(rows.map(r=>r.values),[{key:'AION-1',agreedHours:'4.5',client:'Acme',project:'Web',billing:'Not billable'},{key:'INT-2',agreedHours:'',client:'',project:'',billing:''}]);
 assert.equal(sheets[1].rows[1][1],'=HYPERLINK("x")');
});
test('the template has the import columns and no data rows',async()=>{
 const {sheets}=await readTableFile(file(await buildTemplate()));
 const table=pickTable(sheets,TICKET_IMPORT_FIELDS);assert.equal(table.sheet,'Tickets');assert.equal(rowsFromTable(table,table.map,TICKET_IMPORT_FIELDS).rows.length,0);
});
test('the error file is CSV with neutralised formulas',()=>{assert.match(errorsCsv([{line:4,key:'A-1',message:'=bad'}]),/"4","A-1","'=bad"|4,"A-1","'=bad"/);});
