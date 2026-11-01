import {test} from "node:test";
import assert from "node:assert/strict";
import {calculateWorkload, workloadTotals} from "../../public/assets/models/workload.js";
test("multi-label workload preserves overlap and excludes completed work from overdue",()=>{
  const issues=[{devs:["one","two"],assignee:"lead",status:"Pending QA",cat:"indeterminate",due:"2026-10-10"},{devs:["one"],assignee:"lead",status:"Closed",cat:"done",due:"2026-10-01"},{devs:[],assignee:null,status:"Open",cat:"new",due:null}];
  const rows=calculateWorkload(issues,["one","two","__none"],"2026-10-11");assert.equal(rows[0].open,1);assert.equal(rows[0].completed,1);assert.equal(rows[0].overdue,1);assert.equal(rows[1].inProgress,1);assert.equal(rows[2].noDueDate,1);
  const assignees=calculateWorkload(issues,["lead","other"],"2026-10-11","assignee");assert.equal(assignees[0].open,1);assert.equal(assignees[1].open,1);assert.deepEqual(rows[0].statuses,[{status:"Pending QA",count:1},{status:"Closed",count:1}]);
});
test("team totals count a multi-developer ticket once",()=>{
  const issues=[{devs:["one","two"],assignee:"lead",status:"Pending QA",cat:"indeterminate",due:"2026-10-10"},{devs:["one"],assignee:"lead",status:"Closed",cat:"done",due:"2026-10-01"},{devs:[],assignee:null,status:"Open",cat:"new",due:null}];
  const totals=workloadTotals(issues,"2026-10-11");
  assert.equal(totals.tickets,3);assert.equal(totals.open,2);assert.equal(totals.inProgress,1);assert.equal(totals.overdue,1);assert.equal(totals.noDueDate,1);assert.equal(totals.completed,1);
  assert.deepEqual(totals.statuses,[{status:"Pending QA",count:1},{status:"Closed",count:1},{status:"Open",count:1}]);
});
