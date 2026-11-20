import { DomainError, TaskPlan, UpdatePlan } from "@hyper/contracts";
import { event, fenced, tx, type Db, type Queryable, type Task } from "./db.js";
export async function readPlan(c: Queryable, id: string) {
  const r = await c.query(
    "SELECT version,reason,steps,created_at FROM task_plans WHERE task_id=$1 ORDER BY version DESC LIMIT 1",
    [id],
  );
  return r.rows[0]
    ? TaskPlan.parse({
        ...r.rows[0],
        updatedAt: r.rows[0].created_at.toISOString(),
      })
    : null;
}
export async function updatePlan(
  db: Db,
  task: Task,
  operationId: string,
  raw: unknown,
) {
  const input = UpdatePlan.parse(raw);
  return tx(db, async (c) => {
    await fenced(c, task.id, task.lease_owner!);
    const op = await c.query(
      "SELECT 1 FROM operations WHERE id=$1 AND task_id=$2 AND name='update_plan'",
      [operationId, task.id],
    );
    if (!op.rowCount) throw new DomainError("NOT_FOUND", 404);
    const duplicate = (
      await c.query("SELECT * FROM task_plans WHERE operation_id=$1", [
        operationId,
      ])
    ).rows[0];
    if (duplicate) {
      const equal = await c.query(
        "SELECT 1 FROM task_plans WHERE operation_id=$1 AND task_id=$2 AND version=$3 AND reason=$4 AND steps=$5::jsonb",
        [
          operationId,
          task.id,
          input.expectedVersion + 1,
          input.reason,
          JSON.stringify(input.steps),
        ],
      );
      if (!equal.rowCount)
        throw new DomainError("PLAN_OPERATION_CONFLICT", 409);
      return TaskPlan.parse({
        ...duplicate,
        updatedAt: duplicate.created_at.toISOString(),
      });
    }
    const old = await readPlan(c, task.id);
    if ((old?.version ?? 0) !== input.expectedVersion)
      throw new DomainError("PLAN_VERSION_CONFLICT", 409);
    if (old?.steps.some((s) => !input.steps.some((n) => n.id === s.id)))
      throw new DomainError("PLAN_STEP_REMOVAL_REQUIRES_SKIP", 409);
    const r = await c.query(
      "INSERT INTO task_plans(task_id,version,operation_id,reason,steps) VALUES($1,$2,$3,$4,$5) RETURNING created_at",
      [
        task.id,
        input.expectedVersion + 1,
        operationId,
        input.reason,
        JSON.stringify(input.steps),
      ],
    );
    const plan = TaskPlan.parse({
      version: input.expectedVersion + 1,
      reason: input.reason,
      steps: input.steps,
      updatedAt: r.rows[0].created_at.toISOString(),
    });
    await event(c, task.id, { type: "plan", plan });
    return plan;
  });
}
