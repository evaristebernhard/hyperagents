// UI contract test: API responses are fixtures; no browser service or credentials used.
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
const { WebSocketServer } = createRequire(
  new URL("../backend/package.json", import.meta.url),
)("ws");
const server = await createServer({
  configFile: false,
  optimizeDeps: {
    entries: ["index.html"],
    esbuildOptions: { target: "es2022" },
  },
  plugins: [react()],
  define: { "import.meta.env.VITE_BACKEND_V1": '"true"' },
  server: {
    host: "127.0.0.1",
    port: 5185,
    strictPort: true,
    watch: {
      ignored: [
        "**/backend/**",
        "**/infinity/**",
        "**/browser/**",
        "**/macro/**",
        "**/OpenMausBot/**",
      ],
    },
  },
});
await server.listen();
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage();
const ids = [
  "00000000-0000-4000-a000-000000000001",
  "00000000-0000-4000-a000-000000000002",
  "00000000-0000-4000-a000-000000000003",
  "00000000-0000-4000-a000-000000000004",
];
const [tid, cid, pid, sid] = ids,
  date = "2026-11-03T00:00:00Z";
const task = {
  id: tid,
  conversationId: cid,
  prompt: "Search after I log in",
  state: "waiting_browser",
  waitReason: "human_control",
  browserProfileId: pid,
  createdAt: date,
  updatedAt: date,
};
const conversation = {
  id: cid,
  title: task.prompt,
  created_at: date,
  messages: [{ id: "1", role: "user", content: task.prompt, created_at: date }],
  artifacts: [],
  metadata: {},
  revision: 1,
};
const session = {
  id: sid,
  profile_id: pid,
  profile_name: "Research account",
  task_id: tid,
  state: "open",
  control: "paused",
  control_epoch: 0,
  controller_id: null,
  tabs: [
    {
      tabId: "tab",
      title: "Sign in",
      url: "https://example.org/login",
      active: true,
    },
  ],
};
const errors = [],
  transitions = [];
