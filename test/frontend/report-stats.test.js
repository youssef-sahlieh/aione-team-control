import {test} from "node:test";
import assert from "node:assert/strict";
import {agreementState,usageBand,agreementSummary,agreementGroups,GROUP_SORTS,paretoOverruns,knownSum,estimateAccuracy,applySelection,jerusalemDay,hoursOf} from "../../public/assets/models/report-stats.js";

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

test("a timestamp near midnight is dated in Asia/Jerusalem, not UTC",()=>{
  // 2026-10-31T22:30Z is 00:30 on 1 November in Jerusalem (UTC+2 after the October change).
  assert.equal(jerusalemDay("2026-10-31T22:30:00Z"),"2026-11-01");
  assert.equal(jerusalemDay("not a date"),null);
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

test("applySelection narrows one dataset by client and ticket",()=>{
  const snap="2026-11-01";
  const rows=[
    ticket({key:"A",clientId:"c1",created:at("2026-10-31"),employees:[{name:"Dana",hours:3}]}),
    ticket({key:"B",clientId:"c2",created:at("2026-09-01"),employees:[{name:"Dana",hours:0}]}),
    ticket({key:"C",clientId:"c1",created:at("2026-09-01"),closed:true,employees:[{name:"Ron",hours:2}]})
  ];
  const keys=sel=>applySelection(rows,{...{client:null,project:null,ticket:null},...sel},snap).map(t=>t.key);
  assert.deepEqual(keys({client:"c1"}),["A","C"]);
  assert.deepEqual(keys({ticket:"C"}),["C"]);
});

