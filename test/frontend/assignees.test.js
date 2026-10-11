import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultAssigneeKeys, assigneeOptions, assigneeFilterKey } from "../../public/assets/models/assignees.js";
import { createFilters, matchesFilters } from "../../public/assets/models/filters.js";
import { restoreView, serializeView } from "../../public/assets/models/saved-views.js";
const people={karim:{name:"Karim Team"},ys:{name:"Youssef Team"},rami:{name:"Rami"},rz:{name:"Razan"},ellen:{name:"Ellen"}};
test("default assignees resolve configured keys for the four named people",()=>{
  assert.deepEqual(defaultAssigneeKeys(people),["karim","ys","rami","rz"]);
  assert.deepEqual(assigneeOptions(people).map(([key])=>key),["karim","ys","rami","rz"]);
  const {rz,...withoutRazan}=people;
  assert.equal(defaultAssigneeKeys(withoutRazan).at(-1),"razan");
  assert.equal(assigneeFilterKey({assignee:null,assigneeName:"Razan Team"},withoutRazan),"razan");
});
test("Others includes configured outsiders, unknown Jira accounts and unassigned tickets only when selected",()=>{
  const f=createFilters();f.assignee=new Set(defaultAssigneeKeys(people));
  const match=i=>matchesFilters(i,"2026-10-11",{filters:f,query:"",needsReply:()=>false,assigneeKey:i=>assigneeFilterKey(i,people)});
  for(const issue of [{assignee:"ellen"},{assignee:null,assigneeName:"Someone else"},{assignee:null,assigneeName:"Unassigned"}]){
    assert.equal(match(issue),false);f.assignee.add("other");assert.equal(match(issue),true);f.assignee.delete("other");
  }
  assert.equal(match({assignee:"rz"}),true);
});
test("saved views preserve explicitly selected Others for both roles and restore the default team for empty selections",()=>{
  const f=createFilters(),state={f,focus:"open",view:"list",group:"",q:""};
  for(const admin of [true,false]){
    assert.deepEqual([...restoreView(serializeView(state,"Default"),admin,people).f.assignee],defaultAssigneeKeys(people));
    f.assignee=new Set(["other"]);
    assert.deepEqual([...restoreView(serializeView(state,"Others"),admin,people).f.assignee],["other"]);
    f.assignee.clear();
  }
});
