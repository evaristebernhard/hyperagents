import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import EmbeddedPostgres from "embedded-postgres";
import { buildApp } from "@hyper/api";
import {
  config,
  pool,
  migrate,
  bootstrap,
  invite,
  register,
  createTask,
  getTask,
  claim,
  Engine,
  Storage,
  taskOverview,
  controlTask,
  settlePauses,
  followup,
  cancelTask,
  retryTask,
  updatePlan,
  createKernelBridge,
  listenPrivate,
  kernelHealth,
  type Db,
  type Config,
} from "@hyper/runtime";
import {
  Client,
  TaskOverview,
  type ModelInput,
  type ModelResult,
  type ToolName,
} from "@hyper/contracts";
let db: Db,
  cfg: Config,
  pg: EmbeddedPostgres,
  workspace: string,
  user: string,
  other: string;
let app: Awaited<ReturnType<typeof buildApp>>,
  bridge: Awaited<ReturnType<typeof createKernelBridge>>,
  kernel: ChildProcess;
let headers: Record<string, string>,
  logs = "",
  working = new Set<Promise<unknown>>(),
  stop = false;
const password = "lifecycle-test-password-123";
const scenarios = new Map<
  string,
  {
    calls: number;
    next: (input: ModelInput, call: number) => Promise<ModelResult>;
  }
