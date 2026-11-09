import {test} from "node:test";
import assert from "node:assert/strict";
import {calculateWorkload, workloadTotals, isOverdue, hasNoDueDate} from "../../public/assets/models/workload.js";
test("multi-label workload preserves overlap and excludes completed work from overdue",()=>{
  const issues=[{devs:["one","two"],assignee:"lead",status:"Pending QA",cat:"indeterminate",due:"2026-10-10"},{devs:["one"],assignee:"lead",status:"Closed",cat:"done",due:"2026-10-01"},{devs:[],assignee:null,status:"Open",cat:"new",due:null}];
  const rows=calculateWorkload(issues,["one","two","__none"],"2026-10-11");assert.equal(rows[0].open,1);assert.equal(rows[0].completed,1);assert.equal(rows[0].overdue,1);assert.equal(rows[1].inProgress,1);assert.equal(rows[2].noDueDate,1);
  const assignees=calculateWorkload(issues,["lead","other"],"2026-10-11","assignee");assert.equal(assignees[0].open,1);assert.equal(assignees[1].open,1);assert.deepEqual(rows[0].statuses,[{status:"Pending QA",count:1}]);
});
test("team totals count a multi-developer ticket once",()=>{
  const issues=[{devs:["one","two"],assignee:"lead",status:"Pending QA",cat:"indeterminate",due:"2026-10-10"},{devs:["one"],assignee:"lead",status:"Closed",cat:"done",due:"2026-10-01"},{devs:[],assignee:null,status:"Open",cat:"new",due:null}];
  const totals=workloadTotals(issues,"2026-10-11");
  assert.equal(totals.tickets,3);assert.equal(totals.open,2);assert.equal(totals.inProgress,1);assert.equal(totals.overdue,1);assert.equal(totals.noDueDate,1);assert.equal(totals.completed,1);
  assert.deepEqual(totals.statuses,[{status:"Pending QA",count:1},{status:"Open",count:1}]);
  assert.equal(totals.shared,1);assert.equal(totals.noDeveloper,1);
});
test("overdue and no-date use the ticket list rules: Odoo Helpdesk tickets are neither, and the day boundary is strict",()=>{
  const issues=[{devs:["one"],status:"Open",cat:"new",due:"2026-10-10",odoo:true},{devs:["one"],status:"Open",cat:"new",due:null,odoo:true},{devs:["one"],status:"Open",cat:"new",due:"2026-10-11"},{devs:["one"],status:"Open",cat:"new",due:"2026-10-10"}];
  const [one]=calculateWorkload(issues,["one"],"2026-10-11");
  assert.equal(one.open,4);assert.equal(one.overdue,1);assert.equal(one.noDueDate,0);
  assert.equal(issues.filter(i=>isOverdue(i,"2026-10-11")).length,one.overdue);assert.equal(issues.filter(hasNoDueDate).length,one.noDueDate);
});
test("shared tickets count for every developer and once in the team total",()=>{
  const issues=[{devs:["one","two"],status:"Open",cat:"new",due:"2026-10-01"},{devs:["one","two","three"],status:"Open",cat:"new",due:null},{devs:["two"],status:"Done",cat:"done",due:null}];
  const rows=calculateWorkload(issues,["one","two","three"],"2026-10-11"),team=workloadTotals(issues,"2026-10-11");
  assert.deepEqual(rows.map(r=>[r.open,r.shared,r.overdue]),[[2,2,1],[2,2,1],[1,1,0]]);
  assert.equal(rows.reduce((n,r)=>n+r.open,0),5);assert.equal(team.open,2);assert.equal(team.shared,2);assert.equal(team.overdue,1);assert.equal(team.noDeveloper,0);
});
