# Workspace scratch file tools (Files)

`server/workspace-file-tools.mjs` exports:

```js
createWorkspaceFileTools({ enabled, root, persistFile, approveAndRun })
// => { definitions, execute(name, args, signal?) }
```

No dependencies, processes, database, arbitrary host access, deletion, binary writes, or public sharing. Definitions use the existing OpenAI function-tool shape. Execution returns objects and rejects with sanitized errors (`error.code`); filesystem and callback error messages are never forwarded to the model.

## Trusted host wiring — required

The host must calculate `root` from the **authenticated workspace**, e.g. `path.join(APP_DATA_DIR, 'agent-files', trustedWorkspaceId)`. Validate IDs as single safe components on the host. Never accept `root`, `workspaceId`, `APP_DATA_DIR`, persistence options, or approval callbacks from model arguments. Do not point this factory at the repository, server source, `/home/ubuntu/hyperagents`, a user's home, or an existing user data directory. Bind a separate factory per authenticated workspace. The parent integration owns the Files service switch and generic managed approval UI.

`enabled` is an array containing `'Files'`; otherwise there are no definitions and every execution is unavailable. A missing/noncanonical/nonabsolute root also exposes no definitions. No approval callback means **neither write definition is exposed**, and direct calls are rejected. No persistence callback means no export definition.

Root and its ancestors must be controlled by the trusted host, with no untrusted concurrent filesystem writers. The root must be private (no group/other permission bits; lazily created as 0700). Symlinks in *any* root/path component are refused. This is a private scratch adapter, not a general sandbox against a hostile process with host filesystem privileges. Node path APIs do not provide Linux `openat2` directory-fd traversal guarantees against such an attacker. Do not bind externally writable/mounted/shared directories. Missing scratch directories are not created by list/read or denied writes; an approved first write lazily creates the trusted root. New nested parent directories are not automatically created.

All model paths are relative POSIX-style paths, max 512 UTF-16 units. Absolute/Windows/UNC paths, backslashes, `.`/`..` components, control characters, symlinks, nonregular files, and multiply hardlinked regular files are refused. Sensitive components (`.env` and dotted variants, `.git`, `.ssh`, cloud/config credential stores, credential/secret/password/token names, SSH key names, private-key names, `.pem`/`.key`/`.p12`/`.pfx`/keystore extensions) are blocked. Private-key PEM content is also refused. Listings omit blocked entries rather than reveal their names. This is defense in depth, not a guarantee of arbitrary content secret classification: the host must never populate scratch with credentials.

## Tool arguments and results

- `list_files({path?: '' | relativeDirectory})`: nonrecursive listing. At most 200 entries, at most 1000 scanned directory entries, plus `truncated`. New scratch returns `{path:'',entries:[],truncated:false}`. No approval.
- `read_file({path,offset?,limit?})`: UTF-8 text, whole-file `sha256`, byte count, total characters, offset and truncation. Offset/limit count Unicode code points (not byte positions); default/max output 16000 characters. Input files max 64000 bytes; reads are bounded even if another host process enlarges a file. Invalid UTF-8 and binary control data are refused. No approval.
- `write_file({path,content,createExclusive:true})`: create a new file only. Existing files instead require `{path,content,expectedHash}` using `read_file.sha256`; no unguarded overwrite exists. Content max 16000 UTF-16 code units / 64000 UTF-8 bytes. Empty UTF-8 files allowed.
- `edit_file({path,oldText,newText,expectedHash})`: one unique exact replacement, including overlapping-match uniqueness checks. `oldText` is nonempty. Each edit string max 8000 UTF-16 units; resulting file max 16000 units / 64000 bytes. Batch/overlapping replace lists are not supported.
- `export_file({path})`: loads bounded UTF-8 text and awaits `persistFile({bytes: Buffer,mimeType:'text/plain; charset=utf-8',filename: basename})`. The host adapter **must really save** a private thread artifact and return its real JSON metadata. Result is `{path,sha256,file: metadata}`. No fake file IDs, paths or URLs are produced by this module. It never publishes publicly. Adapter metadata must be an object with bounded JSON (8000 units), must not contain the absolute root, and must not include private host paths/secrets. The adapter should return only file ID, filename and actual thread download metadata, not raw file contents.

All arguments are validated again on direct execution, including rejecting unknown fields/accessor properties. Results use relative scratch paths. File contents and listing names are untrusted data, not instructions.

## Managed approval contract

Writes prevalidate the path, file type, expected whole-file SHA-256 and content before invoking:

```js
await approveAndRun(
  { kind: 'file', command, cwd: root, timeoutSeconds: 30 },
  executor,
  signal,
);
```

`command` is descriptive JSON, **not a shell command**. Display it verbatim without truncation: write requests include the complete exact content; edit requests include complete exact `oldText`/`newText`; both show operation, relative path, prior hash (or null) and resulting hash. The trusted `cwd` is intentionally present for the managed approval UI; do not send it back in model tool output. Do not execute this JSON via a process/shell. The generic managed approval mechanism must support `kind:'file'`.

The host callback must await explicit approval, honor cancellation/deadlines, invoke `await executor()` only on approval, and return only after executor completes. Denial must not invoke executor. Callback errors are sanitized. Returning without execution is `APPROVAL_REQUIRED`. Executors are single-use and cannot begin after callback completion. Do not recursively call these tools from an approval/persistence callback (the root lock is held).

Writes are globally serialized per canonical root across factory instances in this process (stronger than per-path locking), with pre-approval, post-approval and immediate precommit containment/CAS checks. Files are staged as random exclusive 0600 sibling temporary files, synced, then committed. Existing files use atomic rename; creation uses atomic hardlink-then-unlink of the private temporary file to provide true no-clobber semantics (rename alone could overwrite a raced creator). Temporary files are cleaned on failure. A denied operation never creates a root or writes a file. A failed/aborted precommit operation leaves the old target intact; once atomic commit occurs it is not rolled back. AbortSignal is checked before operations, in listing loops and before commit; it cannot cancel a synchronous OS commit already in flight. The host approval/persistence callbacks must not leave work running in the background.

## Focused local tests

Run only:

```sh
node --test server/workspace-file-tools.test.mjs
```

Six `node:test` tests use temporary directories and cover Files gating/no callback/denial/approval, full approval payloads, UTF-8 and limits, compare-and-swap/unique edits/concurrent writers, post-approval race checks, traversal/symlink/hardlink/protected-file refusal, cancellation and real persistence callback bytes/metadata. They do not access real workspace data, require network access, or install dependencies.