>();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function response(
  name: ToolName | "spawn_thread" | "sleep_until_event_or_input",
  args: unknown,
): ModelResult {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: randomUUID(), name, arguments: JSON.stringify(args) }],
    },
    usage: { input: 10, output: 10 },
    finishReason: "tool_calls",
    bytes: 200,
  };
}
async function model(input: ModelInput): Promise<ModelResult> {
  if (input.messages[0]?.content.includes("strict delivery reviewer"))
    return {
      message: { role: "assistant", content: '{"passed":true,"issues":[]}' },
      usage: { input: 10, output: 10 },
      finishReason: "stop",
      bytes: 60,
    };
  const key = [...scenarios.keys()].find((k) =>
    input.messages.some((m) => m.content.includes(k)),
  );
  assert.ok(key, "fixture scenario must be identified");
  const s = scenarios.get(key)!;
  return s.next(input, ++s.calls);
}
let engine: Engine;
async function waitFor(predicate: () => Promise<boolean>, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error("Timed out: " + logs.slice(-2000));
}
async function startKernel() {
  kernel = spawn(
    join(process.cwd(), "kernel/target/debug/hyperagents-kernel"),
    {
      env: {
        ...process.env,
        DATABASE_URL: cfg.DATABASE_URL,
        KERNEL_SOCKET: cfg.KERNEL_SOCKET,
        KERNEL_BRIDGE_SOCKET: cfg.KERNEL_BRIDGE_SOCKET,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  kernel.stderr?.on("data", (d) => {
    logs += d;
  });
  await waitFor(async () => (await kernelHealth(cfg.KERNEL_SOCKET)).available);
}
async function stopKernel() {
  if (kernel?.exitCode === null && kernel?.signalCode === null)
    await new Promise<void>((resolve) => {
      kernel.once("exit", () => resolve());
      kernel.kill("SIGTERM");
    });
}
before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "hyper-lifecycle-"));
  pg = new EmbeddedPostgres({
    databaseDir: join(dir, "pg"),
    user: "hyper",
    password: "hyper",
    port: 55449,
    persistent: false,
    autoRehydrateSymlinks: true,
    onLog: () => {},
    onError: () => {},
    postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("lifecycle");
  cfg = config({
    DATABASE_URL: "postgres://hyper:hyper@127.0.0.1:55449/lifecycle",
    DATA_DIR: join(dir, "data"),
    NODE_ENV: "test",
    PUBLIC_ORIGIN: "http://localhost:18089",
    KERNEL_SOCKET: join(dir, "s/k.sock"),
    KERNEL_BRIDGE_SOCKET: join(dir, "s/b.sock"),
  });
  db = pool(cfg.DATABASE_URL);
  await migrate(db);
  ({ workspaceId: workspace, userId: user } = await bootstrap(db, {
    email: "life@example.org",
    password,
  }));
  await register(db, {
    email: "other@example.org",
    password,
    invite: await invite(db, user),
  });
  other = (
    await db.query(
      "SELECT w.id FROM workspaces w JOIN users u ON u.id=w.user_id WHERE u.email='other@example.org'",
    )
  ).rows[0].id;
  app = await buildApp(db, cfg);
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: cfg.PUBLIC_ORIGIN },
    payload: { email: "life@example.org", password },
  });
  headers = {
    origin: cfg.PUBLIC_ORIGIN,
    cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    "x-csrf-token": login.json().csrfToken,
  };
  engine = new Engine(db, cfg, (attempt) => ({
    name: "controlled",
    complete: async (input) => {
      await attempt();
      return model(input);
    },
  }));
  bridge = await createKernelBridge(db, cfg, () => ({
    name: "controlled",
    complete: model,
  }));
  await listenPrivate(bridge, cfg.KERNEL_BRIDGE_SOCKET!);
  await startKernel();
  // Multiple tasks may run concurrently, just as in the production worker.
  const loop = async () => {
    while (!stop) {
      const t = await claim(db);
      if (t) {
        const p = engine.run(t);
        working.add(p);
        void p.finally(() => working.delete(p));
      }
      await settlePauses(db);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const p = loop();
  working.add(p);
  void p.finally(() => working.delete(p));
});
afterEach(async () => {
  for (const row of (
    await db.query(
      "SELECT id FROM tasks WHERE parent_id IS NULL AND state NOT IN ('failed','succeeded','cancelled')",
    )
  ).rows)
    await cancelTask(db, row.id, workspace);
});
after(async () => {
  stop = true;
  await stopKernel();
  await Promise.allSettled([...working]);
  await bridge?.close();
  await app?.close();
  await db?.end();
  await pg?.stop();
});
async function make(
  runtime: "typescript" | "rust",
  next: (input: ModelInput, n: number) => Promise<ModelResult>,
) {
  const key = "LIFE_" + randomUUID();
  scenarios.set(key, { calls: 0, next });
  const id = (
    await createTask(
      db,
      workspace,
      { prompt: key },
      randomUUID(),
      user,
      runtime,
    )
  ).taskId;
  return { id, key };
}
for (const runtime of ["typescript", "rust"] as const) {
  test(`${runtime}: pause in model, durable plan, saved versions, resume and immutable acceptance`, async () => {
    const started = deferred(),
      release = deferred();
    const { id, key } = await make(runtime, async (input, n) => {
      if (n === 1) {
        started.resolve();
        await release.promise;
        return response("update_plan", {
          expectedVersion: 0,
          reason: "Organize work",
          steps: [
            { id: "write", title: "Write output", status: "in_progress" },
          ],
        });
      }
      if (n === 2) {
        assert.ok(
          input.messages.some((m) =>
            m.content.includes('TASK_PLAN: {"version":1,'),
          ),
          "latest persisted plan must be in each runtime's model context",
        );
        return response("artifact_write", {
          name: "proof.md",
          format: "md",
          content: "durable proof",
        });
      }
      if (n === 3)
        return response("update_plan", {
          expectedVersion: 1,
          reason: "Output saved",
          steps: [{ id: "write", title: "Write output", status: "completed" }],
        });
      return response("finish", {
        summary: "Delivered",
        artifactIds: (
          await db.query(
            "SELECT artifact_id FROM artifact_versions v JOIN tasks t ON t.id=v.task_id WHERE t.prompt=$1",
            [key],
          )
        ).rows.map((r) => r.artifact_id),
      });
    });
    await started.promise;
    await controlTask(db, id, workspace, "pause");
    assert.equal(
      (await taskOverview(db, id, workspace)).control,
      "pause_requested",
    );
    release.resolve();
    await waitFor(
      async () => (await getTask(db, id)).control_state === "paused",
    );
    const paused = await getTask(db, id);
    assert.equal(scenarios.get(key)!.calls, 1);
    assert.equal(
      (
        await db.query(
          "SELECT count(*) FROM operations WHERE task_id=$1 AND status='completed'",
          [id],
        )
      ).rows[0].count,
      "0",
    );
    await stopKernel();
    await startKernel();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await getTask(db, id)).active_ms, paused.active_ms);
    await controlTask(db, id, workspace, "pause");
    assert.equal(
      (await getTask(db, id)).control_revision,
      paused.control_revision,
    );
    await controlTask(db, id, workspace, "resume");
    await waitFor(async () => (await getTask(db, id)).state === "succeeded");
    const overview = await taskOverview(db, id, workspace);
    assert.equal(overview.plan?.version, 2);
    assert.equal(overview.completedSteps, 1);
    assert.equal(overview.deliverables.length, 1);
    assert.equal(overview.validation[0]?.status, "passed");
    assert.equal(overview.deliverables[0]?.validation, "passed");
    const file = overview.deliverables[0]!;
    const download = await app.inject({ url: file.downloadUrl, headers });
    assert.equal(download.body, "durable proof");
    const before = JSON.stringify(overview.validation);
    const revision = (
      await createTask(
        db,
        workspace,
        { prompt: "revision", conversationId: overview.task.conversationId },
        randomUUID(),
      )
    ).taskId;
    await controlTask(db, revision, workspace, "pause");
    const revisionOwner = randomUUID();
    await db.query(
      "UPDATE tasks SET state='running',lease_owner=$2,lease_until=now()+interval '30 seconds' WHERE id=$1",
      [revision, revisionOwner],
    );
    await new Storage(cfg.DATA_DIR, db).artifact(
      await getTask(db, revision),
      randomUUID(),
      {
        name: "proof.md",
        format: "md",
        bytes: Buffer.from("revision"),
        artifactId: file.artifactId,
        sourceIds: [],
      },
      revisionOwner,
    );
    assert.equal(
      JSON.stringify((await taskOverview(db, id, workspace)).validation),
      before,
    );
    assert.equal(
      (await taskOverview(db, id, workspace)).deliverables[0]!.fileId,
      file.fileId,
    );
  });
  test(`${runtime}: current sandbox operation settles once; instruction and resume preserve budget`, async () => {
    const started = deferred(),
      release = deferred();
    let runs = 0;
    const originalHealth = engine.tools.runner.health,
      originalRun = engine.tools.runner.run;
    engine.tools.runner.health = async () => ({ available: true });
    engine.tools.runner.run = async () => {
      runs++;
      started.resolve();
      await release.promise;
      return {
        status: "completed" as const,
        stdout: "proof",
        stderr: "",
        exitCode: 0,
        outputs: [
          {
            path: "proof.py",
            data: Buffer.from("print(42)").toString("base64"),
          },
        ],
      };
    };
    try {
      const { id } = await make(runtime, async (_input, n) =>
        n === 1
          ? response("code_execute", {
              language: "python",
              code: "print(42)",
              outputs: [{ path: "proof.py", format: "py" }],
            })
          : response("ask_user", { question: "Confirm the result" }),
      );
      await started.promise;
      await controlTask(db, id, workspace, "pause");
      await followup(db, id, workspace, "Keep the saved code");
      release.resolve();
      await waitFor(
        async () => (await getTask(db, id)).control_state === "paused",
      );
      const saved = await taskOverview(db, id, workspace);
      assert.equal(saved.deliverables.length, 1);
      assert.equal(runs, 1);
      await controlTask(db, id, workspace, "resume");
      await waitFor(
        async () => (await getTask(db, id)).state === "waiting_user",
      );
      const resumed = await taskOverview(db, id, workspace);
      assert.equal(resumed.deliverables.length, 1);
      assert.equal(runs, 1);
      assert.ok(resumed.budget.modelCalls >= saved.budget.modelCalls);
      await controlTask(db, id, workspace, "pause");
      await controlTask(db, id, workspace, "resume");
      assert.equal((await getTask(db, id)).state, "waiting_user");
    } finally {
      release.resolve();
      engine.tools.runner.health = originalHealth;
      engine.tools.runner.run = originalRun;
    }
  });
}
test("control endpoints: CSRF, workspace isolation, idempotency and generated OpenAPI", async () => {
  const id = (
    await createTask(db, workspace, { prompt: "pending" }, randomUUID())
  ).taskId;
  for (const action of ["pause", "resume"]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/tasks/${id}/${action}`,
          headers: { cookie: headers.cookie! },
        })
      ).statusCode,
      403,
    );
  }
  await assert.rejects(taskOverview(db, id, other), { message: "NOT_FOUND" });
  await assert.rejects(controlTask(db, id, other, "pause"), {
    message: "NOT_FOUND",
  });
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/tasks/${id}/pause`,
    headers,
  });
  assert.equal(r.statusCode, 200, r.body);
  TaskOverview.parse(r.json());
  const doc = (
    await app.inject({ url: "/api/v1/openapi.json", headers })
  ).json();
  assert.ok(
    doc.paths["/api/v1/tasks/{id}/overview"] ||
      doc.paths["/api/v1/tasks/:id/overview"],
  );
  const client = new Client(cfg.PUBLIC_ORIGIN);
  assert.equal(typeof client.overview, "function");
  await cancelTask(db, id, workspace);
  await controlTask(db, id, workspace, "resume");
  assert.equal((await getTask(db, id)).state, "cancelled");
});

