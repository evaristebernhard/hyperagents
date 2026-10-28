import type { Page } from "@playwright/test";
export async function setSystemPrompt(page: Page, value: string) {
  await page.getByRole("button", { name: "Edit system prompt", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "System prompt", exact: true });
  await dialog.getByRole("textbox", { name: "System prompt", exact: true }).fill(value);
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
}
