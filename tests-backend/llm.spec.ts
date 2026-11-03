import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { installManagedRuns } from "./managed-run-fixture";
import type { ChatEvent, ArtifactPatch } from "../src/llm-client";
const password = "local-e2e-owner-password-not-a-secret";
let loginCookies: Awaited<ReturnType<BrowserContext["cookies"]>> | undefined;
async function login(page: Page) {
  if (loginCookies) {
    await page.context().addCookies(loginCookies);
    await page.goto("/threads/new");
    await expect(page.getByLabel("Task prompt", { exact: true })).toBeVisible();
    return;
  }
  await page.goto("/threads/new");
  await page.getByLabel("Password", { exact: true }).fill(password);
  if (await page.getByRole("button", { name: "Create owner account", exact: true }).count()) {
    await page.getByLabel("Confirm password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Create owner account", exact: true }).click();
  } else await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Task prompt", { exact: true })).toBeVisible();
  loginCookies = await page.context().cookies();
}
async function enableMockModel(page: Page) {
  await page.route("**/api/llm/config", route => route.fulfill({ json: { configured: true, models: ["deepseek-flash", "deepseek-v4-pro"] } }));
}
async function configure(page: Page, answer: string, options: { fail?: boolean } = {}) {
  await enableMockModel(page);
  const fixture = await installManagedRuns(page, () => ({
    events: [{ type: "delta", text: answer }, options.fail ? { type: "error", message: "Test provider interrupted" } : { type: "done", model: "deepseek-flash" }],
    status: options.fail ? "failed" : "succeeded",
    ...(options.fail ? { error: "Test provider interrupted" } : {}),
  }));
  return fixture.requests;
}
async function send(page: Page, text: string, followup = false) {
  await page.getByLabel(followup ? "Follow-up message" : "Task prompt", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}
async function diagnostics(page: Page) {
  await page.locator(".rt-thread-actions > summary").click();
  await page.getByRole("button", { name: "Connection diagnostics", exact: true }).click();
}

test("LLM protocol UI: new task autostarts once, answer persists, followup uses saved IDs", async ({ page }) => {
  const requests = await configure(page, "## Generated answer\n**Real protocol** and `code`\n<script>window.untrusted = true</script>");
  await login(page); await send(page, "LLM mocked protocol test");
  await expect(page.locator(".rt-message.assistant:not([aria-label])")).toHaveCount(1);
  await expect(page.locator(".rt-message.assistant:not([aria-label]) strong").filter({ hasText: "Real protocol" })).toBeVisible();
  await expect(page.getByLabel("Storage status", { exact: true })).toHaveText("Saved to local server");
  expect(requests).toHaveLength(1);
  expect(Object.keys(requests[0]).sort()).toEqual(["threadId", "userMessageId", "workspaceId"]);
  expect(await page.evaluate(() => (window as any).untrusted)).toBeUndefined();
  await page.reload(); await expect(page.locator(".rt-message.assistant:not([aria-label])")).toHaveCount(1);
  await expect(page.locator(".rt-status")).toContainText("DeepSeek configured");
  expect(requests).toHaveLength(1);
  await send(page, "Follow-up question", true);
  await expect(page.locator(".rt-message.assistant:not([aria-label])")).toHaveCount(2);
  expect(requests).toHaveLength(2);
  expect(requests[1].threadId).toBe(requests[0].threadId);
  expect(requests[1].userMessageId).not.toBe(requests[0].userMessageId);
});

test("LLM protocol UI: interrupted partial answer is not presented as complete", async ({ page }) => {
  await configure(page, "Partial content", { fail: true }); await login(page); await send(page, "LLM interrupted protocol test");
  await expect(page.locator(".rt-message.assistant:not([aria-label])")).toContainText("Interrupted — partial answer");
  await expect(page.locator(".rt-run-failure")).toContainText("Test provider interrupted");
  await page.reload(); await expect(page.locator(".rt-message.assistant:not([aria-label])")).toContainText("Partial content");
  await expect(page.getByRole("region", { name: "Durable run status", exact: true })).toContainText("Failed");
});

test("LLM protocol UI: generated HTML becomes a real editable, sandboxed artifact", async ({ page }) => {
  await configure(page, "```html\n<!DOCTYPE html><html><body><main><h1>Generated sample</h1><script>parent.untrusted = true</script></main></body></html>\n```");
  await login(page);
  await page.getByRole("button", { name: "Add files or context", exact: true }).click();
  await page.getByRole("button", { name: "Output as…", exact: true }).click();
  await page.getByRole("button", { name: "Webpage", exact: true }).click();
  await send(page, "LLM HTML artifact test");
  await expect(page.getByRole("navigation", { name: "Select artifact", exact: true })).toContainText("LLM HTML artifact test");
  await page.getByRole("navigation", { name: "Select artifact", exact: true }).getByRole("button", { name: "LLM HTML artifact test · Webpage Webpage", exact: true }).click();
  await expect(page.locator(".rt-artifact-editor iframe")).toHaveAttribute("sandbox", "");
  expect(await page.evaluate(() => (window as any).untrusted)).toBeUndefined();
  await page.getByRole("button", { name: "Edit artifact", exact: true }).click();
  await expect(page.getByLabel("Artifact content", { exact: true })).toHaveValue(/Generated sample/);
});

test("LLM protocol UI: failed admission preserves the user message and retries only after checking saved runs", async ({ page }) => {
  await enableMockModel(page);
  const fixture = await installManagedRuns(page, (_request, index) => index === 0
    ? { events: [], admissionError: { status: 503, error: "Test provider unavailable" } }
    : { events: [{ type: "delta", text: "Retry completed." }, { type: "done", model: "deepseek-flash" }] });
  await login(page); await send(page, "LLM retry protocol test");
  await expect(page.getByRole("button", { name: "Retry viewing", exact: true })).toBeVisible();
  await expect(page.locator(".rt-run-view-error")).toContainText("Test provider unavailable");
  await expect(page.getByRole("button", { name: "Generate reply", exact: true })).toHaveCount(0);
  await expect(page.locator(".rt-message.user")).toHaveCount(1); await expect(page.locator(".rt-message.assistant:not([aria-label])")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry viewing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Generate reply", exact: true })).toBeVisible();
  expect(fixture.requests).toHaveLength(1);
  await page.getByRole("button", { name: "Generate reply", exact: true }).click();
  await expect.poll(() => fixture.requests.length).toBe(2);
  await expect(page.locator(".rt-message.assistant:not([aria-label])")).toContainText("Retry completed.");
  await expect(page.locator(".rt-message.user")).toHaveCount(1);
  expect(fixture.requests[1]).toEqual(fixture.requests[0]);
});

test("LLM lifecycle: leaving during a pending message save does not start a paid generation", async ({ page }) => {
  const requests = await configure(page, "Initial saved answer");
  await login(page); await send(page, "LLM navigation lifecycle test");
  await expect(page.locator(".rt-message.assistant:not([aria-label])")).toHaveCount(1);
  await expect(page.getByLabel("Storage status", { exact: true })).toHaveText("Saved to local server");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = new Promise<void>(resolve => { entered = resolve; });
  await page.route("**/api/state", async route => {
    if (route.request().method() === "PUT" && route.request().postData()?.includes("Delayed lifecycle followup")) { entered(); await gate; }
    await route.continue();
  });
  await send(page, "Delayed lifecycle followup", true); await pending;
  await page.locator(".sidebar").getByRole("link", { name: "New thread", exact: true }).click();
  await expect(page.getByLabel("Task prompt", { exact: true })).toBeVisible();
  release();
  await expect(page.getByLabel("Storage status", { exact: true })).toHaveText("Saved to local server");
  expect(requests).toHaveLength(1);
  await page.unroute("**/api/state");
});

test("LLM lifecycle: leaving detaches viewing while the durable answer and artifact save once in the background", async ({ page }) => {
  await enableMockModel(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = await installManagedRuns(page, () => ({ waitUntil: gate, events: [{ type: "delta", text: "```html\n<!DOCTYPE html><html><main>Lifecycle page</main></html>\n```" }, { type: "done", model: "deepseek-flash" }] }));
  await login(page);
  const before = await (await page.request.get("/api/state")).json();
  const count = before.state.workspaces.flatMap((w: any) => w.data.artifacts).length;
  try {
    await page.getByRole("button", { name: "Add files or context", exact: true }).click();
    await page.getByRole("button", { name: "Output as…", exact: true }).click();
    await page.getByRole("button", { name: "Webpage", exact: true }).click();
    await send(page, "Artifact navigation guard");
    await expect(page.getByRole("button", { name: "Stop run", exact: true })).toBeVisible();
    expect(fixture.requests).toHaveLength(1);
    const threadUrl = page.url();
    await page.locator(".sidebar").getByRole("link", { name: "New thread", exact: true }).click();
    await expect(page.getByLabel("Task prompt", { exact: true })).toBeVisible();
    release();
    const completed = await fixture.waitForCompletion(0);
    expect(completed.status).toBe("succeeded");
    expect(completed.resultSaved).toBe(true);
    const after = await (await page.request.get("/api/state")).json();
    const workspace = after.state.workspaces.find((w: any) => w.id === fixture.requests[0].workspaceId);
    const savedThread = workspace.data.threads.find((t: any) => t.id === fixture.requests[0].threadId);
    expect(savedThread.messages.filter((m: any) => m.role === "assistant")).toHaveLength(1);
    expect(savedThread.messages.at(-1).text).toContain("Lifecycle page");
    expect(after.state.workspaces.flatMap((w: any) => w.data.artifacts)).toHaveLength(count + 1);
    expect(workspace.data.artifacts.find((a: any) => a.threadId === savedThread.id).content).toContain("Lifecycle page");
    await page.goto(threadUrl);
    await expect(page.locator(".rt-message.assistant:not([aria-label])")).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "Select artifact", exact: true })).toContainText("Artifact navigation guard");
    expect(fixture.requests).toHaveLength(1);
  } finally { release(); }
});

