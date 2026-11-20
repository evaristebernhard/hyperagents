# Managed agent runtime (first implementation)

The real thread UI now uses authenticated managed runs instead of keeping generation alive through the browser's HTTP stream. The legacy /api/llm/chat endpoint remains compatible for existing clients/tests.

## What runs independently of the page

POST /api/runs creates a durable run for the final saved user message. Repeating that request returns the same run, including after completion. Runs and ordered events are stored in a separate private .data/agent-runs.sqlite database. GET /api/runs lists a thread's recent runs; GET /api/runs/:id/events?after=N replays cursor-based event pages. Closing the viewer or refreshing does not stop execution. The UI reattaches to active runs and explicitly distinguishes reconnecting from rerunning. Final answers and artifacts are persisted by the server against a fresh workspace revision, not by the viewing tab.

Default limits: two active runs, a bounded queue (20 admitted active/queued requests total), 20 minutes per run, 24 model rounds, 64 tool calls, existing output/context byte budgets. These application limits are separate from the WSL V2 gateway's concurrency of four. Server restarts mark unfinished runs interrupted and do not replay commands or model requests. This is viewing reconnection and durable history, not automatic execution resumption after a crash.

POST /api/runs/:id/cancel explicitly aborts generation and managed shell children. Plan/Ask modes do not expose execution tools; update_plan records a structured task plan without doing external work. Steps may use dependsOn to declare prerequisite IDs and childRunId to link a direct delegated run. Cycles and premature dependent progress are rejected; a linked step can complete only after its child succeeds and its result is saved. Previously recorded prerequisite and child evidence links must be retained; revised delegated work uses a new step. Unlinked plan completion still describes progress and is not proof of execution.

## LLM-controlled local shell

Enable Shell in thread Configuration. The model can call shell_execute with an exact command, cwd, and timeoutSeconds. Every command pauses for explicit approval in that thread. Approve and deny are scoped to the run and action, idempotent, and never accept replacement command text. A denied command does not execute. Restarted/expired approvals are not automatically retried.

The shell executes on the same WSL host as this Node server. No V2 gateway/Cloudflare credentials are copied into the app. Cwd must resolve within the project root (including symlink checks); timeout is 1..300 seconds; combined stdout/stderr returned is capped at 64 KiB; process groups are killed on timeout/cancel/exit. The child receives a minimal environment, not model/provider/integration secrets from process.env.

IMPORTANT: This is full authority of the Linux user, NOT a security sandbox. Cwd and environment controls do not prevent an approved command from reading/modifying other paths or accessing the network. Do not approve commands you do not understand, credentials in command text, destructive actions, or detached/background services. Login, Host/Origin checks and CSRF protections remain enabled.

## Read-only delegation

Enable Delegation and the needed read capabilities in the thread configuration. list_agents lists actual saved agents; delegate_agent starts an isolated child thread with a self-contained task. Its tools are the intersection of the parent's selection, the target agent's capabilities, and the runtime's read-only allowlist. Children cannot execute shell/skills, mutate artifacts, or delegate recursively. get_delegated_run and wait_for_delegated_run return actual status, resultSaved, and bounded output. Duplicate agent/task requests reuse the child. Two child slots are separate from the parent slots; up to eight direct children are allowed per parent.

A parent must wait for all children before its final answer. An early final answer fails and cancels unfinished descendants, rather than leaving orphaned work. Cancellation or parent failure also cancels outstanding children. Child completion alone does not verify the content of its answer; the coordinator must reconcile its actual evidence. The [warehouse acceptance case](verification-decomposition/README.md) exercises this path with two agents, linked plan steps, real document persistence, request deduplication, cancellation, and server reopen. Fixture and real-model evidence are recorded separately.

## Other capabilities and limits

Persistent browser control and saved-context continuation now have separate implementations; see [browser persistence](BROWSER-PERSISTENCE.md) and [run continuation](RUN-CONTINUATION.md). This document describes the current legacy SQLite /api/runs runtime used by npm run dev. The v1/PostgreSQL/Rust implementation is a separate entry and its historical checks are not evidence about the active deployment.

Image/video generation, new external credentials, webhook/live/schedule execution, cross-server worker recovery, and unrestricted autonomous shell access are outside this runtime. A read-only Web Fetch tool can use a local Moli binary when explicitly enabled. Tool calls within a run remain sequential, while independent child runs have separate slots. Token counts and elapsed time are recorded; no dollar cost is invented.

## Validation

Run npm run typecheck and node --test server/*.test.mjs. New tests cover managed run persistence, viewer independence, idempotency, cursor replay, cancellation, approvals, restart behavior, artifact persistence, shell deadlines/output/environment boundaries. Fake-provider integration tests must not be reported as a production model round trip.
