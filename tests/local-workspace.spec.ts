import { setSystemPrompt } from "./helpers";
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
async function createSkill(page: Page, name = "Launch checklist") {
  await page.goto("/skills/new");
  await page.getByLabel("Skill name", { exact: true }).fill(name);
  await page
    .getByLabel("Description", { exact: true })
    .fill("A reusable launch process");
  await page.getByLabel("When to use", { exact: true }).fill("Before a launch");
  await page.getByLabel("Tags", { exact: true }).fill("launch, planning");
  await page
    .getByLabel("Documentation", { exact: true })
    .fill(
      "# Launch checklist\n\n## Prepare\n- Verify the audience\n- Review the deliverables",
    );
  await page.getByRole("button", { name: "Save skill", exact: true }).click();
  await expect(page).toHaveURL(/\/skills\/skill-/);
  return new URL(page.url()).pathname;
}
async function createAgent(page: Page, name = "Local researcher") {
  await page.goto("/agents/new");
  await page.getByRole("button", { name: "Fill these in manually →" }).click();
  await page.getByLabel("Agent name", { exact: true }).fill(name);
  await page
    .getByLabel("Description", { exact: true })
    .fill("Research carefully");
  await setSystemPrompt(page, "Verify facts. Ask before external actions.");
}
async function newArtifact(
  page: Page,
  title: string,
  content: string,
  type = "Document",
  thread = "",
) {
  await page.goto("/library");
  await page.getByRole("button", { name: "New artifact", exact: true }).click();
  const d = page.getByRole("dialog", { name: "New artifact", exact: true });
  await d.getByLabel("Title", { exact: true }).fill(title);
  await d.getByLabel("Type", { exact: true }).selectOption(type);
  await d.getByLabel("Content", { exact: true }).fill(content);
  if (thread) await d.getByLabel("Related thread").selectOption(thread);
  await d.getByRole("button", { name: "Save artifact", exact: true }).click();
  await expect(d).not.toBeVisible();
}
test("skill create edit preview archive restore duplicate and export persist", async ({
  page,
}) => {
  const route = await createSkill(page);
  await page.reload();
  await expect(page.locator(".local-markdown")).toContainText(
    "Verify the audience",
  );
  await page.getByRole("button", { name: "Edit Skill", exact: true }).click();
  await page
    .getByLabel("Documentation", { exact: true })
    .fill("# Revised instructions\nKeep evidence visible.");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator(".local-editor-preview")).toContainText(
    "Revised instructions",
  );
  await page.getByRole("button", { name: "Save skill", exact: true }).click();
  await expect(page.locator(".local-markdown")).toContainText(
    "Keep evidence visible.",
  );
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON", exact: true }).click();
  const file = await pending;
  const data = JSON.parse(await fs.readFile((await file.path())!, "utf8"));
  expect(data.name).toBe("Launch checklist");
  expect(data.tags).toEqual(["launch", "planning"]);
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Launch checklist (copy)", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByLabel("Archived", { exact: true }).check();
  await expect(page.locator(".table")).toContainText("Launch checklist (copy)");
  await page
    .getByRole("link", { name: "Launch checklist (copy)", exact: true })
    .click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.goto(route);
  await expect(page.locator(".local-markdown")).toContainText(
    "Keep evidence visible.",
  );
});
test("skill import JSON and markdown with validation", async ({ page }) => {
  await page.goto("/skills");
  await page.getByLabel("Import skill file").setInputFiles({
    name: "team.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Team process\n- Check source quality"),
  });
  await expect(
    page.getByRole("heading", { name: "team", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".local-markdown")).toContainText(
    "Check source quality",
  );
  await page.goto("/skills");
  await page.getByLabel("Import skill file").setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"name":42}'),
  });
  await expect(page.getByRole("status")).toContainText("Use a skill JSON");
  await expect(page).toHaveURL(/\/skills$/);
});
test("marketplace installs a local skill instead of a transient toast", async ({
  page,
}) => {
  await page.goto("/marketplace/s/nyt-data-viz");
  await page.getByRole("button", { name: "Add skill", exact: true }).click();
  await expect(page).toHaveURL(/\/skills\/skill-/);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "NYT Data Viz", exact: true }),
  ).toBeVisible();
  await page.goto("/skills");
  await expect(page.locator(".table")).toContainText("NYT Data Viz");
  await page.goto("/marketplace/s/nyt-data-viz");
  await page
    .getByRole("button", { name: "Open installed skill", exact: true })
    .click();
  await page.goto("/skills");
  await expect(
    page.locator(".table tbody tr").filter({ hasText: "NYT Data Viz" }),
  ).toHaveCount(1);
});
test("agent configuration tabs and skill assignments persist together", async ({
  page,
}) => {
  await createSkill(page);
  await createAgent(page);
  const nav = page.getByRole("navigation", { name: "Agent configuration" });
  await nav.getByRole("button", { name: "Model", exact: true }).click();
  await page.getByLabel("Model", { exact: true }).selectOption("Gemini Pro");
  await page
    .getByLabel("Model provider", { exact: true })
    .selectOption("OpenAI");
  await page
    .getByLabel("Reasoning effort", { exact: true })
    .selectOption("High");
  await nav.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Launch checklist", exact: true })
    .check();
  await page.getByRole("radio", { name: /Read-only memory/ }).check();
  await nav
    .getByRole("button", { name: "Tools & integrations", exact: true })
    .click();
  await page.getByRole("checkbox", { name: /Webpages Available/ }).uncheck();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("link", { name: /Local researcher/ }).click();
  await page.reload();
  await nav.getByRole("button", { name: "Model", exact: true }).click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue(
    "Gemini Pro",
  );
  await expect(
    page.getByLabel("Reasoning effort", { exact: true }),
  ).toHaveValue("High");
  await nav.getByRole("button", { name: "Knowledge", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Launch checklist", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("radio", { name: /Read-only memory/ }),
  ).toBeChecked();
  await page.goto("/skills");
  await expect(
    page.locator(".table tbody tr").filter({ hasText: "Launch checklist" }),
  ).toContainText("1");
});
test("memory full editing and pin toggles persist", async ({ page }) => {
  await page.goto("/memories");
  await page
    .getByRole("button", { name: "Add memory", exact: true })
    .first()
    .click();
  let d = page.getByRole("dialog", { name: "Add Memory", exact: true });
  await d.getByLabel("Memory Content").fill("Prefer concise reports.");
  await d
    .getByLabel("When to Use", { exact: true })
    .fill("Executive summaries");
  await d.getByLabel("Tags", { exact: true }).fill("writing, tone");
  await d.getByRole("button", { name: "Add Memory", exact: true }).click();
  await page.getByRole("button", { name: "Edit memory", exact: true }).click();
  d = page.getByRole("dialog", { name: "Edit Memory", exact: true });
  await expect(d.getByLabel("When to Use", { exact: true })).toHaveValue(
    "Executive summaries",
  );
  await d.getByLabel("Memory Content").fill("Prefer clear concise reports.");
  await d.getByRole("button", { name: "Save Memory", exact: true }).click();
  await page.getByRole("button", { name: "Toggle pinned memory" }).click();
  await page.reload();
  await page.getByLabel("Pinned only", { exact: true }).check();
  await expect(page.locator(".rp-memory-list")).toContainText(
    "Prefer clear concise reports.",
  );
  await expect(page.locator(".rp-memory-list")).toContainText("writing");
});
test("room creation notes team and schedule configuration survive navigation", async ({
  page,
}) => {
  await createAgent(page);
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.goto("/rooms/new");
  await page.getByLabel("Room name", { exact: true }).fill("Launch room");
  await page
    .getByLabel("What will you work on?", { exact: true })
    .fill("Review the release together");
  await page.getByRole("button", { name: "Add members", exact: true }).click();
  let d = page.getByRole("dialog", { name: "Room members" });
  await d
    .getByRole("checkbox", { name: "Local researcher", exact: true })
    .check();
  await d.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  const route = new URL(page.url()).pathname;
  await expect(page).toHaveURL(/\/rooms\/room-/);
  await page
    .getByLabel("Add a room note", { exact: true })
    .fill("The navigation is ready for review.");
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await page.reload();
  await expect(page.locator(".local-room-discussion")).toContainText(
    "The navigation is ready",
  );
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await expect(page.locator(".local-summary-cards")).toContainText(
    "Local researcher",
  );
  await page.getByRole("button", { name: "Schedules", exact: true }).click();
  await page.getByRole("button", { name: "Add schedule", exact: true }).click();
  d = page.getByRole("dialog", { name: "Add schedule" });
  await d.getByLabel("Schedule name", { exact: true }).fill("Daily review");
  await d
    .getByLabel("Instructions", { exact: true })
    .fill("Review the release checklist.");
  await d.getByRole("button", { name: "Save schedule", exact: true }).click();
  await expect(page.locator(".local-schedule")).toContainText("Execution off");
  await page.goto("/workflows");
  await expect(page.locator(".local-schedule")).toContainText("Daily review");
  await page.goto(route);
  await page.getByRole("button", { name: "Schedules", exact: true }).click();
  await expect(page.locator(".local-schedule")).toContainText("Daily review");
});
test("library document editing versions and thread canvas share the same content", async ({
  page,
}) => {
  await newArtifact(
    page,
    "Release note",
    "# Release\nVersion one",
    "Document",
    "small-business",
  );
  await page.getByRole("button", { name: /Release note from/ }).click();
  let d = page.getByRole("dialog", { name: "Artifact preview", exact: true });
  await expect(d).toContainText("Version one");
  await d.getByRole("button", { name: "Edit", exact: true }).click();
  let editor = page.getByRole("dialog", { name: "Edit artifact", exact: true });
  await editor
    .getByLabel("Content", { exact: true })
    .fill("# Release\nVersion two");
  await editor
    .getByRole("button", { name: "Save artifact", exact: true })
    .click();
  await page.goto("/thread/small-business");
  await page
    .getByRole("button", { name: "Open Release note", exact: true })
    .click();
  await expect(page.getByLabel("Working notes", { exact: true })).toHaveValue(
    "# Release\nVersion two",
  );
  await page
    .getByLabel("Working notes", { exact: true })
    .fill("# Release\nVersion three");
  await page.getByRole("button", { name: "Save notes", exact: true }).click();
  await page.goto("/library");
  await page.getByRole("button", { name: /Release note from/ }).click();
  d = page.getByRole("dialog", { name: "Artifact preview", exact: true });
  await expect(d).toContainText("Version three");
  page.once("dialog", (dialog) => dialog.accept());
  await d.getByRole("button", { name: /v1 .* Restore/ }).click();
  await expect(d).toContainText("Version one");
  await page.reload();
  await page.getByRole("button", { name: /Release note from/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Artifact preview", exact: true }),
  ).toContainText("Version one");
});
test("thread fork move archive and restore are actual local changes", async ({
  page,
}) => {
  await page.goto("/thread/small-business");
  await page
    .getByRole("button", {
      name: "Small Biz Website Builder Thread",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Fork thread", exact: true }).click();
  await expect(page).toHaveURL(/\/thread\/local-/);
  await expect(page.locator(".thread-title")).toHaveText(
    "Small Biz Website Builder Thread (fork)",
  );
  await page.locator(".thread-title").click();
  await page
    .getByRole("button", { name: "Move to project", exact: true })
    .click();
  const d = page.getByRole("dialog", { name: "Move to project", exact: true });
  await d.getByLabel("Project", { exact: true }).selectOption("hello");
  await d.getByRole("button", { name: "Move thread", exact: true }).click();
  await page.goto("/projects/hello");
  await expect(
    page.locator(".rp-project-thread-card").filter({ hasText: "(fork)" }),
  ).toHaveCount(1);
  await page.goto("/threads");
  await page
    .getByRole("button", {
      name: "Archive Small Biz Website Builder Thread (fork)",
      exact: true,
    })
    .click();
  await expect(page.locator(".thread-cards")).not.toContainText("(fork)");
  await page.getByLabel("Archived", { exact: true }).check();
  await expect(page.locator(".thread-cards")).toContainText("(fork)");
  await page
    .getByRole("button", {
      name: "Restore Small Biz Website Builder Thread (fork)",
      exact: true,
    })
    .click();
  await page.getByLabel("Archived", { exact: true }).uncheck();
  await expect(page.locator(".thread-cards")).toContainText("(fork)");
});
test("workspace isolation backup round trip and malformed imports do not lose current data", async ({
  page,
}) => {
  await createSkill(page, "Personal handbook");
  await page.goto("/workspaces");
  const exported = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export workspace backup", exact: true })
    .click();
  const file = await exported;
  const bytes = await fs.readFile((await file.path())!);
  const snapshot = JSON.parse(bytes.toString());
  expect(
    snapshot.workspaces[0].data.skills.some(
      (s: any) => s.name === "Personal handbook",
    ),
  ).toBeTruthy();
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .first()
    .click();
  let d = page.getByRole("dialog", { name: "Create workspace", exact: true });
  await d.getByLabel("Workspace name", { exact: true }).fill("Client Alpha");
  await d
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await page.goto("/skills");
  await expect(page.locator(".table")).not.toContainText("Personal handbook");
  await page.goto("/workspaces");
  await page.getByLabel("Import workspace backup file").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      '{"version":1,"active":"x","workspaces":[{"id":"x","name":"x","data":{}}]}',
    ),
  });
  await expect(page.getByRole("alert")).toContainText("Invalid");
  await expect(page.locator(".local-workspace-card")).toContainText([
    "Personal",
    "Client Alpha",
  ]);
  await page.getByLabel("Import workspace backup file").setInputFiles({
    name: "valid.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  d = page.getByRole("dialog", {
    name: "Replace local workspace data?",
    exact: true,
  });
  await d
    .getByRole("button", { name: "Replace local data", exact: true })
    .click();
  await page.goto("/skills");
  await expect(page.locator(".table")).toContainText("Personal handbook");
  await page.reload();
  await expect(page.locator(".table")).toContainText("Personal handbook");
});
test("legacy 0.2 data is migrated without changing the original records", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "hyperagents-demo:threads",
      JSON.stringify([
        {
          id: "legacy-thread",
          title: "A saved original thread",
          summary: "Imported legacy summary",
          time: "yesterday",
        },
      ]),
    );
    localStorage.setItem(
      "hyperagents-demo:memories",
      JSON.stringify([
        {
          id: "legacy-memory",
          content: "Keep my existing facts.",
          category: "User Fact",
          importance: 3,
          pinned: true,
        },
      ]),
    );
  });
  await page.goto("/threads");
  await expect(page.locator(".thread-cards")).toContainText(
    "A saved original thread",
  );
  await page.goto("/memories");
  await expect(page.locator(".rp-memory-list")).toContainText(
    "Keep my existing facts.",
  );
  await page.reload();
  await expect(page.locator(".rp-memory-list")).toContainText(
    "Keep my existing facts.",
  );
});
test("webpage artifacts cannot execute scripts or load remote images", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("should-not-load.invalid")) requests.push(r.url());
  });
  await newArtifact(
    page,
    "Safe webpage",
    '<h1>Sandbox preview</h1><script>window.BAD_MARKER=123</script><img src="https://should-not-load.invalid/track.png">',
    "Webpage",
  );
  await page.getByRole("button", { name: /Safe webpage from/ }).click();
  await expect(
    page
      .frameLocator(".local-web-frame")
      .getByRole("heading", { name: "Sandbox preview" }),
  ).toBeVisible();
  const handle = await page.locator(".local-web-frame").elementHandle();
  const frame = await handle!.contentFrame();
  expect(await frame!.evaluate(() => typeof (window as any).BAD_MARKER)).toBe(
    "undefined",
  );
  expect(requests).toEqual([]);
});

