import { launchLightweight, probeLightweight } from "./lightweight.mjs";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { randomUUID, randomBytes } from "node:crypto";
import {
  mkdir,
  rm,
  readFile,
  stat,
  access,
  writeFile,
  mkdtemp,
} from "node:fs/promises";
import { join } from "node:path";
import { BrowserAction, Id, Format, Limits } from "@hyper/contracts";
import {
  config,
  pool,
  tx,
  getTask,
  browserAccess,
  browserEvent,
  browserJson,
  enqueueBrowserResult,
  validateBrowserTicket,
  hash,
  equal,
  Storage,
} from "@hyper/runtime";

export async function createBrowserService(db, cfg, options = {}) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  const instance = randomUUID(),
    live = new Map(),
    starting = new Map(),
    active = new Map(),
    sockets = new Map(),
    slots = new Set();
  const storage = new Storage(cfg.DATA_DIR, db);
  let ready = false,
    stopping = false;
  const singleton = await db.connect();
  const lock = await singleton.query(
    "SELECT pg_try_advisory_lock(730111) AS locked",
  );
  if (!lock.rows[0].locked) {
    singleton.release();
    throw new Error("BROWSER_SERVICE_ALREADY_RUNNING");
  }
  let released = false;
  async function releaseSingleton() {
    if (released) return;
    released = true;
    await singleton.query("SELECT pg_advisory_unlock(730111)").catch(() => {});
    singleton.release();
  }
  try {
    // Losing the DB lock must stop every browser, rather than allow a second live owner.
    singleton.on("error", () => {
      ready = false;
      for (const b of live.values()) {
        b.context.close().catch(() => {});
        if (b.stop) void b.stop().catch(() => {});
        else for (const p of b.processes) p.kill("SIGKILL");
      }
    });
    await mkdir(cfg.BROWSER_PROFILE_DIR, { recursive: true, mode: 0o700 });
    if (!options.test) {
      if (cfg.BROWSER_RUNTIME_KIND === "lightweight") {
        await probeLightweight(cfg, options.chromium || chromium);
      } else {
        if (
          process.getuid?.() === 0 ||
          !cfg.BROWSER_PROXY ||
          process.env.BROWSER_CONTAINER !== "1"
        )
          throw new Error("ISOLATED_BROWSER_CONTAINER_REQUIRED");
        await access(
          process.env.BROWSER_EXECUTABLE || chromium.executablePath(),
        );
        await probeIsolation(cfg);
      }
    }
    if (!options.test && cfg.BROWSER_RUNTIME_KIND === "lightweight") {
      const { stopSandbox } = await import("@hyper/runtime");
      const prior = await db.query(
        "SELECT id FROM browser_sessions WHERE state IN ('starting','open','error')",
      );
      for (const row of prior.rows) await stopSandbox("browser", row.id);
    }
    // A process crash cannot establish whether a click or submit happened. Never replay it.
    await tx(db, async (c) => {
      const rows = await c.query(
        "UPDATE browser_outbox SET status='uncertain',result='{\"error\":\"BROWSER_PROCESS_LOST\"}' WHERE status='running' RETURNING *",
      );
      for (const r of rows.rows)
        await enqueueBrowserResult(
          c,
          r.operation_id,
          r.task_id,
          { error: "BROWSER_PROCESS_LOST" },
          true,
        );
      const pending = await c.query(
        "UPDATE browser_outbox SET status='obsolete' WHERE status='pending' RETURNING *",
      );
      for (const r of pending.rows)
        await enqueueBrowserResult(c, r.operation_id, r.task_id, {
          error: "BROWSER_RESTARTED_BEFORE_DISPATCH",
        });
      const sessions = await c.query(
        "UPDATE browser_sessions SET state='closed',control='paused',control_epoch=control_epoch+1,controller_id=NULL WHERE state IN ('open','starting') RETURNING *",
      );
      for (const s of sessions.rows) {
        if (s.task_id)
          await c.query(
            "INSERT INTO task_inputs(id,task_id,kind,payload) VALUES($1,$2,'connection_error','{}') ON CONFLICT DO NOTHING",
            [`restart:${instance}:${s.id}`, s.task_id],
          );
        await browserEvent(c, s, "service_restarted");
      }
    });
    app.setErrorHandler((error, req, reply) =>
      reply.code(error.status || 409).send({
        error: /^[A-Z_]+$/.test(error.message)
          ? error.message
          : "BROWSER_OPERATION_FAILED",
      }),
    );
    app.addHook("onRequest", async (req) => {
      if (!ready && req.url !== "/health")
        throw Object.assign(new Error("BROWSER_UNAVAILABLE"), { status: 503 });
      if (
        !cfg.BROWSER_TOKEN ||
        !equal(req.headers.authorization || "", `Bearer ${cfg.BROWSER_TOKEN}`)
      )
        throw Object.assign(new Error("FORBIDDEN"), { status: 403 });
    });
    const session = async (id) => {
      Id.parse(id);
      const s = (
        await db.query("SELECT * FROM browser_sessions WHERE id=$1", [id])
      ).rows[0];
      if (!s) throw new Error("NOT_FOUND");
      return s;
    };
    function dropSockets(id) {
      for (const socket of sockets.get(id) || []) socket.revoke?.();
      sockets.delete(id);
    }
    async function closeSession(id, reason = "closed") {
      await tx(db, async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(730110)");
        const s = (
          await c.query(
            "UPDATE browser_sessions SET control='transferring',control_epoch=control_epoch+1,controller_id=NULL WHERE id=$1 RETURNING *",
            [id],
          )
        ).rows[0];
        if (s) await browserEvent(c, s, reason);
      });
      dropSockets(id);
      await active.get(id)?.catch(() => {});
      await starting.get(id)?.catch(() => {});
      const b = live.get(id);
      if (b) {
        await saveTabs(id, b);
        live.delete(id);
        await (b.closeContext ? b.closeContext() : b.context.close()).catch(
          () => {},
        );
        if (b.stop) await b.stop();
        else await stopProcesses(b.processes);
        live.delete(id);
        slots.delete(b.slot);
        await rm(b.work, { recursive: true, force: true });
      }
      await tx(db, async (c) => {
        const s = (
          await c.query(
            "UPDATE browser_sessions SET state='closed',control='paused' WHERE id=$1 RETURNING *",
            [id],
          )
        ).rows[0];
        if (s) await browserEvent(c, s, reason);
        if (s?.task_id)
          await c.query(
            "INSERT INTO task_inputs(id,task_id,kind,payload) VALUES($1,$2,'connection_error','{}') ON CONFLICT DO NOTHING",
            [`closed:${id}:${s.control_epoch}`, s.task_id],
          );
      });
    }
    function hookPage(b, page, explicit = false) {
      if (b.pageIds.has(page)) return;
      if (!explicit && page.url() === "about:blank") {
        if (b.pendingPages.has(page)) return;
        b.pendingPages.add(page);
        const activate = () => {
          if (page.url() === "about:blank") return;
          page.off("framenavigated", activate);
          b.pendingPages.delete(page);
          hookPage(b, page);
        };
        page.on("framenavigated", activate);
        page.once("close", () => page.off("framenavigated", activate));
        return;
      }
      if (
        /^(?:chrome:\/\/(?:omnibox|tab-search)|chrome-error:)/.test(page.url())
      )
        return;
      b.pageIds.add(page);
      const id = randomUUID();
      b.pages.set(id, page);
      b.current = id;
      page.on("close", () => {
        if (b.dialogPage === id) {
          b.dialog = null;
          b.dialogPage = null;
        }
        b.pages.delete(id);
        if (b.current === id) b.current = b.pages.keys().next().value;
      });
      page.on("dialog", (dialog) => {
        b.current = id;
        b.dialog = dialog;
        b.dialogPage = id;
      });
      // A human can dismiss a native JavaScript dialog through VNC. Reconcile
      // that event too, rather than keeping an already-handled Playwright Dialog.
      void b.context
        .newCDPSession(page)
        .then(async (cdp) => {
          cdp.on("Page.javascriptDialogClosed", () => {
            if (b.dialogPage === id) {
              b.dialog = null;
              b.dialogPage = null;
            }
          });
          await cdp.send("Page.enable");
        })
        .catch(() => {});
      // Suppress native filesystem picking; uploads enter only through authorized workspace file IDs.
      page.on("filechooser", () => {});
      page.on("download", (download) => {
        b.downloads.push(download);
        if (b.downloads.length > 10)
          void b.downloads
            .shift()
            .delete()
            .catch(() => {});
      });
      page.on("framenavigated", () => invalidateRefs(b));
    }
    async function saveTabs(id, b) {
      const tabs = [];
      for (const [tabId, page] of b.pages)
        if (!page.isClosed())
          tabs.push({
            tabId,
            url: safeUrl(page.url()),
            title: b.dialog
              ? "Dialog open"
              : (await page.title().catch(() => "")).slice(0, 200),
            active: tabId === b.current,
          });
      await db.query("UPDATE browser_sessions SET tabs=$2 WHERE id=$1", [
        id,
        browserJson(tabs),
      ]);
      return tabs;
    }
    async function startSession(id) {
      if (live.has(id)) return live.get(id);
      if (starting.has(id)) return starting.get(id);
      const pending = (async () => {
        const s = await session(id);
        if (!["open", "starting"].includes(s.state))
          throw new Error("SESSION_CLOSED");
        if (slots.size >= 2) throw new Error("BROWSER_CAPACITY");
        const slot = slots.has(0) ? 1 : 0,
          display = ":" + (90 + slot),
          port = 5900 + slot * 2;
        slots.add(slot);
        let work;
        const processes = [];
        try {
          let context, lightweight;
          if (cfg.BROWSER_RUNTIME_KIND === "lightweight" && !options.test) {
            lightweight = await launchLightweight(
              cfg,
              options.chromium || chromium,
              s.profile_id,
              id,
            );
            work = lightweight.work;
            context = lightweight.context;
            processes.push(...lightweight.processes);
          } else {
            work = await mkdtemp("/tmp/browser-session-");
            const auth = join(work, "Xauthority");
            // Authenticate each display; another profile cannot connect to its X server.
            await run("xauth", [
              "-f",
              auth,
              "add",
              display,
              ".",
              randomBytes(16).toString("hex"),
            ]);
            const dir = join(cfg.BROWSER_PROFILE_DIR, Id.parse(s.profile_id));
            await mkdir(dir, { recursive: true, mode: 0o700 });
            // X server has no TCP listener. VNC is loopback-only, with a separate server-enforced read-only endpoint.
            processes.push(
              managed(
                "Xvfb",
                [
                  display,
                  "-screen",
                  "0",
                  "1280x800x24",
                  "-nolisten",
                  "tcp",
                  "-auth",
                  auth,
                ],
                { stdio: "ignore" },
              ),
            );
            await waitFile("/tmp/.X11-unix/X" + (90 + slot), processes[0]);
            processes.push(
              managed("openbox", ["--config-file", "/etc/xdg/openbox/rc.xml"], {
                env: { ...process.env, DISPLAY: display, XAUTHORITY: auth },
                stdio: "ignore",
              }),
            );
            context = await (
              options.chromium || chromium
            ).launchPersistentContext(dir, {
              executablePath: process.env.BROWSER_EXECUTABLE,
              downloadsPath: join(work, "downloads"),
              artifactsDir: work,
              headless: false,
              chromiumSandbox: true,
              viewport: null,
              acceptDownloads: true,
              env: {
                DISPLAY: display,
                XAUTHORITY: auth,
                HOME: dir,
                PATH: process.env.PATH,
                BROWSER_PROFILE: dir,
                BROWSER_WORK: work,
              },
              proxy: { server: cfg.BROWSER_PROXY, bypass: "<-loopback>" },
              args: [
                "--disable-dev-shm-usage",
                "--disable-quic",
                "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                "--disable-features=WebRtcHideLocalIpsWithMdns",
                "--window-size=1280,800",
                "--no-first-run",
              ],
            });
          }
          const b = {
            ...lightweight,
            context,
            processes,
            slot,
            port,
            work,
            pages: new Map(),
            pageIds: new WeakSet(),
            pendingPages: new WeakSet(),
            refs: new Map(),
            current: null,
            dialog: null,
            downloads: [],
            last: Date.now(),
          };
          live.set(id, b);
          for (const page of context.pages()) hookPage(b, page);
          context.on("page", (page) => hookPage(b, page));
          context.on("close", () => {
            if (!stopping && live.get(id) === b)
              void closeSession(id, "browser_disconnected").catch(() => {});
          });
          if (!b.pages.size) hookPage(b, await context.newPage(), true);
          // Recover addresses only; the persistent profile restores cookies/storage, not page memory.
          const prior =
            (
              await db.query(
                "SELECT tabs FROM browser_sessions WHERE profile_id=$1 AND id<>$2 ORDER BY created_at DESC LIMIT 1",
                [s.profile_id, id],
              )
            ).rows[0]?.tabs || [];
          await Promise.allSettled(
            prior
              .slice(0, 10)
              .filter((t) => /^https?:\/\//.test(t.url))
              .map(async (t) => {
                const restored = await context.newPage();
                hookPage(b, restored, true);
                await restored.goto(t.url, {
                  timeout: 5000,
                  waitUntil: "domcontentloaded",
                });
              }),
          );
          if (!lightweight)
            for (const readonly of [false, true]) {
              processes.push(
                managed(
                  "x11vnc",
                  [
                    "-display",
                    display,
                    "-auth",
                    auth,
                    "-localhost",
                    "-rfbport",
                    String(port + (readonly ? 1 : 0)),
                    "-forever",
                    "-shared",
                    "-nopw",
                    "-noxdamage",
                    "-nosel",
                    "-quiet",
                    ...(readonly ? ["-viewonly"] : []),
                  ],
                  { stdio: "ignore" },
                ),
              );
              await waitPort(port + (readonly ? 1 : 0));
            }
          await db.query(
            "UPDATE browser_sessions SET state='open',last_active_at=now() WHERE id=$1",
            [id],
          );
          await saveTabs(id, b);
          return b;
        } catch (e) {
          const b = live.get(id);
          live.delete(id);
          await (b?.closeContext ? b.closeContext() : b?.context.close()).catch(
            () => {},
          );
          if (b?.stop) await b.stop();
          else await stopProcesses(processes);
          slots.delete(slot);
          if (work) await rm(work, { recursive: true, force: true });
          await db.query(
            "UPDATE browser_sessions SET state='error',control='paused' WHERE id=$1",
            [id],
          );
          throw e;
        }
      })();
      starting.set(id, pending);
      try {
        return await pending;
      } finally {
        starting.delete(id);
      }
    }
    async function observe(id, b) {
      invalidateRefs(b);
      // Native tab/window changes made by the human do not emit a Playwright
      // "selected tab" event. Reconcile focus before the handback observation.
      if (!b.dialog) {
        const states = await Promise.all(
          [...b.pages].map(async ([tabId, page]) => {
            let timer;
            try {
              const state = await Promise.race([
                page.evaluate(() => ({
                  visible: document.visibilityState === "visible",
                  focused: document.hasFocus(),
                })),
                new Promise((resolve) => {
                  timer = setTimeout(() => resolve(null), 1500);
                }),
              ]);
              return state ? { tabId, ...state } : null;
            } catch {
              return null;
            } finally {
              clearTimeout(timer);
            }
          }),
        );
        const current =
          states.find((s) => s?.focused && s.visible) ||
          states.find((s) => s?.visible);
        if (current) b.current = current.tabId;
      }
      const page = b.pages.get(b.current) || b.pages.values().next().value;
      if (!page) throw new Error("NO_TAB");
      if (b.dialog)
        return {
          tabs: await saveTabs(id, b),
          dialog: {
            type: b.dialog.type(),
            message: b.dialog.message().slice(0, 300),
          },
        };
      if (
        await page
          .locator(
            'input[type=password],input[autocomplete=\"one-time-code\"],iframe[src*=\"captcha\"],iframe[title*=\"challenge\" i]',
          )
          .count()
      )
        return { tabs: await saveTabs(id, b), humanRequired: true };
      const elements = [],
        stamp = randomUUID().slice(0, 8);
      // Keep handles server-side: website-authored attributes cannot forge a ref.
      for (const frame of page.frames()) {
        const handles = await frame
          .locator(
            'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]',
          )
          .elementHandles();
        for (const h of handles.slice(0, 150 - elements.length)) {
          if (!(await h.isVisible().catch(() => false))) {
            await h.dispose();
            continue;
          }
          const item = await h
            .evaluate((el) => ({
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute("type"),
              label: (
                el.getAttribute("aria-label") ||
                el.getAttribute("placeholder") ||
                el.textContent ||
                ""
              )
                .trim()
                .slice(0, 160),
              value: /password|one-time-code|otp|secret|token/i.test(
                [
                  el.getAttribute("type"),
                  el.getAttribute("name"),
                  el.getAttribute("id"),
                  el.getAttribute("autocomplete"),
                ].join(" "),
              )
                ? undefined
                : typeof el.value === "string"
                  ? el.value.slice(0, 500)
                  : undefined,
            }))
            .catch(() => null);
          if (!item) continue;
          const ref = stamp + ":" + elements.length;
          b.refs.set(ref, h);
          elements.push({ ref, ...item });
        }
        if (elements.length >= 150) break;
      }
      const humanRequired =
        (await page
          .locator(
            'input[type=password],input[autocomplete="one-time-code"],iframe[src*="captcha"],iframe[title*="challenge" i]',
          )
          .count()) > 0;
      // Never include sensitive field values, password text, HTML, screenshots or recordings in observations.
      const text = humanRequired
        ? ""
        : (
            await page
              .locator("body")
              .innerText({ timeout: 3000 })
              .catch(() => "")
          ).slice(0, 10000);
      return {
        tabs: await saveTabs(id, b),
        elements,
        text,
        humanRequired,
        dialog: b.dialog
          ? { type: b.dialog.type(), message: b.dialog.message().slice(0, 300) }
          : undefined,
      };
    }
    async function execute(row) {
      let result,
        uncertain = false;
      try {
        const b = await startSession(row.session_id);
        const s = await session(row.session_id),
          task = await getTask(db, row.task_id);
        await browserAccess(
          db,
          s.profile_id,
          task.workspace_id,
          task.requested_by,
        );
        if (
          s.control !== "agent" ||
          s.control_epoch !== row.control_epoch ||
          s.task_id !== task.id ||
          ["cancelled", "failed", "succeeded", "uncertain"].includes(task.state)
        )
          throw new Error("CONTROL_CHANGED");
        if (b.epoch !== s.control_epoch || b.taskId !== task.id) {
          invalidateRefs(b);
          b.epoch = s.control_epoch;
          b.taskId = task.id;
        }
        const a = BrowserAction.parse(row.args);
        const page = a.tabId ? b.pages.get(a.tabId) : b.pages.get(b.current);
        if (!page && !["new_tab", "tabs", "request_human"].includes(a.action))
          throw new Error("TAB_NOT_FOUND");
        const target = () => {
          const h = b.refs.get(a.ref);
          if (!h) throw new Error("STALE_ELEMENT_REF");
          return h;
        };
        const action = async () => {
          switch (a.action) {
            case "navigate":
              await page.bringToFront();
              await page.goto(publicUrl(a.url), {
                timeout: 25000,
                waitUntil: "domcontentloaded",
              });
              break;
            case "new_tab": {
              const p = await b.context.newPage();
              hookPage(b, p, true);
              await p.bringToFront();
              if (a.url)
                await p.goto(publicUrl(a.url), {
                  timeout: 25000,
                  waitUntil: "domcontentloaded",
                });
              break;
            }
            case "close_tab":
              await page.close();
              break;
            case "switch_tab":
              b.current = a.tabId;
              await page.bringToFront();
              break;
            case "click":
              await clickOrDialog(page, target());
              break;
            case "fill": {
              const h = target();
              if (
                await h.evaluate((el) =>
                  /password|one-time-code|otp|secret|token/i.test(
                    [el.type, el.name, el.id, el.autocomplete].join(" "),
                  ),
                )
              )
                throw new Error("HUMAN_INPUT_REQUIRED");
              await h.fill(a.text ?? "", { timeout: 15000 });
              break;
            }
            case "select":
              await target().selectOption(a.values ?? [], { timeout: 15000 });
              break;
            case "scroll":
              await page.mouse.wheel(a.deltaX ?? 0, a.deltaY ?? 600);
              break;
            case "dialog":
              if (!b.dialog) throw new Error("NO_DIALOG");
              if (a.accept) await b.dialog.accept(a.text);
              else await b.dialog.dismiss();
              b.dialog = null;
              break;
            case "upload": {
              if (!task.input_file_ids.includes(a.fileId))
                throw new Error("FILE_NOT_AUTHORIZED");
              const file = await storage.get(task.workspace_id, a.fileId),
                buffer = await storage.bytes(file);
              const h = target();
              if (
                await h.evaluate(
                  (el) => el.tagName === "INPUT" && el.type === "file",
                )
              )
                await h.setInputFiles(
                  { name: file.name, mimeType: file.mime, buffer },
                  { timeout: 15000 },
                );
              else {
                const chooser = page
                  .waitForEvent("filechooser", { timeout: 15000 })
                  .then(
                    (value) => ({ value }),
                    (error) => ({ error }),
                  );
                await h.click({ timeout: 10000, noWaitAfter: true });
                const chosen = await chooser;
                if (chosen.error) throw chosen.error;
                await chosen.value.setFiles({
                  name: file.name,
                  mimeType: file.mime,
                  buffer,
                });
              }
              break;
            }
            case "screenshot": {
              if ((await observe(row.session_id, b)).humanRequired)
                throw new Error("HUMAN_INPUT_REQUIRED");
              const bytes = await page.screenshot({ timeout: 10000 });
              return {
                artifact: await storage.artifact(
                  task,
                  "browser:" + row.operation_id,
                  {
                    name: "browser-" + row.operation_id + ".png",
                    format: "png",
                    bytes,
                    sourceIds: [],
                  },
                  { operationId: row.operation_id, epoch: row.control_epoch },
                ),
              };
            }
            case "download": {
              let download;
              if (a.ref) {
                const pending = page
                  .waitForEvent("download", { timeout: 20000 })
                  .then(
                    (download) => ({ download }),
                    (error) => ({ error }),
                  );
                await target().click({ timeout: 15000, noWaitAfter: true });
                const settled = await pending;
                if (settled.error) throw settled.error;
                download = settled.download;
              } else download = b.downloads.at(-1);
              if (!download) throw new Error("NO_DOWNLOAD");
              const path = await download.path();
              const downloaded = b.readDownload
                ? await b.readDownload(path)
                : path
                  ? await readFile(path)
                  : null;
              if (!downloaded || downloaded.length > Limits.fileBytes) {
                await download.delete();
                throw new Error("FILE_SIZE");
              }
              const name = download
                  .suggestedFilename()
                  .replace(/[/\\\x00-\x1f]/g, "_")
                  .slice(0, 160),
                parsed = Format.safeParse(
                  name.split(".").at(-1)?.toLowerCase(),
                ),
                format = parsed.success ? parsed.data : "bin";
              return {
                artifact: await storage.artifact(
                  task,
                  "browser:" + row.operation_id,
                  { name, format, bytes: downloaded, sourceIds: [] },
                  { operationId: row.operation_id, epoch: row.control_epoch },
                ),
              };
            }
            case "request_human":
              return {
                humanRequired: true,
                question:
                  a.text ||
                  "Take over the browser to sign in, then hand it back.",
              };
            case "tabs":
              return { tabs: await saveTabs(row.session_id, b) };
            case "observe":
              break;
          }
          return a.action === "dialog"
            ? { tabs: await saveTabs(row.session_id, b) }
            : await observe(row.session_id, b);
        };
        let timer;
        try {
          result = await Promise.race([
            action(),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("BROWSER_ACTION_TIMEOUT")),
                30000,
              );
            }),
          ]);
        } catch (e) {
          // Timeout after dispatch may have applied a side effect. Terminate channel before releasing control.
          if (e.message === "BROWSER_ACTION_TIMEOUT") {
            uncertain = true;
            invalidateRefs(b);
            live.delete(row.session_id);
            await (b.closeContext ? b.closeContext() : b.context.close()).catch(
              () => {},
            );
            if (b.stop) await b.stop();
            else await stopProcesses(b.processes);
            slots.delete(b.slot);
            await rm(b.work, { recursive: true, force: true });
            await db.query(
              "UPDATE browser_sessions SET state='error',control='paused',control_epoch=control_epoch+1 WHERE id=$1",
              [row.session_id],
            );
          }
          throw e;
        } finally {
          clearTimeout(timer);
        }
        b.last = Date.now();
        if (result?.humanRequired)
          await tx(db, async (c) => {
            const paused = (
              await c.query(
                "UPDATE browser_sessions SET control='paused',control_epoch=control_epoch+1 WHERE id=$1 AND control='agent' AND control_epoch=$2 RETURNING *",
                [row.session_id, row.control_epoch],
              )
            ).rows[0];
            if (paused)
              await browserEvent(
                c,
                paused,
                "Login or verification needs your input. Take over, then hand back.",
              );
          });
      } catch (e) {
        result = {
          error: /^[A-Z_]+$/.test(e.message)
            ? e.message
            : "BROWSER_ACTION_FAILED",
        };
        if (e.message === "HUMAN_INPUT_REQUIRED") result.humanRequired = true;
        // Playwright errors after an effectful call are ambiguous, even if its timeout fires first.
        if (
          !["observe", "tabs", "screenshot", "request_human"].includes(
            row.args?.action,
          ) &&
          ![
            "CONTROL_CHANGED",
            "STALE_ELEMENT_REF",
            "FILE_NOT_AUTHORIZED",
            "TAB_NOT_FOUND",
            "HUMAN_INPUT_REQUIRED",
          ].includes(e.message)
        )
          uncertain = true;
      }
      if (result?.humanRequired)
        await tx(db, async (c) => {
          const paused = (
            await c.query(
              "UPDATE browser_sessions SET control='paused',control_epoch=control_epoch+1 WHERE id=$1 AND control='agent' AND control_epoch=$2 RETURNING *",
              [row.session_id, row.control_epoch],
            )
          ).rows[0];
          if (paused) await browserEvent(c, paused, "Human input required");
        });
      await tx(db, async (c) => {
        const r = await c.query(
          "UPDATE browser_outbox SET status=$2,result=$3 WHERE operation_id=$1 AND status='running' RETURNING operation_id",
          [
            row.operation_id,
            uncertain ? "uncertain" : "completed",
            browserJson(result),
          ],
        );
        if (r.rowCount)
          await enqueueBrowserResult(
            c,
            row.operation_id,
            row.task_id,
            result,
            uncertain,
          );
      });
    }
    app.get("/health", async () => ({ ok: ready && !stopping }));
    app.get("/metrics", async () => {
      const { sandboxMetrics } = await import("@hyper/runtime");
      return {
        browsers: live.size,
        starting: starting.size,
        operations: active.size,
        ...(cfg.BROWSER_RUNTIME_KIND === "lightweight"
          ? await sandboxMetrics()
          : {}),
      };
    });
    app.post("/sessions/start", async (req) => {
      await startSession(Id.parse(req.body.sessionId));
      return { ok: true };
    });
    app.post("/sessions/close", async (req) => {
      await closeSession(Id.parse(req.body.sessionId));
      return { ok: true };
    });
    app.post("/profiles/delete", async (req) => {
      const id = Id.parse(req.body.profileId);
      await tx(db, async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(730110)");
        if (
          (
            await c.query(
              "SELECT 1 FROM browser_sessions WHERE profile_id=$1 AND state IN ('starting','open')",
              [id],
            )
          ).rowCount
        )
          throw new Error("CLOSE_SESSION_FIRST");
        if (
          (
            await c.query(
              "SELECT 1 FROM tasks WHERE browser_profile_id=$1 AND state NOT IN ('succeeded','failed','cancelled')",
              [id],
            )
          ).rowCount
        )
          throw new Error("PROFILE_IN_USE");
        await rm(join(cfg.BROWSER_PROFILE_DIR, id), {
          recursive: true,
          force: true,
        });
        await c.query(
          "UPDATE browser_profiles SET deleted_at=now() WHERE id=$1",
          [id],
        );
      });
      return { ok: true };
    });
    app.post("/operations", async (req) => {
      const id = Id.parse(req.body.operationId);
      const row = await tx(db, async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(730110)");
        const r = (
          await c.query(
            "SELECT b.*,o.args FROM browser_outbox b JOIN operations o ON o.id=b.operation_id WHERE b.operation_id=$1 FOR UPDATE OF b",
            [id],
          )
        ).rows[0];
        if (!r || r.status !== "pending") return;
        const allowed = await c.query(
          "SELECT task_dispatch_allowed($1) AS allowed",
          [r.task_id],
        );
        if (!allowed.rows[0].allowed) return;
        const s = await session(r.session_id),
          t = await getTask(c, r.task_id);
        if (
          s.control !== "agent" ||
          s.control_epoch !== r.control_epoch ||
          s.task_id !== r.task_id ||
          ["cancelled", "failed", "succeeded", "uncertain"].includes(t.state)
        ) {
          await c.query(
            "UPDATE browser_outbox SET status='obsolete' WHERE operation_id=$1",
            [id],
          );
          await enqueueBrowserResult(c, id, r.task_id, {
            error: "CONTROL_CHANGED",
          });
          return;
        }
        try {
          await browserAccess(c, s.profile_id, t.workspace_id, t.requested_by);
        } catch {
          await c.query(
            "UPDATE browser_outbox SET status='obsolete' WHERE operation_id=$1",
            [id],
          );
          await enqueueBrowserResult(c, id, r.task_id, {
            error: "BROWSER_ACCESS_REVOKED",
            humanRequired: true,
          });
          return;
        }
        if (active.has(s.id)) throw new Error("SESSION_BUSY");
        await c.query(
          "UPDATE browser_outbox SET status='running',service_instance=$2,started_at=now() WHERE operation_id=$1",
          [id, instance],
        );
        return r;
      });
      if (row) {
        const p = execute(row)
          .catch(() => {
            ready = false;
          })
          .finally(() => active.delete(row.session_id));
        active.set(row.session_id, p);
      }
      return { accepted: true };
    });
    app.post("/quiesce", async (req) => {
      const id = Id.parse(req.body.sessionId),
        s = await session(id);
      if (s.control !== "transferring" || s.control_epoch !== req.body.epoch)
        throw new Error("CONTROL_CHANGED");
      dropSockets(id);
      await active.get(id);
      const b = live.get(id);
      if (!b) throw new Error("BROWSER_NOT_RUNNING");
      invalidateRefs(b);
      b.last = Date.now();
      // Pending deliveries from the revoked generation must settle before handback can wake the task.
      await tx(db, async (c) => {
        const rows = await c.query(
          "UPDATE browser_outbox SET status='obsolete' WHERE session_id=$1 AND status='pending' RETURNING *",
          [id],
        );
        for (const r of rows.rows)
          await enqueueBrowserResult(c, r.operation_id, r.task_id, {
            error: "CONTROL_CHANGED",
          });
      });
      return req.body.observe
        ? await observe(id, b)
        : { tabs: await saveTabs(id, b) };
    });
    app.get("/view", { websocket: true }, (socket, req) => {
      const ticketHash = hash(String(req.query.ticket || ""));
      let tcp,
        tick,
        boundId,
        chain = Promise.resolve();
      const close = () => {
        socket.terminate();
        tcp?.destroy();
        clearInterval(tick);
        if (boundId) sockets.get(boundId)?.delete(socket);
      };
      socket.revoke = close;
      socket.on("close", close);
      socket.on("error", close);
      socket.on("message", (data) => {
        if (!tcp) return;
        if (socket.bufferedAmount > 2 * 1024 * 1024) {
          close();
          return;
        }
        chain = chain
          .then(async () => {
            await validateBrowserTicket(db, ticketHash);
            if (!tcp.destroyed) tcp.write(data);
          })
          .catch(close);
      });
      void (async () => {
        const t = await validateBrowserTicket(db, ticketHash, true),
          b = live.get(t.session_id);
        if (!b || socket.readyState !== 1)
          throw new Error("BROWSER_NOT_RUNNING");
        boundId = t.session_id;
        if (t.permission === "write")
          for (const existing of sockets.get(boundId) || [])
            if (existing.permission === "write") existing.revoke?.();
        socket.permission = t.permission;
        const group = sockets.get(boundId) || new Set();
        group.add(socket);
        sockets.set(boundId, group);
        // Separate x11vnc -viewonly endpoint ignores malicious keyboard/pointer packets at the server.
        tcp = b.vncSocket
          ? connect(b.vncSocket(t.permission))
          : connect({
              host: "127.0.0.1",
              port: b.port + (t.permission === "observe" ? 1 : 0),
            });
        tcp.on("data", (data) => {
          if (socket.readyState === 1) {
            if (socket.bufferedAmount > 4 * 1024 * 1024) close();
            else socket.send(data);
          }
        });
        tcp.on("error", close);
        tcp.on("close", close);
        tick = setInterval(() => {
          void validateBrowserTicket(db, ticketHash)
            .then(() => {
              b.last = Date.now();
            })
            .catch(close);
        }, 1000);
      })().catch(close);
    });
    let maintenanceBusy = false;
    const maintenance = setInterval(() => {
      if (maintenanceBusy) return;
      maintenanceBusy = true;
      void (async () => {
        for (const [id, b] of live) {
          if (active.has(id)) continue;
          if (Date.now() - b.last > 30 * 60 * 1000 && !sockets.get(id)?.size)
            await closeSession(id, "idle_timeout");
          else {
            const s = await session(id);
            if (s.task_id) {
              const t = await getTask(db, s.task_id);
              if (t.state === "cancelled") {
                await closeSession(id, "task_cancelled");
                continue;
              }
              try {
                await browserAccess(
                  db,
                  s.profile_id,
                  t.workspace_id,
                  t.requested_by,
                );
              } catch {
                await closeSession(id, "access_revoked");
              }
            }
          }
        }
      })()
        .catch(() => {})
        .finally(() => {
          maintenanceBusy = false;
        });
    }, 5000);
    app.addHook("onClose", async () => {
      stopping = true;
      ready = false;
      clearInterval(maintenance);
      for (const id of live.keys()) await closeSession(id, "service_shutdown");
      await releaseSingleton();
    });
    ready = true;
    return app;
  } catch (error) {
    ready = false;
    stopping = true;
    for (const b of live.values()) {
      await (b.closeContext ? b.closeContext() : b.context.close()).catch(
        () => {},
      );
      if (b.stop) await b.stop().catch(() => {});
      else await stopProcesses(b.processes);
    }
    await releaseSingleton();
    throw error;
  }
}
function publicUrl(value) {
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new Error("URL_NOT_ALLOWED");
  return u.href;
}
function safeUrl(value) {
  try {
    const u = new URL(value);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return "about:blank";
  }
}
async function waitFile(path, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("DISPLAY_FAILED");
    try {
      await access(path);
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("DISPLAY_TIMEOUT");
}
async function waitPort(port) {
  for (let i = 0; i < 100; i++) {
    if (
      await new Promise((r) => {
        const s = connect({ host: "127.0.0.1", port });
        s.once("connect", () => {
          s.destroy();
          r(true);
        });
        s.once("error", () => r(false));
      })
    )
      return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("VNC_TIMEOUT");
}

async function run(file, args) {
  await new Promise((resolve, reject) => {
    const p = spawn(file, args, { stdio: "ignore" });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("BROWSER_ISOLATION_FAILED")),
    );
  });
}

