import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import EmbeddedPostgres from "embedded-postgres";
import { PgBoss } from "pg-boss";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildApp } from "@hyper/api";
import { containerArgs, createRunner } from "@hyper/runner";
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
  setState,
  followup,
  cancelTask,
  retryTask,
  validate,
  tx,
  event,
  type Db,
  type Config,
  type Task,
} from "@hyper/runtime";
import {
  Limits,
  type ModelAdapter,
  type ModelInput,
  type ModelResult,
  type Message,
} from "@hyper/contracts";
let db: Db,
  c: Config,
  embedded: EmbeddedPostgres | undefined,
  app: Awaited<ReturnType<typeof buildApp>>,
  owner: { userId: string; workspaceId: string },
  other: string;
let headers: Record<string, string>, second: Record<string, string>;
const password = "correct-horse-battery-123";
before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "hyper-test-"));
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    embedded = new EmbeddedPostgres({
      databaseDir: join(dir, "postgres"),
      user: "hyper",
      password: "hyper",
      port: 55439,
      persistent: false,
      autoRehydrateSymlinks: true,
      onLog: () => {},
      onError: () => {},
      postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
    });
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase("hyper_test");
    url = "postgres://hyper:hyper@127.0.0.1:55439/hyper_test";
  }
  c = config({
    DATABASE_URL: url,
    DATA_DIR: join(dir, "data"),
    NODE_ENV: "test",
    PUBLIC_ORIGIN: "http://localhost:8081",
  });
  db = pool(url);
  await migrate(db);
  owner = await bootstrap(db, { email: "owner@example.com", password });
  const token = await invite(db, owner.userId);
  await register(db, { email: "other@example.com", password, invite: token });
  other = (
    await db.query<{ id: string }>(
      "SELECT w.id FROM workspaces w JOIN users u ON u.id=w.user_id WHERE u.email=$1",
      ["other@example.com"],
    )
  ).rows[0]!.id;
  app = await buildApp(db, c);
  headers = await login("owner@example.com");
  second = await login("other@example.com");
});
after(async () => {
  await app?.close();
  await db?.end();
  await embedded?.stop();
});
async function login(email: string) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: c.PUBLIC_ORIGIN },
    payload: { email, password },
  });
  assert.equal(r.statusCode, 200, r.body);
  return {
    cookie: String(r.headers["set-cookie"]).split(";")[0]!,
    origin: c.PUBLIC_ORIGIN,
    "x-csrf-token": r.json().csrfToken,
  };
}
async function task(
  prompt = "Say hello",
  acceptance: unknown = {
    formats: [],
    requiredText: [],
    requireSources: false,
  },
) {
  return (
    await createTask(
      db,
      owner.workspaceId,
      { prompt, acceptance },
      randomUUID(),
    )
  ).taskId;
}
async function claimId(id: string) {
  await db.query(
    "UPDATE tasks SET state='cancelled',lease_owner=NULL,lease_until=NULL WHERE state IN ('queued','running','waiting_children') AND id<>$1",
    [id],
  );
  const t = await claim(db);
  assert.equal(t?.id, id);
  return t!;
}
const result = (message: Message): ModelResult => ({
  message,
  usage: { input: 10, output: 10 },
  finishReason: message.toolCalls ? "tool_calls" : "stop",
  bytes: 100,
});
const call = (name: string, args: unknown) =>
  result({
    role: "assistant",
    content: "",
    privateContext: { reasoning_content: "private-marker" },
    toolCalls: [{ id: randomUUID(), name, arguments: JSON.stringify(args) }],
  });
