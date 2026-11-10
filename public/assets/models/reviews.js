// Pull request review assignments as the dashboard shows them (the proxy works out each status, see proxy/src/reviews.js).
// Pure functions only, so the wording and the order are tested without a browser.

export const STATUS_LABEL = {
  needs_review: "Needs review",
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved on GitHub",
  closed: "Pull request closed",
  unlinked: "Pull request not found"
};

// The order of the queue: what needs the person first, finished work last.
const RANK = { needs_review: 0, in_review: 1, changes_requested: 2, approved: 3, closed: 4, unlinked: 5 };

export const reviewLabel = (status) => STATUS_LABEL[status] || "Unknown";

export function sortQueue(items) {
  return [...items].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || (a.assignedAt < b.assignedAt ? 1 : a.assignedAt > b.assignedAt ? -1 : 0));
}

// What to say about the GitHub side of one assignment: text, a tone for its colour, and the one action it offers.
// admin: administrators can retry a refused request.
export function githubNote(github = {}, { admin = false } = {}) {
  const state = github.state || "none";
  if (state === "requested") return { tone: "ok", text: "Review requested on GitHub.", action: "" };
  if (state === "pending") return { tone: "wait", text: "Sending the request to GitHub…", action: "" };
  if (state === "no_login") return { tone: "wait", text: "No GitHub username set yet. An administrator adds it on the Users page, and GitHub is asked then.", action: "" };
  if (state === "failed") return { tone: "bad", text: github.error || "GitHub didn't accept the request.", action: admin ? "retry" : "" };
  return { tone: "", text: "", action: "" };
}

// The keys a reviewer can read read-only (Jira and internal tickets the pull request mentions).
export const ticketKeysOf = (pr) => (pr && Array.isArray(pr.keys) ? pr.keys.filter((k) => /^(?:INT|[A-Z][A-Z0-9_]*)-\d+$/.test(k)) : []);

// Who is already asked to review a pull request, for the administrator's picker. Reviewers are never removed.
export const activeReviewerIds = (assignments = []) => assignments.map((a) => a.reviewer.accountId);

