# UI modernization baseline — first PR

Reviewed October 11, 2026, against version 0.6.0. This PR establishes a regression
baseline before the application shell and filter extraction. The frontend remains
vanilla ES modules on GitHub Pages; the proxy remains on Vercel.

## Current behavior and permission matrix

The backend roles are `admin` and `user` (developer). Every request uses the
session in `session.js`; backend checks remain authoritative. Normalization never
grants access or filters out an unauthorized response.

| Operation | Administrator | Developer | Enforcement |
| --- | --- | --- | --- |
| Read Jira | AION issues matching query | Own `ai1_` label, query additionally constrained | Proxy rewrites JQL, filters returned keys/labels |
| Jira due date, transitions, comments, history | Yes | Own authorized issues | Proxy checks labels before ticket endpoint |
| Jira developer labels / assignee | Yes | No | Field allowlist and role check |
| Jira priority editing | No | No | Not in editable field allowlist |
| Jira user lookup / assignment mail | Yes | No | Admin route checks |
| Users / invitations / account deletion | Yes | No | Admin account routes, last-admin and self-deletion rules |
| Read internal tickets | All stored tickets | Own developer tickets | `canSee` in internal service |
| Create internal tickets | Choose developers | Forced to own developer | Internal route, requires assignee when team people configured |
| Edit internal title, description, priority, status, date / comment | Yes | Own tickets | Internal field validation and visibility |
| Reassign internal developers / assignee, delete ticket | Yes | No | Internal role checks; unchanged assignee accepted |
| Internal attachment download / upload | Yes | Own tickets, up to 4 MB per file | Internal route |
| Remove internal attachment | Any attachment | Own uploaded attachment | Author email or admin check |
| Jira attachments | External Jira link | External Jira link | Upload is performed in Jira, not this dashboard |

The dashboard's main Jira query excludes Epics, selects configured team assignees,
and includes open or recently updated closed issues. A separate query loads closed
tickets for the selected time window. Developer accounts retain the team-assignee
constraint on that query and start/reset with every configured team assignee in
the filter. These defaults must survive saved-view work. UI defaults are not
authorization.

## Data contract

`public/assets/models/issue.js` now contains the existing normalization and label
helpers. `dashboard.js` passes runtime `BYID`, `PEOPLE`, and its unchanged
DOM-based `toText` function. No team configuration is embedded in the module.

| Fields | Meaning / compatibility |
| --- | --- |
| `key`, `internal` | Jira key, or `INT-*` with `internal: true`; Jira objects historically omit `internal` |
| `status`, `cat` | Actual workflow name and source status category; never translated for writes |
| `assignee`, `assigneeId`, `assigneeName` | Configured team key or null, raw Jira ID, display name; not developer labels |
| `labels`, `devs` | Jira labels and deduplicated lowercase `ai1_` names; internal labels synthesized from stored developers |
| `due`, `created`, `updated` | Date-only due or null, date-only creation, original update timestamp |
| `priority`, `type` | Raw priority name (empty if missing); original Jira issue type or `Internal` |
| `reporter`, `reporterId`, `parent` | Reporter display/ID; parent key/name or null; internal has no parent or reporter ID |
| `last` | Last returned comment, author, timestamp, text, team-origin flag, or null |

`withRendered` copies fields/comments before substituting returned rendered HTML.
It falls back to string bodies and ignores ADF objects without rendered text.
HTML sanitization remains in the browser renderer. Jira comments use that text
sanitizer; internal comments stay plain text and count as team-origin comments,
matching the current reply indicator. `labelsWith` preserves unrelated labels and
the original casing of retained developer labels while removing duplicates.

## DOM and event dependencies

The entrypoint immediately registers listeners and then invokes `start()`. It
expects all dashboard IDs to exist before import. Keep those IDs during migration.

| Concern | DOM IDs / selectors | Controller and events |
| --- | --- | --- |
| Session / top bar | `team`, `today`, `updated`, `auto`, `me`, `q`, `refresh`, `users-link`, `signout` | `start`, `applyConfig`, `reload`, 150 ms search debounce, 2 min refresh interval |
| Focus and filters | `tiles`, `active`, `ftoggle`, `fclear`, `fgrid` | `FOCUS`, `F`, `defaultFilters`, `passFilters`, `visible`, `countBy`, `filterCount`, `renderFilters` |
| View and grouping | `vtitle`, `vcount`, `grpwrap`, `grp`, `hint`, `view`, `.seg [data-v]` | `render`, `sortItems`, `listView`, `gridRow`, `boardView`, `historyView`; view/group storage |
| Bulk controls | `bulk`, `b-count`, `b-adddev`, `b-rmdev`, `b-due`, `b-status`, `b-asg`, `b-clear` | Selection Set, developer/date/status/assignee popovers, `runBatch` |
| Feedback / popovers | `pagestate`, `pop`, `toast` | `showState`, `errorText`, `placePop`, `closePop`, outside-click/keyboard handlers |
| Drawer shell | `drawer`, `scrim`, `d-body`, `d-key`, `d-title`, `d-status`, `d-open`, `d-close` | `dz`, `openDrawer`, `closeDrawer`, `loadDetail` |
| Drawer facts / transitions | `d-facts`, `d-trans`, `d-desc`, `d-hist`, `d-asgname`, `d-asg` | `loadTransitions`, `renderDrawerHist`, `fetchHistory`, assignee popover |
| Developer / date editing | `d-devs`, `d-newdev`, `d-adddev`, `d-savedevs`, `d-devmsg`, `d-due`, `d-savedue`, `d-cleardue`, `d-duemsg` | `dz.devs` and original labels; mutation through `runBatch` |
| Comments / assignment | `d-comments`, `d-ccount`, `d-reply`, `d-after`, `d-send`, `d-cmsg`, `d-cattach` | Source-specific comment rendering; comment then optional separate assignee update |
| Internal tickets / notes | `new-int`, `d-edit`, `d-del`, `d-note`, `notify` | `internalPopover`, `notePopover`, confirmed deletion, optional assignment notification |
| Attachments | `d-att`, `d-acount`, `d-attadd`, `i-att`, `i-acount`, `i-file`, `i-attmsg` | Jira links; internal authenticated byte upload/download/delete |

