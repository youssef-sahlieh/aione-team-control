# Replying to a Jira comment

**Reply** on a Jira comment in the ticket drawer answers that comment. Jira Cloud's REST API has no threaded comments.
Its Comment has no parent or reply field
([Issue comments API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)). So a
reply is an ordinary Jira comment that carries its own context. It is not a native Jira thread.

## What is posted

The proxy builds the comment in the wiki markup it already posts with (`/rest/api/2`):

```
In reply to [~accountid:X] — [view comment|https://<site>/browse/KEY?focusedCommentId=ID]
{quote}
first lines of the comment (at most 4 lines / 280 characters)
{quote}
the reply

— Sender name        (only when the sender isn't the account the proxy posts as)
```

- **The original's details come from Jira.** The browser sends only the comment's id (`replyTo`). The proxy reads the
  comment from Jira and checks that it belongs to this ticket. It takes the author and the quote from Jira, and copies
  the comment's visibility (role or group) onto the reply. A Jira Service Management internal comment gets an internal reply.
- **A deleted or unreadable original is refused.** The proxy returns 404 `reply_target_unavailable`. The draft and the
  reply target stay in the drawer.
- **Mentions and notifications:**
  - The author is mentioned by account id only when the account is active, isn't an app account and isn't the
    integration account. Otherwise the reply names them in plain text, which Jira doesn't notify.
  - If the original comment was sent from the dashboard, the reply names the person who sent it, "(via AION Team
    Control)". That person gets a dashboard notification, because Jira only knows the integration account.
  - The drawer says which of these happened. It never promises a Jira notification.
- **No double posts:**
  - Each send has a `requestId`. After a success, the same id answers `duplicate: true` for 24 hours.
  - While a send is still in flight, a second one with that id gets 409 `comment_pending`.
  - The drawer keeps the id after a network error or a 5xx, so a retry is never posted twice. It drops the id after a
    refusal.
- **What a reply never does:** edit the original comment, change the assignee, or apply to Odoo or internal tickets.

## The `focusedCommentId` link

The `focusedCommentId` link is the address Jira's own "Copy link to comment" produces. It isn't in Atlassian's API
reference. Atlassian's issue tracker documents it:

- [JRACLOUD-77216](https://jira.atlassian.com/browse/JRACLOUD-77216)
- [JRACLOUD-76471](https://jira.atlassian.com/browse/JRACLOUD-76471)

If Jira changes that format, the link opens the ticket without scrolling to the comment.
