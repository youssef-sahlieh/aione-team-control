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

export const PERSONAL_FILTERS = [["to_review", "To review"], ["in_review", "In progress"], ["changes_requested", "Waiting for author"], ["drafts", "Drafts"], ["completed", "Completed"], ["all", "All assignments"]];
const personalDraft = item => item.pr?.state === "draft" && !["closed", "unlinked"].includes(item.status);
export function filterPersonalQueue(items, { status = "to_review", search = "", repo = "" } = {}) {
  const query = search.trim().toLowerCase();
  return sortQueue(items).filter(item => {
    const draft = personalDraft(item);
    const matches = status === "all" || (status === "drafts" ? draft
      : status === "completed" ? !draft && ["approved", "closed"].includes(item.status)
      : status === "to_review" ? !draft && ["needs_review", "in_review"].includes(item.status)
      : !draft && item.status === status);
    return matches && (!repo || item.pr?.repo === repo) && (!query ||
      [item.pr?.title, item.prId, item.pr?.author, item.assignedBy, ...(item.pr?.keys || [])].join(" ").toLowerCase().includes(query));
  });
}
export const personalSummary = items => Object.fromEntries(PERSONAL_FILTERS.map(([status]) => [status, filterPersonalQueue(items, { status }).length]));

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
// "unknown": GitHub's review data couldn't be read, so the pull request is listed but never called awaiting. "draft":
// a draft pull request nobody has reviewed yet (it is not waiting for a review).
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

// The queue is one row per open pull request (GET /reviews/queue: prs). pr.tickets lists the tickets it names; none
// means it is unlinked. pr.rami is the Rami reference flag. pr.draft says it is a draft.
const linked = (pr) => (pr.tickets || []).length > 0;

// Checks: what GitHub's check results say (pr.checks, from the proxy). "unavailable" is never shown as a failure.
export const CHECKS_LABEL = { success: "Checks passed", failure: "Checks failing", pending: "Checks running", none: "No checks", unavailable: "Checks not available" };

// Why a pull request needs attention. Only verified conditions count, and each one is said in words:
//   changes requested; no reviewer asked (not for drafts, and not when GitHub's reviewer data is missing); no review for
//   ATTENTION_WAIT_DAYS or more (a real review request or new-commit time); failing checks (not unavailable ones).
// A pull request can have several reasons. now is passed in for tests.
export const ATTENTION_WAIT_DAYS = 3;
export function attentionReasons(pr, now = Date.now()) {
  const out = [];
  if (pr.state === "changes_requested") out.push({ key: "changes", text: "Changes requested" });
  if (!pr.draft && noReviewer(pr) && pr.reviewerState !== "unavailable") out.push({ key: "no_reviewer", text: "No reviewer requested" });
  const t = Date.parse(pr.since || "");
  if (pr.state === "awaiting" && (pr.sinceKind === "requested" || pr.sinceKind === "commit") && !Number.isNaN(t) && now - t >= ATTENTION_WAIT_DAYS * 86400000) {
    out.push({ key: "wait", text: "No review for " + waitingFor(pr.since, now) });
  }
  if (pr.checks && pr.checks.state === "failure") out.push({ key: "checks", text: "Checks failing" + (pr.checks.failed && pr.checks.failed.length ? ": " + pr.checks.failed.slice(0, 2).join(", ") : "") });
  return out;
}

// The quick filters: the primary tabs above the list. "" is all of them. They combine with the search and the menus.
export const DEFAULT_QUICK = "awaiting";
export const QUICK_FILTERS = [["awaiting", "Awaiting review"], ["changes", "Changes requested"], ["approved", "Approved"], ["drafts", "Drafts"], ["", "All PRs"], ["attention", "Needs attention"], ["unlinked", "Unlinked"], ["rami", "For Rami"]];
// The names of every quick filter, for the chips (the cards can set the ones that aren't tabs, such as no reviewer).
const QUICK_LABEL = { awaiting: "Awaiting review", approved: "Approved", drafts: "Drafts", attention: "Needs attention", linked: "Linked to ticket", unlinked: "Unlinked PRs", rami: "For Rami", no_reviewer: "No reviewer requested", changes: "Changes requested" };
const isDraft = pr => pr.draft || pr.state === "draft";
const QUICK = { awaiting: pr => !isDraft(pr) && pr.state === "awaiting", approved: pr => !isDraft(pr) && pr.state === "approved", drafts: isDraft, attention: (pr) => attentionReasons(pr).length > 0, linked, unlinked: (pr) => !linked(pr), rami: (pr) => !!pr.rami, no_reviewer: noReviewer, changes: (pr) => !isDraft(pr) && pr.state === "changes_requested" };

