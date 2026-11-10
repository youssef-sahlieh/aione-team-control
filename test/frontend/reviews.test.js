import {test} from "node:test";
import assert from "node:assert/strict";
import {STATUS_LABEL, reviewLabel, sortQueue, githubNote, ticketKeysOf, activeReviewerIds, assignedLine, queueStateLabel, queueReasonText, waitingFor, longestWaitFirst, filterQueue, queueCounts, queueOptions, NO_REVIEWER, waitLine, safePrUrl, reviewerText, noReviewerText, sortTickets, queueSummary, activeFilters, exactTime} from "../../public/assets/models/reviews.js";

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
  assert.equal(queueStateLabel({state:"unknown"}),"Review information unavailable");
  assert.equal(queueStateLabel({state:"draft"}),"Draft");
  // Anything the page doesn't know is never called awaiting.
  assert.equal(queueStateLabel({state:"nope"}),"Review information unavailable");
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
  assert.equal(waitingFor("not a date", now), "");
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

test("only a known request time is called waiting for review; otherwise the time says what it is",()=>{
  const now = Date.parse("2026-11-08T12:00:00Z");
  assert.deepEqual(waitLine({ since: "2026-11-04T12:00:00Z", sinceKind: "requested" }, now), { label: "Waiting for review", text: "4 days", at: "2026-11-04T12:00:00Z", long: true });
  assert.equal(waitLine({ since: "2026-11-07T12:00:00Z", sinceKind: "requested" }, now).long, false);
  assert.equal(waitLine({ since: "2026-11-01T12:00:00Z", sinceKind: "commit" }, now).label, "Waiting since new commits");
  // A pull request's age is never shown as a long review wait.
  assert.deepEqual(waitLine({ since: "2026-10-01T12:00:00Z", sinceKind: "opened" }, now), { label: "PR age", text: "38 days", at: "2026-10-01T12:00:00Z", long: false });
  assert.equal(waitLine({ since: "2026-10-01T12:00:00Z", sinceKind: "changes" }, now).label, "Changes requested");
  assert.equal(waitLine({ since: "2026-10-01T12:00:00Z", sinceKind: "changes" }, now).long, false);
  assert.deepEqual(waitLine({ since: "", sinceKind: "" }, now), { label: "Waiting time unknown", text: "", at: "", long: false });
  assert.equal(waitLine({ since: "garbage", sinceKind: "requested" }, now).label, "Waiting time unknown");
  assert.match(exactTime("2026-11-08T12:00:00Z"), /2026/);
  assert.equal(exactTime(null), "");
});

test("only a GitHub-style pull request address is linked",()=>{
  assert.equal(safePrUrl("https://github.com/acme/web/pull/12"), "https://github.com/acme/web/pull/12");
  assert.equal(safePrUrl("javascript:alert(1)"), "");
  assert.equal(safePrUrl("http://github.com/acme/web/pull/12"), "");
  assert.equal(safePrUrl("https://github.com/acme/web/pull/12?x=1"), "");
  assert.equal(safePrUrl(undefined), "");
});

test("reviewers say who they are, whether a team, and where their review stands",()=>{
  assert.equal(reviewerText({ name: "Lee", kind: "user", pending: true }), "Lee · requested");
  assert.equal(reviewerText({ name: "Mobile", kind: "team", pending: true }), "Mobile (team) · requested");
  assert.equal(reviewerText({ name: "Sam", kind: "user", pending: false, review: "CHANGES_REQUESTED" }), "Sam · changes requested");
  assert.equal(reviewerText({ name: "Ana" }), "Ana");
  assert.equal(noReviewerText({ reviewerState: "none" }), "No reviewer requested");
  assert.equal(noReviewerText({ reviewerState: "unavailable" }), "Reviewer data unavailable");
});

