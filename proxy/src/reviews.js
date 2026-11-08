// Pull request review assignments. An administrator asks dashboard people to review a pull request that is linked
// to tickets. Each reviewer gets their own assignment in their "Needs review" queue and read-only access to the
// tickets the pull request mentions. When the reviewer has a GitHub login set by an administrator (Users page), the
// review is also requested on GitHub. Approvals and requested changes happen on GitHub; the dashboard shows them from
// the synced pull request index (github.js). A review assignment never changes the Jira ticket.
//
// Store keys:
//   "review:<owner/repo#number>"  one JSON document per pull request: { prId, assignments: [...] }, changed with
//                                 compare-and-set (writeIndexed) so two administrators never overwrite each other.
//   "reviews-by:<accountId>"      set of pull request IDs the account has been assigned.
// An assignment is never removed: a reviewer stays on the pull request until it closes or merges.
// An assignment: { id, reviewerId, reviewerEmail, reviewerName, createdAt, createdBy, startedAt, seen,
//   github: { state, error, code, at } }
// github.state: "no_login" (no GitHub login set yet) | "pending" | "requested" | "failed".
// The shown status (needs_review, in_review, approved, changes_requested, closed, unlinked) is worked out from the
// assignment and the synced pull request, so it is never stored and cannot go stale.
// Administrators also get the workspace queue (GET /reviews/queue): every open pull request that names a ticket, with
// its review state from GitHub (prReviewState), grouped by ticket. Nothing is stored for it either.
import { addToInbox } from "./inbox.js";
import { ensureAccountId, getUser, listUsers } from "./users.js";
import { githubConfigured, prRecord, pullIndex, requestReviewer, requestedLogins, syncPulls } from "./github.js";
import { readFile } from "./internal.js";
import { publicMetadata, readCatalog, readMetadata } from "./ticket-metadata.js";

const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const fail = (code, error, status = 400) => json({ code, error }, status);
const MAX_REVIEWERS = 10;
const PR_ID = /^[\w.-]+\/[\w.-]+#\d{1,9}$/;
const TICKET = /^(?:INT-\d{1,7}|[A-Z][A-Z0-9_]*-\d{1,9})$/;
const ATTACHMENT = /^[\w-]{1,64}$/;
const nowIso = () => new Date().toISOString();
const lc = (s) => String(s || "").trim().toLowerCase();
const isOpen = (pr) => !!pr && (pr.state === "open" || pr.state === "draft");
const docKey = (prId) => "review:" + prId;
const setKey = (accountId) => "reviews-by:" + accountId;
const loginOf = (byId, accountId) => byId.get(accountId)?.githubLogin || "";
const failed = (code, error) => ({ state: "failed", error, code, at: nowIso() });

// The status a reviewer sees. Pure: it depends only on the assignment, the pull request and the reviewer's GitHub login.
export function reviewStatus(a, pr, login) {
  if (!pr) return "unlinked";
  if (!isOpen(pr)) return "closed";
  const latest = login ? (pr.status?.reviews || []).find((r) => lc(r.by) === lc(login)) : null;
  if (latest?.state === "APPROVED") return "approved";
  if (latest?.state === "CHANGES_REQUESTED") return "changes_requested";
  return a.startedAt ? "in_review" : "needs_review";
}

const latest = (times) => times.filter(Boolean).sort().at(-1) || "";
const earliest = (times) => times.filter(Boolean).sort()[0] || "";
// When the wait for a review started: the oldest request still open, else the assignment, else when the pull request
// became ready for review.
const waitingSince = (pr, assignments) => earliest([...(pr.status?.requests || []).map((r) => r.at), ...assignments.map((a) => a.createdAt)]) || pr.readyAt || pr.created || pr.updated || "";

