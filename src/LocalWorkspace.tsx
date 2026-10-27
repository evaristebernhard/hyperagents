import { useRef, useState } from "react";
import {
  Plus,
  Download,
  Upload,
  Folder,
  Check,
  Pencil,
  Database,
  Trash2,
} from "lucide-react";
import type { PageProps } from "./types";
import type { WorkspaceState } from "./local-model";
import { useWorkspace, validateSnapshot } from "./workspace";
import { Modal } from "./ui";
import Schedules from "./Schedules";
export default function LocalWorkspace({ path, navigate, notify }: PageProps) {
  const w = useWorkspace();
  const [modal, setModal] = useState(""),
    [name, setName] = useState(""),
    [id, setId] = useState(""),
    [candidate, setCandidate] = useState<WorkspaceState | null>(null),
    [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const importFile = async (file: File) => {
    setError("");
    if (file.size > 10 * 1024 * 1024) {
      setError("Backup must be smaller than 10 MB.");
      return;
    }
    try {
      const parsed = validateSnapshot(JSON.parse(await file.text()));
      setCandidate(parsed);
      setModal("import");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid backup.");
    }
  };
  return (
    <div className="standard-page">
      <header className="page-header">
        <div>
          <h1 className="page-title">
            {path === "/workflows" ? "Workflows" : "Workspaces"}
          </h1>
          <p className="muted rp-description">
            Lightweight local workspaces. No server or database account
            required.
          </p>
        </div>
        {path !== "/workflows" && (
          <button
            className="btn primary"
            onClick={() => {
              setId("");
              setName("");
              setModal("workspace");
            }}
          >
            <Plus size={14} />
            Create workspace
          </button>
        )}
      </header>
      {path === "/workflows" ? (
        <Schedules />
      ) : (
        <>
          <div className="grid2">
            {w.state.workspaces.map((ws) => (
              <article className="card local-workspace-card" key={ws.id}>
                <div className="page-header">
                  <h3>
                    <Folder size={17} /> {ws.name}
                  </h3>
                  {ws.id === w.state.active && (
                    <span className="badge">
                      <Check size={12} />
                      Active
                    </span>
                  )}
                </div>
                <p className="muted">
                  {ws.data.threads.length} threads · {ws.data.agents.length}{" "}
                  agents · {ws.data.skills.length} skills ·{" "}
                  {ws.data.rooms.length} rooms
                </p>
                <div className="actions">
                  <button
                    className="btn small"
                    onClick={() => {
                      w.switchWorkspace(ws.id);
                      navigate("/threads/new");
                    }}
                  >
                    Open workspace
                  </button>
                  <button
                    className="plain"
                    onClick={() => {
                      setId(ws.id);
                      setName(ws.name);
                      setModal("workspace");
                    }}
                  >
                    <Pencil size={14} />
                    Rename
                  </button>
                </div>
              </article>
            ))}
          </div>
          <section className="card local-backup-panel">
            <Database size={24} />
            <h2>Keep a portable copy of your work</h2>
            <p className="muted">
              Export all workspaces, skills, documents, versions, threads, Agent
              configurations, rooms, schedules, memories, and rubrics as one
              JSON file. Backups do not contain credentials.
            </p>
            <div className="actions">
              <button className="btn" onClick={() => w.exportSnapshot()}>
                <Download size={15} />
                Export workspace backup
              </button>
              <button className="btn" onClick={() => input.current?.click()}>
                <Upload size={15} />
                Import workspace backup
              </button>
            </div>
            <p className="demo-note">
              Import validates the full file before asking you to replace local
              workspace data. Export a backup first. Global appearance/profile
              preferences are not included.
            </p>
            {error && (
              <p className="local-validation-error" role="alert">
                {error}
              </p>
            )}
            <input
              ref={input}
              hidden
              type="file"
              accept=".json,application/json"
              aria-label="Import workspace backup file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
                e.target.value = "";
              }}
            />
          </section>
          <p className="demo-note">
            Data stays in this browser and origin. Other browsers and devices do
            not automatically synchronize.
          </p>
        </>
      )}
      {modal === "workspace" && (
        <Modal
          title={id ? "Rename workspace" : "Create workspace"}
          onClose={() => setModal("")}
          footer={
            <>
              <button className="btn" onClick={() => setModal("")}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={!name.trim()}
                onClick={() => {
                  if (id) w.renameWorkspace(id, name);
                  else w.createWorkspace(name);
                  setModal("");
                  if (!id) navigate("/threads/new");
                  notify("Workspace saved locally.");
                }}
              >
                {id ? "Save name" : "Create workspace"}
              </button>
            </>
          }
        >
          <label className="field">
            Workspace name
            <input
              aria-label="Workspace name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your team or project"
            />
          </label>
          <p className="demo-note">
            Each local workspace has separate content. No team invitations or
            cloud permissions are created.
          </p>
        </Modal>
      )}
      {modal === "import" && candidate && (
        <Modal
          title="Replace local workspace data?"
          onClose={() => {
            setModal("");
            setCandidate(null);
          }}
          footer={
            <>
              <button
                className="btn"
                onClick={() => {
                  setModal("");
                  setCandidate(null);
                }}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  w.importSnapshot(candidate);
                  setCandidate(null);
                  setModal("");
                  navigate("/workspaces");
                  notify("Workspace backup imported locally.");
                }}
              >
                Replace local data
              </button>
            </>
          }
        >
          <p>
            This will replace your current local workspace collection with{" "}
            {candidate.workspaces.length} validated workspace(s):
          </p>
          <ul>
            {candidate.workspaces.map((ws) => (
              <li key={ws.id}>
                {ws.name} · {ws.data.skills.length} skills ·{" "}
                {ws.data.threads.length} threads
              </li>
            ))}
          </ul>
          <p className="local-validation-error">
            Export your current backup before replacing it. No remote account is
            modified.
          </p>
        </Modal>
      )}
    </div>
  );
}
