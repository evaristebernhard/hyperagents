import { test, expect, type Page, type BrowserContext } from "@playwright/test";
const password = "local-e2e-owner-password-not-a-secret";
let cookies: Awaited<ReturnType<BrowserContext["cookies"]>> | undefined;
async function login(page: Page) {
  await page.route("**/api/llm/config", route => route.fulfill({ json: { configured: false, models: ["deepseek-flash", "deepseek-v4-pro"] } }));
  if (cookies) await page.context().addCookies(cookies);
  await page.goto("/threads/new");
  if (!cookies) {
    await page.getByLabel("Password", { exact: true }).fill(password);
    if (await page.getByRole("button", { name: "Create owner account", exact: true }).count()) {
      await page.getByLabel("Confirm password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Create owner account", exact: true }).click();
    } else await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await expect(page.getByLabel("Task prompt", { exact: true })).toBeVisible(); cookies = await page.context().cookies();
}
async function seed(page: Page) {
  await login(page);
  await page.getByLabel("Task prompt", { exact: true }).fill("Canvas " + test.info().title);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page).toHaveURL(/\/thread\/thread-/);
  await expect(page.getByLabel("Storage status", { exact: true })).toHaveText("Saved to local server");
  const result = await page.evaluate(async () => {
    const session = await (await fetch("/api/session")).json(), current = await (await fetch("/api/state")).json();
    const workspace = current.state.workspaces.find((w: any) => w.id === current.state.active), threadId = location.pathname.split("/").at(-1)!;
    const timestamp = new Date().toISOString();
    const artifacts = [
      { id: "canvas-doc-" + crypto.randomUUID(), title: "Canvas document", kind: "Document", content: "# Saved document\nActual SQLite content." },
      { id: "canvas-web-" + crypto.randomUUID(), title: "Canvas webpage", kind: "Webpage", content: "<html><body><h1>Saved webpage</h1><script>parent.canvasInjected=true</script></body></html>" },
      { id: "canvas-table-" + crypto.randomUUID(), title: "Canvas table", kind: "Table", content: JSON.stringify({ columns: ["Name", "Value"], rows: [["Real row", "42"]] }) },
    ].map(a => ({ ...a, threadId, versions: [], createdAt: timestamp, updatedAt: timestamp }));
    workspace.data.artifacts.push(...artifacts);
    const response = await fetch("/api/state", { method: "PUT", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken, "If-Match": String(current.revision) }, body: JSON.stringify({ state: current.state }) });
    if (!response.ok) throw Error("Seed failed"); return { threadId, artifactIds: artifacts.map(a => a.id) };
  });
  await page.reload(); await expect(page.getByRole("button", { name: "Tile layout", exact: true })).toBeVisible(); return result;
}
const canvas = (page: Page) => page.getByRole("region", { name: "Thread artifacts", exact: true });
async function saved(page: Page) { await expect(page.getByLabel("Storage status", { exact: true })).toHaveText("Saved to local server"); }

