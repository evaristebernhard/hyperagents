import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock,
  GitBranch,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  Square,
  Workflow,
  X,
} from "lucide-react";
import { useWorkspace } from "./workspace";
import type { DemoAgent } from "./types";
import AnswerMarkdown from "./AnswerMarkdown";
import {
  addTaskInput,
  changeTask,
  createTask,
  decideTaskApproval,
  listTasks,
  readAgentRuntime,
  readTask,
  saveAgentPrompt,
  taskCanCancel,
  taskCanRetry,
  taskLabels,
  taskNeedsAttention,
  taskTreeRows,
  type AgentPrompt,
  type AgentRuntime,
  type CreateTask,
  type PromptRole,
  type Task,
  type TaskDetail,
  type TaskEvent,
} from "./task-client";
import "./tasks.css";

const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The request could not be completed.";
const requestId = () => crypto.randomUUID();
const dateLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};
function pathTaskId(path: string) {
  try {
    return decodeURIComponent(path.split("/")[2] || "");
  } catch {
    return "";
  }
}
function mergeTasks(current: Task[], incoming: Task[]) {
  const byId = new Map(current.map((task) => [task.id, task]));
  incoming.forEach((task) => byId.set(task.id, task));
  return [...byId.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export default function Tasks({
  path,
  navigate,
}: {
  path: string;
  navigate: (path: string) => void;
}) {
  const workspace = useWorkspace();
  if (workspace.mode !== "server")
    return (
      <section className="tasks-page">
        <h1 className="page-title">Tasks</h1>
        <p>
          Tasks need the local API service. Open the app in server mode to
          create and run work.
        </p>
      </section>
    );
  return (
    <TaskWorkspace
      key={workspace.state.active}
      workspaceId={workspace.state.active}
      agents={workspace.data.agents.filter((agent) => !agent.archived)}
      flush={workspace.flush}
      reloadWorkspace={workspace.reload}
      path={path}
      navigate={navigate}
    />
  );
}

function TaskWorkspace({
  workspaceId,
  agents,
  flush,
  reloadWorkspace,
  path,
  navigate,
}: {
  workspaceId: string;
  agents: DemoAgent[];
  flush: () => Promise<void>;
  reloadWorkspace: () => Promise<void>;
  path: string;
  navigate: (path: string) => void;
}) {
  const [runtime, setRuntime] = useState<AgentRuntime | null>(null),
    [runtimeError, setRuntimeError] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]),
    [listLoading, setListLoading] = useState(true),
    [listError, setListError] = useState("");
  const [detail, setDetail] = useState<TaskDetail | null>(null),
    [detailLoading, setDetailLoading] = useState(false),
    [detailError, setDetailError] = useState("");
  const [reload, setReload] = useState(0),
    [runtimeReload, setRuntimeReload] = useState(0);
  const [createOpen, setCreateOpen] = useState(false),
    [promptOpen, setPromptOpen] = useState(false),
    [filter, setFilter] = useState("all");
  const [text, setText] = useState(""),
    [model, setModel] = useState(""),
    [agentId, setAgentId] = useState(""),
    [pluginIds, setPluginIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false),
    [createError, setCreateError] = useState("");
  const [mutatingTasks, setMutatingTasks] = useState<string[]>([]),
    [actionError, setActionError] = useState("");
  const [workspaceSyncError, setWorkspaceSyncError] = useState("");
  const mounted = useRef(true),
    flushRef = useRef(flush),
    reloadWorkspaceRef = useRef(reloadWorkspace),
    initialized = useRef(false);
  flushRef.current = flush;
  reloadWorkspaceRef.current = reloadWorkspace;
  const terminalVersions = useRef(new Map<string, string>()),
    workspaceSyncLock = useRef(false);
  const detailVersion = useRef(0),
    listVersion = useRef(0),
    mutationLock = useRef(new Set<string>());
  const newRequest = useRef<{ signature: string; id: string }>();
  const createLock = useRef(false);
  const draft = useRef({ text, model, agentId, pluginIds });
  draft.current = { text, model, agentId, pluginIds };
  const selectedId =
    pathTaskId(path) ||
    tasks.find((task) => !task.parentTaskId)?.id ||
    tasks[0]?.id ||
    "";
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const selected = detail?.task.id === selectedId ? detail : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setRuntimeError("");
    void (async () => {
      try {
        await flushRef.current();
        const result = await readAgentRuntime(workspaceId, controller.signal);
        if (controller.signal.aborted) return;
        setRuntime(result);
        if (!initialized.current) {
          initialized.current = true;
          setModel(result.models[0] || "");
          setPluginIds(
            result.plugins
              .filter((plugin) => plugin.available && plugin.defaultEnabled)
              .map((plugin) => plugin.id),
          );
        }
      } catch (error) {
        if (!controller.signal.aborted) setRuntimeError(errorText(error));
      }
    })();
    return () => controller.abort();
  }, [workspaceId, runtimeReload]);
  async function syncTaskOutputs(incoming: Task[], retry = false) {
    if (!mounted.current || workspaceSyncLock.current) return;
    const changed = incoming
      .filter((task) =>
        ["succeeded", "failed", "cancelled"].includes(task.status),
      )
      .map(
        (task) =>
          [
            task.id,
            `${task.status}:${task.updatedAt}:${task.stepCount}:${task.toolCount}`,
          ] as const,
      )
      .filter(([id, version]) => terminalVersions.current.get(id) !== version);
    if (!retry && !changed.length) return;
    workspaceSyncLock.current = true;
    // Remember attempted versions as well as successful ones. A failed local
    // save must not trigger a reload loop or discard edits on the next poll.
    changed.forEach(([id, version]) =>
      terminalVersions.current.set(id, version),
    );
    try {
      await flushRef.current();
      if (!mounted.current) return;
      await reloadWorkspaceRef.current();
      if (mounted.current) setWorkspaceSyncError("");
    } catch (error) {
      if (mounted.current) setWorkspaceSyncError(errorText(error));
    } finally {
      workspaceSyncLock.current = false;
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = ++listVersion.current;
      try {
        await flushRef.current();
        const result = await listTasks(workspaceId, controller.signal);
        if (!controller.signal.aborted && version === listVersion.current) {
          setTasks(result.tasks);
          setListError("");
          await syncTaskOutputs(result.tasks);
        }
      } catch (error) {
        if (!controller.signal.aborted && version === listVersion.current)
          setListError(errorText(error));
      } finally {
        if (!controller.signal.aborted) {
          setListLoading(false);
          timer = setTimeout(poll, document.hidden ? 10000 : 2000);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [workspaceId, reload]);
  useEffect(() => {
    setDetail((current) => (current?.task.id === selectedId ? current : null));
    setDetailError("");
    setActionError("");
    setDetailLoading(!!selectedId);
    if (!selectedId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = ++detailVersion.current;
      try {
        const result = await readTask(
          workspaceId,
          selectedId,
          controller.signal,
        );
        if (!controller.signal.aborted && version === detailVersion.current) {
          setDetail(result);
          setDetailError("");
          // A result can arrive before the next list poll. Refresh its saved
          // outputs before the user leaves the task for the Library.
          await syncTaskOutputs([result.task, ...result.children]);
        }
      } catch (error) {
        if (!controller.signal.aborted && version === detailVersion.current)
          setDetailError(errorText(error));
      } finally {
        if (!controller.signal.aborted) {
          setDetailLoading(false);
          timer = setTimeout(poll, document.hidden ? 10000 : 1500);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [workspaceId, selectedId, reload]);

  function acceptTask(task: Task) {
    if (!mounted.current || task.workspaceId !== workspaceId) return;
    listVersion.current++;
    setTasks((current) => mergeTasks(current, [task]));
    if (selectedRef.current === task.id) {
      detailVersion.current++;
      setDetail((current) =>
        current?.task.id === task.id ? { ...current, task } : current,
      );
    }
  }
  async function submitTask(event: FormEvent) {
    event.preventDefault();
    if (createLock.current || !text.trim() || !runtime?.configured) return;
    const fields = {
      text: text.trim(),
      model,
      agentId,
      pluginIds: [...pluginIds].sort(),
    };
    const signature = JSON.stringify(fields);
    if (newRequest.current?.signature !== signature)
      newRequest.current = { signature, id: requestId() };
    const body: CreateTask = {
      workspaceId,
      text: fields.text,
      requestId: newRequest.current.id,
      pluginIds: fields.pluginIds,
      ...(model ? { model } : {}),
      ...(agentId ? { agentId } : {}),
    };
    createLock.current = true;
    setCreating(true);
    setCreateError("");
    try {
      await flushRef.current();
      if (!mounted.current) return;
      const result = await createTask(body);
      if (!mounted.current) return;
      newRequest.current = undefined;
      acceptTask(result.task);
      const current = draft.current;
      if (
        JSON.stringify({
          text: current.text.trim(),
          model: current.model,
          agentId: current.agentId,
          pluginIds: [...current.pluginIds].sort(),
        }) === signature
      ) {
        setText("");
        setCreateOpen(false);
      }
      navigate("/tasks/" + encodeURIComponent(result.task.id));
    } catch (error) {
      if (mounted.current) setCreateError(errorText(error));
    } finally {
      createLock.current = false;
      if (mounted.current) setCreating(false);
    }
  }
  async function taskAction(
    task: Task,
    action: "cancel" | "retry",
    effectId?: string,
    decision?: "approve" | "deny",
  ) {
    if (mutationLock.current.has(task.id)) return;
    mutationLock.current.add(task.id);
    setMutatingTasks((current) => [...current, task.id]);
    setActionError("");
    try {
      const result =
        effectId && decision
          ? await decideTaskApproval(workspaceId, task.id, effectId, decision)
          : await changeTask(workspaceId, task.id, action);
      acceptTask(result.task);
    } catch (error) {
      if (mounted.current && selectedRef.current === task.id)
        setActionError(errorText(error));
    } finally {
      mutationLock.current.delete(task.id);
      if (mounted.current)
        setMutatingTasks((current) => current.filter((id) => id !== task.id));
    }
  }
  const rootCount = tasks.filter((task) => !task.parentTaskId).length;
  const attentionCount = tasks.filter(taskNeedsAttention).length;
  const rows = taskTreeRows(tasks).filter(
    ({ task }) => filter !== "attention" || taskNeedsAttention(task),
  );
  const showComposer =
    createOpen || (!listLoading && !listError && !tasks.length);
  return (
    <section className="tasks-page">
      <header className="tasks-header">
        <div>
          <p className="tasks-eyebrow">Workspace</p>
          <h1 className="page-title">Tasks</h1>
          <p className="tasks-subtitle">
            Give work a goal. Follow progress and add details as it runs.
          </p>
        </div>
        <div className="tasks-actions">
          <button
            className="btn"
            aria-expanded={promptOpen}
            onClick={() => setPromptOpen((value) => !value)}
          >
            <Settings2 size={15} /> Prompt settings
          </button>
          <button
            className="btn primary"
            onClick={() => {
              setCreateOpen(true);
              setTimeout(
                () => document.getElementById("new-task-description")?.focus(),
                0,
              );
            }}
          >
            <Plus size={16} /> New task
          </button>
        </div>
      </header>
      {workspaceSyncError && (
        <div className="tasks-error" role="alert">
          <span>
            Task outputs could not be refreshed. Your local changes have been
            kept. {workspaceSyncError}
          </span>
          <button
            className="btn small"
            onClick={() => void syncTaskOutputs(tasks, true)}
          >
            Retry workspace sync
          </button>
        </div>
      )}
      {runtimeError && (
        <div className="tasks-error" role="alert">
          <span>{runtimeError}</span>
          <button
            className="btn small"
            onClick={() => setRuntimeReload((value) => value + 1)}
          >
            Retry configuration
          </button>
        </div>
      )}
      {runtime && !runtime.configured && (
        <p className="tasks-notice" role="status">
          Connect a model in the server configuration to run tasks. Existing
          tasks and results remain available.
        </p>
      )}
      {promptOpen && (
        <PromptSettings
          workspaceId={workspaceId}
          prompts={runtime?.prompts || []}
          onSaved={(prompt) => {
            if (!mounted.current) return;
            setRuntime((current) =>
              current
                ? {
                    ...current,
                    prompts: current.prompts.map((item) =>
                      item.role === prompt.role ? prompt : item,
                    ),
                  }
                : current,
            );
          }}
          onRefresh={() => setRuntimeReload((value) => value + 1)}
          onClose={() => setPromptOpen(false)}
        />
      )}
      {showComposer && (
        <form
          className="tasks-compose"
          onSubmit={submitTask}
          aria-label="New task"
        >
          <div className="tasks-section-heading">
            <h2>What would you like done?</h2>
            {tasks.length > 0 && (
              <button
                type="button"
                className="icon-button"
                aria-label="Close new task"
                onClick={() => setCreateOpen(false)}
              >
                <X size={17} />
              </button>
            )}
          </div>
          <label className="tasks-label" htmlFor="new-task-description">
            Task description
          </label>
          <textarea
            id="new-task-description"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={12000}
            rows={3}
            placeholder="Describe the result you need and any constraints…"
            required
          />
          <div className="tasks-form-row">
            <label className="tasks-field">
              Model
              <select
                aria-label="Model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={!runtime?.models.length}
              >
                {!runtime?.models.length && (
                  <option value="">Loading models…</option>
                )}
                {runtime?.models.map((name) => (
                  <option value={name} key={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="tasks-field">
              Agent
              <select
                aria-label="Agent"
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
              >
                <option value="">Default worker</option>
                {agents.map((agent) => (
                  <option value={agent.id} key={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              <small>Instructions for delegated work</small>
            </label>
          </div>
          <fieldset className="tasks-plugins">
            <legend>Plugins for this task</legend>
            {runtime ? (
              runtime.plugins.length ? (
                runtime.plugins.map((plugin) => (
                  <label
                    className={
                      "tasks-plugin" +
                      (pluginIds.includes(plugin.id) ? " selected" : "") +
                      (!plugin.available ? " unavailable" : "")
                    }
                    key={plugin.id}
                  >
                    <input
                      type="checkbox"
                      checked={pluginIds.includes(plugin.id)}
                      disabled={!plugin.available}
                      onChange={(event) =>
                        setPluginIds((current) =>
                          event.target.checked
                            ? [...new Set([...current, plugin.id])]
                            : current.filter((id) => id !== plugin.id),
                        )
                      }
                    />
                    <span>
                      <strong>{plugin.name}</strong>
                      <small>{plugin.description}</small>
                      <span className="tasks-plugin-count">
                        {plugin.available
                          ? `${plugin.tools.length} tools`
                          : "Unavailable"}
                      </span>
                    </span>
                  </label>
                ))
              ) : (
                <p className="tasks-muted">No plugins are registered.</p>
              )
            ) : (
              <p className="tasks-muted">Loading available plugins…</p>
            )}
          </fieldset>
          {createError && (
            <p className="tasks-error" role="alert">
              {createError}
            </p>
          )}
          <div className="tasks-compose-footer">
            <span className="tasks-muted">
              You can add instructions after the task starts.
            </span>
            <button
              className="btn primary"
              type="submit"
              disabled={
                creating || !text.trim() || !runtime?.configured || !model
              }
            >
              {creating ? "Creating…" : "Create task"}
              <ArrowUpRight size={15} />
            </button>
          </div>
        </form>
      )}
      <div className="tasks-layout">
        <aside className="tasks-list-panel" aria-label="Task list">
          <div className="tasks-list-heading">
            <div>
              <strong>Your tasks</strong>
              <span className="tasks-count">{rootCount}</span>
            </div>
            <button
              className="icon-button"
              aria-label="Refresh tasks"
              onClick={() => setReload((value) => value + 1)}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <div className="tasks-filters" aria-label="Task filters">
            <button
              className={filter === "all" ? "active" : ""}
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
            >
              All
            </button>
            <button
              className={filter === "attention" ? "active" : ""}
              aria-pressed={filter === "attention"}
              onClick={() => setFilter("attention")}
            >
              Needs attention
              {attentionCount > 0 && <span>{attentionCount}</span>}
            </button>
          </div>
          {listError && (
            <p className="tasks-error compact" role="alert">
              {listError}
            </p>
          )}
          {listLoading && (
            <p className="tasks-muted tasks-list-empty" role="status">
              Loading tasks…
            </p>
          )}
          {!listLoading && rows.length === 0 && (
            <p className="tasks-muted tasks-list-empty">
              {filter === "attention"
                ? "Nothing needs your attention."
                : listError
                  ? "Task list unavailable."
                  : "Your tasks will appear here."}
            </p>
          )}
          <ul className="tasks-list">
            {rows.map(({ task, depth }) => (
              <li key={task.id}>
                <button
                  className={
                    "tasks-list-item" +
                    (selectedId === task.id ? " selected" : "")
                  }
                  style={{ paddingLeft: 14 + depth * 14 }}
                  onClick={() =>
                    navigate("/tasks/" + encodeURIComponent(task.id))
                  }
                  aria-current={selectedId === task.id ? "true" : undefined}
                >
                  <span className="tasks-item-title">
                    {depth > 0 && <GitBranch size={12} />}
                    <strong>{task.title || task.goal}</strong>
                  </span>
                  <TaskStatusBadge task={task} />
                  <time dateTime={task.updatedAt}>
                    {dateLabel(task.updatedAt)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <div className="tasks-detail-panel" aria-label="Task details">
          {detailError && (
            <div className="tasks-error" role="alert">
              <span>{detailError}</span>
              <button
                className="btn small"
                onClick={() => setReload((value) => value + 1)}
              >
                Retry loading
              </button>
            </div>
          )}
          {selected ? (
            <>
              <div className="tasks-detail-heading">
                <div>
                  <div className="tasks-detail-status">
                    <TaskStatusBadge task={selected.task} />
                    {selected.task.parentTaskId && (
                      <button
                        className="tasks-parent-link"
                        onClick={() =>
                          navigate(
                            "/tasks/" +
                              encodeURIComponent(selected.task.parentTaskId!),
                          )
                        }
                      >
                        <GitBranch size={13} /> Parent task
                      </button>
                    )}
                  </div>
                  <h2>{selected.task.title || "Task"}</h2>
                </div>
                <div className="tasks-actions">
                  {taskCanRetry(selected.task) && (
                    <button
                      className="btn small"
                      disabled={mutatingTasks.includes(selected.task.id)}
                      onClick={() => void taskAction(selected.task, "retry")}
                    >
                      <RotateCcw size={14} /> Retry task
                    </button>
                  )}
                  {taskCanCancel(selected.task) && (
                    <button
                      className="btn small"
                      disabled={mutatingTasks.includes(selected.task.id)}
                      onClick={() => void taskAction(selected.task, "cancel")}
                    >
                      <Square size={12} /> Cancel task
                    </button>
                  )}
                </div>
              </div>
              <p className="tasks-goal">{selected.task.goal}</p>
              <div className="tasks-meta">
                <span>{selected.task.model}</span>
                <span>{selected.task.stepCount} steps</span>
                <span>{selected.task.toolCount} tool calls</span>
                <time dateTime={selected.task.updatedAt}>
                  Updated {dateLabel(selected.task.updatedAt)}
                </time>
              </div>
              {actionError && (
                <p className="tasks-error" role="alert">
                  {actionError}
                </p>
              )}
              {selected.task.error && (
                <p className="tasks-error" role="alert">
                  {selected.task.error}
                </p>
              )}
              {selected.task.question &&
                selected.task.status === "waiting_input" && (
                  <section
                    className="tasks-question"
                    aria-label="Question for you"
                  >
                    <h3>A question for you</h3>
                    <p>{selected.task.question}</p>
                    <small>Reply in Additional instructions below.</small>
                  </section>
                )}
              {selected.task.approvals.length > 0 && (
                <section
                  className="tasks-approval-list"
                  aria-label="Task approvals"
                >
                  {selected.task.approvals.map((approval) => (
                    <article className="tasks-approval" key={approval.id}>
                      <div className="tasks-section-heading">
                        <h3>
                          {approval.status === "awaiting_approval"
                            ? "Review action"
                            : "Action outcome unconfirmed"}
                        </h3>
                        <span className="tasks-muted">
                          {approval.status === "awaiting_approval"
                            ? "Awaiting approval"
                            : "Needs review"}
                        </span>
                      </div>
                      <strong>{approval.tool}</strong>
                      <pre>{JSON.stringify(approval.args, null, 2)}</pre>
                      {approval.status === "unknown" && (
                        <p className="tasks-muted">
                          Check the action's destination and add what happened
                          below before continuing.
                        </p>
                      )}
                      {approval.status === "awaiting_approval" &&
                        selected.task.status !== "cancelled" && (
                          <div className="tasks-actions">
                            <button
                              className="btn primary small"
                              disabled={mutatingTasks.includes(
                                selected.task.id,
                              )}
                              onClick={() =>
                                void taskAction(
                                  selected.task,
                                  "cancel",
                                  approval.id,
                                  "approve",
                                )
                              }
                              aria-label={"Approve " + approval.tool}
                            >
                              Approve
                            </button>
                            <button
                              className="btn small"
                              disabled={mutatingTasks.includes(
                                selected.task.id,
                              )}
                              onClick={() =>
                                void taskAction(
                                  selected.task,
                                  "cancel",
                                  approval.id,
                                  "deny",
                                )
                              }
                              aria-label={"Deny " + approval.tool}
                            >
                              Deny
                            </button>
                          </div>
                        )}
                    </article>
                  ))}
                </section>
              )}
              <TaskUpdates
                key={selected.task.id}
                task={selected.task}
                workspaceId={workspaceId}
                onTask={acceptTask}
              />
              {selected.children.length > 0 && (
                <section className="tasks-children" aria-label="Subtasks">
                  <h3>
                    <GitBranch size={15} /> Subtasks
                  </h3>
                  <ul>
                    {selected.children.map((child) => (
                      <li key={child.id}>
                        <button
                          onClick={() =>
                            navigate("/tasks/" + encodeURIComponent(child.id))
                          }
                        >
                          <span>{child.title || child.goal}</span>
                          <TaskStatusBadge task={child} />
                          <ChevronRight size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <section className="tasks-result" aria-label="Task result">
                <h3>
                  {selected.task.status === "succeeded"
                    ? "Result"
                    : "Latest output"}
                </h3>
                {selected.task.output ? (
                  <AnswerMarkdown content={selected.task.output} />
                ) : (
                  <p className="tasks-muted">
                    {selected.task.status === "queued"
                      ? "This task is queued. Progress will appear here when it starts."
                      : selected.task.status === "running" ||
                          selected.task.status === "waiting_children"
                        ? "Work is in progress. You can leave this page and return later."
                        : "No output has been saved yet."}
                  </p>
                )}
              </section>
              <details className="tasks-history">
                <summary>
                  Instructions <span>{selected.inputs.length}</span>
                </summary>
                <ol>
                  {selected.inputs.map((input) => (
                    <li key={input.id}>
                      <div>
                        <strong>
                          {input.source === "user" ? "You" : input.source}
                        </strong>
                        <time dateTime={input.createdAt}>
                          {dateLabel(input.createdAt)}
                        </time>
                        <span>
                          {input.consumed ? "Received by task" : "Queued"}
                        </span>
                      </div>
                      <p>{input.text}</p>
                    </li>
                  ))}
                </ol>
              </details>
              <details className="tasks-history">
                <summary>
                  Activity <span>{selected.events.length}</span>
                </summary>
                <ol>
                  {selected.events.map((event) => (
                    <li key={event.seq}>
                      <div>
                        <strong>{event.type.replaceAll("_", " ")}</strong>
                        <time dateTime={event.createdAt}>
                          {dateLabel(event.createdAt)}
                        </time>
                      </div>
                      <p>{eventDescription(event)}</p>
                    </li>
                  ))}
                </ol>
                {selected.events.length === 0 && (
                  <p className="tasks-muted">No activity recorded yet.</p>
                )}
              </details>
              <details className="tasks-history tasks-configuration">
                <summary>Task configuration</summary>
                <dl>
                  <dt>Task ID</dt>
                  <dd>{selected.task.id}</dd>
                  <dt>Prompt version</dt>
                  <dd>{selected.task.promptVersion}</dd>
                  <dt>Plugins</dt>
                  <dd>
                    {selected.task.pluginIds
                      .map(
                        (id) =>
                          runtime?.plugins.find((plugin) => plugin.id === id)
                            ?.name || id,
                      )
                      .join(", ") || "None"}
                  </dd>
                </dl>
              </details>
            </>
          ) : (
            <div className="tasks-detail-empty">
              <Workflow size={32} strokeWidth={1.4} />
              <h2>
                {detailLoading ? "Loading task…" : "A place for ongoing work"}
              </h2>
              <p>
                {detailLoading
                  ? "Reading the latest saved state."
                  : "Create a task or select one to see its progress, subtasks and results."}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function TaskStatusBadge({ task }: { task: Task }) {
  return (
    <span className={"tasks-status status-" + task.status}>
      {task.status === "succeeded" ? (
        <Check size={11} />
      ) : task.status === "queued" ? (
        <Clock size={11} />
      ) : (
        <span className="tasks-status-dot" />
      )}
      {taskLabels[task.status] || task.status}
    </span>
  );
}

function TaskUpdates({
  task,
  workspaceId,
  onTask,
}: {
  task: Task;
  workspaceId: string;
  onTask: (task: Task) => void;
}) {
  const [text, setText] = useState(""),
    [sending, setSending] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const alive = useRef(true),
    sendingRef = useRef(false),
    currentText = useRef(text),
    pending = useRef<{ text: string; id: string }>();
  currentText.current = text;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = text.trim();
    if (sendingRef.current || !content || task.status === "cancelled") return;
    if (pending.current?.text !== content)
      pending.current = { text: content, id: requestId() };
    sendingRef.current = true;
    setSending(true);
    setError("");
    setNotice("");
    try {
      const result = await addTaskInput(
        workspaceId,
        task.id,
        content,
        pending.current.id,
      );
      pending.current = undefined;
      if (!alive.current) return;
      onTask(result.task);
      if (currentText.current.trim() === content) setText("");
      setNotice("Update saved. The task will read it at the next step.");
    } catch (failure) {
      if (alive.current) setError(errorText(failure));
    } finally {
      sendingRef.current = false;
      if (alive.current) setSending(false);
    }
  }
  return (
    <form className="tasks-update" onSubmit={submit}>
      <label htmlFor={"task-update-" + task.id}>Additional instructions</label>
      <textarea
        id={"task-update-" + task.id}
        aria-label="Additional instructions"
        rows={2}
        maxLength={12000}
        placeholder={
          task.status === "waiting_input"
            ? "Answer the question or add details…"
            : "Add a constraint, correct the direction, or ask for an update…"
        }
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setNotice("");
        }}
      />
      <div className="tasks-update-footer">
        <span className="tasks-muted">
          {task.status === "cancelled"
            ? "This task was cancelled. Create a new task to continue."
            : "Updates stay with this task."}
        </span>
        <button
          type="submit"
          className="btn small"
          disabled={sending || !text.trim() || task.status === "cancelled"}
        >
          {sending ? "Sending…" : "Send update"}
          <Send size={13} />
        </button>
      </div>
      {error && (
        <p className="tasks-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="tasks-success" role="status">
          {notice}
        </p>
      )}
    </form>
  );
}

function eventDescription(event: TaskEvent) {
  if (typeof event.text === "string") return event.text;
  return [event.message, event.error, event.tool, event.status]
    .filter((value): value is string => typeof value === "string")
    .join(" · ");
}

function PromptSettings({
  workspaceId,
  prompts,
  onSaved,
  onRefresh,
  onClose,
}: {
  workspaceId: string;
  prompts: AgentPrompt[];
  onSaved: (prompt: AgentPrompt) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [role, setRole] = useState<PromptRole>("router");
  const [drafts, setDrafts] = useState<
    Partial<Record<PromptRole, { content: string; revision: number }>>
  >({});
  const [busy, setBusy] = useState<PromptRole | "">(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const alive = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const prompt = prompts.find((item) => item.role === role),
    draft = drafts[role];
  const content = draft?.content ?? prompt?.content ?? "";
  const dirty = !!prompt && content !== prompt.content;
  async function save(reset: boolean) {
    if (!prompt || lock.current) return;
    const currentRole = role,
      before = content,
      revision = draft?.revision ?? prompt.revision;
    lock.current = true;
    setBusy(currentRole);
    setError("");
    setNotice("");
    try {
      const result = await saveAgentPrompt(
        workspaceId,
        currentRole,
        reset ? null : before,
        revision,
      );
      onSaved(result.prompt);
      if (!alive.current) return;
      setDrafts((current) => ({
        ...current,
        [currentRole]: {
          content:
            current[currentRole] && current[currentRole]!.content !== before
              ? current[currentRole]!.content
              : result.prompt.content,
          revision: result.prompt.revision,
        },
      }));
      setNotice(
        reset
          ? "Default prompt restored for new tasks."
          : "Prompt saved for new tasks.",
      );
    } catch (failure) {
      if (alive.current) setError(errorText(failure));
    } finally {
      lock.current = false;
      if (alive.current) setBusy("");
    }
  }
  return (
    <section className="tasks-prompts" aria-label="Prompt settings">
      <div className="tasks-section-heading">
        <div>
          <h2>Built-in prompts</h2>
          <p>
            New tasks use the saved prompt. Existing tasks keep their recorded
            version.
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="Close prompt settings"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </div>
      <div className="tasks-prompt-toolbar">
        <label className="tasks-field">
          Built-in prompt
          <select
            value={role}
            aria-label="Built-in prompt"
            onChange={(event) => {
              setRole(event.target.value as PromptRole);
              setError("");
              setNotice("");
            }}
          >
            <option value="router">Router · plans and coordinates</option>
            <option value="worker">Worker · carries out a task</option>
          </select>
        </label>
        {prompt && (
          <div className="tasks-prompt-version">
            <span>
              {prompt.content === prompt.defaultContent
                ? "Default prompt"
                : "Customized prompt"}
            </span>
            <small title={prompt.version}>
              Version {prompt.version.slice(0, 12)} · revision {prompt.revision}
            </small>
          </div>
        )}
      </div>
      {prompt ? (
        <>
          <p className="tasks-muted">{prompt.description}</p>
          <label className="tasks-label" htmlFor="task-prompt-content">
            Prompt instructions
          </label>
          <textarea
            id="task-prompt-content"
            aria-label="Prompt instructions"
            rows={12}
            maxLength={16000}
            value={content}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [role]: {
                  content: event.target.value,
                  revision: current[role]?.revision ?? prompt.revision,
                },
              }))
            }
          />
          <div className="tasks-prompt-buttons">
            <span className="tasks-muted">
              {dirty ? "Unsaved changes" : "Saved"}
            </span>
            <button
              className="btn small"
              disabled={
                !!busy || (!dirty && prompt.content === prompt.defaultContent)
              }
              onClick={() => void save(true)}
            >
              <RotateCcw size={13} /> Restore default
            </button>
            <button
              className="btn primary small"
              disabled={!!busy || !dirty || !content.trim()}
              onClick={() => void save(false)}
            >
              {busy === role ? "Saving…" : "Save prompt"}
            </button>
          </div>
          <details className="tasks-default-prompt">
            <summary>View built-in default</summary>
            <pre>{prompt.defaultContent}</pre>
          </details>
        </>
      ) : (
        <p className="tasks-muted">Loading prompts…</p>
      )}
      {error && (
        <div className="tasks-error" role="alert">
          <span>{error}</span>
          <button className="btn small" onClick={onRefresh}>
            Refresh saved version
          </button>
          {prompt && (
            <button
              className="btn small"
              onClick={() => {
                setDrafts((current) => ({
                  ...current,
                  [role]: {
                    content: prompt.content,
                    revision: prompt.revision,
                  },
                }));
                setError("");
              }}
            >
              Load saved prompt
            </button>
          )}
        </div>
      )}
      {notice && (
        <p className="tasks-success" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
