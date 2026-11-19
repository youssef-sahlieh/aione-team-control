import {test} from "node:test";
import assert from "node:assert/strict";
import {STATUS_LABEL, reviewLabel, sortQueue, filterPersonalQueue, personalSummary, githubNote, ticketKeysOf, activeReviewerIds, assignedLine, queueStateLabel, queueReasonText, waitingFor, longestWaitFirst, filterQueue, queueOptions, NO_REVIEWER, waitLine, safePrUrl, reviewerText, noReviewerText, sortPrs, groupByTicket, QUICK_FILTERS, VIEWS, queueSummary, activeFilters, exactTime, attentionReasons, menuFilterCount, CHECKS_LABEL, DEFAULT_SORT, SORTS} from "../../public/assets/models/reviews.js";

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

test("personal review filters separate actionable assignments, drafts, author changes and completed history",()=>{
  const item=(id,status,state="open")=>({id,prId:"acme/web#"+id,status,assignedAt:"2026-11-01",assignedBy:"Manager",pr:{title:"Fix totals",repo:"acme/web",state,keys:["AION-1"]}});
  const items=[item("1","needs_review"),item("2","in_review"),item("3","needs_review","draft"),item("4","approved"),item("5","closed","merged"),item("6","changes_requested"),{...item("7","unlinked"),pr:null}];
  assert.deepEqual(filterPersonalQueue(items).map(i=>i.id),["1","2"]);
  assert.deepEqual(filterPersonalQueue(items,{status:"drafts"}).map(i=>i.id),["3"]);
  assert.deepEqual(filterPersonalQueue(items,{status:"completed"}).map(i=>i.id),["4","5"]);
  assert.deepEqual(filterPersonalQueue(items,{status:"changes_requested"}).map(i=>i.id),["6"]);
  assert.equal(filterPersonalQueue(items,{search:"AION-1",repo:"acme/web"}).length,2);
  assert.equal(filterPersonalQueue(items,{repo:"acme/other"}).length,0);
  assert.deepEqual(personalSummary(items),{to_review:2,in_review:1,changes_requested:1,drafts:1,completed:2,all:7});
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

const pr = (over) => ({ id: "acme/web#1", repo: "acme/web", number: 1, title: "Fix totals", url: "https://github.test/1", author: "ellen", state: "awaiting", reason: "", since: "2026-11-01T10:00:00Z", reviewers: [], tickets: [], rami: false, draft: false, ...over });
const tk = (over) => ({ key: "AION-1", title: "Forecourt cash", status: "In Review", done: false, assignee: "Ellen", client: "Acme", subClient: "Till", ...over });

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

test("a search matches the pull request title, repository and number, author, and a linked ticket's key or title",()=>{
  const prs = [pr({ id: "acme/web#1", title: "Fix totals", tickets: [tk({ key: "AION-1", title: "Forecourt cash" })] }), pr({ id: "acme/api#2", repo: "acme/api", number: 2, title: "Round refunds", author: "lee", tickets: [] })];
  const ids = (f) => filterQueue(prs, f).map((p) => p.id);
  assert.deepEqual(ids({ search: "aion-1" }), ["acme/web#1"]);
  assert.deepEqual(ids({ search: "FORECOURT" }), ["acme/web#1"]);
  assert.deepEqual(ids({ search: "round refunds" }), ["acme/api#2"]);
  assert.deepEqual(ids({ search: "acme/api#2" }), ["acme/api#2"]);
  assert.deepEqual(ids({ search: "LEE" }), ["acme/api#2"]);
  assert.deepEqual(ids({ search: "nothing like this" }), []);
});

test("the project, repository, state, reviewer and quick filters all combine; an unlinked pull request has no project",()=>{
  const lee = { name: "Lee", login: "lee" };
  const prs = [
    pr({ id: "web#1", repo: "acme/web", state: "awaiting", reviewers: [lee], reviewerState: "pending", tickets: [tk({ client: "Acme" })], rami: true }),
    pr({ id: "api#2", repo: "acme/api", state: "changes_requested", reviewerState: "given", reviewers: [{ name: "Sam" }], tickets: [tk({ key: "AION-2", client: "Beta" })] }),
    pr({ id: "api#3", repo: "acme/api", state: "awaiting", reviewerState: "none", tickets: [] }),
    pr({ id: "web#4", repo: "acme/web", state: "draft", draft: true, reviewerState: "none", tickets: [], rami: true }),
    pr({ id: "web#5", repo: "acme/web", state: "unknown", reviewerState: "unavailable", tickets: [] })
  ];
  const ids = (f) => filterQueue(prs, f).map((p) => p.id);
  assert.deepEqual(ids({ client: "Beta" }), ["api#2"]);
  assert.deepEqual(ids({ repo: "acme/web" }), ["web#1", "web#4", "web#5"]);
  assert.deepEqual(ids({ state: "draft" }), ["web#4"]);
  assert.deepEqual(ids({ reviewer: "Lee" }), ["web#1"]);
  // Unknown reviewer data is not "no reviewer".
  assert.deepEqual(ids({ reviewer: NO_REVIEWER }), ["api#3", "web#4"]);
  assert.deepEqual(ids({ quick: "linked" }), ["web#1", "api#2"]);
  assert.deepEqual(ids({ quick: "unlinked" }), ["api#3", "web#4", "web#5"]);
  assert.deepEqual(ids({ quick: "rami" }), ["web#1", "web#4"]);
  assert.deepEqual(ids({ quick: "no_reviewer" }), ["api#3", "web#4"]);
  assert.deepEqual(ids({ quick: "changes" }), ["api#2"]);
  assert.deepEqual(ids({ quick: "rami", repo: "acme/web", state: "draft" }), ["web#4"]);
  assert.deepEqual(ids({ quick: "unlinked", client: "Acme" }), []);
  assert.equal(ids({ quick: "nonsense" }).length, 5, "an unknown quick filter keeps everything");
});

test("the primary tabs separate review states, and the list is the default view",()=>{
  assert.deepEqual(QUICK_FILTERS.map(([, label]) => label), ["Awaiting review", "Changes requested", "Approved", "Drafts", "All PRs", "Needs attention", "Unlinked", "For Rami"]);
  assert.deepEqual(VIEWS.map(([v]) => v), ["prs", "tickets"]);
});

test("review-state tabs keep approved pull requests and all drafts out of awaiting review",()=>{
  const prs = [pr({ id: "waiting" }), pr({ id: "approved", state: "approved" }),
    pr({ id: "draft", draft: true, state: "draft" }), pr({ id: "draft-approved", draft: true, state: "approved" }),
    pr({ id: "draft-waiting", draft: true }), pr({ id: "changes", state: "changes_requested" }),
    pr({ id: "unknown", state: "unknown" })];
  const ids = quick => filterQueue(prs, { quick }).map(p=>p.id);
  assert.deepEqual(ids("awaiting"), ["waiting"]);
  assert.deepEqual(ids("approved"), ["approved"]);
  assert.deepEqual(ids("drafts"), ["draft", "draft-approved", "draft-waiting"]);
  assert.deepEqual(ids("changes"), ["changes"]);
  assert.equal(ids("").length,7);
  assert.deepEqual(filterQueue(prs,{state:"awaiting"}).map(p=>p.id),["waiting"]);
  const summary=queueSummary(prs);
  assert.equal(summary.awaiting,1); assert.equal(summary.approved,1); assert.equal(summary.drafts,3); assert.equal(summary.changes,1);
});

test("attention reasons are only verified conditions, each said in words, and a unknown check state is never a failure",()=>{
  const now = Date.parse("2026-11-08T12:00:00Z");
  const base = { state: "awaiting", reviewers: [{ name: "Lee" }], reviewerState: "given", draft: false, since: "2026-11-07T12:00:00Z", sinceKind: "requested" };
  assert.deepEqual(attentionReasons(base, now), [], "a recent request with a reviewer needs nothing");
  assert.deepEqual(attentionReasons({ ...base, reviewers: [], reviewerState: "none" }, now).map((r) => r.key), ["no_reviewer"]);
  assert.deepEqual(attentionReasons({ ...base, reviewers: [], reviewerState: "none", draft: true }, now), [], "drafts don't need a reviewer yet");
  assert.deepEqual(attentionReasons({ ...base, reviewers: [], reviewerState: "unavailable" }, now), [], "missing reviewer data is not a verified gap");
  assert.deepEqual(attentionReasons({ ...base, since: "2026-11-04T12:00:00Z" }, now).map((r) => r.text), ["No review for 4 days"]);
  assert.deepEqual(attentionReasons({ ...base, since: "2026-11-07T12:00:00Z", sinceKind: "opened" }, now), [], "a pull request's age is not a review wait");
  assert.deepEqual(attentionReasons({ ...base, state: "changes_requested" }, now).map((r) => r.key), ["changes"]);
  assert.deepEqual(attentionReasons({ ...base, checks: { state: "failure", failed: ["lint", "unit", "e2e"] } }, now).map((r) => r.text), ["Checks failing: lint, unit"]);
  assert.deepEqual(attentionReasons({ ...base, checks: { state: "unavailable", failed: [] } }, now), [], "checks GitHub couldn't report are not failures");
  assert.equal(CHECKS_LABEL.unavailable, "Checks not available");
});

test("the Filters button counts only the four menus that are set",()=>{
  assert.equal(menuFilterCount({ client: "", repo: "", reviewer: "", state: "" }), 0);
  assert.equal(menuFilterCount({ client: "Acme", repo: "acme/web", reviewer: NO_REVIEWER, state: "", quick: "rami", search: "x" }), 3, "tabs and search are not menus");
});

test("the filter menus list each project, repository and reviewer once, in order",()=>{
  const prs = [pr({ repo: "acme/web", reviewers: [{ name: "Sam" }], tickets: [tk({ client: "Beta" })] }), pr({ id: "x#3", repo: "acme/api", reviewers: [{ name: "Lee" }, { name: "Sam" }], tickets: [tk({ key: "AION-2", client: "Acme" }), tk({ key: "AION-3", client: "" })] }), pr({ id: "y#4", repo: "acme/api", tickets: [] })];
  assert.deepEqual(queueOptions(prs), { clients: ["Acme", "Beta"], repos: ["acme/api", "acme/web"], reviewers: ["Lee", "Sam"], authors: ["ellen"] });
});

test("the default sort puts the longest real review wait first, then other times, then unknown ones",()=>{
  const prs = [
    pr({ id: "a#1", repo: "a", number: 1, since: "2026-10-01T00:00:00Z", sinceKind: "opened", tickets: [tk({ key: "AION-10" })] }),
    pr({ id: "b#2", repo: "b", number: 2, since: "", sinceKind: "", tickets: [] }),
    pr({ id: "c#3", repo: "c", number: 3, since: "2026-11-05T00:00:00Z", sinceKind: "requested", tickets: [tk({ key: "AION-3" })] }),
    pr({ id: "c#4", repo: "c", number: 4, since: "2026-11-02T00:00:00Z", sinceKind: "requested", tickets: [tk({ key: "AION-2" })] })
  ];
  const ids = (sort) => sortPrs(prs, sort).map((p) => p.id);
  assert.deepEqual(ids("wait"), ["c#4", "c#3", "a#1", "b#2"]);
  assert.deepEqual(ids("recent"), ["c#3", "c#4", "a#1", "b#2"]);
  assert.deepEqual(ids("key"), ["c#4", "c#3", "a#1", "b#2"], "ticket keys in number order, unlinked last");
  assert.deepEqual(ids("repo"), ["a#1", "b#2", "c#3", "c#4"]);
  assert.deepEqual(prs.map((p) => p.id), ["a#1", "b#2", "c#3", "c#4"], "the input is not reordered");
});

test("the default order is the newest pull request first by GitHub's created time, unknown times last, and the other orders stay",()=>{
  const prs = [
    pr({ id: "a#1", repo: "a", number: 1, created: "2026-10-01T00:00:00Z" }),
    pr({ id: "b#2", repo: "b", number: 2, created: "" }),
    pr({ id: "c#3", repo: "c", number: 3, created: "2026-11-05T00:00:00Z" }),
    pr({ id: "c#4", repo: "c", number: 4, created: "2026-11-02T00:00:00Z" })
  ];
  assert.equal(DEFAULT_SORT, "created");
  assert.deepEqual(sortPrs(prs).map((p) => p.id), ["c#3", "c#4", "a#1", "b#2"]);
  assert.deepEqual(sortPrs(prs, "created").map((p) => p.id), ["c#3", "c#4", "a#1", "b#2"]);
  assert.ok(SORTS.some(([k]) => k === "wait") && SORTS.some(([k]) => k === "recent"), "the other sorts are still offered");
});

test("the Opened by filter keeps the author's pull requests, and the reviewer relationship narrows the chosen reviewer only",()=>{
  const prs = [
    pr({ id: "a#1", author: "ellen", reviewers: [{ name: "Lee", pending: true, review: "" }] }),
    pr({ id: "b#2", author: "sam", reviewers: [{ name: "Lee", pending: false, review: "APPROVED" }] }),
    pr({ id: "c#3", author: "ellen", reviewers: [{ name: "Sam", pending: false, review: "CHANGES_REQUESTED" }] }),
    pr({ id: "d#4", author: "ellen", reviewers: [] })
  ];
  const ids = (f) => filterQueue(prs, f).map((p) => p.id);
  assert.deepEqual(ids({ author: "ellen" }), ["a#1", "c#3", "d#4"]);
  assert.deepEqual(ids({ reviewer: "Lee" }), ["a#1", "b#2"], "any relationship is the default");
  assert.deepEqual(ids({ reviewer: "Lee", relation: "requested" }), ["a#1"]);
  assert.deepEqual(ids({ reviewer: "Lee", relation: "reviewed" }), ["b#2"]);
  assert.deepEqual(ids({ reviewer: "Lee", relation: "approved" }), ["b#2"]);
  assert.deepEqual(ids({ reviewer: "Sam", relation: "changes" }), ["c#3"]);
  assert.deepEqual(ids({ reviewer: "Sam", relation: "approved" }), [], "a reviewer who never approved isn't matched");
  assert.deepEqual(ids({ reviewer: NO_REVIEWER, relation: "requested" }), ["d#4"], "the relationship doesn't apply to none requested");
  assert.equal(menuFilterCount({ author: "ellen", reviewer: "Lee", relation: "requested" }), 2);
});

test("the active filter chips name the author and the reviewer's part, and the menus count both",()=>{
  const chips = activeFilters({ author: "ellen", reviewer: "Lee", relation: "changes" });
  assert.deepEqual(chips.map((c) => [c.name, c.text]), [["author", "Opened by: ellen"], ["reviewer", "Reviewer: Lee (Changes requested)"]]);
  assert.deepEqual(activeFilters({ reviewer: "Lee", relation: "any" }).map((c) => c.text), ["Reviewer: Lee"]);
  assert.deepEqual(activeFilters({ reviewer: NO_REVIEWER, relation: "requested" }).map((c) => c.text), ["Reviewer: none requested"]);
});

test("the By ticket view lists each ticket with its pull requests, a shared pull request under both, and the unlinked last",()=>{
  const shared = pr({ id: "web#9", tickets: [tk({ key: "AION-1" }), tk({ key: "AION-2", title: "Till float" })] });
  const groups = groupByTicket([pr({ id: "web#8", tickets: [] }), shared, pr({ id: "web#10", tickets: [tk({ key: "AION-2", title: "Till float" })] })]);
  assert.deepEqual(groups.map((g) => [g.key, g.prs.map((p) => p.id)]), [["AION-1", ["web#9"]], ["AION-2", ["web#9", "web#10"]], ["", ["web#8"]]]);
  assert.equal(groups[1].title, "Till float");
  assert.deepEqual(groupByTicket([pr({ tickets: [tk({})] })]).map((g) => g.key), ["AION-1"], "no unlinked group when there are none");
  assert.deepEqual(groupByTicket([]), []);
});

test("the summary cards count pull requests, distinct linked tickets, unlinked, no reviewer, Rami and awaiting",()=>{
  const prs = [
    pr({ id: "web#9", reviewerState: "none", tickets: [tk({ key: "AION-1" }), tk({ key: "AION-2" })], rami: true }),
    pr({ id: "web#10", state: "changes_requested", reviewerState: "given", reviewers: [{ name: "Lee" }], tickets: [tk({ key: "AION-2" })] }),
    pr({ id: "web#11", state: "unknown", reviewerState: "unavailable", tickets: [] }),
    pr({ id: "web#12", state: "draft", draft: true, reviewerState: "none", tickets: [], rami: true })
  ];
  assert.deepEqual(queueSummary(prs), { prs: 4, tickets: 2, unlinked: 2, noReviewer: 2, rami: 2, attention: 2, awaiting: 1, approved: 0, drafts: 1, changes: 1 }, "attention: web#9 (no reviewer) and web#10 (changes requested)");
  assert.deepEqual(queueSummary([]), { prs: 0, tickets: 0, unlinked: 0, noReviewer: 0, rami: 0, attention: 0, awaiting: 0, approved: 0, drafts: 0, changes: 0 });
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

test("the active filters read as chips; the sort and empty values are not filters",()=>{
  assert.deepEqual(activeFilters({ search: "  cash ", quick: "changes", client: "Acme", repo: "", reviewer: NO_REVIEWER, state: "unknown", sort: "key" }), [
    { name: "search", text: "Search: cash" }, { name: "quick", text: "Changes requested" }, { name: "client", text: "Project: Acme" },
    { name: "reviewer", text: "Reviewer: none requested" }, { name: "state", text: "State: Review information unavailable" }
  ]);
  assert.deepEqual(activeFilters({ search: " ", sort: "recent" }), []);
});
