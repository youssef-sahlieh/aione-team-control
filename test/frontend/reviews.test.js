import {test} from "node:test";
import assert from "node:assert/strict";
import {STATUS_LABEL, reviewLabel, sortQueue, githubNote, ticketKeysOf, activeReviewerIds, assignedLine, queueStateLabel, queueReasonText, waitingFor, longestWaitFirst, filterQueue, queueCounts, queueOptions, NO_REVIEWER} from "../../public/assets/models/reviews.js";

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

const pr = (over) => ({ id: "acme/web#1", repo: "acme/web", number: 1, title: "Fix totals", url: "https://github.test/1", author: "ellen", state: "awaiting", reason: "", since: "2026-11-01T10:00:00Z", reviewers: [], ...over });
const ticket = (over) => ({ key: "AION-1", title: "Forecourt cash", status: "In Review", assignee: "Ellen", client: "Acme", subClient: "Till", since: "2026-11-01T10:00:00Z", prs: [pr({})], ...over });

test("the queue states read in plain words, with the reason only where the state doesn't say why",()=>{
  assert.equal(queueStateLabel({state:"awaiting"}),"Awaiting review");
  assert.equal(queueStateLabel({state:"changes_requested"}),"Changes requested");
  assert.equal(queueStateLabel({state:"approved"}),"Approved");
  assert.equal(queueStateLabel({state:"nope"}),"Unknown");
  assert.equal(queueReasonText({state:"awaiting",reason:"new_commits"}),"New commits since changes were requested");
  assert.equal(queueReasonText({state:"awaiting",reason:"more_approvals"}),"More approvals needed");
  assert.equal(queueReasonText({state:"approved",reason:"stale"}),"Approved, but new commits since");
  assert.equal(queueReasonText({state:"awaiting",reason:""}),"");
});

test("waiting time is counted in minutes, hours and days from the wait's start",()=>{
  const now = Date.parse("2026-11-08T12:00:00Z");
  assert.equal(waitingFor("2026-11-08T11:59:30Z", now), "under a minute");
  assert.equal(waitingFor("2026-11-08T11:55:00Z", now), "5 minutes");
  assert.equal(waitingFor("2026-11-08T11:00:00Z", now), "1 hour");
  assert.equal(waitingFor("2026-11-08T07:00:00Z", now), "5 hours");
  assert.equal(waitingFor("2026-11-07T12:00:00Z", now), "1 day");
  assert.equal(waitingFor("2026-11-01T12:00:00Z", now), "7 days");
  assert.equal(waitingFor(null, now), "");
});

test("the longest wait comes first, and an unknown wait goes last",()=>{
  const sorted = ["2026-11-05T00:00:00Z", null, "2026-11-01T00:00:00Z"].sort(longestWaitFirst);
  assert.deepEqual(sorted, ["2026-11-01T00:00:00Z", "2026-11-05T00:00:00Z", null]);
});

test("a search matches the ticket key, the ticket title or the pull request title, case-insensitively",()=>{
  const tickets = [ticket({ key: "AION-1", title: "Forecourt cash", prs: [pr({ id: "a#1", title: "Fix totals" })] }), ticket({ key: "AION-2", title: "Refund rounding", prs: [pr({ id: "b#2", title: "Round refunds" })] })];
  assert.deepEqual(filterQueue(tickets, { search: "aion-2" }).map((t) => t.key), ["AION-2"]);
  assert.deepEqual(filterQueue(tickets, { search: "forecourt" }).map((t) => t.key), ["AION-1"]);
  assert.deepEqual(filterQueue(tickets, { search: "ROUND REFUNDS" }).map((t) => t.key), ["AION-2"]);
  assert.deepEqual(filterQueue(tickets, { search: "nothing like this" }), []);
});

test("a ticket that matches keeps all its pull requests, but a PR-title match keeps only that pull request",()=>{
  const tickets = [ticket({ key: "AION-1", title: "Forecourt cash", prs: [pr({ id: "a#1", title: "Fix totals" }), pr({ id: "a#2", title: "Cash drawer" })] })];
  assert.equal(filterQueue(tickets, { search: "forecourt" })[0].prs.length, 2);
  const byPr = filterQueue(tickets, { search: "drawer" });
  assert.deepEqual(byPr[0].prs.map((p) => p.id), ["a#2"]);
});

test("the project, repository, state and reviewer filters combine, and 'No reviewer assigned' finds the unreviewed",()=>{
  const lee = { name: "Lee", login: "lee" };
  const tickets = [
    ticket({ key: "AION-1", client: "Acme", prs: [pr({ id: "web#1", repo: "acme/web", state: "awaiting", reviewers: [lee] })] }),
    ticket({ key: "AION-2", client: "Beta", prs: [pr({ id: "api#2", repo: "acme/api", state: "changes_requested", reviewers: [] })] })
  ];
  assert.deepEqual(filterQueue(tickets, { client: "Beta" }).map((t) => t.key), ["AION-2"]);
  assert.deepEqual(filterQueue(tickets, { repo: "acme/web" }).map((t) => t.key), ["AION-1"]);
  assert.deepEqual(filterQueue(tickets, { state: "changes_requested" }).map((t) => t.key), ["AION-2"]);
  assert.deepEqual(filterQueue(tickets, { reviewer: "Lee" }).map((t) => t.key), ["AION-1"]);
  assert.deepEqual(filterQueue(tickets, { reviewer: NO_REVIEWER }).map((t) => t.key), ["AION-2"]);
  assert.deepEqual(filterQueue(tickets, { client: "Acme", state: "changes_requested" }), []);
});

test("counts give tickets and distinct pull requests, so a pull request on two tickets counts once",()=>{
  const shared = pr({ id: "web#9" });
  const tickets = [ticket({ key: "AION-1", prs: [shared] }), ticket({ key: "AION-2", prs: [shared, pr({ id: "web#10" })] })];
  assert.deepEqual(queueCounts(tickets), { tickets: 2, prs: 2 });
  assert.deepEqual(queueCounts([]), { tickets: 0, prs: 0 });
});

test("the filter menus list each client, repository and reviewer once, in order",()=>{
  const tickets = [ticket({ client: "Beta", prs: [pr({ repo: "acme/web", reviewers: [{ name: "Sam" }] })] }), ticket({ key: "AION-2", client: "Acme", prs: [pr({ id: "x#3", repo: "acme/api", reviewers: [{ name: "Lee" }, { name: "Sam" }] })] })];
  assert.deepEqual(queueOptions(tickets), { clients: ["Acme", "Beta"], repos: ["acme/api", "acme/web"], reviewers: ["Lee", "Sam"] });
});
