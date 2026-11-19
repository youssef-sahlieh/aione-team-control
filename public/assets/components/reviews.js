// Pull request reviews. Administrators choose who reviews a pull request (the picker, opened from the Pull requests
// block). Reviewers get a "Needs review" queue with a read-only view of the tickets the pull request mentions. The
// proxy keeps the assignments (proxy/src/reviews.js); GitHub is asked for the review when the reviewer has a GitHub
// username set by an administrator (Users page). Nothing here changes a Jira ticket.
import { reviewLabel, sortQueue, githubNote, ticketKeysOf, activeReviewerIds, assignedLine, QUEUE_STATE_LABEL, queueStateLabel, queueReasonText, queueOptions, filterQueue, queueSummary, sortPrs, groupByTicket, activeFilters, menuFilterCount, attentionReasons, CHECKS_LABEL, waitLine, exactTime, safePrUrl, reviewerText, noReviewerText, QUICK_FILTERS, DEFAULT_QUICK, SORTS, VIEWS, NO_REVIEWER, DEFAULT_SORT, REVIEWER_RELATIONS } from "../models/reviews.js";
import { setNavCount } from "../app/nav.js";

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const btn = (text, cls, action) => { const b = el("button", cls, text); b.type = "button"; b.addEventListener("click", action); return b; };
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const stamp = (iso) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
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
  // person chose (filters, sort, view). These live as long as the page, so a refresh or a dialog keeps them.
  let adminRoot = null, adminData = null, adminError = "", adminLoading = false;
  const adminFilters = { search: "", client: "", repo: "", author: "", reviewer: "", relation: "any", state: "", quick: DEFAULT_QUICK, sort: savedSort(), view: "prs" };
  // The sort is remembered on this device; a browser that refuses storage just starts from the default.
  function savedSort() {
    try { const v = localStorage.getItem("aione-review-sort"); return SORTS.some(([k]) => k === v) ? v : DEFAULT_SORT; } catch { return DEFAULT_SORT; }
  }
  function saveSort(v) {
    try { localStorage.setItem("aione-review-sort", v); } catch { /* not kept: the choice lasts this page only */ }
  }
  const collapsed = new Set();   // By ticket: the folded ticket groups
  const expanded = new Set();    // List: the pull requests whose details are open
  // The filter menu closes on a click outside it (set by renderAdminQueue).
  let closeFilters = null;
  document.addEventListener("click", (e) => { if (closeFilters) closeFilters(e.target); });

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

  // Administrators: GitHub's review requests on one pull request, changed here and nowhere else. The server decides who
  // may be asked (GitHub's own list); the page only offers those people. A change is shown and confirmed before it is sent.
  async function openGithubReviewers(pr) {
    const title = "GitHub reviewers: " + pr.repo + " #" + pr.number;
    open(title, el("div", "review-body", "Loading from GitHub…"));
    try {
      drawGithubReviewers(pr, await api("/reviews/github-reviewers?id=" + encodeURIComponent(pr.id)));
    } catch (err) {
      open(title, el("p", "msg err", errorText(err)));
    }
  }

  function drawGithubReviewers(pr, data, notice = "") {
    const body = el("div", "review-body");
    body.append(el("p", "review-note", "Requesting a reviewer whose GitHub username is saved on the Users page also adds this pull request to their Needs review list, even if GitHub cannot update. Removing a GitHub request keeps their dashboard assignment until the pull request closes. You confirm each change before it is sent to GitHub."));
    if (!data.canManage) body.append(el("p", "msg", "This pull request is closed or merged, so its reviewers can't change."));
    if (notice) body.append(el("p", "msg", notice));
    const requested = data.requested || [];
    const requestedLower = new Set(requested.map((u) => u.login.toLowerCase()));
    const asked = (data.eligible || []).filter((u) => !requestedLower.has(u.login.toLowerCase()));
    const form = el("form", "review-picker");
    if (requested.length) {
      form.append(el("h3", "", "Requested now (tick to remove)"));
      const list = el("div", "review-people");
      for (const u of requested) list.append(checkRow("remove", u.login, u.login + " · review requested"));
      form.append(list);
    } else form.append(el("p", "review-note", "No review is requested from GitHub on this pull request."));
    form.append(el("h3", "", "Ask for a review (tick to request)"));
    const pick = el("div", "review-people");
    if (asked.length) for (const u of asked) pick.append(checkRow("add", u.login, u.login));
    else pick.append(el("p", "review-note", "Nobody else is available. GitHub lists only people with access to this repository, and the author can't review their own pull request."));
    form.append(pick);
    const msg = el("p", "msg");
    const save = btn("Review changes…", "btn primary", () => {});
    save.type = "submit";
    save.disabled = !data.canManage;
    const actions = el("div", "review-actions");
    actions.append(save);
    form.append(actions, msg);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const add = [...form.querySelectorAll('input[name="add"]:checked')].map((b) => b.value);
      const remove = [...form.querySelectorAll('input[name="remove"]:checked')].map((b) => b.value);
      if (!add.length && !remove.length) { msg.textContent = "Tick someone to request or remove."; msg.className = "msg err"; return; }
      confirmChanges(pr, data, add, remove);
    });
    body.append(form);
    open("GitHub reviewers: " + pr.repo + " #" + pr.number, body);
  }

  function checkRow(name, value, text) {
    const label = el("label", "review-person");
    const box = el("input");
    box.type = "checkbox"; box.name = name; box.value = value;
    label.append(box, el("span", "", text));
    return label;
  }

  // The second step: what will be sent to GitHub, and the only button that sends it.
  function confirmChanges(pr, data, add, remove) {
    const body = el("div", "review-body");
    body.append(el("p", "review-note", "Confirm the change on GitHub for " + pr.repo + " #" + pr.number + ":"));
    const list = el("ul", "review-confirm");
    if (add.length) list.append(el("li", "", "Ask for a review: " + add.join(", ")));
    if (remove.length) list.append(el("li", "", "Remove the review request: " + remove.join(", ")));
    body.append(list);
    const msg = el("p", "msg");
    const confirm = btn("Confirm on GitHub", "btn primary", async () => {
      confirm.disabled = true; back.disabled = true; msg.textContent = "Sending to GitHub…";
      try {
        const res = await api("/reviews/github-reviewers?id=" + encodeURIComponent(pr.id), { method: "POST", body: { confirmed: true, add, remove } });
        toast("GitHub reviewers updated", [pr.repo + " #" + pr.number], false);
        loadQueue(true);
        drawGithubReviewers(pr, { ...data, requested: res.requested }, "Saved. The list below is what GitHub now shows." + (res.dashboardAssigned?.length ? " Matching dashboard users can also see it in Needs review." : ""));
      } catch (err) {
        msg.textContent = errorText(err); msg.className = "msg err"; confirm.disabled = false; back.disabled = false;
      }
    });
    const back = btn("Back", "btn", () => drawGithubReviewers(pr, data));
    const actions = el("div", "review-actions");
    actions.append(back, confirm);
    body.append(actions, msg);
    open("Confirm GitHub reviewers: " + pr.repo + " #" + pr.number, body);
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
    if (item.rami) c.append(el("span", "queue-rami-tag", "Flagged for Rami"));
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

  // A pull request flagged for Rami: open it on GitHub to check and comment there. Not a review request.
  function flaggedCard(pr) {
    const c = el("article", "review-card review-flagged");
    const head = el("div", "review-head-line");
    const url = safePrUrl(pr.url);
    const title = el(url ? "a" : "span", "review-title", pr.title || pr.repo + " #" + pr.number);
    if (url) { title.href = url; title.target = "_blank"; title.rel = "noopener"; }
    head.append(title);
    if (pr.draft) head.append(el("span", "review-status", "Draft"));
    c.append(head, el("p", "review-meta", pr.repo + " #" + pr.number + (pr.author ? " · by " + pr.author : "") + (pr.tickets.length ? "" : " · No linked ticket")));
    const actions = el("div", "review-actions");
    if (url) { const a = el("a", "btn primary", "Open on GitHub to comment"); a.href = url; a.target = "_blank"; a.rel = "noopener"; actions.append(a); }
    for (const t of pr.tickets) actions.append(btn("Read " + t.key, "btn", () => openTicket(t.key)));
    c.append(actions, notesPanel(pr));
    return c;
  }

  // Internal notes on a flagged pull request. Loaded when opened; saved here only, never sent to GitHub.
  function notesPanel(pr) {
    const box = el("details", "review-notes");
    const summary = el("summary", "", "Notes (" + (pr.notes || 0) + ")");
    const list = el("div", "review-notes-list");
    const form = el("form", "review-note-form");
    const text = el("textarea", "");
    text.rows = 2; text.maxLength = 2000; text.setAttribute("aria-label", "Internal note on " + pr.repo + " #" + pr.number);
    const send = el("button", "btn primary", "Add note"); send.type = "submit";
    const msg = el("p", "msg err");
    msg.setAttribute("role", "alert");
    form.append(text, send, msg);
    box.append(summary, list, form);
    let notes = null;
    const show = () => {
      summary.textContent = "Notes (" + notes.length + ")";
      list.replaceChildren();
      if (!notes.length) list.append(el("p", "empty-copy", "No notes yet."));
      for (const n of notes) {
        const row = el("div", "review-note");
        row.append(el("p", "review-note-meta", (n.author?.name || "Someone") + " · " + exactTime(n.at)), el("p", "review-note-body", n.body));
        list.append(row);
      }
    };
    box.addEventListener("toggle", async () => {
      if (!box.open || notes) return;
      list.textContent = "Loading…";
      try { notes = (await api("/reviews/notes?id=" + encodeURIComponent(pr.id))).notes; show(); }
      catch (err) { list.replaceChildren(el("p", "msg err", errorText(err))); }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = text.value.trim();
      if (!body || !notes) return;
      send.disabled = true; msg.textContent = "";
      try {
        const saved = (await api("/reviews/notes?id=" + encodeURIComponent(pr.id), { method: "POST", body: { body } })).note;
        notes = [...notes, saved]; text.value = ""; show();
      } catch (err) { msg.textContent = "Couldn't save the note: " + errorText(err); }
      finally { send.disabled = false; }
    });
    return box;
  }

  // The reviewer's "Needs review" page. Rami also gets the pull requests flagged for him, above his reviews.
  async function renderPersonalQueue(target) {
    queueTarget = target;
    target.replaceChildren();
    const list = el("div", "review-list", "Loading…");
    target.append(list);
    try {
      const data = await api("/reviews/me");
      if (data.prError) target.insertBefore(el("p", "msg err", "Pull requests can't be refreshed right now: " + data.prError), list);
      if (Array.isArray(data.flagged)) {
        const section = el("section", "review-flagged-list");
        section.append(el("h2", "", "Flagged for you to check (" + data.flagged.length + ")"), el("p", "review-note", "An administrator flagged these pull requests for you to check. Comment on GitHub. This isn't a review request."));
        if (data.ticketsError) section.append(el("p", "msg err", data.ticketsError));
        if (!data.flagged.length) section.append(el("p", "empty-copy", "Nothing is flagged for you right now."));
        for (const pr of data.flagged) section.append(flaggedCard(pr));
        target.insertBefore(section, list);
        list.before(el("h2", "review-list-heading", "Your reviews"));
      }
      list.replaceChildren();
      if (!data.items.length) { list.append(el("p", "empty-copy", "Nothing needs your review right now.")); return; }
      for (const item of sortQueue(data.items)) list.appendChild(card(item));
    } catch (err) {
      list.replaceChildren(el("p", "msg err", errorText(err)));
    }
  }

  // The sidebar's count for administrators: the pull requests awaiting review.
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
      setQueueBadge(adminData.configured ? adminData.counts.awaiting : 0);
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
    adminRoot.status.textContent = adminLoading && adminData ? "Refreshing…" : "";
  }

  // The compact sync indicator in the page head: when the pull requests were last read in full. The exact time is its tooltip.
  function updatedLine(d) {
    const line = el("p", "queue-updated");
    if (!d || !d.configured) return line;
    const ok = d.refresh ? d.refresh.okAt : d.syncError ? null : d.syncedAt;
    if (ok) line.append(el("span", "queue-dot"), "Synced ", timeEl(ok, stamp(ok)));
    else line.append(el("span", "queue-dot warn"), "Not synced yet");
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

  // The four summary cards. Each one is a button that sets the matching quick filter; the cards always count every
  // open pull request (the filters don't change them).
  const CARDS = [["Awaiting review", "awaiting", true], ["Changes requested", "changes", true], ["Approved", "approved", false], ["Drafts", "drafts", false]];
  function drawStats(target, s, quick) {
    const count = { "Awaiting review": s.awaiting, "Changes requested": s.changes, "Approved": s.approved, "Drafts": s.drafts };
    target.replaceChildren(...CARDS.map(([label, value, notable]) => {
      const b = el("button", "queue-stat" + (notable && count[label] ? " notable" : ""));
      b.type = "button";
      b.dataset.stat = label;
      b.setAttribute("aria-pressed", String(quick === value));
      b.append(el("b", "", String(count[label])), el("span", "", label));
      b.addEventListener("click", () => { adminFilters.quick = value; adminFilters.state = ""; drawAdminQueue(); });
      return b;
    }));
  }

  // Redraws the results from the current data and filters. The search box and the filter menu stay in place.
  function drawAdminQueue() {
    if (!adminRoot || !adminRoot.root.isConnected) return;
    drawBusy();
    const d = adminData;
    const prs = d && d.configured ? d.prs : [];
    const opts = queueOptions(prs);
    const f = adminFilters;
    const { client, repo, author, reviewer, relation, state, sort, quick, views, filterBtn, filterBadge } = adminRoot.controls;
    f.client = fillSelect(client, [["", "All projects"], ...opts.clients.map((c) => [c, c])], f.client);
    f.repo = fillSelect(repo, [["", "All repositories"], ...opts.repos.map((r) => [r, r])], f.repo);
    f.author = fillSelect(author, [["", "Anyone"], ...opts.authors.map((a) => [a, a])], f.author);
    f.reviewer = fillSelect(reviewer, [["", "All reviewers"], [NO_REVIEWER, "No reviewer requested"], ...opts.reviewers.map((r) => [r, r])], f.reviewer);
    // The relationship only applies to a named reviewer, so the menu is off until one is chosen.
    relation.value = f.relation;
    relation.disabled = !f.reviewer || f.reviewer === NO_REVIEWER;
    state.value = f.state;
    sort.value = f.sort;
    const sum = queueSummary(prs);
    const tabCount = { awaiting: sum.awaiting, approved: sum.approved, drafts: sum.drafts, changes: sum.changes, "": sum.prs, attention: sum.attention, unlinked: sum.unlinked, rami: sum.rami };
    const live = !!(d && d.configured);
    for (const b of quick) {
      b.setAttribute("aria-pressed", String(b.dataset.quick === f.quick));
      b.querySelector(".queue-count").textContent = live ? String(tabCount[b.dataset.quick] ?? 0) : "";
    }
    for (const b of views) b.setAttribute("aria-pressed", String(b.dataset.view === f.view));
    const menus = menuFilterCount(f);
    filterBadge.textContent = menus ? String(menus) : "";
    filterBadge.hidden = !menus;

    const updated = updatedLine(d);
    adminRoot.updated.replaceWith(updated);
    adminRoot.updated = updated;
    adminRoot.notices.replaceChildren(...queueNotices(d));
    const shown = sortPrs(filterQueue(prs, f), f.sort);
    const active = activeFilters(f);
    drawStats(adminRoot.stats, sum, f.quick);
    adminRoot.stats.hidden = !live;

    const chips = adminRoot.active;
    chips.replaceChildren();
    const plural = (n) => n + (n === 1 ? " pull request" : " pull requests");
    chips.append(el("span", "queue-showing", active.length ? "Showing " + shown.length + " of " + plural(prs.length) : "Showing " + plural(shown.length)));
    for (const a of active) {
      const chip = btn(a.text + " ×", "queue-chip", () => { f[a.name] = ""; if (a.name === "reviewer") f.relation = "any"; if (a.name === "search") adminRoot.controls.search.value = ""; drawAdminQueue(); adminRoot.controls.search.focus(); });
      chip.setAttribute("aria-label", "Remove filter " + a.text);
      chips.append(chip);
    }
    if (active.length) chips.append(btn("Clear all", "linkbtn", () => clearFilters()));
    chips.hidden = !d || !d.configured || !prs.length;

    const list = adminRoot.list;
    list.replaceChildren();
    if (!d) { if (!adminError) list.append(el("p", "empty-copy", "Loading pull requests…")); return; }
    if (!d.configured) return;
    if (!prs.length) {
      // With a sync or Jira problem, an empty list doesn't mean there are no pull requests: the notices say what failed.
      list.append(el("p", "empty-copy", d.syncError || d.ticketsError ? "No pull requests to show. Some data couldn't be read, see above." : "No open pull requests right now."));
      return;
    }
    if (!shown.length) {
      list.append(el("p", "empty-copy", "No pull requests match these filters."), btn("Clear filters", "btn", () => clearFilters()));
      return;
    }
    if (f.view === "tickets") for (const g of groupByTicket(shown)) list.appendChild(adminTicket(g));
    else {
      const box = el("section", "queue-ticket queue-flat");
      box.setAttribute("aria-label", "Open pull requests");
      const ul = el("ul", "queue-prs");
      for (const pr of shown) ul.appendChild(adminPrRow(pr));
      box.append(ul);
      list.append(box);
    }
  }

  function clearFilters() {
    Object.assign(adminFilters, { search: "", client: "", repo: "", author: "", reviewer: "", relation: "any", state: "", quick: "" });
    adminRoot.controls.search.value = "";
    drawAdminQueue();
    adminRoot.controls.search.focus();
  }

  // "By ticket" view: one ticket, its key, title and status (the ticket's, not the pull request's), who works on it,
  // then each pull request on it. The unlinked pull requests come last in a group of their own (key ""). The pull
  // requests fold away; the fold is remembered while the page is open.
  function adminTicket(t) {
    const unlinked = !t.key, foldKey = t.key || "__unlinked";
    const c = el("section", "queue-ticket" + (t.done ? " done" : ""));
    const listId = "queue-prs-" + foldKey.replace(/[^\w-]/g, "_");
    const open = !collapsed.has(foldKey);
    const head = el("div", "queue-ticket-head");
    const toggle = el("button", "queue-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-controls", listId);
    toggle.setAttribute("aria-label", unlinked ? "Unlinked pull requests" : "Pull requests for " + t.key);
    toggle.append(el("span", "queue-caret"));
    const main = el("div", "queue-ticket-main");
    const title = el("h2", "queue-ticket-title");
    const meta = el("p", "queue-ticket-meta");
    const part = (cls, text) => meta.append(el("span", cls, text));
    if (unlinked) {
      title.append(el("span", "queue-unlinked", "Unlinked"), el("span", "", "Pull requests that name no ticket"));
    } else {
      title.append(el("span", "queue-key", t.key), el("span", "", t.title && t.title !== t.key ? t.title : "Title not available"));
      part("ticket-status" + (t.done ? " done" : ""), "Ticket: " + (t.status || "status unknown"));
      if (t.done) part("queue-closed-note", "Ticket closed · PR still open");
      part(t.client ? "" : "queue-missing", t.client ? [t.client, t.subClient].filter(Boolean).join(" › ") : "No project mapped");
      part("", "Assignee: " + (t.assignee || "Unassigned"));
      if (t.devs && t.devs.length) part("", (t.devs.length === 1 ? "Developer: " : "Developers: ") + t.devs.join(", "));
    }
    part("queue-pr-count", t.prs.length + (t.prs.length === 1 ? " PR" : " PRs"));
    main.append(title, meta);
    head.append(toggle, main);
    if (!unlinked) {
      const openTicketBtn = btn("Open ticket", "btn", () => openTicket(t.key));
      openTicketBtn.setAttribute("aria-label", "Open ticket " + t.key + " (read-only)");
      head.append(openTicketBtn);
    }
    const prs = el("ul", "queue-prs");
    prs.id = listId;
    prs.hidden = !open;
    for (const pr of t.prs) prs.appendChild(adminPrRow(pr));
    toggle.addEventListener("click", () => {
      const next = prs.hidden;
      prs.hidden = !next;
      toggle.setAttribute("aria-expanded", String(next));
      if (next) collapsed.delete(foldKey); else collapsed.add(foldKey);
    });
    c.append(head, prs);
    return c;
  }

  // Saves the Rami reference flag. It only marks the pull request: nothing is sent to GitHub and nobody is notified.
  // The box is locked while saving and goes back if the save fails.
  async function setRami(pr, box) {
    const flagged = box.checked;
    box.disabled = true;
    try {
      await api("/reviews/rami?id=" + encodeURIComponent(pr.id), { method: "PUT", body: { flagged } });
      for (const p of adminData.prs) if (p.id === pr.id) p.rami = flagged;
      drawAdminQueue();
      const again = adminRoot.list.querySelector('input[data-rami="' + CSS.escape(pr.id) + '"]');
      if (again) again.focus();
    } catch (err) {
      box.checked = !flagged;
      box.disabled = false;
      toast("Couldn't save the Rami flag", [errorText(err)], true);
    }
  }

  // The reviewers shown in the row; more than this fold into "+N more".
  const SHOWN_REVIEWERS = 3;

  // The details of one pull request, shown when its row is expanded. Only what the proxy knows is shown: a description
  // that hasn't been read yet says so, and checks GitHub couldn't be asked about are "not available", never passing.
  function detailBody(pr) {
    const grid = el("div", "queue-detail-grid");
    const desc = el("section", "queue-detail-desc");
    desc.append(el("h3", "", "Description"));
    if (typeof pr.description !== "string") desc.append(el("p", "queue-detail-empty", "Not read yet. The description appears after the next refresh."));
    else if (!pr.description.trim()) desc.append(el("p", "queue-detail-empty", "No description."));
    else desc.append(el("pre", "queue-desc", pr.description));

    const facts = el("dl", "queue-facts");
    const fact = (k, ...nodes) => { facts.append(el("dt", "", k)); const dd = el("dd"); dd.append(...nodes); facts.append(dd); };
    if (pr.tickets && pr.tickets.length) {
      fact("Linked tickets", ...pr.tickets.map((t) => {
        const b = btn(t.key, "queue-ticket-link", () => openTicket(t.key));
        b.title = (t.title || t.key) + (t.status ? " · " + t.status : "") + " (opens read-only)";
        b.setAttribute("aria-label", "Open ticket " + t.key + " (read-only)");
        return b;
      }));
    } else fact("Linked tickets", el("span", "queue-none", "None. Name a ticket (for example AION-12 or INT-5) in the title, description or branch to link it."));
    const reason = queueReasonText(pr);
    fact("Review state", el("span", "", queueStateLabel(pr) + (reason ? " · " + reason : "")));
    const names = pr.reviewers.map(reviewerText);
    fact("Reviewers", el("span", "", names.length ? names.join(", ") : noReviewerText(pr)));
    if (pr.unresolved != null) fact("Review comments", el("span", "", (pr.unresolved ? pr.unresolved + " unresolved" : "None unresolved") + (pr.comments != null ? " · " + pr.comments + " in all" : "")));
    const checks = (pr.checks && pr.checks.state) || "unavailable";
    let checkText = CHECKS_LABEL[checks] || CHECKS_LABEL.unavailable;
    if (checks === "failure" && pr.checks.failed && pr.checks.failed.length) checkText += ": " + pr.checks.failed.join(", ");
    if (checks === "pending" && pr.checks.running) checkText += " (" + pr.checks.running + " running)";
    if (checks === "unavailable") checkText += ". The GitHub token needs read access to Checks and Commit statuses.";
    fact("Checks", el("span", "queue-check " + checks, checkText));
    fact("Branch", el("code", "", pr.branch ? pr.branch + (pr.base ? " → " + pr.base : "") : "—"));
    fact("Created", el("span", "", day(pr.created)));
    fact("Updated", el("span", "", day(pr.updated)));
    const w = waitLine(pr);
    fact(w.label, w.at ? timeEl(w.at, w.text) : el("span", "", w.text || "—"));
    grid.append(desc, facts);
    return grid;
  }

  function adminPrRow(pr) {
    const linked = pr.tickets && pr.tickets.length > 0;
    const reasons = attentionReasons(pr);
    const isOpen = expanded.has(pr.id);
    const detailId = "pr-detail-" + pr.id.replace(/[^\w-]/g, "_");
    const row = el("li", "queue-pr " + (linked ? "linked" : "unlinked") + (pr.draft ? " draft" : "") + (reasons.length ? " attention" : "") + " state-" + (QUEUE_STATE_LABEL[pr.state] ? pr.state : "unknown") + (isOpen ? " is-open" : ""));
    row.dataset.pr = pr.id;

    // Primary: the title, the repository and number, the author, the tickets, and why it needs attention.
    const main = el("div", "queue-cell queue-pr-main");
    const title = el("span", "queue-pr-title", pr.title || "Untitled pull request");
    title.dir = "auto";
    if (pr.draft) title.prepend(el("span", "queue-draft", "Draft"), " ");
    const ref = el("span", "queue-pr-ref");
    ref.append(el("span", "queue-repo", pr.repo + " #" + pr.number), " · by " + (pr.author || "unknown"));
    const links = el("span", "queue-pr-tickets");
    if (linked) {
      for (const t of pr.tickets) {
        const b = btn(t.key, "queue-ticket-link", () => openTicket(t.key));
        b.title = (t.title || t.key) + (t.status ? " · " + t.status : "") + " (opens read-only)";
        b.setAttribute("aria-label", "Open ticket " + t.key + " (read-only)");
        links.append(b);
      }
    } else {
      const tag = el("span", "queue-unlinked", "Unlinked");
      tag.title = "No ticket named. To link it, name the ticket (for example AION-12 or INT-5) in the pull request's title, description or branch.";
      links.append(tag);
    }
    main.append(title, ref, links);
    if (reasons.length) {
      const att = el("span", "queue-attention");
      for (const r of reasons) att.append(el("span", "queue-attention-chip", r.text));
      main.append(att);
    }

    // Secondary: the review state and reviewers, and the waiting time.
    const status = el("div", "queue-cell queue-status-cell");
    const st = el("div", "queue-state");
    st.append(el("span", "review-status " + (QUEUE_STATE_LABEL[pr.state] ? pr.state : "unknown"), queueStateLabel(pr)));
    const reason = queueReasonText(pr);
    if (reason) st.append(el("span", "queue-reason", reason));
    if (pr.stale) {
      const tag = el("span", "queue-stale", "Last known");
      tag.title = "This repository couldn't be refreshed" + (pr.statusAt ? "; review data read " + exactTime(pr.statusAt) : "");
      st.append(tag);
    }
    const rv = el("div", "queue-reviewers");
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
    status.append(st, rv);

    const w = waitLine(pr);
    const wait = el("div", "queue-cell queue-wait" + (w.long ? " long" : ""));
    wait.append(el("span", "queue-wait-label", w.label));
    if (w.at) wait.append(timeEl(w.at, w.text));

    // The Rami reference flag: always visible; only people allowed to change it (canFlag) can tick it.
    const flag = el("label", "queue-cell queue-rami");
    const box = el("input");
    box.type = "checkbox";
    box.checked = !!pr.rami;
    box.dataset.rami = pr.id;
    box.disabled = !(adminData && adminData.canFlag);
    box.setAttribute("aria-label", "Rami: flag " + pr.repo + " #" + pr.number + " for Rami's reference");
    box.title = "Reference only. It doesn't request a review, assign anyone or change anything on GitHub.";
    box.addEventListener("change", () => setRami(pr, box));
    flag.append(box, el("span", "", "Rami"));

    // Actions: open the details here, and the pull request on GitHub in a new tab.
    const act = el("div", "queue-cell queue-pr-actions");
    const expandBtn = el("button", "queue-expand");
    expandBtn.type = "button";
    expandBtn.setAttribute("aria-expanded", String(isOpen));
    expandBtn.setAttribute("aria-controls", detailId);
    expandBtn.setAttribute("aria-label", "Details for " + pr.repo + " #" + pr.number);
    expandBtn.append(el("span", "queue-caret"), el("span", "", "Details"));
    act.append(expandBtn);
    const manage = btn("Reviewers", "btn", () => openGithubReviewers(pr));
    manage.setAttribute("aria-label", "Manage GitHub reviewers for " + pr.repo + " #" + pr.number);
    manage.title = "Ask GitHub for a review from someone, or remove a request. Changes ask for confirmation first.";
    act.append(manage);
    const href = safePrUrl(pr.url);
    if (href) {
      const link = el("a", "btn", "Open PR ↗");
      link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", "Open pull request " + pr.repo + " #" + pr.number + " on GitHub (opens in a new tab)");
      act.append(link);
    } else act.append(el("span", "queue-none", "Link unavailable"));

    const detail = el("div", "queue-detail");
    detail.id = detailId;
    detail.hidden = !isOpen;
    detail.append(detailBody(pr));

    const toggle = () => {
      const on = !expanded.has(pr.id);
      if (on) expanded.add(pr.id); else expanded.delete(pr.id);
      row.classList.toggle("is-open", on);
      detail.hidden = !on;
      expandBtn.setAttribute("aria-expanded", String(on));
    };
    expandBtn.addEventListener("click", toggle);
    // A click on the row's own text opens the details too; links, buttons and the Rami box keep their own action.
    main.addEventListener("click", (e) => { if (!e.target.closest("a, button, input, summary, label")) toggle(); });

    row.append(main, status, wait, flag, act, detail);
    return row;
  }

  // Builds the admin page once: the head, the summary cards, the quick filters and view, the search with its filter
  // menu and sort, then the results, which are redrawn in place. A dashboard render keeps it (data-keep), so filters,
  // folds, open details and scroll stay as they are.
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

    const notices = el("div", "queue-notices");
    const stats = el("div", "queue-stats");
    stats.setAttribute("role", "group");
    stats.setAttribute("aria-label", "Summary");

    // Primary tabs, and the List / By ticket view beside them.
    const tabRow = el("div", "queue-tabrow");
    const quickBar = el("div", "queue-quick");
    quickBar.setAttribute("role", "group");
    quickBar.setAttribute("aria-label", "Quick filters");
    const quick = QUICK_FILTERS.map(([v, t]) => {
      const b = btn(t, "queue-tab", () => { adminFilters.quick = v; adminFilters.state = ""; drawAdminQueue(); });
      b.dataset.quick = v;
      const count = el("span", "queue-count");
      count.setAttribute("aria-hidden", "true");
      b.append(count);
      return b;
    });
    quickBar.append(...quick);
    const viewBar = el("div", "queue-views");
    viewBar.setAttribute("role", "group");
    viewBar.setAttribute("aria-label", "View");
    const views = VIEWS.map(([v, t]) => {
      const b = btn(t, "queue-seg", () => { adminFilters.view = v; drawAdminQueue(); });
      b.dataset.view = v;
      return b;
    });
    viewBar.append(...views);
    tabRow.append(quickBar, viewBar);

    // The search, the filter menu button, and the sort.
    const bar = el("div", "queue-bar");
    bar.setAttribute("role", "search");
    const search = el("input", "queue-search");
    search.type = "search";
    search.placeholder = "Search title, repository, author or ticket";
    search.setAttribute("aria-label", "Search the review queue");
    search.value = adminFilters.search;
    search.addEventListener("input", () => { adminFilters.search = search.value; drawAdminQueue(); });
    const filterBtn = el("button", "btn queue-filter-btn");
    filterBtn.type = "button";
    filterBtn.setAttribute("aria-expanded", "false");
    filterBtn.setAttribute("aria-controls", "queue-filters");
    const filterBadge = el("span", "queue-badge");
    filterBadge.hidden = true;
    filterBtn.append(document.createTextNode("Filters"), filterBadge);
    const sort = el("select", "queue-sort");
    sort.name = "sort";
    sort.setAttribute("aria-label", "Sort");
    sort.replaceChildren(...SORTS.map(([v, t]) => { const o = el("option", "", t); o.value = v; return o; }));
    sort.addEventListener("change", () => { adminFilters.sort = sort.value; saveSort(sort.value); drawAdminQueue(); });
    bar.append(search, filterBtn, sort);

    // The filter menu: project, repository, reviewer and review state. Opened from Filters; closes on Escape or Done.
    const pop = el("div", "queue-pop");
    pop.id = "queue-filters";
    pop.setAttribute("role", "group");
    pop.setAttribute("aria-label", "Filters");
    pop.hidden = true;
    const menu = (label, name) => {
      const field = el("label", "queue-field");
      field.append(el("span", "", label));
      const s = el("select", "queue-filter");
      s.name = name; s.setAttribute("aria-label", label);
      s.addEventListener("change", () => { adminFilters[name] = s.value; if (name === "state" && ["awaiting", "approved", "drafts", "changes"].includes(adminFilters.quick)) adminFilters.quick = ""; drawAdminQueue(); });
      field.append(s);
      return [field, s];
    };
    const [clientField, client] = menu("Project", "client"), [repoField, repo] = menu("Repository", "repo");
    const [authorField, author] = menu("Opened by", "author");
    const [reviewerField, reviewer] = menu("Reviewer", "reviewer");
    const [relationField, relation] = menu("Reviewer's part", "relation");
    relation.replaceChildren(...REVIEWER_RELATIONS.map(([v, t]) => { const o = el("option", "", t); o.value = v; return o; }));
    const [stateField, state] = menu("Review state", "state");
    state.replaceChildren(...[["", "Any review state"], ...Object.entries(QUEUE_STATE_LABEL)].map(([v, t]) => { const o = el("option", "", t); o.value = v; return o; }));
    const done = btn("Done", "btn primary", () => setPop(false));
    const popFoot = el("div", "queue-pop-foot");
    popFoot.append(btn("Clear menus", "linkbtn", () => {
      Object.assign(adminFilters, { client: "", repo: "", author: "", reviewer: "", relation: "any", state: "" });
      drawAdminQueue();
    }), done);
    pop.append(clientField, repoField, authorField, reviewerField, relationField, stateField, popFoot);
    const setPop = (on) => {
      pop.hidden = !on;
      filterBtn.setAttribute("aria-expanded", String(on));
      if (on) client.focus();
    };
    filterBtn.addEventListener("click", () => setPop(pop.hidden));
    pop.addEventListener("keydown", (e) => { if (e.key === "Escape") { setPop(false); filterBtn.focus(); } });
    closeFilters = (target) => { if (!pop.hidden && !pop.contains(target) && !filterBtn.contains(target)) setPop(false); };

    const active = el("div", "queue-active");
    const list = el("div", "queue-list");
    root.append(head, notices, stats, tabRow, bar, pop, active, list);
    target.append(root);
    adminRoot = { root, controls: { search, client, repo, author, reviewer, relation, state, sort, quick, views, filterBtn, filterBadge }, updated, status, refresh, stats, active, notices, list };
    drawAdminQueue();
    return loadQueue();
  }

  // The page for the signed-in person: the administrators' queue, or the reviewer's own list.
  function renderQueue(target) {
    return isAdmin() ? renderAdminQueue(target) : renderPersonalQueue(target);
  }

  return { openPicker, openTicket, renderQueue, refreshQueue: loadQueue };
}
