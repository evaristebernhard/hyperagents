import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { connect } from "node:net";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import {
  runtimeBundle,
  ensureSandboxSlice,
  systemdArgs,
  stopSandbox,
} from "@hyper/runtime";
import { createEgressProxy } from "./egress.mjs";

export function browserArgs(rootfs, profile, control) {
  return [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--uid",
    "1000",
    "--gid",
    "1000",
    "--ro-bind",
    rootfs,
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--size",
    "268435456",
    "--tmpfs",
    "/tmp",
    "--size",
    "1073741824",
    "--tmpfs",
    "/work",
    "--tmpfs",
    "/run",
    "--bind",
    profile,
    "/profile",
    "--bind",
    control,
    "/control",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/local/bin:/usr/bin:/bin",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "HOME",
    "/profile",
    "/usr/local/bin/hyper-browser-init",
  ];
}
function unixJson(socketPath, path) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, timeout: 1500 }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
        if (data.length > 100000) req.destroy(new Error("CDP_RESPONSE_SIZE"));
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("CDP_TIMEOUT")));
    req.on("error", reject);
    req.end();
  });
}
export async function launchLightweight(cfg, chromium, profileId, id) {
  if (!cfg.BROWSER_RUNTIME_DIR || process.getuid?.() === 0)
    throw new Error("BROWSER_BUNDLE_REQUIRED");
  const bundle = await runtimeBundle(cfg.BROWSER_RUNTIME_DIR, "browser");
  await ensureSandboxSlice();
  const profile = join(cfg.BROWSER_PROFILE_DIR, profileId);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(tmpdir(), "browser-session-"));
  const control = join(work, "control");
  await mkdir(control, { mode: 0o700 });
  const proxy = createEgressProxy();
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(join(control, "egress.sock"), resolve);
  });
  let child,
    browser,
    downloads,
    diagnostic = "",
    closing = false;
  let closeRequest;
  function closeContext() {
    closeRequest ??= (async () => {
      if (!browser?.isConnected()) return;
      let timer;
      try {
        const exited = new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("exit", resolve);
        });
        await Promise.race([
          (async () => {
            await downloads.send("Browser.close");
            await exited;
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("BROWSER_CLOSE_TIMEOUT")),
              5000,
            );
          }),
        ]);
      } catch (error) {
        if (browser.isConnected()) throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
    return closeRequest;
  }
  const proxySockets = new Set();
  proxy.on("connection", (socket) => {
    proxySockets.add(socket);
    socket.on("close", () => proxySockets.delete(socket));
  });
  async function stop() {
    if (closing) return;
    closing = true;
    try {
      await closeContext().catch((error) =>
        console.error(
          JSON.stringify({
            service: "browser",
            code: "GRACEFUL_CLOSE_FAILED",
            detail: String(error),
          }),
        ),
      );
      await stopSandbox("browser", id);
    } finally {
      for (const socket of proxySockets) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
      child?.kill("SIGTERM");
      await rm(work, { recursive: true, force: true });
    }
  }
  try {
    child = spawn(
      "systemd-run",
      [
        ...systemdArgs("browser", id),
        "/usr/bin/bwrap",
        ...browserArgs(bundle.rootfs, profile, control),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-16000);
    });
    let launchError;
    child.on("error", (error) => {
      launchError = error;
    });
    let version,
      endpointsReady = false;
    for (let i = 0; i < 300; i++) {
      if (launchError || child.exitCode !== null || child.signalCode !== null)
        throw new Error("BROWSER_START_FAILED: " + diagnostic);
      try {
        version = await unixJson(join(control, "cdp.sock"), "/json/version");
        await stat(join(control, "control.sock"));
        await stat(join(control, "observe.sock"));
        endpointsReady = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!endpointsReady || !version?.webSocketDebuggerUrl)
      throw new Error("BROWSER_START_TIMEOUT: " + diagnostic);
    const endpoint = new URL(version.webSocketDebuggerUrl);
    // ws+unix is accepted by Playwright's ws transport. CDP never listens on host TCP.
    const ws = new WebSocket(
      `ws+unix://${join(control, "cdp.sock")}:${endpoint.pathname}`,
    );
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const transport = {
      send(message) {
        // Keep Playwright's download events on its root CDP session, while
        // downloading into sandbox tmpfs and observing actual desktop focus.
        if (
          message.method === "Browser.setDownloadBehavior" &&
          message.params?.downloadPath
        )
          message.params.downloadPath = "/work/downloads";
        if (message.method === "Emulation.setFocusEmulationEnabled")
          message.params.enabled = false;
        ws.send(JSON.stringify(message));
      },
      close() {
        ws.close();
      },
    };
    ws.on("message", (data) => transport.onmessage?.(JSON.parse(data)));
    ws.on("close", () => transport.onclose?.());
    ws.on("error", (error) => transport.onclose?.(error.message));
    browser = await chromium.connectOverCDP(transport, {
      timeout: 15000,
      artifactsDir: work,
    });
    downloads = await browser.newBrowserCDPSession();
    const context = browser.contexts()[0];
    if (!context) throw new Error("BROWSER_CONTEXT_MISSING");
    return {
      context,
      closeContext,
      processes: [child],
      work,
      stop,
      diagnostics: () => diagnostic,
      vncSocket: (permission) =>
        join(
          control,
          permission === "observe" ? "observe.sock" : "control.sock",
        ),
      async readDownload(path) {
        if (!path || !/^[a-f0-9-]{36}$/.test(basename(path)))
          throw new Error("UNSAFE_DOWNLOAD");
        return await new Promise((resolve, reject) => {
          const socket = connect(join(control, "files.sock"));
          let size = 0;
          const chunks = [];
          socket.setTimeout(10000, () =>
            socket.destroy(new Error("DOWNLOAD_TIMEOUT")),
          );
          socket.on("connect", () =>
            socket.write(JSON.stringify({ name: basename(path) }) + "\n"),
          );
          socket.on("data", (chunk) => {
            size += chunk.length;
            if (size > 28_000_000) socket.destroy(new Error("FILE_SIZE"));
            else chunks.push(chunk);
          });
          socket.on("error", reject);
          socket.on("end", () => {
            try {
              const result = JSON.parse(Buffer.concat(chunks));
              if (result.error) throw new Error(result.error);
              resolve(Buffer.from(result.data, "base64"));
            } catch (error) {
              reject(error);
            }
          });
        });
      },
    };
  } catch (error) {
    await browser?.close().catch(() => {});
    await stop();
    throw error;
  }
}
export async function probeLightweight(cfg, chromium) {
  if (!cfg.BROWSER_RUNTIME_DIR)
    throw new Error("BROWSER_RUNTIME_NOT_CONFIGURED");
  await runtimeBundle(cfg.BROWSER_RUNTIME_DIR, "browser", true);
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  let launched;
  try {
    launched = await launchLightweight(cfg, chromium, id, id);
    const page = await launched.context.newPage();
    // Chromium reports its own process and namespace sandbox status.
    await page.goto("chrome://sandbox", { timeout: 10000 });
    const status = await page.locator("body").innerText();
    if (
      !/(?:Namespace Sandbox\s+Yes|Layer 1 Sandbox\s+Namespace)/.test(status) ||
      !/PID namespaces\s+Yes/.test(status) ||
      !/Network namespaces\s+Yes/.test(status) ||
      !/Seccomp-BPF sandbox\s+Yes/.test(status)
    )
      throw new Error("CHROMIUM_SANDBOX_DISABLED: " + status.slice(0, 1000));
    let blocked = false;
    try {
      await page.goto("file:///etc/passwd", { timeout: 5000 });
      blocked = !(await page.locator("body").innerText()).includes("root:");
    } catch {
      blocked = true;
    }
    if (!blocked) throw new Error("LOCAL_FILE_POLICY_DISABLED");
    for (const url of [
      "http://169.254.169.254/",
      "http://127.0.0.1/",
      "http://10.0.0.1/",
    ]) {
      const denied = await new Promise((resolve, reject) => {
        const req = request(
          {
            socketPath: join(launched.work, "control/egress.sock"),
            path: url,
            timeout: 2000,
          },
          (response) => {
            let body = "";
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () =>
              resolve(response.statusCode === 403 && body === "EGRESS_DENIED"),
            );
          },
        );
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("EGRESS_PROBE_TIMEOUT")));
        req.end();
      });
      if (!denied) throw new Error("PRIVATE_EGRESS_NOT_DENIED");
    }
  } catch (error) {
    throw new Error(String(error) + "\n" + (launched?.diagnostics() || ""));
  } finally {
    await launched?.closeContext().catch(() => {});
    await launched?.stop();
    await rm(join(cfg.BROWSER_PROFILE_DIR, id), {
      recursive: true,
      force: true,
    });
  }
}
