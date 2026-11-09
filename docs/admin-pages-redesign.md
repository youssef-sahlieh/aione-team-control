# Admin pages redesign: Workload, Checks & Reports, Analytics

Status: **implemented, not yet committed** on `feature/admin-pages-redesign` (2026-11-09).

All three pages are administrator pages in the dashboard (`dashboard.html?page=workload|reports|analytics`).
The routes stay the same. Each page now answers one administrative question:

| Page | Question it answers | Owns | Does not own |
|---|---|---|---|
| Workload | Who is carrying which open work right now, and what is late or unscheduled? | Current team assignments, drill-downs into the ticket list | Period trends, hours, exports |
| Checks & Reports | Which tickets need action (over agreed hours, no agreement, no client, not in Odoo yet), and what do I export? | Exceptions, the ticket table, Excel/CSV export, agreed-hours import | Team workload, created/completed trends, Odoo client/project management |
| Analytics | How did the selected period go compared with the one before? | Period trends: created, completed, net backlog change, on-time rate, work-log hours by week/source/client/person | Current state (overdue now, open by age), ticket exports |
| Clients (unchanged) | Odoo clients/projects, allocation and mapping | Adding clients/projects to Odoo, mapping, budgets | — |
| Needs review (unchanged) | The PR queue | — | — |

## Inventory: keep / move / remove / reuse

### Workload (`public/assets/app/workspace.js` → `workload()`, `public/assets/models/workload.js`)

| Item | Decision | Why |
|---|---|---|
| Developer labels / Jira assignees tabs | Keep | Two real assignment models; the assignee tab stays admin-only. |
| Open, In progress, Overdue, No date columns | Keep, made clickable (Open, Overdue, No date) | Each number opens the ticket list with the same rule (FOCUS `open`, `overdue`, `nodue`) and the member filter. |
| Overdue / No date counting | Fix | Workload counted Odoo Helpdesk tickets as overdue / undated; the ticket list (FOCUS in `dashboard.js`) never does. The counts now use the ticket list's rule, so number = drill-down. |
| Done column | Remove | It counted closed tickets inside whatever closed-ticket window the dashboard had loaded (`closedDays`), so the number changed with an unrelated setting. Completed work is a period figure: Analytics. |
| Shared column | Add (developer tab) | Open tickets with more than one developer label; explains why member rows add up to more than the team total. |
| Team summary (unique tickets) | Add | Open, Overdue, No due date, No developer, each ticket counted once; each opens the ticket list. |
| Distribution bar | Keep | Status mix per member. |
| “Using your current ticket filters” banner | Keep | Workload is computed from the same filtered ticket set as the list, which is what keeps drill-downs consistent. |
| 2-minute auto-refresh | Remove on this page | The header's **↻ Refresh** re-reads the tickets (the dashboard's `reload()`). Workload has no second button of its own. |
| Team & Delivery workload table on Checks & Reports | Move here | Was a second, differently-counted workload table. |

### Checks & Reports (`components/report-browser.js`, `components/report-dashboard.js`, `models/report-view.js`)

| Item | Decision | Why |
|---|---|---|
| Saved report (`/reports/latest`, `/reports/refresh`) | Keep, reuse | Same snapshot, same backend; **Refresh report** is the only refresh. |
| Exceptions strip | Add | Over agreed hours, No agreed hours, Client not set, Not in Odoo yet. Each count is computed by applying that exception's filter to the current filters, so clicking it shows exactly that many rows. |
| Filters | Keep; From/Through/Search in the toolbar, the rest under **More filters** | Less default clutter, same filters. |
| Ticket table | Keep, now the default view; fewer on-screen columns | Billing, Estimated and Actual stay in the exports. Hour columns relabelled (see metrics). |
| By employee, then customer | Keep as the second view | |
| Export Excel / CSV | Keep, reuse | Both export every filtered row, not just the current page. |
| Agreed-hours import | Keep | |
| Overview tab (open now, completed in period, overdue now, age buckets) | Remove | Current state is Workload's; completed in period is Analytics'. The agreed-vs-logged charts it repeated remain below. |
| Hours & Agreements tab | Keep, behind **Agreed vs logged charts** (collapsed) | Directly about exceptions (overruns). |
| Team & Delivery tab | Remove | Workload table → Workload; created/completed → Analytics (it was a second `weeklyFlow`); effort by week/person → Analytics (*Hours by person*); employee × client heatmap removed. |
| “In this report but not in Odoo” add-to-Odoo panel | Move to Clients | Clients owns Odoo client/project management. The report now shows the count and a link to Clients. |
| Work entries in this period | Keep (on demand) | Labelled as period work-log entries. |

