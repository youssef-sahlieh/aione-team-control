# Work log → Odoo timesheets

People log time on Jira, internal and Odoo Helpdesk tickets with **Log work** (in the ticket). Each entry
(work date, duration in minutes, description) becomes one Odoo timesheet line, in one Odoo task per ticket
(`[KEY] Ticket title`) on the ticket's Odoo project. It is **off** until an administrator switches it on.

## What it does

- **Form:** ticket and user (read-only), work date (today in Israel time; earlier dates are allowed, future
  dates and dates in Odoo's lock are not), **duration** as one H:MM field, and a required description. Type
  `1:30` (or decimal hours, `1.5`, which is read exactly). Shortcuts 0:15 / 0:30 / 1:00 / 2:00 set the total.
  The field is checked when you save: from 0:01 to 24:00, minutes 00–59. It shows the Odoo project ("Client →
  Project") and task the work goes to, from the ticket's Odoo project. When the ticket's project changed, earlier
  entries stay where they were sent; only new entries go to the current project. **Save work**, or **Save & add
  another**.
- **Durations:** whole minutes everywhere (the API takes minutes). Decimal hours are rounded to the nearest minute,
  half up (`1.0083` h = 60.498 min → 1:00; `1.0084` h → 1:01). More than 4 decimals are refused, not rounded.
- **Timer (on a ticket):** one timer per person, kept on the server, so closing the page does not stop it.
  Lifecycle: **Running** → **Paused** (Pause / Resume) → **Stopped · not logged yet** (Stop) → **Logged** (Log time)
  or **Discarded**. A stopped timer blocks a new one until it is logged or discarded. The clock in the browser
  only adds the seconds since the server answered; the server computes the elapsed time. The completion form
  suggests the elapsed time rounded to the nearest minute, half up (29 s → 0 min, 30 s → 1 min); under one minute
  it asks for the duration instead. Saving the form logs the entry with the timer's id, so a repeated save logs
  the work once. A timer started on one day and stopped on a later day is flagged, and its work date is the day
  it started.
- **Native Odoo timer: not used.** Odoo's own timer control (its "Start" button on a timesheet) is not connected to
  this page. The timer here is the dashboard's own, stored on the proxy. Its time reaches Odoo only as a timesheet
  line when you log it. Nothing has been verified against Odoo's own timer.
- **AI help (optional, never saves or submits):** **Improve writing** rewrites the description you typed (spelling,
  grammar, same facts and language). **Suggest work description** drafts one from the ticket's title, description,
  status, recent comments and history, and marks it `limited` when the evidence only shows a request. Both show a
  proposal under the field with **Apply** and **Cancel**; the text stays as it was until you apply it. Ticket
  text is treated as untrusted data. Pull requests and commits are not read, so a suggestion never reports a merge,
  test run or deployment that the ticket does not state. A failure never blocks saving.
- **Statuses:** Syncing, Synced, Needs setup (e.g. the ticket has no client or project), Needs review (an
  administrator must reconcile).
- **Work log** in the ticket lists every entry: date, user, duration, description and status.
- **Actual hours** = the hours entered before the work log (kept as they are) + the logged entries.
- **Agreed hours** (set by an administrator on the ticket, see [ticket-business.md](ticket-business.md)): while they
  are set, people's entries are saved but **not sent to Odoo one by one**. Instead the ticket has one Odoo line,
  with the ticket's developer in **Users** (one of its Developers, never its assignee or the person saving; see
  [ticket-business.md](ticket-business.md)), the day the agreed hours were first set as its date, and the agreed
  hours as its duration (its uuid is `agreed:<KEY>`). Changing the agreed hours updates that same line and keeps
  its date. Closing the ticket requires the agreed line to be in Odoo. Setting agreed hours on a ticket that
  already has entries in Odoo shows a warning with how many there are; those lines stay as they are.
- **Corrections:** administrators only, with a required reason. The Odoo line is updated, and every revision is
  kept. There is no delete or reassign in this release.
- **Closed tickets** take no new work and no corrections: reopen first.
- **Closing** (Jira, internal and Odoo Helpdesk) is blocked until every entry and correction is in Odoo,
  confirmed by one Odoo read. The administrator override can't skip this.
- **Work log page:** the overview of logged work, one row per entry: work date, person, client, project,
  ticket or task (linked), description, H:MM duration, sync status
  and **Open in Odoo**. Dashboard entries, direct Odoo entries, native Odoo tasks and "No task." entries are all
  listed once; a synced entry is matched by its entry id and Odoo line id, never by description or duration.
  The worker is the mapped Users field, not the integration employee.
  - Filters default to **This month** (Israel time). Other periods: Last month, Last 30 days, Custom (both dates
    inclusive) and All dates. Search, person, client, project, sync status and grouping by
    day, person, client or project. The period filters by work date; filtering happens before paging, and the
    totals and CSV export cover every matching entry, not only the page shown.
  - Users see only their own logged hours and sync status. Billing (the billing column, billable totals, the billable
    filter and the billing CSV columns) is administrators-only, enforced by the server rather than only hidden in the page.
    Administrators see everyone's work and the billing fields. Corrections keep their existing permissions and audit.  - Agreed-hours accounting lines are shown in their own card (administrators only), never as work sessions.
  - Filters are remembered in the browser. If Odoo cannot be read, the page shows an error rather than partial totals.
  - Administrators also get **Work log settings** (setup, mappings and permissions). Opening it changes nothing;
    the saved setup stays as it is until it is saved.
  - Routes: `GET /time-entries/overview` and `GET /time-entries/overview/export` (CSV).

## Safety of sending

- An entry and its "waiting to sync" state are saved together, in one database step.
- The browser sends an id with each entry, so saving twice (a retry after a lost answer) logs the work once.
- Before each Odoo create, a "being sent" marker is saved, and Odoo is always searched by the entry's id first.
- If Odoo doesn't answer, the create is **never sent blindly again**. One exact match is linked. No match, or
  more than one match, goes to **Needs review**. An administrator can then check Odoo again, send it again, or
  link it to an existing line.
- The ticket's task is found by its name, `[KEY] …`, in the ticket's project (no field on tasks), and the
  dashboard remembers its number once created. Two tasks with the same `[KEY]` name go to Needs review.
- The same unclear-result rules apply to creating the ticket's task. Sends are one at a time per entry and per ticket task.

## Odoo preparation (no module is installed)

Create these **custom text fields** (Settings → Technical → Fields, or Studio):

| Model | Field | Holds |
|---|---|---|
| Timesheet line (`account.analytic.line`) | the existing **Users** field | the name of the person who did the work |
| Timesheet line | e.g. `x_aione_entry_uuid` | the work entry's unique id |
| Timesheet line | e.g. `x_aione_user_uuid` | the person's stable dashboard id |
| Timesheet line | e.g. `x_aione_ticket_ref` | source and ticket, like `jira:AION-12` |

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
`GET|PUT /time-entries/setup` (administrators) · `POST /cron/time-sync` (scheduler secret) ·
`GET /time-entries/timer` (your open timer) · `POST /time-entries/timer` (actions: `start` with a `ticket` and an
`id`, `pause`, `resume`, `stop`, `discard`, `draft` with a `description`; each takes the `revision` last
shown, and a stale one is refused with the current timer) ·
`POST /time-entries/suggest` (a proposed description for a ticket you can see; nothing is saved) ·
`POST /ai-improve` with `purpose: "work"` (rewrites a work description; the default `comment` rewrites a comment).
