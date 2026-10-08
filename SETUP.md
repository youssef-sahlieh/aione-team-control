# AION Team Control: setup and changes

- **Dashboard:** https://youssef-sahlieh.github.io/aione-team-control/ (GitHub Pages, publishes itself on every push to `main`)
- **Jira proxy:** https://aione-team-proxy.vercel.app (Vercel project `aione-team-proxy`, team "aione")
- **Who can sign in:** everyone with an account on the **Users** page (administrators only). Youssef and Ellen are administrators.

The proxy's secrets are **Vercel environment variables**: vercel.com → aione-team-proxy → **Settings → Environment Variables**. They can be replaced there but not read back.

| Variable | What it is |
|---|---|
| `TEAM_PASSWORD` | Before user accounts are on: the password Youssef and Ellen sign in with. Their first sign-in after the database is added turns it into their own account password. |
| `SESSION_SECRET` | A long random string that signs the 12-hour sessions |
| `TEAM_CONFIG` | Team details: people and their Jira IDs, developers and their emails (JSON) |
| `JIRA_SITE` | The Jira address, like `https://<site>.atlassian.net` |
| `JIRA_EMAIL` | The Atlassian account the proxy acts as |
| `JIRA_API_TOKEN` | That account's API token |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Added by Vercel when you connect the Upstash Redis database (user accounts) |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Sends the dashboard's emails automatically through a Gmail account |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | Not used now: the Microsoft 365 alternative to Gmail, if an admin ever sets it up |

**After changing a variable, redeploy:** vercel.com → aione-team-proxy → **Deployments** → the latest one → **⋯ → Redeploy**. Variables only take effect on a new deployment.

---

## Deploying proxy changes

Once the repository is connected (below), every push to `main` that changes `proxy/` redeploys the proxy automatically.

**Connect the repository (one time):** vercel.com → aione-team-proxy → **Settings → Git → Connect Git Repository**, choose GitHub and `youssef-sahlieh/aione-team-control`. If Vercel asks, install its GitHub app and allow it that repository. The project's **Root Directory** is already set to `proxy`.

Until then, deploy by hand from the repository's top folder (not from `proxy/`): `npx vercel deploy --prod`.

## User accounts

Everyone signs in with their own email and password. There are two roles:

- **Administrator** (Youssef, Ellen): sees and changes everything, and manages people on the **Users** page (button at the top of the dashboard).
- **User**: sees only the tickets labelled with their developer name (for example `ai1_bashar`). They can move status, set due dates and comment on those tickets; they can't change developers or assignees, send internal notes, or see other tickets. The proxy enforces this, not just the page.

**Add someone:** Users → fill in name, work email, role, and for a User the developer whose tickets they see → **Add user and send invitation**. They get an email with a link (valid 3 days) to choose their password. If email isn't working, the page shows the link for you to send yourself.

**Forgot password:** anyone can click **Forgot password?** on the sign-in page; a link (valid 1 hour, works once) is emailed to them. Administrators can also press **Send password reset** next to someone on the Users page. Choosing a new password signs that person out everywhere else.

**Change or remove someone:** Users → **Edit** (name, role, developer) or **Remove**. Changes apply immediately, and removed people are signed out right away. You can't remove yourself or the last administrator.

### Switch accounts on (one time)

Accounts are stored in a small free database (Upstash Redis) connected to the proxy:

1. vercel.com → **aione-team-proxy** → **Storage** → **Create Database** → **Upstash for Redis** (Marketplace) → accept the terms, pick the **Free** plan and a region near you, and create it.
2. Connect it to the **aione-team-proxy** project (all environments). Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` by itself.
3. Redeploy the proxy.
4. Youssef or Ellen signs in once with the current team password. That creates both administrator accounts, with that password; change it with **Forgot password?**.

Until then, Youssef and Ellen sign in with the team password and the Users page explains that accounts aren't on yet.

## Internal tickets

Tickets that live only in AION Team Control, never in Jira. They're numbered **INT-1, INT-2, …**, carry a teal **Internal** tag, and show up in every tile, filter, board and view next to the Jira tickets (filter on them with **Work type → Internal**).

- **Open one:** **+ Internal ticket** above the list. Administrators choose one or more developers; Users always open them for themselves.
- **Work on it** in the ticket panel like any ticket: move it **Open → In Development → Closed**, set the due date (changes appear in the due date history), comment, and **Edit** the title, description and priority. A ticket stays open until someone closes it.
- **Attachments:** **+ Add files** in the ticket panel (up to 4 MB each, 20 per ticket). Files are stored with the ticket and only people who can see the ticket can download them. Whoever added a file, or an administrator, can remove it.
- **Who sees what:** administrators see all internal tickets and can reassign developers or **Delete** one (Users can't delete). A User only sees internal tickets for their own developer name.
- With "Email developer on assign" on, developers get an email when an administrator opens a ticket for them or adds them to one.

They're stored in the same Upstash Redis database as the user accounts. The free plan holds 256 MB in total, which is plenty for tickets; attachments use most of it, so keep large files in Jira or a shared drive.

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
