// Prioritize actionable findings before bounded model context truncates the tail.
export function prioritizeReportTickets(tickets,workflow,today){
 const overdueDays=t=>t.closed||!/^\d{4}-\d{2}-\d{2}$/.test(t.due||'')?0:Math.max(0,Math.floor((Date.parse(today)-Date.parse(t.due))/86400000));
 const score=t=>workflow==='hours'?(Number(t.overEstimate?.hours)||0):workflow==='completeness'?(t.closed&&t.missing?.length?100:0)+(t.overrides?.length?50:0)+(t.missing?.length||0):(!t.closed?10:0)+Math.min(overdueDays(t),60)*2+(t.risks?.length||0)*5+(t.overrides?.length?20:0);
 return [...tickets].sort((a,b)=>score(b)-score(a)||String(a.key).localeCompare(String(b.key),undefined,{numeric:true}));
}
export function reportEvidenceSummary(tickets){
 return {scope:'All findings returned by this workflow; these counts are not whole-project totals.',findings:tickets.length,overdue:tickets.filter(t=>t.risks?.includes('Overdue')).length,missingApprovedDueDate:tickets.filter(t=>t.risks?.includes('No approved due date')).length,inactiveSevenDays:tickets.filter(t=>t.risks?.includes('No activity for at least seven calendar days')).length,overEstimate:tickets.filter(t=>t.overEstimate).length,closedWithMissingFields:tickets.filter(t=>t.closed&&t.missing?.length).length};
}
