// Real model, production Worker/kernel and runsc; never substitute test adapters.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import { buildApp } from "@hyper/api";
import { createRunner } from "@hyper/runner";
import {
  config,
  pool,
  migrate,
  bootstrap,
  kernelHealth,
  type Db,
} from "@hyper/runtime";
import { TaskOverview } from "@hyper/contracts";
try {
  process.loadEnvFile("../.env");
} catch {}
const reportDir = resolve("../docs/verification-task-lifecycle");
await mkdir(reportDir, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(reportDir, runId);
await mkdir(runDir, { recursive: true });
const report = {
  date: new Date().toISOString(),
  model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
  results: [] as Record<string, unknown>[],
};
const save = () =>
  writeFile(
    join(reportDir, "real-model.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function port() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const n = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return n;
}
const dir = await mkdtemp(join(tmpdir(), "lifecycle-real-")),
  pgPort = await port(),
  apiPort = await port();
const cfg = config({
  ...process.env,
  DATABASE_URL: `postgres://hyper:hyper@127.0.0.1:${pgPort}/lifecycle_real`,
  DATA_DIR: join(dir, "data"),
  PUBLIC_ORIGIN: `http://127.0.0.1:${apiPort}`,
  PORT: String(apiPort),
  NODE_ENV: "test",
  RUNNER_TOKEN: randomUUID() + randomUUID(),
  COMPUTE_RUNTIME_DIR:
    process.env.COMPUTE_RUNTIME_DIR ||
    join(homedir(), ".local/share/hyperagents/runtimes/compute"),
  KERNEL_SOCKET: join(dir, "s/k.sock"),
  KERNEL_BRIDGE_SOCKET: join(dir, "s/b.sock"),
  BROWSER_ENABLED: "false",
});
const pg = new EmbeddedPostgres({
  databaseDir: join(dir, "pg"),
  port: pgPort,
  user: "hyper",
  password: "hyper",
  persistent: false,
  autoRehydrateSymlinks: true,
  onLog: () => {},
  onError: () => {},
  postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
});
let db: Db | undefined,
  app: Awaited<ReturnType<typeof buildApp>> | undefined,
  runner: Awaited<ReturnType<typeof createRunner>> | undefined,
  worker: ChildProcess | undefined,
  kernel: ChildProcess | undefined;
const headers: Record<string, string> = { origin: cfg.PUBLIC_ORIGIN };
async function request(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<any> {
  const r = await fetch(cfg.PUBLIC_ORIGIN + "/api/v1" + path, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw Error(`HTTP_${r.status}: ${path}`);
  return r.json();
}
async function stop(p?: ChildProcess) {
  if (p?.exitCode === null && p?.signalCode === null)
    await new Promise<void>((r) => {
      p.once("exit", () => r());
      p.kill("SIGTERM");
      setTimeout(() => p.kill("SIGKILL"), 5000).unref();
    });
}
try {
  if (!cfg.DEEPSEEK_API_KEY) {
    report.results.push({
      status: "unverified",
      reason: "MODEL_NOT_CONFIGURED",
    });
    process.exitCode = 2;
  } else {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("lifecycle_real");
    db = pool(cfg.DATABASE_URL);
    await migrate(db);
    const password = randomUUID() + randomUUID();
    await bootstrap(db, { email: "real-life@example.org", password });
    runner = await createRunner(cfg);
    cfg.RUNNER_URL = await runner.listen({ host: "127.0.0.1", port: 0 });
    console.log(JSON.stringify({ stage: "sandbox_warmup" }));
    const health = await runner.inject({
      url: "/health",
      headers: { authorization: "Bearer " + cfg.RUNNER_TOKEN },
    });
    console.log(JSON.stringify({ stage: "sandbox_health", ...health.json() }));
    app = await buildApp(db, cfg);
    await app.listen({ host: "127.0.0.1", port: apiPort });
    const login = await fetch(cfg.PUBLIC_ORIGIN + "/api/v1/auth/login", {
      method: "POST",
      headers: {
        origin: cfg.PUBLIC_ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "real-life@example.org", password }),
    });
    headers.cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    headers["x-csrf-token"] = (
      (await login.json()) as { csrfToken: string }
    ).csrfToken;
    const env = {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(cfg)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ),
    };
    worker = spawn(process.execPath, ["apps/worker/dist/index.js"], {
      env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    kernel = spawn("kernel/target/debug/hyperagents-kernel", {
      env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    for (
      let i = 0;
      i < 100 && !(await kernelHealth(cfg.KERNEL_SOCKET)).available;
      i++
    )
      await sleep(100);
    const capabilities = await request("/capabilities");
    const notes =
      "# 项目资料\n\n会议纪要 A（2026-11-01）：试点有 12 台设备，负责人林工。计划 11 月 10 日完成数据导出。已确认 9 台正常，3 台缺少传感器。\n\n会议纪要 B（2026-11-03）：采购只批准 2 个传感器；剩余 1 台设备暂缓。报告应区分已确认事项和待解决事项，不得将计划写成已经完成。";
    const form = new FormData();
    form.set(
      "file",
      new Blob([notes], { type: "text/markdown" }),
      "project-notes.md",
    );
    const upload = await fetch(cfg.PUBLIC_ORIGIN + "/api/v1/files", {
      method: "POST",
      headers,
      body: form,
    });
    assert.equal(upload.status, 201);
    const source = (await upload.json()) as { id: string };
    for (const runtime of ["typescript", "rust"] as const)
      for (const kind of ["research", "code"] as const) {
        if (kind === "code" && !capabilities.sandbox.available) {
          report.results.push({
            runtime,
            kind,
            status: "unverified",
            reason: capabilities.sandbox.reason,
          });
          await save();
          continue;
        }
        cfg.RUST_NEW_TASKS = runtime === "rust" ? "true" : "false";
        const prompt =
          kind === "research"
            ? "请读取附件项目资料，维护一个有稳定步骤 ID 的简短计划，整理为 project-summary.md。分为‘已确认事项’、‘待解决事项’和‘下一步’三节，保留数量、日期和负责人，并标明来自会议纪要 A 还是 B。不得假称计划已经完成。通过 finish 验收并交付真实文件。"
            : "维护一个简短计划。生成 statistics.py，实现 summarize(values)：返回 count、sum、mean（空数组 mean 为 None）。在沙箱真正执行测试，覆盖 [1,2,3]、[-1,1]、空数组；把测试结果写入 test-results.txt，同时交付 Python 源文件。仅用 Python 标准库，不需要网络。通过 finish 验收实际产物。";
        headers["idempotency-key"] = randomUUID();
        const { taskId } = await request("/tasks", "POST", {
          prompt,
          inputFileIds: kind === "research" ? [source.id] : [],
          acceptance: {
            formats: kind === "research" ? ["md"] : ["py", "txt"],
            requiredText:
              kind === "research" ? ["已确认事项", "待解决事项", "下一步"] : [],
            requireSources: false,
          },
        });
        delete headers["idempotency-key"];
        console.log(
          JSON.stringify({ runtime, kind, taskId, stage: "started" }),
        );
        let paused = false,
          resumed = false;
        const retries: {
          code: string | null;
          modelCalls: number;
          tokens: number;
        }[] = [];
        const start = Date.now();
        while (Date.now() - start < 600000) {
          const o = TaskOverview.parse(
            await request(`/tasks/${taskId}/overview`),
          );
          if (!paused && o.currentOperations.length) {
            await request(`/tasks/${taskId}/pause`, "POST");
            paused = true;
            console.log(
              JSON.stringify({ runtime, kind, stage: "pause_requested" }),
            );
          }
          if (paused && !resumed && o.control === "paused") {
            await sleep(1500);
            const stable = TaskOverview.parse(
              await request(`/tasks/${taskId}/overview`),
            );
            assert.equal(stable.budget.activeMs, o.budget.activeMs);
            assert.equal(stable.budget.modelCalls, o.budget.modelCalls);
            assert.deepEqual(
              stable.deliverables.map((d) => d.fileId),
              o.deliverables.map((d) => d.fileId),
            );
            await request(`/tasks/${taskId}/resume`, "POST");
            resumed = true;
            console.log(JSON.stringify({ runtime, kind, stage: "resumed" }));
          }
          if (
            o.task.state === "failed" &&
            o.availableActions.includes("retry") &&
            retries.length === 0
          ) {
            retries.push({
              code: o.task.errorCode,
              modelCalls: o.budget.modelCalls,
              tokens: o.budget.tokens,
            });
            await request(`/tasks/${taskId}/retry`, "POST");
            continue;
          }
          if (
            [
              "failed",
              "succeeded",
              "cancelled",
              "uncertain",
              "waiting_user",
              "waiting_approval",
            ].includes(o.task.state)
          )
            break;
          await sleep(500);
        }
        const o = TaskOverview.parse(
            await request(`/tasks/${taskId}/overview`),
          ),
          downloads = [];
        for (const f of o.deliverables) {
          const r = await fetch(cfg.PUBLIC_ORIGIN + f.downloadUrl, { headers });
          const bytes = Buffer.from(await r.arrayBuffer());
          assert.equal(r.status, 200);
          assert.equal(bytes.length, f.bytes);
          assert.equal(
            createHash("sha256").update(bytes).digest("hex"),
            f.sha256,
          );
          const name = `${runId}/${runtime}-${kind}-v${f.version}-${f.name}`;
          await writeFile(join(reportDir, name), bytes);
          downloads.push({
            name,
            fileId: f.fileId,
            version: f.version,
            bytes: bytes.length,
            sha256: f.sha256,
            validation: f.validation,
          });
        }
        const operations = (
          await db.query(
            "SELECT name,status FROM operations WHERE task_id=$1 ORDER BY step,ordinal",
            [taskId],
          )
        ).rows;
        const ok =
          o.task.state === "succeeded" &&
          paused &&
          resumed &&
          downloads.length > 0 &&
          o.plan !== null &&
          o.validation.some((v) => v.status === "passed") &&
          (kind !== "code" ||
            operations.some(
              (op) => op.name === "code_execute" && op.status === "completed",
            ));
        if (!ok) process.exitCode = 1;
        report.results.push({
          runtime,
          kind,
          taskId,
          status: ok ? "passed" : "failed",
          state: o.task.state,
          diagnosis: o.diagnosis,
          pauseVerified: paused && resumed,
          retries,
          plan: o.plan,
          budget: o.budget,
          downloads,
          validation: o.validation,
          operations,
          elapsedMs: Date.now() - start,
        });
        await save();
        console.log(
          JSON.stringify({
            runtime,
            kind,
            status: ok ? "passed" : "failed",
            state: o.task.state,
          }),
        );
        if (!["failed", "succeeded", "cancelled"].includes(o.task.state))
          await request(`/tasks/${taskId}/cancel`, "POST");
      }
  }
} catch (e) {
  report.results.push({
    status: "unverified",
    reason: e instanceof Error ? e.message : "UNEXPECTED_ERROR",
  });
  process.exitCode = 1;
} finally {
  await save();
  await writeFile(
    join(runDir, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await stop(worker);
  await stop(kernel);
  await app?.close();
  await runner?.close();
  await db?.end();
  await pg.stop().catch(() => {});
}
