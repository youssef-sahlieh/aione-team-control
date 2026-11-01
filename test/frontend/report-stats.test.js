import {test} from "node:test";
import assert from "node:assert/strict";
import {agreementState,usageBand,agreementSummary,agreementGroups,GROUP_SORTS,paretoOverruns,agingBucket,aging,knownSum,overdueOpen,completedInPeriod,employeeClientMatrix,estimateAccuracy,workloadByStatus,weeklyFlow,weeklyEffort,applySelection,jerusalemDay,hoursOf} from "../../public/assets/models/report-stats.js";

// Synthetic tickets only. Dates are noon UTC, so their Asia/Jerusalem calendar day is the same date.
const at=day=>`${day}T12:00:00Z`;
const ticket=(over={})=>({key:"AION-1",title:"Synthetic",status:"Open",closed:false,created:at("2026-10-20"),completedAt:null,due:null,clientId:"c1",clientName:"Acme",subClientId:null,subClientName:null,agreedHours:null,loggedHours:0,estimatedHours:null,employees:[],devs:[],...over});

test("missing hours stay unknown while an explicitly recorded zero stays zero",()=>{
  assert.equal(hoursOf(null),null);assert.equal(hoursOf(undefined),null);assert.equal(hoursOf(NaN),null);assert.equal(hoursOf(-1),null);
  assert.equal(hoursOf(0),0);
  const rows=[ticket({key:"A",agreedHours:10,loggedHours:0}),ticket({key:"B",agreedHours:10,loggedHours:null}),ticket({key:"C",agreedHours:null,loggedHours:5})];
  const known=knownSum(rows,"loggedHours");
  assert.deepEqual(known,{sum:5,known:2,total:3});
  assert.equal(agreementState(rows[0]),"matched");
  assert.equal(agreementState(rows[1]),"logged-unknown");
  assert.equal(agreementState(rows[2]),"no-agreement");
});

test("matched-cohort ratio is total logged over total agreed, not an average of ticket percentages",()=>{
  const rows=[ticket({key:"A",agreedHours:10,loggedHours:20}),ticket({key:"B",agreedHours:100,loggedHours:50}),ticket({key:"C",agreedHours:10,loggedHours:null})];
  const s=agreementSummary(rows);
  assert.equal(s.matched,2);assert.equal(s.loggedUnknown,1);assert.equal(s.noAgreement,0);
  assert.equal(s.agreedHours,110);assert.equal(s.loggedHours,70);
  assert.ok(Math.abs(s.ratio-70/110)<1e-12);
  // The average of the ticket ratios (200% and 50%) would be 125%, which is not the cohort ratio.
  assert.notEqual(Math.round(s.ratio*100),125);
});

test("no matched tickets gives a null ratio, not a division by zero",()=>{
  const s=agreementSummary([ticket({agreedHours:null,loggedHours:3}),ticket({key:"B",agreedHours:5,loggedHours:null})]);
  assert.equal(s.matched,0);assert.equal(s.ratio,null);assert.equal(s.excessHours,0);
});

test("excess hours count only overruns while net variance nets underruns against them",()=>{
  const rows=[ticket({key:"A",agreedHours:10,loggedHours:15}),ticket({key:"B",agreedHours:10,loggedHours:4})];
  const s=agreementSummary(rows);
  assert.equal(s.excessHours,5);assert.equal(s.netVariance,-1);
});

test("usage bands separate over, approaching (80–100%) and within agreement",()=>{
  assert.equal(usageBand(ticket({agreedHours:10,loggedHours:10.5})),"over");
  assert.equal(usageBand(ticket({agreedHours:10,loggedHours:10})),"approaching");
  assert.equal(usageBand(ticket({agreedHours:10,loggedHours:8})),"approaching");
  assert.equal(usageBand(ticket({agreedHours:10,loggedHours:7.99})),"within");
  assert.equal(usageBand(ticket({agreedHours:10,loggedHours:null})),null);
});