// The default is the newest pull request first, by when GitHub created it. The other orders stay available.
export const SORTS = [["created", "Newest PR first"], ["wait", "Longest wait first"], ["recent", "Most recent first"], ["key", "Ticket key"], ["repo", "Repository"]];
export const DEFAULT_SORT = "created";

// What the Reviewer filter asks about the chosen reviewer: any of them, or one part of their review.
export const REVIEWER_RELATIONS = [["any", "Any relationship"], ["requested", "Review requested"], ["reviewed", "Has reviewed"], ["approved", "Approved"], ["changes", "Changes requested"]];
const RELATION_LABEL = Object.fromEntries(REVIEWER_RELATIONS.filter(([k]) => k !== "any").map(([k, label]) => [k, label]));
const relationMatches = (r, relation) => {
  if (!relation || relation === "any") return true;
  if (relation === "requested") return !!r.pending;
  if (relation === "reviewed") return !!r.review && !r.pending;
  if (relation === "approved") return r.review === "APPROVED";
  if (relation === "changes") return r.review === "CHANGES_REQUESTED";
  return true;
};

// The views: one row per pull request (the default), or the pull requests under each ticket they name.
export const VIEWS = [["prs", "List"], ["tickets", "By ticket"]];

// The choices for the queue's filters, taken from the pull requests that are there now.
export function queueOptions(prs) {
  const sorted = (set) => [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
  return {
    clients: sorted(new Set(prs.flatMap((pr) => (pr.tickets || []).map((t) => t.client)))),
    repos: sorted(new Set(prs.map((pr) => pr.repo))),
    reviewers: sorted(new Set(prs.flatMap((pr) => pr.reviewers.map((r) => r.name)))),
    authors: sorted(new Set(prs.map((pr) => pr.author)))
  };
}

// Narrows the pull requests. Every filter must match. The search looks at the title, "repo#number", the author and
// each linked ticket's key and title, case-insensitively. A project matches through a linked ticket, so an unlinked
// pull request has no project. Order is kept.
export function filterQueue(prs, f = {}) {
  const q = (f.search || "").trim().toLowerCase();
  const has = (text) => (text || "").toLowerCase().includes(q);
  const quick = QUICK[f.quick];
  return prs.filter((pr) => (!q || has(pr.title) || has(pr.repo + "#" + pr.number) || has(pr.author) || (pr.tickets || []).some((t) => has(t.key) || has(t.title)))
    && (!f.client || (pr.tickets || []).some((t) => t.client === f.client))
    && (!f.repo || pr.repo === f.repo)
    && (!f.state || (f.state === "draft" ? isDraft(pr) : !isDraft(pr) && pr.state === f.state))
    && (!quick || quick(pr))
    && (!f.author || pr.author === f.author)
    && (!f.reviewer || (f.reviewer === NO_REVIEWER ? noReviewer(pr) : pr.reviewers.some((r) => r.name === f.reviewer && relationMatches(r, f.relation)))));
}

// Orders the pull requests.
//   wait (default): the longest real wait first, as the proxy does: a review request or new-commit time comes before a
//   time that isn't a review wait (changes requested, approval, PR age), and a pull request with no time goes last.
//   recent: the newest of those times first. key: by first linked ticket key (numbers in order), unlinked last.
//   repo: by repository, then number.
const WAIT_RANK = { requested: 0, commit: 0 };
const time = (x) => { const t = Date.parse(x.since || ""); return Number.isNaN(t) ? null : t; };
const byWait = (a, b) => {
  const ta = time(a), tb = time(b);
  const ra = ta == null ? 2 : WAIT_RANK[a.sinceKind] ?? 1, rb = tb == null ? 2 : WAIT_RANK[b.sinceKind] ?? 1;
  return ra - rb || (ta ?? 0) - (tb ?? 0);
};
const byRecent = (a, b) => (time(b) ?? -Infinity) - (time(a) ?? -Infinity) || 0;
const firstKey = (pr) => (pr.tickets || [])[0]?.key || "";
const byKey = (a, b) => (!firstKey(a) - !firstKey(b)) || firstKey(a).localeCompare(firstKey(b), "en", { numeric: true });
const byRepo = (a, b) => a.repo.localeCompare(b.repo) || a.number - b.number;
const createdAt = (x) => { const t = Date.parse(x.created || ""); return Number.isNaN(t) ? null : t; };
const byCreated = (a, b) => (createdAt(b) ?? -Infinity) - (createdAt(a) ?? -Infinity) || b.number - a.number;
export function sortPrs(prs, sort = DEFAULT_SORT) {
  const cmp = { created: byCreated, recent: byRecent, key: byKey, repo: byRepo }[sort] || byWait;
  return [...prs].sort((a, b) => cmp(a, b) || byWait(a, b) || byRepo(a, b));
}

// The "By ticket" view: each linked ticket with its pull requests (in the order given), in first-seen order, then one
// group of the unlinked ones (key ""). A pull request naming two tickets is under both.
export function groupByTicket(prs) {
  const groups = new Map(), unlinked = [];
  for (const pr of prs) {
    if (!linked(pr)) { unlinked.push(pr); continue; }
    for (const t of pr.tickets) {
      if (!groups.has(t.key)) groups.set(t.key, { ...t, prs: [] });
      groups.get(t.key).prs.push(pr);
    }
  }
  const out = [...groups.values()];
  if (unlinked.length) out.push({ key: "", title: "", prs: unlinked });
  return out;
}

// The summary cards, from the pull requests given: open pull requests, distinct linked tickets, unlinked pull requests,
// no reviewer, flagged for Rami, and awaiting review (drafts are never awaiting).
export function queueSummary(prs) {
  return {
    prs: prs.length,
    tickets: new Set(prs.flatMap((pr) => (pr.tickets || []).map((t) => t.key))).size,
    unlinked: prs.filter(QUICK.unlinked).length,
    noReviewer: prs.filter(noReviewer).length,
    rami: prs.filter(QUICK.rami).length,
    attention: prs.filter(QUICK.attention).length,
    awaiting: prs.filter(QUICK.awaiting).length,
    approved: prs.filter(QUICK.approved).length,
    drafts: prs.filter(QUICK.drafts).length,
    changes: prs.filter(QUICK.changes).length
  };
}

// The menus that narrow the list (not the search, the quick filter, the sort or the view): how many are in use.
export const menuFilterCount = (f = {}) => ["client", "repo", "author", "reviewer", "state"].filter((k) => f[k]).length;

// The filters in use, as removable chips: [{ name, text }]. The sort and the view aren't filters.
export function activeFilters(f = {}) {
  const out = [];
  if ((f.search || "").trim()) out.push({ name: "search", text: "Search: " + f.search.trim() });
  if (f.quick && QUICK_LABEL[f.quick]) out.push({ name: "quick", text: QUICK_LABEL[f.quick] });
  if (f.client) out.push({ name: "client", text: "Project: " + f.client });
  if (f.repo) out.push({ name: "repo", text: "Repository: " + f.repo });
  if (f.author) out.push({ name: "author", text: "Opened by: " + f.author });
  if (f.reviewer) {
    const rel = f.reviewer !== NO_REVIEWER && f.relation && f.relation !== "any" ? " (" + RELATION_LABEL[f.relation] + ")" : "";
    out.push({ name: "reviewer", text: "Reviewer: " + (f.reviewer === NO_REVIEWER ? "none requested" : f.reviewer + rel) });
  }
  if (f.state) out.push({ name: "state", text: "State: " + (QUEUE_STATE_LABEL[f.state] || f.state) });
  return out;
}
