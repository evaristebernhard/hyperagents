import { api } from "./backend-client";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_children"
  | "waiting_input"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked";
export type PromptRole = "router" | "worker";
export type TaskApproval = {
  id: string;
  tool: string;
  args: unknown;
  status: string;
};
export type Task = {
  id: string;
  workspaceId: string;
  parentTaskId?: string;
  rootTaskId: string;
  role: PromptRole;
  title: string;
  goal: string;
  status: TaskStatus;
  model: string;
  pluginIds: string[];
  agentId?: string;
  output: string;
  question?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  stepCount: number;
  toolCount: number;
  approvals: TaskApproval[];
  promptVersion: string;
};
export type TaskInput = {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  consumed: boolean;
};
export type TaskEvent = {
  seq: number;
  type: string;
  createdAt: string;
  text?: string;
  [key: string]: unknown;
};
export type TaskDetail = {
  task: Task;
  children: Task[];
  inputs: TaskInput[];
  events: TaskEvent[];
};
export type RuntimePlugin = {
  id: string;
  name: string;
  description: string;
  available: boolean;
  defaultEnabled: boolean;
  tools: string[];
};
export type AgentPrompt = {
  role: PromptRole;
  content: string;
  defaultContent: string;
  revision: number;
  version: string;
  description: string;
};
export type AgentRuntime = {
  configured: boolean;
  models: string[];
  plugins: RuntimePlugin[];
  prompts: AgentPrompt[];
  limits: { concurrency: number; maxSteps: number; maxChildren: number };
};
export type CreateTask = {
  workspaceId: string;
  text: string;
  requestId: string;
  pluginIds: string[];
  model?: string;
  agentId?: string;
};

const query = (workspaceId: string) =>
  "?" + new URLSearchParams({ workspaceId });
const route = (id: string) => "/api/tasks/" + encodeURIComponent(id);
const detached = () =>
  new DOMException("Stopped viewing this task", "AbortError");

// Detaching stops this subscriber, never the server task. A timed-out mutation
// keeps its requestId in the caller so retrying it cannot create duplicate work.
function request<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(detached());
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(detached());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        Error(
          "The task service did not respond. Your request may still be processing; retry to check it.",
        ),
      );
    }, 20000);
    signal?.addEventListener("abort", abort, { once: true });
    operation().then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export const listTasks = (workspaceId: string, signal?: AbortSignal) =>
  request(
    () => api<{ tasks: Task[] }>("/api/tasks" + query(workspaceId)),
    signal,
  );
export const readTask = (
  workspaceId: string,
  id: string,
  signal?: AbortSignal,
) => request(() => api<TaskDetail>(route(id) + query(workspaceId)), signal);
export const readAgentRuntime = (workspaceId: string, signal?: AbortSignal) =>
  request(
    () => api<AgentRuntime>("/api/agent-runtime" + query(workspaceId)),
    signal,
  );
export const createTask = (body: CreateTask) =>
  request(() => api<{ task: Task }>("/api/tasks", { method: "POST", body }));
export const addTaskInput = (
  workspaceId: string,
  id: string,
  text: string,
  requestId: string,
) =>
  request(() =>
    api<{ task: Task; input: TaskInput }>(route(id) + "/inputs", {
      method: "POST",
      body: { workspaceId, text, requestId },
    }),
  );
export const changeTask = (
  workspaceId: string,
  id: string,
  action: "cancel" | "retry",
) =>
  request(() =>
    api<{ task: Task }>(route(id) + "/" + action, {
      method: "POST",
      body: { workspaceId },
    }),
  );
export const decideTaskApproval = (
  workspaceId: string,
  id: string,
  effectId: string,
  decision: "approve" | "deny",
) =>
  request(() =>
    api<{ task: Task }>(
      route(id) + "/approvals/" + encodeURIComponent(effectId),
      { method: "POST", body: { workspaceId, decision } },
    ),
  );
export const saveAgentPrompt = (
  workspaceId: string,
  role: PromptRole,
  content: string | null,
  revision: number,
) =>
  request(() =>
    api<{ prompt: AgentPrompt }>("/api/agent-prompts/" + role, {
      method: "PUT",
      body: { workspaceId, content, revision },
    }),
  );

export const taskLabels: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Working",
  waiting_children: "Waiting for subtasks",
  waiting_input: "Needs your answer",
  waiting_approval: "Needs approval",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  blocked: "Blocked",
};
export const taskNeedsAttention = (task: Task) =>
  ["waiting_input", "waiting_approval", "blocked", "failed"].includes(
    task.status,
  );
export const taskCanCancel = (task: Task) =>
  [
    "queued",
    "running",
    "waiting_children",
    "waiting_input",
    "waiting_approval",
    "blocked",
  ].includes(task.status);
export const taskCanRetry = (task: Task) =>
  ["failed", "blocked"].includes(task.status);

export function taskTreeRows(tasks: Task[]): { task: Task; depth: number }[] {
  const known = new Set(tasks.map((task) => task.id));
  const children = new Map<string, Task[]>();
  const roots: Task[] = [];
  for (const task of tasks) {
    if (task.parentTaskId && known.has(task.parentTaskId))
      children.set(task.parentTaskId, [
        ...(children.get(task.parentTaskId) || []),
        task,
      ]);
    else roots.push(task);
  }
  const rows: { task: Task; depth: number }[] = [],
    visited = new Set<string>();
  const visit = (task: Task, depth: number) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    rows.push({ task, depth });
    for (const child of children.get(task.id) || [])
      visit(child, Math.min(depth + 1, 6));
  };
  roots.forEach((task) => visit(task, 0));
  tasks.forEach((task) => visit(task, 0));
  return rows;
}
