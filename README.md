# AION Team Control

The team dashboard for Aione, hosted on GitHub Pages at https://youssef-sahlieh.github.io/aione-team-control/. People sign in with their work email and the team password.

- **Setup and changing the password:** see [SETUP.md](SETUP.md)
- **Allowed emails:** `src/team.json`
- **Password:** the `TEAM_PASSWORD` secret under GitHub > Settings > Secrets and variables > Actions. It is never stored in the code.
- **Deploys:** every push to `main` runs the tests, locks the app and publishes `public/` (see `.github/workflows/deploy.yml`)
- **Tests:** `npm test` checks that only the right email and password unlock the app

## How the sign-in protects the app

GitHub Pages serves every file to anyone, so a password check alone would protect nothing. Instead, the app itself (`src/app.html`) is **encrypted** when the site is built. Only the encrypted file is published, and it can only be opened with an approved email and the password. The sign-in page and its code are public, but they contain nothing private.

Things to know:

- Anyone who has the password and an approved email can get in, so share the password only with the team, and change it if it leaks.
- The site can't limit how many passwords someone tries. A long password is what keeps it safe; each guess takes about half a second.
- Never commit private data (tickets, customer details, keys) as plain files. Put app content in `src/app.html` so it gets encrypted.

## Files

- `src/app.html`: the protected app. It's encrypted at build time and never published as-is.
- `src/team.json`: the emails that can sign in.
- `public/index.html`: the sign-in page.
- `public/assets/app.js`: runs the sign-in and shows the app once it's unlocked.
- `public/assets/lock.js`: the encryption (AES-256-GCM, with a password key from PBKDF2-SHA-256).
- `scripts/build.js`: locks `src/app.html` into `public/assets/locked.json`.
