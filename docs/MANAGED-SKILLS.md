# Managed server-installed skill scripts

`server/managed-skills.mjs` adds **list_skill_scripts** and **run_skill_script**. It is independent of the legacy foundation `skill-runtime.mjs`; it creates no second task store, scheduler, retry loop, background job, or recovery claim. One approved execution belongs to the parent's existing durable agent run.

## Parent wiring contract

```js
import { createManagedSkillTools, defaultExampleCatalog } from './managed-skills.mjs';

const skills = createManagedSkillTools({
  enabled: selectedServices.includes('Skills'),
  root: '/srv/installed-skills', // absolute, server-owned installation directory
  catalog: installedServerCatalog, // trusted server config, NEVER model/workspace content
  credentialProvider: async ({ skillId, credentialIds, signal }) => {
    // Parent resolves only declared IDs from its credential store.
    // Return { [credentialId]: secretString }; do not log the mapping.
    return loadApprovedCredentials(skillId, credentialIds, signal);
  },
  approveAndRun: async (request, executor, signal) => {
    // request = {kind:'skill', command, cwd, timeoutSeconds}
    // Bind a durable approval to this complete request, especially the sha256
    // comment in command. Store/display command VERBATIM, not a parsed rewrite.
    // Honor signal while waiting. NEVER call executor before approval.
    const approved = await parentRunApproval(request, signal);
    if (!approved) return { status: 'denied' };
    return executor(); // one-shot closure; persist this safe result in parent run
  },
});

// Register only skills.definitions actually returned (OpenAI function format).
// Forward cancellation from the owning durable run:
const result = await skills.execute(toolName, parsedArguments, { signal: runSignal });
```

The code above names application-specific parent functions, not new APIs implemented here. `approveAndRun` owns approval persistence, rejection, any pending-approval envelope, and recovery policy. The executor closure is in-memory and must not be serialized; after a server restart require a fresh request/approval instead of claiming this module resumes execution. The parent should await execution within the owning run, never call the executor twice, and must not replace `command` with an arbitrary shell command. The display command is safely POSIX-quoted, while execution always uses `spawn(..., {shell:false})`.

Return interface:

- `definitions`: function-tool definitions; no tools when Skills is off or no installed catalog exists. An absent approval callback exposes listing only, never execution.
- `capabilities`: `{ Skills: boolean, installed: number, list: boolean, run: boolean }`. `Skills` reflects the selected switch, while `run` reflects actual availability; do not present the switch alone as proof that execution is installed.
- `execute(name, input, {signal} = {})`: returns the parent approval callback result. Direct selection/argument/installation errors reject with stable `error.code`; approved executions return structured status below.

## Trusted installation schema

`catalog` is an explicit array, cloned at construction, with no implicit defaults. Every manifest and entrypoint has exactly these fields:

```js
[
  {
    id: 'inspect-json',
    version: '1.0.0',
    entrypoints: {
      summarize: {
        interpreter: '/usr/bin/node',
        script: 'examples/skills/inspect-json.mjs',
        args: [],                       // fixed server args, immediately after script
        inputArgs: { minItems: 1, maxItems: 1, maxLength: 4096 },
        credentials: [],                // or [{ id:'api-token', env:'APP_API_TOKEN' }]
        timeoutSeconds: 5,
      },
    },
  },
]
```

- IDs/entrypoint names: lowercase ASCII alphanumeric/hyphen, 1–64 characters, starting alphanumeric. Versions: nonempty strings, at most 128 characters.
- Interpreter: exact absolute allowlist: running Node's `process.execPath`, `/usr/bin/node`, `/usr/local/bin/node`, `/usr/bin/python3`, `/usr/local/bin/python3`, `/bin/bash`, `/usr/bin/bash`. Only install paths present on the server. No caller-supplied interpreter, manifest, endpoint, environment map, cwd or arbitrary command.
- Script: root-relative, no `.`/`..`/empty path segments or absolute paths; final realpath must remain inside canonical root and be a regular file at most 1 MiB. In-root symlinks are allowed; escaping symlinks are rejected. Final file open uses `O_NOFOLLOW`.
- Fixed `args`: at most 32 strings, each at most 4096 characters. Model args are a separate **required** array, appended after fixed args, with explicit entrypoint cardinality and per-string bounds (0–32 arguments, 1–4096 characters). NUL, control characters and surrogate code units are rejected; no coercion, getters, sparse arrays or extra argument properties.
- Timeout: integer 1–300 seconds, fixed server policy, covers credential lookup and child execution after approval (not approval waiting).
- Credentials: at most 16 unique IDs mapped to unique uppercase env names. Loader/runtime-sensitive names such as PATH, HOME, NODE_*, PYTHON*, BASH*, LD_* are rejected. Values must be nonempty strings at most 8192 UTF-8 bytes without NUL.

