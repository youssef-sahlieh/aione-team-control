# Jira comment mentions

In a Jira ticket's Comments tab, type `@` followed by at least two letters. Choose a matching person with the mouse or use Up/Down and Enter. Escape dismisses the picker. Managers and regular users can mention people on tickets they are authorized to comment on.

The composer shows `@Display Name` and sends selected people as `[~accountid:ACCOUNT_ID]` through the existing authenticated comment endpoint. This is Jira Cloud's [account-ID mention format](https://support.atlassian.com/cloud-automation/docs/convert-usernames-to-account-ids/). Jira controls mention notifications and recipient access; this does not grant ticket access.

Editing inside a selected name turns it into plain text. Edits before or after an intact mention preserve the account reference. Failed sends retain the draft.

## Dashboard people mentions

On internal tickets, and on Jira tickets for anyone who is not an administrator (only administrators can search Jira people), `@` lists the people in the dashboard (every account plus the fixed note contacts), filtered as you type. The comment keeps `@Name` as plain text and sends the selected emails as `mentions`. The proxy checks each one against the dashboard people, then gives them a notification (the bell) and an email with the comment and a link. Outsiders are ignored.

Jira account mentions made by administrators also reach the bell of the matching dashboard user (TEAM_CONFIG people id → developer name or first name); Jira sends its own email for those.

In internal notes (the Internal note composer and the Internal notes tab), choosing `@Name` also selects that person as a recipient.

People search uses the existing `/jira/users` endpoint. No API deployment change is needed for mentions on the current login-compatible local preview. The feature is also implemented in the security branch, without reverting secure session changes.

Three browser checks cover both roles, keyboard selection, multiple mentions, edits before a mention, edits inside a mention, posting account references, and hiding the picker for internal tickets. Tests intercept all Jira writes with synthetic responses; no real comments were posted during verification.
