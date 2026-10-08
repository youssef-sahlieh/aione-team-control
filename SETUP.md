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
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | Optional: lets the proxy send emails through Microsoft 365 |

**After changing a variable, redeploy:** vercel.com → aione-team-proxy → **Deployments** → the latest one → **⋯ → Redeploy**. Variables only take effect on a new deployment.

---

## Deploying proxy changes

Once the repository is connected (below), every push to `main` that changes `proxy/` redeploys the proxy automatically.

**Connect the repository (one time):** vercel.com → aione-team-proxy → **Settings → Git → Connect Git Repository**, choose GitHub and `youssef-sahlieh/aione-team-control`. If Vercel asks, install its GitHub app and allow it that repository. The project's **Root Directory** is already set to `proxy`.

Until then, deploy by hand from this folder: `cd proxy` then `npx vercel deploy --prod`.

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

## Send emails automatically (optional)

Without this, "Internal notes" and new-assignment emails open a ready-made email in Outlook that you send yourself. With it, the dashboard sends them straight away from the signed-in person's mailbox (they appear in that person's Sent Items). Emails can only go to @aione.biz addresses. This needs a Microsoft 365 admin.

1. Sign in at **entra.microsoft.com** → **Identity → Applications → App registrations → New registration**.
2. Name it `AION Team Control mail`, choose **Accounts in this organizational directory only**, leave the redirect URI empty, and click **Register**.
3. On **Overview**, copy the **Application (client) ID** and the **Directory (tenant) ID**.
4. **Certificates & secrets → New client secret**, longest expiry, **Add**, and copy the **Value** right away.
5. **API permissions → Add a permission → Microsoft Graph → Application permissions**, tick **Mail.Send**, **Add permissions**, then **Grant admin consent for Aione**.
6. In Vercel, add `MS_TENANT_ID` (directory ID), `MS_CLIENT_ID` (application ID) and `MS_CLIENT_SECRET` (the value), then redeploy. Reload the dashboard: the note button now says **Send email**.

Recommended: Mail.Send on its own lets the app send as any mailbox in the company. An Exchange admin can limit it to the people who use the dashboard (Exchange Online PowerShell):

```powershell
New-DistributionGroup -Name "AION Team Control senders" -Type Security -Members youssef@aione.biz,ellen@aione.biz
New-ApplicationAccessPolicy -AppId <Application (client) ID> -PolicyScopeGroupId "AION Team Control senders" -AccessRight RestrictAccess -Description "AION Team Control may only send as these people"
```

To turn automatic emails off again, delete the three `MS_` variables in Vercel and redeploy.

## If something doesn't work

- **"Can't reach the AION server":** check that https://aione-team-proxy.vercel.app/config answers with `{"code":"session",...}`. If not, open the latest deployment in Vercel for errors.
- **"Jira didn't accept the proxy's API token":** the token expired or was revoked. Replace it (above).
- **"Jira refused: …":** Jira itself said no, usually because the Jira account doesn't have permission for that action.
- **"Microsoft refused to send from …":** Mail.Send isn't granted with admin consent, or an application access policy doesn't include that person.
- **"Microsoft didn't accept the proxy's app details":** the client secret expired or a Microsoft ID is wrong.
- **Run the tests yourself:** `npm test` (Node 20+).
