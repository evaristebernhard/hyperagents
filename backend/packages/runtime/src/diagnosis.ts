import { Limits, terminal, type TaskOverview } from "@hyper/contracts";
import { getTask, type Queryable, type Task } from "./db.js";

export async function budgetUsage(
  c: Queryable,
  task: Task,
): Promise<TaskOverview["budget"]> {
  const root = await getTask(c, task.root_id);
  const time = await c.query(
    "SELECT COALESCE(sum(active_ms + CASE WHEN state='running' AND active_since IS NOT NULL THEN GREATEST(0,extract(epoch FROM (LEAST(now(),lease_until)-active_since))*1000)::bigint ELSE 0 END),0) AS ms FROM tasks WHERE root_id=$1",
    [root.id],
  );
  return {
    activeMs: Number(time.rows[0].ms),
    modelCalls: root.model_calls,
    toolCalls: root.tool_calls,
    tokens: Number(root.tokens),
    reservedTokens: Number(root.reserved_tokens),
    transferBytes: Number(root.transfer_bytes),
    artifactBytes: Number(root.artifact_bytes),
    limits: {
      activeMs: Limits.taskMs,
      modelCalls: Limits.modelCalls,
      toolCalls: Limits.toolCalls,
      tokens: Limits.tokens,
    },
  };
}
export async function canRetry(c: Queryable, task: Task) {
  if (
    task.state !== "failed" ||
    /BUDGET|VALIDATION/.test(task.error_code ?? "")
  )
    return false;
  const b = await budgetUsage(c, task);
  if (
    b.activeMs >= Limits.taskMs ||
    b.modelCalls >= Limits.modelCalls ||
    b.toolCalls >= Limits.toolCalls ||
    b.tokens + b.reservedTokens >= Limits.tokens ||
    b.transferBytes >= 64 * 1024 * 1024 ||
    b.artifactBytes >= Limits.artifactBytes
  )
    return false;
  return !(
    await c.query(
      "SELECT 1 FROM operations o JOIN tasks t ON t.id=o.task_id WHERE t.root_id=$1 AND o.replay='uncertain' AND o.status='running' UNION ALL SELECT 1 FROM tasks WHERE root_id=$1 AND state='uncertain' LIMIT 1",
      [task.root_id],
    )
  ).rowCount;
}
export async function availableActions(
  c: Queryable,
  task: Task,
  root: Task,
): Promise<TaskOverview["availableActions"]> {
  if (task.state === "uncertain" || root.state === "uncertain")
    return ["cancel", "new_task"];
  if (terminal.has(task.state))
    return (await canRetry(c, task)) ? ["retry", "new_task"] : ["new_task"];
  return [
    root.control_state === "normal" ? "pause" : "resume",
    "provide_input",
    "cancel",
  ];
}
export function diagnose(
  task: Task,
  last: TaskOverview["currentOperations"][number] | null,
  checks: TaskOverview["validation"],
): TaskOverview["diagnosis"] {
  if (task.state === "succeeded" || task.state === "cancelled") return null;
  const code =
    task.state === "uncertain"
      ? "OPERATION_UNCERTAIN"
      : task.error_code || (last?.status === "failed" ? last.errorCode : null);
  if (!code) return null;
  const category = /UNCERTAIN|PROCESS_LOST/.test(code)
    ? "uncertain"
    : /BUDGET/.test(code)
      ? "budget"
      : /NOT_CONFIGURED|SANDBOX_UNAVAILABLE|BROWSER_UNAVAILABLE|TOOL_DISABLED|TOOL_UNAVAILABLE|MISSING_DEPENDENCY/.test(
            code,
          )
        ? "capability"
        : /VALIDATION|DELIVERY_CHECK/.test(code)
          ? "validation"
          : /^MODEL_|^BRIDGE_/.test(code)
            ? "model"
            : last?.kind === "tool"
              ? "tool"
              : "runtime";
  const messages = {
    uncertain:
      "The last operation may have taken effect. Inspect the saved results before starting a follow-up task; automatic replay is disabled.",
    budget:
      "This task tree has exhausted an execution budget. Saved files remain available; retry cannot reset the budget.",
    capability:
      "A required capability is unavailable or disabled. Resolve the reported capability before continuing.",
    validation:
      "The saved deliverables did not satisfy the acceptance checks. See the recorded issues and saved file versions.",
    model:
      "The model request failed. The checkpoint and saved files have been retained.",
    tool: "A tool operation failed. Its result is available in the activity details.",
    runtime:
      "Execution stopped with the recorded error. The checkpoint and saved files have been retained.",
  };
  return {
    category,
    stage:
      category === "validation"
        ? "delivery_review"
        : (last?.name ?? "scheduling"),
    code,
    message: messages[category],
    lastOperation: last,
    issues: checks.filter((v) => v.status === "failed").at(-1)?.issues ?? [],
  };
}
