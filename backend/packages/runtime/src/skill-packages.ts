import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError, ResourceId } from "@hyper/contracts";
import { type Db, type Queryable, tx } from "./db.js";

export const SkillBundle = z
  .object({
    id: ResourceId,
    name: z.string().min(1).max(160),
    description: z.string().max(2000),
    source: z
      .object({
        url: z
          .url()
          .refine((v) => ["https:", "http:"].includes(new URL(v).protocol))
          .optional(),
        commit: z.string().max(100).optional(),
        kind: z.enum(["local", "github", "zip", "legacy"]).default("local"),
      })
      .default({ kind: "local" }),
    files: z.record(z.string(), z.string().max(200000)),
    requirements: z
      .object({
        python: z.array(z.string().max(100)).max(50).default([]),
        node: z.array(z.string().max(100)).max(50).default([]),
        tools: z.array(z.string().max(100)).max(40).default([]),
      })
      .default({ python: [], node: [], tools: [] }),
  })
  .strict();
export function validateBundle(raw: unknown) {
  const b = SkillBundle.parse(raw),
    entries = Object.entries(b.files);
  if (
    !b.files["SKILL.md"]?.trim() ||
    entries.length > 200 ||
    Buffer.byteLength(JSON.stringify(b.files)) > 2_000_000
  )
    throw new DomainError("INVALID_SKILL_BUNDLE");
  for (const [path] of entries) {
    if (
      !/^(SKILL\.md|(?:scripts|references|assets)\/[a-zA-Z0-9_./-]+)$/.test(
        path,
      ) ||
      path.split("/").some((p) => !p || p === "." || p === "..")
    )
      throw new DomainError("INVALID_SKILL_PATH");
  }
  const files = Object.fromEntries(
    entries.sort(([a], [b]) => a.localeCompare(b)),
  );
  const digest = createHash("sha256")
    .update(JSON.stringify({ files, requirements: b.requirements }))
    .digest("hex");
  return { ...b, files, digest };
}
export async function importBundle(db: Db, workspace: string, raw: unknown) {
  const b = validateBundle(raw);
  return tx(db, async (c) => {
    await c.query(
      `INSERT INTO skill_packages(workspace_id,id,name,description,source) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,id) DO NOTHING`,
      [workspace, b.id, b.name, b.description, JSON.stringify(b.source)],
    );
    await c.query(
      `INSERT INTO skill_versions(workspace_id,package_id,digest,files,requirements,source) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [
        workspace,
        b.id,
        b.digest,
        JSON.stringify(b.files),
        JSON.stringify(b.requirements),
        JSON.stringify(b.source),
      ],
    );
    return { id: b.id, digest: b.digest, status: "ready_to_install" };
  });
}
export async function installBundle(
  db: Db,
  workspace: string,
  id: string,
  digest: string,
  revision: number,
  local = false,
) {
  return tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      workspace + ":skill:" + id,
    ]);
    const old = (
      await c.query(
        "SELECT * FROM skill_installations WHERE workspace_id=$1 AND package_id=$2",
        [workspace, id],
      )
    ).rows[0];
    if (old?.digest === digest) return old;
    if ((old?.revision || 0) !== revision)
      throw new DomainError("SKILL_CONFLICT", 409);
    if (old?.local && !local)
      throw new DomainError("LOCAL_SKILL_MODIFIED", 409);
    const v = (
      await c.query(
        "SELECT p.*,v.files FROM skill_versions v JOIN skill_packages p ON p.workspace_id=v.workspace_id AND p.id=v.package_id WHERE v.workspace_id=$1 AND v.package_id=$2 AND v.digest=$3",
        [workspace, id, digest],
      )
    ).rows[0];
    if (!v) throw new DomainError("NOT_FOUND", 404);
    const row = (
      await c.query(
        `INSERT INTO skill_installations(workspace_id,package_id,digest,local) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,package_id) DO UPDATE SET digest=EXCLUDED.digest,local=EXCLUDED.local,revision=skill_installations.revision+1 RETURNING *`,
        [workspace, id, digest, local],
      )
    ).rows[0];
    await c.query(
      `INSERT INTO resources(workspace_id,kind,id,value) VALUES($1,'skills',$2,$3) ON CONFLICT(workspace_id,kind,id) DO UPDATE SET value=EXCLUDED.value,revision=resources.revision+1,updated_at=now()`,
      [
        workspace,
        id,
        JSON.stringify({
          id,
          name: v.name,
          description: v.description,
          documentation: v.files["SKILL.md"],
          packageDigest: digest,
        }),
      ],
    );
    return row;
  });
}
export async function uninstallBundle(
  db: Db,
  workspace: string,
  id: string,
  revision: number,
  unlink: boolean,
) {
  return tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      workspace + ":skill:" + id,
    ]);
    const refs = await c.query(
      `SELECT id FROM resources WHERE workspace_id=$1 AND kind='agents' AND value->'skillIds' ? $2 FOR UPDATE`,
      [workspace, id],
    );
    if (refs.rowCount && !unlink)
      throw new DomainError("SKILL_REFERENCED", 409);
    const r = await c.query(
      "DELETE FROM skill_installations WHERE workspace_id=$1 AND package_id=$2 AND revision=$3 RETURNING package_id",
      [workspace, id, revision],
    );
    if (!r.rowCount) throw new DomainError("SKILL_CONFLICT", 409);
    await c.query(
      `UPDATE resources SET value=jsonb_set(value,'{skillIds}',(value->'skillIds')-$2),revision=revision+1 WHERE workspace_id=$1 AND kind='agents' AND value->'skillIds' ? $2`,
      [workspace, id],
    );
    await c.query(
      "DELETE FROM resources WHERE workspace_id=$1 AND kind='skills' AND id=$2",
      [workspace, id],
    );
    return { uninstalled: true };
  });
}
export async function installedSkills(db: Queryable, workspace: string) {
  return (
    await db.query(
      `SELECT p.id,p.name,p.description,i.digest,i.revision,i.local FROM skill_installations i JOIN skill_packages p ON p.workspace_id=i.workspace_id AND p.id=i.package_id WHERE i.workspace_id=$1 ORDER BY p.name`,
      [workspace],
    )
  ).rows;
}
