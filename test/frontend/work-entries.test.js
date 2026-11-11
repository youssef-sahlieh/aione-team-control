// The Work entries view's filters, requests and labels (models/work-entries.js). Synthetic data only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_WORK,customPeriodError,workQuery,exportQuery,withFilter,taskLabel,billingLabel,workCsv,summaryText} from '../../public/assets/models/work-entries.js';

test('a filter change goes back to the first page; paging keeps the filters',()=>{
  const v={...DEFAULT_WORK,offset:100,limit:50};
  assert.equal(withFilter(v,{client:'900'}).offset,0);
  assert.equal(withFilter(v,{client:'900'}).client,'900');
});

test('the request carries every filter the view holds, and custom dates only for the custom period',()=>{
  const q=new URLSearchParams(workQuery({...DEFAULT_WORK,client:'900',project:'10',q:' checkout ',billable:true,period:'last_month',offset:50,limit:25}));
  assert.equal(q.get('period'),'last_month');assert.equal(q.get('client'),'900');assert.equal(q.get('project'),'10');
  assert.equal(q.get('search'),'checkout');assert.equal(q.get('billable'),'1');assert.equal(q.get('offset'),'50');assert.equal(q.get('limit'),'25');
  assert.equal(q.has('from'),false);
  const c=new URLSearchParams(workQuery({...DEFAULT_WORK,period:'custom',from:'2026-10-27',to:'2026-10-27'}));
  assert.equal(c.get('from'),'2026-10-27');assert.equal(c.get('to'),'2026-10-27');
});

test('export asks for every matching row, with the same filters and no page',()=>{
  const q=new URLSearchParams(exportQuery({...DEFAULT_WORK,client:'901',billable:true,offset:50}));
  assert.equal(q.get('export'),'1');assert.equal(q.get('client'),'901');assert.equal(q.get('billable'),'1');
  assert.equal(q.has('offset'),false);assert.equal(q.has('limit'),false);
});

test('custom dates are checked in the browser the same way the server checks them',()=>{
  assert.equal(customPeriodError('2026-03-05','2026-03-05'),'','one day is a period');
  assert.match(customPeriodError('2026-03-10','2026-03-01'),/after the end date/);
  assert.match(customPeriodError('2026-02-30','2026-03-01'),/valid/);
  assert.match(customPeriodError('2026-03-01',''),/valid/);
  assert.match(customPeriodError('2024-01-01','2026-03-01'),/about a year/);
  assert.equal(customPeriodError('2028-02-29','2028-02-29'),'','leap day');
  assert.match(customPeriodError('2027-02-29','2027-02-29'),/valid/,'not a leap year');
});

test('a row without a task says so; billing names the source when it is the project',()=>{
  assert.equal(taskLabel({task:null}),'No task');
  assert.equal(taskLabel({task:{key:'AION-7',name:'Checkout fails'}}),'AION-7 Checkout fails');
  assert.equal(billingLabel({value:'billable',source:'project'}),'Billable (project default)');
  assert.equal(billingLabel({value:'not_billable',source:'ticket'}),'Not billable (set on the ticket)');
  assert.equal(billingLabel({value:'unclassified',source:'none'}),'Not classified');
});

test('the summary and the CSV: the Odoo rows, then the dashboard rows marked as not in Odoo yet',()=>{
  assert.equal(summaryText({count:1,hours:1.5,billableHours:0}),'1 entry · 1.5 h actual · 0 h billable actual');
  const odoo={date:'2026-10-27',client:{name:'Acme'},project:{name:'Branch A'},task:null,person:'Dana',description:'Set up, "staging"',hours:2,billing:{value:'billable',source:'project'},source:'odoo'};
  const pending={...odoo,date:'2026-11-02',hours:1,source:'dashboard'};
  const text=workCsv([odoo],[pending]);
  const lines=text.replace(/^﻿/,'').split('\r\n');
  assert.equal(lines[0],'Work date,Client,Project,Ticket / task,Person,Description,Hours,Billing,Source');
  assert.equal(lines[1],'2026-10-27,Acme,Branch A,No task,Dana,"Set up, ""staging""",2,Billable (project default),Odoo');
  assert.match(lines[2],/,1,Billable \(project default\),"Dashboard, not in Odoo yet"$/,'the source is quoted because it has a comma');
});