### Analytics (`components/analytics.js`, `models/analytics-stats.js`, `proxy/src/analytics.js`)

| Item | Decision | Why |
|---|---|---|
| Snapshot (`/analytics/snapshot`, `/analytics/refresh`) | Keep, reuse | Filters and period are computed in the browser; no request when they change. |
| Created, Completed tiles | Keep | |
| “Open at period end” tile, note “Created minus completed” | Replace with **Net backlog change** | Created − completed is a change, not an open backlog. A historical open count cannot be rebuilt reliably: done tickets without a completion date counted as open forever, reopenings are not in the snapshot, and tickets closed before the 24-month window are missing. |
| Overdue now tile, Overdue now table, Open work by age | Remove | Current state, not a period trend: Workload (Overdue / No date drill-downs). |
| On time | Keep | |
| Hours logged → **Work-log hours** | Keep, relabelled; split into confirmed in Odoo / pending sync / held under agreed hours | |
| Charts: created & completed per week, hours per week by source, hours by client | Keep | |
| Hours by person | Add | Replaces the Checks & Reports effort panel; same snapshot entries. |
| Refresh data | Keep (manual only) | |

### Reused, not duplicated

- Ticket drill-down: the dashboard's FOCUS rules and `state.f` filters (no new list).
- Workload numbers: `calculateWorkload` / `workloadTotals` (one implementation).
- Created/completed per week: `analytics-stats.js` `weeklyFlow` only (the report copy is removed).
- Odoo client/project add and mapping: the Clients page only.
- Odoo sync state: `isSynced()` in `proxy/src/time-entries.js` (exported, used by the snapshot).
- Exports: `unifiedCsv` and `buildReportWorkbook`.

## Metric definitions

Days are Asia/Jerusalem calendar days (`YYYY-MM-DD`). “—” means unknown and is never summed as zero.

| Metric | Page | Source | Date scope | Counting rule |
|---|---|---|---|---|
| Open (member) | Workload | Dashboard tickets (`state.issues`) after the ticket filters | Now | Status category ≠ done. A ticket with two developer labels counts for each developer. |
| Overdue | Workload | Same | Today (Jerusalem) | Open, not Odoo Helpdesk, due date before today. |
| No date | Workload | Same | Now | Open, not Odoo Helpdesk, no due date. |
| Shared | Workload | Same | Now | Open and more than one developer label. |
| Team totals | Workload | Same | Now | Each ticket once (`workloadTotals`). |
| Over agreed hours | Checks & Reports | Saved report | Ticket lifetime | `overage === 'overage'`: logged (all time) > agreed. |
| No agreed hours | Checks & Reports | Saved report | — | No agreed hours on the ticket (`overage == null`). |
| Client not set | Checks & Reports | Saved report | — | No client on the ticket. |
| Not in Odoo yet | Checks & Reports | Saved report `odooStatus` | Snapshot time | `Waiting to sync` or `Not sent`. |
| Logged, all time (h) | Checks & Reports | Work log summary per ticket | Ticket lifetime | Every work-log entry on the ticket, any date. **Not** hours in the selected period. |
| Agreed, ticket (h) | Checks & Reports | Ticket business record | — | The ticket's agreed hours. **Not** the project allocation (that is on Clients → budgets). |
| Created / Completed | Analytics | Snapshot tickets | Selected period | Created day / completion day in the period. Done tickets with no completion date are left out and counted in a warning. |
| Net backlog change | Analytics | Snapshot tickets | Selected period | Created − completed. Positive = more came in than was finished. |
| On time | Analytics | Snapshot tickets | Selected period | Completed in the period with a due date, completed on or before it. |
| Work-log hours | Analytics | Snapshot entries | Selected period | Entries dated in the period. Split: confirmed in Odoo (synced, current revision), pending sync (syncing, needs setup, needs review), held under agreed hours (not sent individually; the agreed-hours line goes to Odoo instead). |
| Hours by person / client / week | Analytics | Snapshot entries | Selected period | Same entries as Work-log hours. |