// The review state of an open pull request, from GitHub's reviews (see github.js). Pure, so the rules are tested.
// state: "awaiting" (someone should review: nobody has approved yet, the author pushed after changes were requested, or
// GitHub needs more approvals), "changes_requested" (the author has to act first) or "approved".
// reason: "new_commits", "more_approvals", "stale" (every approval is older than the latest commit) or "".
// counts: whether it needs a review from someone now. since: when the wait started (ISO time), or "".
export function prReviewState(pr, assignments = []) {
  const s = pr.status || {}, head = s.lastCommitAt || "", reviews = s.reviews || [];
  const changes = reviews.filter((r) => r.state === "CHANGES_REQUESTED");
  const approvals = reviews.filter((r) => r.state === "APPROVED");
  if (changes.length) {
    const asked = latest(changes.map((r) => r.at));
    return head && head > asked
      ? { state: "awaiting", reason: "new_commits", since: head, counts: true }
      : { state: "changes_requested", reason: "", since: asked, counts: false };
  }
  if (approvals.length) {
    if (head && approvals.every((r) => r.at && r.at < head)) return { state: "approved", reason: "stale", since: head, counts: true };
    if (s.decision === "REVIEW_REQUIRED") return { state: "awaiting", reason: "more_approvals", since: waitingSince(pr, assignments), counts: true };
    return { state: "approved", reason: "", since: latest(approvals.map((r) => r.at)), counts: false };
  }
  return { state: "awaiting", reason: "", since: waitingSince(pr, assignments), counts: true };
}

async function readDoc(env, prId) {
  const raw = await env.STORE.get(docKey(prId));
  return raw ? JSON.parse(raw) : null;
}

// Changes one pull request's document only if it is still the version that was read. fn receives a fresh copy and
// returns { doc?, add?, out }: no doc means nothing to save. add lists [set, member] pairs saved in the same write.
async function mutate(env, prId, fn) {
  const key = docKey(prId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await env.STORE.get(key);
    const change = fn(raw ? JSON.parse(raw) : { prId, assignments: [] });
    if (!change.doc) return change.out;
    if (await env.STORE.writeIndexed(key, raw, JSON.stringify(change.doc), change.add || [], [])) return change.out;
  }
  throw new Error("The review changed while it was being saved. Try again.");
}

// Changes one assignment (whatever its status) and returns it, or null when it doesn't exist.
const editAssignment = (env, prId, id, edit) => mutate(env, prId, (d) => {
  const a = d.assignments.find((x) => x.id === id);
  if (!a) return { out: null };
  edit(a);
  return { doc: d, out: { ...a } };
});

async function notify(env, emails, item) {
  await addToInbox(env.STORE, [...new Set(emails.filter(Boolean))], item, "");
}

// Dashboard people whose GitHub login wrote the pull request: they hear about its reviews.
const authorEmails = (users, pr) => users.filter((u) => u.githubLogin && lc(u.githubLogin) === lc(pr.author)).map((u) => u.email);

// Asks GitHub for the review. Returns the GitHub state to save. Never throws: a failure is a state people can act on.
export async function requestOnGitHub(env, prId, pr, login) {
  const at = nowIso();
  if (!login) return { state: "no_login", error: "", code: "no_login", at };
  if (!githubConfigured(env)) return failed("github", "GitHub isn't set up for this dashboard.");
  if (lc(login) === lc(pr.author)) return failed("author", "This person wrote the pull request, so GitHub can't ask them to review it.");
  const repo = prId.split("#")[0];
  let r;
  try {
    r = await requestReviewer(env, repo, pr.number, login);
  } catch {
    // No answer: GitHub may have accepted the request anyway, so ask it before reporting a failure.
    try {
      if ((await requestedLogins(env, repo, pr.number)).includes(lc(login))) return { state: "requested", error: "", code: "", at };
    } catch { /* still unknown below */ }
    return failed("unknown", "GitHub didn't confirm the request. Retry to send it again.");
  }
  if (r.ok) return { state: "requested", error: "", code: "", at };
  if (r.status === 422) return failed("not_eligible", r.data?.message || "GitHub won't let this account review this pull request.");
  if (r.rateLimited) return failed("rate_limit", "GitHub's rate limit is reached. Retry later.");
  if (r.status === 403) return failed("github_access", "The GitHub token can't request reviews on this repository.");
  if (r.status === 404) return failed("missing", "GitHub can't find this pull request.");
  return failed("github", "GitHub answered " + r.status + ". Retry later.");
}

