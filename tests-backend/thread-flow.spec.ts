import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
const ownerPassword = "local-e2e-owner-password-not-a-secret";
test.describe.configure({ mode: "serial" });
async function signedIn(page: Page) {
  await page.goto("/threads/new");
  // Password inputs have no textbox role in all browser accessibility trees.
  const input = page.getByLabel("Password", { exact: true });
  const setup = page.getByRole("button", { name: "Create owner account", exact: true });
  await expect(input).toBeVisible();
  await input.fill(ownerPassword);
  if (await setup.count()) {
    await page.getByLabel("Confirm password", { exact: true }).fill(ownerPassword);
    await setup.click();
  } else await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Task prompt", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Storage status", { exact: true })).toHaveText("Saved to local server");
}
async function createThread(page: Page, title: string) {
  await page.goto("/threads/new");
  await page.getByLabel("Task prompt", { exact: true }).fill(title);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page).toHaveURL(/\/thread\/thread-/);
  await expect(page.locator(".rt-title h1")).toHaveText(title);
  await expect(page.getByLabel("Storage status", { exact: true })).toHaveText("Saved to local server");
  return new URL(page.url()).pathname.split("/")[2];
}
async function document(page: Page, title: string, text: string) {
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await page.getByRole("button", { name: "Edit artifact", exact: true }).click();
  await page.getByLabel("Artifact title", { exact: true }).fill(title);
  await page.getByLabel("Artifact content", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Save artifact", exact: true }).click();
  await expect(page.getByLabel("Storage status", { exact: true })).toHaveText("Saved to local server");
}
async function state(page: Page) { return (await page.request.get("/api/state")).json(); }
test.beforeEach(async ({ page }) => { await signedIn(page); });

test("fresh database has no demo threads; configuration, actual upload bytes and message survive reload", async ({ page }) => {
  await expect(page.locator(".sidebar").getByText("Welcome to Hyperagent", { exact: true })).toHaveCount(0);
  await page.goto("/threads/new?settings=thread-defaults");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByLabel("Default model preference").fill("saved-model-preference");
  await settings.getByRole("button", { name: "Save default thread settings", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("saved to the local server");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add files or context", exact: true }).click();
  await page.getByRole("button", { name: "Add to a project", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Select projects", exact: true });
  await picker.getByRole("button", { name: "Create new project…", exact: true }).click();
  await picker.getByLabel("Project name", { exact: true }).fill("Server-backed project");
  await picker.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(picker).not.toBeVisible();
  const bytes = Buffer.from("This is actual uploaded data, not a filename placeholder.\n");
  await page.getByLabel("Attach files", { exact: true }).setInputFiles({ name: "evidence.txt", mimeType: "text/plain", buffer: bytes });
  await expect(page.getByRole("button", { name: "Remove attachment evidence.txt", exact: true })).toBeVisible();
  await page.getByLabel("Task prompt", { exact: true }).fill("Real persisted conversation");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page).toHaveURL(/\/thread\/thread-/);
  await expect(page.locator(".rt-message.assistant")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".rt-title h1")).toHaveText("Real persisted conversation");
  await expect(page.locator(".rt-message.user")).toHaveCount(1);
  const saved = await state(page);
  const workspace = saved.state.workspaces.find((w: any) => w.id === saved.state.active);
  const thread = workspace.data.threads.find((t: any) => t.title === "Real persisted conversation");
  expect(thread.config.model).toBe("saved-model-preference");
  expect(thread.projectId).toBe(workspace.data.projects.find((p: any) => p.name === "Server-backed project").id);
  expect(thread.messages[0].context.attachments[0].size).toBe(bytes.length);
  const downloadPromise = page.waitForEvent("download");
  await page.locator(".rt-attachments").getByRole("link", { name: "evidence.txt", exact: true }).click();
  const downloaded = await downloadPromise;
  expect(downloaded.suggestedFilename()).toBe("evidence.txt");
  expect(await fs.readFile((await downloaded.path())!)).toEqual(bytes);
});

test("rename, follow-up, artifact editing, real history restore and fork persist", async ({ page }) => {
  await createThread(page, "Artifact lifecycle");
  await page.getByRole("button", { name: "Rename thread", exact: true }).click();
  await page.getByLabel("Thread title", { exact: true }).fill("Renamed conversation");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await page.getByLabel("Follow-up message", { exact: true }).fill("A real second user message");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".rt-message.user")).toHaveCount(2);
  await expect(page.locator(".rt-message.assistant")).toHaveCount(0);
  await document(page, "Versioned notes", "First durable content");
  await page.getByRole("button", { name: "Edit artifact", exact: true }).click();
  await page.getByLabel("Artifact content", { exact: true }).fill("Second durable content");
  await page.getByRole("button", { name: "Save artifact", exact: true }).click();
  const versions = page.getByRole("combobox", { name: "Artifact version", exact: true });
  const prior = await versions.locator("option").nth(1).getAttribute("value");
  await versions.selectOption(prior!);
  await page.getByRole("button", { name: "Restore this version", exact: true }).click();
  await expect(page.locator(".rt-artifact-editor")).toContainText("First durable content");
  await page.getByRole("button", { name: "Fork thread", exact: true }).click();
  await expect(page.locator(".rt-title h1")).toHaveText("Renamed conversation (fork)");
  await expect(page.locator(".rt-message.user")).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Select artifact", exact: true })).toContainText("Versioned notes");
});

test("share is an immutable read-only snapshot and revocation removes anonymous access", async ({ page, browser }) => {
  await createThread(page, "Snapshot publication");
  await document(page, "Public notes", "Public artifact version one");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share thread snapshot", exact: true });
  await dialog.getByRole("checkbox", { name: /Public notes/ }).check();
  await dialog.getByRole("checkbox", { name: /I confirm/ }).check();
  await dialog.getByRole("button", { name: "Publish snapshot", exact: true }).click();
  const link = dialog.getByRole("link").filter({ hasText: "/share/" }).first();
  await expect(link).toBeVisible();
  const url = await link.getAttribute("href");
  const anonymous = await browser.newContext();
  const publicPage = await anonymous.newPage();
  const ownerRequests: string[] = [];
  publicPage.on("request", request => { if (/\/api\/(session|state|files)(?:[/?]|$)/.test(request.url())) ownerRequests.push(request.url()); });
  await publicPage.goto("http://127.0.0.1:5174" + url);
  await expect(publicPage.getByRole("heading", { name: "Snapshot publication", exact: true })).toBeVisible();
  await expect(publicPage.getByRole("region", { name: "Shared artifacts", exact: true })).toContainText("Public artifact version one");
  expect(ownerRequests).toEqual([]);
  expect((await anonymous.request.get("http://127.0.0.1:5174/api/state")).status()).toBe(401);
  await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(dialog.getByText("Revoked", { exact: true })).toBeVisible();
  await publicPage.reload();
  await expect(publicPage.getByRole("alert")).toContainText("revoked");
  await anonymous.close();
});

test("a stale revision cannot silently overwrite another writer", async ({ page }) => {
  const id = await createThread(page, "Conflict source");
  const current = await state(page);
  const session = await (await page.request.get("/api/session")).json();
  const workspace = current.state.workspaces.find((w: any) => w.id === current.state.active);
  workspace.data.threads.find((t: any) => t.id === id).title = "Other writer saved this";
  const written = await page.request.put("/api/state", { headers: { Origin: "http://127.0.0.1:5174", "X-CSRF-Token": session.csrfToken, "If-Match": String(current.revision) }, data: { state: current.state } });
  expect(written.status()).toBe(200);
  await page.getByRole("button", { name: "Rename thread", exact: true }).click();
  await page.getByLabel("Thread title", { exact: true }).fill("This must not overwrite silently");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByLabel("Storage status", { exact: true })).toContainText("Conflicting changes");
  expect((await state(page)).state.workspaces.find((w: any) => w.id === current.state.active).data.threads.find((t: any) => t.id === id).title).toBe("Other writer saved this");
  await page.getByRole("dialog", { name: "Rename thread", exact: true }).getByRole("button", { name: "Close dialog", exact: true }).click();
  page.once("dialog", dialog => void dialog.accept());
  await page.getByRole("button", { name: "Reload server version", exact: true }).click();
  await expect(page.locator(".rt-title h1")).toHaveText("Other writer saved this");
});

