# AION Reporting V2 — implementation plan

Draft dated 18 October 2026. Confirmed preferences: the user has both Claude Pro and ChatGPT Pro; support both for interactive AI analysis; all reporting areas including Odoo, databases and deployment health. Baseline: main commit 5ce751a. This is a plan, not an implemented release.

## Current implementation decision

The user now prefers a **free hosted AI API** that works when their computer is off. Integrate Groq Free-plan access with openai/gpt-oss-120b into the existing server-side AI/report tools. Use a server-only GROQ_API_KEY, explicit AI_VENDOR=groq, quota handling and an inference-call cap; do not fall back to paid providers. See [activation details](free-hosted-ai.md). Claude Pro and ChatGPT Pro remain available for optional future MCP clients, not the primary dependency for the deployed reporting assistant. This provider integration does not by itself implement the remaining Reporting V2 data/history/UI work.

## 1. Objective

Create one reporting service for Jira, internal work, Odoo Helpdesk, client/sub-client work, GitHub delivery, database health, and integration failures. The dashboard and Claude must read the same calculated facts. Every important total must drill down to its contributing records.

Optional subscription AI experience: interactive analysis inside the user's existing Claude Pro and ChatGPT Pro accounts through compatible read-only AION MCP connectors. Both clients consume the same authorized report service and verified calculations. Claude API narratives require separate Console/API setup; Claude Pro is not listed as eligible for included API credits in the current official eligibility table. For ChatGPT-backed dashboard requests, verify eligibility and integration requirements before choosing a subscription-backed Sign in with ChatGPT flow or a separately configured API adapter. Neither subscription is assumed to provide unattended reporting automatically.

## 2. Verified starting point

- Existing reports: completeness, delivery risk, estimate/actual review, management summary; administrator-only; Jira and internal tickets; on-demand CSV export.
- Reports currently perform bounded live source reads. There is no saved report history or reliable trend store. Odoo Helpdesk is not included in the management report service.
- Existing Claude integration: server-side Anthropic adapter, authenticated read tools, rate limits, citations, internal/Jira access, deterministic report summaries. It does not yet expose a Claude-account connector or unified operational sources.
- Separate database reporting already reads customer company names from inside databases and supports cached refresh and a daily cron. GitHub PR links/checks, ticket history, Sync errors and integration-key health now exist on main.
- Local ticket history stores at most 300 events per ticket and is best-effort. It cannot by itself prove complete historical throughput or audit retention.
- The newest main makes client selection optional and billing enforcement configurable. Documentation contains older statements; implementation must reconcile documentation with current code.
- The inline business-field edits, assignment-to-development behavior and first-save user estimate lock from our previous sessions are preserved in stash 182aed5. They are not active on current main. Reconcile their patches deliberately in the first implementation phase; do not restore older files wholesale over newer main.

## 3. Reporting products

| Report | Required output |
| --- | --- |
| Management overview | Open backlog, new/completed/reopened tickets, overdue work, changes versus prior comparable period, top risks and required decisions |
| Delivery and deadlines | Overdue tickets, missing approved dates, due soon, stale activity, time in stage, due-date changes, approval waiting time |
| Developer workload | Assigned work, priority/status distribution, age, unestimated work, known ticket-total estimates; capacity only when configured |
| Client/Sub-client | Open and completed work, estimated/actual ticket totals, overruns, billable/nonbillable/unclassified work; Unmapped group remains explicit |
| Hours and estimates | Estimate versus actual, difference, percentage over, missing values and coverage; no invented period effort |
| Process and quality | Missing fields, override reasons, reopened work, locked-estimate corrections, due-date requests and approval exceptions |
| GitHub delivery | Ticket-linked PRs, reviews waiting, failed checks, merge lead time; deployment status only if an authoritative deployment feed is available |
| Odoo/database operations | Helpdesk backlog, company/database inventory, access failures, version distribution, expiry and last-observed activity |
| Integration and sync health | Last successful sync, freshness, failures, retry outcome, key validity and known expiry; Unknown when providers do not expose expiry |

Administrators get management, client/billing and operational reports. Ordinary users get a separate My work report for authorized tickets only. Do not broaden developer access to database infrastructure or management totals.

## 4. Data model and source collection

