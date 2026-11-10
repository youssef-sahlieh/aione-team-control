import {test} from "node:test";
import assert from "node:assert/strict";
import {readFilters,writeFilters,withoutFilters,rangeEndingAt,MAX_DAYS} from "../../public/assets/models/analytics-url.js";
import {readRoute,routeUrl} from "../../public/assets/app/router.js";

const today="2026-10-25";

test("no filters in the address gives the last 30 days, everyone, all sources",()=>{
  assert.deepEqual(readFilters("",today),{from:"2026-09-26",to:"2026-10-25",client:"",dev:"",source:"all"});
});

test("invalid dates, reversed ranges and unknown sources fall back instead of throwing",()=>{
  assert.equal(readFilters("?from=nope&to=2026-10-01",today).to,today);
  assert.equal(readFilters("?from=2026-02-30&to=2026-03-01",today).to,today);
  assert.equal(readFilters("?from=2026-10-20&to=2026-10-01",today).from,"2026-09-26");
  assert.equal(readFilters("?source=drop",today).source,"all");
});

test("a range is clamped to a year and never extends into the future",()=>{
  const f=readFilters("?from=2020-01-01&to=2026-10-01",today);
  assert.equal(f.to,"2026-10-01");assert.equal(f.from,rangeEndingAt("2026-10-01",MAX_DAYS).from);
  const future=readFilters("?from=2026-10-20&to=2027-01-01",today);
  assert.equal(future.to,today);assert.equal(future.from,"2026-10-20");
});

test("filters round-trip through the address and are removed when leaving the page",()=>{
  const filters={from:"2026-10-01",to:"2026-10-10",client:"c1",dev:"dana",source:"jira"};
  const url=writeFilters("https://app.test/dashboard.html?page=analytics",filters);
  assert.deepEqual(readFilters(url.search,today),filters);
  assert.equal(url.searchParams.get("page"),"analytics");
  assert.equal(withoutFilters(url).search,"?page=analytics");
  assert.equal(writeFilters(url,{...filters,source:"all",client:""}).searchParams.has("source"),false);
  assert.equal(routeUrl("tickets",null,url).search,"?page=tickets");
  assert.equal(routeUrl("analytics",null,url).searchParams.get("from"),"2026-10-01");
});

test("the paused analytics page: its address opens Clients for administrators and All tickets for others",()=>{
  const url=new URL("https://app.test/dashboard.html?page=analytics");
  assert.equal(readRoute(url,true).page,"clients");
  assert.equal(readRoute(url,false).page,"tickets");
});
