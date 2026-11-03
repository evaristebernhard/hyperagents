import { type Db } from "./db.js";
import { createTask } from "./tasks.js";
import { codeOf } from "@hyper/contracts";
import { resourceSchemas } from "./resources.js";
export async function runSchedules(db: Db, now = new Date()) {
  const minute = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const rows = (
    await db.query(
      "SELECT workspace_id,id,value FROM resources WHERE kind='schedules' AND value->>'enabled'='true' AND COALESCE(value->>'archived','false')='false'",
    )
  ).rows;
  for (const row of rows) {
    const parsed = resourceSchemas.schedules.safeParse(row.value);
    if (!parsed.success) continue;
    const s = parsed.data,
      parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: s.timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(now);
    if (s.cadence === "Daily at " + parts)
      await db.query(
        "INSERT INTO schedule_runs(workspace_id,schedule_id,occurrence) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [row.workspace_id, row.id, minute],
      );
  }
  // Reconcile claimed occurrences after restart. createTask uses an occurrence
  // idempotency key, so a crash between task insertion and linking cannot duplicate.
  const pending = (
    await db.query(
      `SELECT r.*,s.value FROM schedule_runs r JOIN resources s ON s.workspace_id=r.workspace_id AND s.id=r.schedule_id AND s.kind='schedules' WHERE r.task_id IS NULL AND r.error_code IS NULL ORDER BY occurrence LIMIT 100`,
    )
  ).rows;
  for (const run of pending) {
    try {
      const s = resourceSchemas.schedules.parse(run.value);
      const task = await createTask(
        db,
        run.workspace_id,
        {
          prompt: s.instructions,
          context: { agentId: s.agentId, roomId: s.roomId },
        },
        "schedule:" +
          run.schedule_id +
          ":" +
          new Date(run.occurrence).toISOString(),
      );
      await db.query(
        "UPDATE schedule_runs SET task_id=$4 WHERE workspace_id=$1 AND schedule_id=$2 AND occurrence=$3",
        [run.workspace_id, run.schedule_id, run.occurrence, task.taskId],
      );
    } catch (e) {
      await db.query(
        "UPDATE schedule_runs SET error_code=$4 WHERE workspace_id=$1 AND schedule_id=$2 AND occurrence=$3",
        [run.workspace_id, run.schedule_id, run.occurrence, codeOf(e)],
      );
    }
  }
}
