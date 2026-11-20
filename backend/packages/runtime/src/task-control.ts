import { DomainError, terminal } from "@hyper/contracts";
import { event, fenced, getTask, tx, type Db, type Queryable } from "./db.js";

// Acquire before task row locks everywhere that admits work or changes control.
export async function controlLock(c: Queryable) {
  await c.query("SELECT pg_advisory_xact_lock(730110)");
}
export async function assertDispatch(c: Queryable, taskId: string) {
  await controlLock(c);
  const r = await c.query<{ allowed: boolean }>(
    "SELECT task_dispatch_allowed($1) AS allowed",
    [taskId],
  );
  if (!r.rows[0]?.allowed) throw new DomainError("TASK_PAUSED", 409);
}
export async function settlePauses(db: Db) {
  await tx(db, async (c) => {
    await controlLock(c);
    await c.query("SELECT settle_task_pauses()");
  });
}
export async function pauseBoundary(
  db: Db,
  taskId: string,
  owner: string,
  yieldAnyway = false,
) {
  return tx(db, async (c) => {
    await controlLock(c);
    const task = await getTask(c, taskId);
    const root = await getTask(c, task.root_id);
    if (root.control_state === "normal" && !yieldAnyway) return false;
    await fenced(c, taskId, owner);
    if (yieldAnyway)
      await c.query(
        "UPDATE operations SET status='prepared' WHERE task_id=$1 AND name IN ('finish','delegate','browser') AND status='running'",
        [taskId],
      );
    await c.query(
      "UPDATE tasks SET state='queued',lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
      [taskId],
    );
    await event(c, taskId, { type: "state", state: "queued" });
    await c.query("SELECT settle_task_pauses()");
    return true;
  });
}
export async function controlTask(
  db: Db,
  id: string,
  workspace: string,
  action: "pause" | "resume",
) {
  return tx(db, async (c) => {
    await controlLock(c);
    const task = await getTask(c, id, workspace);
    const root = await getTask(c, task.root_id, workspace);
    if (terminal.has(root.state)) return root.id;
    const next = action === "pause" ? "pause_requested" : "normal";
    if (
      (action === "pause" && root.control_state !== "normal") ||
      root.control_state === next
    )
      return root.id;
    await c.query(
      "UPDATE tasks SET control_state=$2,control_revision=control_revision+1,control_updated_at=now() WHERE id=$1",
      [root.id, next],
    );
    await event(c, root.id, {
      type: "control",
      control: next,
      revision: root.control_revision + 1,
    });
    await c.query("SELECT settle_task_pauses()");
    await c.query("SELECT pg_notify('hyper_kernel',$1)", [root.id]);
    return root.id;
  });
}
