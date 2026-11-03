import type { MessageContext } from "./types";

export const backendV1 = import.meta.env.VITE_BACKEND_V1 === "true";
export type Identity = {
  userId: string;
  workspaceId: string;
  admin: boolean;
  email: string;
  role: string;
};
export type Capabilities = {
  models: { provider: string; model: string; configured: boolean }[];
  search: { provider: string; degraded: boolean };
  sandbox: { available: boolean; reason?: string };
  formats: string[];
  externalActions: boolean;
};
export type Conversation = {
  id: string;
  title: string;
  created_at: string;
  revision: number;
  metadata: {
    starred?: boolean;
    archived?: boolean;
    projectId?: string;
    roomId?: string;
    canvas?: import("./types").CanvasPreferences;
  };
  messages: {
    id: string;
    role: "user" | "assistant";
    content: string;
    created_at: string;
  }[];
  artifacts: { id: string; name: string }[];
};
export type Task = {
  id: string;
  conversationId: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  state: string;
  errorCode?: string;
  inputFileIds?: string[];
  context?: { id: string; kind: string; name: string; revision: number }[];
  result?: {
    summary: string;
    artifacts: {
      id: string;
      name: string;
      format: string;
      downloadUrl: string;
    }[];
  };
};
export type TaskEvent = {
  id: string;
  payload: {
    type: string;
    name?: string;
    status?: string;
    state?: string;
    code?: string;
    message?: string;
    question?: string;
    operationId?: string;
    input?: {
      query?: string;
      url?: string;
      language?: string;
      code?: string;
      name?: string;
    };
    result?: {
      question?: string;
      stdout?: string;
      stderr?: string;
      error?: string;
      details?: { stdout?: string; stderr?: string };
      outputErrors?: { path: string; error: string }[];
      url?: string;
      title?: string;
      results?: { url: string; title: string }[];
      warning?: string;
    };
    issues?: string[];
    passed?: boolean;
  };
  created_at: string;
  taskId?: string;
};
export type ArtifactDetail = {
  id: string;
  name: string;
  versions: { version: number; file_id: string; created_at: string }[];
};
export const terminal = (state: string) =>
  ["succeeded", "failed", "cancelled"].includes(state);
export const stateLabel: Record<string, string> = {
  queued: "Queued",
  running: "Working",
  waiting_children: "Delegating",
  waiting_user: "Needs your input",
  waiting_approval: "Awaiting review",
  uncertain: "Outcome uncertain",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
const csrfKey = "hyperagents:v1:csrf";
let epoch = 0;
let activeWorkspace = "";
export const sessionEpoch = () => epoch;
export function setActiveWorkspace(id: string) {
  activeWorkspace = id;
}
export class V1Error extends Error {
  constructor(
    public status: number,
    code: string,
  ) {
    super(code);
  }
}
export function invalidateSessionRequests() {
  epoch++;
  activeWorkspace = "";
}
export function clearSession() {
  invalidateSessionRequests();
  localStorage.removeItem(csrfKey);
}
export async function v1<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    key?: string;
    signal?: AbortSignal;
    quiet?: boolean;
    expectedEpoch?: number;
    workspace?: string;
  } = {},
): Promise<T> {
  const requestEpoch = options.expectedEpoch ?? epoch;
  if (requestEpoch !== epoch)
    throw new DOMException("Session changed", "AbortError");
  const method = options.method || "GET";
  const headers: Record<string, string> = {};
  const workspace = options.workspace ?? activeWorkspace;
  if (workspace && !path.startsWith("/auth/"))
    headers["x-workspace-id"] = workspace;
  if (method !== "GET") {
    headers["x-csrf-token"] = localStorage.getItem(csrfKey) || "";
    if (options.body !== undefined && !(options.body instanceof FormData))
      headers["content-type"] = "application/json";
  }
  if (options.key) headers["idempotency-key"] = options.key;
  const response = await fetch("/api/v1" + path, {
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    signal: options.signal,
    body:
      options.body === undefined
        ? undefined
        : options.body instanceof FormData
          ? options.body
          : JSON.stringify(options.body),
  });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !options.quiet && requestEpoch === epoch) {
      clearSession();
      window.dispatchEvent(new Event("backend-session-expired"));
    }
    throw new V1Error(response.status, body.error || "Request failed");
  }
  // Discard responses from a session that ended while this request was pending.
  if (requestEpoch !== epoch)
    throw new DOMException("Session changed", "AbortError");
  return body as T;
}
export async function session() {
  try {
    await v1<Identity>("/auth/session", { quiet: true });
    return {
      authenticated: !!localStorage.getItem(csrfKey),
      setupRequired: false,
    };
  } catch (e) {
    if (e instanceof V1Error && e.status === 401) {
      clearSession();
      return { authenticated: false, setupRequired: false };
    }
    throw e;
  }
}
export async function login(email: string, password: string) {
  const result = await v1<{ csrfToken: string }>("/auth/login", {
    method: "POST",
    body: { email, password },
    quiet: true,
  });
  localStorage.setItem(csrfKey, result.csrfToken);
  return { authenticated: true, setupRequired: false };
}
export async function logout() {
  await v1("/auth/logout", { method: "POST" });
  clearSession();
  window.dispatchEvent(new Event("backend-logout"));
}
export async function submitTask(
  prompt: string,
  context?: MessageContext,
  key: string = crypto.randomUUID(),
  conversationId?: string,
) {
  const formats =
    context?.settings.outputFormat?.split(",").filter(Boolean) || [];
  const { taskId } = await v1<{ taskId: string }>("/tasks", {
    method: "POST",
    key,
    body: {
      prompt,
      ...(conversationId ? { conversationId } : {}),
      inputFileIds: context?.attachments.map((f) => f.id) || [],
      acceptance: { formats, requiredText: [], requireSources: false },
      ...(context &&
      (context.settings.agentId ||
        context.projectId ||
        context.roomId ||
        context.skillIds.length ||
        context.memoryIds.length ||
        context.artifactIds.length ||
        context.rubricIds?.length)
        ? {
            context: {
              agentId: context.settings.agentId,
              projectId: context.projectId,
              roomId: context.roomId,
              skillIds: context.skillIds,
              memoryIds: context.memoryIds,
              artifactIds: context.artifactIds,
              rubricIds: context.rubricIds || [],
            },
          }
        : {}),
    },
  });
  const task = await v1<Task>("/tasks/" + taskId);
  window.dispatchEvent(new Event("v1-conversations-changed"));
  return task;
}
export const fileUrl = (id: string) =>
  "/api/v1/files/" + encodeURIComponent(id) + "/download";

// Completed assistant messages are persisted as the result envelope. Present
// the human-readable answer while files remain in the artifact panel.
export function assistantText(content: string): string {
  try {
    const result: unknown = JSON.parse(content);
    if (
      result &&
      typeof result === "object" &&
      "summary" in result &&
      typeof result.summary === "string"
    )
      return result.summary;
  } catch {}
  return content;
}

export function artifactKind(format: string): import("./types").ArtifactKind {
  return format === "png"
    ? "Image"
    : format === "html"
      ? "Webpage"
      : format === "csv"
        ? "Table"
        : ["md", "pdf", "txt"].includes(format)
          ? "Document"
          : "File";
}
