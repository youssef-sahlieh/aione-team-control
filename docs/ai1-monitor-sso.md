# AI1 Monitor sign-in from AION (revised architecture)

Goal: a person signed in to the AION dashboard opens the AI1 Monitor tab and is already signed in to the monitor,
with no second sign-in. The tab stays inside the dashboard.

The monitor lives in KAD-org/fileHostingService (branch `odoo-admin-dashboard`).

Written for: the teammate who owns the monitor code, and whoever reviews the AION side.

## Why this design

The first plan sent a 60-second token with every request. That was built on the assumption that the monitor's session
cookie can't be used inside an iframe. Checking the hosts shows it can:

- The dashboard is `https://dashboard.ai1.host` and the monitor is `https://monitor.ai1.host`. Both are in the
  `ai1.host` site, so for the browser this is same-site, not cross-site.
- The monitor's session cookie is `SameSite=Lax`. Lax cookies are sent in same-site iframes, and a same-site
  response may set one.

So the monitor can keep its normal session (Flask-Login, 8 hours) and only needs to get that session once from an AION
token. Per-request bearer tokens are not needed on this path.

The remaining blockers are: the monitor sends `X-Frame-Options: SAMEORIGIN` (which means the same origin, not
the same site, so the dashboard is refused), its CSP has no `frame-ancestors`, and the monitor has no route that accepts
an AION token.

**Assumption to confirm first:** the production AION dashboard is served from `dashboard.ai1.host`. The AION
allowlist also names `aione.biz` and `www.aione.biz` in the monitor's `_ALLOWED_ORIGINS`. If the dashboard is ever served
from `aione.biz`, the cookie approach does not work and section 7 (fallback) applies.

## Components

| Part | Where | Job |
|---|---|---|
| AION dashboard | `public/assets/app/workspace.js` (AI1 Monitor tab) | Embeds the monitor in an iframe; answers the monitor's token request with a fresh AION token. |
| AION token endpoint | `POST /sso/monitor` in `proxy/src/handler.js` | Signed-in people only; returns a 60-second token. Already built. |
| AION key endpoint | `GET /sso/monitor/keys` | Public key (JWK and PEM) for the monitor. Already built. |
| Monitor frame page | monitor dashboard page and `static/monitor/dashboard.js` | Asks for a token; posts it to the exchange route; then loads normally. |
| Monitor exchange route | new `POST /auth/aione/exchange` | Verifies the AION token, maps the email to a monitor account, starts the monitor session. |
| Monitor verifier | new `verify_aione_sso_assertion`, next to `verify_odoo_sso_assertion` in `actor_assertion.py` | Signature, issuer, audience, lifetime, `jti` replay. |
| Monitor framing headers | `response_security.py` (`apply_response_security`) | Lets only the AION dashboard frame the monitor. |

## Flow

### First open (no monitor session yet)

1. The person is signed in to AION and opens the AI1 Monitor tab.
2. AION creates the iframe with `src = https://monitor.ai1.host/dashboard`.
3. The monitor page loads and calls `GET /api/session`. There is no session yet, so it gets 401.
4. The page posts `{type: "ai1-monitor:need-token"}` to `window.parent`, with the AION origin as the target origin.
5. AION checks the sender origin and that the message comes from its own iframe, then calls `POST /sso/monitor` and
   replies `{type: "ai1-monitor:token", token, expiresAt}` to the monitor origin.
6. The monitor page accepts the reply only from the AION origin and from `window.parent`, then calls
   `POST https://monitor.ai1.host/auth/aione/exchange` with `{token}` in the JSON body and `credentials: "include"`.
7. The exchange route verifies the token (section 4), maps the email to an account, rotates the session, and sets the
   monitor's session cookie. Same-site, so the browser accepts it.
8. The page reloads its data. The person is signed in.

### Later opens (session still valid)

The iframe loads, `/api/session` returns the signed-in user, and nothing else happens. No token is needed.

