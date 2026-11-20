// Real Rust -> TS -> browser -> human handback -> download -> runsc -> delivery.
// The model and login website are controlled fixtures; sandboxes and PostgreSQL are real.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import { chromium } from "playwright";
import {
  config,
  pool,
  migrate,
  bootstrap,
  createTask,
  getTask,
  claim,
  Engine,
  createKernelBridge,
  listenPrivate,
  kernelHealth,
  BrowserClient,
  dispatchBrowser,
  consumeBrowserInputs,
  transitionBrowser,
  Storage,
  controlTask,
  settlePauses,
  taskOverview,
} from "@hyper/runtime";
import { createRunner } from "@hyper/runner";
import { createBrowserService } from "../browser-service/service.mjs";
const lifecycle = process.env.LIFECYCLE_ACCEPTANCE === "true";
const runtime = process.env.LIFECYCLE_RUNTIME || "rust";
const root = await mkdtemp("/tmp/hyper-complete-flow-");
const portProbe = createServer();
await new Promise((resolve, reject) => {
  portProbe.once("error", reject);
  portProbe.listen(0, "127.0.0.1", resolve);
});
const pgPort = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const cfg = config({
  ...process.env,
  DATA_DIR: join(root, "files"),
  DATABASE_URL: `postgres://hyper:hyper@127.0.0.1:${pgPort}/flow`,
  BROWSER_ENABLED: "true",
  BROWSER_PROFILE_DIR: join(root, "profiles"),
  BROWSER_TOKEN: randomUUID() + randomUUID(),
  RUNNER_TOKEN: randomUUID() + randomUUID(),
  KERNEL_SOCKET: join(root, "run/kernel.sock"),
  KERNEL_BRIDGE_SOCKET: join(root, "run/bridge.sock"),
});
if (!cfg.COMPUTE_RUNTIME_DIR || !cfg.BROWSER_RUNTIME_DIR)
  throw new Error("Both runtime directories are required");
const pg = new EmbeddedPostgres({
  databaseDir: join(root, "pg"),
  user: "hyper",
  password: "hyper",
  port: pgPort,
  persistent: false,
  autoRehydrateSymlinks: true,
  onLog: () => {},
  onError: () => {},
  postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
});
let db,
  runner,
  browser,
  bridge,
  kernel,
  contexts = [],
  logs = "",
  completed = false;
const fixture = `<!doctype html><title>Dummy login</title><input type="password" id="password"><button id="login">Login</button><script>
document.getElementById("login").onclick = () => {
  localStorage.setItem("login", "yes");
  document.body.innerHTML = '<h1>Ready for download</h1><button id="download">Download data</button>';
  document.getElementById("download").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([${JSON.stringify("name,value\nA,6\nB,7\n")}], {type: "text/csv"}));
    a.download = "data.csv";
    a.click();
  };
};
</script>`;

