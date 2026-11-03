import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { mkdir, writeFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import privateDataPlugin, { privateFsDeny } from "./private-data.mjs";

// Fail before opening the persistent database if any v1 port is occupied.
for (const port of [5174, 8081, 55432]) {
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
for (const filename of [".env", "backend/.data-v1/runner.env"]) {
  try {
    process.loadEnvFile(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
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
    PUBLIC_ORIGIN: "http://localhost:5174",
    HOST: "127.0.0.1",
    PORT: "8081",
  };
  const db = runtime.pool(env.DATABASE_URL);
  try {
    await runtime.migrate(db);
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
  for (const service of ["api", "worker"]) {
    const child = spawn(
      process.execPath,
      [`backend/apps/${service}/dist/index.js`],
      { env, stdio: ["ignore", "inherit", "inherit"] },
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
    plugins: [privateDataPlugin(), react()],
    server: {
      host: "127.0.0.1",
      port: 5174,
      strictPort: true,
      fs: { strict: true, deny: [...privateFsDeny, "**/backend/**"] },
      watch: {
        ignored: [
          "**/.data/**",
          "**/backend/.data-v1/**",
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
        "/api/v1": { target: "http://127.0.0.1:8081", changeOrigin: false },
      },
    },
  });
  await vite.listen();
  console.log("Main UI + backend v1: http://localhost:5174");
  console.log(
    "Local login credentials: backend/.data-v1/interactive/access.json",
  );
} catch (error) {
  console.error(error.message);
  await close(1);
}
