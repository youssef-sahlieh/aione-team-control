# Free hosted AI: Groq

AION supports Groq's hosted Free plan with openai/gpt-oss-120b for its existing authenticated chat, ticket briefs, and calculated-report explanations. This is an open-weight OpenAI model hosted by Groq; no OpenAI or Claude subscription is used. It works from the deployed proxy while your computer is off.

## Activate

1. Create/sign in to a Groq account at https://console.groq.com and keep it on the **Free** plan. Check account quota and data controls there. Do not enable Developer billing if you want no provider usage charges. The application cannot determine your billing plan from an API key.
2. Create a key at https://console.groq.com/keys. Store it directly in the existing proxy's Vercel environment as GROQ_API_KEY; never put it in frontend configuration, Git, a report, or a chat message.
3. Set these server environment variables:

    AI_VENDOR=groq
    GROQ_API_KEY=<server secret>
    AI_MODEL=openai/gpt-oss-120b
    GROQ_DAILY_REQUEST_LIMIT=100

4. Deploy the proxy through the repository's normal release process. In **Sync errors**, check that the Groq AI key works and the selected model is available. This read-only health check does not run model inference or verify the account's billing/quota balance.
5. Ask AION AI about a known authorized ticket, then request an administrator management report. Verify counts and citations against the deterministic report. Repeat with a developer account and verify billing/team tools remain inaccessible.

For local development, copy .env.local.example to the ignored .env.local, add the key there, and run npm run dev. This uses live authorized data through the existing proxy; use automated synthetic tests for write verification.

## Limits and behavior

Exact provider limits depend on the account and may change. Every model/tool round consumes a request and tokens, so the provider request limit is not a number of completed AION chats. See https://console.groq.com/docs/rate-limits.

A daily 100-inference-call cap is shared across the configured Jira project, reset by UTC date. Redis coordinates it across deployed instances. Without STORE, the local development cap is in process memory and resets on restart; it is not a shared production quota. Invalid cap configuration and storage failure block inference. Attempts, including failed provider calls, count conservatively. The cap bounds requests, not dollars, and does not replace the provider's Free-plan controls.

Long tool evidence is reduced with an explicit model-context coverage note; calculated totals remain unchanged. Oversized conversations ask the user to narrow the request. Rate limits return a clear message without repeated requests, another model, or a paid provider fallback. The existing 45-second conversation deadline, 8-tool limit, safe rendering, access checks, and verified ticket citations remain. Reasoning text is neither displayed nor replayed.

Calculated reports remain available when AI is disabled, offline, or quota-limited. This integration reuses existing Jira/internal reporting tools; the broader cross-source Reporting V2 plan remains future work.

## Privacy

Only existing role-authorized ticket/report evidence is sent to Groq. Billing stays administrator-only. Jira/Odoo credentials and integration tokens never enter model input. Descriptions/comments/tool output remain untrusted data. No hosted browsing/code tools or ticket-write functions are enabled. Groq account privacy/retention settings apply: https://console.groq.com/docs/your-data.

## Verification

Run npm test and npm run test:e2e. AI tests mock Groq tool calls, defaults, limits, errors, usage caps, permission isolation and key redaction. Live provider quality/quota and deployed activation require the account's own key; mocked tests do not prove live activation.
