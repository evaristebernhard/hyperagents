# DeepSeek integration and current parity boundary

This is an independent implementation, not Hyperagent's private source or backend.

## Configure a real provider

1. Rotate any key that has appeared in chat or source history.
2. In the deployment platform's private environment settings, or in this project's untracked .env on your server, set DEEPSEEK_API_KEY. Do not send the value in chat. .env.example deliberately contains an empty value.
3. Restart the existing Node service. npm run dev starts Vite and the API together; npm run preview serves the built frontend and API. A static-only server cannot supply generation.
4. Sign in using the existing owner account. A thread displays DeepSeek connected when the server has a nonempty key. This checks configuration presence, not provider authorization or account balance; a first real message is required to validate those.
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

Only bounded UTF-8 text attachments with matching saved file metadata are read (at most 16 KiB per file, further bounded in prompts). Images, PDFs, larger or binary files remain downloadable but are explicitly reported as not read. Text resources and history are truncated under documented implementation limits; this is not full-document retrieval or vector search. Skill documents supply instructions, not executable tools, and connection metadata supplies no authenticated integration access.

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

Browser control is intentionally excluded. External web search/research providers, image/video/audio/avatar generation, transcription, maps, executable apps, OAuth connectors, unattended schedules/live runs, multi-user permissions and billing are not implemented by this increment. Their existing configuration UI is not evidence of execution. This is a functional text-and-local-tools agent, not complete non-browser feature parity or a durable unattended runner.

## Verification boundary

Backend tests use isolated temporary SQLite/files/HTTP servers and injected provider streams; they do not consume provider credit or need a real key. Frontend tests may intercept the LLM endpoints and must be described as mocked protocol/UI tests. Live DeepSeek authorization, balance, latency, public deployment and reverse-proxy streaming still require a deployment with a securely configured replacement key. No live provider request with the exposed key was made.


Local verification for this increment: production build passes; backend suite covers provider streaming and actual local tool execution; browser protocol tests cover persistence, partial responses, navigation cancellation, staged tool commits, versions, table rendering and CSV download. Provider transport in automated tests is mocked; local tool functions, SQLite writes and download bytes are real. The fixture suite covers pre-existing UI flows, not provider authorization. An overloaded parallel settings test was rerun successfully in isolation.
