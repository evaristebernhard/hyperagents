import { test, expect } from "@playwright/test";

test("desktop settings follows the observed shell geometry", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1280 });
  await page.goto("/threads/new?settings=appearance");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeCloseTo(1180, 0);
  expect(bounds!.height).toBeCloseTo(760, 0);
  expect(bounds!.x).toBeCloseTo(50, 0);
  expect(bounds!.y).toBeCloseTo(260, 0);
  const nav = await dialog.getByRole("navigation", { name: "Settings navigation" }).boundingBox();
  expect(nav!.width).toBeCloseTo(240, 0);
  await expect(dialog.getByText("System follows this device's light or dark setting.")).toBeVisible();
  await expect(dialog.locator(".sx-theme-previews")).toHaveCount(0);
});

test("appearance keeps local theme behavior after layout changes", async ({ page }) => {
  await page.goto("/learning?settings=appearance");
  const mode = page.getByRole("combobox", { name: "Color mode" });
  await mode.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(mode).toHaveValue("dark");
  await mode.selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await mode.selectOption("system");
  await expect(mode).toHaveValue("system");
});

test("composer integrations entry preserves the current page", async ({ page }) => {
  await page.goto("/threads/new");
  await page.getByRole("button", { name: "Add files or context" }).click();
  await page.locator(".composer-popover").getByRole("button", { name: "Integrations", exact: true }).click();
  await expect(page).toHaveURL(/\/threads\/new\?settings=integrations$/);
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/threads\/new$/);
});

test("settings appearance remains usable on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/threads/new?settings=appearance");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  const mode = dialog.getByRole("combobox", { name: "Color mode" });
  await expect(mode).toBeVisible();
  await mode.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
