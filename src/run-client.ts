import { api, ApiError } from "./backend-client";
import type { ChatEvent } from "./llm-client";

export type RunStatus = "queued" | "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type ShellApproval = {
  id: string;
  status: "pending" | "approved" | "denied" | "executing" | "completed" | "failed" | "cancelled" | "expired";
  command: string;
  cwd: string;
  timeoutSeconds: number;
};
export type RunInfo = {
  id: string;
  workspaceId: string;
  threadId: string;
  userMessageId: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  model?: string;
  error?: string;
  toolCount: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  approvals: ShellApproval[];
  resultSaved?: boolean;
  plan?: { id: string; title: string; status: "pending" | "in_progress" | "completed" }[];
};
export type RuntimeEvent = ChatEvent
  | { type: "shell_approval"; actionId: string; command: string; cwd: string; timeoutSeconds: number }
  | { type: "run_status"; status: RunStatus }
  | { type: "plan"; steps: NonNullable<RunInfo["plan"]> }
  | { type: "shell_result"; actionId: string; result: unknown };
export type RunScope = { workspaceId: string; threadId: string };
export type RunEvents = { run: RunInfo; events: { seq: number; event: RuntimeEvent }[]; nextCursor: number; hasMore: boolean };
export type RunConnection = { status: "connected" | "reconnecting"; failures: number; retryInMs: number; message?: string };
export const isActiveRun = (run: Pick<RunInfo, "status">) => ["queued", "running", "waiting_approval"].includes(run.status);
const scopeQuery = (scope: RunScope) => new URLSearchParams(scope).toString();
const abortError = () => new DOMException("Stopped viewing this run", "AbortError");

/** api() owns authentication/CSRF. Aborting this wrapper detaches the viewer only;
 * an already dispatched request may finish, but cannot restart or cancel execution. */
async function viewingRequest<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(abortError()); };
    const timer = setTimeout(() => { cleanup(); reject(Error("The run service did not respond within 20 seconds.")); }, 20000);
    signal?.addEventListener("abort", abort, { once: true });
    request().then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export async function createRun(scope: RunScope & { userMessageId: string }, signal?: AbortSignal) {
  return (await viewingRequest(() => api<{ run: RunInfo }>("/api/runs", { method: "POST", body: scope }), signal)).run;
}
export async function listRuns(scope: RunScope, signal?: AbortSignal) {
  return (await viewingRequest(() => api<{ runs: RunInfo[] }>("/api/runs?" + scopeQuery(scope)), signal)).runs;
}
export async function cancelRun(id: string, scope: RunScope) {
  return (await api<{ run: RunInfo }>("/api/runs/" + encodeURIComponent(id) + "/cancel", { method: "POST", body: scope })).run;
}
export async function decideShellApproval(id: string, actionId: string, scope: RunScope, decision: "approve" | "deny") {
  return (await api<{ run: RunInfo }>("/api/runs/" + encodeURIComponent(id) + "/approvals/" + encodeURIComponent(actionId), { method: "POST", body: { ...scope, decision } })).run;
}

/** Replay/poll a durable event log; neither retries nor detaching creates execution.
 * Cursor advances only after delivery. Retry with the returned cursor in onCursor. */
export async function followRun(options: {
  id: string;
  scope: RunScope;
  signal: AbortSignal;
  after?: number;
  onEvent: (event: RuntimeEvent) => void;
  onRun: (run: RunInfo) => void;
  onCursor: (cursor: number) => void;
  onConnection: (connection: RunConnection) => void;
}): Promise<RunInfo> {
  const { id, scope, signal } = options;
  let cursor = options.after || 0, failures = 0;
  while (!signal.aborted) {
    let page: RunEvents;
    try {
      page = await viewingRequest(() => api<RunEvents>("/api/runs/" + encodeURIComponent(id) + "/events?" + scopeQuery(scope) + "&after=" + cursor), signal);
      if (signal.aborted) throw abortError();
      if (!page?.run || !Array.isArray(page.events) || !Number.isInteger(page.nextCursor) || page.nextCursor < cursor) throw Error("The run event log returned an invalid cursor.");
      if (page.hasMore && page.nextCursor === cursor) throw Error("The run event log did not advance its cursor.");
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) throw Error(error.message + " Viewing paused; the server run was not cancelled.");
      failures++;
      const message = error instanceof Error ? error.message : "Unable to reach the run service.";
      const retryInMs = Math.min(1000 * 2 ** (failures - 1), 8000);
      options.onConnection({ status: "reconnecting", failures, retryInMs, message });
      if (failures >= 5) throw Error("Viewing paused after five connection failures. The server run has not been cancelled. " + message);
      await pause(retryInMs, signal);
      continue;
    }
    failures = 0;
    options.onConnection({ status: "connected", failures: 0, retryInMs: 0 });
    for (const entry of page.events) {
      if (entry.seq <= cursor) continue;
      if (!Number.isInteger(entry.seq) || entry.seq > page.nextCursor) throw Error("The run event log returned an invalid event sequence.");
      options.onEvent(entry.event);
      cursor = entry.seq;
      options.onCursor(cursor);
    }
    cursor = page.nextCursor;
    options.onCursor(cursor);
    // Metadata is authoritative over replayed historical run_status/approval events.
    options.onRun(page.run);
    if (!page.hasMore && !isActiveRun(page.run)) return page.run;
    if (!page.hasMore) await pause(1000, signal);
  }
  throw abortError();
}
