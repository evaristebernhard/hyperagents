import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { config } from "@hyper/runtime";
import { createRunner } from "@hyper/runner";
import { ociConfig } from "../apps/runner/src/direct.js";
test("one runner owns a receipt directory and releases ownership on shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-owner-"));
  const cfg = config({
    DATA_DIR: root,
    RUNNER_TOKEN: randomUUID() + randomUUID(),
  });
  const first = await createRunner(cfg);
  try {
    await assert.rejects(createRunner(cfg), /SERVICE_ALREADY_RUNNING/);
  } finally {
    await first.close();
  }
  const replacement = await createRunner(cfg);
  await replacement.close();
  await rm(root, { recursive: true, force: true });
});
test("OCI compute mounts only immutable runtime, immutable inputs and bounded scratch", () => {
  const spec = ociConfig("/runtime/rootfs", "/receipt/inputs");
  assert.equal(spec.root.readonly, true);
  assert.deepEqual(
    spec.mounts.filter((m) => m.type === "bind").map((m) => m.source),
    ["/receipt/inputs"],
  );
  assert.deepEqual(
    new Set(spec.linux.namespaces.map((n) => n.type)),
    new Set(["pid", "network", "ipc", "uts", "mount", "user"]),
  );
  assert.ok(spec.process.noNewPrivileges);
  assert.deepEqual(spec.process.capabilities.effective, []);
  assert.ok(!spec.process.env.some((e) => /KEY|TOKEN|DATABASE|DBUS/.test(e)));
  assert.ok(
    spec.mounts.some(
      (m) => m.destination === "/work" && m.options?.includes("size=1g"),
    ),
  );
});
