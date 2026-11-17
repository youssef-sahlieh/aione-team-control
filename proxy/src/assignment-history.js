// Did a Jira ticket ever pass through Mordi? A read-only historical indicator for the All tickets page.
//
// Identity: Mordi's Jira account id comes from TEAM_CONFIG.people (the team setting that already links Jira account
// ids to people). Nothing is hardcoded and no display name is matched against assignees. If Mordi is missing, listed
// twice, or has no account id, every ticket is Unknown and the reason says what to configure.
//
// Evidence: the last 6 assignee changes in the ticket's changelog, read from the newest page backwards. A ticket is
// "ever" when any of those changes went to Mordi, the earliest of them was from Mordi, or Mordi is the current assignee.
// It is "never" only when the whole history has 6 or fewer assignee changes, was read, and none of that is true. Any
// failure, or a history with more than 6 assignee changes, is "unknown", never "never".
//
// Cost: results are cached per ticket and reused while Jira's `updated` stamp is the same. A reassignment changes
// `updated`, so the next check reads the new history; nothing is fetched on every page render.

const PAGE = 100;
const MAX_PAGES = 10;            // up to 1000 history entries per ticket
const CONCURRENCY = 4;
const BUDGET_MS = 15000;         // a single request never waits on Jira longer than this in total
const MAX_KEYS = 50;
const RECENT = 6;                // only the last 6 assignee changes decide the verdict
const CACHE_PREFIX = "jira-assignment:v2:";
const ACCOUNT_ID = /^[\w:-]{1,128}$/;
const JIRA_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

const isMordi = (key, person) =>
  /^mordi$/i.test(String(key || "")) || /^mordi$/i.test(String(person?.name || "").trim().split(/\s+/)[0] || "");

// Mordi's Jira account id from TEAM_CONFIG.people, or the reason it can't be used.
export function mordiAccount(env) {
  let people;
  try { people = JSON.parse(env.TEAM_CONFIG || "{}").people || {}; }
  catch { return { id: null, reason: "TEAM_CONFIG is not valid JSON, so Mordi's account can't be read." }; }
  const hits = Object.entries(people).filter(([key, person]) => isMordi(key, person));
  if (hits.length === 0) return { id: null, reason: "Add Mordi to TEAM_CONFIG.people with his Jira account id." };
  if (hits.length > 1) return { id: null, reason: "More than one person named Mordi is in TEAM_CONFIG.people. Keep one." };
  const [, person] = hits[0];
  if (typeof person?.id !== "string" || !ACCOUNT_ID.test(person.id)) return { id: null, reason: "Mordi's entry in TEAM_CONFIG.people has no Jira account id." };
  return { id: person.id, name: String(person.name || "Mordi") };
}

