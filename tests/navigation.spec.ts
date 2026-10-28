import { setSystemPrompt } from "./helpers";
import { test, expect } from "@playwright/test";
const routes = [
  ["/threads/new", "Let's get to work."],
  ["/threads", "Threads"],
  ["/thread/small-business", "Working notes"],
  ["/agents", "Agents"],
  ["/agents/new", "Identity"],
  ["/rooms/new", "A shared room for this work."],
  ["/skills", "Skills"],
  ["/skills/small-biz-builder", "Small Biz Website Builder"],
  ["/skills/new", "Create skill"],
  ["/memories", "Memories"],
  ["/projects", "Projects"],
  ["/projects/new", "Project details"],
  ["/projects/hello", "Threads (1)"],
  ["/library", "Library"],
  ["/marketplace", "Hire your team of agents"],
  ["/marketplace/a/priya", "Priya"],
  ["/marketplace/s/small-biz-builder", "Small Biz Website Builder"],
  ["/inbox", "Inbox"],
  ["/learning", "Learning"],
  ["/rubrics", "Rubrics"],
  ["/wiki", "Autowiki"],
  ["/command-center", "Command Center"],
  ["/documents", "Documents"],
  ["/hyperapps", "HyperApps"],
  ["/workflows", "Workflows"],
  ["/workspaces", "Workspaces"],
];
for (const [route, text] of routes)
  test("direct route " + route, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(route);
    await expect(page.locator("main.main-content")).toContainText(text);
    expect(errors).toEqual([]);
  });