// Notices reviews that changed on GitHub (approved, changes requested, pull request closed). Each change is announced
// once: the assignment remembers the last status, and the change is saved only if it is still new.
async function settle(env, prId, pr, users) {
  const doc = await readDoc(env, prId);
  if (!doc) return;
  const byEmail = new Map(users.map((u) => [u.id, u]));
  for (const a of doc.assignments) {
    const status = reviewStatus(a, pr, byEmail.get(a.reviewerId)?.githubLogin);
    if (status === a.seen) continue;
    const changed = await mutate(env, prId, (d) => {
      const x = d.assignments.find((y) => y.id === a.id);
      if (!x || x.seen === status) return { out: false };
      x.seen = status;
      return { doc: d, out: true };
    });
    if (!changed) continue;
    const title = pr.repo + " #" + pr.number + ": " + pr.title, key = pr.keys?.[0] || "";
    if (status === "approved" || status === "changes_requested") {
      const by = a.reviewerName, text = status === "approved" ? "Approved on GitHub." : "Requested changes on GitHub.";
      await notify(env, [a.createdBy?.email, ...authorEmails(users, pr)], { type: "review_update", key, title, by, text });
    } else if (status === "closed") {
      await notify(env, [a.reviewerEmail, a.createdBy?.email], { type: "review_closed", key, title, by: "GitHub", text: "This review has ended." });
    }
  }
}

// Asks GitHub for the review of every assignment of one account that was waiting for a GitHub login (after an
// administrator sets it on the Users page).
export async function requestWaitingReviews(env, accountId, login) {
  for (const prId of await env.STORE.smembers(setKey(accountId))) {
    const pr = await prRecord(env, prId);
    if (!isOpen(pr)) continue;
    const doc = await readDoc(env, prId);
    for (const a of doc?.assignments || []) {
      if (a.reviewerId !== accountId || a.github?.state !== "no_login") continue;
      await editAssignment(env, prId, a.id, (x) => { x.github = { state: "pending", error: "", code: "", at: nowIso() }; });
      const github = await requestOnGitHub(env, prId, pr, login);
      await editAssignment(env, prId, a.id, (x) => { x.github = github; });
    }
  }
}

// What a reviewer or administrator sees about one assignment.
function assignmentRow(a, pr, login) {
  return {
    id: a.id,
    status: reviewStatus(a, pr, login),
    reviewer: { accountId: a.reviewerId, name: a.reviewerName },
    assignedAt: a.createdAt,
    assignedBy: a.createdBy?.name || "",
    startedAt: a.startedAt || null,
    github: { state: a.github?.state || "none", error: a.github?.error || "", code: a.github?.code || "" }
  };
}

const prSummary = (pr, prId) => pr && { id: prId, repo: prId.split("#")[0], number: pr.number, title: pr.title, url: pr.url, author: pr.author, state: pr.state, keys: pr.keys, updated: pr.updated };

// GET /reviews/me: the signed-in person's assignments, with the GitHub link state.
async function myQueue(env, user) {
  let prError = "";
  if (githubConfigured(env)) {
    try { await syncPulls(env); } catch (e) { prError = e.message || "Couldn't read pull requests."; }
  }
  const users = await listUsers(env.STORE), byId = new Map(users.map((u) => [u.id, u]));
  const items = [];
  for (const prId of await env.STORE.smembers(setKey(user.id))) {
    const pr = await prRecord(env, prId);
    if (pr) await settle(env, prId, pr, users);
    const doc = await readDoc(env, prId);
    for (const a of doc?.assignments || []) {
      if (a.reviewerId !== user.id) continue;
      items.push({ prId, pr: prSummary(pr, prId), ...assignmentRow(a, pr, user.githubLogin) });
    }
  }
  items.sort((x, y) => (x.assignedAt < y.assignedAt ? 1 : -1));
  return json({ items, prError });
}

