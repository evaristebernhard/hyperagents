# Tool foundation — unified registry, dispatcher and run tracing (2026-10-29)

## What this phase adds

Local adapters were already real (13 provider APIs / 31 operations, workspace artifacts,
approval-gated shell, read-only public data), but each had its own dispatch branch and
their traces lost arguments. This phase does not add fake capabilities; it makes the
existing executors composable and observable:

1. `server/tool-registry.mjs` — single registry + dispatcher:
   - Bindings carry `source` (workspace/public-api/integration/shell/managed) and
     `effect` (read-only/local-staged/approval-gated/mixed/orchestration).
   - JSON-Schema-subset validation (objects, arrays, enums, unions, bounds, prototype
     pollution keys) runs BEFORE any adapter executes; unknown or malformed calls never
     reach executors; definitions are cloned per projection; no automatic retries.
   - `tool_catalog` model tool: discovery of THIS run's authorized tools only. Discovery
     never installs, connects, authorizes or spawns anything; Plan modes disable it.
   - `argumentShape()` traces argument field names/types/lengths only — never values,
     commands, paths or tokens. `toolResultOutcome()` classifies staged/approval/error.
2. `server/llm.mjs` — the tool loop now dispatches every call through the registry and
   emits durable `tool_trace` events (started/finished, source, effect, outcome,
   durationMs) next to existing `tool` events. Existing SSE contract is unchanged.
3. Plan modes keep exactly `update_plan`; catalog only binds when executors exist.

## Evidence

- `npm run typecheck` passes; `node --test server/*.test.mjs`: 241/241 pass
  (includes new tool-registry 9 tests, tool-routing 3 real-loop tests, and all
  pre-existing llm/agent-runs/shell/integrations/tools suites).
- Real-loop tests verify: catalog→artifact routing, staged `prepared` outcome trace,
  integration approval stays `awaiting_approval` with zero write execution, and Plan
  mode exposes no executors.
- Iterations: initial wiring broke agent-plan expectations (catalog in Plan mode) and
  had a syntax error; both were fixed and the full suite re-run — final state is the
  241-pass run above, not the first attempt.

## Reference projects (reviewed, licenses verified; nothing imported yet)

- MCP TypeScript SDK (Apache-2.0/MIT transition, packages `@modelcontextprotocol/client`
  /`/server`): the only recommended future dependency, for external tool adapters.
- pi-mono→earendil-works/pi (MIT): registry/subagent dispatch design reference.
- LangGraph.js (MIT), Mastra (Apache-2.0, `ee/` excluded): patterns only; full adoption
  rejected as overlapping the existing durable-runs runtime.

## Deliberately not claimed

No new user-facing tool kinds, no browser/MCP/subagent execution, no scheduler. Next
steps: child-run dispatcher on durable runs (parentRunId, allowlists, budgets), MCP
client adapter behind the registry, and artifact validation tooling.
