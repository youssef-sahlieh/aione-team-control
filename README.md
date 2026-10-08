# AION Team Control

The Aione team dashboard for the AION Jira project: tickets, filters, boards, due date history, comments, developer assignments and internal notes.

- **Dashboard:** https://youssef-sahlieh.github.io/aione-team-control/ (GitHub Pages, from `public/`)
- **Jira proxy:** https://aione-team-proxy.vercel.app (Vercel, from `proxy/`), which checks the sign-in and talks to Jira
- **Setup and changes:** see [SETUP.md](SETUP.md)
- **Tests:** `npm test` (Node 20+) checks the proxy's sign-in, its limits on Jira, and that no team details are in the public code

## How it fits together

```
Browser ──► GitHub Pages (dashboard files, public)
   │
   └──► Jira proxy on Vercel (checks email + password, holds the Jira token)
            └──► Jira (AION project only)
```

- People sign in with their work email and the team password. The **proxy** checks them and returns a 12-hour session.
- Every Jira request goes through the proxy with that session. The proxy only reads and changes **AION** tickets, and only labels (developers), due dates, assignee, status and comments.
- The Jira token, the password, the Jira site and the team details (people, developer emails) are **Vercel environment variables** on the proxy. None of them are in this public repository.
- Internal notes and new-assignment emails are sent automatically through a Gmail account, named after the signed-in person, with replies going to them at @aione.biz, to @aione.biz addresses only (SETUP.md). Without Gmail set up, they open a ready-made email in Outlook.
- Changes in Jira are made as the Jira account whose API token the proxy uses.

## Files

- `public/index.html`, `public/assets/signin.js`: the sign-in page.
- `public/dashboard.html`, `public/assets/dashboard.js`, `public/assets/dashboard.css`: the dashboard.
- `public/assets/session.js`: the session and the calls to the proxy.
- `public/assets/config.js`: the proxy's address.
- `proxy/src/handler.js`: the proxy. `proxy/settings.js`: its allowed emails, Jira project and email domain. `proxy/api/proxy.js`, `proxy/vercel.json`: the Vercel wiring.
- `.github/workflows/deploy.yml`: publishes the dashboard.
