// Deterministic browser coverage; every API request is intercepted, no model or DB.
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import assert from "node:assert/strict";
import privateDataPlugin from "./private-data.mjs";
const server = await createServer({
  configFile: false,
  plugins: [privateDataPlugin(), react()],
  define: { "import.meta.env.VITE_BACKEND_V1": '"true"' },
  server: {
    host: "127.0.0.1",
    port: 5184,
    strictPort: true,
    watch: {
      ignored: [
        "**/backend/**",
        "**/OpenMausBot/**",
        "**/browser/**",
        "**/macro/**",
      ],
    },
  },
});
await server.listen();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addInitScript(() =>
  localStorage.setItem("hyperagents:v1:csrf", "test-csrf"),
);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const date = "2026-11-03T00:00:00Z";
const taskId = "00000000-0000-4000-a000-000000000001",
  conversationId = "00000000-0000-4000-a000-000000000002";
let created = false,
  lost = false,
  expired = false,
  loseEvents = false;
const keys = [],
  cursors = [];
const events = Array.from({ length: 105 }, (_, i) => ({
  id: String(i + 1),
  created_at: date,
  payload: { type: "tool", name: "file_read", status: "completed" },
}));
const task = {
  id: taskId,
  conversationId,
  prompt: "A durable task",
  state: "running",
};
const conversation = {
  id: conversationId,
  title: "A durable task",
  created_at: date,
  messages: [{ id: "1", role: "user", content: task.prompt, created_at: date }],
  artifacts: [],
};
await context.route("**/api/**", async (route) => {
  const request = route.request(),
    url = new URL(request.url()),
    path = url.pathname.replace("/api/v1", "");
  const reply = (body, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  if (!url.pathname.startsWith("/api/v1/"))
    throw Error("Unexpected legacy API: " + url.pathname);
  if (expired) return reply({ error: "UNAUTHENTICATED" }, 401);
  if (path === "/auth/session")
    return reply({ userId: "user", workspaceId: "workspace", admin: true });
  if (path === "/capabilities")
    return reply({
      models: [{ provider: "deepseek", model: "test-model", configured: true }],
      search: { provider: "public-bing-rss", degraded: true },
      sandbox: { available: false },
      formats: ["md", "pdf"],
      externalActions: false,
    });
  if (path === "/conversations") return reply(created ? [conversation] : []);
  if (path.startsWith("/conversations/")) return reply(conversation);
  if (path === "/tasks" && request.method() === "POST") {
    keys.push(request.headers()["idempotency-key"]);
    created = true;
    if (!lost) {
      lost = true;
      return route.abort("failed");
    }
    return reply({ taskId }, 202);
  }
  if (path.endsWith("/instructions")) {
    assert.equal(request.postDataJSON().message, "Use blue");
    task.state = "running";
    return reply({ accepted: true });
  }
  if (path.endsWith("/cancel")) {
    assert.equal(
      request.headers()["content-type"],
      undefined,
      "empty mutations must not send a JSON content type",
    );
    task.state = "cancelled";
    return reply({ cancelled: true });
  }
  if (path === "/tasks") return reply(created ? [task] : []);
  if (path === "/tasks/" + taskId) return reply(task);
  if (path.endsWith("/events")) {
    const after = Number(url.searchParams.get("after") || 0);
    cursors.push(after);
    if (loseEvents) {
      loseEvents = false;
      return route.abort("failed");
    }
    const rows = events.filter((e) => Number(e.id) > after).slice(0, 100);
    return reply({
      events: rows,
      nextCursor: rows.at(-1)?.id || String(after),
    });
  }
  return reply({ error: "UNSUPPORTED_TEST_ROUTE" }, 404);
});
try {
  await page.goto("http://localhost:5184");
  await page.getByRole("heading", { name: "Let's get to work." }).waitFor();
  await page.getByRole("button", { name: "Add files or context" }).click();
  await page.getByRole("button", { name: "Output as…" }).click();
  assert.equal(
    await page
      .getByRole("checkbox", { name: "PDF · Unavailable" })
      .isDisabled(),
    true,
  );
  await page.keyboard.press("Escape");
  await page.getByLabel("Task prompt").fill(task.prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("alert").waitFor();
  await page.getByRole("button", { name: "Send message" }).click();
  await page.locator("[data-task-id]").waitFor();
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  await page.waitForFunction(
    () => document.querySelectorAll("[data-event-id]").length === 105,
  );
  assert.ok(cursors.includes(0) && cursors.includes(100));
  loseEvents = true;
  await page.getByRole("alert").waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Retry connection" }).click();
  await page.getByRole("alert").waitFor({ state: "hidden" });
  assert.ok(cursors.includes(105));
  assert.equal(await page.locator("[data-event-id]").count(), 105);
  await page.reload();
  await page.waitForFunction(
    () => document.querySelectorAll("[data-event-id]").length === 105,
  );
  assert.equal(
    new Set(
      await page
        .locator("[data-event-id]")
        .evaluateAll((nodes) => nodes.map((n) => n.dataset.eventId)),
    ).size,
    105,
  );
  task.state = "waiting_user";
  events.push({
    id: "106",
    created_at: date,
    payload: {
      type: "tool",
      name: "ask_user",
      status: "completed",
      result: { question: "Which color should I use?" },
    },
  });
  await page
    .getByText("Which color should I use?", { exact: true })
    .waitFor({ timeout: 20000 });
  await page.getByLabel("Follow-up message").fill("Use blue");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-task-state]")
        ?.getAttribute("data-task-state") === "running",
  );
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-task-state]")
        ?.getAttribute("data-task-state") === "cancelled",
  );
  expired = true;
  await page.getByLabel("Email", { exact: true }).waitFor({ timeout: 20000 });
  assert.equal(await page.locator("[data-conversation-id]").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS unavailable capabilities, lost-response idempotency, 105-event pagination, disconnect cursor recovery, refresh deduplication, waiting-user question and follow-up, bodyless cancellation, session teardown",
  );
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
