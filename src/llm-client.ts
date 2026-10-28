import type { Artifact } from "./local-model";
import type { IntegrationApproval, ToolRun } from "./types";
import { ApiError, authenticatedStream } from "./backend-client";

export type LlmConfig = { configured: boolean; models: string[] };
export type ArtifactPatch = { artifact: Artifact; base?: { content: string; title: string; updatedAt: string } };
export type ChatEvent = { type: "approval"; approval: IntegrationApproval } | ({ type: "tool" } & ToolRun) | { type: "artifact"; patch: ArtifactPatch } | { type: "delta" | "reasoning"; text: string } | { type: "done"; model: string } | { type: "error"; message: string };
export const currentModels = ["deepseek-flash", "deepseek-v4-pro"];
export const pendingKey = (workspaceId: string, threadId: string) => "llm-pending:" + workspaceId + ":" + threadId;

/** Decode data frames incrementally; never render model HTML directly in the conversation. */
export async function consumeChat(response: Response, onEvent: (event: ChatEvent) => void, signal?: AbortSignal) {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("The model endpoint did not return a stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", data: string[] = [], complete = false, bytes = 0;
  const dispatch = () => {
    if (!data.length) return;
    const raw = data.join("\n"); data = [];
    const event = JSON.parse(raw) as ChatEvent;
    if (event.type === "error") throw new Error(typeof event.message === "string" ? event.message : "Generation failed.");
    if ((event.type === "delta" || event.type === "reasoning") && typeof event.text === "string") onEvent(event);
    else if (event.type === "tool" && typeof event.id === "string" && typeof event.summary === "string") onEvent(event);
    else if (event.type === "approval" && typeof event.approval?.token === "string") onEvent(event);
    else if (event.type === "artifact" && event.patch?.artifact && typeof event.patch.artifact.id === "string") onEvent(event);
    else if (event.type === "done" && typeof event.model === "string") { complete = true; onEvent(event); }
    else throw new Error("Invalid model stream event.");
  };
  const line = (value: string) => {
    if (!value) dispatch();
    else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
  };
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
      const chunk = await reader.read();
      if (chunk.value) { bytes += chunk.value.byteLength; if (bytes > 2 * 1024 * 1024) throw new Error("Model stream exceeded the size limit."); buffer += decoder.decode(chunk.value, { stream: true }); }
      if (chunk.done) buffer += decoder.decode();
      let match: RegExpExecArray | null;
      while ((match = /[\r\n]/.exec(buffer))) {
        const at = match.index;
        if (buffer[at] === "\r" && at === buffer.length - 1 && !chunk.done) break;
        const size = buffer[at] === "\r" && buffer[at + 1] === "\n" ? 2 : 1;
        line(buffer.slice(0, at)); buffer = buffer.slice(at + size);
      }
      if (buffer.length > 256 * 1024) throw new Error("Model stream frame exceeded the size limit.");
      if (chunk.done) { if (buffer) line(buffer); dispatch(); break; }
    }
    if (!complete) throw new Error("The connection ended before the answer completed. Any partial answer is marked below.");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function streamChat(request: { workspaceId: string; threadId: string; userMessageId: string; model?: string }, signal: AbortSignal, onEvent: (event: ChatEvent) => void) {
  const response = await authenticatedStream("/api/llm/chat", request, signal);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (response.status === 401) window.dispatchEvent(new Event("backend-session-expired"));
    throw new ApiError(typeof body?.error === "string" ? body.error : "Model request failed (" + response.status + ").", response.status, body?.code);
  }
  await consumeChat(response, onEvent, signal);
}

export function artifactFromAnswer(text: string, kind: "Document" | "Webpage") {
  if (kind === "Document") return text;
  const block = /```(?:html)?\s*\n([\s\S]*?)```/i.exec(text);
  const html = block?.[1]?.trim() || text.trim();
  if (!/^<(?:!doctype\s+html|html|main|section|article|div)\b/i.test(html)) throw new Error("This answer does not contain an HTML webpage. Ask the assistant to produce a complete HTML page first.");
  return html;
}
