# AION Team Control

The team dashboard for Aione, running on Cloudflare Workers at https://team.aione.host. Sign-in is done with Cloudflare Access: people get an email one-time PIN, and only approved emails get in.

- **Setup guide:** see [SETUP.md](SETUP.md)
- **Allowed emails:** `ALLOWED_EMAILS` in `wrangler.toml`, plus the Access policy in Zero Trust
- **Tests:** `npm install && npm test` checks that the sign-in token check rejects missing, forged, expired, wrong-audience and not-allowed tokens

## Files

- `src/index.js`: the Worker. It checks sign-in, then serves pages and `/api/me`.
- `src/access.js`: verifies the Cloudflare Access token and the allow-list.
- `public/`: the pages (the home page now; the dashboard next).
- `wrangler.toml`: Worker settings, domain, and allowed emails.
