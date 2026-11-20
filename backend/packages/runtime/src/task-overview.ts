import { TaskOverview } from "@hyper/contracts";
import { getTask, publicTask, tx, type Db } from "./db.js";
import { readPlan } from "./task-plan.js";
import { availableActions, budgetUsage, diagnose } from "./diagnosis.js";

export async function taskOverview(
  db: Db,
  id: string,
  workspace: string,
): Promise<TaskOverview> {
  return tx(db, async (c) => {
    // One MVCC snapshot for state, plan, controls, event cursor and delivery versions.
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const task = await getTask(c, id, workspace),
      root = await getTask(c, task.root_id, workspace);
    const plan = await readPlan(c, id);
    const scope = task.parent_id ? task.id : task.root_id;
    const operations = (
      await c.query(
        `SELECT o.id,o.task_id AS "taskId",'tool' AS kind,o.name,o.status,o.result->>'error' AS "errorCode",o.created_at AS "createdAt",t.state AS "taskState"
      FROM operations o JOIN tasks t ON t.id=o.task_id WHERE (t.id=$1 OR t.root_id=$1) AND t.workspace_id=$2
      UNION ALL SELECT m.id,m.task_id,'model',COALESCE(m.model,'model'),m.status,m.error_code,m.created_at,t.state
      FROM model_attempts m JOIN tasks t ON t.id=m.task_id WHERE (t.id=$1 OR t.root_id=$1) AND t.workspace_id=$2 ORDER BY "createdAt" DESC,id DESC`,
        [scope, workspace],
      )
    ).rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    const validation = (
      await c.query(
        `SELECT d.id,d.task_id AS "taskId",d.operation_id AS "operationId",d.status,d.issues,d.artifacts,d.created_at AS "createdAt" FROM delivery_checks d JOIN tasks t ON t.id=d.task_id WHERE (t.id=$1 OR t.root_id=$1) AND t.workspace_id=$2 ORDER BY d.created_at,d.id`,
        [scope, workspace],
      )
    ).rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    const versions = (
      await c.query(
        `SELECT v.artifact_id AS "artifactId",v.file_id AS "fileId",v.task_id AS "taskId",v.version,f.name,f.format,f.bytes,f.sha256,v.source_ids AS "sourceIds",v.validation AS "structuralValidation",v.created_at AS "createdAt"
      FROM artifact_versions v JOIN files f ON f.id=v.file_id JOIN tasks t ON t.id=v.task_id
      WHERE (t.id=$1 OR t.root_id=$1 OR EXISTS(SELECT 1 FROM delivery_checks d JOIN tasks dt ON dt.id=d.task_id WHERE (dt.id=$1 OR dt.root_id=$1) AND d.artifacts @> jsonb_build_array(jsonb_build_object('fileId',v.file_id)))) AND v.workspace_id=$2 ORDER BY v.created_at,v.version`,
        [scope, workspace],
      )
    ).rows;
    const deliverables = [];
    for (const v of versions) {
      const verdict = validation
        .filter((check) =>
          check.artifacts.some(
            (a: { fileId: string }) => a.fileId === v.fileId,
          ),
        )
        .at(-1);
      const sources = (
        await c.query(
          "SELECT id,url,title,read FROM sources WHERE id=ANY($1::uuid[]) AND workspace_id=$2",
          [v.sourceIds, workspace],
        )
      ).rows;
      deliverables.push({
        ...v,
        bytes: Number(v.bytes),
        createdAt: v.createdAt.toISOString(),
        downloadUrl: "/api/v1/files/" + v.fileId + "/download",
        sources,
        validation: verdict?.status ?? "unverified",
      });
    }
    const children = [];
    for (const child of (
      await c.query(
        "SELECT * FROM tasks WHERE root_id=$1 AND id<>$1 AND NOT kernel_internal AND workspace_id=$2 ORDER BY created_at,id",
        [task.id, workspace],
      )
    ).rows) {
      children.push({
        id: child.id,
        parentId: child.parent_id,
        state: child.state,
        prompt: child.prompt,
        errorCode: child.error_code,
        plan: await readPlan(c, child.id),
      });
    }
    const cursor = (
      await c.query(
        "SELECT COALESCE(max(id),0)::text AS cursor FROM events WHERE task_id=$1",
        [id],
      )
    ).rows[0].cursor;
    const currentOperations = operations.filter(
      (o) =>
        ["running", "dispatched"].includes(o.status) &&
        !["failed", "succeeded", "cancelled", "uncertain"].includes(
          o.taskState,
        ) &&
        !["failed", "succeeded", "cancelled", "uncertain"].includes(task.state),
    );
    return TaskOverview.parse({
      task: publicTask(task),
      rootTaskId: root.id,
      runtime: task.runtime_kind,
      control: root.control_state,
      controlRevision: root.control_revision,
      plan,
      completedSteps:
        plan?.steps.filter((s) => s.status === "completed").length ?? 0,
      totalSteps: plan?.steps.length ?? 0,
      budget: await budgetUsage(c, task),
      currentOperations,
      diagnosis: diagnose(task, operations[0] ?? null, validation),
      availableActions: await availableActions(c, task, root),
      deliverables,
      validation,
      children,
      eventCursor: cursor,
    });
  });
}
