# AION Team Control

The team dashboard for Aione, hosted on GitHub Pages at https://youssef-sahlieh.github.io/aione-team-control/. People sign in with their Aione Microsoft 365 account, and only approved accounts get in.

- **Setup guide:** see [SETUP.md](SETUP.md)
- **Allowed accounts:** `allowedEmails` in `public/assets/config.js`, plus the users assigned to the app in Microsoft Entra
- **Deploys:** every push to `main` runs the tests and publishes `public/` (see `.github/workflows/deploy.yml`)
- **Tests:** `npm install && npm test` checks the sign-in rules: wrong tenant, not-allowed emails and missing settings are refused

## How sign-in protects the app

GitHub Pages serves files to anyone, so the page files themselves (HTML, CSS, JavaScript) are public. Sign-in controls who gets *into the app*:

- Microsoft only lets users assigned to the app in Entra sign in (SETUP.md, step 2). This is the real gate.
- The page also checks the account's tenant and the allow-list before showing anything.

Keep private information out of the page files. Data such as Jira tickets and Outlook mail must be loaded after sign-in, from services that check the signed-in user's token. Never put it in this repository.

## Files

- `public/index.html`: the page (sign-in, no-access and app views).
- `public/assets/app.js`: runs the Microsoft sign-in and shows the right view.
- `public/assets/auth.js`: the sign-in rules (tenant and allow-list checks).
- `public/assets/config.js`: the Entra app IDs and allowed emails.
- `scripts/build.js`: copies the Microsoft sign-in library into `public/assets/vendor/`.
