import { test } from "node:test";
import assert from "node:assert/strict";
import { createFilters } from "../../public/assets/models/filters.js";
import { serializeView, restoreView, readViews, savedViewKey, validateView } from "../../public/assets/models/saved-views.js";
const state={f:createFilters(),view:"dev",focus:"overdue",group:"status",q:"test"};
test("ticket source survives saved views while older views default to all sources",()=>{
  const f=createFilters();f.source="internal";const view=serializeView({...state,f},"Internal only");assert.equal(restoreView(view,true,{lead:{}}).f.source,"internal");
  delete view.filters.source;assert.equal(restoreView(view,true,{lead:{}}).f.source,"all");view.filters.source="invalid";assert.equal(validateView(view),false);
});
test("due-date history saved views downgrade for developers and remain intact for managers",()=>{
  const view=serializeView({...state,focus:"duechg",view:"history"},"Date changes");
  const user=restoreView(view,false,{lead:{}});
  assert.equal(user.focus,"open");assert.equal(user.view,"list");
  const admin=restoreView(view,true,{lead:{}});
  assert.equal(admin.focus,"duechg");assert.equal(admin.view,"history");
});
test("no-developer saved views remain available only to managers",()=>{
  const f=createFilters();f.dev.add("__none");f.dev.add("builder");
  const view=serializeView({...state,f,focus:"nodev"},"Unassigned work");
  const user=restoreView(view,false,{lead:{}});
  assert.equal(user.focus,"open");assert.deepEqual([...user.f.dev],[]);
  const admin=restoreView(view,true,{lead:{}});
  assert.equal(admin.focus,"nodev");assert.deepEqual([...admin.f.dev],["__none","builder"]);
});
test("saved views reconstruct Sets and preserve user defaults without elevating board mode",()=>{
  const v=serializeView(state,"Work");const restored=restoreView(v,false,{lead:{}});assert.equal(restored.view,"list");assert.deepEqual([...restored.f.assignee],["lead"]);assert.equal(restored.focus,"overdue");assert.equal(restored.q,"test");assert.ok(restored.f.dev instanceof Set);
});
test("corrupted and oversized definitions cannot crash or become views",()=>{
  assert.deepEqual(readViews({getItem:()=>"{broken"},"test@example.invalid"),[]);assert.deepEqual(readViews({getItem:()=>"{}"},"test@example.invalid"),[]);
  const v=serializeView(state,"Work");v.filters.dev=new Array(101).fill("builder");assert.equal(validateView(v),false);assert.equal(restoreView(v,true,{}),null);
});
test("view definitions are scoped by identity and contain no issue or credential payloads",()=>{
  const view=serializeView({...state,issues:[{key:"SECRET"}],token:"private"},"Work");assert.equal("issues" in view,false);assert.equal("token" in view,false);assert.notEqual(savedViewKey("one@example.invalid"),savedViewKey("two@example.invalid"));assert.equal(savedViewKey("ONE@example.invalid"),savedViewKey("one@example.invalid"));
});
