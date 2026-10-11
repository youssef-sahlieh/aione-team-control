# Modernize the dashboard workspace and ticket experience

The dashboard previously put navigation, filters and account actions into one
crowded header. This change adds a responsive sidebar/top bar, dedicated Overview,
Workload and Calendar pages, cleaner paginated ticket rows, compact filters and
user-scoped saved views, and a tabbed ticket drawer with draft/focus protection.

Existing ticket mutations, Jira transitions, bulk actions and source-specific
attachments remain on their current handlers. The proxy, role enforcement and
CSP are unchanged. Page/hash routes survive sign-in and browser Back/Forward.
Assignment-email preferences are in My Account; Internal Notes and other existing
row actions remain in the quick-action dialog. Calendar editing opens the normal
authorized ticket editor.

Validation: 36 proxy, 22 account, 19 frontend and 22 mocked Chromium browser tests
passed. Browser checks cover navigation, roles, sign-in/deep links, saved views,
drawer draft/focus behavior, failed saves, pagination selections and layouts at
320/375/390/768/1024/1440 px. Screenshots are generated in `test-results/` and
available in CI artifacts. Production tickets were not changed during tests.

See `docs/ui-redesign.md` for details and remaining limits, including partial
Jira history and further bulk/attachment browser coverage. Rollback is a revert
of this change; no data migration is required.