test("search, keyboard, browser history and refresh", async ({ page }) => {
  await page.goto("/threads/new");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Search", exact: true });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "Search workspace" })
    .fill("Library");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/library$/);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Library", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/threads\/new$/);
});
test("composer menus and local-only conversation persist", async ({ page }) => {
  await page.goto("/threads/new");
  await page.getByRole("button", { name: "Add files or context" }).click();
  await page.getByRole("button", { name: "Output as…" }).click();
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await page.getByLabel("Task prompt").fill("Build a concise launch plan");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page).toHaveURL(/\/thread\/local-/);
  await expect(page.locator(".conversation-scroll")).toContainText(
    "Build a concise launch plan",
  );
  await expect(page.locator(".conversation-scroll")).toContainText("no LLM");
  await page.reload();
  await expect(page.locator(".conversation-scroll")).toContainText(
    "Build a concise launch plan",
  );
});
test("settings are query driven and escape closes", async ({ page }) => {
  await page.goto("/learning?settings=personalization");
  let dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(page).toHaveURL(/\/learning\?settings=appearance$/);
  await dialog.getByRole("combobox", { name: "Color mode" }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/learning$/);
  await expect(dialog).not.toBeVisible();
});
test("legacy integrations compatibility points at current settings modal", async ({
  page,
}) => {
  await page.goto("/settings/integrations");
  await expect(page).toHaveURL(/\/threads\/new\?settings=integrations$/);
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search integrations" })
    .fill("Notion");
  await expect(page.locator(".sx-integration-card")).toHaveCount(1);
  await page
    .locator(".sx-integration-card")
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Connect Notion", exact: true }),
  ).toContainText("not connected");
});
test("memory dialog saves locally and survives reload", async ({ page }) => {
  await page.goto("/memories");
  await page
    .getByRole("button", { name: "Add memory", exact: true })
    .first()
    .click();
  const d = page.getByRole("dialog", { name: "Add Memory", exact: true });
  await d
    .getByLabel("Memory Content")
    .fill("Always distinguish verified facts from assumptions.");
  await d.getByRole("button", { name: "Add Memory", exact: true }).click();
  await expect(page.locator(".rp-memory-list")).toContainText(
    "Always distinguish verified facts",
  );
  await page.reload();
  await expect(page.locator(".rp-memory-list")).toContainText(
    "Always distinguish verified facts",
  );
});
test("project creation and thread association", async ({ page }) => {
  await page.goto("/projects/new");
  await page.getByLabel("Project name", { exact: true }).fill("Launch project");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Track the interface rollout");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects\/project-/);
  await page
    .getByRole("button", { name: "Add existing thread", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Velocity Theorem Explanation" })
    .click();
  await expect(page.locator(".rp-project-thread-card")).toContainText(
    "Velocity Theorem",
  );
});
test("agent identity save, tabs and edit round trip", async ({ page }) => {
  await page.goto("/agents/new");
  await page.getByRole("button", { name: "Fill these in manually →" }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Research guide");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Research thoughtfully");
  await setSystemPrompt(page, "Verify facts and ask before outward-facing actions.");
  for (const n of [
    "Model",
    "Tools & integrations",
    "Invocations",
    "Knowledge",
    "Identity",
  ])
    await page
      .getByRole("navigation", { name: "Agent configuration" })
      .getByRole("button", { name: n, exact: true })
      .click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await page.getByRole("link", { name: /Research guide/ }).click();
  await expect(page.getByLabel("Agent name", { exact: true })).toHaveValue(
    "Research guide",
  );
  await page.reload();
  await expect(page.getByLabel("Agent name", { exact: true })).toHaveValue(
    "Research guide",
  );
});
test("thread canvas, title menu and panel query", async ({ page }) => {
  await page.goto("/thread/small-business");
  await page.getByRole("button", { name: "Tile", exact: true }).click();
  await expect(page.locator(".artifact-tile")).toHaveCount(6);
  await page.getByRole("button", { name: "Carousel", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Open Local potential, redesigned",
      exact: true,
    })
    .click();
  await expect(
    page.frameLocator(".local-web-frame").locator("main"),
  ).toContainText("Loved around town.");
  await page
    .getByRole("button", { name: "Open thread details", exact: true })
    .click();
  await expect(page).toHaveURL(/\?panel=settings$/);
  await page
    .getByRole("button", { name: "Close thread details", exact: true })
    .click();
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Set up Live mode" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Small Biz Website Builder Thread",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  const d = page.getByRole("dialog", { name: "Rename thread" });
  await d.getByLabel("Thread name").fill("Updated local thread");
  await d.getByRole("button", { name: "Save name" }).click();
  await expect(page.locator(".thread-title")).toHaveText(
    "Updated local thread",
  );
});
test("settings sections render distinct views without runtime errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const s of [
    "personalization",
    "appearance",
    "thread-defaults",
    "security",
    "notifications",
    "integrations",
    "mcp-access",
    "import-openclaw",
    "import-manus",
    "billing",
    "usage",
    "ai-providers",
    "referrals",
  ]) {
    await page.goto("/threads/new?settings=" + s);
    await expect(
      page.getByRole("dialog", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".sx-content h2")).not.toBeEmpty();
  }
  expect(errors).toEqual([]);
});
test("mobile main screens do not overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of [
    "/threads/new",
    "/thread/small-business",
    "/agents/new",
    "/memories",
    "/projects",
    "/library",
    "/marketplace",
    "/threads/new?settings=integrations",
  ]) {
    await page.goto(route);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBeTruthy();
    await expect(page.locator("body")).not.toBeEmpty();
  }
});
test("visual reference captures", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 1280 });
  for (const [route, name] of [
    ["/threads/new", "home"],
    ["/thread/small-business", "thread"],
    ["/agents/new", "agent"],
    ["/marketplace", "marketplace"],
    ["/threads/new?settings=integrations", "settings"],
  ]) {
    await page.goto(route);
    await page.screenshot({
      path: info.outputPath(name + ".png"),
      fullPage: true,
    });
  }
});
test("search autofocus and normal typing remain stable", async ({ page }) => {
  await page.goto("/threads/new");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("marketplace", { delay: 25 });
  const input = page.getByRole("textbox", { name: "Search workspace" });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("marketplace");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/marketplace$/);
});
test("mobile artifact preview is reachable and dismissible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/thread/small-business");
  await page.getByRole("button", { name: "View artifact on mobile" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Working notes",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});
test("public marketing, format tabs, login and standalone 404", async ({
  page,
}) => {
  await page.goto("/marketing");
  await expect(
    page.getByRole("heading", {
      name: "Agents that ship real, powerful work.",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next step", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "The fleet gets building." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dashboards", exact: true }).click();
  await expect(page.locator(".marketing-format-caption")).toContainText(
    "Dashboards",
  );
  await page.getByRole("link", { name: "Sign up", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page
    .getByRole("button", { name: "Continue to demo workspace →" })
    .click();
  await expect(page).toHaveURL(/\/threads\/new$/);
  await page.goto("/signup");
  await expect(
    page.getByRole("heading", { name: "404", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).not.toBeVisible();
});
test("demonstration flows make no API or model requests", async ({ page }) => {
  const api: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" || r.url().includes("/api/")) api.push(r.url());
  });
  await page.goto("/threads/new");
  await page.getByLabel("Task prompt").fill("A local-only prompt");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page).toHaveURL(/\/thread\/local-/);
  await page.goto("/threads/new?settings=ai-providers");
  await page.getByRole("button", { name: "◉ Connect with ChatGPT" }).click();
  await expect(
    page.getByRole("dialog", { name: "Connect ChatGPT", exact: true }),
  ).toBeVisible();
  expect(api).toEqual([]);
});
