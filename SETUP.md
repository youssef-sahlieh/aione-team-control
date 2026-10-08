# AION Team Control: sign-in and publishing

The site is at **https://youssef-sahlieh.github.io/aione-team-control/**.

To sign in, people enter their **work email** and the **team password**. Only these emails can sign in:

- youssef@aione.biz
- ellen@aione.biz

Every change pushed to the `main` branch is published automatically in about a minute. You can watch it under the **Actions** tab on GitHub.

---

## Change the password

1. On GitHub, open the repository and go to **Settings → Secrets and variables → Actions**.
2. Click **TEAM_PASSWORD → Update secret**, type the new password, and click **Update secret**.
3. Go to **Actions → Deploy to GitHub Pages → Run workflow**. Once it finishes, only the new password works, and everyone has to sign in again.

Use a long password (16+ characters, or four random words). The site can't block someone who keeps guessing, so length is what protects it.

## Add or remove someone

1. On GitHub, open `src/team.json` and click the pencil icon.
2. Add or remove the email in the list, for example:
   ```json
   { "emails": ["youssef@aione.biz", "ellen@aione.biz", "new.person@aione.biz"] }
   ```
3. **Commit changes.** The site republishes itself.

If you remove someone who knows the password, also change the password (see above).

## Change the app

The app's page is `src/app.html`. Edit it and commit; it's encrypted and published automatically. Don't put private information anywhere under `public/`, because those files are published as they are.

## If something doesn't work

- **"That email and password don't match":** check the email is in `src/team.json` and the password is the current one. Passwords are case-sensitive.
- **"The app couldn't load":** the last publish probably failed. Open the **Actions** tab and check the latest run. If it says `TEAM_PASSWORD is not set`, add the secret (see "Change the password").
- **Run the tests yourself (optional):** `npm test` (needs Node.js 20 or newer).
