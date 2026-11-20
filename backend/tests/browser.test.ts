import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { buildApp } from "@hyper/api";
import {
  config,
  pool,
  migrate,
  bootstrap,
  createTask,
  claim,
  getTask,
  cancelTask,
  controlTask,
  settlePauses,
  taskOverview,
  prepareBrowser,
  consumeBrowserInputs,
  enqueueBrowserResult,
  transitionBrowser,
  issueBrowserTicket,
  validateBrowserTicket,
  browserAccess,
  BrowserClient,
  hash,
  type Db,
  type Config,
  type Identity,
  type Operation,
} from "@hyper/runtime";
let db: Db,
  cfg: Config,
  pg: EmbeddedPostgres,
  app: Awaited<ReturnType<typeof buildApp>>,
  u: Identity,
  headers: Record<string, string>,
  cookie: string;
class Service extends BrowserClient {
  override async request() {
    return {
      tabs: [{ tabId: "fresh", url: "https://example.org/", active: true }],
      elements: [{ ref: "fresh:0" }],
    };
  }
}
let service: Service;
before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-test-"));
  pg = new EmbeddedPostgres({
    databaseDir: join(dir, "pg"),
    user: "hyper",
    password: "hyper",
    port: 55440,
    persistent: false,
    autoRehydrateSymlinks: true,
    onLog: () => {},
    onError: () => {},
    postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("browser_test");
  cfg = config({
    DATABASE_URL: "postgres://hyper:hyper@127.0.0.1:55440/browser_test",
    DATA_DIR: join(dir, "data"),
    BROWSER_PROFILE_DIR: join(dir, "profiles"),
    NODE_ENV: "test",
    BROWSER_ENABLED: "true",
    BROWSER_TOKEN: "x".repeat(40),
  });
  db = pool(cfg.DATABASE_URL);
  await migrate(db);
  const owner = await bootstrap(db, {
    email: "browser@example.org",
    password: "browser-password-12345",
  });
  u = {
    ...owner,
    admin: true,
    role: "admin",
    email: "browser@example.org",
    csrfHash: "",
  };
  app = await buildApp(db, cfg);
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: cfg.PUBLIC_ORIGIN },
    payload: { email: u.email, password: "browser-password-12345" },
  });
  assert.equal(r.statusCode, 200, r.body);
  headers = {
    origin: cfg.PUBLIC_ORIGIN,
    cookie: String(r.headers["set-cookie"]).split(";")[0]!,
    "x-csrf-token": r.json().csrfToken,
  };
  cookie = headers.cookie!.split("=")[1]!;
  service = new Service(cfg);
});
after(async () => {
  await app?.close();
  await db?.end();
  await pg?.stop();
});
beforeEach(async () => {
  await db.query(
    "UPDATE tasks SET state='cancelled',lease_owner=NULL,lease_until=NULL",
  );
  await db.query("UPDATE browser_sessions SET state='closed',control='paused'");
  await db.query("UPDATE task_inputs SET consumed_at=now()");
});
async function profile() {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/browser/profiles",
    headers,
    payload: { name: "Identity" },
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().id as string;
}
async function pending(
  profileId?: string,
  runtime: "typescript" | "rust" = "typescript",
) {
  const pid = profileId || (await profile()),
    { taskId } = await createTask(
      db,
      u.workspaceId,
      { prompt: "Use browser", browserProfileId: pid },
      randomUUID(),
      u.userId,
      runtime,
    );
  if (runtime === "rust")
    await db.query("UPDATE tasks SET runtime_phase='tools' WHERE id=$1", [
      taskId,
    ]);
  assert.equal((await claim(db))?.id, taskId);
  const id = randomUUID(),
    callId = randomUUID();
  const messages = [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: callId, name: "browser", arguments: '{"action":"observe"}' },
      ],
    },
  ];
  await db.query("UPDATE tasks SET checkpoint=$2 WHERE id=$1", [
    taskId,
    JSON.stringify({ messages }),
  ]);
  const op = (
    await db.query<Operation>(
      "INSERT INTO operations(id,task_id,step,call_id,name,args,status,replay) VALUES($1,$2,1,$3,'browser','{\"action\":\"observe\"}','running','safe') RETURNING *",
      [id, taskId, callId],
    )
  ).rows[0]!;
  await prepareBrowser(db, await getTask(db, taskId), op);
  const s = (
    await db.query(
      "SELECT * FROM browser_sessions WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1",
      [taskId],
    )
  ).rows[0];
  if (s)
    await db.query("UPDATE browser_sessions SET state='open' WHERE id=$1", [
      s.id,
    ]);
  return { taskId, pid, op, s };
}
async function complete(
  id: string,
  task: string,
  result: unknown = { ok: true },
  uncertain = false,
) {
  await db.query("UPDATE browser_outbox SET status=$2 WHERE operation_id=$1", [
    id,
    uncertain ? "uncertain" : "completed",
  ]);
  await enqueueBrowserResult(db, id, task, result, uncertain);
  await consumeBrowserInputs(db);
}
test("profiles enforce ownership and service failure disables Browser", async () => {
  const { BrowserAction } = await import("@hyper/contracts");
  assert.equal(BrowserAction.safeParse({ action: "navigate" }).success, false);
  assert.equal(
    BrowserAction.safeParse({ action: "navigate", url: "file:///etc/passwd" })
      .success,
    false,
  );
  assert.equal(
    BrowserAction.safeParse({ action: "fill", ref: "r" }).success,
    false,
  );
  const id = await profile();
  await assert.rejects(
    browserAccess(db, id, u.workspaceId, randomUUID()),
    /BROWSER_PROFILE_FORBIDDEN/,
  );
  await assert.rejects(
    createTask(
      db,
      u.workspaceId,
      { prompt: "x", browserProfileId: id },
      randomUUID(),
    ),
    /BROWSER_PROFILE_FORBIDDEN/,
  );
  const cap = (
    await app.inject({ url: "/api/v1/capabilities", headers })
  ).json();
  assert.equal(cap.browser.available, false);
  assert.deepEqual(cap.browser.operations, []);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/browser/sessions",
        headers,
        payload: { profileId: id },
      })
    ).statusCode,
    503,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/browser/profiles",
        headers: { cookie: headers.cookie!, origin: cfg.PUBLIC_ORIGIN },
        payload: { name: "forbidden" },
      })
    ).statusCode,
    403,
  );
});
test("durable dispatch releases worker; duplicate results advance once", async () => {
  const { taskId, op } = await pending();
  let t = await getTask(db, taskId);
  assert.equal(t.state, "waiting_tool");
  assert.equal(t.lease_owner, null);
  assert.equal(t.tool_calls, 1);
  assert.equal(
    (await db.query("SELECT status FROM operations WHERE id=$1", [op.id]))
      .rows[0].status,
    "dispatched",
  );
  const next = await createTask(
    db,
    u.workspaceId,
    { prompt: "Other work" },
    randomUUID(),
  );
  assert.equal((await claim(db))?.id, next.taskId);
  await complete(op.id, taskId);
  await enqueueBrowserResult(db, op.id, taskId, { duplicate: true });
  await consumeBrowserInputs(db);
  t = await getTask(db, taskId);
  assert.equal(t.state, "queued");
  assert.equal(
    t.checkpoint.messages!.filter((m) => m.role === "tool").length,
    1,
  );
  assert.equal(t.checkpoint.messages!.at(-1)!.content, '{"ok":true}');
});
test("exclusive profiles and two-browser capacity wait without worker or tool charges", async () => {
  const one = await pending(),
    two = await pending(),
    blocked = await pending(one.pid),
    capacity = await pending();
  for (const id of [blocked.taskId, capacity.taskId]) {
    const t = await getTask(db, id);
    assert.equal(t.state, "waiting_browser");
    assert.equal(t.wait_reason, "profile_or_capacity");
    assert.equal(t.lease_owner, null);
    assert.equal(t.tool_calls, 0);
  }
  assert.equal(
    (
      await db.query(
        "SELECT count(*) AS n FROM browser_sessions WHERE state='open'",
      )
    ).rows[0].n,
    "2",
  );
  await db.query("UPDATE browser_sessions SET state='closed' WHERE id=$1", [
    two.s.id,
  ]);
  await consumeBrowserInputs(db);
  assert.equal((await getTask(db, capacity.taskId)).state, "queued");
});
test("takeover races have one winner; handback retires stale intentions exactly once", async () => {
  const { taskId, op, s } = await pending();
  const race = await Promise.allSettled([
    transitionBrowser(db, service, u, s.id, "takeover", 0, "a"),
    transitionBrowser(db, service, u, s.id, "takeover", 0, "b"),
  ]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  const key = race[0].status === "fulfilled" ? "a" : "b",
    held = await transitionBrowser(db, service, u, s.id, "takeover", 0, key);
  assert.equal(held.control, "human");
  assert.equal(held.control_epoch, 1);
  await complete(op.id, taskId);
  assert.equal((await getTask(db, taskId)).state, "waiting_browser");
  await assert.rejects(
    transitionBrowser(
      db,
      service,
      { ...u, userId: randomUUID() },
      s.id,
      "handback",
      1,
      "bad",
    ),
  );
  const stale = randomUUID();
  await db.query(
    "INSERT INTO operations(id,task_id,step,call_id,name,args,status,replay,ordinal) VALUES($1,$2,1,'stale','browser','{\"action\":\"click\",\"ref\":\"old\"}','prepared','safe',1)",
    [stale, taskId],
  );
  const back = await transitionBrowser(
    db,
    service,
    u,
    s.id,
    "handback",
    1,
    "back",
    "Logged in",
  );
  assert.equal(back.control, "agent");
  assert.equal(back.control_epoch, 2);
  await transitionBrowser(
    db,
    service,
    u,
    s.id,
    "handback",
    1,
    "back",
    "Logged in",
  );
  await consumeBrowserInputs(db);
  await consumeBrowserInputs(db);
  const t = await getTask(db, taskId);
  assert.equal(t.state, "queued");
  assert.equal(
    t.checkpoint.messages!.filter((m) =>
      m.content.startsWith("Browser handed back"),
    ).length,
    1,
  );
  assert.equal(
    (await db.query("SELECT status FROM operations WHERE id=$1", [stale]))
      .rows[0].status,
    "obsolete",
  );
  await assert.rejects(
    transitionBrowser(db, service, u, s.id, "handback", 1, "back", "changed"),
    /IDEMPOTENCY_CONFLICT/,
  );
});
test("tickets bind user, app session, permission, epoch and one redemption; logout revokes", async () => {
  const { s } = await pending();
  await assert.rejects(
    issueBrowserTicket(db, u, cookie, s.id, "write"),
    /NOT_CONTROLLER/,
  );
  const ro = await issueBrowserTicket(db, u, cookie, s.id, "observe");
  assert.equal(
    (await validateBrowserTicket(db, hash(ro.ticket), true)).permission,
    "observe",
  );
  await assert.rejects(
    validateBrowserTicket(db, hash(ro.ticket), true),
    /EXPIRED_TICKET/,
  );
  await transitionBrowser(db, service, u, s.id, "takeover", 0, "take");
  await assert.rejects(
    validateBrowserTicket(db, hash(ro.ticket)),
    /INVALID_TICKET/,
  );
  const rw = await issueBrowserTicket(db, u, cookie, s.id, "write");
  await validateBrowserTicket(db, hash(rw.ticket), true);
  await db.query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [hash(cookie)],
  );
  await assert.rejects(
    validateBrowserTicket(db, hash(rw.ticket)),
    /INVALID_TICKET/,
  );
  await db.query(
    "UPDATE sessions SET expires_at=now()+interval '1 day' WHERE token_hash=$1",
    [hash(cookie)],
  );
});
test("uncertain side effects cannot be revived by late connection or handback events", async () => {
  const { taskId, op } = await pending();
  await complete(op.id, taskId, { error: "BROWSER_PROCESS_LOST" }, true);
  assert.equal((await getTask(db, taskId)).state, "uncertain");
  await db.query(
    "INSERT INTO task_inputs(id,task_id,kind,payload) VALUES($1,$2,'connection_error','{}'),($3,$2,'handback','{}')",
    [randomUUID(), taskId, randomUUID()],
  );
  await consumeBrowserInputs(db);
  assert.equal((await getTask(db, taskId)).state, "uncertain");
});
test("cancel revokes generation and late results never revive task", async () => {
  const { taskId, op, s } = await pending();
  await cancelTask(db, taskId, u.workspaceId);
  await complete(op.id, taskId);
  const t = await getTask(db, taskId);
  assert.equal(t.state, "cancelled");
  assert.equal(t.checkpoint.messages!.length, 1);
  const fresh = (
    await db.query("SELECT * FROM browser_sessions WHERE id=$1", [s.id])
  ).rows[0];
  assert.equal(fresh.control, "paused");
  assert.equal(fresh.control_epoch, 1);
});
test("human waiting beyond 20 wall-clock minutes retains cumulative execution budget", async () => {
  const { taskId, op } = await pending();
  await db.query(
    "UPDATE tasks SET deadline=now()-interval '2 hours',active_ms=500 WHERE id=$1",
    [taskId],
  );
  await complete(op.id, taskId);
  const next = await claim(db);
  assert.equal(next?.id, taskId);
  assert.equal(next?.state, "running");
  assert.ok(next!.deadline!.getTime() > Date.now() + 1100000);
  assert.equal(Number(next?.active_ms), 500);
  await db.query("UPDATE tasks SET state='waiting_browser' WHERE id=$1", [
    taskId,
  ]);
  await db.query(
    "UPDATE tasks SET state='queued',active_ms=1200001 WHERE id=$1",
    [taskId],
  );
  await claim(db);
  assert.equal((await getTask(db, taskId)).state, "failed");
});
test("team profiles require explicit grant AND current membership; personal profiles cannot be used in team", async () => {
  const team = randomUUID(),
    member = randomUUID(),
    id = randomUUID();
  await db.query(
    "INSERT INTO users(id,email,password_hash) VALUES($1,$2,'unused')",
    [member, member + "@example.org"],
  );
  await db.query(
    "INSERT INTO workspaces(id,user_id,kind,name) VALUES($1,$2,'team','Team')",
    [team, u.userId],
  );
  await db.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
    [team, member],
  );
  await db.query(
    "INSERT INTO browser_profiles(id,workspace_id,owner_id,name) VALUES($1,$2,$3,'Team identity')",
    [id, team, u.userId],
  );
  await assert.rejects(browserAccess(db, id, team, member));
  await db.query(
    "INSERT INTO browser_grants(profile_id,user_id) VALUES($1,$2)",
    [id, member],
  );
  await browserAccess(db, id, team, member);
  await assert.rejects(browserAccess(db, await profile(), team, member));
  await db.query(
    "DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
    [team, member],
  );
  await assert.rejects(browserAccess(db, id, team, member));
});
test("failed quiesce keeps transfer fenced and the same key can complete it", async () => {
  const { s } = await pending(),
    broken = new Service(cfg);
  broken.request = async () => {
    throw Error("disconnected");
  };
  await assert.rejects(
    transitionBrowser(db, broken, u, s.id, "takeover", 0, "retry"),
  );
  assert.equal(
    (await db.query("SELECT control FROM browser_sessions WHERE id=$1", [s.id]))
      .rows[0].control,
    "transferring",
  );
  await assert.rejects(issueBrowserTicket(db, u, cookie, s.id, "write"));
  const r = await transitionBrowser(
    db,
    service,
    u,
    s.id,
    "takeover",
    0,
    "retry",
  );
  assert.equal(r.control, "human");
  assert.equal(r.control_epoch, 1);
});
test("service restart marks dispatched side effects uncertain instead of replaying", async () => {
  const { taskId, op } = await pending();
  await db.query(
    "UPDATE browser_outbox SET status='running' WHERE operation_id=$1",
    [op.id],
  );
  const { createBrowserService } =
    await import("../browser-service/service.mjs");
  const browser = await createBrowserService(db, cfg, { test: true });
  try {
    await consumeBrowserInputs(db);
    assert.equal((await getTask(db, taskId)).state, "uncertain");
    assert.equal(
      (
        await db.query(
          "SELECT status FROM browser_outbox WHERE operation_id=$1",
          [op.id],
        )
      ).rows[0].status,
      "uncertain",
    );
  } finally {
    await browser.close();
  }
});
test("egress rejects metadata, private, mapped and mixed DNS answers and pins public address", async () => {
  const { publicAddress, createEgressProxy } =
    await import("../browser-service/egress.mjs");
  for (const h of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "0.0.0.0",
  ])
    await assert.rejects(publicAddress(h));
  await assert.rejects(
    publicAddress("rebind.example", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
  );
  assert.equal(
    (
      await publicAddress("public.example", async () => [
        { address: "93.184.216.34", family: 4 },
      ])
    ).address,
    "93.184.216.34",
  );
  const proxy = createEgressProxy();
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  try {
    const { request } = await import("node:http"),
      port = (proxy.address() as { port: number }).port;
    const status = await new Promise((r) => {
      request(
        {
          host: "127.0.0.1",
          port,
          path: "http://169.254.169.254/latest/meta-data/",
        },
        (res) => {
          res.resume();
          r(res.statusCode);
        },
      ).end();
    });
    assert.equal(status, 403);
  } finally {
    await new Promise<void>((r) => proxy.close(() => r()));
  }
});
test("the model executor yields at browser dispatch and continues from a persisted result", async () => {
  const { Engine } = await import("@hyper/runtime"),
    { createServer } = await import("node:http");
  const http = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  try {
    const pid = await profile(),
      { taskId } = await createTask(
        db,
        u.workspaceId,
        { prompt: "Observe the browser", browserProfileId: pid },
        randomUUID(),
        u.userId,
      );
    let calls = 0;
    const engine = new Engine(
      db,
      {
        ...cfg,
        BROWSER_URL: `http://127.0.0.1:${(http.address() as { port: number }).port}`,
      },
      (onAttempt) => ({
        name: "scripted",
        complete: async (input) => {
          await onAttempt();
          if (!input.tools.length)
            return {
              message: {
                role: "assistant",
                content: '{"passed":true,"issues":[]}',
              },
              usage: { input: 1, output: 1 },
              bytes: 20,
              finishReason: "stop",
            };
          calls++;
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: randomUUID(),
                  name: calls === 1 ? "browser" : "finish",
                  arguments: JSON.stringify(
                    calls === 1
                      ? { action: "observe" }
                      : { summary: "Observed the page.", artifactIds: [] },
                  ),
                },
              ],
            },
            usage: { input: 1, output: 1 },
            bytes: 20,
            finishReason: "tool_calls",
          };
        },
      }),
    );
    await engine.run((await claim(db))!);
    assert.equal((await getTask(db, taskId)).state, "waiting_tool");
    assert.equal(calls, 1);
    const op = (
      await db.query(
        "SELECT operation_id FROM browser_outbox WHERE task_id=$1",
        [taskId],
      )
    ).rows[0];
    await complete(op.operation_id, taskId, { text: "Test page" });
    await engine.run((await claim(db))!);
    assert.equal((await getTask(db, taskId)).state, "succeeded");
    assert.equal(calls, 2);
  } finally {
    await new Promise<void>((r) => http.close(() => r()));
  }
});
test("asynchronous browser artifacts retain original bytes and names, deduplicate, and require operation fencing", async () => {
  const { Storage } = await import("@hyper/runtime"),
    { taskId, op } = await pending(),
    storage = new Storage(cfg.DATA_DIR, db),
    task = await getTask(db, taskId);
  await db.query(
    "UPDATE browser_outbox SET status='running' WHERE operation_id=$1",
    [op.id],
  );
  const options = {
    name: "download.zip",
    format: "bin" as const,
    bytes: Buffer.from([80, 75, 3, 4, 0, 255]),
    sourceIds: [],
  };
  await assert.rejects(
    storage.artifact(task, "browser:" + op.id, options, {
      operationId: op.id,
      epoch: 99,
    }),
    /BROWSER_OPERATION_REVOKED/,
  );
  const saved = await storage.artifact(task, "browser:" + op.id, options, {
    operationId: op.id,
    epoch: 0,
  });
  const again = await storage.artifact(task, "browser:" + op.id, options, {
    operationId: op.id,
    epoch: 0,
  });
  assert.equal(saved.fileId, again.fileId);
  assert.equal(again.version, 1);
  const file = await storage.get(u.workspaceId, saved.fileId);
  assert.equal(file.name, "download.zip");
  assert.deepEqual(await storage.bytes(file), options.bytes);
  await cancelTask(db, taskId, u.workspaceId);
  await assert.rejects(
    storage.artifact(task, "browser:" + op.id + ":late", options, {
      operationId: op.id,
      epoch: 0,
    }),
    /BROWSER_OPERATION_REVOKED/,
  );
});
test("handoff retires safe intentions interrupted before dispatch and settles abandoned model reservations", async () => {
  const { taskId, s, op } = await pending();
  await db.query("DELETE FROM browser_outbox WHERE operation_id=$1", [op.id]);
  await db.query("UPDATE operations SET status='running' WHERE id=$1", [op.id]);
  await db.query(
    "UPDATE tasks SET state='running',lease_owner=$2,lease_until=now()+interval '30 seconds',reserved_tokens=100 WHERE id=$1",
    [taskId, randomUUID()],
  );
  await db.query(
    "INSERT INTO model_attempts(id,task_id,root_id,reserved,status) VALUES($1,$2,$2,100,'running')",
    [randomUUID(), taskId],
  );
  await transitionBrowser(db, service, u, s.id, "takeover", 0, "boundary-take");
  assert.equal(
    (
      await db.query("SELECT reserved_tokens,tokens FROM tasks WHERE id=$1", [
        taskId,
      ])
    ).rows[0].reserved_tokens,
    "0",
  );
  await transitionBrowser(db, service, u, s.id, "handback", 1, "boundary-back");
  await consumeBrowserInputs(db);
  assert.equal(
    (await db.query("SELECT status FROM operations WHERE id=$1", [op.id]))
      .rows[0].status,
    "obsolete",
  );
  assert.equal((await getTask(db, taskId)).state, "queued");
});
test("handoff never resumes a non-replayable computation interrupted by takeover", async () => {
  const { taskId, s, op } = await pending();
  await complete(op.id, taskId);
  await claim(db);
  await db.query(
    "INSERT INTO operations(id,task_id,step,call_id,name,args,status,replay) VALUES($1,$2,2,'compute','code_execute','{}','running','uncertain')",
    [randomUUID(), taskId],
  );
  await transitionBrowser(db, service, u, s.id, "takeover", 0, "compute-take");
  await transitionBrowser(db, service, u, s.id, "handback", 1, "compute-back");
  await consumeBrowserInputs(db);
  assert.equal((await getTask(db, taskId)).state, "uncertain");
});