## Discrepancies between the spec and the source data

1. **No historical open backlog.** The snapshot does not store status history, so “open on day X” cannot be rebuilt. Shown instead: net backlog change.
2. **Completion dates.** Some done Jira tickets have no resolution date. The snapshot reads up to 20 histories per build; the rest are left out of completion counts and reported in a warning.
3. **Odoo confirmation on old snapshots.** Snapshots built before this change have no sync state per entry. The split shows “Odoo confirmation unknown — use Refresh data” instead of zero.
4. **Report Odoo status with agreed hours.** When a ticket has agreed hours, `odooStatus` reflects only the agreed-hours line, not the individual work entries (by design: those are held). “Not in Odoo yet” follows that rule.
5. **Report hours are lifetime totals.** The saved report has no per-period hours per ticket; the period applies only to the “Created or completed in period” option and to the work-entry list.
6. **Workload scope.** Workload uses the dashboard's loaded tickets and current filters; closed tickets depend on the loaded closed window, which is why the Done column was removed.
7. **Odoo Helpdesk tickets** have no due dates here and are never overdue or undated (matches the ticket list).
8. **Odoo Helpdesk entries** (source `odoo`) have no ticket in the snapshot, so they match only while no client or developer filter is set (unchanged rule).

## Refresh rules

- No timers on these pages: the dashboard's 2-minute ticket auto-refresh pauses on Workload, Checks & Reports and Analytics (as it already did on Clients).
- One manual action per page: the header **↻ Refresh** on Workload (it shows tickets), **Refresh report** on Checks & Reports, **Refresh data** on Analytics. The header refresh and its timer line are hidden on Checks & Reports and Analytics (`workspace.css`), because they re-read tickets, not those pages' data.
- **Refresh data** is disabled and reads “Refreshing…” while it runs; the numbers stay on screen with a note until the new data arrives.
- Changing filters, period, view or page is local: no request (Analytics, Checks & Reports) and never a sync.
- Checks & Reports and Analytics stay in place when the dashboard re-renders (`data-keep`, like Clients), so filters, scroll, open sections and the import file survive.
- A failed refresh keeps the last data and shows the error.

## Acceptance criteria

- [x] Backend: non-admins get 403 from `/analytics/*`, `/reports/*`.
- [x] Workload: every clickable count equals the ticket list it opens.
- [x] Workload: shared tickets count per developer; team totals count each ticket once.
- [x] Workload: overdue uses the Asia/Jerusalem day; Odoo Helpdesk tickets excluded as in the list.
- [x] Checks & Reports: each exception count equals the rows shown after clicking it.
- [x] Checks & Reports: CSV/Excel contain every filtered row across pages.
- [x] Checks & Reports: failed refresh keeps the report and filters.
- [x] Analytics: net backlog change = created − completed; no historical open tile.
- [x] Analytics: work-log hours split into confirmed / pending / held; unknown when not recorded.
- [x] Analytics: missing completion dates and missing work log shown as unknown, never zero.
- [x] Work-log entries de-duplicated across month indexes.
- [x] No auto-refresh on the three pages; filters cause no request.
- [x] Desktop and mobile layouts checked.
- [x] Clients mapping/add-to-Odoo and ticket assignment flows still pass their tests.

## Implementation status

Done. The main changes, by file:

- **Workload:** `app/workspace.js` and `models/workload.js`.
  - Adds the team summary cards and the Shared column.
  - Every count opens the ticket list with the same FOCUS rule and member filter.
  - Removes the Done column and Workload's own Refresh button.
