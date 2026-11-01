# Managed read-only delegation runtime

## Scope and integration status

Implemented only in `server/agent-runs.mjs`, reusing `agent_runs`, private request JSON, `run_events`, the existing persistence callback and recursive cancellation. No workflow database, schema migration, synthetic agent, alternate provider or automatic replay was introduced. The new test suite uses temporary databases and a fake model; no external services or real user configuration are touched.

**App and LLM wiring are required before enabling this in production.** This patch deliberately does not modify either file. The existing LLM implementation does not yet enforce the new read-only execution contract. Do not treat supplying `readOnly` as sufficient until that boundary is wired and tested.

## Trusted host callback

Pass this optional callback to `createRunManager`:

```js
async createDelegatedThread({
  workspaceId, parentThreadId, parentRunId, agentId, task, tools
}) => ({ workspaceId, threadId, userMessageId })
```

The app must atomically save a **new** thread and its one user brief in the existing workspace-state storage before resolving. Set `config.agentId` to `agentId` and `config.tools` to the exact supplied intersection (or put these in the user message's `context.settings`). The message text must equal `task`. Do not copy parent history, attachments, contexts, project linkage, integrations or credentials. The child must have no project linkage and no message-context keys other than `settings`.

Use a deterministic child thread/message ID derived from the tuple `(parentRunId, agentId, exact task)`; a hash of JSON encoding that tuple is suitable. A retry after a thread-save success/run-admission failure must reuse that thread, not create another. Recheck parent thread and selected agent ownership in the host's atomic state transaction. Do not substitute an agent on failure. Runtime validates the saved isolation contract, then performs durable run admission; it reports failure if either stage fails. A host-save success followed by admission failure may leave the saved child thread without a run; this is deliberate, and deterministic IDs let an explicit retry reuse it.

Without this callback, dispatch fails clearly with a host-not-configured error. Listing real workspace agents remains available when the parent's saved tools contain Delegation.

## LLM execution contract — required parent integration

`buildConversation`, `llm.chat` request, and `persist` request receive only legal fields:

- `workspaceId`
- `threadId`
- `userMessageId`
- optional `model`

Internal `_runTools` and `_delegation` never cross those request boundaries. The public `create()` API accepts only the four fields and rejects `parentRunId`, `_delegation`, `_runTools`, `readOnly` and `allowedTools`. Legacy `createChild()` now fails explicitly rather than pretending same-thread admission is delegation.

For a delegated run the manager supplies trusted execution options:

```js
{ readOnly: true, allowedTools: ['Thread Search'], maxConcurrent: rootLimit + 2, ... }
```

`allowedTools` is a conservative capability-name intersection of the parent's **admission-time saved tools**, the selected real agent's `tools`, and this explicit read-only candidate set:

- `Thread Search`
- `Search`
- `Find Similar`

An empty intersection is valid: the child can reason over its supplied brief without tools. No Shell, Skills, Files, Delegation, Documents, Tables, Slides, Webpages, Artifacts, browser/session capability, integration or other capability is inherited. This intentionally excludes mixed read/write capability buckets rather than trying to guess their safe subsets.

At the LLM boundary, when `execution.readOnly === true`:

1. Derive enabled capabilities only from `execution.allowedTools`; do not union saved settings or skill-required tools back in.
2. Do not bind integrations, shell, skill executors, artifact writers, file exporters, media/storage or session-creation tools. No credentials inherited from the parent or user-selected connections.
3. Filter final tool definitions **and dispatch registry** to read-only implementations; model-supplied function names cannot bypass the allowlist. In particular local resource reads must not accidentally authorize a file export/write or an artifact mutation.
4. Retain only the manager's non-executing `update_plan` managed tool on children. No child can delegate further. The manager also rejects forged child calls to the delegation handlers.
5. Respect the manager's bounded provider concurrency (`rootLimit + 2`). Do not impose the old root-only global provider limit, which would reject every child while roots wait.

The manager additionally suppresses child artifact/approval patches in `persist`, but this is defense in depth, **not a replacement for definition/dispatch filtering**. Child generation and persisted answer remain real normal model calls in the saved child thread.

## Model-facing managed tools

Available only when the root run's admission-time saved `tools` explicitly include `Delegation`:

- `list_agents({})`: projects real non-archived agents in the current workspace: id, name, description, model and conservative candidate capabilities. No prompts, credentials or invented agents.
- `delegate_agent({agentId, task})`: validates active parent, workspace-local non-archived agent, permissions and budgets; saves the isolated brief through the host and durably admits a real child. Returns child run/thread/status and bounded output available so far. Exact parent/agent/task retries, including simultaneous calls, reuse a single admitted run. Failed attempts are not presented as successful work.
- `get_delegated_run({runId})`: direct-child + workspace checks; projects actual durable delta text and current status, not a fabricated answer.
- `wait_for_delegated_run({runId, timeoutSeconds = 30})`: one abortable EventEmitter wait, 0–30 seconds, no polling loop or implicit retry. On timeout returns current status; it does not pretend completion. Validates direct-child/workspace scope before waiting.

Results include `runId`, `threadId`, `status`, `resultSaved`, `text` (at most 12,000 characters), `truncated`, and any sanitized run error. Output comes from real durable delta events, including partial output on failure/cancellation; `resultSaved` distinguishes workspace persistence from event preservation. Other parents' runs, sibling roots and foreign-workspace runs are never readable through these tools.

## Admission, limits and lifecycle

- Root worker concurrency remains the configured `maxConcurrent`.
- Separate child worker pool: at most **2** concurrently executing child runs. Thus roots waiting on children cannot occupy every worker slot; total model concurrency is bounded at `maxConcurrent + 2`.
- At most **8 children per parent**, tree size **32**, existing maximum depth **3**, shared active queue limit **20**.
- This first model-facing delegation implementation is one level only: a read-only child cannot delegate further, even if its selected agent has Delegation enabled.
- Child metadata lives only in existing request JSON (`_delegation` with parentId, agentId, deterministic key and allowedTools); lineage remains in existing parent/root/depth columns.
- A parent is checked again after the awaited host save and after asynchronous conversation validation, so cancellation or permission changes cannot admit new child work unnoticed.
- Existing recursive `cancel()` aborts running child providers and cancels queued descendants. A wait is also interrupted by the parent's abort signal.
- Restart marks active roots and children interrupted and never replays work. Durable queued/events/results and the existing shell approval mechanism are retained. Root shell behavior is unchanged; child execution receives no shell runtime.

## Focused verification

```sh
node --test server/delegation-runtime.test.mjs
node --test server/agent-plan.test.mjs
node --test --test-name-pattern='two concurrent runs|approved real shell command|a real process restart' server/agent-runs.test.mjs
```

The six new tests cover real child model invocation/result, isolated saved brief, trusted permission intersection and no recursion, concurrent retry idempotency, root+child worker progress, public metadata-spoof rejection, scope/archived-agent rejection, running/queued descendant cancellation, host/admission failures, eight-child budget and bounded waits/results. The focused existing tests cover root concurrency, approved shell execution, durable plan and real-process restart behavior. App callback atomicity and the final LLM read-only registry filter need integration tests after the parent wires those components.
