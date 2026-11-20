# Hyperagents — local single-owner workspace

新增侧栏 **浏览器**（`/browser`）：持久身份、标签导航、断连重连、人工接管，以及 agent 的点击/填表/按键工具。中断任务支持 **从已保存上下文继续**，并可回看原运行日志。[浏览器与持久化说明](docs/BROWSER-PERSISTENCE.md)。

Elys 个人分身已作为原生功能接入：侧栏 **分身与记忆**（`/companion`）可设置个人分身、进入自聊、从本人原话整理并确认记忆，查看每轮提供给模型的记忆快照。使用与范围见 [分身与记忆说明](docs/ELYS-COMPANION.md)。

Independent recreation of Hyperagent's web UI, now with a real local data service.
It is not the official application, does not include its private implementation,
and optionally calls DeepSeek through the authenticated server. Explicitly selected,
server-configured capabilities read workspace data and real APIs, save artifacts,
and perform approved external writes.

2026-11-12：新增[能力进度与具体拆分演练](docs/AGENT-PROGRESS.md)，覆盖两个只读子 agent、依赖校验、结果回收、实际文档保存及失败/取消处理。真实模型质量与运行层 fixture 证据分别记录。

## Current integrated runtime and verification (2026-11-08)

The observed `npm run dev` entry is the legacy SQLite application on 5173/8787.
`dev:v1`, PostgreSQL, Worker and Rust are separate implementations; historical
v1 reports below do not identify the active deployment. The outer Elys checkout
now supplies an optional dedicated SCNet adapter and persistent browser
controller. See [provider and browser setup](docs/SCNET-AGENT-PROVIDER.md).
The original private `.env`, owner account, SQLite and uploads are retained.

The SCNet adapter translates real schema-validated JSON model decisions; it is
not native function calling. Real acceptance exposed a limit: the 1.5B model
first selected local document search and unrelated suggestions. After semantic
catalog improvements and narrowing authorization to `web_search` and
`create_artifact`, it performed public searches but repeatedly searched instead
of saving a report. Neither trial is a successful research-agent acceptance.
The unedited [initial](../docs/hyperagents-agent-live-before.json) and
[restricted](../docs/hyperagents-agent-live.json) records remain available.
A generic consecutive same-tool/canonical-arguments guard now refuses the
duplicate before execution. It does not choose another tool or invent a report.
General multi-step reliability remains a product limitation of this model/mode.

Persistent browser takeover is host-enforced: `browser_request_takeover` itself
waits for explicit human handback and an actual observation before another
model turn. Missing handback stops the run, retaining browser/human control.
Viewer disconnection is not handback; finishing releases the run lease without
deleting login profiles. Enter credentials/codes directly in Browser, never chat.
Controller/UI fixtures and a user's real account login are separate scopes.

The legacy main `/api/runs` still requires an active run to finish or stop before
another message. The separate `/api/tasks/:id/inputs` is not yet connected as
running-follow-up support for that main conversation. Completed-turn follow-ups
retain bounded history and explicitly selected saved artifacts.

## Run locally

Use **Node 24+** (`.nvmrc` is included):

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. One foreground command starts Vite and the local
API. On first use, create the single-owner password in the browser (12+ characters).
No external database is needed. A server-side DeepSeek key is required only for generated replies. Keep the terminal running.

If startup reports a port already in use, stop the existing development server.
To use different ports, set `APP_PORT=8788` in `.env` for the API and run
`npm run dev -- --port 5174` for Vite (choose ports that are available).
Changing Vite's `--port` alone does not change the API port.

Normal mode starts empty: no fake threads, tool logs, assistant replies, or
generated artifacts are inserted. Saving a message stores a user message and its
context. With DEEPSEEK_API_KEY configured, it requests a real streamed reply; without it, the message is saved and the UI explains how to enable generation.

### Persistent data

- `.data/workspace.sqlite`: SQLite workspace state, revision, owner/password hash,
  sessions, file metadata and share snapshots.
- `.data/tasks.sqlite`: durable task goals, inputs, prompts, tool effects and results.
- `.data/tasks.scheduler.sqlite`: operating-system-backed exclusive scheduler lock.
- `.data/tasks.lock`: diagnostic owner metadata; released on normal shutdown.
- `.data/uploads/`: actual private uploaded bytes.
- `.data` and `.env` are excluded from Git and the Docker build context.
- Restarting the service or updating code does not reset the database.
- Stop the service before copying the entire `.data` directory for a full backup.
  JSON exports contain metadata, not a full binary-file backup.

Workspace edits use a serialized save queue and optimistic UI. The storage bar
reports **Saving / Saved / Error / Conflict**. A stale revision never silently
overwrites another tab. Failed edits remain available for export or retry; reloading
the server version requires confirmation before discarding unsaved edits.

### Existing browser data

