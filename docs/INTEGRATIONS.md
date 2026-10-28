# Real API integrations for the single-owner replica

This version replaces server-mode connection-label placeholders with 13 real service adapters and 31 bounded operations. The frontend-only fixture demo is unchanged and still does not call external services. Existing metadata is preserved, not silently treated as verified access.

## Use an integration

1. Update the server from main and install/build dependencies normally. Preserve .data, the owner account and your existing APP_PUBLIC_ORIGIN.
2. Supply your own provider credential in the private server .env or deployment secret settings. .env.example lists empty variables, not real keys. Do not commit tokens, paste them into chat, put them into endpoints/labels, or use VITE_ variables.
3. Restart the existing Node service. The startup runner captures and removes integration credentials from process.env before initializing Vite. Secrets are not returned by status endpoints or stored in workspace metadata.
4. Sign in to the replica and open Settings > Integrations. Refresh API status. Credentials present means configuration only, not verified permissions. Click Test and enable: the backend calls a real identity or minimum read API. Only an acknowledged test and workspace save enables the binding.
5. Add that integration using the composer's Add files or context > Integrations picker before sending a task. Merely keeping a connection enabled does not expose its tools to every conversation. Up to eight selected connections can participate in a task.
6. Read results stream through actual API calls. Write requests produce an exact-content approval card. Review the destination/arguments and click Confirm write to perform the action. A model-generated request by itself cannot send or write.

Hyperagent's connected accounts and this replica are separate authorizations. This app cannot borrow a GitHub/Slack connection from Hyperagent, extract its token, or fake an OAuth sign-in. This first personal-use release uses server-owned API credentials/pre-authorized Google tokens. It does not implement a browser OAuth consent/callback flow. Provider scopes and resource sharing remain necessary even after a successful identity test.

## Implemented services and operations

| Service | Reads | Confirmed writes | Server credential |
|---|---|---|---|
| GitHub | First 20 repositories, open issues, bounded UTF-8 file content | Create one Issue | GITHUB_TOKEN |
| Slack | Public channels, recent history in an accessible channel | Send one message | SLACK_BOT_TOKEN |
| Notion | Search, page properties and bounded children | Create one child page | NOTION_TOKEN |
| Airtable | Accessible bases, bounded table records | Create one record | AIRTABLE_TOKEN |
| Gmail | Message IDs/search and bounded inline text parts | Create one DRAFT, never send | Google token configuration |
| Google Calendar | Upcoming events | Create one timed event, without guests/notifications | Google token configuration |
| Google Drive | File metadata | None | Google token configuration |
| Google Docs | Bounded text from the first document tab | Append text to the first tab | Google token configuration |
| Google Sheets | Bounded finite A1 range | Append string rows using RAW values | Google token configuration |
| Telegram | Pending updates, without acknowledging an offset | Send one bot message | TELEGRAM_BOT_TOKEN |
| Linear | Bounded issues | Create one issue in a selected team | LINEAR_API_KEY |
| Stripe | Customer and invoice basic metadata | None; no charges, transfers or refunds | STRIPE_SECRET_KEY |
| Asana | Project tasks | Create one task | ASANA_TOKEN |

Reads are deliberately bounded (generally first 20 items; provider-specific limits can be smaller). Pagination, binary downloads, all historical messages and arbitrary provider API requests are not implied. Stripe exposes basic IDs/status/time metadata, not full accounting, card details or money actions. Google Docs reads/append cover the first tab, not every tab. Gmail does not send email or fetch binary attachments. Telegram getUpdates can conflict with a bot already using a webhook; this app will not delete that webhook or acknowledge updates silently.

## Minimum setup and access

### GitHub

