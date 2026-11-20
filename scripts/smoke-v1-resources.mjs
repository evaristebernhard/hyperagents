// Live browser acceptance. Uses isolated verification accounts and real sandbox/model.
// Credentials and temporary files stay in the ignored private data directory.
import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
const origin = process.env.V1_UI_ORIGIN || "http://localhost:5173";
const output = "docs/verification-v1-resources";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [],
  legacy = [],
  checks = [];
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  const p = new URL(r.url()).pathname;
  if (p.startsWith("/api/") && !p.startsWith("/api/v1/")) legacy.push(p);
});
const check = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
async function login(page, a) {
  await page.goto(origin);
  await page.getByLabel("Email", { exact: true }).fill(a.email);
  await page.getByLabel("Password", { exact: true }).fill(a.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Let's get to work." }).waitFor();
}
async function api(path, method = "GET", body) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const r = await fetch("/api/v1" + path, {
        method,
        headers: {
          "x-csrf-token": localStorage.getItem("hyperagents:v1:csrf") || "",
          "idempotency-key": crypto.randomUUID(),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    },
    { path, method, body },
  );
}
async function waitSaved() {
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Storage status"]')?.textContent ===
      "Saved to workspace",
  );
}
async function complete(attempt = 0) {
  await page.waitForFunction(
    () =>
      [
        "succeeded",
        "failed",
        "cancelled",
        "uncertain",
        "waiting_user",
      ].includes(
        document
          .querySelector("[data-task-state]")
          ?.getAttribute("data-task-state"),
      ),
    {},
    { timeout: 480000 },
  );
  const state = await page
    .locator("[data-task-state]")
    .getAttribute("data-task-state");
  if (
    state === "failed" &&
    attempt < 2 &&
    (await page.getByRole("button", { name: "Resume saved run" }).count())
  ) {
    await page.getByRole("button", { name: "Resume saved run" }).last().click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-task-state]")
          ?.getAttribute("data-task-state") !== "failed",
    );
    check(
      "Explicit recovery of a transient model failure; saved operations are preserved",
    );
    return complete(attempt + 1);
  }
  assert.equal(
    state,
    "succeeded",
    await page.locator(".rt-messages").innerText(),
  );
}
let run = randomUUID().slice(0, 8);
let firstTask, conversation, artifact;
try {
  if (process.env.V1_RESUME_TASK) {
    const access = JSON.parse(
      await readFile(
        "backend/.data-v1/verification/resources-access.json",
        "utf8",
      ),
    );
    await login(page, access);
    const personal = (await api("/workspaces")).body.find(
      (w) => w.kind === "personal",
    );
    assert.ok(personal);
    await api("/workspaces/" + personal.id + "/select", "POST");
    const saved = (await api("/resources")).body.find(
      (r) => r.kind === "memories" && r.value.content.includes("BLUE-"),
    );
    run = saved.value.content.match(/BLUE-([a-z0-9]+)/)[1];
    firstTask = process.env.V1_RESUME_TASK;
    const task = (await api("/tasks/" + firstTask)).body;
    conversation = task.conversationId;
    await page.goto(origin + "/thread/" + conversation);
    await page.locator("[data-task-id]").waitFor();
    if (task.state === "failed") {
      await page.getByRole("button", { name: "Resume saved run" }).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector("[data-task-state]")
            ?.getAttribute("data-task-state") !== "failed",
      );
      check("Explicitly resume saved calculation after model timeout");
    }
  } else {
    const admin = JSON.parse(
      await readFile("backend/.data-v1/interactive/access.json", "utf8"),
    );
    await login(page, admin);
    const registration = (await api("/invites", "POST")).body.token;
    const a = {
      email: "verify-" + run + "@example.test",
      password: randomBytes(24).toString("base64url"),
    };
    assert.equal(
      (await api("/auth/register", "POST", { ...a, invite: registration }))
        .status,
      201,
    );
    await api("/auth/logout", "POST");
    await page.evaluate(() => localStorage.removeItem("hyperagents:v1:csrf"));
    await login(page, a);
    await mkdir("backend/.data-v1/verification", {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      "backend/.data-v1/verification/resources-access.json",
      JSON.stringify(a),
      { mode: 0o600 },
    );
    await page.goto(origin + "/memories");
    await page
      .getByRole("button", { name: "Add memory", exact: true })
      .first()
      .click();
    await page
      .getByLabel("Memory Content")
      .fill(
        "数学计算请用简体中文回答，以循环和公式两种方式验证。报告末尾标注：BLUE-" +
          run,
      );
    await page.getByRole("checkbox", { name: "Pinned", exact: true }).check();
    await page
      .getByRole("button", { name: "Add Memory", exact: true })
      .last()
      .click();
    await waitSaved();
    await page.reload();
    await page
      .getByText("BLUE-" + run, { exact: false })
      .first()
      .waitFor();
    check("Memory CRUD persists after refresh");
    await page.goto(origin + "/marketplace");
    await page
      .getByRole("button", { name: "Install skill", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Installed", exact: true })
      .waitFor();
    check("Marketplace installs a usable skill");
    const resources = (await api("/resources")).body;
    const skill = resources.find((r) => r.kind === "skills").id;
    const agent = randomUUID();
    assert.equal(
      (
        await api("/resources/agents/" + agent, "PUT", {
          revision: 0,
          value: {
            id: agent,
            name: "Calculation reviewer",
            description: "Deterministic math checks",
            prompt:
              "Verify arithmetic using Python and an independent formula. Preserve source and document artifact versions.",
            tools: ["Documents", "Files", "Thread Search", "Skills"],
            skillIds: [skill],
            memoryMode: "Connected memory",
          },
        })
      ).status,
      200,
    );
    await page.goto(origin + "/agents");
    await page
      .getByText("Calculation reviewer", { exact: true })
      .first()
      .waitFor();
    check("Agent roster loads persisted runtime configuration");
    await page.goto(origin + "/threads/new");
    await page.getByRole("button", { name: "Select agent" }).click();
    await page
      .getByRole("button", { name: "Calculation reviewer", exact: true })
      .click();
    await page
      .getByLabel("Task prompt")
      .fill(
        "请计算 1 到 1000 的整数之和。用 Python 循环和公式双重核验，输出一个 sum.py 程序，以及 result.md 和 result.pdf 中文报告，使用 hyper_document.markdown_pdf。遵守已保存的记忆。最后用 learning_propose 提议一条新偏好：求和结果用表格列出。不要自动保存该偏好。",
      );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await page.locator("[data-task-id]").waitFor();
    conversation = await page
      .locator("[data-conversation-id]")
      .getAttribute("data-conversation-id");
    firstTask = await page
      .locator("[data-task-id]")
      .getAttribute("data-task-id");
    assert.equal(await page.locator(".rt-artifacts").count(), 0);
    check("Empty thread does not reserve an artifact panel");
  }
  await complete();
  await page
    .getByRole("button", { name: /activities/ })
    .first()
    .click();
  await page.screenshot({ path: output + "/calculation.png", fullPage: true });
  const detail = (await api("/conversations/" + conversation)).body;
  const files = [];
  for (const item of detail.artifacts) {
    const versions = (await api("/artifacts/" + item.id)).body.versions;
    const original =
      versions.find((v) => v.task_id === firstTask) || versions.at(-1);
    const res = await page.request.get(
      origin + "/api/v1/files/" + original.file_id + "/download",
    );
    assert.equal(res.status(), 200);
    files.push({
      id: item.id,
      name: item.name,
      bytes: (await res.body()).length,
      versions: versions.length,
      fileId: original.file_id,
    });
  }
  assert.ok(files.some((f) => f.name.endsWith(".py")));
  assert.ok(files.some((f) => f.name.endsWith(".pdf")));
  artifact = files.find((f) => f.name.endsWith(".md"));
  assert.ok(artifact);
  const md = await (
    await page.request.get(
      origin + "/api/v1/files/" + artifact.fileId + "/download",
    )
  ).text();
  assert.match(md, /500500|500,500/);
  assert.ok(md.includes("BLUE-" + run));
  check(
    "Real Python calculation, saved Memory context, source/Markdown/PDF downloads",
  );
  if (process.env.V1_RESUME_PHASE !== "revision") {
    await page
      .getByLabel("Follow-up message")
      .fill(
        "继续修改同一份报告和程序：改为计算 1 到 100 的整数之和，保留原有产物 ID，生成新的版本；两种方法的结果应为 5050。不要创建新的学习建议。",
      );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await page.waitForFunction(
      (id) =>
        document
          .querySelector("[data-task-id]")
          ?.getAttribute("data-task-id") !== id,
      firstTask,
    );
    await complete();
  }
  const versions = (await api("/artifacts/" + artifact.id)).body.versions;
  assert.ok(versions.length >= 2);
  const revised = await (
    await page.request.get(
      origin + "/api/v1/files/" + versions[0].file_id + "/download",
    )
  ).text();
  assert.match(revised, /5050|5,050/);
  await page.reload();
  await page.locator('[data-task-state="succeeded"]').waitFor();
  await page.locator('[data-artifact-id="' + artifact.id + '"]').click();
  await page
    .getByLabel("Artifact version")
    .selectOption(String(versions.at(-1).version));
  await page
    .getByRole("link", { name: "Download selected artifact" })
    .waitFor();
  assert.ok(
    (
      await page
        .getByRole("link", { name: "Download selected artifact" })
        .getAttribute("href")
    ).includes(versions.at(-1).file_id),
  );
  check(
    "Follow-up creates versions; refresh restores every task and historical downloads",
  );
  await page.screenshot({ path: output + "/versions.png", fullPage: true });
  await page.goto(origin + "/learning");
  const learning = (await api("/learning")).body;
  if (learning.some((s) => !s.decision)) {
    await page
      .getByRole("button", { name: "Accept", exact: true })
      .first()
      .waitFor();
    const before = (await api("/resources")).body.filter(
      (r) => r.kind === "memories",
    ).length;
    await page
      .getByRole("button", { name: "Accept", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Accept", exact: true })
      .first()
      .waitFor({ state: "hidden" });
    assert.equal(
      (await api("/resources")).body.filter((r) => r.kind === "memories")
        .length,
      before + 1,
    );
    check("Agent learning proposal requires explicit acceptance");
  } else {
    assert.ok(learning.some((s) => s.decision === "accepted"));
    check("Accepted learning persists after refresh");
  }
  await page.goto(origin + "/library");
  await page.getByRole("heading", { name: "Library", exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll(".v1-library-card").length >= 3,
  );
  assert.ok(
    (await page.getByRole("link", { name: "Download", exact: true }).count()) >=
      3,
  );
  await page.screenshot({ path: output + "/library.png", fullPage: true });
  check("Library contains real task artifacts");
  const tasks = (await api("/tasks?conversationId=" + conversation)).body;
  const recoveryCodes = [];
  for (const t of tasks) {
    const es = (await api("/tasks/" + t.id + "/events?limit=500")).body.events;
    recoveryCodes.push(
      ...es
        .filter((e) => e.payload.type === "error")
        .map((e) => e.payload.code),
    );
  }
  const space = (
    await api("/workspaces", "POST", { name: "Verification team " + run })
  ).body.id;
  await api("/workspaces/" + space + "/select", "POST");
  await page.goto(origin + "/rooms/new");
  await page.getByLabel("Room name").fill("Shared calculations");
  await page
    .getByLabel("What will you work on?")
    .fill("Review arithmetic and keep evidence together.");
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await waitSaved();
  await page.reload();
  await page.getByRole("button", { name: "Start work in this room" }).waitFor();
  assert.equal((await api("/library")).body.length, 0);
  check("Team rooms persist and do not inherit personal files");
  await page.goto(origin + "/workspaces");
  await page
    .getByRole("heading", { name: "Workspaces", exact: true })
    .waitFor();
  await page.screenshot({ path: output + "/workspaces.png", fullPage: true });
  assert.deepEqual(legacy, []);
  assert.deepEqual(errors, []);
  check("No browser errors or legacy API requests");
  await writeFile(
    output + "/result.json",
    JSON.stringify(
      {
        recoveryCodes,
        origin,
        checks,
        conversation,
        firstTask,
        artifactIds: files.map((f) => f.id),
        files,
        errors,
        legacy,
      },
      null,
      2,
    ),
  );
} catch (e) {
  await page
    .screenshot({ path: "/tmp/hyper-v1-resource-failure.png", fullPage: true })
    .catch(() => {});
  console.error("Browser acceptance failed:", e.message);
  throw e;
} finally {
  await browser.close();
}
