import type { ReactNode } from "react";
import {
  X,
  ChevronDown,
  Plus,
  SlidersHorizontal,
  Bot,
  Zap,
  ArrowUp,
  LockKeyhole,
  Paperclip,
  Image,
  Video,
  Volume2,
  Globe,
  Presentation,
  Table2,
  Map,
  FileText,
  Puzzle,
  Brain,
  Folder,
  Layers,
} from "lucide-react";
import { useState, useEffect, useRef } from "react";
import type { Navigate } from "./types";
export function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
export function IconButton({
  label,
  children,
  onClick,
  className = "",
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={"icon-btn " + className}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
  footer,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement;
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const nodes = ref.current?.querySelectorAll<HTMLElement>(
          'button,input,select,textarea,a[href],[tabindex="0"]',
        );
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", listener);
    const firstInput = ref.current?.querySelector<HTMLElement>(
      "input:not([type=hidden]),textarea,select",
    );
    (firstInput || ref.current)?.focus();
    return () => {
      document.removeEventListener("keydown", listener);
      prev?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={"modal-dialog " + (wide ? "wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
const outputs = [
  ["Image", Image],
  ["Video", Video],
  ["Audio", Volume2],
  ["Webpage", Globe],
  ["Slides", Presentation],
  ["Table", Table2],
  ["Map", Map],
  ["Doc", FileText],
] as const;
export function Composer({
  navigate,
  onSend,
  notify,
  compact = false,
  agents = [],
}: {
  navigate: Navigate;
  onSend: (text: string) => void;
  notify: (message: string) => void;
  compact?: boolean;
  agents?: string[];
}) {
  const [text, setText] = useState(""),
    [menu, setMenu] = useState(""),
    [mode, setMode] = useState("Execute"),
    [model, setModel] = useState("Choose your model"),
    [output, setOutput] = useState(""),
    [files, setFiles] = useState<string[]>([]),
    [agent, setAgent] = useState("Agent");
  const box = useRef<HTMLDivElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const click = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu("");
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu("");
    };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", key);
    };
  }, []);
  const send = () => {
    if (!text.trim()) return;
    onSend(text.trim() + (output ? "\n[Output: " + output + "]" : ""));
    setText("");
    setFiles([]);
    setMenu("");
  };
  const toggle = (m: string) => setMenu(menu === m ? "" : m);
  return (
    <div className={"composer " + (compact ? "compact" : "")} ref={box}>
      <textarea
        aria-label={compact ? "Follow-up message" : "Task prompt"}
        placeholder={
          compact ? "Add a follow-up..." : "Ask anything or start a task..."
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      {(files.length > 0 || output) && (
        <div className="composer-chips">
          {files.map((f, i) => (
            <button
              key={i}
              onClick={() => setFiles(files.filter((_, j) => i !== j))}
            >
              <Paperclip size={12} />
              {f}
              <X size={12} />
            </button>
          ))}
          {output && (
            <button onClick={() => setOutput("")}>
              {output}
              <X size={12} />
            </button>
          )}
        </div>
      )}
      <div className="composer-bar">
        <div className="composer-bar-left">
          <IconButton
            label="Add files or context"
            onClick={() => toggle("add")}
          >
            <Plus size={18} />
          </IconButton>
          <button
            className={"pill " + (compact ? "compact-model" : "")}
            aria-label="Model settings"
            onClick={() => toggle("model")}
          >
            <SlidersHorizontal size={14} />
            {!compact && model}
            {!compact && <ChevronDown size={12} />}
          </button>
          {!compact && (
            <button className="pill" onClick={() => toggle("agents")}>
              <Bot size={14} />
              {agent}
              <ChevronDown size={12} />
            </button>
          )}
        </div>
        <div className="composer-bar-right">
          <button
            className="plain execution"
            aria-label="Execution mode"
            onClick={() => toggle("mode")}
          >
            <Zap size={15} />
            {!compact && mode}
            {!compact && <ChevronDown size={11} />}
          </button>
          <IconButton
            label="Safety and permissions"
            onClick={() =>
              notify(
                "Demo mode: no external actions or tool execution are enabled.",
              )
            }
          >
            <LockKeyhole size={17} />
          </IconButton>
          <button
            className="send-btn"
            aria-label="Send message"
            disabled={!text.trim()}
            onClick={send}
          >
            <ArrowUp size={19} />
          </button>
        </div>
      </div>
      <button
        className="integration-strip"
        onClick={() => navigate(location.pathname + "?settings=integrations")}
      >
        <span className="integration-logos">
          <b>◈</b>
          <b>M</b>
          <b>✣</b>
        </span>
        Connect your integrations →
      </button>
      <input
        ref={upload}
        type="file"
        multiple
        hidden
        aria-label="Attach files"
        onChange={(e) => {
          setFiles([
            ...files,
            ...Array.from(e.target.files || []).map((f) => f.name),
          ]);
          setMenu("");
          e.target.value = "";
        }}
      />
      {menu === "add" && (
        <div className="popover composer-popover">
          <button onClick={() => upload.current?.click()}>
            <Paperclip size={15} />
            Upload files…
          </button>
          <button
            onClick={() => {
              navigate("/skills");
              setMenu("");
            }}
          >
            <Puzzle size={15} />
            Skills
          </button>
          <button
            onClick={() => {
              navigate("/memories");
              setMenu("");
            }}
          >
            <Brain size={15} />
            Memories
          </button>
          <button
            onClick={() => {
              navigate("/library");
              setMenu("");
            }}
          >
            <Layers size={15} />
            Assets
          </button>
          <button onClick={() => setMenu("output")}>
            <Globe size={15} />
            Output as…
            <ChevronDown size={12} />
          </button>
          <button
            onClick={() => {
              navigate("/projects");
              setMenu("");
            }}
          >
            <Folder size={15} />
            Add to a project
          </button>
        </div>
      )}
      {menu === "output" && (
        <div className="popover composer-popover">
          {outputs.map(([n, I]) => (
            <button
              key={n}
              onClick={() => {
                setOutput(n);
                setMenu("");
              }}
            >
              <I size={15} />
              {n}
            </button>
          ))}
        </div>
      )}
      {menu === "mode" && (
        <div className="popover mode-popover">
          {[
            ["Plan first", "Think through an approach before taking action"],
            ["Execute", "Act immediately without a plan"],
            ["Auto", "Choose the appropriate execution mode"],
          ].map(([n, t]) => (
            <button
              key={n}
              onClick={() => {
                setMode(n);
                setMenu("");
              }}
            >
              <span>
                <strong>{n}</strong>
                <small>{t}</small>
              </span>
              {mode === n && "✓"}
            </button>
          ))}
        </div>
      )}
      {menu === "model" && (
        <div className="popover model-popover">
          <label>
            Model
            <select
              aria-label="Choose model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {[
                "Choose your model",
                "Auto",
                "GPT-6.1 Sol",
                "Claude Opus",
                "Gemini Pro",
              ].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label>
            Reasoning effort
            <select aria-label="Reasoning effort" defaultValue="Medium">
              <option>Low</option>
              <option>Medium</option>
              <option>High</option>
            </select>
          </label>
          <label>
            Provider
            <select aria-label="Provider">
              <option>Any</option>
              <option>OpenAI</option>
              <option>Anthropic</option>
              <option>Google</option>
            </select>
          </label>
          <button
            onClick={() => {
              navigate(
                location.pathname +
                  "?" +
                  (location.pathname.startsWith("/thread/")
                    ? "panel=settings"
                    : "settings=thread-defaults"),
              );
              setMenu("");
            }}
          >
            <SlidersHorizontal size={14} />
            Open full settings
          </button>
          <small className="demo-note">Model selections are UI-only.</small>
        </div>
      )}
      {menu === "agents" && (
        <div className="popover composer-popover">
          <button
            onClick={() => {
              setAgent("Agent");
              setMenu("");
            }}
          >
            <Bot size={15} />
            General assistant
          </button>
          {agents.map((a) => (
            <button
              key={a}
              onClick={() => {
                setAgent(a);
                setMenu("");
              }}
            >
              <Bot size={15} />
              {a}
            </button>
          ))}
          <button
            onClick={() => {
              navigate("/agents/new");
              setMenu("");
            }}
          >
            <Plus size={15} />
            New agent
          </button>
        </div>
      )}
    </div>
  );
}