test("browser migration is previewed and appends a copy without changing source or existing server data", async ({ page }) => {
  const previous = await state(page);
  const legacy = { version: 1, active: "old-browser", workspaces: [{ id: "old-browser", name: "Old browser", data: Object.fromEntries(["threads", "projects", "agents", "memories", "skills", "rooms", "artifacts", "schedules", "rubrics", "reviewedSuggestions", "connections"].map(name => [name, name === "threads" ? [{ id: "legacy-thread", title: "Previously local", summary: "", time: "", messages: [{ role: "user", text: "Legacy user data" }] }] : []])) }] };
  const original = JSON.stringify(legacy);
  await page.evaluate(value => localStorage.setItem("hyperagents-demo:workspace-v1", value), original);
  await page.reload();
  await page.getByRole("button", { name: "Preview browser import", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm browser import", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel import", exact: true }).click();
  expect((await state(page)).state.workspaces.length).toBe(previous.state.workspaces.length);
  await page.getByRole("button", { name: "Preview browser import", exact: true }).click();
  await page.getByRole("checkbox", { name: "I understand and want to import a copy.", exact: true }).check();
  await page.getByRole("button", { name: "Confirm browser import", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm browser import", exact: true })).toHaveCount(0);
  const after = await state(page);
  expect(after.state.workspaces.length).toBe(previous.state.workspaces.length + 1);
  for (const workspace of previous.state.workspaces) expect(after.state.workspaces.some((w: any) => w.id === workspace.id)).toBe(true);
  const copied = after.state.workspaces.find((w: any) => w.name === "Old browser (imported)");
  expect(copied.id).not.toBe("old-browser");
  expect(copied.data.threads[0].messages[0].text).toBe("Legacy user data");
  expect(await page.evaluate(() => localStorage.getItem("hyperagents-demo:workspace-v1"))).toBe(original);
});

test("unauthenticated Vite filesystem paths cannot expose SQLite, uploads or public symlink aliases", async ({ page, browser }) => {
  const dataDir = process.env.HYPERAGENTS_E2E_DIR!;
  await fs.stat(path.join(dataDir, "workspace.sqlite"));
  const saved = await state(page);
  const metadata = saved.state.workspaces.flatMap((w: any) => w.data.threads.flatMap((t: any) => (t.messages || []).flatMap((m: any) => m.context?.attachments || [])))[0];
  expect(metadata).toBeTruthy();
  const alias = "private-alias-" + Date.now() + ".txt";
  const aliasPath = path.join(process.cwd(), "public", alias);
  await fs.symlink(path.join(dataDir, "uploads", metadata.id), aliasPath);
  const anonymous = await browser.newContext();
  try {
    for (const target of [
      "/.data/workspace.sqlite?raw", "/.data/uploads/" + metadata.id,
      "/@fs/" + path.join(dataDir, "workspace.sqlite").replaceAll("\\", "/") + "?raw",
      "/@fs/" + path.join(dataDir, "uploads", metadata.id).replaceAll("\\", "/"),
      "/" + alias,
    ]) {
      const response = await anonymous.request.get("http://127.0.0.1:5174" + target);
      expect(response.status()).toBe(403);
      const text = await response.text();
      expect(text).not.toContain("SQLite format 3");
      expect(text).not.toContain("This is actual uploaded data");
      expect(text).not.toContain(dataDir);
    }
  } finally { await fs.rm(aliasPath, { force: true }); await anonymous.close(); }
});

test("migration waits for delayed saves, locks editing and cannot discard a concurrent follow-up", async ({ page }) => {
  const id = await createThread(page, "Migration concurrency source");
  const legacy = { version: 1, active: "race-browser", workspaces: [{ id: "race-browser", name: "Race browser", data: Object.fromEntries(["threads", "projects", "agents", "memories", "skills", "rooms", "artifacts", "schedules", "rubrics", "reviewedSuggestions", "connections"].map(name => [name, []])) }] };
  await page.evaluate(value => localStorage.setItem("hyperagents-demo:workspace-v1", value), JSON.stringify(legacy));
  await page.reload();
  await expect(page.getByLabel("Follow-up message", { exact: true })).toBeVisible();
  let releaseWrite!: () => void, writeStarted!: () => void, releaseImport!: () => void, importStarted!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const writing = new Promise<void>(resolve => { writeStarted = resolve; });
  const importGate = new Promise<void>(resolve => { releaseImport = resolve; });
  const importing = new Promise<void>(resolve => { importStarted = resolve; });
  let delayWrite = true, importCalls = 0;
  await page.route("**/api/state", async route => {
    if (route.request().method() === "PUT" && delayWrite) {
      delayWrite = false; const response = await route.fetch(); writeStarted(); await writeGate; await route.fulfill({ response });
    } else await route.continue();
  });
  await page.route("**/api/migrate", async route => {
    importCalls++; const response = await route.fetch(); importStarted(); await importGate; await route.fulfill({ response });
  });
  try {
    await page.getByLabel("Follow-up message", { exact: true }).fill("Preserve this delayed save");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await writing;
    await page.getByRole("button", { name: "Preview browser import", exact: true }).click();
    await page.getByRole("checkbox", { name: "I understand and want to import a copy.", exact: true }).check();
    await page.getByRole("button", { name: "Confirm browser import", exact: true }).click();
    await expect(page.getByRole("alertdialog", { name: "Updating workspace snapshot", exact: true })).toBeVisible();
    await expect(page.locator(".backend-owner-root")).toHaveAttribute("inert", "");
    expect(importCalls).toBe(0);
    releaseWrite(); await importing;
    await expect(page.locator(".backend-owner-root")).toHaveAttribute("inert", "");
    releaseImport();
    await expect(page.getByRole("alertdialog", { name: "Updating workspace snapshot", exact: true })).toHaveCount(0);
    await expect(page.locator(".rt-messages")).toContainText("Preserve this delayed save");
    await page.getByLabel("Follow-up message", { exact: true }).fill("Save after replacement");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByLabel("Storage status", { exact: true })).toHaveText("Saved to local server");
    const after = await state(page);
    const thread = after.state.workspaces.flatMap((w: any) => w.data.threads).find((t: any) => t.id === id);
    expect(thread.messages.map((m: any) => m.text)).toContain("Preserve this delayed save");
    expect(thread.messages.map((m: any) => m.text)).toContain("Save after replacement");
    expect(after.state.workspaces.some((w: any) => w.name === "Race browser (imported)")).toBe(true);
  } finally { releaseWrite(); releaseImport(); }
});