Previous localStorage data is not erased or automatically uploaded. The application
offers a preview with workspace/resource counts and explicit confirmation. Import
appends copies under new workspace IDs rather than replacing server workspaces.
Old demo examples may be present: review them before importing. Filenames from the
old demo cannot recover file bytes that were never uploaded.

## What is connected

- Durable workspace/thread/message/project/Agent/skill/memory/artifact metadata.
- A legacy task API with Router/Worker delegation, execution-time follow-ups,
  persistent waiting and recovery, pluggable tools, and editable built-in prompts.
- Messages carry IDs, timestamps, saved preferences, context references and actual
  attachment metadata; retries use stable request IDs rather than fake replies.
- Upload/download private file bytes (UI maximum20MB), not merely file names.
- Real thread rename/star/archive/fork/delete/project assignment.
- DeepSeek tool calling for saved workspace search/read and Document/Webpage/Table creation and updates.
- Tool activity history, saved table previews and formula-safe CSV export.
- Explicit Document/Webpage creation, editing, stored version history, restoration,
  filtering, ordering and download; no fallback canvas content in normal mode.
- Thread configuration and default preferences stored in the database.
- Owner-created immutable public share snapshots and revocation. Public views do
  not expose private attachment bytes, Agent prompts, credentials or whole workspaces.

Local workspace tools and selected server-configured integration APIs execute.
Browser OAuth onboarding, scheduled workers, payment services and remote skill
research/import are not connected. Such actions are disabled or explicitly
state that they are unavailable; they do not report fake successful execution.
Existing fixture-only controls are not evidence that execution exists.

## Main UI with backend v1

Run `npm run dev:v1` and open **http://localhost:5173** to use the original main
sidebar, home composer, conversation and artifact panel with the isolated
TypeScript backend. The extra Tasks page has been retired. The legacy service is stopped; its SQLite data is preserved.

Build the backend first with `npm --prefix backend ci --ignore-scripts` and
`npm --prefix backend run build`. The v1 launcher preserves the existing accounts,
PostgreSQL database and files under `backend/.data-v1/interactive`. First-run local
credentials are written to its private `access.json`; credentials are never committed.
See [setup and verification](docs/verification-v1-ui/REPORT.md) for Runner/PDF
requirements, startup, supported features and browser verification.

The previous `.mjs` task API remains available to existing clients; its historical
runtime documentation is in [TASK-RUNTIME.md](docs/TASK-RUNTIME.md).

## Rust kernel and Docker-free sandboxes

The optional Rust kernel uses durable PostgreSQL execution slices and the pinned Infinity core. New-task allocation remains off by default. Browser identities use bubblewrap and compute operations use direct runsc; neither requires Docker. See [kernel setup and rollback](backend/kernel/README.md), [runtime bundle installation](backend/sandbox/README.md), and [verification results and remaining manual acceptance](docs/verification-rust-sandbox/REPORT.md). Existing accounts, files and localhost:5173 remain in place.

## Real account integrations

Settings > Integrations now tests real API access before enabling a workspace binding.
Thirteen services and 31 operations are implemented; external writes require signed,
exact-content approval cards and are never automatic model actions. Configure only the
services you use in private .env. See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) for
credentials, least scopes, setup, supported operations and limits. Google uses pre-consented
server tokens with optional automatic refresh; no fake browser OAuth flow is shown.

## Skills and Marketplace

Server mode includes the observed 61-entry source catalog, category/search/readiness filters,
explicit saved installations, independent recipe previews and per-tool availability. See
[docs/MARKETPLACE-INTEGRATION.md](docs/MARKETPLACE-INTEGRATION.md) for the per-item
coverage ledger and limitations. Thirteen independently written implementations are included;
source-only entries are not misrepresented as working packages. Public-data tools include
NWS, World Bank (upstream access must be checked) and server-configured OpenAlex.

## DeepSeek generation

See [docs/DEEPSEEK.md](docs/DEEPSEEK.md) for setup, supported models, context boundaries,
streaming/stop behavior, and the verified-vs-unverified test boundary. The key lives only
in the server environment or untracked .env, never in Git, SQLite preferences, browser
storage, client requests, VITE_ variables, or Docker build arguments.

## Optional environment configuration

Copy `.env.example` to `.env`; `npm run dev`, `npm start` and `npm run preview`
load it without replacing already exported variables. Never put secrets in variables
prefixed `VITE_`. Tests use temporary data directories and skip the user's env file.

Defaults: API127.0.0.1:8787, Vite127.0.0.1:5173, data`.data`. CLI `--port` and
`--host` are accepted by the dev runner. Only loopback is enabled by default.

### Using your existing domain or tunnel

Initialize the owner through localhost first. Then explicitly configure, for this
project, the exact trusted browser origin, for example:

```dotenv
APP_PUBLIC_ORIGIN=https://lp.chayu123.me
```

