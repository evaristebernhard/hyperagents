# Managed agent runtime (first implementation)

The real thread UI now uses authenticated managed runs instead of keeping generation alive through the browser's HTTP stream. The legacy /api/llm/chat endpoint remains compatible for existing clients/tests.

## What runs independently of the page

POST /api/runs creates a durable run for the final saved user message. Repeating that request returns the same run, including after completion. Runs and ordered events are stored in a separate private .data/agent-runs.sqlite database. GET /api/runs lists a thread's recent runs; GET /api/runs/:id/events?after=N replays cursor-based event pages. Closing the viewer or refreshing does not stop execution. The UI reattaches to active runs and explicitly distinguishes reconnecting from rerunning. Final answers and artifacts are persisted by the server against a fresh workspace revision, not by the viewing tab.

Default limits: two active runs, a bounded queue (20 admitted active/queued requests total), 20 minutes per run, 24 model rounds, 64 tool calls, existing output/context byte budgets. These application limits are separate from the WSL V2 gateway's concurrency of four. Server restarts mark unfinished runs interrupted and do not replay commands or model requests. This is viewing reconnection and durable history, not automatic execution resumption after a crash.

POST /api/runs/:id/cancel explicitly aborts generation and managed shell children. Plan/Ask modes do not expose execution tools; update_plan records a structured task plan without doing external work.

## LLM-controlled local shell

Enable Shell in thread Configuration. The model can call shell_execute with an exact command, cwd, and timeoutSeconds. Every command pauses for explicit approval in that thread. Approve and deny are scoped to the run and action, idempotent, and never accept replacement command text. A denied command does not execute. Restarted/expired approvals are not automatically retried.

The shell executes on the same WSL host as this Node server. No V2 gateway/Cloudflare credentials are copied into the app. Cwd must resolve within the project root (including symlink checks); timeout is 1..300 seconds; combined stdout/stderr returned is capped at 64 KiB; process groups are killed on timeout/cancel/exit. The child receives a minimal environment, not model/provider/integration secrets from process.env.

IMPORTANT: This is full authority of the Linux user, NOT a security sandbox. Cwd and environment controls do not prevent an approved command from reading/modifying other paths or accessing the network. Do not approve commands you do not understand, credentials in command text, destructive actions, or detached/background services. Login, Host/Origin checks and CSRF protections remain enabled.

## Not implemented in this phase

No browser automation, image/video generation, new external credentials, webhook/live/schedule executor, multi-agent delegation, cross-server worker recovery, or unrestricted autonomous shell access. A read-only Web Fetch tool can use a local Moli binary when explicitly enabled. Tool calls remain sequential. Token counts and elapsed time are recorded; no dollar cost is invented.

## Validation

Run npm run typecheck and node --test server/*.test.mjs. New tests cover managed run persistence, viewer independence, idempotency, cursor replay, cancellation, approvals, restart behavior, artifact persistence, shell deadlines/output/environment boundaries. Fake-provider integration tests must not be reported as a production model round trip.