test("workspace tools UI: document/table patches persist, tool history survives reload, updates preserve versions and CSV is safe", async ({ page }) => {
  await enableMockModel(page);
  await installManagedRuns(page, async (request, index) => {
    const timestamp = new Date().toISOString();
    const saved = await (await page.request.get("/api/state")).json();
    const ws = saved.state.workspaces.find((w: any) => w.id === request.workspaceId);
    const old = ws.data.artifacts.find((a: any) => a.id === "artifact-tool-doc-test");
    const document = old ? { ...old, content: "# Updated tool document", updatedAt: timestamp, versions: [...old.versions, { id: "version-tool-doc-test", content: old.content, createdAt: old.updatedAt }] } : { id: "artifact-tool-doc-test", title: "Tool-created document", kind: "Document", content: "# First tool document", threadId: request.threadId, versions: [], createdAt: timestamp, updatedAt: timestamp };
    const patches: ArtifactPatch[] = [{ artifact: document, ...(old ? { base: { content: old.content, title: old.title, updatedAt: old.updatedAt } } : {}) }];
    if (!old) patches.push({ artifact: { id: "artifact-tool-table-test", title: "Tool-created table", kind: "Table", content: JSON.stringify({ columns: ["Name", "Note"], rows: [["=1+1", "safe"]] }), threadId: request.threadId, versions: [], createdAt: timestamp, updatedAt: timestamp } });
    const events: ChatEvent[] = [{ type: "tool", id: "call-ui-" + index, name: old ? "update_artifact" : "create_table", status: "success", summary: "Validated artifact data prepared" }, ...patches.map(patch => ({ type: "artifact" as const, patch })), { type: "delta", text: old ? "Updated the document." : "Prepared your document and table." }, { type: "done", model: "deepseek-flash" }];
    return { events };
  });
  await login(page); await send(page, "Execute document and table tools");
  await expect(page.getByRole("navigation", { name: "Select artifact", exact: true })).toContainText("Tool-created table");
  await expect(page.getByLabel("Tool activity", { exact: true })).toContainText("Create table");
  await expect(page.getByLabel("Tool activity", { exact: true })).toContainText("Completed");
  await expect(page.getByLabel("Storage status", { exact: true })).toHaveText("Saved to local server");
  await page.getByRole("navigation", { name: "Select artifact", exact: true }).getByRole("button", { name: "Tool-created table Table", exact: true }).click();
  await expect(page.getByRole("table", { name: "Tool-created table", exact: true })).toContainText("=1+1");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const csv = await downloaded;
  expect(csv.suggestedFilename()).toBe("Tool-created table.csv");
  const fs = await import("node:fs/promises");
  expect(await fs.readFile((await csv.path())!, "utf8")).toContain("\"'=1+1\"");
  await page.reload(); await expect(page.getByLabel("Tool activity", { exact: true })).toContainText("Create table");
  await send(page, "Update that document", true);
  await expect(page.getByRole("navigation", { name: "Select artifact", exact: true })).toContainText("Tool-created document");
  await expect(page.locator(".rt-message.assistant:not([aria-label])")).toHaveCount(2);
  await page.getByRole("navigation", { name: "Select artifact", exact: true }).getByRole("button", { name: "Tool-created document Document", exact: true }).click();
  await expect(page.locator(".rt-artifact-editor")).toContainText("Updated tool document");
  await expect(page.getByRole("combobox", { name: "Artifact version", exact: true }).locator("option")).toHaveCount(2);
  const final = await (await page.request.get("/api/state")).json();
  const artifacts = final.state.workspaces.flatMap((w: any) => w.data.artifacts);
  expect(artifacts.find((a: any) => a.id === "artifact-tool-doc-test").versions[0].content).toBe("# First tool document");
  const savedThread = final.state.workspaces.flatMap((w: any) => w.data.threads).find((t: any) => t.title === "Execute document and table tools");
  const savedAnswers = savedThread.messages.filter((m: any) => m.role === "assistant");
  expect(savedAnswers[0].toolRuns[0]).toMatchObject({ name: "create_table", status: "success" });
  expect(savedAnswers[1].toolRuns[0]).toMatchObject({ name: "update_artifact", status: "success" });
});

