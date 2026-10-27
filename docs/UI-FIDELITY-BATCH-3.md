# UI fidelity — batch 3: Skills and Agent creation workflows

This batch implements the pre-submit workflows observed during the 2026-10-27 interactive audit. It builds on merged PR #3. It does not add model inference, casting generation, remote repository import, documentation analysis, OAuth or production automation.

## Skills creation

- The active Skills list in ContentHub now opens a four-method creation wizard instead of sending Create skill straight to a generic editor.
- Research: topic gating, Quick Learn/Interactive selection, conditional Initial description and mode-specific action.
- Documentation: independent URL and pasted-document drafts, preserved while switching modes or returning to the chooser.
- GitHub: repository URL form and nonempty gating. The action clearly reports that remote import is not connected and makes no network call.
- Files: a single-file dropzone, explicit selection/removal/import, validation for JSON/MD up to5MB and ZIP up to50MB. Merely selecting or dropping never creates a record.
- Valid JSON/MD can still be explicitly imported into the local workspace. Invalid files keep the dialog open. Cancelling during an asynchronous read aborts the import before a record is written.
- ZIP selection/size validation is implemented, but safe archive parsing/extraction is not. The UI says this explicitly; it does not invent a manifest or claim installation.
- The previous manual editor remains at /skills/new as an explicitly labeled local-only alternative. Existing legacy JSON/MD/TXT import and local CRUD remain available.

## New agent

- /agents/new?creation=manual now actually opens manual identity configuration.
- Create Agent/Save changes is disabled until a nonblank name and confirmed system prompt exist. Description stays optional.
- System prompt opens a transactional rich-text dialog. Close/Escape discard the current edit; OK applies text and sanitized formatting. The plain prompt remains available for existing local storage/export consumers.
- Formatting includes headings, bold/italic/strike, inline/block code, lists, blockquote, horizontal rule and browser-native undo/redo. This is a lightweight browser-native editor, not the original Tiptap implementation; exact toolbar artwork and history semantics are not claimed.
- Prompt HTML is sanitized before preview, apply and persistence; paste/drop input is filtered. Imported agent JSON remains supported, including safe restoration of this replica's optional promptHtml.
- Creation drafts are scoped to the active local workspace and survive navigation/reload. Explicit creation clears that workspace's creation draft. Draft storage is separate from workspace backups and is not a saved Agent or runtime.
- Trust profile leads to Knowledge. Connected/Read-only/Separate/Custom profiles coordinate learning visibility, memory read scope and save destination. Existing skill assignment/library controls are preserved.
- Legacy Recall-only memory is displayed as Read-only memory; unsupported older demo profile labels display as Custom memory. Existing stored Agent records are not automatically rewritten.
- Re-draft from a posting uses a confirmation dialog. Continue returns to the posting without deleting the currently confirmed identity; the unconnected Draft identity action does not fabricate replacement fields.

## Casting route

- Dedicated /agents/new/cast page, separate from the normal editor.
- Four example jobs fill the job field.
- Archetype / One Universe / Mixed Reel / Casting Director lenses with observed explanatory text.
- Non-Archetype lenses expose optional World text plus eight chips; switching preserves user input.
- Cast requires a job and explicitly reports generation is not connected, without creating candidates, portraits or an Agent.
- Skip — configure manually navigates to /agents/new?creation=manual, preserving the draft rather than generating an identity.

## Verification and compatibility

- New focused Playwright coverage exercises creation gates, prompt apply/discard, draft restore/clear, re-draft confirmation, trust profiles, casting, sanitization, skill wizard modes, file validation and local import behavior.
- Existing Agent tests now edit prompts through the dialog instead of assuming an inline textarea; existing local persistence/skill assignment tests remain part of full CI.
- Local npm ci is still blocked by HTTP403 on the yallist tarball. Build/typecheck/browser-test success must come from the existing GitHub CI, not be inferred from static checks.
- No dependency or lockfile changes are required.

## Deliberately left for following batches

- Marketplace theme/category routes/search/registry preview/native-detail refinements.
- Composer + inline Skills/Memories/Assets/Integrations/project selectors and mention model.
- Actual model-generated identity/candidates, skill research/import execution, safe ZIP package parsing, final installation, and populated-server states not captured in the audit.

This is a bounded workflow-fidelity improvement, not a claim that the entire app or every creation backend has been recreated.
