# DeepSeek integration and current parity boundary

This is an independent implementation, not Hyperagent's private source or backend.

## Configure a real provider

1. Rotate any key that has appeared in chat or source history.
2. In the deployment platform's private environment settings, or in this project's untracked .env on your server, set DEEPSEEK_API_KEY. Do not send the value in chat. .env.example deliberately contains an empty value.
3. Restart the existing Node service. npm run dev starts Vite and the API together; npm run preview serves the built frontend and API. A static-only server cannot supply generation.
4. Sign in using the existing owner account. A thread displays DeepSeek configured when the server has a nonempty key; it never labels configuration presence as a verified connection. Open Connection diagnostics from the thread header or Settings > AI providers. Local API and SQLite checks do not call DeepSeek. Choose a model and explicitly click Run small paid test to verify a real completion.
5. Send a short question. The answer streams into the conversation and is saved through the normal revision-checked SQLite state API.

Never set VITE_DEEPSEEK_API_KEY or commit the key. The browser sends saved resource IDs to the same-origin authenticated API; the server attaches the provider Authorization header. The key is removed from process.env before Vite initializes and never returned by /api/llm/config. No real credential is included in this change.

For the existing external domain, preserve APP_PUBLIC_ORIGIN=https://lp.chayu123.me and the existing owner/database configuration. Do not delete .data or reinitialize the owner. If using a reverse proxy, forward /api to the Node process, disable response buffering for /api/llm/chat, and allow at least 130 seconds for streaming responses. Do not expose the API without its existing Host, Origin, owner-session and CSRF checks.

## Provider contract

Fixed HTTPS endpoint: https://api.deepseek.com/chat/completions.

Current official model names checked on 2026-10-28:
- deepseek-flash (default)
- deepseek-v4-pro

Sources: https://api-docs.deepseek.com/ and https://api-docs.deepseek.com/api/create-chat-completion and https://api-docs.deepseek.com/guides/thinking_mode/ . The documented supported effort values are low/high/max; UI Low/Medium/High map to low/high/max respectively. Old or unsupported saved model identifiers fall back to Flash; no other model provider is called. An unsupported explicit model in the chat API is rejected.

The service enables thinking mode, caps generated tokens at 8192, cancels requests after 120 seconds, caps combined streamed output at 256 KiB, permits two active generations per process and one per thread, and rate-limits generation starts. These conservative limits are not the provider's model maximums. Long/high-effort answers may hit them. Reasoning is indicated as status, not displayed or saved as answer text. Provider failures are sanitized rather than forwarding arbitrary upstream bodies.

Authenticated GET /api/llm/config returns configuration presence and model names only. POST /api/llm/chat requires owner session, CSRF, trusted origin, and saved workspaceId/threadId/userMessageId. Only the final saved user message can run. SSE emits delta, reasoning, tool activity, validated artifact patches, done or error JSON data frames. No arbitrary endpoint or raw client-supplied conversation is accepted.

## Real behavior in this increment

- New tasks and follow-up messages request generated replies when configured.
- New-task auto-generation is requested once in sessionStorage; reopening an old thread does not silently rerun a paid request. Pending unanswered user messages have an explicit Generate reply button.
- Stop cancels the network request. Received text, if any, is saved with a partial-answer marker. A provider/network error likewise preserves received text with an interrupted marker.
- Completed answer text is persisted by the existing serialized, revision-checked state save queue. Conflicts do not silently overwrite another writer. A duplicate completed request is blocked for the lifetime of the backend process.
- Navigating away aborts generation. An unfinished transient stream is not guaranteed to survive navigation, tab closure or a server restart; this is not a durable background runner. Export a backup if persistence reports an error.
- Copy answer and Save as document create actual local results. Save as webpage requires returned HTML; it does not label arbitrary prose as a webpage.
- Selecting Doc or Webpage before sending asks the model for that format and saves a completed answer into the existing artifact system, linked to the thread and Library. Existing editing, sandboxed preview, history, download and explicit public-share functionality remain in place.

## Context actually sent

The server re-resolves resources from the requested saved workspace, rather than trusting arbitrary prompt bodies supplied by the browser. It uses bounded recent message history, the selected agent's prompt and linked skill documentation, explicitly selected skills/memories/artifacts, workspace pinned memories, project description/goal and thread notes. The latest message's saved settings determine model/mode/output format.

Only bounded UTF-8 text attachments with matching saved file metadata are read (at most 16 KiB per file, further bounded in prompts). Images, PDFs, larger or binary files remain downloadable but are explicitly reported as not read. Text resources and history are truncated under documented implementation limits; this is not full-document retrieval or vector search. Skill documents supply instructions, not executable tools, and connection metadata alone supplies no authenticated integration access; selected bindings additionally require a configured server API adapter and provider credentials.

## Executable local tools

New threads enable Thread Search, Documents, Webpages and Tables by default. Existing saved configurations are preserved: enable these names in composer Tools or thread configuration if an old thread has no tools selected. Only the corresponding tools are exposed to DeepSeek.

