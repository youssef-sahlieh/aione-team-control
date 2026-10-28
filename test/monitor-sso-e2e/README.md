# Local Monitor SSO browser tests

Run from the Aione Team Control checkout. Requires Node.js, installed npm dependencies, Python 3.10+,
and a separate fileHostingService checkout containing the Monitor SSO implementation.

PowerShell:

~~~powershell
npm ci
npx playwright install chromium
python -m venv .venv-monitor-e2e
.\.venv-monitor-e2e\Scripts\python.exe -m pip install -r test/monitor-sso-e2e/requirements.txt
$env:AIONE_MONITOR_REPO = 'C:\Users\ellenh\fileHostingService'
$env:AIONE_TEST_PYTHON = (Resolve-Path '.venv-monitor-e2e/Scripts/python.exe').Path
npm run test:e2e:monitor-sso
~~~

Choose an environment directory outside the checkout if you do not want an untracked virtual environment.
No production environment file, signing key, browser profile, database, or running Monitor service is needed.
The Python server binds only to 127.0.0.1 on an ephemeral port; Playwright stops it after the suite.

The browser loads the real Team Control frontend and Monitor templates/JavaScript at their HTTPS production
origins, with all content and API traffic intercepted and served locally. Team Control's real token issuer
uses an in-memory user store and an ephemeral Ed25519 signing key. Monitor uses its real start, callback,
exchange, verifier, replay handling, session expiry, and security headers with a small synthetic database
adapter. The Monitor's server-to-server redeem call goes to the real Team Control redeem handler, served on
loopback by the test process. Peripheral ticket and infrastructure reads are stubs; infrastructure mutations never run.

Transport details: Playwright intercepts before Chromium adds Fetch Metadata, so the bridge derives
Sec-Fetch-Dest from the actual frame/navigation type. HTTP redirect responses become local meta-navigations
because Chromium does not route redirected network requests through page.route. This keeps the browser on
the real entry URL while preventing redirected requests from reaching production. Response security headers
and browser Secure/HttpOnly/SameSite session cookies remain in effect.
These tests do not verify production TLS, ingress redirects, PostgreSQL transactions/schema, or deployed configuration.

Coverage (test/monitor-sso-e2e/redirect.spec.js):
- Same-tab round trip: dashboard link, Monitor start, dashboard with the state, one-time code, Monitor callback,
  signed-in Monitor session for the linked account.
- No token-shaped value appears in any URL the browser visited, in the code response, or in the Monitor's storage.
- Bob signs in on a browser where Alice's Monitor session is still valid, and Bob replaces her.
- A person with no AION link is refused, and the earlier Monitor session does not stay signed in.
- A used sign-in callback is refused and the existing Monitor session stays signed in.

Sign-in callback policy (shared with the AI1 Monitor, see its docs/aione-monitor-sso-deployment.md):
- A callback whose state doesn't match this browser's state cookie (missing, reused or forged) returns 400 and
  changes nothing. A forged link can't sign anyone out.
- A callback with a matching state whose code is refused (unknown, expired, used, or an account that can't use
  AI1 Monitor) ends the current Monitor session, so a failed sign-in never leaves the previous person signed in.

Playwright failure traces may contain synthetic tokens. They are test credentials only; never use production
credentials with this harness. To inspect a failure: npx playwright show-trace <trace.zip>.

Not covered here: the admin route that creates and links a first-time AION account (covered by the Monitor's
Flask tests in tests/test_aione_sign_in.py), and the account-recreation issues reported separately.