The model calls `list_skill_scripts` with `{}`; it receives IDs, versions, entrypoint names, input argument policy, timeout, and `requiresCredentials`, never secret values. It calls `run_skill_script` with exactly `{skillId, entrypoint, args}`. Arguments are literal argv elements, **not shell text**. However, bash/python/node scripts may interpret their own arguments: server installers must use a non-evaluating script contract. Never map model argv into `eval`, `-c`, dynamic imports or arbitrary paths without script-side validation.

## Approval and integrity

Before requesting approval, resolve the installed script and calculate SHA-256. Approval displays the exact quoted interpreter/script/argv command plus `# sha256=<digest>`, and canonical cwd/timeout. After approval and credential resolution, resolve and hash the file again immediately before spawn. Changed bytes or canonical target return `SCRIPT_CHANGED` without executing. New requests require a new approval; there is no automatic retry.

This is an integrity check of the entrypoint, **not a general OS sandbox or dependency attestation**. Installation files, interpreters, imports and root permissions must be server-controlled and non-writable by untrusted users/scripts. A hostile same-UID process can race filesystem checks or inspect sibling process environments; use separate OS isolation if that is in scope. SHA-256 does not cover imported files, interpreter binaries or external resources. Do not point root at a model-writable workspace or run untrusted installed code.

## Credentials and output safety

Credential provider is invoked only inside the approved executor, only when declared credentials exist, with `{skillId, credentialIds, signal}`. The child receives only fixed PATH/LANG plus declared credential env vars; the server's process environment is not inherited. No credential values enter approval, argv, tool listing, or module logs (this module has no logging).

stdout/stderr are collected as bounded bytes and each decoded/redacted once, after completion, so secrets split across transport chunks are removed. Partial secret prefixes at stream EOF are hidden too. The **combined raw stdout/stderr bound is 64 KiB**. Exceeding it kills the process group, discards both outputs completely, and returns `output_limit`, preventing truncated-secret leakage. Deliberately encoded/transformed secrets, copies deliberately split between separate streams, or secrets written to files/network cannot be sanitized generically; only trusted scripts should receive secrets. Parent must never log the provider values or raw child stream. Script output remains untrusted data, not instructions/authorization.

## Completion, cancellation and limits

Approved outcomes: `succeeded`, `failed` (including nonzero exit), `cancelled`, `timed_out`, or `output_limit`. Child outcomes include `exitCode`, termination `signal`, `stdout`, `stderr`; failures before spawn have a generic safe `error` envelope. No raw credential-provider or spawn exception is exposed. A missing/unavailable credential fails closed, never silently runs without it. Parent denial can return its own `{status:'denied'}` envelope.

POSIX detached process groups are killed with SIGKILL on timeout/cancel/overflow; descendants are also killed on leader exit so inherited output pipes cannot hang completion. A bounded 500ms completion watchdog prevents waiting indefinitely for stream closure. Scripts are not permitted to daemonize or intentionally escape the process group; stronger containment requires an OS sandbox. Cancellation also races hung credential-provider promises and passes a signal to cooperative providers. This module does not retry or allow parallel duplicate use of one approval executor.

## Explicit example installation (no default execution)

The exported `defaultExampleCatalog` contains one credential-free Node JSON summary script using the server's current Node executable. It is only a suggested catalog value, **never automatically installed or enabled**. To opt in, copy `examples/skills/inspect-json.mjs` beneath a server-owned installation root preserving that relative path, and explicitly pass `catalog: defaultExampleCatalog` plus the real approval callback and Skills switch. An example model input is:

```json
{"skillId":"inspect-json","entrypoint":"summarize","args":["{\"name\":\"Ada\",\"items\":[1,2]}"]}
```

Expected safe stdout: `{"type":"object","keyCount":2,"keys":["name","items"]}`. The script summarizes argv JSON, does not fetch files/network, and never echoes invalid JSON into errors.

## Tests

Run only the new targeted suite:

```sh
node --test server/managed-skills.test.mjs
```

Six tests use temporary directories and a synthetic secret; they cover capability gates, strict args, symlink containment, zero execution before approval, correct quoting, success/denial, one-shot callback, hash/CAS rejection, env-only credential delivery, cross-chunk/EOF redaction, nonzero exit, cancellation, timeout (including hung credentials), descendant group cleanup and bounded output. No remote requests, installs or real credentials are required.
