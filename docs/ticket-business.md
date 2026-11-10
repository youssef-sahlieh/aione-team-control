# Ticket business fields and management reports

Ticket client selection, billing, estimates, actual hours and Work done are private dashboard metadata. They are never written to Jira. Ticket totals are not timesheets.

## Deploy and activate

Deploy the proxy before the frontend. The Pages workflow waits for the public health capability `ticket-business-v1`. STORE must support compareAndSet, setIfAbsent and deleteIfValue, as the existing Redis adapter does. The dashboard blocks status changes when connected to an older proxy.

Sign in as an administrator and open **Clients**. Choose the supplied project XLSX workbook, inspect the import preview, then press **Apply reviewed import**. The workbook is read in the browser; only validated customer/display-name rows are sent to the authenticated catalog API. Do not commit the workbook, imported data, or credentials into public assets.

Mapping: Customer becomes Client and Display Name becomes Sub-client. If Customer is blank, Display Name becomes a standalone Client. All 245 supplied entries, including the 81 standalone entries, are supported. No Company, source creation date, Stage, or status value becomes ticket metadata. Imports are additive and repeatable; they preserve archived entries and administrator renames. Names are trimmed, without translating or altering their spelling. Source row numbers are retained for review.

Existing tickets remain unassigned to clients with billing and hours unset. Use Client not set and the administrator bulk **Client / Sub-client** action to assign existing open tickets. Do not backfill guessed values. Existing closed tickets remain closed. Reopen a ticket before correcting its new fields.

## Roles and workflow

New internal tickets default to **Internal Tickets**, a virtual assignee without a Jira account or login. Existing assignments remain unchanged. Developers still determine user access. The default filter includes this shared assignee.

Users choose a client/sub-client during internal creation. Administrators manage catalog entries and change client selection afterward. Both roles can save positive estimated and actual hours (up to two decimal places, maximum 1,000,000) and a plain-text Work done description up to 5,000 characters while the ticket is open. Blank work fields are allowed in progress. Billing is administrator-only; user responses, histories and AI context exclude it.