// "Review requested by Ellen on 4 Nov" style line for an assignment.
export function assignedLine(item) {
  const by = item.assignedBy ? "Asked by " + item.assignedBy : "Asked";
  return by + (item.assignedAt ? " · " + new Date(item.assignedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
}

// The administrators' queue (GET /reviews/queue): one state per pull request, as the proxy works it out from GitHub.
// "unknown": GitHub's review data couldn't be read, so the pull request is listed but never called awaiting. The proxy
// leaves drafts out of the queue; their label is here so one is never shown raw.
export const QUEUE_STATE_LABEL = { awaiting: "Awaiting review", changes_requested: "Changes requested", approved: "Approved", draft: "Draft", unknown: "Review information unavailable" };
export const queueStateLabel = (pr) => QUEUE_STATE_LABEL[pr.state] || QUEUE_STATE_LABEL.unknown;
export const NO_REVIEWER = "__none";

// The reason under a state, when the state alone doesn't say why the pull request is listed.
export function queueReasonText(pr) {
  if (pr.state === "awaiting" && pr.reason === "new_commits") return "New commits since changes were requested";
  if (pr.state === "awaiting" && pr.reason === "more_approvals") return "More approvals needed";
  if (pr.state === "approved" && pr.reason === "stale") return "Approved, but new commits since";
  return "";
}

// How long something has waited since its ISO time: "under a minute", "5 hours", "3 days". now is passed in for tests.
export function waitingFor(since, now = Date.now()) {
  const t = Date.parse(since || "");
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((now - t) / 60000);
  if (mins < 1) return "under a minute";
  if (mins < 60) return mins + (mins === 1 ? " minute" : " minutes");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour" : " hours");
  const days = Math.floor(hours / 24);
  return days + (days === 1 ? " day" : " days");
}

// Longest wait first: the earliest ISO time comes first, and an unknown one goes last.
export const longestWaitFirst = (a, b) => (a || "￿") < (b || "￿") ? -1 : (a || "￿") > (b || "￿") ? 1 : 0;

// What the time on a pull request means (sinceKind, from the proxy):
//   requested: a review was asked for then (GitHub's request event or a dashboard assignment), the only real "waiting
//   for review"; commit: new commits after changes were requested or after an approval; changes / approved: when that
//   review was given; opened: no request time is known, so it is only the pull request's age.
const WAIT_LABEL = { requested: "Waiting for review", commit: "Waiting since new commits", changes: "Changes requested", approved: "Approved", opened: "PR age" };
// A real wait this long is shown a little stronger. It is a nudge, not a deadline.
export const LONG_WAIT_DAYS = 3;
export function waitLine(pr, now = Date.now()) {
  const t = Date.parse(pr.since || "");
  if (Number.isNaN(t)) return { label: "Waiting time unknown", text: "", at: "", long: false };
  const real = pr.sinceKind === "requested" || pr.sinceKind === "commit";
  return { label: WAIT_LABEL[pr.sinceKind] || "Since", text: waitingFor(pr.since, now), at: pr.since, long: real && now - t >= LONG_WAIT_DAYS * 86400000 };
}

// The exact time, for the tooltip and the diagnostics: "8 Nov 2026, 11:00" in the viewer's time zone.
export const exactTime = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isNaN(t) ? "" : new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

// Only a GitHub-style pull request address is linked; anything else is shown without a link.
export const safePrUrl = (url) => (/^https:\/\/[^/\s?#]+\/[^/\s?#]+\/[^/\s?#]+\/pull\/\d+$/.test(url || "") ? url : "");

// A reviewer as the queue lists them: a team says so, and their part in the review is said in words.
const REVIEW_WORD = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", COMMENTED: "commented", DISMISSED: "dismissed" };
export function reviewerText(r) {
  const who = r.kind === "team" ? r.name + " (team)" : r.name;
  const what = r.pending ? "requested" : REVIEW_WORD[r.review] || "";
  return what ? who + " · " + what : who;
}
// When a pull request lists no reviewer: say whether none was asked or GitHub's data is missing.
export const noReviewerText = (pr) => (pr.reviewerState === "unavailable" ? "Reviewer data unavailable" : "No reviewer requested");
const noReviewer = (pr) => (pr.reviewerState ? pr.reviewerState === "none" : !pr.reviewers.length);
const unavailable = (pr) => pr.state === "unknown" || pr.reviewerState === "unavailable";

// The quick filters above the list, and what each keeps.
export const QUICK_FILTERS = [["", "All"], ["no_reviewer", "No reviewer"], ["changes", "Changes requested"], ["unavailable", "Review data unavailable"]];
const QUICK = { no_reviewer: noReviewer, changes: (pr) => pr.state === "changes_requested", unavailable };

export const SORTS = [["wait", "Longest wait first"], ["recent", "Most recent first"], ["key", "Ticket key"]];

// The choices for the queue's filters, taken from the tickets that are there now.
export function queueOptions(tickets) {
  const sorted = (set) => [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
  const prs = tickets.flatMap((t) => t.prs);
  return {
    clients: sorted(new Set(tickets.map((t) => t.client))),
    repos: sorted(new Set(prs.map((pr) => pr.repo))),
    reviewers: sorted(new Set(prs.flatMap((pr) => pr.reviewers.map((r) => r.name))))
  };
}

// Narrows the queue. A ticket that matches by key or title keeps all its pull requests; otherwise only pull requests
// whose title or repository (as "repo#number") matches stay. A ticket with no pull request left is dropped. Order is kept.
export function filterQueue(tickets, f = {}) {
  const q = (f.search || "").trim().toLowerCase();
  const has = (text) => (text || "").toLowerCase().includes(q);
  const quick = QUICK[f.quick];
  return tickets
    .filter((t) => !f.client || t.client === f.client)
    .map((t) => {
      const ticketMatch = !q || has(t.key) || has(t.title);
      const prs = t.prs.filter((pr) => (ticketMatch || has(pr.title) || has(pr.repo + "#" + pr.number))
        && (!f.repo || pr.repo === f.repo)
        && (!f.state || pr.state === f.state)
        && (!quick || quick(pr))
        && (!f.reviewer || (f.reviewer === NO_REVIEWER ? noReviewer(pr) : pr.reviewers.some((r) => r.name === f.reviewer))));
      return { ...t, prs };
    })
    .filter((t) => t.prs.length);
}

// Orders the tickets and the pull requests in each one.
//   wait (default): the longest real wait first, as the proxy does: a review request or new-commit time comes before a
//   time that isn't a review wait (changes requested, approval, PR age), and a pull request with no time goes last.
//   recent: the newest of those times first. key: by ticket key, numbers in order.
// A ticket's time is its first pull request's, so after filtering it follows the pull requests still shown.
const WAIT_RANK = { requested: 0, commit: 0 };
const time = (x) => { const t = Date.parse(x.since || ""); return Number.isNaN(t) ? null : t; };
const byWait = (a, b) => {
  const ta = time(a), tb = time(b);
  const ra = ta == null ? 2 : WAIT_RANK[a.sinceKind] ?? 1, rb = tb == null ? 2 : WAIT_RANK[b.sinceKind] ?? 1;
  return ra - rb || (ta ?? 0) - (tb ?? 0);
};
const byRecent = (a, b) => (time(b) ?? -Infinity) - (time(a) ?? -Infinity) || 0;
export function sortTickets(tickets, sort = "wait") {
  const cmp = sort === "recent" ? byRecent : byWait;
  const out = tickets.map((t) => {
    const prs = [...t.prs].sort((a, b) => cmp(a, b) || a.number - b.number);
    return { ...t, prs, since: prs[0]?.since || "", sinceKind: prs[0]?.sinceKind || "" };
  });
  const byKey = (a, b) => a.key.localeCompare(b.key, "en", { numeric: true });
  return out.sort(sort === "key" ? byKey : (a, b) => cmp(a, b) || byKey(a, b));
}

// Tickets and distinct pull requests. A pull request that names two tickets counts once as a pull request.
export function queueCounts(tickets) {
  return { tickets: tickets.length, prs: new Set(tickets.flatMap((t) => t.prs.map((pr) => pr.id))).size };
}

// The summary strip: distinct open pull requests, the tickets they name, and how many have no reviewer, changes
// requested or no review data. Each pull request counts once however many tickets it names.
export function queueSummary(tickets) {
  const prs = [...new Map(tickets.flatMap((t) => t.prs.map((pr) => [pr.id, pr]))).values()];
  return {
    prs: prs.length, tickets: tickets.length,
    noReviewer: prs.filter(noReviewer).length, changes: prs.filter(QUICK.changes).length, unavailable: prs.filter(unavailable).length
  };
}

// The filters in use, as removable chips: [{ name, text }]. The sort isn't a filter.
export function activeFilters(f = {}) {
  const out = [];
  const quick = QUICK_FILTERS.find(([v]) => v && v === f.quick);
  if ((f.search || "").trim()) out.push({ name: "search", text: "Search: " + f.search.trim() });
  if (quick) out.push({ name: "quick", text: quick[1] });
  if (f.client) out.push({ name: "client", text: "Project: " + f.client });
  if (f.repo) out.push({ name: "repo", text: "Repository: " + f.repo });
  if (f.reviewer) out.push({ name: "reviewer", text: "Reviewer: " + (f.reviewer === NO_REVIEWER ? "none requested" : f.reviewer) });
  if (f.state) out.push({ name: "state", text: "State: " + (QUEUE_STATE_LABEL[f.state] || f.state) });
  return out;
}

