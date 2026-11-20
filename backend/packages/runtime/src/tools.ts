import { DomainError, ToolSchemas, type ToolName } from "@hyper/contracts";
import { allowedTools } from "./resources.js";
import { tx, fenced, type Db, type Task } from "./db.js";
import { Storage } from "./storage.js";
import { RunnerClient } from "./runner-client.js";
import { DeliveryService } from "./delivery.js";
import { updatePlan } from "./task-plan.js";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { researchHandlers } from "./tool-handlers/research.js";
import { knowledgeHandlers } from "./tool-handlers/knowledge.js";
import { filesHandlers } from "./tool-handlers/files.js";
import { computeHandlers } from "./tool-handlers/compute.js";
import { coordinationHandlers } from "./tool-handlers/coordination.js";
import { browserHandlers } from "./tool-handlers/browser.js";
import { normalizeCodeArguments } from "./tool-handlers/compute.js";
export { normalizeCodeArguments } from "./tool-handlers/compute.js";
export interface Operation {
  id: string;
  task_id: string;
  step: number;
  call_id: string;
  name: string;
  args: unknown;
  status:
    "prepared" | "running" | "dispatched" | "completed" | "failed" | "obsolete";
  replay: "safe" | "uncertain";
  result: unknown;
}
export interface ToolResult {
  data: unknown;
  deferred?: boolean;
  pause?: "waiting_children" | "waiting_user" | "waiting_approval";
  finish?: { summary: string; artifactIds: string[] };
}
export type ToolHandler = (
  this: ToolExecutor,
  task: Task,
  op: Operation,
  signal: AbortSignal,
) => Promise<ToolResult>;
export class ToolExecutor {
  readonly storage: Storage;
  readonly runner: RunnerClient;
  constructor(
    readonly db: Db,
    readonly config: Config,
  ) {
    this.storage = new Storage(config.DATA_DIR, db);
    this.runner = new RunnerClient(config);
  }
  readonly handlers = {
    ...researchHandlers,
    ...knowledgeHandlers,
    ...filesHandlers,
    ...computeHandlers,
    ...coordinationHandlers,
    ...browserHandlers,
    update_plan: async function (task, op) {
      return { data: await updatePlan(this.db, task, op.id, op.args) };
    },
  } satisfies Record<ToolName, ToolHandler>;
  async check(task: Task, artifactIds: string[], summary: string) {
    return new DeliveryService(this.db, this.storage).check(
      task,
      artifactIds,
      summary,
    );
  }
  async execute(
    task: Task,
    op: Operation,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const owner = task.lease_owner!;
    signal.throwIfAborted();
    if (!Object.hasOwn(ToolSchemas, op.name))
      throw new DomainError("UNKNOWN_TOOL");
    if (!allowedTools(task.context || {}).includes(op.name as ToolName))
      throw new DomainError("TOOL_DISABLED_FOR_AGENT", 403);
    // Every domain shares argument validation, authorization and lease fencing.
    // Dispatch admission is committed by Engine before invoking a handler.
    await tx(this.db, (c) => fenced(c, task.id, owner));
    const handler = this.handlers[op.name as ToolName];
    const raw = ["code_execute"].includes(op.name)
      ? normalizeCodeArguments(op.args)
      : op.args;
    op = { ...op, args: ToolSchemas[op.name as ToolName].parse(raw) };
    return handler.call(this, task, op, signal);
  }
  async source(
    task: Task,
    source: { url: string; title: string; excerpt: string; read: boolean },
  ) {
    const id = randomUUID();
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO sources(id,workspace_id,task_id,url,title,excerpt,read) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(task_id,url) DO UPDATE SET title=EXCLUDED.title,excerpt=CASE WHEN EXCLUDED.read THEN EXCLUDED.excerpt ELSE sources.excerpt END,read=sources.read OR EXCLUDED.read RETURNING id`,
      [
        id,
        task.workspace_id,
        task.id,
        source.url,
        source.title,
        source.excerpt,
        source.read,
      ],
    );
    return {
      ...source,
      excerpt: source.excerpt.slice(0, 6000),
      sourceId: r.rows[0]!.id,
      totalChars: source.excerpt.length,
      nextOffset: source.excerpt.length > 6000 ? 6000 : null,
    };
  }
}
