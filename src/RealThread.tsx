import { parseSlidesContent } from "./slide-preview";
import { useEffect, useRef, useState } from "react";
import { Star, SlidersHorizontal, Share2, GitFork, Archive, Trash2, Pencil, X, Activity, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { ThreadProps } from "./Thread";
import type { MessageContext, ThreadSettings, ToolRun } from "./types";
import { defaultThreadSettings } from "./types";
import type { Artifact } from "./local-model";
import { now, uid } from "./local-model";
import { useWorkspace } from "./workspace";
import { Composer, IconButton, Modal } from "./ui";
import { ArtifactView, exportArtifact } from "./LibraryManager";
import { api, fileDownloadUrl } from "./backend-client";
import { pendingKey, artifactFromAnswer, currentModels, type LlmConfig } from "./llm-client";
import { createRun, listRuns, followRun, cancelRun, decideShellApproval, isActiveRun, type RunInfo, type RunConnection, type RuntimeEvent } from "./run-client";
import AnswerMarkdown from "./AnswerMarkdown";
import { parseTable } from "./table-utils";
import ArtifactCanvas from "./ArtifactCanvas";
import ProviderDiagnostics from "./ProviderDiagnostics";
import IntegrationApprovals from "./IntegrationApprovals";
import "./real-thread.css";

type Share = { id: string; token: string; createdAt: string; revokedAt?: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : "The operation could not be completed.";
const dateLabel = (value?: string) => value ? new Date(value).toLocaleString() : "";

export default function RealThread({ thread, update, navigate, notify, settingsPanel, agents }: ThreadProps) {
  const w = useWorkspace();
  const [error, setError] = useState("");
  const [llm, setLlm] = useState<LlmConfig | null>(null);
  const [llmError, setLlmError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState("");
  const [reasoning, setReasoning] = useState(false);
  const [toolRuns, setToolRuns] = useState<ToolRun[]>([]);
  // This controller owns the VIEW, never the lifetime of server execution.
  const generation = useRef<AbortController | null>(null);
  const [runInfo, setRunInfo] = useState<RunInfo | null>(null);
  const runRef = useRef<RunInfo | null>(null);
  const cursor = useRef(0);
  const [checkingRuns, setCheckingRuns] = useState(true);
  const [connection, setConnection] = useState<RunConnection | null>(null);
  const [viewError, setViewError] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState("");
  const actionPending = useRef(false);
  const [preparedArtifacts, setPreparedArtifacts] = useState(0);
  const [preparedApprovals, setPreparedApprovals] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const alive = useRef(true);
  const lifecycle = useRef(0);
  const currentView = useRef({ threadId: thread.id, workspaceId: w.state.active });
  currentView.current = { threadId: thread.id, workspaceId: w.state.active };
  const isCurrentView = (epoch: number) => alive.current && lifecycle.current === epoch && currentView.current.threadId === thread.id && currentView.current.workspaceId === w.state.active;
  const bottom = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState("");
  const [title, setTitle] = useState(thread.title);
  const [config, setConfig] = useState<ThreadSettings>(thread.config || w.data.preferences?.defaultThreadSettings || defaultThreadSettings);
  const [toolsText, setToolsText] = useState(config.tools.join(", "));
  const [selectedId, setSelectedId] = useState("");
  const [kind, setKind] = useState("All");
  const [sort, setSort] = useState("updated");
  const [search, setSearch] = useState("");
  const [artifactTitle, setArtifactTitle] = useState("");
  const [content, setContent] = useState("");
  const [versionId, setVersionId] = useState("");
  const [editing, setEditing] = useState(false);
  const [shares, setShares] = useState<Share[]>([]);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareError, setShareError] = useState("");
  const [shareIds, setShareIds] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const operationBusy = useRef(false);
  const latest = useRef(thread);
  latest.current = thread;
  const linked = w.data.artifacts.filter(a => a.threadId === thread.id && !a.archived);
  const sortedArtifacts = [...linked].sort((a, b) => sort === "title" ? a.title.localeCompare(b.title) : (sort === "created" ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt)));
  const visible = sortedArtifacts.filter(a => (kind === "All" || a.kind === kind) && a.title.toLowerCase().includes(search.toLowerCase()));
  const canvasOrder = new Map((thread.canvas?.order || []).map((id, i) => [id, i]));
  const canvasVisible = visible.filter(a => !thread.canvas?.hidden.includes(a.id)).sort((a, b) => (canvasOrder.get(a.id) ?? canvasOrder.size) - (canvasOrder.get(b.id) ?? canvasOrder.size));
  const selected = linked.find(a => a.id === selectedId);
  function selectArtifact(id: string) {
    if (id === selectedId) return true;
    if (editing && selected && (content !== selected.content || artifactTitle !== selected.title) && !window.confirm("Discard unsaved artifact edits before opening another artifact?")) return false;
    setSelectedId(id); return true;
  }
  const historical = selected?.versions.find(v => v.id === versionId);
  const preview = selected && historical ? { ...selected, content: historical.content } : selected;

  useEffect(() => {
    setTitle(thread.title);
    setConfig(thread.config || w.data.preferences?.defaultThreadSettings || defaultThreadSettings);
    setToolsText((thread.config || w.data.preferences?.defaultThreadSettings || defaultThreadSettings).tools.join(", "));
  }, [thread.id, thread.title, thread.config]);
  useEffect(() => { setSelectedId(""); setModal(""); setError(""); }, [thread.id]);
  useEffect(() => {
    setArtifactTitle(selected?.title || ""); setContent(selected?.content || "");
    setVersionId(""); setEditing(false);
  }, [selected?.id, selected?.content, selected?.title]);

  useEffect(() => {
    alive.current = true;
    const epoch = ++lifecycle.current;
    const controller = new AbortController();
    generation.current = controller;
    setLlm(null); setLlmError(""); setDraft(""); setToolRuns([]); setGenerating(false);
    setRunInfo(null); runRef.current = null; cursor.current = 0;
    setCheckingRuns(true); setConnection(null); setViewError("");
    setPreparedArtifacts(0); setPreparedApprovals(0); setCancelBusy(false); setApprovalBusy("");
    actionPending.current = false;
    const load = async () => {
      let result: LlmConfig | null = null;
      try {
        result = await api<LlmConfig>("/api/llm/config");
        if (!isCurrentView(epoch) || controller.signal.aborted) return;
        setLlm(result);
      } catch (e) { if (isCurrentView(epoch) && !controller.signal.aborted) setLlmError(errorText(e)); }
      if (isCurrentView(epoch) && !controller.signal.aborted) await discoverRuns(epoch, controller, !!result?.configured);
    };
    void load();
    return () => { alive.current = false; lifecycle.current++; controller.abort(); generation.current?.abort(); generation.current = null; };
  }, [thread.id, w.state.active]);
  useEffect(() => { if (generating) bottom.current?.scrollIntoView({ block: "nearest" }); }, [draft, generating]);
  useEffect(() => {
    if (!runInfo || !isActiveRun(runInfo)) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runInfo?.id, runInfo?.status]);

  async function answerArtifact(text: string, artifactKind: "Document" | "Webpage", epoch = lifecycle.current) {
    if (!isCurrentView(epoch)) return;
    const body = artifactFromAnswer(text, artifactKind);
    const timestamp = now();
    const artifact: Artifact = { id: uid("artifact"), title: thread.title + (artifactKind === "Webpage" ? " · Webpage" : " · Document"), kind: artifactKind, content: body, threadId: thread.id, projectId: thread.projectId, versions: [], createdAt: timestamp, updatedAt: timestamp };
    w.set("artifacts", items => [...items, artifact]);
    setSelectedId(artifact.id);
    await w.flush();
  }

  function showRun(run: RunInfo) {
    runRef.current = run; setRunInfo(run); setGenerating(isActiveRun(run));
  }
  function receiveEvent(event: RuntimeEvent) {
    if (event.type === "delta") { setDraft(text => text + event.text); setReasoning(false); }
    else if (event.type === "reasoning") setReasoning(true);
    else if (event.type === "tool") setToolRuns(items => {
      const run: ToolRun = { id: event.id, name: event.name, status: event.status, summary: event.summary };
      return items.some(item => item.id === run.id) ? items.map(item => item.id === run.id ? run : item) : [...items, run];
    });
    else if (event.type === "plan" && runRef.current) showRun({ ...runRef.current, plan: event.steps });
    else if (event.type === "artifact") setPreparedArtifacts(count => count + 1);
    else if (event.type === "approval") setPreparedApprovals(count => count + 1);
    else if (event.type === "shell_approval" && runRef.current) {
      const run = runRef.current;
      if (!run.approvals.some(item => item.id === event.actionId)) showRun({ ...run, approvals: [...run.approvals, { id: event.actionId, status: "pending", command: event.command, cwd: event.cwd, timeoutSeconds: event.timeoutSeconds }] });
    } else if (event.type === "run_status" && runRef.current) showRun({ ...runRef.current, status: event.status });
    else if (event.type === "done" && runRef.current) showRun({ ...runRef.current, model: event.model });
    else if (event.type === "error") setError(event.message);
  }
  async function watchRun(run: RunInfo, epoch: number, controller: AbortController, replay = true) {
    if (!isCurrentView(epoch) || controller.signal.aborted) return;
    generation.current = controller; showRun(run); setCheckingRuns(false); setViewError(""); setConnection(null);
    if (replay) {
      cursor.current = 0; setDraft(""); setReasoning(false); setToolRuns([]); setPreparedArtifacts(0); setPreparedApprovals(0);
    }
    const viewing = () => isCurrentView(epoch) && generation.current === controller && !controller.signal.aborted;
    try {
      await followRun({
        id: run.id, scope: { workspaceId: run.workspaceId, threadId: run.threadId }, signal: controller.signal, after: cursor.current,
        onEvent: event => { if (viewing()) receiveEvent(event); },
        onRun: value => { if (viewing()) showRun(value); },
        onCursor: value => { if (viewing()) cursor.current = value; },
        onConnection: value => { if (viewing()) setConnection(value); },
      });
      if (!viewing()) return;
      // Server owns final assistant messages and versioned artifacts. Never re-save them here.
      await w.reload();
      if (viewing()) { setDraft(""); setReasoning(false); setToolRuns([]); setPreparedArtifacts(0); setPreparedApprovals(0); }
    } catch (e) {
      if (viewing()) setViewError(errorText(e) + " Retry viewing reconnects to this run; it does not execute again.");
    } finally {
      if (viewing()) { generation.current = null; setCheckingRuns(false); setConnection(null); setGenerating(!!runRef.current && isActiveRun(runRef.current)); }
    }
  }
  async function discoverRuns(epoch: number, controller: AbortController, allowPending = false) {
    const viewing = () => isCurrentView(epoch) && generation.current === controller && !controller.signal.aborted;
    setCheckingRuns(true); setViewError("");
    try {
      const runs = await listRuns({ workspaceId: w.state.active, threadId: thread.id }, controller.signal);
      if (!viewing()) return;
      const key = pendingKey(w.state.active, thread.id), pendingId = sessionStorage.getItem(key);
      const active = runs.find(isActiveRun);
      if (active) {
        if (active.userMessageId === pendingId) sessionStorage.removeItem(key);
        void watchRun(active, epoch, controller);
        return;
      }
      const recent = runs[0];
      if (recent) showRun(recent);
      const pendingRun = pendingId ? runs.find(run => run.userMessageId === pendingId) : undefined;
      if (pendingRun) sessionStorage.removeItem(key);
      if (recent) {
        await w.reload();
        if (!viewing()) return;
      }
      generation.current = null; setCheckingRuns(false); setConnection(null);
      if (allowPending && !pendingRun && pendingId && latest.current.messages?.at(-1)?.id === pendingId && latest.current.messages?.at(-1)?.role === "user") void generate(pendingId, epoch);
    } catch (e) {
      if (viewing()) { generation.current = null; setCheckingRuns(false); setViewError("Could not check saved runs. " + errorText(e) + " Retry viewing before sending or generating again."); }
    }
  }
  async function generate(userMessageId: string, epoch = lifecycle.current) {
    if (!isCurrentView(epoch) || generation.current || (runRef.current && isActiveRun(runRef.current)) || thread.archived) return;
    const controller = new AbortController();
    generation.current = controller; setGenerating(true); setDraft(""); setError(""); setViewError(""); setReasoning(false); setToolRuns([]);
    // A failed POST is ambiguous: discover the new run, never reconnect to an older terminal run.
    runRef.current = null; setRunInfo(null); cursor.current = 0; setConnection(null); setPreparedArtifacts(0); setPreparedApprovals(0);
    const key = pendingKey(w.state.active, thread.id);
    try {
      await w.flush();
      if (!isCurrentView(epoch) || generation.current !== controller || controller.signal.aborted) return;
      sessionStorage.setItem(key, userMessageId);
      const run = await createRun({ workspaceId: w.state.active, threadId: thread.id, userMessageId }, controller.signal);
      if (!isCurrentView(epoch) || generation.current !== controller || controller.signal.aborted) return;
      sessionStorage.removeItem(key);
      // Release onSend after the durable POST, not after a long-running execution.
      void watchRun(run, epoch, controller);
    } catch (e) {
      if (isCurrentView(epoch) && generation.current === controller && !controller.signal.aborted) {
        generation.current = null; setGenerating(false);
        setViewError("Could not attach to the run. " + errorText(e) + " The server may already be executing. Retry viewing to check; do not submit the task again.");
      }
    }
  }
  function retryViewing() {
    if (generation.current || checkingRuns) return;
    const epoch = lifecycle.current, controller = new AbortController();
    generation.current = controller;
    if (runRef.current) void watchRun(runRef.current, epoch, controller, false);
    else void discoverRuns(epoch, controller);
  }
  async function stopRun() {
    const run = runRef.current;
    if (!run || !isActiveRun(run) || actionPending.current) return;
    const epoch = lifecycle.current;
    actionPending.current = true; setCancelBusy(true); setError("");
    try {
      const stopped = await cancelRun(run.id, { workspaceId: run.workspaceId, threadId: run.threadId });
      if (!isCurrentView(epoch)) return;
      showRun(stopped);
      if (!generation.current) { const controller = new AbortController(); void watchRun(stopped, epoch, controller, false); }
    } catch (e) { if (isCurrentView(epoch)) setError("Cancellation was not confirmed: " + errorText(e) + " The run may still be active."); }
    finally { if (isCurrentView(epoch)) { actionPending.current = false; setCancelBusy(false); } }
  }
  async function approveShell(actionId: string, decision: "approve" | "deny") {
    const run = runRef.current;
    if (!run || !isActiveRun(run) || actionPending.current || !run.approvals.some(item => item.id === actionId && item.status === "pending")) return;
    const epoch = lifecycle.current;
    actionPending.current = true; setApprovalBusy(actionId); setError("");
    try {
      const next = await decideShellApproval(run.id, actionId, { workspaceId: run.workspaceId, threadId: run.threadId }, decision);
      if (isCurrentView(epoch)) {
        showRun(next);
        if (!generation.current) { const controller = new AbortController(); void watchRun(next, epoch, controller, false); }
      }
    } catch (e) { if (isCurrentView(epoch)) setError("The shell decision was not confirmed: " + errorText(e) + " Retry viewing to check its status before deciding again."); }
    finally { if (isCurrentView(epoch)) { actionPending.current = false; setApprovalBusy(""); } }
  }
  const lastMessage = thread.messages?.at(-1);
  const canGenerate = !!llm?.configured && lastMessage?.role === "user" && !!lastMessage.id && !thread.archived && !checkingRuns && !viewError && (!runInfo || (!isActiveRun(runInfo) && runInfo.userMessageId !== lastMessage.id));

  async function perform(action: () => Promise<void>) {
    if (operationBusy.current) return;
    operationBusy.current = true; setBusy(true); setError("");
    try { await action(); } catch (e) { setError(errorText(e)); } finally { operationBusy.current = false; setBusy(false); }
  }
  async function saveThread(patch: Partial<typeof thread>) {
    update({ ...latest.current, ...patch, updatedAt: now() });
    await w.flush();
  }
  async function send(text: string, context?: MessageContext, clientRequestId?: string) {
    if (generation.current || generating || checkingRuns || viewError || (runRef.current && isActiveRun(runRef.current))) throw Error("Wait for the active run or retry viewing its saved status before sending another message.");
    setError("");
    const epoch = lifecycle.current;
    const current = latest.current;
    const message = { id: clientRequestId || crypto.randomUUID(), role: "user" as const, text, createdAt: now(), ...(context ? { context } : {}) };
    const next = { ...current, updatedAt: now(), config: context?.settings || current.config || config, projectId: context?.projectId || current.projectId, messages: current.messages?.some(m => m.id === message.id) ? current.messages : [...(current.messages || []), message] };
    latest.current = next;
    update(next);
    try { await w.flush(); } catch (e) { setError(errorText(e)); throw e; }
    if (llm?.configured && isCurrentView(epoch)) await generate(message.id, epoch);
  }
  async function fork() {
    const timestamp = now();
    const id = uid("thread");
    const allArtifacts = w.data.artifacts.filter(a => a.threadId === thread.id);
    const ids = new Map(allArtifacts.map(a => [a.id, uid("artifact")]));
    const copies = allArtifacts.map(a => ({ ...structuredClone(a), id: ids.get(a.id)!, threadId: id, versions: a.versions.map(v => ({ ...v, id: uid("version") })), createdAt: timestamp, updatedAt: timestamp }));
    const copy = { ...structuredClone(thread), ...(thread.canvas ? { canvas: { ...thread.canvas, hidden: thread.canvas.hidden.flatMap(a => ids.has(a) ? [ids.get(a)!] : []), order: thread.canvas.order.flatMap(a => ids.has(a) ? [ids.get(a)!] : []) } } : {}), id, title: thread.title + " (fork)", starred: false, archived: false, createdAt: timestamp, updatedAt: timestamp, messages: (thread.messages || []).map(m => ({ ...structuredClone(m), id: crypto.randomUUID(), ...(m.actionRequests ? { actionRequests: m.actionRequests.map(a => ({ ...a, token: "", status: a.status === "pending" ? "dismissed" as const : a.status })) } : {}), ...(m.context ? { context: { ...structuredClone(m.context), artifactIds: (m.context.artifactIds || []).map(a => ids.get(a) || a) } } : {}) })) };
    w.set("threads", items => [...items, copy]);
    w.set("artifacts", items => [...items, ...copies]);
    await w.flush(); navigate("/thread/" + id);
  }
  async function newArtifact(artifactKind: "Document" | "Webpage") {
    const timestamp = now();
    const artifact: Artifact = { id: uid("artifact"), title: "Untitled " + artifactKind.toLowerCase(), kind: artifactKind, content: "", threadId: thread.id, projectId: thread.projectId, versions: [], createdAt: timestamp, updatedAt: timestamp };
    w.set("artifacts", items => [...items, artifact]); setSelectedId(artifact.id);
    await w.flush();
  }
  async function saveArtifact() {
    if (!selected || !artifactTitle.trim()) throw Error("An artifact title is required.");
    if (selected.kind === "Table") parseTable(content);
    if (selected.kind === "Slides") parseSlidesContent(content);
    w.set("artifacts", items => items.map(a => a.id !== selected.id ? a : { ...a, title: artifactTitle.trim(), content, updatedAt: now(), versions: content === a.content ? a.versions : [...a.versions, { id: uid("version"), content: a.content, createdAt: a.updatedAt }] }));
    await w.flush(); setEditing(false);
  }
  async function loadShares() {
    setShareLoading(true); setShareError("");
    try { await w.flush(); const result = await api<{ shares: Share[] }>("/api/shares?workspaceId=" + encodeURIComponent(w.state.active) + "&threadId=" + encodeURIComponent(thread.id)); setShares(result.shares); }
    catch (e) { setShareError(errorText(e)); } finally { setShareLoading(false); }
  }
  function openShare() { setShareIds([]); setConfirmed(false); setShares([]); setModal("share"); void loadShares(); }
  async function publish() {
    if (!confirmed) return;
    await w.flush();
    const { share } = await api<{ share: Share }>("/api/shares", { method: "POST", body: { workspaceId: w.state.active, threadId: thread.id, artifactIds: shareIds.filter(id => linked.some(a => a.id === id)) } });
    setShares(items => [share, ...items]); setConfirmed(false);
  }

  return <main className="real-thread">
    <header className="rt-header">
      <div className="rt-title"><h1>{thread.title}</h1>{thread.archived && <span className="rt-badge">Archived</span>}</div>
      <div className="rt-actions">
        <IconButton label={thread.canvas?.collapsed ? "Show canvas" : "Hide canvas"} onClick={() => void perform(() => saveThread({ canvas: { layout: "focus", hidden: [], order: [], ...thread.canvas, collapsed: !thread.canvas?.collapsed } }))}>{thread.canvas?.collapsed ? <PanelRightOpen size={17} /> : <PanelRightClose size={17} />}</IconButton>
        <IconButton label="Connection diagnostics" onClick={() => setModal("diagnostics")}><Activity size={17} /></IconButton>
        <IconButton label={thread.starred ? "Unstar thread" : "Star thread"} onClick={() => void perform(() => saveThread({ starred: !thread.starred }))}><Star size={17} fill={thread.starred ? "currentColor" : "none"} /></IconButton>
        <IconButton label="Rename thread" onClick={() => { setTitle(thread.title); setModal("rename"); }}><Pencil size={17} /></IconButton>
        <IconButton label="Fork thread" onClick={() => void perform(fork)}><GitFork size={17} /></IconButton>
        <IconButton label={thread.archived ? "Unarchive thread" : "Archive thread"} onClick={() => void perform(() => saveThread({ archived: !thread.archived }))}><Archive size={17} /></IconButton>
        <IconButton label="Delete thread" onClick={() => setModal("delete")}><Trash2 size={17} /></IconButton>
        <button className="btn small" onClick={openShare}><Share2 size={15} />Share</button>
        <IconButton label="Thread configuration" onClick={() => navigate("/thread/" + thread.id + (settingsPanel ? "" : "?panel=settings"))}><SlidersHorizontal size={17} /></IconButton>
      </div>
    </header>
    <div className="rt-status"><span>{llm?.configured ? "DeepSeek configured · Connection not verified" : llmError ? "Model status unavailable" : llm ? "DeepSeek not configured · Messages are still saved" : "Checking model connection…"}</span><span role="status">{busy ? "Saving…" : w.persistence === "saved" ? "Saved" : w.persistence}</span></div>
    {llm && !llm.configured && <p className="rt-notice">To enable real replies, set DEEPSEEK_API_KEY in the server’s private .env or deployment environment and restart the service. Never commit a key or use a VITE_ secret. Local tools and selected public-data APIs are available when enabled. Selected configured integrations can read actual APIs. Integration writes require your per-action confirmation. Durable runs can use real shell commands only when Shell is explicitly enabled and you approve each command. Shell is not sandboxed and can modify files or access the network. Browser offers ephemeral public-HTTPS navigation, DOM observation/extraction and PNG capture when its backend is configured. Slides uses a dedicated navigable artifact. Search/Find Similar require a configured Exa service. Click/type, persistent logins, handoff, media and schedules remain unavailable.</p>}
    {checkingRuns && <p className="rt-run-loading" role="status">Checking saved runs before enabling execution…</p>}
    {runInfo && <section className={"rt-run-panel " + runInfo.status} aria-label="Durable run status">
      <div className="rt-run-heading"><div><strong>{runStatusLabel(runInfo.status)}</strong><code title={runInfo.id}>Run {runInfo.id.slice(0, 8)}</code></div><div className="rt-actions">{isActiveRun(runInfo) && <button className="btn small" disabled={cancelBusy || !!approvalBusy} onClick={() => void stopRun()}>{cancelBusy ? "Stopping…" : "Stop run"}</button>}</div></div>
      <dl className="rt-run-stats"><div><dt>Elapsed</dt><dd>{elapsedLabel(runInfo, clock)}</dd></div><div><dt>Tools</dt><dd>{runInfo.toolCount.toLocaleString()}</dd></div>{runInfo.model && <div><dt>Model</dt><dd>{runInfo.model}</dd></div>}{runInfo.usage?.prompt_tokens !== undefined && <div><dt>Input tokens</dt><dd>{runInfo.usage.prompt_tokens.toLocaleString()}</dd></div>}{runInfo.usage?.completion_tokens !== undefined && <div><dt>Output tokens</dt><dd>{runInfo.usage.completion_tokens.toLocaleString()}</dd></div>}{runInfo.usage?.total_tokens !== undefined && <div><dt>Total tokens</dt><dd>{runInfo.usage.total_tokens.toLocaleString()}</dd></div>}</dl>
      {!!runInfo.plan?.length && <ol className="rt-run-plan" aria-label="Agent task plan">{runInfo.plan.map(step => <li key={step.id} className={step.status}><span aria-hidden="true">{step.status === "completed" ? "✓" : step.status === "in_progress" ? "◌" : "○"}</span><span>{step.title}</span><small>{step.status.replace("_", " ")}</small></li>)}</ol>}
      {isActiveRun(runInfo) && <p className="rt-run-hint">Execution continues on the server if you leave this page. Stop run explicitly requests cancellation.</p>}
      {!isActiveRun(runInfo) && <p className="rt-run-hint">{runInfo.resultSaved ? "Result saved by the server." : "Run ended. Saving the result was not confirmed; inspect the preserved execution log."}{runInfo.status !== "succeeded" && " Send a new message if you want another execution; retry viewing never reruns the task."}</p>}
      {runInfo.error && <p className="rt-run-failure" role="alert">{runInfo.error}</p>}
      {connection?.status === "reconnecting" && <p className="rt-run-reconnecting" role="status">Reconnecting to saved events · attempt {connection.failures}/5 · retry in {Math.ceil(connection.retryInMs / 1000)}s. Execution is not restarted.<span>{connection.message}</span></p>}
      {!!runInfo.approvals.length && <div className="rt-shell-approvals" aria-label="Shell command approvals"><p className="rt-shell-warning"><strong>Full shell authority — not a sandbox.</strong> Approved commands run on the server and may modify files, access credentials available to the process, or contact the network. Review the exact command, working directory and timeout. No command is auto-approved.</p>{runInfo.approvals.map(approval => <section className={"rt-shell-approval " + approval.status} key={approval.id} aria-label="Shell command review"><div className="rt-section-heading"><strong>Shell command</strong><span className="rt-badge">{approval.status}</span></div><pre className="rt-shell-command">{approval.command}</pre><dl><dt>Working directory</dt><dd><code>{approval.cwd}</code></dd><dt>Timeout</dt><dd>{approval.timeoutSeconds} seconds</dd></dl>{approval.status === "pending" && isActiveRun(runInfo) && <div className="rt-actions"><button className="btn primary" disabled={!!approvalBusy || cancelBusy || !!viewError} onClick={() => void approveShell(approval.id, "approve")}>{approvalBusy === approval.id ? "Submitting decision…" : "Approve command"}</button><button className="btn" disabled={!!approvalBusy || cancelBusy || !!viewError} onClick={() => void approveShell(approval.id, "deny")}>Deny command</button></div>}</section>)}</div>}
    </section>}
    {viewError && <div className="rt-run-view-error" role="alert"><p>{viewError}</p><button className="btn small" disabled={checkingRuns || !!generation.current} onClick={retryViewing}>Retry viewing</button></div>}
    {llmError && <p className="rt-error" role="alert">{llmError}</p>}
    {error && <div className="rt-error" role="alert">{error}<button className="btn small" onClick={() => setError("")}>Dismiss</button></div>}
    {(w.persistence === "error" || w.persistence === "conflict") && <div className="rt-error" role="alert"><p>{w.storageError || "Changes are not saved. Export a backup before reloading saved data."}</p><div className="rt-actions"><button className="btn small" onClick={w.exportSnapshot}>Export backup</button>{w.persistence === "error" && <button className="btn small" disabled={busy} onClick={() => void perform(w.retrySave)}>Retry save</button>}<button className="btn small" disabled={busy} onClick={() => { if (window.confirm("Discard unsaved local changes and reload saved server data? Export a backup first if you want to keep them.")) void perform(w.reload); }}>Reload saved data</button></div></div>}
    <div className={"rt-columns" + (settingsPanel ? " has-settings" : "") + (thread.canvas?.collapsed ? " canvas-collapsed" : "")}>
      <section className="rt-conversation" aria-label="Conversation">
        <div className="rt-messages">
          {!(thread.messages || []).length && <div className="rt-empty"><h2>No messages yet</h2><p>Ask a question or start a task. DeepSeek can use your saved conversation, selected agent instructions, skills, memories and text attachments when configured.</p></div>}
          {(thread.messages || []).map((message, i) => <article className={"rt-message " + message.role} key={message.id || i}>
            <div className="rt-message-meta"><strong>{message.role === "user" ? "You" : "Assistant"}</strong><time dateTime={message.createdAt}>{dateLabel(message.createdAt)}</time></div>
            {message.role === "assistant" ? <div className="rt-answer"><AnswerMarkdown content={message.text} /><div className="rt-answer-actions"><button className="btn small" onClick={() => void navigator.clipboard.writeText(message.text).then(() => notify("Answer copied")).catch(() => setError("Clipboard access failed. Select and copy the answer text instead."))}>Copy answer</button><button className="btn small" disabled={busy || generating} onClick={() => void perform(() => answerArtifact(message.text, "Document"))}>Save as document</button><button className="btn small" disabled={busy || generating} onClick={() => void perform(() => answerArtifact(message.text, "Webpage"))}>Save as webpage</button></div></div> : <p>{message.text}</p>}
            {!!message.context?.attachments?.length && <ul className="rt-attachments">{message.context.attachments.map(file => <li key={file.id}><a href={fileDownloadUrl(file)} download={file.name}>{file.name}</a><span> · {file.size.toLocaleString()} bytes</span></li>)}</ul>}
            {!!message.toolRuns?.length && <ToolHistory runs={message.toolRuns} />}
            {!!message.actionRequests?.length && message.id && <IntegrationApprovals threadId={thread.id} messageId={message.id} requests={message.actionRequests} />}
            {message.context && <details className="rt-context"><summary>Saved context</summary><dl><dt>Model preference</dt><dd>{message.context.settings?.model || "Not selected"}</dd><dt>Provider preference</dt><dd>{message.context.settings?.provider || "Not selected"}</dd><dt>Skills</dt><dd>{(message.context.skillIds || []).map(id => w.data.skills.find(s => s.id === id)?.name || id).join(", ") || "None"}</dd><dt>Memories</dt><dd>{(message.context.memoryIds || []).length}</dd><dt>Artifacts</dt><dd>{(message.context.artifactIds || []).map(id => w.data.artifacts.find(a => a.id === id)?.title || id).join(", ") || "None"}</dd><dt>Integrations</dt><dd>{(message.context.integrationIds || []).map(id => w.data.connections.find(c => c.id === id)?.label || id).join(", ") || "None"}</dd></dl></details>}
          </article>)}
          {(generating || (!!viewError && !!draft)) && <article className="rt-message assistant" aria-label="Streaming answer"><div className="rt-message-meta"><strong>Assistant · live preview</strong><span role="status">{viewError ? "Viewing paused" : runInfo?.status === "waiting_approval" ? "Awaiting approval" : connection?.status === "reconnecting" ? "Reconnecting…" : draft ? "Writing…" : reasoning ? "Reasoning…" : "Working…"}</span></div>{!!toolRuns.length && <ToolHistory runs={toolRuns} />}{draft && <div className="rt-answer"><AnswerMarkdown content={draft} /></div>}{!!preparedArtifacts && <p className="rt-run-hint">{preparedArtifacts} artifact update(s) prepared. The server saves final artifact versions.</p>}{!!preparedApprovals && <p className="rt-run-hint">Integration review prepared. Review the saved action below the final answer when the run finishes.</p>}</article>}
          {!generating && canGenerate && <button className="btn" onClick={() => void generate(lastMessage!.id!)}>Generate reply</button>}
          <div ref={bottom} />
        </div>
        <div className="rt-composer"><Composer disabled={generating || checkingRuns || !!viewError || !!generation.current} compact navigate={navigate} notify={notify} agents={agents} initialSettings={thread.config} contextKey={thread.id} onSend={send} /></div>
      </section>
      <section className={"rt-artifacts" + (thread.canvas?.collapsed ? " is-collapsed" : "")} aria-label="Thread artifacts">
        {thread.canvas?.collapsed ? <button className="rt-canvas-restore" onClick={() => void perform(() => saveThread({ canvas: { ...thread.canvas!, collapsed: false } }))}><PanelRightOpen size={17} />Show canvas</button> : <>
        <div className="rt-section-heading"><h2>Artifacts <span>{linked.length}</span></h2><div className="rt-actions"><button className="btn small" disabled={busy} onClick={() => void perform(() => newArtifact("Document"))}>New document</button><button className="btn small" disabled={busy} onClick={() => void perform(() => newArtifact("Webpage"))}>New webpage</button></div></div>
        <div className="rt-artifact-filters"><input aria-label="Filter artifacts" placeholder="Filter artifacts…" value={search} onChange={e => setSearch(e.target.value)} /><select aria-label="Artifact type" value={kind} onChange={e => setKind(e.target.value)}>{["All", "Document", "Webpage", "Slides", "Table", "Image", "File"].map(k => <option key={k}>{k}</option>)}</select><select aria-label="Sort artifacts" value={sort} onChange={e => setSort(e.target.value)}><option value="updated">Last updated</option><option value="created">Newest first</option><option value="title">Title A–Z</option></select></div>
        <ArtifactCanvas artifacts={visible} allArtifacts={sortedArtifacts} selectedId={selectedId} value={thread.canvas} disabled={busy} onSelect={selectArtifact} onChange={canvas => void perform(() => saveThread({ canvas }))}>
        {!linked.length ? <div className="rt-empty"><h3>No linked artifacts</h3><p>Create a document or webpage to start. This thread has no generated or sample content.</p></div> : !canvasVisible.length ? <p className="rt-empty">No visible artifacts match these filters. Restore docked items below.</p> : <nav className="rt-artifact-list" aria-label="Select artifact">{canvasVisible.map(a => <button key={a.id} className={a.id === selectedId ? "active" : ""} onClick={() => selectArtifact(a.id)}><span>{a.title}</span><small>{a.kind}</small></button>)}</nav>}
        {selected ? <div className="rt-artifact-editor">
          <div className="rt-section-heading"><h3>{selected.title}</h3><button className="btn small" onClick={() => exportArtifact(preview!)}>Download</button></div>
          <div className="rt-artifact-filters"><label>Version <select aria-label="Artifact version" value={versionId} onChange={e => { setVersionId(e.target.value); setEditing(false); }}><option value="">Current version</option>{[...selected.versions].reverse().map((v, i) => <option key={v.id} value={v.id}>{dateLabel(v.createdAt)} · revision {selected.versions.length - i}</option>)}</select></label>{historical ? <button className="btn small" disabled={busy} onClick={() => void perform(async () => { w.updateArtifact(selected.id, historical.content); await w.flush(); setVersionId(""); })}>Restore this version</button> : <button className="btn small" onClick={() => setEditing(!editing)}>{editing ? "Preview" : "Edit artifact"}</button>}</div>
          {historical && <p className="rt-notice">Viewing a previous version. Restoring preserves the current content in version history.</p>}
          {editing ? <form onSubmit={e => { e.preventDefault(); void perform(saveArtifact); }} className="rt-artifact-form"><label>Artifact title<input required value={artifactTitle} onChange={e => setArtifactTitle(e.target.value)} /></label><label>{selected.kind === "Webpage" ? "HTML source" : selected.kind === "Slides" ? "Slides JSON" : "Content"}<textarea aria-label="Artifact content" value={content} onChange={e => setContent(e.target.value)} /></label><button className="btn primary" disabled={busy}>Save artifact</button></form> : <ArtifactView artifact={preview!} />}
        </div> : !!linked.length && <p className="rt-empty">Select an artifact to preview, edit, download, or restore a version.</p>}
        </ArtifactCanvas>
        </>}
      </section>
      {settingsPanel && <aside className="rt-settings" aria-label="Thread configuration"><div className="rt-section-heading"><h2>Configuration</h2><IconButton label="Close configuration" onClick={() => navigate("/thread/" + thread.id)}><X size={16} /></IconButton></div><p className="rt-notice">DeepSeek uses the selected agent prompt and saved context. Only the supported models below execute. Enable Thread Search, Documents, Webpages and Tables for local tool calls. Enable Web Fetch for read-only public HTTPS Markdown retrieval through local Moli. World Bank / Weather / configured OpenAlex are read-only API tools. Selected integrations execute actual API reads; writes are confirmation-gated. Durable server runs can use Shell only after you enable it and explicitly approve each command. Shell has full server authority, not sandbox isolation, and can modify files or contact the network. Leaving this page does not stop a run. Browser supports ephemeral sessions, public HTTPS navigation, DOM observation/extraction and PNG capture when configured. Slides uses a dedicated navigable artifact. Search/Find Similar require a configured Exa service. Click/type, persistent logins, handoff, media and schedules remain unavailable.</p>
        <label>Project<select aria-label="Thread project" value={thread.projectId || ""} onChange={e => void perform(() => saveThread({ projectId: e.target.value || undefined, project: undefined }))}><option value="">No project</option>{w.data.projects.filter(p => !p.archived || p.id === thread.projectId).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <form onSubmit={e => { e.preventDefault(); void perform(() => saveThread({ config })); }}>
          <label>Provider<select value="DeepSeek" disabled><option>DeepSeek</option></select></label>
          <label>Model<select aria-label="DeepSeek model" value={currentModels.includes(config.model) ? config.model : ""} onChange={e => setConfig({ ...config, model: e.target.value, provider: "DeepSeek" })}><option value="">Default · DeepSeek Flash</option>{currentModels.map(model => <option key={model}>{model}</option>)}</select></label>
          <label>Reasoning preference<input value={config.reasoning} onChange={e => setConfig({ ...config, reasoning: e.target.value })} /></label>
          <label>Mode preference<select value={config.mode} onChange={e => setConfig({ ...config, mode: e.target.value })}>{Array.from(new Set([config.mode, "Execute", "Plan", "Ask"])).map(m => <option key={m}>{m}</option>)}</select></label>
          <label>Agent preference<select value={config.agentId || ""} onChange={e => setConfig({ ...config, agentId: e.target.value || undefined, starterAgentName: undefined })}><option value="">No agent</option>{w.data.agents.filter(a => !a.archived || a.id === config.agentId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label>Tools preference (comma-separated)<input value={toolsText} onChange={e => { setToolsText(e.target.value); setConfig({ ...config, tools: e.target.value.split(",").map(s => s.trim()).filter(Boolean) }); }} /></label>
          <div className="rt-shell-config"><strong>Real shell execution</strong><p>Enable Shell for future runs only if you intend to grant real server shell access. Every proposed command still requires Approve or Deny. Enabling this tool does not approve any command.</p><button type="button" className="btn small" disabled={busy || config.tools.some(tool => tool.toLowerCase() === "shell")} onClick={() => void perform(async () => { const next = { ...config, tools: [...config.tools, "Shell"] }; setConfig(next); setToolsText(next.tools.join(", ")); await saveThread({ config: next }); })}>{config.tools.some(tool => tool.toLowerCase() === "shell") ? "Shell enabled in configuration" : "Enable Shell & save configuration"}</button></div>
          <label>Output format<input value={config.outputFormat || ""} onChange={e => setConfig({ ...config, outputFormat: e.target.value })} /></label>
          <label>Visual style<input value={config.visuals || ""} onChange={e => setConfig({ ...config, visuals: e.target.value })} /></label>
          <div className="rt-actions"><button className="btn primary" disabled={busy}>Save configuration</button><button type="button" className="btn" disabled={busy} onClick={() => void perform(async () => { w.setPreferences({ defaultThreadSettings: structuredClone(config) }); await w.flush(); })}>Save as default</button></div>
        </form>
        <button className="btn" disabled title="Execution is not connected">Schedule execution unavailable</button>
      </aside>}
    </div>
    {modal === "diagnostics" && <Modal title="AI provider & system status" onClose={() => setModal("")} wide><ProviderDiagnostics /></Modal>}
    {modal === "rename" && <Modal title="Rename thread" onClose={() => setModal("")}><form className="rt-dialog-form" onSubmit={e => { e.preventDefault(); if (title.trim()) void perform(async () => { await saveThread({ title: title.trim() }); setModal(""); }); }}><label>Thread title<input aria-label="Thread title" required autoFocus value={title} onChange={e => setTitle(e.target.value)} /></label>{error && <p className="rt-error" role="alert">{error}</p>}<button className="btn primary" disabled={busy || !title.trim()}>Save name</button></form></Modal>}
    {modal === "delete" && <Modal title="Delete thread?" onClose={() => setModal("")}><p>This permanently removes “{thread.title}” and its messages. Artifacts remain in the Library, unlinked from this thread. All active public snapshots of this thread will also be revoked. This cannot be undone.</p>{error && <p className="rt-error" role="alert">{error}</p>}<div className="rt-actions"><button className="btn" onClick={() => setModal("")}>Cancel</button><button className="btn danger" disabled={busy} onClick={() => void perform(async () => { await w.flush(); const result = await api<{ shares: Share[] }>("/api/shares?workspaceId=" + encodeURIComponent(w.state.active) + "&threadId=" + encodeURIComponent(thread.id)); for (const share of result.shares.filter(s => !s.revokedAt)) await api("/api/shares/" + encodeURIComponent(share.id), { method: "DELETE" }); w.set("threads", items => items.filter(t => t.id !== thread.id)); w.set("artifacts", items => items.map(a => a.threadId === thread.id ? { ...a, threadId: undefined } : a)); await w.flush(); navigate("/threads"); })}>Delete permanently</button></div></Modal>}
    {modal === "share" && <Modal title="Share thread snapshot" onClose={() => setModal("")} wide><div className="rt-share"><p>Publishing creates an immutable public snapshot of the thread title, message text and attachment filenames. Only artifacts you select below are included. Private attachment bytes, context, settings, and workspace data are never public.</p><p>Anyone with the link can read the snapshot. Review message text and artifact contents for sensitive information before publishing.</p><fieldset><legend>Artifacts to include</legend>{linked.length ? linked.map(a => <label className="rt-checkbox" key={a.id}><input type="checkbox" checked={shareIds.includes(a.id)} onChange={e => setShareIds(ids => e.target.checked ? [...ids, a.id] : ids.filter(id => id !== a.id))} />{a.title} ({a.kind})</label>) : <p>No linked artifacts.</p>}</fieldset><label className="rt-checkbox"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I confirm the message text and selected artifact snapshots may be public.</label><button className="btn primary" disabled={busy || !confirmed} onClick={() => void perform(publish)}>Publish snapshot</button>{error && <p role="alert" className="rt-error">{error}</p>}<div className="rt-section-heading"><h3>Published snapshots</h3><button className="btn small" disabled={shareLoading} onClick={() => void loadShares()}>Refresh</button></div>{shareLoading && <p role="status">Loading snapshots…</p>}{shareError && <p role="alert" className="rt-error">{shareError}</p>}{!shareLoading && !shareError && !shares.length && <p>No published snapshots.</p>}{shares.map(share => <div className="rt-share-row" key={share.id}><div><time>{dateLabel(share.createdAt)}</time>{share.revokedAt ? <p>Revoked</p> : <a href={"/share/" + encodeURIComponent(share.token)} target="_blank" rel="noopener noreferrer">{window.location.origin}/share/{share.token}</a>}</div>{!share.revokedAt && <button className="btn small" disabled={busy} onClick={() => void perform(async () => { await api("/api/shares/" + encodeURIComponent(share.id), { method: "DELETE" }); setShares(items => items.map(s => s.id === share.id ? { ...s, revokedAt: now() } : s)); })}>Revoke</button>}</div>)}</div></Modal>}
  </main>;
}

function ToolHistory({ runs }: { runs: ToolRun[] }) {
  return <div className="rt-tool-history" aria-label="Tool activity">{runs.map(run => <details key={run.id} className={"rt-tool " + run.status}><summary><span>{run.status === "running" ? "◌" : run.status === "error" ? "!" : "✓"}</span> {run.name} <small>{run.status === "running" ? "Running" : run.status === "error" ? "Failed" : "Result ready"}</small></summary><pre>{run.summary}</pre></details>)}</div>;
}

function runStatusLabel(status: RunInfo["status"]) {
  const labels: Record<RunInfo["status"], string> = { queued: "Queued", running: "Running", waiting_approval: "Waiting for approval", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted" };
  return labels[status];
}
function elapsedLabel(run: RunInfo, clock: number) {
  const start = Date.parse(run.startedAt || run.createdAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : isActiveRun(run) ? clock : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m " + seconds % 60 + "s";
  return Math.floor(seconds / 3600) + "h " + Math.floor(seconds % 3600 / 60) + "m";
}
