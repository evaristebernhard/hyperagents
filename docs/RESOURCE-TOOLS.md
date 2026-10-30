# Local resource tools

These tools execute over the isolated snapshot passed to `createWorkspaceTools` in `server/tools.mjs`. They do not grant access to additional workspaces or use a remote service. The caller must supply an authenticated/authorized `workspaceId` and current `threadId`, and the authoritative enabled capability list. Enabling an unrelated tool never exposes these definitions or permits their execution.

| Tool signature | Required capability | Semantics |
| --- | --- | --- |
| `search_threads({query, limit=10})` | Thread Search | Case-insensitive literal title/summary/message-text search. Max 20 results, 512-character titles, 1000-character summaries, 500-character excerpts. |
| `get_thread_messages({thread_id, limit=20, offset=0})` | Thread Search | Explicit thread, saved array order, max 50 messages/page. Fields are only `id`, `role`, `text`, `createdAt`; max 4000 text characters/message and 12000/page. `next_offset` resumes at the next unreturned message; truncated message text is indicated but is not continued. Offset equal to message count returns an empty terminal page; larger offsets fail. |
| `read_document({id, version_index?})` | Documents | Only Document artifacts, never Webpage/Table. Omit version index for current content; zero-based index selects the existing saved versions array. Max 12000 content characters, with truncation indicator. Workspace documents may be read across threads. |
| `update_document_section({id, section_name, operation, content})` | Documents | Only current-thread Document artifacts. Operation is append/prepend/replace; no missing-heading fallback. |

Thread tools exclude `archived`, `excluded`, `isSearchable:false`, and records explicitly marked with a different workspaceId. Documents apply the same record exclusion/workspace checks. Results are explicit projections, not serialization of saved records, contexts, configs, or versions. All tool arguments reject unknown own keys (including prototype pollution keys), custom prototypes, non-enumerable/accessor arguments, wrong types, and out-of-range values.

## Section edit semantics

`section_name` matches trimmed heading text exactly, case-sensitively. ATX headings (levels 1–6, including trailing closing hashes) and setext headings are recognized outside backtick/tilde fenced code. Missing or repeated heading names fail explicitly. The selected body includes nested subsections and ends before the next same/higher-level heading. Replacing a section replaces that body, not its heading or unrelated sections. Append/prepend separate nonempty fragments by a newline if needed. Markdown is not a full CommonMark AST: headings nested inside blockquotes/lists and inline-format normalization are not supported.

Document edits are capped at 100000 UTF-8 bytes (and the existing 100000-character content limit). The shared 256000-byte aggregate patch budget, at most 10 staged artifacts, and runtime call budget still apply. Each change saves previous content to version history; successive edits preserve the first original `{content,title,updatedAt}` CAS base. Validation and prepare-budget failures do not mutate the snapshot overlay or staged patches. The input state is never mutated.

## Parent integration

No registry, capability, runtime, persistence, or UI wiring was changed. The parent should synchronize `server/tools.mjs`, `server/resource-operations.test.mjs`, and this document, then register/map these four local tool names wherever explicit allowlists/routing require it, preserving the capability gates above. Section edits return the same `status: prepared` patch protocol as existing artifact/table edits; the host remains responsible for authorization, checking the original CAS base, and atomically committing patches after a successful run. Avoid translating a Documents or Thread Search enablement into any new workspace permission.

Validation: `node --test server/resource-operations.test.mjs` (six focused synthetic-fixture tests). No real workspace data or remote APIs are used.
