# Workspace resources and the agent runtime

The original sidebar, centered composer, conversation layout and artifact canvas remain the entry points. There is no separate Tasks workspace. The implementation follows the observed interaction inventory in `OBSERVED-PARITY-2026-10-29.md`, `THREAD-PARITY-2026-10-31.md`, and the [public Hyperagent thread example](https://hyperagent.com/featured/out-of-home-campaign). It does not claim access to Hyperagent's private implementation.

## Resource → task → review → reuse

- Memories, Skills, Agents, Projects, Rooms and Rubrics are persisted through authenticated `/api/v1/resources` endpoints with per-record revision checks. Concurrent edits return a conflict instead of overwriting another member's work.
- The composer selects an Agent, Skills, Memories, existing artifacts, a Project and Rubrics. A task stores the selected resource revisions and contents. Relevant saved memories are retrieved locally, using Unicode tokens and pinned-memory ranking; there is no paid embeddings service.
- Agent briefs and skills become task context; agent tool selections restrict the tools the worker can execute. Delegated work inherits those restrictions and the original workspace. Rubrics are also supplied to delivery review.
- `knowledge_search` and `thread_search` retrieve workspace knowledge and prior conversations. They do not search other workspaces. Memory profiles restrict retrieval and proposal behavior.
- `learning_propose` creates a pending Memory, Skill or Wiki suggestion. Learning shows the source thread and explanation. Accepting the suggestion writes a resource in a transaction; dismissing it leaves saved knowledge unchanged. No automatic memory write occurs.
- Library uses the real artifact/version/file records. Repeating an output filename in the same conversation appends a version; it does not create competing copies. Downloads and previews use the selected saved version.
- Inbox lists actual tasks needing input/recovery, pending learning and scheduled run history. Autowiki lists approved pages and source tasks; a user can request another page through the same agent/review flow.
- Marketplace installs independently authored instruction templates. Researching a skill or reading public documentation starts a real task that submits a skill proposal for review. JSON/Markdown import and manual editing remain available. Arbitrary ZIP/code installation is not enabled.

## Teams and execution

Personal workspace IDs and data are preserved. Creating a team adds a separate workspace. Invitations are email-bound, single-use, expire after seven days, and grant admin/member/viewer access. A new invitee receives their own personal workspace as well as team membership. Existing accounts can accept the token from Workspaces. Invitation links are displayed for manual sharing; the application does not send email.

Workspace members share that workspace's rooms, conversations, resources and files. Roles and membership are checked on every request; viewers cannot submit tasks or mutate resources. Removing a member revokes access and resets affected session selections. Private workspace resources are not copied into a team. Room notes and selected agent briefs are task context, and shared room notes retain author attribution.

Enabled schedules run daily at the configured local time (the UI currently uses Asia/Shanghai). Occurrences are persisted and task creation is idempotent across workers/restarts. Claimed occurrences are reconciled after a restart; entirely missed time slots during downtime are not backfilled. Schedules are disabled by default. External messaging, purchases and publishing are unavailable.

## Free public services

Web search parses public Bing RSS with another Bing endpoint and DuckDuckGo HTML fallback. It does **not** use Exa or another paid search API, even if an old Exa environment variable exists. Search results are snippets, not verified evidence; the agent separately reads and cites original sources. Public requests retain DNS/IP pinning, private-network rejection, bounded responses and timeouts. Search availability depends on the public sites; blocked pages produce an explicit error.

Image lookup uses the public, keyless [Wikimedia Commons / MediaWiki Imageinfo API](https://www.mediawiki.org/wiki/API:Imageinfo). Results retain source URLs, authors and license metadata. This finds existing images; it is not image generation. Reuse conditions must be checked on the source page.

No new paid provider, account or subscription is created. Image generation, video/audio generation and external account actions remain unavailable until a suitable free service is configured. The public Nominatim endpoint is not offered as a generic agent map/search tool: its [usage policy](https://operations.osmfoundation.org/policies/nominatim/) restricts that use. The existing configured DeepSeek model is still used for agent reasoning; this change does not make model inference free.

## Failure handling and recovery

The activity timeline shows each task's searches, program/output, saved files and errors. Empty threads do not reserve an unused canvas column. All task events resume from cursors, including after refresh; canvas choices persist on the conversation.

Python/JavaScript source outputs are supported. Common runtime labels normalize to `python`/`node`. A successful calculation and a failed file delivery are reported separately, with stdout retained. Each sandbox operation starts with a fresh filesystem; prior saved files must be explicitly supplied as inputs. Source-code inputs are staged with a `.txt` extension for compatibility with the existing runner protocol.

Model request timeouts are reported as `MODEL_TIMEOUT`, distinct from user cancellation. The user can explicitly resume a saved run after a transient model failure. Uncertain execution is never automatically replayed. Model delivery review receives saved resource context and actual tool evidence; it can verify that learning was proposed without requiring the proposal to have been accepted.

## Running and migration

```sh
npm run build --prefix backend
npm run dev:v1
```

The launcher applies additive PostgreSQL migrations and serves the UI on `http://localhost:5173`, with `/api/v1` proxied to port 8081. Keep the existing runner running. Existing accounts, databases and files are retained. The database was backed up privately before the resource migration; credentials, backups and runtime state remain excluded from Git.

The API adds workspace membership/invitation selection, resources, Learning, Inbox, Library, conversation metadata revisions, and task context. Existing task requests remain valid. OpenAPI is available to authenticated users at `/api/v1/openapi.json`.
