# Put AION Team Control online at team.aione.host

The address will be **https://team.aione.host**. Sign-in is done by **Cloudflare Access**:

1. Someone opens the address.
2. Cloudflare asks for their email.
3. If the email is allowed, Cloudflare emails them a 6-digit code.
4. They type the code and the app opens.

Only **youssef@aione.biz** and **ellen@aione.biz** are allowed. Anyone else never reaches the app. The app also checks Cloudflare's sign-in token itself on every request, so it stays closed even if a setting is wrong.

It takes about 15 minutes. Follow the steps in order.

---

## Step 1 · Turn on Cloudflare Zero Trust (one time)

1. Sign in at **dash.cloudflare.com** and click **Zero Trust** in the left menu.
2. If it's your first time, Cloudflare asks for a **team name**. Type `aione` (or any name you like) and choose the **Free** plan. It's free for up to 50 users.
3. Your **team domain** is now `<team name>.cloudflareaccess.com`, for example `aione.cloudflareaccess.com`. Write it down. You can find it again under **Settings → Custom Pages** or **Settings → General**.
4. Go to **Settings → Authentication → Login methods**. Make sure **One-time PIN** is listed. If it isn't, click **Add new → One-time PIN → Save**.

## Step 2 · Protect team.aione.host with sign-in

1. In Zero Trust go to **Access → Applications → Add an application → Self-hosted**.
2. Fill in:
   - **Application name:** `AION Team Control`
   - **Session duration:** `12 hours`
   - **Public hostname:** subdomain `team`, domain `aione.host`
3. Under **Identity providers / Login methods**, tick only **One-time PIN**. Turn on **Instant Auth** if it's offered, so people skip the method picker.
4. Click **Next** to the **Policies** step. Add a policy:
   - **Policy name:** `Approved team`
   - **Action:** `Allow`
   - **Include → Emails:** `youssef@aione.biz` and `ellen@aione.biz`
5. Save the application.
6. Open the application again. On the **Overview** tab, copy the **Application Audience (AUD) Tag**. It's a long string of letters and numbers.

## Step 3 · Put the code on GitHub

1. On **github.com** click **New repository**. Name it `aione-team-control`, choose **Private**, and create it.
2. Click **uploading an existing file**. Drag in everything from this folder **except** `node_modules`, then **Commit changes**.
3. In the repository, open `wrangler.toml` and click the pencil icon to edit it. Replace:
   - `REPLACE_WITH_TEAM_NAME.cloudflareaccess.com` with your team domain from Step 1, for example `aione.cloudflareaccess.com`
   - `REPLACE_WITH_AUD_TAG` with the AUD tag from Step 2
4. **Commit changes.**

## Step 4 · Deploy it on Cloudflare

1. In the Cloudflare dashboard (not Zero Trust), go to **Workers & Pages → Create → Import a repository**.
2. Connect your GitHub account when asked, and allow Cloudflare to see the `aione-team-control` repository.
3. Select the repository. Leave the build settings as they are; the deploy command is `npx wrangler deploy`. Click **Deploy**.
4. When it finishes, the Worker attaches itself to **team.aione.host**, because that's set in `wrangler.toml`. Check it under **Settings → Domains & Routes**.
5. From now on, every change committed to GitHub is deployed automatically.

## Step 5 · Test it

1. Open **https://team.aione.host** in a private browser window.
2. Enter `youssef@aione.biz`. Check your inbox for an email from Cloudflare with the code, and enter it.
3. You should see "You're signed in" with your email at the top.
4. Try a different email. Cloudflare should refuse it and no code should arrive.
5. Ask Ellen to try with `ellen@aione.biz`.

## Change who has access

Add or remove the email in **both** places:

- **Zero Trust → Access → Applications → AION Team Control → Policies → Approved team**
- `ALLOWED_EMAILS` in `wrangler.toml` on GitHub (commit, and it redeploys itself)

## If something doesn't work

- **"You don't have access" right after entering the code:** the email isn't in `ALLOWED_EMAILS`, or `TEAM_DOMAIN` / `POLICY_AUD` in `wrangler.toml` don't match Step 1 and Step 2.
- **No code email arrives:** check spam, and check that the email is in the Access policy. Cloudflare only sends codes to allowed emails.
- **The deploy fails on the domain:** make sure `aione.host` is in the same Cloudflare account and its DNS is active. Also make sure no other DNS record already uses `team`.
- **Run the safety tests yourself (optional):** `npm install`, then `npm test`.
