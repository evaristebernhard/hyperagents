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
}: ComposerProps) {
  const w = useWorkspace(),
    capabilities = w.capabilities;
  const [text, setText] = useState("");
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [formats, setFormats] = useState<string[]>([]);
  const [menu, setMenu] = useState("");
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
    if (lock.current || disabled || !text.trim() || !model) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const signature = JSON.stringify([
      text.trim(),
      files.map((f) => f.id),
      formats,
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
            tools: [],
            outputFormat: formats.join(","),
          },
          attachments: files,
          skillIds: [],
          memoryIds: [],
          artifactIds: [],
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
        disabled={busy || disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
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
            disabled={busy || disabled}
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
          {!compact && (
            <button
              className="pill"
              disabled
              title="Custom agents are not available yet"
            >
              <Bot size={14} />
              Agent
              <ChevronDown size={12} />
            </button>
          )}
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
        disabled
        title="Integrations are not available yet"
      >
        Connect your integrations · Unavailable
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="Attach files"
        accept={capabilities?.formats.map((f) => "." + f).join(",")}
        disabled={busy || disabled}
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
            "Skills",
            "Memories",
            "Assets",
            "Integrations",
            "Add to a project",
          ].map((label) => (
            <button key={label} disabled>
              {label} · Unavailable
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
          <button disabled>Custom tool selection · Unavailable</button>
        </div>
      )}
    </div>
  );
}
