import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectReport} from '../../public/assets/models/report-view.js';
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