Role CSS uses `.role-user .admin-only`; source CSS uses `.is-int`, `.int-only`,
and `.jira-only`. `users-link` is also explicitly hidden without account storage.
Saved `dev` and `assignee` boards downgrade to list for developer accounts.

Other pages remain unchanged: sign-in uses `signin-form`, `email`, `password`,
`signin-btn`, `signin-msg`; forgot-password uses `forgot-form`, `forgot-email`,
`forgot-btn`, `forgot-msg` and view/back controls. Password reset consumes `#t=`,
removes the token from the URL, checks the link, validates matching passwords,
then posts the reset. Users registers add-role/developer controls, add-form,
copy-link, dynamically generated edit/delete/invite actions and sign-out.

## State and API boundaries for the next PR

- `state`: issue collections, focus, filter Sets, query, view, group, selection,
  filter visibility, history period, updated/due/closed time windows.
- Runtime config: site/project, people, developer metadata, account identity and
  role, mail capability, JQL and closed-query constraints.
- Caches/guards: `INT`, `HIST`, drawer `dz`, drag/popover state, loading,
  history/closed/batch busy guards and last refresh time.
- Jira client: POST search, PUT issue fields, GET/POST transitions, POST comment,
  GET changelog, GET user search. Internal client: list/create/update/comment/delete;
  attachments use shared `apiFile`. Mail uses POST `/mail`.
- Source dispatch: `setDevs`, `setDue`, `doTransition`, `doComment`, `getTransitions`.
  All `INT-*` mutations must stay on the internal API.
- `runBatch` applies operations sequentially, reports per-ticket errors, stops on
  session failure, optionally notifies successful new assignments, reloads data
  and reloads the open detail. Preserve partial failures and ambiguous network saves.

Filtering stays in the existing engine in this PR. Selections are currently
pruned when filters change. Extract this engine in PR #2 with characterization
tests for faceted `skip`, OR within Sets / AND between fields, `__none` developer,
`other` assignee, `None` priority, epic, date boundaries and activity windows.

## Validation and next work

Run `npm ci`, `npm ci --prefix proxy`, `npm test`, then
`npx playwright install chromium` and `npm run test:e2e`.

The existing 36 proxy and 22 account tests remain intact. Eight Node tests cover
the extracted model. Browser tests exercise the actual dashboard with synthetic
fixtures: both sources, search/clear/group/board, developer defaults and saved
board downgrade, deep links and source-specific drawer actions, expired-session
redirect, load failure, and details at 320/768/1440 px. Every external request is
intercepted; unconfigured proxy calls return a test permission error. These tests
do not certify backend permissions; the existing proxy/account tests cover those.

CI runs backend/model/browser tests on PRs and before Pages deployment. PRs do
not publish Pages. Screenshots and failure traces are uploaded as test artifacts;
local screenshots are under ignored `test-results/`.

Known existing limitations to address in later PRs:

- `searchAll` stops after 11 search pages. Complete-dataset pagination needs an
  explicit follow-up, not an assumption that every Jira ticket was loaded.
- Changelog uses expanded issue history, with no broader-history pagination.
  Internal persistence includes due-date history, not a complete field audit.
- Drawer closes without unsaved-edit protection, opener focus restoration or a
  modal focus trap. Deep links are read on startup, not via a live hash router.
- Persistent view/group/window preferences are not user-scoped. Saved views must
  use validated per-user definitions; issue payloads and credentials must not be stored there.
- Baseline screenshots record current mobile layout; they do not establish the
  proposed redesign's overflow, touch-target or keyboard acceptance criteria.
  Visual review at 320 px shows crowded drawer header actions with the Close
  button partly clipped; retain this evidence for the responsive redesign.
- Mutations, partial bulk failure, full authentication/reset browser flows,
  complete filter parity and all six target widths need more browser coverage
  as their corresponding modules migrate.

Rollback: revert this PR as a unit, restoring inline normalization and the
previous test workflow. There is no database migration or backend change.