### Session expired or signed out in the monitor

`/api/session` returns 401 again. The page repeats steps 4–8. This happens without a second sign-in if the person is
still signed in to AION.

### Signed out of AION

The monitor session is not ended by AION signing out. Section 6 decides how long this can last.

## Monitor side: what to build

### 1. Framing headers (`response_security.py`)
- For the monitor host, remove `X-Frame-Options` and send
  `frame-ancestors 'self' https://dashboard.ai1.host`.
- Keep `X-Frame-Options: DENY` and `frame-ancestors 'none'` for the partner host.
- Confirm which module serves the monitor first (see the audit findings below).

### 2. Exchange route (`POST /auth/aione/exchange`)
- Accept `POST` only, with `Content-Type: application/json`, and a body of `{token}`.
- Reject unless the `Origin` header is exactly `https://dashboard.ai1.host`. This is in addition to the token check.
- Verify the token (section 3). Any failure returns a bounded 401 with no detail; a repeated `jti` returns 409.
- Map the email to a monitor account. Recommended: only accounts that already exist (pre-provisioned), otherwise 403.
- Call `session.clear()`, then `login_user(user)`, set the session permanent, and issue a new CSRF token. This is the same
  sequence the Odoo callback uses.
- Respond with `Cache-Control: no-store`, and never echo the token.
- Record an auth event (`aione.signin`) with the email, the `jti` and the request ID. Do not record the token.

### 3. Verifier (`verify_aione_sso_assertion`)
Model: `verify_odoo_sso_assertion` in `actor_assertion.py` (about lines 253–345). It hardcodes the Odoo issuer, audience and
`sub` format, so write a separate function, or refactor the shared parts (signature, algorithm, `kid`, replay) into a
helper with parameters and keep the Odoo tests passing unchanged.

| Check | Odoo assertion (today) | AION token (new) |
|---|---|---|
| Algorithm | EdDSA | EdDSA only; reject `none` and anything else |
| Key | PEM by `kid` from `ODOO_ACTOR_PUBLIC_KEYS_DIR` / `ODOO_ACTOR_PUBLIC_KEY_FILE` | PEM by `kid` from `AIONE_SSO_PUBLIC_KEYS_DIR` (a separate set, so the trust sets never mix) |
| Issuer | `kad-odoo-monitor` | `aione-team-control` |
| Audience | `filehostingservice-web` | `ai1-monitor` |
| State | required | none |
| Lifetime | up to 120 s | `exp - iat` ≤ 60 s; reject expired; allow 60 s of clock skew |
| Subject | `odoo-user:<db>:<uid>` | the person's email |
| Required claims | `jti`, `sub` | `jti`, `email` |
| Replay | `odoo_sso_replays` by `jti` | same table pattern, separate subject, expired rows removed |

Keys: copy AION's PEM from `/sso/monitor/keys` into `AIONE_SSO_PUBLIC_KEYS_DIR` when the key changes. Keep the old and
new keys during rotation. Runtime fetching can come later.

Test cases: copy the eight cases from `test/monitor-sso.test.js` (valid, edited claims, expired, wrong `aud`, wrong `iss`,
unknown `kid`, `alg: none`, lifetime over 60 seconds), plus a repeated `jti`.

### 4. Frame page
- Post `ai1-monitor:need-token` to `window.parent` only with the AION origin as target.
- Accept `ai1-monitor:token` only when `event.origin` is the AION origin and `event.source === window.parent`.
- Call the exchange once per token. Do not keep the token after exchanging it.
- On `ai1-monitor:error` or a failed exchange, show: "Sign in to AION again, then reopen the AI1 Monitor tab."
- Outside an iframe, nothing changes: the existing Odoo and local sign-in stay.

### 5. Roles and policy
- AION's `role` and `dev` are inputs, signed by AION. The monitor's account record and policy decide what the person can do.
  This matches the monitor's own rule: "role signed from Odoo and rechecked by FHS".
