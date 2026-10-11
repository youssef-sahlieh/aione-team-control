# AION AI v1

The top-bar AION AI button opens a read-only chat panel. Questions can cover
authorized Jira tickets, descriptions, recent comments, prioritization, deadlines,
project updates and administrator workload. Verified ticket keys open dashboard
details. Messages survive closing/reopening the panel during the current page
session; New chat, reload and sign-out discard them. No conversation is written
to browser storage or the application database. The server receives up to 12
recent messages, trimmed further to fit the request budget.

## Activate locally

Users receive ticket help only: their authorized ticket descriptions, comments,
deadlines and personal priorities. Their chat starters exclude management reports.
Managers (the application's `admin` role) also receive team workload, project
progress, weekly summaries and delivery-risk options. Manager tools are omitted
for users and forged calls are rejected server-side. The server selects role
instructions from the authenticated account; chat history cannot elevate access.
Both experiences remain read-only. Ticket data access is enforced by the proxy;
the model's refusal of off-topic requests is instructed through its system prompt.

Copy `.env.local.example` to `.env.local` and configure Claude:

```dotenv
AI_VENDOR=anthropic
ANTHROPIC_API_KEY=your-api-key
AI_MODEL=claude-sonnet-5-5
```

Use a model available to your Anthropic account; see the official
[model IDs](https://platform.claude.com/docs/en/models/overview).
For OpenAI, set `AI_VENDOR=openai`, `OPENAI_API_KEY`, and an OpenAI `AI_MODEL`
instead. Explicit vendor selection is recommended if both keys exist.
Run or restart
`npm run dev`, then open `http://localhost:3000`. Keys remain on the server and
`.env.local` is ignored by Git. The local AI route verifies the existing sign-in
against the deployed proxy's `/config` and reads Jira through its authenticated
`/jira/search`. Local chat uses live authorized Jira data and the configured model
API, so normal provider usage charges apply. Without the selected provider's key and model the panel
hides the AI launcher and does not send questions to the model. Configuration
instructions remain in this guide rather than in the dashboard.

## Activate on Vercel

Set `AI_VENDOR=anthropic`, `ANTHROPIC_API_KEY` and `AI_MODEL` in the proxy's Vercel
environment (or the OpenAI settings above) and deploy the
updated proxy and dashboard. Existing Jira credentials and authentication remain
in place. `/config` reports only AI availability and read-only mode. No key is
sent to the frontend. Local preview uses its local model settings independently
of Vercel. The application has not been deployed as part of this implementation.

## Integration boundary

`public/assets/ai-assistant.js` and `.css` own chat presentation, focus handling,
session messages, question retry, loading states and safe plain-text rendering.
`proxy/src/ai.js` owns request validation, rate/budget limits, the conversation
loop, read capabilities and the model adapter. Claude uses Anthropic's
[Messages API](https://platform.claude.com/docs/en/api/messages/create), translating
the same capability registry into `tool_use`/`tool_result` messages. Signed
thinking blocks, when returned, are replayed unchanged during tool rounds.
No hosted web, code execution, or Jira write tools are provided to either model.
The optional OpenAI adapter uses OpenAI's
[Responses function-calling API](https://developers.openai.com/api/docs/guides/function-calling)
with `store: false` and stateless replay of tool/response items. This disables
response storage; it is not a claim of Zero Data Retention. The server-only
`AI_PROVIDER` function seam supports provider replacement/testing without
changing the frontend or Jira tool layer.

`/ai/chat` authenticates before any model access. Its read-search callback reuses
the existing proxy route, project restriction and authenticated developer label
scope. Tools additionally filter returned rows before any ticket data reaches
the model. The model cannot submit arbitrary JQL, URLs, credentials or HTTP
methods. Dashboard display filters are independent of AI authorization: a user
can ask about all their AI1_ Jira tickets, including those assigned to Others.
Admin access follows the existing application's project permissions; the proxy
uses its configured integration account rather than the user's personal Jira
OAuth identity.

Read capabilities: `search_tickets`, `read_issue`, and admin-only
`analyze_workload` and `analyze_project_progress`. Both manager tools are omitted for developers and rejected if
forged. Searches inspect at most five pages/500 tickets, return up to 100 ticket
summaries within a 24,000-character payload budget, and disclose incomplete
coverage. Search totals cover every examined ticket even when fewer summaries
fit. Details include up to 20 comments within a 14,000-character comment budget
from Jira's returned comment page and disclose partial coverage. Weekly summaries
use updated dates, not invented completion dates or a complete changelog.
Internal INT tickets and full comment/changelog pagination are outside v1.

Descriptions, comments, history and model output are treated as untrusted data.
No model output is executed. Only citation keys read through authorized tools
become clickable links; other keys remain plain text. Answers should still be
checked against Jira, especially when coverage is incomplete.

Requests are limited to 32 KB, a 2,000-character question and 12 history messages.
The service allows ten chats per account per minute (shared Redis limiter when
available, instance-memory fallback otherwise), up to eight tool calls/five model
rounds, and a 45-second conversation deadline. Each response has a token cap.
Provider error details and credentials are not returned to the browser.

## Ticket brief column

When AI is configured, the ticket list includes **AI brief**. Press **Generate brief** on a Jira row to produce one or two short sentences (up to 40 words / 320 characters) explaining its title and description. On small screens the brief sits beneath the title. Briefs are generated on demand, retained in page-session memory, and invalidated when the ticket's updated timestamp changes. Reload and sign-out clear them; they are never stored in browser storage. Internal INT tickets do not support AI briefs in v1.

The authenticated `/ai/brief` endpoint accepts only a project ticket key, reuses the existing authorized ticket reader, and checks availability before model access. The model receives only that authorized title and bounded description, with no tools, comments, credentials or chat history. Briefs and chat share the ten-request-per-minute limit and provider configuration. No status, label, date, assignee or comment writes occur. Failures offer a per-row retry; unavailable AI hides the column. Sparse descriptions may produce limited explanations. Read the ticket for authoritative details.

## Reserved actions

The server has a disabled write capability list for status changes, developer
assignment/removal, comments and ticket creation. These capabilities are never
advertised to the model. Model write calls, unknown capabilities, client action
envelopes, AI routes other than chat/brief, and mutation methods are rejected server-side.
The AI service has no Jira mutation callback at all. No v2 activation flag exists.

V2 should add a separate action service with validated proposals, explicit user
confirmation bound to the current account/ticket/action, and execution through
the existing authenticated proxy. Recheck permissions at execution time. Do not
enable v2 by merely adding tool names to the read registry.

## Verification

`npm test` includes 22 AI backend tests for authentication, authorized reads,
cross-project/developer isolation, partial comments, administrator workload,
rejected writes, malformed requests, pagination, limits, and the model adapter.
`npm run test:e2e` includes eleven AI browser tests for chat history, ticket links, ticket briefs,
safe rendering, role suggestions, hidden unavailable controls, failure states, keyboard focus,
and layouts at 320/1440 px. Tests use synthetic Jira/model data and never contact
production Jira, Claude or OpenAI. Live model quality and credentials have not been tested.