If Vite must listen beyond loopback, start it with an explicit host after owner
initialization. The runner refuses public binding without a trusted origin and an
initialized owner. Proxy `/api` through the same origin; do not expose an unprotected
standalone write API. Host/Origin checks, session cookies and CSRF checks remain on.
HTTPS/reverse-proxy security and host firewall configuration are your responsibility.
Do not publish the data directory or owner environment file.

### Built preview

```sh
npm run build
npm run preview
```

The backend serves `dist` and API on the same loopback port8787. `npm start` runs
API-only unless `APP_SERVE_DIST=1` is set. A frontend-only Nginx deployment no longer
provides normal-mode data functionality.

### Docker (optional, not required for npm run dev)

The image runs Node24 with built frontend plus API, not static Nginx. Persist
`/app/.data`; do not replace it on rebuild. Container binding requires an existing
owner database or an explicitly supplied `APP_OWNER_PASSWORD` bootstrap (12+ chars,
only used for an empty owner table). Set the exact `APP_PUBLIC_ORIGIN`; prefer a
loopback-only published port behind an HTTPS reverse proxy. Mounted data must be
writable by the image's non-root `node` user. Never bake real secrets into the image.
Docker build/runtime has not been tested in the assistant sandbox.

## Import and development-server safety

- Vite cannot serve `.data`, configured backend storage, SQLite sidecars, or public
  symlink aliases to private data, including `/@fs/` and `?raw` requests.
- Import preview checks the backup on the server. Missing live links are listed as
  warnings before confirmation; records and historical context are preserved.
  Backups containing binary attachment references are blocked before confirmation,
  not silently stripped or replaced with invented files.
- Import/reload waits for outstanding saves and temporarily locks editing. An old
  save acknowledgement cannot replace an imported snapshot or drop intervening edits.

## Tests

```sh
npm run test:backend       # built-in Node tests; real temp SQLite/files/HTTP
npm run test:tasks         # model/plugin/prompt/runtime/API tests for Tasks
npm run test:v1-adapter    # deterministic browser adapter tests; no model or DB
npm run test:v1-ui         # live v1 browser verification; requires dev:v1 + model + Runner
npm run test:fixtures     # existing UI regression suite in explicit fixture mode
npm test                  # backend + fixture UI + real backend browser tests, in sequence
npm run test:backend-flow  # real API + browser workflows in a temporary data directory
```

The backend-flow suite exercises owner setup/sign-in, empty initial state,
configuration, binary upload/download, message reload, artifact history/fork,
public share/revoke, revision conflict and confirmation-only browser migration.
Tests do not use the owner's `.data` directory. Fixture mode is available separately
as `npm run dev:fixtures`; it is for UI regression samples, not normal operation.

Browser suites require a Playwright Chromium installation (`npx playwright install
chromium`). The legacy backend browser suite uses controlled model/tool adapters with real
HTTP and SQLite; it does not call production DeepSeek or external services.

See `docs/BACKEND-CONTRACT.md` for the existing endpoints and security boundaries,
`docs/TASK-RUNTIME.md` for the Tasks API, and the earlier `docs/UI-FIDELITY-BATCH-*`
audit notes for frontend replication history.

## Forgotten local owner password

Do not delete .data or the SQLite database. On your own server, stop the app and run:

```sh
npm run reset-password
```

The local-only command reads the same .env / APP_DATA_DIR configuration, shows the
selected data directory, asks you to type RESET, then asks for a new password twice
without echoing it. It accepts no password command arguments, environment password,
HTTP request or default password. Use 12+ characters. Run it as the OS account that
owns the data (the container's node user for a mounted Docker data volume).

Before changing credentials it creates a private consistent SQLite backup in
.data/recovery-backups (or the configured data directory). It changes only the owner
password hash and invalidates existing login sessions. Conversations, uploaded bytes,
workspace configuration and integration settings are preserved. Missing, symlinked,
unrecognized or future-schema databases are refused, not recreated. The backup is
private and contains sensitive workspace data; do not publish it.

Restart the normal app service and sign in with the new local password. This is not
your DeepSeek key or Hyperagent password. APP_OWNER_PASSWORD remains a first-owner
bootstrap only; changing it does not replace an existing password.

## Development documentation

- [Durable task runtime](docs/TASK-RUNTIME.md): legacy Router/Worker scheduling, plugins, prompts and crash recovery.
- [Delegation runtime](docs/DELEGATION-RUNTIME.md): managed parent/child runs and authorization boundaries.
- [Delegated resource access](docs/DELEGATION-RESOURCE-ACCESS-2026-11-01.md): read-only document/table access and capability intersection.
- [Resource discovery](docs/RESOURCE-DISCOVERY-2026-10-31.md): workspace document/table search and pagination.
- [Workspace files](docs/WORKSPACE-FILES.md): managed file storage and execution boundaries.

Independent reference checkouts (`OpenMausBot/`, `browser/`, `macro/`) and local
implementation backups are intentionally ignored. They remain on disk and are not
part of the application source or Git submodules. Never add `.env` or `.data/` to a commit.