- workspace_search: search saved threads, projects, skills, memories, artifacts and attachment filenames in the current workspace, with bounded excerpts. Archived resources and knowledge-excluded threads are omitted from search.
- resource_read: retrieve bounded saved text or actual readable text attachments by workspace-owned ID. No arbitrary filesystem path or network URL is accepted.
- create_artifact: construct a Document or sandboxed HTML Webpage linked to the current thread.
- update_artifact: modify an existing artifact belonging to this thread, retaining the previous content in version history. Updates to a different thread's artifact are refused.
- create_table: construct validated string columns/rows as a real Table artifact. The UI renders the table and exports CSV with spreadsheet formula injection mitigation.

The server executes these functions over an isolated workspace snapshot; it does not merely echo tool names. Results are returned to the model in role=tool messages, allowing subsequent reads/updates and a final answer. The run is bounded to eight model rounds, twelve model tool calls and ten runtime executions. The service has no generic eval, shell or arbitrary HTTP tool.

Artifact changes are staged until the complete run succeeds. The UI validates their thread scope and compares the original content/title/timestamp for updates, then applies them with the final message through the existing revision-checked save queue. This avoids tool writes silently overwriting edits made during streaming. Tool cards say Result ready rather than claiming a database save before acknowledgement. Interrupted runs do not apply staged artifact changes; received answer text is marked partial. Navigation cancels execution and cannot later insert artifacts into another workspace. The model never receives credentials, connection secrets or a raw database dump.

## Not equivalent to all of Hyperagent

Browser control is intentionally excluded. General web search/research providers, image/video/audio/avatar generation, transcription, maps, executable apps, full OAuth onboarding and unimplemented service connectors, unattended schedules/live runs, multi-user permissions and billing are not implemented by this increment. Their existing configuration UI is not evidence of execution. This is a functional text-and-local-tools agent, not complete non-browser feature parity or a durable unattended runner.

## Verification boundary

Backend tests use isolated temporary SQLite/files/HTTP servers and injected provider streams; they do not consume provider credit or need a real key. Frontend tests may intercept the LLM endpoints and must be described as mocked protocol/UI tests. Live DeepSeek authorization, balance, latency, public deployment and reverse-proxy streaming still require a deployment with a securely configured replacement key. No live provider request with the exposed key was made.


Local verification for this increment: production build passes; backend suite covers provider streaming and actual local tool execution; browser protocol tests cover persistence, partial responses, navigation cancellation, staged tool commits, versions, table rendering and CSV download. Provider transport in automated tests is mocked; local tool functions, SQLite writes and download bytes are real. The fixture suite covers pre-existing UI flows, not provider authorization. An overloaded parallel settings test was rerun successfully in isolation.


## Marketplace skills and public data

Selected independently installed Marketplace skills can bind the fixed read-only World Bank, NWS and configured OpenAlex tools. The server re-resolves the source template and selected installation; it does not execute arbitrary code embedded in skill documentation. See MARKETPLACE-INTEGRATION.md for the complete dated inventory, per-item coverage, live NWS test, World Bank WAF failure and unconfigured OpenAlex boundary.


## Selected account integration tools

Configured integrations explicitly selected in a message now supply bounded real API reads and prepare-only write tools. Writes require owner confirmation outside the model loop, with signed current-thread/workspace scope and replay protection. See INTEGRATIONS.md for actual supported services and remaining limits. Connected Hyperagent accounts are not reused.


## Connection diagnostics (2026-10-29)

Authenticated GET /api/diagnostics returns API readiness, SQLite readability and revision,
Node version, and provider configuration presence/model allowlist. It does not return
paths, environment values, owner details or workspace contents. Opening or refreshing
the diagnostics panel never calls the provider and never changes workspace revision.

POST /api/llm/test requires the owner session, trusted Origin, CSRF token, an allowlisted
model and confirmed: true. It sends one fixed small non-streaming request with thinking
disabled and at most 16 output tokens. The server key is sent only to the fixed DeepSeek
HTTPS endpoint; redirects are rejected. The 15-second deadline covers fetch and body
reading, and the body is bounded to 64 KiB. Only status, safe error code, model, latency,
check time and cache status are returned. Neither model output nor provider error bodies
are returned. Results are reused per model for 30 seconds; simultaneous tests are refused
and the endpoint is limited to six requests per minute. A verified result means that model
returned a real completion at that instant, not that all tools work or availability is permanent.

The diagnostics UI distinguishes rejected credentials, insufficient balance, rate limits,
model access, timeouts and connection/service failures. It never accepts or reveals API keys.
Normal server mode replaces the placeholder ChatGPT connection UI in Settings > AI providers;
fixture mode retains its existing UI regression samples.

For an explicit live end-to-end smoke test, run on your server:

    node scripts/verify-provider.mjs --confirm

This spends two small provider requests, uses an isolated temporary SQLite database and
random temporary owner password, verifies a real SSE completion, saves/reloads the answer
through the revision-checked API and checks persistence after a server restart. It does not
modify the real owner database, print credentials or expose a server publicly. Automated
unit/browser tests still use mocked provider transport; live test results must be reported
separately, never inferred from configuration or fixture tests.


### Live verification on the authorized WSL node — 2026-10-29

The explicit smoke test completed against the real configured DeepSeek Flash provider:
small non-streaming completion, authenticated SSE answer with expected marker,
revision-checked answer save/reload, and persistence after restarting the temporary backend.
The provider probe took 984 ms in that run. This was separate from mocked automated tests.
The existing owner database and credentials were not changed. This verifies that deployment
at that moment, not other models, integrations, public reverse-proxy streaming or all media tools.
