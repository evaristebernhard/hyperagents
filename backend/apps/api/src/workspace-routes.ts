import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { DomainError, Id, ResourceId } from "@hyper/contracts";
import {
  type Db,
  type Identity,
  ResourceKind,
  parseResource,
  acceptLearning,
  SkillBundle,
  importBundle,
  installBundle,
  uninstallBundle,
  validateBundle,
  readSkillZip,
  githubSkill,
  tx,
  hash,
  token,
} from "@hyper/runtime";

export function workspaceRoutes(
  server: FastifyInstance,
  db: Db,
  who: (r: FastifyRequest) => Identity,
) {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ id: Id });
  const resourceParams = z.object({ kind: ResourceKind, id: ResourceId });
  const admin = async (r: FastifyRequest) => {
    const u = who(r);
    if (u.role !== "admin") throw new DomainError("FORBIDDEN", 403);
    return u;
  };
  app.post(
    "/api/v1/skill-imports",
    { schema: { body: SkillBundle } },
    async (req) => importBundle(db, who(req).workspaceId, req.body),
  );
  app.post(
    "/api/v1/skill-imports/archive",
    {
      schema: {
        body: z.object({
          id: ResourceId,
          name: z.string().min(1).max(160),
          description: z.string().max(2000),
          archive: z.string().max(2_700_000),
        }),
      },
    },
    async (req) =>
      importBundle(db, who(req).workspaceId, {
        id: req.body.id,
        name: req.body.name,
        description: req.body.description,
        files: await readSkillZip(Buffer.from(req.body.archive, "base64")),
        source: { kind: "zip" },
      }),
  );
  app.post(
    "/api/v1/skill-imports/github",
    {
      schema: {
        body: z.object({
          id: ResourceId,
          name: z.string().min(1).max(160),
          description: z.string().max(2000),
          repository: z.string().max(200),
          ref: z.string().min(1).max(100),
        }),
      },
    },
    async (req) =>
      importBundle(db, who(req).workspaceId, {
        id: req.body.id,
        name: req.body.name,
        description: req.body.description,
        ...(await githubSkill(req.body.repository, req.body.ref)),
      }),
  );
  app.get(
    "/api/v1/marketplace",
    async (req) =>
      (
        await db.query(
          `SELECT p.*,i.digest installed_digest,i.revision,i.local,
    (SELECT jsonb_agg(jsonb_build_object('digest',v.digest,'requirements',v.requirements,'createdAt',v.created_at) ORDER BY v.created_at DESC) FROM skill_versions v WHERE v.workspace_id=p.workspace_id AND v.package_id=p.id) versions
    FROM skill_packages p LEFT JOIN skill_installations i ON i.workspace_id=p.workspace_id AND i.package_id=p.id WHERE p.workspace_id=$1 ORDER BY p.name`,
          [who(req).workspaceId],
        )
      ).rows,
  );
  app.get(
    "/api/v1/skill-packages/:id/versions/:digest",
    {
      schema: {
        params: z.object({
          id: ResourceId,
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      },
    },
    async (req) => {
      const row = (
        await db.query(
          `SELECT v.*,i.digest installed_digest,old.files previous_files FROM skill_versions v LEFT JOIN skill_installations i ON i.workspace_id=v.workspace_id AND i.package_id=v.package_id LEFT JOIN skill_versions old ON old.workspace_id=i.workspace_id AND old.package_id=i.package_id AND old.digest=i.digest WHERE v.workspace_id=$1 AND v.package_id=$2 AND v.digest=$3`,
          [who(req).workspaceId, req.params.id, req.params.digest],
        )
      ).rows[0];
      if (!row) throw new DomainError("NOT_FOUND", 404);
      const paths = [
        ...new Set([
          ...Object.keys(row.files),
          ...Object.keys(row.previous_files || {}),
        ]),
      ];
      return {
        ...row,
        changes: paths
          .filter((p) => row.files[p] !== row.previous_files?.[p])
          .map((path) => ({
            path,
            before: row.previous_files?.[path] ?? null,
            after: row.files[path] ?? null,
          })),
      };
    },
  );
  app.put(
    "/api/v1/skill-installations/:id",
    {
      schema: {
        params: z.object({ id: ResourceId }),
        body: z
          .object({
            digest: z.string().regex(/^[a-f0-9]{64}$/),
            revision: z.number().int().min(0),
            local: z.boolean().default(false),
          })
          .strict(),
      },
    },
    async (req) =>
      installBundle(
        db,
        who(req).workspaceId,
        req.params.id,
        req.body.digest,
        req.body.revision,
        req.body.local,
      ),
  );
  app.delete(
    "/api/v1/skill-installations/:id",
    {
      schema: {
        params: z.object({ id: ResourceId }),
        body: z
          .object({
            revision: z.number().int().min(1),
            unlink: z.boolean().default(false),
          })
          .strict(),
      },
    },
    async (req) =>
      uninstallBundle(
        db,
        who(req).workspaceId,
        req.params.id,
        req.body.revision,
        req.body.unlink,
      ),
  );
  app.get(
    "/api/v1/workspaces",
    async (req) =>
      (
        await db.query(
          `SELECT w.id,w.name,w.kind,CASE WHEN w.user_id=$1 THEN 'admin' ELSE m.role END role FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=$1 WHERE w.user_id=$1 OR m.user_id=$1 ORDER BY w.kind,w.name`,
          [who(req).userId],
        )
      ).rows,
  );
  app.post(
    "/api/v1/workspaces",
    {
      schema: {
        body: z.object({ name: z.string().trim().min(1).max(160) }).strict(),
      },
    },
    async (req) => {
      const id = randomUUID();
      await db.query(
        "INSERT INTO workspaces(id,user_id,kind,name) VALUES($1,$2,'team',$3)",
        [id, who(req).userId, req.body.name],
      );
      return { id };
    },
  );
  app.post(
    "/api/v1/workspaces/:id/select",
    { schema: { params } },
    async (req) => {
      const u = who(req);
      const r = await db.query(
        "SELECT 1 FROM workspaces w WHERE w.id=$1 AND (w.user_id=$2 OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w.id AND m.user_id=$2))",
        [req.params.id, u.userId],
      );
      if (!r.rowCount) throw new DomainError("NOT_FOUND", 404);
      await db.query(
        "UPDATE sessions SET active_workspace_id=$2 WHERE token_hash=$1",
        [hash(req.cookies.hyper_session!), req.params.id],
      );
      return { selected: true };
    },
  );
  app.get(
    "/api/v1/members",
    async (req) =>
      (
        await db.query(
          `SELECT u.id,u.email,CASE WHEN u.id=w.user_id THEN 'admin' ELSE m.role END role,(u.id=w.user_id) owner FROM workspaces w JOIN users u ON u.id=w.user_id OR EXISTS(SELECT 1 FROM workspace_members x WHERE x.workspace_id=w.id AND x.user_id=u.id) LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=u.id WHERE w.id=$1 ORDER BY owner DESC,u.email`,
          [who(req).workspaceId],
        )
      ).rows,
  );
  app.delete("/api/v1/members/:id", { schema: { params } }, async (req) => {
    const u = await admin(req);
    const r = await db.query(
      "DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND user_id<>(SELECT user_id FROM workspaces WHERE id=$1) RETURNING user_id",
      [u.workspaceId, req.params.id],
    );
    if (!r.rowCount) throw new DomainError("NOT_FOUND", 404);
    await db.query(
      "UPDATE sessions SET active_workspace_id=NULL WHERE user_id=$1 AND active_workspace_id=$2",
      [req.params.id, u.workspaceId],
    );
    return { removed: true };
  });
  app.post(
    "/api/v1/team-invites",
    {
      schema: {
        body: z
          .object({
            email: z.email().transform((v) => v.toLowerCase()),
            role: z.enum(["admin", "member", "viewer"]),
          })
          .strict(),
      },
    },
    async (req) => {
      const u = await admin(req);
      if (
        !(
          await db.query(
            "SELECT 1 FROM workspaces WHERE id=$1 AND kind='team'",
            [u.workspaceId],
          )
        ).rowCount
      )
        throw new DomainError("TEAM_WORKSPACE_REQUIRED");
      const secret = token();
      await db.query(
        "INSERT INTO team_invites(id,workspace_id,email,role,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '7 days')",
        [
          randomUUID(),
          u.workspaceId,
          req.body.email,
          req.body.role,
          hash(secret),
        ],
      );
      return { token: secret, expiresInDays: 7 };
    },
  );
  app.post(
    "/api/v1/team-invites/accept",
    {
      schema: {
        body: z.object({ token: z.string().min(32).max(128) }).strict(),
      },
    },
    async (req) =>
      tx(db, async (c) => {
        const u = who(req),
          r = await c.query(
            "SELECT * FROM team_invites WHERE token_hash=$1 AND email=$2 AND used_at IS NULL AND expires_at>now() FOR UPDATE",
            [hash(req.body.token), u.email],
          );
        const invite = r.rows[0];
        if (!invite) throw new DomainError("INVALID_INVITE");
        // An invite never changes an existing membership or downgrades its owner.
        await c.query(
          "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [invite.workspace_id, u.userId, invite.role],
        );
        await c.query("UPDATE team_invites SET used_at=now() WHERE id=$1", [
          invite.id,
        ]);
        return { workspaceId: invite.workspace_id };
      }),
  );
  app.get(
    "/api/v1/resources",
    async (req) =>
      (
        await db.query(
          "SELECT kind,id,value,revision FROM resources WHERE workspace_id=$1 ORDER BY updated_at DESC",
          [who(req).workspaceId],
        )
      ).rows,
  );
  app.put(
    "/api/v1/resources/:kind/:id",
    {
      schema: {
        params: resourceParams,
        body: z
          .object({ revision: z.number().int().min(0), value: z.unknown() })
          .strict(),
      },
    },
    async (req) => {
      const value = parseResource(req.params.kind, req.body.value);
      if (value.id !== req.params.id)
        throw new DomainError("INVALID_RESOURCE_ID");
      const u = who(req);
      if (
        req.params.kind === "memories" &&
        "scope" in value &&
        value.scope === "personal" &&
        (
          await db.query("SELECT kind FROM workspaces WHERE id=$1", [
            u.workspaceId,
          ])
        ).rows[0]?.kind === "team"
      )
        throw new DomainError("USE_PERSONAL_WORKSPACE");
      return tx(db, async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          u.workspaceId + req.params.kind + req.params.id,
        ]);
        const old = await c.query(
          "SELECT revision,value FROM resources WHERE workspace_id=$1 AND kind=$2 AND id=$3",
          [u.workspaceId, req.params.kind, req.params.id],
        );
        if ((old.rows[0]?.revision || 0) !== req.body.revision)
          throw new DomainError("RESOURCE_CONFLICT", 409);
        if (req.params.kind === "rooms" && "notes" in value) {
          value.notes = value.notes.map((note) => ({
            ...note,
            author:
              old.rows[0]?.value?.notes?.find(
                (n: { id: string }) => n.id === note.id,
              )?.author || u.email,
          }));
        }
        if (req.params.kind === "skills" && "documentation" in value) {
          await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            u.workspaceId + ":skill:" + value.id,
          ]);
          const installed = (
            await c.query(
              "SELECT v.files,v.requirements FROM skill_installations i JOIN skill_versions v USING(workspace_id,package_id,digest) WHERE i.workspace_id=$1 AND i.package_id=$2",
              [u.workspaceId, value.id],
            )
          ).rows[0];
          const b = validateBundle({
            id: value.id,
            name: value.name,
            description: value.description,
            files: {
              ...(installed?.files || {}),
              "SKILL.md": value.documentation,
            },
            requirements: installed?.requirements,
          });
          await c.query(
            "INSERT INTO skill_packages(workspace_id,id,name,description) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [u.workspaceId, value.id, value.name, value.description],
          );
          await c.query(
            "INSERT INTO skill_versions(workspace_id,package_id,digest,files,requirements) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            [
              u.workspaceId,
              value.id,
              b.digest,
              JSON.stringify(b.files),
              JSON.stringify(b.requirements),
            ],
          );
          await c.query(
            "INSERT INTO skill_installations(workspace_id,package_id,digest,local) VALUES($1,$2,$3,true) ON CONFLICT(workspace_id,package_id) DO UPDATE SET digest=EXCLUDED.digest,local=true,revision=skill_installations.revision+1",
            [u.workspaceId, value.id, b.digest],
          );
          value.packageDigest = b.digest;
        }
        const r = await c.query(
          `INSERT INTO resources(workspace_id,kind,id,value) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,kind,id) DO UPDATE SET value=EXCLUDED.value,revision=resources.revision+1,updated_at=now() RETURNING kind,id,value,revision`,
          [
            u.workspaceId,
            req.params.kind,
            req.params.id,
            JSON.stringify(value),
          ],
        );
        return r.rows[0];
      });
    },
  );
  app.delete(
    "/api/v1/resources/:kind/:id",
    {
      schema: {
        params: resourceParams,
        body: z.object({ revision: z.number().int().min(1) }),
      },
    },
    async (req) => {
      if (
        req.params.kind === "skills" &&
        (
          await db.query(
            "SELECT 1 FROM skill_installations WHERE workspace_id=$1 AND package_id=$2",
            [who(req).workspaceId, req.params.id],
          )
        ).rowCount
      )
        throw new DomainError("USE_SKILL_UNINSTALL", 409);
      const r = await db.query(
        "DELETE FROM resources WHERE workspace_id=$1 AND kind=$2 AND id=$3 AND revision=$4 RETURNING id",
        [
          who(req).workspaceId,
          req.params.kind,
          req.params.id,
          req.body.revision,
        ],
      );
      if (!r.rowCount) throw new DomainError("RESOURCE_CONFLICT", 409);
      return { deleted: true };
    },
  );
  app.get(
    "/api/v1/learning-jobs",
    async (req) =>
      (
        await db.query(
          "SELECT j.* FROM learning_jobs j JOIN tasks t ON t.id=j.task_id WHERE t.workspace_id=$1 ORDER BY t.created_at DESC LIMIT 200",
          [who(req).workspaceId],
        )
      ).rows,
  );
  app.get(
    "/api/v1/learning",
    async (req) =>
      (
        await db.query(
          "SELECT s.*,t.conversation_id FROM learning_suggestions s JOIN tasks t ON t.id=s.task_id WHERE s.workspace_id=$1 ORDER BY s.created_at DESC LIMIT 200",
          [who(req).workspaceId],
        )
      ).rows,
  );
  app.post(
    "/api/v1/learning/:id",
    {
      schema: {
        params,
        body: z
          .object({ decision: z.enum(["accepted", "dismissed"]) })
          .strict(),
      },
    },
    async (req) =>
      tx(db, (c) =>
        acceptLearning(
          c,
          who(req).workspaceId,
          req.params.id,
          req.body.decision,
        ),
      ),
  );
  app.get("/api/v1/inbox", async (req) => {
    const workspace = who(req).workspaceId;
    const tasks = (
      await db.query(
        "SELECT id,conversation_id,prompt,state,error_code,updated_at FROM tasks WHERE workspace_id=$1 AND parent_id IS NULL AND state IN ('failed','waiting_user','waiting_approval','uncertain') ORDER BY updated_at DESC LIMIT 100",
        [workspace],
      )
    ).rows;
    const learning = (
      await db.query(
        "SELECT id,name,kind,task_id FROM learning_suggestions WHERE workspace_id=$1 AND decision IS NULL ORDER BY created_at DESC LIMIT 100",
        [workspace],
      )
    ).rows;
    const schedules = (
      await db.query(
        "SELECT schedule_id,occurrence,task_id,error_code FROM schedule_runs WHERE workspace_id=$1 ORDER BY occurrence DESC LIMIT 100",
        [workspace],
      )
    ).rows;
    return { tasks, learning, schedules };
  });
  app.get(
    "/api/v1/library",
    async (req) =>
      (
        await db.query(
          `SELECT a.id,a.name,a.conversation_id,v.version,v.file_id,v.created_at,f.format FROM artifacts a JOIN LATERAL(SELECT * FROM artifact_versions WHERE artifact_id=a.id ORDER BY version DESC LIMIT 1)v ON true JOIN files f ON f.id=v.file_id WHERE a.workspace_id=$1 ORDER BY v.created_at DESC LIMIT 500`,
          [who(req).workspaceId],
        )
      ).rows,
  );
  app.patch(
    "/api/v1/conversations/:id",
    {
      schema: {
        params,
        body: z
          .object({
            revision: z.number().int().min(1),
            title: z.string().min(1).max(160).optional(),
            metadata: z
              .object({
                starred: z.boolean().optional(),
                archived: z.boolean().optional(),
                projectId: ResourceId.optional(),
                roomId: ResourceId.optional(),
                canvas: z
                  .object({
                    layout: z.enum(["focus", "tiles", "carousel"]),
                    hidden: z.array(Id).max(500),
                    order: z.array(Id).max(500),
                    collapsed: z.boolean().optional(),
                  })
                  .optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      },
    },
    async (req) => {
      const r = await db.query(
        "UPDATE conversations SET title=COALESCE($4,title),metadata=metadata||COALESCE($5::jsonb,'{}'::jsonb),revision=revision+1 WHERE id=$1 AND workspace_id=$2 AND revision=$3 RETURNING revision,metadata",
        [
          req.params.id,
          who(req).workspaceId,
          req.body.revision,
          req.body.title || null,
          req.body.metadata ? JSON.stringify(req.body.metadata) : null,
        ],
      );
      if (!r.rowCount) throw new DomainError("CONVERSATION_CONFLICT", 409);
      return r.rows[0];
    },
  );
}