page.on("pageerror", (e) => errors.push(e.message));
await context.addInitScript(() =>
  localStorage.setItem("hyperagents:v1:csrf", "test"),
);
await context.route("**/api/**", async (route) => {
  const req = route.request(),
    url = new URL(req.url()),
    p = url.pathname.replace("/api/v1", ""),
    reply = (v, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(v),
      });
  if (p === "/auth/session")
    return reply({
      userId: "user",
      workspaceId: "workspace",
      admin: true,
      role: "admin",
    });
  if (p === "/workspaces")
    return reply([{ id: "workspace", name: "Personal", role: "admin" }]);
  if (["/resources", "/library", "/members"].includes(p)) return reply([]);
  if (p === "/capabilities")
    return reply({
      models: [{ provider: "test", model: "test", configured: true }],
      search: { provider: "public", degraded: false },
      sandbox: { available: false },
      browser: { available: true, operations: ["observe", "navigate"] },
      formats: ["md", "pdf"],
      externalActions: false,
    });
  if (p === "/conversations") return reply([conversation]);
  if (p.startsWith("/conversations/")) return reply(conversation);
  if (p === "/tasks") return reply([task]);
  if (p === "/tasks/" + tid) return reply(task);
  if (p.endsWith("/events")) return reply({ events: [], nextCursor: "0" });
  if (p === "/browser/profiles")
    return reply([
      { id: pid, name: "Research account", kind: "personal", grants: [] },
    ]);
  if (p === "/browser/sessions") return reply([session]);
  if (p === "/browser/sessions/" + sid) return reply(session);
  if (p.endsWith("/view-ticket"))
    return reply({
      ticket: "fixture-ticket",
      permission: req.postDataJSON().permission,
    });
  if (p.endsWith("/takeover") || p.endsWith("/handback")) {
    const action = p.endsWith("/takeover") ? "takeover" : "handback";
    transitions.push({
      action,
      body: req.postDataJSON(),
      key: req.headers()["idempotency-key"],
    });
    assert.equal(req.postDataJSON().expectedEpoch, session.control_epoch);
    session.control_epoch++;
    session.control = action === "takeover" ? "human" : "agent";
    session.controller_id = action === "takeover" ? "user" : null;
    return reply(session);
  }
  return reply({ error: "UNEXPECTED_ROUTE" }, 404);
});
const frames = new WebSocketServer({ noServer: true });
server.httpServer.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/api/v1/browser/"))
    frames.handleUpgrade(req, socket, head, (ws) =>
      frames.emit("connection", ws),
    );
});
frames.on("connection", (ws) => {
  let stage = 0;
  ws.on("message", () => {
    if (stage === 0) {
      stage++;
      ws.send(Buffer.from([1, 1]));
    } else if (stage === 1) {
      stage++;
      ws.send(Buffer.alloc(4));
    } else if (stage === 2) {
      stage++;
      const init = Buffer.alloc(28);
      init.writeUInt16BE(1280, 0);
      init.writeUInt16BE(800, 2);
      init[4] = 32;
      init[5] = 24;
      init[7] = 1;
      init.writeUInt16BE(255, 8);
      init.writeUInt16BE(255, 10);
      init.writeUInt16BE(255, 12);
      init[14] = 16;
      init[15] = 8;
      init.writeUInt32BE(4, 20);
      init.write("Test", 24);
      ws.send(init);
    }
  });
  ws.send(Buffer.from("RFB 003.008\n"));
});
try {
  await page.goto(`http://127.0.0.1:5185/thread/${cid}`);
  await page.getByRole("region", { name: "Persistent browser" }).waitFor();
  await page.getByText("https://example.org/login", { exact: true }).waitFor();
  await page.getByRole("button", { name: "View only", exact: true }).click();
  await page.getByText(/Connected · Read only/).waitFor();
  await page.getByRole("button", { name: "Take over", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect controls", exact: true })
    .waitFor();
  await page
    .getByLabel("Note for the agent (optional)")
    .fill("Logged in; search for quarterly results.");
  await page
    .getByRole("button", { name: "Disconnect view", exact: true })
    .click();
  assert.equal(transitions.length, 1, "disconnect must not hand back");
  await page.reload();
  await page
    .getByRole("button", { name: "Connect controls", exact: true })
    .waitFor();
  assert.equal(transitions.length, 1, "refresh must not hand back");
  await page
    .getByLabel("Note for the agent (optional)")
    .fill("Logged in; search for quarterly results.");
  await page
    .getByRole("button", { name: "Hand back to agent", exact: true })
    .click();
  await page.getByRole("button", { name: "Take over", exact: true }).waitFor();
  assert.equal(
    transitions[1].body.note,
    "Logged in; search for quarterly results.",
  );
  assert.ok(transitions.every((t) => t.key));
  await page.getByRole("button", { name: "Expand", exact: true }).click();
  await page
    .getByRole("button", { name: "Exit expanded view", exact: true })
    .waitFor();
  await mkdir("docs/verification-browser", { recursive: true });
  await page.screenshot({
    path: "docs/verification-browser/thread.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Exit expanded view", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Artifacts · 0", exact: true })
    .click();
  await page.getByText("No linked artifacts", { exact: true }).waitFor();
  await page.goto("http://127.0.0.1:5185/integrations");
  await page.getByRole("heading", { name: "Browser identities" }).waitFor();
  await page.getByRole("button", { name: "Open / sign in" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS browser panel, takeover, disconnect, refresh, explicit handback with note, expand, Artifacts tab and Integrations identity management (fixture API)",
  );
} catch (e) {
  console.log("UI errors", errors);
  console.log(
    await page
      .locator(".browser-panel")
      .innerText()
      .catch(() => ""),
  );
  throw e;
} finally {
  await context.close();
  await browser.close();
  for (const socket of frames.clients) socket.terminate();
  await new Promise((r) => frames.close(r));
  await server.close();
}
