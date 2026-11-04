// Pull request review assignments. An administrator asks dashboard people to review a pull request that is linked
// to tickets. Each reviewer gets their own assignment in their "Needs review" queue and read-only access to the
// tickets the pull request mentions. When the reviewer has a GitHub login set by an administrator (Users page), the
// review is also requested on GitHub. Approvals and requested changes happen on GitHub; the dashboard shows them from
// the synced pull request index (github.js). A review assignment never changes the Jira ticket.
//
// Store keys:
//   "review:<owner/repo#number>"  one JSON document per pull request: { prId, assignments: [...] }, changed with
//                                 compare-and-set (writeIndexed) so two administrators never overwrite each other.
//   "reviews-by:<accountId>"      set of pull request IDs the account has been assigned (kept for history too).
// An assignment: { id, reviewerId, reviewerEmail, reviewerName, status: "active"|"removed", createdAt, createdBy,
//   startedAt, endedAt, seen, github: { state, error, code, at, removeError } }
// github.state: "no_login" (no GitHub login set yet) | "pending" | "requested" | "failed" | "removed".
// The shown status (needs_review, in_review, approved, changes_requested, closed, unlinked) is worked out from the
// assignment and the synced pull request, so it is never stored and cannot go stale.
import { addToInbox } from "./inbox.js";
import { ensureAccountId, getUser, listUsers } from "./users.js";
import { githubConfigured, prRecord, removeReviewer, requestReviewer, requestedLogins, syncPulls } from "./github.js";
import { readFile } from "./internal.js";

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
  if (a.status !== "active") return "removed";
  if (!pr) return "unlinked";
  if (!isOpen(pr)) return "closed";
  const latest = login ? (pr.status?.reviews || []).find((r) => lc(r.by) === lc(login)) : null;
  if (latest?.state === "APPROVED") return "approved";
  if (latest?.state === "CHANGES_REQUESTED") return "changes_requested";
  return a.startedAt ? "in_review" : "needs_review";
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
    if (a.status !== "active") continue;
    const status = reviewStatus(a, pr, byEmail.get(a.reviewerId)?.githubLogin);
    if (status === a.seen) continue;
    const changed = await mutate(env, prId, (d) => {
      const x = d.assignments.find((y) => y.id === a.id);
      if (!x || x.status !== "active" || x.seen === status) return { out: false };
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
      if (a.reviewerId !== accountId || a.status !== "active" || a.github?.state !== "no_login") continue;
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
    github: { state: a.github?.state || "none", error: a.github?.error || "", code: a.github?.code || "", removeError: a.github?.removeError || "" }
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
      if (a.reviewerId !== user.id || a.status !== "active") continue;
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

// Replaces the reviewers of one pull request with the chosen set: adds new ones, ends the rest. Each new reviewer
// gets one assignment; a repeated request finds the assignment already there and adds nothing.
async function setReviewers(env, me, prId, pr, wanted, byId) {
  const at = nowIso(), actor = { email: me.email, name: me.name || me.email };
  // byId holds the full account records (GitHub login included), so the actions below need no second read.
  const result = await mutate(env, prId, (d) => {
    const removed = [], adds = [], add = [];
    for (const a of d.assignments) {
      if (a.status === "active" && !wanted.includes(a.reviewerId)) {
        a.status = "removed";
        a.endedAt = at;
        removed.push({ ...a });
      }
    }
    const active = new Set(d.assignments.filter((a) => a.status === "active").map((a) => a.reviewerId));
    for (const id of wanted) {
      if (active.has(id)) continue;
      const u = byId.get(id);
      const a = {
        id: crypto.randomUUID(), reviewerId: id, reviewerEmail: u.email, reviewerName: u.name, status: "active",
        createdAt: at, createdBy: actor, startedAt: null, endedAt: null, seen: "needs_review",
        github: u.githubLogin ? { state: "pending", error: "", code: "", at } : { state: "no_login", error: "", code: "no_login", at }
      };
      d.assignments.push(a);
      adds.push({ ...a });
      add.push(["reviews-by:" + id, prId]);
    }
    if (!adds.length && !removed.length) return { out: { adds, removed } };
    return { doc: d, add, out: { adds, removed } };
  });
  const title = pr.title, key = pr.keys?.[0] || "", repo = prId.split("#")[0] + " #" + pr.number;
  await notify(env, result.adds.map((a) => a.reviewerEmail), { type: "review", key, title: "Review requested: " + title, by: actor.name, text: repo });
  await notify(env, result.removed.map((a) => a.reviewerEmail), { type: "review_removed", key, title: "Review request removed: " + title, by: actor.name, text: repo });
  // Requests that GitHub should see: removed ones it was asked for, and new ones (those without a login wait for one).
  for (const a of result.removed) {
    if (a.github?.state !== "requested" || !byId.get(a.reviewerId)?.githubLogin) continue;
    const r = await removeReviewer(env, prId.split("#")[0], pr.number, byId.get(a.reviewerId).githubLogin).catch(() => null);
    await editAssignment(env, prId, a.id, (x) => { x.github = r?.ok ? { ...x.github, state: "removed", removeError: "" } : { ...x.github, removeError: r ? "GitHub answered " + r.status + "." : "GitHub didn't answer." }; });
  }
  await Promise.all(result.adds.filter((a) => a.github.state === "pending").map(async (a) => {
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
// and has an active assignment for the account. Checked on every read; removal or closure ends it at once.
async function reviewedPr(env, accountId, key) {
  for (const prId of await env.STORE.smembers(setKey(accountId))) {
    const pr = await prRecord(env, prId);
    if (!isOpen(pr) || !pr.keys?.includes(key)) continue;
    const doc = await readDoc(env, prId);
    if (doc?.assignments.some((a) => a.reviewerId === accountId && a.status === "active")) return pr;
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
      await setReviewers(env, user, prId, pr, wanted, byId);
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
    const a = doc?.assignments.find((x) => x.id === aid && x.status === "active");
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
    const pr = await reviewedPr(env, user.id, key);
    const ticket = pr && await readReviewTicket(env, deps, key);
    if (!ticket) return fail("not_found", "Ticket unavailable.", 404);
    return json({ ticket, pr: prSummary(pr, pr.id || "") });
  }
  if (method === "GET" && path === "/reviews/ticket/attachment") {
    const key = url.searchParams.get("key") || "", id = url.searchParams.get("id") || "";
    if (!TICKET.test(key) || !ATTACHMENT.test(id)) return fail("bad_request", "Choose an attachment.", 400);
    if (!(await reviewedPr(env, user.id, key))) return fail("not_found", "Attachment unavailable.", 404);
    return (await ticketAttachment(env, deps, key, id)) || fail("not_found", "Attachment unavailable.", 404);
  }
  return fail("not_found", "Not found.", 404);
}
