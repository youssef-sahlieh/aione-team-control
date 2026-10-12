# Workspace UI redesign

The dashboard now has a persistent sidebar, compact search/account bar,
collapsible desktop navigation, mobile navigation with dismissal/focus handling,
page headings and a consistent responsive visual system. The Users management
and sign-in/reset screens retain their existing layouts.

The workspace readability pass uses Segoe UI with Hebrew-capable fallbacks,
15 px body/ticket text, 12–14 px supporting labels, stronger secondary-text
contrast, and consistent 44 px primary controls. Search and drawer inputs use
16 px text on mobile, filters and view switches wrap, and keyboard focus is
clearly outlined. Styles are scoped through the dashboard's readability sheet.

Pages use an allowlisted `?page=` route. Overview shows open/overdue/today/completed
metrics, deadline-sorted attention items and actual workflow distribution. Boards
and History reuse the existing renderers and actions. Workload keeps developer
labels and Jira assignees separate and is visible only to managers (admin role).
Developer Workload links fall back to All tickets, preserving ticket deep links. Calendar
has month/week navigation, a mobile agenda, and unscheduled tickets; opening a
ticket gives access to the existing due-date editor. Page changes do not request
new Jira data. Browser Back/Forward and page queries with issue hashes work,
including after sign-in.

Overview uses a minimal layout: one divided metrics panel, a six-ticket attention
list and a plain status-count summary. Decorative banners, status dots and
marketing copy are removed from this page. Metrics still open the corresponding
ticket focus; list entries open details. Dates use short readable labels, overdue
work is explicit, and Completed states the active history window. Filters and
all role restrictions continue to apply. The layout stacks on smaller screens.

All tickets is the single ticket page for both roles. User ticket access remains
restricted by the authenticated developer scope enforced by the proxy. Summary
and calendar pages honor the current filter criteria and disclose when filters apply.

Ticket rows now use clearer spacing, separate priority/status/date indicators,
role-aware quick actions and page sizes of 25/50/100. Sorting/filtering precedes
pagination; selection survives page changes. Grouping remains intact, including
duplicated rows when an issue belongs to multiple developer groups. Select All
continues selecting the whole filtered issue set, not just the current page.
Search follows all supplied Jira pagination tokens and rejects repeated tokens
instead of silently stopping after eleven pages.

The original filter engine is extracted into `models/filters.js` with its Set
semantics, faceted skip behavior, sentinels and date/activity boundaries preserved.
Status/developer/date selectors are always visible; Advanced Filters contains
all existing controls. Removable chips and Clear All remain. Saved views are
validated browser-local filter/display definitions scoped to authenticated email;
they contain no issue payloads or credentials. Developer defaults and unavailable
board downgrades are retained. Saving an existing name replaces that definition;
at most 20 views are retained per user. Cross-device sharing is not implemented.

The No developer focus tile and filter options are reserved for managers (admin
role). Restoring a saved view as a developer removes that filter and resets the
No developer focus to All open.
Due date history navigation, the Due date changes view, Due date moved tile,
and the drawer Activity tab are also manager-only. Developer history routes and
saved modes fall back to the ticket list, and Jira changelog requests are skipped.
Developers retain the current due date and its editor.
Developer quick/advanced filter controls and editable developer filter chips are
manager-only. Users rely on the proxy's authenticated AI1_ label scope; old saved
developer filters are ignored so they cannot silently narrow the user's list.

Both roles default to Karim, Youssef and Rami in the assignee filter. Razan
remains a separate option and is included only when explicitly selected.

The manager sidebar keeps Overview, All tickets, Workload and Calendar as primary
pages, with Boards and Due date history under More. My tasks has been removed;
old My tasks links open All tickets while preserving the ticket hash. Users
continue to see only authorized tickets. Direct links still
work and open the relevant navigation group. The manager's quick filters show
Assignee, Developer, Reporter, Status, Priority and Due date; multi-select developer chips and saved-view controls are
available in More filters. Users have a minimal Assignee, Status and Due date bar,
with search in the top bar. Reporter, Priority, Developer, advanced filters and saved-view controls
are manager-only. Users' default assignees are summarized as Default team instead of separate chips;
custom selections remain removable and Razan/Others stay available through the assignee picker.
Hidden advanced criteria are cleared for users so they cannot silently narrow the list.
Ticket focus counts use compact buttons, and rows
keep assignee, developer, status and due date visible on smaller screens. Reporter,
created/updated dates and internal notes remain available in details or row menus.
Bulk actions appear only after selection. AI stays in its existing top-bar panel.

