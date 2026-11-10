import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_WORK,WORK_PERIODS,WORK_MODES,customPeriodError,workQuery} from '../../public/assets/models/project-workspace.js';

test('the work periods match the server: this month by default, and the same keys',()=>{
  assert.deepEqual(Object.keys(WORK_PERIODS),['month','last_month','last_30','all','custom']);
  assert.deepEqual(Object.keys(WORK_MODES),['work','all']);
  assert.deepEqual(DEFAULT_WORK,{period:'month',from:'',to:'',mode:'work',billable:false});
});

test('a custom period is checked in words: both dates, real dates, start not after end, at most about a year',()=>{
  assert.equal(customPeriodError('2026-03-05','2026-03-05'),'','one day is a period');
  assert.equal(customPeriodError('','2026-03-05'),'Choose both dates.');
  assert.equal(customPeriodError('2026-03-05',''),'Choose both dates.');
  assert.equal(customPeriodError('2026-02-30','2026-03-01'),'Choose valid dates.');
  assert.equal(customPeriodError('03/05/2026','2026-03-06'),'Choose valid dates.');
  assert.equal(customPeriodError('2026-03-10','2026-03-01'),'The start date is after the end date.');
  assert.equal(customPeriodError('2025-01-01','2026-02-05'),'','400 days apart is allowed');
  assert.equal(customPeriodError('2025-01-01','2026-02-06'),'Choose at most about a year.','401 days apart is not');
});

test('the query carries the period, the mode and the billable filter; dates only for a custom period',()=>{
  assert.equal(workQuery(DEFAULT_WORK).toString(),'period=month&mode=work');
  assert.equal(workQuery({...DEFAULT_WORK,billable:true,mode:'all'}).toString(),'period=month&mode=all&billable=1');
  assert.equal(workQuery({...DEFAULT_WORK,period:'last_month',from:'2026-01-01',to:'2026-01-02'}).toString(),'period=last_month&mode=work','dates are ignored outside a custom period');
  assert.equal(workQuery({...DEFAULT_WORK,period:'custom',from:'2026-03-05',to:'2026-03-06'}).toString(),'period=custom&mode=work&from=2026-03-05&to=2026-03-06');
});
