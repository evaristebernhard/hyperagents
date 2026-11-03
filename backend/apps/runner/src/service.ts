import Fastify from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  open,
  readFile,
  writeFile,
  rename,
  readdir,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DomainError, Id, Limits } from "@hyper/contracts";
import {
  RunRequest,
  RunResponse,
  equal,
  hash,
  type Config,
} from "@hyper/runtime";
const exec = promisify(execFile);
export function containerArgs(name: string, inputDir: string, image: string) {
  return [
    "create",
    "--name",
    name,
    "--runtime=runsc",
    "--network=none",
    "--read-only",
    "--cpus=2",
    "--memory=2g",
    "--memory-swap=2g",
    "--pids-limit=128",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=1000:1000",
    "--ulimit",
    "nofile=256:256",
    "--ulimit",
    "nproc=128:128",
    "--ulimit",
    "fsize=20971520:20971520",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=128m,mode=1777",
    "--tmpfs",
    "/work:rw,nosuid,size=1g,mode=1777",
    "--mount",
    `type=bind,source=${inputDir},target=/inputs,readonly`,
    "--workdir=/work",
    "--env",
    "HOME=/tmp",
    "--env",
    "MPLCONFIGDIR=/tmp/matplotlib",
    "--log-driver=local",
    "--log-opt",
    "max-size=1m",
    "--log-opt",
    "max-file=2",
    image,
  ];
}
export async function createRunner(config: Config) {
  if (!config.RUNNER_TOKEN) throw new DomainError("RUNNER_TOKEN_REQUIRED");
  const root = join(config.DATA_DIR, "runner");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const app = Fastify({ bodyLimit: 32 * 1024 * 1024, logger: false });
  const active = new Map<string, AbortController>();
  let health: { available: boolean; reason?: string } = {
      available: false,
      reason: "NOT_PROBED",
    },
    checked = 0;
  async function probe() {
    if (Date.now() - checked < 30000) return health;
    try {
      const r = await exec(
        "docker",
        ["info", "--format", "{{json .Runtimes}}"],
        { timeout: 5000, maxBuffer: 100000 },
      );
      if (!Object.hasOwn(JSON.parse(r.stdout), "runsc")) throw new Error();
      await exec("docker", ["image", "inspect", config.SANDBOX_IMAGE], {
        timeout: 5000,
        maxBuffer: 100000,
      });
      await exec(
        "docker",
        [
          "run",
          "--rm",
          "--runtime=runsc",
          "--network=none",
          "--read-only",
          "--memory=512m",
          "--pids-limit=128",
          config.SANDBOX_IMAGE,
          "python3",
          "-c",
          'print("sandbox-ok")',
        ],
        { timeout: 10000, maxBuffer: 10000 },
      );
      health = { available: true };
    } catch {
      health = { available: false, reason: "GVISOR_OR_IMAGE_UNAVAILABLE" };
    }
    checked = Date.now();
    return health;
  }
  async function save(id: string, value: unknown) {
    const dir = join(root, id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, "receipt.tmp");
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flush: true });
    await rename(temp, join(dir, "receipt.json"));
    for (const directory of [dir, root]) {
      const handle = await open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  // A process restart cannot prove a previous arbitrary program's outcome. Kill only this runner's named containers.
  for (const id of await readdir(root)) {
    if (!Id.safeParse(id).success) continue;
    try {
      const r = JSON.parse(
        await readFile(join(root, id, "receipt.json"), "utf8"),
      ) as { status: string; digest: string };
      if (r.status === "running") {
        await exec("docker", ["rm", "-f", "hyper-v1-" + id], {
          timeout: 10000,
          maxBuffer: 10000,
        }).catch(() => {});
        await save(id, {
          digest: r.digest,
          status: "uncertain",
          stdout: "",
          stderr: "RUNNER_RESTARTED",
          exitCode: null,
          outputs: [],
        });
      }
    } catch {
      /* Incomplete receipts remain unavailable, never replayed. */
    }
  }
  app.addHook("onRequest", async (req) => {
    const value = req.headers.authorization ?? "";
    if (!equal(value, "Bearer " + config.RUNNER_TOKEN))
      throw new DomainError("UNAUTHENTICATED", 401);
  });
  app.setErrorHandler((e, _req, reply) => {
    void reply
      .code(e instanceof DomainError ? e.status : 400)
      .send({ error: e instanceof DomainError ? e.code : "RUNNER_ERROR" });
  });
  app.get("/health", probe);
  app.post("/operations/:id/cancel", async (req) => {
    const id = Id.parse((req.params as { id: string }).id);
    active.get(id)?.abort();
    await exec("docker", ["rm", "-f", "hyper-v1-" + id], {
      timeout: 5000,
      maxBuffer: 10000,
    }).catch(() => {});
    return { cancelled: true };
  });
  app.post("/run", async (req, reply) => {
    const input = RunRequest.parse(req.body);
    const digest = hash(JSON.stringify(input)),
      id = input.operationId,
      name = "hyper-v1-" + id,
      dir = join(root, id);
    let receipt: unknown;
    try {
      receipt = JSON.parse(await readFile(join(dir, "receipt.json"), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new DomainError("RECEIPT_CORRUPT", 409);
    }
    if (receipt) {
      const r = z
        .object({ digest: z.string(), status: z.string() })
        .passthrough()
        .parse(receipt);
      if (r.digest !== digest) throw new DomainError("OPERATION_CONFLICT", 409);
      if (r.status === "running")
        throw new DomainError("OPERATION_RUNNING", 409);
      return RunResponse.parse(r);
    }
    if (active.has(id)) throw new DomainError("OPERATION_RUNNING", 409);
    if (active.size >= 4) throw new DomainError("RUNNER_BUSY", 503);
    const controller = new AbortController();
    active.set(id, controller);
    try {
      if (!(await probe()).available)
        throw new DomainError("SANDBOX_UNAVAILABLE", 503);
      await mkdir(join(dir, "inputs"), { recursive: true, mode: 0o755 });
      await save(id, { digest, status: "running" });
      let inputBytes = 0;
      for (const file of input.inputs) {
        const bytes = Buffer.from(file.data, "base64");
        inputBytes += bytes.length;
        if (inputBytes > Limits.fileBytes) throw new DomainError("INPUT_SIZE");
        await writeFile(
          join(dir, "inputs", file.id + "." + file.format),
          bytes,
          { mode: 0o444 },
        );
      }
      const script = input.language === "python" ? "program.py" : "program.mjs";
      await writeFile(join(dir, "inputs", script), input.code, { mode: 0o444 });
      const args = containerArgs(
        name,
        join(dir, "inputs"),
        config.SANDBOX_IMAGE,
      );
      // Keep the tmpfs mounted until outputs have been copied. A stopped
      // container loses its tmpfs, including every generated delivery file.
      args.push("sleep", "infinity");
      await exec("docker", args, {
        timeout: 15000,
        maxBuffer: 100000,
        signal: controller.signal,
      });
      await exec("docker", ["start", name], {
        timeout: 15000,
        maxBuffer: 10000,
        signal: controller.signal,
      });
      let stdout = "",
        stderr = "",
        exitCode: number | null = 0;
      let executionTimedOut = false;
      const executionDeadline = setTimeout(() => {
        executionTimedOut = true;
        void exec("docker", ["rm", "-f", name], { timeout: 5000, maxBuffer: 10000 }).catch(() => {});
      }, Limits.codeMs);
      try {
        const out = await exec("docker", ["exec", name,
          input.language === "python" ? "python3" : "node", "/inputs/" + script], {
          timeout: Limits.codeMs,
          maxBuffer: 200000,
          signal: controller.signal,
        });
        stdout = out.stdout.slice(0, 100000);
        stderr = out.stderr.slice(0, 100000);
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; code?: number };
        stdout = String(err.stdout ?? "").slice(0, 100000);
        stderr = String(err.stderr ?? "").slice(0, 100000);
        exitCode = typeof err.code === "number" ? err.code : 1;
      } finally {
        clearTimeout(executionDeadline);
      }
      const inspected = await exec(
        "docker",
        ["inspect", "--format", "{{json .State}}", name],
        { timeout: 5000, maxBuffer: 10000 },
      ).catch(() => undefined);
      if (inspected) {
        const state = z
          .object({
            ExitCode: z.number(),
            Running: z.boolean(),
            OOMKilled: z.boolean(),
          })
          .parse(JSON.parse(inspected.stdout));
        if (!state.Running || state.OOMKilled) {
          exitCode = state.ExitCode || 1;
          if (state.OOMKilled) stderr += "\nMEMORY_LIMIT";
        }
      }
      if (executionTimedOut) {
        exitCode = 1;
        stderr += "\nTIME_LIMIT";
      }
      const outputs: { path: string; data: string }[] = [];
      let outputBytes = 0;
      if (exitCode === 0 && !controller.signal.aborted) {
        for (const output of input.outputs) {
          // Export bounded regular files inside the sandbox. Never extract an
          // untrusted directory/tar archive or follow a symlink on the host.
          const exporter = [
            "import os,stat,sys,base64",
            "fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)",
            "s=os.fstat(fd)",
            "limit=int(sys.argv[2])",
            "assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<=limit",
            "with os.fdopen(fd,'rb') as f: data=f.read(limit+1)",
            "assert len(data)<=limit",
            "sys.stdout.write(base64.b64encode(data).decode('ascii'))",
          ].join("\n");
          const exported = await exec("docker", ["exec", name, "python3", "-I", "-c", exporter,
            "/work/" + output, String(Limits.fileBytes - outputBytes)], {
            timeout: 10000,
            maxBuffer: Math.ceil(Limits.fileBytes * 4 / 3) + 10000,
            signal: controller.signal,
          }).catch(() => { throw new DomainError("UNSAFE_OUTPUT"); });
          const bytes = Buffer.from(exported.stdout, "base64");
          outputBytes += bytes.length;
          if (outputBytes > Limits.fileBytes) throw new DomainError("UNSAFE_OUTPUT");
          outputs.push({ path: output, data: bytes.toString("base64") });
        }
      }
      const result = {
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
      await save(id, { ...result, digest });
      return RunResponse.parse(result);
    } catch (e) {
      if (receipt === undefined) {
        await save(id, {
          digest,
          status: controller.signal.aborted ? "cancelled" : "failed",
          stdout: "",
          stderr: e instanceof DomainError ? e.code : "RUNNER_ERROR",
          exitCode: null,
          outputs: [],
        }).catch(() => {});
      }
      throw e;
    } finally {
      controller.abort();
      await exec("docker", ["rm", "-f", name], {
        timeout: 10000,
        maxBuffer: 10000,
      }).catch(() => {});
      active.delete(id);
    }
  });
  app.addHook("onClose", async () => {
    for (const [id, c] of active) {
      c.abort();
      await exec("docker", ["rm", "-f", "hyper-v1-" + id], {
        timeout: 5000,
        maxBuffer: 10000,
      }).catch(() => {});
    }
  });
  return app;
}