**Agreed hours** are also administrator-only: they are stripped from ordinary users' responses. An administrator sets them in the ticket drawer, under "Agreed hours (administrators only)". The value must be a valid positive number of hours. It is written to the ticket's history. Clearing agreed hours is refused with 409 `agreed_sent` once the ticket's agreed line is in Odoo. The Odoo line goes to one of the ticket's **Developers** (its `ai1_` labels, or an internal ticket's developers), never to its assignee or to the administrator saving. One developer: that one. Several: the administrator chooses in "Agreed hours go to" (`agreedDev`); a choice still on the ticket is kept when the hours change. No developer: refused with 409 `agreed_needs_developer`; several and no choice: 409 `agreed_choose_developer`; a developer not on the ticket: 409 `agreed_developer_unknown`. The drawer shows who the hours go to beside the field and checks this before saving. The developer is checked only when the agreed hours or the chosen developer change, so unchanged agreed hours never block other fields. Both CSV imports use the same rule; for several developers the choice is made on the ticket. The history names the developer (`agreedDeveloper`). While agreed hours are set, people's Odoo entries are replaced by one agreed line per ticket; see [work-log.md](work-log.md).

**Overage flag.** The flag is computed when the ticket is read, not stored. When logged hours are more than agreed hours, the ticket shows **Needs checkup** in the drawer, on the board card and in the report. Only logged entries are compared, and the amount over (`overHours`) is shown to administrators only.

All dashboard transitions into a completed status require client selection, estimated hours, actual hours and Work done. Administrators can override missing requirements with a recorded reason. The same server guard protects drawer, board, bulk and direct API calls. Bulk actions report per-ticket failures. Closing directly in Jira bypasses dashboard validation; the next authoritative read locks the business fields. Created date always uses the original ticket timestamp and displays in Asia/Jerusalem time.

## Odoo project on tickets

When Odoo is connected, **each ticket picks one Odoo project and its client comes from that project**. The picker in create, details, quick edit, bulk edit and the ticket filters lists "Client → Project" labels (with the Odoo id when two read the same). The client is shown read-only. The ticket stores `odooProjectId`; `clientId`/`subClientId` are derived from it and can no longer be set on their own (400 `project_required`).

- Only active projects with a client are offered. A project without a client is listed as not available (400 `project_no_client`), archived ones are refused for new choices (400 `project_archived`), unknown ids get 400 `project_unknown`.
- New tickets need a project. Older tickets without one stay readable and editable; a project is required only when it is set or changed.
- A ticket on a project later archived in Odoo keeps it and shows **Archived**.
- Users choose the project when the ticket has none; afterwards only administrators change it. Changing it on a ticket with work logs asks first; existing entries stay on their Odoo project and only new entries go to the new one. The change is in the ticket history ("Odoo project: from → to").
- The project list is a snapshot of Odoo (`business:<P>:odoo-projects`) refreshed by every Odoo sync (once when the dashboard loads, **Sync from Odoo now**, and after **Create project**). The Clients page shows when the last sync worked and, only when the last one failed, the error with what to do.

### Clients & Projects page (administrators, with Odoo)

The page has the heading, **Sync from Odoo now**, **+ Create project**, **Map tickets (N)** (tickets without an Odoo project) and a **More** menu (Export CSV, Create contact, the clients board, the epic map when enabled, and *How figures are counted*), a one-line sync status, and the Odoo projects table. **+ Create project** duplicates the Odoo project named **Template (Enterprise Customers or Odoo.sh)** (its stages, tasks and settings) under the new name and contact, active, with the template's tags plus **Active** (made in Odoo the first time it is missing). Without that template, or with two projects of that name, nothing is created and the reason is shown.

**Refreshing.** The page reads its data when it opens and again only after **Sync from Odoo now** or a change made on it. Nothing runs on a timer: the ticket auto-refresh pauses while the page is open, and dashboard renders leave the page in place (`data-keep="clients"`), so search, filters, open rows, scroll position and open dialogs stay as they are. One request per data source runs at a time; a second Sync press while one runs does nothing, and the backend answers *busy* to a sync from elsewhere. After a change only the table rows and the Map tickets count are read again; an allocation edit redraws its own row, and a refresh that arrives while an allocation is being edited waits until it closes.

### Odoo projects table

Every active Odoo project, including those with no tickets, newest first. Columns: Project (opens its details), Client, Allocated, Logged, Remaining, Budget status, Open tickets, and the actions **Set/Edit allocation** and **Map tickets**. The ▸ button shows the rest: created, % used, tickets needing PR review, last work log, time not in Odoo yet, company, Odoo id, **Open in Odoo**, Jira links with the link control, and the details dialog (tickets, work logs and history). Search (project or client) and the client filter are always shown; budget status, missing client, with/without tickets and the sort (including Created and Last work log) are behind **Filters (n)**. Totals, the count line and **Export CSV** follow the filters.

- **Logged** is Odoo's timesheet total (each line once). Work log time not in Odoo yet (pending or failed) is shown apart and not counted.
- **Remaining** = allocated − logged, and can be negative. An empty allocation is **Allocation not set**, not zero; an allocation of 0 is over budget as soon as any time is logged.
- **Near limit** starts at **80%** of the allocated hours (`NEAR_LIMIT`, sent with the list); over 100% is **Over budget**, below 80% **Within budget**.
- **Open tickets** are linked tickets the dashboard has not recorded as completed. **Needs PR review** counts linked tickets with an open pull request waiting for review (needs `GITHUB_TOKEN` and `GITHUB_REPOS`).
- Each row says whether tickets can be given the project (`assignable`: in the last sync, active, with a client) and why not (`blocked`); **Map tickets** is disabled with that reason otherwise.

### Project billing workspace (billing-v1)

Expanding a project's row (▸) also opens its **billing workspace**: administrators only, read the first time the row is opened (`GET /clients/odoo-projects/tickets?id=`) and kept for the session, so closing and reopening the row, or opening a ticket's drawer, keeps the search, filters, sort, page, selection and scroll.

- **Description** of the Odoo project, two lines with **Show more**.
- **Tickets**: every ticket of the project once: tickets whose business fields name it, tickets with work on it (Jira, internal and Helpdesk), and its Odoo tasks named `[KEY] …`. An Odoo task is never a ticket of its own, so nothing is counted twice. Columns: selection, Ticket (key opens the drawer, plus Jira / Internal / Helpdesk), Title (with a two-line description preview), Status, People (developers and the assignee, shown apart), Billing (override, and the effective value with where it comes from), Est., Agreed (with the developer they go to), Actual, Commercial, Odoo sync (time not in Odoo yet, entries to review, a billing field that failed to save).
- **Actual** is the work logged; **Commercial** is what counts against the allowance (agreed hours once, else billable actual work). They are never added together.
- **Scope**: hours cover the project's active allowance period (else the last 365 days); **Filters → Period** picks other dates. The totals line says the scope and the filtered count; the selected count shows its own hours.
- **Search** (key, title, description, people), **Filters** (status, developer, source, billing incl. inherited/override, sync and setup problems), **sort**, **pagination** (25/50/100). Loading, empty, no-match (with *Clear search and filters*) and error (with **Retry**) states are shown. Up to 500 tickets are listed; more is stated.
- **Inline edits** use the existing saves: billing override `PUT /billing/ticket`, agreed hours `PUT /ticket-metadata` (a ticket with several developers asks which one; Helpdesk and closed tickets are read-only here). The row and the project's figures are read again afterwards; the drawer's own edits refresh the workspace too.
- **+ Create ticket** opens the usual new-ticket form with this project (and so its client) chosen.
- **Export…**: scope (this project, the selected tickets, every filtered ticket on all pages, or all projects), types **A** project settings & allocations, **B** tickets & billing (hours in each project's scope), **C** billing / work entries for a period (with billing, source, export state and worker filters), as Excel (one sheet each) or CSV (one file each, UTF-8 BOM, CRLF, formula text prefixed with `'`). Stable IDs (Odoo project id, ticket key, revision, exported at) are included so a file can come back in.
- **Import…** (`POST /clients/odoo-projects/import/preview`, then `/import`): an exported file or the **template** (Projects, Tickets and *How to fill* sheets). Columns are matched by header; a blank cell leaves the value unchanged and `[clear]` clears it. Projects: billing default and allocated hours. Tickets: billing override, agreed hours and developer (the agreed-hours developer rule applies), Odoo project. The preview shows each row's current → proposed values, errors, warnings (e.g. already exported charges become adjustments) and the commercial impact; a row changed since the file was exported (revision or project history after *Exported At*) is refused. **Apply** sends only ready rows, each through the existing saves with its own result (applied, partial, failed, not applied, unchanged); **Download report** gives every row's result and **Check the N rows again** previews only those that did not apply. Up to 300 projects and 300 tickets per import. Imports never send email; the scheduled billing check sends any *allocation exhausted* alert once.

### Map tickets

A dialog listing tickets without an Odoo project, with filters **Ready**, **Missing**, **Ambiguous** and **Conflict** and a search over key, title, client and project. Each ticket has a searchable "Client → Project" picker with the same projects as the table (`assignable` rows) and its own **Apply**. The client always comes from the project.

- **Ready**: the ticket's catalog project links exactly one Odoo project that is active and has a client. Only then is it suggested (preselected). Names are never matched.
- **Missing**: no client/project, a project with no Odoo link, or one whose Odoo project is archived or has no client.
- **Ambiguous**: the project links several Odoo projects; they are listed first in the picker, none is chosen.
- **Conflict**: the ticket's work already went to a different Odoo project, or its Odoo project is not among the synced ones. It is mapped only on its own, after a confirm (`resolveConflict`); bulk actions never include it.
- **Apply all ready** sends the ready tickets only. Opened from a project's row, the dialog shows that project and its client; tick tickets (conflicts cannot be ticked) and confirm **Assign N tickets**.
- Every ticket is sent with the revision read when the dialog opened and re-checked under its lock; one changed since, given a project meanwhile, or no longer valid is skipped and the reason shown under it. The dialog stays open, keeps its own list and choices through page refreshes, and asks before closing with choices not applied.
- Saving sets `odooProjectId` and the derived client/project (`epicKey` cleared) with a history entry (who, when, from → to, and whether it was suggested or chosen). Work logs keep their Odoo project; Jira links and Jira project membership are unchanged. `POST /clients/needs-mapping/apply` (administrators) takes `{items:[{key,revision,odooProjectId?,resolveConflict?}]}` (up to 1,000) and returns `{applied,skipped,linked,plan}`.

## API and storage

All routes require the existing authenticated session:

- GET /clients: catalog choices; source provenance is returned only to administrators.
- POST /clients and PUT /clients: administrator add, rename, archive or restore with the current catalog revision.
- POST /clients/import/preview: validate rows and return proposed additions without saving.
- POST /clients/import: apply reviewed rows with the preview revision.
- GET /clients/projects (administrators, capability `project-admin-v1`): every project with its local ID, the Odoo projects it is linked to, its contact and status (mapped, unmapped, conflict, archived).
- GET /clients/odoo/candidates?id= (administrators): unlinked Odoo projects with the same name under the same contact as an unmapped project.
- POST /clients/odoo/link {revision, id, odooId} (administrators): links an unmapped project to one of those candidates. Refused with 400 `not_candidate` for any other Odoo project, and with 409 when the project is already linked or the revision is stale.
- GET /clients/odoo-projects/options: the active Odoo projects a ticket can take (any user). GET /clients/odoo-sync: last successful sync, project snapshot time and last error.
- GET /clients/odoo-projects (administrators): the projects table rows. GET /clients/odoo-projects/details?id=: one project's budget, tickets, pull requests, timesheet lines and history. PUT /clients/odoo-projects/allocation {odooId, hours|null}: saves allocated hours in Odoo and records the change.
- GET /clients/needs-mapping and POST /clients/needs-mapping/apply {keys?} (administrators): the migration check and applying its ready rows.
- GET /epic-map (administrators): Jira epics and the Odoo project each is mapped to. PUT /epic-map {revision, epicKey, entryId|null} saves one mapping and updates its tickets.
- POST /epic-map/sync: brings tickets under mapped epics in line (at most every 10 minutes; administrators may add ?force=1). Tickets with no client, or whose client came from an epic, take the epic's project; a client chosen by hand is kept; completed tickets only get an empty client filled.
- POST /ticket-metadata/batch: read metadata for up to 100 authorized ticket keys.
- GET /ticket-metadata?key=KEY: authorized metadata, filtered history and authoritative closed state.
- PUT /ticket-metadata: body {key, fields:{revision, ...changes}}. Stale revisions and closed tickets return 409.
- POST /reports/run: the unified business report (one row per ticket), with optional start/end dates, clientId, subClientId, source, flag, employee and status filters.
- POST /agreed-hours/import/preview and POST /agreed-hours/import (administrators): bulk-set agreed hours from a CSV with the columns `Ticket,Agreed hours`. A preview checks up to 100 rows without saving. Apply refuses the whole import with `import_errors` if any row has an error, so fix the rows and apply again.

New records are namespaced business:<JIRA_PROJECT>:catalog and business:<JIRA_PROJECT>:ticket:<KEY>. Ticket locks coordinate metadata writes and dashboard transitions. A successful status change is recorded before returning; failed Jira responses do not create successful completion/override events. Jira and Redis are separate services: an infrastructure outage after a Jira write can require checking ticket status before retrying.

## Checks & Reports

Reports run on demand inside the administrator workspace without an AI key. They ignore ordinary list filters; their own client, sub-client, source and period controls define scope. The default period is today and the previous six calendar dates in Asia/Jerusalem.

The report is one row per ticket, with its client, developers, estimated, agreed, logged and actual hours, the overage flag and its Odoo status. Filters: client, employee, flag (Needs checkup, Within agreed hours, No agreed hours), status and period. The period filter selects tickets created or completed in the period. Logged hours are all-time totals per ticket, compared only against logged entries.

The report can be grouped by employee, then customer. Expanding an employee shows each ticket with that person's own hours, and the ticket's total is repeated under each person who worked on it. Work entries for a ticket load on demand from a list inside the report.

**Export CSV** downloads the visible rows as `aion-business-report-<date>.csv`. Every cell is quoted, double quotes are doubled, and values starting with `=`, `+`, `@`, `-`, tab or carriage return get a leading apostrophe. Lines end with CRLF, and an unset agreed or logged value is an empty cell.

**Agreed hours import.** Choose a CSV with `Ticket,Agreed hours`, check the preview, then apply. The import is for setting agreed hours in bulk. It accepts a byte-order mark, quoted cells and CRLF, and refuses a file without those two headers.

**Statistics dashboard.** Above the report results, the dashboard has three tabs. Every chart, card and table reads the same rows: the report filters, then the chart selection. Local interaction makes no backend call. The one exception is dated effort on Team & Delivery, which loads once per period when that tab opens.

- **Overview:** five cards (open tickets now, completed in period, overdue now, logged hours on these tickets, excess above agreement); agreed against logged by client; open-ticket age; the largest overrun contributors; and an exceptions table. Each ticket opens in its drawer.
- **Hours & Agreements:** agreed against logged by client or project, sorted by excess, logged hours or name; an estimate-accuracy scatter (estimated on X, logged on Y, with the dashed Y = X line and a zoom to the 90th percentile of points); an overrun Pareto with the top 10 tickets, an "Other" bar and the cumulative share; and a client and project comparison table.
- **Team & Delivery:** a heatmap of each person's logged hours by client; open work by developer and status; created and completed per week; and dated logged effort per week, grouped by person or client.

**Chart selection.** Choosing a client or project bar, an age bucket or a heatmap cell narrows the table, employee grouping, dashboard and CSV together. Each selection shows as a chip with a remove control, and Clear selection removes them all. Choosing the same item again clears it.

**Definitions.**
- A *matched* ticket has agreed hours above zero and a known logged value. Only matched tickets feed the agreed and logged totals, excess and ratios. Tickets without agreed hours, or with unknown logged hours, are counted apart in each group.
- *Excess* is the sum of logged minus agreed, counting only the tickets over agreement. *Net variance* is the sum of logged minus agreed over all matched tickets. *Logged ÷ agreed* is total logged over total agreed for matched tickets. Usage bands are over agreement, approaching (80% to 100%) and within (under 80%), using unrounded values.
- *Unknown is not zero.* When the work log cannot be read, logged hours are unknown and are never added as zero. A recorded zero means the log has no hours. A card shows "n of N recorded" when some values are unknown.
- *Ticket age* is calendar days from the creation day to the snapshot day in Asia/Jerusalem. Buckets are 0–7, 8–14, 15–30, 31–60 and 61+ days. Missing creation dates, and creation dates after the snapshot, are shown apart.
- *Overdue now* is an open ticket whose due date is before the snapshot day.
- *Completed in period* counts closed tickets with a verified completion date in the period. Closed tickets without one are excluded and disclosed.
- *Created and completed per week* uses Sunday to Saturday weeks in Asia/Jerusalem; the first and last weeks are marked partial when they extend past the period. Completion uses the latest recorded completion only.
- *Estimate accuracy* uses completed tickets with a positive estimated-hours value and known logged hours. The legacy actual-hours field is not used.
- *Employee × client* cells hold each person's own hours from work entries. A ticket's total is never split or repeated per person.
- *Open work by developer* counts assignments from the ai1 developer labels, not time. A shared ticket counts once for each developer and once in the team totals.
- *Dated effort* is the work entries dated in the period on the selected tickets, from the administrator work-entry report (up to 400 days). Agreed billing lines are excluded.

**Limits.** Logged hours on the cards and tables are all-time totals per ticket, not hours worked during the period. Only dated effort is shown by week. Estimates are the ticket's estimated-hours field.

Missing hours are reported as missing, not silently treated as zero. Completion uses authoritative Jira resolution/history or dashboard/internal completion records. Updated is never substituted for Completed. Bounded or failed Jira pagination is disclosed as partial coverage.

Saved reports are stored under the `reports:all:v2:` key. A report saved before this change must be refreshed to show the new columns.

## Claude

The existing Anthropic adapter is reused. Configure AI_VENDOR=anthropic, ANTHROPIC_API_KEY and AI_MODEL on the proxy using a model available to the account. Do not place the API key in frontend code. Without credentials, checks and reports still work; AI stays unavailable.

Chat adds search_internal_tickets and authorized business fields in read_issue. Administrators also receive run_dashboard_report. Billing is filtered before ordinary-user model input. No AI write tools are enabled. Ask AION AI to explain a completeness, risk, hours or management report to generate a narrative from calculated results. Reports disclose limited detail returned to the model. Internal ticket briefs remain outside the brief endpoint; internal ticket chat is supported.

Scheduled delivery, email reports, automatic ticket changes, a third Project field, and dated per-user time entries are intentionally outside this release.

## Verification

Run npm test and npm run test:e2e. The browser tests cover the database and monitor pages; the dashboard browser spec was removed. Tests use synthetic accounts, tickets, catalog files and AI responses and do not write to production. Live Claude credentials, deployment, and the real catalog import are activation steps after local verification.

## Assignment and scheduling prerequisites

Administrators must choose Billable or Not billable before creating/assigning an internal ticket or changing Jira/internal developer or assignee assignments. Both server routes and the guided assignment dialog enforce this; users never receive the billing value. Existing assigned tickets are not migrated automatically.

Users must save positive estimated hours before setting an initial date, submitting a date-change request, or revising one. The date dialog offers an estimate-first form. Withdrawal and notification retries remain available without an estimate, and administrator date decisions retain their existing behavior. These prerequisites apply to Jira and internal tickets; the upstream Odoo Helpdesk workflow is preserved.

The list defaults to Work view, which prioritizes identity, client, status, dates and work fields. All columns restores the complete list; the preference is saved per account. Related fields are grouped in the drawer and completion indicators show what remains before closing.
