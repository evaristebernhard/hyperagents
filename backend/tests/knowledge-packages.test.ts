import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";
import {
  pool,
  migrate,
  importBundle,
  installBundle,
  uninstallBundle,
  validateBundle,
  searchKnowledge,
  taskContext,
  type Db,
} from "@hyper/runtime";
let db: Db, pg: EmbeddedPostgres;
const workspace = randomUUID(),
  other = randomUUID();
before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: await mkdtemp(join(tmpdir(), "knowledge-test-")),
    user: "hyper",
    password: "hyper",
    port: 55443,
    persistent: false,
    autoRehydrateSymlinks: true,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  db = pool("postgresql://hyper:hyper@localhost:55443/postgres");
  await migrate(db);
  const user = randomUUID();
  await db.query(
    "INSERT INTO users(id,email,password_hash) VALUES($1,'knowledge@example.com','test')",
    [user],
  );
  await db.query(
    "INSERT INTO workspaces(id,user_id,kind) VALUES($1,$3,'personal'),($2,$3,'team')",
    [workspace, other, user],
  );
});
after(async () => {
  await db?.end();
  await pg?.stop();
});
const bundle = {
  id: "test-skill",
  name: "Test",
  description: "Test script",
  files: {
    "SKILL.md": "# Test",
    "scripts/run.py": "print(42)",
    "references/help.md": "Reference",
    "assets/template.txt": "Template",
  },
};
test("bundle rejects traversal and missing entrypoint", () => {
  assert.throws(() =>
    validateBundle({
      ...bundle,
      files: { ...bundle.files, "scripts/../../escape.py": "bad" },
    }),
  );
  assert.throws(() =>
    validateBundle({ ...bundle, files: { "scripts/a.py": "pass" } }),
  );
  assert.equal(
    validateBundle(bundle).digest,
    validateBundle({
      ...bundle,
      files: Object.fromEntries(Object.entries(bundle.files).reverse()),
    }).digest,
  );
});
test("install idempotence, pinned versions, local edits, rollback and reference-aware uninstall", async () => {
  const v1 = await importBundle(db, workspace, bundle);
  const first = await installBundle(db, workspace, bundle.id, v1.digest, 0);
  assert.equal(
    (await installBundle(db, workspace, bundle.id, v1.digest, 0)).revision,
    first.revision,
  );
  const context = await taskContext(db, workspace, "test", {});
  const v2 = await importBundle(db, workspace, {
    ...bundle,
    files: { ...bundle.files, "scripts/run.py": "print(43)" },
  });
  await assert.rejects(installBundle(db, other, bundle.id, v1.digest, 0));
  await assert.rejects(installBundle(db, workspace, bundle.id, v2.digest, 0));
  await installBundle(db, workspace, bundle.id, v2.digest, 1);
  assert.equal(context.skills[0].digest, v1.digest);
  await installBundle(db, workspace, bundle.id, v1.digest, 2);
  await db.query(
    "INSERT INTO resources(workspace_id,kind,id,value) VALUES($1,'agents','agent',$2)",
    [
      workspace,
      JSON.stringify({ id: "agent", name: "Agent", skillIds: [bundle.id] }),
    ],
  );
  await assert.rejects(uninstallBundle(db, workspace, bundle.id, 3, false));
  await uninstallBundle(db, workspace, bundle.id, 3, true);
  assert.deepEqual(
    (
      await db.query(
        "SELECT value->'skillIds' ids FROM resources WHERE workspace_id=$1 AND id='agent'",
        [workspace],
      )
    ).rows[0].ids,
    [],
  );
  await installBundle(db, workspace, bundle.id, v1.digest, 0, true);
  await assert.rejects(installBundle(db, workspace, bundle.id, v2.digest, 1));
  await assert.rejects(
    db.query("UPDATE skill_versions SET files=files WHERE workspace_id=$1", [
      workspace,
    ]),
  );
});
test("full-history bilingual retrieval and agent isolation", async () => {
  await db.query(
    `INSERT INTO resources(workspace_id,kind,id,value,updated_at) VALUES($1,'memories','old',$2,now()-interval '1 year')`,
    [
      workspace,
      JSON.stringify({
        id: "old",
        content: "南京市偏好 PostgreSQL",
        importance: 9,
      }),
    ],
  );
  await db.query(
    `INSERT INTO resources(workspace_id,kind,id,value) SELECT $1,'memories','filler-'||n,jsonb_build_object('id','filler-'||n,'content','unrelated filler') FROM generate_series(1,1100)n`,
    [workspace],
  );
  for (const query of ["京市", "postgresql", "postgreql"])
    assert.equal((await searchKnowledge(db, workspace, query))[0]?.id, "old");
  assert.equal((await searchKnowledge(db, other, "postgresql")).length, 0);
  assert.equal(
    (await searchKnowledge(db, workspace, "postgresql", "agent", true)).length,
    0,
  );
  await db.query(
    `INSERT INTO resources(workspace_id,kind,id,value) VALUES($1,'memories','private',$2)`,
    [
      workspace,
      JSON.stringify({
        id: "private",
        content: "private postgresql",
        agentId: "agent",
      }),
    ],
  );
  assert.ok(
    !(await searchKnowledge(db, workspace, "postgresql")).some(
      (r) => r.id === "private",
    ),
  );
  await assert.rejects(
    taskContext(db, workspace, "test", { memoryIds: ["private"] }),
  );
});
test("ZIP parser rejects traversal, links and expansion limits without extraction", async () => {
  const { readSkillZip } = await import("@hyper/runtime");
  const { execFileSync } = await import("node:child_process");
  const zip = (body: string) =>
    execFileSync("python3", [
      "-c",
      `import zipfile,io,sys\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:\n ${body}\nsys.stdout.buffer.write(b.getvalue())`,
    ]);
  const valid = zip(
    "z.writestr('pkg/SKILL.md','# Test'); z.writestr('pkg/scripts/main.py','print(42)')",
  );
  assert.equal((await readSkillZip(valid))["scripts/main.py"], "print(42)");
  await assert.rejects(readSkillZip(zip("z.writestr('../SKILL.md','bad')")));
  await assert.rejects(readSkillZip(zip("z.writestr('SKILL.md','x'*2000001)")));
  await assert.rejects(
    readSkillZip(
      zip(
        "i=zipfile.ZipInfo('SKILL.md'); i.external_attr=(0o120777<<16); z.writestr(i,'/etc/passwd')",
      ),
    ),
  );
});
test("durable extraction proposes once, accepts transactionally and reuses next task", async () => {
  const { createTask, setState, extractLearning, config, acceptLearning, tx } =
    await import("@hyper/runtime");
  const { taskId } = await createTask(
    db,
    workspace,
    { prompt: "Remember my preference: concise bilingual reports" },
    randomUUID(),
  );
  await setState(db, taskId, "succeeded", undefined, undefined, {
    summary: "The user prefers concise bilingual reports.",
  });
  let calls = 0;
  const model = {
    name: "test-extractor",
    complete: async () => {
      calls++;
      return {
        message: {
          role: "assistant" as const,
          content: "",
          toolCalls: [
            {
              id: "extract",
              name: "learning_propose" as const,
              arguments: JSON.stringify({
                kind: "memories",
                name: "Report preference",
                content: "Prefers concise bilingual reports",
                reason:
                  "The user explicitly requested this preference in the source task.",
              }),
            },
          ],
        },
        usage: { input: 100, output: 50 },
        finishReason: "tool_calls" as const,
        bytes: 150,
      };
    },
  };
  await extractLearning(db, config({}), model);
  assert.equal(calls, 1);
  assert.equal(await extractLearning(db, config({}), model), false);
  const suggestion = (
    await db.query("SELECT * FROM learning_suggestions WHERE task_id=$1", [
      taskId,
    ])
  ).rows[0];
  assert.ok(suggestion);
  assert.equal(
    (
      await db.query(
        "SELECT 1 FROM resources WHERE value->>'content'='Prefers concise bilingual reports'",
      )
    ).rowCount,
    0,
  );
  await tx(db, (c) => acceptLearning(c, workspace, suggestion.id, "accepted"));
  await assert.rejects(
    tx(db, (c) => acceptLearning(c, workspace, suggestion.id, "accepted")),
  );
  assert.ok(
    (await taskContext(db, workspace, "bilingual reports", {})).items.some(
      (i) => i.value.content === "Prefers concise bilingual reports",
    ),
  );
  assert.deepEqual(
    (
      await db.query("SELECT usage FROM learning_jobs WHERE task_id=$1", [
        taskId,
      ])
    ).rows[0].usage,
    { input: 100, output: 50 },
  );
});
test("read-only tasks never enqueue extraction", async () => {
  const { createTask, setState } = await import("@hyper/runtime");
  await db.query(
    "INSERT INTO resources(workspace_id,kind,id,value) VALUES($1,'agents','readonly',$2)",
    [
      workspace,
      JSON.stringify({
        id: "readonly",
        name: "Read only",
        memoryMode: "read-only",
      }),
    ],
  );
  const { taskId } = await createTask(
    db,
    workspace,
    { prompt: "Read only task", context: { agentId: "readonly" } },
    randomUUID(),
  );
  await setState(db, taskId, "succeeded");
  assert.equal(
    (await db.query("SELECT 1 FROM learning_jobs WHERE task_id=$1", [taskId]))
      .rowCount,
    0,
  );
});
