import { test, expect } from "@playwright/test";
import { setSystemPrompt } from "./helpers";

test("manual route applies required gates and prompt edits are transactional", async ({ page }) => {
  await page.goto("/agents/new?creation=manual");
  const create = page.getByRole("button", { name: "Create Agent", exact: true });
  await expect(create).toBeDisabled();
  await page.getByLabel("Agent name", { exact: true }).fill("Release reviewer");
  await expect(create).toBeDisabled();
  await page.getByRole("button", { name: "Edit system prompt", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "System prompt", exact: true });
  await expect(dialog.getByRole("toolbar", { name: "Prompt formatting" })).toBeVisible();
  await dialog.getByRole("textbox", { name: "System prompt", exact: true }).fill("This edit is discarded");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(create).toBeDisabled();
  await page.getByRole("button", { name: "Edit system prompt", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "System prompt", exact: true });
  await expect(dialog.getByRole("textbox", { name: "System prompt", exact: true })).toBeEmpty();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await setSystemPrompt(page, "Verify test evidence. Ask before publishing.");
  await expect(create).toBeEnabled();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue("");
  await create.click();
  await expect(page).toHaveURL(/\/agents$/);
  await page.getByRole("link", { name: /Release reviewer/ }).click();
  await expect(page.getByRole("button", { name: "Edit system prompt", exact: true })).toContainText("Verify test evidence.");
});

test("creation draft survives navigation and reload, then clears after explicit creation", async ({ page }) => {
  await page.goto("/agents/new?creation=manual");
  await page.getByLabel("Agent name", { exact: true }).fill("Persistent draft");
  await setSystemPrompt(page, "A draft is not a saved agent.");
  await page.goto("/skills");
  await page.goto("/agents/new");
  await expect(page.getByLabel("Agent name", { exact: true })).toHaveValue("Persistent draft");
  await page.reload();
  await expect(page.getByLabel("Agent name", { exact: true })).toHaveValue("Persistent draft");
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.goto("/agents/new?creation=manual");
  await expect(page.getByLabel("Agent name", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Create Agent", exact: true })).toBeDisabled();
});

test("redraft requires confirmation and does not erase identity or fabricate generation", async ({ page }) => {
  await page.goto("/agents/new?creation=manual");
  await page.getByLabel("Agent name", { exact: true }).fill("Keep this identity");
  await setSystemPrompt(page, "Keep the current confirmed prompt.");
  await page.getByRole("button", { name: "Re-draft from a posting", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Re-draft from a posting?", exact: true });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Agent name", { exact: true })).toHaveValue("Keep this identity");
  await page.getByRole("button", { name: "Re-draft from a posting", exact: true }).click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Describe the job", { exact: true })).toBeVisible();
  await page.getByLabel("Describe the job", { exact: true }).fill("A revised release audit role");
  await page.getByRole("button", { name: "Draft identity", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Identity drafting is not connected" })).toBeVisible();
  await page.getByRole("button", { name: "Fill these in manually →", exact: true }).click();
  await expect(page.getByLabel("Agent name", { exact: true })).toHaveValue("Keep this identity");
});

test("trust profile jumps to Knowledge and readonly preset controls learning and scope", async ({ page }) => {
  await page.goto("/agents/new?creation=manual");
  await page.getByRole("button", { name: "Edit trust profile", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Knowledge profile", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: /^Read-only memory/ }).check();
  await expect(page.getByRole("switch", { name: "Learns automatically", exact: true })).not.toBeChecked();
  await expect(page.getByRole("combobox", { name: "Memory read scope", exact: true })).toHaveValue("linked");
  await expect(page.getByRole("combobox", { name: "Memory suggestions", exact: true })).toHaveCount(0);
  await page.getByRole("radio", { name: /^Separate memory/ }).check();
  await expect(page.getByRole("switch", { name: "Learns automatically", exact: true })).toBeChecked();
  await expect(page.getByRole("combobox", { name: "Memory save target", exact: true })).toHaveValue("agent");
});

test("casting route has lenses, world chips, examples and a nonexecuting submit", async ({ page }) => {
  await page.goto("/agents/new/cast");
  const cast = page.getByRole("button", { name: "Cast", exact: true });
  await expect(cast).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "World", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Run the standup so every blocker has an owner by ten", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "What should this agent do?", exact: true })).toHaveValue("Run the standup so every blocker has an owner by ten");
  for (const value of ["One Universe", "Mixed Reel", "Casting Director"]) {
    await page.getByRole("button", { name: value, exact: true }).click();
    await expect(page.getByRole("textbox", { name: "World", exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Film noir", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "World", exact: true })).toHaveValue("Film noir");
  await cast.click();
  await expect(page.getByRole("status")).toContainText("No candidates or portraits were generated");
  await page.getByRole("link", { name: "Skip — configure manually", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/new\?creation=manual$/);
  await expect(page.getByLabel("Agent name", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Create Agent", exact: true })).toBeDisabled();
});

test("prompt HTML from a persisted draft is sanitized before preview", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hyperagents-demo:agent-creation:personal", JSON.stringify({ manual: true, name: "Unsafe draft", prompt: "Safe text", promptHtml: '<p>Safe text</p><img src=x onerror="window.promptXss=true"><script>window.promptXss=true</script>' })));
  await page.goto("/agents/new?creation=manual");
  await expect(page.locator(".agent-prompt-preview img,.agent-prompt-preview script")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).promptXss)).toBeUndefined();
});