- **Checks & Reports:** `components/report-browser.js`, `report-dashboard.js` and `models/report-stats.js`.
  - Adds the exceptions strip and the Odoo filter (`ODOO_WAITING` in `models/report-view.js`).
  - The ticket table is now the default view, with relabelled hour columns. Two lines under the totals explain lifetime vs period hours, and ticket agreement vs project allocation.
  - The agreed-vs-logged charts sit in a collapsed section.
  - Removed: the Overview and Team & Delivery tabs, and their stats (`aging`, `overdueOpen`, `completedInPeriod`, `employeeClientMatrix`, `workloadByStatus`, `weeklyFlow`, `weeklyEffort`). `agreementSummary` stays, because `agreementGroups` uses it.
  - The add-to-Odoo panel is replaced by a count and a link to Clients (`ticket-business.js` `reportAddPanel`).
  - The phone layout labels every value and keeps Status visible (`ticket-business.css`).
- **Analytics, browser side:** `components/analytics.js`, `models/analytics-stats.js` and `analytics.css`.
  - Five tiles: Created, Completed, Net backlog change, On time, Work-log hours (with the Odoo split).
  - Hours by person replaces Open work by age.
  - Removed: the Overdue tile and table. `openAt`, `isOverdue` and `openByAge` are deleted.
  - The page sits in a `data-keep` host.
  - The phone controls no longer overflow the screen.
- **Analytics, proxy:** `proxy/src/analytics.js`.
  - Each snapshot entry gains a 6th element: 0 pending, 1 confirmed (`isSynced`), 2 held (`state === 'agreed'`).
- **Dashboard:** `dashboard.js`.
  - The business context gets `navigate`.
  - Analytics no longer gets `openIssue`, because it has no ticket table now.

### Limitations

- The Workload Shared column is for developer labels only; Jira has one assignee per ticket.
- The Odoo split appears only after **Refresh data** rebuilds the snapshot. Until then it reads “unknown”.
- Checks & Reports counts and rows reflect the saved report as of its generation time. Workload reflects the tickets as of the last ticket read.
- See *Discrepancies* above for the source-data limits.

## Verification

Run on 2026-11-09. Every e2e test uses a synthetic proxy (Playwright route mocks); no real data.

| Check | How | Result |
|---|---|---|
| Browser unit tests | `node --test test/frontend/` | 138/138 pass |
| Proxy tests | `node --test test/*.test.js` | 344/345 pass. The failure is the Chart.js vendor-file check, which also fails without these changes. |
| End-to-end | `npx playwright test` | 111/111 pass |
| Admin-only backend | `test/saved-reports.test.js`, `test/analytics.test.js` | Non-admin refused on `/reports/*` and `/analytics/*` |
| Drill-down = count | `test/e2e/workload.spec.js` | The Overdue card, a developer's Open count and their Overdue count each open exactly the counted tickets |
| Shared counting | `workload.spec.js`, `test/frontend/workload.test.js` | A two-developer ticket counts for each developer and once in the team totals |
| Jerusalem day boundaries | `analytics-stats.test.js`, `workload.test.js` | The first and last period days count, the next day does not; overdue is strictly before today |
| Unknown vs zero | `analytics-stats.test.js`, `analytics.spec.js` | No work log shows “—”; an old snapshot shows “Odoo confirmation unknown” |
| Work-log dedup | `test/analytics.test.js` | An entry listed under two month indexes counts once |
| Exceptions = rows | `test/e2e/reports-checks.spec.js` | No agreed hours, Over agreed hours and Client not set each show exactly their count of rows, and choosing one again clears it |
| Export across pages | `reports-checks.spec.js` | The CSV holds all 60 tickets while the table shows 50. Excel uses the same `shownRows()`. |
| Failed refresh keeps state | `reports-checks.spec.js`, `analytics.spec.js` | Rows, filters, numbers and the developer filter stay, and the error is shown |
| No timers, no requests on filters | `workload.spec.js`, `analytics.spec.js`, `reports-checks.spec.js` | Five minutes on a fake clock: no ticket or analytics read. Filter clicks send no `/reports` request. |
| Mapping and assignment flows | `odoo-projects.spec.js`, `all-open-assignee.spec.js`, `ticket-business.test.js` | Pass |
| Desktop and mobile | Screenshots at 1440×900 and 390×844 of all three pages | Two fixes: the exception strip had no styles, and the Analytics controls overflowed on phones. After them, no horizontal page scroll at 390 px. |
