# Local browser verification

Run with the local Playwright Chromium against the current same-tab redirect design.

| Suite | Passed | Failed | Skipped | Retries/flaky |
|---|---:|---:|---:|---:|
| Cross-repository Monitor SSO (redirect.spec.js) | 4 | 0 | 0 | 0 |

The earlier framed-design run (142 existing + 5 SSO) is superseded: the framed flow was removed, and the
existing suite was not re-run in this change. See README.md for setup and transport limitations.

Passing these browser tests does not verify production TLS/ingress, the real PostgreSQL schema/transactions,
or per-account authorization configuration.
