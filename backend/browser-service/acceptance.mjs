// Run ONLY inside the browser image against a dedicated empty acceptance DB and a
// public instance of fixture.mjs. Production egress policy remains unchanged.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  config,
  pool,
  migrate,
  bootstrap,
  createTask,
  claim,
  getTask,
  prepareBrowser,
  consumeBrowserInputs,
  cancelTask,
  Storage,
} from "@hyper/runtime";
import { createBrowserService } from "./service.mjs";
const url = process.env.BROWSER_ACCEPTANCE_DATABASE_URL,
  origin = process.env.BROWSER_TEST_ORIGIN;
if (!url || !origin || url === process.env.DATABASE_URL)
  throw new Error(
    "Use BROWSER_ACCEPTANCE_DATABASE_URL for a separate empty DB and BROWSER_TEST_ORIGIN for the public dummy fixture",
  );
const cfg = config({ ...process.env, DATABASE_URL: url }),
  db = pool(url),
  storage = new Storage(cfg.DATA_DIR, db);
await migrate(db);
if ((await db.query("SELECT 1 FROM users LIMIT 1")).rowCount)
  throw new Error("ACCEPTANCE_DATABASE_MUST_BE_EMPTY");
const user = await bootstrap(db, {
    email: "acceptance@example.org",
    password: randomUUID() + randomUUID(),
  }),
  pid = randomUUID();
await db.query(
  "INSERT INTO browser_profiles(id,workspace_id,owner_id,name) VALUES($1,$2,$3,$4)",
  [pid, user.workspaceId, user.userId, "Disposable acceptance identity"],
);
const file = await storage.upload(
  user.workspaceId,
  "fixture.txt",
  "txt",
  Buffer.from("Authorized fixture file"),
);
let app,
  taskId,
  sessionId,
  step = 0;
async function task() {
  taskId = (
    await createTask(
      db,
      user.workspaceId,
      {
        prompt: "Browser service acceptance",
        browserProfileId: pid,
        inputFileIds: [file.id],
      },
      randomUUID(),
      user.userId,
    )
  ).taskId;
}
async function action(args) {
  const t = await claim(db);
  assert.equal(t?.id, taskId);
  const id = randomUUID(),
    call = randomUUID(),
    fresh = await getTask(db, taskId);
  const messages = [
    ...(fresh.checkpoint.messages || []),
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: call, name: "browser", arguments: JSON.stringify(args) },
      ],
    },
  ];
  await db.query("UPDATE tasks SET checkpoint=$2 WHERE id=$1", [
    taskId,
    JSON.stringify({ messages }),
  ]);
  const op = (
    await db.query(
      "INSERT INTO operations(id,task_id,step,call_id,name,args,status,replay) VALUES($1,$2,$3,$4,'browser',$5,'running','safe') RETURNING *",
      [id, taskId, ++step, call, JSON.stringify(args)],
    )
  ).rows[0];
  await prepareBrowser(db, await getTask(db, taskId), op);
  const r = await app.inject({
    method: "POST",
    url: "/operations",
    headers: { authorization: "Bearer " + cfg.BROWSER_TOKEN },
    payload: { operationId: id },
  });
  assert.equal(r.statusCode, 200, r.body);
  for (let i = 0; i < 240; i++) {
    const out = (
      await db.query("SELECT * FROM browser_outbox WHERE operation_id=$1", [id])
    ).rows[0];
    if (["completed", "uncertain"].includes(out.status)) {
      await consumeBrowserInputs(db);
      assert.equal(out.status, "completed", JSON.stringify(out.result));
      assert.equal(out.result.error, undefined, JSON.stringify(out.result));
      sessionId = out.session_id;
      return out.result;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("OPERATION_DID_NOT_SETTLE");
}
async function state() {
  for (let i = 0; i < 12; i++) {
    const s = await action({ action: "observe" });
    if (s.text?.includes("cookie=true localStorage=true indexedDB=true"))
      return s;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("PERSISTENT_LOGIN_MISSING");
}
async function close() {
  const r = await app.inject({
    method: "POST",
    url: "/sessions/close",
    headers: { authorization: "Bearer " + cfg.BROWSER_TOKEN },
    payload: { sessionId },
  });
  assert.equal(r.statusCode, 200, r.body);
  await cancelTask(db, taskId, user.workspaceId);
}
try {
  app = await createBrowserService(db, cfg);
  await task();
  await action({ action: "navigate", url: new URL("/seed", origin).href });
  let observed = await state();
  const search = observed.elements.find(
    (e) => e.tag === "input" && e.label === "Search",
  );
  assert.ok(search);
  await action({ action: "fill", ref: search.ref, text: "quarterly results" });
  observed = await action({ action: "observe" });
  const download = observed.elements.find((e) => e.label === "Download CSV");
  const saved = await action({ action: "download", ref: download.ref });
  assert.equal(
    (
      await storage.bytes(
        await storage.get(user.workspaceId, saved.artifact.fileId),
      )
    ).toString(),
    "name,value\nfixture,42\n",
  );
  observed = await action({ action: "observe" });
  await action({
    action: "upload",
    ref: observed.elements.find((e) => e.label === "Upload fixture").ref,
    fileId: file.id,
  });
  await action({ action: "screenshot" });
  await close();
  await task();
  await action({ action: "navigate", url: new URL("/app", origin).href });
  await state();
  console.log(
    "PASS Cookie, localStorage, IndexedDB across tasks and normal browser restart; authorized upload, download artifact and screenshot",
  );
  await close();
  await app.close();
  app = await createBrowserService(db, cfg);
  await task();
  await action({ action: "navigate", url: new URL("/app", origin).href });
  await state();
  const expired = await action({
    action: "navigate",
    url: new URL("/expire", origin).href,
  });
  assert.equal(expired.humanRequired, true);
  assert.equal((await getTask(db, taskId)).state, "waiting_browser");
  console.log(
    "PASS service restart restores identity; expired login pauses for human input",
  );
  console.log(
    "Manual VNC takeover/login/handback, read-only tampering and real website checks still required; see deploy/BROWSER.md.",
  );
} finally {
  if (taskId) await cancelTask(db, taskId, user.workspaceId);
  await app?.close();
  await rm(join(cfg.BROWSER_PROFILE_DIR, pid), {
    recursive: true,
    force: true,
  });
  await db.end();
}
