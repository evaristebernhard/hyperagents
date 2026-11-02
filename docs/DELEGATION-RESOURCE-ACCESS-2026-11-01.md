# Read-only delegated document and table access — 2026-11-01

This change extends the existing one-level managed delegation implementation. It does not create an agent, start a run, change a saved agent's tools, restart a service, or deploy code.

## Capability intersection

A parent run must have Delegation enabled. A delegated worker may receive Documents and/or Tables only when the capability appears both in the parent run's admission-time saved tools and in the selected workspace agent's current tools. Thread Search, Search and Find Similar remain eligible under the same intersection. `list_agents` reports this actual intersection rather than the target agent's independent capability list; this is a preview, not a guarantee that the capability or provider is configured or reachable. Admission still rechecks target availability and permissions.

When Documents is inherited the child can use `search_documents` and `read_document`. When Tables is inherited the child can use `search_tables` and `get_table`, including its summary mode. Search is literal, not semantic. Resources are scoped to the current workspace and are untrusted data.

Delegated workspace tools use an explicit function-name allowlist at both definition and dispatch boundaries. Generic `workspace_search`, `resource_read`, and `resource_read_page` are no longer exposed to delegated workers: they can cover broader resource and file types than the capability-specific grant. Document/table mutation, table export, shell, managed Files/Skills, integrations and further delegation remain unavailable. The change does not add new privileges to existing agent settings.

`get_table` now rejects archived, excluded, non-searchable or foreign-workspace records consistently with document reading. This applies to ordinary runs as well as delegated runs. Such a table is not readable while those flags apply; no table is modified by this change.

## Verification and operational limit

Focused tests include real local app/SQLite flows with a synthetic model: document and table search/read, summary mode, actual delegation results, permission intersection and rejection of forged write/broad-reader calls. The full backend suite and TypeScript check run against test environments, not the owner's live workspace or a real model provider. Existing delegated runs retain their admission-time authorization. New server behavior takes effect only after an authorized service reload/restart; this change does not itself reload a running server. No UI change is included.
