import { searchKnowledge } from "../resources.js";
import { randomUUID } from "node:crypto";

import { DomainError, ToolSchemas, type ToolName } from "@hyper/contracts";
import { tx } from "../db.js";

import type { ToolHandler } from "../tools.js";

export const knowledgeHandlers = {
  thread_search: async function (task, op, signal) {
    const owner = task.lease_owner!;

    const a = ToolSchemas.thread_search.parse(op.args);
    const r = await this.db.query(
      "SELECT c.id,c.title,m.content FROM conversations c JOIN LATERAL(SELECT content FROM messages WHERE conversation_id=c.id AND content ILIKE $2 ORDER BY id DESC LIMIT 2)m ON true WHERE c.workspace_id=$1 ORDER BY c.created_at DESC LIMIT 10",
      [task.workspace_id, "%" + a.query.replace(/[\\%_]/g, "\\$&") + "%"],
    );
    return {
      data: {
        threads: r.rows.map((row) => ({
          ...row,
          content: row.content.slice(0, 2000),
        })),
      },
    };
  },
  skill_search: async function (task, op, signal) {
    const owner = task.lease_owner!;

    const { query } = ToolSchemas.skill_search.parse(op.args);
    return {
      data: {
        skills: (task.context.skills || []).filter((s) =>
          (s.name + " " + s.description)
            .toLowerCase()
            .includes(query.toLowerCase()),
        ),
      },
    };
  },
  skill_read: async function (task, op, signal) {
    const owner = task.lease_owner!;

    const { id, path, offset, length } = ToolSchemas.skill_read.parse(op.args);
    const pinned = task.context.skills?.find((s) => s.id === id);
    if (!pinned) throw new DomainError("SKILL_NOT_IN_TASK", 404);
    const version = (
      await this.db.query(
        "SELECT files FROM skill_versions WHERE workspace_id=$1 AND package_id=$2 AND digest=$3",
        [task.workspace_id, id, pinned.digest],
      )
    ).rows[0];
    if (!version || !Object.hasOwn(version.files, path))
      throw new DomainError("NOT_FOUND", 404);
    return {
      data: {
        id,
        digest: pinned.digest,
        path,
        content: version.files[path].slice(offset, offset + length),
        total: version.files[path].length,
      },
    };
  },
  knowledge_search: async function (task, op, signal) {
    const owner = task.lease_owner!;

    if (
      task.context?.memoryMode === "custom" ||
      (task.context?.memoryReadScope === "linked" &&
        task.context?.memoryMode !== "separate")
    )
      return { data: { items: task.context?.items || [] } };
    const a = ToolSchemas.knowledge_search.parse(op.args);
    return {
      data: {
        items: await searchKnowledge(
          this.db,
          task.workspace_id,
          a.query,
          task.context?.selection?.agentId,
          task.context?.memoryMode === "separate",
        ),
      },
    };
  },
  learning_propose: async function (task, op, signal) {
    const owner = task.lease_owner!;

    if (task.context?.memoryMode === "read-only")
      throw new DomainError("MEMORY_WRITE_DISABLED");
    const a = ToolSchemas.learning_propose.parse(op.args),
      id = randomUUID();
    const agent = task.context?.items?.find(
      (i) => i.kind === "agents" && i.id === task.context.selection?.agentId,
    );
    const preference =
      a.kind === "memories"
        ? "Memory suggestions"
        : a.kind === "skills"
          ? "Skill suggestions"
          : "Wiki suggestions";
    if (agent?.value.learning?.[preference] === "Disabled")
      throw new DomainError("LEARNING_DISABLED_FOR_AGENT");
    const r = await tx(this.db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        task.workspace_id + ":learning",
      ]);
      const agentId =
        task.context.memorySaveTarget === "agent"
          ? task.context.selection?.agentId
          : undefined;
      if (task.context.memorySaveTarget === "agent" && !agentId)
        throw new DomainError("MEMORY_SCOPE_DENIED", 403);
      const duplicate = await c.query(
        `SELECT id FROM learning_suggestions WHERE workspace_id=$1 AND kind=$2 AND content=$3 AND decision IS DISTINCT FROM 'dismissed'
            AND task_id IN (SELECT id FROM tasks WHERE workspace_id=$1 AND context->>'memorySaveTarget' IS NOT DISTINCT FROM $4 AND context->'selection'->>'agentId' IS NOT DISTINCT FROM $5) LIMIT 1`,
        [
          task.workspace_id,
          a.kind,
          a.content,
          task.context.memorySaveTarget || null,
          task.context.selection?.agentId || null,
        ],
      );
      if (duplicate.rowCount) return duplicate;
      const saved = await c.query(
        `SELECT id FROM resources WHERE workspace_id=$1 AND kind=$2 AND COALESCE(value->>'content',value->>'documentation')=$3 AND value->>'agentId' IS NOT DISTINCT FROM $4`,
        [task.workspace_id, a.kind, a.content, agentId || null],
      );
      if (saved.rowCount) return { rows: [{ id: null }] };
      let before = null;
      if (a.targetId) {
        const target = (
          await c.query(
            "SELECT value,revision FROM resources WHERE workspace_id=$1 AND kind=$2 AND id=$3",
            [task.workspace_id, a.kind, a.targetId],
          )
        ).rows[0];
        if (!target || target.revision !== a.targetRevision)
          throw new DomainError("RESOURCE_CONFLICT", 409);
        if ((target.value.agentId || null) !== (agentId || null))
          throw new DomainError("MEMORY_SCOPE_DENIED", 403);
        before = target.value;
      } else if (a.targetRevision) throw new DomainError("TARGET_REQUIRED");
      return c.query(
        "INSERT INTO learning_suggestions(id,workspace_id,task_id,operation_id,kind,name,content,reason,target_id,target_revision,before_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(operation_id) DO UPDATE SET operation_id=EXCLUDED.operation_id RETURNING id",
        [
          id,
          task.workspace_id,
          task.id,
          op.id,
          a.kind,
          a.name,
          a.content,
          a.reason,
          a.targetId || null,
          a.targetRevision || null,
          before,
        ],
      );
    });
    return {
      data: {
        suggestionId: r.rows[0].id,
        status: r.rows[0].id ? "pending_review" : "already_saved",
        savedToKnowledge: false,
      },
    };
  },
} satisfies Partial<Record<ToolName, ToolHandler>>;
