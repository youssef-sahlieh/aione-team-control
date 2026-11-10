# Billable work, customer hour allowances and renewal alerts

Administrators only. Behind the `billing-v1` capability and two switches: **Billing classification** (in Billing setup)
and **Allocation-exhausted emails** (Off / Dry run / On, in Billing setup, plus the server setting
`BILLING_ALERT_MAIL=on`). It is off until an administrator turns it on.

## Classification

- **Project default** (Clients page, in a project's details): Billable, Not billable, or not set (Unclassified).
- **Ticket override** (in the ticket, section "Billing (administrators only)"): Inherit, Billable or Not billable.
  An explicit override wins; Inherit takes the project default. New tickets start on Inherit, so they follow the project unless someone changes them. The ticket shows the effective value and where it
  comes from (ticket, project, or not classified). This works the same for Jira, internal and Odoo Helpdesk tickets.
  For Jira and internal tickets the override is the existing `billing` business field. For Helpdesk tickets it is
  kept in the billing store.
- **Odoo fields** are discovered with `fields_get` on `project.project` and `project.task`. Only stored, editable
  boolean or selection fields that look like billing fields are offered: custom `x_` fields, or "bill" in the name
  or label. For a selection field, each Odoo value is mapped to Inherit / Billable / Not billable. Nothing is
  created in Odoo. When no field is chosen, classification lives only in the dashboard ("Not saved in Odoo").
  A value changed directly in Odoo is reported by the billing check and never copied over.

## Consumption

Everything is counted in whole minutes.

- A billable ticket with **agreed hours** consumes them once, on the day they were first set.
- A billable ticket without agreed hours consumes its billable work entries, each on its work date.
- Non-billable and unclassified work consumes nothing. Unclassified work is shown, and it blocks finalizing an export.
- Every change to what a ticket consumes is an add / change / remove event in its ledger, with who, when and why.

## Allowances

Kinds: Commercial package, Internal estimate, Fixed-fee budget, Unlimited time & materials, No allocation.

- An allowance covers one project or a shared pool of projects, from a start date (the cutover). It has an
  opening balance for the hours used before that date.
- **Top-ups** need either an Odoo sales order line, which is checked to be confirmed, or an explicit confirmation
  with a reference.
- **Overage** carries forward: a top-up first pays back what was over.
- A billable ticket in a project that is not billable consumes an allowance only when it is assigned to one.

## The "allocated hours exhausted" alert

- **One event per allowance and cycle:** created with `setIfAbsent`, so it is never created twice.
- **Delivery:** the email waits in a durable queue. Each attempt is recorded. A send whose result is unknown is
  marked **Delivery uncertain** and is never retried automatically: an administrator settles it with
  "It was sent" or "It was not sent", or sends it again after a warning.
- **Next cycle:** a confirmed top-up that restores capacity starts the next cycle (re-arm).
- **Backlog:** an allowance already exhausted the first time it is seen is marked *Backlog (not sent)*. No email
  goes for it unless an administrator sends it.
- **Recipients:** `NO_DEVELOPER_NOTIFY_TO`, the server setting new-ticket alerts already use. It is validated the
  same way: at most 20 recipients, each a valid `@MAIL_DOMAIN` address. Recipients are never set in the frontend.
  Mail goes through the existing mail service.
- **Subject:** `[AION] Allocated hours exhausted — <Customer> / <Project>`.
- **Body:** "All allocated hours have been consumed. Please prepare a new sales quotation for this customer."
  It also contains the allocated, consumed and over figures, the time, a link to the project and a **Prepare
  quotation** link. That link only opens Odoo's quotations: nothing is created.
- **Modes:** Off, or Dry run (recorded, never sent). Emails are On only when Billing setup says On, the
  deployment has `BILLING_ALERT_MAIL=on`, and the recipients are valid.

## Billing check (scheduled)

`POST /cron/billing-scan`, every 15 minutes from [.github/workflows/billing-scan.yml](../.github/workflows/billing-scan.yml),
authenticated with `Bearer TIME_SYNC_SECRET`. One run at a time (lock). Each run is bounded:

- it reconciles ticket ledgers in turns, using half the time budget at most;
- it reads Odoo timesheet lines of the billing projects in pages of 500, at most 20 pages, and marks the read
  incomplete when there are more;
- it evaluates the allowances and works through the mail queue until the time budget runs out.

Administrators can run the same check with **Check Odoo now** in Billing setup.

The check reports:

- Odoo lines entered directly in Odoo. An administrator logs them in the dashboard or acknowledges them.
- Lines changed in Odoo.
- Duplicate lines, and agreed-hours tickets that also have their own lines.
- Classification differences between Odoo and the dashboard.

## Billable export

Clients page → More → **Billable export**.

- **Filters:** dates (Asia/Jerusalem), billing, export state, customer, project, source and coverage.
- **Views:** a task summary and the entry detail, each downloadable as CSV (UTF-8 BOM, CRLF). Text that a
  spreadsheet would run as a formula is prefixed with an apostrophe.
- **Finalize** saves a batch:
  - Every charge in it is recorded as exported with its minutes.
  - A later preview shows only new charges, plus corrections as **adjustments** (the difference).
  - A finalized charge is never charged again.
- **Blocked:** finalizing is blocked while the preview has exceptions (unclassified work, Odoo lines entered
  directly, unreconciled or duplicate lines). It is also blocked when the data changed since the preview: the
  fingerprint differs.
- **Batches:** earlier batches stay downloadable.

## Project billing workspace

The expanded row of a project on the Clients page lists its tickets with actual and commercial hours, billing overrides
and sync problems, and exports and imports project defaults, allocations and ticket billing fields (details in
[ticket-business.md](ticket-business.md#project-billing-workspace-billing-v1)). It keeps no figures of its own: imports
and inline edits call the same saves as the rest of the dashboard (`saveProjectDefault`, `saveAllocation`,
`saveTicket`, `saveMetadata`), so revisions, histories, ledgers and Odoo pushes apply unchanged, and work entries,
consumption and export markers are never written. Its routes (`/clients/odoo-projects/tickets`,
`/clients/odoo-projects/import/preview`, `/clients/odoo-projects/import`) need an administrator session.

## Visibility

Every `/billing/*` route needs an administrator session. The billing columns on the Clients page, the ticket
section, histories and exports are shown to administrators only. The AI assistant keeps its existing rule: a
ticket's billing field goes to it for administrators only. Allowance, consumption and alert figures are not given to it.

## Rollout

1. Deploy with emails Off; the `billing-v1` capability appears for administrators.
2. **Billing setup → Preview switching on:** shows the ticket overrides already set, the projects classified and
   still unclassified, and the last 90 days of work by classification. Nothing is changed.
3. Set the project defaults (Clients page), optionally map the Odoo fields, and create the allowances with their
   start date and opening balance.
4. Turn on classification, and set emails to **Dry run**. Watch the alerts list: allowances already exhausted
   show as *Backlog* and are never emailed on their own.
5. When the dry run looks right: set `BILLING_ALERT_MAIL=on` in Vercel, check that `NO_DEVELOPER_NOTIFY_TO` is
   correct, and set emails to **On** in Billing setup. Turning emails on asks for confirmation and names the
   recipients.
6. Add the repository secret `TIME_SYNC_SECRET`, if it is not there yet, for the scheduled check.
