// Replying to one Jira comment from the ticket drawer (the proxy builds and checks the reply, see
// proxy/src/comment-reply.js). Pure functions only, so the wording and the retry rules are tested without a browser.

// The start of the comment being answered, on one line, for the "Replying to" box.
export function replyPreview(text, max = 160) {
  const one = String(text || "").replace(/\s+/g, " ").trim(), points = [...one];
  return points.length > max ? points.slice(0, max).join("").trimEnd() + "…" : one;
}

// Who a comment is from, as the drawer shows it: its Jira author, and the dashboard person who sent it from here
// (the proxy's account is the Jira author of those). The reply goes to that person.
export function commentAuthor(comment, submitter) {
  const jiraName = (comment && comment.author && comment.author.displayName) || "Someone";
  return { jiraName, submitter: submitter || "", replyName: submitter || jiraName };
}

// Comments sent from the dashboard end with "— Name". When the drawer already says who sent it, that last line is
// left out of the display. Returns the element to hide, or null.
export function signatureNode(body, submitter) {
  if (!body || !submitter) return null;
  const last = body.lastElementChild || null;
  return last && last.textContent.trim() === "— " + submitter ? last : null;
}

// One id per send. It is kept after a failure that may have reached Jira (no answer, a timeout, a server error, or
// "still being sent"), so the retry is recognised and never posted twice. After a refusal it is dropped.
export const newSendId = () => "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
export const keepSendId = (err) => !err || err.code === "network" || err.code === "comment_pending" || !err.status || err.status >= 500;

// What the drawer says after a reply was sent.
export function replySentText(reply, notified = []) {
  if (!reply) return "";
  const parts = ["Reply sent to " + reply.to + "'s comment."];
  if (reply.mentioned) parts.push(reply.to + " was mentioned in Jira.");
  else parts.push(reply.to + " couldn't be mentioned in Jira" + (notified.length ? ", but got a dashboard notification." : "."));
  if (reply.restricted) parts.push(reply.restricted + ", like the comment it answers.");
  return parts.join(" ");
}
