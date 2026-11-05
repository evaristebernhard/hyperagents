import { installedSkills } from "./skill-packages.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  DomainError,
  ResourceId,
  TaskContext,
  ToolSchemas,
  type ToolName,
} from "@hyper/contracts";
import { type Queryable } from "./db.js";

export const ResourceKind = z.enum([
  "memories",
  "skills",
  "agents",
  "projects",
  "rooms",
  "rubrics",
  "wiki",
  "schedules",
  "preferences",
]);
const text = z.string().max(12000),
  name = z.string().trim().min(1).max(160);
const ids = z.array(ResourceId).max(30).default([]);
// Keep compatibility with the original UI's editable resource shapes. Unknown
// fields are stripped, and no credentials or executable host commands are stored.
const base = { id: ResourceId, archived: z.boolean().optional() };
export const resourceSchemas = {
  memories: z.object({
    ...base,
    content: text.min(1),
    agentId: ResourceId.optional(),
    category: z.string().max(80).default("General"),
    importance: z.number().min(1).max(10).default(5),
    pinned: z.boolean().default(false),
    whenToUse: text.optional(),
    tags: z.array(z.string().max(60)).max(30).default([]),
    scope: z
      .enum(["workspace", "personal", "Global", "Agent", "Personal"])
      .default("workspace")
      .transform((v) =>
        v === "Global"
          ? "workspace"
          : ["Agent", "Personal"].includes(v)
            ? "personal"
            : v,
      ),
  }),
  skills: z.object({
    ...base,
    name,
    description: text.default(""),
    documentation: text.min(1),
    whenToUse: text.default(""),
    tags: z.array(z.string().max(60)).max(30).default([]),
    author: z.string().max(160).default("Workspace"),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    sourceId: ResourceId.optional(),
    packageDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
  agents: z.object({
    ...base,
    name,
    description: text.default(""),
    prompt: text.default(""),
    skillIds: ids,
    memoryMode: z
      .enum([
        "connected",
        "read-only",
        "separate",
        "custom",
        "Connected",
        "Read-only",
        "Separate",
        "Custom",
        "Connected memory",
        "Read-only memory",
        "Separate memory",
        "Custom memory",
      ])
      .default("connected"),
    memoryReadScope: z.string().max(100).optional(),
    memorySaveTarget: z.string().max(100).optional(),
    learnsAutomatically: z.boolean().optional(),
    tools: z.array(z.string().max(100)).max(40).optional(),
    model: z.string().max(160).optional(),
    provider: z.string().max(80).optional(),
    reasoning: z.string().max(80).optional(),
    learning: z.record(z.string(), z.string().max(100)).optional(),
    libraryEnabled: z.boolean().optional(),
    starred: z.boolean().optional(),
  }),
  projects: z.object({
    ...base,
    name,
    description: text.default(""),
    goal: text.default(""),
  }),
  rooms: z.object({
    ...base,
    name,
    topic: text.default(""),
    agentIds: ids,
    notes: z
      .array(
        z.object({
          id: ResourceId,
          text: text.min(1),
          createdAt: z.iso.datetime(),
          author: z.string().max(254).optional(),
        }),
      )
      .max(500)
      .default([]),
  }),
  rubrics: z.object({
    ...base,
    name,
    criteria: z.array(z.string().min(1).max(2000)).min(1).max(30),
  }),
  wiki: z.object({
    ...base,
    name,
    content: text.min(1),
    sourceTaskIds: z.array(z.uuid()).max(100).default([]),
  }),
  schedules: z.object({
    ...base,
    name,
    instructions: text.min(1),
    cadence: z.string().regex(/^Daily at ([01]\d|2[0-3]):[0-5]\d$/),
    timeZone: z
      .string()
      .max(80)
      .default("Asia/Shanghai")
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, "Invalid time zone"),
    enabled: z.boolean(),
    agentId: ResourceId.optional(),
    roomId: ResourceId.optional(),
  }),
  preferences: z.object({
    ...base,
    theme: z.enum(["light", "dark", "system"]).optional(),
    displayName: z.string().max(160).optional(),
  }),
};
export type ResourceRow = {
  id: string;
  kind: z.infer<typeof ResourceKind>;
  value: Record<string, any>;
  revision: number;
};
export function parseResource(
  kind: z.infer<typeof ResourceKind>,
  raw: unknown,
) {
  return resourceSchemas[kind].parse(raw);
}
export async function resource(
  db: Queryable,
  workspace: string,
  kind: string,
  id: string,
) {
  const r = await db.query<ResourceRow>(
    "SELECT id,kind,value,revision FROM resources WHERE workspace_id=$1 AND kind=$2 AND id=$3",
    [workspace, kind, id],
  );
  if (!r.rows[0] || r.rows[0].value.archived)
    throw new DomainError("RESOURCE_NOT_FOUND", 404);
  return r.rows[0];
}
export async function searchKnowledge(
  db: Queryable,
  workspace: string,
  query: string,
  agentId?: string,
  separate = false,
) {
  // Filter and rank in PostgreSQL, across the complete workspace history.
  return (
    await db.query<ResourceRow>(
      `
    SELECT id,kind,value,revision FROM resources
    WHERE workspace_id=$1 AND kind IN ('memories','skills','wiki')
      AND COALESCE((value->>'archived')::boolean,false)=false
      AND (value->>'agentId' IS NULL OR value->>'agentId'=$3)
      AND (NOT $4::boolean OR value->>'agentId'=$3)
      AND (search_terms && knowledge_terms($2) OR search_document %> lower($2) OR value->>'pinned'='true')
    ORDER BY
      (SELECT count(*) FROM unnest(search_terms) t WHERE t=ANY(knowledge_terms($2))) * 2
      + CASE WHEN value->>'pinned'='true' THEN 10 ELSE 0 END
      + COALESCE((value->>'importance')::numeric,5)/10 + word_similarity(lower($2),search_document) DESC,
      updated_at DESC,id
    LIMIT 12`,
      [workspace, query, agentId || null, separate],
    )
  ).rows;
}
export async function taskContext(
  db: Queryable,
  workspace: string,
  prompt: string,
  input: unknown,
) {
  const selection = TaskContext.parse(input || {}),
    items: ResourceRow[] = [];
  const add = async (kind: string, id: string) => {
    const r = await resource(db, workspace, kind, id);
    if (!items.some((i) => i.kind === kind && i.id === id)) items.push(r);
    return r;
  };
  let agent: ResourceRow | undefined;
  if (selection.agentId) {
    agent = await add("agents", selection.agentId);
    for (const id of agent.value.skillIds || []) await add("skills", id);
  }
  if (selection.projectId) await add("projects", selection.projectId);
  if (selection.roomId) {
    const room = await add("rooms", selection.roomId);
    for (const id of room.value.agentIds || []) await add("agents", id);
  }
  for (const id of selection.skillIds) await add("skills", id);
  for (const id of selection.memoryIds) await add("memories", id);
  for (const id of selection.rubricIds) await add("rubrics", id);
  const memoryMode = String(agent?.value.memoryMode || "connected")
    .toLowerCase()
    .replace(/ memory$/, "");
  if (
    memoryMode === "separate" ||
    (memoryMode !== "custom" && agent?.value.memoryReadScope !== "linked")
  )
    for (const row of await searchKnowledge(
      db,
      workspace,
      prompt,
      selection.agentId,
      memoryMode === "separate",
    ))
      if (
        row.kind === "memories" &&
        !items.some((i) => i.kind === row.kind && i.id === row.id)
      )
        items.push(row);
  for (const item of items) {
    if (
      item.kind === "memories" &&
      ((item.value.agentId && item.value.agentId !== selection.agentId) ||
        (memoryMode === "separate" && item.value.agentId !== selection.agentId))
    )
      throw new DomainError("MEMORY_SCOPE_DENIED", 403);
  }
  const fileIds: string[] = [];
  for (const id of selection.artifactIds) {
    const r = await db.query<{ file_id: string }>(
      "SELECT file_id FROM artifact_versions WHERE artifact_id=$1 AND workspace_id=$2 ORDER BY version DESC LIMIT 1",
      [id, workspace],
    );
    if (!r.rows[0]) throw new DomainError("NOT_FOUND", 404);
    fileIds.push(r.rows[0].file_id);
  }
  const skills = await installedSkills(db, workspace);
  const result = {
    selection,
    skills,
    items: items.map((item) => {
      if (item.kind !== "skills" || !skills.some((s) => s.id === item.id))
        return item;
      const { documentation, ...metadata } = item.value;
      return { ...item, value: metadata };
    }),
    fileIds,
    memoryMode,
    memoryReadScope: agent?.value.memoryReadScope || "all",
    memorySaveTarget:
      agent?.value.memorySaveTarget ||
      (memoryMode === "separate" ? "agent" : "library"),
    learnsAutomatically: agent?.value.learnsAutomatically !== false,
  };
  if (JSON.stringify(result).length > 60000)
    throw new DomainError("CONTEXT_TOO_LARGE", 413);
  return result;
}
export async function acceptLearning(
  db: Queryable,
  workspace: string,
  id: string,
  decision: "accepted" | "dismissed",
) {
  const r = await db.query(
    "UPDATE learning_suggestions SET decision=$3 WHERE id=$1 AND workspace_id=$2 AND decision IS NULL RETURNING *",
    [id, workspace, decision],
  );
  if (!r.rows[0]) throw new DomainError("SUGGESTION_CONFLICT", 409);
  const s = r.rows[0];
  const context = (
    await db.query("SELECT context FROM tasks WHERE id=$1", [s.task_id])
  ).rows[0]?.context;
  if (decision === "accepted") {
    if (
      context?.memoryMode === "read-only" ||
      context?.learnsAutomatically === false
    )
      throw new DomainError("MEMORY_WRITE_DISABLED", 403);
    if (s.target_id) {
      const current = await resource(db, workspace, s.kind, s.target_id);
      if (current.revision !== s.target_revision)
        throw new DomainError("RESOURCE_CONFLICT", 409);
      const value = parseResource(s.kind, {
        ...current.value,
        ...(s.kind === "skills"
          ? { documentation: s.content }
          : { content: s.content }),
      });
      const updated = await db.query(
        "UPDATE resources SET value=$5,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND kind=$2 AND id=$3 AND revision=$4 RETURNING id",
        [
          workspace,
          s.kind,
          s.target_id,
          s.target_revision,
          JSON.stringify(value),
        ],
      );
      if (!updated.rowCount) throw new DomainError("RESOURCE_CONFLICT", 409);
      return { decision };
    }
    const rid = randomUUID(),
      date = new Date().toISOString();
    const value = parseResource(
      s.kind,
      s.kind === "memories"
        ? {
            id: rid,
            content: s.content,
            ...(context?.memorySaveTarget === "agent"
              ? { agentId: context.selection?.agentId }
              : {}),
          }
        : s.kind === "skills"
          ? {
              id: rid,
              name: s.name,
              documentation: s.content,
              createdAt: date,
              updatedAt: date,
            }
          : {
              id: rid,
              name: s.name,
              content: s.content,
              sourceTaskIds: [s.task_id],
            },
    );
    await db.query(
      "INSERT INTO resources(workspace_id,kind,id,value) VALUES($1,$2,$3,$4)",
      [workspace, s.kind, rid, JSON.stringify(value)],
    );
  }
  return { decision };
}

export function allowedTools(context: {
  selection?: TaskContext;
  items?: ResourceRow[];
  memoryMode?: string;
  learnsAutomatically?: boolean;
}) {
  const agent = context.items?.find(
    (i) => i.kind === "agents" && i.id === context.selection?.agentId,
  );
  let allowed = Object.keys(ToolSchemas) as ToolName[];
  if (agent?.value.tools) {
    const map: Record<string, ToolName[]> = {
      Browser: ["browser"],
      Search: ["web_search", "web_read", "source_read", "image_search"],
      "Thread Search": ["thread_search", "knowledge_search"],
      Files: ["file_read"],
      Skills: ["skill_search", "skill_read", "skill_run"],
      Delegation: ["delegate"],
      Webpages: ["artifact_write"],
      Tables: ["artifact_write", "code_execute"],
      Documents: ["artifact_write", "code_execute"],
      Code: ["code_execute"],
    };
    const selected = new Set<ToolName>([
      "ask_user",
      "finish",
      "learning_propose",
    ]);
    for (const label of agent.value.tools)
      for (const name of map[label] || []) selected.add(name);
    allowed = allowed.filter((n) => selected.has(n));
  }
  if (
    context.memoryMode === "read-only" ||
    context.learnsAutomatically === false
  )
    allowed = allowed.filter((n) => n !== "learning_propose");
  if (!allowed.includes("code_execute"))
    allowed = allowed.filter((n) => n !== "skill_run");
  return allowed;
}