test("canvas: real previews, persistent layouts, dock, restore and collapse never delete artifacts", async ({ page }) => {
  await seed(page);
  await canvas(page).getByRole("button", { name: "Tile layout", exact: true }).click(); await saved(page);
  await expect(canvas(page).locator(".ac-card")).toHaveCount(3);
  await expect(canvas(page).getByRole("table", { name: "Canvas table", exact: true })).toContainText("Real row");
  await expect(canvas(page).locator("iframe")).toHaveAttribute("sandbox", "");
  expect(await page.evaluate(() => (window as any).canvasInjected)).toBeUndefined();
  await page.screenshot({ path: test.info().outputPath("canvas-tiles.jpg"), type: "jpeg", quality: 75 });
  await canvas(page).getByRole("button", { name: "Minimize: Canvas document", exact: true }).click(); await saved(page);
  await expect(canvas(page).locator(".ac-card")).toHaveCount(2);
  await expect(canvas(page).getByRole("navigation", { name: "Minimized artifacts", exact: true })).toContainText("Canvas document");
  await page.reload(); await expect(canvas(page).getByRole("button", { name: "Tile layout", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(canvas(page).locator(".ac-card")).toHaveCount(2);
  await canvas(page).getByRole("button", { name: "Restore: Canvas document", exact: true }).click(); await saved(page);
  await expect(canvas(page).locator(".ac-card")).toHaveCount(3);
  await page.getByRole("button", { name: "Hide canvas", exact: true }).click(); await saved(page); await page.reload();
  await expect(canvas(page).getByRole("button", { name: "Show canvas", exact: true })).toBeVisible();
  await page.locator(".rt-actions").first().getByRole("button", { name: "Show canvas", exact: true }).click(); await saved(page);
  await expect(canvas(page).locator(".ac-card")).toHaveCount(3);
  await canvas(page).getByRole("button", { name: "Carousel layout", exact: true }).click(); await saved(page);
  await expect(canvas(page).locator(".ac-carousel .ac-card")).toHaveCount(3);
  await expect(canvas(page).getByRole("button", { name: "Scroll artifacts right", exact: true })).toBeVisible();
});

test("canvas: keyboard reorder persists, spotlight is sandboxed and editor retains versions", async ({ page }) => {
  await seed(page); await canvas(page).getByRole("button", { name: "Tile layout", exact: true }).click(); await saved(page);
  await canvas(page).getByRole("button", { name: "Move earlier: Canvas webpage", exact: true }).click(); await saved(page);
  await expect(canvas(page).locator(".ac-card-header strong").first()).toHaveText("Canvas webpage");
  await page.reload(); await expect(canvas(page).locator(".ac-card-header strong").first()).toHaveText("Canvas webpage");
  await canvas(page).getByRole("button", { name: "Spotlight: Canvas webpage", exact: true }).click();
  const spotlight = page.getByRole("dialog", { name: "Canvas webpage", exact: true });
  await expect(spotlight.locator("iframe")).toHaveAttribute("sandbox", "");
  await spotlight.getByRole("button", { name: "Next spotlight artifact", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Canvas document", exact: true })).toBeVisible(); await page.keyboard.press("Escape");
  await canvas(page).getByRole("button", { name: "Reset order", exact: true }).click(); await saved(page);
  const doc = canvas(page).locator(".ac-card").filter({ has: page.locator(".ac-card-header strong", { hasText: "Canvas document" }) });
  await doc.getByRole("button", { name: "Open editor", exact: true }).click(); await saved(page);
  await expect(canvas(page).getByRole("button", { name: "Focus layout", exact: true })).toHaveAttribute("aria-pressed", "true");
  await canvas(page).getByRole("button", { name: "Edit artifact", exact: true }).click();
  await page.getByLabel("Artifact content", { exact: true }).fill("# Updated canvas document");
  await page.getByRole("button", { name: "Save artifact", exact: true }).click(); await saved(page);
  await expect(page.getByLabel("Artifact version", { exact: true }).locator("option")).toHaveCount(2);
  await page.reload(); await expect(canvas(page).getByRole("navigation", { name: "Select artifact", exact: true })).toContainText("Canvas document");
});

test("canvas: filtering is view-only and fork remaps layout IDs to copied artifacts", async ({ page }) => {
  const seeded = await seed(page); await canvas(page).getByRole("button", { name: "Tile layout", exact: true }).click(); await saved(page);
  await canvas(page).getByRole("button", { name: "Minimize: Canvas document", exact: true }).click(); await saved(page);
  await page.getByLabel("Artifact type", { exact: true }).selectOption("Table");
  await expect(canvas(page).locator(".ac-card")).toHaveCount(1);
  await expect(canvas(page).getByRole("button", { name: "Restore: Canvas document", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Fork thread", exact: true }).click(); await saved(page);
  await expect(page).not.toHaveURL(new RegExp(seeded.threadId));
  await expect(canvas(page).getByRole("button", { name: "Restore: Canvas document", exact: true })).toBeVisible();
  const data = await page.evaluate(async () => {
    const current = await (await fetch("/api/state")).json(), w = current.state.workspaces.find((w: any) => w.id === current.state.active), id = location.pathname.split("/").at(-1);
    return { thread: w.data.threads.find((t: any) => t.id === id), artifacts: w.data.artifacts.filter((a: any) => a.threadId === id) };
  });
  expect(data.artifacts).toHaveLength(3); expect(data.thread.canvas.hidden).toHaveLength(1);
  expect(seeded.artifactIds).not.toContain(data.thread.canvas.hidden[0]);
  expect(data.artifacts.map((a: any) => a.id)).toContain(data.thread.canvas.hidden[0]);
});

test("canvas: minimizing a focused draft requires discard approval and moves focus to another artifact", async ({ page }) => {
  await seed(page);
  await canvas(page).getByRole("navigation", { name: "Select artifact", exact: true }).getByRole("button", { name: "Canvas document Document", exact: true }).click();
  await canvas(page).getByRole("button", { name: "Edit artifact", exact: true }).click();
  await page.getByLabel("Artifact content", { exact: true }).fill("Unsaved private draft");
  page.once("dialog", dialog => dialog.dismiss());
  await canvas(page).getByRole("button", { name: "Minimize selected", exact: true }).click();
  await expect(page.getByLabel("Artifact content", { exact: true })).toHaveValue("Unsaved private draft");
  await expect(canvas(page).getByRole("navigation", { name: "Minimized artifacts", exact: true })).toHaveCount(0);
  page.once("dialog", dialog => dialog.accept());
  await canvas(page).getByRole("button", { name: "Minimize selected", exact: true }).click(); await saved(page);
  await expect(canvas(page).getByRole("button", { name: "Restore: Canvas document", exact: true })).toBeVisible();
  await expect(canvas(page).locator(".rt-artifact-editor h3")).toHaveText("Canvas webpage");
  await expect(canvas(page).locator(".rt-artifact-editor iframe")).toHaveAttribute("sandbox", "");
});

test("canvas: first reorder follows title sort and keeps docked slots stable", async ({ page }) => {
  await seed(page); await canvas(page).getByRole("button", { name: "Tile layout", exact: true }).click(); await saved(page);
  await page.getByLabel("Sort artifacts", { exact: true }).selectOption("title");
  const titles = canvas(page).locator(".ac-card-header strong");
  await expect(titles).toHaveText(["Canvas document", "Canvas table", "Canvas webpage"]);
  await canvas(page).getByRole("button", { name: "Move later: Canvas document", exact: true }).click(); await saved(page);
  await expect(titles).toHaveText(["Canvas table", "Canvas document", "Canvas webpage"]);
  await canvas(page).getByRole("button", { name: "Minimize: Canvas document", exact: true }).click(); await saved(page);
  await canvas(page).getByRole("button", { name: "Move later: Canvas table", exact: true }).click(); await saved(page);
  await expect(titles).toHaveText(["Canvas webpage", "Canvas table"]);
  await canvas(page).getByRole("button", { name: "Restore: Canvas document", exact: true }).click(); await saved(page);
  await expect(titles).toHaveText(["Canvas webpage", "Canvas document", "Canvas table"]);
  await page.reload(); await expect(titles).toHaveText(["Canvas webpage", "Canvas document", "Canvas table"]);
});
