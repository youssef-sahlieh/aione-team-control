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
