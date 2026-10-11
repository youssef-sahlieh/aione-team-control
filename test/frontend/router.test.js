import {test} from "node:test";
import assert from "node:assert/strict";
import {readRoute,routeUrl} from "../../public/assets/app/router.js";
test("unknown pages and disallowed developer boards fall back safely",()=>{
  assert.deepEqual(readRoute(new URL("http://localhost/dashboard.html?page=unknown&mode=dev"),false),{page:"tickets",mode:"status"});
  assert.deepEqual(readRoute(new URL("http://localhost/dashboard.html?page=boards&mode=dev"),false),{page:"boards",mode:"status"});
});
test("page navigation preserves issue hashes and removes irrelevant board modes",()=>{
  const url=routeUrl("overview",null,"http://localhost/dashboard.html?mode=dev#INT-9");assert.equal(url.hash,"#INT-9");assert.equal(url.searchParams.get("page"),"overview");assert.equal(url.searchParams.has("mode"),false);
});