- Mutations through the monitor on Odoo still need the Odoo-signed actor assertion. The AION session does not replace it.
- AION has no GitHub identity for a person. Any scope that needs a linked GitHub ID links through the monitor's Odoo/GitHub
  flow.
- Start with report mode for the Phase B policy (`FHS_AUTHORIZATION_POLICY_MODE=report`).

## Security checks

- The token never appears in a URL, a log, or the page after exchange. It travels only in postMessage and in the exchange
  body.
- The exchange is protected by the origin check, the single-use `jti`, and the short lifetime.
- The monitor session is rotated on exchange (`session.clear()`), which prevents session fixation.
- Direct visits to the monitor keep the Odoo and local sign-in. The frame path doesn't weaken them.

## Audit findings that still apply

- The audit could not confirm which module the container starts. `deployment/monitor-stack.yml` starts `app_odoo.py`, whose
  `/login` checks only a local password. `app.py` has the Odoo handoff, the cookie settings and `apply_response_security`.
  If `app_odoo.py` is the one served, the framing headers and the exchange route must be added there.
- A hardcoded database password fallback in `app.py` (about line 228, used when `DB_PASS` is unset). This is a credential
  in source, separate from this work. Rotate it and remove the fallback.
- `/clear_session` is a GET endpoint that signs the user out (`native_identity.py`, about line 920). Make it POST with the
  CSRF check, in the same change as the exchange route.
- The audit did not run the monitor's tests (`tests/test_native_identity.py`, `tests/test_actor_assertion.py`,
  `tests/test_standalone_dashboard.py`). Run them before and after.

## Order of work

1. Confirm the production AION host is `dashboard.ai1.host`, and the module the monitor container serves.
2. Verifier and key setting (section 3), with the test cases.
3. Exchange route (section 2), with origin and replay checks and a test that a cross-origin POST is refused.
4. Framing headers (section 1). Test that the monitor loads inside the AION dashboard in Chrome, Edge, Firefox and Safari.
5. Frame page (section 4). Test the first open, the later open, and an expired session.
6. Roles and policy in report mode (section 5).

## Decisions needed

1. **Session length for AION sign-ins.** The monitor session lasts 8 hours. If a person signs out of AION, they can stay
   signed in to the monitor in that browser for up to 8 hours. Options: keep 8 hours; or set a shorter session (for example
   1 hour) for sessions started from AION and re-run the handshake when it ends (recommended).
2. **Account creation.** Only pre-provisioned monitor accounts can sign in through AION (recommended), or new accounts
   are created from AION's team list.
3. **Who can use the monitor.** **Decided: everyone with a dashboard role.** That means both dashboard roles, `admin` and
   `user` (a developer with an `ai1_` label). AION already enforces this: `POST /sso/monitor` only issues a token to a
   signed-in dashboard account (`proxy/src/handler.js`), so no AION change is needed. The monitor must accept both roles,
   and its own policy still decides what each role can do (section 5).
   Consequence for decision 2: if everyone with a dashboard role can use the monitor, pre-provisioning every account by hand
   means keeping two user lists in step. See decision 2 for the choice.

## 7. Fallback if the dashboard is not on `ai1.host`

If the dashboard is served from a different site (for example `aione.biz`), the session cookie won't be sent in the frame.
Then the design needs a per-request token: the frame keeps the 60-second AION token in memory and sends it as
`Authorization: Bearer`, with a new token before expiry. The verifier, key, and error rules are the same; the exchange route
is replaced by a bearer check on the monitor's API routes. Do not change the cookie to `SameSite=None` for everyone.

## Testing on AION

- `npm test` runs `test/monitor-sso.test.js` (8 tests). Tokens are 60 seconds, and the tests reject anything longer.
- To see the handshake locally, run the local server and open the AI1 Monitor tab. The frame stays blank until the
  monitor side is changed.
