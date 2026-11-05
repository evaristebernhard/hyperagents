import { mkdir, chmod, lstat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { connect } from "node:net";
import { request } from "node:http";
import type { FastifyInstance } from "fastify";
import { DomainError } from "@hyper/contracts";
export async function listenPrivate(app: FastifyInstance, path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  try {
    const metadata = await lstat(path);
    if (!metadata.isSocket() || metadata.uid !== process.getuid?.())
      throw new DomainError("UNSAFE_SOCKET_PATH");
    const live = await new Promise<boolean>((resolve) => {
      const socket = connect(path);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (live) throw new DomainError("SOCKET_ALREADY_RUNNING");
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await app.listen({ path });
  await chmod(path, 0o600);
}
export async function kernelHealth(
  path?: string,
): Promise<{ available: boolean; protocol?: number; version?: string }> {
  if (!path) return { available: false };
  try {
    return await new Promise((resolve, reject) => {
      const req = request(
        { socketPath: path, path: "/v1/health", timeout: 1000 },
        (res) => {
          let text = "";
          res.on("data", (data) => {
            text += data;
            if (text.length > 10000) req.destroy(new Error("RESPONSE_SIZE"));
          });
          res.on("end", () => {
            try {
              const value = JSON.parse(text);
              resolve({
                available:
                  res.statusCode === 200 &&
                  value.protocol === 1 &&
                  value.version === "infinity-1abc6fc-v1",
                ...value,
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("KERNEL_TIMEOUT")));
      req.on("error", reject);
      req.end();
    });
  } catch {
    return { available: false };
  }
}

export async function kernelRequest(
  path: string | undefined,
  route: string,
  body: unknown,
): Promise<unknown> {
  if (!path) throw new DomainError("KERNEL_NOT_CONFIGURED");
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: path,
        path: route,
        method: "POST",
        timeout: 10000,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
          if (text.length > 10000) req.destroy(new Error("RESPONSE_SIZE"));
        });
        res.on("end", () => {
          try {
            const value = JSON.parse(text);
            if (res.statusCode !== 200)
              throw new DomainError(value.error || "KERNEL_REQUEST_FAILED");
            resolve(value);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("KERNEL_TIMEOUT")));
    req.on("error", reject);
    req.end(data);
  });
}

// flock attaches to the shared open-file description. The short-lived helper
// exits; the parent's descriptor retains the lock and releases it even on SIGKILL.
export async function fileLease(path: string) {
  const { open } = await import("node:fs/promises");
  const { spawn } = await import("node:child_process");
  const handle = await open(path, "a", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("flock", ["--nonblock", "3"], {
        stdio: ["ignore", "ignore", "ignore", handle.fd],
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new DomainError("SERVICE_ALREADY_RUNNING")),
      );
    });
    return () => handle.close();
  } catch (error) {
    await handle.close();
    throw error;
  }
}
