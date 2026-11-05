// Opt-in real bubblewrap/Chromium/VNC acceptance. Uses only disposable profiles.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { config, sandboxMetrics } from "@hyper/runtime";
import {
  launchLightweight,
  probeLightweight,
} from "../browser-service/lightweight.mjs";
const exec = promisify(execFile);
const root = await mkdtemp("/tmp/hyper-browser-live-"),
  cfg = config({ ...process.env, BROWSER_PROFILE_DIR: join(root, "profiles") });
if (!cfg.BROWSER_RUNTIME_DIR)
  throw new Error("Set BROWSER_RUNTIME_DIR to a built browser bundle");
const fixture =
  '<!doctype html><meta charset="utf-8"><title>Sandbox acceptance</title><h1>Dummy login</h1><input id="entry"><button id="save">Save dummy login</button><script>save.onclick=async()=>{localStorage.setItem("login","retained");document.cookie="fixture=retained;Max-Age=86400;Secure;SameSite=Lax";const r=indexedDB.open("fixture",1);r.onupgradeneeded=()=>r.result.createObjectStore("state");r.onsuccess=()=>{const tx=r.result.transaction("state","readwrite");tx.objectStore("state").put("retained","login");tx.oncomplete=()=>{r.result.close();document.body.dataset.saved="yes"}}}</script>';
const live = [],
  units = [],
  resources = [];
async function record(label) {
  resources.push({
    label,
    at: new Date().toISOString(),
    ...(await sandboxMetrics()),
  });
}
async function start(profile) {
  const id = randomUUID(),
    before = Date.now();
  const b = await launchLightweight(cfg, chromium, profile, id);
  units.push(id);
  live.push(b);
  console.log(JSON.stringify({ browserStartedMs: Date.now() - before }));
  return b;
}
async function close(b) {
  await b.closeContext().catch(() => {});
  await b.stop();
  live.splice(live.indexOf(b), 1);
}
async function page(b) {
  const p = await b.context.newPage();
  await p.route("https://example.com/hyper-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: fixture }),
  );
  await p.bringToFront();
  await p.goto("https://example.com/hyper-fixture");
  return p;
}
async function vnc(path) {
  const socket = connect(path);
  let bytes = Buffer.alloc(0),
    pending;
  socket.setTimeout(5000, () => socket.destroy(new Error("RFB_TIMEOUT")));
  socket.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    pending?.();
  });
  const take = (n) =>
    new Promise((resolve, reject) => {
      const pump = () => {
        if (bytes.length >= n) {
          const part = bytes.subarray(0, n);
          bytes = bytes.subarray(n);
          pending = null;
          socket.off("error", reject);
          resolve(part);
        }
      };
      pending = pump;
      socket.once("error", reject);
      pump();
    });
  const version = await take(12);
  assert.match(version.toString(), /^RFB 003\./);
  socket.write("RFB 003.008\n");
  const count = (await take(1))[0],
    types = await take(count);
  assert.ok(types.includes(1));
  socket.write(Buffer.from([1]));
  assert.equal((await take(4)).readUInt32BE(), 0);
  socket.write(Buffer.from([1]));
  const init = await take(24);
  await take(init.readUInt32BE(20));
  socket.setTimeout(0);
  socket.on("error", () => {});
  return {
    socket,
    key(code) {
      for (const down of [1, 0]) {
        const packet = Buffer.alloc(8);
        packet[0] = 4;
        packet[1] = down;
        packet.writeUInt32BE(code, 4);
        socket.write(packet);
      }
    },
  };
}
try {
  await record("idle");
  const before = Date.now();
  await probeLightweight(cfg, chromium);
  console.log(JSON.stringify({ sandboxProbeMs: Date.now() - before }));
  const identity = randomUUID(),
    b = await start(identity),
    p = await page(b);
  await record("one-browser");
  await p.click("#save");
  await p.waitForFunction(() => document.body.dataset.saved === "yes");
  assert.ok((await b.context.cookies()).some(c => c.name === "fixture"));
  await p.locator("#entry").focus();
  const observer = await vnc(b.vncSocket("observe"));
  observer.key(0x61);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await p.locator("#entry").inputValue(), "");
  observer.socket.destroy();
  const writer = await vnc(b.vncSocket("write"));
  writer.key(0x62);
  await p.waitForFunction(() => document.querySelector("#entry").value === "b");
  writer.socket.destroy();
  const next = p.waitForEvent("download");
  await p.evaluate(() => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob(["download-proof"], { type: "text/plain" }),
    );
    a.download = "proof.txt";
    a.click();
  });
  const download = await next;
  const path = await download.path();
  assert.equal((await b.readDownload(path)).toString(), "download-proof");
  const second = await start(randomUUID()),
    secondPage = await page(second);
  await record("two-browsers");
  assert.equal(
    await secondPage.evaluate(() => localStorage.getItem("login")),
    null,
  );
  assert.ok(
    !(await second.context.cookies()).some((c) => c.name === "fixture"),
  );
  await close(second);
  await close(b);
  const reopened = await start(identity),
    restored = await page(reopened);
  assert.equal(
    await restored.evaluate(() => localStorage.getItem("login")),
    "retained",
  );
  assert.ok(
    (await reopened.context.cookies()).some(
      (c) => c.name === "fixture" && c.value === "retained",
    ),
  );
  assert.equal(
    await restored.evaluate(
      () =>
        new Promise((resolve) => {
          const r = indexedDB.open("fixture", 1);
          r.onsuccess = () => {
            const t = r.result.transaction("state");
            const q = t.objectStore("state").get("login");
            q.onsuccess = () => {
              resolve(q.result);
              r.result.close();
            };
          };
        }),
    ),
    "retained",
  );
  // This navigation uses actual egress; fixture interception covers only its exact URL.
  await restored.goto("https://example.com/", { timeout: 25000 });
  assert.match(await restored.title(), /Example Domain/);
  await close(reopened);
  await record("closed");
  for (const id of units) {
    const { stdout } = await exec("systemctl", [
      "--user",
      "show",
      `hyperagents-browser-${id}.service`,
      "-p",
      "ActiveState",
    ]);
    assert.ok(!stdout.includes("ActiveState=active"));
  }
  const report = {
    status: "passed",
    checks: [
      "real-chromium-sandbox",
      "private-and-metadata-egress-denied",
      "file-policy",
      "public-egress",
      "vnc-readonly-input-rejected",
      "vnc-write-input",
      "download-export",
      "two-profiles-isolated",
      "persistent-cookies-localstorage-indexeddb",
      "full-process-group-cleanup",
    ],
    resources,
  };
  console.log(JSON.stringify(report));
  if (process.env.SANDBOX_REPORT)
    await writeFile(
      process.env.SANDBOX_REPORT,
      JSON.stringify(report, null, 2) + "\n",
    );
} finally {
  for (const b of [...live]) await close(b);
  await rm(root, { recursive: true, force: true });
}
