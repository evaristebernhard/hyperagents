// Browser → real HTTP API → temporary task database. The model and write tool
// below are test-only adapters and never call a provider or external service.
// Run after `npm run build`; install Chromium with `npx playwright install chromium`.
// TASK_UI_BROWSER_EXECUTABLE optionally selects an already-installed browser.
// TASK_UI_BROWSER_ARGS optionally supplies a JSON array of launch arguments.
// TASK_UI_ARTIFACT_DIR optionally selects the screenshots directory.
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { createApp } from "../server/app.mjs";

const projectDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distDir = path.join(projectDir, "dist");
const artifacts = path.resolve(
  process.env.TASK_UI_ARTIFACT_DIR ||
    path.join(projectDir, "test-results", "tasks-ui"),
);
const executablePath = process.env.TASK_UI_BROWSER_EXECUTABLE || undefined;
const browserArgs = process.env.TASK_UI_BROWSER_ARGS
  ? JSON.parse(process.env.TASK_UI_BROWSER_ARGS)
  : [];
assert.ok(
  Array.isArray(browserArgs) &&
    browserArgs.every((value) => typeof value === "string"),
  "TASK_UI_BROWSER_ARGS must be a JSON array of strings",
);
await access(path.join(distDir, "index.html")).catch(() => {
  throw Error("The built UI is missing. Run npm run build before this test.");
});
await mkdir(artifacts, { recursive: true });

const done = (text) => ({ text, toolCalls: [] });
const calls = (...values) => ({
  text: "",
  toolCalls: values.map(([name, args], i) => ({
    id: name + "-" + i,
    name,
    arguments: args,
  })),
});
let writes = 0;
const retries = new Set();
const documentTitle = "Document from a completed task";
const documentContent =
  "This document was saved by the built-in Documents plugin.";
