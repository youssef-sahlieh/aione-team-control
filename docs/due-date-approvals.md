# Due-date requests and approvals

The approved due date is controlled by administrators. Users can set the first due date immediately without approval. Changes or removal of an existing date require an admin decision; submitting a change request does not change the ticket. This applies to Jira AION tickets and internal INT tickets.

## Local review

Run `npm run preview:approvals` and open:

- Admin inbox: http://localhost:3100/preview/admin
- Developer overview: http://localhost:3100/preview/user
- Captured email messages: http://localhost:3100/preview/emails

The preview uses synthetic tickets, local identities and an in-memory database. Its APIs execute the actual proxy and approval implementation. It cannot call live Jira or send real emails. Data resets on restart. Use the banner links to switch roles. This differs from `npm run dev`, which still forwards requests to the deployed API.

## Dashboard behavior

Date requests is a primary sidebar page for both roles. Administrators see all authorized requests; developers only see requests on tickets currently assigned to their developer label. The inbox is independent of ticket display filters. Awaiting review, My requests, Decisions and All requests views are available. Pending counts, ticket badges and the Pending date request filter identify work awaiting a decision. Overview shows pending requests and recent decisions; the calendar uses approved dates.

Direct user date editors, the Due date changes list mode, Due date moved tile and movement counters are removed. Older manager history URLs resolve to Date requests. Due-date history remains in the manager-only ticket Activity tab, and Jira field history remains in History.

When no date has ever been set, users select Set due date and save immediately, with an optional note. Once a date has been set, users request a change or removal with a required reason and optional blocker details. Clearing a previously set date does not restore permission to set another date without approval. One active request is permitted per ticket. Its requester can revise or withdraw before a decision; administrators can withdraw. User-created internal tickets start without a date. Admins also create internal tickets first, then use Change approved date to set an initial date with a recorded reason.

Admins approve the proposed date, approve an alternative with an explanation, reject with an explanation, or directly set an approved date with a reason. Direct changes are recorded as approved requests. Active requests must be decided or withdrawn before a separate direct change.

## API and persistence

- `GET /date-requests?key=AION-123`: authorized ticket requests and decision history.
- `GET /date-requests?cursor=20`: inbox, paginated over up to 20 ticket records at a time. Follow nextCursor while isLast is false.
- `POST /date-requests/initial`: key and a non-null proposedDate; optional reason. Saves immediately only if no due date has ever been set.
- `POST /date-requests/submit`: key, proposedDate (YYYY-MM-DD or null), reason, optional blocker.
- `POST /date-requests/revise`: key, id, version, proposedDate, reason, optional blocker.
- `POST /date-requests/withdraw`: key, id, version.
- `POST /date-requests/approve`: key, id, version, optional approvedDate and decision reason; confirmContext=true after reviewing changed context.
- `POST /date-requests/reject`: key, id, version, reason.
- `POST /date-requests/direct`: admin-only key, proposedDate and reason.
- `POST /date-requests/retry-email`: key and id; admins or the original requester can retry failed deliveries.

Redis keys are project-prefixed: dates:AION:tickets indexes ticket records; dates:AION:AION-123 stores that ticket's requests, revisions, decisions, delivery statuses and history. Per-ticket atomic locks and compare-and-set updates serialize dashboard approvals. Identity and roles come from the authenticated session. Initial setting rechecks the current date, stored date decisions and Jira/internal due-date history, under the same ticket lock. If history cannot be verified, it fails without changing the date. Dates undergo actual calendar validation. Oversized bodies and invalid keys are rejected. Generic Jira edits and internal-ticket create/update endpoints reject direct due-date fields, including mixed updates and date clearing.

The states include set (initial date saved without approval), pending, needs_review, applying, approved, rejected and withdrawn. Approval rereads the current date, developer assignment and closed status. Changed context requires another review and explicit confirmation; closed tickets cannot receive approved date changes. A durable applying record is written before applying the ticket date. If a write is unconfirmed, retry after two minutes: the service rereads the date and reconciles an already-applied target before attempting another write. Applying requests cannot be revised, withdrawn or rejected until reconciled.

Internal dates are written with compare-and-set and carry request ID/reason in dueHistory. Ordinary internal updates also use compare-and-set so a stale status or comment write cannot overwrite an approved date. Jira writes use the proxy service account; the application approval record identifies the actual administrator.

## Email

The existing Gmail/Microsoft service sends submission notices to administrator accounts, decisions to the requester, and direct date changes to affected developer accounts. Recipients must be within MAIL_DOMAIN. Email failure does not undo the saved request or approved date. Failed/pending delivery statuses appear on request cards with a retry action. SMTP acceptance is not proof of inbox delivery; a process interruption after sending but before saving can cause a duplicate retry. Requests and decisions always remain available in the dashboard.

## Deployment and Jira permissions

No production deployment or Jira permission changes are performed by the local preview. Release backend and frontend together. Upstash storage and the existing mailer must be configured.

To enforce this restriction in Jira itself, a Jira administrator must remove Schedule Issues / Schedule work items permission from ordinary developer roles while retaining it for managers and the proxy service account. See [Atlassian due-date permission guidance](https://support.atlassian.com/jira/kb/due-date-field-not-showing-when-i-create-or-view-a-jira-cloud-issue/).

The proxy serializes its own approvals but cannot atomically compare-and-set a Jira field against edits made outside the dashboard. External Jira edits between the preflight read and update remain a race; permission restrictions and coordination with other date-writing automations are required. Requests are rechecked on every decision and never automatically approved.

## Validation

`npm test` includes date-request validation, scope, role restrictions, revisions, conflicts, simultaneous decisions, email retry and reconciliation tests. `npm run test:approvals` runs developer-to-admin browser approval tests against an isolated backend on port 3101, including mobile layout and a direct-write bypass attempt. `npm run test:e2e` retains existing dashboard regressions with mocked APIs.
