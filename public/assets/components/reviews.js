// Pull request reviews. Administrators choose who reviews a pull request (the picker, opened from the Pull requests
// block). Reviewers get a "Needs review" queue with a read-only view of the tickets the pull request mentions. The
// proxy keeps the assignments (proxy/src/reviews.js); GitHub is asked for the review when the reviewer has a GitHub
// username set by an administrator (Users page). Nothing here changes a Jira ticket.
import { reviewLabel, sortQueue, githubNote, ticketKeysOf, activeReviewerIds, assignedLine, QUEUE_STATE_LABEL, queueStateLabel, queueReasonText, queueOptions, filterQueue, queueCounts, queueSummary, sortTickets, activeFilters, waitingFor, waitLine, exactTime, safePrUrl, reviewerText, noReviewerText, QUICK_FILTERS, SORTS, NO_REVIEWER } from "../models/reviews.js";
import { setNavCount } from "../app/nav.js";

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
  // The administrators' queue: the last answer from the proxy, the last error, whether a read is under way, and what the
  // person chose (filters, sort, folded tickets). These live as long as the page, so a refresh or a dialog keeps them.
  let adminRoot = null, adminData = null, adminError = "", adminLoading = false;
  const adminFilters = { search: "", client: "", repo: "", reviewer: "", state: "", quick: "", sort: "wait" };
  const collapsed = new Set();

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
    setNavCount("reviews", count);
  }

  // Reads the queue. A failed read keeps the last answer on screen and says so; it never shows as an empty queue.
  // force: Refresh and Retry ask the proxy to read GitHub again now. The list stays on screen while it loads.
  async function loadQueue(force = false) {
    adminLoading = true;
    drawBusy();
    try {
      adminData = await api("/reviews/queue" + (force === true ? "?refresh=1" : ""));
      adminError = "";
      if (adminData.configured) setQueueBadge(adminData.counts.tickets);
      else setQueueBadge(0);
    } catch (err) {
      adminError = errorText(err);
    }
    adminLoading = false;
    drawAdminQueue();
  }

  const timeEl = (iso, text) => { const t = el("time", "", text); t.dateTime = iso; t.title = exactTime(iso); return t; };
  const retryBtn = () => btn("Retry", "btn", () => loadQueue(true));

  // Only the busy parts change while the queue loads, so the list, the scroll position and the focus stay put.
  function drawBusy() {
    if (!adminRoot || !adminRoot.root.isConnected) return;
    adminRoot.root.setAttribute("aria-busy", String(adminLoading));
    adminRoot.refresh.disabled = adminLoading;
    adminRoot.refresh.textContent = adminLoading ? "Refreshing…" : "Refresh";
    adminRoot.status.textContent = adminLoading && adminData ? "Refreshing the review queue…" : "";
  }

  // When the pull requests were last read in full, for the page head.
  function updatedLine(d) {
    const line = el("p", "queue-updated");
    if (!d || !d.configured) return line;
    const ok = d.refresh ? d.refresh.okAt : d.syncError ? null : d.syncedAt;
    if (ok) line.append("Last successful update ", timeEl(ok, exactTime(ok)), " (" + waitingFor(ok) + " ago)");
    else line.append("No complete update yet");
    return line;
  }

  // Why the list may be incomplete: the queue couldn't be read, some repositories couldn't be refreshed, GitHub isn't
  // set up, or Jira titles are missing. GitHub's messages are only in the technical details, never in the warning.
  function queueNotices(d) {
    const notices = [];
    if (adminError && !d) {
      const box = el("div", "queue-alert bad");
      box.setAttribute("role", "alert");
      box.append(el("p", "queue-alert-title", "The review queue couldn't be loaded: " + adminError), retryBtn());
      notices.push(box);
    } else if (adminError) {
      const box = el("div", "queue-alert");
      box.setAttribute("role", "status");
      box.append(el("p", "queue-alert-title", "Refresh failed. Showing the last available results."), el("p", "queue-alert-facts", adminError), retryBtn());
      notices.push(box);
    }
    if (d && !d.configured) notices.push(el("p", "msg err", "Pull requests aren't connected, so no reviews can be listed. Ask an administrator to set up GitHub access."));
    const r = d && d.refresh;
    if (d && d.configured && (d.syncError || (r && r.failedRepos))) {
      const box = el("div", "queue-alert");
      box.setAttribute("role", "status");
      box.append(el("p", "queue-alert-title", "Some pull requests could not be refreshed. Showing the last available results."));
      const facts = el("p", "queue-alert-facts");
      const at = r && r.attemptedAt, ok = r && r.okAt;
      facts.append("Last refresh attempt: ", at ? timeEl(at, exactTime(at)) : "unknown", " · Last successful update: ", ok ? timeEl(ok, exactTime(ok)) : "none yet");
      if (r && r.failedRepos) facts.append(" · " + r.failedRepos + " of " + r.repos + (r.repos === 1 ? " repository" : " repositories") + " affected");
      const details = el("details", "queue-diagnostics");
      details.append(el("summary", "", "Technical details"));
      const list = el("ul");
      for (const f of (r && r.failures) || []) list.append(el("li", "", f.repo + " — " + (f.stage === "status" ? "review states" : "pull request list") + ": " + f.error + (f.lastOkAt ? " (last read " + exactTime(f.lastOkAt) + ")" : " (never read)")));
      if (d.syncError && !(r && r.failures && r.failures.length)) list.append(el("li", "", d.syncError));
      details.append(list);
      box.append(facts, retryBtn(), details);
      notices.push(box);
    }
    if (d && d.ticketsError) notices.push(el("p", "msg err", d.ticketsError));
    return notices;
  }

  // The summary strip: distinct pull requests, tickets, and the three things that need someone's attention.
  function drawStats(target, s, filtered) {
    const stat = (n, label, quick) => {
      const box = el("div", "queue-stat" + (quick && n ? " notable" : ""));
      box.append(el("b", "", String(n)), el("span", "", label));
      return box;
    };
    target.replaceChildren(
      stat(s.prs, s.prs === 1 ? "open pull request" : "open pull requests"),
      stat(s.tickets, s.tickets === 1 ? "linked ticket" : "linked tickets"),
      stat(s.noReviewer, "no reviewer", true),
      stat(s.changes, "changes requested", true),
      stat(s.unavailable, "review data unavailable", true),
      el("p", "queue-stats-scope", filtered ? "Counts for the filtered list" : "All pull requests in the queue")
    );
  }

  // Redraws the results from the current data and filters. The search box and the filter menus stay in place.
  function drawAdminQueue() {
    if (!adminRoot || !adminRoot.root.isConnected) return;
    drawBusy();
    const d = adminData;
    const tickets = d && d.configured ? d.tickets : [];
    const opts = queueOptions(tickets);
    const f = adminFilters;
    const { client, repo, reviewer, state, sort, quick } = adminRoot.controls;
    f.client = fillSelect(client, [["", "All projects"], ...opts.clients.map((c) => [c, c])], f.client);
    f.repo = fillSelect(repo, [["", "All repositories"], ...opts.repos.map((r) => [r, r])], f.repo);
    f.reviewer = fillSelect(reviewer, [["", "All reviewers"], [NO_REVIEWER, "No reviewer requested"], ...opts.reviewers.map((r) => [r, r])], f.reviewer);
    state.value = f.state;
    sort.value = f.sort;
    for (const b of quick) b.setAttribute("aria-pressed", String(b.dataset.quick === f.quick));

    const updated = updatedLine(d);
    adminRoot.updated.replaceWith(updated);
    adminRoot.updated = updated;
    adminRoot.notices.replaceChildren(...queueNotices(d));
    const shown = sortTickets(filterQueue(tickets, f), f.sort);
    const active = activeFilters(f);
    const all = queueCounts(tickets), now = queueCounts(shown);
    drawStats(adminRoot.stats, queueSummary(shown), active.length > 0);
    adminRoot.stats.hidden = !d || !d.configured;

    const chips = adminRoot.active;
    chips.replaceChildren();
    const plural = (n, one, many) => n + " " + (n === 1 ? one : many);
    const shownText = "Showing " + plural(now.tickets, "ticket", "tickets") + " · " + plural(now.prs, "pull request", "pull requests");
    chips.append(el("span", "queue-showing", active.length ? shownText + " of " + all.tickets + " · " + all.prs : shownText));
    for (const a of active) {
      const chip = btn(a.text + " ×", "queue-chip", () => { f[a.name] = ""; if (a.name === "search") adminRoot.controls.search.value = ""; drawAdminQueue(); adminRoot.controls.search.focus(); });
      chip.setAttribute("aria-label", "Remove filter " + a.text);
      chips.append(chip);
    }
    if (active.length) chips.append(btn("Clear filters", "linkbtn", () => clearFilters()));
    chips.hidden = !d || !d.configured || !tickets.length;

    const list = adminRoot.list;
    list.replaceChildren();
    if (!d) { if (!adminError) list.append(el("p", "empty-copy", "Loading the review queue…")); return; }
    if (!d.configured) return;
    if (!tickets.length) {
      // With a sync or Jira problem, an empty list doesn't mean nothing needs review: the notices say what failed.
      list.append(el("p", "empty-copy", d.syncError || d.ticketsError ? "No pull requests to show. Some data couldn't be read, see above." : "Nothing needs review right now."));
      return;
    }
    if (!shown.length) {
      list.append(el("p", "empty-copy", "No pull requests match these filters."), btn("Clear filters", "btn", () => clearFilters()));
      return;
    }
    const head = el("div", "queue-cols");
    head.setAttribute("aria-hidden", "true");
    head.append(el("span", "", "Pull request"), el("span", "", "Review state"), el("span", "", "Reviewers"), el("span", "", "Time"), el("span", "", ""));
    list.append(head);
    for (const t of shown) list.appendChild(adminTicket(t));
  }

  function clearFilters() {
    Object.assign(adminFilters, { search: "", client: "", repo: "", reviewer: "", state: "", quick: "" });
    adminRoot.controls.search.value = "";
    drawAdminQueue();
    adminRoot.controls.search.focus();
  }

  // One ticket: its key, title and status (the ticket's, not the pull request's), who works on it, then each pull request
  // waiting on it. The pull requests fold away; the fold is remembered while the page is open.
  function adminTicket(t) {
    const c = el("section", "queue-ticket" + (t.ticketDone ? " done" : ""));
    const listId = "queue-prs-" + t.key.replace(/[^\w-]/g, "_");
    const open = !collapsed.has(t.key);
    const head = el("div", "queue-ticket-head");
    const toggle = el("button", "queue-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-controls", listId);
    toggle.setAttribute("aria-label", "Pull requests for " + t.key);
    toggle.append(el("span", "queue-caret"));
    const main = el("div", "queue-ticket-main");
    const title = el("h2", "queue-ticket-title");
    title.append(el("span", "queue-key", t.key), el("span", "", t.title && t.title !== t.key ? t.title : "Title not available"));
    const meta = el("p", "queue-ticket-meta");
    const part = (cls, text) => meta.append(el("span", cls, text));
    part("ticket-status" + (t.ticketDone ? " done" : ""), "Ticket: " + (t.status || "status unknown"));
    if (t.ticketDone) part("queue-closed-note", "Ticket closed · PR still open");
    part(t.client ? "" : "queue-missing", t.client ? [t.client, t.subClient].filter(Boolean).join(" › ") : "No project mapped");
    part("", "Assignee: " + (t.assignee || "Unassigned"));
    if (t.devs && t.devs.length) part("", (t.devs.length === 1 ? "Developer: " : "Developers: ") + t.devs.join(", "));
    part("queue-pr-count", t.prs.length + (t.prs.length === 1 ? " PR" : " PRs"));
    main.append(title, meta);
    const openTicketBtn = btn("Open ticket", "btn", () => openTicket(t.key));
    openTicketBtn.setAttribute("aria-label", "Open ticket " + t.key + " (read-only)");
    head.append(toggle, main, openTicketBtn);
    const prs = el("ul", "queue-prs");
    prs.id = listId;
    prs.hidden = !open;
    for (const pr of t.prs) prs.appendChild(adminPrRow(pr));
    toggle.addEventListener("click", () => {
      const next = prs.hidden;
      prs.hidden = !next;
      toggle.setAttribute("aria-expanded", String(next));
      if (next) collapsed.delete(t.key); else collapsed.add(t.key);
    });
    c.append(head, prs);
    return c;
  }

  // The reviewers shown in the row; more than this fold into "+N more".
  const SHOWN_REVIEWERS = 3;

  function adminPrRow(pr) {
    const row = el("li", "queue-pr");
    const who = el("div", "queue-cell queue-pr-main");
    who.append(el("span", "queue-pr-title", pr.title || "Untitled pull request"));
    const ref = el("span", "queue-pr-ref");
    ref.append(el("span", "queue-repo", pr.repo + "#" + pr.number), " · by " + (pr.author || "unknown"));
    who.append(ref);

    const st = el("div", "queue-cell queue-state");
    st.append(el("span", "review-status " + (QUEUE_STATE_LABEL[pr.state] ? pr.state : "unknown"), queueStateLabel(pr)));
    const reason = queueReasonText(pr);
    if (reason) st.append(el("span", "queue-reason", reason));
    if (pr.stale) {
      const tag = el("span", "queue-stale", "Last known");
      tag.title = "This repository couldn't be refreshed" + (pr.statusAt ? "; review data read " + exactTime(pr.statusAt) : "");
      st.append(tag);
    }

    const rv = el("div", "queue-cell queue-reviewers");
    const names = pr.reviewers.map(reviewerText);
    if (!names.length) rv.append(el("span", "queue-none", noReviewerText(pr)));
    else {
      rv.append(el("span", "", names.slice(0, SHOWN_REVIEWERS).join(", ")));
      if (names.length > SHOWN_REVIEWERS) {
        const more = el("details", "queue-more");
        more.append(el("summary", "", "+" + (names.length - SHOWN_REVIEWERS) + " more"));
        const ul = el("ul");
        for (const n of names.slice(SHOWN_REVIEWERS)) ul.append(el("li", "", n));
        more.append(ul);
        rv.append(more);
      }
      if (pr.reviewerState === "unavailable") rv.append(el("span", "queue-reason", "Review progress unavailable"));
    }

    const w = waitLine(pr);
    const wait = el("div", "queue-cell queue-wait" + (w.long ? " long" : ""));
    wait.append(el("span", "queue-wait-label", w.label));
    if (w.at) wait.append(timeEl(w.at, w.text));

    const act = el("div", "queue-cell queue-pr-actions");
    const href = safePrUrl(pr.url);
    if (href) {
      const link = el("a", "btn", "Open PR ↗");
      link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", "Open pull request " + pr.repo + "#" + pr.number + " on GitHub (opens in a new tab)");
      act.append(link);
    } else act.append(el("span", "queue-none", "Link unavailable"));

    row.append(who, st, rv, wait, act);
    return row;
  }

  // Builds the admin page once: the head, the summary, the search box and filter menus, then the results, which are
  // redrawn in place. A dashboard render keeps it (data-keep), so filters, folds and scroll stay as they are.
  function renderAdminQueue(target) {
    queueTarget = target;
    const root = el("div", "queue");
    root.dataset.keep = "reviews";
    const head = el("div", "queue-head");
    const updated = el("p", "queue-updated");
    const status = el("span", "queue-status");
    status.setAttribute("role", "status");
    const refresh = btn("Refresh", "btn", () => loadQueue(true));
    refresh.setAttribute("aria-label", "Refresh the review queue from GitHub");
    head.append(updated, status, refresh);

    const stats = el("div", "queue-stats");
    stats.setAttribute("role", "group");
    stats.setAttribute("aria-label", "Summary");

    const bar = el("div", "queue-bar");
    bar.setAttribute("role", "search");
    const search = el("input", "queue-search");
    search.type = "search";
    search.placeholder = "Search ticket, PR title or repository";
    search.setAttribute("aria-label", "Search the review queue");
    search.value = adminFilters.search;
    search.addEventListener("input", () => { adminFilters.search = search.value; drawAdminQueue(); });
    const menu = (label, name) => { const s = el("select", "queue-filter"); s.name = name; s.setAttribute("aria-label", label); s.addEventListener("change", () => { adminFilters[name] = s.value; drawAdminQueue(); }); return s; };
    const client = menu("Project", "client"), repo = menu("Repository", "repo"), reviewer = menu("Reviewer", "reviewer"), state = menu("Review state", "state"), sort = menu("Sort", "sort");
    state.replaceChildren(...[["", "Any review state"], ...Object.entries(QUEUE_STATE_LABEL).filter(([v]) => v !== "draft")].map(([v, t]) => { const o = el("option", "", t); o.value = v; return o; }));
    sort.replaceChildren(...SORTS.map(([v, t]) => { const o = el("option", "", t); o.value = v; return o; }));
    bar.append(search, client, repo, reviewer, state, sort);

    const quickBar = el("div", "queue-quick");
    quickBar.setAttribute("role", "group");
    quickBar.setAttribute("aria-label", "Quick filters");
    const quick = QUICK_FILTERS.map(([v, t]) => {
      const b = btn(t, "queue-chip", () => { adminFilters.quick = v; drawAdminQueue(); });
      b.dataset.quick = v;
      return b;
    });
    quickBar.append(...quick);
    const active = el("div", "queue-active");
    const notices = el("div", "queue-notices");
    const list = el("div", "queue-list");
    root.append(head, notices, stats, bar, quickBar, active, list);
    target.append(root);
    adminRoot = { root, controls: { search, client, repo, reviewer, state, sort, quick }, updated, status, refresh, stats, active, notices, list };
    drawAdminQueue();
    return loadQueue();
  }

  // The page for the signed-in person: the administrators' queue, or the reviewer's own list.
  function renderQueue(target) {
    return isAdmin() ? renderAdminQueue(target) : renderPersonalQueue(target);
  }

  return { openPicker, openTicket, renderQueue, refreshQueue: loadQueue };
}
