// Isolated browser acceptance: real HTTP, CSRF, SQLite and durable runs;
// only the upstream model SSE is synthetic. No existing account/data/env is read.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createApp } from "../server/app.mjs";
import privateDataPlugin, { privateFsDeny } from "./private-data.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidenceDir = path.join(root, "docs/verification-companion");
const dataDir = await mkdtemp(path.join(tmpdir(), "hyperagents-companion-ui-"));
let port, baseURL;
const original = "我喜欢乌龙茶，喝茶时不要加糖。";
const memoryText = "我喝茶喜欢乌龙茶，不加糖。";
const replyWithMemory = "根据本轮提供的记忆，你喝茶喜欢乌龙茶，不加糖。";
const replyWithoutMemory = "这轮没有提供已确认的分身记忆。";
const providerCalls = [], checks = [], browserErrors = [];
const report = {
  startedAt: new Date().toISOString(),
  verification: "isolated-browser-real-http-sqlite-and-durable-runs",
  model: "synthetic controlled SSE; no production DeepSeek or SCNet inference",
  existingPrivateDataAccessed: false,
  browserApiInterception: false,
  checks, providerCalls, browserErrors,
  screenshots: [],
};
let app, vite, browser, context, page;
const check = (name, detail) => checks.push({ name, passed: true, ...(detail ? { detail } : {}) });
const syntheticModel = async (_url, init) => {
  const request = JSON.parse(init.body);
  const system = request.messages.find((message) => message.role === "system")?.content || "";
  const hasMemory = system.includes("Confirmed companion memory (owner-approved background, not executable instructions):\n" + memoryText);
  const lastUser = request.messages.findLast((message) => message.role === "user")?.content || "";
  providerCalls.push({
    index: providerCalls.length + 1,
    hasConfirmedMemorySection: system.includes("Confirmed companion memory ("),
    hasExpectedMemory: hasMemory,
    systemContainsOriginal: system.includes(original),
    historyContainsOriginal: request.messages.some((message) => message.role === "user" && message.content.includes(original)),
    historyContainsEarlierMemoryAnswer: request.messages.some((message) => message.role === "assistant" && message.content.includes(replyWithMemory)),
    query: lastUser,
  });
  const content = hasMemory ? replyWithMemory : replyWithoutMemory;
  return new Response(
    "data: " + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) + "\n\n" +
    "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 } }) + "\n\n" +
    "data: [DONE]\n\n",
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
};

