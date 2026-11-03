import type { Page, Route } from "@playwright/test";
import type { ChatEvent } from "../src/llm-client";
import type { WorkspaceState } from "../src/local-model";
import type { RunInfo, RunStatus, RuntimeEvent } from "../src/run-client";
import type { DemoMessage, ToolRun } from "../src/types";

export type ManagedRunRequest = { workspaceId: string; threadId: string; userMessageId: string };
export type ManagedRunScenario = {
  events: ChatEvent[];
  status?: Extract<RunStatus, "succeeded" | "failed" | "cancelled" | "interrupted">;
  error?: string;
  /** Admission and live events happen first. This gate delays final persistence. */
  waitUntil?: Promise<void>;
  admissionError?: { status: number; error: string };
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // A fixture failure is observable through metadata and waitForCompletion; it
  // must not become an unhandled rejection when a test navigates away.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
type StoredRun = {
  info: RunInfo;
  origin: string;
  sourceText: string;
  scenario: ManagedRunScenario;
  events: { seq: number; event: RuntimeEvent }[];
  cancelled: boolean;
  cancel: ReturnType<typeof deferred<void>>;
  completion: ReturnType<typeof deferred<RunInfo>>;
};
const terminal = (status: RunStatus) => ["succeeded", "failed", "cancelled", "interrupted"].includes(status);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const snapshot = (run: StoredRun) => structuredClone(run.info);

/** Managed-run protocol fixture for browser rendering/lifecycle tests.
 *
 * Only /api/runs is simulated. The test process retains its append-only event
 * log across page navigation/reload; this is not a run-database durability test.
 * Owner login, CSRF, workspace validation, revisions and final answer/artifact
 * persistence use the real HTTP API and SQLite. The Node backend suite tests
 * real admission, permissions, scheduling and crash recovery separately.
 * /api/llm/config remains under each spec's control (including diagnostics).
 */
export async function installManagedRuns(
  page: Page,
  handler: (request: ManagedRunRequest, index: number) => ManagedRunScenario | Promise<ManagedRunScenario>,
) {
  const requests: ManagedRunRequest[] = [];
  const runs = new Map<string, StoredRun>();
  const admitted = new Map<string, StoredRun>();
  const completions: ReturnType<typeof deferred<RunInfo>>[] = [];
  const key = (request: ManagedRunRequest) => JSON.stringify([request.workspaceId, request.threadId, request.userMessageId]);
  const append = (run: StoredRun, event: RuntimeEvent) => run.events.push({ seq: run.events.length + 1, event: structuredClone(event) });
  const reply = (route: Route, status: number, json: unknown) => route.fulfill({ status, json });

  async function state(origin: string): Promise<{ state: WorkspaceState; revision: number }> {
    const response = await page.request.get(origin + "/api/state");
    if (!response.ok()) throw Error(`Managed-run fixture could not read real workspace: ${response.status()} ${await response.text()}`);
    return response.json();
  }
  async function persist(run: StoredRun, status: NonNullable<ManagedRunScenario["status"]>, error?: string) {
    const session = await page.request.get(run.origin + "/api/session");
    const { csrfToken } = await session.json();
    if (!session.ok() || !csrfToken) throw Error("Managed-run fixture requires a real authenticated owner session.");
    const events = run.scenario.events;
    const patches = status === "succeeded" ? events.flatMap(event => event.type === "artifact" ? [event.patch] : []) : [];
    const approvals = status === "succeeded" ? events.flatMap(event => event.type === "approval" ? [event.approval] : []) : [];
    const tools = new Map<string, ToolRun>();
    for (const event of events) if (event.type === "tool") tools.set(event.id, { id: event.id, name: event.name, summary: event.summary, status: event.status === "running" ? "error" : event.status });
    let text = events.flatMap(event => event.type === "delta" ? [event.text] : []).join("");
    if (!text.trim()) text = approvals.length ? "An integration action is ready for explicit review. No write has been performed."
      : patches.length ? `Created ${patches.length} artifact(s).` : error || "The run completed without answer text.";
    if (status !== "succeeded") text += "\n\n[" + (status === "cancelled" ? "Stopped — partial answer" : status === "interrupted" ? "Server stopped — partial answer" : "Interrupted — partial answer") + "]";

    // A real host commits synchronously after reading a fresh revision. HTTP
    // introduces an extra race with browser saves, so retry only revision 409s.
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await state(run.origin);
      const workspace = current.state.workspaces.find(item => item.id === run.info.workspaceId);
      const thread = workspace?.data.threads.find(item => item.id === run.info.threadId && !item.archived);
      const sourceIndex = thread?.messages?.findIndex(item => item.id === run.info.userMessageId) ?? -1;
      if (!workspace || !thread?.messages || sourceIndex < 0 || thread.messages[sourceIndex].text !== run.sourceText) throw Error("Managed-run source changed before persistence.");
      const answerId = "run-answer-" + run.info.id;
      if (thread.messages.some(item => item.id === answerId)) return;
      for (const patch of patches) {
        const artifact = structuredClone(patch.artifact);
        if (artifact.threadId !== thread.id || !["Document", "Webpage", "Slides", "Table"].includes(artifact.kind)) throw Error("Invalid managed-run artifact scope.");
        const index = workspace.data.artifacts.findIndex(item => item.id === artifact.id), old = workspace.data.artifacts[index];
        if (patch.base) {
          if (!old || old.archived || old.threadId !== thread.id || old.content !== patch.base.content || old.title !== patch.base.title || old.updatedAt !== patch.base.updatedAt) throw Error("Managed-run artifact conflict.");
          workspace.data.artifacts[index] = artifact;
        } else {
          if (index >= 0) throw Error("Managed-run artifact ID conflict.");
          workspace.data.artifacts.push(artifact);
        }
      }
      const source = thread.messages[sourceIndex], timestamp = new Date().toISOString();
      const format = (source.context?.settings?.outputFormat || thread.config?.outputFormat || "").toLowerCase();
      if (status === "succeeded" && !patches.length && ["doc", "document", "webpage"].includes(format)) {
        const kind = format === "webpage" ? "Webpage" : "Document";
        const content = kind === "Webpage" ? /```(?:html)?\s*\n([\s\S]*?)```/i.exec(text)?.[1]?.trim() || text.trim() : text;
        if (content && (kind !== "Webpage" || /^<(?:!doctype\s+html|html|main|section|article|div)\b/i.test(content))) {
          workspace.data.artifacts.push({ id: "artifact-" + crypto.randomUUID(), title: thread.title + " · " + kind, kind, content, threadId: thread.id,
            ...(thread.projectId ? { projectId: thread.projectId } : {}), versions: [], createdAt: timestamp, updatedAt: timestamp });
        }
      }
      const answer: DemoMessage = { id: answerId, role: "assistant", text, createdAt: timestamp };
      if (tools.size) answer.toolRuns = [...tools.values()].slice(-30);
      if (approvals.length) answer.actionRequests = structuredClone(approvals.slice(0, 12));
      if (status === "succeeded") {
        for (const event of events) {
          if (event.type === "suggestions") answer.followUps = [...event.followUps];
          if (event.type === "reasoning_timing") answer.reasoningMs = event.reasoningMs;
          if (event.type === "knowledge_hints") answer.knowledgeHints = structuredClone(event.knowledgeHints);
        }
        const files = events.flatMap(event => event.type === "generated_file" ? [event.file] : []).filter((file, index, all) => all.findIndex(item => item.id === file.id) === index).slice(0, 8);
        if (files.length) answer.context = { settings: source.context?.settings || thread.config || { model: "", reasoning: "Medium", provider: "Any", mode: "Execute", tools: [] }, skillIds: [], memoryIds: [], artifactIds: [], integrationIds: [], attachments: files };
      }
      thread.messages.splice(sourceIndex + 1, 0, answer);
      thread.updatedAt = timestamp;
      const saved = await page.request.put(run.origin + "/api/state", {
        headers: { Origin: run.origin, "X-CSRF-Token": csrfToken, "If-Match": String(current.revision) }, data: { state: current.state },
      });
      if (saved.status() === 409) continue;
      if (!saved.ok()) throw Error(`Managed-run fixture could not persist real workspace: ${saved.status()} ${await saved.text()}`);
      return;
    }
    throw Error("Managed-run fixture could not save after five workspace revision conflicts.");
  }

  async function execute(run: StoredRun) {
    try {
      run.info.status = "running";
      run.info.startedAt = new Date().toISOString();
      append(run, { type: "run_status", status: "running" });
      for (const event of run.scenario.events) {
        if (event.type !== "done") append(run, event);
        if (event.type === "tool" && event.status === "running") run.info.toolCount++;
      }
      if (run.scenario.waitUntil) await Promise.race([run.scenario.waitUntil, run.cancel.promise]);
      const done = run.scenario.events.findLast(event => event.type === "done");
      const providerError = run.scenario.events.findLast(event => event.type === "error");
      const status = run.cancelled ? "cancelled" : run.scenario.status || (done && !providerError && !run.scenario.error ? "succeeded" : "failed");
      const error = run.cancelled ? "Run cancelled by the user." : run.scenario.error || (providerError?.type === "error" ? providerError.message : undefined) || (status !== "succeeded" ? "Generation did not complete." : undefined);
      await persist(run, status, error);
      run.info = { ...run.info, status, finishedAt: new Date().toISOString(), resultSaved: true, ...(done?.type === "done" ? { model: done.model } : {}), ...(error ? { error } : {}) };
      if (done && status === "succeeded") append(run, done);
      append(run, { type: "run_status", status });
      run.completion.resolve(snapshot(run));
    } catch (error) {
      run.info = { ...run.info, status: "failed", finishedAt: new Date().toISOString(), resultSaved: false, error: message(error) };
      append(run, { type: "error", message: message(error) });
      append(run, { type: "run_status", status: "failed" });
      run.completion.reject(error);
    }
  }

  await page.route(/\/api\/runs(?:[/?].*)?$/, async route => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.pathname === "/api/runs" && method === "POST") {
      const request = route.request().postDataJSON() as ManagedRunRequest;
      if (!request || Object.keys(request).some(field => !["workspaceId", "threadId", "userMessageId"].includes(field)) || ![request.workspaceId, request.threadId, request.userMessageId].every(value => typeof value === "string" && value.length)) return reply(route, 400, { error: "Saved workspace, thread and user message IDs are required." });
      const index = requests.push(structuredClone(request)) - 1, completion = deferred<RunInfo>();
      completions.push(completion);
      const existing = admitted.get(key(request));
      if (existing) { completion.resolve(existing.completion.promise); return reply(route, 202, { run: snapshot(existing) }); }
      try {
        const scenario = await handler(structuredClone(request), index);
        if (scenario.admissionError) { completion.reject(Error(scenario.admissionError.error)); return reply(route, scenario.admissionError.status, { error: scenario.admissionError.error }); }
        const saved = await state(url.origin);
        const source = saved.state.workspaces.find(item => item.id === request.workspaceId)?.data.threads.find(item => item.id === request.threadId && !item.archived)?.messages?.find(item => item.id === request.userMessageId && item.role === "user");
        if (!source) { completion.reject(Error("Saved run source is unavailable.")); return reply(route, 404, { error: "Saved run source is unavailable." }); }
        const run: StoredRun = {
          info: { id: crypto.randomUUID(), ...request, status: "queued", createdAt: new Date().toISOString(), toolCount: 0, approvals: [], resultSaved: false },
          origin: url.origin, sourceText: source.text, scenario: { ...scenario, events: structuredClone(scenario.events) }, events: [], cancelled: false, cancel: deferred<void>(), completion,
        };
        runs.set(run.info.id, run); admitted.set(key(request), run);
        append(run, { type: "run_status", status: "queued" });
        await reply(route, 202, { run: snapshot(run) });
        // Once admitted, execution is independent of the browser's viewer.
        void execute(run);
      } catch (error) {
        completion.reject(error);
        await reply(route, 500, { error: message(error) });
        throw error;
      }
      return;
    }
    const requestScope = method === "POST" ? route.request().postDataJSON() : { workspaceId: url.searchParams.get("workspaceId"), threadId: url.searchParams.get("threadId") };
    if (!requestScope?.workspaceId || !requestScope?.threadId) return reply(route, 400, { error: "Workspace and thread are required." });
    const current = await state(url.origin);
    if (!current.state.workspaces.find(item => item.id === requestScope.workspaceId)?.data.threads.some(item => item.id === requestScope.threadId && !item.archived)) return reply(route, 404, { error: "Run thread is unavailable." });
    const inScope = (run: StoredRun) => run.info.workspaceId === requestScope.workspaceId && run.info.threadId === requestScope.threadId;
    if (url.pathname === "/api/runs" && method === "GET") return reply(route, 200, { runs: [...runs.values()].filter(inScope).reverse().slice(0, 20).map(snapshot) });
    const match = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(events|cancel))?$/.exec(url.pathname);
    const run = match ? runs.get(match[1]) : undefined;
    if (!run || !inScope(run)) return reply(route, 404, { error: "Run not found in this workspace/thread." });
    if (method === "GET" && !match?.[2]) return reply(route, 200, { run: snapshot(run) });
    if (method === "GET" && match?.[2] === "events") {
      const rawCursor = url.searchParams.get("after") ?? "0";
      if (!/^\d{1,10}$/.test(rawCursor)) return reply(route, 400, { error: "Invalid event cursor." });
      const after = Number(rawCursor), events = run.events.filter(entry => entry.seq > after).slice(0, 200);
      const nextCursor = events.at(-1)?.seq ?? after;
      return reply(route, 200, { run: snapshot(run), events: structuredClone(events), nextCursor, hasMore: run.events.some(entry => entry.seq > nextCursor) });
    }
    if (method === "POST" && match?.[2] === "cancel") {
      if (!terminal(run.info.status)) { run.cancelled = true; run.cancel.resolve(); }
      return reply(route, 200, { run: snapshot(run) });
    }
    return reply(route, 405, { error: "Unsupported managed-run fixture operation." });
  });
  return {
    requests,
    waitForCompletion(index = requests.length - 1) {
      if (!completions[index]) throw Error("No managed-run request exists at index " + index);
      return completions[index].promise;
    },
  };
}
