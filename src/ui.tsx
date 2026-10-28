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
  Plug,
} from "lucide-react";
import { useState, useEffect, useRef } from "react";
import type { Navigate, ThreadSettings, MessageContext, FileMeta } from "./types";
import { defaultThreadSettings } from "./types";
import { useWorkspace } from "./workspace";
import { uploadFile } from "./backend-client";
import ComposerContextPicker, { type PickerKind } from "./ComposerContextPicker";
import ComposerMenus from "./ComposerMenus";
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
  headerless = false,
  dialogRole = "dialog",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
  headerless?: boolean;
  dialogRole?: "dialog" | "alertdialog";
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
        const nodes = [...(ref.current?.querySelectorAll<HTMLElement>(
          'button,input,select,textarea,a[href],[tabindex="0"],[contenteditable="true"]',
        ) || [])].filter(node => !node.hasAttribute("disabled") && node.getClientRects().length > 0 && node.getAttribute("type") !== "hidden");
        if (!nodes.length) return;
        if (document.activeElement === ref.current || !ref.current?.contains(document.activeElement)) {
          e.preventDefault();
          (e.shiftKey ? nodes[nodes.length - 1] : nodes[0]).focus();
          return;
        }
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
    const focusable = [...(ref.current?.querySelectorAll<HTMLElement>(
      'input:not([type=hidden]),textarea,select,button,a[href],[tabindex="0"],[contenteditable="true"]',
    ) || [])].filter(node => !node.hasAttribute("disabled") && node.getClientRects().length > 0);
    const firstInput = focusable.find(node => ["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName) || node.isContentEditable);
    (firstInput || focusable[0] || ref.current)?.focus();
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
        role={dialogRole}
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        {!headerless && (
          <div className="modal-header">
            <h2>{title}</h2>
            <IconButton label="Close dialog" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
        )}
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
export function Composer({ navigate, onSend, notify, compact = false, agents = [], initialSettings, contextKey = "new" }: {
  navigate: Navigate;
  onSend: (text: string, context?: MessageContext, clientRequestId?: string) => void | Promise<void>;
  notify: (message: string) => void;
  compact?: boolean;
  agents?: string[];
  initialSettings?: ThreadSettings;
  contextKey?: string;
}) {
  const w = useWorkspace();
  const server = w.mode === "server";
  const baseline = initialSettings || w.data.preferences?.defaultThreadSettings || defaultThreadSettings;
  const [choices, setChoices] = useState<ThreadSettings>(() => structuredClone(baseline));
  const [text, setText] = useState("");
  const [menu, setMenu] = useState("");
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [memoryIds, setMemoryIds] = useState<string[]>([]);
  const [artifactIds, setArtifactIds] = useState<string[]>([]);
  const [integrationIds, setIntegrationIds] = useState<string[]>([]);
  const [projectId, setProjectId] = useState<string | undefined>();
  const [agent, setAgent] = useState("Agent");
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const requestId = useRef(crypto.randomUUID());
  const failed = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const signature = JSON.stringify(baseline);
  useEffect(() => { setChoices(structuredClone(baseline)); }, [contextKey, signature]);
  useEffect(() => {
    const click = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setMenu(""); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(""); };
    document.addEventListener("mousedown", click); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", click); document.removeEventListener("keydown", key); };
  }, []);
  const send = async () => {
    if ((!text.trim() && !files.length) || busy.current || uploading) return;
    busy.current = true; setSending(true); setError("");
    try {
      const ensure = (ids: string[], available: { id: string }[], label: string) => { if (ids.some(id => !available.some(item => item.id === id))) throw Error("A selected " + label + " is no longer available. Remove it before sending."); };
      if (server) {
        ensure(skillIds, w.data.skills.filter(s => !s.archived), "skill"); ensure(memoryIds, w.data.memories, "memory");
        ensure(artifactIds, w.data.artifacts.filter(a => !a.archived), "artifact"); ensure(integrationIds, w.data.connections.filter(c => c.enabled), "connection");
        if (choices.agentId) ensure([choices.agentId], w.data.agents.filter(a => !a.archived), "agent");
        if (projectId) ensure([projectId], w.data.projects.filter(p => !p.archived), "project");
      }
      const context: MessageContext = { settings: structuredClone(choices), skillIds: [...skillIds], memoryIds: [...memoryIds], artifactIds: [...artifactIds], integrationIds: [...integrationIds], projectId, attachments: [...files] };
      await onSend(server ? text.trim() : text.trim() + (choices.outputFormat ? "\n[Output: " + choices.outputFormat + "]" : ""), context, requestId.current);
      setText(""); setFiles([]); setSkillIds([]); setMemoryIds([]); setArtifactIds([]); setIntegrationIds([]); setMenu(""); setProjectId(undefined);
      requestId.current = crypto.randomUUID(); failed.current = false;
    } catch (e) { failed.current = true; setError(e instanceof Error ? e.message : "Could not confirm this message was saved. Check storage status before retrying."); }
    finally { busy.current = false; setSending(false); }
  };
  const toggle = (value: string) => setMenu(menu === value ? "" : value);
  const openContext = (value: PickerKind, legacyPath: string) => { if (server) setMenu(value); else { navigate(legacyPath); setMenu(""); } };
  const pickerKinds: PickerKind[] = ["skills", "memories", "assets", "integrations", "projects"];
  const add = (set: (fn: (old: string[]) => string[]) => void, id: string) => set(old => old.includes(id) ? old : [...old, id]);
  const contextChips = [
    ...skillIds.map(id => ({ key: "skill:" + id, label: "@" + (w.data.skills.find(s => s.id === id)?.name || "Unavailable skill"), remove: () => setSkillIds(list => list.filter(x => x !== id)) })),
    ...memoryIds.map(id => ({ key: "memory:" + id, label: "Memory: " + (w.data.memories.find(m => m.id === id)?.content.slice(0,40) || "Unavailable"), remove: () => setMemoryIds(list => list.filter(x => x !== id)) })),
    ...artifactIds.map(id => ({ key: "artifact:" + id, label: w.data.artifacts.find(a => a.id === id)?.title || "Unavailable artifact", remove: () => setArtifactIds(list => list.filter(x => x !== id)) })),
    ...integrationIds.map(id => ({ key: "integration:" + id, label: "@" + (w.data.connections.find(c => c.id === id)?.label || "Unavailable connection"), remove: () => setIntegrationIds(list => list.filter(x => x !== id)) })),
    ...(projectId ? [{ key: "project:" + projectId, label: "Project: " + (w.data.projects.find(p => p.id === projectId)?.name || "Unavailable"), remove: () => setProjectId(undefined) }] : []),
  ];
  return <div className={"composer " + (server ? "server-composer " : "") + (compact ? "compact" : "")} ref={box}>
    <textarea aria-label={compact ? "Follow-up message" : "Task prompt"} placeholder={compact ? "Add a message…" : "Ask anything or start a task…"} value={text} disabled={sending}
      onChange={e => { if (failed.current) { requestId.current = crypto.randomUUID(); failed.current = false; } setText(e.target.value); setError(""); }}
      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
    {(files.length > 0 || contextChips.length > 0) && <div className="composer-context-chips">
      {files.map(file => <button key={file.id} disabled={sending} onClick={() => setFiles(list => list.filter(f => f.id !== file.id))} aria-label={"Remove attachment " + file.name}><Paperclip size={12} />{file.name}<X size={12} /></button>)}
      {contextChips.map(chip => <button key={chip.key} onClick={chip.remove} disabled={sending}>{chip.label}<X size={12} /></button>)}
    </div>}
    {uploading && <p role="status" className="composer-upload-error">Uploading file bytes…</p>}
    {error && <p role="alert" className="composer-upload-error">{error}</p>}
    <div className="composer-bar"><div className="composer-bar-left">
      <IconButton label="Add files or context" onClick={() => toggle("add")}><Plus size={18} /></IconButton>
      {!!choices.outputFormat && <button className="pill" aria-label={choices.outputFormat + " output settings"} onClick={() => toggle("format-settings")}>{choices.outputFormat}</button>}
      <button className={"pill " + (compact ? "compact-model" : "")} aria-label="Model settings" aria-haspopup="menu" aria-expanded={menu === "model"} onClick={() => toggle("model")}><SlidersHorizontal size={14} />{!compact && <span className="model-chip-label">{choices.model || "Choose your model"}</span>}{!compact && <ChevronDown className="model-chip-chevron" size={12} />}</button>
      {!compact && <button className="pill" aria-label="Use an agent" aria-haspopup="menu" aria-expanded={menu === "agents"} onClick={() => toggle("agents")}><Bot size={14} />{choices.agentId ? w.data.agents.find(a => a.id === choices.agentId)?.name || "Unavailable agent" : choices.starterAgentName || agent}<ChevronDown size={12} /></button>}
    </div><div className="composer-bar-right">
      <button className="plain execution" aria-label="Execution mode" aria-haspopup="menu" aria-expanded={menu === "mode"} onClick={() => toggle("mode")}><Zap size={15} />{!compact && choices.mode}{!compact && <ChevronDown size={11} />}</button>
      <IconButton label="Safety and permissions" onClick={() => server ? toggle("safety") : notify("No external actions or tool execution are enabled.")}><LockKeyhole size={17} /></IconButton>
      <button className="send-btn" aria-label="Send message" disabled={sending || uploading || (!text.trim() && !files.length)} onClick={() => void send()}><ArrowUp size={19} /></button>
    </div></div>
    {!server && <button className="integration-strip" onClick={() => navigate(location.pathname + "?settings=integrations")}><span className="integration-logos"><b>◈</b><b>M</b><b>✣</b></span>Connect your integrations →</button>}
    <input ref={upload} type="file" multiple hidden aria-label="Attach files" disabled={sending || uploading} onChange={async e => {
      const selected = Array.from(e.target.files || []); e.target.value = ""; setMenu(""); setError(""); setUploading(true);
      try {
        if (server) await w.flush();
        for (const file of selected) {
          if (file.size > 20 * 1024 * 1024) throw Error("Files must be 20 MB or smaller.");
          const metadata = server ? await uploadFile(file, w.state.active) : { id: crypto.randomUUID(), workspaceId: w.state.active, name: file.name, size: file.size, mimeType: file.type || "application/octet-stream", createdAt: new Date().toISOString() };
          setFiles(current => [...current, metadata]);
        }
      } catch (e) { setError(e instanceof Error ? e.message : "Upload failed. No missing file was attached."); }
      finally { setUploading(false); }
    }} />
    {menu === "add" && <div className="popover composer-popover">
      <button onClick={() => upload.current?.click()}><Paperclip size={15} />Upload files…</button>
      <button onClick={() => openContext("skills", "/skills")}><Puzzle size={15} />Skills</button>
      <button onClick={() => openContext("memories", "/memories")}><Brain size={15} />Memories</button>
      <button onClick={() => openContext("assets", "/library")}><Layers size={15} />Assets</button>
      <button onClick={() => setMenu("output")}><Globe size={15} />Output as…<ChevronDown size={12} /></button>
      <button onClick={() => openContext("integrations", location.pathname + "?settings=integrations")}><Plug size={15} />Integrations</button>
      <button onClick={() => openContext("projects", "/projects")}><Folder size={15} />Add to a project</button>
    </div>}
    {menu === "output" && <div className="popover composer-popover">{outputs.map(([name, Icon]) => <button key={name} onClick={() => { setChoices(current => ({ ...current, outputFormat: name })); setMenu(""); }}><Icon size={15} />{name}</button>)}</div>}
    {menu === "format-settings" && <div className="popover composer-popover"><label className="field">Visuals<select aria-label="Output visuals" value={choices.visuals || "Auto"} onChange={e => setChoices(current => ({ ...current, visuals: e.target.value }))}>{["Auto", "None", "AI enhanced", "Full AI render"].map(value => <option key={value}>{value}</option>)}</select></label><button onClick={() => { setChoices(current => ({ ...current, outputFormat: undefined, visuals: undefined })); setMenu(""); }}>Clear selection</button>{server && <small>Stored format preference only. No generation runs.</small>}</div>}
    {menu === "safety" && <div className="popover composer-popover"><p>Single-owner local data service. Messages, files and preferences are persisted. No model, browser, integration or scheduled execution is connected.</p><button onClick={() => setMenu("")}>Close</button></div>}
    {server && pickerKinds.includes(menu as PickerKind) && <ComposerContextPicker kind={menu as PickerKind} close={() => setMenu("")} navigate={navigate} choose={id => {
      if (menu === "skills") add(setSkillIds, id); if (menu === "memories") add(setMemoryIds, id); if (menu === "assets") add(setArtifactIds, id); if (menu === "integrations") add(setIntegrationIds, id); if (menu === "projects") setProjectId(id);
    }} />}
    <ComposerMenus menu={menu} close={() => setMenu("")} navigate={navigate} mode={choices.mode} setMode={mode => setChoices(current => ({ ...current, mode }))} model={choices.model || "Choose your model"} agent={agent} setAgent={setAgent} agents={agents}
      settings={server ? choices : undefined} onSettingsChange={setChoices} dataOnly={server} savedAgents={server ? w.data.agents.filter(a => !a.archived).map(a => ({ id: a.id, name: a.name })) : undefined}
      onAgentSelection={(agentId, starterAgentName) => setChoices(current => ({ ...current, agentId, starterAgentName }))} />
  </div>;
}