test("the quick filters find no reviewer, changes requested and missing review data; search finds a repository",()=>{
  const tickets = [
    ticket({ key: "AION-1", prs: [pr({ id: "web#1", repo: "acme/web", number: 1, reviewerState: "none" }), pr({ id: "web#2", repo: "acme/web", number: 2, state: "changes_requested", reviewerState: "given", reviewers: [{ name: "Lee" }] })] }),
    ticket({ key: "AION-2", prs: [pr({ id: "api#3", repo: "acme/api", number: 3, state: "unknown", reviewerState: "unavailable" })] })
  ];
  assert.deepEqual(filterQueue(tickets, { quick: "no_reviewer" }).flatMap((t) => t.prs.map((p) => p.id)), ["web#1"]);
  assert.deepEqual(filterQueue(tickets, { quick: "changes" }).flatMap((t) => t.prs.map((p) => p.id)), ["web#2"]);
  assert.deepEqual(filterQueue(tickets, { quick: "unavailable" }).flatMap((t) => t.prs.map((p) => p.id)), ["api#3"]);
  // Unknown reviewer data is not "no reviewer".
  assert.deepEqual(filterQueue(tickets, { reviewer: NO_REVIEWER }).flatMap((t) => t.prs.map((p) => p.id)), ["web#1"]);
  assert.deepEqual(filterQueue(tickets, { search: "acme/api" }).map((t) => t.key), ["AION-2"]);
  assert.deepEqual(filterQueue(tickets, { search: "web#2" }).flatMap((t) => t.prs.map((p) => p.id)), ["web#2"]);
});

test("the default sort puts the longest real review wait first, then other times, then unknown ones",()=>{
  const tickets = [
    ticket({ key: "AION-10", prs: [pr({ id: "a#1", since: "2026-10-01T00:00:00Z", sinceKind: "opened" })] }),
    ticket({ key: "AION-2", prs: [pr({ id: "b#2", since: "", sinceKind: "" })] }),
    ticket({ key: "AION-3", prs: [pr({ id: "c#3", number: 3, since: "2026-11-05T00:00:00Z", sinceKind: "requested" }), pr({ id: "c#4", number: 4, since: "2026-11-02T00:00:00Z", sinceKind: "requested" })] })
  ];
  const waited = sortTickets(tickets);
  assert.deepEqual(waited.map((t) => t.key), ["AION-3", "AION-10", "AION-2"]);
  assert.deepEqual(waited[0].prs.map((p) => p.id), ["c#4", "c#3"]);
  assert.equal(waited[0].since, "2026-11-02T00:00:00Z");
  assert.deepEqual(sortTickets(tickets, "recent").map((t) => t.key), ["AION-3", "AION-10", "AION-2"]);
  assert.deepEqual(sortTickets(tickets, "recent")[0].prs.map((p) => p.id), ["c#3", "c#4"]);
  assert.deepEqual(sortTickets(tickets, "key").map((t) => t.key), ["AION-2", "AION-3", "AION-10"]);
});

test("the summary counts each pull request once, even when it names two tickets",()=>{
  const shared = pr({ id: "web#9", reviewerState: "none" });
  const tickets = [
    ticket({ key: "AION-1", prs: [shared] }),
    ticket({ key: "AION-2", prs: [shared, pr({ id: "web#10", state: "changes_requested", reviewerState: "given", reviewers: [{ name: "Lee" }] }), pr({ id: "web#11", state: "unknown", reviewerState: "unavailable" })] })
  ];
  assert.deepEqual(queueSummary(tickets), { prs: 3, tickets: 2, noReviewer: 1, changes: 1, unavailable: 1 });
  assert.deepEqual(queueSummary([]), { prs: 0, tickets: 0, noReviewer: 0, changes: 0, unavailable: 0 });
});

test("the active filters read as chips; the sort and empty values are not filters",()=>{
  assert.deepEqual(activeFilters({ search: "  cash ", quick: "changes", client: "Acme", repo: "", reviewer: NO_REVIEWER, state: "unknown", sort: "key" }), [
    { name: "search", text: "Search: cash" }, { name: "quick", text: "Changes requested" }, { name: "client", text: "Project: Acme" },
    { name: "reviewer", text: "Reviewer: none requested" }, { name: "state", text: "State: Review information unavailable" }
  ]);
  assert.deepEqual(activeFilters({ search: " ", sort: "recent" }), []);
});
