import { TaskActivity } from "./V1Activity";
import { useEffect, useRef, useState } from "react";
import { PanelRightClose, PanelRightOpen, Download } from "lucide-react";
import { Composer, IconButton } from "./ui";
import AnswerMarkdown from "./AnswerMarkdown";
import ArtifactCanvas from "./ArtifactCanvas";
import { useWorkspace } from "./workspace";
import type { Artifact } from "./local-model";
import type { CanvasPreferences, MessageContext, Navigate } from "./types";
import {
  v1,
  V1Error,
  assistantText,
  artifactKind,
  fileUrl,
  submitTask,
  stateLabel,
  terminal,
  type Conversation,
  type Task,
  type TaskEvent,
  type ArtifactDetail,
} from "./v1-client";
import "./real-thread.css";
import "./v1-adapter.css";

export default function V1Thread({
  id,
  navigate,
  notify,
}: {
  id: string;
  navigate: Navigate;
  notify: (message: string) => void;
}) {
  const w = useWorkspace();
  const [conversation, setConversation] = useState<Conversation>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactDetail[]>([]);
  const [selected, setSelected] = useState("");
  const [version, setVersion] = useState("");
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [canvas, setCanvas] = useState<CanvasPreferences>({
    layout: "focus",
    hidden: [],
    order: [],
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false);
  const [prefill, setPrefill] = useState<{ id: string; text: string }>();
  const [refresh, setRefresh] = useState(0);
  const latest = tasks[0];
  const cursors = useRef(new Map<string, string>());
  const known = useRef(new Map<string, TaskEvent>());
  const signature = useRef("");
  const canvasLoaded = useRef(false);
  const canvasQueue = useRef(Promise.resolve());
  const canvasClosed = collapsed || artifacts.length === 0;
  const saveCanvas = (next: CanvasPreferences) => {
    setCanvas(next);
    if (next.collapsed !== undefined) setCollapsed(next.collapsed);
    if (w.role === "viewer") return;
    canvasQueue.current = canvasQueue.current
      .catch(() => {})
      .then(async () => {
        const fresh = await v1<Conversation>("/conversations/" + id);
        await v1("/conversations/" + id, {
          method: "PATCH",
          body: { revision: fresh.revision, metadata: { canvas: next } },
        });
      });
    void canvasQueue.current.catch((e) => setError(e.message));
  };
  useEffect(() => {
    const controller = new AbortController(),
      signal = controller.signal;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [detail, all] = await Promise.all([
          v1<Conversation>("/conversations/" + id, { signal }),
          v1<Task[]>("/tasks?conversationId=" + id, { signal }),
        ]);
        const own = all.filter((t) => t.conversationId === id);
        if (signal.aborted) return;
        setConversation(detail);
        if (!canvasLoaded.current) {
          canvasLoaded.current = true;
          if (detail.metadata?.canvas) {
            setCanvas(detail.metadata.canvas);
            setCollapsed(!!detail.metadata.canvas.collapsed);
          }
        }
        setTasks(own);
        // Drain every page before advancing the cursor. Each reconnect resumes after
        // the last acknowledged event; deduplication also handles repeated responses.
        for (const ownTask of own) {
          const taskId = ownTask.id;
          if (terminal(ownTask.state) && cursors.current.has(taskId)) continue;
          let cursor = cursors.current.get(taskId) || "0";
          for (;;) {
            const page = await v1<{ events: TaskEvent[]; nextCursor: string }>(
              `/tasks/${taskId}/events?after=${cursor}&limit=100`,
              { signal },
            );
            if (signal.aborted) return;
            for (const row of page.events)
              known.current.set(row.id, { ...row, taskId });
            cursors.current.set(taskId, page.nextCursor);
            if (page.events.length < 100 || page.nextCursor === cursor) break;
            cursor = page.nextCursor;
          }
          setEvents(
            [...known.current.values()].sort(
              (a, b) => Number(a.id) - Number(b.id),
            ),
          );
        }
        const nextSignature = JSON.stringify([detail.artifacts, own]);
        if (nextSignature !== signature.current) {
          const details = await Promise.all(
            detail.artifacts.map((a) =>
              v1<ArtifactDetail>("/artifacts/" + a.id, { signal }),
            ),
          );
          if (signal.aborted) return;
          setArtifacts(details);
          setSelected((current) =>
            details.some((a) => a.id === current)
              ? current
              : details[0]?.id || "",
          );
          signature.current = nextSignature;
        }
        setReady(true);
        setError("");
      } catch (e) {
        if (!signal.aborted) {
          setError(e instanceof Error ? e.message : "Connection interrupted");
          setReady(false);
        }
      } finally {
        if (!signal.aborted) timer = setTimeout(poll, 4000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, refresh]);
  async function send(text: string, context?: MessageContext, key?: string) {
    // Recheck immediately before sending so another tab's run is not missed.
    const current = (await v1<Task[]>("/tasks?conversationId=" + id)).find(
      (t) =>
        t.conversationId === id &&
        !terminal(t.state) &&
        t.state !== "uncertain",
    );
    if (current) {
      if (
        context &&
        (context.attachments.length ||
          context.settings.agentId ||
          context.projectId ||
          context.skillIds.length ||
          context.memoryIds.length ||
          context.artifactIds.length ||
          context.rubricIds?.length)
      )
        throw Error(
          "Files and context can be changed for the next task after this run ends. Clear the context selections to send a text instruction now.",
        );
      await v1("/tasks/" + current.id + "/instructions", {
        method: "POST",
        body: { message: text },
      });
    } else await submitTask(text, context, key, id);
    setVersion("");
    setRefresh((n) => n + 1);
  }
  const active =
    latest && !terminal(latest.state) && latest.state !== "uncertain";
  const chosen = artifacts.find((a) => a.id === selected);
  const chosenVersion =
    chosen?.versions.find((v) => String(v.version) === version) ||
    chosen?.versions[0];
  const canvasArtifacts: Artifact[] = artifacts.map((a) => ({
    id: a.id,
    title: a.name,
    kind: artifactKind(a.name.split(".").at(-1) || "txt"),
    content: "",
    versions: [],
    createdAt: a.versions.at(-1)?.created_at || "",
    updatedAt: a.versions[0]?.created_at || "",
    threadId: id,
  }));
  const visible = canvasArtifacts.filter((a) =>
    a.title.toLowerCase().includes(search.toLowerCase()),
  );
  const select = (value: string) => {
    setSelected(value);
    setVersion("");
    return true;
  };
  if (!conversation)
    return (
      <section className="backend-loading" role="status">
        <h1>{error || "Loading conversation…"}</h1>
      </section>
    );
  return (
    <div
      className="real-thread"
      data-conversation-id={id}
      data-task-id={latest?.id}
      data-task-state={latest?.state}
    >
      <header className="rt-header">
        <div className="rt-title">
          <h1>{conversation.title}</h1>
        </div>
        <div className="rt-actions">
          <span className="rt-header-model">
            {w.capabilities?.models.find((m) => m.configured)?.model ||
              "Model unavailable"}
          </span>
          <IconButton
            label={canvasClosed ? "Show canvas" : "Hide canvas"}
            onClick={() => saveCanvas({ ...canvas, collapsed: !canvasClosed })}
          >
            {canvasClosed ? (
              <PanelRightOpen size={17} />
            ) : (
              <PanelRightClose size={17} />
            )}
          </IconButton>
          <button
            className="btn small"
            onClick={() => navigate("/workspaces")}
            title="Manage workspace access"
          >
            Team access
          </button>
        </div>
      </header>
      <details className="rt-status">
        <summary>Connection & storage</summary>
        <span>{w.activeName} · Saved to workspace</span>
        <span role="status">
          {latest ? stateLabel[latest.state] || latest.state : "Ready"}
        </span>
      </details>
      {error && (
        <p className="rt-error" role="alert">
          {error} · Reconnecting…
          <button
            className="btn small"
            onClick={() => setRefresh((n) => n + 1)}
          >
            Retry connection
          </button>
        </p>
      )}
      <div
        className={"rt-columns " + (canvasClosed ? "v1-canvas-collapsed" : "")}
      >
        <section className="rt-conversation" aria-label="Conversation">
          <div className="rt-messages">
            {[
              ...conversation.messages.map((message) => ({
                key: "m" + message.id,
                time: new Date(message.created_at).getTime(),
                message,
                task: undefined as Task | undefined,
              })),
              ...tasks.map((task) => ({
                key: "t" + task.id,
                time: new Date(task.createdAt).getTime() + 1,
                message: undefined as
                  Conversation["messages"][number] | undefined,
                task,
              })),
            ]
              .sort((a, b) => a.time - b.time)
              .map((entry) =>
                entry.task ? (
                  <TaskActivity
                    key={entry.key}
                    task={entry.task}
                    events={events.filter((e) => e.taskId === entry.task!.id)}
                    busy={busy}
                    readonly={w.role === "viewer"}
                    onRetry={() => {
                      setBusy(true);
                      void v1("/tasks/" + entry.task!.id + "/retry", {
                        method: "POST",
                      })
                        .then(() => {
                          cursors.current.delete(entry.task!.id);
                          setRefresh((n) => n + 1);
                        })
                        .catch((e) => setError(e.message))
                        .finally(() => setBusy(false));
                    }}
                    onCancel={() => {
                      setBusy(true);
                      void v1("/tasks/" + entry.task!.id + "/cancel", {
                        method: "POST",
                      })
                        .then(() => setRefresh((n) => n + 1))
                        .catch((e) => setError(e.message))
                        .finally(() => setBusy(false));
                    }}
                  />
                ) : (
                  <article
                    key={entry.key}
                    className={"rt-message " + entry.message!.role}
                  >
                    <div className="rt-message-meta">
                      <strong>
                        {entry.message!.role === "user" ? "You" : "Hyperagent"}
                      </strong>
                      <time>
                        {new Date(entry.message!.created_at).toLocaleTimeString(
                          [],
                          { hour: "2-digit", minute: "2-digit" },
                        )}
                      </time>
                    </div>
                    {entry.message!.role === "assistant" ? (
                      <div className="rt-answer">
                        <AnswerMarkdown
                          content={assistantText(entry.message!.content)}
                        />
                      </div>
                    ) : (
                      <p>{entry.message!.content}</p>
                    )}
                  </article>
                ),
              )}
            {!!artifacts.length && !active && (
              <div className="rt-followups">
                <button
                  onClick={() =>
                    setPrefill({
                      id: crypto.randomUUID(),
                      text: "继续修改当前文件：请保留原有内容并更新相同产物的版本。",
                    })
                  }
                >
                  Continue modifying these files ↗
                </button>
              </div>
            )}
          </div>
          <div className="rt-composer">
            {active && (
              <p className="rt-notice">
                Your message adds an instruction to the running task. Files can
                be attached after it ends.
              </p>
            )}
            <Composer
              compact
              key={id}
              disabled={!ready || busy || w.role === "viewer"}
              navigate={navigate}
              notify={notify}
              onSend={send}
              prefill={prefill}
            />
          </div>
        </section>
        {!canvasClosed && (
          <section className="rt-artifacts" aria-label="Thread artifacts">
            <div className="rt-section-heading">
              <h2>
                Artifacts <span>{artifacts.length}</span>
              </h2>
              <button
                className="btn small"
                disabled
                title="Ask in the conversation to create or edit files"
              >
                New document
              </button>
            </div>
            <div className="rt-artifact-filters">
              <input
                aria-label="Filter artifacts"
                placeholder="Filter artifacts…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <ArtifactCanvas
              artifacts={visible}
              allArtifacts={canvasArtifacts}
              selectedId={selected}
              value={canvas}
              onSelect={select}
              onChange={saveCanvas}
              renderPreview={(artifact) => {
                const file = artifacts.find((a) => a.id === artifact.id)
                  ?.versions[0]?.file_id;
                return file ? (
                  <ArtifactPreview key={file} fileId={file} />
                ) : (
                  <p>No saved file</p>
                );
              }}
              onDownload={(artifact) => {
                const file = artifacts.find((a) => a.id === artifact.id)
                  ?.versions[0]?.file_id;
                if (file) {
                  const link = document.createElement("a");
                  link.href = fileUrl(file);
                  link.download = artifact.title;
                  link.click();
                }
              }}
            >
              {!artifacts.length ? (
                <div className="rt-empty">
                  <h3>No linked artifacts</h3>
                  <p>Files generated in this conversation will appear here.</p>
                </div>
              ) : (
                <nav className="rt-artifact-list" aria-label="Select artifact">
                  {visible
                    .filter((a) => !canvas.hidden.includes(a.id))
                    .map((a) => (
                      <button
                        key={a.id}
                        data-artifact-id={a.id}
                        className={a.id === selected ? "active" : ""}
                        onClick={() => select(a.id)}
                      >
                        <span>{a.title}</span>
                        <small>{a.kind}</small>
                      </button>
                    ))}
                </nav>
              )}
              {chosen && chosenVersion && (
                <div className="rt-artifact-editor">
                  <div className="rt-section-heading">
                    <h3>{chosen.name}</h3>
                    <a
                      className="btn small"
                      aria-label="Download selected artifact"
                      href={fileUrl(chosenVersion.file_id)}
                      download
                    >
                      <Download size={14} />
                      Download
                    </a>
                  </div>
                  <div className="rt-artifact-filters">
                    <label>
                      Version{" "}
                      <select
                        aria-label="Artifact version"
                        value={version}
                        onChange={(e) => setVersion(e.target.value)}
                      >
                        <option value="">
                          Current version · {chosen.versions[0]?.version}
                        </option>
                        {chosen.versions.map((v) => (
                          <option key={v.version} value={v.version}>
                            Version {v.version} ·{" "}
                            {new Date(v.created_at).toLocaleString()}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {version && (
                    <p className="rt-notice">
                      Viewing version {chosenVersion.version}. Downloads use
                      this saved version.
                    </p>
                  )}
                  <ArtifactPreview
                    key={chosenVersion.file_id}
                    fileId={chosenVersion.file_id}
                  />
                </div>
              )}
            </ArtifactCanvas>
          </section>
        )}
      </div>
    </div>
  );
}

export function ArtifactPreview({ fileId }: { fileId: string }) {
  const [preview, setPreview] = useState<{
    type: string;
    text: string;
    url: string;
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    void (async () => {
      const response = await fetch(fileUrl(fileId), {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.status === 401) {
        window.dispatchEvent(new Event("backend-session-expired"));
        throw new V1Error(401, "Session expired");
      }
      if (!response.ok) throw Error("Preview unavailable");
      const blob = await response.blob();
      const text =
        blob.type.startsWith("text/") || blob.type.includes("json")
          ? await blob.text()
          : "";
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setPreview({ type: blob.type, text, url });
    })().catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [fileId]);
  if (error) return <p role="alert">{error}</p>;
  if (!preview) return <p role="status">Loading preview…</p>;
  if (preview.type.includes("pdf"))
    return (
      <iframe
        className="local-web-frame"
        title="PDF preview"
        src={preview.url}
      />
    );
  if (preview.type.startsWith("image/"))
    return <img src={preview.url} alt="Generated artifact" />;
  if (preview.type.includes("html"))
    return (
      <iframe
        className="local-web-frame"
        title="HTML preview"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={
          "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:\">" +
          preview.text
        }
      />
    );
  if (preview.type.includes("python") || preview.type.includes("javascript"))
    return <pre className="v1-code-preview">{preview.text}</pre>;
  return <AnswerMarkdown content={preview.text} />;
}
