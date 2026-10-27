# UI map and implementation boundaries

## Architecture

- `src/App.tsx`: History API router, global shell, search, homepage, room draft, thread list, namespaced local state.
- `src/Thread.tsx`: conversation, canvas, layout modes, working notes, title menu, Live dialog, thread details panel.
- `src/Agents.tsx`: roster, five editor tabs, local identity creation/editing, local JSON import.
- `src/ResourcesUI.tsx`: resource pages, project association, memory dialog, marketplace, library preview, learning and dashboard.
- `src/SettingsUI.tsx`: shared query-driven account settings dialog and 13 sections.
- `src/Marketing.tsx`: public homepage structure, carousel, output tabs, authentication-entry links and independent demo legal copy.
- `src/ui.tsx`: icon buttons, focus-managed dialogs, composer menus.
- `src/data.ts`: sanitized fixtures, local asset paths and safe localStorage reads.
- `tests/navigation.spec.ts`: routing, interaction, persistence and smoke checks.

## Observed UI rules preserved

1. The signed-in landing page is `/threads/new`, not a separately invented Home sidebar entry.
2. Sidebar Agents expands New agent and View roster. Learning opens a menu: Improvements, Rubrics, Autowiki.
3. Search opens above the current page and supports keyboard navigation. Selecting a result navigates to its route.
4. Composer settings, execution modes, files/context and output-format menus do not change the route.
5. Opening a conversation artifact selects the right canvas view without changing the conversation URL.
6. The thread configuration panel is query-driven by `panel=settings`.
7. Account settings preserves the background page. Selecting its left navigation changes `settings=...`.
8. `/settings/integrations` remains a compatibility redirect into the settings dialog, independent of deployment hosting.
9. Agent configuration tabs stay on the same Agent route.
10. Library artifact previews stay on `/library` rather than creating fake per-file URLs.
11. Projects link to their own context pages and to ordinary thread routes.
12. Marketplace uses a separate dark visual register, while the workspace follows the appearance preference.
13. Login / Sign up / Start shipping links in the public reference page lead to `/login`. Demo auth then offers an explicit local workspace entry.

## Settings parameter values

`personalization`, `appearance`, `thread-defaults`, `security`, `notifications`, `integrations`, `mcp-access`, `import-openclaw`, `import-manus`, `billing`, `usage`, `ai-providers`, `referrals`.

Account / Data access / Subscription are grouping labels, not settings pages.

## Scope and honest substitutions

This recreates the captured layouts and principal navigation flows; it is not a copy of the original private implementation. Fixtures and text are sanitized examples. No real user's account, private messages or identifiers are embedded.

A local Agent's identity can be edited; model/tool selection controls are UI-only and do not provision a configured runtime. The room draft demonstrates its form but does not create multiplayer rooms. Suggestions, rubric creation, publishing, sharing, billing, notifications and external connectors provide explicit preview messaging instead of pretending a backend action succeeded.

Public showcase image crops are local SVG wrappers with embedded JPEGs, so the UI does not depend on the original site's CDN. The sole optional external UI resource is Google Fonts; system font fallbacks remain functional offline.

## Deployment and tests

The default base path is `/`. `history.pushState`, popstate handling and server-side fallback enable ordinary path-based navigation. Nginx `try_files` is included. GitHub Pages automatic deployment was removed per the user's direction.

There are 41 Playwright tests. Visual captures help inspect layout, but no pixel-perfect golden comparison is claimed. The current mobile behavior is an adaptation; the original reference set was desktop-only.
