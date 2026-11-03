import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  ChevronDown,
  LockKeyhole,
  Paperclip,
  Plus,
  SlidersHorizontal,
  X,
  Zap,
} from "lucide-react";
import { useWorkspace } from "./workspace";
import { v1 } from "./v1-client";
import { defaultThreadSettings, type FileMeta } from "./types";
import type { ComposerProps } from "./ui";

export default function V1Composer({
  onSend,
  compact = false,
  disabled = false,
  prefill,
  navigate,
}: ComposerProps) {
  const w = useWorkspace(),
    capabilities = w.capabilities;
  const [text, setText] = useState("");
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [formats, setFormats] = useState<string[]>([]);
  const [menu, setMenu] = useState("");
  const [skillIds, setSkillIds] = useState<string[]>([]),
    [memoryIds, setMemoryIds] = useState<string[]>([]),
    [artifactIds, setArtifactIds] = useState<string[]>([]),
    [rubricIds, setRubricIds] = useState<string[]>([]);
  const [agentId, setAgentId] = useState(""),
    [projectId, setProjectId] = useState("");
  const contextOptions: Record<string, { id: string; name: string }[]> = {
    skills: w.data.skills
      .filter((x) => !x.archived)
      .map((x) => ({ id: x.id, name: x.name })),
    memories: w.data.memories.map((x) => ({
      id: x.id,
      name: x.content.slice(0, 100),
    })),
    assets: w.data.artifacts.map((x) => ({ id: x.id, name: x.title })),
    rubrics: w.data.rubrics.map((x) => ({ id: x.id, name: x.name })),
  };
  const selection: Record<string, [string[], (v: string[]) => void]> = {
    skills: [skillIds, setSkillIds],
    memories: [memoryIds, setMemoryIds],
    assets: [artifactIds, setArtifactIds],
    rubrics: [rubricIds, setRubricIds],
  };
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);
  const lock = useRef(false),
    request = useRef(crypto.randomUUID()),
    previous = useRef("");
  const consumed = useRef("");
  const model = capabilities?.models.find((m) => m.configured);
  useEffect(() => {
    if (!prefill || consumed.current === prefill.id) return;
    consumed.current = prefill.id;
    setText((current) =>
      current.trim() ? current + "\n\n" + prefill.text : prefill.text,
    );
    box.current?.querySelector("textarea")?.focus();
  }, [prefill]);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu("");
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu("");
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, []);
  const toggle = (name: string) =>
    setMenu((current) => (current === name ? "" : name));
  async function send() {
    if (
      lock.current ||
      disabled ||
      w.role === "viewer" ||
      !text.trim() ||
      !model
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    const signature = JSON.stringify([
      text.trim(),
      files.map((f) => f.id),
      formats,
      skillIds,
      memoryIds,
      artifactIds,
      rubricIds,
      agentId,
      projectId,
    ]);
    if (signature !== previous.current) {
      request.current = crypto.randomUUID();
      previous.current = signature;
    }
    try {
      await onSend(
        text.trim(),
        {
          settings: {
            ...defaultThreadSettings,
            model: model.model,
            provider: model.provider,
            agentId: agentId || undefined,
            tools: [],
            outputFormat: formats.join(","),
          },
          attachments: files,
          skillIds,
          memoryIds,
          artifactIds,
          rubricIds,
          projectId: projectId || undefined,
          integrationIds: [],
        },
        request.current,
      );
      setText("");
      setFiles([]);
      setMenu("");
      previous.current = "";
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not send. Retry uses the same request key.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div
      ref={box}
      className={"composer server-composer " + (compact ? "compact" : "")}
    >
      <textarea
        aria-label={compact ? "Follow-up message" : "Task prompt"}
        placeholder={
          compact
            ? "Add a follow-up or instruction…"
            : "Ask anything or start a task…"
        }
        value={text}
        disabled={busy || disabled || w.role === "viewer"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {(skillIds.length +
        memoryIds.length +
        artifactIds.length +
        rubricIds.length >
        0 ||
        projectId) && (
        <div className="composer-context-chips">
          {Object.entries(selection).flatMap(([kind, [ids, set]]) =>
            ids.map((id) => (
              <button
                key={kind + id}
                onClick={() => set(ids.filter((x) => x !== id))}
              >
                {contextOptions[kind].find((x) => x.id === id)?.name || kind}
                <X size={12} />
              </button>
            )),
          )}
          {projectId && (
            <button onClick={() => setProjectId("")}>
              {w.data.projects.find((p) => p.id === projectId)?.name}
              <X size={12} />
            </button>
          )}
        </div>
      )}
      {!!files.length && (
        <div className="composer-context-chips">
          {files.map((f) => (
            <button
              key={f.id}
              disabled={busy}
              aria-label={"Remove attachment " + f.name}
              onClick={() =>
                setFiles((items) => items.filter((x) => x.id !== f.id))
              }
            >
              <Paperclip size={12} />
              {f.name}
              <X size={12} />
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="composer-upload-error">
          {error}
        </p>
      )}
      <div className="composer-bar">
        <div className="composer-bar-left">
          <button
            className="icon-btn"
            aria-label="Add files or context"
            disabled={busy || disabled || w.role === "viewer"}
            onClick={() => toggle("add")}
          >
            <Plus size={18} />
          </button>
          {!!formats.length && (
            <button className="pill" onClick={() => toggle("output")}>
              {formats.join(" + ").toUpperCase()}
            </button>
          )}
          <button
            className={"pill " + (compact ? "compact-model" : "")}
            aria-label="Model settings"
            aria-expanded={menu === "model"}
            onClick={() => toggle("model")}
          >
            <SlidersHorizontal size={14} />
            <span className="model-chip-label">
              {model?.model || "Model unavailable"}
            </span>
            <ChevronDown size={12} />
          </button>
          <button
            className="pill"
            aria-label="Select agent"
            onClick={() => toggle("agents")}
            disabled={busy || disabled}
          >
            <Bot size={14} />
            {w.data.agents.find((a) => a.id === agentId)?.name || "Agent"}
            <ChevronDown size={12} />
          </button>
        </div>
        <div className="composer-bar-right">
          <button
            className="plain execution"
            aria-label="Execution mode"
            disabled
            title="Execute is the only supported mode"
          >
            <Zap size={15} />
            <span className="execution-label">Execute</span>
            <ChevronDown size={11} />
          </button>
          <button
            className="icon-btn"
            aria-label="Tools and permissions"
            onClick={() => toggle("tools")}
          >
            <LockKeyhole size={17} />
          </button>
          <button
            className="send-btn"
            aria-label="Send message"
            disabled={busy || disabled || !text.trim() || !model}
            onClick={() => void send()}
          >
            <ArrowUp size={19} />
          </button>
        </div>
      </div>
      <button
        className="integration-strip"
        onClick={() => navigate?.("/integrations")}
      >
        Web research · Documents · Code · View capabilities ↗
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="Attach files"
        accept={capabilities?.formats.map((f) => "." + f).join(",")}
        disabled={busy || disabled || w.role === "viewer"}
        onChange={async (e) => {
          const selected = Array.from(e.target.files || []);
          e.target.value = "";
          if (lock.current) return;
          lock.current = true;
          setBusy(true);
          setError("");
          setMenu("");
          try {
            if (files.length + selected.length > 20)
              throw Error("Attach at most 20 files.");
            for (const file of selected) {
              if (file.size > 20 * 1024 * 1024)
                throw Error("Files must be 20 MB or smaller.");
              const body = new FormData();
              body.set("file", file);
              const saved = await v1<{
                id: string;
                name: string;
                bytes: number;
              }>("/files", { method: "POST", body });
              setFiles((rows) => [
                ...rows,
                {
                  id: saved.id,
                  name: saved.name,
                  size: saved.bytes,
                  mimeType: file.type,
                  workspaceId: w.state.active,
                  createdAt: new Date().toISOString(),
                },
              ]);
            }
          } catch (e) {
            setError(e instanceof Error ? e.message : "Upload failed");
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      />
      {menu === "add" && (
        <div className="popover composer-popover">
          <button onClick={() => input.current?.click()}>
            <Paperclip size={15} />
            Upload files…
          </button>
          <button onClick={() => setMenu("output")}>Output as…</button>
          {[
            ["Skills", "skills"],
            ["Memories", "memories"],
            ["Assets", "assets"],
            ["Rubrics", "rubrics"],
            ["Add to a project", "projects"],
          ].map(([label, key]) => (
            <button key={key} onClick={() => setMenu(key)}>
              {label}…
            </button>
          ))}
        </div>
      )}
      {!!selection[menu] && (
        <div className="popover composer-popover">
          <small>
            {menu === "memories"
              ? "Relevant memories are also retrieved automatically."
              : "Select task context"}
          </small>
          {contextOptions[menu].map((item) => (
            <label key={item.id} className="rt-checkbox">
              <input
                type="checkbox"
                checked={selection[menu][0].includes(item.id)}
                onChange={() => {
                  const [ids, set] = selection[menu];
                  set(
                    ids.includes(item.id)
                      ? ids.filter((x) => x !== item.id)
                      : [...ids, item.id],
                  );
                }}
              />
              {item.name}
            </label>
          ))}
          {!contextOptions[menu].length && <p>No saved {menu} yet.</p>}
        </div>
      )}
      {menu === "agents" && (
        <div className="popover composer-popover">
          <button
            onClick={() => {
              setAgentId("");
              setMenu("");
            }}
          >
            Default agent
          </button>
          {w.data.agents
            .filter((a) => !a.archived)
            .map((a) => (
              <button
                key={a.id}
                onClick={() => {
                  setAgentId(a.id);
                  setMenu("");
                }}
              >
                {a.name}
                {agentId === a.id ? " ✓" : ""}
              </button>
            ))}
          <button onClick={() => navigate?.("/agents/new?creation=manual")}>
            Create agent…
          </button>
        </div>
      )}
      {menu === "projects" && (
        <div className="popover composer-popover">
          <button
            onClick={() => {
              setProjectId("");
              setMenu("");
            }}
          >
            No project
          </button>
          {w.data.projects
            .filter((p) => !p.archived)
            .map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setProjectId(p.id);
                  setMenu("");
                }}
              >
                {p.name}
                {projectId === p.id ? " ✓" : ""}
              </button>
            ))}
        </div>
      )}
      {menu === "output" && (
        <div className="popover composer-popover" aria-label="Output formats">
          <small>Required output files</small>
          {capabilities?.formats.map((format) => (
            <label className="rt-checkbox" key={format}>
              <input
                type="checkbox"
                checked={formats.includes(format)}
                disabled={
                  busy ||
                  (!capabilities.sandbox.available &&
                    ["pdf", "png"].includes(format))
                }
                onChange={() =>
                  setFormats((current) =>
                    current.includes(format)
                      ? current.filter((f) => f !== format)
                      : [...current, format],
                  )
                }
              />
              {format.toUpperCase()}
              {!capabilities.sandbox.available &&
              ["pdf", "png"].includes(format)
                ? " · Unavailable"
                : ""}
            </label>
          ))}
          <small>Leave empty to let the agent choose.</small>
        </div>
      )}
      {menu === "model" && (
        <div className="popover composer-popover">
          <small>Configured model · selected by the server</small>
          {capabilities?.models.map((m) => (
            <button
              key={m.provider + m.model}
              disabled={!m.configured}
              onClick={() => setMenu("")}
            >
              {m.model} · {m.provider}
              {m.configured ? " ✓" : " · Unavailable"}
            </button>
          ))}
        </div>
      )}
      {menu === "tools" && (
        <div className="popover composer-popover">
          <small>Available tools · managed by the server</small>
          <p>File reading and document writing</p>
          <p>
            Web search · {capabilities?.search.provider}
            {capabilities?.search.degraded ? " (limited)" : ""}
          </p>
          <p>
            Sandbox code / PDF / PNG ·{" "}
            {capabilities?.sandbox.available ? "Available" : "Unavailable"}
          </p>
          <button disabled>External actions · Unavailable</button>
          <p>Memory retrieval · Automatic, workspace scoped</p>
          <p>Memory changes · Require your review</p>
        </div>
      )}
    </div>
  );
}