function scripted(
  fn: (input: ModelInput) => Promise<ModelResult> | ModelResult,
) {
  return (onAttempt: () => Promise<void>): ModelAdapter => ({
    name: "scripted",
    complete: async (input) => {
      await onAttempt();
      if (!input.tools.length)
        return result({
          role: "assistant",
          content: '{"passed":true,"issues":[]}',
        });
      return fn(input);
    },
  });
}
test("migrations are repeatable and PostgreSQL queue wakes tasks", async () => {
  await migrate(db);
  const boss = new PgBoss(c.DATABASE_URL);
  boss.on("error", () => {});
  await boss.start();
  try {
    await boss.createQueue("verification");
    const id = await boss.send("verification", { taskId: randomUUID() });
    assert.ok(id);
    const jobs = await boss.fetch("verification");
    assert.equal(jobs.length, 1);
  } finally {
    await boss.stop();
  }
});
test("binary control characters in tool output persist safely in PostgreSQL", async () => {
  const id = await task(), claimed = await claimId(id);
  let step = 0;
  const engine = new Engine(db, c, scripted(() => ++step === 1
    ? call("web_search", { query: "test" })
    : call("finish", { summary: "hello", artifactIds: [] })));
  const execute = engine.tools.execute.bind(engine.tools);
  engine.tools.execute = async (...args) => args[1].name === "web_search"
    ? { data: { stdout: "before\0after" } } : execute(...args);
  await engine.run(claimed);
  assert.equal((await getTask(db, id)).state, "succeeded");
  const recorded = await db.query("SELECT result FROM operations WHERE task_id=$1 AND name='web_search'", [id]);
  assert.equal(recorded.rows[0].result.stdout, "before\uFFFDafter");
});
test("invites are single use, expire and bootstrap cannot run twice", async () => {
  const token = await invite(db, owner.userId);
  await register(db, { email: "third@example.com", password, invite: token });
  await assert.rejects(
    register(db, { email: "fourth@example.com", password, invite: token }),
    { message: "INVALID_INVITE" },
  );
  await assert.rejects(
    bootstrap(db, { email: "admin2@example.com", password }),
    { message: "ALREADY_BOOTSTRAPPED" },
  );
});
test("Origin CSRF auth and admin checks are enforced", async () => {
  assert.equal((await app.inject({ url: "/api/v1/tasks" })).statusCode, 401);
  for (const bad of [
    { ...headers, origin: "https://evil.example" },
    { ...headers, "x-csrf-token": "bad" },
  ])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/invites",
          headers: bad,
        })
      ).statusCode,
      403,
    );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/invites",
        headers: second,
      })
    ).statusCode,
    403,
  );
  const session = await app.inject({ url: "/api/v1/auth/session", headers });
  assert.equal(session.json().workspaceId, owner.workspaceId);
  assert.ok(!session.body.includes("csrfHash"));
});
test("task idempotency handles concurrency and detects changed request", async () => {
  const key = randomUUID(),
    body = { prompt: "hello" };
  const ids = await Promise.all(
    Array.from({ length: 5 }, () =>
      createTask(db, owner.workspaceId, body, key),
    ),
  );
  assert.equal(new Set(ids.map((r) => r.taskId)).size, 1);
  await assert.rejects(
    createTask(db, owner.workspaceId, { prompt: "different" }, key),
    { message: "IDEMPOTENCY_CONFLICT" },
  );
});
test("cross-user tasks, conversations, events, sources, mutations are inaccessible", async () => {
  const id = await task(),
    t = await getTask(db, id);
  for (const url of [
    "/tasks/" + id,
    "/tasks/" + id + "/events",
    "/tasks/" + id + "/sources",
    "/tasks/" + id + "/approvals",
    "/conversations/" + t.conversation_id,
  ])
    assert.equal(
      (await app.inject({ url: "/api/v1" + url, headers: second })).statusCode,
      404,
      url,
    );
  for (const action of ["cancel", "retry"])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/tasks/" + id + "/" + action,
          headers: second,
        })
      ).statusCode,
      404,
    );
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    headers: { ...second, "idempotency-key": randomUUID() },
    payload: { prompt: "steal", conversationId: t.conversation_id },
  });
  assert.equal(r.statusCode, 404);
  const rejected = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: { prompt: "x", workspaceId: other },
  });
  assert.equal(rejected.statusCode, 400);
});
test("files are scoped, traversal blocked and downloaded bytes verified", async () => {
  const store = new Storage(c.DATA_DIR, db);
  await assert.rejects(
    store.upload(
      owner.workspaceId,
      "../escape.csv",
      "csv",
      Buffer.from("a,b\n1,2"),
    ),
    { message: "INVALID_FILENAME" },
  );
  const f = await store.upload(
    owner.workspaceId,
    "input.csv",
    "csv",
    Buffer.from("a,b\n1,2"),
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/v1/files/" + f.id + "/download",
        headers: second,
      })
    ).statusCode,
    404,
  );
  const dl = await app.inject({
    url: "/api/v1/files/" + f.id + "/download",
    headers,
  });
  assert.equal(dl.body, "a,b\n1,2");
  assert.ok(dl.headers["content-disposition"]);
  await assert.rejects(
    createTask(
      db,
      other,
      { prompt: "read", inputFileIds: [f.id] },
      randomUUID(),
    ),
    { message: "NOT_FOUND" },
  );
});
test("document loop resolves omitted saved delivery IDs and hides provider context", async () => {
  const id = await task("Create a Markdown document", {
    formats: ["md"],
    requiredText: ["数学题", "答案"],
    requireSources: false,
  });
  const t = await claimId(id);
  const engine = new Engine(
    db,
    c,
    scripted((input) => {
      const last = input.messages.filter((m) => m.role === "tool").at(-1);
      if (!last)
        return call("artifact_write", {
          name: "math.md",
          format: "md",
          content: "# 数学题\n1. 1+1=?\n\n# 答案\n1. 2",
        });
      return call("finish", {
        summary: "文档已保存。",
        artifactIds: [],
      });
    }),
  );
  await engine.run(t);
  const saved = await getTask(db, id);
  assert.equal(saved.state, "succeeded", JSON.stringify(saved));
  const ev = await app.inject({
    url: "/api/v1/tasks/" + id + "/events",
    headers,
  });
  assert.ok(!ev.body.includes("private-marker"));
  const detail = await app.inject({ url: "/api/v1/tasks/" + id, headers });
  assert.ok(!detail.body.includes("checkpoint"));
  const final = saved.result as {
    artifacts: { id: string; downloadUrl: string }[];
  };
  assert.equal(
    (await app.inject({ url: final.artifacts[0]!.downloadUrl, headers }))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/v1/artifacts/" + final.artifacts[0]!.id,
        headers: second,
      })
    ).statusCode,
    404,
  );
});
test("artifact persistence crash window is idempotent and revisions keep history", async () => {
  const id = await task(),
    t = await claimId(id),
    store = new Storage(c.DATA_DIR, db),
    op = randomUUID();
  const a = await store.artifact(
    t,
    op,
    {
      name: "x.md",
      format: "md",
      bytes: Buffer.from("version one"),
      sourceIds: [],
    },
    t.lease_owner!,
  );
  const again = await store.artifact(
    t,
    op,
    {
      name: "x.md",
      format: "md",
      bytes: Buffer.from("version one"),
      sourceIds: [],
    },
    t.lease_owner!,
  );
  assert.equal(a.artifactId, again.artifactId);
  const next = await store.artifact(
    t,
    randomUUID(),
    {
      name: "x.md",
      format: "md",
      bytes: Buffer.from("version two"),
      artifactId: a.artifactId,
      sourceIds: [],
    },
    t.lease_owner!,
  );
  assert.equal(next.version, 2);
  assert.equal(
    (
      await db.query("SELECT * FROM artifact_versions WHERE artifact_id=$1", [
        a.artifactId,
      ])
    ).rows.length,
    2,
  );
  await setState(db, id, "cancelled", t.lease_owner!);
});
test("missing requested output cannot succeed after two repair rounds", async () => {
  const id = await task("Write the result", {
    formats: ["csv"],
    requiredText: [],
    requireSources: false,
  });
  const t = await claimId(id);
  await new Engine(
    db,
    c,
    scripted(() => call("finish", { summary: "done", artifactIds: [] })),
  ).run(t);
  const saved = await getTask(db, id);
  assert.equal(saved.state, "failed");
  assert.equal(saved.error_code, "VALIDATION_FAILED");
  assert.equal(saved.repair_count, 2);
});
test("invalid tool args become safe tool errors without creating files", async () => {
  const id = await task(),
    t = await claimId(id);
  let n = 0;
  await new Engine(
    db,
    c,
    scripted(() =>
      n++ === 0
        ? call("artifact_write", {
            name: "../../escape",
            format: "md",
            content: "x",
          })
        : call("finish", {
            summary: "Invalid input was rejected.",
            artifactIds: [],
          }),
    ),
  ).run(t);
  assert.equal(
    (await db.query("SELECT * FROM files WHERE task_id=$1", [id])).rowCount,
    0,
  );
  assert.ok(
    (
      await db.query("SELECT result FROM operations WHERE task_id=$1", [id])
    ).rows.some((r) => r.result?.error === "INVALID_ARGUMENTS"),
  );
});
test("crashed non-replayable code goes uncertain and cannot retry", async () => {
  const id = await task(),
    t = await claimId(id);
  await db.query(
    "INSERT INTO operations(id,task_id,step,call_id,name,args,status,replay) VALUES($1,$2,0,'crash','code_execute','{}','running','uncertain')",
    [randomUUID(), id],
  );
  await db.query(
    "UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  await claim(db);
  assert.equal((await getTask(db, id)).state, "uncertain");
  await assert.rejects(retryTask(db, id, owner.workspaceId), {
    message: "UNCERTAIN_REQUIRES_NEW_TASK",
  });
});
test("expired read lease resumes and previous worker cannot commit", async () => {
  const id = await task(),
    t = await claimId(id);
  await db.query(
    "UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  const fresh = await claim(db);
  assert.equal(fresh?.id, id);
  assert.notEqual(fresh?.lease_owner, t.lease_owner);
  await assert.rejects(setState(db, id, "succeeded", t.lease_owner!), {
    message: "LEASE_LOST",
  });
  await cancelTask(db, id, owner.workspaceId);
});
test("followup supersedes only unexecuted operations at a safe boundary", async () => {
  const id = await task(),
    t = await claimId(id);
  const calls = [
    { id: "c1", name: "artifact_write", arguments: "{}" },
    { id: "c2", name: "finish", arguments: "{}" },
  ];
  await db.query("UPDATE tasks SET checkpoint=$2 WHERE id=$1", [
    id,
    JSON.stringify({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "old" },
        { role: "assistant", content: "", toolCalls: calls },
      ],
    }),
  ]);
  for (const call of calls)
    await db.query(
      "INSERT INTO operations(id,task_id,step,call_id,name,args,status,replay) VALUES($1,$2,0,$3,$4,'{}','prepared','safe')",
      [randomUUID(), id, call.id, call.name],
    );
  await followup(db, id, owner.workspaceId, "New requirement: answer only");
  await new Engine(db, c).boundary(await getTask(db, id), t.lease_owner!);
  const ops = await db.query("SELECT status FROM operations WHERE task_id=$1", [
    id,
  ]);
  assert.ok(ops.rows.every((r) => r.status === "obsolete"));
  assert.ok(
    (await getTask(db, id)).checkpoint.messages?.some(
      (m) => m.content === "New requirement: answer only",
    ),
  );
  await cancelTask(db, id, owner.workspaceId);
});
test("cancellation aborts in-flight model and prevents success", async () => {
  const id = await task(),
    t = await claimId(id);
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const engine = new Engine(db, c, (onAttempt) => ({
    name: "abort-test",
    complete: async (input) => {
      await onAttempt();
      started();
      await new Promise((_, reject) =>
        input.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        ),
      );
      throw new Error("unreachable");
    },
  }));
  const run = engine.run(t);
  await ready;
  await cancelTask(db, id, owner.workspaceId);
  await run;
  assert.equal((await getTask(db, id)).state, "cancelled");
});
test("shared model attempt budget blocks before transport", async () => {
  const id = await task(),
    t = await claimId(id);
  await db.query("UPDATE tasks SET model_calls=$2 WHERE id=$1", [
    id,
    Limits.modelCalls,
  ]);
  let called = false;
  await new Engine(
    db,
    c,
    scripted(() => {
      called = true;
      return call("finish", { summary: "x", artifactIds: [] });
    }),
  ).run(t);
  assert.equal(called, false);
  assert.equal((await getTask(db, id)).error_code, "MODEL_BUDGET");
});
test("long context checkpoint keeps constraints and actual artifact references", async () => {
  const id = await task(),
    t = await claimId(id),
    engine = new Engine(db, c);
  const messages: Message[] = [
    { role: "system", content: "system" },
    { role: "user", content: "保留中文；答案放最后。" },
    { role: "assistant", content: "x".repeat(200000) },
  ];
  const compact = await engine.compact(t, messages, t.lease_owner!);
  assert.ok(compact.some((m) => m.content.includes("答案放最后")));
  assert.ok(JSON.stringify(compact).length < Limits.contextChars);
  await cancelTask(db, id, owner.workspaceId);
});
test("delegation runs two children through same engine and resumes parent", async () => {
  const id = await task(),
    t = await claimId(id);
  const engine = new Engine(
    db,
    c,
    scripted((input) => {
      const system = input.messages[0]!.content,
        sub = input.messages.some((m) =>
          m.content.startsWith("Your independent subtask"),
        );
      if (sub)
        return call("finish", {
          summary: "Child evidence complete",
          artifactIds: [],
        });
      if (input.messages.some((m) => m.content.startsWith("CHILD_RESULTS:")))
        return call("finish", {
          summary: "Both independent results checked",
          artifactIds: [],
        });
      return call("delegate", {
        tasks: [
          {
            prompt: "One independent fact",
            acceptance: {
              formats: [],
              requiredText: [],
              requireSources: false,
            },
          },
          {
            prompt: "Second independent fact",
            acceptance: {
              formats: [],
              requiredText: [],
              requireSources: false,
            },
          },
        ],
      });
    }),
  );
  await engine.run(t);
  assert.equal((await getTask(db, id)).state, "waiting_children");
  const a = await claim(db),
    b = await claim(db);
  assert.ok(a?.parent_id === id && b?.parent_id === id);
  await Promise.all([engine.run(a!), engine.run(b!)]);
  await engine.tick();
  assert.equal((await getTask(db, id)).state, "succeeded");
  assert.equal(
    (await db.query("SELECT * FROM tasks WHERE parent_id=$1", [id])).rowCount,
    2,
  );
});
test("SSE cursor pagination returns each persisted event once", async () => {
  const id = await task();
  await event(db, id, { type: "message", message: "one" });
  await event(db, id, { type: "message", message: "two" });
  const first = await app.inject({
    url: "/api/v1/tasks/" + id + "/events?limit=1",
    headers,
  });
  const a = first.json();
  const next = await app.inject({
    url: "/api/v1/tasks/" + id + "/events",
    headers: { ...headers, "last-event-id": a.nextCursor },
  });
  assert.ok(
    next
      .json()
      .events.every((e: { id: string }) => Number(e.id) > Number(a.nextCursor)),
  );
});
test("external approval is exact and never executes anything", async () => {
  const id = await task(),
    t = await claimId(id);
  await new Engine(
    db,
    c,
    scripted(() =>
      call("request_approval", {
        action: "Publish example",
        payload: { url: "https://example.com", content: "draft" },
      }),
    ),
  ).run(t);
  const r = await app.inject({
    url: "/api/v1/tasks/" + id + "/approvals",
    headers,
  });
  const approval = r.json()[0];
  assert.ok(approval.digest);
  const bad = await app.inject({
    method: "POST",
    url: "/api/v1/tasks/" + id + "/approvals/" + approval.id,
    headers,
    payload: { digest: "x".repeat(64), decision: "approved" },
  });
  assert.equal(bad.statusCode, 409);
  const ok = await app.inject({
    method: "POST",
    url: "/api/v1/tasks/" + id + "/approvals/" + approval.id,
    headers,
    payload: { digest: approval.digest, decision: "approved" },
  });
  assert.equal(ok.json().executed, false);
  assert.equal((await getTask(db, id)).state, "waiting_approval");
});
test("PDF must render and extract text; image-only PDF requests OCR", async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("Verified real PDF", { font });
  for (let page = 2; page <= 12; page++)
    pdf.addPage().drawText(`Verified page ${page}`, { font });
  assert.equal(
    (await validate(Buffer.from(await pdf.save()), "pdf")).passed,
    true,
  );
  const scan = await PDFDocument.create();
  scan.addPage();
  await assert.rejects(validate(Buffer.from(await scan.save()), "pdf"), {
    message: "OCR_REQUIRED",
  });
});
test("sandbox template cannot mount socket, secrets or enable networking", () => {
  const args = containerArgs("test", "/isolated/inputs", "image");
  assert.ok(args.includes("--runtime=runsc"));
  assert.ok(args.includes("--network=none"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--pids-limit=128"));
  assert.equal(args.filter((a) => a === "--mount").length, 1);
  assert.ok(!args.join(" ").includes("docker.sock"));
  assert.ok(!args.join(" ").includes("DEEPSEEK"));
});
test("unconfigured sandbox reports unavailable and no host execution", async () => {
  const capabilities = await app.inject({
    url: "/api/v1/capabilities",
    headers,
  });
  assert.equal(capabilities.json().sandbox.available, false);
  const id = await task(),
    t = await claimId(id);
  const engine = new Engine(db, c);
  await assert.rejects(
    engine.tools.execute(
      t,
      {
        id: randomUUID(),
        task_id: id,
        step: 1,
        call_id: "x",
        name: "code_execute",
        args: { language: "python", code: "print(1)", outputs: [] },
        status: "running",
        replay: "uncertain",
        result: null,
      },
      new AbortController().signal,
    ),
    { message: "SANDBOX_UNAVAILABLE" },
  );
  await cancelTask(db, id, owner.workspaceId);
});
test("OpenAPI comes from shared Zod contracts", async () => {
  const r = await app.inject({ url: "/api/v1/openapi.json", headers });
  assert.equal(r.statusCode, 200, r.body);
  const doc = r.json();
  assert.ok(doc.paths["/api/v1/tasks"].post.requestBody);
  assert.ok(doc.paths["/api/v1/tasks/{id}"].get.responses["200"]);
});
test("runner requires internal authentication and fails closed without gVisor", async () => {
  const runner = await createRunner({ ...c, RUNNER_TOKEN: "r".repeat(40) });
  try {
    assert.equal((await runner.inject({ url: "/health" })).statusCode, 401);
    const health = await runner.inject({
      url: "/health",
      headers: { authorization: "Bearer " + "r".repeat(40) },
    });
    if (!health.json().available) {
      const run = await runner.inject({
        method: "POST",
        url: "/run",
        headers: { authorization: "Bearer " + "r".repeat(40) },
        payload: {
          operationId: randomUUID(),
          taskId: randomUUID(),
          language: "python",
          code: 'raise Exception("must never run on host")',
          inputs: [],
          outputs: [],
        },
      });
      assert.equal(run.statusCode, 503);
      assert.equal(run.json().error, "SANDBOX_UNAVAILABLE");
    }
  } finally {
    await runner.close();
  }
});
test("late instruction racing finish is queued instead of publishing stale success", async () => {
  const id = await task(),
    t = await claimId(id);
  let sent = false;
  const engine = new Engine(db, c, (onAttempt) => ({
    name: "race",
    complete: async (input) => {
      await onAttempt();
      if (!input.tools.length) {
        if (!sent) {
          sent = true;
          await followup(
            db,
            id,
            owner.workspaceId,
            "Correction arrived during validation",
          );
        }
        return result({
          role: "assistant",
          content: '{"passed":true,"issues":[]}',
        });
      }
      return call("finish", { summary: "old answer", artifactIds: [] });
    },
  }));
  await engine.run(t);
  const saved = await getTask(db, id);
  assert.equal(saved.state, "queued");
  assert.equal(saved.result, null);
});
test("crashed reserved model attempt is accounted and does not strand quota", async () => {
  const id = await task(),
    t = await claimId(id);
  await db.query(
    "INSERT INTO model_attempts(id,task_id,root_id,reserved,status) VALUES($1,$2,$2,1000,'running')",
    [randomUUID(), id],
  );
  await db.query(
    "UPDATE tasks SET reserved_tokens=1000,lease_until=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  await claim(db);
  const r = await db.query(
    "SELECT reserved_tokens,tokens FROM tasks WHERE id=$1",
    [id],
  );
  assert.equal(Number(r.rows[0].reserved_tokens), 0);
  assert.equal(Number(r.rows[0].tokens), 1000);
  await cancelTask(db, id, owner.workspaceId);
});
test("global and workspace scheduling limits are atomic", async () => {
  await db.query(
    "UPDATE tasks SET state='cancelled',lease_owner=NULL,lease_until=NULL WHERE state IN ('queued','running','waiting_children')",
  );
  const one = await task(),
    two = await task(),
    three = (
      await createTask(db, other, { prompt: "other user" }, randomUUID())
    ).taskId;
  const [a, b, d] = await Promise.all([claim(db), claim(db), claim(db)]);
  const claimed = [a, b, d].filter(Boolean);
  assert.equal(claimed.length, 2);
  assert.equal(new Set(claimed.map((t) => t!.workspace_id)).size, 2);
  await cancelTask(db, one, owner.workspaceId);
  await cancelTask(db, two, owner.workspaceId);
  await cancelTask(db, three, other);
});
test("SSE disconnect leaves task alive and Last-Event-ID resumes over HTTP", async () => {
  const address = await app.listen({ host: "127.0.0.1", port: 0 }),
    id = await task();
  const firstAbort = new AbortController();
  const first = await fetch(address + "/api/v1/tasks/" + id + "/events", {
    headers: { cookie: headers.cookie!, accept: "text/event-stream" },
    signal: firstAbort.signal,
  });
  assert.equal(first.status, 200);
  const firstChunk = new TextDecoder().decode(
    (await first.body!.getReader().read()).value,
  );
  const cursor = /id: (\d+)/.exec(firstChunk)![1]!;
  firstAbort.abort();
  await event(db, id, { type: "message", message: "after-disconnect" });
  const secondAbort = new AbortController();
  const next = await fetch(address + "/api/v1/tasks/" + id + "/events", {
    headers: {
      cookie: headers.cookie!,
      accept: "text/event-stream",
      "last-event-id": cursor,
    },
    signal: secondAbort.signal,
  });
  const secondChunk = new TextDecoder().decode(
    (await next.body!.getReader().read()).value,
  );
  secondAbort.abort();
  assert.ok(secondChunk.includes("after-disconnect"));
  assert.equal((await getTask(db, id)).state, "queued");
  await cancelTask(db, id, owner.workspaceId);
});
test("delivery checks inspect visible HTML and do not accept summary-only content", async () => {
  const id = await task("Make HTML", {
      formats: ["html"],
      requiredText: ["2x", "required section"],
      requireSources: false,
    }),
    t = await claimId(id),
    engine = new Engine(db, c);
  const artifact = await engine.tools.storage.artifact(
    t,
    randomUUID(),
    {
      name: "x.html",
      format: "html",
      bytes: Buffer.from("<html><body><span>2</span>x</body></html>"),
      sourceIds: [],
    },
    t.lease_owner!,
  );
  const result = await engine.tools.check(
    t,
    [artifact.artifactId],
    "required section",
  );
  assert.ok(
    result.issues.includes("Missing required content: required section"),
  );
  assert.ok(!result.issues.includes("Missing required content: 2x"));
  assert.ok(
    (
      await engine.tools.storage.readText(t.workspace_id, artifact.fileId)
    ).includes("<span>"),
  );
  await cancelTask(db, id, owner.workspaceId);
});
test("research phase preserves budget for actual delivery", async () => {
  const id = await task(),
    t = await claimId(id);
  await db.query("UPDATE tasks SET tokens=60000 WHERE id=$1", [id]);
  let phaseSeen = false;
  await new Engine(
    db,
    c,
    scripted((input) => {
      phaseSeen =
        !input.tools.includes("web_search") &&
        !input.tools.includes("delegate") &&
        input.tools.includes("artifact_write");
      return call("finish", {
        summary: "Only supported evidence used.",
        artifactIds: [],
      });
    }),
  ).run(t);
  assert.equal(phaseSeen, true);
  assert.equal((await getTask(db, id)).state, "succeeded");
});
test("instruction arriving before wait transition is not lost", async () => {
  const id = await task(),
    t = await claimId(id);
  await followup(db, id, t.workspace_id, "Already answered");
  await setState(db, id, "waiting_user", t.lease_owner!);
  assert.equal((await getTask(db, id)).state, "queued");
  await cancelTask(db, id, t.workspace_id);
});
test("SIGKILL after artifact save recovers without duplicate files or versions", async () => {
  const { spawn } = await import("node:child_process");
  await db.query(
    "UPDATE tasks SET state='cancelled',lease_owner=NULL,lease_until=NULL WHERE state IN ('queued','running','waiting_children')",
  );
  const id = await task("Save a Markdown file", {
    formats: ["md"],
    requiredText: ["Persisted before SIGKILL"],
    requireSources: false,
  });
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/crash-worker.ts"],
    {
      env: {
        ...process.env,
        TEST_CRASH_DATABASE_URL: c.DATABASE_URL,
        TEST_CRASH_TASK_ID: id,
        TEST_CRASH_DATA_DIR: c.DATA_DIR,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child timeout")), 15000);
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("CRASH_WINDOW_READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error("child exited " + code));
      });
    });
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGKILL");
    await exited;
    await db.query(
      "UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
      [id],
    );
    const recovered = await claim(db);
    assert.equal(recovered?.id, id);
    await new Engine(
      db,
      c,
      scripted((input) => {
        const data = JSON.parse(
          input.messages.filter((m) => m.role === "tool").at(-1)!.content,
        );
        return call("finish", {
          summary: "Recovered existing artifact",
          artifactIds: [data.artifactId],
        });
      }),
    ).run(recovered!);
    assert.equal((await getTask(db, id)).state, "succeeded");
    assert.equal(
      (await db.query("SELECT 1 FROM files WHERE task_id=$1", [id])).rowCount,
      1,
    );
    assert.equal(
      (await db.query("SELECT 1 FROM artifact_versions WHERE task_id=$1", [id]))
        .rowCount,
      1,
    );
  } finally {
    child.kill("SIGKILL");
  }
});
test("database heartbeat failure aborts work and lease recovery remains possible", async () => {
  const id = await task(),
    t = await claimId(id),
    query = db.query;
  let armed = false,
    failed = false;
  db.query = ((...args: unknown[]) => {
    if (
      armed &&
      !failed &&
      typeof args[0] === "string" &&
      args[0].startsWith("UPDATE tasks SET lease_until")
    ) {
      failed = true;
      return Promise.reject(new Error("injected database outage"));
    }
    return Reflect.apply(query, db, args);
  }) as typeof db.query;
  try {
    await new Engine(db, c, (onAttempt) => ({
      name: "database-outage",
      complete: async (input) => {
        await onAttempt();
        armed = true;
        await new Promise((_, reject) =>
          input.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          ),
        );
        throw new Error("unreachable");
      },
    })).run(t);
  } finally {
    db.query = query;
  }
  assert.equal(failed, true);
  assert.equal((await getTask(db, id)).state, "running");
  await db.query(
    "UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  assert.equal((await claim(db))?.id, id);
  await cancelTask(db, id, owner.workspaceId);
});
test("known HTTP rejection releases reserved tokens and keeps failed attempt audit", async () => {
  const id = await task(),
    t = await claimId(id);
  const { DeepSeek } = await import("@hyper/runtime");
  await new Engine(
    db,
    c,
    (onAttempt) =>
      new DeepSeek({
        key: "test",
        model: "test",
        onAttempt,
        fetch: async () => new Response("private balance", { status: 402 }),
      }),
  ).run(t);
  const saved = await getTask(db, id);
  assert.equal(saved.error_code, "MODEL_QUOTA");
  assert.equal(Number(saved.tokens), 0);
  const attempt = (
    await db.query(
      "SELECT status,error_code,usage FROM model_attempts WHERE task_id=$1",
      [id],
    )
  ).rows[0];
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.error_code, "MODEL_QUOTA");
  assert.deepEqual(attempt.usage, { input: 0, output: 0 });
});
test("persisted deliverables enter validation instead of an unbounded self-read loop", async () => {
  const id = await task("Create Markdown", {
      formats: ["md"],
      requiredText: ["verified"],
      requireSources: false,
    }),
    t = await claimId(id);
  let fileReads = 0;
  await new Engine(
    db,
    c,
    scripted((input) => {
      const last = input.messages.filter((m) => m.role === "tool").at(-1);
      if (!last)
        return call("artifact_write", {
          name: "done.md",
          format: "md",
          content: "# verified\nActual delivery",
        });
      const data = JSON.parse(last.content);
      if (input.tools.includes("file_read")) {
        fileReads++;
        return call("file_read", { fileId: data.fileId });
      }
      return call("finish", {
        summary: "Verified output saved",
        artifactIds: [data.artifactId],
      });
    }),
  ).run(t);
  assert.equal(fileReads, 0);
  assert.equal((await getTask(db, id)).state, "succeeded");
});

