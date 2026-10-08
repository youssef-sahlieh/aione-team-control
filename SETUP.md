# AION Team Control: setup and changes

- **Dashboard:** https://youssef-sahlieh.github.io/aione-team-control/ (GitHub Pages, publishes itself on every push to `main`)
- **Jira proxy:** https://aione-team-proxy.vercel.app (Vercel project `aione-team-proxy`, team "aione")
- **Who can sign in:** youssef@aione.biz and ellen@aione.biz, with the team password.

The proxy's secrets are **Vercel environment variables**: vercel.com → aione-team-proxy → **Settings → Environment Variables**. They can be replaced there but not read back.

| Variable | What it is |
|---|---|
| `TEAM_PASSWORD` | The password everyone signs in with |
| `SESSION_SECRET` | A long random string that signs the 12-hour sessions |
| `TEAM_CONFIG` | Team details: people and their Jira IDs, developers and their emails (JSON) |
| `JIRA_SITE` | The Jira address, like `https://<site>.atlassian.net` |
| `JIRA_EMAIL` | The Atlassian account the proxy acts as |
| `JIRA_API_TOKEN` | That account's API token |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Sends the dashboard's emails automatically through a Gmail account |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | Not used now: the Microsoft 365 alternative to Gmail, if an admin ever sets it up |

**After changing a variable, redeploy:** vercel.com → aione-team-proxy → **Deployments** → the latest one → **⋯ → Redeploy**. Variables only take effect on a new deployment.

---

## Deploying proxy changes

Once the repository is connected (below), every push to `main` that changes `proxy/` redeploys the proxy automatically.

**Connect the repository (one time):** vercel.com → aione-team-proxy → **Settings → Git → Connect Git Repository**, choose GitHub and `youssef-sahlieh/aione-team-control`. If Vercel asks, install its GitHub app and allow it that repository. The project's **Root Directory** is already set to `proxy`.

Until then, deploy by hand from the repository's top folder (not from `proxy/`): `npx vercel deploy --prod`.

## Change the password

1. Replace `TEAM_PASSWORD` in Vercel, then redeploy.
2. People already signed in stay signed in for up to 12 hours. To sign everyone out right away, also replace `SESSION_SECRET` with a new long random string.

Use a long password (16+ characters, or four random words): the sign-in limit (10 tries a minute per address) slows guessing down but can't stop it on its own.

## Add or remove someone who can sign in

Edit `TEAM_EMAILS` in `proxy/settings.js` and commit (or redeploy by hand). Anyone removed is signed out immediately. If you remove someone who knows the password, change the password too.

## Change the team shown on the dashboard

Replace `TEAM_CONFIG` in Vercel, then redeploy. It looks like this:

```json
{
  "people": { "karim": { "id": "<Jira account ID>", "name": "Karim", "ini": "K" } },
  "devs": ["bashar", "ellen"],
  "devEmails": { "bashar": "bashar.b@aione.biz", "ellen": "Ellen@aione.biz" },
  "devColors": { "bashar": "k1", "ellen": "k4" }
}
```

- `people` are the assignees the dashboard follows (it shows their AION tickets).
- `devs` are the `ai1_` developer labels; `devEmails` are used for internal notes and assignment emails.

## Replace the Jira API token

Atlassian tokens expire (at most a year).

1. Signed in to Atlassian as the account in `JIRA_EMAIL`, open **https://id.atlassian.com/manage-profile/security/api-tokens**.
2. Click **Create API token** (the plain one, not "with scopes"), name it `AION Team Control`, pick the longest expiry, and copy it.
3. Replace `JIRA_API_TOKEN` in Vercel, redeploy, and delete the old token on the Atlassian page.

Every change made from the dashboard shows in Jira as made by this account.

## Send emails automatically (Gmail)

"Internal notes" and new-assignment emails are sent automatically through a Gmail account. They arrive as **"Youssef via AION Team Control"** (or Ellen), and pressing Reply in Outlook replies to the person who sent them, at @aione.biz. Emails can only go to @aione.biz addresses. Without the two Gmail variables, the dashboard opens a ready-made email in Outlook instead.

**Set it up (once, about 5 minutes):**

1. Create a Gmail account for the team, for example `aione.team.control@gmail.com` (or use an existing one).
2. Turn on 2-Step Verification for it: **myaccount.google.com → Security → 2-Step Verification**. Google only allows app passwords with it on.
3. Open **https://myaccount.google.com/apppasswords**, type `AION Team Control`, click **Create**, and copy the 16-letter password.
4. In Vercel, add `GMAIL_USER` (the Gmail address) and `GMAIL_APP_PASSWORD` (the 16 letters), then redeploy. Reload the dashboard: the note button now says **Send email**.

**So emails don't land in Junk:** each person who receives them (the developers) can open one in Outlook and choose **Not junk**, or add the Gmail address under **Settings → Mail → Junk email → Safe senders**. Outlook will mark them as coming from outside the company; that's expected.

Gmail allows about 500 emails a day from one account. To stop sending, delete the two `GMAIL_` variables and redeploy. If you change the Gmail account's password, Google cancels its app passwords: create a new one and update `GMAIL_APP_PASSWORD`.

## If something doesn't work

- **"Can't reach the AION server":** check that https://aione-team-proxy.vercel.app/config answers with `{"code":"session",...}`. If not, open the latest deployment in Vercel for errors.
- **"Jira didn't accept the proxy's API token":** the token expired or was revoked. Replace it (above).
- **"Jira refused: …":** Jira itself said no, usually because the Jira account doesn't have permission for that action.
- **"The email account didn't accept its app password":** the Gmail app password was revoked (for example after a password change). Create a new one and update `GMAIL_APP_PASSWORD`.
- **Emails don't arrive:** check the recipient's Junk folder, and the Gmail account's **Sent** folder to see whether they went out.
- **Run the tests yourself:** `npm test` (Node 20+).
