import {test} from "node:test";
import assert from "node:assert/strict";
import {STATUS_LABEL, reviewLabel, sortQueue, githubNote, ticketKeysOf, activeReviewerIds, assignedLine} from "../../public/assets/models/reviews.js";

test("the queue puts what needs the reviewer first and finished work last, newest first within a status",()=>{
  const queue=sortQueue([
    {id:"a",status:"approved",assignedAt:"2026-11-01T10:00:00Z"},
    {id:"b",status:"needs_review",assignedAt:"2026-11-01T10:00:00Z"},
    {id:"c",status:"needs_review",assignedAt:"2026-11-03T10:00:00Z"},
    {id:"d",status:"unlinked",assignedAt:"2026-11-04T10:00:00Z"},
    {id:"e",status:"changes_requested",assignedAt:"2026-11-02T10:00:00Z"}
  ]);
  assert.deepEqual(queue.map((x)=>x.id),["c","b","e","a","d"]);
});

test("every status has a readable label, and an unknown one is not shown raw",()=>{
  assert.equal(reviewLabel("needs_review"),STATUS_LABEL.needs_review);
  assert.equal(reviewLabel("approved"),"Approved on GitHub");
  assert.equal(reviewLabel("something_new"),"Unknown");
});

test("a reviewer without a GitHub username is told the administrator adds it, and only administrators can retry a refusal",()=>{
  assert.deepEqual(githubNote({state:"no_login"}),{tone:"wait",text:"No GitHub username set yet. An administrator adds it on the Users page, and GitHub is asked then.",action:""});
  assert.equal(githubNote({state:"failed",error:"Not Found"},{admin:true}).action,"retry");
  assert.equal(githubNote({state:"failed",error:"Not Found"},{admin:false}).action,"");
  assert.equal(githubNote({state:"failed"}).text,"GitHub didn't accept the request.");
  assert.equal(githubNote({state:"requested"}).tone,"ok");
  assert.equal(githubNote({}).text,"");
});

test("only Jira and internal keys are offered as read-only tickets",()=>{
  assert.deepEqual(ticketKeysOf({keys:["AION-12","INT-3","random","aion-4","OPS_X-9"]}),["AION-12","INT-3","OPS_X-9"]);
  assert.deepEqual(ticketKeysOf({}),[]);
  assert.deepEqual(ticketKeysOf(null),[]);
});

test("the picker starts from the people already asked",()=>{
  assert.deepEqual(activeReviewerIds([
    {reviewer:{accountId:"u1"}},
    {reviewer:{accountId:"u3"}}
  ]),["u1","u3"]);
  assert.deepEqual(activeReviewerIds(),[]);
});

test("the assignment line names who asked and when",()=>{
  assert.equal(assignedLine({assignedBy:"Ellen",assignedAt:"2026-11-04T09:00:00Z"}).startsWith("Asked by Ellen · "),true);
  assert.equal(assignedLine({}),"Asked");
});
