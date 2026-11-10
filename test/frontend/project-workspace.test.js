import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_VIEW,ticketView,ticketTotals,ticketProblems,syncLabel,ticketMatches,developers,hiddenCount,projectSheetRows,ticketSheetRows,PROJECT_COLUMNS,TICKET_COLUMNS,csvFile,fileSlug,importBody,importTables,reportRows,retryBody,templateSheets,sheetColumns} from '../../public/assets/models/project-workspace.js';
import {parseCsv} from '../../public/assets/models/table-import.js';

const t=o=>({key:'INT-1',source:'internal',projectId:7,onProject:true,revision:2,override:null,effective:{value:'billable',source:'project'},estimatedHours:null,agreedHours:null,agreedDeveloper:null,
  actualMinutes:0,chargeableMinutes:0,entries:0,consumedMinutes:0,sync:{pendingMinutes:0,review:0,billingField:null},exported:{charges:0,minutes:0},completedAt:null,title:'',description:'',status:'To Do',closed:false,devs:[],assignee:'',...o});
const list=[
  t({key:'INT-10',title:'Hebrew שלום',devs:['dana'],assignee:'Manager Mo',actualMinutes:120,chargeableMinutes:120,estimatedHours:3}),
  t({key:'AI-2',source:'jira',title:'Login bug',devs:['dana','eli'],agreedHours:2,actualMinutes:300,chargeableMinutes:120,override:'billable',effective:{value:'billable',source:'ticket'}}),
  t({key:'HD-5',source:'odoo',title:'Printer',closed:true,status:'Solved',actualMinutes:60,chargeableMinutes:0,override:'not_billable',effective:{value:'not_billable',source:'ticket'}}),
  t({key:'INT-3',title:'No default',effective:{value:'unclassified',source:'none'},sync:{pendingMinutes:30,review:1,billingField:{state:'failed',error:'boom'}}})
];

test('filters, search and sort cover the whole list; paging is a slice of it',()=>{
  const v=o=>({...DEFAULT_VIEW,...o});
  assert.deepEqual(ticketView(list,v()).matching.map(x=>x.key),['AI-2','HD-5','INT-3','INT-10']);
  assert.deepEqual(ticketView(list,v({q:'שלום'})).matching.map(x=>x.key),['INT-10']);
  assert.deepEqual(ticketView(list,v({q:'manager'})).matching.map(x=>x.key),['INT-10'],'the assignee is searchable');
  assert.deepEqual(ticketView(list,v({status:'closed'})).matching.map(x=>x.key),['HD-5']);
  assert.deepEqual(ticketView(list,v({dev:'eli'})).matching.map(x=>x.key),['AI-2']);
  assert.deepEqual(ticketView(list,v({source:'odoo'})).matching.map(x=>x.key),['HD-5']);
  assert.deepEqual(ticketView(list,v({billing:'not_billable'})).matching.map(x=>x.key),['HD-5']);
  assert.deepEqual(ticketView(list,v({billing:'inherit'})).matching.map(x=>x.key),['INT-3','INT-10']);
  assert.deepEqual(ticketView(list,v({billing:'override:billable'})).matching.map(x=>x.key),['AI-2']);
  assert.deepEqual(ticketView(list,v({problems:'any'})).matching.map(x=>x.key),['INT-3']);
  assert.deepEqual(ticketView(list,v({problems:'failed'})).matching.map(x=>x.key),['INT-3']);
  assert.deepEqual(ticketView(list,v({sort:'actual',dir:-1})).matching.map(x=>x.key),['AI-2','INT-10','HD-5','INT-3']);
  const page=ticketView(list,v({size:3,page:5}));assert.equal(page.page,1,'a page past the end shows the last');assert.deepEqual(page.rows.map(x=>x.key),['INT-10']);
  assert.equal(hiddenCount(v({dev:'x',problems:'any'})),2);
  assert.deepEqual(developers(list),['dana','eli']);
  assert.equal(ticketMatches(list[0],v({q:'  '})),true);
});

test('totals keep actual work apart from commercial hours; problems are named',()=>{
  assert.deepEqual(ticketTotals(list),{tickets:4,open:3,estimatedHours:3,agreedHours:2,actualHours:8,commercialHours:4});
  assert.deepEqual(ticketProblems(list[3]).map(p=>p.kind),['pending','review','failed','unclassified']);
  assert.match(syncLabel(list[3]),/0.5 h not in Odoo yet · 1 entry needs review · Billing not saved in Odoo: boom/);
  assert.equal(syncLabel(list[0]),'OK');
});

