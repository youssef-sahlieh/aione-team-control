import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dateMatches,NEAR_LIMIT,budgetStatus,budgetText,budgetRows,budgetCsvRows,budgetCounts,projectChoices,percent,signedHours,DEFAULT_VIEW,hiddenFilterCount,assignableProjects,mappingSuggestion,mappingRows,mappingCounts} from '../../public/assets/models/odoo-projects.js';

const p=o=>({odooId:1,name:'P',client:'Acme',createdAt:'2026-01-01T00:00:00Z',allocatedHours:null,loggedHours:0,remainingHours:null,overHours:0,usedPercent:null,status:'not_set',mapped:true,missingClient:false,ticketCount:0,openTickets:0,reviewTickets:0,lastWorkDate:null,pendingHours:0,company:'All in One',links:{projects:[],epics:[],helpdesk:false,tickets:{count:0,byProject:{},keys:[]}},...o});

test('budget status: zero and empty are neutral, near limit from 80%, over goes negative',()=>{
 assert.equal(NEAR_LIMIT,0.8);
 assert.deepEqual(budgetStatus(null,5),{status:'not_set',remainingHours:null,overHours:0,usedPercent:null});
 assert.deepEqual(budgetStatus(0,0),{status:'not_set',remainingHours:null,overHours:0,usedPercent:null});
 assert.equal(budgetStatus(0,0.5).status,'not_set');
 assert.equal(budgetStatus(10,7.9).status,'on_track');
 assert.equal(budgetStatus(10,8).status,'near');
 assert.equal(budgetStatus(10,10).status,'near');
 assert.deepEqual(budgetStatus(10,12.5),{status:'over',remainingHours:-2.5,overHours:2.5,usedPercent:125});
 assert.equal(budgetText({status:'over',overHours:2.5}),'Over by 2.5 h');
 assert.equal(budgetText({status:'on_track'}),'Within budget');
 assert.equal(percent(null),'—');assert.equal(signedHours(-2.5),'−2.5 h');
});

test('rows: filters by status, client, missing client, tickets and search; newest first with empty values last',()=>{
 const rows=[p({odooId:1,name:'Old',createdAt:'2025-01-01T00:00:00Z',status:'over',allocatedHours:1,loggedHours:2,remainingHours:-1,overHours:1,ticketCount:2}),
  p({odooId:2,name:'New',createdAt:'2026-06-01T00:00:00Z',client:'',missingClient:true,mapped:false}),
  p({odooId:3,name:'Undated',createdAt:null,client:'Globex',status:'near'})];
 assert.deepEqual(budgetRows(rows).map(r=>r.name),['New','Old','Undated']);
 assert.deepEqual(budgetRows(rows,{...DEFAULT_VIEW,dir:1}).map(r=>r.name),['Old','New','Undated']);
 assert.deepEqual(budgetRows(rows,{...DEFAULT_VIEW,status:'over'}).map(r=>r.name),['Old']);
 assert.deepEqual(budgetRows(rows,{...DEFAULT_VIEW,status:'unmapped'}).map(r=>r.name),['New']);
 assert.deepEqual(budgetRows(rows,{...DEFAULT_VIEW,client:'__none'}).map(r=>r.name),['New']);
 assert.deepEqual(budgetRows(rows,{...DEFAULT_VIEW,missingClient:'present'}).map(r=>r.name),['Old','Undated']);
 assert.deepEqual(budgetRows(rows,{...DEFAULT_VIEW,tickets:'with'}).map(r=>r.name),['Old']);
 assert.deepEqual(budgetRows(rows,{...DEFAULT_VIEW,q:'globex'}).map(r=>r.name),['Undated']);
 assert.deepEqual(budgetRows(rows,{...DEFAULT_VIEW,sort:'remaining',dir:1}).map(r=>r.name),['Old','New','Undated']);
 assert.deepEqual(budgetCounts(rows),{projects:3,over:1,near:1,notSet:1,unmapped:1,missingClient:1});
});

test('CSV: one line per row, allocation not set spelled out and negative remaining kept as a number',()=>{
 const [head,...lines]=budgetCsvRows([p({name:'A',allocatedHours:10,loggedHours:12.5,remainingHours:-2.5,overHours:2.5,usedPercent:125,status:'over'}),p({name:'B',client:'',missingClient:true})]);
 assert.equal(head[0],'Odoo Project');assert.equal(lines.length,2);
 assert.deepEqual(lines[0].slice(0,9),['A','Acme','2026-01-01',10,12.5,-2.5,125,'Over by 2.5 h',2.5]);
 assert.deepEqual(lines[1].slice(0,8),['B','No client','2026-01-01','No allocation',0,'','','No allocation']);
});

