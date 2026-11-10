// Replying to one Jira comment from the dashboard.
//
// Jira Cloud's REST API has no comment threads: a comment has body, visibility and properties, and no parent or reply
// field (see Comment in https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/). So a
// reply is an ordinary comment that carries its context in the text, in the wiki markup the proxy already posts with
// (/rest/api/2):
//
//   In reply to [~accountid:X] — [view comment|https://site/browse/KEY?focusedCommentId=ID]
//   {quote}first lines of that comment{quote}
//   the reply
//
// Everything about the comment being answered (that it is on this ticket, who wrote it, its text, who may see it) is read
// from Jira here. The browser only names the comment's id.

export const QUOTE_CHARS = 280, QUOTE_LINES = 4;

// Text shown as itself in wiki markup: characters that would start formatting, links, macros or mentions are escaped.
// A backslash would escape the next character (and two make a line break), so it is written as its character code.
export const wikiText = (s) => String(s ?? "").replace(/[\\*_+^~{}[\]|!#-]/g, (c) => (c === "\\" ? "&#92;" : "\\" + c));

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
// Jira's rendered HTML as plain text, keeping line breaks.
export function htmlText(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+\d*);/gi, (m, e) => {
      if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()];
      const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : /^#/.test(e) ? Number(e.slice(1)) : NaN;
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    })
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The first lines of a comment, at most QUOTE_LINES lines and QUOTE_CHARS characters (never cutting a character in
// half), with "…" when something was left out.
export function excerpt(text, { chars = QUOTE_CHARS, lines = QUOTE_LINES } = {}) {
  const all = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  let out = all.slice(0, lines).join("\n"), cut = all.length > lines;
  const points = [...out];
  if (points.length > chars) { out = points.slice(0, chars).join("").replace(/\s+\S*$/u, "") || points.slice(0, chars).join(""); cut = true; }
  return out + (cut ? "…" : "");
}

// The address Jira's own "Copy link" gives a comment: the ticket, with the comment focused.
export const commentLink = (site, key, id) => String(site || "").replace(/\/+$/, "") + "/browse/" + key + "?focusedCommentId=" + id;

// Who is answered, as the reply names them:
//   a comment written from the dashboard (Jira shows the proxy's account): the person who wrote it, by name, and they
//   get the dashboard's notification; any other comment: its Jira author, mentioned by account id when the account can
//   still be mentioned (a deactivated, deleted or app account, or the proxy's own account, is named, not mentioned).
export function replyAuthor(comment, logged, integrationEmail = "") {
  const a = comment.author || {};
  if (logged?.by) return { name: String(logged.by.name || logged.by.email || "someone"), email: String(logged.by.email || ""), accountId: "", viaDashboard: true };
  const mentionable = /^[\w:-]{1,128}$/.test(a.accountId || "") && a.active !== false && (a.accountType || "atlassian") === "atlassian" && !(integrationEmail && String(a.emailAddress || "").toLowerCase() === String(integrationEmail).toLowerCase());
  return { name: String(a.displayName || "a former user"), email: "", accountId: mentionable ? a.accountId : "", viaDashboard: false };
}

// The reply's text in wiki markup. signature: the "— Name" line comments written from the dashboard end with.
export function replyBody({ site, key, commentId, author, quote, text, signature = "" }) {
  const who = author.accountId ? "[~accountid:" + author.accountId + "]" : wikiText(author.name) + (author.viaDashboard ? " (via AION Team Control)" : "");
  return "In reply to " + who + " — [view comment|" + commentLink(site, key, commentId) + "]\n"
    + (quote ? "{quote}\n" + wikiText(quote) + "\n{quote}\n" : "")
    + text + (signature ? "\n\n— " + signature : "");
}

// Reads the comment being answered and checks it may be answered from here. Returns { target } or { error, status }.
//   readJira(path): the proxy's Jira call ({ ok, data } or { ok: false, res }).
//   log: this ticket's dashboard history (to know who wrote a comment sent from here).
export async function readReplyTarget({ readJira, key, commentId, log = [], integrationEmail = "" }) {
  const gone = { status: 404, code: "reply_target_unavailable", error: "The comment you're replying to was deleted or can't be read any more. Cancel the reply to send your text as an ordinary comment." };
  if (!/^\d{1,20}$/.test(String(commentId || ""))) return { status: 400, code: "bad_request", error: "Choose the comment to reply to again." };
  const issue = await readJira("/rest/api/3/issue/" + key + "?fields=labels");
  if (!issue.ok) return { res: issue.res };
  const got = await readJira("/rest/api/2/issue/" + key + "/comment/" + commentId + "?expand=renderedBody");
  if (!got.ok) return got.res?.status === 404 || got.res?.status === 403 ? gone : { res: got.res };
  const c = got.data || {};
  // The comment must be this ticket's: Jira's address for it names the issue's id.
  if (String(c.id) !== String(commentId) || !issue.data?.id || !new RegExp("/issue/" + issue.data.id + "/comment/" + commentId + "$").test(String(c.self || ""))) return gone;
  const logged = log.find((e) => e.action === "comment" && String(e.commentId) === String(commentId));
  const author = replyAuthor(c, logged, integrationEmail);
  let text = htmlText(c.renderedBody) || String(typeof c.body === "string" ? c.body : "");
  if (logged) text = text.replace(/\n*— [^\n]*$/, "");
  // Who may see the reply: never more people than could see the comment it quotes.
  const visibility = c.visibility && c.visibility.type && (c.visibility.value || c.visibility.identifier)
    ? { type: c.visibility.type, ...(c.visibility.identifier ? { identifier: c.visibility.identifier } : { value: c.visibility.value }) } : null;
  return { target: { commentId: String(commentId), author, quote: excerpt(text), visibility, internal: c.jsdPublic === false } };
}

// What the dashboard says about the restriction a reply keeps.
export const visibilityText = (v) => (v ? "Visible only to " + (v.value || v.identifier) + (v.type === "role" ? " (role)" : " (group)") : "");
