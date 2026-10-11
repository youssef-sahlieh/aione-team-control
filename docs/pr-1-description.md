# Establish UI regression baseline and extract ticket normalization

The dashboard mixes ticket normalization with rendering and API operations, making
UI changes difficult to verify. This change extracts the existing normalization
and developer-label helpers into `public/assets/models/issue.js`, while retaining
the current Jira/internal data contract and browser sanitizer.

Adds eight frontend model tests, synthetic fixtures, and nine Playwright browser
tests covering source-specific drawers, deep links, developer defaults and board
restrictions, local filtering/grouping, session expiry, load errors, and rendering
at 320/768/1440 px. All external browser requests are intercepted; these tests
cannot modify production Jira or send mail.

CI now runs the existing backend tests plus model/browser tests on pull requests
and before Pages publishing. PR runs do not deploy. The baseline document records
the permission matrix, DOM/state/API dependencies, issue contract and follow-up
risks for incremental extraction and redesign.

Validation completed locally:

- `npm test`: 36 proxy + 22 account + 8 frontend tests passed.
- `npm run test:e2e`: 9 browser tests passed in Chromium.
- `git diff --check`: passed.
- Visual review of desktop/mobile screenshots under `test-results/`; CI uploads
  these images with browser test artifacts. The current 320 px drawer header
  partly clips Close; recorded as existing responsive work for a later PR.

No proxy, authentication, hosting or workflow behavior changes. Complete filter
parity, mutation/partial-batch browser coverage, full authentication browser flows
and the redesigned shell remain follow-up PRs. Rollback is a single PR revert;
there is no backend or data migration.
