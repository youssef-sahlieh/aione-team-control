# Put AION Team Control online with GitHub Pages

The address will be **https://youssef-sahlieh.github.io/aione-team-control/**. Sign-in is done by **Microsoft 365**:

1. Someone opens the address and clicks **Sign in with Microsoft**.
2. Microsoft asks for their Aione work account and password (and MFA, if it's on).
3. If the account is approved, the app opens. Anyone else is turned away by Microsoft.

Only **youssef@aione.biz** and **ellen@aione.biz** are allowed.

It takes about 10 minutes. You need to be an admin of the Aione Microsoft 365 tenant (or ask one).

---

## Step 1 · Register the app with Microsoft (one time)

1. Sign in at **entra.microsoft.com**.
2. Go to **Identity → Applications → App registrations → New registration**.
3. Fill in:
   - **Name:** `AION Team Control`
   - **Supported account types:** *Accounts in this organizational directory only (single tenant)*
   - **Redirect URI:** platform **Single-page application (SPA)**, address `https://youssef-sahlieh.github.io/aione-team-control/` (keep the slash at the end)
4. Click **Register**.
5. On the **Overview** page, copy:
   - **Application (client) ID**
   - **Directory (tenant) ID**

## Step 2 · Allow only Youssef and Ellen

1. Go to **Identity → Applications → Enterprise applications** and open **AION Team Control**.
2. **Properties:** set **Assignment required?** to **Yes**, then **Save**. Microsoft will now refuse anyone who isn't assigned.
3. **Users and groups → Add user/group:** add Youssef and Ellen, then **Assign**.

## Step 3 · Put the IDs in the code

1. On **github.com**, open the `aione-team-control` repository and go to `public/assets/config.js`.
2. Click the pencil icon to edit it. Replace:
   - `REPLACE_WITH_CLIENT_ID` with the Application (client) ID from Step 1
   - `REPLACE_WITH_TENANT_ID` with the Directory (tenant) ID from Step 1
3. **Commit changes.** GitHub publishes the site automatically. Watch it under the **Actions** tab; it takes about a minute.

## Step 4 · Test it

1. Open **https://youssef-sahlieh.github.io/aione-team-control/** in a private browser window.
2. Click **Sign in with Microsoft** and sign in as `youssef@aione.biz`.
3. You should see "You're signed in" with your email at the top.
4. Try another Aione account. Microsoft should say you aren't assigned to the app.
5. Ask Ellen to try with `ellen@aione.biz`.

## Change who has access

Add or remove the person in **both** places:

- **Entra → Enterprise applications → AION Team Control → Users and groups**
- `allowedEmails` in `public/assets/config.js` on GitHub (commit, and it republishes itself)

## Optional · Use team.aione.host instead

1. In the repository go to **Settings → Pages → Custom domain**, type `team.aione.host`, and **Save**.
2. Where the DNS for `aione.host` is managed, add a **CNAME** record: name `team`, target `youssef-sahlieh.github.io`. On Cloudflare, set it to **DNS only** (grey cloud).
3. Once GitHub shows the domain as verified, tick **Enforce HTTPS**.
4. In Entra, open the app registration → **Authentication** and add the redirect URI `https://team.aione.host/` (SPA).

## If something doesn't work

- **"This site isn't set up yet":** the IDs in `public/assets/config.js` are still placeholders, or were pasted wrong.
- **Microsoft shows "redirect URI mismatch" (AADSTS50011):** the address in Step 1 must match the site address exactly, including the slash at the end.
- **Microsoft says the user isn't assigned (AADSTS50105):** add them in Step 2.
- **"You don't have access" after signing in:** the account's sign-in name isn't in `allowedEmails`. The name shown on that page is the one to add.
- **The site didn't update:** open the **Actions** tab on GitHub and check the latest "Deploy to GitHub Pages" run for errors.
- **Run the tests yourself (optional):** `npm install`, then `npm test`.
