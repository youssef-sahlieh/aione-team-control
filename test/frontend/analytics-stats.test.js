import {test} from "node:test";
import assert from "node:assert/strict";
import {priorPeriod,applyFilters,kpis,weeklyFlow,weeklyHours,hoursByClient,openByAge,openAt,isOverdue} from "../../public/assets/models/analytics-stats.js";

// Synthetic data only. Days are Asia/Jerusalem calendar days.
const t=(over={})=>({key:"AION-1",source:"jira",title:"x",status:"Open",cat:"indeterminate",createdDay:"2026-10-01",completedDay:null,dueDay:null,clientId:"c1",clientName:"Acme",devs:["dana"],loggedMinutes:0,...over});
const period={from:"2026-10-05",to:"2026-10-11"};

test("the prior period has the same length and ends the day before",()=>{
  assert.deepEqual(priorPeriod(period),{from:"2026-09-28",to:"2026-10-04"});
  assert.deepEqual(priorPeriod({from:"2026-03-01",to:"2026-03-01"}),{from:"2026-02-28",to:"2026-02-28"});
});

test("created, completed and open are counted by calendar day, and open at the period end ignores later completions",()=>{
  const tickets=[
    t({key:"A",createdDay:"2026-10-06"}),
    t({key:"B",createdDay:"2026-09-01",cat:"done",completedDay:"2026-10-08"}),
    t({key:"C",createdDay:"2026-09-01",cat:"done",completedDay:"2026-10-20"}),
    t({key:"D",createdDay:"2026-10-15"}),
  ];
  const k=kpis({tickets,entries:null},period,"2026-10-25");
  assert.equal(k.created.value,1);assert.equal(k.completed.value,1);
  assert.equal(k.open.value,2); // A, and C which was still open on 2026-10-11; D did not exist yet
  assert.equal(k.open.netFlow,0);
  assert.equal(k.created.prior,0);
});

test("a completed ticket with no completion day is reported, not counted",()=>{
  const k=kpis({tickets:[t({key:"A",cat:"done",completedDay:null})],entries:null},period,"2026-10-25");
  assert.equal(k.completed.value,0);assert.equal(k.completed.unknownCompletion,1);
});

test("overdue uses approved due dates on open tickets only",()=>{
  const open=t({dueDay:"2026-10-10"}),done=t({key:"B",cat:"done",completedDay:"2026-10-09",dueDay:"2026-10-01"}),none=t({key:"C"});
  assert.equal(isOverdue(open,"2026-10-11"),true);assert.equal(isOverdue(open,"2026-10-10"),false);
  assert.equal(isOverdue(done,"2026-10-11"),false);assert.equal(isOverdue(none,"2026-10-11"),false);
  const k=kpis({tickets:[open,done,none],entries:null},period,"2026-10-11");
  assert.deepEqual(k.overdue,{value:1,withDueDate:1});
});

test("on-time percentage uses only completed tickets with a due date and shows its denominator",()=>{
  const tickets=[t({key:"A",cat:"done",completedDay:"2026-10-06",dueDay:"2026-10-06"}),t({key:"B",cat:"done",completedDay:"2026-10-07",dueDay:"2026-10-06"}),t({key:"C",cat:"done",completedDay:"2026-10-07"})];
  const k=kpis({tickets,entries:null},period,"2026-10-25");
  assert.deepEqual({kept:k.onTime.kept,of:k.onTime.of,percent:k.onTime.percent},{kept:1,of:2,percent:50});
  assert.equal(kpis({tickets:[t()],entries:null},period,"2026-10-25").onTime.percent,null);
});

test("hours are unknown when the work log is unreadable, and zero only when it was read and empty",()=>{
  assert.equal(kpis({tickets:[],entries:null},period,"2026-10-25").hours.value,null);
  assert.equal(kpis({tickets:[],entries:[]},period,"2026-10-25").hours.value,0);
  const entries=[["AION-1","2026-10-05",0,90,0],["INT-1","2026-10-06",0,30,1],["AION-1","2026-10-12",0,600,0],["HD-1","2026-10-07",1,60,2]];
  const k=kpis({tickets:[],entries},period,"2026-10-25");
  assert.equal(k.hours.value,3);
  assert.deepEqual(k.hours.bySource,[{source:"jira",hours:1.5},{source:"internal",hours:0.5},{source:"odoo",hours:1}]);
});