async function clickOrDialog(page, handle) {
  let seen;
  const dialog = new Promise((resolve) => {
    seen = resolve;
    page.once("dialog", seen);
  });
  try {
    await Promise.race([
      handle.click({ timeout: 20000, noWaitAfter: true }),
      dialog,
    ]);
  } finally {
    page.off("dialog", seen);
  }
}

async function probeIsolation(cfg) {
  const dir = join(cfg.BROWSER_PROFILE_DIR, randomUUID()),
    work = await mkdtemp("/tmp/browser-session-"),
    auth = join(work, "Xauthority"),
    display = ":99";
  const processes = [];
  let context;
  await mkdir(dir, { mode: 0o700 });
  try {
    await run("xauth", [
      "-f",
      auth,
      "add",
      display,
      ".",
      randomBytes(16).toString("hex"),
    ]);
    processes.push(
      managed(
        "Xvfb",
        [
          display,
          "-screen",
          "0",
          "1280x800x24",
          "-nolisten",
          "tcp",
          "-auth",
          auth,
        ],
        { stdio: "ignore" },
      ),
    );
    await waitFile("/tmp/.X11-unix/X99", processes[0]);
    context = await chromium.launchPersistentContext(dir, {
      executablePath: process.env.BROWSER_EXECUTABLE,
      headless: false,
      chromiumSandbox: true,
      artifactsDir: work,
      timeout: 20000,
      env: {
        DISPLAY: display,
        XAUTHORITY: auth,
        HOME: dir,
        PATH: process.env.PATH,
        BROWSER_PROFILE: dir,
        BROWSER_WORK: work,
      },
      proxy: { server: cfg.BROWSER_PROXY, bypass: "<-loopback>" },
      args: [
        "--disable-dev-shm-usage",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    });
    const page = context.pages()[0] || (await context.newPage());
    let blocked = false;
    try {
      await page.goto("file:///etc/passwd", { timeout: 5000 });
      blocked = !(await page.locator("body").innerText()).includes("root:");
    } catch {
      blocked = true;
    }
    if (!blocked) throw new Error("BROWSER_LOCAL_FILES_NOT_BLOCKED");
    // A VNC listener on the authenticated X display checks the display path.
    processes.push(
      managed(
        "x11vnc",
        [
          "-display",
          display,
          "-auth",
          auth,
          "-localhost",
          "-rfbport",
          "5999",
          "-forever",
          "-shared",
          "-nopw",
          "-viewonly",
          "-quiet",
        ],
        { stdio: "ignore" },
      ),
    );
    await waitPort(5999);
    const proxy = await fetch(cfg.BROWSER_PROXY, {
      signal: AbortSignal.timeout(3000),
    });
    if (proxy.status !== 403) throw new Error("EGRESS_PROXY_NOT_READY");
  } finally {
    await context?.close().catch(() => {});
    await stopProcesses(processes);
    await rm(work, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
}

function invalidateRefs(b) {
  const refs = [...b.refs.values()];
  b.refs.clear();
  void Promise.allSettled(refs.map((h) => h.dispose()));
}

function managed(file, args, options) {
  const p = spawn(file, args, options);
  p.on("error", () => {});
  return p;
}
async function stopProcesses(processes) {
  await Promise.all(
    processes.map(
      (p) =>
        new Promise((resolve) => {
          if (!p.pid || p.exitCode !== null || p.signalCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(() => p.kill("SIGKILL"), 2000);
          p.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          p.kill("SIGTERM");
        }),
    ),
  );
}
