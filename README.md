# Hyperagents — local single-owner workspace

Independent recreation of Hyperagent's web UI, now with a real local data service.
It is not the official application, does not include its private implementation,
and optionally calls DeepSeek through the authenticated server. It does not control a browser or execute external integrations.

## Run locally

Use **Node 24+** (`.nvmrc` is included):

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. One foreground command starts Vite and the local
API. On first use, create the single-owner password in the browser (12+ characters).
No external database is needed. A server-side DeepSeek key is required only for generated replies. Keep the terminal running.

Normal mode starts empty: no fake threads, tool logs, assistant replies, or
generated artifacts are inserted. Saving a message stores a user message and its
context. With DEEPSEEK_API_KEY configured, it requests a real streamed reply; without it, the message is saved and the UI explains how to enable generation.

### Persistent data

- `.data/workspace.sqlite`: SQLite workspace state, revision, owner/password hash,
  sessions, file metadata and share snapshots.
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

Local workspace tools execute; no browser runtime, OAuth, external service actions, scheduled worker, payment service or
remote skill research/import is connected. Such actions are disabled or explicitly
state that they are unavailable; they do not report fake successful execution.
Existing fixture-only controls are not evidence that execution exists.

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
npm run test:fixtures     # existing UI regression suite in explicit fixture mode
npm test                  # backend + fixture UI + real backend browser tests, in sequence
npm run test:backend-flow  # real API + browser workflows in a temporary data directory
```

The backend-flow suite exercises owner setup/sign-in, empty initial state,
configuration, binary upload/download, message reload, artifact history/fork,
public share/revoke, revision conflict and confirmation-only browser migration.
Tests do not use the owner's `.data` directory. Fixture mode is available separately
as `npm run dev:fixtures`; it is for UI regression samples, not normal operation.

See `docs/BACKEND-CONTRACT.md` for endpoints and security boundaries, and the earlier
`docs/UI-FIDELITY-BATCH-*` audit notes for frontend replication history. Local sandbox
npm access has been blocked by registry403, so full browser/build verification is
reported from GitHub CI rather than falsely claimed as local execution.
