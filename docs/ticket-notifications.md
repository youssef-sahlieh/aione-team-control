# New-ticket emails for Youssef and Ellen

When a new **AION Jira ticket** is created and still has **no `ai1_` developer label**, the proxy emails **youssef@aione.biz** and **ellen@aione.biz**. The message includes its title, status, assignee, priority, due date, and links to the ticket in AION and Jira.

This runs through Jira Automation, even with the dashboard closed. It does not depend on the current user's assignee filters or saved views. Tickets for any assignee in the AION project qualify. Internal tickets require a developer at creation, so they do not qualify.

## Activate in production

The code alone does not turn on alerts. Deploy the proxy, then configure this rule in Jira.

1. In the **aione-team-proxy** Vercel project, ensure the existing Gmail mailer (`GMAIL_USER` and `GMAIL_APP_PASSWORD`) and Upstash storage are configured.
2. Add `JIRA_NOTIFICATION_SECRET`: a new random secret with at least 32 characters. Keep it in Vercel and Jira's hidden header; do not use a Jira API token or team password. To generate one locally: `node -p "require('node:crypto').randomBytes(32).toString('hex')"`.
3. Recipients default to the two addresses above. Optionally override them with `NO_DEVELOPER_NOTIFY_TO`, a comma-separated list of `@aione.biz` addresses. An empty override disables delivery by returning a configuration error. Redeploy after changing environment variables.
4. In the **AION project → Project settings → Automation**, create a rule named **New ticket without developer — notify managers**.
5. Choose **Work item created / Issue created** as the trigger. Scope the rule to AION. Do not use an updated or scheduled trigger: existing tickets are not backfilled and removing a developer does not send a new-ticket alert.
6. Add **Send web request**:
   - URL: `https://aione-team-proxy.vercel.app/notifications/jira-created`
   - Method: `POST`
   - Header: `Content-Type: application/json`
   - Header: `X-AION-Webhook-Secret: <the secret from step 2>`; select **Hidden**.
   - Body: **Custom data**, with the JSON below.
   - Enable waiting for the response so errors are visible in the automation audit log.
7. Enable the rule. Create a real new AION ticket without a developer label to verify both mailboxes receive the alert. This sends a real email; also check Junk folders. A ticket created with an `ai1_` label should not send an alert.

```json
{
  "webhookEvent": "jira:issue_created",
  "issue": { "key": "{{issue.key}}" }
}
```

Jira's [Send web request action](https://support.atlassian.com/cloud-automation/docs/jira-automation-actions/#Send-web-request) supports custom bodies and hidden headers. Imported or copied rules lose hidden values; re-enter the secret when copying the rule.

## Delivery behavior

- The endpoint requires the webhook secret; ordinary user sessions cannot trigger it. It reads ticket data from Jira itself and sends only to the configured recipients.
- Any `ai1_` label, including an unknown developer or mixed capitalization, excludes the ticket. Done tickets are excluded. This matches the dashboard's No developer category.
- Successful alerts are recorded by Jira issue ID in Redis, so repeated deliveries and redeployments do not ordinarily resend them. Simultaneous calls are locked.
- Email or Jira failures return an error and leave the event retryable. Review the Jira automation audit log and retry the web request if needed; automatic delivery/retry is not guaranteed by this endpoint.
- SMTP cannot guarantee exactly-once delivery: if sending succeeds but saving the sent marker fails, or a process stops between those steps, retrying may send a duplicate. A failed multi-recipient SMTP delivery can also partially deliver. The sent marker records provider acceptance, not inbox delivery.
- No dashboard setup controls or recipient controls are added. To stop alerts, disable the Jira rule.

Run `npm test` for authentication, scope, escaping, role restrictions, duplicates, simultaneous calls, and retry tests. Tests use fake Jira and email services and do not send real emails.
