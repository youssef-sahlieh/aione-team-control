import { test } from "node:test";
import assert from "node:assert/strict";
import { createFilters, matchesFilters } from "../../public/assets/models/filters.js";
import { normalizeJiraIssue } from "../../public/assets/models/issue.js";
import { jiraIssue, byId } from "../fixtures/issues.js";
const issue=normalizeJiraIssue(jiraIssue,byId,x=>x);
const today="2026-10-11";
const matches=(i,f,skip,query="")=>matchesFilters(i,today,{filters:f,query,needsReply:x=>x.last&&!x.last.fromTeam,now:Date.parse(today+"T09:00:00Z")},skip);
test("filters OR selected values within a field and AND different fields",()=>{
  const f=createFilters();f.dev=new Set(["missing","builder"]);f.status.add("Pending QA");assert.equal(matches(issue,f),true);f.priority.add("Low");assert.equal(matches(issue,f),false);assert.equal(matches(issue,f,"priority"),true);assert.equal(matches(issue,f,"status"),false);
});
test("due date ranges exclude today from upcoming and include day seven",()=>{
  const f=createFilters();f.due="week";
  for(const [date,result] of [[null,false],[today,false],["2026-10-12",true],["2026-10-18",true],["2026-10-19",false]])assert.equal(matches({...issue,due:date},f),result);
  f.due="later";assert.equal(matches({...issue,due:"2026-10-19"},f),true);assert.equal(matches({...issue,due:"2026-10-18"},f),false);
  f.due="overdue";assert.equal(matches(issue,f),true);assert.equal(matches({...issue,due:today},f),false);
});
test("none developer, other assignee and absent priority preserve sentinel meanings",()=>{
  const f=createFilters();f.dev.add("__none");f.assignee.add("other");f.priority.add("None");assert.equal(matches({...issue,devs:[],assignee:null,priority:""},f),true);assert.equal(matches(issue,f),false);
});
test("search includes reporter and epic case-insensitively and epic none excludes parents",()=>{
  const f=createFilters();assert.equal(matches(issue,f,undefined,"TEST REPORTER"),true);assert.equal(matches(issue,f,undefined,"synthetic epic"),true);assert.equal(matches(issue,f,undefined,"missing"),false);f.epic="none";assert.equal(matches(issue,f),false);assert.equal(matches({...issue,parent:null},f),true);
});
test("activity filters retain rolling update windows and external reply semantics",()=>{
  const f=createFilters();f.activity="reply";assert.equal(matches(issue,f),true);assert.equal(matches({...issue,last:{fromTeam:true}},f),false);f.activity="upd1";assert.equal(matches({...issue,updated:"2026-10-10T09:00:00Z"},f),true);assert.equal(matches({...issue,updated:"2026-10-10T08:59:59Z"},f),false);f.activity="new3";assert.equal(matches({...issue,created:"2026-10-08"},f),true);assert.equal(matches({...issue,created:"2026-10-07"},f),false);
});