Add source adapters for Jira, internal tickets, Odoo Helpdesk, GitHub, database reports and integration health. Each adapter returns source identity, original ID/key, timestamps, normalized facts, permissions/provenance, pagination coverage and freshness.

Canonical identity includes environment, source, configured project/team and original record ID. Use explicit links between Jira/Odoo/PR records. Do not merge tickets by similar title. A linked item group must have an explicit counting policy so management totals do not silently double-count mirrored work.

Retain original statuses and map them separately to reporting phases: Open, Ready, In Development, Review, Done and Cancelled. Dev Approved is a ready phase unless configuration says otherwise. Reporting mappings never mutate source status.

Use incremental collection with cursors, bounded pages, retries/backoff and deletion/access-loss handling. Prefer webhook updates where the source supports them, but retain scheduled reconciliation. Job steps must fit the existing 60-second proxy limit; persist cursors and resume longer work in background jobs.

Keep Redis for existing operational metadata and short-lived cache/locks. Recommended historical store: private managed PostgreSQL for normalized reporting records, append-only reporting events, daily snapshots, report runs, saved definitions, schedules and delivery results. Confirm hosting and storage cost before provisioning. Do not introduce a database migration for existing dashboard data merely to produce the first live reports.

Suggested tables: reporting_items, reporting_links, reporting_events, daily_snapshots, source_sync_runs, report_definitions, report_runs, report_artifacts, report_schedules, report_deliveries and ai_usage. Secrets remain in server secret storage, never reporting tables or artifacts.

## 5. Metric definitions

All counts and arithmetic are application code with versioned definitions. Claude explains results and proposes questions; it never decides validation or computes authoritative totals.

- Timezone: Asia/Jerusalem. Store instants in UTC and evaluate local date boundaries with timezone-aware logic, including daylight saving.
- Created: original source creation instant. Completed: verified transition/resolution/closure event. Updated is not a completion date.
- Period default: last seven completed local calendar days. Offer today, current week, previous week, month and custom dates.
- Report history distinguishes the ticket state observed at the cutoff from later corrections. Save immutable input/cutoff references and calculation version for each published run.
- Current hours remain ticket totals. Label them as current totals on the selected ticket cohort. Daily snapshots can show changes in recorded totals after collection starts; those changes are not proof of when work occurred.
- Accurate hours worked per day/week, per-user effort and invoices require dated, attributable time entries. Those are a separately approved timesheet extension, not part of this reporting release.
- Missing values remain Unknown/Not set. State how much of a total is known. An empty result is not proof that a failed source has no work.
- A shared ticket counts once in company/client totals. In developer views, label shared assignments and do not duplicate the full estimate into summed team capacity. Individual effort remains unavailable without attribution.
- Billable totals are classified ticket hours, not revenue, profit, invoices or amounts due. Monetary reports require separately defined rates and invoice/accounting sources.
- Trend charts begin when reliable history begins. Backfill only facts supported by authoritative source history; mark gaps rather than inventing prior snapshots.

## 6. Dashboard experience

Expand Checks & Reports into a single Reports area with Overview, Delivery, People, Clients & Hours, Quality, Operations, Saved reports and History.

Common controls: period, comparison period, source, client/sub-client, developer, assignee, status phase and priority. Billing controls appear only to admins. Report filters are explicit and independent from the ticket-list filters unless the user deliberately opens Report this view.

Each report contains summary cards, a small number of useful charts, a sortable findings table and links to relevant tickets/PRs/databases. Add saved views, configurable columns, report run history and comparisons based on compatible coverage.

Show generated time, data cutoff, per-source last sync, examined/included/excluded counts, metric definitions, missing values and Complete/Partial/Failed state. Unknown datasets and uncertain health must stay visible.

Exports: structured CSV first, then formatted XLSX and PDF. Include filter scope, generation time, completeness and definitions. Use spreadsheet-safe text. Store files privately with authorization on download and expiring links.

## 7. Claude Pro and ChatGPT Pro connections

Build a shared read-only remote MCP service for AION Reports, with connector registration/authentication compatible with both Claude and ChatGPT. Authenticate each person through the existing AION identity using a proper OAuth authorization flow, with revocable scoped credentials. Do not reuse a shared administrator secret for all Claude users.

Proposed tools: list_report_definitions, get_report, compare_reports, search_report_tickets, get_ticket_evidence and get_source_health. Operational tools are administrator-only. Every call rechecks the account's current permissions and returns bounded structured results plus coverage, run IDs and verified citations. Report tools do not change tickets, send email or trigger deployments.

