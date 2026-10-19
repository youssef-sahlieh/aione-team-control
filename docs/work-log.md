# Work log → Odoo timesheets

People log time on Jira, internal and Odoo Helpdesk tickets with **Log work** (in the ticket). Each entry
(work date, duration in minutes, description) becomes one Odoo timesheet line, in one Odoo task per ticket
(`[KEY] Ticket title`) on the ticket's Odoo project. It is **off** until an administrator switches it on.

## What it does

- **Form:** ticket and user (read-only), work date (today in Israel time; earlier dates are allowed, future
  dates and dates in Odoo's lock are not), duration from 1 minute to 24 hours (shortcuts 15m / 30m / 1h / 2h),
  and a required description. It shows the Odoo project and task the work goes to. **Save**, or
  **Save and add another**.
- **Statuses:** Syncing, Synced, Needs setup (e.g. the ticket has no client or project), Needs review (an
  administrator must reconcile).
- **Work log** in the ticket lists every entry: date, user, duration, description and status.
- **Actual hours** = the hours entered before the work log (kept as they are) + the logged entries.
- **Corrections:** administrators only, with a required reason. The Odoo line is updated, and every revision is
  kept. There is no delete or reassign in this release.
- **Closed tickets** take no new work and no corrections: reopen first.
- **Closing** (Jira, internal and Odoo Helpdesk) is blocked until every entry and correction is in Odoo,
  confirmed by one Odoo read. The administrator override can't skip this.
- **Work log page:** a dated report by user, client, project, ticket, source and status, with logged,
  confirmed and pending hours. The hours entered before the work log are shown separately. Users see their
  own work; administrators see everyone's and have the **Setup** tab.

## Safety of sending

- An entry and its "waiting to sync" state are saved together, in one database step.
- The browser sends an id with each entry, so saving twice (a retry after a lost answer) logs the work once.
- Before each Odoo create, a "being sent" marker is saved, and Odoo is always searched by the entry's id first.
- If Odoo doesn't answer, the create is **never sent blindly again**. One exact match is linked. No match, or
  more than one match, goes to **Needs review**. An administrator can then check Odoo again, send it again, or
  link it to an existing line.
- The same rules apply to the ticket's task. Sends are one at a time per entry and per ticket task.

## Odoo preparation (no module is installed)

Create these **custom text fields** (Settings → Technical → Fields, or Studio):

| Model | Field | Holds |
|---|---|---|
| Timesheet line (`account.analytic.line`) | the existing **Users** field | the name of the person who did the work |
| Timesheet line | e.g. `x_aione_entry_uuid` | the work entry's unique id |
| Timesheet line | e.g. `x_aione_user_uuid` | the person's stable dashboard id |
| Timesheet line | e.g. `x_aione_ticket_ref` | source and ticket, like `jira:AION-12` |
| Task (`project.task`) | e.g. `x_aione_ticket_ref` | `aione:jira:AION-12` (links the ticket's one task) |

Lines are created with Odoo's own defaults: the employee of the Odoo user the dashboard signs in as, in that
user's company. That user needs **exactly one active employee** in its company, otherwise logging can't be
switched on. There is no per-person employee mapping. The real person is in **Users**.

## Switching it on

1. Set `TIME_SYNC_SECRET` (at least 24 random characters) in Vercel → Environment Variables. Set the same
   value as a GitHub repository secret named `TIME_SYNC_SECRET`. The **Work log sync to Odoo** workflow then
   calls the proxy every 5 minutes (`POST /cron/time-sync` with `Authorization: Bearer <secret>`). The same
   call can instead run from your own server's cron.
2. **Test on a test Odoo first:** point a preview deployment's `ODOO_*` settings at the test database. Open
   **Work log → Setup**, check the fields it found and the employee and company it reports, and log a few
   synthetic entries, including a correction and a ticket close.
3. On production: Setup → choose the fields, map clients that have no project (and an optional default
   project for Helpdesk tickets without one), choose **Pilot group**, pick a few people, and save. Odoo checks
   everything before it saves.
4. When the pilot is happy, switch to **Everyone**.

## Routes

`GET /time-entries?ticket=KEY` · `POST /time-entries` · `PATCH /time-entries/:id` (administrators) ·
`POST /time-entries/:id/sync` (retry; administrators: check / resend / link) · `GET /time-entries/report` ·
`GET|PUT /time-entries/setup` (administrators) · `POST /cron/time-sync` (scheduler secret).