test("connection diagnostics: page loads never spend provider credit; missing key is explicit", async ({ page }) => {
  await configure(page, "Diagnostics setup answer"); await login(page); await send(page, "Connection diagnostics missing-key test");
  await expect(page.locator(".rt-message.assistant:not([aria-label])")).toHaveCount(1);
  let paidTests = 0;
  await page.route("**/api/llm/test", route => { paidTests++; return route.abort(); });
  await diagnostics(page);
  const panel = page.getByRole("region", { name: "Connection diagnostics", exact: true });
  await expect(panel.getByText("Reachable", { exact: true })).toBeVisible();
  await expect(panel.getByText("Readable", { exact: true })).toBeVisible();
  await expect(panel.getByText("Not configured", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Run small paid test", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(panel.getByText("Readable", { exact: true })).toBeVisible();
  expect(paidTests).toBe(0);
});

test("connection diagnostics: explicit model test displays dated verified result, refresh clears it", async ({ page }) => {
  await configure(page, "Diagnostics connected answer");
  await page.route("**/api/diagnostics", route => route.fulfill({ json: { api: { status: "ready" }, database: { status: "ready", engine: "SQLite", revision: 12 }, provider: { name: "DeepSeek", configured: true, models: ["deepseek-flash", "deepseek-v4-pro"] }, runtime: { node: "24.18.0" } } }));
  const requests: unknown[] = [];
  await page.route("**/api/llm/test", route => { requests.push(route.request().postDataJSON()); return route.fulfill({ json: { status: "verified", model: "deepseek-v4-pro", checkedAt: "2026-10-29T06:00:00.000Z", latencyMs: 420, cached: false } }); });
  await login(page); await send(page, "Connection diagnostics explicit-test flow");
  await expect(page.locator(".rt-message.assistant:not([aria-label])")).toHaveCount(1);
  await diagnostics(page);
  const panel = page.getByRole("region", { name: "Connection diagnostics", exact: true });
  await expect(panel.getByText("Key configured", { exact: true })).toBeVisible(); expect(requests).toHaveLength(0);
  await panel.getByLabel("Diagnostic model", { exact: true }).selectOption("deepseek-v4-pro");
  await panel.getByRole("button", { name: "Run small paid test", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Provider verified · deepseek-v4-pro");
  await expect(panel.getByRole("status")).toContainText("420 ms");
  expect(requests).toEqual([{ model: "deepseek-v4-pro", confirmed: true }]);
  await panel.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(panel.getByText("Key configured", { exact: true })).toBeVisible();
  await expect(panel.getByRole("status")).toHaveCount(0); expect(requests).toHaveLength(1);
});

test("connection diagnostics: rejected credential is actionable, not connected", async ({ page }) => {
  await configure(page, "Diagnostics rejected answer");
  await page.route("**/api/diagnostics", route => route.fulfill({ json: { api: { status: "ready" }, database: { status: "ready", engine: "SQLite", revision: 1 }, provider: { name: "DeepSeek", configured: true, models: ["deepseek-flash"] }, runtime: { node: "24.18.0" } } }));
  await page.route("**/api/llm/test", route => route.fulfill({ json: { status: "failed", code: "AUTH_REJECTED", model: "deepseek-flash", checkedAt: "2026-10-29T06:00:00.000Z", latencyMs: 120, cached: false } }));
  await login(page); await send(page, "Connection diagnostics rejected test");
  await expect(page.locator(".rt-message.assistant:not([aria-label])")).toHaveCount(1);
  await diagnostics(page);
  const panel = page.getByRole("region", { name: "Connection diagnostics", exact: true });
  await panel.getByRole("button", { name: "Run small paid test", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("DeepSeek rejected the server credential");
  await expect(panel.getByRole("status")).not.toContainText("Provider verified");
  await expect(page.locator(".rt-status")).toContainText("Connection not verified");
});
