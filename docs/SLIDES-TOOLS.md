> 主线整合状态：下方交接清单已落实（包括父CSP确切脚本hash、产物类型、运行持久化、UI和版本校验），真实Chromium iframe导航smoke通过。TypeScript声明已补充，未用ts-ignore掩盖类型错误。

# Structured Slides: integration handoff

## Storage and API

Slides are a **distinct `kind: "Slides"`**, not Webpages. Artifact `content` and every version's `content` are JSON strings of this structure:

```json
{"title":"Quarterly review","slides":[{"title":"Results","body":"Revenue grew 12%.\n• Main result\n• Next step","notes":"Optional speaker notes"}]}
```

Bodies are **plain text** (Markdown/HTML syntax displays literally). There is no HTML/script mode. Deck/slide titles are nonblank and at most 240 characters; body 6000; optional notes 4000; 1–40 slides; serialized JSON at most 300000 characters. Existing workspace/patch byte caps may impose a stricter total. Unsupported keys, invalid data types and raw HTML documents are rejected.

`server/slides.mjs` is a pure, dependency-free module usable by both the Node server and browser:

- `SLIDES_PARAMETERS_SCHEMA`: full `publish_slides` JSON-schema parameters `{title, slides}`.
- `validateSlides(value)`: strictly validate/clone structured input.
- `serializeSlides(value)`: validate and serialize for artifact storage.
- `parseSlidesContent(string)`: validate stored/updated artifact JSON, return structured deck.
- `buildSlidesHtml(deckOrJsonString)`: validate and generate complete safe HTML for preview/download/export.
- `SLIDES_LIMITS`, `SLIDES_CSP`, `SLIDES_SCRIPT_HASH`, `SLIDES_NAVIGATION_SCRIPT`.
- Validation errors expose `status:422`, `code:"VALIDATION"` and a human-readable message.

Suggested publish integration:

```js
import { SLIDES_PARAMETERS_SCHEMA, serializeSlides, parseSlidesContent, buildSlidesHtml } from './slides.mjs';
// Add publish_slides definition using SLIDES_PARAMETERS_SCHEMA, gated by Slides.
// After existing scope, quota, ownership and enabled-tool checks:
const artifact = { /* standard artifact fields */, title: args.title, kind: 'Slides', content: serializeSlides(args), versions: [] };
// update_artifact: when existing.kind === 'Slides', call parseSlidesContent(args.content)
// before staging it. Never change kind or store buildSlidesHtml output as content.
// Optional safe export: existing authenticated file storage with
// content:buildSlidesHtml(artifact.content), MIME text/html, filename *.html.
```

Do not bypass normal patch limits, version history, permissions or ownership checks. The publish schema uses nested object items: the current generic tool checker does not recursively validate objects, so **always call `serializeSlides`** even when upstream JSON schema validation exists. When updating title separately, artifact title is the Library label; the JSON deck title supplies the internal presentation title (update both if desired).

## Preview security

`src/slide-preview.tsx` imports that same renderer and uses `sandbox="allow-scripts"`, deliberately **without `allow-same-origin`**, network permission, popups, forms or top navigation. The generated meta CSP is before styles/content, defaults to `none`, and allows exactly the hash of the one fixed data-free navigation script. Script event attributes are blocked. Images, fonts, frames, media, connections, forms, base URLs and external resources are blocked. User text is escaped into text nodes only; no raw HTML path exists. Existing Webpage renderer/sandbox is untouched.

Decks use fixed 1280×720 canvas with resize-aware fit/letterboxing; one page visible at a time; previous/next buttons; arrows; dots; counter; horizontal touch swipes ≥50px; Escape posts `{type:'close-fullscreen'}` to parent. Navigation messages accept only `window.parent` and direction `prev`/`next`. The React preview verifies the **exact iframe contentWindow** before turning its Escape message into the app's normal close event (opaque origins alone are not trusted).

The script hash is static and verified in tests. If editing navigation, recalculate the SHA-256 base64 hash of the exact `SLIDES_NAVIGATION_SCRIPT` text and update `SLIDES_SCRIPT_HASH`; do not add `unsafe-inline` or relax CSP.

Library supports Slides filter, distinct icon, safe preview, JSON editing, version restore and generated `.html` download. Type conversion is intentionally unavailable for an existing Slides artifact (history must remain structured); existing non-Slides cannot be converted to Slides in this editor. Imported `.html` stays an inert Webpage, never executable Slides. Shared snapshots validate Slides JSON and reuse the same preview/export path. Canvas uses a Presentation icon.

## Required parent-owned edits (not changed by this implementer)

These files are outside the allowed edit list and **must be updated before compilation/integration**:

1. `src/local-model.ts`: replace Artifact's current inline kind union with `import type { ArtifactKind } from './types'` and `kind: ArtifactKind` (new alias in `src/types.ts` includes Slides). Without this, the new UI comparisons produce TS2367 errors.
2. `src/workspace.tsx`: add Slides to artifact-kind validation allowlist; invoke `parseSlidesContent` for Slides current/version content in imported snapshots if possible. Server validation already validates current and versions. The existing allowlist otherwise rejects restored/persisted Slides snapshots.
3. `server/tools.mjs`: register/gate `publish_slides`, expose schema, serialize structured input; extend `canKind` mapping for Slides; validate Slides in `update_artifact`; preserve normal budgets/history. Never put Slides through the arbitrary Webpage HTML path.
4. `server/llm.mjs`, `server/capability-authority.mjs` and related parent-owned capability/settings surfaces: route Slides to the real tool, not a fake text/Webpage fallback. Enable only when supported.
5. `server/app.mjs`: managed-run patch commit allowlist currently accepts only Document/Webpage/Table; include Slides. **Critical preview CSP integration:** its static-file response currently sends `script-src 'self'` (~line 399). `srcdoc` inherits that parent CSP, so the iframe meta policy alone cannot authorize the navigation script. Import `SLIDES_SCRIPT_HASH` from `./slides.mjs` and append **only that exact hash source** to the parent's `script-src`, e.g. `script-src 'self' '${SLIDES_SCRIPT_HASH}'`. Do not add `unsafe-inline`, change Webpage sandbox, or weaken its own `script-src 'none'`. This narrowly allows the known fixed navigator; the Slides iframe's stricter meta CSP still blocks everything else. Any export MIME allowlist currently excluding text/html needs a narrowly validated generated-Slides path if implementing server-side HTML export. Client Library HTML downloads already work without changing server export paths.
6. `src/RealThread.tsx`: add Slides to the thread canvas kind-filter options. Existing editor will show JSON, ArtifactView renders safely; optionally label the text editor as structured JSON. No need to permit arbitrary HTML.
7. Search other shared-snapshot/backend persistence allowlists during unified wiring. `SharedThreadPage.tsx` and `server/validation.mjs` are already updated here.

No dependencies installed. No full suite/build run (no node_modules). Focused validation executed:

```sh
node --test server/slides.test.mjs   # 5 passed
node --check server/slides.mjs
node --check server/validation.mjs
```

Tests cover schema/types/field/slide/total limits, escaping and no injected scripts, exact hash/CSP consistency, generated fixed canvas plus real navigation-script execution in a minimal VM DOM (buttons/dots/keys/parent messages/Escape/swipe), and snapshot validation of both current/history JSON. A browser render smoke test should follow unified wiring on the main workspace.
