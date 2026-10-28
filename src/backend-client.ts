import type { WorkspaceState } from "./local-model";
import type { FileMeta } from "./types";
let csrf = "";
export type SessionInfo = { authenticated: boolean; setupRequired: boolean; csrfToken?: string };
export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); this.name = "ApiError"; }
}
async function result<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("backend-session-expired"));
    throw new ApiError(typeof body?.error === "string" ? body.error : `Request failed (${response.status})`, response.status, body?.code);
  }
  return body as T;
}
export async function getSession(): Promise<SessionInfo> {
  const info = await result<SessionInfo>(await fetch("/api/session", { credentials: "same-origin", cache: "no-store" }));
  csrf = info.csrfToken || "";
  return info;
}
export async function api<T>(path: string, options: { method?: string; body?: unknown; revision?: number } = {}): Promise<T> {
  const method = options.method || "GET";
  const headers: Record<string, string> = {};
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  if (options.revision !== undefined) headers["If-Match"] = String(options.revision);
  const response = await fetch(path, { method, headers, credentials: "same-origin", cache: "no-store", body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const body = await result<T>(response);
  if (path === "/api/login" || path === "/api/setup") csrf = (body as SessionInfo).csrfToken || "";
  if (path === "/api/logout") csrf = "";
  return body;
}
export const getState = () => api<{ state: WorkspaceState; revision: number }>("/api/state");
export const saveState = (state: WorkspaceState, revision: number) => api<{ revision: number }>("/api/state", { method: "PUT", body: { state }, revision });
export const previewMigration = (state: WorkspaceState) => api<{ warnings: string[]; workspaceCount: number }>("/api/migrate/preview", { method: "POST", body: { state } });
export const migrateState = (state: WorkspaceState, revision: number) => api<{ state: WorkspaceState; revision: number }>("/api/migrate", { method: "POST", body: { state, revision }, revision });
export async function uploadFile(file: File, workspaceId: string): Promise<FileMeta> {
  const headers: Record<string, string> = { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) };
  if (csrf) headers["X-CSRF-Token"] = csrf;
  const { file: metadata } = await result<{ file: FileMeta }>(await fetch("/api/files?workspaceId=" + encodeURIComponent(workspaceId), { method: "POST", headers, body: file, credentials: "same-origin" }));
  return metadata;
}
export const fileDownloadUrl = (file: Pick<FileMeta, "id" | "workspaceId">) => "/api/files/" + encodeURIComponent(file.id) + "?workspaceId=" + encodeURIComponent(file.workspaceId);
export const fixtureMode = () => import.meta.env.VITE_STORAGE_MODE === "fixture";
