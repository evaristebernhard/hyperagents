import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const origin = process.env.V1_UI_ORIGIN || "http://localhost:5174";
const access = JSON.parse(
  await readFile("backend/.data-v1/interactive/access.json", "utf8"),
);
const output = "docs/verification-v1-ui";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const page = await context.newPage();
const errors = [],
  legacyRequests = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  const p = new URL(r.url()).pathname;
  if (p.startsWith("/api/") && !p.startsWith("/api/v1/"))
    legacyRequests.push(p);
});
const check = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
async function login(target, credentials) {
  await target.goto(origin);
  await target.getByLabel("Email", { exact: true }).fill(credentials.email);
  await target
    .getByLabel("Password", { exact: true })
    .fill(credentials.password);
  await target.getByRole("button", { name: "Sign in", exact: true }).click();
  await target.getByRole("heading", { name: "Let's get to work." }).waitFor();
}
async function api(path, method = "GET", body) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const response = await fetch("/api/v1" + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          "x-csrf-token": localStorage.getItem("hyperagents:v1:csrf") || "",
          "idempotency-key": crypto.randomUUID(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, method, body },
  );
}
async function waitComplete() {
  await page.waitForFunction(
    () =>
      ["succeeded", "failed", "cancelled", "uncertain"].includes(
        document
          .querySelector("[data-task-state]")
          ?.getAttribute("data-task-state"),
      ),
    {},
    { timeout: 900000 },
  );
  assert.equal(
    await page.locator("[data-task-state]").getAttribute("data-task-state"),
    "succeeded",
    await page.locator(".rt-messages").innerText(),
  );
  await page.locator(".rt-artifact-list button").first().waitFor();
}
async function artifactFiles() {
  const result = [];
  const items = page.locator(".rt-artifact-list button");
  const count = await items.count();
  for (let i = 0; i < count; i++) {
    const item = items.nth(i),
      id = await item.getAttribute("data-artifact-id");
    await item.click();
    const link = page.getByRole("link", { name: "Download selected artifact" });
    const url = await link.getAttribute("href");
    const download = page.waitForEvent("download");
    await link.click();
    const received = await download;
    assert.equal(await received.failure(), null);
    const bytes = await readFile(await received.path());
    assert.ok(bytes.length > 0);
    const detail = await api("/artifacts/" + id);
    result.push({
      id,
      url,
      name: await item.innerText(),
      bytes: bytes.length,
      versions: detail.body.versions.map((v) => ({
        version: v.version,
        fileId: v.file_id,
      })),
    });
  }
  return result;
}
try {
  await login(page, access);
  check("login with original auth style");
  assert.equal(
    await page.getByRole("link", { name: "Tasks", exact: true }).count(),
    0,
  );
  assert.equal(await page.locator(".sidebar").count(), 1);
  await page.screenshot({ path: output + "/home.png", fullPage: true });
  await page.getByRole("button", { name: "Model settings" }).click();
  assert.match(
    await page.locator(".composer-popover").innerText(),
    /deepseek/i,
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Tools and permissions" }).click();
  assert.match(
    await page.locator(".composer-popover").innerText(),
    /Available/,
  );
  await page.keyboard.press("Escape");
  check("main sidebar, homepage and actual capabilities");
  await page
    .getByLabel("Attach files", { exact: true })
    .setInputFiles({
      name: "requirements.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "标题：一元一次方程练习。所有题目在前，答案与解析在后。",
      ),
    });
  await page
    .getByRole("button", { name: "Remove attachment requirements.txt" })
    .waitFor();
  await page.getByRole("button", { name: "Add files or context" }).click();
  await page.getByRole("button", { name: "Output as…" }).click();
  await page.getByRole("checkbox", { name: "MD", exact: true }).check();
  await page.getByRole("checkbox", { name: "PDF", exact: true }).check();
  await page.keyboard.press("Escape");
  await page
    .getByLabel("Task prompt", { exact: true })
    .fill(
      "读取附件要求，生成一份中文数学练习 Markdown 和 PDF：4 道一元一次方程，按简单和中等两档排列，每档两道。先列所有题目，所有答案与解题步骤统一放到末尾的“答案与解析”。使用 hyper_document.markdown_pdf 生成中文 PDF。",
    );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.locator("[data-task-id]").waitFor();
  const conversationId = await page
    .locator("[data-conversation-id]")
    .getAttribute("data-conversation-id");
  const firstTask = await page
    .locator("[data-task-id]")
    .getAttribute("data-task-id");
  await page
    .getByLabel("Follow-up message")
    .fill("补充说明：答案统一放到全文末尾，保留难度分组。");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByRole("article")
    .filter({ hasText: "补充说明：答案统一放到全文末尾，保留难度分组。" })
    .first()
    .waitFor();
  check("upload, task submission and running instruction");
  await page.reload();
  await page.locator(`[data-conversation-id="${conversationId}"]`).waitFor();
  assert.equal(
    await page.locator("[data-task-id]").getAttribute("data-task-id"),
    firstTask,
  );
  check("refresh restores conversation and running task");
  await waitComplete();
  const before = await artifactFiles();
  assert.ok(before.length >= 2);
  await page.screenshot({ path: output + "/completed.png", fullPage: true });
  check("math Markdown and PDF generated and downloaded");
  await page
    .getByRole("button", { name: "Continue modifying these files" })
    .click();
  await page
    .getByLabel("Follow-up message")
    .fill(
      "继续修改之前的 Markdown 和 PDF：在最前面加入“使用说明”，提醒先独立完成再查看答案；保留原有四道题目、难度分组、全部答案和解题步骤。更新原有两个产物的版本，不新建产物。",
    );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.waitForFunction(
    (id) =>
      document.querySelector("[data-task-id]")?.getAttribute("data-task-id") !==
      id,
    firstTask,
  );
  await waitComplete();
  const after = await artifactFiles();
  for (const old of before) {
    const changed = after.find((a) => a.id === old.id);
    assert.ok(changed, "same artifact retained");
    assert.notEqual(changed.url, old.url);
    assert.ok(changed.versions.length >= 2);
  }
  await page.getByLabel("Artifact version", { exact: true }).selectOption("1");
  assert.match(
    await page
      .getByRole("link", { name: "Download selected artifact" })
      .getAttribute("href"),
    new RegExp(before.at(-1).versions.find((v) => v.version === 1).fileId),
  );
  await page.screenshot({ path: output + "/versions.png", fullPage: true });
  check("follow-up revision preserves artifact IDs and historical downloads");
  // New run, cancel through the conversation controls.
  await page.getByRole("link", { name: "New thread", exact: true }).click();
  await page
    .getByLabel("Task prompt", { exact: true })
    .fill("搜索 PostgreSQL 和 SQLite 的官方资料，生成详细中文对比研究文档。");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const cancelled = page.waitForResponse(
    (r) => r.url().endsWith("/cancel") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  assert.equal((await cancelled).status(), 200);
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-task-state]")
        ?.getAttribute("data-task-state") === "cancelled",
  );
  check("cancel task from original conversation");
  // Revoke session on the server without notifying React, then let polling detect it.
  assert.equal((await api("/auth/logout", "POST")).status, 200);
  await page.getByLabel("Email", { exact: true }).waitFor({ timeout: 20000 });
  assert.equal(await page.locator(".app-shell").count(), 0);
  await login(page, access);
  check("expired session unmounts private UI and reauthentication works");
  const invite = await api("/invites", "POST");
  assert.equal(invite.status, 200);
  const second = {
    email: "ui-isolation-" + randomUUID() + "@example.com",
    password: randomUUID() + "-Aa1",
  };
  const otherContext = await browser.newContext();
  const registered = await otherContext.request.post(
    origin + "/api/v1/auth/register",
    { headers: { origin }, data: { ...second, invite: invite.body.token } },
  );
  assert.equal(registered.status(), 201);
  const other = await otherContext.newPage();
  await login(other, second);
  const isolation = await other.evaluate(
    async ({ conversationId, taskId, fileUrl, artifactId }) => {
      const paths = [
        "/conversations/" + conversationId,
        "/tasks/" + taskId,
        "/tasks/" + taskId + "/events",
        "/artifacts/" + artifactId,
      ];
      const codes = await Promise.all(
        paths.map(async (path) => (await fetch("/api/v1" + path)).status),
      );
      codes.push((await fetch(fileUrl)).status);
      return {
        codes,
        conversations: await (await fetch("/api/v1/conversations")).json(),
      };
    },
    {
      conversationId,
      taskId: firstTask,
      fileUrl: before[0].url,
      artifactId: before[0].id,
    },
  );
  assert.ok(isolation.codes.every((code) => code === 404));
  assert.equal(isolation.conversations.length, 0);
  await otherContext.close();
  check(
    "second user cannot list or access conversations, tasks, events, files or artifacts",
  );
  for (const port of [5173, 5174]) {
    for (const path of [
      "/backend/.data-v1/interactive/access.json",
      "/backend/%2edata-v1/runner.env?raw",
      "/@fs/home/ubuntu/hyperagents/backend/.data-v1/interactive/access.json?raw",
    ]) {
      const response = await fetch("http://localhost:" + port + path);
      assert.equal(response.status, 403, port + path);
    }
  }
  check("private files denied on both old and new development ports");
  assert.deepEqual(errors, []);
  assert.deepEqual(legacyRequests, []);
  check("no browser exceptions or legacy API requests");
  await writeFile(
    output + "/result.json",
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        origin,
        status: "passed",
        checks,
        before,
        after,
        consoleErrors: errors,
        legacyRequests,
      },
      null,
      2,
    ) + "\n",
  );
} catch (e) {
  await page
    .screenshot({ path: "/tmp/v1-ui-failure.png", fullPage: true })
    .catch(() => {});
  await writeFile(
    "/tmp/v1-ui-failure.json",
    JSON.stringify(
      { checks, error: String(e), errors, legacyRequests },
      null,
      2,
    ),
  );
  throw e;
} finally {
  await context.close();
  await browser.close();
}
