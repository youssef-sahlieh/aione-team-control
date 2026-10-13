# Deploying the security fixes

**Current setup (13 October 2026): GitHub Pages frontend + existing Vercel proxy.** The cookie-host migration was reverted to restore this setup. Keep Vercel Root Directory set to `proxy`; merge/deploy `fix/github-pages-login` and use `https://youssef-sahlieh.github.io/aione-team-control/index.html`. There is no redirect to the API host. Existing account data and Jira tickets are retained. If the Vercel project has a manually configured `APP_URL`, use the GitHub Pages URL; the proxy settings already default to it.

Atomic reset-link consumption, safe mailer/proxy errors, stronger password hashing with upgrades, and broad environment-file exclusions remain implemented. GitHub Pages uses the existing JavaScript-accessible bearer session. HttpOnly browser sessions and dashboard frame-ancestor response headers remain unresolved under this hosting arrangement. Cookie service code and its isolated regression tests remain available, but the production entry point does not enable that service.

The instructions below describe the **optional future migration**, using the repository-root configuration retained on `security/hardening`. They do not describe the active GitHub Pages setup. Do not apply them to restore current login.

## One-time hosting change

Use the existing **aione-team-proxy** Vercel project, retaining its domain, Jira/mail credentials and Upstash account database.

1. In **Settings → Build and Deployment**, change **Root Directory** from `proxy` to the repository root (`.` / empty root selector). Use framework **Other**, Node.js 24, and clear old build/output overrides that conflict with root `vercel.json`. The configuration serves `public` and runs `api/proxy.js`.
2. Keep the Redis environment variables (`KV_REST_API_*` or `UPSTASH_REDIS_REST_*`). Secure browser sessions deliberately fail closed without storage.
3. Set Production `APP_URL` to `https://aione-team-proxy.vercel.app`, or the full HTTPS app URL if using a custom domain. Password/reset and notification links now point there.
4. Deploy the security branch to Preview and verify the checks below, then merge/deploy to Production. Coordinate the Vercel deployment and Pages update. Changing Root Directory affects new deployments; it does not change the already-running deployment.
5. Open **https://aione-team-proxy.vercel.app/dashboard.html** and sign in again. Legacy browser bearer sessions are intentionally rejected by the production entry point. Existing passwords and tickets are retained; old password hashes upgrade at successful login.

Old GitHub Pages links redirect to the new host while preserving page queries and ticket/reset fragments. The frontend removes old `aione-session` localStorage entries. API routes on the new host are **`/api/...`**. If the optional Jira webhook is in use, update it to **`https://aione-team-proxy.vercel.app/api/notifications/jira-created`**; automatic manager-dashboard email checks need no new configuration.

## Verify after deployment

- Dashboard responses send **X-Frame-Options: DENY** and a CSP response header containing **frame-ancestors 'none'**.
- Login sets **`__Host-aion-session`** with **HttpOnly**, **Secure**, **SameSite=Strict**, **Path=/**, no Domain, and a 24-hour expiry. Login and `/api/session` JSON return identity, expiry and a CSRF token, never the bearer credential.
- The credential is absent from `document.cookie`, localStorage and sessionStorage. CSRF values remain in page memory; authenticated mutations require both the exact Origin and the session's CSRF value.
- Sign out and verify a copied previous cookie is rejected by `/api/session`. Redis revocation applies across server instances. Never paste real cookies into chat or public logs.
- Wrong/missing Origin or CSRF returns 403. Redis GETDEL permits only one reset-link consumer.
- Confirm the deployed commit is the security commit; source tests alone cannot verify production settings.

## Local preview

The loopback preview forwards cookies without exposing them to JavaScript. It converts the production Secure host cookie to a loopback-only HttpOnly cookie, validates the local Origin, and forwards CSRF values to the proxy. It requires the updated proxy deployment. Restart `npm run dev` after these changes. Browser tests use a separate synthetic cookie backend, never live email/Jira writes.

## Fixes and limits

Validation: 138 backend/frontend checks and 54 browser checks passed. Browser checks include actual cookie sign-in, JavaScript/storage credential isolation, cross-origin rejection, security headers and rejection of a copied session after logout. The local password-hash benchmark took 174 ms; production latency depends on the deployed runtime.

- Reset consumption uses atomic **GETDEL**.
- Mail/system/proxy logs contain stable approved codes, and mail responses exclude raw provider errors.
- Sessions use random IDs and CSRF values, HttpOnly cookies, Redis revocation and renewal at sign-in.
- PBKDF2-HMAC-SHA256 uses **600,000 iterations**. Login verifies old hashes at their stored count, then upgrades with compare-and-set so concurrent account edits are not overwritten. Resets/new accounts use the new work factor.
- Root environment-file variants are ignored, with explicit example files allowed.
- Vercel and loopback hosts provide framing/security headers.

The workspace has no authenticated Vercel CLI/project connection. Production Root Directory changes and live verification have therefore not been performed by the coding agent. Platform reference: [Vercel configuration](https://vercel.com/docs/project-configuration/vercel-json).