test("client and project groups keep their own matched cohort and excluded counts",()=>{
  const rows=[ticket({key:"A",agreedHours:10,loggedHours:12}),ticket({key:"B",clientId:null,clientName:null,agreedHours:4,loggedHours:1}),ticket({key:"C",agreedHours:null,loggedHours:3})];
  const groups=agreementGroups(rows,t=>({key:t.clientId||"__none",label:t.clientName||"Client not set"})).sort(GROUP_SORTS.excess);
  assert.equal(groups[0].label,"Acme");assert.equal(groups[0].matched,1);assert.equal(groups[0].noAgreement,1);assert.equal(groups[0].excessHours,2);
  assert.equal(groups[1].label,"Client not set");assert.equal(groups[1].matched,1);
});

test("Pareto orders by excess, closes at 100% with Other, and uses the full total for shares",()=>{
  const rows=[5,3,2,1].map((excess,i)=>ticket({key:"T"+i,agreedHours:10,loggedHours:10+excess}));
  rows.push(ticket({key:"U",agreedHours:10,loggedHours:9}));// under agreement, not in the Pareto
  rows.push(ticket({key:"V",agreedHours:null,loggedHours:99}));// no agreement
  const p=paretoOverruns(rows,2);
  assert.equal(p.total,11);assert.equal(p.count,4);
  assert.deepEqual(p.bars.map(b=>b.key),["T0","T1"]);
  assert.ok(Math.abs(p.bars[0].cumulativeShare-5/11)<1e-12);
  assert.ok(Math.abs(p.bars[1].cumulativeShare-8/11)<1e-12);
  assert.equal(p.other.count,2);assert.equal(p.other.excess,3);assert.equal(p.other.cumulativeShare,1);
});

test("Pareto without overruns is empty and has no Other group",()=>{
  const p=paretoOverruns([ticket({agreedHours:10,loggedHours:4})]);
  assert.equal(p.total,0);assert.equal(p.bars.length,0);assert.equal(p.other,null);
});

test("aging buckets change at 7/8, 14/15, 30/31 and 60/61 calendar days",()=>{
  const snap="2026-11-01";
  const label=n=>agingBucket(ticket({created:at(dayBefore(snap,n))}),snap);
  assert.equal(label(0),"0–7 days");assert.equal(label(7),"0–7 days");
  assert.equal(label(8),"8–14 days");assert.equal(label(14),"8–14 days");
  assert.equal(label(15),"15–30 days");assert.equal(label(30),"15–30 days");
  assert.equal(label(31),"31–60 days");assert.equal(label(60),"31–60 days");
  assert.equal(label(61),"61+ days");
});

test("aging keeps unknown and future-created tickets out of the buckets and counts only open tickets",()=>{
  const snap="2026-11-01";
  const rows=[ticket({key:"A",created:at("2026-10-31")}),ticket({key:"B",created:null}),ticket({key:"C",created:"not a date"}),ticket({key:"D",created:at("2026-11-05")}),ticket({key:"E",closed:true,created:at("2026-01-01")})];
  const a=aging(rows,snap);
  assert.equal(a.open,4);
  assert.deepEqual(a.buckets[0],{label:"0–7 days",count:1,keys:["A"]});
  assert.equal(a.unknown.count,2);assert.equal(a.invalid.count,1);
});

test("creation near midnight is dated in Asia/Jerusalem, not UTC",()=>{
  // 2026-10-31T22:30Z is 00:30 on 1 November in Jerusalem (UTC+2 after the October change).
  assert.equal(jerusalemDay("2026-10-31T22:30:00Z"),"2026-11-01");
  assert.equal(agingBucket(ticket({created:"2026-10-31T22:30:00Z"}),"2026-11-01"),"0–7 days");
  assert.equal(jerusalemDay("not a date"),null);
});

test("overdue is open, dated and before the snapshot day only",()=>{
  const rows=[ticket({key:"A",due:"2026-10-31"}),ticket({key:"B",due:"2026-11-01"}),ticket({key:"C",due:"2026-10-01",closed:true}),ticket({key:"D",due:null})];
  assert.deepEqual(overdueOpen(rows,"2026-11-01").map(t=>t.key),["A"]);
});

