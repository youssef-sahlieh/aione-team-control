# Needs review (administrators' pull request queue)

The page administrators see at **Needs review** (`GET /reviews/queue`, `proxy/src/reviews.js`; page in
`public/assets/components/reviews.js`, rules in `public/assets/models/reviews.js`). Developers keep their personal list
(`GET /reviews/me`) and never receive the administrators' queue (403).

## What is listed

Every open pull request in the repositories named in `GITHUB_REPOS`, one row each, whether or not it names a ticket.

- **Linked** pull requests name a ticket that exists: a Jira key in this project, or `INT-n`, in the title, description
  or branch. A key that Jira doesn't know is not a link. Linking is optional. Nothing here creates a ticket.
- **Unlinked** pull requests name no ticket. They are listed with an "Unlinked" tag. To link one, name the ticket in
  the pull request.
- **Drafts** are listed and marked **Draft**. A draft that nobody has reviewed shows the Draft state, not Awaiting review.
- Approved and changes-requested pull requests stay listed with that state.
- Merged and closed pull requests are left out. So are repositories no longer in `GITHUB_REPOS`.
- A pull request whose review data couldn't be read shows **Review information unavailable**, never Awaiting review.
- The ticket's own status doesn't matter. A closed ticket with an open pull request stays, and the "By ticket" view marks
  it "Ticket closed · PR still open".

Each pull request is identified by `owner/repo#number`, never by its title, so it appears once even when it names two
tickets.

### Where the pull requests come from

The GitHub index (`github:prs:v4`, `proxy/src/github.js`) is synced at most every 2 minutes. Retry and Refresh sync it at
once. Each sync reads each repository's pull request list, newest first, from its last cursor. The index keeps every pull
request that names a ticket, plus every open or draft one that names none. An unlinked one is dropped once it closes.
Review states for open pull requests come from one GraphQL query per repository.

An index saved before unlinked pull requests were kept has no `scope` marker. It is read again from the start once, so
existing deployments pick up their unlinked pull requests without any manual step.

## Summary cards

The six cards always count every open pull request. Filters don't change them.

| Card | Counts |
| --- | --- |
| Open PRs | open pull requests, drafts included |
| Linked tickets | distinct tickets named by them |
| Unlinked PRs | pull requests that name no ticket |
| No reviewer | nobody asked and no review given (`reviewerState` `none`) |
| Flagged for Rami | pull requests with the Rami flag |
| Awaiting review | pull requests in the Awaiting review state (never drafts) |

The navigation badge is the Awaiting review count.

## Filters, sort and views

Quick filters: All PRs, Linked to ticket, Unlinked PRs, Rami flagged, No reviewer, Changes requested. They combine with:

- the search, which matches the title, `repo#number`, the author, or a linked ticket's key or title
- the Project, Repository, Opened by, Reviewer and Review state menus

A project matches through a linked ticket, so an unlinked pull request has no project.

**Opened by** lists the pull request authors in the queue. **Reviewer** lists the reviewers; the **Reviewer's part**
menu, active once a reviewer is chosen, narrows it to: Any relationship, Review requested (a request is open on
GitHub or in the dashboard), Has reviewed, Approved, or Changes requested. "No reviewer requested" needs no part.

Every active filter is a removable chip above the list, with **Clear all**. The chips name the author and the
reviewer's part, for example "Reviewer: Lee (Changes requested)".

Sort options:

| Sort | Order |
| --- | --- |
| Newest PR first | the default: by when GitHub created the pull request, newest first; a pull request with no creation time goes last |
| Longest wait | see Times |
| Most recent | newest time first |
| Ticket key | by key number, unlinked last |
| Repository | by repository, then number |

**List** (the default) shows one row per pull request. **By ticket** groups the same rows under each ticket they name,
with the unlinked ones last. A pull request that names two tickets is under both in that view. All of this happens on
the page, so the queue isn't read again.

## GitHub reviewers on a pull request

Each row has a **Reviewers** button (administrators only). It manages GitHub's own review requests on that pull request.
It never touches a ticket: a ticket's status change requests nothing, and a dashboard assignment (the "Reviewers" picker
in the row's details) is a separate thing that stays as it was.

