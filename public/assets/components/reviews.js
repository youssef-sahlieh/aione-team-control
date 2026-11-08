// Pull request reviews. Administrators choose who reviews a pull request (the picker, opened from the Pull requests
// block). Reviewers get a "Needs review" queue with a read-only view of the tickets the pull request mentions. The
// proxy keeps the assignments (proxy/src/reviews.js); GitHub is asked for the review when the reviewer has a GitHub
// username set by an administrator (Users page). Nothing here changes a Jira ticket.
import { reviewLabel, sortQueue, githubNote, ticketKeysOf, activeReviewerIds, assignedLine, queueStateLabel, queueReasonText, queueOptions, filterQueue, queueCounts, waitingFor, longestWaitFirst, NO_REVIEWER } from "../models/reviews.js";

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const btn = (text, cls, action) => { const b = el("button", cls, text); b.type = "button"; b.addEventListener("click", action); return b; };
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const size = (n) => (n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB");
// A select whose options can change on refresh; the chosen value stays when it is still offered.
const fillSelect = (select, pairs, value) => {
  select.replaceChildren(...pairs.map(([v, t]) => { const o = el("option", "", t); o.value = v; return o; }));
  select.value = pairs.some(([v]) => v === value) ? value : "";
  return select.value;
};

export function createReviews({ api, apiFile, toast, errorText, isAdmin = () => false }) {
  const dialog = el("dialog", "review-dialog");
  document.body.appendChild(dialog);
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  let queueTarget = null;
  // The administrators' queue: the last answer from the proxy, the last error, and the filters the person chose.
  let adminRoot = null, adminData = null, adminError = "";
  const adminFilters = { search: "", client: "", repo: "", reviewer: "", state: "" };

  // A dialog with a title, a body and a Close button. The body is replaced when the content arrives.
  function open(title, body) {
    dialog.replaceChildren();
    const heading = el("h2", "", title);
    heading.id = "review-dialog-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const foot = el("div", "review-actions");
    foot.append(btn("Close", "btn", () => dialog.close()));
    dialog.append(heading, body, foot);
    dialog.showModal();
  }

  // Administrator: the people who review this pull request, and the state of each request.
  function drawPicker(pr, view, people) {
    const body = el("div", "review-body");
    const form = el("form", "review-picker");
    const chosen = new Set(activeReviewerIds(view.assignments));
    const note = el("p", "review-note", "Reviewers see the pull request in their Needs review list, with the ticket read-only. People with a GitHub username also get a review request there. A reviewer stays on the pull request until it closes or merges.");
    const msg = el("p", "msg");
    const list = el("div", "review-people");
    for (const p of people) {
      const label = el("label", "review-person");
      const box = el("input");
      box.type = "checkbox"; box.name = "reviewer"; box.value = p.accountId; box.checked = chosen.has(p.accountId);
      // A reviewer already on the pull request stays there, so their box can't be cleared.
      box.disabled = box.checked;
      label.append(box, el("span", "", p.name + (p.dev ? " (" + p.dev + ")" : "")), el("span", p.githubLogin ? "review-tag ok" : "review-tag", p.githubLogin ? "GitHub " + p.githubLogin : "No GitHub username"));
      list.appendChild(label);
    }
    const save = el("button", "btn primary", "Save reviewers");
    save.type = "submit";
    form.append(list, save, msg);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const reviewerIds = [...form.querySelectorAll('input[name="reviewer"]:checked')].map((b) => b.value);
      save.disabled = true; msg.textContent = "Saving…";
      try {
        const next = await api("/reviews/pr?id=" + encodeURIComponent(pr.id), { method: "PUT", body: { reviewerIds } });
        drawPicker(pr, next, people);
        toast("Reviewers saved", [pr.repo + " #" + pr.number], false);
      } catch (err) {
        msg.textContent = errorText(err); msg.className = "msg err"; save.disabled = false;
      }
    });
    body.append(note, form);
    if (view.assignments.length) {
      const rows = el("div", "review-assignments");
      for (const a of view.assignments) {
        const row = el("div", "review-row");
        const gh = githubNote(a.github, { admin: true });
        row.append(el("b", "", a.reviewer.name), el("span", "review-status " + a.status, reviewLabel(a.status)));
        if (gh.text) row.append(el("span", "review-gh " + gh.tone, gh.text));
        if (gh.action === "retry") row.append(btn("Retry GitHub request", "btn", async () => {
          try { drawPicker(pr, await api("/reviews/retry?id=" + encodeURIComponent(pr.id) + "&assignment=" + encodeURIComponent(a.id), { method: "POST" }), people); }
          catch (err) { toast("GitHub request failed", [errorText(err)], true); }
        }));
        rows.appendChild(row);
      }
      body.append(el("h3", "", "Current reviews"), rows);
    }
    open("Reviewers: " + pr.repo + " #" + pr.number, body);
  }

  async function openPicker(pr) {
    open("Reviewers: " + pr.repo + " #" + pr.number, el("div", "review-body", "Loading…"));
    try {
      const [view, { people }] = await Promise.all([api("/reviews/pr?id=" + encodeURIComponent(pr.id)), api("/reviews/people")]);
      drawPicker(pr, view, people);
    } catch (err) {
      open("Reviewers", el("p", "msg err", errorText(err)));
    }
  }

  // Read-only: the fields a developer needs to review, without history, edits or business fields.
  function drawTicket(key, { ticket, pr }) {
    const body = el("div", "review-body");
    body.append(el("p", "review-ro", "Read-only. To change this ticket, use Jira or the ticket's own page."));
    const facts = el("dl", "review-facts");
    const pairs = [["Status", ticket.status], ["Priority", ticket.priority], ["Type", ticket.type], ["Epic", ticket.epic], ["Assignee", ticket.assignee], ["Reporter", ticket.reporter], ["Developers", ticket.devs.join(", ")], ["Due", day(ticket.due)], ["Created", day(ticket.created)], ["Updated", day(ticket.updated)]];
    for (const [k, v] of pairs) if (v) facts.append(el("dt", "", k), el("dd", "", v));
    body.append(facts);
    body.append(el("h3", "", "Description"), el("pre", "review-text", ticket.description || "No description."));
    if (ticket.attachments.length) {
      body.append(el("h3", "", "Attachments"));
      const list = el("ul", "review-files");
      for (const a of ticket.attachments) {
        const li = el("li");
        li.append(btn(a.filename + " (" + size(a.size || 0) + ")", "link", async () => {
          try {
            const res = await apiFile("/reviews/ticket/attachment?key=" + encodeURIComponent(key) + "&id=" + encodeURIComponent(a.id));
            const url = URL.createObjectURL(await res.blob());
            const link = el("a"); link.href = url; link.download = a.filename; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
          } catch (err) { toast("Attachment can't be opened", [errorText(err)], true); }
        }));
        list.appendChild(li);
      }
      body.append(list);
    }
    body.append(el("h3", "", "Comments (" + ticket.commentsTotal + ")"));
    if (ticket.commentsTotal > ticket.comments.length) body.append(el("p", "review-note", "Showing the latest " + ticket.comments.length + "."));
    for (const c of ticket.comments) {
      const item = el("div", "review-comment");
      item.append(el("b", "", c.author), el("span", "review-when", " " + day(c.created)), el("pre", "review-text", c.body));
      body.append(item);
    }
    if (pr) body.append(el("p", "review-note", "Read-only because you're reviewing " + pr.repo + " #" + pr.number + "."));
    open(key + " — " + ticket.title, body);
  }

  async function openTicket(key) {
    open(key, el("div", "review-body", "Loading…"));
    try {
      drawTicket(key, await api("/reviews/ticket?key=" + encodeURIComponent(key)));
    } catch (err) {
      open(key, el("p", "msg err", errorText(err)));
    }
  }

  async function startReview(item) {
    try {
      await api("/reviews/start?id=" + encodeURIComponent(item.prId) + "&assignment=" + encodeURIComponent(item.id), { method: "POST" });
      renderQueue(queueTarget);
    } catch (err) {
      toast("Couldn't start the review", [errorText(err)], true);
    }
  }

  function card(item) {
    const c = el("article", "review-card review-" + item.status);
    const head = el("div", "review-head-line");
    const title = el("a", "review-title", item.pr ? item.pr.title : "Pull request no longer available");
    if (item.pr) { title.href = item.pr.url; title.target = "_blank"; title.rel = "noopener"; }
    head.append(title, el("span", "review-status " + item.status, reviewLabel(item.status)));
    c.append(head);
    const repo = item.pr ? item.pr.repo + " #" + item.pr.number : item.prId;
    c.append(el("p", "review-meta", repo + " · " + assignedLine(item) + (item.pr && item.pr.author ? " · by " + item.pr.author : "")));
    const gh = githubNote(item.github);
    if (gh.text) c.append(el("p", "review-gh " + gh.tone, gh.text));
    const actions = el("div", "review-actions");
    if (item.status === "needs_review" && !item.startedAt) actions.append(btn("Start review", "btn primary", () => startReview(item)));
    for (const key of ticketKeysOf(item.pr)) actions.append(btn("Read " + key, "btn", () => openTicket(key)));
    if (actions.childElementCount) c.append(actions);
    return c;
  }

  // The reviewer's "Needs review" page.
  async function renderPersonalQueue(target) {
    queueTarget = target;
    target.replaceChildren();
    const list = el("div", "review-list", "Loading…");
    target.append(list);
    try {
      const data = await api("/reviews/me");
      if (data.prError) target.insertBefore(el("p", "msg err", "Pull requests can't be refreshed right now: " + data.prError), list);
      list.replaceChildren();
      if (!data.items.length) { list.append(el("p", "empty-copy", "Nothing needs your review right now.")); return; }
      for (const item of sortQueue(data.items)) list.appendChild(card(item));
    } catch (err) {
      list.replaceChildren(el("p", "msg err", errorText(err)));
    }
  }

  // The sidebar's count for administrators: the tickets waiting, the same number the page's heading shows unfiltered.
  function setQueueBadge(count) {
    const badge = document.getElementById("nav-review-count");
    if (!badge) return;
    badge.textContent = String(count);
    badge.hidden = !count;
  }

  // Reads the queue. A failed read keeps the last answer on screen and says so; it never shows as an empty queue.
  async function loadQueue() {
    try {
      adminData = await api("/reviews/queue");
      adminError = "";
      if (adminData.configured) setQueueBadge(adminData.counts.tickets);
      else setQueueBadge(0);
    } catch (err) {
      adminError = errorText(err);
    }
    drawAdminQueue();
  }

  // The message that explains why the list may be incomplete: GitHub not set up, a sync failure, Jira titles missing.
  function queueNotices(d) {
    const notices = [];
    if (adminError) notices.push(el("p", "msg err", (adminData ? "Refresh failed, showing the last list: " : "The review queue couldn't be loaded: ") + adminError));
    if (d && !d.configured) notices.push(el("p", "msg err", "Pull requests aren't connected, so no reviews can be listed. Ask an administrator to set up GitHub access."));
    if (d && d.syncError) notices.push(el("p", "msg err", "Pull requests couldn't be refreshed, so this list may be out of date. " + d.syncError));
    if (d && d.ticketsError) notices.push(el("p", "msg err", d.ticketsError));
    return notices;
  }

  // Redraws the results from the current data and filters. The search box and the filter menus stay in place.
  function drawAdminQueue() {
    if (!adminRoot || !adminRoot.root.isConnected) return;
    const d = adminData;
    const tickets = d && d.configured ? d.tickets : [];
    const opts = queueOptions(tickets);
    const f = adminFilters;
    const { search, client, repo, reviewer, state } = adminRoot.controls;
    f.client = fillSelect(client, [["", "All projects and clients"], ...opts.clients.map((c) => [c, c])], f.client);
    f.repo = fillSelect(repo, [["", "All repositories"], ...opts.repos.map((r) => [r, r])], f.repo);
    f.reviewer = fillSelect(reviewer, [["", "All reviewers"], [NO_REVIEWER, "No reviewer assigned"], ...opts.reviewers.map((r) => [r, r])], f.reviewer);
    state.value = f.state;
    adminRoot.controls.clear.hidden = !(f.search || f.client || f.repo || f.reviewer || f.state);

    const shown = filterQueue(tickets, f);
    const total = queueCounts(tickets), now = queueCounts(shown);
    const filtered = now.tickets !== total.tickets || now.prs !== total.prs;
    adminRoot.summary.replaceChildren(
      el("span", "queue-count", now.tickets + (now.tickets === 1 ? " ticket" : " tickets")),
      el("span", "queue-count", now.prs + (now.prs === 1 ? " pull request" : " pull requests")),
      el("span", "queue-updated", filtered ? "of " + total.tickets + " tickets and " + total.prs + " pull requests" : d && d.syncedAt ? "Pull requests read " + new Date(d.syncedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "")
    );
    adminRoot.notices.replaceChildren(...queueNotices(d));

    const list = adminRoot.list;
    list.replaceChildren();
    if (!d) { if (!adminError) list.append(el("p", "empty-copy", "Loading…")); return; }
    if (!d.configured) return;
    if (!tickets.length) {
      // With a sync or Jira problem, an empty list doesn't mean nothing needs review: the notices say what failed.
      if (!d.syncError && !d.ticketsError) list.append(el("p", "empty-copy", "Nothing needs review right now."));
      return;
    }
    if (!shown.length) {
      list.append(el("p", "empty-copy", "No pull requests match these filters."), btn("Clear filters", "btn", () => clearFilters()));
      return;
    }
    for (const t of shown) list.appendChild(adminTicketCard(t));
  }

  function clearFilters() {
    Object.assign(adminFilters, { search: "", client: "", repo: "", reviewer: "", state: "" });
    adminRoot.controls.search.value = "";
    drawAdminQueue();
  }

  // One ticket, read-only, with each pull request waiting on it. The wait shown is the longest of its pull requests.
  function adminTicketCard(t) {
    const c = el("article", "review-card queue-ticket");
    const head = el("div", "review-head-line");
    const titleText = el("span", "queue-ticket-title");
    titleText.append(el("b", "queue-key", t.key), el("span", "", " " + (t.title || "Title not available")));
    head.append(titleText);
    const oldest = t.prs.map((pr) => pr.since).sort(longestWaitFirst)[0];
    if (oldest) head.append(el("span", "queue-wait", "Waiting " + waitingFor(oldest)));
    c.append(head);
    const facts = [t.status, "Assignee: " + (t.assignee || "Unassigned"), [t.client, t.subClient].filter(Boolean).join(" › ")].filter(Boolean);
    c.append(el("p", "review-meta", facts.join(" · ")));
    const prs = el("div", "queue-prs");
    for (const pr of t.prs) prs.appendChild(adminPrRow(pr));
    c.append(prs);
    const actions = el("div", "review-actions");
    actions.append(btn("Open ticket", "btn", () => openTicket(t.key)));
    c.append(actions);
    return c;
  }

  function adminPrRow(pr) {
    const row = el("div", "queue-pr");
    const head = el("div", "queue-pr-head");
    const title = el("a", "review-title", pr.title || "Untitled pull request");
    title.href = pr.url; title.target = "_blank"; title.rel = "noopener";
    head.append(title, el("span", "review-status " + pr.state, queueStateLabel(pr)));
    row.append(head);
    row.append(el("p", "review-meta", pr.repo + " #" + pr.number + " · by " + (pr.author || "unknown") + (pr.since ? " · waiting " + waitingFor(pr.since) : "")));
    const names = pr.reviewers.map((r) => r.name);
    row.append(el("p", names.length ? "review-meta" : "review-meta queue-none", names.length ? "Reviewers: " + names.join(", ") : "No reviewer assigned"));
    const reason = queueReasonText(pr);
    if (reason) row.append(el("p", "review-note", reason));
    const open = el("a", "btn", "Open PR");
    open.href = pr.url; open.target = "_blank"; open.rel = "noopener";
    row.append(open);
    return row;
  }

  // Builds the admin page once: the search box and filter menus, then the results, which are redrawn in place.
  function renderAdminQueue(target) {
    queueTarget = target;
    const root = el("div", "queue");
    const bar = el("div", "queue-bar");
    const search = el("input", "queue-search");
    search.type = "search";
    search.placeholder = "Search ticket key, ticket title or PR title";
    search.setAttribute("aria-label", "Search the review queue");
    search.value = adminFilters.search;
    search.addEventListener("input", () => { adminFilters.search = search.value; drawAdminQueue(); });
    const menu = (label, name) => { const s = el("select", "queue-filter"); s.name = name; s.setAttribute("aria-label", label); s.addEventListener("change", () => { adminFilters[name] = s.value; drawAdminQueue(); }); return s; };
    const client = menu("Project or client", "client"), repo = menu("Repository", "repo"), reviewer = menu("Reviewer", "reviewer"), state = menu("Review state", "state");
    state.replaceChildren(...[["", "Any state"], ["awaiting", "Awaiting review"], ["changes_requested", "Changes requested"], ["approved", "Approved"]].map(([v, t]) => { const o = el("option", "", t); o.value = v; return o; }));
    const clear = btn("Clear filters", "linkbtn", () => clearFilters());
    clear.hidden = true;
    bar.append(search, client, repo, reviewer, state, clear);
    const summary = el("div", "queue-summary");
    const notices = el("div", "queue-notices");
    const list = el("div", "review-list");
    root.append(bar, summary, notices, list);
    target.append(root);
    adminRoot = { root, controls: { search, client, repo, reviewer, state, clear }, summary, notices, list };
    drawAdminQueue();
    return loadQueue();
  }

  // The page for the signed-in person: the administrators' queue, or the reviewer's own list.
  function renderQueue(target) {
    return isAdmin() ? renderAdminQueue(target) : renderPersonalQueue(target);
  }

  return { openPicker, openTicket, renderQueue, refreshQueue: loadQueue };
}