test('project picker: only active projects with a client; the ticket keeps its archived, clientless or unknown project, disabled',()=>{
 const list=[{id:1,label:'Acme → Web',clientName:'Acme'},{id:2,label:'Acme → Old',clientName:'Acme',archived:true},{id:3,label:'No client → Loose',clientName:'',missingClient:true}];
 const plain=projectChoices(list);
 assert.deepEqual(plain.choices.map(c=>c.id),[1]);assert.deepEqual(plain.noClient.map(x=>x.id),[3]);
 assert.deepEqual(projectChoices(list,2).choices.at(-1),{id:2,label:'Acme → Old (archived)',clientName:'Acme',disabled:true});
 assert.equal(projectChoices(list,3).choices.at(-1).label,'No client → Loose (no client)');
 assert.deepEqual(projectChoices(list,99).choices.at(-1),{id:99,label:'Odoo project #99 (not found)',clientName:'',disabled:true});
});

test('Map tickets: the table’s assignable rows are the choices; a suggestion only for a ready ticket whose project is offered',()=>{
 const choices=assignableProjects([p({odooId:2,name:'Web',label:'Acme → Web',assignable:true}),p({odooId:3,name:'Old',assignable:false}),p({odooId:1,name:'App',client:'',assignable:true})]);
 assert.deepEqual(choices.map(c=>[c.id,c.label]),[[2,'Acme → Web'],[1,'No client → App']]);
 assert.deepEqual(mappingSuggestion({kind:'ready',odooProjectId:2},choices),{id:2,linked:[]});
 assert.deepEqual(mappingSuggestion({kind:'ready',odooProjectId:3},choices),{id:null,linked:[]});
 assert.deepEqual(mappingSuggestion({kind:'ambiguous',candidates:[{id:2},{id:3},{id:1}]},choices),{id:null,linked:[2,1]});
 assert.deepEqual(mappingSuggestion({kind:'missing',linked:{id:2}},choices),{id:null,linked:[]});
 assert.equal(hiddenFilterCount({...DEFAULT_VIEW,q:'x',client:'Acme'}),0);
 assert.equal(hiddenFilterCount({...DEFAULT_VIEW,status:'over',tickets:'with'}),2);
});

test('Map tickets: rows filter by kind and search; one project’s own tickets first; counts leave out applied tickets',()=>{
 const rows=[{key:'A-1',kind:'missing',client:'',project:''},{key:'A-2',kind:'ready',odooProjectId:5,client:'Acme',project:'Web'},{key:'A-3',kind:'ambiguous',candidates:[{id:5},{id:6}],client:'Acme',project:'Site'},{key:'A-4',kind:'conflict',client:'Globex',project:'Shop'}];
 assert.deepEqual(mappingRows(rows,{kind:'ready'}).map(r=>r.key),['A-2']);
 assert.deepEqual(mappingRows(rows,{q:'globex'}).map(r=>r.key),['A-4']);
 assert.deepEqual(mappingRows(rows,{q:'login',titles:{'A-1':'Login page'}}).map(r=>r.key),['A-1']);
 assert.deepEqual(mappingRows(rows,{project:5}).map(r=>r.key),['A-2','A-3','A-1','A-4']);
 assert.deepEqual(mappingCounts(rows,new Set(['A-2'])),{all:3,ready:0,missing:1,ambiguous:1,conflict:1});
});


test('project dates: inclusive creation and last-work ranges, missing dates excluded only with a range',()=>{
 const rows=[p({odooId:1,name:'First',createdAt:'2026-11-01T09:00:00Z',lastWorkDate:'2026-11-09'}),p({odooId:2,name:'Last',createdAt:'2026-11-10T12:00:00Z',lastWorkDate:'2026-10-01'}),p({odooId:3,name:'Missing',createdAt:null})];
 const view={...DEFAULT_VIEW,dateFrom:'2026-11-01',dateTo:'2026-11-10'};
 assert.deepEqual(budgetRows(rows,view).map(p=>p.odooId),[2,1]);
 assert.deepEqual(budgetRows(rows,{...view,dateField:'lastWork'}).map(p=>p.odooId),[1]);
 assert.equal(budgetRows(rows,{...DEFAULT_VIEW,dateTo:'2026-11-01'}).length,1);
 assert.equal(budgetRows(rows,DEFAULT_VIEW).length,3);
 assert.equal(budgetCsvRows(budgetRows(rows,view)).length,3);
});

test('the date filter compares the Asia/Jerusalem calendar day, with both boundaries inclusive',()=>{
  // 22:30 UTC on 1 May is 01:30 on 2 May in Jerusalem (summer time), so it belongs to 2 May.
  const p={createdAt:'2026-05-01T22:30:00Z',lastWorkDate:'2026-05-02'};
  assert.equal(dateMatches(p,{dateField:'created',dateFrom:'2026-05-02',dateTo:'2026-05-02'}),true);
  assert.equal(dateMatches(p,{dateField:'created',dateFrom:'2026-05-01',dateTo:'2026-05-01'}),false);
  assert.equal(dateMatches(p,{dateField:'lastWork',dateFrom:'2026-05-02',dateTo:'2026-05-02'}),true);
  assert.equal(dateMatches({createdAt:null},{dateField:'created',dateFrom:'2026-05-02'}),false);
  assert.equal(dateMatches({createdAt:null},{dateField:'created'}),true);
});