test('export rows keep stable IDs, Hebrew, multiline text and formula protection',()=>{
  const projects=[{odooId:7,name:'פרויקט',client:'=HYPERLINK("x")',allocatedHours:10,loggedHours:4,openTickets:2,ticketCount:3,billing:{default:'billable',actualMinutes:240,billableMinutes:180,chargeableMinutes:180,status:'available',allowance:{consumedMinutes:180,capacityMinutes:600,remainingMinutes:420,overageMinutes:0}}},
    {odooId:8,name:'No billing',client:'',allocatedHours:null,loggedHours:0}];
  const p=projectSheetRows(projects,'2026-11-09T10:00:00Z');
  assert.equal(p[0].length,PROJECT_COLUMNS.length);
  assert.deepEqual(p[0],[7,'פרויקט','=HYPERLINK("x")','Billable',10,4,4,3,3,7,'available',2,3,'2026-11-09T10:00:00Z']);
  assert.deepEqual(p[1].slice(0,5),[8,'No billing','','','']);
  const rows=ticketSheetRows([{...list[1],description:'line 1\nline 2',scope:{from:'2026-01-01',to:'2026-11-09'}}],{7:{name:'פרויקט',client:'Acme'}},'X');
  assert.equal(rows[0].length,TICKET_COLUMNS.length);
  const at=k=>rows[0][TICKET_COLUMNS.indexOf(k)];
  assert.equal(at('Ticket'),'AI-2');assert.equal(at('Odoo Project ID'),7);assert.equal(at('Billing Override'),'Billable');assert.equal(at('Agreed Hours'),2);
  assert.equal(at('Actual Hours (period)'),5);assert.equal(at('Commercial Hours (period)'),2);assert.equal(at('Period From'),'2026-01-01');assert.equal(at('Revision'),2);
  const csv=csvFile([['Name','Note','Hours'],['שלום','=1+1',-3],['a','x\ny',1.5]]);
  assert.ok(csv.startsWith('﻿'));
  assert.equal(csv.slice(1),'Name,Note,Hours\r\nשלום,"\'=1+1",-3\r\na,"x\ny",1.5');
  assert.deepEqual(parseCsv(csv.slice(1))[2],['a','x\ny','1.5'],'multiline text reads back as one cell');
  assert.equal(fileSlug('Acme / Web: שלב 2'),'Acme-Web-שלב-2');
  assert.deepEqual(sheetColumns(['Ticket','Agreed Hours']).map(c=>c.type),[undefined,'hours']);
});

test('import: an exported file reads back; blank stays blank and [clear] is kept',()=>{
  const sheets=[{name:'Projects',rows:[PROJECT_COLUMNS,[7,'P','Acme','Not billable','',4,'','','','','',1,1,'2026-11-09T10:00:00Z'],[],[8,'Q','','','[clear]']]},
    {name:'Tickets',rows:[TICKET_COLUMNS,['INT-1','Internal',7,'P','Acme','T','', '', '', '', 'Inherit','Billable','Project default','',' 3,5 ','Dana','','','','','','',4,'X']]}];
  const {body,notes}=importBody(sheets);
  assert.deepEqual(body.projects,[{row:2,odooId:'7',customer:'Acme',billing:'Not billable',allocatedHours:'',exportedAt:'2026-11-09T10:00:00Z'},{row:4,odooId:'8',customer:'',billing:'',allocatedHours:'[clear]',exportedAt:''}]);
  assert.deepEqual(body.tickets,[{row:2,key:'INT-1',odooProjectId:'7',customer:'Acme',billing:'Inherit',agreedHours:'3,5',agreedDeveloper:'Dana',revision:'4'}]);
  assert.ok(notes.some(n=>/1 empty projects row/.test(n)));
  // A single CSV with a Ticket column is the tickets; one without is the projects.
  const one=importTables([{name:'CSV',rows:[['Ticket','Agreed Hours','Odoo Project ID'],['AI-1','2','7']]}]);
  assert.ok(one.tickets&&!one.projects);
  const proj=importTables([{name:'CSV',rows:[['Odoo Project ID','Allocated Hours'],['7','10']]}]);
  assert.ok(proj.projects&&!proj.tickets);
  assert.match(importBody([{name:'CSV',rows:[['a','b']]}]).notes[0],/No Projects or Tickets table/);
  assert.equal(templateSheets().length,3);
});

test('import results: report rows, and only rows that did not apply are sent again',()=>{
  const body={projects:[{row:2,odooId:'7'}],tickets:[{row:2,key:'INT-1'},{row:3,key:'INT-2'},{row:4,key:'INT-3'}]};
  const result={rows:[{sheet:'projects',row:2,id:'7',name:'P',result:'applied',changes:[{label:'Allocated hours',from:null,to:10}],errors:[],warnings:[]},
    {sheet:'tickets',row:2,id:'INT-1',result:'failed',message:'The ticket changed after the preview. Preview again.',changes:[],errors:[],warnings:[]},
    {sheet:'tickets',row:3,id:'INT-2',result:'not_applied',errors:['Unknown ticket.'],changes:[],warnings:[]},
    {sheet:'tickets',row:4,id:'INT-3',result:'unchanged',changes:[],errors:[],warnings:[]}]};
  assert.deepEqual(retryBody(body,result),{projects:[],tickets:[{row:2,key:'INT-1'},{row:3,key:'INT-2'}]});
  const r=reportRows(result);
  assert.deepEqual(r[1],['Projects',2,'7','P','Applied','Allocated hours: empty → 10','','','']);
  assert.equal(r[2][4],'Failed');assert.equal(r[3][6],'Unknown ticket.');
});
