import { test, expect } from "@playwright/test";

test("model settings has six rows and the observed gated model submenu", async ({ page }) => {
  await page.goto("/threads/new");
  await page.getByRole("button", { name: "Model settings", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Model settings menu", exact: true });
  for (const text of ["Model", "Reasoning effort", "Provider", "Tools", "Integrations", "Open full settings"]) {
    await expect(menu.locator(":scope > button").filter({ hasText: text }).first()).toBeVisible();
  }
  await menu.locator('[data-submenu="model"]').hover();
  await expect(page.getByRole("menuitem", { name: /Unlock every model/ })).toBeVisible();
  await page.getByRole("menuitem", { name: /Unlock every model/ }).click();
  await expect(page).toHaveURL(/\?settings=billing$/);
});

test("reasoning and tool preview choices update without invoking a model", async ({ page }) => {
  await page.goto("/threads/new");
  await page.getByRole("button", { name: "Model settings", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Model settings menu", exact: true });
  await menu.locator('[data-submenu="effort"]').hover();
  await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
  await expect(menu.locator('[data-submenu="effort"]')).toContainText("High");
  await menu.locator('[data-submenu="tools"]').hover();
  const browser = page.getByRole("menuitemcheckbox", { name: "Browser", exact: true });
  await expect(browser).toHaveAttribute("aria-checked", "true");
  await browser.click();
  await expect(browser).toHaveAttribute("aria-checked", "false");
  await expect(menu.locator('[data-submenu="tools"]')).toContainText("15");
  await page.keyboard.press("Escape");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Model settings", exact: true })).toBeFocused();
});

test("execution keeps Auto nested instead of a third top-level mode", async ({ page }) => {
  await page.goto("/threads/new");
  await page.getByRole("button", { name: "Execution mode", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Execution mode menu", exact: true });
  await expect(menu.getByRole("menuitemradio")).toHaveCount(2);
  await menu.getByRole("menuitem", { name: "Execution policy: Auto", exact: true }).hover();
  await expect(page.getByRole("menu", { name: "Execution policy options", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await menu.getByRole("menuitemradio", { name: /^Plan first/ }).click();
  await expect(menu).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Execution mode", exact: true })).toContainText("Plan first");
});

test("agent picker searches starter names and descriptions and selects locally", async ({ page }) => {
  await page.goto("/threads/new");
  await page.getByRole("button", { name: "Use an agent", exact: true }).click();
  const picker = page.getByRole("menu", { name: "Agent picker", exact: true });
  await expect(picker.getByText("STARTER AGENTS", { exact: true })).toBeVisible();
  await expect(picker.getByRole("menuitem", { name: /Create from scratch/ })).toBeVisible();
  const search = picker.getByRole("textbox", { name: "Search agents", exact: true });
  await expect(search).toBeFocused();
  await search.fill("debug");
  await expect(picker.getByRole("menuitem", { name: /Developer/ })).toBeVisible();
  await expect(picker.getByRole("menuitem", { name: /Recruiter/ })).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Use an agent", exact: true })).toContainText("Developer");
  await page.getByRole("button", { name: "Use an agent", exact: true }).click();
  await picker.getByRole("textbox", { name: "Search agents", exact: true }).fill("no-such-agent-xyz");
  await expect(picker.getByRole("status")).toHaveText("No agents found");
});

test("workspace search is headerless, scoped, grouped and handles empty results", async ({ page }) => {
  await page.goto("/threads/new");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Search", exact: true });
  await expect(dialog.locator(".modal-header")).toHaveCount(0);
  await expect(dialog.locator(".search-scope")).toContainText("Personal");
  await expect(dialog.getByText("Go to", { exact: true })).toBeVisible();
  const input = dialog.getByRole("textbox", { name: "Search workspace" });
  await input.fill("zz-no-matches-zz");
  await expect(dialog.getByText("No matches found.")).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await input.fill("Marketplace");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/marketplace$/);
});

test("search Control+Enter opens the selected route in a new tab", async ({ page, context }) => {
  await page.goto("/threads/new");
  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "Search workspace" }).fill("Library");
  const popupPromise = context.waitForEvent("page");
  await page.keyboard.press("Control+Enter");
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/\/library$/);
  await expect(page).toHaveURL(/\/threads\/new$/);
  await popup.close();
});

test("sidebar sections collapse and flyouts keep the observed destinations", async ({ page }) => {
  await page.goto("/threads/new");
  const sidebar = page.locator(".sidebar");
  const recent = sidebar.getByRole("button", { name: "Recent threads", exact: true });
  await expect(recent).toHaveAttribute("aria-expanded", "true");
  await recent.click();
  await expect(recent).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#sidebar-recent-list")).toHaveCount(0);
  await recent.click();
  await expect(page.locator("#sidebar-recent-list")).toBeVisible();
  await sidebar.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(sidebar.getByRole("link", { name: "View roster", exact: true })).toBeVisible();
  await sidebar.getByRole("button", { name: "Learning", exact: true }).click();
  const learning = page.getByRole("menu", { name: "Learning", exact: true });
  for (const name of ["Improvements", "Rubrics", "Autowiki"]) await expect(learning.getByRole("menuitem", { name, exact: true })).toBeVisible();
  await learning.getByRole("menuitem", { name: "Autowiki", exact: true }).click();
  await expect(page).toHaveURL(/\/wiki$/);
  await sidebar.locator(".workspace-switch").click();
  await expect(page.getByRole("menu", { name: "Workspaces", exact: true }).getByRole("menuitem", { name: "Create workspace", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sidebar.locator(".workspace-switch")).toBeFocused();
  await sidebar.locator(".account-button").click();
  const account = page.getByRole("menu", { name: "Account", exact: true });
  for (const name of ["Account settings", "Help & support", "Add account", "Sign out"]) await expect(account.getByRole("menuitem", { name, exact: true })).toBeVisible();
});

test("nested model menu stays within the narrow viewport horizontally", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/threads/new");
  await page.getByRole("button", { name: "Model settings", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Model settings menu", exact: true });
  await menu.locator('[data-submenu="model"]').click();
  const sub = page.getByRole("menu", { name: "model options", exact: true });
  await expect(sub).toBeVisible();
  const rect = await sub.boundingBox();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(390);
});

test("keyboard submenu selection returns focus to its parent row", async ({ page }) => {
  await page.goto("/threads/new");
  await page.getByRole("button", { name: "Model settings", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Model settings menu", exact: true });
  await page.keyboard.press("ArrowDown");
  await expect(menu.locator('[data-submenu="effort"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitemradio", { name: "Medium", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu.locator('[data-submenu="effort"]')).toBeFocused();
  await expect(menu.locator('[data-submenu="effort"]')).toContainText("High");
});

test("compact composer submenu is constrained to the viewport vertically", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto("/thread/small-business");
  await page.getByRole("button", { name: "Model settings", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Model settings menu", exact: true });
  await menu.locator('[data-submenu="tools"]').hover();
  const sub = page.getByRole("menu", { name: "tools options", exact: true });
  await expect(sub).toBeVisible();
  const rect = await sub.boundingBox();
  expect(rect!.y).toBeGreaterThanOrEqual(7);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(693);
});
