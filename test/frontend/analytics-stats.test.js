import {test} from "node:test";
import assert from "node:assert/strict";
import {priorPeriod,applyFilters,kpis,weeklyFlow,weeklyHours,hoursByClient,hoursByPerson,odooSplit} from "../../public/assets/models/analytics-stats.js";

// Synthetic data only. Days are Asia/Jerusalem calendar days.
const t=(over={})=>({key:"AION-1",source:"jira",title:"x",status:"Open",cat:"indeterminate",createdDay:"2026-10-01",completedDay:null,dueDay:null,clientId:"c1",clientName:"Acme",devs:["dana"],loggedMinutes:0,...over});
const period={from:"2026-10-05",to:"2026-10-11"};

test("the prior period has the same length and ends the day before",()=>{
  assert.deepEqual(priorPeriod(period),{from:"2026-09-28",to:"2026-10-04"});
  assert.deepEqual(priorPeriod({from:"2026-03-01",to:"2026-03-01"}),{from:"2026-02-28",to:"2026-02-28"});
});

test("created and completed are counted by calendar day, and net backlog change is created minus completed",()=>{
  const tickets=[
    t({key:"A",createdDay:"2026-10-06"}),
    t({key:"B",createdDay:"2026-09-01",cat:"done",completedDay:"2026-10-08"}),
    t({key:"C",createdDay:"2026-09-01",cat:"done",completedDay:"2026-10-20"}),
    t({key:"D",createdDay:"2026-10-15"}),
  ];
  const k=kpis({tickets,entries:null},period,"2026-10-25");
  assert.equal(k.created.value,1);assert.equal(k.completed.value,1);
  assert.deepEqual(k.netChange,{value:0,prior:0});
  assert.equal(k.created.prior,0);
  assert.equal("open" in k,false); // no open-at-period-end figure: the snapshot has no status history
  assert.equal(kpis({tickets:[t({key:"E",createdDay:"2026-10-06"}),t({key:"F",createdDay:"2026-10-07"})],entries:null},period).netChange.value,2);
});

test("a completed ticket with no completion day is reported, not counted",()=>{
  const k=kpis({tickets:[t({key:"A",cat:"done",completedDay:null})],entries:null},period,"2026-10-25");
  assert.equal(k.completed.value,0);assert.equal(k.completed.unknownCompletion,1);
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

test("work-log hours split into confirmed in Odoo, pending sync and held under agreed hours; an unrecorded state is unknown, not zero",()=>{
  const entries=[["A","2026-10-05",0,60,0,1],["A","2026-10-06",0,30,0,0],["B","2026-10-07",1,90,0,2],["C","2026-10-08",1,120,0],["A","2026-10-12",0,600,0,1]];
  assert.deepEqual(odooSplit(entries,period),{confirmed:1,pending:0.5,held:1.5,unknown:2});
  assert.deepEqual(kpis({tickets:[],entries:[["A","2026-10-05",0,60,0]]},period).hours.odoo,{confirmed:0,pending:0,held:0,unknown:1});
  assert.equal(kpis({tickets:[],entries:null},period).hours.odoo,null);
  // The split adds up to the work-log total.
  const k=kpis({tickets:[],entries},period),o=k.hours.odoo;assert.equal(o.confirmed+o.pending+o.held+o.unknown,k.hours.value);
});

test("period boundaries are the Asia/Jerusalem days the snapshot stores: the first and last day count, the next day does not",()=>{
  const entries=[["A","2026-10-04",0,60,0,1],["A","2026-10-05",0,60,0,1],["A","2026-10-11",0,60,0,1],["A","2026-10-12",0,60,0,1]];
  assert.equal(kpis({tickets:[],entries},period).hours.value,2);
});

test("hours by person count each entry once for the person who logged it, largest first",()=>{
  const entries=[["A","2026-10-05",0,60,0,1],["A","2026-10-05",1,120,0,0],["B","2026-10-06",1,60,1,0],["A","2026-10-20",0,600,0,1],["C","2026-10-06",2,30,0]];
  assert.deepEqual(hoursByPerson(entries,["Dana","Lee"],period),[{person:"Lee",hours:3},{person:"Dana",hours:1},{person:"Unknown",hours:0.5}]);
  assert.equal(hoursByPerson(null,["Dana"],period),null);
});