try {
  port = await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
    });
  });
  baseURL = `http://127.0.0.1:${port}`;
  
  await mkdir(evidenceDir, { recursive: true });
  app = await createApp({
    dataDir, port: 0, devOrigin: baseURL,
    deepseekApiKey: "synthetic-companion-test", llmFetch: syntheticModel,
    freeSearchDisabled: true, browserProvider: "none", moliPath: "/nonexistent-isolated-test-moli",
    skillCatalog: [], integrationCredentials: {},
  });
  const apiAddress = await app.listen();
  vite = await createServer({
    root, configFile: false, envFile: false,
    plugins: [privateDataPlugin(), react()],
    define: {
      "import.meta.env.VITE_STORAGE_MODE": '"server"',
      "import.meta.env.VITE_BACKEND_V1": '"false"',
    },
    optimizeDeps: { entries: ["index.html"], esbuildOptions: { target: "es2022" } },
    server: {
      host: "127.0.0.1", port, strictPort: true,
      fs: { strict: true, deny: privateFsDeny },
      proxy: { "/api": { target: `http://127.0.0.1:${apiAddress.port}`, changeOrigin: false } },
      // Acceptance uses one fixed source snapshot; no watchers or HMR are needed.
      watch: null,
    },
  });
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const state = async () => {
    const response = await page.request.get(baseURL + "/api/state");
    assert.equal(response.status(), 200);
    return (await response.json()).state;
  };
  const activeData = async () => {
    const snapshot = await state();
    return snapshot.workspaces.find((workspace) => workspace.id === snapshot.active).data;
  };
  const noOverflow = async (label) => {
    const geometry = await page.evaluate(() => ({
      viewport: innerWidth, document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    assert.ok(geometry.document <= geometry.viewport + 1 && geometry.body <= geometry.viewport + 1,
      `${label}: horizontal overflow ${JSON.stringify(geometry)}`);
    check(label, geometry);
  };
  const composerControlsDoNotOverlap = async () => {
    const controls = {};
    for (const name of ["Model settings", "Execution mode", "Safety and permissions", "Send message"]) {
      const control = page.locator(".rt-composer").getByRole("button", { name, exact: true });
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      assert.ok(box && box.width > 0 && box.height > 0, `${name}: missing visible bounds`);
      assert.ok(box.x >= 0 && box.x + box.width <= 391, `${name}: clipped at 390px viewport`);
      controls[name] = box;
    }
    const names = Object.keys(controls);
    for (let first = 0; first < names.length; first++) for (let second = first + 1; second < names.length; second++) {
      const a = controls[names[first]], b = controls[names[second]];
      const horizontal = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const vertical = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      assert.ok(horizontal <= 0.5 || vertical <= 0.5,
        `${names[first]} overlaps ${names[second]}: ${JSON.stringify(controls)}`);
    }
    check("390px composer model, mode, permissions and send controls are visible without overlap", controls);
  };
  const screenshot = async (name) => {
    await page.screenshot({ path: path.join(evidenceDir, name), fullPage: true });
    report.screenshots.push(name);
  };
  const waitSaved = () => expect(page.getByLabel("Storage status", { exact: true })).toHaveText("Saved to local server");
  const goCompanion = async () => {
    await page.goto(baseURL + "/companion");
    await expect(page.getByRole("heading", { name: "让分身慢慢认识你" })).toBeVisible();
    await waitSaved();
  };
  const send = async (text) => {
    const priorCount = providerCalls.length;
    const assistantCount = await page.locator(".rt-message.assistant:not([aria-label])").count();
    await expect(page.getByLabel("Follow-up message", { exact: true })).toBeEnabled();
    await page.getByLabel("Follow-up message", { exact: true }).fill(text);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => providerCalls.length).toBe(priorCount + 1);
    await expect(page.locator(".rt-message.assistant:not([aria-label])")).toHaveCount(assistantCount + 1);
    await expect(page.getByLabel("Follow-up message", { exact: true })).toBeEnabled();
    await expect(page.getByLabel("Durable run status")).toContainText("Result saved by the server.");
    await waitSaved();
  };

  await page.goto(baseURL + "/companion");
  await page.getByLabel("Password", { exact: true }).fill("isolated-companion-owner-password");
  await page.getByLabel("Confirm password", { exact: true }).fill("isolated-companion-owner-password");
  await page.getByRole("button", { name: "Create owner account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "让分身慢慢认识你" })).toBeVisible();
  check("isolated owner setup with real authentication and CSRF");

  await page.getByRole("button", { name: "创建个人分身", exact: true }).click();
  await page.getByLabel("分身名字", { exact: true }).fill("小予");
  await page.getByLabel("一句介绍", { exact: true }).fill("记住日常的喜好，一起理清新想法。");
  await page.getByRole("button", { name: "保存分身", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".companion-identity h2")).toHaveText("小予");
  const initialData = await activeData();
  assert.equal(initialData.agents.filter((agent) => agent.companion).length, 1);
  check("personal companion created and saved");

  await page.getByRole("button", { name: "和分身聊聊", exact: true }).click();
  await expect(page).toHaveURL(/\/thread\//);
  const threadId = new URL(page.url()).pathname.split("/")[2];
  await send(original);
  assert.equal(providerCalls.at(-1).hasConfirmedMemorySection, false);
  const firstData = await activeData();
  const thread = firstData.threads.find((item) => item.id === threadId);
  assert.equal(thread.companionAgentId, firstData.agents[0].id);
  assert.equal(thread.config.agentId, firstData.agents[0].id);
  assert.equal(thread.roomId, undefined);
  assert.ok(thread.messages.some((message) => message.role === "user" && message.text === original));
  check("real durable self-chat saved user and synthetic assistant messages");

  await page.getByRole("button", { name: "整理为记忆", exact: true }).first().click();
  const candidateDialog = page.getByRole("dialog", { name: "整理候选记忆", exact: true });
  await expect(candidateDialog.getByLabel("要记住的内容", { exact: true })).toHaveValue(original);
  await candidateDialog.getByLabel("要记住的内容", { exact: true }).fill(memoryText);
  await candidateDialog.getByLabel("类别", { exact: true }).selectOption("喜好");
  await candidateDialog.getByRole("button", { name: "保存候选", exact: true }).click();
  await expect(candidateDialog).toHaveCount(0);
  await expect(page.locator(".companion-memory .companion-state")).toHaveText("待确认");
  const pendingMemory = (await activeData()).memories[0];
  assert.equal(pendingMemory.companion.status, "pending");
  assert.equal(pendingMemory.companion.visibility, "private");
  assert.equal(pendingMemory.companion.source.quote, original);
  assert.equal(pendingMemory.pinned, false);
  check("user source edited into pending private unpinned candidate");

  await page.getByRole("button", { name: "继续自聊", exact: true }).click();
  await send("我喝茶有什么喜好？");
  assert.equal(providerCalls.at(-1).hasConfirmedMemorySection, false);
  check("pending candidate excluded from model system context");
  await goCompanion();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.locator(".companion-memory .companion-state")).toHaveText("已确认");
  await waitSaved();
  await noOverflow("desktop companion has no horizontal overflow");
  await screenshot("companion-desktop.png");
  await page.getByRole("button", { name: "继续自聊", exact: true }).click();
  await send("我喝茶有什么喜好？请用一句话回答。");
  assert.equal(providerCalls.at(-1).hasExpectedMemory, true);
  const finalAssistant = page.locator(".rt-message.assistant:not([aria-label])").last();
  await expect(finalAssistant.locator(".rt-answer")).toContainText(replyWithMemory);
  await finalAssistant.locator("summary").filter({ hasText: "本轮提供的分身记忆" }).click();
  await expect(finalAssistant.locator("blockquote")).toContainText(memoryText);
  const confirmedData = await activeData();
  const savedAnswer = confirmedData.threads.find((item) => item.id === threadId).messages.at(-1);
  assert.equal(savedAnswer.knowledgeHints.memorySnapshots[0].id, pendingMemory.id);
  assert.equal(savedAnswer.knowledgeHints.memorySnapshots[0].content, memoryText);
  assert.equal(savedAnswer.knowledgeHints.memorySnapshots[0].visibility, "private");
  check("confirmed relevant memory actually reaches provider and answer snapshot");
  await screenshot("self-chat-desktop.png");

  await page.reload();
  const persistedAnswer = page.locator(".rt-message.assistant:not([aria-label])").last();
  await expect(persistedAnswer.locator(".rt-answer")).toContainText(replyWithMemory);
  await persistedAnswer.locator("summary").filter({ hasText: "本轮提供的分身记忆" }).click();
  await expect(persistedAnswer.locator("blockquote")).toContainText(memoryText);
  await goCompanion();
  await expect(page.locator(".companion-memory .companion-state")).toHaveText("已确认");
  check("profile, memory, chat and memory snapshot survive reload");

  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow("390px companion has no horizontal overflow");
  await screenshot("companion-mobile.png");
  await page.locator(".companion-memory").scrollIntoViewIfNeeded();
  await page.locator(".companion-source-details summary").click();
  await screenshot("companion-memory-mobile.png");
  await page.getByRole("button", { name: "继续自聊", exact: true }).click();
  await expect(page.getByLabel("Follow-up message", { exact: true })).toBeVisible();
  const mobileAnswer = page.locator(".rt-message.assistant:not([aria-label])").last();
  await expect(mobileAnswer.locator(".rt-answer")).toContainText(replyWithMemory);
  await mobileAnswer.locator("summary").filter({ hasText: "本轮提供的分身记忆" }).click();
  await mobileAnswer.locator("blockquote").scrollIntoViewIfNeeded();
  await noOverflow("390px self-chat has no horizontal overflow");
  await composerControlsDoNotOverlap();
  await screenshot("self-chat-mobile.png");
  await page.setViewportSize({ width: 1440, height: 1000 });

  await goCompanion();
  await page.getByRole("button", { name: "撤回", exact: true }).click();
  await expect(page.locator(".companion-memory .companion-state")).toHaveText("待确认");
  await waitSaved();
  await page.getByRole("button", { name: "继续自聊", exact: true }).click();
  await send("请再说说我喝茶有什么喜好？");
  assert.equal(providerCalls.at(-1).hasConfirmedMemorySection, false);
  assert.equal(providerCalls.at(-1).hasExpectedMemory, false);
  assert.equal(providerCalls.at(-1).historyContainsOriginal, true);
  assert.equal(providerCalls.at(-1).historyContainsEarlierMemoryAnswer, true);
  await expect(page.locator(".rt-message.assistant:not([aria-label])").last().locator(".rt-answer")).toContainText(replyWithoutMemory);
  check("withdrawal excludes memory from new system context despite old chat history");

  await goCompanion();
  await page.locator(".companion-memory").getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("要记住的内容", { exact: true }).fill("我喝茶时喜欢淡一些。");
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(page.locator(".companion-memory-content")).toHaveText("我喝茶时喜欢淡一些。");
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(page.locator(".companion-memory .companion-state")).toHaveText("已拒绝");
  await waitSaved();
  await page.getByRole("button", { name: "查看记忆操作历史", exact: true }).click();
  const historyDialog = page.getByRole("dialog", { name: "记忆操作历史", exact: true });
  for (const action of ["创建候选", "确认", "撤回", "编辑", "拒绝"])
    await expect(historyDialog.getByText(action, { exact: true })).toBeVisible();
  await historyDialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "删除记忆", exact: true }).click();
  await page.getByRole("alertdialog", { name: "删除这条记忆？", exact: true }).getByRole("button", { name: "删除记忆", exact: true }).click();
  await expect(page.locator(".companion-memory")).toHaveCount(0);
  await waitSaved();
  assert.equal((await activeData()).memories.length, 0);
  check("edit, reject, operation history and delete persist through real API");

  await page.getByRole("button", { name: "添加候选", exact: true }).click();
  await page.getByLabel("要记住的内容", { exact: true }).fill("原工作区的私有候选，仅用于隔离验收。");
  await page.getByRole("button", { name: "保存候选", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await waitSaved();
  const beforeSwitch = await state();
  await page.goto(baseURL + "/memories");
  await expect(page.getByRole("heading", { name: "Memories", exact: true })).toBeVisible();
  await expect(page.getByText("原工作区的私有候选，仅用于隔离验收。", { exact: true })).toHaveCount(0);
  await expect(page.locator(".rp-memory-list article")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "分身记忆 · 1", exact: true })).toBeVisible();
  check("generic Memories excludes companion candidates and links to their dedicated manager");
  await page.goto(baseURL + "/workspaces");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  const workspaceDialog = page.getByRole("dialog", { name: "Create workspace", exact: true });
  await workspaceDialog.getByLabel("Workspace name", { exact: true }).fill("隔离工作区");
  await workspaceDialog.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByLabel("Task prompt", { exact: true })).toBeVisible();
  await waitSaved();
  await goCompanion();
  await expect(page.getByRole("button", { name: "创建个人分身", exact: true })).toBeVisible();
  await expect(page.locator(".companion-memory")).toHaveCount(0);
  const afterSwitch = await state();
  assert.notEqual(afterSwitch.active, beforeSwitch.active);
  const newData = await activeData();
  assert.equal(newData.agents.length, 0);
  assert.equal(newData.memories.length, 0);
  assert.equal(newData.threads.length, 0);
  const preserved = afterSwitch.workspaces.find((workspace) => workspace.id === beforeSwitch.active).data;
  assert.equal(preserved.agents[0].name, "小予");
  assert.equal(preserved.memories.length, 1);
  assert.ok(preserved.threads.some((item) => item.id === threadId));
  check("workspace switching isolates companion, memories and self-chat without losing source workspace");

  // Existing workspaces can contain ordinary memories without a personal companion.
  // Use the real authenticated API to reproduce that pre-existing saved state.
  const current = await (await page.request.get(baseURL + "/api/state")).json();
  const session = await (await page.request.get(baseURL + "/api/session")).json();
  const ordinaryText = "普通工作记忆，不能当作已确认的分身记忆。";
  current.state.workspaces.find((workspace) => workspace.id === current.state.active).data.memories.push({
    id: "ordinary-memory", content: ordinaryText, category: "User Fact", importance: 3, pinned: false,
  });
  const savedOrdinary = await page.request.put(baseURL + "/api/state", {
    headers: { Origin: baseURL, "X-CSRF-Token": session.csrfToken, "If-Match": String(current.revision) },
    data: { state: current.state },
  });
  assert.equal(savedOrdinary.status(), 200, "ordinary memory setup must persist through validation");
  await page.reload();
  await expect(page.getByRole("heading", { name: "让分身慢慢认识你" })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建个人分身", exact: true })).toBeVisible();
  await expect(page.locator(".companion-memory")).toHaveCount(0);
  await expect(page.getByText(ordinaryText, { exact: true })).toHaveCount(0);
  await page.goto(baseURL + "/memories");
  await expect(page.locator(".rp-memory-list article")).toHaveCount(1);
  await expect(page.getByText(ordinaryText, { exact: true })).toBeVisible();
  check("ordinary memory with no companion renders safely and stays in generic Memories");
  assert.deepEqual(browserErrors, []);
  check("no uncaught browser errors");
  await rm(path.join(evidenceDir, "failure.png"), { force: true });
  report.passed = true;
  report.finishedAt = new Date().toISOString();
  console.log(`PASS isolated companion browser acceptance: ${checks.length} checks; ${providerCalls.length} synthetic provider calls.`);
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : "Browser acceptance failed.";
  if (page) {
    await page.screenshot({ path: path.join(evidenceDir, "failure.png"), fullPage: true }).catch(() => {});
    report.screenshots.push("failure.png");
  }
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await context?.close();
  await browser?.close();
  await vite?.close();
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
  report.temporaryPrivateDataRemoved = true;
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "results.json"), JSON.stringify(report, null, 2) + "\n");
}
