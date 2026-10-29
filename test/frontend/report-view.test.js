import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectReport,unifiedCsv,groupByEmployee,parseAgreedCsv,flagLabel,insights,UNIFIED_HEADERS} from '../../public/assets/models/report-view.js';
const rows=[
 {key:'AION-20',title:'Delayed',clientId:'a',clientName:'Client A',devs:['one','two'],status:'Open',closed:false,created:'2026-10-10T12:00:00Z',due:'2026-10-11',estimatedHours:2,actualHours:5,billing:'billable',missing:[],risks:['Overdue'],overrides:[],overEstimate:{hours:3,percent:150}},
 {key:'INT-2',title:'Older completed',internal:true,clientId:'b',clientName:'Client B',devs:[],status:'Closed',closed:true,created:'2026-01-01T12:00:00Z',completedAt:null,estimatedHours:null,actualHours:null,missing:['Work done'],risks:[],overrides:[]},
 {key:'AION-3',title:'Recent completion',clientId:'a',clientName:'Client A',devs:['two'],status:'Done',closed:true,created:'2026-10-08T22:30:00Z',completedAt:'2026-10-10T12:00:00Z',estimatedHours:1,actualHours:null,missing:['Actual hours'],risks:[],overrides:[]}
];
const snapshot={workflow:'all',period:{start:'2026-10-09',end:'2026-10-15'},coverage:{examined:3,jiraComplete:false},warnings:['Partial source'],tickets:rows};
test('all reports keep source order and old closed findings until filters select a workflow',()=>{
 const all=selectReport(snapshot);assert.deepEqual(all.tickets.map(t=>t.key),['AION-20','INT-2','AION-3']);assert.equal(all.totals.open,1);assert.equal(all.totals.created,2);assert.equal(all.totals.completed,1);assert.equal(all.coverage.jiraComplete,false);assert.deepEqual(all.warnings,['Partial source']);assert.equal(all.groups[0].actualHours,5);assert.equal(all.groups.reduce((n,g)=>n+g.missingActual,0),1);
 assert.deepEqual(selectReport(snapshot,{workflow:'management'}).tickets.map(t=>t.key),['AION-20','AION-3']);assert.equal(selectReport(snapshot,{workflow:'hours'}).tickets.length,1);assert.equal(selectReport(snapshot,{workflow:'completeness'}).tickets.length,2);
});
test('combined filters recalculate totals without mutating the snapshot or double counting shared work',()=>{
 const filtered=selectReport(snapshot,{developer:'two',clientId:'a',billing:'billable',workflow:'delivery'});assert.equal(filtered.tickets.length,1);assert.equal(filtered.totals.atRisk,1);assert.equal(filtered.groups[0].tickets,1);assert.equal(filtered.groups[0].estimatedHours,2);assert.equal(rows[0].createdInPeriod,undefined);
 assert.equal(selectReport(snapshot,{source:'internal',developer:'__none',status:'__closed'}).tickets[0].key,'INT-2');assert.equal(selectReport(snapshot,{text:'recent completion'}).tickets[0].key,'AION-3');assert.equal(selectReport(snapshot,{start:'2026-10-11',end:'2026-10-12'}).totals.created,0);
});
test('sorting is explicit, numeric and keeps missing values last in either direction',()=>{
 assert.deepEqual(selectReport(snapshot,{sort:'key:asc'}).tickets.map(t=>t.key),['AION-3','AION-20','INT-2']);assert.equal(selectReport(snapshot,{sort:'estimatedHours:desc'}).tickets.at(-1).key,'INT-2');assert.equal(selectReport(snapshot,{sort:'estimatedHours:asc'}).tickets.at(-1).key,'INT-2');assert.deepEqual(rows.map(t=>t.key),['AION-20','INT-2','AION-3']);
});
// One row per ticket with its agreed and logged hours and the overage flag.
const unified=[
 {key:'AION-1',title:'=HYPERLINK("x")',status:'Open',clientId:'a',clientName:'Client A',devs:['Dana'],employees:[{name:'Dana',hours:2},{name:'Ron',hours:1}],estimatedHours:2,agreedHours:2.5,loggedHours:3,actualHours:3,overage:'overage',overHours:0.5,closed:false,created:'2026-10-01T10:00:00Z',completedAt:null,billing:'billable'},
 {key:'AION-2',title:'Quiet',status:'Open',clientId:'b',clientName:'Client B',devs:['Ron'],employees:[{name:'Ron',hours:1}],estimatedHours:null,agreedHours:4,loggedHours:1,actualHours:1,overage:'ok',overHours:0,closed:false,created:'2026-10-02T10:00:00Z',completedAt:null},
 {key:'AION-3',title:'None set',status:'Open',clientId:'a',clientName:'Client A',devs:[],employees:[],estimatedHours:null,agreedHours:null,loggedHours:0,actualHours:null,overage:null,closed:false,created:'2026-10-03T10:00:00Z',completedAt:null}
];
const unifiedSnapshot={workflow:'all',period:{start:'2026-10-01',end:'2026-10-31'},coverage:{examined:3},warnings:[],tickets:unified};
test('the flag and employee filters pick tickets; "none" is tickets with no agreed hours',()=>{
 const keys=f=>selectReport(unifiedSnapshot,f).tickets.map(t=>t.key);
 assert.deepEqual(keys({flag:'overage'}),['AION-1']);assert.deepEqual(keys({flag:'ok'}),['AION-2']);assert.deepEqual(keys({flag:'none'}),['AION-3']);
 assert.deepEqual(keys({employee:'Ron'}),['AION-1','AION-2']);assert.deepEqual(keys({employee:'Nobody'}),[]);
 assert.equal(flagLabel(unified[0]),'Needs checkup');assert.equal(flagLabel(unified[1]),'Within agreed hours');assert.equal(flagLabel(unified[2]),'No agreed hours');
});
test('the unified CSV has one quoted row per ticket, CRLF, with formulas neutralized',()=>{
 const lines=unifiedCsv(unified).split('\r\n');
 assert.equal(lines.length,4);assert.equal(lines[0],UNIFIED_HEADERS.map(h=>'"'+h+'"').join(','));
 assert.match(lines[1],/^"AION-1",/);
 assert.ok(lines[1].includes('"\'=HYPERLINK(""x"")"'),'a title that starts with = is prefixed with an apostrophe and its quotes doubled');
 assert.ok(lines[1].includes('"Dana (2 h); Ron (1 h)"'));assert.ok(lines[1].includes('"Needs checkup"'));
 assert.ok(lines[3].includes(',"",'),'an unset agreed value is an empty cell');
});
test('grouping by employee then customer: a ticket appears under each person with their own hours',()=>{
 const people=groupByEmployee(unified);
 assert.deepEqual(people.map(p=>p.name),['Dana','Ron','No work logged']);
 const ron=people[1];assert.equal(ron.hours,2);
 assert.deepEqual(ron.customers.map(c=>c.name),['Client A','Client B']);
 assert.equal(ron.customers[0].hours,1);assert.equal(ron.customers[0].tickets[0].employeeHours,1);
 assert.equal(people[2].customers[0].tickets[0].key,'AION-3');
});
test('agreed-hours CSV: BOM, quoted cells and CRLF are read; a missing header is refused',()=>{
 assert.deepEqual(parseAgreedCsv('﻿"Ticket","Agreed hours"\r\n"AION-1","12.5"\r\nAION-2,4\r\n'),[{key:'AION-1',agreedHours:'12.5'},{key:'AION-2',agreedHours:'4'}]);
 assert.deepEqual(parseAgreedCsv('Ticket,Agreed hours\n\n AION-1 , 2 \n\n'),[{key:'AION-1',agreedHours:'2'}]);
 assert.throws(()=>parseAgreedCsv('Key,Hours\nAION-1,2'),/"Ticket" and "Agreed hours"/);
});
test('insights: KPIs, burn buckets, breakdowns and months are computed from the same rows as the report',()=>{
 const s=insights(unified);
 assert.equal(s.kpis.tickets,3);assert.equal(s.kpis.open,3);assert.equal(s.kpis.closed,0);
 assert.equal(s.kpis.withAgreed,2);assert.equal(s.kpis.noAgreed,1);assert.equal(s.kpis.checkups,1);assert.equal(s.kpis.checkupRate,50);
 assert.equal(s.kpis.agreedHours,6.5);assert.equal(s.kpis.loggedOnAgreed,4);assert.equal(s.kpis.burnRate,61.5);
 assert.equal(s.kpis.loggedHours,4);assert.equal(s.kpis.estimatedHours,2);assert.equal(s.kpis.actualHours,4);
 assert.deepEqual(s.burn.map(b=>b.tickets),[1,0,0,1],'AION-2 is under 50%, AION-1 is over 100%');
 assert.deepEqual(s.flags.map(f=>[f.label,f.tickets]),[['Needs checkup',1],['Within agreed hours',1],['No agreed hours',1]]);
 assert.deepEqual(s.byEmployee.map(e=>[e.label,e.loggedHours,e.tickets]),[['Dana',2,1],['Ron',2,2]]);
 assert.deepEqual(s.byClient.map(c=>[c.label,c.tickets,c.loggedHours,c.checkups]),[['Client A',2,3,1],['Client B',1,1,0]]);
 assert.deepEqual(s.byBilling.map(b=>[b.label,b.tickets]),[['billable',1],['Not set',2]]);
 assert.deepEqual(s.byOdoo,[{label:'Not set',tickets:3,agreedHours:6.5,loggedHours:4,checkups:1}]);
 assert.deepEqual(s.byMonth,[{month:'2026-10',created:3,completed:0}]);
});
test('insights on no rows are zero, and no rate is invented',()=>{
 const s=insights([]);
 assert.equal(s.kpis.tickets,0);assert.equal(s.kpis.checkupRate,null);assert.equal(s.kpis.burnRate,null);
 assert.deepEqual(s.byEmployee,[]);assert.deepEqual(s.byMonth,[]);assert.deepEqual(s.burn.map(b=>b.tickets),[0,0,0,0]);
});