Users add AION Reports as a custom connector in Claude and a custom MCP plugin in ChatGPT, sign in to AION separately from each client, and ask questions there. Verify account/workspace access during activation. Use separate OAuth client registrations/grants where required, so either connection can be revoked independently. The reachable HTTPS MCP endpoint is hosted server-side; do not assume a localhost-only dashboard can serve either remote client.

For optional AI narratives inside AION or scheduled generation, reuse the existing Anthropic API adapter. Configure a separate server-side provider key and a currently supported model available to the API account. The confirmed Claude plan is Pro, which is not eligible for the currently documented Max/Team included API credits. Keep this paid API extension off by default. Connecting either client to the AION MCP server does not automatically configure an unattended dashboard API. Keep the existing model adapters separate from connector authentication.

AI report format: executive summary; what changed; delivery risks; client/hour exceptions; requested management decisions; evidence and limitations. Every numeric statement references calculated report facts. Save model/prompt version, report-run reference, generation time and token usage. Keep the deterministic report usable if AI is unavailable.

Provide per-run token limits, per-account/workspace budgets, caching tied to report version, administrative cost visibility, graceful rate-limit/credit errors and a kill switch. Do not store subscription passwords, browser session cookies or copied Claude login tokens.

## 8. Privacy and authorization

One server-side authorization layer protects dashboard, API, exports, cached reports and MCP. Recheck permissions at read/download time and schedule execution time. Removal, role changes and revoked access invalidate future report/connector access.

Ordinary-user projections omit billing entirely, including AI context, exports, report history and error details. Do not allow aggregates or comparisons to reveal other developers' private data. Cache keys include authorized scope; never serve an administrator result to a user.

Operational database adapters export only approved summary fields. Existing connection credentials, Knowledge-article secrets, raw infrastructure configuration and integration tokens must never reach Claude or report exports. Ticket descriptions and external text are untrusted evidence, never instructions to the model.

## 9. Scheduled checks and delivery

First implement administrator Run now and save report history. Then add configurable scheduled runs. Suggested defaults, pending confirmation: a daily 08:30 management digest on working days and a Sunday 08:30 weekly summary. Compute next runs in Asia/Jerusalem; do not assume a fixed UTC offset.

Support dashboard inbox first, then email after recipient configuration. Keep automated ticket edits out of scope. Use durable jobs, idempotency keys, owner/recipient permission checks, delivery retries, failure visibility and duplicate prevention. Full-data failure never produces a reassuring green report. Partial reports carry a prominent label; define whether scheduled delivery is suppressed or sent as a partial-data alert.

## 10. Implementation phases and completion criteria

1. Baseline reconciliation: branch from current main; selectively recover authorized local changes from stash; preserve newer optional-client, billing toggle, ticket history, Odoo sync and mobile improvements. Update outdated documentation and add regression cases for the combined behavior.
2. Reporting core: metric registry, normalized source interfaces, per-source coverage/freshness and unified Jira/internal/Odoo live reporting. Complete when totals reconcile to source fixtures and drill-downs.
3. History and background collection: private historical store, resumable sync jobs, append-only events, daily snapshots and report run persistence. Complete when replay/idempotency, partial syncs, corrections and gaps are handled accurately.
4. Dashboard: report pages, filters, comparison, saved views, private CSV exports; then XLSX/PDF. Complete when desktop/mobile/keyboard access and permissions pass.
5. Claude Pro and ChatGPT Pro: implement and authenticate both MCP connections against the shared deterministic reporting service. Validate administrator/developer scope, cross-source questions and citations independently in both clients. Compare the same saved weekly-management, client/hour-overrun and Odoo/database-health report runs for factual accuracy, evidence coverage, practical usefulness and unsupported claims. Choose the preferred client from these results; do not duplicate calculations or automatically send every report to both. This can proceed in parallel with phase 4 once report APIs stabilize. Dashboard API narratives remain optional and disabled by default.
6. Automation: schedules, private artifacts, dashboard inbox and configured email delivery. Complete when timezone/DST, retries, revoked access and duplicate delivery tests pass.
7. Rollout: local synthetic preview, automated tests, staging pilot with one admin and one developer, backend/schema before frontend, connector activation and monitored production release. Provisioning, production deployment and recipient activation occur only when authorized for implementation.

