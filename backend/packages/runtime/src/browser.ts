import { randomUUID } from "node:crypto";
import {
  BrowserAction,
  DomainError,
  terminal,
  type Message,
} from "@hyper/contracts";
import {
  tx,
  fenced,
  event,
  getTask,
  type Db,
  type Queryable,
  type Task,
} from "./db.js";
import { hash, token, type Identity } from "./auth.js";
import type { Config } from "./config.js";
import type { Operation } from "./tools.js";

export interface BrowserSession {
  id: string;
  profile_id: string;
  profile_name?: string;
  task_id: string | null;
  state: string;
  control: "agent" | "transferring" | "human" | "paused";
  control_epoch: number;
  controller_id: string | null;
  tabs: unknown[];
}
export class BrowserClient {
  constructor(readonly config: Config) {}
  async request(path: string, body?: unknown) {
    if (
      this.config.BROWSER_ENABLED !== "true" ||
      !this.config.BROWSER_URL ||
      !this.config.BROWSER_TOKEN
    )
      throw new DomainError("BROWSER_UNAVAILABLE", 503);
    const response = await fetch(new URL(path, this.config.BROWSER_URL), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.config.BROWSER_TOKEN}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : browserJson(body),
      signal: AbortSignal.timeout(path === "/health" ? 1500 : 45000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new DomainError(
        body.error && /^[A-Z_]+$/.test(body.error)
          ? body.error
          : "BROWSER_SERVICE_UNAVAILABLE",
        response.status,
      );
    }
    return (await response.json()) as Record<string, any>;
  }
  async health() {
    try {
      const r = await this.request("/health");
      return {
        available: r.ok === true,
        operations: r.ok ? BrowserAction.shape.action.options : [],
        reason: r.ok ? undefined : "BROWSER_UNAVAILABLE",
      };
    } catch {
      return {
        available: false,
        operations: [],
        reason: "BROWSER_UNAVAILABLE",
      };
    }
  }
}
export async function browserAccess(
  db: Queryable,
  profileId: string,
  workspace: string,
  userId?: string,
) {
  const r = await db.query(
    `SELECT p.*,w.kind FROM browser_profiles p JOIN workspaces w ON w.id=p.workspace_id
     WHERE p.id=$1 AND p.workspace_id=$2 AND p.deleted_at IS NULL AND
     (($3::uuid IS NOT NULL AND w.kind='personal' AND w.user_id=$3 AND p.owner_id=$3) OR
      ($3::uuid IS NOT NULL AND w.kind='team' AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w.id AND m.user_id=$3 AND m.role<>'viewer') AND
      EXISTS(SELECT 1 FROM browser_grants g WHERE g.profile_id=p.id AND g.user_id=$3)))`,
    [profileId, workspace, userId ?? null],
  );
  if (!r.rowCount) throw new DomainError("BROWSER_PROFILE_FORBIDDEN", 403);
  return r.rows[0]!;
}
export async function sessionAccess(
  db: Queryable,
  id: string,
  identity: Identity,
) {
  const s = (
    await db.query<BrowserSession>(
      "SELECT s.*,p.name AS profile_name FROM browser_sessions s JOIN browser_profiles p ON p.id=s.profile_id WHERE s.id=$1",
      [id],
    )
  ).rows[0];
  if (!s) throw new DomainError("NOT_FOUND", 404);
  await browserAccess(db, s.profile_id, identity.workspaceId, identity.userId);
  return s;
}
export async function browserEvent(
  db: Queryable,
  s: BrowserSession,
  reason?: string,
) {
  if (s.task_id)
    await event(db, s.task_id, {
      type: "browser",
      sessionId: s.id,
      control: s.control,
      controlEpoch: s.control_epoch,
      reason,
    });
}
export async function reserveSession(
  db: Queryable,
  profile: string,
  taskId: string | null,
) {
  await db.query("SELECT pg_advisory_xact_lock(730110)");
  // Terminal tasks release their identity, but keep the live browser for subsequent tasks.
  await db.query(
    "UPDATE browser_sessions s SET task_id=NULL WHERE task_id IN (SELECT id FROM tasks WHERE state IN ('succeeded','failed','cancelled')) AND control='agent'",
  );
  const old = (
    await db.query<BrowserSession>(
      "SELECT * FROM browser_sessions WHERE profile_id=$1 AND state IN ('starting','open') FOR UPDATE",
      [profile],
    )
  ).rows[0];
  if (old) {
    if (old.task_id && old.task_id !== taskId) return;
    if (old.control !== "agent" && old.task_id !== taskId) return;
    if (taskId && !old.task_id) {
      await db.query(
        "UPDATE browser_sessions SET task_id=$2,control_epoch=control_epoch+1 WHERE id=$1",
        [old.id, taskId],
      );
      old.task_id = taskId;
      old.control_epoch++;
    }
    return old;
  }
  const count = await db.query(
    "SELECT 1 FROM browser_sessions WHERE state IN ('starting','open')",
  );
  if (count.rowCount! >= 2) return;
  const id = randomUUID();
  return (
    await db.query<BrowserSession>(
      "INSERT INTO browser_sessions(id,profile_id,task_id) VALUES($1,$2,$3) RETURNING *",
      [id, profile, taskId],
    )
  ).rows[0]!;
}
// Called before any network dispatch. Checkpoint, operation and outbox share one commit.
export async function prepareBrowser(db: Db, task: Task, op: Operation) {
  const args = BrowserAction.parse(op.args);
  if (!task.browser_profile_id)
    throw new DomainError("BROWSER_PROFILE_REQUIRED");
  return tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(730110)");
    await fenced(c, task.id, task.lease_owner!);
    await browserAccess(
      c,
      task.browser_profile_id!,
      task.workspace_id,
      task.requested_by ?? undefined,
    );
    const s = await reserveSession(c, task.browser_profile_id!, task.id);
    if (!s || s.control !== "agent") {
      await c.query("UPDATE operations SET status='prepared' WHERE id=$1", [
        op.id,
      ]);
      await c.query(
        "UPDATE tasks SET state='waiting_browser',wait_reason=$2,lease_owner=NULL,lease_until=NULL WHERE id=$1",
        [task.id, s ? "human_control" : "profile_or_capacity"],
      );
      await event(c, task.id, { type: "state", state: "waiting_browser" });
      return;
    }
    const charged = await c.query(
      "UPDATE tasks SET tool_calls=tool_calls+1 WHERE id=$1 AND tool_calls<64 RETURNING id",
      [task.root_id],
    );
    if (!charged.rowCount) throw new DomainError("TOOL_BUDGET");
    await c.query("UPDATE operations SET status='dispatched' WHERE id=$1", [
      op.id,
    ]);
    await c.query(
      "INSERT INTO browser_outbox(operation_id,task_id,session_id,profile_id,control_epoch) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [op.id, task.id, s.id, s.profile_id, s.control_epoch],
    );
    await c.query(
      "UPDATE tasks SET state='waiting_tool',wait_reason='browser_operation',lease_owner=NULL,lease_until=NULL WHERE id=$1",
      [task.id],
    );
    await event(c, task.id, { type: "state", state: "waiting_tool" });
    await browserEvent(c, s, args.action);
  });
}
export async function enqueueBrowserResult(
  db: Queryable,
  opId: string,
  taskId: string,
  result: unknown,
  uncertain = false,
) {
  await db.query(
    "INSERT INTO task_inputs(id,task_id,kind,payload) VALUES($1,$2,'browser_result',$3) ON CONFLICT DO NOTHING",
    [
      "browser:" + opId,
      taskId,
      browserJson({ operationId: opId, result, uncertain }),
    ],
  );
}
export async function consumeBrowserInputs(db: Db) {
  await tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(730110)");
    const inputs = await c.query(
      "SELECT * FROM task_inputs WHERE consumed_at IS NULL ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 50",
    );
    for (const i of inputs.rows) {
      await c.query("SELECT 1 FROM tasks WHERE id=$1 FOR UPDATE", [i.task_id]);
      const task = await getTask(c, i.task_id);
      if (!terminal.has(task.state)) {
        const messages: Message[] = [...(task.checkpoint.messages ?? [])];
        let next = task.state;
        if (i.kind === "browser_result") {
          const row = (
            await c.query(
              "SELECT o.*,b.control_epoch,b.session_id,b.status AS delivery_status FROM operations o JOIN browser_outbox b ON b.operation_id=o.id WHERE o.id=$1 AND o.task_id=$2",
              [i.payload.operationId, task.id],
            )
          ).rows[0];
          if (row?.status === "dispatched") {
            // Results settle their one operation even across takeover, but never wake a human-held task.
            await c.query(
              "UPDATE operations SET status=$2,result=$3 WHERE id=$1",
              [
                row.id,
                i.payload.uncertain || i.payload.result?.error
                  ? "failed"
                  : "completed",
                browserJson(i.payload.result),
              ],
            );
            messages.push({
              role: "tool",
              toolCallId: row.call_id,
              content: browserJson(i.payload.result),
            });
            const s = (
              await c.query<BrowserSession>(
                "SELECT * FROM browser_sessions WHERE id=$1",
                [row.session_id],
              )
            ).rows[0]!;
            next = i.payload.uncertain
              ? "uncertain"
              : s.control === "agent"
                ? "queued"
                : "waiting_browser";
            if (i.payload.result?.humanRequired) next = "waiting_browser";
            await event(c, task.id, {
              type: "tool",
              operationId: row.id,
              name: "browser",
              status:
                i.payload.uncertain || i.payload.result?.error
                  ? "failed"
                  : "completed",
              result: i.payload.result,
            });
          }
        } else if (i.kind === "handback" && task.state !== "uncertain") {
          messages.push({
            role: "user",
            content:
              "Browser handed back. All previous element refs are invalid. Observe again before acting. " +
              browserJson(i.payload),
          });
          if (task.runtime_kind === "rust")
            await c.query("SELECT kernel_input($1,$2,$3)", [
              "browser-handback:" + i.id,
              task.id,
              {
                kind: "user",
                text:
                  "Browser handed back. All previous element refs are invalid. Observe again before acting. " +
                  browserJson(i.payload),
              },
            ]);
          next = "queued";
        } else if (i.kind === "connection_error") {
          next = "waiting_browser";
        }
        if (task.state === "uncertain") next = "uncertain";
        await c.query(
          "UPDATE tasks SET checkpoint=$2,state=$3,wait_reason=CASE WHEN $3='waiting_browser' THEN 'human_control' ELSE NULL END,updated_at=now() WHERE id=$1",
          [task.id, browserJson({ ...task.checkpoint, messages }), next],
        );
        if (next !== task.state)
          await event(c, task.id, { type: "state", state: next });
      }
      await c.query("UPDATE task_inputs SET consumed_at=now() WHERE id=$1", [
        i.id,
      ]);
    }
    const waiting = await c.query<Task>(
      "SELECT * FROM tasks WHERE state='waiting_browser' AND wait_reason='profile_or_capacity' ORDER BY created_at FOR UPDATE",
    );
    for (const t of waiting.rows) {
      if (await reserveSession(c, t.browser_profile_id!, t.id)) {
        await c.query(
          "UPDATE tasks SET state='queued',wait_reason=NULL WHERE id=$1",
          [t.id],
        );
        await event(c, t.id, { type: "state", state: "queued" });
      }
    }
  });
}
export async function dispatchBrowser(db: Db, client: BrowserClient) {
  await consumeBrowserInputs(db);
  if (client.config.BROWSER_ENABLED !== "true") return;
  const rows = await db.query(
    "SELECT operation_id FROM browser_outbox WHERE status='pending' ORDER BY created_at LIMIT 2",
  );
  await Promise.allSettled(
    rows.rows.map(async (r) => {
      await client.request("/operations", { operationId: r.operation_id });
      await db.query(
        "UPDATE browser_outbox SET attempts=attempts+1 WHERE operation_id=$1",
        [r.operation_id],
      );
    }),
  );
}
export async function transitionBrowser(
  db: Db,
  client: BrowserClient,
  identity: Identity,
  id: string,
  action: "takeover" | "handback",
  expected: number,
  key: string,
  note = "",
) {
  const prepared = await tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(730110)");
    const s = await sessionAccess(c, id, identity);
    const prior = (
      await c.query(
        "SELECT * FROM browser_transitions WHERE session_id=$1 AND key=$2",
        [id, key],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.user_id !== identity.userId ||
        prior.action !== action ||
        prior.expected_epoch !== expected ||
        prior.note !== note
      )
        throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
      if (prior.result) return { done: prior.result, s };
      if (s.control_epoch !== expected + 1 || s.control !== "transferring")
        throw new DomainError("CONTROL_CHANGED", 409);
      return { s };
    }
    if (
      s.state !== "open" ||
      s.control_epoch !== expected ||
      s.control === "transferring"
    )
      throw new DomainError("CONTROL_CHANGED", 409);
    if (action === "takeover" && !["agent", "paused"].includes(s.control))
      throw new DomainError("ALREADY_CONTROLLED", 409);
    if (
      action === "handback" &&
      (s.control !== "human" || s.controller_id !== identity.userId)
    )
      throw new DomainError("NOT_CONTROLLER", 403);
    s.control = "transferring";
    s.control_epoch++;
    s.controller_id = identity.userId;
    await c.query(
      "UPDATE browser_sessions SET control=$2,control_epoch=$3,controller_id=$4 WHERE id=$1",
      [id, s.control, s.control_epoch, identity.userId],
    );
    await c.query("DELETE FROM browser_tickets WHERE session_id=$1", [id]);
    if (s.task_id) {
      await c.query("SELECT 1 FROM tasks WHERE id=$1 FOR UPDATE", [s.task_id]);
      const t = await getTask(c, s.task_id);
      if (!terminal.has(t.state) && t.state !== "uncertain") {
        await c.query(
          "UPDATE tasks SET state='waiting_browser',wait_reason='human_control',lease_owner=NULL,lease_until=NULL WHERE id=$1",
          [s.task_id],
        );
        await event(c, s.task_id, { type: "state", state: "waiting_browser" });
      }
    }
    await c.query(
      "INSERT INTO browser_transitions(session_id,key,user_id,action,expected_epoch,note) VALUES($1,$2,$3,$4,$5,$6)",
      [id, key, identity.userId, action, expected, note],
    );
    await browserEvent(c, s);
    return { s };
  });
  if (prepared.done) return prepared.done;
  // Settle after revocation commits, taking model-attempt then budget locks in
  // the same order as callModel. A live old worker can no longer commit decisions.
  if (prepared.s.task_id)
    await tx(db, async (c) => {
      const abandoned = await c.query<{ reserved: string }>(
        "UPDATE model_attempts SET status='failed',error_code='CONTROL_CHANGED',finished_at=now() WHERE task_id=$1 AND status='running' RETURNING reserved",
        [prepared.s.task_id],
      );
      const reserved = abandoned.rows.reduce(
        (sum, row) => sum + Number(row.reserved),
        0,
      );
      if (reserved)
        await c.query(
          "UPDATE tasks SET reserved_tokens=reserved_tokens-$2,tokens=tokens+$2 WHERE id=(SELECT root_id FROM tasks WHERE id=$1)",
          [prepared.s.task_id, reserved],
        );
    });
  // The service closes all writable sockets and drains/aborts the actual browser channel.
  // A failure leaves transferring fenced. Retrying the same key safely completes it.
  const observed = await client.request("/quiesce", {
    sessionId: id,
    epoch: prepared.s.control_epoch,
    observe: action === "handback",
  });
  await consumeBrowserInputs(db);
  return tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(730110)");
    const s = await sessionAccess(c, id, identity);
    const prior = (
      await c.query(
        "SELECT result FROM browser_transitions WHERE session_id=$1 AND key=$2",
        [id, key],
      )
    ).rows[0];
    if (prior?.result) return prior.result;
    if (s.control_epoch !== expected + 1 || s.control !== "transferring")
      throw new DomainError("CONTROL_CHANGED", 409);
    s.control = action === "takeover" ? "human" : "agent";
    s.controller_id = action === "takeover" ? identity.userId : null;
    await c.query(
      "UPDATE browser_sessions SET control=$2,controller_id=$3,last_active_at=now(),tabs=COALESCE($4,tabs) WHERE id=$1",
      [
        id,
        s.control,
        s.controller_id,
        observed.tabs ? browserJson(observed.tabs) : null,
      ],
    );
    if (s.task_id && action === "handback") {
      // Retire any pre-handoff prepared intentions before the next model decision.
      const t = await getTask(c, s.task_id);
      const stale = await c.query<Operation>(
        "UPDATE operations SET status='obsolete',result='{\"error\":\"CONTROL_CHANGED\"}' WHERE task_id=$1 AND (status='prepared' OR (status='running' AND replay='safe')) RETURNING *",
        [s.task_id],
      );
      const unknown = await c.query(
        "SELECT 1 FROM operations WHERE task_id=$1 AND status='running' AND replay='uncertain'",
        [t.id],
      );
      if (unknown.rowCount && !terminal.has(t.state)) {
        await c.query(
          "UPDATE tasks SET state='uncertain',error_code='OPERATION_UNCERTAIN',lease_owner=NULL,lease_until=NULL WHERE id=$1",
          [t.id],
        );
        await event(c, t.id, { type: "state", state: "uncertain" });
      }
      const messages = [...(t.checkpoint.messages ?? [])];
      for (const op of stale.rows) {
        messages.push({
          role: "tool",
          toolCallId: op.call_id,
          content: '{"error":"CONTROL_CHANGED"}',
        });
        await event(c, t.id, {
          type: "tool",
          operationId: op.id,
          name: op.name,
          status: "obsolete",
        });
      }
      await c.query("UPDATE tasks SET checkpoint=$2 WHERE id=$1", [
        t.id,
        browserJson({ ...t.checkpoint, messages }),
      ]);
      await c.query(
        "INSERT INTO task_inputs(id,task_id,kind,payload) VALUES($1,$2,'handback',$3) ON CONFLICT DO NOTHING",
        [
          `handback:${id}:${s.control_epoch}`,
          s.task_id,
          browserJson({ note, ...observed }),
        ],
      );
    }
    await browserEvent(c, s);
    await c.query(
      "UPDATE browser_transitions SET result=$3 WHERE session_id=$1 AND key=$2",
      [id, key, browserJson(s)],
    );
    return s;
  });
}
export async function issueBrowserTicket(
  db: Db,
  identity: Identity,
  appSession: string,
  id: string,
  permission: "observe" | "write",
) {
  return tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(730110)");
    const s = await sessionAccess(c, id, identity);
    if (s.state !== "open" || s.control === "transferring")
      throw new DomainError("BROWSER_NOT_READY", 409);
    if (
      permission === "write" &&
      (s.control !== "human" || s.controller_id !== identity.userId)
    )
      throw new DomainError("NOT_CONTROLLER", 403);
    const ticket = token();
    await c.query(
      "INSERT INTO browser_tickets(token_hash,session_id,user_id,app_session_hash,workspace_id,permission,control_epoch,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '30 seconds')",
      [
        hash(ticket),
        id,
        identity.userId,
        hash(appSession),
        identity.workspaceId,
        permission,
        s.control_epoch,
      ],
    );
    return { ticket, expiresIn: 30, permission, controlEpoch: s.control_epoch };
  });
}
// Checked for every incoming WebSocket frame and periodically for idle sockets.
export async function validateBrowserTicket(
  db: Queryable,
  ticketHash: string,
  redeem = false,
) {
  const r = await db.query(
    `SELECT t.*,b.control,b.controller_id FROM browser_tickets t JOIN browser_sessions b ON b.id=t.session_id JOIN sessions a ON a.token_hash=t.app_session_hash WHERE t.token_hash=$1 AND a.user_id=t.user_id AND a.expires_at>now() AND (a.active_workspace_id IS NULL OR a.active_workspace_id=t.workspace_id) AND b.state='open' AND b.control_epoch=t.control_epoch AND b.control<>'transferring'`,
    [ticketHash],
  );
  const t = r.rows[0];
  if (!t) throw new DomainError("INVALID_TICKET", 403);
  if (
    t.permission === "write" &&
    (t.control !== "human" || t.controller_id !== t.user_id)
  )
    throw new DomainError("NOT_CONTROLLER", 403);
  const s = (
    await db.query<BrowserSession>(
      "SELECT * FROM browser_sessions WHERE id=$1",
      [t.session_id],
    )
  ).rows[0]!;
  await browserAccess(db, s.profile_id, t.workspace_id, t.user_id);
  if (redeem) {
    const used = await db.query(
      "UPDATE browser_tickets SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING token_hash",
      [ticketHash],
    );
    if (!used.rowCount) throw new DomainError("EXPIRED_TICKET", 403);
  } else if (!t.used_at) throw new DomainError("INVALID_TICKET", 403);
  return t;
}

export function browserJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "string"
      ? item.toWellFormed().replaceAll("\0", "\uFFFD")
      : item,
  );
}
