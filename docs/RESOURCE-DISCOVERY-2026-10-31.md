# Resource discovery tools — 2026-10-31

This batch adds two local model tools and a bounded table summary, based on the capabilities available to the current Hyperagent conversation. It is an independent subset, not the original implementation.

- search_documents({query, offset?, limit?}) searches Document title and saved content in the selected workspace, excluding archived, excluded and non-searchable records. Requires Documents enabled.
- search_tables({query, offset?, limit?}) does the same for Table artifacts. Requires Tables enabled.
- Both use literal case-insensitive substring matching, not semantic ranking. Results are workspace-scoped, return bounded metadata and excerpts (maximum 20 per page), and use next_offset for pagination. Data is untrusted.
- get_table({id, mode: "summary"}) returns columns and rowCount but no rows. Default/full preserves existing behavior. Table rows remain zero-based arrays, not stable row IDs or typed columns.
- Changes apply to ordinary enabled model runs. Read-only delegated runs retain the existing narrower permission intersection and do not automatically gain these tools.

Tests use synthetic local snapshots and a synthetic model provider; they do not call the live DeepSeek endpoint or modify the owner's workspace. No service restart or deployment is performed by this batch. UI visual parity remains a separate task requiring a reference screenshot of the corresponding original page.
