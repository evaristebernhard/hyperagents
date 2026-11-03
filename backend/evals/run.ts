import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { parse as parseCsv } from "csv-parse/sync";
import EmbeddedPostgres from "embedded-postgres";
import { buildApp } from "@hyper/api";
import {
  config,
  pool,
  migrate,
  bootstrap,
  invite,
  register,
  Storage,
  validate,
  getTask,
  PROMPT_VERSION,
  TOOL_VERSION,
} from "@hyper/runtime";
import { cases, CASE_VERSION } from "./cases.js";
try {
  process.loadEnvFile("../.env");
} catch {}
const runnerEnv = process.argv
  .find((arg) => arg.startsWith("--runner-env="))
  ?.slice("--runner-env=".length);
if (runnerEnv) process.loadEnvFile(runnerEnv);
const runId = new Date().toISOString().replace(/[:.]/g, "-"),
  root = join(process.cwd(), ".data-v1", "evaluations", runId);
await mkdir(root, { recursive: true, mode: 0o700 });
const pg = new EmbeddedPostgres({
  databaseDir: join(root, "postgres"),
  port: 55440,
  user: "hyper",
  password: "hyper",
  persistent: true,
  autoRehydrateSymlinks: true,
  onLog: () => {},
  onError: () => {},
  postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
});
await pg.initialise();
await pg.start();
await pg.createDatabase("hyper_eval");
const c = config({
  ...process.env,
  DATABASE_URL: "postgres://hyper:hyper@127.0.0.1:55440/hyper_eval",
  DATA_DIR: join(root, "files"),
  PUBLIC_ORIGIN: "http://127.0.0.1:18081",
  PORT: "18081",
  HOST: "127.0.0.1",
});
const db = pool(c.DATABASE_URL);
await migrate(db);
const password = randomUUID() + randomUUID(),
  admin = await bootstrap(db, { email: "eval0@example.com", password });
