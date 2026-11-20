import { assertDispatch } from "../task-control.js";

import { randomUUID } from "node:crypto";

import { DomainError, ToolSchemas, type ToolName } from "@hyper/contracts";
import { tx, fenced, event } from "../db.js";

import { hash } from "../auth.js";

import type { ToolHandler } from "../tools.js";

export const coordinationHandlers = {
  delegate: async function (task, op, signal) {
    const owner = task.lease_owner!;

    const a = ToolSchemas.delegate.parse(op.args);
    if (task.parent_id) throw new DomainError("DELEGATION_DEPTH");
    return tx(this.db, async (c) => {
      await assertDispatch(c, task.id);
      await fenced(c, task.id, owner);
      const old = await c.query<{ id: string }>(
        "SELECT id FROM tasks WHERE parent_id=$1 AND NOT kernel_internal",
        [task.id],
      );
      if (old.rows.length)
        return {
          data: { taskIds: old.rows.map((t) => t.id) },
          pause: "waiting_children" as const,
        };
      const ids = [];
      for (const sub of a.tasks) {
        const id = randomUUID();
        ids.push(id);
        await c.query(
          "INSERT INTO tasks(id,workspace_id,conversation_id,parent_id,root_id,prompt,acceptance,input_file_ids,state,deadline,context) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10)",
          [
            id,
            task.workspace_id,
            task.conversation_id,
            task.id,
            task.root_id,
            sub.prompt,
            JSON.stringify(sub.acceptance),
            JSON.stringify(task.input_file_ids),
            task.deadline,
            JSON.stringify(task.context || {}),
          ],
        );
        await event(c, id, { type: "state", state: "queued" });
      }
      return { data: { taskIds: ids }, pause: "waiting_children" as const };
    });
  },
  ask_user: async function (task, op, signal) {
    const owner = task.lease_owner!;

    const a = ToolSchemas.ask_user.parse(op.args);
    return { data: a, pause: "waiting_user" };
  },
  request_approval: async function (task, op, signal) {
    const owner = task.lease_owner!;

    const a = ToolSchemas.request_approval.parse(op.args);
    const digest = hash(JSON.stringify(a)),
      id = randomUUID();
    await this.db.query(
      "INSERT INTO approvals(id,task_id,operation_id,action,payload,digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(operation_id) DO NOTHING",
      [id, task.id, op.id, a.action, JSON.stringify(a.payload), digest],
    );
    return {
      data: {
        approvalId: id,
        digest,
        executed: false,
        executorAvailable: false,
      },
      pause: "waiting_approval",
    };
  },
  finish: async function (task, op, signal) {
    const owner = task.lease_owner!;

    const a = ToolSchemas.finish.parse(op.args);
    // Resolve requested deliveries from persisted versions, including when
    // a model mentions only the most recently returned artifact ID.
    const persisted = await this.db.query<{ artifact_id: string }>(
      `SELECT DISTINCT ON (f.format) v.artifact_id FROM artifact_versions v
           JOIN files f ON f.id=v.file_id JOIN artifacts ar ON ar.id=v.artifact_id
           WHERE f.task_id=$1 AND f.workspace_id=$2 AND ar.conversation_id=$3
             AND f.format=ANY($4::text[])
             AND v.version=(SELECT max(v2.version) FROM artifact_versions v2 WHERE v2.artifact_id=v.artifact_id)
           ORDER BY f.format,v.created_at DESC`,
      [
        task.id,
        task.workspace_id,
        task.conversation_id,
        task.acceptance.formats,
      ],
    );
    a.artifactIds = [
      ...new Set([
        ...a.artifactIds,
        ...persisted.rows.map((row) => row.artifact_id),
      ]),
    ];
    return { data: a, finish: a };
  },
} satisfies Partial<Record<ToolName, ToolHandler>>;
