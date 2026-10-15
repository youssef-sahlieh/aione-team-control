// Pull requests from the product repositories (GITHUB_REPOS), matched to Jira tickets by the ticket
// number people write in the PR: "AION-71" anywhere (title, description, branch), the release-note
// "Jira:" line ("Jira: AION-571 / AION-575", "Jira: 572"), or "Jira 72" / "Jira ticket 72".
// One index of all PRs is kept in the database and brought up to date incrementally (only PRs changed
// since the last sync are read), at most every SYNC_MS, so ticket screens stay fast.
const SYNC_MS = 2 * 60 * 1000;
const INDEX_KEY = "github:prs:v1", LOCK_KEY = "github:prs:lock";
const MAX_PAGES_FIRST_SYNC = 40; // 4,000 PRs per repository

export const githubConfigured = (env) => !!(env.GITHUB_TOKEN && repos(env).length);
export function repos(env) { return String(env.GITHUB_REPOS || "").split(",").map((r) => r.trim()).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)); }
function aliases(env) { return [...new Set([env.JIRA_PROJECT, ...String(env.GITHUB_JIRA_ALIASES || "").split(",")].map((a) => String(a || "").trim().toUpperCase()).filter((a) => /^[A-Z][A-Z0-9_]*$/.test(a)))]; }

// Every ticket key a PR refers to, as this project's keys (aliases such as AIONE-12 become AION-12).
export function ticketKeys(env, { title = "", body = "", branch = "" }) {
  const project = String(env.JIRA_PROJECT || "").toUpperCase(), out = new Set();
  const names = aliases(env).map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (!project || !names) return [];
  const full = new RegExp("(?:^|[^A-Za-z0-9])(?:" + names + ")[-_ ]?\\s?(\\d{1,7})(?!\\d)", "gi");
  for (const text of [title, body, branch]) for (const m of String(text || "").matchAll(full)) out.add(project + "-" + Number(m[1]));
  // Bare numbers only where they are clearly a Jira reference.
  const text = String(title || "") + "\n" + String(body || "");
  for (const m of text.matchAll(/^[ \t>*_-]*jira\s*:([^\n]*)$/gim)) for (const n of m[1].matchAll(/(?:^|[^A-Za-z0-9-])#?(\d{1,7})(?!\d)/g)) out.add(project + "-" + Number(n[1]));
  for (const m of text.matchAll(/\bjira(?:\s+ticket)?\s*#?\s*(\d{1,7})(?!\d)/gi)) out.add(project + "-" + Number(m[1]));
  return [...out];
}

function record(env, repo, pr) {
  return {
    id: repo + "#" + pr.number, repo: repo.split("/")[1], number: pr.number, title: String(pr.title || "").slice(0, 300),
    state: pr.merged_at ? "merged" : pr.state === "open" ? (pr.draft ? "draft" : "open") : "closed",
    url: pr.html_url, author: pr.user && pr.user.login, branch: pr.head && pr.head.ref, base: pr.base && pr.base.ref,
    updated: pr.updated_at, merged: pr.merged_at || null,
    keys: ticketKeys(env, { title: pr.title, body: pr.body, branch: pr.head && pr.head.ref })
  };
}

async function gh(env, path) {
  const res = await fetch("https://api.github.com" + path, { headers: { Authorization: "Bearer " + env.GITHUB_TOKEN, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "aion-team-control" } });
  if (!res.ok) {
    const why = res.status === 401 ? "the GitHub token isn't valid" : res.status === 403 || res.status === 404 ? "the GitHub token can't read this repository" : "GitHub answered " + res.status;
    throw new Error("Couldn't read pull requests: " + why + ".");
  }
  return res.json();
}

async function readIndex(env) { try { return JSON.parse((await env.STORE.get(INDEX_KEY)) || "null") || { prs: {}, cursors: {}, syncedAt: 0 }; } catch { return { prs: {}, cursors: {}, syncedAt: 0 }; } }

// Brings the index up to date. Each repository is read newest-updated first until PRs older than
// the last sync appear, so a normal sync is one request per repository.
export async function syncPulls(env, { force = false } = {}) {
  const index = await readIndex(env);
  if (!force && Date.now() - index.syncedAt < SYNC_MS) return { index, synced: false };
  const owner = crypto.randomUUID();
  if (!(await env.STORE.setIfAbsent(LOCK_KEY, owner, 120))) return { index, synced: false };
  try {
    // Repositories are read at the same time (each one's pages in order).
    await Promise.all(repos(env).map(async (repo) => {
      const cursor = index.cursors[repo] || "";
      let newest = cursor, done = false;
      for (let page = 1; !done && page <= (cursor ? 10 : MAX_PAGES_FIRST_SYNC); page++) {
        const list = await gh(env, "/repos/" + repo + "/pulls?state=all&sort=updated&direction=desc&per_page=100&page=" + page);
        for (const pr of list) {
          if (cursor && pr.updated_at <= cursor) { done = true; break; }
          const r = record(env, repo, pr);
          if (r.keys.length) index.prs[r.id] = r; else delete index.prs[r.id];
          if (!newest || pr.updated_at > newest) newest = pr.updated_at;
        }
        if (list.length < 100) done = true;
      }
      index.cursors[repo] = newest;
    }));
    index.syncedAt = Date.now();
    await env.STORE.set(INDEX_KEY, JSON.stringify(index));
    return { index, synced: true };
  } finally { await env.STORE.deleteIfValue(LOCK_KEY, owner); }
}

export function prsByKey(index, keys) {
  const want = new Set(keys), out = {};
  for (const pr of Object.values(index.prs)) for (const k of pr.keys) if (want.has(k)) {
    const { keys: _all, ...rest } = pr; (out[k] = out[k] || []).push(rest);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => (a.updated < b.updated ? 1 : -1));
  return out;
}
