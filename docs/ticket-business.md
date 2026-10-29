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

**Agreed hours** are also administrator-only: they are stripped from ordinary users' responses. An administrator sets them in the ticket drawer, under "Agreed hours (administrators only)". The value must be a valid positive number of hours. It is written to the ticket's history. Clearing agreed hours is refused with 409 `agreed_sent` once the ticket's agreed line is in Odoo. Setting them needs a non-internal assignee first (409 `agreed_needs_developer`, "Assign a developer first."). While agreed hours are set, people's Odoo entries are replaced by one agreed line per ticket; see [work-log.md](work-log.md).

**Overage flag.** The flag is computed when the ticket is read, not stored. When logged hours are more than agreed hours, the ticket shows **Needs checkup** in the drawer, on the board card and in the report. Only logged entries are compared, and the amount over (`overHours`) is shown to administrators only.

All dashboard transitions into a completed status require client selection, estimated hours, actual hours and Work done. Administrators can override missing requirements with a recorded reason. The same server guard protects drawer, board, bulk and direct API calls. Bulk actions report per-ticket failures. Closing directly in Jira bypasses dashboard validation; the next authoritative read locks the business fields. Created date always uses the original ticket timestamp and displays in Asia/Jerusalem time.

## API and storage

All routes require the existing authenticated session:

- GET /clients: catalog choices; source provenance is returned only to administrators.
- POST /clients and PUT /clients: administrator add, rename, archive or restore with the current catalog revision.
- POST /clients/import/preview: validate rows and return proposed additions without saving.
- POST /clients/import: apply reviewed rows with the preview revision.
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

**Insights** sits above the report results and describes the same rows the filters select. Its tiles give tickets (total, open, closed, with and without agreed hours), checkups and the checkup rate (flagged tickets as a share of tickets with agreed hours), agreed hours, logged hours on those tickets, the burn rate (logged as a share of agreed on those tickets), and total logged, estimated and actual hours. Bars show logged against agreed in four bands (under 50%, 50–79%, 80–100%, over 100%), flags, logged hours by employee and by client, billing, and Odoo status. A table counts tickets created and completed by month. A rate is shown as "—" when its denominator is zero. Logged hours are all-time totals per ticket, so the bars do not show hours by month. The statistics are calculated in the browser from the saved report, so they update with the filters and need no extra backend call.

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
