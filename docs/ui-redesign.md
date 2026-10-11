# Workspace UI redesign

The dashboard now has a persistent sidebar, compact search/account bar,
collapsible desktop navigation, mobile navigation with dismissal/focus handling,
page headings and a consistent responsive visual system. The Users management
and sign-in/reset screens retain their existing layouts.

Pages use an allowlisted `?page=` route. Overview shows open/overdue/today/completed
metrics, deadline-sorted attention items and actual workflow distribution. Boards
and History reuse the existing renderers and actions. Workload keeps developer
labels and Jira assignees separate; developers get their own workload. Calendar
has month/week navigation, a mobile agenda, and unscheduled tickets; opening a
ticket gives access to the existing due-date editor. Page changes do not request
new Jira data. Browser Back/Forward and page queries with issue hashes work,
including after sign-in.

My Tasks uses the authenticated developer label or a configured person matched by
email/account prefix; if neither matches, an administrator's personal list is
empty. This does not expand proxy-authorized visibility. Summary and calendar
pages honor the current filter criteria and disclose when filters apply.

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

Validation: existing 36 proxy and 22 account tests, 19 frontend model/router/filter/
saved-view/workload tests, and 22 mocked Chromium browser tests. Browser coverage
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
