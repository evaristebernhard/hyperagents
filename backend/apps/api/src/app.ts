import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import {
  DomainError,
  Id,
  CreateTask,
  Credentials,
  Register,
  Followup,
  Format,
  Limits,
  TaskResponse,
  codeOf,
} from "@hyper/contracts";
import {
  authenticate,
  login,
  register,
  invite,
  hash,
  equal,
  createTask,
  cancelTask,
  retryTask,
  followup,
  publicTask,
  getTask,
  Storage,
  RunnerClient,
  tx,
  event,
  type Db,
  type Config,
  type Identity,
} from "@hyper/runtime";
const Params = z.object({ id: Id });
export async function buildApp(db: Db, config: Config) {
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    logger: false,
    requestTimeout: 30000,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: Limits.fileBytes, files: 1, fields: 2, parts: 3 },
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(swagger, {
    openapi: {
      info: { title: "Hyperagents API", version: "1.0.0" },
      components: {
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: "hyper_session" },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  const identities = new WeakMap<FastifyRequest, Identity>();
  const who = (req: FastifyRequest) => {
    const identity = identities.get(req);
    if (!identity) throw new DomainError("UNAUTHENTICATED", 401);
    return identity;
  };
  const storage = new Storage(config.DATA_DIR, db),
    runner = new RunnerClient(config);
  app.setErrorHandler((err, req, reply) => {
    const e = err as {
      code?: string;
      validation?: unknown;
      statusCode?: number;
    };
    const status =
      err instanceof DomainError
        ? err.status
        : e.code === "23505"
          ? 409
          : e.validation || err instanceof z.ZodError
            ? 400
            : e.statusCode && e.statusCode < 500
              ? e.statusCode
              : 500;
    void reply
      .code(status)
      .send({
        error:
          status >= 500
            ? "INTERNAL_ERROR"
            : e.code === "23505"
              ? "CONFLICT"
              : e.validation
                ? "INVALID_ARGUMENTS"
                : codeOf(err),
        requestId: req.id,
      });
  });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff");
    const path = req.url.split("?")[0];
    if (path === "/health") return;
    const authPublic =
      path === "/api/v1/auth/login" || path === "/api/v1/auth/register";
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (req.headers.origin !== new URL(config.PUBLIC_ORIGIN).origin)
        throw new DomainError("ORIGIN_REJECTED", 403);
    }
    if (authPublic) return;
    const identity = await authenticate(db, req.cookies.hyper_session);
    identities.set(req, identity);
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const csrf = req.headers["x-csrf-token"];
      if (typeof csrf !== "string" || !equal(hash(csrf), identity.csrfHash))
        throw new DomainError("CSRF_REJECTED", 403);
    }
  });
  app.get("/health", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });
  app.post(
    "/api/v1/auth/register",
    {
      schema: { body: Register },
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      await register(db, req.body);
      return reply.code(201).send({ registered: true });
    },
  );
  app.post(
    "/api/v1/auth/login",
    {
      schema: { body: Credentials },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const r = await login(db, req.body);
      reply.setCookie("hyper_session", r.session, {
        httpOnly: true,
        secure: new URL(config.PUBLIC_ORIGIN).protocol === "https:",
        sameSite: "strict",
        path: "/",
        maxAge: 7 * 24 * 3600,
      });
      return { csrfToken: r.csrf };
    },
  );
  app.get("/api/v1/auth/session", async (req) => {
    const { csrfHash, ...u } = who(req);
    return u;
  });
  app.post("/api/v1/auth/logout", async (req, reply) => {
    await db.query("DELETE FROM sessions WHERE token_hash=$1", [
      hash(req.cookies.hyper_session!),
    ]);
    reply.clearCookie("hyper_session", { path: "/" });
    return { loggedOut: true };
  });
  app.post("/api/v1/invites", async (req) => {
    const u = who(req);
    if (!u.admin) throw new DomainError("FORBIDDEN", 403);
    const secret = await invite(db, u.userId);
    return {
      token: secret,
      registrationUrl: config.PUBLIC_ORIGIN + "/register?invite=" + secret,
      expiresInDays: 7,
    };
  });
  app.get("/api/v1/invites", async (req) => {
    const u = who(req);
    if (!u.admin) throw new DomainError("FORBIDDEN", 403);
    return (
      await db.query(
        "SELECT id,expires_at,used_at FROM invites WHERE created_by=$1 ORDER BY expires_at DESC LIMIT 100",
        [u.userId],
      )
    ).rows;
  });
  app.delete(
    "/api/v1/invites/:id",
    { schema: { params: Params } },
    async (req) => {
      const u = who(req);
      if (!u.admin) throw new DomainError("FORBIDDEN", 403);
      await db.query(
        "DELETE FROM invites WHERE id=$1 AND created_by=$2 AND used_at IS NULL",
        [req.params.id, u.userId],
      );
      return { revoked: true };
    },
  );
  app.get(
    "/api/v1/conversations",
    async (req) =>
      (
        await db.query(
          "SELECT id,title,created_at FROM conversations WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100",
          [who(req).workspaceId],
        )
      ).rows,
  );
  app.get(
    "/api/v1/conversations/:id",
    { schema: { params: Params } },
    async (req) => {
      const workspace = who(req).workspaceId;
      const c = await db.query(
        "SELECT id,title,created_at FROM conversations WHERE id=$1 AND workspace_id=$2",
        [req.params.id, workspace],
      );
      if (!c.rowCount) throw new DomainError("NOT_FOUND", 404);
      return {
        ...c.rows[0],
        messages: (
          await db.query(
            "SELECT id,role,content,created_at FROM messages WHERE conversation_id=$1 ORDER BY id LIMIT 1000",
            [req.params.id],
          )
        ).rows,
        artifacts: (
          await db.query(
            "SELECT id,name FROM artifacts WHERE conversation_id=$1 AND workspace_id=$2",
            [req.params.id, workspace],
          )
        ).rows,
      };
    },
  );
  app.post(
    "/api/v1/tasks",
    {
      schema: {
        body: CreateTask,
        headers: z
          .object({ "idempotency-key": z.string().min(1).max(200) })
          .passthrough(),
        response: { 202: z.object({ taskId: Id }) },
      },
    },
    async (req, reply) =>
      reply
        .code(202)
        .send(
          await createTask(
            db,
            who(req).workspaceId,
            req.body,
            req.headers["idempotency-key"],
          ),
        ),
  );
  app.get("/api/v1/tasks", async (req) => {
    const r = await db.query(
      "SELECT id FROM tasks WHERE workspace_id=$1 AND parent_id IS NULL ORDER BY created_at DESC LIMIT 100",
      [who(req).workspaceId],
    );
    return Promise.all(
      r.rows.map(async (r) =>
        publicTask(await getTask(db, r.id, who(req).workspaceId)),
      ),
    );
  });
  app.get(
    "/api/v1/tasks/:id",
    { schema: { params: Params, response: { 200: TaskResponse } } },
    async (req) =>
      publicTask(await getTask(db, req.params.id, who(req).workspaceId)),
  );
  app.post(
    "/api/v1/tasks/:id/instructions",
    { schema: { params: Params, body: Followup } },
    async (req) => {
      await followup(db, req.params.id, who(req).workspaceId, req.body.message);
      return { accepted: true };
    },
  );
  app.post(
    "/api/v1/tasks/:id/cancel",
    { schema: { params: Params } },
    async (req) => {
      await cancelTask(db, req.params.id, who(req).workspaceId);
      return { cancelled: true };
    },
  );
  app.post(
    "/api/v1/tasks/:id/retry",
    { schema: { params: Params } },
    async (req) => {
      await retryTask(db, req.params.id, who(req).workspaceId);
      return { queued: true };
    },
  );
  app.get(
    "/api/v1/tasks/:id/events",
    {
      schema: {
        params: Params,
        querystring: z.object({
          after: z.coerce.number().int().nonnegative().default(0),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
    },
    async (req, reply) => {
      await getTask(db, req.params.id, who(req).workspaceId);
      let after = req.query.after;
      const last = req.headers["last-event-id"];
      if (typeof last === "string") {
        const parsed = z.coerce.number().int().nonnegative().safeParse(last);
        if (!parsed.success) throw new DomainError("INVALID_CURSOR");
        after = Math.max(after, parsed.data);
      }
      const read = async () =>
        (
          await db.query<{ id: string; payload: unknown; created_at: Date }>(
            "SELECT id,payload,created_at FROM events WHERE task_id=$1 AND id>$2 ORDER BY id LIMIT $3",
            [req.params.id, after, req.query.limit],
          )
        ).rows;
      if (!req.headers.accept?.includes("text/event-stream")) {
        const rows = await read();
        return { events: rows, nextCursor: rows.at(-1)?.id ?? String(after) };
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      });
      let closed = false;
      const close = () => {
        closed = true;
      };
      reply.raw.on("close", close);
      try {
        const start = Date.now();
        while (!closed && Date.now() - start < 25000) {
          await authenticate(db, req.cookies.hyper_session);
          const rows = await read();
          for (const e of rows) {
            if (closed) break;
            if (
              !reply.raw.write(
                `id: ${e.id}\nevent: task\ndata: ${JSON.stringify(e.payload)}\n\n`,
              )
            ) {
              closed = true;
              break;
            }
            after = Number(e.id);
          }
          if (!closed) {
            reply.raw.write(": keepalive\n\n");
            await new Promise<void>((resolve) => {
              const timer = setTimeout(done, 1000);
              function done() {
                clearTimeout(timer);
                reply.raw.off("close", done);
                resolve();
              }
              reply.raw.once("close", done);
            });
          }
        }
      } catch {
        /* Client reconnects from its last persisted cursor. */
      } finally {
        reply.raw.off("close", close);
        reply.raw.end();
      }
    },
  );
  app.get(
    "/api/v1/tasks/:id/sources",
    { schema: { params: Params } },
    async (req) => {
      await getTask(db, req.params.id, who(req).workspaceId);
      return (
        await db.query(
          "SELECT id,url,title,excerpt,read,created_at FROM sources WHERE task_id=$1 AND workspace_id=$2",
          [req.params.id, who(req).workspaceId],
        )
      ).rows;
    },
  );
  app.get(
    "/api/v1/tasks/:id/approvals",
    { schema: { params: Params } },
    async (req) => {
      await getTask(db, req.params.id, who(req).workspaceId);
      return (
        await db.query(
          "SELECT id,action,payload,digest,decision FROM approvals WHERE task_id=$1",
          [req.params.id],
        )
      ).rows;
    },
  );
  app.post(
    "/api/v1/tasks/:id/approvals/:approvalId",
    {
      schema: {
        params: Params.extend({ approvalId: Id }),
        body: z
          .object({
            digest: z.string().length(64),
            decision: z.enum(["approved", "denied"]),
          })
          .strict(),
      },
    },
    async (req) => {
      await getTask(db, req.params.id, who(req).workspaceId);
      await tx(db, async (c) => {
        const r = await c.query(
          "UPDATE approvals SET decision=$4 WHERE id=$1 AND task_id=$2 AND digest=$3 AND decision IS NULL RETURNING id",
          [
            req.params.approvalId,
            req.params.id,
            req.body.digest,
            req.body.decision,
          ],
        );
        if (!r.rowCount) throw new DomainError("APPROVAL_CONFLICT", 409);
        await event(c, req.params.id, {
          type: "message",
          message:
            "Approval recorded; external executor is unavailable. No action executed.",
        });
      });
      return {
        decision: req.body.decision,
        executed: false,
        reason: "EXTERNAL_EXECUTOR_UNAVAILABLE",
      };
    },
  );
  app.post("/api/v1/files", async (req, reply) => {
    const file = await req.file();
    if (!file) throw new DomainError("FILE_REQUIRED");
    const bytes = await file.toBuffer();
    if (file.file.truncated) throw new DomainError("FILE_SIZE", 413);
    const ext = file.filename.split(".").at(-1)?.toLowerCase();
    const format = Format.parse(ext);
    const saved = await storage.upload(
      who(req).workspaceId,
      file.filename,
      format,
      bytes,
    );
    return reply
      .code(201)
      .send({
        id: saved.id,
        name: saved.name,
        format: saved.format,
        bytes: Number(saved.bytes),
        sha256: saved.sha256,
      });
  });
  app.get(
    "/api/v1/files",
    async (req) =>
      (
        await db.query(
          "SELECT id,name,format,bytes,sha256,created_at FROM files WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100",
          [who(req).workspaceId],
        )
      ).rows,
  );
  app.get(
    "/api/v1/files/:id/download",
    { schema: { params: Params } },
    async (req, reply) => {
      const file = await storage.get(who(req).workspaceId, req.params.id);
      reply
        .header("content-type", file.mime)
        .header(
          "content-security-policy",
          "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        )
        .header(
          "content-disposition",
          "attachment; filename*=UTF-8''" + encodeURIComponent(file.name),
        );
      return reply.send(await storage.bytes(file));
    },
  );
  app.get(
    "/api/v1/artifacts/:id",
    { schema: { params: Params } },
    async (req) => {
      const workspace = who(req).workspaceId;
      const r = await db.query(
        "SELECT id,name,conversation_id FROM artifacts WHERE id=$1 AND workspace_id=$2",
        [req.params.id, workspace],
      );
      if (!r.rows[0]) throw new DomainError("NOT_FOUND", 404);
      return {
        ...r.rows[0],
        versions: (
          await db.query(
            "SELECT version,file_id,task_id,validation,source_ids,created_at FROM artifact_versions WHERE artifact_id=$1 AND workspace_id=$2 ORDER BY version DESC",
            [req.params.id, workspace],
          )
        ).rows,
      };
    },
  );
  app.get("/api/v1/capabilities", async () => ({
    models: [
      {
        provider: "deepseek",
        model: config.DEEPSEEK_MODEL,
        configured: !!config.DEEPSEEK_API_KEY,
      },
    ],
    search: {
      provider: config.EXA_API_KEY ? "exa" : "public-bing-rss",
      degraded: !config.EXA_API_KEY,
    },
    sandbox: await runner.health(),
    formats: Format.options,
    externalActions: false,
    limits: Limits,
  }));
  app.get("/api/v1/openapi.json", async () => app.swagger());
  return app;
}