// What the administrator (all reviewers) or a reviewer (their own assignment only) sees for one pull request.
async function prView(env, prId, pr, viewer, users) {
  const doc = (await readDoc(env, prId)) || { assignments: [] };
  const byId = new Map(users.map((u) => [u.id, u]));
  await settle(env, prId, pr, users);
  const rows = doc.assignments.filter((a) => viewer.isAdmin || a.reviewerId === viewer.id).map((a) => assignmentRow(a, pr, loginOf(byId, a.reviewerId)));
  return json({ pr: prSummary(pr, prId), assignments: rows, canManage: viewer.isAdmin });
}

// Every dashboard account, each with an account ID (see users.js).
async function accountsWithIds(store) {
  const users = await listUsers(store);
  const ready = await Promise.all(users.map((u) => ensureAccountId(store, u)));
  return ready.filter(Boolean);
}

// Adds the chosen reviewers to one pull request. Nobody is ever removed: a reviewer already on the pull request stays,
// whether or not they are in the list. Each new reviewer gets one assignment; a repeated request finds the assignment
// already there and adds nothing.
async function addReviewers(env, me, prId, pr, wanted, byId) {
  const at = nowIso(), actor = { email: me.email, name: me.name || me.email };
  // byId holds the full account records (GitHub login included), so the actions below need no second read.
  const adds = await mutate(env, prId, (d) => {
    const created = [], add = [];
    const already = new Set(d.assignments.map((a) => a.reviewerId));
    for (const id of wanted) {
      if (already.has(id)) continue;
      const u = byId.get(id);
      const a = {
        id: crypto.randomUUID(), reviewerId: id, reviewerEmail: u.email, reviewerName: u.name,
        createdAt: at, createdBy: actor, startedAt: null, seen: "needs_review",
        github: u.githubLogin ? { state: "pending", error: "", code: "", at } : { state: "no_login", error: "", code: "no_login", at }
      };
      d.assignments.push(a);
      created.push({ ...a });
      add.push(["reviews-by:" + id, prId]);
    }
    if (!created.length) return { out: created };
    return { doc: d, add, out: created };
  });
  const title = pr.title, key = pr.keys?.[0] || "", repo = prId.split("#")[0] + " #" + pr.number;
  await notify(env, adds.map((a) => a.reviewerEmail), { type: "review", key, title: "Review requested: " + title, by: actor.name, text: repo });
  // A reviewer without a GitHub login waits for one (see requestWaitingReviews); the others are asked now.
  await Promise.all(adds.filter((a) => a.github.state === "pending").map(async (a) => {
    const github = await requestOnGitHub(env, prId, pr, byId.get(a.reviewerId).githubLogin);
    await editAssignment(env, prId, a.id, (x) => { x.github = github; });
  }));
}

// Reviewer data for the administrator's picker: accounts only, no emails or sign-in details.
const people = (list) => list.map((u) => ({ accountId: u.id, name: u.name, dev: u.dev || "", githubLogin: u.githubLogin || "" })).sort((a, b) => a.name.localeCompare(b.name));

// Jira's rich text (ADF) as plain text. Ticket details are read-only, so no HTML is ever produced.
export function adfText(node, depth = 0) {
  if (node == null || depth > 40) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((n) => adfText(n, depth + 1)).join("");
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return "@" + String(node.attrs?.text || "").replace(/^@/, "");
  const inner = (node.content || []).map((n) => adfText(n, depth + 1)).join("");
  return /^(paragraph|heading|listItem|codeBlock|blockquote|rule|tableRow)$/.test(node.type) ? inner + "\n" : inner;
}
const plain = (text) => String(text || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 20000);

