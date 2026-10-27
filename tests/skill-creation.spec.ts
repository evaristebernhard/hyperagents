import { test, expect, type Page } from "@playwright/test";

async function openWizard(page: Page) {
  await page.goto("/skills");
  await page.getByRole("button", { name: "Create skill", exact: true }).click();
  return page.getByRole("dialog");
}
const storage = (page: Page) => page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));

test("Create skill opens four methods without navigating; cancel and local-only editor remain separate", async ({ page }) => {
  const d = await openWizard(page);
  const before = await storage(page);
  await expect(page).toHaveURL(/\/skills$/);
  await expect(d).toHaveAttribute("aria-label", "Create skill");
  for (const name of ["Build a skill from scratch", "Learn from documentation", "Import from GitHub", "Import from file"]) {
    await expect(d.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  }
  await d.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(d).toHaveCount(0);
  expect(await storage(page)).toBe(before);
  await page.getByRole("button", { name: "Create skill", exact: true }).click();
  await d.getByRole("button", { name: "Open local-only manual editor →", exact: true }).click();
  await expect(page).toHaveURL(/\/skills\/new$/);
  await expect(page.getByLabel("Skill name", { exact: true })).toBeVisible();
  await expect(page.getByText(/Local-only manual editor/)).toBeVisible();
});

test("research modes gate empty topics and preserve topic and interactive description across Back", async ({ page }) => {
  const d = await openWizard(page);
  const before = await storage(page);
  const requests: string[] = [];
  page.on("request", r => requests.push(r.url()));
  await d.getByRole("button", { name: /Build a skill from scratch/ }).click();
  await expect(d).toHaveAttribute("aria-label", "Research a new skill");
  await expect(d.getByRole("radio", { name: /Quick Learn/ })).toBeChecked();
  await expect(d.getByRole("button", { name: "Start Research", exact: true })).toBeDisabled();
  await d.getByLabel("Topic", { exact: true }).fill("   ");
  await expect(d.getByRole("button", { name: "Start Research", exact: true })).toBeDisabled();
  await d.getByLabel("Topic", { exact: true }).fill("Accessible design systems");
  await d.getByRole("button", { name: "Start Research", exact: true }).click();
  await expect(d.getByRole("status")).toContainText("not connected");
  await d.getByRole("radio", { name: /Interactive/ }).check();
  await d.getByLabel("Initial description (optional)", { exact: true }).fill("Use clear examples");
  await d.getByRole("radio", { name: /Quick Learn/ }).check();
  await expect(d.getByLabel("Initial description (optional)", { exact: true })).toHaveCount(0);
  await d.getByRole("radio", { name: /Interactive/ }).check();
  await expect(d.getByLabel("Initial description (optional)", { exact: true })).toHaveValue("Use clear examples");
  await d.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await d.getByRole("button", { name: /Build a skill from scratch/ }).click();
  await expect(d.getByLabel("Topic", { exact: true })).toHaveValue("Accessible design systems");
  await expect(d.getByLabel("Initial description (optional)", { exact: true })).toHaveValue("Use clear examples");
  await d.getByRole("button", { name: "Start Interactive", exact: true }).click();
  await expect(d.getByRole("status")).toContainText("No model was called");
  expect(await storage(page)).toBe(before);
  expect(requests).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create skill", exact: true })).toBeFocused();
});

test("documentation tabs keep independent drafts and never analyze remotely", async ({ page }) => {
  const d = await openWizard(page);
  const before = await storage(page);
  await d.getByRole("button", { name: /Learn from documentation/ }).click();
  const submit = d.getByRole("button", { name: "Analyze & Learn", exact: true });
  await expect(submit).toBeDisabled();
  await d.getByLabel("Documentation URL", { exact: true }).fill("https://docs.example.com/api");
  await expect(submit).toBeEnabled();
  await d.getByRole("tab", { name: "Paste Docs", exact: true }).click();
  await expect(submit).toBeDisabled();
  await d.getByLabel("Documentation", { exact: true }).fill("# Independent instructions");
  await d.getByRole("tab", { name: "From URL", exact: true }).click();
  await expect(d.getByLabel("Documentation URL", { exact: true })).toHaveValue("https://docs.example.com/api");
  await submit.click();
  await expect(d.getByRole("status")).toContainText("not connected");
  await d.getByRole("tab", { name: "Paste Docs", exact: true }).click();
  await expect(d.getByLabel("Documentation", { exact: true })).toHaveValue("# Independent instructions");
  await d.getByRole("button", { name: "Back", exact: true }).click();
  await d.getByRole("button", { name: /Learn from documentation/ }).click();
  await expect(d.getByLabel("Documentation", { exact: true })).toHaveValue("# Independent instructions");
  await submit.click();
  await expect(d.getByRole("status")).toContainText("no skill was created");
  expect(await storage(page)).toBe(before);
});

test("GitHub blank/nonblank gate reports not connected with no requests or fake writes", async ({ page }) => {
  const d = await openWizard(page);
  const before = await storage(page);
  const requests: string[] = [];
  page.on("request", r => requests.push(r.url()));
  await d.getByRole("button", { name: /Import from GitHub/ }).click();
  const submit = d.getByRole("button", { name: "Import from GitHub", exact: true });
  await expect(submit).toBeDisabled();
  await d.getByLabel("Repository URL", { exact: true }).fill(" ");
  await expect(submit).toBeDisabled();
  await d.getByLabel("Repository URL", { exact: true }).fill("https://github.com/example/skill");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(d.getByRole("status")).toContainText("not connected");
  await d.getByRole("button", { name: "Back", exact: true }).click();
  await d.getByRole("button", { name: /Import from GitHub/ }).click();
  await expect(d.getByLabel("Repository URL", { exact: true })).toHaveValue("https://github.com/example/skill");
  await d.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await storage(page)).toBe(before);
  expect(requests).toEqual([]);
});