test("filters apply to tickets and to the work on them; Odoo work only shows with no client or developer filter",()=>{
  const snapshot={tickets:[t({key:"A",clientId:"c1",devs:["dana"]}),t({key:"B",clientId:"c2",devs:["lee"],source:"internal"})],entries:[["A","2026-10-05",0,60,0],["B","2026-10-05",0,60,1],["HD-1","2026-10-05",0,60,2]]};
  assert.equal(applyFilters(snapshot,{}).entries.length,3);
  assert.deepEqual(applyFilters(snapshot,{client:"c1"}).tickets.map(x=>x.key),["A"]);
  assert.equal(applyFilters(snapshot,{client:"c1"}).entries.length,1);
  assert.equal(applyFilters(snapshot,{dev:"lee"}).entries.length,1);
  assert.deepEqual(applyFilters(snapshot,{source:"odoo"}).entries.map(e=>e[0]),["HD-1"]);
  assert.equal(applyFilters({...snapshot,entries:null},{client:"c1"}).entries,null);
});

test("weekly flow starts weeks on Sunday and drops what is outside the period",()=>{
  const tickets=[t({key:"A",createdDay:"2026-10-05"}),t({key:"B",createdDay:"2026-10-12",cat:"done",completedDay:"2026-10-13"}),t({key:"C",createdDay:"2026-09-01"})];
  const weeks=weeklyFlow(tickets,period);
  // 2026-10-11 is a Sunday, so the period's last day opens a second, partial week.
  assert.deepEqual(weeks.map(w=>w.start),["2026-10-04","2026-10-11"]);
  assert.equal(weeks[0].created,1);
  const two=weeklyFlow(tickets,{from:"2026-10-05",to:"2026-10-14"});
  assert.deepEqual(two.map(w=>[w.start,w.created,w.completed]),[["2026-10-04",1,0],["2026-10-11",1,1]]);
});

test("weekly hours split by source, and are null without a work log",()=>{
  assert.equal(weeklyHours(null,period),null);
  const w=weeklyHours([["A","2026-10-05",0,90,0],["B","2026-10-06",0,30,1]],period);
  assert.deepEqual(w,[{start:"2026-10-04",jira:1.5,internal:0.5,odoo:0},{start:"2026-10-11",jira:0,internal:0,odoo:0}]);
});

test("hours by client puts work with no client in its own row and sorts largest first",()=>{
  const tickets=[t({key:"A",clientId:"c1",clientName:"Acme"}),t({key:"B",clientId:"c2",clientName:"Beta"})];
  const rows=hoursByClient({tickets,entries:[["A","2026-10-05",0,60,0],["B","2026-10-05",0,180,0],["HD-1","2026-10-06",0,30,2],["A","2026-11-01",0,999,0]]},period);
  assert.deepEqual(rows.map(r=>[r.client,r.hours]),[["Beta",3],["Acme",1],["No client",0.5]]);
  assert.equal(hoursByClient({tickets,entries:null},period),null);
});

test("open work by age counts unknown creation apart and never counts done tickets",()=>{
  const tickets=[t({key:"A",createdDay:"2026-10-24"}),t({key:"B",createdDay:"2026-09-01"}),t({key:"C",createdDay:null}),t({key:"D",cat:"done",createdDay:"2026-01-01",completedDay:"2026-02-01"})];
  const a=openByAge(tickets,"2026-10-25");
  assert.equal(a.open,3);assert.equal(a.unknown,1);
  assert.deepEqual(a.buckets.map(b=>b.count),[1,0,0,1,0]); // 1 day old, and 54 days old (31–60)
});

test("openAt needs a creation day",()=>{assert.equal(openAt(t({createdDay:null}),"2026-10-11"),false);});