- **Read.** `GET /reviews/github-reviewers?id=owner/repo#number` returns who GitHub has a review requested from now
  (`requested`), and who GitHub allows as a reviewer on the repository (`eligible`, from GitHub's assignee list). The
  author is never offered. Nothing comes from the dashboard's own directory.
- **Change.** `POST /reviews/github-reviewers?id=…` with `{ "confirmed": true, "add": [logins], "remove": [logins] }`.
  Removals go first (`DELETE .../requested_reviewers`), then requests (`POST .../requested_reviewers`), both with
  GitHub's REST API. Logins are matched case-insensitively and sent with GitHub's own spelling.
- **Confirmation.** The page shows what will be sent and sends it only from **Confirm on GitHub**. The server refuses
  any change without `confirmed: true`, so the step can't be skipped by calling the route directly.
- **Refused before GitHub is called:** a non-administrator (403); a closed or merged pull request (409); a malformed
  login; the author; someone both added and removed; more than 10 changes at once; a login GitHub doesn't list for the
  repository (400, `not_eligible`). Someone already requested is skipped, and someone not requested isn't removed.
- **Afterwards.** The stored pull request is refreshed (`syncPulls` with `force`), so the queue shows the new requests.
  A failed refresh doesn't undo the change. If GitHub refuses or doesn't answer, nothing more is sent and the message
  says which.
- **GitHub token.** The token is read on the server only and is never sent to the page. It needs read access to pull
  requests and metadata to read the lists, and write access to pull requests (review requests) to change them.

## The Rami flag

Each row has a **Rami** checkbox. It is a reference marker only.

- **Storage.** `PUT /reviews/rami?id=owner/repo#number` with `{ "flagged": true | false }` adds the ID to, or removes it
  from, the store set `review-flags:rami`. The queue reads that set and returns `rami` on each pull request.
  `/reviews/me` also returns it, so reviewers see it on their own list.
- **Independent of sync.** The set lives apart from the GitHub index, so a sync never writes or clears it. A flag stays
  until someone unticks it.
- **No side effects.** Ticking it makes no GitHub call, requests no review, assigns no one, changes no state or reviewer,
  notifies no one, creates no ticket and needs no approval.
- **Who can change it.** Only administrators. Anyone else gets 403. The queue says `canFlag`, and the page disables the
  box without it.
- **Validation.** A bad ID or a non-boolean `flagged` is 400. Setting a flag on a pull request the index doesn't know is
  404. Clearing always works.
- **Failed saves.** If a save fails, the box goes back and the page says so.

### What Rami sees

A flag is for Rami to check the pull request and comment on GitHub himself. It is not a review request. Rami's
dashboard account is named by the `RAMI_EMAIL` setting (`proxy/settings.js`). He doesn't need to be an administrator.

- His **Needs review** page shows **Flagged for you to check** above his own reviews. That list is every open pull
  request with the flag, newest activity first, from `GET /reviews/me` (`flagged`). Nobody else's answer has it.
- Each one has **Open on GitHub to comment**, and a read-only **Read** button for each ticket it names. Rami reads
  those tickets (and their attachments) the way a reviewer does, while the pull request is open and flagged.
- A flagged pull request is not a review assignment: it adds nothing to his reviews, sends no GitHub request and no
  notification. Unticking the flag takes it off his list.
- With `RAMI_EMAIL` empty, nobody gets the list.

## Reviewers

Each pull request lists the people assigned on the dashboard, the people and teams GitHub has been asked for, then anyone
who has already reviewed it. `reviewerState` says which case applies:

| `reviewerState` | Shown as | Meaning |
| --- | --- | --- |
| `none` | No reviewer requested | Nobody was asked, and no review was given |
| `pending` | Name · requested | Someone was asked and hasn't reviewed since |
| `given` | Name · approved / changes requested / commented | Reviews were given, and nobody is still waiting to review |
| `unavailable` | Reviewer data unavailable | GitHub's review data was never read |

## Times

GitHub's `ReviewRequest` has no time, so request times come from the `ReviewRequestedEvent` timeline
(`timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT])`). The wait shown is the earliest open request, or the dashboard
assignment if that is earlier. `sinceKind` says what the time means:

| `sinceKind` | Label | Counts as a review wait |
| --- | --- | --- |
| `requested` | Waiting for review | yes |
| `commit` | Waiting since new commits (after changes requested or a stale approval) | yes |
| `changes` | Changes requested | no |
| `approved` | Approved | no |
| `opened` | PR age (no request time known) | no |
| empty | Waiting time unknown | no |

The default sort is the longest wait first. Review waits come first, then the other times (oldest first), and pull
requests with no time come last. Ties are broken by repository, then number. A review wait of 3 days or more is shown a
little stronger. This is a nudge, not a service level.

## Refresh failures

Each repository is read on its own. When one fails, its pull requests keep their last known data and are marked
**Last known**, its cursor isn't advanced, and the others still update. The page then shows "Some pull requests could not
be refreshed. Showing the last available results." with:

- **Retry**, which sends `?refresh=1`. The proxy re-reads GitHub unless it last tried less than 15 seconds ago.
- When the last refresh was attempted, and when the last one fully succeeded.
- How many repositories were affected.

GitHub's messages appear only under **Technical details**. Tokens and response bodies are never stored or shown.

If the queue can't be read at all and there's no earlier result, the page says so and offers Retry. It never shows an
empty queue in that case.

## Viewing a ticket

A linked ticket's key, or **Open ticket** in the By ticket view, opens the shared read-only ticket dialog
(`GET /reviews/ticket`), the same one reviewers use. **Open PR** opens GitHub in a new tab, and only for a
`https://…/owner/repo/pull/N` address. The page never merges, approves or assigns reviewers. Reviewers are still assigned
from a ticket's Pull requests block.
