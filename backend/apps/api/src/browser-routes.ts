import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { WebSocket } from "ws";
import { z } from "zod";
import { BrowserTransition, DomainError, Id } from "@hyper/contracts";
import {
  BrowserClient,
  browserAccess,
  sessionAccess,
  reserveSession,
  transitionBrowser,
  issueBrowserTicket,
  hash,
  tx,
  getTask,
  type Db,
  type Config,
  type Identity,
} from "@hyper/runtime";
const params = z.object({ id: Id });
export function browserRoutes(
  app: FastifyInstance,
  db: Db,
  config: Config,
  who: (r: FastifyRequest) => Identity,
) {
  const api = app.withTypeProvider<ZodTypeProvider>(),
    client = new BrowserClient(config);
  const admin = async (req: FastifyRequest, profileId?: string) => {
    const u = who(req);
    if (u.role !== "admin") throw new DomainError("FORBIDDEN", 403);
    if (
      profileId &&
      !(
        await db.query(
          "SELECT 1 FROM browser_profiles WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL",
          [profileId, u.workspaceId],
        )
      ).rowCount
    )
      throw new DomainError("NOT_FOUND", 404);
    return u;
  };
  api.get("/api/v1/browser/profiles", async (req) => {
    const u = who(req);
    return (
      await db.query(
        `SELECT p.id,p.name,p.created_at,w.kind,
      (SELECT jsonb_agg(g.user_id) FROM browser_grants g WHERE g.profile_id=p.id) AS grants
      FROM browser_profiles p JOIN workspaces w ON w.id=p.workspace_id WHERE p.workspace_id=$1 AND p.deleted_at IS NULL AND
      ($3 OR (w.kind='personal' AND p.owner_id=$2) OR EXISTS(SELECT 1 FROM browser_grants g WHERE g.profile_id=p.id AND g.user_id=$2)) ORDER BY p.created_at`,
        [u.workspaceId, u.userId, u.role === "admin"],
      )
    ).rows;
  });
  api.post(
    "/api/v1/browser/profiles",
    {
      schema: {
        body: z.object({ name: z.string().trim().min(1).max(100) }).strict(),
      },
    },
    async (req) => {
      const u = await admin(req),
        id = randomUUID();
      await tx(db, async (c) => {
        await c.query(
          "INSERT INTO browser_profiles(id,workspace_id,owner_id,name) VALUES($1,$2,$3,$4)",
          [id, u.workspaceId, u.userId, req.body.name],
        );
        await c.query(
          "INSERT INTO browser_grants(profile_id,user_id) VALUES($1,$2)",
          [id, u.userId],
        );
      });
      return { id, name: req.body.name };
    },
  );
  api.patch(
    "/api/v1/browser/profiles/:id",
    {
      schema: {
        params,
        body: z.object({ name: z.string().trim().min(1).max(100) }).strict(),
      },
    },
    async (req) => {
      await admin(req, req.params.id);
      await db.query("UPDATE browser_profiles SET name=$2 WHERE id=$1", [
        req.params.id,
        req.body.name,
      ]);
      return { updated: true };
    },
  );
  api.put(
    "/api/v1/browser/profiles/:id/grants",
    {
      schema: {
        params,
        body: z.object({ userIds: z.array(Id).max(100) }).strict(),
      },
    },
    async (req) => {
      const u = await admin(req, req.params.id);
      await tx(db, async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(730110)");
        if (
          !(
            await c.query(
              "SELECT 1 FROM workspaces WHERE id=$1 AND kind='team'",
              [u.workspaceId],
            )
          ).rowCount
        )
          throw new DomainError("TEAM_PROFILE_REQUIRED", 409);
        for (const id of req.body.userIds)
          if (
            !(
              await c.query(
                "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role<>'viewer'",
                [u.workspaceId, id],
              )
            ).rowCount
          )
            throw new DomainError("INVALID_MEMBER", 400);
        await c.query("DELETE FROM browser_grants WHERE profile_id=$1", [
          req.params.id,
        ]);
        for (const id of new Set(req.body.userIds))
          await c.query(
            "INSERT INTO browser_grants(profile_id,user_id) VALUES($1,$2)",
            [req.params.id, id],
          );
        await c.query(
          "DELETE FROM browser_tickets WHERE session_id IN (SELECT id FROM browser_sessions WHERE profile_id=$1)",
          [req.params.id],
        );
      });
      return { updated: true };
    },
  );
  api.delete(
    "/api/v1/browser/profiles/:id",
    { schema: { params } },
    async (req) => {
      await admin(req, req.params.id);
      // Service holds the same profile lock while checking no live session and deleting the private directory.
      await client.request("/profiles/delete", { profileId: req.params.id });
      return { deleted: true };
    },
  );
  api.get(
    "/api/v1/browser/sessions",
    { schema: { querystring: z.object({ taskId: Id.optional() }) } },
    async (req) => {
      const u = who(req);
      const rows = (
        await db.query(
          "SELECT s.*,p.name AS profile_name FROM browser_sessions s JOIN browser_profiles p ON p.id=s.profile_id WHERE p.workspace_id=$1 AND p.deleted_at IS NULL AND ($2::uuid IS NULL OR s.task_id=$2) ORDER BY s.created_at DESC LIMIT 50",
          [u.workspaceId, req.query.taskId ?? null],
        )
      ).rows;
      const visible = [];
      for (const s of rows) {
        try {
          await browserAccess(db, s.profile_id, u.workspaceId, u.userId);
          visible.push(s);
        } catch {}
      }
      return visible;
    },
  );
  api.post(
    "/api/v1/browser/sessions",
    {
      schema: {
        body: z.object({ profileId: Id, taskId: Id.optional() }).strict(),
      },
    },
    async (req) => {
      const u = who(req);
      if (!(await client.health()).available)
        throw new DomainError("BROWSER_UNAVAILABLE", 503);
      const s = await tx(db, async (c) => {
        await browserAccess(c, req.body.profileId, u.workspaceId, u.userId);
        if (req.body.taskId) {
          const task = await getTask(c, req.body.taskId, u.workspaceId);
          if (
            task.browser_profile_id !== req.body.profileId ||
            task.state !== "waiting_browser" ||
            task.requested_by !== u.userId
          )
            throw new DomainError("TASK_NOT_RESUMABLE", 409);
        }
        return reserveSession(c, req.body.profileId, req.body.taskId ?? null);
      });
      if (!s) throw new DomainError("BROWSER_BUSY", 409);
      await client.request("/sessions/start", { sessionId: s.id });
      return sessionAccess(db, s.id, u);
    },
  );
  api.get("/api/v1/browser/sessions/:id", { schema: { params } }, (req) =>
    sessionAccess(db, req.params.id, who(req)),
  );
  api.post(
    "/api/v1/browser/sessions/:id/close",
    { schema: { params } },
    async (req) => {
      const s = await sessionAccess(db, req.params.id, who(req));
      if (s.controller_id && s.controller_id !== who(req).userId)
        throw new DomainError("NOT_CONTROLLER", 403);
      await client.request("/sessions/close", { sessionId: s.id });
      return { closed: true };
    },
  );
  for (const action of ["takeover", "handback"] as const)
    api.post(
      `/api/v1/browser/sessions/:id/${action}`,
      {
        schema: {
          params,
          body: BrowserTransition,
          headers: z
            .object({ "idempotency-key": z.string().min(1).max(200) })
            .passthrough(),
        },
      },
      (req) =>
        transitionBrowser(
          db,
          client,
          who(req),
          req.params.id,
          action,
          req.body.expectedEpoch,
          req.headers["idempotency-key"],
          req.body.note,
        ),
    );
  api.post(
    "/api/v1/browser/sessions/:id/view-ticket",
    {
      schema: {
        params,
        body: z.object({ permission: z.enum(["observe", "write"]) }).strict(),
      },
    },
    (req) =>
      issueBrowserTicket(
        db,
        who(req),
        req.cookies.hyper_session!,
        req.params.id,
        req.body.permission,
      ),
  );
  app.get<{ Params: { id: string }; Querystring: { ticket: string } }>(
    "/api/v1/browser/sessions/:id/view",
    { websocket: true },
    (socket, req) => {
      let upstream: WebSocket | undefined;
      const close = () => {
        socket.close();
        upstream?.close();
      };
      // Register immediately: no input is buffered while access is being checked.
      socket.on("message", (data) => {
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(data);
      });
      socket.on("close", () => upstream?.close());
      socket.on("error", close);
      void (async () => {
        const u = who(req);
        if (
          !req.headers.origin ||
          ![config.PUBLIC_ORIGIN, ...config.ADDITIONAL_ORIGINS]
            .map((x) => new URL(x).origin)
            .includes(req.headers.origin)
        )
          throw new Error("origin");
        if (!config.BROWSER_URL || config.BROWSER_ENABLED !== "true")
          throw new Error("unavailable");
        await sessionAccess(db, req.params.id, u);
        const valid = await db.query(
          "SELECT 1 FROM browser_tickets WHERE token_hash=$1 AND session_id=$2 AND user_id=$3 AND app_session_hash=$4",
          [
            hash(req.query.ticket || ""),
            req.params.id,
            u.userId,
            hash(req.cookies.hyper_session!),
          ],
        );
        if (!valid.rowCount || socket.readyState !== WebSocket.OPEN)
          throw new Error("ticket");
        const url = new URL("/view", config.BROWSER_URL);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("ticket", req.query.ticket);
        upstream = new WebSocket(url, {
          headers: { authorization: `Bearer ${config.BROWSER_TOKEN}` },
          maxPayload: 1024 * 1024,
        });
        upstream.on("message", (data) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(data);
        });
        upstream.on("close", close);
        upstream.on("error", close);
      })().catch(close);
    },
  );
}
