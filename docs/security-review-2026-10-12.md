# Security review — 12 October 2026

Reviewed local commit `fc8473a`, all 29 locally available commits/ref histories, 258 unique historical blobs, 71 current files, public hosting endpoints and installed dependency lockfiles. This is a source review and targeted verification, not a penetration-test certification.

**Remediation update:** all six findings below now have implemented code changes and regression coverage. The updated suite passed 138 backend/frontend checks and 54 browser checks (192 total). A local benchmark of the new 600,000-iteration password hash took 174 ms. Original evidence is preserved as the audit baseline. Cookie isolation and framing protection require the repository-root Vercel deployment in [security deployment](security-deployment.md); production migration and live header verification remain pending. The reset, error-redaction and hashing changes also require deployment before protecting production.

## Password and API-key exposure

**No confirmed real password, API key, private key or credential URL was found in the scanned current files or available Git history.**

- A redacting scan checked recognizable provider tokens, private-key headers, credential-bearing URLs and literal password/secret/token assignments. Matches were inspected without printing candidate values.
- Nine distinct candidate matches were reviewed: eight synthetic credential literals in test fixtures and one historical workflow code expression, not a credential. Other matches were obvious placeholders. This is not a guarantee that every possible secret format would be detected.
- `.env.local` is ignored by Git and is not tracked. No non-placeholder configured local secret values were available for exact-value comparison with history.
- GitHub Pages publishes only `public/`. Live GET requests to `.env.local`, `.git/config` and `proxy/src/handler.js` under the dashboard URL returned 404.
- Live unauthenticated `/config`, `/users`, `/internal` and the ticket history route returned 401 with `Cache-Control: no-store`.
- Passwords are submitted to the proxy for authentication; application code saves the returned session, not the password. Database password records contain a salt and PBKDF2 hash. Public account responses exclude hashes.
- Jira, model, Gmail and Redis credentials are configured server-side; they are not intentionally passed to the frontend or model context. Vercel environment contents and real production logs were not accessible in this review, so those stores cannot be certified leak-free.

## Findings requiring changes

| Priority | Finding | Evidence and impact | Recommended change |
|---|---|---|---|
| Medium | Reset-link consumption is not atomic | `proxy/src/users.js:81` reads a token and deletes it in separate calls. A local test with overlapping Redis-style reads returned two successful consumers for the same synthetic token. Possession of a valid token is required; this can race the legitimate user's password reset. | Consume with Redis `GETDEL` or a single Lua operation; add a concurrent-consumption regression test. |
| Medium | Raw mailer errors can reach clients and logs | `proxy/src/handler.js:173` logs the original exception and returns its message for non-auth failures. A fake mailer error containing a synthetic sensitive marker was reflected in the client response. No actual credential exposure was observed. | Return stable generic errors; log only approved error codes and redact provider details. Apply the same policy to system-mail/proxy exception logs. |
| Medium | Session tokens are accessible to JavaScript and other applications on the same origin | `public/assets/session.js:10` stores the 24-hour bearer token in `localStorage`. A future XSS or another compromised page hosted under the same GitHub Pages origin could read it. No working XSS was demonstrated. Sign-out removes browser storage but does not revoke a copied token server-side. | Plan an HttpOnly, Secure cookie/BFF session design on an appropriate shared/custom domain with CSRF protection and server-side logout/revocation. Simply moving to sessionStorage does not remove XSS access. |
| Medium | Password-hashing work factor is below current guidance | `proxy/src/users.js:11` uses PBKDF2-HMAC-SHA256 with 210,000 iterations. Salted hashing is present, but a stolen database would be cheaper to attack than at the current recommended work factor. | Benchmark and increase new hashes to at least 600,000 iterations, with safe migration of old hashes on successful authentication/reset. |
| Low | Environment-file ignore coverage is narrow | `.gitignore` ignores `.env.local` but not every `.env` / `.env.production` variant. No such credential-bearing tracked file was found. | Ignore environment files broadly, keeping only an explicit example/template allowlist. |
| Low | Public dashboard can be framed | The live dashboard has a CSP meta tag but no observed `frame-ancestors` response header or X-Frame-Options. CSP in a meta tag cannot provide frame-ancestor protection. | Add frame-ancestor protection through hosting/proxy response headers; verify after deployment. |

The reset race and mailer error reflection were reproduced only with local fake storage/email services. No live password reset, email send or Jira mutation was performed.

## Controls checked

- Server-side account roles and developer-label/ticket ownership checks; manager-only history and mail access.
- Signed session expiry and account version checks; removed accounts/password resets invalidate older account versions.
- Random 256-bit password-link tokens, hashed storage, expiry, fragment-based reset links and removal of the fragment from browser history.
- Login/forgot/reset/AI rate limits; shared Redis limits when configured. In-memory fallback limits remain instance-local, and Redis increment/expiry is not a single transaction.
- Rendered Jira HTML is reconstructed with an allowlist. Event-handler attributes, script/iframe/style elements and unsafe link schemes are not copied. AI and history output use text nodes.
- AI role restrictions, explicit untrusted-data envelopes, read-only tool registry and authorized source reads. Prompt instructions alone are not a guarantee against prompt injection; server permissions remain the enforcement boundary.
- Internal attachments require ticket access, enforce file limits, use attachment downloads and `nosniff`, and sanitize filenames. Concurrent read/modify/write ticket updates are not transactional and can lose updates; this review did not demonstrate an authorization bypass from that behavior.
- GitHub Actions tests use synthetic fixtures and Pages upload includes only `public/`. Workflow action tags are not pinned to immutable commit hashes; pinning is an additional supply-chain improvement.

## Dependencies and tests

`npm audit` for the root (including development dependencies) and the proxy production dependencies reported **zero known vulnerabilities** at review time. This is registry-advisory coverage, not proof that the dependencies have no flaws.

All 129 backend/frontend tests and 53 browser checks passed (182 total). Existing functional tests do not cover every security finding above, so passing them does not negate the findings.

## Limits

The review does not cover unreachable/deleted Git objects, forks or externally copied credentials; production environment secrets, Vercel/SMTP/Redis logs, actual database exports, authenticated live account administration, Jira integration-account permissions, third-party account MFA, or provider-side retention. Public access checks used a small set of known paths. The custom secret scan is heuristic, rather than an exhaustive independent commercial/scanner audit. No passwords or real secret values were included in this report.

References: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [OWASP browser storage](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html), [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