test("plan CAS, stable IDs, operation replay and paused crash recovery", async () => {
  const started = deferred(),
    release = deferred();
  const { id } = await make("typescript", async () => {
    started.resolve();
    await release.promise;
    return response("ask_user", { question: "Continue?" });
  });
  await started.promise;
  await controlTask(db, id, workspace, "pause");
  release.resolve();
  await waitFor(async () => (await getTask(db, id)).control_state === "paused");
  const owner = randomUUID();
  await db.query(
    "UPDATE tasks SET state='running',lease_owner=$2,lease_until=now()+interval '30 seconds' WHERE id=$1",
    [id, owner],
  );
  const t = await getTask(db, id);
  const op = async () => {
    const opId = randomUUID();
    await db.query(
      "INSERT INTO operations(id,task_id,step,call_id,name,args,status,replay) VALUES($1,$2,50,$3,'update_plan','{}','running','safe')",
      [opId, id, randomUUID()],
    );
    return opId;
  };
  const op1 = await op(),
    first = {
      expectedVersion: 0,
      reason: "Initial",
      steps: [{ id: "a", title: "First", status: "pending" }],
    };
  const saved = await updatePlan(db, t, op1, first);
  assert.equal(saved.version, 1);
  assert.deepEqual(await updatePlan(db, t, op1, first), saved);
  await assert.rejects(
    updatePlan(db, t, op1, { ...first, reason: "Different" }),
    { message: "PLAN_OPERATION_CONFLICT" },
  );
  await assert.rejects(updatePlan(db, t, await op(), first), {
    message: "PLAN_VERSION_CONFLICT",
  });
  await assert.rejects(
    updatePlan(db, t, await op(), {
      ...first,
      expectedVersion: 1,
      steps: [{ id: "b", title: "Replacement", status: "pending" }],
    }),
    { message: "PLAN_STEP_REMOVAL_REQUIRES_SKIP" },
  );
  const [one, two] = await Promise.all([op(), op()]);
  const conflict = await Promise.allSettled(
    [one, two].map((operation) =>
      updatePlan(db, t, operation, {
        ...first,
        expectedVersion: 1,
        reason: "Progress",
        steps: [{ id: "a", title: "First", status: "completed" }],
      }),
    ),
  );
  assert.equal(conflict.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (await db.query("SELECT count(*) FROM task_plans WHERE task_id=$1", [id]))
      .rows[0].count,
    "2",
  );
  // Unknown side effects remain uncertain even if a pause was durable before the crash.
  await db.query(
    "INSERT INTO operations(id,task_id,step,call_id,name,args,status,replay) VALUES($1,$2,51,$3,'code_execute','{}','running','uncertain')",
    [randomUUID(), id, randomUUID()],
  );
  await db.query(
    "UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  await waitFor(async () => (await getTask(db, id)).state === "uncertain");
  await assert.rejects(retryTask(db, id, workspace), {
    message: "UNCERTAIN_REQUIRES_NEW_TASK",
  });
  assert.equal(
    (await taskOverview(db, id, workspace)).diagnosis?.category,
    "uncertain",
  );
});
for (const runtime of ["typescript", "rust"] as const) {
  test(`${runtime}: queued tree and unresolved approval remain stopped across controls`, async () => {
    const started = deferred(),
      release = deferred();
    const { id } = await make(runtime, async () => {
      started.resolve();
      await release.promise;
      return response("request_approval", {
        action: "Review only",
        payload: {},
      });
    });
    await started.promise;
    await controlTask(db, id, workspace, "pause");
    release.resolve();
    await waitFor(
      async () => (await getTask(db, id)).control_state === "paused",
    );
    const child = randomUUID();
    await db.query(
      "INSERT INTO tasks(id,workspace_id,conversation_id,parent_id,root_id,prompt,acceptance,state) SELECT $1,workspace_id,conversation_id,id,root_id,'Child','{}','queued' FROM tasks WHERE id=$2",
      [child, id],
    );
    assert.equal(
      (await db.query("SELECT task_dispatch_allowed($1) AS allowed", [child]))
        .rows[0].allowed,
      false,
    );
    await controlTask(db, child, workspace, "pause");
    assert.equal((await taskOverview(db, child, workspace)).rootTaskId, id);
    await cancelTask(db, child, workspace);
    await controlTask(db, id, workspace, "resume");
    await waitFor(
      async () => (await getTask(db, id)).state === "waiting_approval",
    );
    await controlTask(db, id, workspace, "pause");
    await followup(
      db,
      id,
      workspace,
      "Additional context, approval is still pending",
    );
    const approval = (
      await db.query("SELECT id,digest FROM approvals WHERE task_id=$1", [id])
    ).rows[0];
    const decided = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${id}/approvals/${approval.id}`,
      headers,
      payload: { digest: approval.digest, decision: "approved" },
    });
    assert.equal(decided.statusCode, 200);
    assert.equal((await getTask(db, id)).control_state, "paused");
    await controlTask(db, id, workspace, "resume");
    assert.equal((await getTask(db, id)).state, "waiting_approval");
    assert.equal(decided.json().executed, false);
    await cancelTask(db, id, workspace);
    await controlTask(db, id, workspace, "resume");
    assert.equal((await getTask(db, id)).state, "cancelled");
  });
}
test("budget diagnosis does not offer or permit budget-reset retries", async () => {
  const started = deferred(),
    release = deferred();
  const { id } = await make("typescript", async () => {
    started.resolve();
    await release.promise;
    return response("ask_user", { question: "Input?" });
  });
  await started.promise;
  await controlTask(db, id, workspace, "pause");
  release.resolve();
  await waitFor(async () => (await getTask(db, id)).control_state === "paused");
  await db.query(
    "UPDATE tasks SET state='failed',error_code='MODEL_BUDGET',model_calls=32,lease_owner=NULL,lease_until=NULL WHERE id=$1",
    [id],
  );
  const overview = await taskOverview(db, id, workspace);
  assert.equal(overview.diagnosis?.category, "budget");
  assert.deepEqual(overview.availableActions, ["new_task"]);
  await assert.rejects(retryTask(db, id, workspace), {
    message: "BUDGET_REQUIRES_NEW_TASK",
  });
  await db.query(
    "UPDATE tasks SET error_code='MODEL_UNAVAILABLE' WHERE id=$1",
    [id],
  );
  await assert.rejects(retryTask(db, id, workspace), {
    message: "BUDGET_REQUIRES_NEW_TASK",
  });
});

test("Rust pause before native delegation caches the completed model response", async () => {
  const started = deferred(),
    release = deferred();
  const { id, key } = await make("rust", async (input, n) => {
    if (n === 1) {
      started.resolve();
      await release.promise;
      const parent = /Your current thread ID is `([^`]+)`/.exec(
        input.messages[0]!.content,
      )![1]!;
      return response("spawn_thread", {
        instructions: "A child awaiting user input",
        child_of: [parent],
        fresh_context: true,
      });
    }
    return response("ask_user", { question: "Awaiting user input" });
  });
  await started.promise;
  await controlTask(db, id, workspace, "pause");
  release.resolve();
  await waitFor(async () => (await getTask(db, id)).control_state === "paused");
  assert.equal(
    (await db.query("SELECT count(*) FROM tasks WHERE parent_id=$1", [id]))
      .rows[0].count,
    "0",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM kernel_model_results WHERE task_id=$1",
        [id],
      )
    ).rows[0].count,
    "1",
  );
  assert.equal(scenarios.get(key)!.calls, 1);
  await stopKernel();
  await startKernel();
  await controlTask(db, id, workspace, "resume");
  await waitFor(
    async () =>
      (await db.query("SELECT count(*) FROM tasks WHERE parent_id=$1", [id]))
        .rows[0].count === "1",
  );
  // Subsequent calls can ask for input; spawn's completed response was reused.
  const calls = (
    await db.query("SELECT args FROM operations WHERE task_id=$1", [id])
  ).rows;
  assert.ok(!calls.some((r) => r.args?.error));
  await cancelTask(db, id, workspace);
});

