import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';

const OUTPUT_LIMIT = 64 * 1024;
const ALLOWED_FIELDS = new Set(['command', 'cwd', 'timeoutSeconds']);
const SHELL_PATH = '/usr/local/bin:/usr/bin:/bin';

/**
 * Local, approval-neutral execution of commands with the user's full shell authority.
 * IMPORTANT: cwd checks and a minimal environment are NOT a security sandbox. A
 * command can read/write elsewhere, access the network, or deliberately escape its
 * process group. The caller must obtain per-command approval before execute().
 * Creating a runtime and calling normalize() never starts a shell or any command.
 *
 * normalize(args) is synchronous and returns a fresh { command, cwd, timeoutSeconds }.
 * execute(args, { signal }?) revalidates, rejects excess concurrency (no queue), and
 * resolves after process/pipe cleanup. Validation, spawn, and cleanup errors reject;
 * command failures, timeout, and cancellation are ordinary result objects.
 * exitCode/signal are the actual bash exit status (null when not applicable).
 * A pre-aborted signal does not spawn bash and returns both status fields as null.
 */
export function createShellRuntime({ root, maxConcurrent = 2 } = {}) {
  if (typeof root !== 'string' || !root || root.includes('\0')) {
    throw new TypeError('root must be a nonempty filesystem path without NUL');
  }
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError('maxConcurrent must be a positive safe integer');
  }

  const rootPath = realpathSync(root);
  if (!statSync(rootPath).isDirectory()) throw new TypeError('root must be a directory');
  let active = 0;

  function normalize(args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) {
      throw new TypeError('shell arguments must be a plain object');
    }
    for (const field of Reflect.ownKeys(args)) {
      if (!ALLOWED_FIELDS.has(field)) {
        throw new TypeError(`Unexpected shell argument: ${String(field)}`);
      }
    }
    const { command, cwd, timeoutSeconds = 30 } = args;
    if (typeof command !== 'string' || !command.trim() || command.includes('\0')) {
      throw new TypeError('command must be a nonempty string without NUL');
    }
    if (command.length > 8192) throw new RangeError('command must be at most 8192 characters');
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) {
      throw new RangeError('timeoutSeconds must be an integer from 1 to 300');
    }
    if (cwd !== undefined && (typeof cwd !== 'string' || !cwd || cwd.includes('\0'))) {
      throw new TypeError('cwd must be a nonempty filesystem path without NUL');
    }
    const resolvedCwd = realpathSync(cwd === undefined ? rootPath : path.resolve(rootPath, cwd));
    const relative = path.relative(rootPath, resolvedCwd);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new RangeError('cwd must remain within root, including after resolving symlinks');
    }
    if (!statSync(resolvedCwd).isDirectory()) throw new TypeError('cwd must be a directory');
    return { command, cwd: resolvedCwd, timeoutSeconds };
  }

  async function execute(args, { signal } = {}) {
    const normalized = normalize(args);
    if (signal !== undefined && (signal === null || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function')) {
      throw new TypeError('signal must be an AbortSignal');
    }
    if (active >= maxConcurrent) {
      const error = new Error(`Shell concurrency limit of ${maxConcurrent} reached`);
      error.code = 'SHELL_CONCURRENCY_LIMIT';
      throw error;
    }
    active += 1;
    const started = performance.now();
    try {
      if (signal?.aborted) return emptyCancelledResult(started);
      return await run(normalized, signal, started);
    } finally {
      active -= 1;
    }
  }

  function run(args, abortSignal, started) {
    return new Promise((resolve, reject) => {
      let child;
      let timer;
      let settled = false;
      let rootExited = false;
      let timedOut = false;
      let cancelled = false;
      let truncated = false;
      let captureStopped = false;
      let capturedBytes = 0;
      const output = { stdout: [], stderr: [] };
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };

      // Budget the UTF-8 encoding of the returned text, not raw input: malformed
      // bytes can expand to three-byte replacement characters during decoding.
      function captureText(stream, text) {
        if (!text) return;
        if (captureStopped) return;
        const bytes = Buffer.from(text, 'utf8');
        const remaining = OUTPUT_LIMIT - capturedBytes;
        if (bytes.length <= remaining) {
          output[stream].push(text);
          capturedBytes += bytes.length;
          return;
        }
        let end = remaining;
        // Back up to a code point boundary; never return half a UTF-8 character.
        while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
        if (end) output[stream].push(bytes.subarray(0, end).toString('utf8'));
        capturedBytes += end;
        truncated = true;
        captureStopped = true;
      }

      function captureChunk(stream, chunk) {
        if (captureStopped) return; // Keep the data listeners attached: drain all excess.
        captureText(stream, decoders[stream].write(chunk));
      }

      function killGroup() {
        if (!child?.pid) return undefined;
        try {
          // detached:true makes bash the process-group leader on POSIX.
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') return error;
        }
        return undefined;
      }

      function cleanup() {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
      }

      function fail(error) {
        if (settled) return;
        settled = true;
        cleanup();
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        reject(error);
      }

      function stop(reason) {
        if (settled || rootExited || timedOut || cancelled) return;
        if (reason === 'timeout') timedOut = true;
        else cancelled = true;
        const error = killGroup();
        if (error) fail(error);
      }

      function onAbort() { stop('abort'); }

      try {
        child = spawn('/bin/bash', ['-c', args.command], {
          cwd: args.cwd,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          // Never spread process.env: provider tokens and other parent secrets
          // must not be inherited. Bash may create its own PWD, SHLVL, and _.
          env: { PATH: SHELL_PATH, HOME: rootPath, LANG: 'C.UTF-8', TMPDIR: tmpdir() },
        });
        child.once('error', (error) => {
          const cleanupError = killGroup();
          fail(cleanupError ?? error);
        });
        for (const stream of ['stdout', 'stderr']) {
          child[stream].on('data', (chunk) => captureChunk(stream, chunk));
          child[stream].once('end', () => captureText(stream, decoders[stream].end()));
          child[stream].once('error', (error) => {
            const cleanupError = killGroup();
            fail(cleanupError ?? error);
          });
        }
        child.once('exit', () => {
          rootExited = true;
          cleanup();
          // Children can keep stdout/stderr open after bash exits. Kill the group
          // at exit, not close (waiting for close first could hang indefinitely).
          const error = killGroup();
          if (error) fail(error);
        });
        child.once('close', (exitCode, exitSignal) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({
            exitCode,
            signal: exitSignal,
            stdout: output.stdout.join(''),
            stderr: output.stderr.join(''),
            truncated,
            timedOut,
            cancelled,
            durationMs: Math.max(0, performance.now() - started),
          });
        });
        timer = setTimeout(() => stop('timeout'), args.timeoutSeconds * 1000);
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        // Covers an abort occurring between the preflight check and registration.
        if (abortSignal?.aborted) onAbort();
      } catch (error) {
        const cleanupError = killGroup();
        fail(cleanupError ?? error);
      }
    });
  }

  return { normalize, execute };
}

function emptyCancelledResult(started) {
  return {
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false,
    cancelled: true,
    durationMs: Math.max(0, performance.now() - started),
  };
}
