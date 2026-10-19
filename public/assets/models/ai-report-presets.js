// Prompt drafts are guidance, never permissions or calculated report results.
export const reportPresets = Object.freeze([
 {id:'management',title:'Management summary',description:'Open work, delivery risks and decisions to review.',workflow:'management'},
 {id:'delivery',title:'Delivery risks',description:'Overdue work, missing dates and stalled tickets.',workflow:'delivery'},
 {id:'hours',title:'Hours review',description:'Estimate overruns and ticket-total hour evidence.',workflow:'hours'},
 {id:'completeness',title:'Completeness check',description:'Missing fields and closure exceptions.',workflow:'completeness'}
]);
export function buildReportPrompt(id,{days=7,focus=''}={}) {
 const preset=reportPresets.find(p=>p.id===id);
 if(!preset||![7,14,30].includes(Number(days)))throw new Error('Choose a supported report and period.');
 const context=String(focus).trim().slice(0,180);
 const analysis={management:'Lead with the main delivery concern, then distinguish current open work from period created/completed counts. Identify decisions that need manager attention.',delivery:'Rank the most urgent overdue or stalled tickets. Include available due dates and assigned developers, explain the concrete risk and propose a next step.',hours:'Rank overruns by excess hours and show estimate, actual, difference and percentage when available. Use Work done as evidence, not proof of a cause. Preserve the original estimate; never recommend changing it just to match actual hours.',completeness:'Prioritize closed tickets with missing fields and closure overrides, then open-ticket gaps. Name the missing field and the proposed correction.'}[id];
 return [
  'Prepare a '+preset.title.toLowerCase()+' using run_dashboard_report with workflow "'+preset.workflow+'" and days '+Number(days)+'. The period includes today in Asia/Jerusalem. Created/completed cohorts use this period; open work and risk checks are current snapshots.',
  context?'Focus: '+context+'. Apply this focus only where source data supports it; if filtered totals are unavailable, label totals as the broader report scope.':'Scope: all authorized Jira and internal tickets. Dashboard display filters do not limit this report.',
  analysis,
  'Use calculated report results as authoritative. Give a short conclusion, up to 5 prioritized evidence-backed findings with ticket keys and a specific proposed next step for each, then brief data limitations. Avoid repeating actions in multiple sections. Separate facts from possible explanations. If the report tool is unavailable, say so; do not replace it with guessed totals.',
  'Label hours as current ticket-total hours, not hours worked during the period. Missing hours are unavailable, not zero. Explain incomplete source coverage and omitted detail rows. Odoo, database health and deployment evidence are unavailable in these tools; do not claim to have checked them.'
 ].join('\n\n');
}
