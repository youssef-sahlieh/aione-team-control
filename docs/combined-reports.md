# Combined ticket reporting

The Checks & Reports page automatically opens one administrator-only server-saved snapshot from GET `/reports/latest`, using workflow `all`. It includes all retrieved Jira and internal tickets, including old closed tickets. Completeness, delivery, hours and management are local views of that snapshot. Odoo/operational report sources are not added by this change.

Default order is the returned source order, with no additional sort. Filters include report type, client, sub-client, developer, status, source, billing and text. Sorting is optional. Changes to filters, period, sorting and pagination do not call the API or AI. Only the optional Refresh report button (POST `/reports/refresh`) refreshes the snapshot; generation time and partial-source warnings stay visible. Snapshot age is not hidden by changing filters.

Created/completed counts and grouped hours use the chosen Asia/Jerusalem period. Open work and delivery risks remain current snapshot findings. Summary totals and CSV exports use the selected filters; exported rows include the whole filtered result, not only the current page. Shared developer tickets count once per selected result. Unknown hours remain unavailable.

Performance: the backend already scanned and enriched all tickets for each individual workflow, so the combined mode adds no source scans or history lookups. It returns more records when previously excluded tickets exist, so initial transfer time can increase with response size; unchanged end-to-end latency is not guaranteed. Local filter operations reuse formatted dates, text input is debounced, no default comparator runs, and ticket/group rendering is limited to 50 rows per page. No account data is persisted in browser storage by the report browser.

Saved reports are stored privately by Jira site/project. The first request generates a report only if none exists; later reads return the saved report without source scans. Snapshots older than an hour are labelled as old and are not automatically rebuilt. Explicit refresh uses a distributed lock; an incomplete refresh never replaces a previous complete snapshot. The sample preview precomputes its report before accepting requests.

Compatibility: deploy the backend advertising `reports-all-v1` and `reports-saved-v1` before the frontend. An older backend is explicitly rejected rather than silently treating a limited management report as a complete snapshot. Administrator authorization and server persistence requirements remain enforced.
