# Local data backend contract (implementation target)

Scope: Node 24+, single owner, local npm run dev, no LLM/browser execution. Production UI must not seed fake conversations or emit fake assistant replies. SQLite persistence via built-in node:sqlite; raw file bytes on disk. No new npm dependencies. Default bind loopback. Old browser data is never silently imported/replaced. Fixture mode is explicit and test-only.

## JSON state

GET /api/state -> { state: WorkspaceState, revision: integer }. PUT /api/state with If-Match: revision, X-CSRF-Token -> { revision }. Snapshot is version1 with active and workspaces. Each workspace has id/name/data arrays threads/projects/agents/memories/skills/rooms/artifacts/schedules/rubrics/reviewedSuggestions/connections. data.preferences is optional JSON object. Start with one empty Personal workspace, not demo fixtures. Writes are atomic, validated, bounded (10MB), CAS protected (409 on stale revision), and never silently overwrite on conflict. Persist via SQLite singleton snapshot + revision; this is a real durable store, not a mock DB. IDs scoped to workspace, metadata JSON not executable.

Thread additions (optional for legacy compatibility): createdAt/updatedAt, config {model,reasoning,provider,mode,agentId?,starterAgentName?,tools:string[],outputFormat?,visuals?}, projectId, messages [{id,role:user|assistant,text,createdAt,context?:{settings,skillIds,memoryIds,artifactIds,integrationIds,projectId?,attachments:FileMeta[]}}]. No automatic assistant message. preferences.defaultThreadSettings persists defaults. Artifacts use existing version/content schema.

## Auth / safety

GET /api/session -> {authenticated,setupRequired,csrfToken?}. POST /api/setup {password} creates the sole owner if none exists; POST /api/login {password}; POST /api/logout. Setup must only be allowed via loopback origin, never an arbitrary configured public origin. Passwords scrypt-hashed with random salt; no plaintext storage or logging. Optional APP_OWNER_PASSWORD can initialize an empty DB at process startup, not overwrite an owner. Cookie session HttpOnly/SameSite=Strict; Secure on HTTPS; CSRF token required on authenticated mutations. Expiry bounded. Setup/login protected by exact Origin/Host allowlist + JSON, rate limiting; no CORS wildcard. Mutation requests missing/foreign Origin must be rejected. Allowed development origin APP_DEV_ORIGIN default http://127.0.0.1:5173 (+ localhost equivalent); backend local origin localhost/127.0.0.1 with configured port. Optional APP_PUBLIC_ORIGIN exact configured origin for intentional external use. Do not trust arbitrary forwarded headers. External APP_HOST binding requires an existing owner or explicit bootstrap password. Default APP_HOST=127.0.0.1 APP_PORT=8787.

Responses JSON errors {error,code?}, statuses400/401/403/404/409/413/422. Never expose secrets, paths or stack traces. GET /api/status is harmless availability/version check; never use reserved /health or /run routes.

## Files

POST /api/files?workspaceId=... body raw File bytes, X-File-Name=encodeURIComponent(name), Content-Type=mime, session+CSRF. Bounded max20MB by default. -> {file:{id,name,size,mimeType,createdAt,workspaceId}}. Random server-generated filenames, SQLite metadata, temp write + cleanup on error. GET /api/files/:id?workspaceId=... -> authenticated attachment download, safe Content-Disposition + nosniff (never execute uploaded HTML). Verify workspace/file association. No path traversal, no arbitrary filesystem access. Reject invalid workspace. Do not silently delete orphan files or existing uploads on a state update. Check attachment references on save when present. No fixture file content pretending to be uploaded.

## Share snapshots

GET /api/shares?workspaceId=...&threadId=... -> {shares:[{id,token,threadId,workspaceId,createdAt,revokedAt?}]}.
POST /api/shares {workspaceId,threadId,artifactIds?:string[]} -> {share}. Explicit owner operation creates immutable public read-only snapshot. Include only title + messages (role/text/createdAt and attachment filenames, not file IDs/content or context/private settings) and explicitly chosen thread artifacts. No entire workspace/Agent prompts/memory/credentials leakage. Token >=32 random bytes. GET /api/public/shares/:token -> {title,createdAt,messages,artifacts}; revoked/missing404. DELETE /api/shares/:id revokes. Never publicly serve owner snapshot API or private file bytes. Frontend public route /share/:token renders outside owner AuthGate/WorkspaceProvider and makes only public-share request. No edit controls. Sandbox HTML previews.

## Migration

POST /api/migrate {state:legacyWorkspaceSnapshot,revision} session+CSRF. Validate, require current revision, append imported workspaces under fresh workspace IDs and suffix names, preserve resource IDs within new workspace. Do not replace existing workspaces. Return new {state,revision}. No automatic request; frontend shows counts/warnings and requires explicit confirmation. Browser localStorage remains untouched. Missing file payloads cannot be reconstructed from old filenames; do not pretend otherwise. JSON export is metadata, not full binary backup.

## Development / tests

npm run dev -> node scripts/dev.mjs starts API+Vite, forwards signals, keeps both foreground, preserves --port and --host args safely. Vite /api proxy target loopback APP_PORT with changeOrigin=false. Runner sets APP_DEV_ORIGIN to actual Vite origin; public origin explicitly configured. npm run dev:fixtures is explicit legacy test mode (VITE_STORAGE_MODE=fixture), Vite only; fixtures never become default server data. Backend test script node --test server/*.test.mjs, temp data dirs, real HTTP/SQLite/files, no external service calls. Existing Playwright runs fixture mode; new separate Playwright backend config starts full dev on5174/API8788 with temp data dir and tests real auth/reload/uploads/restart persistence/conflicts/shares. Never use user's .data or actual secrets in tests. APP_DATA_DIR default project .data; gitignore .data and .env, provide .env.example and Node24 engine guidance. API service can serve dist for npm start, but must not imply unconfigured public deployment is safe.

Frontend backend-client helpers will be implemented by parent: api<T>(path,{method?,body?,revision?}), getSession(), uploadFile(file,workspaceId), fileDownloadUrl(file), getState(), saveState(state,revision), migrateState(state,revision). api attaches in-memory session CSRF, credentials same-origin, emits session-expired event on401. No password/token localStorage.

Workspace Store additions: mode:'server'|'fixture', persistence:'loading'|'saving'|'saved'|'error'|'conflict', flush():Promise<void>, reload():Promise<void>, retrySave():Promise<void>, setPreferences(patch). Existing w.set remains synchronous optimistic mutation, while flush resolves only after serialized durable writes. Conflict/error blocks automatic overwrite and offers export/retry/reload with confirmation. App must not render fixture fallback on API failure.

Historical message context IDs are tombstones, not live authorization: they remain
as valid ID strings after a source is deleted. Active thread/default Agent,
Project, Room and Artifact references still require live resources. New composer
submissions resolve selections against the current workspace. A future execution
service must re-authorize sources before running anything. This avoids rewriting
conversation history or blocking legitimate resource deletion.


## Follow-up hardening

Existing GitHub workflow files remain unchanged. npm test sequences Node backend,
legacy fixture UI, and the new real-backend browser suite via package scripts.
The Vite pre-middleware and filesystem deny list protect both default and configured
storage, SQLite sidecars, raw imports and symlink aliases independently of API auth.
Snapshot replacement uses an exclusive lock: finish prior saves, block edits, install
one acknowledged snapshot, then unlock. Migration preview reports normalized missing
live links before confirmation; records/history remain intact. Attachment-bearing
backups remain explicitly unsupported in this metadata migration and are rejected
without stripping data. Full binary recovery uses a stopped-service data-directory backup.
