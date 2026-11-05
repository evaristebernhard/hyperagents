import Fastify from "fastify";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  readdir,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainError, Id, Limits } from "@hyper/contracts";
import {
  RunRequest,
  RunResponse,
  equal,
  hash,
  ensureSandboxSlice,
  systemdArgs,
  stopSandbox,
  runtimeBundle,
  sandboxMetrics,
  fileLease,
  type Config,
} from "@hyper/runtime";
const exec = promisify(execFile);
const safeEnv = [
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "HOME=/tmp",
  "LANG=C.UTF-8",
  "PYTHONDONTWRITEBYTECODE=1",
  "PYTHONUNBUFFERED=1",
  "MPLCONFIGDIR=/tmp/matplotlib",
  "OPENBLAS_NUM_THREADS=1",
  "OMP_NUM_THREADS=1",
];
export function ociConfig(rootfs: string, inputs: string) {
  return {
    ociVersion: "1.0.2",
    hostname: "compute",
    root: { path: rootfs, readonly: true },
    process: {
      terminal: false,
      user: { uid: 1000, gid: 1000 },
      args: ["/bin/sleep", "infinity"],
      env: safeEnv,
      cwd: "/work",
      noNewPrivileges: true,
      capabilities: {
        bounding: [],
        effective: [],
        inheritable: [],
        permitted: [],
        ambient: [],
      },
      rlimits: [
        { type: "RLIMIT_NOFILE", hard: 256, soft: 256 },
        { type: "RLIMIT_NPROC", hard: 128, soft: 128 },
        {
          type: "RLIMIT_FSIZE",
          hard: Limits.fileBytes,
          soft: Limits.fileBytes,
        },
      ],
    },
    mounts: [
      { destination: "/proc", type: "proc", source: "proc" },
      {
        destination: "/dev",
        type: "tmpfs",
        source: "tmpfs",
        options: ["nosuid", "strictatime", "mode=755", "size=8m"],
      },
      {
        destination: "/tmp",
        type: "tmpfs",
        source: "tmpfs",
        options: ["nosuid", "nodev", "noexec", "mode=1777", "size=128m"],
      },
      {
        destination: "/work",
        type: "tmpfs",
        source: "tmpfs",
        options: ["nosuid", "nodev", "mode=1777", "size=1g"],
      },
      {
        destination: "/inputs",
        type: "bind",
        source: inputs,
        options: ["rbind", "ro", "nosuid", "nodev", "noexec"],
      },
    ],
    linux: {
      namespaces: ["pid", "network", "ipc", "uts", "mount", "user"].map(
        (type) => ({ type }),
      ),
      uidMappings: [{ containerID: 0, hostID: process.getuid!(), size: 1 }],
      gidMappings: [{ containerID: 0, hostID: process.getgid!(), size: 1 }],
      maskedPaths: [
        "/proc/acpi",
        "/proc/kcore",
        "/proc/keys",
        "/proc/timer_list",
        "/proc/scsi",
        "/sys/firmware",
      ],
      readonlyPaths: [
        "/proc/bus",
        "/proc/fs",
        "/proc/irq",
        "/proc/sys",
        "/proc/sysrq-trigger",
      ],
    },
  };
}
export async function createDirectRunner(config: Config) {
  if (!config.RUNNER_TOKEN) throw new DomainError("RUNNER_TOKEN_REQUIRED");
  const root = join(config.DATA_DIR, "runner-direct");
  const state = join(root, "state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const flags = [
    "--root=" + state,
    "--platform=systrap",
    "--network=none",
    "--ignore-cgroups=true",
  ];
  const runsc = (args: string[], options: Parameters<typeof exec>[2] = {}) =>
    exec(config.SANDBOX_RUNSC, [...flags, ...args], {
      timeout: 10000,
      maxBuffer: 200000,
      ...options,
    });
  const releaseLease = await fileLease(join(root, "owner.lock"));
  const active = new Map<string, AbortController>();
  let stopping = false;
  const app = Fastify({ bodyLimit: 32 * 1024 * 1024, logger: false });
  async function save(id: string, data: unknown) {
    const dir = join(root, id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "receipt.tmp"), JSON.stringify(data), {
      mode: 0o600,
      flush: true,
    });
    await rename(join(dir, "receipt.tmp"), join(dir, "receipt.json"));
    for (const p of [dir, root]) {
      const handle = await open(p, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  async function stop(id: string) {
    // Stop the cgroup first, then remove runtime metadata. No host path supplied by a task.
    await stopSandbox("compute", id);
    await runsc(["delete", "--force", "hyper-" + id]);
  }
  try {
    for (const id of await readdir(root)) {
      if (!Id.safeParse(id).success) continue;
      const path = join(root, id, "receipt.json");
      let receipt;
      try {
        receipt = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new DomainError("RECEIPT_CORRUPT");
      }
      if (receipt.status === "running") {
        await stop(id);
        await save(id, {
          digest: receipt.digest,
          status: "uncertain",
          stdout: "",
          stderr: "RUNNER_RESTARTED",
          exitCode: null,
          outputs: [],
        });
      }
    }
  } catch (error) {
    await releaseLease();
    await app.close();
    throw error;
  }
  let cached:
    { available: boolean; reason?: string; runtime?: string } | undefined;
  let checked = 0;
  async function execute(
    id: string,
    inputs: string,
    action: (name: string, signal: AbortSignal) => Promise<unknown>,
    signal: AbortSignal,
  ) {
    if (!config.COMPUTE_RUNTIME_DIR)
      throw new DomainError("COMPUTE_RUNTIME_NOT_CONFIGURED");
    const bundle = await runtimeBundle(config.COMPUTE_RUNTIME_DIR, "compute");
    await ensureSandboxSlice();
    const dir = join(root, id),
      name = "hyper-" + id;
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify(ociConfig(bundle.rootfs, inputs)),
      { mode: 0o600 },
    );
    signal.throwIfAborted();
    const child = spawn(
      "systemd-run",
      [
        ...systemdArgs("compute", id, 145),
        config.SANDBOX_RUNSC,
        ...flags,
        "run",
        "--bundle=" + dir,
        name,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let startupError = "",
      launchError: Error | undefined;
    child.stderr.on("data", (data: Buffer) => {
      if (startupError.length < 10000) startupError += data.toString();
    });
    child.once("error", (error) => {
      launchError = error;
    });
    const abort = () => {
      void stop(id).catch((error) =>
        console.error(
          JSON.stringify({
            service: "runner",
            code: "SANDBOX_STOP_FAILED",
            operationId: id,
            error: String(error),
          }),
        ),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      let running = false;
      for (let i = 0; i < 150; i++) {
        signal.throwIfAborted();
        if (launchError || child.exitCode !== null || child.signalCode !== null)
          throw new Error("SANDBOX_START_FAILED: " + startupError);
        try {
          running =
            JSON.parse(
              String((await runsc(["state", name], { timeout: 1000 })).stdout),
            ).status === "running";
        } catch {
          /* startup race */
        }
        if (running) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!running) throw new DomainError("SANDBOX_START_TIMEOUT");
      return await action(name, signal);
    } finally {
      signal.removeEventListener("abort", abort);
      await stop(id);
      child.kill("SIGTERM");
    }
  }
  let probing: ReturnType<typeof performProbe> | undefined;
  async function probe() {
    if (cached?.available && active.size > 0) return cached;
    probing ??= performProbe().finally(() => {
      probing = undefined;
    });
    return probing;
  }
  async function performProbe() {
    if (cached && Date.now() - checked < 30000) return cached;
    const id = randomUUID(),
      inputs = join(root, id, "inputs");
    try {
      await mkdir(inputs, { recursive: true, mode: 0o755 });
      if (config.COMPUTE_RUNTIME_DIR)
        await runtimeBundle(config.COMPUTE_RUNTIME_DIR, "compute", true);
      await execute(
        id,
        inputs,
        async (name, signal) => {
          const out = await runsc(
            [
              "exec",
              "--user=1000:1000",
              name,
              "/usr/local/bin/python3",
              "-I",
              "-c",
              'import os,socket; assert not os.path.exists("/home/ubuntu"); s=socket.socket(); s.settimeout(1)\ntry: s.connect(("1.1.1.1",443)); raise RuntimeError("NETWORK_OPEN")\nexcept OSError: pass\nprint("isolated-ok")',
            ],
            { signal },
          );
          if (!out.stdout.includes("isolated-ok"))
            throw new DomainError("SANDBOX_PROBE_FAILED");
        },
        AbortSignal.timeout(25000),
      );
      cached = { available: true, runtime: "runsc-systrap" };
    } catch (error) {
      console.error(
        JSON.stringify({
          service: "runner",
          code: "SANDBOX_PROBE_FAILED",
          detail: String(error).slice(0, 3000),
        }),
      );
      cached = {
        available: false,
        reason: "GVISOR_BUNDLE_OR_CGROUP_UNAVAILABLE",
      };
    } finally {
      await rm(join(root, id), { recursive: true, force: true });
    }
    checked = Date.now();
    return cached;
  }
  app.addHook("onRequest", async (req) => {
    if (
      !equal(req.headers.authorization ?? "", "Bearer " + config.RUNNER_TOKEN)
    )
      throw new DomainError("UNAUTHENTICATED", 401);
  });
  app.setErrorHandler((error, _req, reply) =>
    reply.code(error instanceof DomainError ? error.status : 400).send({
      error: error instanceof DomainError ? error.code : "RUNNER_ERROR",
    }),
  );
  app.get("/health", async () => ({ ...(await probe()), protocol: 1 }));
  app.get("/metrics", async () => ({
    active: active.size,
    ...(await sandboxMetrics()),
  }));
  app.post("/operations/:id/cancel", async (req) => {
    const id = Id.parse((req.params as { id: string }).id);
    active.get(id)?.abort();
    return { cancelled: true };
  });
  app.post("/run", async (req) => {
    const input = RunRequest.parse(req.body),
      id = input.operationId,
      digest = hash(JSON.stringify(input)),
      dir = join(root, id);
    let previous;
    try {
      previous = JSON.parse(await readFile(join(dir, "receipt.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new DomainError("RECEIPT_CORRUPT", 409);
    }
    if (previous) {
      if (previous.digest !== digest)
        throw new DomainError("OPERATION_CONFLICT", 409);
      if (previous.status === "running")
        throw new DomainError("OPERATION_RUNNING", 409);
      return RunResponse.parse(previous);
    }
    // Reserve before the first await; duplicate requests and preflight cannot bypass capacity.
    if (active.has(id)) throw new DomainError("OPERATION_RUNNING", 409);
    if (stopping || active.size >= 1) throw new DomainError("RUNNER_BUSY", 503);
    const controller = new AbortController();
    active.set(id, controller);
    let dispatched = false;
    try {
      if (!(await probe()).available)
        throw new DomainError("SANDBOX_UNAVAILABLE", 503);
      const inputs = join(dir, "inputs");
      await mkdir(inputs, { recursive: true, mode: 0o755 });
      let bytes = 0;
      for (const file of input.inputs) {
        const data = Buffer.from(file.data, "base64");
        bytes += data.length;
        if (bytes > Limits.fileBytes) throw new DomainError("INPUT_SIZE");
        await writeFile(join(inputs, file.id + "." + file.format), data, {
          mode: 0o444,
        });
      }
      for (const [path, content] of Object.entries(input.skillFiles || {})) {
        const parts = path.split("/");
        await mkdir(join(inputs, "skill", ...parts.slice(0, -1)), {
          recursive: true,
          mode: 0o755,
        });
        await writeFile(join(inputs, "skill", path), content, { mode: 0o444 });
      }
      const script = input.language === "python" ? "program.py" : "program.mjs";
      await writeFile(join(inputs, script), input.code, { mode: 0o444 });
      await save(id, { digest, status: "running" });
      const deadline = AbortSignal.timeout(Limits.codeMs);
      const signal = AbortSignal.any([controller.signal, deadline]);
      const result = await execute(
        id,
        inputs,
        async (name) => {
          dispatched = true;
          let stdout = "",
            stderr = "",
            exitCode = 0;
          try {
            const out = await runsc(
              [
                "exec",
                "--user=1000:1000",
                "--cwd=/work",
                name,
                input.language === "python"
                  ? "/usr/local/bin/python3"
                  : "/usr/local/bin/node",
                "/inputs/" + script,
              ],
              { timeout: Limits.codeMs, signal },
            );
            stdout = String(out.stdout).slice(0, 100000);
            stderr = String(out.stderr).slice(0, 100000);
          } catch (error) {
            const e = error as {
              stdout?: string;
              stderr?: string;
              code?: number;
            };
            stdout = String(e.stdout ?? "").slice(0, 100000);
            stderr = String(e.stderr ?? "").slice(0, 100000);
            exitCode = typeof e.code === "number" ? e.code || 1 : 1;
            if (deadline.aborted) stderr += "\nTIME_LIMIT";
          }
          const outputs: { path: string; data: string }[] = [];
          let outputBytes = 0;
          if (exitCode === 0 && !signal.aborted) {
            for (const output of input.outputs) {
              // Export inside the still-live tmpfs; never extract an untrusted archive on the host.
              const exporter =
                'import os,stat,sys,base64\nfd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)\ns=os.fstat(fd);limit=int(sys.argv[2])\nassert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<=limit\nwith os.fdopen(fd,"rb") as f: data=f.read(limit+1)\nassert len(data)<=limit\nprint(base64.b64encode(data).decode("ascii"))';
              const out = await runsc(
                [
                  "exec",
                  "--user=1000:1000",
                  name,
                  "/usr/local/bin/python3",
                  "-I",
                  "-c",
                  exporter,
                  "/work/" + output,
                  String(Limits.fileBytes - outputBytes),
                ],
                {
                  signal,
                  maxBuffer: Math.ceil((Limits.fileBytes * 4) / 3) + 10000,
                },
              ).catch(() => {
                throw new DomainError("UNSAFE_OUTPUT");
              });
              const data = Buffer.from(String(out.stdout).trim(), "base64");
              outputBytes += data.length;
              if (outputBytes > Limits.fileBytes)
                throw new DomainError("UNSAFE_OUTPUT");
              outputs.push({ path: output, data: data.toString("base64") });
            }
          }
          return {
            status: controller.signal.aborted
              ? "cancelled"
              : exitCode === 0
                ? "completed"
                : "failed",
            stdout,
            stderr,
            exitCode,
            outputs,
          };
        },
        signal,
      );
      await save(id, { ...(result as object), digest });
      return RunResponse.parse(result);
    } catch (error) {
      const result = {
        digest,
        status: controller.signal.aborted
          ? "cancelled"
          : dispatched && !(error instanceof DomainError)
            ? "uncertain"
            : "failed",
        stdout: "",
        stderr: error instanceof DomainError ? error.code : "RUNNER_ERROR",
        exitCode: null,
        outputs: [],
      };
      await save(id, result);
      if (error instanceof DomainError && error.status === 503) throw error;
      return RunResponse.parse(result);
    } finally {
      controller.abort();
      active.delete(id);
    }
  });
  app.addHook("onClose", async () => {
    stopping = true;
    try {
      for (const [id, controller] of active) {
        controller.abort();
        await stop(id);
      }
    } finally {
      await releaseLease();
    }
  });
  return app;
}