All tickets retains its original dashboard layout: all ten focus cards are
available directly, and list rows use their original desktop/mobile arrangement.
The manager's compact card and row styling applies only to other ticket pages.
The new Jira-style filters and three-person default selection remain in place.

Jira ticket details include a manager-only **History** tab immediately beside Comments.
It loads all pages of Jira's field changelog on demand, newest first, with author,
timestamp, field name and full before/after text. Status, assignee, labels, priority,
due dates and custom field changes are included when Jira records them; Comments
remain in their own tab. Internal tickets retain their existing due-date Activity
timeline and have no Jira History tab. The proxy's `/jira/issue/<key>/history` route
is authenticated, manager-only, restricted to this project, read-only, and fixes
each Jira page to 100 entries. It uses Jira's [paginated changelog endpoint](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-changelog-get).
The frontend follows pages to completion, detects stalled pagination, discloses
partial failures with retry, caches five ticket histories by updated timestamp
for the page session, and ignores stale results when the selected ticket changes.
Tab switching preserves comment drafts. Existing manager-only due-date history
controls remain unchanged.

The Jira-style filter toolbar has a searchable assignee picker with native
checkboxes, default/optional groups, counts and staged Apply/Cancel controls.
Cancel or Escape discards draft selections and restores keyboard focus. At least
one assignee must be selected; Reset to default restores Karim, Youssef and Rami.
The picker uses a native modal dialog for focus handling, becomes a bottom sheet
on mobile, and supports zero-result searches. Active chips remain removable, and
the toolbar reports the matching ticket count for the current focus and filters.
The quick selector offers the default team, each person, and Others; advanced
chips allow combining selections. Other configured people, unknown Jira accounts
and unassigned tickets are grouped under Others and appear only when selected.
Reset filters and Default team restore the named selection. Existing nonempty saved
assignee selections remain, including explicitly selected Others. Names resolve
to configured account keys, with a display-name fallback for named people absent
from config; this does not add invented Jira IDs or change internal assignment
permissions. Workspaces with an entirely different configured team retain it.
Jira searches no longer hardcode team assignees, so Others can include authorized
tickets; the proxy still enforces every developer's authenticated AI1_ label.

Ticket details retain their DOM controls and API handlers, now organized into
Overview, Activity, Comments and Files tabs. Tabs preserve draft inputs; closing
with pending date/developer/comment edits prompts before discarding them. The
drawer traps keyboard focus, makes the underlying shell inert and restores focus
on close. Header actions wrap on mobile. Activity explicitly shows recorded
due-date history rather than claiming a complete audit. Failed mutations do not
reload the failed ticket's detail and erase the pending input. Assignment-email
preferences remain available in My Account; row quick actions retain Internal
Notes, assignee/developer changes, and the Jira link as applicable.

The deployed proxy, backend roles, workflows, credentials, internal-ticket storage
and Content Security Policy are unchanged. Runtime team config continues coming
from the authenticated API. Development preview runs at `http://localhost:3000`
using `npm run dev` (Node 24+); authenticated requests go through the existing
deployed proxy. This preview uses live data and saves.

Validation: existing 36 proxy and 22 account tests, 24 frontend model/router/filter/
saved-view/workload/assignee tests, and 26 mocked Chromium browser tests. Browser coverage
includes roles, source-specific drawers, sign-in with page/hash, saved views across
reload, draft discard/focus restoration, failure feedback, pagination selection,
page navigation and layout checks at 320/375/390/768/1024/1440 px. Screenshots of
Overview, Calendar, Workload, Tickets and Drawer are generated under ignored
`test-results/` and uploaded by CI. No browser test accesses production data.

Remaining limitations: expanded Jira changelog history still lacks full audit
pagination; internal records do not contain every field-change event. No calendar
drag/drop, shared saved views, capacity estimation or exhaustive visual snapshots.
Calendar can show many ticket buttons on a heavily scheduled day; unscheduled
preview is capped at 25 with a link to the paginated list. Browser coverage of all
bulk partial-failure and attachment scenarios remains a follow-up; existing
backend coverage stays in place. Remaining orchestration is still in the original
dashboard entrypoint for gradual extraction.

Rollback: revert the UI change as a unit; no database migration is involved.