test("completions in the period use the completion date and ignore open tickets",()=>{
  const rows=[ticket({key:"A",closed:true,completedAt:at("2026-10-29")}),ticket({key:"B",closed:true,completedAt:at("2026-11-02")}),ticket({key:"C",closed:false,completedAt:null})];
  assert.deepEqual(completedInPeriod(rows,"2026-10-25","2026-11-01").map(t=>t.key),["A"]);
});

test("the employee × client matrix attributes each person's own hours and never copies ticket totals",()=>{
  const rows=[
    ticket({key:"A",clientId:"c1",clientName:"Acme",loggedHours:10,employees:[{name:"Dana",hours:6},{name:"Ron",hours:4}]}),
    ticket({key:"B",clientId:"c1",clientName:"Acme",loggedHours:9,employees:[{name:"Dana",hours:9}]}),
    ticket({key:"C",clientId:null,clientName:null,loggedHours:2,employees:[{name:"Ron",hours:2}]}),
    ticket({key:"D",clientId:"c2",clientName:"Bluefin",loggedHours:0,employees:[]})
  ];
  const m=employeeClientMatrix(rows);
  const cell=(e,c)=>m.cells.find(x=>x.employee===e&&x.client===c);
  assert.equal(cell("Dana","c1").hours,15);assert.deepEqual(cell("Dana","c1").keys,["A","B"]);
  assert.equal(cell("Ron","c1").hours,4);assert.equal(cell("Ron","__none").hours,2);
  assert.equal(cell("Dana","__none"),undefined);
  // Ticket A's 10 h are split 6 + 4, not 10 + 10.
  assert.equal(m.employees.find(p=>p.name==="Ron").hours,6);
  assert.equal(m.employees.find(p=>p.name==="Ron").tickets,2);
  assert.equal(m.clients.find(c=>c.key==="c1").tickets,2);
  assert.equal(m.max,15);
});

test("the matrix skips people with unknown hours and tickets with unknown people",()=>{
  const m=employeeClientMatrix([ticket({employees:null}),ticket({key:"B",employees:[{name:"Dana",hours:null},{name:"Ron",hours:0}]})]);
  assert.equal(m.cells.length,0);assert.equal(m.employees.length,0);
});

test("estimate accuracy uses completed tickets with positive estimates and known hours, and counts exclusions",()=>{
  const rows=[
    ticket({key:"A",closed:true,estimatedHours:10,loggedHours:12}),
    ticket({key:"B",closed:true,estimatedHours:null,loggedHours:3}),
    ticket({key:"C",closed:true,estimatedHours:0,loggedHours:3}),
    ticket({key:"D",closed:false,estimatedHours:5,loggedHours:5})
  ];
  const e=estimateAccuracy(rows);
  assert.equal(e.completed,3);assert.equal(e.sample,1);
  assert.deepEqual(e.excluded,{noEstimate:2,loggedUnknown:0});
  assert.equal(e.points[0].variance,2);assert.equal(e.points[0].variancePct,20);
});

test("workload counts shared tickets once per developer and once in the team total",()=>{
  const rows=[
    ticket({key:"A",status:"In Progress",devs:["dana","ron"]}),
    ticket({key:"B",status:"Open",devs:["dana"]}),
    ticket({key:"C",status:"Open",devs:[]}),
    ticket({key:"D",status:"Done",closed:true,devs:["ron"]})
  ];
  const w=workloadByStatus(rows);
  assert.equal(w.team.tickets,3);assert.equal(w.team.shared,1);assert.equal(w.team.unassigned,1);
  assert.deepEqual(w.team.statuses.sort((a,b)=>a.status.localeCompare(b.status)),[{status:"In Progress",count:1},{status:"Open",count:2}]);
  const dana=w.rows.find(r=>r.name==="dana");assert.equal(dana.tickets,2);assert.equal(dana.shared,1);
  assert.equal(w.rows.at(-1).name,"__none");
});

