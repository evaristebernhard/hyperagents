import { randomUUID } from "node:crypto";
import {
  CreateTask,
  DomainError,
  terminal,
  type TaskState,
} from "@hyper/contracts";
import { tx, event, getTask, type Db } from "./db.js";
import { hash } from "./auth.js";
export async function createTask(
  db: Db,
  workspace: string,
  raw: unknown,
  key: string,
) {
  const input = CreateTask.parse(raw);
  if (!key || key.length > 200)
    throw new DomainError("IDEMPOTENCY_KEY_REQUIRED");
  const digest = hash(JSON.stringify(input));
  return tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [workspace]);
    const old = await c.query<{ id: string; request_hash: string }>(
      "SELECT id,request_hash FROM tasks WHERE workspace_id=$1 AND idempotency_key=$2",
      [workspace, key],
    );
    if (old.rows[0]) {
      if (old.rows[0].request_hash !== digest)
        throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
      return { taskId: old.rows[0].id };
    }
    for (const id of input.inputFileIds) {
      if (
        !(
          await c.query("SELECT 1 FROM files WHERE id=$1 AND workspace_id=$2", [
            id,
            workspace,
          ])
        ).rowCount
      )
        throw new DomainError("NOT_FOUND", 404);
    }
    const conversation = input.conversationId ?? randomUUID();
    if (input.conversationId) {
      if (
        !(
          await c.query(
            "SELECT 1 FROM conversations WHERE id=$1 AND workspace_id=$2",
            [conversation, workspace],
          )
        ).rowCount
      )
        throw new DomainError("NOT_FOUND", 404);
    } else
      await c.query(
        "INSERT INTO conversations(id,workspace_id,title) VALUES($1,$2,$3)",
        [conversation, workspace, input.prompt.slice(0, 100)],
      );
    const formats = [...input.acceptance.formats];
    for (const [pattern, format] of [
      [/\bpdf\b/i, "pdf"],
      [/\bcsv\b/i, "csv"],
      [/\bhtml\b|网页/i, "html"],
      [/\bpng\b|图表/i, "png"],
    ] as const)
      if (pattern.test(input.prompt) && !formats.includes(format))
        formats.push(format);
    if (
      !formats.length &&
      /文档|报告|\b(document|report)\b/i.test(input.prompt)
    )
      formats.push("md");
    const id = randomUUID();
    await c.query(
      "INSERT INTO tasks(id,workspace_id,conversation_id,root_id,prompt,acceptance,input_file_ids,state,idempotency_key,request_hash) VALUES($1,$2,$3,$1,$4,$5,$6,'queued',$7,$8)",
      [
        id,
        workspace,
        conversation,
        input.prompt,
        JSON.stringify({ ...input.acceptance, formats }),
        JSON.stringify(input.inputFileIds),
        key,
        digest,
      ],
    );
    await c.query(
      "INSERT INTO messages(conversation_id,role,content) VALUES($1,'user',$2)",
      [conversation, input.prompt],
    );
    await event(c, id, { type: "state", state: "queued" });
    return { taskId: id };
  });
}
export async function cancelTask(db: Db, id: string, workspace: string) {
  await tx(db, async (c) => {
    const t = await getTask(c, id, workspace);
    if (terminal.has(t.state)) return;
    const r = await c.query<{ id: string }>(
      "UPDATE tasks SET state='cancelled',lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE (id=$1 OR parent_id=$1) AND state NOT IN ('succeeded','failed','cancelled') RETURNING id",
      [id],
    );
    for (const row of r.rows)
      await event(c, row.id, { type: "state", state: "cancelled" });
  });
}
export async function followup(
  db: Db,
  id: string,
  workspace: string,
  message: string,
) {
  await tx(db, async (c) => {
    await c.query(
      "SELECT 1 FROM tasks WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
      [id, workspace],
    );
    const t = await getTask(c, id, workspace);
    if (terminal.has(t.state) || t.state === "uncertain")
      throw new DomainError("TASK_NOT_RESUMABLE", 409);
    await c.query("INSERT INTO instructions(task_id,message) VALUES($1,$2)", [
      id,
      message,
    ]);
    await c.query(
      "INSERT INTO messages(conversation_id,role,content) VALUES($1,'user',$2)",
      [t.conversation_id, message],
    );
    await event(c, id, { type: "instruction", message });
    if (["waiting_user", "waiting_approval"].includes(t.state)) {
      await c.query(
        "UPDATE tasks SET state='queued',updated_at=now() WHERE id=$1",
        [id],
      );
      await event(c, id, { type: "state", state: "queued" });
    }
  });
}
export async function retryTask(db: Db, id: string, workspace: string) {
  await tx(db, async (c) => {
    await c.query(
      "SELECT 1 FROM tasks WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
      [id, workspace],
    );
    const t = await getTask(c, id, workspace);
    if (t.state === "uncertain")
      throw new DomainError("UNCERTAIN_REQUIRES_NEW_TASK", 409);
    if (t.state !== "failed") throw new DomainError("NOT_RETRYABLE", 409);
    if (/BUDGET|VALIDATION/.test(t.error_code ?? ""))
      throw new DomainError("BUDGET_REQUIRES_NEW_TASK", 409);
    await c.query(
      "UPDATE tasks SET state='queued',error_code=NULL,updated_at=now() WHERE id=$1",
      [id],
    );
    await event(c, id, { type: "state", state: "queued" });
  });
}
export async function wakeParents(db: Db) {
  await tx(db, async (c) => {
    const r = await c.query<{ id: string }>(
      `UPDATE tasks t SET state='queued',updated_at=now() WHERE state='waiting_children' AND NOT EXISTS(SELECT 1 FROM tasks ch WHERE ch.parent_id=t.id AND ch.state NOT IN ('succeeded','failed','cancelled','uncertain','waiting_user','waiting_approval')) RETURNING id`,
    );
    for (const t of r.rows)
      await event(c, t.id, { type: "state", state: "queued" });
  });
}
