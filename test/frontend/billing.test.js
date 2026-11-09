import {test} from 'node:test';
import assert from 'node:assert/strict';
import {billingFigures,billingMatches,budgetCsvRows,budgetRows,DEFAULT_VIEW,hiddenFilterCount} from '../../public/assets/models/odoo-projects.js';
import {csvCell,csvText,entryCsvRows,taskCsvRows,ENTRY_HEADER,minutesText,allowanceText} from '../../public/assets/models/billing.js';

const p=(billing,o)=>({odooId:1,name:'P',client:'Acme',createdAt:'2026-01-01T00:00:00Z',allocatedHours:null,loggedHours:0,remainingHours:null,overHours:0,usedPercent:null,status:'not_set',mapped:true,missingClient:false,ticketCount:0,openTickets:0,reviewTickets:0,lastWorkDate:null,pendingHours:0,company:'',links:{projects:[],epics:[],helpdesk:false,tickets:{count:0,byProject:{},keys:[]}},billing,...o});
const b=o=>({default:'billable',actualMinutes:600,billableMinutes:540,chargeableMinutes:540,unclassifiedMinutes:0,status:'available',allowance:null,email:null,...o});

test('billing figures: hours from minutes, remaining goes negative when over',()=>{
  const f=billingFigures(p(b({status:'overage',allowance:{consumedMinutes:720,capacityMinutes:600,remainingMinutes:0,overageMinutes:120}})));
  assert.deepEqual([f.defaultLabel,f.workedHours,f.billableHours,f.consumedHours,f.allocatedHours,f.remainingHours,f.statusLabel],['Billable',10,9,12,10,-2,'Over allocation']);
  assert.equal(billingFigures(p(b({default:null}))).defaultLabel,'Not classified');
  assert.equal(billingFigures(p(null)),null);
});
test('billing filter: default, unclassified work, exhausted includes overage; cleared filters show all',()=>{
  const rows=[p(b(),{odooId:1}),p(b({default:'not_billable',status:'not_billable'}),{odooId:2}),p(b({status:'overage',unclassifiedMinutes:30}),{odooId:3}),p(b({status:'exhausted'}),{odooId:4}),p(null,{odooId:5})];
  const ids=f=>budgetRows(rows,{...DEFAULT_VIEW,billing:f}).map(r=>r.odooId).sort();
  assert.deepEqual(ids('billable'),[1,3,4]);
  assert.deepEqual(ids('not_billable'),[2]);
  assert.deepEqual(ids('unclassified'),[3]);
  assert.deepEqual(ids('exhausted'),[3,4]);
  assert.deepEqual(ids(''),[1,2,3,4,5]);
  assert.equal(billingMatches(p(null),'billable'),false);
  assert.equal(hiddenFilterCount({...DEFAULT_VIEW,billing:'near'}),1);
});
test('project CSV adds billing columns only when billing is on',()=>{
  assert.equal(budgetCsvRows([p(undefined)])[0].includes('Billing Default'),false);
  const rows=budgetCsvRows([p(b())]);assert.ok(rows[0].includes('Billing Default'));assert.equal(rows[0].length,rows[1].length);
});
test('export CSV: formula text is neutralised, numbers stay numbers, BOM and CRLF',()=>{
  assert.equal(csvCell('=HYPERLINK("x")'),'"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('+1'),'"\'+1"');assert.equal(csvCell('@me'),'"\'@me"');
  assert.equal(csvCell(-30),'-30');assert.equal(csvCell('a,b'),'"a,b"');
  const text=csvText([['a','b'],[1,2]]);assert.ok(text.startsWith('﻿'));assert.ok(text.includes('\r\n'));
  const rows=entryCsvRows([{chargeId:'e1',date:'2026-11-01',customer:'Acme',project:'Web',ticket:'AION-1',taskId:7,worker:'Dana',description:'-rm',actualMinutes:60,chargeableMinutes:60,exportedMinutes:30,deltaMinutes:30,billing:{value:'billable'},originLabel:'Actual work',allowanceId:'a1',saleOrderLineId:9,coverageLabel:'Covered',syncLabel:'Saved',exportState:'adjustment'}],{batchId:'B1',allowances:{a1:'Pack'}});
  assert.equal(rows[0],ENTRY_HEADER);assert.equal(rows[1].length,ENTRY_HEADER.length);
  assert.deepEqual([rows[1][0],rows[1][12],rows[1][15],rows[1][18]],['B1',30,'Pack / SO line 9','Adjustment']);
  assert.ok(csvText(rows).includes('"\'-rm"'));
  assert.equal(taskCsvRows([{customer:'A',project:'P',ticket:'T',title:'x',taskId:null,entries:2,actualMinutes:90,chargeableMinutes:60,deltaMinutes:60,origins:'Actual work',coverage:''}])[1][4],'');
});
test('minutes and allowance text',()=>{
  assert.equal(minutesText(90),'1h 30m');assert.equal(minutesText(-120),'−2h');assert.equal(minutesText(0),'0m');assert.equal(minutesText(null),'—');
  assert.equal(allowanceText({capacityMinutes:600,consumedMinutes:420,remainingMinutes:180,overageMinutes:0}),'7h of 10h · 3h left');
  assert.equal(allowanceText({capacityMinutes:600,consumedMinutes:720,remainingMinutes:0,overageMinutes:120}),'12h of 10h · 2h over');
  assert.equal(allowanceText({kind:'t_and_m',capacityMinutes:null}),'Unlimited time & materials');
});
