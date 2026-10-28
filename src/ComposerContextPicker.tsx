import { useState } from "react";
import { useWorkspace } from "./workspace";
import { uid } from "./local-model";
import type { Navigate } from "./types";
export type PickerKind = "skills" | "memories" | "assets" | "integrations" | "projects";
export default function ComposerContextPicker({ kind, close, choose, navigate }: { kind: PickerKind; close: () => void; choose: (id: string) => void; navigate: Navigate }) {
  const w = useWorkspace();
  const [query, setQuery] = useState("");
  const [newProjectId] = useState(() => uid("project"));
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [goals, setGoals] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const items = kind === "skills" ? w.data.skills.filter(s => !s.archived).map(s => ({ id: s.id, label: s.name }))
    : kind === "memories" ? w.data.memories.map(m => ({ id: m.id, label: m.content }))
    : kind === "assets" ? w.data.artifacts.filter(a => !a.archived).map(a => ({ id: a.id, label: a.title }))
    : kind === "integrations" ? w.data.connections.filter(c => c.enabled).map(c => ({ id: c.id, label: c.label || c.provider }))
    : w.data.projects.filter(p => !p.archived).map(p => ({ id: p.id, label: p.name }));
  const filtered = items.filter(item => item.label.toLowerCase().includes(query.toLowerCase()));
  return <div className="context-picker" role="dialog" aria-label={"Select " + kind}>
    <input autoFocus aria-label={"Search " + kind} placeholder={"Search " + kind} value={query} onChange={e => setQuery(e.target.value)} />
    {filtered.map(item => <button key={item.id} onClick={() => { choose(item.id); close(); }}>{item.label}</button>)}
    {!filtered.length && <p className="empty-state">{items.length ? "No matching items" : "No " + kind + " available"}</p>}
    {kind === "integrations" && <><small>Select a server-configured integration for real API reads. Writes require a separate approval card. Unsupported metadata entries cannot execute.</small><button onClick={() => { close(); navigate(location.pathname + "?settings=integrations"); }}>Add other integrations</button></>}
    {kind === "projects" && !creating && <button onClick={() => setCreating(true)}>Create new project…</button>}
    {kind === "projects" && creating && <form onSubmit={async e => {
      e.preventDefault(); if (!name.trim() || busy) return;
      setBusy(true); setError("");
      const id = newProjectId;
      try { w.set("projects", list => [...list.filter(p => p.id !== id), { id, name: name.trim(), description: "", goal: goals }]); await w.flush(); choose(id); close(); }
      catch (e) { setError(e instanceof Error ? e.message : "Could not save project."); }
      finally { setBusy(false); }
    }}><label>Project name<input aria-label="Project name" required value={name} onChange={e => setName(e.target.value)} /></label><label>Goals (optional)<textarea aria-label="Project goals" value={goals} onChange={e => setGoals(e.target.value)} /></label><button className="btn primary" disabled={busy || !name.trim()}>Create project</button><button type="button" className="btn" onClick={() => setCreating(false)}>Cancel</button>{error && <p role="alert">{error}</p>}</form>}
    <button onClick={close}>Close selection</button>
  </div>;
}
