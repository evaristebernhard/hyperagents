import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, realpath, stat, readlink, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DomainError } from "@hyper/contracts";
const exec = promisify(execFile);
export const sandboxSlice = "hyperagents-sandbox.slice";
let initializing: Promise<void> | undefined;
export async function ensureSandboxSlice() {
  initializing ??= (async () => {
    await exec("systemctl", ["--user", "start", sandboxSlice], {
      timeout: 5000,
    });
    await exec(
      "systemctl",
      [
        "--user",
        "set-property",
        "--runtime",
        sandboxSlice,
        "MemoryMax=5G",
        "MemorySwapMax=0",
        "CPUQuota=200%",
        "TasksMax=768",
      ],
      { timeout: 5000 },
    );
    const { stdout } = await exec(
      "systemctl",
      [
        "--user",
        "show",
        sandboxSlice,
        "-p",
        "MemoryMax",
        "-p",
        "CPUQuotaPerSecUSec",
        "-p",
        "ControlGroup",
      ],
      { timeout: 5000 },
    );
    if (
      !stdout.includes("MemoryMax=5368709120") ||
      !stdout.includes("CPUQuotaPerSecUSec=2s") ||
      !/ControlGroup=\//.test(stdout)
    )
      throw new DomainError("CGROUP_LIMITS_UNAVAILABLE");
  })().catch((error) => {
    initializing = undefined;
    throw error;
  });
  return initializing;
}
export function unitName(kind: "compute" | "browser", id: string) {
  if (!/^[a-zA-Z0-9-]{1,70}$/.test(id)) throw new DomainError("SANDBOX_ID");
  return `hyperagents-${kind}-${id}.service`;
}
export function systemdArgs(
  kind: "compute" | "browser",
  id: string,
  runtimeSeconds?: number,
) {
  return [
    "--user",
    "--quiet",
    "--pipe",
    "--wait",
    "--collect",
    "--unit=" + unitName(kind, id),
    "--property=Slice=" + sandboxSlice,
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=3s",
    "--property=SendSIGKILL=yes",
    "--property=MemoryMax=" + (kind === "compute" ? "2G" : "1536M"),
    "--property=MemorySwapMax=0",
    "--property=CPUQuota=200%",
    "--property=TasksMax=" + (kind === "compute" ? "160" : "256"),
    ...(runtimeSeconds ? ["--property=RuntimeMaxSec=" + runtimeSeconds] : []),
    "--",
  ];
}
export async function stopSandbox(kind: "compute" | "browser", id: string) {
  try {
    await exec("systemctl", ["--user", "stop", unitName(kind, id)], {
      timeout: 8000,
      maxBuffer: 10000,
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 5) throw error;
  }
}
export async function runtimeBundle(
  directory: string,
  kind: "compute" | "browser",
  verifyFiles = false,
) {
  const dir = await realpath(resolve(directory));
  const manifest = await readFile(join(dir, "manifest.json"));
  const checksum = (
    await readFile(join(dir, "manifest.sha256"), "utf8")
  ).trim();
  if (createHash("sha256").update(manifest).digest("hex") !== checksum)
    throw new DomainError("RUNTIME_MANIFEST_CORRUPT");
  const value = JSON.parse(manifest.toString()) as {
    version: number;
    kind: string;
    files: Record<string, { sha256?: string; link?: string; mode?: number }>;
  };
  if (
    value.version !== 1 ||
    value.kind !== kind ||
    !(await stat(join(dir, "rootfs"))).isDirectory()
  )
    throw new DomainError("RUNTIME_BUNDLE_INVALID");
  if (verifyFiles) {
    for (const [name, file] of Object.entries(value.files)) {
      const path = resolve(dir, "rootfs", name);
      if (!path.startsWith(join(dir, "rootfs") + "/"))
        throw new DomainError("RUNTIME_PATH_INVALID");
      const metadata = await lstat(path);
      if (
        file.link !== undefined &&
        (!metadata.isSymbolicLink() || (await readlink(path)) !== file.link)
      )
        throw new DomainError("RUNTIME_LINK_CORRUPT");
      if (
        file.sha256 &&
        (!metadata.isFile() || metadata.mode % 512 !== file.mode)
      )
        throw new DomainError("RUNTIME_MODE_CORRUPT");
      if (
        file.sha256 &&
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex") !== file.sha256
      )
        throw new DomainError("RUNTIME_FILE_CORRUPT");
    }
  }
  return { rootfs: join(dir, "rootfs"), checksum };
}
export async function sandboxMetrics() {
  const { stdout } = await exec(
    "systemctl",
    [
      "--user",
      "show",
      sandboxSlice,
      "-p",
      "MemoryCurrent",
      "-p",
      "CPUUsageNSec",
      "-p",
      "TasksCurrent",
    ],
    { timeout: 3000, maxBuffer: 10000 },
  );
  const values = Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  return {
    memoryBytes: Number(values.MemoryCurrent) || 0,
    cpuNanos: Number(values.CPUUsageNSec) || 0,
    tasks: Number(values.TasksCurrent) || 0,
  };
}
