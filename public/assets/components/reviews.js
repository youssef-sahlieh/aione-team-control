// Pull request reviews. Administrators choose who reviews a pull request (the picker, opened from the Pull requests
// block). Reviewers get a "Needs review" queue with a read-only view of the tickets the pull request mentions. The
// proxy keeps the assignments (proxy/src/reviews.js); GitHub is asked for the review when the reviewer has a GitHub
// username set by an administrator (Users page). Nothing here changes a Jira ticket.
import { reviewLabel, sortQueue, githubNote, ticketKeysOf, activeReviewerIds, assignedLine } from "../models/reviews.js";

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const btn = (text, cls, action) => { const b = el("button", cls, text); b.type = "button"; b.addEventListener("click", action); return b; };
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const size = (n) => (n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB");

export function createReviews({ api, apiFile, toast, errorText }) {
  const dialog = el("dialog", "review-dialog");
  document.body.appendChild(dialog);
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  let queueTarget = null;

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
  async function renderQueue(target) {
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

  return { openPicker, openTicket, renderQueue };
}
