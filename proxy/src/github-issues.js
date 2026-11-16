// GitHub issues become internal tickets (INT-n). One-way: GitHub -> internal system. The original issue is never changed.
//
// Sources are configured per repository in settings.js (GITHUB_ISSUE_SOURCES): each names the developer its new tickets
// go to. Adding a repository is a settings change only.
//
// Duplicates: the claim key "ext:github:<repo>:<issue id>" holds the internal ticket key once the ticket exists. A short
// lock ("extlock:...") makes two simultaneous deliveries wait their turn. If a claim points at a ticket that was never
// written (a crash mid-create), the next delivery writes that same ticket instead of taking a new number.
//
// Store keys used (the same as internal.js): "it:<KEY>" ticket, "itickets" set, "it:seq" counter.

import { githubRequest } from "./github.js";
import { ensureAccountId, listUsers, normDev, validDev } from "./users.js";
import { INTERNAL_ASSIGNEE, saveMetadata, internalDefaults, internalOdooProject } from "./ticket-metadata.js";
import { recordTicketEvent } from "./ticket-log.js";
import { odooConfigured } from "./odoo.js";

const LOCK_SECONDS = 60;
const TEN_YEARS = 315360000;
const MAX_BODY = 1024 * 1024;
const SYSTEM = { email: "github-issues@system", name: "GitHub", role: "admin" };
const SYSTEM_BY = { email: SYSTEM.email, name: SYSTEM.name };

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const fail = (code, error, status) => json({ code, error }, status);
const now = () => new Date().toISOString();

// The configured repositories, keyed by lowercase "owner/repo". Entries with no valid developer are left out.
export function githubSources(env) {
  const out = {};
  for (const [repo, cfg] of Object.entries(env.GITHUB_ISSUE_SOURCES || {})) {
    const developer = normDev(cfg && cfg.developer);
    if (/^[\w.-]+\/[\w.-]+$/.test(repo) && developer && validDev(developer)) out[repo.toLowerCase()] = { repo, developer };
  }
  return out;
}

// Constant-time comparison of two strings (hashed first, so the length doesn't leak either).
async function sameText(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s))))));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

// GitHub signs the raw body with the webhook secret: X-Hub-Signature-256 is "sha256=" plus the hex HMAC-SHA256.
export async function validSignature(raw, header, secret) {
  if (!header || !String(header).startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sameText(hex, String(header).slice(7));
}

// The Bashar K rule: exactly one account whose developer name is the configured one. Nothing else matches (a similar
// name or a second account with the same developer name is not taken for him). Returns the account, or an error.
export async function resolveDeveloper(store, developer) {
  const matches = (await listUsers(store)).filter((u) => normDev(u.dev) === developer);
  if (matches.length !== 1) return { error: matches.length ? matches.length + " accounts have the developer name " + developer : "no account has the developer name " + developer };
  const user = await ensureAccountId(store, matches[0]);
  if (!user || !user.id) return { error: "the account for " + developer + " has no internal ID" };
  return { accountId: user.id, name: String(user.name || user.email || developer) };
}

async function placement(env) {
  if (odooConfigured(env)) {
    const internal = await internalOdooProject(env);
    return internal ? { odooProjectId: internal.id } : {};
  }
  return internalDefaults(env);
}

// Creates the internal ticket for one GitHub issue, or returns the one already made. Returns
// { status: "created" | "duplicate" | "in_progress", key }.
export async function createFromIssue(env, { repo, developer, issue }) {
  const store = env.STORE;
  const ref = "ext:github:" + repo.toLowerCase() + ":" + issue.id, lockKey = "extlock:github:" + repo.toLowerCase() + ":" + issue.id;
  const existing = await store.get(ref);
  if (existing && (await store.get("it:" + existing))) return { status: "duplicate", key: existing };

  const owner = crypto.randomUUID();
  if (!(await store.setIfAbsent(lockKey, owner, LOCK_SECONDS))) return { status: "in_progress", key: existing || null };
  try {
    const again = await store.get(ref);
    if (again && (await store.get("it:" + again))) return { status: "duplicate", key: again };
    const key = again || "INT-" + (await store.incr("it:seq"));
    if (!again) await store.set(ref, key);

    // Only an administrator's resolution can place the ticket on a developer. When Bashar K can't be found, the ticket
    // is still created, with no developer, so only administrators see it and can assign it.
    const found = await resolveDeveloper(store, developer);
    if (found.error) console.warn("github_issue_developer_unresolved", repo, issue.number, found.error);
    const devs = found.error ? [] : [developer];
    const title = String(issue.title || "");
    const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l && l.name)).filter(Boolean).map(String);
    const t = {
      key, summary: title.slice(0, 200), description: String(issue.body || ""), priority: "Medium", due: null, status: "Open",
      assignee: INTERNAL_ASSIGNEE, devs, comments: [], dueHistory: [], attachments: [],
      created: now(), updated: now(), createdBy: SYSTEM_BY, source: "github",
      external: {
        provider: "github", repo, issueId: issue.id, number: issue.number, url: issue.html_url,
        title, author: issue.user && issue.user.login || "", createdAt: issue.created_at || null, labels,
        developer, assignedAccountId: found.error ? null : found.accountId, assignmentError: found.error || null
      }
    };
    await store.set("it:" + key, JSON.stringify(t));
    await store.sadd("itickets", key);

    // The ticket exists from here on, so a failure below doesn't undo it (and the claim keeps it from being made twice).
    try { await saveMetadata(env, key, { ...(await placement(env)), revision: 0 }, SYSTEM, { creating: true, ticket: { title: t.summary, devs } }); }
    catch (e) { console.warn("github_issue_placement_failed", key, String((e && e.message) || e).slice(0, 200)); }
    await recordTicketEvent(env, key, SYSTEM, {
      action: "created",
      text: "Created from GitHub issue " + repo + "#" + issue.number + (found.error ? " (no developer: " + found.error + ")" : ""),
      changes: { status: { from: null, to: "Open" }, developers: { from: null, to: devs.join(", ") || "None" } }
    });
    return { status: "created", key, unassigned: !!found.error };
  } finally {
    await store.deleteIfValue(lockKey, owner);
  }
}

