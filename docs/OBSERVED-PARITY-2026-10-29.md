# Observed product parity — 2026-10-29

This is an independent implementation. Observations below came from the real logged-in
Hyperagent product UI and its public featured example, not from assumptions about private
server code. No source-account resources were created, modified, installed or published.
No paid task was submitted to the source product. Personal account values are omitted.

## Observed surfaces and implementation boundary

| Surface | Actually observed | Replica status / gap |
| --- | --- | --- |
| New task | Centered composer, model / Agent / Execute controls, featured task gallery | Existing local task creation and server-backed conversations; DeepSeek-only execution |
| Composer context | Upload files, Skills, Memories, Assets, Output as, Integrations | Actual local attachments/context and selected supported API bindings; not all source integrations |
| Output formats | Image, Video, Audio, Webpage, Slides, Table, Map, Doc | Document, sandboxed Webpage and Table execute; do not claim media/map generation |
| Thread settings | Model & compute, Subagents, Autonomy & safety, Capabilities | Local supported model/context/tool settings; no generic child-agent runtime |
| Autonomy | Auto / Ask first and run limits 10/30/60/90 min/4 hours | Integration writes remain per-action confirmed; source duration choices are not implemented |
| Capabilities | Research, Browser, Data, Interactive, Media, Integrations; browser residential IP / CAPTCHA options | Only implemented local/public-data/integration tools execute; no browser automation runtime |
| Agent creation | Identity, Model, Tools & integrations, Invocations, Knowledge | Existing editable local agents; UI metadata is not proof that external triggers execute |
| Agent identity | Job brief or manual name/description/system prompt, appearance preview | Existing manual configuration and local prompt execution |
| Invocations | Other agents, iMessage, Telegram, Scheduled, Webhook, Email, Slack | No durable unattended worker or complete trigger onboarding |
| Knowledge | Connected / Read-only / Separate / Custom memory, self-learning, skills/context files | Existing local saved context; no equivalent autonomous learning pipeline |
| Skills | Workspace / Shared with workspace; grid/list, search/filters; four creation paths | Local authored skills and independent supported installs; not source package execution |
| Memories | Content, category, importance, when-to-use, tags, audience, pinned | Local saved memories; not full multi-user permissions |
| Learning | Improvements and Autowiki navigation; empty workspace has no threads to review | Basic local learning UI; no claim of source self-improvement engine |
| Library | Grid/list, newest sorting, archived visibility; Type / Visibility / Source filters; eight types | Existing local library and artifact history; only implemented artifact kinds |
| Marketplace | Community skills/agents, eight categories, detail instructions/publisher/install/star | Independent authored implementations and disclosed source-only entries |
| Inbox | Mentions, approvals, agent questions, failing schedules | Existing local approvals; no equivalent cross-user scheduler inbox |
| Rooms | Name, optional work goal, Add members; room can contain people without agents | Local room data, not equivalent team chat/auth infrastructure |
| Account settings | Account / Data access / Subscription; 15 items | Functional local settings where supported; billing/OAuth placeholders are not a real subscription service |
| Integrations | Connected / Featured / All other; MCP / NATIVE; custom MCP server | Selected server API adapters, not arbitrary remote MCP execution |
| Artifact canvas | Chat left, multiple artifacts right; carousel/tile/window modes, spotlight, dock, order controls | This batch adds Focus / Tiles / Carousel, spotlight, dock restore, reorder and collapse with SQLite persistence |

## Canvas behavior implemented in this batch

- Display actual saved Document, Webpage, Table, Image and File artifacts using the existing
  safe renderer. Empty states never insert generated examples into the owner workspace.
- Focus retains the existing edit, version-history, restore and download workflow.
- Tiles show several real artifact previews; Carousel provides horizontal snap navigation.
- Spotlight expands a saved artifact with previous/next navigation and download.
- Minimize to a persistent dock, restore individually/all, and collapse/show the canvas.
- Drag using the dedicated handle or use accessible earlier/later buttons. Reset order
  returns to the chosen artifact sort. Filters affect visibility, not stored content.
- Layout, order, dock IDs and collapsed state live on the thread snapshot and pass through
  the existing authenticated, CSRF-protected, revision-checked SQLite save path.
- Switching away from an unsaved focused artifact asks before discarding its draft; minimizing a focused item selects another visible artifact.
- Fork remaps canvas references to the fork's copied artifact IDs rather than the source.
- Old threads without canvas metadata retain the previous Focus behavior without migration.
- Artifact HTML stays in sanitized, script-disabled sandboxed iframes. Spotlight and card
  previews do not relax CSP, enable remote scripts or execute artifact code.

## Explicit remaining canvas gaps

Free-position floating windows, persisted resize geometry, browser-session cards, media
playback/generation, map creation and a general execution sandbox are not implemented here.
Carousel is a real local layout, not the source private canvas code. A source toolbar
control being visible was not counted as proof of source backend execution.

## Evidence routes

Signed-in workspace routes (workspace slug omitted): /threads/new, /agents, /agents/new,
/skills, /memories, /learning, /library, /marketplace, /inbox, /rooms, /rooms/new,
with settings=personalization and settings=integrations. One marketplace skill detail
was inspected without installing it. The tested account's model picker was subscription-gated.

Public sample inspected and interacted with:
https://hyperagent.com/featured/out-of-home-campaign

Its tile layout and Spotlight controls were clicked; no Remix action was taken.
Only user-visible product behavior was used to design an independent implementation.
