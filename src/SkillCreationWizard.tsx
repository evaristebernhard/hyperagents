import { useEffect, useRef, useState } from "react";
import { ArrowLeft, BookOpen, ChevronRight, FileUp, Github, Sparkles, Upload, X } from "lucide-react";
import { Modal } from "./ui";
import "./skill-creation.css";

type Method = "choose" | "research" | "docs" | "github" | "file";
export default function SkillCreationWizard({ onClose, onManual, onImport }: {
  onClose: () => void;
  onManual: () => void;
  onImport: (file: File, signal: AbortSignal) => Promise<string | null>;
}) {
  const [method, setMethod] = useState<Method>("choose");
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState("Quick Learn");
  const [description, setDescription] = useState("");
  const [docsTab, setDocsTab] = useState("From URL");
  const [url, setUrl] = useState("");
  const [docs, setDocs] = useState("");
  const [repository, setRepository] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const close = () => { pending.current?.abort(); onClose(); };
  const changeMethod = (next: Method) => { setMethod(next); setStatus(""); setError(""); };
  const chooseFile = (files: File[]) => {
    setError(""); setStatus(""); setFile(null);
    if (files.length !== 1) { setError("Select a single skill file."); return; }
    const selected = files[0];
    const extension = selected.name.split(".").pop()?.toLowerCase();
    if (!extension || !["json", "md", "zip"].includes(extension)) {
      setError("Choose a JSON, MD, or ZIP file. TXT remains available through the legacy Import skill button."); return;
    }
    const limit = extension === "zip" ? 50 : 5;
    if (selected.size > limit * 1024 * 1024) { setError(`${extension.toUpperCase()} files must be ${limit} MB or smaller.`); return; }
    setFile(selected);
  };
  const isZip = file?.name.toLowerCase().endsWith(".zip");
  const submit = async () => {
    if (method === "file") {
      if (!file || busy) return;
      if (isZip) {
        setStatus("ZIP import is not supported in this local preview. No safe ZIP parser is connected; the manifest cannot be inspected and nothing was extracted or installed."); return;
      }
      const controller = new AbortController(); pending.current = controller;
      setBusy(true); setError("");
      const problem = await onImport(file, controller.signal);
      if (!controller.signal.aborted) {
        setBusy(false);
        if (problem) setError(problem); else onClose();
      }
      return;
    }
    setStatus(method === "research"
      ? "Research is not connected in this local preview. No model was called and no skill was created."
      : method === "docs"
        ? "Documentation analysis is not connected in this local preview. No URL was fetched, no model was called, and no skill was created."
        : "GitHub import is not connected in this local preview. No repository was fetched and no skill was created.");
  };
  const title = { choose: "Create skill", research: "Research a new skill", docs: "Learn from documentation", github: "Import from GitHub", file: "Import skill from file" }[method];
  const disabled = busy || (method === "research" ? !topic.trim() : method === "docs" ? !(docsTab === "From URL" ? url : docs).trim() : method === "github" ? !repository.trim() : !file);
  const submitLabel = method === "research" ? mode === "Interactive" ? "Start Interactive" : "Start Research" : method === "docs" ? "Analyze & Learn" : method === "github" ? "Import from GitHub" : busy ? "Importing…" : "Import skill";
  return (
    <Modal title={title} onClose={close} footer={<>
      {method !== "choose" && <button className="btn sc-back" disabled={busy} onClick={() => changeMethod("choose")}><ArrowLeft size={14} />Back</button>}
      <button className="btn" onClick={close}>Cancel</button>
      {method !== "choose" && <button className="btn primary" disabled={disabled} onClick={() => void submit()}>{submitLabel}</button>}
    </>}>
      <div className="sc-wizard">
        {method === "choose" ? <>
          <p className="sc-intro">How would you like to create your skill?</p>
          <div className="sc-methods">
            {([
              ["research", Sparkles, "Build a skill from scratch", "Research a topic and turn it into a reusable skill."],
              ["docs", BookOpen, "Learn from documentation", "Provide a URL or paste documentation."],
              ["github", Github, "Import from GitHub", "Learn from an existing repository."],
              ["file", FileUp, "Import from file", "Upload a skill file or a ZIP package."],
            ] as const).map(([value, Icon, label, detail]) => <button key={value} className="sc-method" onClick={() => changeMethod(value)}>
              <span className="sc-method-icon"><Icon size={20} /></span><span><strong>{label}</strong><small>{detail}</small></span><ChevronRight size={16} />
            </button>)}
          </div>
          <div className="sc-manual"><span>Already have your instructions?</span><button className="plain" onClick={onManual}>Open local-only manual editor →</button></div>
        </> : method === "research" ? <>
          <p className="sc-intro">What would you like your agent to learn?</p>
          <label className="field">Topic<input className="input" autoFocus value={topic} onChange={e => { setTopic(e.target.value); setStatus(""); }} placeholder="e.g. Create accessible React components" /></label>
          <fieldset className="sc-modes"><legend>Learning mode</legend>{["Quick Learn", "Interactive"].map(value => <label className={mode === value ? "sc-mode selected" : "sc-mode"} key={value}>
            <input type="radio" name="skill-learning-mode" value={value} checked={mode === value} onChange={() => { setMode(value); setStatus(""); }} /><span><strong>{value}</strong><small>{value === "Quick Learn" ? "Research the topic in one step." : "Refine the skill through a conversation."}</small></span>
          </label>)}</fieldset>
          {mode === "Interactive" && <label className="field">Initial description (optional)<textarea className="textarea" rows={4} value={description} onChange={e => setDescription(e.target.value)} placeholder="Share any context or goals for this skill…" /></label>}
        </> : method === "docs" ? <>
          <p className="sc-intro">Turn existing documentation into a reusable skill.</p>
          <div className="sc-tabs" role="tablist" aria-label="Documentation source">{["From URL", "Paste Docs"].map(value => <button key={value} id={value === "From URL" ? "sc-url-tab" : "sc-docs-tab"} role="tab" aria-controls="sc-docs-panel" aria-selected={docsTab === value} onClick={() => { setDocsTab(value); setStatus(""); }}>{value}</button>)}</div>
          <div role="tabpanel" id="sc-docs-panel" aria-labelledby={docsTab === "From URL" ? "sc-url-tab" : "sc-docs-tab"}>
            {docsTab === "From URL" ? <label className="field">Documentation URL<input className="input" value={url} onChange={e => { setUrl(e.target.value); setStatus(""); }} placeholder="https://docs.example.com" /></label> : <label className="field">Documentation<textarea className="textarea" rows={8} value={docs} onChange={e => { setDocs(e.target.value); setStatus(""); }} placeholder="Paste your documentation here…" /></label>}
          </div>
        </> : method === "github" ? <>
          <p className="sc-intro">Provide a GitHub repository to learn from.</p>
          <label className="field">Repository URL<input className="input" autoFocus value={repository} onChange={e => { setRepository(e.target.value); setStatus(""); }} placeholder="https://github.com/owner/repository" /></label>
        </> : <>
          <p className="sc-intro">Import a skill from a single file. Nothing is imported until you select Import skill.</p>
          <div className={"sc-dropzone" + (dragging ? " dragging" : "")} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); if (!busy) chooseFile(Array.from(e.dataTransfer.files)); }}>
            <Upload size={28} /><strong>Drag and drop your skill file here</strong><span>or</span><button className="btn" disabled={busy} onClick={() => picker.current?.click()}>Choose file</button><small>JSON or MD up to 5 MB · ZIP up to 50 MB · One file only</small>
          </div>
          <input hidden type="file" ref={picker} accept=".json,.md,.zip" aria-label="Upload skill file" disabled={busy} onChange={e => { chooseFile(Array.from(e.target.files || [])); e.target.value = ""; }} />
          {file && <div className="sc-selected-file"><FileUp size={18} /><span><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(2)} MB · {isZip ? "ZIP package" : "Local text import"}</small></span><button className="icon-btn" aria-label="Remove selected file" disabled={busy} onClick={() => { setFile(null); setError(""); setStatus(""); }}><X size={16} /></button></div>}
          {isZip && <section className="sc-manifest" aria-label="ZIP manifest preview"><h3>Manifest preview</h3><p>Unavailable in this local preview. A safe ZIP parser is not connected, so package contents and manifest cannot be read. ZIP files are accepted for selection and size validation only; no extraction, installation, or script execution is supported.</p></section>}
        </>}
        {method !== "choose" && method !== "file" && <p className="sc-boundary">Local preview only. Research, documentation analysis, and GitHub services are not connected.</p>}
        {error && <p className="sc-error" role="alert">{error}</p>}
        {status && <p className="sc-status" role="status">{status}</p>}
      </div>
    </Modal>
  );
}