// The full ticket for a reviewer, read-only: what a developer sees, without history, edits or business fields.
async function readReviewTicket(env, deps, key) {
  if (key.startsWith("INT-")) {
    const raw = await env.STORE.get("it:" + key);
    if (!raw) return null;
    const t = JSON.parse(raw);
    return {
      key, title: t.summary || key, status: t.status || "", priority: t.priority || "", type: "Internal ticket", epic: "",
      assignee: t.assignee?.name || "Unassigned", reporter: "", due: t.due || null, created: null, updated: null,
      devs: t.devs || [], description: plain(t.description), commentsTotal: (t.comments || []).length,
      comments: (t.comments || []).slice(-50).map((c) => ({ author: c.author?.name || "Someone", created: c.created, body: plain(c.body) })),
      attachments: (t.attachments || []).map((a) => ({ id: a.id, filename: a.filename, size: a.size, mimeType: a.mimeType, created: a.created }))
    };
  }
  const r = await deps.jira(env, "/rest/api/3/issue/" + key + "?fields=summary,description,status,assignee,reporter,labels,duedate,created,updated,priority,issuetype,project,comment,attachment,parent");
  if (!r.ok) { if ([403, 404].includes(r.res.status)) return null; throw new Error("Ticket read failed"); }
  const f = r.data.fields || {};
  if (r.data.key !== key || f.project?.key !== env.JIRA_PROJECT) return null;
  const comments = f.comment?.comments || [];
  return {
    key, title: f.summary || key, status: f.status?.name || "", priority: f.priority?.name || "", type: f.issuetype?.name || "",
    epic: f.parent?.fields?.summary || "", assignee: f.assignee?.displayName || "Unassigned", reporter: f.reporter?.displayName || "",
    due: f.duedate || null, created: f.created || null, updated: f.updated || null,
    devs: (f.labels || []).filter((l) => /^ai1_/i.test(l)).map((l) => l.slice(4).toLowerCase()),
    description: plain(adfText(f.description)), commentsTotal: f.comment?.total ?? comments.length,
    comments: comments.slice(-50).map((c) => ({ author: c.author?.displayName || "Someone", created: c.created, body: plain(adfText(c.body)) })),
    attachments: (f.attachment || []).map((a) => ({ id: String(a.id), filename: a.filename, size: a.size, mimeType: a.mimeType, created: a.created }))
  };
}

// The pull request that gives this account read access to the ticket: an open pull request that mentions the ticket
// and has an assignment for the account. Checked on every read; closure or merge ends it at once.
async function reviewedPr(env, accountId, key) {
  for (const prId of await env.STORE.smembers(setKey(accountId))) {
    const pr = await prRecord(env, prId);
    if (!isOpen(pr) || !pr.keys?.includes(key)) continue;
    const doc = await readDoc(env, prId);
    if (doc?.assignments.some((a) => a.reviewerId === accountId)) return pr;
  }
  return null;
}

async function ticketAttachment(env, deps, key, id) {
  if (key.startsWith("INT-")) {
    const raw = await env.STORE.get("it:" + key);
    const att = raw && (JSON.parse(raw).attachments || []).find((a) => a.id === id);
    if (!att) return null;
    const bytes = await readFile(env.STORE, att);
    if (!bytes) return null;
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(att.mimeType || "") ? att.mimeType : "application/octet-stream";
    return new Response(bytes, { status: 200, headers: { "Content-Type": type,"Content-Length": String(bytes.length), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(att.filename) } });
  }
  if (!/^\d{1,20}$/.test(id)) return null;
  const r = await deps.jira(env, "/rest/api/3/issue/" + key + "?fields=attachment,project");
  if (!r.ok || r.data.key !== key || r.data.fields?.project?.key !== env.JIRA_PROJECT) return null;
  const meta = (r.data.fields?.attachment || []).find((a) => String(a.id) === id);
  if (!meta) return null;
  const file = await fetch(env.JIRA_SITE + "/rest/api/3/attachment/content/" + id, { headers: { Authorization: "Basic " + btoa(env.JIRA_EMAIL + ":" + env.JIRA_API_TOKEN) } });
  if (!file.ok || !file.body) return null;
  const type = String(meta.mimeType || "application/octet-stream").split(";")[0].trim();
  return new Response(file.body, { status: 200, headers: {
    "Content-Type": /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "application/octet-stream",
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(meta.filename || "attachment")
  } });
}

// An open pull request that names the ticket, for the ticket dialog's link (administrators see every ticket).
async function openPrFor(env, key) {
  return Object.values((await pullIndex(env)).prs).find((pr) => isOpen(pr) && pr.keys?.includes(key)) || null;
}

