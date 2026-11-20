// Real browser -> real API -> temporary PostgreSQL. Only the model is controlled.
import { chromium } from "@playwright/test";
import { createServer as vite } from "vite";
import react from "@vitejs/plugin-react";
import privateDataPlugin from "./private-data.mjs";
import EmbeddedPostgres from "../backend/node_modules/embedded-postgres/dist/index.js";
import { buildApp } from "../backend/apps/api/dist/app.js";
import {
  config,
  pool,
  migrate,
  bootstrap,
  claim,
  Engine,
  readPlan,
  cancelTask,
} from "../backend/packages/runtime/dist/index.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
async function port() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const n = s.address().port;
  await new Promise((r) => s.close(r));
  return n;
}
const dir = await mkdtemp(join(tmpdir(), "lifecycle-ui-")),
  pgPort = await port(),
  apiPort = await port(),
  uiPort = await port(),
  origin = `http://127.0.0.1:${uiPort}`;
const output = resolve("docs/verification-task-lifecycle");
await mkdir(output, { recursive: true });
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
let db,
  app,
  server,
  browser,
  loop,
  owner,
  stop = false,
  held = false,
  release;
const gate = new Promise((r) => {
  release = r;
});
const cfg = config({
  DATABASE_URL: `postgres://hyper:hyper@127.0.0.1:${pgPort}/ui`,
  DATA_DIR: join(dir, "data"),
  PUBLIC_ORIGIN: origin,
  DEEPSEEK_API_KEY: "controlled-fixture",
  NODE_ENV: "test",
});
const errors = [],
  checks = [];
function response(name, args) {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: randomUUID(), name, arguments: JSON.stringify(args) }],
    },
    usage: { input: 10, output: 10 },
    finishReason: "tool_calls",
    bytes: 100,
  };
}
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("ui");
  db = pool(cfg.DATABASE_URL);
  await migrate(db);
  const password = randomUUID();
  owner = await bootstrap(db, { email: "ui@example.org", password });
  app = await buildApp(db, cfg);
  await app.listen({ host: "127.0.0.1", port: apiPort });
  server = await vite({
    configFile: false,
    root: process.cwd(),
    optimizeDeps: {
      entries: ["index.html"],
      esbuildOptions: { target: "es2022" },
    },
    plugins: [privateDataPlugin(), react()],
    define: { "import.meta.env.VITE_BACKEND_V1": '"true"' },
    server: {
      host: "127.0.0.1",
      port: uiPort,
      strictPort: true,
      proxy: { "/api": `http://127.0.0.1:${apiPort}` },
      watch: {
        ignored: [
          "**/backend/**",
          "**/docs/**",
          "**/OpenMausBot/**",
          "**/browser/**",
          "**/macro/**",
        ],
      },
    },
  });
  await server.listen();
  const engine = new Engine(db, cfg, (attempt) => ({
    name: "controlled",
    complete: async (input) => {
      await attempt();
      if (input.messages[0].content.includes("strict delivery reviewer"))
        return {
          message: {
            role: "assistant",
            content: '{"passed":true,"issues":[]}',
          },
          usage: { input: 10, output: 10 },
          finishReason: "stop",
          bytes: 60,
        };
      const t = (
        await db.query(
          "SELECT id FROM tasks WHERE parent_id IS NULL ORDER BY created_at DESC LIMIT 1",
        )
      ).rows[0];
      const plan = await readPlan(db, t.id);
      if (!plan)
        return response("update_plan", {
          expectedVersion: 0,
          reason: "Prepare and deliver a file",
          steps: [
            { id: "prepare", title: "Prepare content", status: "completed" },
            { id: "save", title: "Save output", status: "in_progress" },
          ],
        });
      if (!held) {
        held = true;
        await gate;
      }
      const files = (
        await db.query(
          "SELECT artifact_id FROM artifact_versions WHERE task_id=$1",
          [t.id],
        )
      ).rows;
      if (!files.length)
        return response("artifact_write", {
          name: "proof.md",
          format: "md",
          content: "# Persistent delivery\nBrowser, API and database agree.",
        });
      if (plan.version === 1)
        return response("update_plan", {
          expectedVersion: 1,
          reason: "Saved output",
          steps: plan.steps.map((s) => ({ ...s, status: "completed" })),
        });
      return response("finish", {
        summary: "Delivered proof.md",
        artifactIds: files.map((f) => f.artifact_id),
      });
    },
  }));
  loop = (async () => {
    while (!stop) {
      const task = await claim(db);
      if (task) await engine.run(task);
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1360, height: 980 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByLabel("Email", { exact: true }).fill("ui@example.org");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Let's get to work." }).waitFor();
  checks.push("real login");
  await page
    .getByLabel("Task prompt", { exact: true })
    .fill("Save a Markdown file with persistent delivery proof");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByText("Task plan · 1/2 completed", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Pause task", exact: true }).click();
  await page.getByText("Pausing…", { exact: true }).waitFor();
  release();
  await page
    .locator('.v1-run strong[role="status"]')
    .filter({ hasText: /^Paused$/ })
    .waitFor();
  const taskId = await page
    .locator(".real-thread[data-task-id]")
    .getAttribute("data-task-id");
  assert.equal(
    (await db.query("SELECT control_state FROM tasks WHERE id=$1", [taskId]))
      .rows[0].control_state,
    "paused",
  );
  checks.push("pause UI persisted in PostgreSQL");
  await page.getByLabel("Follow-up message").fill("Preserve the file title");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Resume task", exact: true })
    .waitFor();
  assert.equal(await page.locator(".v1-run.is-running").count(), 0);
  assert.equal(
    await page
      .locator(".v1-activity em")
      .filter({ hasText: /^In progress$/ })
      .count(),
    0,
  );
  checks.push("paused instructions and refresh");
  await page.screenshot({ path: join(output, "paused.png"), fullPage: true });
  const tab = await context.newPage();
  await tab.goto(page.url());
  await tab.getByRole("button", { name: "Resume task", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".real-thread[data-task-state]")
        ?.getAttribute("data-task-state") === "succeeded",
    {},
    { timeout: 45000 },
  );
  await page.getByText("Task plan · 2/2 completed", { exact: true }).waitFor();
  checks.push("second tab resumes same task");
  await page.locator(".v1-deliverables a").first().waitFor();
  const downloading = page.waitForEvent("download");
  await page.locator(".v1-deliverables a").first().click();
  const download = await downloading;
  assert.equal(await download.failure(), null);
  assert.match(
    await readFile(await download.path(), "utf8"),
    /Browser, API and database agree/,
  );
  checks.push("browser downloads accepted persisted file");
  await page.reload();
  await page.getByText("Saved deliverables · 1", { exact: true }).waitFor();
  await page.screenshot({
    path: join(output, "completed.png"),
    fullPage: true,
  });
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM artifact_versions WHERE task_id=$1",
        [taskId],
      )
    ).rows[0].count,
    "1",
  );
  assert.deepEqual(errors, []);
  checks.push("accepted version survives reload; no console errors");
  await writeFile(
    join(output, "api-ui.json"),
    JSON.stringify({ status: "passed", checks, errors }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ status: "passed", checks }));
} finally {
  release();
  stop = true;
  if (db && owner)
    for (const t of (
      await db.query(
        "SELECT id FROM tasks WHERE parent_id IS NULL AND state NOT IN ('failed','succeeded','cancelled')",
      )
    ).rows)
      await cancelTask(db, t.id, owner.workspaceId);
  await loop;
  await browser?.close();
  await server?.close();
  await app?.close();
  await db?.end();
  await pg.stop().catch(() => {});
}