Use a fine-grained personal token scoped only to intended repositories: Metadata read, Contents read for file reading, Issues read/write for the confirmed create action. Token access to a repository is still required; the app never substitutes another repository when access fails. [REST authentication](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api), [Issues](https://docs.github.com/en/rest/issues/issues).

### Slack

Use your own app's bot token. Public channel listing needs channels:read, history needs channels:history and bot membership, sending needs chat:write. Private channels/DM discovery is not included by this adapter. Add the bot to the intended channel. A passed auth.test is not proof of every later scope. [Web API](https://docs.slack.dev/apis/web-api/), [Scopes](https://docs.slack.dev/reference/scopes/).

### Notion

Create an internal integration and share the intended pages with it. Enable read content and insert content for the supported operations. The integration token does not grant access to every workspace page. The code pins a documented Notion API version; source comments identify it. [Authorization](https://developers.notion.com/docs/authorization), [Page creation](https://developers.notion.com/reference/post-page).

### Airtable

Use a personal access token with schema.bases:read, data.records:read and, only if needed, data.records:write. Explicitly grant target base access. [PAT setup](https://airtable.com/developers/web/guides/personal-access-tokens), [Scopes](https://airtable.com/developers/web/api/scopes).

### Google Workspace

Enable the relevant APIs in your own Google Cloud project and obtain consented tokens separately. This release accepts either GOOGLE_ACCESS_TOKEN for temporary use or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN for automatic offline refresh. Leave GOOGLE_ACCESS_TOKEN empty when using the refresh trio; a supplied access token takes precedence and is not automatically replaced after it expires. Cached refreshed tokens are shared across the Google adapters and refreshed before expiry; failed writes are never automatically retried.

Useful scope suffixes under https://www.googleapis.com/auth/:
- Gmail: gmail.readonly; creating drafts also needs gmail.compose (Google may grant sending capability with that scope, but this app exposes no send action).
- Calendar: calendar.events.readonly / calendar.events.
- Drive metadata: drive.metadata.readonly.
- Docs: documents.readonly / documents.
- Sheets: spreadsheets.readonly / spreadsheets.

Docs/Sheets connection testing additionally discovers an existing accessible file with Drive files.list and performs an actual read. It requires drive.metadata.readonly or suitable app-authorized drive.file access. No existing file or insufficient permissions produces a failure, not a fake successful connection. Google may require app verification for sensitive/restricted scopes. [Offline consent and refresh](https://developers.google.com/identity/protocols/oauth2/web-server#offline), [API scopes](https://developers.google.com/identity/protocols/oauth2/scopes).

### Telegram, Linear, Stripe and Asana

Use a Telegram bot you own; the bot must have access to the target chat and cannot initiate contact with arbitrary users. Linear uses its personal API key in the documented Authorization format, with Read/Create permissions and intended team access. Prefer a restricted read-only Stripe key for Balance (identity test), Customers and Invoices. Asana uses a personal token with access to the selected project. All sends/task/issue writes still need explicit per-action confirmation.

Official references: [Telegram Bot API](https://core.telegram.org/bots/api), [Linear authentication](https://linear.app/developers/graphql), [Stripe API](https://docs.stripe.com/api), [Asana authentication](https://developers.asana.com/docs/authentication).

## Confirmation, scope and failure semantics

The model sees read operations and prepare-prefixed write operations, never an automatically executing write tool. Preparation validates arguments and creates a signed, short-lived action proposal bound to exact workspace/thread/connection/provider/operation/arguments. The token contains no provider credential. The confirmed API endpoint requires the owner session, trusted origin, CSRF and matching current workspace/thread. Enabled bindings are re-resolved immediately before each integration read and confirmed write. Disabling a connection stops subsequent calls; it cannot undo a call that already reached the provider.

An action nonce becomes executing before any outbound write. Concurrent/repeated confirmation does not send again; completed tokens return the saved in-process result. An uncertain network/provider outcome becomes unknown and is never retried automatically: inspect the external service before requesting a new action. Approval records expire after ten minutes and restart invalidates old tokens. This is an in-process confirmation broker, not a durable job queue or distributed exactly-once guarantee. After an ambiguous result, a fresh proposal can still create a duplicate if the owner ignores the warning; provider verification is necessary.

Forked/imported conversations retain history but strip executable approval tokens and dismiss pending copies. A token displayed in a copied workspace/thread cannot execute or replay against its original scope. Public shares project text only, not approval tokens or connection credentials. Workspace backups may contain short-lived approval records, so keep exports private; imported copies lose execution authority.

Disabling a workspace binding is not token revocation at the provider and does not change another workspace's binding. Server credentials belong to this app's single owner; workspace selection controls which credentials a task can use, not separate multi-user authorization.

## Still not implemented

AgentMail, Ahrefs, Databricks, Magic Patterns, QuickBooks, Supabase, YouTube and generic/custom MCP do not have active adapters in this increment. The server-mode UI says so and offers no fake connect success. No credentials from Hyperagent's native/MCP connections are transferred. Browser control, unattended integration workers and full OAuth onboarding remain outside this change.

## Verification

Automated adapters use synthetic credentials and injected HTTP mocks. Tests exercise request URLs/headers, JSON wire serialization, response projections, authentication failures, Google refresh, selected-binding isolation, live disable/revocation, confirmation signatures/scope, copied approvals, replay, ambiguous errors and frontend persistence. No real external message, issue, page, task, calendar event or draft was created during implementation. Live account acceptance still requires the owner's server credentials and the real Test and enable action; successful mocked tests are not a live account authorization claim.