let releaseDocument;
const documentReady = new Promise((resolve) => {
  releaseDocument = resolve;
});
const taskModel = {
  configured: true,
  models: ["local-ui-test-model"],
  async step({ messages, signal }) {
    const goal =
      messages.find((message) => message.role === "user")?.content || "";
    const tools = messages.filter((message) => message.role === "tool");
    if (goal === "Choose a color") {
      return messages.some(
        (message) => message.role === "user" && message.content === "Use blue",
      )
        ? done("Blue choice confirmed.")
        : calls([
            "request_user_input",
            { question: "Which color should I use?" },
          ]);
    }
    if (goal === "Parallel report" || goal === "Approval task") {
      if (
        messages.some(
          (message) =>
            message.role === "user" &&
            String(message.content).startsWith("[Runtime event; source=child]"),
        )
      )
        return done(
          goal === "Parallel report"
            ? "Combined both worker results."
            : "Approved work completed.",
        );
      if (!tools.length)
        return goal === "Parallel report"
          ? calls(
              ["delegate_task", { task: "Read source A" }],
              ["delegate_task", { task: "Read source B" }],
              ["wait_for_tasks", {}],
            )
          : calls(
              ["delegate_task", { task: "Approval worker" }],
              ["wait_for_tasks", {}],
            );
      return calls(["wait_for_tasks", {}]);
    }
    if (goal === "Read source A" || goal === "Read source B") {
      await delay(150, undefined, { signal });
      return done(goal + " result.");
    }
    if (goal === "Approval worker")
      return tools.length
        ? done("Approved action complete.")
        : calls(["local_test_write", { value: "Approved payload" }]);
    if (goal === "Save a document") {
      if (
        messages.some(
          (message) =>
            message.role === "user" &&
            String(message.content).startsWith("[Runtime event; source=child]"),
        )
      )
        return done("The document is saved in your Library.");
      return tools.length
        ? calls(["wait_for_tasks", {}])
        : calls(
            ["delegate_task", { task: "Document worker" }],
            ["wait_for_tasks", {}],
          );
    }
    if (goal === "Document worker") {
      if (tools.length) return done("Document artifact saved.");
      await documentReady;
      signal.throwIfAborted();
      return calls([
        "task_save_document",
        { title: documentTitle, content: documentContent },
      ]);
    }
    if (goal === "Cancel task demo")
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    if (goal === "Retry task demo" && !retries.has(goal)) {
      retries.add(goal);
      throw Error("Synthetic transient model failure");
    }
    return done("Task finished successfully.");
  },
};
const tool = {
  type: "function",
  function: {
    name: "local_test_write",
    description: "Write only to this isolated test counter.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
};
const agentPlugins = [
  {
    id: "fixture-actions",
    name: "Local test actions",
    description: "Isolated UI-test adapter. No external services.",
    available: true,
    defaultEnabled: true,
    tools: [
      {
        definition: tool,
        effect: "write",
        replay: "manual",
        approvalRequired: true,
      },
    ],
    bind: () => ({
      execute: async (name, args) => {
        assert.equal(name, "local_test_write");
        writes++;
        return { status: "saved", value: args.value };
      },
      close: async () => {},
    }),
  },
];

const dataDir = await mkdtemp(path.join(tmpdir(), "hyperagents-task-ui-"));
const errors = [],
  checkpoints = [];
let app, browser, page;
try {
  const noExternalFetch = async () => {
    throw Error("UI tests must not access external services.");
  };
  app = await createApp({
    dataDir,
    port: 0,
    taskModel,
    agentPlugins,
    distDir,
    freeSearchDisabled: true,
    exaApiKey: "",
    openAlexApiKey: "",
    publicFetch: noExternalFetch,
    exaFetch: noExternalFetch,
  });
  const base = "http://127.0.0.1:" + (await app.listen()).port;
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: browserArgs,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === base
      ? route.continue()
      : route.abort(),
  );
  await page.goto(base + "/tasks");
  await page
    .getByLabel("Password", { exact: true })
    .fill("isolated-task-ui-password");
  await page.getByLabel("Confirm password").fill("isolated-task-ui-password");
  await page
    .getByRole("button", { name: "Create owner account", exact: true })
    .click();
  await expect(page.getByLabel("Task description")).toBeVisible();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue(
    "local-ui-test-model",
  );
  checkpoints.push("real owner setup and runtime configuration");

  async function create(text) {
    if (!(await page.getByLabel("Task description").isVisible()))
      await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Task description").fill(text);
    await page
      .getByRole("button", { name: "Create task", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: text, exact: true }),
    ).toBeVisible();
    return page.url();
  }
  await create("Choose a color");
  await expect(page.getByLabel("Question for you")).toContainText(
    "Which color should I use?",
  );
  await page
    .getByLabel("Additional instructions")
    .fill("Unsent draft survives refresh");
  await page.getByRole("button", { name: "Refresh tasks" }).click();
  await expect(page.getByLabel("Additional instructions")).toHaveValue(
    "Unsent draft survives refresh",
  );
  await page.getByLabel("Additional instructions").fill("Use blue");
  await page.getByRole("button", { name: "Send update", exact: true }).click();
  await expect(page.getByLabel("Task result")).toContainText(
    "Blue choice confirmed.",
  );
  checkpoints.push(
    "human question, waiting-state input, and refresh preserves draft",
  );
  await page.reload();
  await expect(page.getByLabel("Task result")).toContainText(
    "Blue choice confirmed.",
  );
  checkpoints.push("reload restores persisted result");

  await page
    .getByRole("button", { name: "Prompt settings", exact: true })
    .click();
  const original = await page.getByLabel("Prompt instructions").inputValue();
  const versionLabel = page
    .getByLabel("Prompt settings", { exact: true })
    .getByText(/^Version /);
  const originalVersion = await versionLabel.getAttribute("title");
  assert.ok(originalVersion);
  await page
    .getByLabel("Prompt instructions")
    .fill(original + "\n\nPrefer concise user updates.");
  await page.getByRole("button", { name: "Save prompt", exact: true }).click();
  await expect(
    page.getByText("Prompt saved for new tasks.", { exact: true }),
  ).toBeVisible();
  await expect(versionLabel).not.toHaveAttribute("title", originalVersion);
  await page.getByLabel("Built-in prompt").selectOption("worker");
  await expect(page.getByLabel("Prompt instructions")).not.toHaveValue(
    original,
  );
  await page.getByLabel("Built-in prompt").selectOption("router");
  await expect(page.getByLabel("Prompt instructions")).toHaveValue(
    original + "\n\nPrefer concise user updates.",
  );
  await page
    .getByRole("button", { name: "Restore default", exact: true })
    .click();
  await expect(page.getByLabel("Prompt instructions")).toHaveValue(original);
  await expect(versionLabel).toHaveAttribute("title", originalVersion);
  await page.getByRole("button", { name: "Close prompt settings" }).click();
  checkpoints.push(
    "prompt save, role switch, version update and default restore",
  );

  const parallelUrl = await create("Parallel report");
  await expect(page.getByLabel("Task result")).toContainText(
    "Combined both worker results.",
  );
  await expect(page.getByLabel("Subtasks").getByRole("button")).toHaveCount(2);
  await page.getByLabel("Subtasks").getByRole("button").first().click();
  await expect(page.getByLabel("Task result")).toContainText(
    "Read source A result.",
  );
  await page.getByRole("button", { name: "Parent task", exact: true }).click();
  await expect(page).toHaveURL(parallelUrl);
  checkpoints.push("root and child task tree with result navigation");

  const approvalUrl = await create("Approval task");
  await expect(page.getByLabel("Subtasks").getByRole("button")).toHaveCount(1);
  await page.getByLabel("Subtasks").getByRole("button").click();
  await expect(
    page.getByRole("button", { name: "Approve local_test_write", exact: true }),
  ).toBeVisible();
  assert.equal(writes, 0);
  await page
    .getByRole("button", { name: "Approve local_test_write", exact: true })
    .click();
  await expect(page.getByLabel("Task result")).toContainText(
    "Approved action complete.",
  );
  assert.equal(writes, 1);
  await page.goto(approvalUrl);
  await expect(page.getByLabel("Task result")).toContainText(
    "Approved work completed.",
  );
  checkpoints.push(
    "real durable approval card and exactly one isolated plugin effect",
  );

  await create("Cancel task demo");
  await expect(
    page.getByLabel("Task details").getByText("Working", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  await expect(
    page.getByLabel("Task details").getByText("Cancelled", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry task", exact: true }),
  ).toHaveCount(0);
  checkpoints.push("explicit cancellation remains terminal");

  await create("Retry task demo");
  await expect(
    page.getByRole("button", { name: "Retry task", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry task", exact: true }).click();
  await expect(page.getByLabel("Task result")).toContainText(
    "Task finished successfully.",
  );
  checkpoints.push("failed task retries and persists its result");

  async function createAndRead(text) {
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/tasks",
    );
    await create(text);
    const body = await (await response).json();
    await expect(page).toHaveURL(base + "/tasks/" + body.task.id);
    return body.task;
  }
  const firstSame = await createAndRead("Intentional repeated task");
  const secondSame = await createAndRead("Intentional repeated task");
  assert.notEqual(
    firstSame.id,
    secondSame.id,
    "intentional same-text tasks must receive fresh request IDs after success",
  );
  const inputIds = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    await page
      .getByLabel("Additional instructions")
      .fill("Intentional repeated update");
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          "/api/tasks/" + secondSame.id + "/inputs",
    );
    await page
      .getByRole("button", { name: "Send update", exact: true })
      .click();
    inputIds.push((await (await response).json()).input.id);
    await expect(page.getByLabel("Additional instructions")).toHaveValue("");
  }
  assert.notEqual(
    inputIds[0],
    inputIds[1],
    "intentional repeated updates must remain distinct after success",
  );
  const repeatedDetail = await (
    await page.request.get(
      base +
        "/api/tasks/" +
        secondSame.id +
        "?workspaceId=" +
        secondSame.workspaceId,
    )
  ).json();
  assert.equal(
    repeatedDetail.inputs.filter(
      (input) => input.text === "Intentional repeated update",
    ).length,
    2,
  );
  checkpoints.push(
    "intentional same-text tasks and updates get distinct persisted request IDs",
  );

  await create("Save a document");
  await page
    .getByLabel("Additional instructions")
    .fill("Keep this unsent task draft");
  const refreshedDocument = page.waitForResponse(async (response) => {
    if (
      response.request().method() !== "GET" ||
      new URL(response.url()).pathname !== "/api/state" ||
      !response.ok()
    )
      return false;
    const snapshot = await response.json();
    return snapshot.state.workspaces.some((workspace) =>
      workspace.data.artifacts.some(
        (artifact) => artifact.title === documentTitle,
      ),
    );
  });
  releaseDocument();
  await expect(page.getByLabel("Task result")).toContainText(
    "The document is saved in your Library.",
  );
  await refreshedDocument;
  await expect(
    page.getByRole("alertdialog", { name: "Updating workspace snapshot" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Additional instructions")).toHaveValue(
    "Keep this unsent task draft",
  );
  const documentLifetime = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: documentTitle, exact: true }),
  ).toBeVisible();
  assert.equal(
    await page.evaluate(() => performance.timeOrigin),
    documentLifetime,
    "task artifacts must appear without a full-page reload",
  );
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", { name: documentTitle, exact: true }),
    })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Artifact preview" }),
  ).toContainText(documentContent);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editedContent = documentContent + "\n\nEdited after task completion.";
  await page.getByLabel("Content", { exact: true }).fill(editedContent);
  const saveAfterTask = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === "/api/state",
  );
  await page
    .getByRole("button", { name: "Save artifact", exact: true })
    .click();
  assert.equal(
    (await saveAfterTask).status(),
    200,
    "the refreshed revision must allow the next user edit",
  );
  const savedSnapshot = await (
    await page.request.get(base + "/api/state")
  ).json();
  assert.equal(
    savedSnapshot.state.workspaces
      .flatMap((workspace) => workspace.data.artifacts)
      .find((artifact) => artifact.title === documentTitle)?.content,
    editedContent,
  );
  checkpoints.push(
    "built-in Documents output reaches Library without page reload; task draft survives and the next edit saves",
  );
  await page.goto(parallelUrl);
  await expect(page.getByLabel("Task result")).toContainText(
    "Combined both worker results.",
  );
  await page.screenshot({
    path: path.join(artifacts, "tasks-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Task details")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  assert.equal(overflow, false, "mobile layout must not overflow horizontally");
  await page.screenshot({
    path: path.join(artifacts, "tasks-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  checkpoints.push("desktop and mobile layouts; no uncaught page errors");
  console.log(
    JSON.stringify(
      {
        passed: checkpoints,
        pluginWrites: writes,
        screenshots: ["tasks-desktop.png", "tasks-mobile.png"].map((name) =>
          path.join(artifacts, name),
        ),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error("Completed checks:", checkpoints);
  if (page) {
    await page
      .screenshot({
        path: path.join(artifacts, "tasks-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
    console.error(
      (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(-9000),
    );
  }
  throw error;
} finally {
  releaseDocument();
  try {
    await browser?.close();
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}
