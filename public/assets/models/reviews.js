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
export const QUEUE_STATE_LABEL = { awaiting: "Awaiting review", changes_requested: "Changes requested", approved: "Approved" };
export const queueStateLabel = (pr) => QUEUE_STATE_LABEL[pr.state] || "Unknown";
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
  if (!since) return "";
  const mins = Math.floor((now - Date.parse(since)) / 60000);
  if (mins < 1) return "under a minute";
  if (mins < 60) return mins + (mins === 1 ? " minute" : " minutes");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour" : " hours");
  const days = Math.floor(hours / 24);
  return days + (days === 1 ? " day" : " days");
}

// Longest wait first: the earliest ISO time comes first, and an unknown one goes last.
export const longestWaitFirst = (a, b) => (a || "￿") < (b || "￿") ? -1 : (a || "￿") > (b || "￿") ? 1 : 0;

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
// whose own title matches stay. A ticket with no pull request left is dropped. Order is kept.
export function filterQueue(tickets, f = {}) {
  const q = (f.search || "").trim().toLowerCase();
  const has = (text) => (text || "").toLowerCase().includes(q);
  return tickets
    .filter((t) => !f.client || t.client === f.client)
    .map((t) => {
      const ticketMatch = !q || has(t.key) || has(t.title);
      const prs = t.prs.filter((pr) => (ticketMatch || has(pr.title))
        && (!f.repo || pr.repo === f.repo)
        && (!f.state || pr.state === f.state)
        && (!f.reviewer || (f.reviewer === NO_REVIEWER ? !pr.reviewers.length : pr.reviewers.some((r) => r.name === f.reviewer))));
      return { ...t, prs };
    })
    .filter((t) => t.prs.length);
}

// Tickets and distinct pull requests. A pull request that names two tickets counts once as a pull request.
export function queueCounts(tickets) {
  return { tickets: tickets.length, prs: new Set(tickets.flatMap((t) => t.prs.map((pr) => pr.id))).size };
}