// Internal tickets (INT-n) live in the store; every other ticket is read from Jira.
const jiraKey = (key) => !key.startsWith("INT-");
// Oldest wait first. A missing time sorts last.
const byWait = (a = "", b = "") => { const x = a || "9999", y = b || "9999"; return x < y ? -1 : x > y ? 1 : 0; };

// Title, status and assignee of each ticket. A Jira ticket outside this project is left out. When Jira can't be read,
// the Jira tickets stay with their key only and the error says so.
async function ticketDetails(env, deps, keys) {
  const details = new Map();
  let error = "";
  for (const key of keys.filter((k) => !jiraKey(k))) {
    const raw = await env.STORE.get("it:" + key);
    if (!raw) continue;
    const t = JSON.parse(raw);
    details.set(key, { title: t.summary || key, status: t.status || "", assignee: t.assignee?.name || "Unassigned" });
  }
  const ours = keys.filter(jiraKey);
  for (let i = 0; i < ours.length; i += 100) {
    try {
      const jql = 'project = "' + env.JIRA_PROJECT + '" AND key in (' + ours.slice(i, i + 100).join(",") + ")";
      const r = await deps.jira(env, "/rest/api/3/search/jql", { method: "POST", body: { jql, fields: ["summary", "status", "assignee"], maxResults: 100 } });
      if (!r.ok) { error = "Jira couldn't be read, so titles and assignees may be missing."; continue; }
      for (const issue of r.data.issues || []) {
        details.set(issue.key, { title: issue.fields?.summary || issue.key, status: issue.fields?.status?.name || "", assignee: issue.fields?.assignee?.displayName || "Unassigned" });
      }
    } catch {
      error = "Jira couldn't be read, so titles and assignees may be missing.";
    }
  }
  return { details, error };
}

// Every reviewer on a pull request: the dashboard people assigned, then anyone else GitHub has been asked for.
function reviewersOf(pr, assignments, byId, byLogin) {
  const out = [], seen = new Set();
  const add = (name, login) => {
    const k = lc(login || name);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ name: name || login, login: login || "" });
  };
  for (const a of assignments) add(a.reviewerName, byId.get(a.reviewerId)?.githubLogin || "");
  for (const login of pr.status?.requested || []) add(byLogin.get(lc(login))?.name || login, login);
  return out;
}