// Assignee changes from the changelog, oldest first. `fromKnown` is false when Jira didn't say who it was assigned to.
export function assigneeChanges(histories) {
  const out = [];
  for (const h of histories || []) {
    for (const item of h.items || []) {
      if (item.field !== "assignee" && item.fieldId !== "assignee") continue;
      out.push({
        at: String(h.created || ""),
        by: String(h.author?.displayName || ""),
        from: item.from ?? null,
        fromKnown: item.from !== undefined,
        fromName: String(item.fromString || ""),
        to: item.to ?? null,
        toName: String(item.toString || "")
      });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

// The verdict for one ticket. `complete` says the whole changelog was read.
export function analyzeAssignments({ changes, complete, currentId, mordiId, created }) {
  const mine = (id) => !!mordiId && id === mordiId;
  const first = changes[0] || null;
  // With no changes the assignee never moved, so the current assignee is the one from creation.
  const startId = first ? first.from : currentId;
  const startKnown = first ? first.fromKnown : true;
  const assignments = changes.filter((c) => mine(c.to)).map((c) => ({ at: c.at, by: c.by, kind: "assigned" }));
  const leftMordi = changes.filter((c) => mine(c.from));
  const events = [...assignments];
  if (mine(startId)) {
    if (first) events.unshift({ at: null, before: first.at, by: "", kind: "start" });
    else events.unshift({ at: created || null, by: "", kind: "creation" });
  }
  const lastLeft = leftMordi[leftMordi.length - 1] || null;
  const ever = mine(currentId) || mine(startId) || assignments.length > 0;

  let state;
  if (ever) state = "ever";
  else if (!complete) state = "unknown";
  else if (!startKnown) state = "unknown";
  else state = "never";

  return {
    state,
    assignedToMordi: ever,
    events,
    lastLeftAt: lastLeft ? lastLeft.at : null,
    lastLeftBy: lastLeft ? lastLeft.by : "",
    reason: state === "unknown" ? (complete ? "Jira didn't say who the ticket started with." : "The history is longer than the check reads.") : ""
  };
}

// Reads every changelog page for one ticket. Returns { histories, complete } or { failed, reason }.
export async function readHistories(jira, key) {
  const histories = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await jira("/rest/api/3/issue/" + key + "/changelog?startAt=" + page * PAGE + "&maxResults=" + PAGE, { signal: AbortSignal.timeout(5000) });
    if (!r || !r.ok || !r.data || !Array.isArray(r.data.values)) return { failed: true, reason: "Jira's history couldn't be read." };
    histories.push(...r.data.values);
    const done = r.data.isLast === true || r.data.values.length < PAGE || (typeof r.data.total === "number" && (page + 1) * PAGE >= r.data.total);
    if (done) return { histories, complete: true };
  }
  return { histories, complete: false };
}

// Reads the changelog from the newest page backwards, stopping once it holds RECENT assignee changes or reaches the
// start. `reachedStart` says the earliest entry was read.
export async function readRecentHistories(jira, key) {
  const fetchPage = async (page) => {
    const r = await jira("/rest/api/3/issue/" + key + "/changelog?startAt=" + page * PAGE + "&maxResults=" + PAGE, { signal: AbortSignal.timeout(5000) });
    if (!r || !r.ok || !r.data || !Array.isArray(r.data.values)) return null;
    return r.data;
  };
  const head = await fetchPage(0);
  if (!head) return { failed: true, reason: "Jira's history couldn't be read." };
  if (typeof head.total !== "number") {
    const full = await readHistories(jira, key);
    return full.failed ? full : { histories: full.histories, reachedStart: full.complete };
  }
  const lastPage = Math.max(0, Math.ceil(head.total / PAGE) - 1);
  const collected = [];
  let reachedStart = false;
  for (let page = lastPage, reads = 0; reads < MAX_PAGES; page--, reads++) {
    const data = page === 0 ? head : await fetchPage(page);
    if (!data) return { failed: true, reason: "Jira's history couldn't be read." };
    collected.unshift(...data.values);
    if (page === 0) { reachedStart = true; break; }
    if (assigneeChanges(collected).length >= RECENT) break;
  }
  return { histories: collected, reachedStart };
}

async function readCache(env, key) {
  if (!env.STORE) return null;
  try { const raw = await env.STORE.get(CACHE_PREFIX + key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function writeCache(env, key, value) {
  if (!env.STORE) return;
  try { await env.STORE.set(CACHE_PREFIX + key, JSON.stringify(value)); } catch { /* the next check simply reads Jira again */ }
}

// One ticket. Never throws: a failure is an Unknown result.
async function checkTicket(env, jira, issue, mordi, now) {
  const base = { key: issue.key, updated: issue.updated || "" };
  try {
    const cached = await readCache(env, issue.key);
    if (cached && cached.updated === issue.updated && cached.mordiId === mordi.id && cached.result) return { ...cached.result, cached: true };
    const read = await readRecentHistories(jira, issue.key);
    if (read.failed) return { ...base, state: "unknown", events: [], assignedToMordi: false, reason: read.reason, verifiedAt: null };
    const all = assigneeChanges(read.histories);
    const recent = all.slice(-RECENT);
    const verdict = analyzeAssignments({
      changes: recent, complete: read.reachedStart && all.length <= RECENT,
      currentId: issue.assigneeId || null, mordiId: mordi.id, created: issue.created || null
    });
    const result = { ...base, ...verdict, verifiedAt: new Date(now()).toISOString() };
    if (result.state !== "unknown") await writeCache(env, issue.key, { updated: issue.updated || "", mordiId: mordi.id, result });
    return { ...result, cached: false };
  } catch {
    return { ...base, state: "unknown", events: [], assignedToMordi: false, reason: "Jira's history couldn't be checked.", verifiedAt: null };
  }
}

// Results for the given Jira issues (already filtered to what the caller may see), in the same order.
export async function checkTickets({ env, jira, issues, now = Date.now }) {
  const mordi = mordiAccount(env);
  if (!mordi.id) return { configured: false, reason: mordi.reason, results: issues.map((i) => ({ key: i.key, state: "unknown", events: [], assignedToMordi: false, reason: mordi.reason, verifiedAt: null })) };
  const deadline = now() + BUDGET_MS, out = new Map(), queue = [...issues];
  const worker = async () => {
    while (queue.length) {
      const issue = queue.shift();
      out.set(issue.key, now() > deadline
        ? { key: issue.key, state: "unknown", events: [], assignedToMordi: false, reason: "Not checked yet. Try again in a moment.", verifiedAt: null }
        : await checkTicket(env, jira, issue, mordi, now));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, issues.length) }, worker));
  return { configured: true, mordi: { name: mordi.name }, results: issues.map((i) => out.get(i.key)) };
}

// Route: POST /jira/assignment-history { keys: [...] }. `searchIssues` is the caller-scoped Jira search, so a
// developer only gets history for tickets they are allowed to see.
export async function assignmentHistoryRoute(request, env, { searchIssues, jira, json, fail, readJson }) {
  if (request.method !== "POST") return fail("method", "Use POST.", 405);
  const body = (await readJson(request)) || {};
  const keys = Array.isArray(body.keys) ? body.keys : null;
  if (!keys || keys.length > MAX_KEYS || !keys.every((k) => typeof k === "string")) return fail("bad_request", "Ask for up to " + MAX_KEYS + " tickets at a time.", 400);
  const wanted = [...new Set(keys)];
  const jiraKeys = wanted.filter((k) => JIRA_KEY.test(k) && !/^(INT|HD)-/.test(k));
  const notJira = wanted.filter((k) => !jiraKeys.includes(k)).map((key) => ({ key, state: "na", events: [], assignedToMordi: false, reason: "Not a Jira ticket.", verifiedAt: null }));

  let visible = [];
  if (jiraKeys.length) {
    try {
      const data = await searchIssues({ jql: "key in (" + jiraKeys.join(",") + ")", fields: ["assignee", "created", "updated"], maxResults: MAX_KEYS });
      visible = (data.issues || []).map((i) => ({
        key: i.key, assigneeId: i.fields?.assignee?.accountId || null, created: i.fields?.created || null, updated: i.fields?.updated || ""
      }));
    } catch {
      return fail("jira", "Jira couldn't be asked which tickets you can see.", 502);
    }
  }
  const seen = new Set(visible.map((i) => i.key));
  const checked = await checkTickets({ env, jira, issues: visible });
  const byKey = new Map(checked.results.map((r) => [r.key, r]));
  const hidden = jiraKeys.filter((k) => !seen.has(k)).map((key) => ({ key, state: "unknown", events: [], assignedToMordi: false, reason: "Not available to you.", verifiedAt: null }));
  return json({ configured: checked.configured, reason: checked.configured ? "" : checked.reason, results: [...wanted.map((k) => byKey.get(k) || notJira.find((r) => r.key === k) || hidden.find((r) => r.key === k)).filter(Boolean)] });
}
