# UI fidelity — batch 2: menus, search and sidebar

Reference: the authenticated desktop browser observations from 2026-10-27, recorded in this project's audit. This batch builds on batch 1; it does not introduce LLM inference, browser control, real authentication or billing.

## Implemented from observed structure

### Composer

- Model settings now has six rows: Model, Reasoning effort, Provider, Tools, Integrations and Open full settings.
- Model opens the observed gated state: “Unlock every model / Subscribe to a plan to pick more powerful models”. Its action opens the existing billing preview. No selectable model catalog was visible in the audited account, so none is invented here.
- Rows open nested panels on hover or click. Arrow navigation, ArrowRight/ArrowLeft and Escape support navigating and dismissing nested panels; Escape from the top-level menu restores trigger focus.
- Reasoning/provider/tool choices are local component state, retained while the composer stays mounted. The provider list and tool toggle details are explicitly marked local-preview choices, not a verified reproduction of every original submenu item.
- Execution has two top-level modes, Plan first and Execute. Auto is now a nested control beside Execute, not a third top-level mode. Only the observed Auto state is offered; no unobserved policy list is invented.
- Agent picker has a search field, a STARTER AGENTS section with seven names and descriptions, locally saved agents when present, and Create from scratch.
- Starter names: Daily Briefing, Context Builder, Chief of Staff, Developer, Investment Analyst, Recruiter and Sales Prospector. Choosing one updates the local composer label only; it does not create or run an agent. Avatars are approximate local emoji/gradient treatments, not original artwork.
- Attachment menu retains Upload files…, Skills, Memories, Assets, Output as…, Integrations and Add to a project. The Integrations item was added in batch 1; existing local navigation/output selection is preserved.

### Search

- Replaces the generic titled modal presentation with a compact, headerless 576px desktop search surface, scoped to the active local workspace.
- Empty query presents recent non-archived threads and Go to navigation. Typed searches retain support for saved agents, projects, skills, rooms and artifacts.
- Groups and icons, selected-row shortcut hints and footer keyboard hints match the observed hierarchy. Date grouping uses the demo fixtures' display labels, not original account history or real timestamps.
- Arrow keys select and scroll results. Enter opens locally; Control/Command+Enter opens the selected route in another tab; Control/Command+C copies its URL unless text is selected in the input. Clipboard errors are surfaced. Escape and backdrop dismissal keep the existing modal focus restoration behavior.
- No cross-workspace or server-side full-text search is claimed.

### Sidebar

- Agents expands inline to saved agents, New agent and View roster.
- Recent threads and recent rooms use actual expanded/collapsed chevron states, with aria-expanded and controlled list identifiers.
- Workspace/account/Learning flyouts are anchored to the clicked control rather than fixed magic offsets. They support keyboard traversal and Escape focus restoration.
- Workspaces includes the active workspace and Create workspace. Additional saved local workspaces remain accessible; backups/workspace management are still available through Search → Workspaces.
- Learning contains Improvements, Rubrics and Autowiki.
- Account contains Account settings, Plan & billing with Free badge, Help & support, Add account and Sign out. Profile name/initials reflect the existing local profile; email remains demo data. Sign out returns to the demo login and does not manage a real session.
- Empty project collections show New project; populated local workspaces retain Projects navigation.

## Routes and remaining boundaries

- Existing /thread/:id and /featured/:slug routing is retained. No new featured detail pages or thread/canvas states are fabricated from the earlier failed thread visit.
- The original site account data, avatar files, paid model catalog, unobserved Auto policies, full Model settings panel internals and exact original mobile states require further observation.
- Long submenus have scrolling and narrow-view adaptations; these are usability safeguards, not a claim of a captured original mobile design.
- Skill/Memory/Assets attachment selection still follows the existing local pages rather than pretending to access original account resources.

## Verification

- Eight new Playwright scenarios cover model gating, local menu state, nested execution controls, starter-agent search, workspace search, new-tab shortcuts, sidebar flyouts and narrow-view submenu width.
- Batch 1's GitHub Actions check passed before this work started.
- Local dependency installation remains blocked by HTTP 403 from the npm registry (yallist tarball; standalone formatter metadata is also denied). No local build/Playwright/formatter success is claimed.
- Static patch checks and remote file verification are reported separately from runtime tests. The existing PR CI must validate this new commit before merge.