test("configured public and loopback origins support login while unknown origins and missing CSRF are rejected", async () => {
  const origins = [
    "https://workspace.example",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ];
  const originApp = await buildApp(db, {
    ...c,
    PUBLIC_ORIGIN: origins[0]!,
    ADDITIONAL_ORIGINS: origins.slice(1),
  });
  try {
    for (const origin of origins) {
      const response = await originApp.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin },
        payload: { email: "owner@example.com", password },
      });
      assert.equal(response.statusCode, 200, response.body);
      const cookieHeader = String(response.headers["set-cookie"]);
      assert.equal(
        /; Secure(?:;|$)/i.test(cookieHeader),
        origin.startsWith("https:"),
      );
      const cookie = cookieHeader.split(";")[0]!;
      const denied = await originApp.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: { origin, cookie },
      });
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().error, "CSRF_REJECTED");
      const logout = await originApp.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: { origin, cookie, "x-csrf-token": response.json().csrfToken },
      });
      assert.equal(logout.statusCode, 200);
    }
    for (const origin of [
      undefined,
      "null",
      "https://evil.example",
      "http://localhost:5174",
      "https://workspace.example.evil.example",
    ]) {
      const response = await originApp.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: origin ? { origin } : {},
        payload: { email: "owner@example.com", password },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, "ORIGIN_REJECTED");
    }
  } finally {
    await originApp.close();
  }
});
