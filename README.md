# AION Team Control

The Aione team dashboard for the AION Jira project: tickets, filters, boards, due date history, comments, developer assignments and internal notes, plus **internal tickets** (INT-…) that live only in the dashboard, never in Jira.

- **Dashboard:** https://youssef-sahlieh.github.io/aione-team-control/ (GitHub Pages, from `public/`)
- **Jira proxy:** https://aione-team-proxy.vercel.app (Vercel, from `proxy/`), which checks the sign-in and talks to Jira
- **Setup and changes:** see [SETUP.md](SETUP.md)
- **Tests:** `npm test` (Node 20+) checks the proxy's sign-in, its limits on Jira, and that no team details are in the public code

UI modernization starts with the [baseline and permission matrix](docs/ui-modernization-baseline.md).
The [workspace redesign](docs/ui-redesign.md) adds sidebar navigation, Overview,
Workload, Calendar, paginated tickets, personal saved views and tabbed details.
The [AION AI v1 setup guide](docs/ai-assistant.md) describes the read-only chat
assistant, server model settings, permission boundaries and reserved v2 actions.
Install dependencies with `npm ci` and `npm ci --prefix proxy`. `npm test` also
runs frontend model tests; `npx playwright install chromium` followed by
`npm run test:e2e` runs mocked browser regression tests without production writes.

For a local preview with Node 24+, run `npm run dev` and open `http://localhost:3000`.
Sign in with your existing account. The local server forwards API requests to
the deployed proxy, so ticket saves affect the live system. It listens only on
loopback and requires no local Jira credentials.

## How it fits together

```
Browser ──► GitHub Pages (dashboard files, public)
   │
   └──► Jira proxy on Vercel (checks email + password, holds the Jira token)
            └──► Jira (AION project only)
```

- People sign in with their own work email and password (Administrators and Users, managed on the Users page; see SETUP.md). The **proxy** checks them and returns a 24-hour session. Users only reach the tickets labelled with their developer name.
- Every Jira request goes through the proxy with that session. The proxy only reads and changes **AION** tickets, and only labels (developers), due dates, assignee, status and comments.
- The Jira token, the password, the Jira site and the team details (people, developer emails) are **Vercel environment variables** on the proxy. None of them are in this public repository.
- Internal notes and new-assignment emails are sent automatically through a Gmail account, named after the signed-in person, with replies going to them at @aione.biz, to @aione.biz addresses only (SETUP.md). Without Gmail set up, they open a ready-made email in Outlook.
- New Jira tickets without a developer can email Youssef and Ellen automatically, even with the dashboard closed. Activate the Jira Automation rule described in [ticket notifications](docs/ticket-notifications.md).
- Changes in Jira are made as the Jira account whose API token the proxy uses.

## Files

- `public/index.html`, `public/assets/signin.js`: the sign-in page and "Forgot password?".
- `public/reset.html`, `public/assets/reset.js`: choosing a password from an emailed link.
- `public/users.html`, `public/assets/users.js`: the Users page (administrators).
- `public/dashboard.html`, `public/assets/dashboard.js`, `public/assets/dashboard.css`: the dashboard.
- `public/assets/session.js`: the session and the calls to the proxy.
- `public/assets/config.js`: the proxy's address.
- `proxy/src/handler.js`: the proxy. `proxy/src/users.js`: accounts, password hashing and one-time links. `proxy/src/internal.js`: internal tickets. `proxy/settings.js`: its allowed emails, Jira project and email domain. `proxy/api/proxy.js`, `proxy/vercel.json`: the Vercel wiring.
- `.github/workflows/deploy.yml`: publishes the dashboard.
