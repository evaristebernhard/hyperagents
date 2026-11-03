import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  DomainError,
  Event,
  type TaskEvent,
  type TaskState,
  type Message,
  type CreateTask,
} from "@hyper/contracts";
export type Db = pg.Pool;
export type Queryable = Pick<pg.Pool, "query">;
export const pool = (url: string) =>
  new pg.Pool({ connectionString: url, max: 12, statement_timeout: 15000 });
export async function tx<T>(
  db: Db,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const v = await fn(c);
    await c.query("COMMIT");
    return v;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
export async function migrate(db: Db) {
  await tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(730101)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const dir = fileURLToPath(new URL("../../../migrations/", import.meta.url));
    for (const name of (await readdir(dir))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      if (
        !(await c.query("SELECT 1 FROM migrations WHERE name=$1", [name]))
          .rowCount
      ) {
        await c.query(await readFile(dir + name, "utf8"));
        await c.query("INSERT INTO migrations(name) VALUES($1)", [name]);
      }
    }
  });
}
export interface Checkpoint {
  messages?: Message[];
  summary?: string;
}
export interface Task {
  id: string;
  workspace_id: string;
  conversation_id: string;
  parent_id: string | null;
  root_id: string;
  prompt: string;
  acceptance: CreateTask["acceptance"];
  input_file_ids: string[];
  state: TaskState;
  checkpoint: Checkpoint;
  result: unknown;
  error_code: string | null;
  step: number;
  repair_count: number;
  instruction_cursor: string;
  lease_owner: string | null;
  lease_until: Date | null;
  deadline: Date | null;
  created_at: Date;
  updated_at: Date;
  model_calls: number;
  tool_calls: number;
  tokens: string;
  transfer_bytes: string;
  artifact_bytes: string;
}
export async function getTask(
  db: Queryable,
  id: string,
  workspace?: string,
): Promise<Task> {
  const r = await db.query<Task>(
    "SELECT * FROM tasks WHERE id=$1" +
      (workspace ? " AND workspace_id=$2" : ""),
    workspace ? [id, workspace] : [id],
  );
  if (!r.rows[0]) throw new DomainError("NOT_FOUND", 404);
  return r.rows[0];
}
export async function event(db: Queryable, id: string, payload: TaskEvent) {
  await db.query("INSERT INTO events(task_id,payload) VALUES($1,$2)", [
    id,
    Event.parse(payload),
  ]);
}
export async function fenced(c: Queryable, id: string, owner: string) {
  const r = await c.query(
    "SELECT 1 FROM tasks WHERE id=$1 AND lease_owner=$2 AND lease_until>now() AND state='running' FOR UPDATE",
    [id, owner],
  );
  if (!r.rowCount) throw new DomainError("LEASE_LOST", 409);
}
export async function setState(
  db: Db,
  id: string,
  state: TaskState,
  owner?: string,
  code?: string,
  result?: unknown,
) {
  await tx(db, async (c) => {
    if (owner) await fenced(c, id, owner);
    if (owner && ["waiting_user", "waiting_approval"].includes(state)) {
      const pending = await c.query(
        "SELECT 1 FROM instructions i JOIN tasks t ON t.id=i.task_id WHERE t.id=$1 AND i.id>t.instruction_cursor",
        [id],
      );
      if (pending.rowCount) state = "queued";
    }
    await c.query(
      "UPDATE tasks SET state=$2,error_code=$3,result=COALESCE($4,result),lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
      [
        id,
        state,
        code ?? null,
        result === undefined ? null : JSON.stringify(result),
      ],
    );
    await event(c, id, { type: "state", state });
    if (["failed", "cancelled", "succeeded"].includes(state)) {
      const children = await c.query<{ id: string }>(
        "UPDATE tasks SET state='cancelled',lease_owner=NULL,lease_until=NULL WHERE parent_id=$1 AND state NOT IN ('succeeded','failed','cancelled') RETURNING id",
        [id],
      );
      for (const child of children.rows)
        await event(c, child.id, { type: "state", state: "cancelled" });
    }
  });
}
export async function claim(db: Db): Promise<Task | undefined> {
  return tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(730102)");
    // A crashed operation whose effects cannot be established is never automatically replayed.
    const expired = await c.query<Task>(
      "SELECT * FROM tasks WHERE state='running' AND lease_until<now() FOR UPDATE",
    );
    for (const t of expired.rows) {
      const abandoned = await c.query<{ reserved: string }>(
        "UPDATE model_attempts SET status='failed' WHERE task_id=$1 AND status='running' RETURNING reserved",
        [t.id],
      );
      const reserved = abandoned.rows.reduce(
        (n, r) => n + Number(r.reserved),
        0,
      );
      if (reserved)
        await c.query(
          "UPDATE tasks SET reserved_tokens=reserved_tokens-$2,tokens=tokens+$2 WHERE id=$1",
          [t.root_id, reserved],
        );
      const uncertain = await c.query(
        "SELECT 1 FROM operations WHERE task_id=$1 AND status='running' AND replay='uncertain'",
        [t.id],
      );
      const state = uncertain.rowCount ? "uncertain" : "queued";
      await c.query(
        "UPDATE tasks SET state=$2,lease_owner=NULL,lease_until=NULL WHERE id=$1",
        [t.id, state],
      );
      await event(c, t.id, { type: "state", state });
    }
    const r =
      await c.query<Task>(`SELECT t.* FROM tasks t WHERE t.state='queued' AND (t.parent_id IS NOT NULL OR (
 (SELECT count(*) FROM tasks WHERE parent_id IS NULL AND state IN ('running','waiting_children'))<2
 AND NOT EXISTS(SELECT 1 FROM tasks x WHERE x.workspace_id=t.workspace_id AND x.parent_id IS NULL AND x.state IN ('running','waiting_children'))
 )) AND (t.parent_id IS NULL OR EXISTS(SELECT 1 FROM tasks p WHERE p.id=t.parent_id AND p.state IN ('running','waiting_children')))
 ORDER BY (t.parent_id IS NOT NULL) DESC,t.created_at FOR UPDATE OF t SKIP LOCKED LIMIT 1`);
    const t = r.rows[0];
    if (!t) return;
    const root = await getTask(c, t.root_id);
    if (root.deadline && root.deadline.getTime() < Date.now()) {
      await c.query(
        "UPDATE tasks SET state='failed',error_code='TIME_BUDGET' WHERE id=$1",
        [t.id],
      );
      await event(c, t.id, { type: "state", state: "failed" });
      return;
    }
    const owner = randomUUID();
    await c.query(
      "UPDATE tasks SET deadline=COALESCE(deadline,now()+interval '20 minutes') WHERE id=$1",
      [t.root_id],
    );
    await c.query(
      "UPDATE tasks SET state='running',lease_owner=$2,lease_until=now()+interval '30 seconds',deadline=(SELECT deadline FROM tasks WHERE id=$3),updated_at=now() WHERE id=$1",
      [t.id, owner, t.root_id],
    );
    await event(c, t.id, { type: "state", state: "running" });
    return getTask(c, t.id);
  });
}
export async function heartbeat(db: Db, id: string, owner: string) {
  const r = await db.query(
    "UPDATE tasks SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>now() RETURNING id",
    [id, owner],
  );
  return !!r.rowCount;
}
export const publicTask = (t: Task) => ({
  id: t.id,
  conversationId: t.conversation_id,
  state: t.state,
  prompt: t.prompt,
  result: t.result,
  errorCode: t.error_code,
  createdAt: t.created_at.toISOString(),
  updatedAt: t.updated_at.toISOString(),
});