test("weeks run Sunday to Saturday in Jerusalem and include zero-count weeks",()=>{
  // 2026-11-01 is a Sunday. 2026-11-07 (Saturday) is in the same week as 2026-11-01; 2026-11-08 starts the next week.
  const rows=[
    ticket({key:"A",created:at("2026-11-07")}),
    ticket({key:"B",created:at("2026-11-08"),closed:true,completedAt:at("2026-11-08")}),
    ticket({key:"C",created:at("2026-11-22"),closed:true,completedAt:at("2026-11-22")})
  ];
  const f=weeklyFlow(rows,"2026-11-01","2026-11-24");
  assert.deepEqual(f.weeks.map(w=>w.start),["2026-11-01","2026-11-08","2026-11-15","2026-11-22"]);
  assert.deepEqual(f.weeks.map(w=>w.created),[1,1,0,1]);
  assert.deepEqual(f.weeks.map(w=>w.completed),[0,1,0,1]);
  assert.equal(f.totals.created,3);assert.equal(f.totals.completed,2);
  assert.equal(f.weeks[3].partial,true);
});

test("weekly flow discloses closed tickets without a completion date and never uses updated time",()=>{
  const rows=[ticket({key:"A",closed:true,completedAt:null,created:at("2026-11-02")})];
  const f=weeklyFlow(rows,"2026-11-01","2026-11-07");
  assert.equal(f.unknownCompletion,1);assert.equal(f.totals.completed,0);
});

test("weekly effort uses only dated entries on the selected tickets and ignores agreed billing lines",()=>{
  const tickets=[ticket({key:"A",clientName:"Acme"}),ticket({key:"B",clientName:"Bluefin"})];
  const entries=[
    {id:"e1",ticket:"A",date:"2026-11-02",minutes:90,user:"Dana"},
    {id:"e2",ticket:"A",date:"2026-11-09",minutes:60,user:"Ron"},
    {id:"agreed:A",ticket:"A",date:"2026-11-02",minutes:600,user:"Odoo"},
    {id:"e3",ticket:"Z",date:"2026-11-02",minutes:60,user:"Dana"},
    {id:"e4",ticket:"B",date:"2026-12-02",minutes:60,user:"Dana"},
    {id:"e5",ticket:"B",date:"2026-11-03",minutes:null,user:"Dana"}
  ];
  const e=weeklyEffort(entries,tickets,"2026-11-01","2026-11-30","employee");
  assert.equal(e.counted,2);assert.equal(e.unattributed,2);
  assert.deepEqual(e.weeks.map(w=>[w.start,w.total]),[["2026-11-01",1.5],["2026-11-08",1]]);
  const byClient=weeklyEffort(entries,tickets,"2026-11-01","2026-11-30","client");
  assert.deepEqual(byClient.groups,[{label:"Acme",hours:2.5}]);
});

test("applySelection narrows one dataset by client, aging bucket, person-client cell and ticket",()=>{
  const snap="2026-11-01";
  const rows=[
    ticket({key:"A",clientId:"c1",created:at("2026-10-31"),employees:[{name:"Dana",hours:3}]}),
    ticket({key:"B",clientId:"c2",created:at("2026-09-01"),employees:[{name:"Dana",hours:0}]}),
    ticket({key:"C",clientId:"c1",created:at("2026-09-01"),closed:true,employees:[{name:"Ron",hours:2}]})
  ];
  const keys=sel=>applySelection(rows,{...{client:null,project:null,aging:null,cell:null,ticket:null},...sel},snap).map(t=>t.key);
  assert.deepEqual(keys({client:"c1"}),["A","C"]);
  assert.deepEqual(keys({aging:"0–7 days"}),["A"]);
  assert.deepEqual(keys({aging:"61+ days"}),["B"]);// B is open and 61 days old; closed C is never aged
  assert.deepEqual(keys({cell:{employee:"Dana",client:"c1"}}),["A"]);
  assert.deepEqual(keys({ticket:"C"}),["C"]);
});

function dayBefore(day,n){const [y,m,d]=day.split("-").map(Number);return new Date(Date.UTC(y,m-1,d-n)).toISOString().slice(0,10);}