for (const runtime of ["typescript", "rust"] as const) {
  test(`${runtime}: browser callback and human handback preserve task pause`, async () => {
    const { taskId, op, s } = await pending(undefined, runtime);
    await db.query(
      "UPDATE browser_outbox SET status='running' WHERE operation_id=$1",
      [op.id],
    );
    await controlTask(db, taskId, u.workspaceId, "pause");
    assert.equal((await getTask(db, taskId)).control_state, "pause_requested");
    await enqueueBrowserResult(db, op.id, taskId, { ok: true });
    await consumeBrowserInputs(db);
    await settlePauses(db);
    assert.equal((await getTask(db, taskId)).control_state, "paused");
    assert.equal(await claim(db), undefined);
    await transitionBrowser(
      db,
      service,
      u,
      s.id,
      "takeover",
      s.control_epoch,
      randomUUID(),
    );
    const fresh = (
      await db.query("SELECT * FROM browser_sessions WHERE id=$1", [s.id])
    ).rows[0];
    await transitionBrowser(
      db,
      service,
      u,
      s.id,
      "handback",
      fresh.control_epoch,
      randomUUID(),
    );
    await consumeBrowserInputs(db);
    assert.equal(
      (await taskOverview(db, taskId, u.workspaceId)).control,
      "paused",
    );
    assert.equal(await claim(db), undefined);
    await controlTask(db, taskId, u.workspaceId, "resume");
    assert.equal((await claim(db))?.id, taskId);
  });
}