for (const runtime of ["typescript", "rust"] as const) {
  test(`${runtime}: failed acceptance retains downloadable files and immutable verdicts`, async () => {
    const started = deferred(),
      release = deferred();
    const { id } = await make(runtime, async (_input, n) => {
      if (n === 1) {
        started.resolve();
        await release.promise;
        return response("artifact_write", {
          name: "incomplete.md",
          format: "md",
          content: "Saved but incomplete",
        });
      }
      const ids = (
        await db.query(
          "SELECT artifact_id FROM artifact_versions WHERE task_id=$1",
          [id],
        )
      ).rows.map((r) => r.artifact_id);
      return response("finish", {
        summary: "Candidate delivery",
        artifactIds: ids,
      });
    });
    await started.promise;
    await db.query("UPDATE tasks SET acceptance=$2 WHERE id=$1", [
      id,
      {
        formats: ["md"],
        requiredText: ["Required missing section"],
        requireSources: false,
      },
    ]);
    release.resolve();
    await waitFor(async () => (await getTask(db, id)).state === "failed");
    const o = await taskOverview(db, id, workspace);
    assert.equal(o.diagnosis?.category, "validation");
    assert.equal(o.validation.length, 3);
    assert.ok(
      o.validation.every(
        (v) => v.status === "failed" && v.artifacts.length === 1,
      ),
    );
    assert.equal(o.deliverables[0]!.validation, "failed");
    const download = await app.inject({
      url: o.deliverables[0]!.downloadUrl,
      headers,
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, "Saved but incomplete");
    await assert.rejects(retryTask(db, id, workspace), {
      message: "BUDGET_REQUIRES_NEW_TASK",
    });
  });
}

test("a pause request retains its workspace slot until the in-flight operation settles", async () => {
  const started = deferred(),
    release = deferred(),
    otherStarted = deferred(),
    otherRelease = deferred();
  const { id } = await make("typescript", async () => {
    started.resolve();
    await release.promise;
    return response("ask_user", { question: "Done?" });
  });
  await started.promise;
  await controlTask(db, id, workspace, "pause");
  const second = await make("typescript", async () => {
    otherStarted.resolve();
    await otherRelease.promise;
    return response("ask_user", { question: "Next?" });
  });
  try {
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await getTask(db, second.id)).state, "queued");
    release.resolve();
    await otherStarted.promise;
    assert.equal((await getTask(db, id)).control_state, "paused");
  } finally {
    release.resolve();
    otherRelease.resolve();
  }
});
