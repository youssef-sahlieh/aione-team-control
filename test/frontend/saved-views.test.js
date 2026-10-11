import { test } from "node:test";
import assert from "node:assert/strict";
import { createFilters } from "../../public/assets/models/filters.js";
import { serializeView, restoreView, readViews, savedViewKey, validateView } from "../../public/assets/models/saved-views.js";
const state={f:createFilters(),view:"dev",focus:"overdue",group:"status",q:"test"};
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
