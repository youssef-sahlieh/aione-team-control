import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prioritizeReportTickets,reportEvidenceSummary} from '../proxy/src/ai-report-evidence.js';
test('urgent old tickets survive evidence bounding ahead of newer routine tickets',()=>{
 const rows=[{key:'AION-1',closed:false,due:'2026-10-30',risks:[]},{key:'AION-2',closed:false,due:'2026-10-01',risks:['Overdue']},{key:'AION-3',closed:true,due:'2026-01-01',risks:[]}];
 assert.equal(prioritizeReportTickets(rows,'delivery','2026-10-18')[0].key,'AION-2');assert.equal(rows[0].key,'AION-1');
 assert.equal(prioritizeReportTickets([{key:'AION-1',overEstimate:{hours:1}},{key:'AION-2',overEstimate:{hours:20}}],'hours','2026-10-18')[0].key,'AION-2');
 assert.equal(prioritizeReportTickets([{key:'AION-1',missing:['estimate']},{key:'AION-2',closed:true,missing:['work done']}],'completeness','2026-10-18')[0].key,'AION-2');
 const summary=reportEvidenceSummary(rows);assert.equal(summary.overdue,1);assert.equal(summary.findings,3);assert.match(summary.scope,/not whole-project/);
});
