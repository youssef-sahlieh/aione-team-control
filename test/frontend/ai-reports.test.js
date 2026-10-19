import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildReportPrompt,reportPresets} from '../../public/assets/models/ai-report-presets.js';
test('report drafts preserve workflow, period, scope and evidence constraints',()=>{
 for(const preset of reportPresets){const prompt=buildReportPrompt(preset.id,{days:14,focus:'Sample client'});assert.match(prompt,new RegExp('workflow "'+preset.workflow+'" and days 14'));assert.match(prompt,/includes today in Asia\/Jerusalem/);assert.match(prompt,/Sample client/);assert.match(prompt,/broader report scope/);assert.match(prompt,/not hours worked/);assert.match(prompt,/unavailable, not zero/);assert.match(prompt,/do not claim to have checked/);assert.ok(prompt.length<=2000);}
 assert.match(buildReportPrompt('management'),/all authorized Jira and internal tickets/);
 assert.throws(()=>buildReportPrompt('deployments'));assert.throws(()=>buildReportPrompt('hours',{days:90}));
});
