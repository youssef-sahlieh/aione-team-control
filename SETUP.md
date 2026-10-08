# AION Team Control: setup and changes

- **Dashboard:** https://youssef-sahlieh.github.io/aione-team-control/
- **Who can sign in:** youssef@aione.biz and ellen@aione.biz, with the team password.

Everything is configured on GitHub under **Settings → Secrets and variables → Actions**. Secrets can be replaced there but never read back.

| Secret | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Lets GitHub deploy the proxy to Cloudflare (step 1) |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID (step 1) |
| `JIRA_EMAIL` | The Atlassian account the proxy acts as (step 2) |
| `JIRA_API_TOKEN` | That account's API token (step 2) |
| `JIRA_SITE` | The Jira address, like `https://<site>.atlassian.net` |
| `TEAM_PASSWORD` | The password everyone signs in with |
| `SESSION_SECRET` | A long random string that signs the 12-hour sessions |
| `TEAM_CONFIG` | Team details: people and their Jira IDs, developers and their emails (JSON) |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | Optional: lets the proxy send emails through Microsoft 365 (step 4) |

---

## First-time setup

### Step 1 · Let GitHub deploy to Cloudflare

1. Sign in at **dash.cloudflare.com**.
2. Copy your **Account ID**: open **Workers & Pages**; it's in the right-hand column (or in the address bar after `dash.cloudflare.com/`).
3. Go to **My Profile → API Tokens → Create Token**, pick the **Edit Cloudflare Workers** template, and under **Account Resources** choose your account. Click **Continue to summary → Create Token** and copy it.
4. On GitHub, add two secrets: `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (the account ID).

### Step 2 · Give the proxy a Jira API token

1. In the browser, sign in to Atlassian as the account the dashboard should act as (for example youssef@aione.biz).
2. Open **https://id.atlassian.com/manage-profile/security/api-tokens**.
3. Click **Create API token**. Use the plain **Create API token** button, not "Create API token with scopes": scoped tokens don't work with this setup.
4. Name it `AION Team Control`, set the expiry as far out as it allows (up to one year), and click **Create**.
5. Click **Copy**. Atlassian shows the token only once; if you lose it, delete it and create a new one.
6. On GitHub, add two secrets: `JIRA_EMAIL` (the email you signed in to Atlassian with) and `JIRA_API_TOKEN` (the token).

Every change made from the dashboard shows in Jira as made by this account. Put a reminder in your calendar a week before the token expires; then create a new one and update `JIRA_API_TOKEN`.

### Step 3 · Deploy

1. On GitHub, go to **Actions → Deploy Jira proxy → Run workflow**.
2. When it finishes, the log shows the proxy's address, like `https://aione-team-proxy.<name>.workers.dev`.
3. Put that address in `public/assets/config.js` and commit. The dashboard republishes itself.

### Step 4 · Send emails automatically (optional)

Without this step, "Internal notes" and new-assignment emails open a ready-made email in Outlook that you send yourself. With it, the dashboard sends them straight away from the signed-in person's mailbox (they appear in that person's Sent Items). Emails can only go to @aione.biz addresses.

This needs a Microsoft 365 admin.

1. Sign in at **entra.microsoft.com** and go to **Identity → Applications → App registrations → New registration**.
2. Name it `AION Team Control mail`, choose **Accounts in this organizational directory only**, leave the redirect URI empty, and click **Register**.
3. On the **Overview** page, copy the **Application (client) ID** and the **Directory (tenant) ID**.
4. Go to **Certificates & secrets → New client secret**, choose the longest expiry, click **Add**, and copy the **Value** right away (it's shown only once).
5. Go to **API permissions → Add a permission → Microsoft Graph → Application permissions**, tick **Mail.Send**, and click **Add permissions**. Then click **Grant admin consent for Aione** and confirm.
6. On GitHub, add three secrets: `MS_TENANT_ID` (directory ID), `MS_CLIENT_ID` (application ID) and `MS_CLIENT_SECRET` (the secret value).
7. Run **Actions → Deploy Jira proxy → Run workflow**. Reload the dashboard: the note button now says **Send email**.

Recommended: Mail.Send on its own lets the app send as any mailbox in the company. An Exchange admin can limit it to the people who use the dashboard with an application access policy (Exchange Online PowerShell):

```powershell
New-DistributionGroup -Name "AION Team Control senders" -Type Security -Members youssef@aione.biz,ellen@aione.biz
New-ApplicationAccessPolicy -AppId <Application (client) ID> -PolicyScopeGroupId "AION Team Control senders" -AccessRight RestrictAccess -Description "AION Team Control may only send as these people"
```

When the client secret expires, create a new one (step 4.4), update `MS_CLIENT_SECRET`, and run the workflow again.

---

## Change the password

1. Update the `TEAM_PASSWORD` secret.
2. Run **Actions → Deploy Jira proxy → Run workflow**. The new password works as soon as it finishes.

People who are already signed in stay signed in for up to 12 hours. To sign everyone out right away, also change `SESSION_SECRET` to a new long random string before running the workflow.

## Add or remove someone who can sign in

Edit `TEAM_EMAILS` in `worker/wrangler.toml` and commit. The proxy redeploys itself, and anyone removed is signed out immediately. If you remove someone who knows the password, change the password too.

## Change the team shown on the dashboard

Update the `TEAM_CONFIG` secret, then run **Deploy Jira proxy**. It looks like this:

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

## If something doesn't work

- **"Can't reach the AION server":** the proxy address in `public/assets/config.js` is wrong, or the proxy isn't deployed. Check **Actions → Deploy Jira proxy**.
- **"Jira didn't accept the proxy's API token":** the Jira token expired or was revoked. Create a new one (step 2), update `JIRA_API_TOKEN`, and run **Deploy Jira proxy**.
- **"Jira refused: …":** Jira itself said no, usually because the Jira account doesn't have permission for that action.
- **The proxy deploy fails with "missing secrets":** the error lists which ones to add.
- **"Microsoft refused to send from …":** Mail.Send isn't granted with admin consent (step 4.5), or an application access policy doesn't include that person.
- **"Microsoft didn't accept the proxy's app details":** the client secret expired or a Microsoft ID is wrong. Check the three `MS_` secrets.
- **To turn automatic emails off again:** delete the three `MS_` secrets on GitHub *and* under Cloudflare → Workers & Pages → aione-team-proxy → Settings → Variables and Secrets.
- **The proxy deploy asks for a workers.dev subdomain:** in Cloudflare, open **Workers & Pages** once and pick a subdomain, then run the workflow again.