await register(db, {
  email: "eval1@example.com",
  password,
  invite: await invite(db, admin.userId),
});
const app = await buildApp(db, c);
await app.listen({ host: "127.0.0.1", port: c.PORT });
const worker = spawn(process.execPath, ["apps/worker/dist/index.js"], {
  env: {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(c)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    ),
  },
  stdio: ["ignore", "ignore", "pipe"],
});
worker.stderr.on("data", () => {});
const rows: Record<string, unknown>[] = [];
let providerBlocked = false;
const credentials: Record<string, string>[] = [];
for (let i = 0; i < 2; i++) {
  const r = await fetch(c.PUBLIC_ORIGIN + "/api/v1/auth/login", {
    method: "POST",
    headers: { origin: c.PUBLIC_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email: `eval${i}@example.com`, password }),
  });
  const data = (await r.json()) as { csrfToken: string };
  credentials.push({
    cookie: r.headers.get("set-cookie")!.split(";")[0]!,
    origin: c.PUBLIC_ORIGIN,
    "x-csrf-token": data.csrfToken,
  });
}
async function request(
  user: number,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const r = await fetch(c.PUBLIC_ORIGIN + "/api/v1" + path, {
    method,
    headers: {
      ...credentials[user]!,
      "content-type": "application/json",
      ...(method === "POST" ? { "idempotency-key": randomUUID() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error("API_" + r.status);
  return await r.json();
}
const capability = await request(0, "/capabilities");
const selection=process.argv.find(arg=>arg.startsWith('--cases='))?.slice('--cases='.length)??process.env.EVAL_CASES;
const selected = selection
  ? cases.filter((c) => selection.split(",").includes(c.id))
  : cases;
const repeats = Number(process.env.EVAL_REPEATS ?? 3);
const jobs = selected.flatMap((test) =>
  Array.from({ length: repeats }, (_, i) => ({ test, repeat: i + 1 })),
);
async function waitTask(user: number, id: string) {
  const start = Date.now();
  while (Date.now() - start < LimitsMs) {
    const t = await request(user, "/tasks/" + id);
    if (!["queued", "running", "waiting_children"].includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("EVAL_TIMEOUT");
}
const LimitsMs = 21 * 60 * 1000;
async function run(user: number) {
  while (jobs.length) {
    const job = jobs.shift()!;
    const { test, repeat } = job,
      start = Date.now();
    const row: Record<string, unknown> = {
      caseId: test.id,
      repeat,
      model: c.DEEPSEEK_MODEL,
      promptVersion: PROMPT_VERSION,
      toolVersion: TOOL_VERSION,
      caseVersion: CASE_VERSION,
    };
    rows.push(row);
    try {
      if (!c.DEEPSEEK_API_KEY) {
        Object.assign(row, {
          status: "blocked",
          reason: "MODEL_NOT_CONFIGURED",
        });
        continue;
      }
      if (providerBlocked) {
        Object.assign(row, { status: "blocked", reason: "MODEL_QUOTA" });
        continue;
      }
      if ("sandbox" in test && test.sandbox && !capability.sandbox.available) {
        Object.assign(row, { status: "blocked", reason: "GVISOR_UNAVAILABLE" });
        continue;
      }
      const fileIds: string[] = [];
      if ("csv" in test) {
        const form = new FormData();
        form.set("file", new Blob([test.csv]), "input.csv");
        const r = await fetch(c.PUBLIC_ORIGIN + "/api/v1/files", {
          method: "POST",
          headers: credentials[user],
          body: form,
        });
        if (!r.ok) throw new Error("UPLOAD_FAILED");
        fileIds.push(((await r.json()) as { id: string }).id);
      }
      const created = await request(user, "/tasks", "POST", {
        prompt: test.prompt,
        inputFileIds: fileIds,
        acceptance: {
          formats: test.formats,
          requiredText: test.required,
          requireSources: "research" in test && test.research,
        },
      });
      row.taskId = created.taskId;
      let task = await waitTask(user, created.taskId);
      const checks = {
        content: false,
        files: false,
        execution: false,
        versions: !("followup" in test),
      };
      row.checks = checks;
      if (task.state !== "succeeded") {
        if (task.errorCode === "MODEL_QUOTA") providerBlocked = true;
        Object.assign(row, {
          status: "failed",
          reason: task.errorCode ?? task.state,
        });
        continue;
      }
      const storage = new Storage(c.DATA_DIR, db),
        internal = await getTask(db, task.id);
      let texts = "";
      const delivered = new Map<string, string[]>();
      for (const a of task.result.artifacts) {
        const r = await fetch(c.PUBLIC_ORIGIN + a.downloadUrl, {
          headers: credentials[user],
        });
        if (!r.ok) throw new Error("DOWNLOAD_FAILED");
        const bytes = Buffer.from(await r.arrayBuffer());
        if (!bytes.length) throw new Error("EMPTY_DOWNLOAD");
        const checked = await validate(bytes, a.format);
        if (a.format !== "png") {
          texts += checked.text;
          delivered.set(a.format, [...(delivered.get(a.format) ?? []), checked.text]);
        }
      }
      checks.files = test.formats.every((format) =>
        task.result.artifacts.some(
          (a: { format: string }) => a.format === format,
        ),
      );
      checks.content = test.required.every((text) => texts.includes(text));
      if (test.id === "data-analysis-chart" || test.id === "csv-cleaning") {
        const expected = test.id === "data-analysis-chart" ? { A: 20, B: 20 } : { Alice: 15, Bob: 20 };
        checks.content &&= (delivered.get("csv") ?? []).some(text => {
          const rows = parseCsv(text, { skip_empty_lines: true }) as string[][];
          return rows.length === 3 && Object.entries(expected).every(([label, value]) =>
            rows.slice(1).some(row => row.includes(label) && row.some(cell => Number(cell) === value)));
        });
      }
      if (test.id === "json-structure") {
        checks.content &&= (delivered.get("json") ?? []).some(text => {
          const value: unknown = JSON.parse(text);
          if (!value || typeof value !== "object" || !("project" in value) || !("weeks" in value)) return false;
          return value.project === "学习计划" && Array.isArray(value.weeks) && value.weeks.length === 2 &&
            value.weeks.every((week: unknown) => !!week && typeof week === "object" && "week" in week &&
              typeof week.week === "number" && "goals" in week && Array.isArray(week.goals) &&
              week.goals.length > 0 && week.goals.every((goal: unknown) => typeof goal === "string"));
        });
      }
      if (test.id === "answer-order") {
        const answerHeading = [
          ...texts.matchAll(/^#{1,6}\s+[^\n]*答案[^\n]*$/gm),
        ].at(-1);
        const answerIndex = answerHeading?.index ?? -1;
        checks.content &&=
          answerIndex > texts.indexOf("Q3") &&
          ["5/6", "1/4", "2/5"].every(
            (answer) => !texts.slice(0, answerIndex).includes(answer),
          );
      }
      const ops = await db.query(
        "SELECT name,status,result FROM operations WHERE task_id IN (SELECT id FROM tasks WHERE root_id=$1)",
        [task.id],
      );
      checks.execution = test.tools.every((name) =>
        ops.rows.some(
          (r) =>
            r.name === name && r.status === "completed" && !r.result?.error,
        ),
      );
      if ("followup" in test) {
        const prior = task.result.artifacts.map((a: { id: string }) => a.id);
        const next = await request(user, "/tasks", "POST", {
          prompt: test.followup,
          conversationId: task.conversationId,
          acceptance: {
            formats: test.formats,
            requiredText:
              test.id === "document-version"
                ? ["下一步", "校准仪器", "记录温度"]
                : ["使用说明"],
            requireSources: false,
          },
        });
        row.revisionTaskId = next.taskId;
        const revision = await waitTask(user, next.taskId);
        checks.versions =
          revision.state === "succeeded" &&
          revision.result.artifacts.every((a: { id: string }) =>
            prior.includes(a.id),
          );
        if (checks.versions) {
          checks.versions &&= test.formats.every(format => revision.result.artifacts.some((a: { format: string }) => a.format === format));
          for (const artifact of revision.result.artifacts) {
            const response = await fetch(c.PUBLIC_ORIGIN + artifact.downloadUrl, { headers: credentials[user] });
            if (!response.ok) throw new Error("REVISION_DOWNLOAD_FAILED");
            const checked = await validate(Buffer.from(await response.arrayBuffer()), artifact.format);
            checks.versions &&= checked.text.includes(test.id === "document-version" ? "下一步" : "使用说明");
          }
          for (const id of prior) {
            const detail = await request(user, "/artifacts/" + id);
            checks.versions &&= detail.versions.length >= 2;
          }
        }
      }
      Object.assign(row, {
        status: Object.values(checks).every(Boolean) ? "passed" : "failed",
        usage: await db
          .query(
            "SELECT model_calls,tool_calls,tokens,transfer_bytes,artifact_bytes FROM tasks WHERE id=$1",
            [created.taskId],
          )
          .then((r) => r.rows[0]),
      });
    } catch (e) {
      Object.assign(row, {
        status: "failed",
        reason: e instanceof Error ? e.message : "EVAL_ERROR",
      });
    } finally {
      if (typeof row.taskId === "string") {
        const ids = [
          row.taskId,
          ...(typeof row.revisionTaskId === "string"
            ? [row.revisionTaskId]
            : []),
        ];
        row.usage = (
          await db.query(
            "SELECT id,model_calls,tool_calls,tokens,transfer_bytes,artifact_bytes FROM tasks WHERE id=ANY($1::uuid[])",
            [ids],
          )
        ).rows;
        row.artifacts = (
          await db.query(
            "SELECT id,name,format,sha256,bytes,storage_key FROM files WHERE task_id IN (SELECT id FROM tasks WHERE root_id=ANY($1::uuid[]))",
            [ids],
          )
        ).rows;
      }
      if (row.status === "failed" && !row.reason) row.reason = "GRADING_FAILED";
      row.elapsedMs = Date.now() - start;
      console.log(
        JSON.stringify({
          caseId: test.id,
          repeat,
          status: row.status,
          reason: row.reason,
          elapsedMs: row.elapsedMs,
        }),
      );
    }
  }
}
try {
  await Promise.all([run(0), run(1)]);
} finally {
  worker.kill("SIGTERM");
  await new Promise<void>((r) => {
    const timer = setTimeout(() => {
      worker.kill("SIGKILL");
      r();
    }, 10000);
    worker.once("exit", () => {
      clearTimeout(timer);
      r();
    });
  });
  await app.close();
  await db.end();
  await pg.stop();
}
const passed = rows.filter((r) => r.status === "passed").length,
  blocked = rows.filter((r) => r.status === "blocked").length;
const report = {
  runId,
  caseVersion: CASE_VERSION,
  graderVersion: "1.1.1",
  model: c.DEEPSEEK_MODEL,
  root,
  total: rows.length,
  passed,
  blocked,
  passRate: passed / rows.length,
  gatePassed:
    rows.length === 36 &&
    cases.every(test => rows.filter(row => row.caseId === test.id).length === 3) &&
    passed / 36 >= 0.9 &&
    rows
      .filter((r) => r.caseId === "math-document-revision")
      .every((r) => r.status === "passed"),
  capabilities: capability,
  results: rows,
};
await mkdir("evals/results", { recursive: true });
await writeFile(`evals/results/${runId}.json`, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    report: `evals/results/${runId}.json`,
    total: rows.length,
    passed,
    blocked,
    passRate: report.passRate,
    gatePassed: report.gatePassed,
  }),
);
if (!report.gatePassed) process.exitCode = 1;