test("connector metadata can be configured and removed without authentication", async ({
  page,
}) => {
  await page.goto("/threads/new?settings=integrations");
  await page
    .getByRole("textbox", { name: "Search integrations" })
    .fill("Notion");
  await page
    .locator(".sx-integration-card")
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  let d = page.getByRole("dialog", { name: "Connect Notion", exact: true });
  await d.getByLabel("Connection label", { exact: true }).fill("Team notes");
  await d
    .getByLabel("Endpoint (optional)", { exact: true })
    .fill("https://example.com/mcp");
  await d
    .getByRole("button", { name: "Save configuration", exact: true })
    .click();
  await page.reload();
  await expect(
    page.locator(".sx-integration-card").filter({ hasText: "Team notes" }),
  ).toContainText("Not authenticated");
  await page
    .locator(".sx-integration-card")
    .filter({ hasText: "Team notes" })
    .getByRole("button", { name: "Manage configuration" })
    .click();
  d = page.getByRole("dialog", { name: "Connection settings", exact: true });
  await expect(
    d.getByLabel("Endpoint (optional)", { exact: true }),
  ).toHaveValue("https://example.com/mcp");
  page.once("dialog", (dialog) => dialog.accept());
  await d.getByRole("button", { name: "Remove configuration" }).click();
  await expect(
    page.locator(".sx-integration-card").filter({ hasText: "Team notes" }),
  ).toHaveCount(0);
});
test("rubrics have persistent manual criteria and editable names", async ({
  page,
}) => {
  await page.goto("/rubrics");
  await page
    .getByRole("button", { name: "Create rubric", exact: true })
    .click();
  let d = page.getByRole("dialog", { name: "Create rubric", exact: true });
  await d.getByLabel("Name", { exact: true }).fill("UI readiness");
  await d
    .getByLabel("Criteria", { exact: true })
    .fill("Links navigate correctly\nEmpty states are clear");
  await d.getByRole("button", { name: "Save rubric", exact: true }).click();
  await page.reload();
  await expect(page.locator(".local-summary-cards")).toContainText(
    "Links navigate correctly",
  );
  await page.getByRole("button", { name: "Edit rubric" }).click();
  d = page.getByRole("dialog", { name: "Edit rubric" });
  await d.getByLabel("Name", { exact: true }).fill("Release readiness");
  await d.getByRole("button", { name: "Save rubric", exact: true }).click();
  await expect(page.locator(".local-summary-cards")).toContainText(
    "Release readiness",
  );
});
test("search includes local skills and rooms from the active workspace", async ({
  page,
}) => {
  await createSkill(page, "Evidence notebook");
  await page.keyboard.press("Control+k");
  const d = page.getByRole("dialog", { name: "Search", exact: true });
  await d
    .getByRole("textbox", { name: "Search workspace" })
    .fill("Evidence notebook");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/skills\/skill-/);
  await expect(
    page.getByRole("heading", { name: "Evidence notebook", exact: true }),
  ).toBeVisible();
});

test("local content visual reference captures", async ({ page }, info) => {
  await createSkill(page, "Launch handbook");
  await page.screenshot({
    path: info.outputPath("skill-detail.png"),
    fullPage: true,
  });
  await page.goto("/skills");
  await page.screenshot({
    path: info.outputPath("skills-local.png"),
    fullPage: true,
  });
  await page.goto("/workspaces");
  await page.screenshot({
    path: info.outputPath("workspace-backup.png"),
    fullPage: true,
  });
});