// POST /github/webhook. Public (GitHub can't sign in): the signature is the only check, and it is required.
export async function githubWebhook(request, env) {
  const secret = String(env.GITHUB_WEBHOOK_SECRET || "");
  if (secret.length < 32) return fail("notification_off", "GitHub issue tickets aren't configured.", 503);
  if (Number(request.headers.get("Content-Length")) > MAX_BODY) return fail("bad_request", "Event is too large.", 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return fail("bad_request", "Event is too large.", 413);
  if (!(await validSignature(raw, request.headers.get("X-Hub-Signature-256"), secret))) return fail("forbidden", "Invalid webhook signature.", 401);

  const event = request.headers.get("X-GitHub-Event") || "";
  if (event === "ping") return json({ ok: true, message: "pong" });
  if (event !== "issues") return json({ ok: true, ignored: "event" });
  let payload;
  try { payload = JSON.parse(raw); } catch { return fail("bad_request", "The event isn't valid JSON.", 400); }
  if (payload.action !== "opened") return json({ ok: true, ignored: "action" });
  // Pull requests also come through the issues event in some cases; they never become tickets.
  if (!payload.issue || payload.issue.pull_request) return json({ ok: true, ignored: "pull_request" });
  const repoName = String(payload.repository && payload.repository.full_name || "");
  const source = githubSources(env)[repoName.toLowerCase()];
  if (!source) return json({ ok: true, ignored: "repository" });
  if (!env.STORE) return fail("no_store", "GitHub issue tickets need the database.", 501);

  const r = await createFromIssue(env, { repo: source.repo, developer: source.developer, issue: payload.issue });
  if (r.status === "in_progress") return fail("in_progress", "This issue is being imported. Redeliver it in a moment.", 409);
  return json({ ok: true, status: r.status, key: r.key }, r.status === "created" ? 201 : 200);
}

// Imports the repository's existing issues (open and closed, not pull requests), a page at a time. Pages are read until
// the time budget is used, and nextPage says where to continue. Safe to run again: issues already imported are skipped.
export async function importGithubIssues(env, { repo, page = 1, budgetMs = 40000 } = {}) {
  const sources = Object.values(githubSources(env));
  const source = repo ? githubSources(env)[String(repo).toLowerCase()] : sources[0];
  if (!source) throw Object.assign(new Error("No GitHub repository is set up for issue tickets."), { status: 400 });
  if (!env.STORE) throw Object.assign(new Error("GitHub issue tickets need the database."), { status: 501 });
  const started = Date.now(), counts = { created: 0, duplicate: 0, in_progress: 0, pullRequests: 0 };
  let next = Math.max(1, Number(page) || 1), done = false;
  while (true) {
    const res = await githubRequest(env, "GET", "/repos/" + source.repo + "/issues?state=all&sort=created&direction=asc&per_page=100&page=" + next);
    if (!res.ok) throw Object.assign(new Error("GitHub answered " + res.status + " for " + source.repo + "."), { status: 502 });
    const list = Array.isArray(res.data) ? res.data : [];
    for (const issue of list) {
      if (issue.pull_request) { counts.pullRequests++; continue; }
      const r = await createFromIssue(env, { repo: source.repo, developer: source.developer, issue });
      counts[r.status]++;
    }
    if (list.length < 100) { done = true; break; }
    next++;
    if (Date.now() - started > budgetMs) break;
  }
  return { repo: source.repo, ...counts, done, nextPage: done ? null : next };
}
