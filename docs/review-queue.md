# Needs review (administrators' pull request queue)

The page administrators see at **Needs review** (`GET /reviews/queue`, `proxy/src/reviews.js`; page in
`public/assets/components/reviews.js`, rules in `public/assets/models/reviews.js`). Developers keep their personal list
(`GET /reviews/me`) and never receive the administrators' queue (403).

## What is listed

An open pull request that names a ticket (Jira key in this project, or `INT-n`) is listed under each ticket it names.
These rules are the same as before this page was redesigned:

- Drafts, merged and closed pull requests are left out.
- Approved pull requests are left out unless the approval is stale (new commits since) or GitHub needs more approvals.
- Changes requested stays listed.
- A pull request whose review data couldn't be read is listed as **Review information unavailable**, never as
  Awaiting review.
- The ticket's own status doesn't matter: a closed ticket with an open pull request stays, marked
  "Ticket closed · PR still open".

The counts are distinct pull requests. A pull request that names two tickets appears under both but counts once.

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
requests with no time come last. Ties are broken by ticket key. Within a ticket, ties are broken by pull request number.
A review wait of 3 days or more is shown a little stronger. This is a nudge, not a service level.

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

**Open ticket** opens the shared read-only ticket dialog (`GET /reviews/ticket`), the same one reviewers use. **Open PR**
opens GitHub in a new tab, and only for a `https://…/owner/repo/pull/N` address. The page never merges, approves or
assigns reviewers. Reviewers are still assigned from a ticket's Pull requests block.