test("upload selection, removal, validation and cancel never auto-import", async ({ page }) => {
  const d = await openWizard(page);
  const before = await storage(page);
  await d.getByRole("button", { name: /Import from file/ }).click();
  const input = d.getByLabel("Upload skill file", { exact: true });
  const submit = d.getByRole("button", { name: "Import skill", exact: true });
  await expect(submit).toBeDisabled();
  await input.setInputFiles({ name: "bad.exe", mimeType: "application/octet-stream", buffer: Buffer.from("no") });
  await expect(d.getByRole("alert")).toContainText("Choose a JSON, MD, or ZIP");
  await expect(submit).toBeDisabled();
  await input.setInputFiles({ name: "large.md", mimeType: "text/markdown", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
  await expect(d.getByRole("alert")).toContainText("5 MB or smaller");
  await expect(submit).toBeDisabled();
  await input.setInputFiles({ name: "draft.md", mimeType: "text/markdown", buffer: Buffer.from("# Draft instructions") });
  await expect(d.locator(".sc-selected-file")).toContainText("draft.md");
  await expect(submit).toBeEnabled();
  expect(await storage(page)).toBe(before);
  await d.getByRole("button", { name: "Back", exact: true }).click();
  await d.getByRole("button", { name: /Import from file/ }).click();
  await expect(d.locator(".sc-selected-file")).toContainText("draft.md");
  await d.getByRole("button", { name: "Remove selected file", exact: true }).click();
  await expect(submit).toBeDisabled();
  await input.setInputFiles({ name: "draft.md", mimeType: "text/markdown", buffer: Buffer.from("# Draft instructions") });
  await d.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await storage(page)).toBe(before);
  await page.getByRole("button", { name: "Create skill", exact: true }).click();
  await d.getByRole("button", { name: /Import from file/ }).click();
  await expect(submit).toBeDisabled();
});

test("invalid JSON stays open; valid explicit imports above legacy 1 MB persist locally", async ({ page }) => {
  const d = await openWizard(page);
  await d.getByRole("button", { name: /Import from file/ }).click();
  const input = d.getByLabel("Upload skill file", { exact: true });
  await input.setInputFiles({ name: "broken.json", mimeType: "application/json", buffer: Buffer.from('{"name":42}') });
  await d.getByRole("button", { name: "Import skill", exact: true }).click();
  await expect(d.getByRole("alert")).toContainText("Use a skill JSON");
  await expect(d).toBeVisible();
  await input.setInputFiles({ name: "explicit.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ name: "Explicit local import", documentation: "# Local instructions\n" + " ".repeat(1024 * 1024), tags: [] })) });
  await d.getByRole("button", { name: "Import skill", exact: true }).click();
  await expect(page).toHaveURL(/\/skills\/skill-/);
  await expect(page.getByRole("heading", { name: "Explicit local import", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Explicit local import", exact: true })).toBeVisible();
});

test("ZIP manifest stage states the unsupported preview boundary and installs nothing", async ({ page }) => {
  const d = await openWizard(page);
  const before = await storage(page);
  await d.getByRole("button", { name: /Import from file/ }).click();
  const input = d.getByLabel("Upload skill file", { exact: true });
  await input.setInputFiles({ name: "oversized.zip", mimeType: "application/zip", buffer: Buffer.alloc(50 * 1024 * 1024 + 1) });
  await expect(d.getByRole("alert")).toContainText("50 MB or smaller");
  await input.setInputFiles({ name: "package.zip", mimeType: "application/zip", buffer: Buffer.from("not extracted") });
  await expect(d.getByRole("region", { name: "ZIP manifest preview", exact: true })).toContainText("no extraction");
  await d.getByRole("button", { name: "Import skill", exact: true }).click();
  await expect(d.getByRole("status")).toContainText("not supported");
  await expect(d).toBeVisible();
  expect(await storage(page)).toBe(before);
});

test("dropzone rejects multiple files without importing", async ({ page }) => {
  const d = await openWizard(page);
  const before = await storage(page);
  await d.getByRole("button", { name: /Import from file/ }).click();
  await d.locator(".sc-dropzone").evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["# First"], "first.md"));
    transfer.items.add(new File(["# Second"], "second.md"));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
  });
  await expect(d.getByRole("alert")).toContainText("single skill file");
  await expect(d.getByRole("button", { name: "Import skill", exact: true })).toBeDisabled();
  expect(await storage(page)).toBe(before);
});