// The administrators' queue: open pull requests that name a ticket and need a review now, grouped by ticket. A pull
// request is listed when prReviewState says so, and "changes requested" is listed too. Approved ones are left out
// unless they are stale or GitHub needs more approvals. Drafts, merged and closed pull requests never appear.
// Read-only: nothing is stored. Sync and Jira failures come back as fields, so the page can say so.
async function adminQueue(env, deps, me) {
  if (!githubConfigured(env)) return json({ configured: false, syncedAt: null, syncError: "", ticketsError: "", tickets: [], counts: { tickets: 0, prs: 0 }, reviewers: [], clients: [] });
  let syncError = "";
  try { await syncPulls(env); } catch (e) { syncError = e.message || "Couldn't read pull requests."; }
  const index = await pullIndex(env);
  syncError = syncError || index.statusError || "";
  const open = Object.values(index.prs).filter((pr) => pr.state === "open" && pr.keys?.length);
  const [docs, users, catalog] = await Promise.all([Promise.all(open.map((pr) => readDoc(env, pr.id))), listUsers(env.STORE), readCatalog(env)]);
  const byId = new Map(users.map((u) => [u.id, u])), byLogin = new Map(users.filter((u) => u.githubLogin).map((u) => [lc(u.githubLogin), u]));
  const named = [...new Set(open.flatMap((pr) => pr.keys.filter((k) => TICKET.test(k))))];
  const { details, error: ticketsError } = await ticketDetails(env, deps, named);
  const known = (key) => details.has(key) || (!!ticketsError && jiraKey(key));

  const rows = [];
  open.forEach((pr, i) => {
    const keys = pr.keys.filter((k) => TICKET.test(k) && known(k));
    if (!keys.length) return;
    const assignments = docs[i]?.assignments || [];
    const review = prReviewState(pr, assignments);
    if (review.state === "approved" && !review.counts) return;
    rows.push({ pr, keys, review, reviewers: reviewersOf(pr, assignments, byId, byLogin) });
  });

  const groups = new Map();
  for (const row of rows) for (const key of row.keys) groups.set(key, [...(groups.get(key) || []), row]);
  const tickets = await Promise.all([...groups].map(async ([key, list]) => {
    const d = details.get(key) || { title: key, status: "", assignee: "" };
    const m = publicMetadata(await readMetadata(env, key), me, catalog);
    const prs = list
      .map(({ pr, review, reviewers }) => ({ id: pr.id, repo: pr.id.split("#")[0], number: pr.number, title: pr.title, url: pr.url, author: pr.author || "", state: review.state, reason: review.reason, since: review.since, reviewers }))
      .sort((a, b) => byWait(a.since, b.since) || a.number - b.number);
    return { key, title: d.title, status: d.status, assignee: d.assignee, client: m.clientName || "", subClient: m.subClientName || "", since: earliest(prs.map((p) => p.since)), prs };
  }));
  tickets.sort((a, b) => byWait(a.since, b.since) || a.key.localeCompare(b.key));
  const reviewers = [...new Set(rows.flatMap((r) => r.reviewers.map((x) => x.name)))].sort((a, b) => a.localeCompare(b));
  const clients = [...new Set(tickets.map((t) => t.client).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return json({
    configured: true, syncedAt: index.syncedAt ? new Date(index.syncedAt).toISOString() : null, syncError, ticketsError,
    tickets, counts: { tickets: tickets.length, prs: rows.length }, reviewers, clients
  });
}

// The tickets with an open pull request that needs a review, by the administrators' queue rule, from the last synced
// index (nothing is fetched from GitHub or Jira). For the Odoo projects table: key -> [{id, number, title, url, state}].
export async function ticketsAwaitingReview(env) {
  const out = new Map();
  if (!githubConfigured(env) || !env.STORE) return out;
  const open = Object.values((await pullIndex(env)).prs).filter((pr) => pr.state === "open" && pr.keys?.length);
  const docs = await Promise.all(open.map((pr) => readDoc(env, pr.id)));
  open.forEach((pr, i) => {
    const review = prReviewState(pr, docs[i]?.assignments || []);
    if (review.state === "approved" && !review.counts) return;
    for (const key of pr.keys.filter((k) => TICKET.test(k))) out.set(key, [...(out.get(key) || []), { id: pr.id, number: pr.number, title: pr.title, url: pr.url, state: review.state, since: review.since || null }]);
  });
  return out;
}

// Reviewer and administrator routes. deps.jira is the proxy's Jira call (see handler.js).
export async function reviewRoutes(request, env, url, me, deps) {
  const store = env.STORE, path = url.pathname, method = request.method;
  if (!store?.writeIndexed) return fail("reviews", "Review requests need the account database.", 503);
  const isAdmin = me.role === "admin";
  const found = await getUser(store, me.email);
  const user = found && (await ensureAccountId(store, found));
  if (!user) return fail("session", "Please sign in again.", 401);
  const prId = url.searchParams.get("id") || "";
  const readJson = async () => { try { return await request.json(); } catch { return null; } };
  const forbidden = () => fail("forbidden", "Only administrators can do that.", 403);

  if (method === "GET" && path === "/reviews/me") return myQueue(env, user);

  if (method === "GET" && path === "/reviews/people") {
    if (!isAdmin) return forbidden();
    return json({ people: people(await accountsWithIds(store)) });
  }

  if (method === "GET" && path === "/reviews/queue") {
    if (!isAdmin) return forbidden();
    return adminQueue(env, deps, me);
  }

  if (path === "/reviews/pr") {
    if (!PR_ID.test(prId)) return fail("bad_request", "Choose a pull request.", 400);
    const pr = await prRecord(env, prId);
    if (!pr) return fail("not_found", "Pull request unavailable.", 404);
    if (method === "GET") {
      const users = await listUsers(store);
      const doc = (await readDoc(env, prId)) || { assignments: [] };
      if (!isAdmin && !doc.assignments.some((a) => a.reviewerId === user.id)) return fail("not_found", "Pull request unavailable.", 404);
      return prView(env, prId, pr, { isAdmin, id: user.id }, users);
    }
    if (method === "PUT") {
      if (!isAdmin) return forbidden();
      const b = await readJson();
      if (!Array.isArray(b?.reviewerIds) || b.reviewerIds.length > MAX_REVIEWERS || !b.reviewerIds.every((x) => typeof x === "string" && x.length <= 64)) return fail("bad_request", "Choose up to " + MAX_REVIEWERS + " reviewers.", 400);
      if (!isOpen(pr)) return fail("conflict", "Closed or merged pull requests can't get reviewers.", 409);
      const wanted = [...new Set(b.reviewerIds)];
      const byId = new Map((await accountsWithIds(store)).map((u) => [u.id, u]));
      for (const id of wanted) {
        const u = byId.get(id);
        if (!u) return fail("bad_request", "Choose dashboard people as reviewers.", 400);
        if (u.githubLogin && lc(u.githubLogin) === lc(pr.author)) return fail("bad_request", u.name + " wrote this pull request, so they can't review it.", 400);
      }
      await addReviewers(env, user, prId, pr, wanted, byId);
      return prView(env, prId, pr, { isAdmin, id: user.id }, await listUsers(store));
    }
    return fail("method", "Use GET or PUT here.", 405);
  }

  if (method === "POST" && (path === "/reviews/retry" || path === "/reviews/start")) {
    if (!PR_ID.test(prId)) return fail("bad_request", "Choose a pull request.", 400);
    const pr = await prRecord(env, prId);
    if (!pr) return fail("not_found", "Pull request unavailable.", 404);
    const aid = url.searchParams.get("assignment") || "";
    const doc = await readDoc(env, prId);
    const a = doc?.assignments.find((x) => x.id === aid);
    if (!a) return fail("not_found", "No such review.", 404);
    if (path === "/reviews/start") {
      if (a.reviewerId !== user.id) return fail("not_found", "No such review.", 404);
      if (!a.startedAt) await editAssignment(env, prId, aid, (x) => { x.startedAt = nowIso(); });
    } else {
      if (!isAdmin) return forbidden();
      if (!isOpen(pr)) return fail("conflict", "Closed or merged pull requests can't get reviewers.", 409);
      const full = (await listUsers(store)).find((u) => u.id === a.reviewerId);
      const github = await requestOnGitHub(env, prId, pr, full?.githubLogin || "");
      await editAssignment(env, prId, aid, (x) => { x.github = github; });
    }
    const users = await listUsers(store);
    return prView(env, prId, pr, { isAdmin, id: user.id }, users);
  }

  if (method === "GET" && path === "/reviews/ticket") {
    const key = url.searchParams.get("key") || "";
    if (!TICKET.test(key)) return fail("bad_request", "Choose a ticket.", 400);
    // Administrators read any ticket (read-only); others only the tickets of their own pull requests.
    const pr = isAdmin ? await openPrFor(env, key) : await reviewedPr(env, user.id, key);
    const ticket = (isAdmin || pr) && (await readReviewTicket(env, deps, key));
    if (!ticket) return fail("not_found", "Ticket unavailable.", 404);
    return json({ ticket, pr: prSummary(pr, pr?.id || "") });
  }
  if (method === "GET" && path === "/reviews/ticket/attachment") {
    const key = url.searchParams.get("key") || "", id = url.searchParams.get("id") || "";
    if (!TICKET.test(key) || !ATTACHMENT.test(id)) return fail("bad_request", "Choose an attachment.", 400);
    if (!isAdmin && !(await reviewedPr(env, user.id, key))) return fail("not_found", "Attachment unavailable.", 404);
    return (await ticketAttachment(env, deps, key, id)) || fail("not_found", "Attachment unavailable.", 404);
  }
  return fail("not_found", "Not found.", 404);
}