Deliver phases 1–4 before presenting historical trend claims. Connector development may proceed once the authenticated report APIs stabilize. Do not wait for AI configuration to ship accurate deterministic reports.

## 11. Required verification

- Counts reconcile across Jira/internal/Odoo, including linked records and shared developers.
- Optional/unmapped clients and unclassified billing remain explicit; reporting does not change ticket validation settings.
- Period boundaries, DST, reopening and original creation/completion dates work correctly.
- Missing hours, absent completion history, stale sources and failed/limited pagination never become invented zeroes or complete totals.
- Immutable reports preserve their cutoff and definition version; corrections create a new run.
- Users cannot access billing, other users' rows, administrator exports or operational secrets through any route, cache, AI context or connector.
- Disabled accounts and revoked tokens lose access. Scheduled jobs stop when ownership/scope is invalid.
- Neither Claude nor ChatGPT can execute writes, invent count inputs, resolve unauthorized citation links or follow malicious ticket instructions. Test per-client revocation, role changes and isolation between cached administrator/user results.
- Export formulas are neutralized; downloads require authorization; delivery is idempotent.
- Existing assignments, date approvals, internal notes, notifications, saved views, audit/deployment screens and database reports continue working.
- Run repository backend/frontend tests, mocked browser suites and local integration tests; live provider verification only after secure credential setup.

## 12. Remaining inputs

Confirmed: both Claude Pro and ChatGPT Pro; interactive reporting available in both; all proposed reports including Odoo/database/deployment health. Remaining inputs: working days/delivery time, report language, named recipients and historical storage provisioning. Implement broad source coverage first, then deepen historical metrics and scheduled delivery. Defaults remain proposals until those preferences are supplied.

No revenue report, individual productivity ranking, automatic ticket mutation, inferred timesheets, public customer catalog or invented historical backfill is included.

## Official integration references checked for this plan

- Custom connectors / remote MCP: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- API versus paid chat plan: https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-is-claude-api-usage-billed-separately-from-my-paid-claude-plan
- Included API credits and plan eligibility: https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers
- ChatGPT custom MCP plugins: https://developers.openai.com/api/docs/guides/custom-mcp-server
- Sign in with ChatGPT and eligible plan usage: https://developers.openai.com/siwc/quickstart

Verify eligibility, models and provider terms again when activating the connection; the user has confirmed Claude Pro and ChatGPT Pro.

## Local AI enhancement review — 2026-10-18

Implemented for local review: administrator Report Studio with four editable prompt drafts (management, delivery, hours and completeness), 7/14/30-day periods including today in Asia/Jerusalem, optional narrative focus, and explicit scope guidance. Choosing a preset does not call a provider. AI reporting instructions now require authoritative calculated totals, evidence-backed findings, suggested actions distinguished from facts, and disclosure of missing source coverage or omitted detail. Report tool evidence includes generation time, status, developers, due dates and last activity where available.

The isolated preview runs the existing authenticated report engine over synthetic Jira/internal records and labels its deterministic responses as demo output. It requires no API key and does not call a live model. Use `npm run preview:approvals` and open `http://localhost:3100/preview/admin`; this review session runs separately at port 3101.

This increment does not implement saved report-run history, scheduled delivery, comparison snapshots, MCP access, or unified Odoo/database/deployment reporting. Free hosted inference is integrated but still requires server-only Groq configuration and a separate deployment. Focus guides narrative analysis; it does not change the existing report tool's scope or totals.

## Combined reports — 2026-10-19

Implemented one administrator report snapshot containing all retrieved Jira/internal records, with local report-type, developer, client/sub-client, source, status, billing, date and text filters. Default is source order without an additional sort. Totals and CSV follow the filters; sorting is explicit; ticket and group rendering is paginated. Filter changes make no API/AI calls. See [combined-reports.md](combined-reports.md) for scope, performance limits and the reports-all-v1 backend rollout requirement.

Saved-report refinement: Reports now opens GET `/reports/latest` automatically and reuses a private server snapshot across visits. No Run action is needed. The first missing snapshot is generated automatically; subsequent source refreshes are explicit through Refresh report. Older data is labelled and partial refreshes preserve a previous complete report. Production requires the reports-saved-v1 backend capability.