function answer(name, args) {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: randomUUID(), name, arguments: JSON.stringify(args) }],
    },
    usage: { input: 100, output: 100 },
    bytes: 1000,
    finishReason: "tool_calls",
  };
}
async function model(input) {
  if (input.messages[0]?.content.includes("strict delivery reviewer"))
    return {
      message: { role: "assistant", content: '{"passed":true,"issues":[]}' },
      usage: { input: 100, output: 100 },
      bytes: 1000,
      finishReason: "stop",
    };
  const toolResults = input.messages
    .filter((m) => m.role === "tool")
    .map((m) => {
      try {
        return JSON.parse(m.content);
      } catch {
        return {};
      }
    });
  const computed = toolResults.find((r) => r.artifacts?.some((a) => a.fileId));
  if (computed)
    return answer("finish", {
      summary:
        "Human login, browser download, isolated computation and real output completed",
      artifactIds: computed.artifacts.map((a) => a.artifactId),
    });
  const downloaded = toolResults.find((r) => r.artifact?.fileId);
  if (downloaded)
    return answer("code_execute", {
      language: "python",
      inputFileIds: [downloaded.artifact.fileId],
      outputs: [{ path: "result.txt", format: "txt" }],
      code:
        'from pathlib import Path\nimport csv,math,time\ntime.sleep(1)\nwith open("/inputs/' +
        downloaded.artifact.fileId +
        '.csv") as f: product=math.prod(int(r["value"]) for r in csv.DictReader(f))\nPath("result.txt").write_text("6 * 7 = " + str(product))\nprint(product)',
    });
  const handed = input.messages.some(
    (m) => m.role === "user" && m.content.startsWith("Browser handed back."),
  );
  if (handed) {
    const observed = [...toolResults]
      .reverse()
      .find((r) => r.elements?.some((e) => e.label === "Download data"));
    if (observed)
      return answer("browser", {
        action: "download",
        ref: observed.elements.find((e) => e.label === "Download data").ref,
      });
    return answer("browser", { action: "observe" });
  }
  return answer("browser", {
    action: "navigate",
    url: "https://example.com/hyper-login",
  });
}
try {
  console.log(JSON.stringify({ stage: "database-init" }));
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("flow");
  db = pool(cfg.DATABASE_URL);
  await migrate(db);
  const owner = await bootstrap(db, {
    email: "flow@example.org",
    password: randomUUID(),
  });
  const profile = randomUUID();
  await db.query(
    "INSERT INTO browser_profiles(id,workspace_id,owner_id,name) VALUES($1,$2,$3,'Disposable login')",
    [profile, owner.workspaceId, owner.userId],
  );
  console.log(JSON.stringify({ stage: "database-ready" }));
  runner = await createRunner(cfg);
  console.log(JSON.stringify({ stage: "runner-created" }));
  cfg.RUNNER_URL = await runner.listen({ host: "127.0.0.1", port: 0 });
  if (lifecycle)
    assert.equal(
      (
        await runner.inject({
          url: "/health",
          headers: { authorization: "Bearer " + cfg.RUNNER_TOKEN },
        })
      ).json().available,
      true,
    );
  const wrappedChromium = {
    async connectOverCDP(...args) {
      const b = await chromium.connectOverCDP(...args);
      const c = b.contexts()[0];
      contexts.push(c);
      const originalPage = c.newPage.bind(c);
      c.newPage = async () => {
        const page = await originalPage();
        await page.route("https://example.com/hyper-login", async (route) => {
          if (lifecycle) await new Promise((r) => setTimeout(r, 1000));
          await route.fulfill({ contentType: "text/html", body: fixture });
        });
        return page;
      };
      return b;
    },
  };
  console.log(JSON.stringify({ stage: "browser-preflight" }));
  browser = await createBrowserService(db, cfg, { chromium: wrappedChromium });
  cfg.BROWSER_URL = await browser.listen({ host: "127.0.0.1", port: 0 });
  bridge = await createKernelBridge(db, cfg, () => ({
    name: "controlled",
    complete: model,
  }));
  await listenPrivate(bridge, cfg.KERNEL_BRIDGE_SOCKET);
  kernel = spawn(
    fileURLToPath(
      new URL("../kernel/target/debug/hyperagents-kernel", import.meta.url),
    ),
    {
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: cfg.DATABASE_URL,
        KERNEL_SOCKET: cfg.KERNEL_SOCKET,
        KERNEL_BRIDGE_SOCKET: cfg.KERNEL_BRIDGE_SOCKET,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  kernel.stderr.on("data", (d) => {
    logs += d;
  });
  for (
    let n = 0;
    n < 100 && !(await kernelHealth(cfg.KERNEL_SOCKET)).available;
    n++
  )
    await new Promise((r) => setTimeout(r, 50));
  const taskId = (
    await createTask(
      db,
      owner.workspaceId,
      {
        prompt:
          "Complete the controlled login, browser download and isolated calculation",
        browserProfileId: profile,
        acceptance: { formats: ["txt"], requiredText: ["42"] },
      },
      randomUUID(),
      owner.userId,
      runtime,
    )
  ).taskId;
  const engine = new Engine(db, cfg, (attempt) => ({
    name: "controlled",
    complete: async (input) => {
      await attempt();
      return model(input);
    },
  }));
  let browserPaused = false,
    computePaused = false,
    pauseChecks = 0;
  if (lifecycle) {
    const run = engine.tools.runner.run.bind(engine.tools.runner);
    engine.tools.runner.run = async (...args) => {
      const work = run(...args);
      let done = false;
      void work.then(
        () => {
          done = true;
        },
        () => {
          done = true;
        },
      );
      for (let i = 0; i < 100 && !done; i++) {
        if (
          (
            await runner.inject({
              url: "/metrics",
              headers: { authorization: "Bearer " + cfg.RUNNER_TOKEN },
            })
          ).json().active > 0
        ) {
          await controlTask(db, taskId, owner.workspaceId, "pause");
          computePaused = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      return work;
    };
  }
  console.log(JSON.stringify({ stage: "kernel-and-sandboxes-ready" }));
  const client = new BrowserClient(cfg);
  let handedBack = false;
  const deadline = Date.now() + (lifecycle ? 240000 : 120000);
  while (Date.now() < deadline) {
    await dispatchBrowser(db, client);
    await consumeBrowserInputs(db);
    if (
      lifecycle &&
      !browserPaused &&
      (
        await db.query(
          "SELECT 1 FROM browser_outbox WHERE task_id=$1 AND status='running'",
          [taskId],
        )
      ).rowCount
    ) {
      await controlTask(db, taskId, owner.workspaceId, "pause");
      browserPaused = true;
    }
    await settlePauses(db);
    if (lifecycle && (await getTask(db, taskId)).control_state === "paused") {
      const before = await taskOverview(db, taskId, owner.workspaceId);
      await new Promise((r) => setTimeout(r, 250));
      const after = await taskOverview(db, taskId, owner.workspaceId);
      assert.equal(after.budget.activeMs, before.budget.activeMs);
      assert.equal(after.budget.modelCalls, before.budget.modelCalls);
      await controlTask(db, taskId, owner.workspaceId, "resume");
      pauseChecks++;
    }
    const t = await getTask(db, taskId);
    if (["failed", "uncertain", "cancelled"].includes(t.state))
      throw new Error(
        JSON.stringify({
          state: t.state,
          code: t.error_code,
          step: t.step,
          logs,
        }),
      );
    if (t.state === "succeeded") {
      const files = await db.query(
        "SELECT f.* FROM artifact_versions v JOIN files f ON f.id=v.file_id WHERE v.task_id=$1 AND f.name='result.txt'",
        [taskId],
      );
      assert.equal(files.rows.length, 1);
      const storage = new Storage(cfg.DATA_DIR, db);
      assert.match(
        (await storage.bytes(files.rows[0])).toString(),
        /6 \* 7 = 42/,
      );
      completed = true;
      break;
    }
    if (t.state === "waiting_browser" && !handedBack) {
      let s = (
        await db.query("SELECT * FROM browser_sessions WHERE task_id=$1", [
          taskId,
        ])
      ).rows[0];
      if (s?.state === "open" && s.control === "paused") {
        const identity = {
          userId: owner.userId,
          workspaceId: owner.workspaceId,
          admin: true,
          role: "admin",
          email: "flow@example.org",
          csrfHash: "",
        };
        await transitionBrowser(
          db,
          client,
          identity,
          s.id,
          "takeover",
          s.control_epoch,
          randomUUID(),
        );
        const context = contexts.at(-1),
          page = context
            .pages()
            .find((p) => p.url() === "https://example.com/hyper-login");
        assert.ok(page);
        await page.bringToFront();
        await page.locator("#password").fill("dummy-local-fixture");
        await page.locator("#login").dispatchEvent("click");
        assert.equal(
          await page.evaluate(() => localStorage.getItem("login")),
          "yes",
        );
        s = (
          await db.query("SELECT * FROM browser_sessions WHERE id=$1", [s.id])
        ).rows[0];
        await transitionBrowser(
          db,
          client,
          identity,
          s.id,
          "handback",
          s.control_epoch,
          randomUUID(),
          "Dummy login completed",
        );
        handedBack = true;
        console.log(
          JSON.stringify({
            stage: "human-handback-completed",
            viewport: await page.evaluate(() => ({
              width: innerWidth,
              height: innerHeight,
              visible: document.visibilityState,
              focused: document.hasFocus(),
            })),
          }),
        );
      }
    }
    const claimed = await claim(db);
    if (claimed) await engine.run(claimed);
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(completed, logs || "Flow timed out");
  assert.ok(handedBack);
  if (lifecycle) {
    assert.ok(browserPaused);
    assert.ok(computePaused);
    assert.ok(pauseChecks >= 2);
    console.log(
      JSON.stringify({ runtime, browserPaused, computePaused, pauseChecks }),
    );
  }
  console.log(
    JSON.stringify({
      status: "passed",
      checks: [
        `${runtime}-provider`,
        "atomic-outbox",
        "real-browser",
        "human-control-transition",
        "fresh-handback-observation",
        "download-artifact",
        "direct-runsc",
        "versioned-output-delivery",
      ],
    }),
  );
} catch (error) {
  console.error(error);
  throw error;
} finally {
  if (kernel && kernel.exitCode === null && kernel.signalCode === null)
    await new Promise((resolve) => {
      kernel.once("exit", resolve);
      kernel.kill("SIGTERM");
    });
  await bridge?.close();
  await browser?.close();
  await runner?.close();
  await db?.end();
  if (
    pg.process &&
    (pg.process.exitCode !== null || pg.process.signalCode !== null)
  )
    pg.process = undefined;
  await pg.stop();
  await rm(root, { recursive: true, force: true });
}
