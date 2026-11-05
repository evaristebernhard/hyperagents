import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import EmbeddedPostgres from "embedded-postgres";
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
  createKernelBridge,
  listenPrivate,
  followup,
  cancelTask,
  kernelHealth,
  type Db,
  type Config,
} from "@hyper/runtime";
import type { ModelInput, ModelResult } from "@hyper/contracts";
let db: Db,
  cfg: Config,
  embedded: EmbeddedPostgres,
  dir: string,
  workspace: string,
  user: string;
let bridge: Awaited<ReturnType<typeof createKernelBridge>>,
  kernel: ChildProcess;
let logs = "",
  active = 0,
  maxActive = 0;
const completions = new Map<string, number>();
function response(
  content: string,
  tool?: { name: string; args: unknown },
): ModelResult {
  return {
    message: {
      role: "assistant",
      content,
      ...(tool
        ? {
            toolCalls: [
              {
                id: randomUUID(),
                name: tool.name,
                arguments: JSON.stringify(tool.args),
              },
            ],
          }
        : {}),
    },
    usage: { input: 10, output: 10 },
    finishReason: tool ? "tool_calls" : "stop",
    bytes: 150,
  };
}
async function controlled(input: ModelInput): Promise<ModelResult> {
  if (input.messages[0]?.content.includes("strict delivery reviewer"))
    return response('{"passed":true,"issues":[]}');
  const prompt = input.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
  const start = /CASE_\w+/.exec(prompt)?.[0] || "unknown";
  completions.set(start, (completions.get(start) || 0) + 1);
  active++;
  maxActive = Math.max(maxActive, active);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        resolve,
        prompt.includes("CASE_SLOW") ? 800 : 30,
      );
      input.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
    if (
      input.messages.some(
        (m) =>
          m.role === "tool" && m.content.includes("INSIDE a compaction thread"),
      )
    ) {
      const thread = /Your current thread ID is `([^`]+)`/.exec(
        input.messages[0]!.content,
      )![1]!;
      return response("", {
        name: "close_thread",
        args: {
          thread_id: thread,
          report_to_parent: "CASE_IDLE compacted durable proof",
        },
      });
    }
    if (prompt.includes("CASE_IDLE"))
      return response("", { name: "sleep_until_event_or_input", args: {} });
    if (
      prompt.includes("CASE_TIMER") &&
      !input.messages.some((m) => m.toolCalls?.some((c) => c.name === "sleep"))
    )
      return response("", { name: "sleep", args: { seconds: 1.5 } });
    if (prompt.includes("CASE_NATIVE")) {
      const thread = /Your current thread ID is `([^`]+)`/.exec(
        input.messages[0]!.content,
      )![1]!;
      if (
        input.messages.some(
          (m) => m.role === "tool" && m.content.includes("You are now INSIDE"),
        )
      )
        return response("", {
          name: "close_thread",
          args: { thread_id: thread, report_to_parent: "native-proof" },
        });
      if (input.messages.some((m) => m.content.includes("native-proof")))
        return response("", {
          name: "finish",
          args: { summary: "Native child reported", artifactIds: [] },
        });
      if (
        !input.messages.some((m) =>
          m.toolCalls?.some((c) => c.name === "spawn_thread"),
        )
      )
        return response("", {
          name: "spawn_thread",
          args: {
            instructions: "CASE_NATIVE_CHILD return a proof",
            child_of: [thread],
          },
        });
      return response("", { name: "sleep_until_event_or_input", args: {} });
    }
    if (prompt.includes("CASE_WAIT") && !prompt.includes("please continue"))
      return response("", {
        name: "ask_user",
        args: { question: "Please confirm" },
      });
    if (
      prompt.includes("CASE_ARTIFACT") &&
      !input.messages.some(
        (m) => m.role === "tool" && m.content.includes("artifactId"),
      )
    )
      return response("", {
        name: "artifact_write",
        args: {
          name: "proof.md",
          format: "md",
          content: "Verified durable output",
          sourceIds: [],
        },
      });
    const artifactIds = input.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => {
        try {
          const v = JSON.parse(m.content);
          return v.artifactId ? [v.artifactId] : [];
        } catch {
          return [];
        }
      });
    return response("", {
      name: "finish",
      args: { summary: "Controlled task completed", artifactIds },
    });
  } finally {
    active--;
  }
}
async function startKernel(extra: Record<string, string> = {}) {
  logs = "";
  kernel = spawn(
    join(process.cwd(), "kernel/target/debug/hyperagents-kernel"),
    {
      env: {
        ...process.env,
        DATABASE_URL: cfg.DATABASE_URL,
        KERNEL_SOCKET: cfg.KERNEL_SOCKET,
        KERNEL_BRIDGE_SOCKET: cfg.KERNEL_BRIDGE_SOCKET,
        ...extra,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  kernel.stdout?.on("data", (d) => {
    logs += d;
  });
  kernel.stderr?.on("data", (d) => {
    logs += d;
  });
  for (let n = 0; n < 100; n++) {
    if (kernel.exitCode !== null) throw new Error("Kernel exited: " + logs);
    if ((await kernelHealth(cfg.KERNEL_SOCKET)).available) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Kernel start timeout: " + logs);
}
async function stopKernel(signal: NodeJS.Signals = "SIGTERM") {
  if (kernel?.exitCode !== null || kernel?.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    kernel.once("exit", () => resolve());
    kernel.kill(signal);
  });
}
async function drive(id: string, target: string, timeout = 30000) {
  const engine = new Engine(db, cfg, (attempt) => ({
    name: "controlled",
    complete: async (input) => {
      await attempt();
      return controlled(input);
    },
  }));
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await getTask(db, id);
    if (t.state === target) return t;
    if (
      ["failed", "uncertain", "cancelled"].includes(t.state) &&
      t.state !== target
    )
      throw new Error(JSON.stringify({ t, logs }));
    const task = await claim(db);
    if (task) await engine.run(task);
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(
    "Task timeout: " + JSON.stringify(await getTask(db, id)) + "\n" + logs,
  );
}
async function make(prompt: string) {
  return (
    await createTask(db, workspace, { prompt }, randomUUID(), user, "rust")
  ).taskId;
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "hyper-kernel-"));
  embedded = new EmbeddedPostgres({
    databaseDir: join(dir, "pg"),
    user: "hyper",
    password: "hyper",
    port: 55447,
    persistent: false,
    autoRehydrateSymlinks: true,
    onLog: () => {},
    onError: () => {},
    postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
  });
  await embedded.initialise();
  await embedded.start();
  await embedded.createDatabase("kernel_test");
  cfg = config({
    DATABASE_URL: "postgres://hyper:hyper@127.0.0.1:55447/kernel_test",
    DATA_DIR: join(dir, "data"),
    KERNEL_SOCKET: join(dir, "run/kernel.sock"),
    KERNEL_BRIDGE_SOCKET: join(dir, "run/bridge.sock"),
    NODE_ENV: "test",
  });
  db = pool(cfg.DATABASE_URL);
  await migrate(db);
  const owner = await bootstrap(db, {
    email: "kernel@example.org",
    password: randomUUID(),
  });
  workspace = owner.workspaceId;
  user = owner.userId;
  bridge = await createKernelBridge(db, cfg, () => ({
    name: "controlled",
    complete: controlled,
  }));
  await listenPrivate(bridge, cfg.KERNEL_BRIDGE_SOCKET!);
  await startKernel();
});
after(async () => {
  await stopKernel();
  await bridge?.close();
  await db?.end();
  await embedded?.stop();
  await rm(dir, { recursive: true, force: true });
});
test("new runtime is fixed; TypeScript cannot claim Rust model slices", async () => {
  await stopKernel();
  const id = await make("CASE_BASIC fixed allocation");
  assert.equal(await claim(db), undefined);
  await startKernel();
  await assert.rejects(
    db.query("UPDATE tasks SET runtime_kind='typescript' WHERE id=$1", [id]),
    /immutable/,
  );
  await drive(id, "succeeded");
  assert.equal((await getTask(db, id)).runtime_version, "infinity-1abc6fc-v1");
  assert.equal(
    (
      await db.query("SELECT count(*) FROM kernel_threads WHERE task_id=$1", [
        id,
      ])
    ).rows[0].count,
    "1",
  );
});
test("ordinary tools persist real versioned artifacts, then finish with review", async () => {
  const id = await make("CASE_ARTIFACT create proof");
  await drive(id, "succeeded");
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM artifact_versions WHERE task_id=$1",
        [id],
      )
    ).rows[0].count,
    "1",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM operations WHERE task_id=$1 AND status='completed'",
        [id],
      )
    ).rows[0].count,
    "2",
  );
});
test("human wait releases the lease and survives process restart beyond twenty minutes", async () => {
  const id = await make("CASE_WAIT wait for human");
  await drive(id, "waiting_user");
  const count = completions.get("CASE_WAIT");
  await db.query(
    "UPDATE tasks SET updated_at=now()-interval '30 minutes' WHERE id=$1",
    [id],
  );
  assert.equal((await getTask(db, id)).lease_owner, null);
  await stopKernel();
  await startKernel();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(completions.get("CASE_WAIT"), count);
  await followup(db, id, workspace, "please continue");
  await drive(id, "succeeded");
});
test("cancellation fences a late model result", async () => {
  const id = await make("CASE_SLOW cancel this request");
  for (let i = 0; i < 100 && !completions.get("CASE_SLOW"); i++)
    await new Promise((r) => setTimeout(r, 20));
  await cancelTask(db, id, workspace);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal((await getTask(db, id)).state, "cancelled");
  assert.equal(
    (await db.query("SELECT count(*) FROM operations WHERE task_id=$1", [id]))
      .rows[0].count,
    "0",
  );
});
test("native Infinity child creation, report and close cross only committed boundaries", async () => {
  const id = await make("CASE_NATIVE root");
  await drive(id, "succeeded");
  const children = (
    await db.query("SELECT * FROM tasks WHERE parent_id=$1", [id])
  ).rows;
  assert.equal(children.length, 1);
  assert.equal(children[0].runtime_kind, "rust");
  assert.equal(children[0].state, "succeeded");
  assert.equal(
    (
      await db.query("SELECT count(*) FROM kernel_threads WHERE task_id=$1", [
        children[0].id,
      ])
    ).rows[0].count,
    "1",
  );
});
test("crash during a model call recovers the lease without duplicate tool intents", async () => {
  const old = completions.get("CASE_SLOW") || 0;
  const id = await make("CASE_SLOW recover the call");
  for (let n = 0; n < 150 && (completions.get("CASE_SLOW") || 0) === old; n++)
    await new Promise((r) => setTimeout(r, 20));
  await stopKernel("SIGKILL");
  await db.query(
    "UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  await startKernel();
  await drive(id, "succeeded");
  assert.equal(
    (await db.query("SELECT count(*) FROM operations WHERE task_id=$1", [id]))
      .rows[0].count,
    "1",
  );
  assert.equal(
    (await db.query("SELECT reserved_tokens FROM tasks WHERE id=$1", [id]))
      .rows[0].reserved_tokens,
    "0",
  );
});
test("post-commit process death leaves one durable intent for the TS dispatcher", async () => {
  await stopKernel();
  await startKernel({ KERNEL_FAULT: "after_commit" });
  const old = completions.get("CASE_SLOW") || 0;
  const id = await make("CASE_SLOW postcommit");
  for (let n = 0; n < 150 && kernel.exitCode === null; n++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(kernel.exitCode, 86, logs);
  assert.equal((await getTask(db, id)).runtime_phase, "tools");
  await startKernel();
  await drive(id, "succeeded");
  assert.equal(completions.get("CASE_SLOW"), old + 1);
  assert.equal(
    (await db.query("SELECT count(*) FROM operations WHERE task_id=$1", [id]))
      .rows[0].count,
    "1",
  );
});
test("pre-commit process death publishes neither snapshot nor intent", async () => {
  await stopKernel();
  await startKernel({ KERNEL_FAULT: "before_commit" });
  const id = await make("CASE_SLOW precommit");
  for (let n = 0; n < 150 && kernel.exitCode === null; n++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(kernel.exitCode, 86, logs);
  assert.equal(
    (await db.query("SELECT count(*) FROM operations WHERE task_id=$1", [id]))
      .rows[0].count,
    "0",
  );
  assert.equal(
    (
      await db.query("SELECT count(*) FROM kernel_threads WHERE task_id=$1", [
        id,
      ])
    ).rows[0].count,
    "0",
  );
  await db.query(
    "UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  await startKernel();
  await drive(id, "succeeded");
});
test("delayed tool input persists across restart without a resident timer", async () => {
  const id = await make("CASE_TIMER durable wait");
  for (let n = 0; n < 150; n++) {
    if (
      (
        await db.query(
          "SELECT 1 FROM kernel_inputs WHERE task_id=$1 AND id LIKE 'delay:%'",
          [id],
        )
      ).rowCount
    )
      break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const waiting = await getTask(db, id);
  assert.equal(waiting.lease_owner, null);
  await stopKernel();
  await startKernel();
  await drive(id, "succeeded");
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM kernel_inputs WHERE task_id=$1 AND id LIKE 'delay:%' AND consumed_at IS NOT NULL",
        [id],
      )
    ).rows[0].count,
    "1",
  );
});
test("redelivering a consumed input does not advance the same thread twice", async () => {
  const id = await make("CASE_IDLE duplicate delivery");
  await drive(id, "waiting_user");
  const before = completions.get("CASE_IDLE");
  await db.query("UPDATE kernel_inputs SET consumed_at=NULL WHERE id=$1", [
    "start:" + id,
  ]);
  await db.query("UPDATE tasks SET state='queued' WHERE id=$1", [id]);
  await drive(id, "waiting_user");
  assert.equal(completions.get("CASE_IDLE"), before);
  await cancelTask(db, id, workspace);
});
test("Infinity context compaction persists its summary before resuming original inputs", async () => {
  const id = await make("CASE_IDLE compaction root");
  await drive(id, "waiting_user");
  await db.query(
    "UPDATE kernel_threads SET snapshot=jsonb_set(snapshot,'{messages}',snapshot->'messages'||jsonb_build_array(jsonb_build_array(jsonb_build_object('kind','assistant','content',jsonb_build_object('text',repeat('x',82000))),'large-input'))) WHERE task_id=$1",
    [id],
  );
  await followup(db, id, workspace, "CASE_IDLE preserve the constraints");
  await drive(id, "waiting_user", 20000);
  const internal = (
    await db.query(
      "SELECT id,state FROM tasks WHERE parent_id=$1 AND kernel_internal",
      [id],
    )
  ).rows;
  assert.equal(internal.length, 1);
  assert.equal(internal[0].state, "succeeded");
  assert.ok(
    (
      await db.query("SELECT snapshot FROM kernel_threads WHERE task_id=$1", [
        id,
      ])
    ).rows[0].snapshot.compactions.length > 0,
  );
  await cancelTask(db, id, workspace);
});
test("model fragments enforce four global slots and two slots per workspace", async () => {
  const token = await invite(db, user);
  await register(db, {
    email: "fairness@example.org",
    password: randomUUID(),
    invite: token,
  });
  const other = (
    await db.query(
      "SELECT w.id,u.id AS user_id FROM workspaces w JOIN users u ON u.id=w.user_id WHERE u.email='fairness@example.org'",
    )
  ).rows[0];
  const tasks = [];
  for (let n = 0; n < 4; n++) tasks.push(await make("CASE_SLOW fairness " + n));
  for (let n = 0; n < 4; n++)
    tasks.push(
      (
        await createTask(
          db,
          other.id,
          { prompt: "CASE_SLOW alternate " + n },
          randomUUID(),
          other.user_id,
          "rust",
        )
      ).taskId,
    );
  const end = Date.now() + 2000;
  let sawFour = false;
  while (Date.now() < end) {
    const groups = (
      await db.query(
        "SELECT workspace_id,count(*) AS active FROM tasks WHERE runtime_kind='rust' AND state='running' AND runtime_phase='model' GROUP BY workspace_id",
      )
    ).rows;
    assert.ok(groups.every((r) => Number(r.active) <= 2));
    const count = groups.reduce((n, r) => n + Number(r.active), 0);
    assert.ok(count <= 4);
    sawFour ||= count === 4;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(sawFour);
  for (const id of tasks) await drive(id, "succeeded", 20000);
});
test("heartbeat contention never suspends the transaction it is waiting on", async () => {
  await stopKernel();
  await startKernel({ KERNEL_FAULT: "slow_reservation" });
  const id = await make("CASE_BASIC heartbeat transaction barrier");
  await drive(id, "succeeded");
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM model_attempts WHERE task_id=$1 AND status='running'",
        [id],
      )
    ).rows[0].count,
    "0",
  );
  await stopKernel();
  await startKernel();
});
test("dedup store errors abort the entire slice before tool dispatch", async () => {
  await stopKernel();
  await startKernel({ KERNEL_FAULT: "dedup_write" });
  const id = await make("CASE_BASIC dedup fault");
  await drive(id, "failed");
  assert.equal(
    (await db.query("SELECT count(*) FROM operations WHERE task_id=$1", [id]))
      .rows[0].count,
    "0",
  );
  assert.equal(
    (
      await db.query("SELECT count(*) FROM kernel_threads WHERE task_id=$1", [
        id,
      ])
    ).rows[0].count,
    "0",
  );
  await stopKernel();
  await startKernel();
});
test("ten thousand persisted sleepers consume no execution slots or per-task drivers", async () => {
  const rss = async () =>
    Number(
      /^VmRSS:\s+(\d+)/m.exec(
        await readFile(`/proc/${kernel.pid}/status`, "utf8"),
      )![1],
    );
  const before = await rss();
  await db.query(
    "INSERT INTO tasks(id,workspace_id,conversation_id,root_id,prompt,acceptance,state,runtime_kind,runtime_version) SELECT u,$1,$2,u,'waiting load test','{}','waiting_user','rust','infinity-1abc6fc-v1' FROM (SELECT gen_random_uuid() AS u FROM generate_series(1,10000)) s",
    [
      workspace,
      (await db.query("SELECT id FROM conversations LIMIT 1")).rows[0].id,
    ],
  );
  // Cover a full two-second fallback scan, not only the insertion instant.
  await new Promise((r) => setTimeout(r, 2500));
  const health = (await kernelHealth(cfg.KERNEL_SOCKET)) as {
    active?: number;
    sleeping?: number;
  };
  assert.equal(health.active, 0);
  assert.ok(health.sleeping! >= 10000);
  assert.ok((await rss()) - before < 64 * 1024);
  const connections = (
    await db.query(
      "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()",
    )
  ).rows[0].count;
  assert.ok(Number(connections) < 25);
  console.log(
    JSON.stringify({
      sleepingThreads: 10000,
      rssDeltaKiB: (await rss()) - before,
      databaseConnections: Number(connections),
      maxModelConcurrency: maxActive,
    }),
  );
});
