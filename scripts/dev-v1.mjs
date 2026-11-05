import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { mkdir, writeFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import { homedir } from "node:os";
import privateDataPlugin, { privateFsDeny } from "./private-data.mjs";

// Fail before opening the persistent database if any v1 port is occupied.
for (const port of [5173, 8081, 55432]) {
  const probe = createTcpServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise((resolve) => probe.close(resolve));
  } catch {
    throw Error(
      `Backend v1 port ${port} is already in use. The existing service was left running.`,
    );
  }
}
const requireBackend = createRequire(
  new URL("../backend/package.json", import.meta.url),
);
const { default: EmbeddedPostgres } = await import(
  requireBackend.resolve("embedded-postgres")
);
const runtime = await import("../backend/packages/runtime/dist/index.js");
const root = path.resolve("backend/.data-v1/interactive");
await mkdir(root, { recursive: true, mode: 0o700 });
for (const filename of [".env"]) {
  try {
    process.loadEnvFile(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
// Legacy runner.env is intentionally not loaded: it can silently select a stale
// daemon. A remote Runner must now be explicitly configured in .env/environment.
if (!process.env.RUNNER_URL && !process.env.COMPUTE_RUNTIME_DIR) {
  const installed = path.join(
    homedir(),
    ".local/share/hyperagents/runtimes/compute",
  );
  try {
    await access(path.join(installed, "manifest.json"));
    process.env.COMPUTE_RUNTIME_DIR = installed;
  } catch {}
}
const publicOrigin = new URL(
  process.env.V1_PUBLIC_ORIGIN ||
    process.env.APP_PUBLIC_ORIGIN ||
    "http://localhost:5173",
).origin;
const allowedOrigins = [
  ...new Set(
    [
      publicOrigin,
      process.env.APP_PUBLIC_ORIGIN,
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]
      .filter(Boolean)
      .map((value) => new URL(value).origin),
  ),
];
const pg = new EmbeddedPostgres({
  databaseDir: path.join(root, "postgres"),
  port: 55432,
  user: "hyper",
  password: "hyper",
  persistent: true,
  autoRehydrateSymlinks: true,
  onLog: () => {},
  onError: () => {},
  postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
});
const children = [];
let vite,
  closing = false,
  started = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  await vite?.close();
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null)
            return resolve();
          const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
  if (started) await pg.stop();
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void close());
try {
  try {
    await access(path.join(root, "postgres", "PG_VERSION"));
  } catch {
    await pg.initialise();
  }
  await pg.start();
  started = true;
  try {
    await pg.createDatabase("hyper_v1");
  } catch (e) {
    if (e.code !== "42P04") throw e;
  }
  const env = {
    ...process.env,
    DATABASE_URL: "postgres://hyper:hyper@127.0.0.1:55432/hyper_v1",
    DATA_DIR: path.join(root, "files"),
    PUBLIC_ORIGIN: publicOrigin,
    ADDITIONAL_ORIGINS: allowedOrigins
      .filter((origin) => origin !== publicOrigin)
      .join(","),
    HOST: "127.0.0.1",
    PORT: "8081",
  };
  env.KERNEL_SOCKET ||= path.join(root, "run", "kernel.sock");
  env.KERNEL_BRIDGE_SOCKET ||= path.join(root, "run", "bridge.sock");
  const db = runtime.pool(env.DATABASE_URL);
  let needsKernel =
    env.RUST_NEW_TASKS === "true" || env.KERNEL_ENABLED === "true";
  try {
    await runtime.migrate(db);
    needsKernel ||= !!(
      await db.query(
        "SELECT 1 FROM tasks WHERE runtime_kind='rust' AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1",
      )
    ).rowCount;
    if (!(await db.query("SELECT 1 FROM users LIMIT 1")).rowCount) {
      const credentials = {
        email: "demo@example.com",
        password: randomBytes(15).toString("base64url"),
      };
      await runtime.bootstrap(db, credentials);
      await writeFile(
        path.join(root, "access.json"),
        JSON.stringify(credentials),
        { mode: 0o600 },
      );
    }
  } finally {
    await db.end();
  }
  const services = ["api", "worker"];
  if (env.COMPUTE_RUNTIME_DIR && !env.RUNNER_URL) {
    env.RUNNER_URL = "http://127.0.0.1:" + (env.RUNNER_PORT || "8084");
    env.RUNNER_PORT ||= "8084";
    env.RUNNER_TOKEN ||= randomBytes(32).toString("hex");
    services.unshift("runner");
  }
  if (env.BROWSER_ENABLED === "true" && !env.BROWSER_URL) {
    env.BROWSER_URL = "http://127.0.0.1:" + (env.BROWSER_PORT || "8083");
    env.BROWSER_TOKEN ||= randomBytes(32).toString("hex");
    env.BROWSER_PROFILE_DIR ||= path.join(root, "browser-profiles");
    services.unshift("browser");
  }
  if (needsKernel) {
    await new Promise((resolve, reject) => {
      const build = spawn(
        "cargo",
        ["build", "--locked", "--manifest-path", "backend/kernel/Cargo.toml"],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      build.once("error", reject);
      build.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("Kernel build failed")),
      );
    });
    services.unshift("kernel");
  }
  const internalEnv = (service) => {
    if (service === "api" || service === "worker") return env;
    const common = [
      "PATH",
      "HOME",
      "USER",
      "LANG",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
      "NODE_ENV",
    ];
    const keys =
      service === "kernel"
        ? [...common, "DATABASE_URL", "KERNEL_SOCKET", "KERNEL_BRIDGE_SOCKET"]
        : service === "runner"
          ? [
              ...common,
              "DATA_DIR",
              "HOST",
              "RUNNER_PORT",
              "RUNNER_TOKEN",
              "SANDBOX_BACKEND",
              "SANDBOX_RUNSC",
              "SANDBOX_IMAGE",
              "COMPUTE_RUNTIME_DIR",
            ]
          : [
              ...common,
              "DATABASE_URL",
              "DATA_DIR",
              "HOST",
              "BROWSER_ENABLED",
              "BROWSER_PORT",
              "BROWSER_TOKEN",
              "BROWSER_PROFILE_DIR",
              "BROWSER_RUNTIME_KIND",
              "BROWSER_RUNTIME_DIR",
              "BROWSER_PROXY",
              "BROWSER_CONTAINER",
              "BROWSER_EXECUTABLE",
            ];
    return Object.fromEntries(
      keys
        .filter((key) => env[key] !== undefined)
        .map((key) => [key, env[key]]),
    );
  };
  for (const service of services) {
    const child = spawn(
      service === "kernel"
        ? "backend/kernel/target/debug/hyperagents-kernel"
        : process.execPath,
      service === "kernel"
        ? []
        : [
            service === "browser"
              ? "backend/browser-service/index.mjs"
              : `backend/apps/${service}/dist/index.js`,
          ],
      { env: internalEnv(service), stdio: ["ignore", "inherit", "inherit"] },
    );
    children.push(child);
    child.once("error", () => void close(1));
    child.once("exit", () => {
      if (!closing) void close(1);
    });
  }
  let healthy = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      healthy = (
        await fetch("http://127.0.0.1:8081/health", {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {}
    if (healthy) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!healthy) throw Error("Backend API did not become ready.");
  process.env.VITE_BACKEND_V1 = "true";
  vite = await createServer({
    configFile: false,
    optimizeDeps: {
      entries: ["index.html"],
      esbuildOptions: { target: "es2022" },
    },
    plugins: [privateDataPlugin(), react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      allowedHosts: [
        ...new Set(allowedOrigins.map((origin) => new URL(origin).hostname)),
      ],
      fs: { strict: true, deny: [...privateFsDeny, "**/backend/**"] },
      watch: {
        ignored: [
          "**/.data/**",
          "**/backend/.data-v1/**",
          "**/backend/kernel/target/**",
          "**/backend/kernel/vendor/**",
          "**/infinity/**",
          "**/OpenMausBot/**",
          "**/browser/**",
          "**/macro/**",
        ],
      },
      headers: {
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "frame-ancestors 'none'",
      },
      proxy: {
        "/api/v1": {
          target: "http://127.0.0.1:8081",
          changeOrigin: false,
          ws: true,
        },
      },
    },
  });
  await vite.listen();
  console.log("Main UI + backend v1: http://localhost:5173");
  console.log(
    "Local login credentials: backend/.data-v1/interactive/access.json",
  );
} catch (error) {
  console.error(error.message);
  await close(1);
}
